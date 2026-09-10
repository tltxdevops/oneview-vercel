import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const pageUrl = new URL("../src/pages/Operadoras.tsx", import.meta.url);
const apiUrl = new URL("../src/lib/oneview-api.ts", import.meta.url);

test("OV-P0-295 drawer renders reminder controls before persisted state resolves", async () => {
  const page = await readFile(pageUrl, "utf8");
  assert.match(page, /<CircuitReminderPanel link=\{view\} \/>/);
  assert.doesNotMatch(page, /\{loading \? <Skeleton[^:]+: reminder/s);
  assert.match(page, /Carregando acompanhamento…/);
  assert.match(page, /onClick=\{create\}/);
  assert.match(page, /clickStartedAt\.current = performance\.now\(\);\s*setOpen\(true\)/s);
  assert.doesNotMatch(page.match(/const create = \(\) => \{[\s\S]*?\n  \};/)?.[0] || "", /fetchOperatorReminders|await|fetch\(/);
});

test("OV-P0-295 GET failure is isolated, retryable and never uses the global unavailable copy", async () => {
  const page = await readFile(pageUrl, "utf8");
  assert.match(page, /Não foi possível carregar o acompanhamento\./);
  assert.match(page, />Tentar novamente</);
  assert.match(page, /loadReminderState\(true\)/);
  assert.doesNotMatch(page, /setMutationError\(cause instanceof Error \? cause\.message/);
});

test("OV-P0-295 reminder reads use short cache, in-flight deduplication and race protection", async () => {
  const [page, api] = await Promise.all([readFile(pageUrl, "utf8"), readFile(apiUrl, "utf8")]);
  assert.match(api, /OPERATOR_REMINDER_CACHE_TTL_MS = 45_000/);
  assert.match(api, /operatorReminderCacheKey[\s\S]*data_source_id[\s\S]*circuit_key \|\| link\.id/);
  assert.match(api, /operatorReminderInFlight\.get\(cacheKey\)/);
  assert.match(api, /operatorReminderInFlight\.set\(cacheKey, request\)/);
  assert.match(api, /finally\(\(\) => operatorReminderInFlight\.delete\(cacheKey\)\)/);
  assert.match(page, /requestVersion\.current === version/);
  assert.match(page, /return \(\) => \{ requestVersion\.current \+= 1; \}/);
  assert.match(api, /replaceOperatorReminders\(link, \[item\]\)/);
  assert.match(api, /replaceOperatorReminders\(link, \[\]\)/);
  assert.match(api, /operatorReminderGeneration\.get\(cacheKey\)[\s\S]*!== generation/);
});

test("OV-P0-295 handles missing identity, normal link and mutation status messages", async () => {
  const page = await readFile(pageUrl, "utf8");
  assert.match(page, /Lembrete indisponível: identidade do circuito ainda não confirmada\./);
  assert.match(page, /Lembrete disponível somente enquanto houver alerta ativo\./);
  assert.match(page, /if \(!hasConfirmedCircuitIdentity\)[\s\S]*return;/);
  assert.match(page, /Sua sessão expirou\. Entre novamente\./);
  assert.match(page, /Você não possui permissão para esta ação\./);
  assert.match(page, /Já existe um lembrete ativo para este circuito\./);
  assert.match(page, /Não foi possível agendar agora\. Tente novamente\./);
  assert.match(page, /active_reminder_exists[\s\S]*fetchOperatorReminders\(reminderLink, \{ force: true \}\)/);
});

test("OV-P0-295 emits measured UX timings without identity or payload fields", async () => {
  const page = await readFile(pageUrl, "utf8");
  for (const metric of ["drawer_open_to_render_ms", "reminder_get_ms", "reminder_button_click_to_modal_ms"]) {
    assert.match(page, new RegExp(metric));
  }
  const timingEntries = page.match(/event: "oneview_reminder_ui_timing"[\s\S]{0,220}/g) || [];
  assert.ok(timingEntries.length >= 3);
  assert.doesNotMatch(timingEntries.join("\n"), /email|cookie|token|oid|payload/);
});

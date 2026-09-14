import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const badgeSource = await readFile(new URL("../src/components/badges/OneViewIncidentStatusBadge.tsx", import.meta.url), "utf8");
const visualSource = await readFile(new URL("../src/lib/oneview-incident-status-visual.ts", import.meta.url), "utf8");
const pageSource = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");

test("ServiceNow states use the centralized semantic status palette", () => {
  const expected = [
    ["1", "Novo", "info"],
    ["2", "Em andamento", "info"],
    ["3", "Em espera", "warning"],
    ["6", "Resolvido", "success"],
    ["7", "Fechado", "neutral"],
    ["8", "Cancelado", "neutral"],
  ];

  for (const [state, label, tone] of expected) {
    const entry = new RegExp(`"${state}": \\{[\\s\\S]*?label: "${label}",[\\s\\S]*?tone: "${tone}"`);
    assert.match(visualSource, entry);
  }
  assert.doesNotMatch(visualSource, /destructive|(?:^|[^a-z])red-/i);
  assert.match(badgeSource, /data-tone=\{visual\.tone\}/);
});

test("monitoring stays red for failures and green for normalized links", () => {
  assert.match(pageSource, /monitoringDown: "text-error dark:text-red-300"/);
  assert.match(pageSource, /monitoringNormalized: "text-success"/);
  assert.match(pageSource, /failing \? OPERATOR_STATUS_TONE\.monitoringDown : OPERATOR_STATUS_TONE\.monitoringNormalized/);
});

test("secondary meanings use warning, violet, and pending-classification accents", () => {
  assert.match(pageSource, /divergence: "border-warning\/40 bg-warning\/10 text-amber-800/);
  assert.match(pageSource, /recurrence: "border-violet-300 bg-violet-50 text-violet-800/);
  assert.match(pageSource, /classificationPending: "border-warning\/35 bg-warning\/10 text-amber-800/);
  assert.match(pageSource, /className=\{OPERATOR_STATUS_TONE\.divergence\}>● \{divergenceLabel\(link\)\}/);
  assert.doesNotMatch(pageSource, /variant="destructive"[^>]*>[^<]*\{divergenceLabel/);
});

test("incident status is a discrete badge and queue rows remain neutral", () => {
  assert.match(pageSource, /<span>\{link\.current_incident\.number \|\| "INC"\}<\/span><OneViewIncidentStatusBadge/);
  assert.match(pageSource, /<TableRow key=\{item\.id\} className="cursor-pointer"/);
  assert.doesNotMatch(pageSource, /<TableRow key=\{item\.id\} className=\{cn\([^\n]*(?:error|success|warning|red|green|amber|orange|violet)/);
});

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

test("monitoring uses the semantic down and normalized statuses", () => {
  assert.match(pageSource, /OneViewSemanticStatusBadge/);
  assert.match(pageSource, /status=\{failing \? "monitoring-down" : "monitoring-normalized"\}/);
  assert.doesNotMatch(pageSource, /OPERATOR_STATUS_TONE/);
});

test("secondary meanings use the official semantic badges", () => {
  assert.match(pageSource, /status="divergence" label=\{divergenceLabel\(link\)\}/);
  assert.match(pageSource, /status="recurrence" label=\{`\$\{count\} quedas \/ 24h`\}/);
  assert.match(pageSource, /status="classification-pending"/);
  assert.doesNotMatch(pageSource, /border-violet-|text-amber-|bg-amber-|OPERATOR_STATUS_TONE/);
});

test("incident status is a discrete badge and queue rows remain neutral", () => {
  assert.match(pageSource, /<span>\{link\.current_incident\.number \|\| "INC"\}<\/span><OneViewIncidentStatusBadge/);
  assert.match(pageSource, /<TableRow key=\{item\.id\} className="cursor-pointer"/);
  assert.doesNotMatch(pageSource, /<TableRow key=\{item\.id\} className=\{cn\([^\n]*(?:error|success|warning|red|green|amber|orange|violet)/);
});

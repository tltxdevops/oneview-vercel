/**
 * OV-P0-111B — classificação contra read model PROD (sem HTTP SN, sem host).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyExplicitServiceNowCorrelation,
  inspectExplicitServiceNowTags,
} from "../api/_lib/oneview-inc-correlation.js";
import {
  mapReadModelIncident,
  pickRelation,
  RELATION_PRIORITY,
  summarizePublicRows,
  toPublicClass,
} from "../scripts/ov-p0-111b-prod-alert-correlation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("OV-P0-111B mapeia classes públicas e incidente do read model", () => {
  assert.equal(toPublicClass("correlated_exact"), "correlated_exact");
  assert.equal(toPublicClass("correlated_by_sys_id_only"), "sys_id_only");
  assert.equal(toPublicClass("correlated_by_number_only"), "number_only");
  assert.equal(toPublicClass("mismatch"), "mismatch");
  assert.equal(toPublicClass("missing_in_servicenow"), "missing");
  assert.equal(toPublicClass("malformed_tag"), "missing");

  const incident = mapReadModelIncident({
    sys_id: "AA62F29F47477610082E3D02E26D4358",
    number: "inc0064518",
    state: "7",
    priority: "2",
    assigned_to: "user-1",
    assignment_group: "group-1",
    display_values: {
      state: "Encerrado(a)",
      priority: "2 - Alta",
      assigned_to: "NOC",
      assignment_group: "NOC-Zabbix",
    },
  });
  assert.equal(incident.sys_id, "aa62f29f47477610082e3d02e26d4358");
  assert.equal(incident.number, "INC0064518");
  assert.equal(incident.state, "Encerrado(a)");
  assert.equal(incident.assignment_group, "NOC-Zabbix");
});

test("OV-P0-111B prioriza sys_id → number → histórico → evento → none", () => {
  const sysId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const inspect = inspectExplicitServiceNowTags({
    event_tags: [
      { tag: "__zbx_servicenow_sys_id", value: sysId },
      { tag: "__zbx_servicenow_number", value: "INC0001" },
    ],
  });
  const classified = classifyExplicitServiceNowCorrelation({
    inspect,
    bySysId: new Map([[sysId, { sys_id: sysId, number: "INC0001" }]]),
    byNumber: new Map([["INC0001", { sys_id: sysId, number: "INC0001" }]]),
  });
  const first = pickRelation({ inspect, classified });
  assert.equal(first.source, RELATION_PRIORITY.SYS_ID);

  const history = pickRelation({
    inspect: inspectExplicitServiceNowTags({ event_tags: [] }),
    classified: classifyExplicitServiceNowCorrelation({
      inspect: inspectExplicitServiceNowTags({ event_tags: [{ tag: "__zbx_servicenow_number", value: "INC9999" }] }),
      bySysId: new Map(),
      byNumber: new Map([["INC9999", null]]),
    }),
    historyNumbers: ["INC0002"],
    byHistoryNumber: new Map([["INC0002", { sys_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", number: "INC0002" }]]),
  });
  assert.equal(history.source, RELATION_PRIORITY.HISTORY);

  const event = pickRelation({
    classified: { sys_id_exists: false, number_exists: false, resolved: null },
    eventIncident: { sys_id: "cccccccccccccccccccccccccccccccc", number: "INC0003" },
  });
  assert.equal(event.source, RELATION_PRIORITY.EVENT);

  const none = pickRelation({ classified: { sys_id_exists: false, number_exists: false, resolved: null } });
  assert.equal(none.source, RELATION_PRIORITY.NONE);
});

test("OV-P0-111B resumo e script não usam fallback por host", async () => {
  const summary = summarizePublicRows([
    { public_class: "correlated_exact" },
    { public_class: "correlated_exact" },
    { public_class: "sys_id_only" },
    { public_class: "mismatch" },
    { public_class: "missing" },
  ]);
  assert.equal(summary.TOTAL, 5);
  assert.equal(summary.EXACT, 2);
  assert.equal(summary.MISMATCH, 1);
  assert.equal(summary.MISSING, 1);
  assert.equal(summary.CORRELATION_RATE, 40);

  const script = await readFile(path.join(root, "scripts/ov-p0-111b-prod-alert-correlation.mjs"), "utf8");
  assert.match(script, /host_fallback: false/);
  assert.match(script, /servicenow_incidents/);
  assert.doesNotMatch(script, /u_hostname_zabbix/);
  assert.doesNotMatch(script, /fetchIncidentsByExact/);
  assert.doesNotMatch(script, /method:\s*["']POST["']/);
});

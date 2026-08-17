/**
 * OV-P0-111 — classificação de correlação explícita alerta ↔ INC.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyExplicitServiceNowCorrelation,
  EXPLICIT_SN_CORRELATION_CLASS,
  inspectExplicitServiceNowTags,
  parseSysIdFromServiceNowLink,
} from "../api/_lib/oneview-inc-correlation.js";
import { summarizeCorrelationRows } from "../scripts/ov-p0-111-alert-incident-correlation-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function incident(sysId, number, extra = {}) {
  return {
    sys_id: sysId,
    number,
    state: extra.state || "2",
    state_display: extra.state_display || "Em andamento",
    priority: extra.priority || "3",
    priority_display: extra.priority_display || "3 - Moderada",
    assigned_to: extra.assigned_to || "analyst-1",
    assigned_to_display: extra.assigned_to_display || "NOC",
  };
}

test("OV-P0-111 parseia sys_id do deep link e detecta tag malformada", () => {
  const parsed = parseSysIdFromServiceNowLink(
    "https://teletexprod.service-now.com/incident.do?sys_id=aa62f29f47477610082e3d02e26d4358",
  );
  assert.equal(parsed.sys_id, "aa62f29f47477610082e3d02e26d4358");
  assert.equal(parsed.host, "teletexprod.service-now.com");

  const inspect = inspectExplicitServiceNowTags({
    event_tags: [
      { tag: "__zbx_servicenow_sys_id", value: "not-a-sys-id" },
      { tag: "__zbx_servicenow_number", value: "TICKET-99" },
      { tag: "__zbx_servicenow_link", value: "notaurl" },
      { tag: "__zbx_servicenow_link", value: "[redacted-url]" },
    ],
    trigger_tags: [],
    host_tags: [],
  });
  assert.equal(inspect.valid_sys_ids.length, 0);
  assert.equal(inspect.valid_numbers.length, 0);
  assert.ok(inspect.malformed.some((item) => item.reason === "redacted_link"));
  assert.ok(inspect.malformed.length >= 3);
});

test("OV-P0-111 correlated_exact quando number e sys_id batem no mesmo INC", () => {
  const sysId = "aa62f29f47477610082e3d02e26d4358";
  const inspect = inspectExplicitServiceNowTags({
    event_tags: [
      { tag: "__zbx_servicenow_sys_id", value: sysId },
      { tag: "__zbx_servicenow_number", value: "INC0067822" },
      { tag: "__zbx_servicenow_link", value: `https://example.service-now.com/incident.do?sys_id=${sysId}` },
    ],
  });
  const row = classifyExplicitServiceNowCorrelation({
    inspect,
    bySysId: new Map([[sysId, incident(sysId, "INC0067822")]]),
    byNumber: new Map([["INC0067822", incident(sysId, "INC0067822")]]),
  });
  assert.equal(row.classification, EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_EXACT);
  assert.equal(row.same_incident, true);
  assert.equal(row.link_opens_same_incident, true);
  assert.equal(row.resolved.fields_recovered.state, true);
  assert.equal(row.resolved.fields_recovered.priority, true);
  assert.equal(row.resolved.fields_recovered.assigned_to, true);
});

test("OV-P0-111 classifica sys_id-only, number-only, mismatch, missing e malformed", () => {
  const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  const sysOnly = classifyExplicitServiceNowCorrelation({
    inspect: inspectExplicitServiceNowTags({
      event_tags: [{ tag: "__zbx_servicenow_sys_id", value: a }],
    }),
    bySysId: new Map([[a, incident(a, "INC0001")]]),
    byNumber: new Map(),
  });
  assert.equal(sysOnly.classification, EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_BY_SYS_ID_ONLY);

  const numberOnly = classifyExplicitServiceNowCorrelation({
    inspect: inspectExplicitServiceNowTags({
      event_tags: [{ tag: "__zbx_servicenow_number", value: "INC0002" }],
    }),
    bySysId: new Map(),
    byNumber: new Map([["INC0002", incident(b, "INC0002")]]),
  });
  assert.equal(numberOnly.classification, EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_BY_NUMBER_ONLY);

  const mismatch = classifyExplicitServiceNowCorrelation({
    inspect: inspectExplicitServiceNowTags({
      event_tags: [
        { tag: "__zbx_servicenow_sys_id", value: a },
        { tag: "__zbx_servicenow_number", value: "INC0002" },
      ],
    }),
    bySysId: new Map([[a, incident(a, "INC0001")]]),
    byNumber: new Map([["INC0002", incident(b, "INC0002")]]),
  });
  assert.equal(mismatch.classification, EXPLICIT_SN_CORRELATION_CLASS.MISMATCH);

  const missing = classifyExplicitServiceNowCorrelation({
    inspect: inspectExplicitServiceNowTags({
      event_tags: [{ tag: "__zbx_servicenow_number", value: "INC9999" }],
    }),
    bySysId: new Map(),
    byNumber: new Map([["INC9999", null]]),
  });
  assert.equal(missing.classification, EXPLICIT_SN_CORRELATION_CLASS.MISSING_IN_SERVICENOW);

  const malformed = classifyExplicitServiceNowCorrelation({
    inspect: inspectExplicitServiceNowTags({
      event_tags: [{ tag: "__zbx_servicenow_sys_id", value: "xyz" }],
    }),
    bySysId: new Map(),
    byNumber: new Map(),
  });
  assert.equal(malformed.classification, EXPLICIT_SN_CORRELATION_CLASS.MALFORMED_TAG);
});

test("OV-P0-111 resumo e script/docs não usam fallback por host", async () => {
  const summary = summarizeCorrelationRows([
    { classification: "correlated_exact", causes: [], resolved: { fields_recovered: { state: true, priority: true, assigned_to: true } } },
    { classification: "correlated_exact", causes: [], resolved: { fields_recovered: { state: true, priority: true, assigned_to: false } } },
    { classification: "mismatch", causes: ["number_and_sys_id_point_to_different_incidents"] },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.exact_pct, 66.7);
  assert.equal(summary.mismatch_pct, 33.3);

  const [script, lib] = await Promise.all([
    readFile(path.join(root, "scripts/ov-p0-111-alert-incident-correlation-gate.mjs"), "utf8"),
    readFile(path.join(root, "api/_lib/oneview-inc-correlation.js"), "utf8"),
  ]);
  assert.match(script, /host_fallback: false/);
  assert.doesNotMatch(script, /u_hostname_zabbix/);
  assert.doesNotMatch(script, /buildRelatedIncidentsSysparmQuery/);
  assert.match(lib, /EXPLICIT_SN_CORRELATION_CLASS/);
  assert.doesNotMatch(script, /method:\s*["']POST["']/);
});

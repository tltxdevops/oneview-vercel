/**
 * OV-P0-262A — ServiceNow possible-duplicate read model (Snow Notifier-compatible).
 * READ ONLY — no ServiceNow writes.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DUPLICATE_CLASSIFICATION,
  OPEN_INCIDENT_STATES_EXCLUDED,
  normalizeDuplicateDescription,
  buildPossibleDuplicateGroups,
  createIncidentDuplicatesHandler,
  fetchPossibleDuplicateGroups,
} from "../api/_lib/oneview-incident-duplicates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

function mockRes() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    end(value) {
      this.body = value ? JSON.parse(value) : null;
      return this;
    },
  };
}

test("OV-P0-262A normalizeDuplicateDescription matches Snow Notifier rules", () => {
  assert.equal(normalizeDuplicateDescription("🔴 [PROBLEM] Host unreachable"), "host unreachable");
  assert.equal(normalizeDuplicateDescription("[RESOLVED] Host unreachable"), "host unreachable");
  assert.equal(normalizeDuplicateDescription("[OK] Host unreachable"), "host unreachable");
  assert.equal(normalizeDuplicateDescription("  Host Unreachable  "), "host unreachable");
  assert.equal(
    normalizeDuplicateDescription("[PROBLEM] Acme - core-01 - ICMP ping"),
    "acme - core-01 - icmp ping",
  );
  assert.equal(normalizeDuplicateDescription(""), "");
  assert.equal(normalizeDuplicateDescription(null), "");
});

test("OV-P0-262A grouping: same key >=2, newest primary, different customers kept", () => {
  const groups = buildPossibleDuplicateGroups([
    {
      number: "INC1003",
      short_description: "🔴 [PROBLEM] Link down on edge",
      sys_created_on: "2026-03-02T12:00:00Z",
      company_display: "Acme",
    },
    {
      number: "INC1002",
      short_description: "[PROBLEM] Link down on edge",
      sys_created_on: "2026-03-02T11:00:00Z",
      company_display: "Beta",
    },
    {
      number: "INC1001",
      short_description: "[RESOLVED] Link down on edge",
      sys_created_on: "2026-03-02T10:00:00Z",
      company_display: "Acme",
    },
    {
      number: "INC2000",
      short_description: "Unrelated alert",
      sys_created_on: "2026-03-02T13:00:00Z",
      company_display: "Acme",
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].duplicateKey, "link down on edge");
  assert.equal(groups[0].duplicateCount, 3);
  assert.equal(groups[0].classification, DUPLICATE_CLASSIFICATION);
  assert.equal(groups[0].primaryIncident.number, "INC1003");
  assert.deepEqual(
    groups[0].relatedIncidents.map((item) => item.number),
    ["INC1002", "INC1001"],
  );
  assert.equal(groups[0].relatedIncidents[0].company_display, "Beta");
});

test("OV-P0-262A open universe excludes resolved/closed/cancelled", () => {
  assert.deepEqual([...OPEN_INCIDENT_STATES_EXCLUDED], ["6", "7", "8"]);
});

test("OV-P0-262A fetchPossibleDuplicateGroups is read-only", async () => {
  const rows = [
    {
      sys_id: "a".repeat(32),
      number: "INC1",
      state: "1",
      priority: "2",
      assigned_to: null,
      assignment_group: null,
      caller_id: null,
      company: "acme",
      contact_type: "monitoring",
      short_description: "[PROBLEM] CPU high",
      description: "",
      opened_at: "2026-03-02T10:00:00Z",
      resolved_at: null,
      closed_at: null,
      sys_created_on: "2026-03-02T10:00:00Z",
      sys_updated_on: "2026-03-02T11:00:00Z",
      correlation_id: null,
      u_hostname_zabbix: null,
      u_ip_zabbix: null,
      display_values: JSON.stringify({
        company_display: "Acme",
        state_display: "Novo",
        priority_display: "2",
      }),
    },
    {
      sys_id: "b".repeat(32),
      number: "INC0",
      state: "2",
      priority: "2",
      assigned_to: null,
      assignment_group: null,
      caller_id: null,
      company: "beta",
      contact_type: "monitoring",
      short_description: "CPU high",
      description: "",
      opened_at: "2026-03-02T09:00:00Z",
      resolved_at: null,
      closed_at: null,
      sys_created_on: "2026-03-02T09:00:00Z",
      sys_updated_on: "2026-03-02T09:30:00Z",
      correlation_id: null,
      u_hostname_zabbix: null,
      u_ip_zabbix: null,
      display_values: JSON.stringify({
        company_display: "Beta",
        state_display: "Em andamento",
        priority_display: "2",
      }),
    },
  ];

  const pool = {
    query: async (sql) => {
      assert.match(String(sql), /servicenow_incidents/i);
      assert.doesNotMatch(String(sql), /\b(update|insert|delete)\b/i);
      return { rows };
    },
  };

  const payload = await fetchPossibleDuplicateGroups({
    filters: {},
    pool,
    relatedAlertResolver: async () => new Map(),
    includeRelatedAlerts: false,
  });

  assert.equal(payload.classification, "POSSIBLE_DUPLICATE");
  assert.equal(payload.groups.length, 1);
  assert.equal(payload.groups[0].primaryIncident.number, "INC1");
  assert.deepEqual(payload.groups[0].relatedIncidents.map((i) => i.number), ["INC0"]);
  assert.equal(payload.write_actions.auto_close, false);
  assert.equal(payload.write_actions.parent_incident_mutation, false);
  assert.equal(payload.write_actions.servicenow_write, false);
  assert.equal(payload.stats.evaluated_incidents, 2);
});

test("OV-P0-262A handler rejects non-GET and invalid query", async () => {
  const handler = createIncidentDuplicatesHandler({
    authorize: async () => ({ ok: true }),
    fetchGroups: async () => ({
      classification: DUPLICATE_CLASSIFICATION,
      groups: [],
      stats: {
        evaluated_incidents: 0,
        duplicate_groups: 0,
        incidents_in_duplicate_groups: 0,
        largest_group: 0,
        bff_ms: 1,
      },
      data_source: "postgresql",
      checked_at: new Date().toISOString(),
      write_actions: {
        auto_close: false,
        parent_incident_mutation: false,
        servicenow_write: false,
      },
    }),
  });

  const postRes = mockRes();
  await handler({ method: "POST", query: {} }, postRes);
  assert.equal(postRes.statusCode, 405);

  const badRes = mockRes();
  await handler({ method: "GET", query: { priority: "99" } }, badRes);
  assert.equal(badRes.statusCode, 400);

  const okRes = mockRes();
  await handler({ method: "GET", query: {} }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.classification, DUPLICATE_CLASSIFICATION);
});

test("OV-P0-262A route + API client + Chamados wiring (no write actions)", async () => {
  const [duplicatesLib, route, api, chamados] = await Promise.all([
    read("api/_lib/oneview-incident-duplicates.js"),
    read("api/oneview/incidents/duplicates.js"),
    read("src/lib/oneview-api.ts"),
    read("src/pages/Chamados.tsx"),
  ]);

  assert.match(duplicatesLib, /POSSIBLE_DUPLICATE/);
  assert.match(duplicatesLib, /normalizeDuplicateDescription/);
  assert.match(duplicatesLib, /servicenow_write:\s*false/);
  assert.doesNotMatch(duplicatesLib, /method:\s*["']PATCH["']/i);

  assert.match(route, /oneview-incident-duplicates/);
  assert.match(api, /fetchIncidentDuplicates/);
  assert.match(api, /\/oneview\/incidents\/duplicates/);

  assert.match(chamados, /Duplicados/);
  assert.match(chamados, /fetchIncidentDuplicates/);
  assert.match(chamados, /if \(viewMode !== "duplicates"\) return;/);
  assert.match(chamados, /Duplicidade sugerida/);
  assert.doesNotMatch(chamados, /Encerrar dups|Resolver todos|parent_incident/i);
});

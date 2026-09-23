import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readIncidentIdentityGuard } from "../api/_lib/oneview-incident-identity-guard.js";
import { mapReadModelIncident } from "../api/_lib/oneview-incidents-read-model.js";
import {
  fetchAuthoritativeServiceNowIncidentByNumber,
  createServiceNowEventsHandler,
  normalizeServiceNowEventPayload,
  upsertServiceNowIncidentEvent,
} from "../api/_lib/oneview-servicenow-events.js";

const OLD_SYS_ID = "71d813e4336bc71064bca4989d5c7b88";
const CURRENT_SYS_ID = "3d291be4336bc71064bca4989d5c7b26";
const NUMBER = "INC0087332";

function incoming(sysId = CURRENT_SYS_ID, updated = "2026-09-22 19:35:58") {
  return normalizeServiceNowEventPayload({
    sys_id: sysId,
    number: NUMBER,
    state: { value: "3", display_value: "Em espera" },
    priority: { value: "3", display_value: "3 - Moderada" },
    assignment_group: { value: "group", display_value: "Service Desk" },
    assigned_to: { value: "analyst", display_value: "Analista" },
    caller_id: { value: "caller", display_value: "Solicitante" },
    company: { value: "company", display_value: "Cliente" },
    contact_type: { value: "phone", display_value: "Telefone" },
    short_description: "Teste de identidade",
    description: "Teste",
    opened_at: "2026-09-22 17:00:00",
    sys_created_on: "2026-09-22 17:00:00",
    sys_updated_on: updated,
  });
}

function memoryClient(initialRows) {
  const state = { rows: initialRows.map((row) => ({ ...row })), queries: [], writes: 0, deletes: 0 };
  return {
    state,
    async query(sql, values = []) {
      state.queries.push({ sql, values });
      const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (normalized.startsWith("select sys_id, number from servicenow_incidents")) {
        return { rows: state.rows.filter((row) => row.number === values[0]).map((row) => ({ sys_id: row.sys_id, number: row.number })) };
      }
      if (normalized.startsWith("select sys_id, sys_updated_on from servicenow_incidents")) {
        return { rows: state.rows.filter((row) => row.sys_id === values[0]).map((row) => ({ sys_id: row.sys_id, sys_updated_on: row.sys_updated_on })) };
      }
      if (normalized.startsWith("insert into servicenow_incidents")) {
        const [sys_id, number] = values;
        const sys_updated_on = values[15];
        const existing = state.rows.find((row) => row.sys_id === sys_id);
        if (existing) Object.assign(existing, { number, sys_updated_on });
        else state.rows.push({ sys_id, number, sys_updated_on });
        state.writes += 1;
        return { rows: [{ sys_id }] };
      }
      if (normalized.startsWith("delete from servicenow_incidents")) {
        const [number, staleIds] = values;
        const stale = new Set(staleIds);
        const before = state.rows.length;
        state.rows = state.rows.filter((row) => !(row.number === number && stale.has(row.sys_id)));
        state.deletes += before - state.rows.length;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
  };
}

async function reconcile(client, event, authoritative, audit = async () => {}) {
  return upsertServiceNowIncidentEvent(client, event, new Date("2026-09-22T20:00:00.000Z"), {
    authoritativeLookup: async () => authoritative,
    auditIdentity: audit,
  });
}

function responseRecorder() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader() { return this; },
    end(value) { this.payload = value ? JSON.parse(value) : null; },
  };
}

test("OV-P0-315 same number + same sys_id stays idempotent with no authoritative lookup", async () => {
  const client = memoryClient([{ sys_id: CURRENT_SYS_ID, number: NUMBER, sys_updated_on: "2026-09-22T19:35:58.000Z" }]);
  let lookups = 0;
  const result = await upsertServiceNowIncidentEvent(client, incoming(), new Date(), {
    authoritativeLookup: async () => { lookups += 1; return { status: "authoritative", sys_id: CURRENT_SYS_ID }; },
    auditIdentity: async () => {},
  });
  assert.equal(result.status, "idempotent");
  assert.equal(lookups, 0);
  assert.equal(client.state.writes, 0);
});

test("OV-P0-315 authoritative incoming sys_id reconciles stale local row atomically", async () => {
  const client = memoryClient([{ sys_id: OLD_SYS_ID, number: NUMBER, sys_updated_on: "2026-09-22T17:57:46.000Z" }]);
  const audits = [];
  const result = await reconcile(client, incoming(), { status: "authoritative", sys_id: CURRENT_SYS_ID }, async (_client, entry) => audits.push(entry));
  assert.equal(result.status, "reconciled");
  assert.deepEqual(client.state.rows.map((row) => row.sys_id), [CURRENT_SYS_ID]);
  assert.equal(client.state.deletes, 1);
  assert.equal(audits[0].outcome, "reconciled");
});

test("OV-P0-315 authoritative old sys_id never lets a new payload replace it", async () => {
  const client = memoryClient([{ sys_id: OLD_SYS_ID, number: NUMBER, sys_updated_on: "2026-09-22T17:57:46.000Z" }]);
  const result = await reconcile(client, incoming(), { status: "authoritative", sys_id: OLD_SYS_ID });
  assert.equal(result.status, "identity_conflict");
  assert.deepEqual(client.state.rows.map((row) => row.sys_id), [OLD_SYS_ID]);
  assert.equal(client.state.writes, 0);
  assert.equal(client.state.deletes, 0);
});

test("OV-P0-315 zero or multiple authoritative results are conflicts and make no incident write", async () => {
  for (const authoritative of [
    { status: "identity_conflict", record_count: 0, sys_id: null },
    { status: "identity_conflict", record_count: 2, sys_id: null },
  ]) {
    const client = memoryClient([{ sys_id: OLD_SYS_ID, number: NUMBER, sys_updated_on: "2026-09-22T17:57:46.000Z" }]);
    const result = await reconcile(client, incoming(), authoritative);
    assert.equal(result.status, "identity_conflict");
    assert.equal(client.state.writes, 0);
    assert.equal(client.state.deletes, 0);
  }
});

test("OV-P0-315 failed reconciliation rolls back its stale delete", async () => {
  const client = memoryClient([{ sys_id: OLD_SYS_ID, number: NUMBER, sys_updated_on: "2026-09-22T17:57:46.000Z" }]);
  const transaction = async (work) => {
    const snapshot = structuredClone(client.state.rows);
    try { return await work(client); }
    catch (error) { client.state.rows = snapshot; throw error; }
  };
  const handler = createServiceNowEventsHandler({
    configProvider: () => ({ secret: "test-secret" }),
    transaction,
    authoritativeLookup: async () => ({ status: "authoritative", sys_id: CURRENT_SYS_ID }),
    auditIdentity: async () => { throw new Error("audit unavailable"); },
    logger: () => undefined,
  });
  const res = responseRecorder();
  await handler({ method: "POST", headers: { authorization: "Bearer test-secret" }, body: incoming().raw_payload }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(client.state.rows.map((row) => row.sys_id), [OLD_SYS_ID]);
});

test("OV-P0-315 number advisory lock serializes two reconciliations and leaves one identity", async () => {
  const client = memoryClient([{ sys_id: OLD_SYS_ID, number: NUMBER, sys_updated_on: "2026-09-22T17:57:46.000Z" }]);
  await reconcile(client, incoming(), { status: "authoritative", sys_id: CURRENT_SYS_ID });
  const second = await reconcile(client, incoming(), { status: "authoritative", sys_id: CURRENT_SYS_ID });
  assert.equal(second.status, "idempotent");
  assert.deepEqual(client.state.rows.map((row) => row.sys_id), [CURRENT_SYS_ID]);
  const firstNumberLock = client.state.queries.findIndex(({ values }) => values[0] === `servicenow-incident-number:${NUMBER}`);
  const firstNumberRead = client.state.queries.findIndex(({ sql }) => String(sql).includes("where number::text = $1 for update"));
  assert.ok(firstNumberLock >= 0 && firstNumberLock < firstNumberRead);
});

test("OV-P0-315 authoritative lookup is by number, constrained to two records", async () => {
  let received;
  const result = await fetchAuthoritativeServiceNowIncidentByNumber(NUMBER, {
    config: { baseUrl: "https://example.invalid", username: "ignored", password: "ignored" },
    getPage: async (_table, options) => {
      received = options;
      return { records: [{ sys_id: CURRENT_SYS_ID, number: NUMBER }] };
    },
  });
  assert.equal(result.sys_id, CURRENT_SYS_ID);
  assert.equal(received.sysparm_query, `number=${NUMBER}`);
  assert.equal(received.sysparm_limit, 2);
});

test("OV-P0-315 BFF read-model marks conflict, suppresses direct link, and action guard detects it", async () => {
  const item = mapReadModelIncident({ sys_id: OLD_SYS_ID, number: NUMBER, identity_conflict: true, display_values: {} });
  assert.equal(item.identity_conflict, true);
  assert.equal(item.servicenow_url, null);
  const guard = await readIncidentIdentityGuard({
    query: async () => ({ rows: [{ sys_id: OLD_SYS_ID, number: NUMBER, identity_conflict: true }] }),
  }, OLD_SYS_ID);
  assert.equal(guard.identity_conflict, true);
});

test("OV-P0-315 actions have no per-action number-to-sys_id fallback", async () => {
  const files = await Promise.all([
    "oneview-servicenow-claim.js",
    "oneview-servicenow-work-note.js",
    "oneview-servicenow-attachment.js",
    "oneview-servicenow-put-on-hold.js",
  ].map((file) => readFile(new URL(`../api/_lib/${file}`, import.meta.url), "utf8")));
  for (const source of files) {
    assert.match(source, /assertIncidentIdentitySafe/);
    assert.doesNotMatch(source, /sysparm_query:\s*`?number=/);
  }
});

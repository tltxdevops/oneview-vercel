import test from "node:test";
import assert from "node:assert/strict";

import { createOperatorReminderInboxHandler } from "../api/_lib/oneview-operator-reminder-inbox.js";
import {
  buildOperatorReminderInAppCopy,
  circuitLabelFromSnapshot,
} from "../api/_lib/oneview-operator-reminder-message.js";

const actor = { id: "analyst-1", name: "Ana Analista" };
const SINCE = "2026-09-11T10:00:00.000Z";

const response = () => ({
  statusCode: 0,
  body: null,
  setHeader() { return this; },
  status(value) { this.statusCode = value; return this; },
  end(value) { this.body = JSON.parse(value); },
});

const request = (query = {}) => ({ method: "GET", query, headers: {}, socket: {} });

const snapshot = {
  customer: { name: "Sanepar" },
  link: { service_name: "WAN Principal", uplink_key: "wan1" },
  circuit: { host_name: "sanep-gw-01", circuit_key: "ds-1:sanep-gw-01:wan1" },
  alert: { severity: "high", problem_name: "Link down" },
  incident: { number: "INC0089999" },
};

test("OV-P0-299 buildOperatorReminderInAppCopy — fases fired e delivered", () => {
  const reminder = {
    subject_type: "circuit",
    context_snapshot: snapshot,
    initial_incident_number: "INC0089999",
  };
  const fired = buildOperatorReminderInAppCopy(reminder, "fired");
  assert.match(fired.title, /Lembrete/i);
  assert.match(fired.body, /Sanepar/);
  assert.match(fired.body, /INC0089999/);

  const delivered = buildOperatorReminderInAppCopy(reminder, "delivered");
  assert.match(delivered.title, /Webex/i);
  assert.match(delivered.body, /Sanepar/);
});

test("OV-P0-299 circuitLabelFromSnapshot usa serviço do link", () => {
  const label = circuitLabelFromSnapshot(snapshot);
  assert.match(label, /WAN Principal/);
});

test("OV-P0-299 inbox rejeita since inválido", async () => {
  const route = createOperatorReminderInboxHandler({
    authorize: async () => actor,
    query: async (work) => work({ query: async () => ({ rows: [] }) }),
    logger: () => undefined,
  });
  const res = response();
  await route(request({ since: "2026-09-11" }), res);
  assert.equal(res.statusCode, 400);
});

test("OV-P0-299 inbox retorna eventos fired e delivered do solicitante", async () => {
  const rows = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      subject_type: "circuit",
      subject_key: "circuit:ds-1:host:wan1",
      circuit_key: "ds-1:host:wan1",
      data_source_id: "ds-1",
      source_host_id: "host",
      source_trigger_id: null,
      status: "processing",
      context_snapshot: snapshot,
      initial_incident_number: "INC0089999",
      updated_at: new Date("2026-09-11T12:00:00.000Z"),
      sent_at: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      subject_type: "circuit",
      subject_key: "circuit:ds-1:host2:wan1",
      circuit_key: "ds-1:host2:wan1",
      data_source_id: "ds-1",
      source_host_id: "host2",
      source_trigger_id: null,
      status: "sent",
      context_snapshot: { ...snapshot, customer: { name: "MAPS" } },
      initial_incident_number: null,
      updated_at: new Date("2026-09-11T13:00:00.000Z"),
      sent_at: new Date("2026-09-11T13:05:00.000Z"),
    },
  ];

  const route = createOperatorReminderInboxHandler({
    authorize: async () => actor,
    query: async (work) => work({
      query: async (sql, values) => {
        assert.ok(values.includes(actor.id));
        assert.equal(values[1], SINCE);
        return { rows };
      },
    }),
    logger: () => undefined,
  });

  const res = response();
  await route(request({ since: SINCE, limit: "20" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.items[0].phase, "fired");
  assert.equal(res.body.items[1].phase, "delivered");
  assert.equal(res.body.items[0].link.data_source_id, "ds-1");
  assert.match(res.body.items[1].body, /MAPS/);
});

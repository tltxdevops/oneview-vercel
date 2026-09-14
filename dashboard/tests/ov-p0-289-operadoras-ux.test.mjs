import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildLinksPayload, parseLinkFilters } from "../api/_lib/oneview-links.js";

const filters = parseLinkFilters({ query: { tab: "open", sort: "recent", page_size: "100" } });
const row = (id, latestAlertAt) => ({
  id, customer_name: "Havan", customer_key: "havan", datasource: "teletex-http", source_host_id: id,
  service_name: id, classification: "uplink", resolution_status: "resolved", active_alerts: 1, state: "alert",
  latest_alert_at: latestAlertAt, latest_activity_at: "2026-09-04T08:00:00Z", active_since_at: "2026-09-04T07:00:00Z",
  incident_count: 0, open_incident_count: 0, incident_correlation_status: "available", alerts: [], incidents: [],
});

test("OV-P0-289 open queue sorts by latest_alert_at descending", () => {
  const payload = buildLinksPayload([
    row("older-alert", "2026-09-04T10:00:00Z"),
    row("latest-alert", "2026-09-04T11:00:00Z"),
  ], filters, Date.parse("2026-09-04T12:00:00Z"));
  assert.deepEqual(payload.items.map((item) => item.id), ["latest-alert", "older-alert"]);
});

test("OV-P0-289 Operadoras keeps the operational table and browser-only columns", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  for (const label of ["Link / local", "Situação", "Último alerta", "Chamado atual", "Acompanhamento", "Colunas", "Filtros rápidos de cliente", "Resumo operacional", "Detalhes técnicos", "Em falha", "Normalizados", "Recorrentes", "Recorrência", "Sem chamado", "Com chamado"]) assert.match(page, new RegExp(label));
  assert.doesNotMatch(page, /Resolvidos hoje/);
  assert.doesNotMatch(page, /\["open", "Em aberto"\]/);
  assert.match(page, /localStorage/);
  assert.match(page, /Accordion/);
  assert.match(page, /Atualizando/);
  // Reminder history may display the persisted Theo acceptance state, but does not add a sender here.
  assert.match(page, /Theo acionado/);
});

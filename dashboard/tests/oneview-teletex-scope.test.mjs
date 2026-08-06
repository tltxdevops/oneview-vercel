import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getOneViewConfig } from "../api/_lib/oneview-config.js";
import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import { getOneViewSnapshotPayload, resetOneViewSnapshotCacheForTests } from "../api/_lib/oneview-fallback.js";
import { getPrimaryDataSourceName } from "../api/_lib/oneview-scope.js";

const request = (query = {}) => ({ method: "GET", query, headers: {} });
const scopeConfig = { primaryDataSourceName: "teletex-http" };

test("configuração central resolve teletex-http sem UUID", () => {
  assert.equal(getPrimaryDataSourceName({}), "teletex-http");
  assert.equal(getPrimaryDataSourceName({ ONEVIEW_PRIMARY_DATA_SOURCE_NAME: " TELETEX-HTTP " }), "teletex-http");
  assert.equal(getOneViewConfig({ ONEVIEW_PRIMARY_DATA_SOURCE_NAME: "teletex-http" }).primaryDataSourceName, "teletex-http");
});

test("listagem combina escopo obrigatório com filtros e paginação", () => {
  const query = buildAlertListQuery(request({
    datasource: "outra-fonte",
    severity: "high",
    page: "3",
    page_size: "25",
  }), "teletex-http");

  assert.equal(query.params[0], "teletex-http");
  assert.match(query.whereSql, /d\.name = \$1/);
  assert.match(query.whereSql, /d\.name = any\(\$2::text\[\]\)/);
  assert.deepEqual([query.page, query.pageSize, query.offset], [3, 25, 50]);
});

test("snapshot operacional retorna somente teletex-http em alertas e métricas", async () => {
  resetOneViewSnapshotCacheForTests();
  const alerts = await getOneViewSnapshotPayload(
    "alerts",
    request({ status: "all", page_size: "100" }),
    scopeConfig,
  );
  const metrics = await getOneViewSnapshotPayload("dashboard-summary", request(), scopeConfig);

  assert.ok(alerts.items.length > 0);
  assert.ok(alerts.items.every((item) => item.datasource_name.toLowerCase() === "teletex-http"));
  assert.equal(metrics.active_total, metrics.by_severity.reduce((total, item) => total + item.count, 0));
});

test("detalhe de alerta de outra fonte não é retornado no fallback", async () => {
  const snapshot = JSON.parse(await readFile(
    new URL("../src/lib/oneview-real-snapshot.safe.json", import.meta.url),
    "utf8",
  ));
  const sourceNames = new Map((snapshot.data_sources || []).map((source) => [String(source.id), String(source.name).toLowerCase()]));
  const otherAlert = (snapshot.alerts || []).find((alert) => {
    const sourceName = String(alert.datasource_name || sourceNames.get(String(alert.data_source_id)) || "").toLowerCase();
    return sourceName && sourceName !== "teletex-http";
  });

  assert.ok(otherAlert, "fixture deve conter alerta de outra fonte");
  await assert.rejects(
    () => getOneViewSnapshotPayload("alert-detail", request({ id: otherAlert.id }), scopeConfig),
    (error) => error?.code === "not_found" && error?.status === 404,
  );
});

test("SQL de detalhe e históricos aplica JOIN parametrizado pelo datasource", async () => {
  const database = await readFile(new URL("../api/_lib/oneview-db.js", import.meta.url), "utf8");
  const detail = database.match(/async function fetchAlertDetailPayload[\s\S]*?const HISTORY_TITLES/)?.[0] || "";
  const perAlert = database.match(/async function fetchAlertHistoryPayload[\s\S]*?export function classifyOperationalSource/)?.[0] || "";
  const global = database.match(/async function fetchGlobalHistoryPayload[\s\S]*?export function getOneViewDbConfig/)?.[0] || "";

  assert.match(detail, /join data_sources d on d\.id = a\.data_source_id[\s\S]*d\.name = \$2/);
  assert.match(perAlert, /from alert_history h[\s\S]*join alerts a on a\.id = h\.alert_id[\s\S]*join data_sources d on d\.id = a\.data_source_id[\s\S]*d\.name = \$2/);
  assert.match(global, /d\.name = \$1/);
  assert.match(global, /from alert_history h[\s\S]*join alerts a on a\.id = h\.alert_id[\s\S]*join data_sources d on d\.id = a\.data_source_id/);
});

test("endpoints legados de alertas e métricas usam o mesmo escopo central", async () => {
  const [list, detail, metrics] = await Promise.all([
    readFile(new URL("../api/alerts/index.js", import.meta.url), "utf8"),
    readFile(new URL("../api/alerts/[id].js", import.meta.url), "utf8"),
    readFile(new URL("../api/alerts/metrics.js", import.meta.url), "utf8"),
  ]);

  assert.match(list, /getPrimaryDataSourceName/);
  assert.match(list, /data_source_id = \(select id from data_sources where name = \$1/);
  assert.match(detail, /data_source_id = \([\s\S]*select id from data_sources where name = \$2/);
  assert.match(metrics, /join data_sources d on d\.id = a\.data_source_id[\s\S]*where d\.name = \$1/);
});

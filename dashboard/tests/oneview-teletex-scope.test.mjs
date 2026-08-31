import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getOneViewConfig } from "../api/_lib/oneview-config.js";
import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import { getOperationalDataSourceNames } from "../api/_lib/oneview-scope.js";

const request = (query = {}) => ({ method: "GET", query, headers: {} });
const operationalSources = ["teletex-http", "rhp", "castrolanda", "zurich", "fraport-for", "fraport-poa"];

test("OV-P0-257C central scope contains exactly the six operational datasources", () => {
  assert.deepEqual(getOperationalDataSourceNames(), operationalSources);
  assert.deepEqual(getOneViewConfig({}).operationalDataSourceNames, operationalSources);
});

test("OV-P0-257C list uses parameterized all-source scope and explicit filter stays additive", () => {
  const query = buildAlertListQuery(request({
    datasource: "rhp",
    severity: "high",
    page: "3",
    page_size: "25",
  }));

  assert.deepEqual(query.params[0], operationalSources);
  assert.deepEqual(query.params[1], ["rhp"]);
  assert.match(query.whereSql, /d\.name = any\(\$1::text\[\]\)/);
  assert.match(query.whereSql, /d\.name = any\(\$2::text\[\]\)/);
  assert.deepEqual([query.page, query.pageSize, query.offset], [3, 25, 50]);
});

test("OV-P0-257C an unknown datasource remains safely parameterized and intersects canonical scope", () => {
  const query = buildAlertListQuery(request({ datasource: "maps" }));
  assert.deepEqual(query.params[0], operationalSources);
  assert.deepEqual(query.params[1], ["maps"]);
  assert.match(query.whereSql, /d\.name = any\(\$1::text\[\]\).*d\.name = any\(\$2::text\[\]\)/);
});

test("OV-P0-257C detail and histories preserve the same parameterized multi-source scope", async () => {
  const database = await readFile(new URL("../api/_lib/oneview-db.js", import.meta.url), "utf8");
  const detail = database.match(/async function fetchAlertDetailPayload[\s\S]*?const HISTORY_TITLES/)?.[0] || "";
  const perAlert = database.match(/async function fetchAlertHistoryPayload[\s\S]*?export function classifyOperationalSource/)?.[0] || "";
  const global = database.match(/async function fetchGlobalHistoryPayload[\s\S]*?export function getOneViewDbConfig/)?.[0] || "";

  assert.match(detail, /d\.name = any\(\$2::text\[\]\)/);
  assert.match(perAlert, /d\.name = any\(\$2::text\[\]\)/);
  assert.match(global, /d\.name = any\(\$1::text\[\]\)/);
  assert.match(global, /from alert_history h[\s\S]*join alerts a on a\.id = h\.alert_id[\s\S]*join data_sources d on d\.id = a\.data_source_id/);
});

test("OV-P0-257C legacy alert endpoints and Operators use the canonical multi-source scope", async () => {
  const [list, detail, metrics, operators] = await Promise.all([
    readFile(new URL("../api/alerts/index.js", import.meta.url), "utf8"),
    readFile(new URL("../api/alerts/[id].js", import.meta.url), "utf8"),
    readFile(new URL("../api/alerts/metrics.js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-operator-queue.js", import.meta.url), "utf8"),
  ]);

  assert.match(list, /getOperationalDataSourceNames/);
  assert.match(list, /name = any\(\$1::text\[\]\)/);
  assert.match(detail, /name = any\(\$2::text\[\]\)/);
  assert.match(metrics, /where d\.name = any\(\$1::text\[\]\)/);
  assert.match(operators, /where d\.name = any\(\$1::text\[\]\)/);
});

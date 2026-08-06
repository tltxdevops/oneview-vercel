import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  attentionRequiredState,
  buildAlertListQuery,
  buildAttentionRequiredQuery,
  classifyAlertEnrichment,
  classifyOperationalSource,
  compareAttentionRequiredEntries,
  consolidateAlertHistoryItems,
  countDailyOperationalMetrics,
  dailyOperationalMetricQueries,
  getAttentionThresholds,
  GLOBAL_HISTORY_EVENT_TYPES,
  historyTitle,
  historyValueIsMeaningful,
  resolveAckActorName,
  resolveSourceAck,
  safeCustomerIdentity,
} from "../api/_lib/oneview-db.js";
import { getOneViewSnapshotPayload } from "../api/_lib/oneview-fallback.js";
import { createOneViewHandler } from "../api/_lib/oneview-response.js";

function request(method = "GET", query = {}) {
  return { method, query, headers: {} };
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(value) { this.body = value ? JSON.parse(value) : undefined; return this; },
  };
}

const authenticated = async () => ({ roles: ["viewer"] });
const liveConfig = () => ({
  snapshotMode: false,
  liveEnabled: true,
  snapshotFallbackEnabled: true,
  dbConfig: {},
});

test("métricas diárias separam resolução, ACK da origem e reconhecimento OneView", () => {
  const queries = dailyOperationalMetricQueries("America/Sao_Paulo", new Date("2026-07-22T02:30:00.000Z"));
  assert.equal(queries.day.from, "2026-07-21T03:00:00.000Z");
  assert.equal(queries.day.to, "2026-07-22T03:00:00.000Z");
  assert.match(queries.resolved.text, /d\.name = \$1/);
  assert.match(queries.resolved.text, /resolved_at >= \$2::timestamptz/);
  assert.doesNotMatch(queries.resolved.text, /acknowledged/);
  assert.match(queries.sourceAcknowledged.text, /acknowledged_source = true/);
  assert.match(queries.sourceAcknowledged.text, /acknowledged_at >= \$2::timestamptz/);
  assert.doesNotMatch(queries.sourceAcknowledged.text, /alert_acknowledgements/);
  assert.match(queries.oneViewAcknowledged.text, /from alert_acknowledgements/);
  assert.match(queries.oneViewAcknowledged.text, /requested_at >= \$2::timestamptz/);
  assert.equal(queries.oneViewAcknowledged.values[0], "teletex-http");
  assert.deepEqual(queries.oneViewAcknowledged.values[3], ["internal"]);
  assert.equal(queries.oneViewAcknowledged.values[4].includes("failed"), false);
  assert.equal(queries.oneViewAcknowledged.values[4].includes("cancelled"), false);
});

test("virada do dia operacional não usa meia-noite UTC", () => {
  const beforeMidnight = dailyOperationalMetricQueries("America/Sao_Paulo", new Date("2026-07-22T02:59:59.000Z"));
  const afterMidnight = dailyOperationalMetricQueries("America/Sao_Paulo", new Date("2026-07-22T03:00:01.000Z"));
  assert.equal(beforeMidnight.day.from, "2026-07-21T03:00:00.000Z");
  assert.equal(afterMidnight.day.from, "2026-07-22T03:00:00.000Z");
});

test("eventos de hoje contam apenas em sua própria métrica e ontem fica fora", () => {
  const metrics = countDailyOperationalMetrics({
    alerts: [
      { resolved_at: "2026-07-22T12:00:00.000Z", acknowledged_source: false },
      { resolved_at: null, acknowledged_source: true, acknowledged_at: "2026-07-22T13:00:00.000Z" },
      { resolved_at: "2026-07-21T02:59:59.000Z", acknowledged_source: true, acknowledged_at: "2026-07-21T02:59:59.000Z" },
    ],
    acknowledgements: [
      { acknowledgement_type: "internal", status: "recorded", requested_at: "2026-07-22T14:00:00.000Z" },
      { acknowledgement_type: "internal", status: "failed", requested_at: "2026-07-22T15:00:00.000Z" },
      { acknowledgement_type: "internal", status: "recorded", requested_at: "2026-07-22T02:59:59.000Z" },
    ],
  }, "America/Sao_Paulo", new Date("2026-07-22T16:00:00.000Z"));
  assert.deepEqual({
    resolved_today: metrics.resolved_today,
    source_acknowledgements_today: metrics.source_acknowledgements_today,
    oneview_acknowledgements_today: metrics.oneview_acknowledgements_today,
  }, { resolved_today: 1, source_acknowledgements_today: 1, oneview_acknowledgements_today: 1 });
});

test("fila de atenção usa first_seen_at, reconhecimento da origem e limites por severidade", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  const alert = (severity, minutes, overrides = {}) => ({
    severity,
    status_source: "active",
    resolved_at: null,
    acknowledged_source: false,
    first_seen_at: new Date(now - minutes * 60_000).toISOString(),
    last_seen_at: new Date(now - 5_000).toISOString(),
    ...overrides,
  });

  assert.equal(attentionRequiredState(alert("disaster", 6), undefined, now).matches, true);
  assert.equal(attentionRequiredState(alert("disaster", 4), undefined, now).matches, false);
  assert.equal(attentionRequiredState(alert("disaster", 5), undefined, now).matches, false);
  assert.equal(attentionRequiredState(alert("disaster", 5.1), undefined, now).matches, true);
  assert.equal(attentionRequiredState(alert("critical", 6), undefined, now).matches, true);
  assert.equal(attentionRequiredState(alert("high", 16), undefined, now).matches, true);
  assert.equal(attentionRequiredState(alert("average", 31), undefined, now).matches, true);
  assert.equal(attentionRequiredState(alert("warning", 61), undefined, now).matches, true);
  assert.equal(attentionRequiredState(alert("warning", 59), undefined, now).matches, false);
  assert.equal(attentionRequiredState(alert("disaster", 60, { acknowledged_source: true }), undefined, now).matches, false);
  assert.equal(attentionRequiredState(alert("disaster", 60, { resolved_at: "2026-07-16T11:59:00.000Z" }), undefined, now).matches, false);
});

test("fila de atenção ordena severidade e depois maior tempo sem reconhecimento", () => {
  const ordered = [
    { alert: { severity: "average" }, unacknowledgedMinutes: 90 },
    { alert: { severity: "disaster" }, unacknowledgedMinutes: 8 },
    { alert: { severity: "high" }, unacknowledgedMinutes: 20 },
    { alert: { severity: "disaster" }, unacknowledgedMinutes: 30 },
  ].sort(compareAttentionRequiredEntries);

  assert.deepEqual(
    ordered.map((entry) => [entry.alert.severity, entry.unacknowledgedMinutes]),
    [["disaster", 30], ["disaster", 8], ["high", 20], ["average", 90]],
  );
});

test("fila de atenção usa defaults seguros, limita 200 e neutraliza entrada inválida", () => {
  assert.deepEqual(getAttentionThresholds({}), {
    disasterMinutes: 5,
    highMinutes: 15,
    averageMinutes: 30,
    lowMinutes: 60,
  });
  const query = buildAttentionRequiredQuery(request("GET", { limit: "5000" }), getAttentionThresholds({}));
  assert.equal(query.limit, 200);
  assert.deepEqual(query.values, [5, 15, 30, 60, "teletex-http"]);
  assert.match(query.whereSql, /scope_d\.name = \$5/);
  assert.match(query.whereSql, /a\.first_seen_at < now\(\)/);
  assert.match(query.whereSql, /severity in \('disaster', 'critical'\)/);
  assert.match(query.whereSql, /severity in \('warning', 'information', 'not_classified'\)/);
  assert.doesNotMatch(query.whereSql, /last_seen_at/);
  assert.match(query.orderSql, /when 'disaster' then 1 when 'critical' then 1/);
  assert.throws(
    () => buildAttentionRequiredQuery(request("GET", { limit: "100; select * from alerts" })),
    (error) => error?.code === "invalid_query",
  );

  const recentWindow = buildAttentionRequiredQuery(
    request("GET", { limit: "20", first_seen_from: "2026-08-03T10:00:00.000Z" }),
    getAttentionThresholds({}),
  );
  assert.equal(recentWindow.values[5], "2026-08-03T10:00:00.000Z");
  assert.match(recentWindow.whereSql, /a\.first_seen_at >= \$6::timestamptz/);
  assert.throws(
    () => buildAttentionRequiredQuery(request("GET", {
      first_seen_from: "2026-08-03T12:00:00.000Z",
      first_seen_to: "2026-08-03T10:00:00.000Z",
    })),
    (error) => error?.code === "invalid_query",
  );
});

test("attention-required GET retorna contrato seguro e POST retorna 405", async () => {
  const payload = {
    summary: { total: 1, disaster: 1, high: 0, average: 0, by_customer: [], by_datasource: [] },
    thresholds: { disaster_minutes: 5, high_minutes: 15, average_minutes: 30 },
    items: [{
      id: "safe-id",
      customer_name: "Cliente",
      customer_confidence: "high",
      datasource_name: "Fonte",
      host_visible_name: "Host protegido ABCD1234",
      problem: "Falha operacional",
      severity: "disaster",
      first_seen_at: "2026-07-16T10:00:00.000Z",
      last_seen_at: "2026-07-16T11:00:00.000Z",
      unacknowledged_minutes: 60,
      acknowledged: false,
    }],
  };
  let databaseCalled = false;
  const getResponse = response();
  await createOneViewHandler("attention-required", {
    authorize: authenticated,
    configProvider: liveConfig,
    database: async () => { databaseCalled = true; return payload; },
    logger: () => undefined,
  })(request(), getResponse);
  assert.equal(databaseCalled, true);
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.body.data_source, "database");
  assert.equal(getResponse.body.summary.total, 1);
  assert.doesNotMatch(JSON.stringify(getResponse.body), /payload_raw|payload_normalized|inventory|api_url|token|password|senha|https?:\/\/|\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2})\b/i);

  databaseCalled = false;
  const postResponse = response();
  await createOneViewHandler("attention-required", {
    authorize: authenticated,
    configProvider: liveConfig,
    database: async () => { databaseCalled = true; return payload; },
  })(request("POST"), postResponse);
  assert.equal(postResponse.statusCode, 405);
  assert.equal(databaseCalled, false);
});

test("attention-required sem autenticação retorna 401", async () => {
  const previous = process.env.ONEVIEW_API_AUTH_REQUIRED;
  process.env.ONEVIEW_API_AUTH_REQUIRED = "true";
  try {
    const res = response();
    await createOneViewHandler("attention-required")(request(), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "authentication_required" });
  } finally {
    if (previous === undefined) delete process.env.ONEVIEW_API_AUTH_REQUIRED;
    else process.env.ONEVIEW_API_AUTH_REQUIRED = previous;
  }
});

test("attention-required em snapshot preserva segurança e informa contingência", async () => {
  const payload = await getOneViewSnapshotPayload(
    "attention-required",
    request("GET", { limit: "200" }),
    { attentionThresholds: getAttentionThresholds({}) },
  );
  assert.ok(payload.items.length <= 200);
  assert.equal(payload.summary.total, payload.summary.disaster + payload.summary.critical + payload.summary.high + payload.summary.average + payload.summary.low);
  assert.equal(payload.snapshot_coverage.partial, true);
  assert.doesNotMatch(JSON.stringify(payload), /payload_raw|payload_normalized|inventory|api_url|token|password|senha|https?:\/\/|\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2})\b/i);
});

test("paginação gera páginas distintas e limita page_size a 100", () => {
  const first = buildAlertListQuery(request("GET", { page: "1", page_size: "50" }));
  const second = buildAlertListQuery(request("GET", { page: "2", page_size: "50" }));
  const capped = buildAlertListQuery(request("GET", { page: "3", page_size: "5000" }));

  assert.deepEqual([first.page, first.pageSize, first.offset], [1, 50, 0]);
  assert.deepEqual([second.page, second.pageSize, second.offset], [2, 50, 50]);
  assert.deepEqual([capped.page, capped.pageSize, capped.offset], [3, 100, 200]);
  assert.match(first.whereSql, /a\.resolved_at is null/);
  assert.match(first.whereSql, /status_internal/);
});

test("status active, resolved e all usam predicados antes da paginacao", () => {
  const active = buildAlertListQuery(request("GET", { status: "active", page: "2", page_size: "25" }));
  const resolved = buildAlertListQuery(request("GET", { status: "resolved", page: "3", page_size: "25" }));
  const all = buildAlertListQuery(request("GET", { status: "all", page: "1", page_size: "25" }));

  assert.match(active.whereSql, /a\.resolved_at is null/);
  assert.match(active.whereSql, /status_internal/);
  assert.match(resolved.whereSql, /a\.resolved_at is not null/);
  assert.match(resolved.whereSql, /'normalized'/);
  assert.match(all.whereSql, /d\.name = \$1/);
  assert.deepEqual([resolved.page, resolved.pageSize, resolved.offset], [3, 25, 50]);
});

test("ACK da origem e reconhecimento interno usam filtros independentes no BFF", () => {
  const query = buildAlertListQuery(request("GET", {
    acknowledged_source: "true",
    acknowledged_internal: "false",
  }));
  assert.equal(query.filters.acknowledgedSource, "true");
  assert.equal(query.filters.acknowledgedInternal, "false");
  assert.match(query.whereSql, /acknowledged_source/);
  assert.match(query.whereSql, /acknowledged_internal/);
  assert.deepEqual(query.params, ["teletex-http", true, false]);
});

test("resolvidos combinam cliente, datasource, busca e recovery parametrizados", () => {
  const query = buildAlertListQuery(request("GET", {
    status: "resolved",
    customer: "fps",
    datasource: "teletex-http",
    search: "link indisponivel",
    sort: "resolved_at",
    order: "desc",
  }));

  assert.equal(query.filters.status, "resolved");
  assert.deepEqual(query.filters.customers, ["fps"]);
  assert.deepEqual(query.filters.datasources, ["teletex-http"]);
  assert.match(query.whereSql, /customer_key/);
  assert.match(query.whereSql, /d\.name/);
  assert.match(query.whereSql, /ilike \$\d+/);
  assert.match(query.orderSql, /^a\.resolved_at DESC nulls last/);
  assert.equal(query.params.includes("%link indisponivel%"), true);
});

test("filtros, multisseleção, datas, busca e sort ficam parametrizados", () => {
  const injection = "%' OR 1=1 --";
  const query = buildAlertListQuery(request("GET", {
    client: ["Castrolanda", "Zurich"],
    customer: ["ailos", "fps"],
    datasource: ["teletex-http"],
    customer_confidence: ["high", "low"],
    severity: ["high", "disaster"],
    status: "resolved",
    acknowledged: "false",
    search: injection,
    host_search: "core-switch",
    problem_search: "latência alta",
    date_from: "2026-07-01T00:00:00.000Z",
    date_to: "2026-07-14T23:59:59.999Z",
    first_seen_from: "2026-07-14T22:00:00.000Z",
    first_seen_to: "2026-07-14T22:30:00.000Z",
    last_seen_from: "2026-07-14T23:00:00.000Z",
    last_seen_to: "2026-07-14T23:30:00.000Z",
    resolved_from: "2026-07-14T20:00:00.000Z",
    resolved_to: "2026-07-14T21:00:00.000Z",
    acknowledged_from: "2026-07-14T18:00:00.000Z",
    acknowledged_to: "2026-07-14T19:00:00.000Z",
    sort: "client",
    order: "asc",
  }));

  assert.deepEqual(query.filters.clients, ["Castrolanda", "Zurich"]);
  assert.deepEqual(query.filters.customers, ["ailos", "fps"]);
  assert.deepEqual(query.filters.datasources, ["teletex-http"]);
  assert.deepEqual(query.filters.customerConfidences, ["high", "low"]);
  assert.deepEqual(query.filters.severities, ["high", "disaster"]);
  assert.equal(query.filters.status, "resolved");
  assert.equal(query.filters.acknowledged, "false");
  assert.equal(query.filters.hostSearch, "core-switch");
  assert.equal(query.filters.problemSearch, "latência alta");
  assert.equal(query.filters.firstSeenFrom, "2026-07-14T22:00:00.000Z");
  assert.equal(query.filters.firstSeenTo, "2026-07-14T22:30:00.000Z");
  assert.equal(query.filters.lastSeenFrom, "2026-07-14T23:00:00.000Z");
  assert.equal(query.filters.lastSeenTo, "2026-07-14T23:30:00.000Z");
  assert.equal(query.filters.resolvedFrom, "2026-07-14T20:00:00.000Z");
  assert.equal(query.filters.resolvedTo, "2026-07-14T21:00:00.000Z");
  assert.equal(query.filters.acknowledgedFrom, "2026-07-14T18:00:00.000Z");
  assert.equal(query.filters.acknowledgedTo, "2026-07-14T19:00:00.000Z");
  assert.match(query.whereSql, /a\.client_name = any\(\$\d+::text\[\]\)/);
  assert.match(query.whereSql, /a\.customer_key = any\(\$\d+::text\[\]\)/);
  assert.match(query.whereSql, /d\.name = any\(\$\d+::text\[\]\)/);
  assert.match(query.whereSql, /coalesce\(a\.customer_confidence, 'unclassified'\) = any\(\$\d+::text\[\]\)/);
  assert.match(query.whereSql, /a\.severity = any\(\$\d+::text\[\]\)/);
  assert.match(query.whereSql, /a\.first_seen_at >= \$\d+/);
  assert.match(query.whereSql, /a\.first_seen_at <= \$\d+/);
  assert.match(query.whereSql, /a\.last_seen_at >= \$\d+/);
  assert.match(query.whereSql, /a\.last_seen_at <= \$\d+/);
  assert.match(query.whereSql, /a\.resolved_at >= \$\d+/);
  assert.match(query.whereSql, /a\.resolved_at <= \$\d+/);
  assert.match(query.whereSql, /a\.acknowledged_at >= \$\d+/);
  assert.match(query.whereSql, /a\.acknowledged_at <= \$\d+/);
  assert.doesNotMatch(query.baseWhereSql, /first_seen_at|last_seen_at|resolved_at >=|resolved_at <=|acknowledged_at/);
  assert.match(query.baseWhereSql, /customer_key/);
  assert.match(query.whereSql, /host_visible_name/);
  assert.match(query.whereSql, /problem_name/);
  assert.match(query.orderSql, /^case[\s\S]+Cliente não identificado[\s\S]+a\.customer_name[\s\S]+end ASC/);
  assert.doesNotMatch(`${query.whereSql}\n${query.orderSql}`, /OR 1=1/);
  assert.equal(query.params.includes(`%${injection}%`), true);
  assert.equal(query.params.includes("%core-switch%"), true);
  assert.equal(query.params.includes("%latência alta%"), true);
});

test("ordena explicitamente por criação ou última atualização", () => {
  const newest = buildAlertListQuery(request("GET", { sort: "first_seen_at", order: "desc" }));
  const mostRecent = buildAlertListQuery(request("GET", { sort: "last_seen_at", order: "desc" }));
  assert.match(newest.orderSql, /^a\.first_seen_at DESC/);
  assert.match(mostRecent.orderSql, /^a\.last_seen_at DESC/);
});

test("filtros canônicos não convertem disaster em high nem high em critical", () => {
  const query = buildAlertListQuery(request("GET", {
    status: "active",
    severity: ["disaster"],
    sort: "severity",
    order: "desc",
    page_size: "15",
  }));
  const high = buildAlertListQuery(request("GET", { severity: ["high"] }));
  const critical = buildAlertListQuery(request("GET", { severity: ["critical"] }));
  assert.deepEqual(query.filters.severities, ["disaster"]);
  assert.deepEqual(high.filters.severities, ["high"]);
  assert.deepEqual(critical.filters.severities, ["critical"]);
  assert.equal(query.pageSize, 15);
  assert.match(query.orderSql, /when 'disaster' then 7 when 'critical' then 6 when 'high' then 5/);
  assert.match(query.orderSql, /DESC, a\.first_seen_at desc, a\.last_seen_at desc/);
});

test("sort_secondary duration/resolved_at no desempate de severity (OV-P0-34)", () => {
  const byDuration = buildAlertListQuery(request("GET", {
    status: "active",
    severity: ["disaster", "high"],
    sort: "severity",
    order: "desc",
    sort_secondary: "duration",
  }));
  const byResolved = buildAlertListQuery(request("GET", {
    status: "resolved",
    severity: ["disaster", "high"],
    sort: "severity",
    order: "desc",
    sort_secondary: "resolved_at",
  }));
  assert.equal(byDuration.filters.sortSecondary, "duration");
  assert.match(byDuration.orderSql, /DESC, a\.duration_seconds DESC/);
  assert.equal(byResolved.filters.sortSecondary, "resolved_at");
  assert.match(byResolved.orderSql, /DESC, a\.resolved_at DESC nulls last/);
  assert.throws(
    () => buildAlertListQuery(request("GET", { sort: "severity", sort_secondary: "severity" })),
    (error) => error?.code === "invalid_query" && error?.status === 400,
  );
});

test("atalho da Home (desastre sem ACK) gera filtro válido sem 400", () => {
  const query = buildAlertListQuery(request("GET", {
    status: "active",
    severity: ["disaster"],
    acknowledged_source: "false",
    sort: "first_seen_at",
    order: "desc",
    first_seen_from: "2026-07-22",
  }));
  assert.deepEqual(query.filters.severities, ["disaster"]);
  assert.equal(query.filters.status, "active");
  assert.equal(query.filters.acknowledgedSource, "false");
  assert.match(query.filters.firstSeenFrom, /^2026-07-22/);
  assert.doesNotMatch(JSON.stringify(query.filters.severities), /high|critical/);
});

test("labels PT-BR de prioridade são rejeitados pelo BFF", () => {
  for (const severity of ["Desastre", "Crítico", "Alto", "Médio", "Aviso"]) {
    assert.throws(
      () => buildAlertListQuery(request("GET", { severity: [severity] })),
      (error) => error?.code === "invalid_query" && error?.status === 400,
    );
  }
});

test("família desastre + alto ficam separados nos filtros", () => {
  const combined = buildAlertListQuery(request("GET", { severity: ["disaster", "high"] }));
  assert.deepEqual(combined.filters.severities, ["disaster", "high"]);
  assert.ok(!combined.filters.severities.includes("critical"));
});

for (const query of [
  { page: "0" },
  { page: String(Number.MAX_SAFE_INTEGER), page_size: "100" },
  { status: "closed" },
  { acknowledged: "yes" },
  { severity: "catastrophic" },
  { customer_confidence: "certain" },
  { sort: "select * from alerts" },
  { order: "sideways" },
  { date_from: "2026-07-14", date_to: "2026-07-01" },
  { first_seen_from: "ontem" },
  { first_seen_from: "2026-07-15", first_seen_to: "2026-07-14" },
  { last_seen_from: "agora" },
  { last_seen_from: "2026-07-15", last_seen_to: "2026-07-14" },
  { resolved_from: "ontem" },
  { resolved_from: "2026-07-15", resolved_to: "2026-07-14" },
  { acknowledged_from: "ontem" },
  { acknowledged_from: "2026-07-15", acknowledged_to: "2026-07-14" },
]) {
  test(`entrada inválida retorna invalid_query: ${JSON.stringify(query)}`, () => {
    assert.throws(() => buildAlertListQuery(request("GET", query)), (error) => error?.code === "invalid_query" && error?.status === 400);
  });
}

test("snapshot aplica paginação, filtros e informa cobertura parcial", async () => {
  const first = await getOneViewSnapshotPayload("alerts", request("GET", { page: "1", page_size: "25", status: "all" }));
  const second = await getOneViewSnapshotPayload("alerts", request("GET", { page: "2", page_size: "25", status: "all" }));

  assert.equal(first.items.length, 25);
  assert.equal(second.items.length, 25);
  assert.equal(first.pagination.page, 1);
  assert.equal(second.pagination.page, 2);
  assert.equal(first.items.some((item) => second.items.some((other) => other.id === item.id)), false);
  assert.equal(first.snapshot_coverage.partial, true);
  assert.equal(first.snapshot_coverage.available_items, first.pagination.total_items);
  assert.ok(first.items.every((item) => item.datasource_name === "teletex-http"));
  assert.ok(first.snapshot_coverage.total_persisted >= first.snapshot_coverage.available_items);
  assert.equal(first.filtered_summary.total, first.pagination.total_items);
  assert.deepEqual(Object.keys(first.filtered_summary.by_severity), [
    "information",
    "warning",
    "average",
    "high",
    "disaster",
  ]);
  assert.equal(typeof first.filtered_summary.not_classified, "number");
  assert.equal(Object.hasOwn(first.filtered_summary.by_severity, "low"), false);
  assert.ok(
    Object.values(first.filtered_summary.by_severity).every((value) => Number.isInteger(value) && value >= 0),
  );
  assert.ok(Number.isInteger(first.filtered_summary.not_classified) && first.filtered_summary.not_classified >= 0);
  assert.deepEqual(Object.keys(first.temporal_counts.created), ["15m", "1h", "6h", "24h", "7d"]);
  assert.deepEqual(Object.keys(first.temporal_counts.updated), ["15m", "1h", "6h", "24h", "7d"]);
  assert.deepEqual(Object.keys(first.temporal_counts.resolved), ["15m", "1h", "6h", "24h", "7d", "30d"]);
});

test("OV-P0-39: filtered_summary separa warning/information e agrega critical em high (snapshot)", async () => {
  const probe = await getOneViewSnapshotPayload("alerts", request("GET", { page_size: "1", status: "all" }));
  const totalItems = probe.pagination.total_items;
  const pageSize = 100;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const allItems = [];
  let summary = null;

  for (let page = 1; page <= totalPages; page += 1) {
    const payload = await getOneViewSnapshotPayload("alerts", request("GET", {
      page: String(page),
      page_size: String(pageSize),
      status: "all",
    }));
    assert.ok(payload.items.length <= pageSize);
    assert.equal(payload.pagination.page_size, pageSize);
    assert.equal(payload.filtered_summary.total, totalItems);
    assert.equal(payload.pagination.total_items, totalItems);
    if (!summary) summary = payload.filtered_summary;
    else assert.deepEqual(payload.filtered_summary, summary);
    allItems.push(...payload.items);
  }

  assert.equal(allItems.length, totalItems);
  assert.deepEqual(Object.keys(summary.by_severity), [
    "information",
    "warning",
    "average",
    "high",
    "disaster",
  ]);
  assert.equal(Object.hasOwn(summary.by_severity, "low"), false);
  assert.equal(typeof summary.not_classified, "number");

  const count = (severity) => allItems.filter((item) => item.severity === severity).length;
  assert.equal(summary.by_severity.information, count("information"));
  assert.equal(summary.by_severity.warning, count("warning"));
  assert.equal(summary.by_severity.average, count("average"));
  assert.equal(summary.by_severity.high, count("high") + count("critical"));
  assert.equal(summary.by_severity.disaster, count("disaster"));
  assert.equal(summary.not_classified, count("not_classified"));
  // Warning e Information nunca compartilham o mesmo bucket
  assert.equal(
    summary.by_severity.warning + summary.by_severity.information,
    count("warning") + count("information"),
  );
  // Disaster nunca entra em high
  assert.equal(
    summary.by_severity.high,
    allItems.filter((item) => item.severity === "high" || item.severity === "critical").length,
  );
});

test("snapshot fornece detalhe seguro e histórico vazio para ID existente", async () => {
  const list = await getOneViewSnapshotPayload("alerts", request("GET", { page_size: "1", status: "all" }));
  const id = list.items[0].id;
  const detail = await getOneViewSnapshotPayload("alert-detail", request("GET", { id }));
  const history = await getOneViewSnapshotPayload("alert-history", request("GET", { id }));
  const serialized = JSON.stringify({ detail, history });

  assert.equal(detail.item.id, id);
  assert.match(detail.item.host_name, /^Host protegido [A-F0-9]{8}$/);
  assert.equal(detail.item.host_ip, null);
  assert.equal(detail.item.enrichment_status, "pending");
  assert.equal(detail.item.customer_name, null);
  assert.deepEqual(detail.item.host_groups, []);
  assert.deepEqual(history.items, []);
  assert.equal(history.history_available, false);
  assert.equal(history.history_partial, false);
  assert.equal(history.first_event_at, null);
  assert.equal(history.last_event_at, null);
  assert.equal(history.has_recovery, false);
  assert.equal(history.has_ack, false);
  assert.doesNotMatch(serialized, /payload_raw|payload_normalized|fingerprint|https?:\/\/|\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2})\b/i);
});

test("event_type do histórico recebe nome amigável", () => {
  const expected = {
    problem_created: "Alerta identificado",
    problem_seen: "Ocorrência atualizada",
    severity_changed: "Severidade alterada",
    acknowledged: "Alerta reconhecido na origem",
    internal_acknowledged: "Reconhecido no OneView",
    ack_message: "Comentário adicionado ao reconhecimento",
    suppressed: "Alerta suprimido",
    unsuppressed: "Supressão encerrada",
    maintenance: "Evento de manutenção",
    recovered: "Alerta resolvido",
    reopened: "Alerta reaberto",
    status_changed: "Status alterado",
  };
  for (const [eventType, title] of Object.entries(expected)) {
    assert.equal(historyTitle(eventType), title);
  }
});

test("histórico global operacional exclui técnicos e resolution só recovered (OV-P0-10)", () => {
  assert.deepEqual(GLOBAL_HISTORY_EVENT_TYPES.operational, [
    "problem_created",
    "created_from_zabbix",
    "acknowledged",
    "ack_message",
    "severity_changed",
    "recovered",
    "maintenance",
    "suppressed",
    "unsuppressed",
  ]);
  assert.deepEqual(GLOBAL_HISTORY_EVENT_TYPES.identified, ["problem_created", "created_from_zabbix"]);
  assert.deepEqual(GLOBAL_HISTORY_EVENT_TYPES.actions, [
    "acknowledged",
    "ack_message",
    "severity_changed",
    "recovered",
    "maintenance",
    "suppressed",
    "unsuppressed",
  ]);
  assert.deepEqual(GLOBAL_HISTORY_EVENT_TYPES.resolution, ["recovered"]);
  assert.deepEqual(GLOBAL_HISTORY_EVENT_TYPES.acks, ["acknowledged", "ack_message"]);
  assert.ok(!GLOBAL_HISTORY_EVENT_TYPES.resolution.includes("resolved_by_reconciliation"));
  assert.ok(!GLOBAL_HISTORY_EVENT_TYPES.operational.includes("problem_seen"));
  assert.ok(!GLOBAL_HISTORY_EVENT_TYPES.operational.includes("status_changed"));
  assert.ok(!GLOBAL_HISTORY_EVENT_TYPES.operational.includes("internal_acknowledged"));
  assert.ok(!GLOBAL_HISTORY_EVENT_TYPES.operational.includes("resolved_by_reconciliation"));
});

test("responsável do ACK rejeita identificador numérico e respeita prioridade nominal", () => {
  assert.equal(resolveAckActorName("Analista principal", "Operador alternativo", "Nome legado"), "Analista principal");
  assert.equal(resolveAckActorName("53", "Operador alternativo", "Nome legado"), "Operador alternativo");
  assert.equal(resolveAckActorName("53", "71", "Nome legado"), "Nome legado");
  assert.equal(resolveAckActorName("53", "71", "92"), null);
  assert.notEqual(resolveAckActorName("53"), "53");
});

function historyFixture(overrides = {}) {
  return {
    id: "history-id",
    event_type: "problem_seen",
    title: "Ocorrência atualizada",
    description: null,
    previous_value: null,
    current_value: null,
    source_event_id: "safe-event",
    occurred_at: "2026-07-17T12:00:00.000Z",
    created_at: "2026-07-17T12:00:01.000Z",
    actor_name: null,
    ack_actor_name: null,
    ack_actor_unresolved: false,
    actor_type: null,
    source: "Zabbix",
    origin: "worker",
    legacy: false,
    ...overrides,
  };
}

test("ACK e comentário do mesmo update são consolidados em um único card", () => {
  const items = consolidateAlertHistoryItems([
    historyFixture({ id: "ack", event_type: "acknowledged", title: "Alerta reconhecido", acknowledge_id: "42", ack_actor_name: "Analista NOC", actor_name: "Analista NOC" }),
    historyFixture({ id: "message", event_type: "ack_message", title: "Comentário adicionado ao reconhecimento", description: "Em tratamento", acknowledge_id: "42", ack_actor_name: "Analista NOC", actor_name: "Analista NOC" }),
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].event_type, "acknowledged");
  assert.equal(items[0].grouped_event_count, 2);
  assert.equal(items[0].comment, "Em tratamento");
  assert.equal(items[0].ack_actor_name, "Analista NOC");
  assert.equal(items[0].acknowledge_id, "42");
});

test("resolveSourceAck monta comentário, ator e horário a partir do histórico", () => {
  const sourceAck = resolveSourceAck(
    {
      acknowledged_source: true,
      acknowledged_by: "99999",
      acknowledged_at: "2025-10-14T11:24:34.000Z",
    },
    [
      historyFixture({
        id: "ack",
        event_type: "acknowledged",
        acknowledge_id: "1001",
        occurred_at: "2025-10-14T11:24:34.000Z",
        ack_actor_name: "Richard Malaga",
        actor_name: "Richard Malaga",
      }),
      historyFixture({
        id: "message",
        event_type: "ack_message",
        acknowledge_id: "1001",
        description: "Em análise no NOC",
        occurred_at: "2025-10-14T11:24:34.000Z",
        ack_actor_name: "Richard Malaga",
        actor_name: "Richard Malaga",
      }),
    ],
  );

  assert.equal(sourceAck.acknowledged, true);
  assert.equal(sourceAck.actor_name, "Richard Malaga");
  assert.equal(sourceAck.comment, "Em análise no NOC");
  assert.equal(sourceAck.acknowledge_id, "1001");
  assert.equal(sourceAck.history_available, true);
  assert.equal(sourceAck.acknowledged_at, "2025-10-14T11:24:34.000Z");
});

test("resolveSourceAck sem comentário preserva ator e marca histórico disponível", () => {
  const sourceAck = resolveSourceAck(
    { acknowledged_source: true, acknowledged_by: "Richard Malaga", acknowledged_at: "2025-10-14T11:24:34.000Z" },
    [
      historyFixture({
        id: "ack",
        event_type: "acknowledged",
        acknowledge_id: "1002",
        occurred_at: "2025-10-14T11:24:34.000Z",
        ack_actor_name: "Richard Malaga",
        actor_name: "Richard Malaga",
      }),
    ],
  );
  assert.equal(sourceAck.comment, null);
  assert.equal(sourceAck.actor_name, "Richard Malaga");
  assert.equal(sourceAck.history_available, true);
});

test("resolveSourceAck sem histórico usa estado atual e não inventa comentário", () => {
  const sourceAck = resolveSourceAck({
    acknowledged_source: true,
    acknowledged_source_by: "Richard Malaga",
    acknowledged_source_at: "2025-10-14T11:24:34.000Z",
  }, []);
  assert.equal(sourceAck.acknowledged, true);
  assert.equal(sourceAck.actor_name, "Richard Malaga");
  assert.equal(sourceAck.comment, null);
  assert.equal(sourceAck.acknowledge_id, null);
  assert.equal(sourceAck.history_available, false);
});

test("resolveSourceAck nunca devolve ID numérico como responsável", () => {
  const sourceAck = resolveSourceAck(
    { acknowledged_source: true, acknowledged_by: "12345", acknowledged_at: "2025-10-14T11:24:34.000Z" },
    [
      historyFixture({
        id: "ack",
        event_type: "acknowledged",
        acknowledge_id: "77",
        ack_actor_name: null,
        actor_name: null,
        ack_actor_unresolved: true,
      }),
    ],
  );
  assert.equal(sourceAck.actor_name, null);
  assert.doesNotMatch(String(sourceAck.actor_name || ""), /^\d+$/);
});

test("ACKs de pessoas diferentes permanecem separados e ordenados por occurred_at", () => {
  const items = consolidateAlertHistoryItems([
    historyFixture({ id: "older", event_type: "acknowledged", occurred_at: "2026-07-17T11:00:00.000Z", ack_actor_name: "Analista A" }),
    historyFixture({ id: "newer", event_type: "acknowledged", occurred_at: "2026-07-17T12:00:00.000Z", ack_actor_name: "Analista B" }),
  ]);

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.ack_actor_name), ["Analista B", "Analista A"]);
});

test("reconhecimento interno não é consolidado com ACK da origem", () => {
  const items = consolidateAlertHistoryItems([
    historyFixture({ id: "source-ack", event_type: "acknowledged", acknowledge_id: "ack-1" }),
    historyFixture({ id: "internal-ack", event_type: "internal_acknowledged", acknowledge_id: "ack-1" }),
  ]);
  assert.equal(items.length, 2);
  assert.equal(items.some((item) => item.event_type === "acknowledged"), true);
  assert.equal(items.some((item) => item.event_type === "internal_acknowledged"), true);
});

test("recovery permanece depois da criacao na cronologia e preserva horarios distintos", () => {
  const items = consolidateAlertHistoryItems([
    historyFixture({ id: "created", event_type: "problem_created", occurred_at: "2026-07-17T10:00:00.000Z", created_at: "2026-07-17T10:00:03.000Z" }),
    historyFixture({ id: "recovered", event_type: "recovered", title: "Alerta resolvido", occurred_at: "2026-07-17T12:00:00.000Z", created_at: "2026-07-17T12:00:04.000Z" }),
  ]);

  assert.deepEqual(items.map((item) => item.id), ["recovered", "created"]);
  assert.equal(items[0].occurred_at, "2026-07-17T12:00:00.000Z");
  assert.equal(items[0].created_at, "2026-07-17T12:00:04.000Z");
});

test("historico legado permanece explicitamente marcado", () => {
  const [legacy] = consolidateAlertHistoryItems([
    historyFixture({ id: "legacy", event_type: "created_from_zabbix", legacy: true, source: "Histórico legado", description: null }),
  ]);

  assert.equal(legacy.legacy, true);
  assert.equal(legacy.source, "Histórico legado");
});

test("valor técnico legacy vazio não gera comparação visual", () => {
  for (const value of [null, "", "-", "new", "null", "undefined", { status: "new" }]) {
    assert.equal(historyValueIsMeaningful(value), false);
  }
  assert.equal(historyValueIsMeaningful({ severity: "high" }), true);
});

test("enriquecimento diferencia completo, parcial, legado e não classificado", () => {
  assert.equal(classifyAlertEnrichment({ customer_name: "Cliente Real", customer_confidence: "high" }), "complete");
  assert.equal(classifyAlertEnrichment({ customer_name: "Cliente Real", customer_confidence: "low" }), "partial");
  assert.equal(classifyAlertEnrichment({ customer_name: null, customer_confidence: null }), "legacy");
  assert.equal(classifyAlertEnrichment({ customer_name: "Cliente não classificado", customer_confidence: "low" }), "unclassified");
  assert.equal(classifyAlertEnrichment({ customer_name: "teletex-http", customer_source: "datasource_fallback", customer_confidence: "high" }), "unclassified");
});

test("datasource_fallback nunca vira nome de cliente", () => {
  assert.deepEqual(safeCustomerIdentity({
    customer_name: "teletex-http",
    customer_key: "teletex-http",
    customer_source: "datasource_fallback",
  }), {
    customerName: null,
    customerKey: "unclassified",
    unidentified: true,
  });

  const query = buildAlertListQuery(request("GET", { customer: "unclassified" }));
  assert.match(query.whereSql, /customer_source[\s\S]+datasource_fallback/);
  assert.match(query.whereSql, /customer_key[\s\S]+unclassified/);
  assert.doesNotMatch(query.whereSql, /client_name =/);
});

test("BFF seleciona enriquecimento seguro e histórico estruturado", async () => {
  const source = await readFile(new URL("../api/_lib/oneview-db.js", import.meta.url), "utf8");
  for (const field of [
    "customer_name",
    "customer_key",
    "customer_source",
    "customer_confidence",
    "host_visible_name",
    "host_technical_name",
    "acknowledged_at",
    "maintenance_status",
    "host_groups",
    "event_tags",
    "trigger_tags",
    "host_tags",
    "occurred_at",
    "previous_value",
    "current_value",
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`));
  }
  assert.match(source, /order by occurred_at desc nulls last, created_at desc, id desc/);
  assert.match(source, /'internal_acknowledged'::text as event_type/);
  assert.match(source, /\.sort\(\(left, right\) => Date\.parse\(right\.occurred_at\) - Date\.parse\(left\.occurred_at\)\)/);
  assert.match(source, /history_partial: items\.some/);
  assert.match(source, /first_event_at: items\.at\(-1\)/);
  assert.match(source, /last_event_at: items\[0\]/);
  assert.match(source, /has_recovery: items\.some/);
  assert.match(source, /has_ack: items\.some/);
  assert.match(source, /resolveAckActorName\(row\.actor_name_candidate, row\.operator_name_candidate, row\.acknowledged_by_candidate\)/);
  assert.match(source, /ack_actor_name: ackActorName/);
  assert.match(source, /consolidateAlertHistoryItems\(mappedItems\)/);
  assert.doesNotMatch(source.match(/async function fetchAlertHistoryPayload[\s\S]*?export function classifyOperationalSource/)?.[0] ?? "", /actor_id/);
  assert.doesNotMatch(source.match(/async function fetchAlertDetailPayload[\s\S]*?function historyTitle/)?.[0] ?? "", /payload_raw|payload_normalized|inventory/);
});

test("timeline usa origem segura, horario da origem e registro no OneView sem descricao sintetica", async () => {
  const databaseSource = await readFile(new URL("../api/_lib/oneview-db.js", import.meta.url), "utf8");
  const pageSource = await readFile(new URL("../src/pages/Alerts.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(databaseSource, /O alerta foi registrado pelo Zabbix/);
  assert.match(databaseSource, /source: historySource\(row\.source, legacy\)/);
  assert.match(pageSource, /historyOrigin/);
  assert.match(pageSource, /Fonte Zabbix/);
  assert.match(pageSource, /Hist.rico legado/);
  assert.match(pageSource, /Hor.rio da origem:/);
  assert.match(pageSource, /Registrado no OneView:/);
  assert.match(pageSource, /Integridade do hist.rico/);
});

test("tela usa status no BFF, nao filtra pagina localmente e oculta ACK em resolvidos", async () => {
  const pageSource = await readFile(new URL("../src/pages/Alerts.tsx", import.meta.url), "utf8");
  assert.match(pageSource, /status: statusFilter/);
  assert.doesNotMatch(pageSource, /Reconhecer no OneView|<UserCheck className="h-3\.5 w-3\.5" \/> ACK<\/Button>/);
  assert.doesNotMatch(pageSource, /alerts\.filter\(/);
});

test("clients-summary separa clientes internos de datasources", async () => {
  const facets = await getOneViewSnapshotPayload("clients-summary", request());
  assert.ok(Array.isArray(facets.customers));
  assert.ok(Array.isArray(facets.datasources));
  assert.ok(facets.customers.some((item) => item.enrichment_status === "pending"));
});

test("OV-P0-42B clients-summary windowed agrega top_clients e separa unclassified", async () => {
  const from = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const payload = await getOneViewSnapshotPayload(
    "clients-summary",
    request("GET", { status: "active", first_seen_from: from, limit: "5" }),
  );
  assert.equal(payload.window?.field, "first_seen_at");
  assert.ok(payload.window?.from);
  assert.ok(Array.isArray(payload.top_clients));
  assert.ok(payload.top_clients.length <= 5);
  assert.equal(Object.hasOwn(payload, "unclassified_count"), true);
  assert.ok(Number.isInteger(payload.total_active));
  assert.ok(payload.total_active >= 0);
  assert.ok(Number.isInteger(payload.unclassified_count));
  assert.ok(!payload.top_clients.some((item) => item.customer_key === "unclassified"));
  assert.deepEqual(payload.customers, []);
  assert.equal(typeof payload.partial, "boolean");
});

test("400 e 404 do database não acionam fallback", async () => {
  for (const [code, status] of [["invalid_query", 400], ["not_found", 404]]) {
    let fallbackCalled = false;
    const res = response();
    await createOneViewHandler("alert-detail", {
      authorize: authenticated,
      configProvider: liveConfig,
      database: async () => { const error = new Error(code); error.code = code; throw error; },
      fallback: async () => { fallbackCalled = true; return {}; },
      logger: () => undefined,
    })(request("GET", { id: "00000000-0000-0000-0000-000000000000" }), res);

    assert.equal(res.statusCode, status);
    assert.equal(res.body.error, code);
    assert.equal(res.body.data_source, "database");
    assert.equal(fallbackCalled, false);
  }
});

test("detalhe e histórico database retornam contrato explícito", async () => {
  for (const [route, payload] of [
    ["alert-detail", { item: { id: "safe-id", host_name: "Host protegido ABCD1234" } }],
    ["alert-history", { alert_id: "safe-id", items: [], total_items: 0 }],
  ]) {
    const res = response();
    await createOneViewHandler(route, {
      authorize: authenticated,
      configProvider: liveConfig,
      database: async () => payload,
      logger: () => undefined,
    })(request("GET", { id: "00000000-0000-0000-0000-000000000000" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data_source, "database");
    assert.match(res.body.checked_at, /Z$/);
  }
});

test("logs de rotas dinâmicas usam template e não registram ID", async () => {
  const entries = [];
  const id = "00000000-0000-0000-0000-000000000000";
  const res = response();
  await createOneViewHandler("alert-detail", {
    authorize: authenticated,
    configProvider: liveConfig,
    database: async () => ({ item: { id: "safe" } }),
    logger: (entry) => entries.push(JSON.parse(entry)),
  })(request("GET", { id }), res);
  assert.equal(entries[0].route, "/api/oneview/alerts/:id");
  assert.doesNotMatch(JSON.stringify(entries), new RegExp(id));
});

test("saúde operacional classifica healthy, error, stale e disabled", () => {
  const now = Date.parse("2026-07-14T12:00:00.000Z");
  const base = {
    status: "active",
    sync_enabled: true,
    sync_interval_seconds: 60,
    last_sync_status: "success",
    last_activity_at: "2026-07-14T11:59:30.000Z",
    failure_count: 0,
  };
  assert.equal(classifyOperationalSource(base, now).status, "healthy");
  assert.equal(classifyOperationalSource({ ...base, status: "error" }, now).status, "error");
  assert.equal(classifyOperationalSource({ ...base, last_activity_at: "2026-07-14T11:55:00.000Z" }, now).status, "stale");
  assert.equal(classifyOperationalSource({ ...base, sync_enabled: false, status: "error" }, now).status, "disabled");
});

for (const route of ["alert-detail", "alert-history", "operations-health"]) {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`${route} ${method} retorna 405 antes de qualquer consulta`, async () => {
      let databaseCalled = false;
      const res = response();
      await createOneViewHandler(route, {
        authorize: authenticated,
        configProvider: liveConfig,
        database: async () => { databaseCalled = true; return {}; },
      })(request(method), res);
      assert.equal(res.statusCode, 405);
      assert.equal(databaseCalled, false);
    });
  }
}

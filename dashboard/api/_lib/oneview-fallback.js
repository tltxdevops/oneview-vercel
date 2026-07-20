import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  attentionRequiredState,
  buildAlertListQuery,
  buildAttentionRequiredQuery,
  classifyAlertEnrichment,
  classifyOperationalSource,
  compareAttentionRequiredEntries,
  getAttentionThresholds,
} from "./oneview-db.js";

const snapshotPath = new URL("../../src/lib/oneview-real-snapshot.safe.json", import.meta.url);
let snapshotPromise;

function loadSnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = readFile(snapshotPath, "utf8").then(JSON.parse);
  }
  return snapshotPromise;
}

function oneQueryValue(req, key) {
  const value = req.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function asInt(value, fallback, { min = 0, max = 1000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function countBy(items, keyOf, mapper) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([key, count]) => mapper(key, count));
}

function snapshotAlert(alert, generatedAt) {
  const hostSeed = String(alert.host_alias || alert.id || "host");
  const hostDigest = createHash("sha256").update(hostSeed).digest("hex").slice(0, 8).toUpperCase();
  const enrichmentState = classifyAlertEnrichment({
    customer_name: alert.customer_name,
    customer_confidence: alert.customer_confidence,
  });
  return {
    id: String(alert.id || ""),
    data_source_id: String(alert.data_source_id || ""),
    datasource_name: String(alert.datasource_name || alert.client_name || "Datasource OneView"),
    client_name: String(alert.client_name || "Cliente OneView"),
    customer_name: alert.customer_name ? String(alert.customer_name) : null,
    customer_key: alert.customer_key ? String(alert.customer_key) : null,
    customer_source: alert.customer_source ? String(alert.customer_source) : null,
    customer_confidence: alert.customer_confidence ? String(alert.customer_confidence) : null,
    enrichment_status: ["complete", "partial"].includes(enrichmentState) ? "enriched" : "pending",
    enrichment_state: enrichmentState,
    source_type: "zabbix",
    source_event_id: String(alert.source_event_id || alert.id || ""),
    source_problem_id: alert.source_problem_id ? String(alert.source_problem_id) : null,
    source_trigger_id: alert.source_trigger_id ? String(alert.source_trigger_id) : null,
    source_host_id: null,
    host_name: `Host protegido ${hostDigest}`,
    host_visible_name: alert.host_visible_name ? String(alert.host_visible_name) : null,
    host_technical_name: alert.host_technical_name ? String(alert.host_technical_name) : null,
    host_ip: null,
    host_group: null,
    host_groups: [],
    event_tags: [],
    trigger_tags: [],
    host_tags: [],
    service_name: alert.service_name ? String(alert.service_name) : null,
    item_name: alert.item_name ? String(alert.item_name) : null,
    item_key: null,
    trigger_description: alert.trigger_description ? String(alert.trigger_description) : null,
    operational_data: null,
    problem_name: String(alert.problem_name || "Alerta sincronizado"),
    severity: String(alert.severity || "not_classified"),
    status_source: String(alert.status_source || "active"),
    status_internal: String(alert.status_internal || "new"),
    acknowledged_source: Boolean(alert.acknowledged_source),
    acknowledged_internal: Boolean(alert.acknowledged_internal),
    acknowledged_at: alert.acknowledged_at || null,
    acknowledged_by: null,
    ack_request_status: null,
    suppressed: Boolean(alert.suppressed),
    suppressed_until: alert.suppressed_until || null,
    maintenance_status: alert.maintenance_status || null,
    first_seen_at: alert.first_seen_at || alert.started_at || generatedAt,
    started_at: alert.started_at || alert.first_seen_at || generatedAt,
    last_seen_at: alert.last_seen_at || generatedAt,
    resolved_at: alert.resolved_at || null,
    source_recovery_event_id: alert.source_recovery_event_id ? String(alert.source_recovery_event_id) : null,
    duration_seconds: Math.max(0, Number(alert.duration_seconds) || 0),
    created_at: alert.created_at || alert.first_seen_at || generatedAt,
    updated_at: alert.updated_at || alert.last_seen_at || generatedAt,
  };
}

function snapshotAlerts(snapshot) {
  return (snapshot.alerts || []).map((alert) => snapshotAlert(alert, snapshot.generated_at));
}

function attentionRequiredPayload(snapshot, req, thresholds = getAttentionThresholds()) {
  const { limit } = buildAttentionRequiredQuery(req, thresholds);
  const matching = snapshotAlerts(snapshot)
    .map((alert) => {
      const state = attentionRequiredState(alert, thresholds);
      return { alert, ...state };
    })
    .filter((entry) => entry.matches)
    .sort(compareAttentionRequiredEntries);
  const countByValue = (valueOf, label) => countBy(
    matching,
    ({ alert }) => valueOf(alert),
    (value, count) => ({ [label]: value, count }),
  ).sort((left, right) => right.count - left.count || String(left[label]).localeCompare(String(right[label]), "pt-BR"));
  const disaster = matching.filter(({ alert }) => alert.severity === "disaster").length;
  const high = matching.filter(({ alert }) => alert.severity === "high").length;
  const average = matching.filter(({ alert }) => alert.severity === "average").length;

  return {
    generated_at: snapshot.generated_at,
    summary: {
      total: matching.length,
      disaster,
      high,
      average,
      by_customer: countByValue(
        (alert) => alert.customer_name || "Sem classificação",
        "customer_name",
      ),
      by_datasource: countByValue(
        (alert) => alert.datasource_name || "Datasource OneView",
        "datasource_name",
      ),
    },
    thresholds: {
      disaster_minutes: thresholds.disasterMinutes,
      high_minutes: thresholds.highMinutes,
      average_minutes: thresholds.averageMinutes,
    },
    items: matching.slice(0, limit).map(({ alert, unacknowledgedMinutes }) => ({
      id: alert.id,
      customer_name: alert.customer_name,
      customer_confidence: alert.customer_confidence || "unclassified",
      datasource_name: alert.datasource_name,
      host_visible_name: alert.host_visible_name || alert.host_name,
      problem: alert.problem_name,
      severity: alert.severity,
      first_seen_at: alert.first_seen_at,
      last_seen_at: alert.last_seen_at,
      unacknowledged_minutes: unacknowledgedMinutes,
      acknowledged: false,
    })),
    snapshot_coverage: {
      partial: Number(snapshot.alerts_count || 0) > Number(snapshot.alerts?.length || 0),
      total_persisted: Math.max(0, Number(snapshot.alerts_count) || matching.length),
      available_items: Number(snapshot.alerts?.length || 0),
    },
  };
}

function snapshotLog(log, generatedAt) {
  const status = String(log.status || "unknown").toLowerCase();
  return {
    id: String(log.id || ""),
    datasource: String(log.datasource || "Datasource OneView"),
    data_source_id: String(log.data_source_id || ""),
    status,
    fetched: Math.max(0, Number(log.fetched) || 0),
    upserted: Math.max(0, Number(log.upserted) || 0),
    detail: status === "success" ? "Sincronização concluída." : "Falha registrada; detalhes técnicos protegidos.",
    created_at: log.created_at || generatedAt,
  };
}

function filteredAlerts(snapshot, req) {
  let items = snapshotAlerts(snapshot);
  const { page, pageSize, offset, filters } = buildAlertListQuery(req);

  if (filters.clients.length) items = items.filter((item) => filters.clients.includes(item.client_name));
  if (filters.customers.length) items = items.filter((item) => filters.customers.includes(item.customer_key || "unclassified"));
  if (filters.datasources.length) items = items.filter((item) => filters.datasources.includes(item.datasource_name));
  if (filters.customerConfidences.length) {
    items = items.filter((item) => filters.customerConfidences.includes(item.customer_confidence || "unclassified"));
  }
  if (filters.severities.length) items = items.filter((item) => filters.severities.includes(item.severity));
  if (filters.status === "active") items = items.filter((item) => item.status_source === "active" && !item.resolved_at);
  if (filters.status === "resolved") items = items.filter((item) => item.status_source === "resolved" || Boolean(item.resolved_at));
  if (filters.acknowledged) {
    const expected = filters.acknowledged === "true";
    items = items.filter((item) => Boolean(item.acknowledged_internal || item.acknowledged_source) === expected);
  }
  if (filters.search) {
    const search = filters.search.toLocaleLowerCase("pt-BR");
    items = items.filter((item) => [
      item.host_visible_name,
      item.host_technical_name,
      item.host_name,
      item.problem_name,
      item.service_name,
      item.customer_name,
      item.client_name,
      item.datasource_name,
    ]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(search)));
  }
  if (filters.dateFrom) items = items.filter((item) => Date.parse(item.last_seen_at) >= Date.parse(filters.dateFrom));
  if (filters.dateTo) items = items.filter((item) => Date.parse(item.last_seen_at) <= Date.parse(filters.dateTo));
  if (filters.firstSeenFrom) items = items.filter((item) => Date.parse(item.first_seen_at) >= Date.parse(filters.firstSeenFrom));
  if (filters.lastSeenFrom) items = items.filter((item) => Date.parse(item.last_seen_at) >= Date.parse(filters.lastSeenFrom));

  const severityRank = { disaster: 5, high: 4, average: 3, warning: 2, information: 1, not_classified: 0 };
  const valueOf = (item) => {
    if (filters.sort === "severity") return severityRank[item.severity] ?? 0;
    if (filters.sort === "client") return item.customer_name || item.client_name;
    if (filters.sort === "datasource") return item.datasource_name;
    if (filters.sort === "host") return item.host_name;
    if (filters.sort === "problem") return item.problem_name;
    if (filters.sort === "duration") return item.duration_seconds;
    return Date.parse(item[filters.sort] || item.last_seen_at) || 0;
  };
  items.sort((left, right) => {
    const leftValue = valueOf(left);
    const rightValue = valueOf(right);
    const comparison = typeof leftValue === "string"
      ? leftValue.localeCompare(String(rightValue), "pt-BR")
      : Number(leftValue) - Number(rightValue);
    return filters.order === "asc" ? comparison : -comparison;
  });

  const filteredTotal = items.length;
  const totalPages = filteredTotal === 0 ? 0 : Math.ceil(filteredTotal / pageSize);

  return {
    generated_at: snapshot.generated_at,
    items: items.slice(offset, offset + pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total_items: filteredTotal,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_previous: page > 1 && totalPages > 0,
    },
    snapshot_coverage: {
      partial: Number(snapshot.alerts_count || 0) > Number(snapshot.alerts?.length || 0),
      total_persisted: Math.max(0, Number(snapshot.alerts_count) || filteredTotal),
      available_items: Number(snapshot.alerts?.length || 0),
    },
  };
}

function dataSourcesPayload(snapshot) {
  const alerts = snapshotAlerts(snapshot);
  const alertCountBySource = alerts.reduce((acc, alert) => {
    acc.set(alert.data_source_id, (acc.get(alert.data_source_id) || 0) + 1);
    return acc;
  }, new Map());

  return {
    generated_at: snapshot.generated_at,
    items: (snapshot.data_sources || []).map((source) => ({
      id: String(source.id || ""),
      name: String(source.name || "Datasource OneView"),
      client_name: String(source.client_name || source.name || "Cliente OneView"),
      type: "zabbix",
      environment: source.environment === "external" ? "external" : "internal",
      problem_group_filter: null,
      status: ["active", "inactive", "error"].includes(source.status) ? source.status : "inactive",
      sync_enabled: Boolean(source.sync_enabled),
      sync_interval_seconds: Math.max(15, Number(source.sync_interval_seconds) || 300),
      via_vpn: Boolean(source.via_vpn),
      observation: null,
      last_sync_at: source.last_sync_at || null,
      last_sync_status: source.last_sync_status || null,
      last_sync_error: source.last_sync_error ? "Falha registrada; detalhes técnicos protegidos." : null,
      last_success_at: source.last_success_at || null,
      last_error: source.last_error ? "Falha registrada; detalhes técnicos protegidos." : null,
      failure_count: Math.max(0, Number(source.failure_count) || 0),
      sync_locked_at: source.sync_locked_at || null,
      sync_lock_owner: null,
      display_order: Math.max(0, Number(source.display_order) || 100),
      created_at: source.created_at || snapshot.generated_at,
      updated_at: source.updated_at || snapshot.generated_at,
      has_token: true,
      alerts_count: Number(source.alerts_count ?? alertCountBySource.get(source.id) ?? 0),
      pending_reason: source.pending_reason || source.last_error || source.last_sync_error
        ? "Pendência operacional registrada; detalhes técnicos protegidos."
        : null,
    })),
  };
}

function syncLogsPayload(snapshot, req) {
  const limit = asInt(oneQueryValue(req, "limit"), 20, { min: 1, max: 50 });
  return {
    generated_at: snapshot.generated_at,
    items: (snapshot.sync_logs || []).slice(0, limit).map((log) => snapshotLog(log, snapshot.generated_at)),
  };
}

function dashboardSummaryPayload(snapshot) {
  const alerts = snapshotAlerts(snapshot);
  const active = alerts.filter((alert) => alert.status_source === "active" && !alert.resolved_at);
  const alertsTotal = Math.max(0, Number(snapshot.summary?.total_alerts ?? snapshot.alerts_count) || alerts.length);
  const activeTotal = Math.max(0, Number(snapshot.summary?.active_alerts) || active.length);

  return {
    generated_at: snapshot.generated_at,
    alerts_total: alertsTotal,
    alerts_sample_size: Math.max(0, Number(snapshot.exported_alerts_count) || alerts.length),
    active_total: activeTotal,
    resolved_total: Math.max(alertsTotal - activeTotal, 0),
    by_severity: countBy(active, (alert) => alert.severity, (severity, count) => ({ severity, count })),
    by_status: countBy(active, (alert) => alert.status_internal, (status_internal, count) => ({ status_internal, count })),
    by_client: countBy(active, (alert) => alert.client_name, (client_name, count) => ({ client_name, count })),
    by_service: countBy(active, (alert) => alert.service_name || "-", (service_name, count) => ({
      service_name,
      environment: "internal",
      count,
    })),
    top_hosts: countBy(active, (alert) => alert.host_name || "-", (host_name, count) => ({ host_name, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 10),
    unacknowledged_total: Number(snapshot.operational_view?.sem_tratamento)
      || active.filter((alert) => !(alert.acknowledged_internal || alert.acknowledged_source)).length,
    longest_duration: [...active]
      .sort((left, right) => right.duration_seconds - left.duration_seconds)
      .slice(0, 10)
      .map((alert) => ({
        id: alert.id,
        client_name: alert.client_name,
        host_name: alert.host_name,
        problem_name: alert.problem_name,
        severity: alert.severity,
        duration_seconds: alert.duration_seconds,
        first_seen_at: alert.first_seen_at,
      })),
    avg_ack_time_seconds: 0,
    avg_normalization_time_seconds: 0,
  };
}

function grafanaSummaryPayload(snapshot) {
  const alerts = snapshotAlerts(snapshot).filter((alert) => alert.status_source === "active" && !alert.resolved_at);
  const acknowledged = Number(snapshot.grafana_summary?.acknowledged)
    || alerts.filter((alert) => alert.acknowledged_internal || alert.acknowledged_source).length;
  const total = Number(snapshot.grafana_summary?.total) || alerts.length;

  return {
    generated_at: snapshot.generated_at,
    total,
    acknowledged,
    unacknowledged: Number(snapshot.grafana_summary?.unacknowledged) || Math.max(total - acknowledged, 0),
    average: Number(snapshot.grafana_summary?.average)
      || alerts.filter((alert) => ["average", "warning"].includes(alert.severity)).length,
    high: Number(snapshot.grafana_summary?.high) || alerts.filter((alert) => alert.severity === "high").length,
    disaster: Number(snapshot.grafana_summary?.disaster) || alerts.filter((alert) => alert.severity === "disaster").length,
    by_client: snapshot.grafana_summary?.by_client
      || countBy(alerts, (alert) => alert.client_name, (client, count) => ({ client, count })),
    last_updated_at: snapshot.grafana_summary?.last_updated_at ?? snapshot.generated_at,
    data_sources: (snapshot.data_sources || []).map((source) => ({
      id: source.id,
      name: source.name,
      status: source.status,
      last_sync_at: source.last_sync_at,
      last_sync_status: source.last_sync_status,
      alerts_count: Number(source.alerts_count ?? 0),
    })),
    sync_logs: (snapshot.sync_logs || []).slice(0, 8).map((log) => snapshotLog(log, snapshot.generated_at)),
  };
}

function clientsSummaryPayload(snapshot) {
  const alerts = snapshotAlerts(snapshot).filter((alert) => alert.status_source === "active" && !alert.resolved_at);
  return {
    generated_at: snapshot.generated_at,
    clients: (snapshot.data_sources || []).map((source) => ({
      id: source.id,
      name: source.client_name || source.name,
      status: source.status,
      alerts_count: Number(source.alerts_count ?? 0),
      last_sync_at: source.last_sync_at,
    })),
    customers: countBy(
      alerts,
      (alert) => alert.customer_key || "unclassified",
      (key, count) => {
        const item = alerts.find((alert) => (alert.customer_key || "unclassified") === key);
        return {
          key,
          name: item?.customer_name || "Cliente não classificado",
          alerts_count: count,
          high_confidence_count: alerts.filter((alert) => (alert.customer_key || "unclassified") === key && alert.customer_confidence === "high").length,
          low_confidence_count: alerts.filter((alert) => (alert.customer_key || "unclassified") === key && alert.customer_confidence === "low").length,
          enrichment_status: key === "unclassified" ? "pending" : "enriched",
        };
      },
    ).sort((left, right) => right.alerts_count - left.alerts_count),
    datasources: countBy(
      alerts,
      (alert) => alert.datasource_name,
      (name, count) => ({
        id: (snapshot.data_sources || []).find((source) => source.name === name)?.id || name,
        name,
        alerts_count: count,
      }),
    ).sort((left, right) => right.alerts_count - left.alerts_count),
  };
}

function fallbackError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function requestedAlert(snapshot, req) {
  const id = String(oneQueryValue(req, "id") || "").slice(0, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id)) throw fallbackError("invalid_query", 400);
  const item = snapshotAlerts(snapshot).find((alert) => alert.id === id);
  if (!item) throw fallbackError("not_found", 404);
  return item;
}

function alertDetailPayload(snapshot, req) {
  const item = requestedAlert(snapshot, req);
  return {
    generated_at: snapshot.generated_at,
    item: { ...item, history_count: 0, acknowledgement_count: 0 },
  };
}

function alertHistoryPayload(snapshot, req) {
  const item = requestedAlert(snapshot, req);
  return {
    generated_at: snapshot.generated_at,
    alert_id: item.id,
    items: [],
    source_total_items: 0,
    total_items: 0,
    history_available: false,
    history_partial: false,
    first_event_at: null,
    last_event_at: null,
    has_recovery: false,
    has_ack: false,
    acknowledgement_count: 0,
    first_ack_at: null,
    latest_ack_at: null,
    has_ack_comment: false,
    ack_actor_summary: "Sem ACK",
  };
}

function operationsHealthPayload(snapshot) {
  const logsBySource = new Map();
  for (const log of snapshot.sync_logs || []) {
    const current = logsBySource.get(log.data_source_id);
    if (!current || Date.parse(log.created_at || "") > Date.parse(current.created_at || "")) {
      logsBySource.set(log.data_source_id, log);
    }
  }
  const now = Date.now();
  const items = (snapshot.data_sources || []).map((source) => {
    const log = logsBySource.get(source.id);
    const lastActivityAt = [source.last_sync_at, source.last_success_at, log?.created_at]
      .filter(Boolean)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
    const health = classifyOperationalSource({ ...source, last_activity_at: lastActivityAt }, now);
    return {
      id: String(source.id || ""),
      name: String(source.name || "Datasource OneView"),
      client_name: String(source.client_name || source.name || "Cliente OneView"),
      source_status: ["active", "inactive", "error"].includes(source.status) ? source.status : "inactive",
      operational_status: health.status,
      reason_code: health.reason_code,
      sync_enabled: Boolean(source.sync_enabled),
      sync_interval_seconds: health.intervalSeconds,
      last_sync_status: source.last_sync_status || null,
      last_sync_at: source.last_sync_at || null,
      last_success_at: source.last_success_at || null,
      last_activity_at: health.lastActivityAt,
      failure_count: Math.max(0, Number(source.failure_count) || 0),
    };
  });
  const summary = Object.fromEntries(["healthy", "warning", "error", "stale", "disabled"].map((status) => [
    status,
    items.filter((item) => item.operational_status === status).length,
  ]));
  const enabled = items.filter((item) => item.sync_enabled);
  const workerActivity = enabled.map((item) => item.last_activity_at).filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  const workerWindow = enabled.length ? Math.min(...enabled.map((item) => item.sync_interval_seconds * 3)) : 900;
  const workerStatus = !workerActivity ? "unknown" : now - Date.parse(workerActivity) > workerWindow * 1000 ? "stale" : "healthy";
  const status = summary.error > 0 ? "error" : summary.stale > 0 ? "stale" : summary.warning > 0 || summary.disabled > 0 ? "warning" : "healthy";
  return {
    generated_at: snapshot.generated_at,
    status,
    summary: { total: items.length, ...summary },
    worker: { status: workerStatus, last_activity_at: workerActivity },
    items,
  };
}

export async function getOneViewSnapshotPayload(routeName, req, config = {}) {
  const snapshot = await loadSnapshot();
  const alerts = snapshot.alerts || [];

  switch (routeName) {
    case "health":
      return {
        status: "ok",
        database_reachable: false,
        counts: {
          total_alerts: Math.max(0, Number(snapshot.alerts_count) || alerts.length),
          active_alerts: Math.max(0, Number(snapshot.summary?.active_alerts) || alerts.length),
        },
        capabilities: { acknowledgement: false },
      };
    case "dashboard-summary":
      return dashboardSummaryPayload(snapshot);
    case "grafana-summary":
      return grafanaSummaryPayload(snapshot);
    case "alerts":
      return filteredAlerts(snapshot, req);
    case "attention-required":
      return attentionRequiredPayload(snapshot, req, config.attentionThresholds);
    case "alert-detail":
      return alertDetailPayload(snapshot, req);
    case "alert-history":
      return alertHistoryPayload(snapshot, req);
    case "operations-health":
      return operationsHealthPayload(snapshot);
    case "clients-summary":
      return clientsSummaryPayload(snapshot);
    case "data-sources":
      return dataSourcesPayload(snapshot);
    case "sync-logs":
      return syncLogsPayload(snapshot, req);
    default:
      return null;
  }
}

export function resetOneViewSnapshotCacheForTests() {
  snapshotPromise = undefined;
}

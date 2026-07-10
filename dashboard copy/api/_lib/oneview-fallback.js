import { readFile } from "node:fs/promises";

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

function snapshotAlerts(snapshot) {
  return (snapshot.alerts || []).map((alert) => ({
    ...alert,
    host_name: alert.host_alias ?? "Host protegido",
    host_ip: null,
    payload_normalized: {},
  }));
}

function filteredAlerts(snapshot, req) {
  let items = snapshotAlerts(snapshot);
  const clientName = String(oneQueryValue(req, "client_name") || "");
  const severity = String(oneQueryValue(req, "severity") || "");
  const statusInternal = String(oneQueryValue(req, "status_internal") || "");
  const acknowledged = String(oneQueryValue(req, "acknowledged") || "").toLowerCase();
  const host = String(oneQueryValue(req, "host") || "").toLocaleLowerCase("pt-BR");
  const service = String(oneQueryValue(req, "service") || "").toLocaleLowerCase("pt-BR");

  if (clientName) items = items.filter((item) => item.client_name === clientName);
  if (severity) items = items.filter((item) => item.severity === severity);
  if (statusInternal) items = items.filter((item) => item.status_internal === statusInternal);
  if (acknowledged === "true" || acknowledged === "false") {
    const expected = acknowledged === "true";
    items = items.filter((item) => Boolean(item.acknowledged_internal || item.acknowledged_source) === expected);
  }
  if (host) items = items.filter((item) => item.host_name?.toLocaleLowerCase("pt-BR").includes(host));
  if (service) items = items.filter((item) => item.service_name?.toLocaleLowerCase("pt-BR").includes(service));

  const offset = asInt(oneQueryValue(req, "offset"), 0, { min: 0, max: 500000 });
  const limit = asInt(oneQueryValue(req, "limit"), 500, { min: 1, max: 5000 });
  const filteredTotal = items.length;
  const hasFilter = Boolean(clientName || severity || statusInternal || acknowledged || host || service);

  return {
    generated_at: snapshot.generated_at,
    total: hasFilter ? filteredTotal : Math.max(0, Number(snapshot.alerts_count) || filteredTotal),
    limit,
    offset,
    items: items.slice(offset, offset + limit),
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
      ...source,
      type: "zabbix",
      has_token: true,
      alerts_count: Number(source.alerts_count ?? alertCountBySource.get(source.id) ?? 0),
      pending_reason: source.pending_reason ?? source.last_error ?? source.last_sync_error ?? null,
    })),
  };
}

function syncLogsPayload(snapshot, req) {
  const limit = asInt(oneQueryValue(req, "limit"), 20, { min: 1, max: 50 });
  return {
    generated_at: snapshot.generated_at,
    items: (snapshot.sync_logs || []).slice(0, limit).map((log) => ({ ...log })),
  };
}

function dashboardSummaryPayload(snapshot) {
  const alerts = snapshotAlerts(snapshot);
  const active = alerts.filter((alert) => alert.status_source !== "resolved");
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
  const alerts = snapshotAlerts(snapshot).filter((alert) => alert.status_source !== "resolved");
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
    sync_logs: (snapshot.sync_logs || []).slice(0, 8).map((log) => ({ ...log })),
  };
}

function clientsSummaryPayload(snapshot) {
  return {
    generated_at: snapshot.generated_at,
    clients: (snapshot.data_sources || []).map((source) => ({
      id: source.id,
      name: source.client_name || source.name,
      status: source.status,
      alerts_count: Number(source.alerts_count ?? 0),
      last_sync_at: source.last_sync_at,
    })),
  };
}

export async function getOneViewSnapshotPayload(routeName, req) {
  const snapshot = await loadSnapshot();
  const alerts = snapshot.alerts || [];

  switch (routeName) {
    case "health":
      return {
        status: "ok",
        generated_at: snapshot.generated_at,
        alerts_count: Math.max(0, Number(snapshot.alerts_count) || alerts.length),
        active_alerts: Math.max(0, Number(snapshot.summary?.active_alerts) || alerts.length),
        data_sources_total: (snapshot.data_sources || []).length,
      };
    case "dashboard-summary":
      return dashboardSummaryPayload(snapshot);
    case "grafana-summary":
      return grafanaSummaryPayload(snapshot);
    case "alerts":
      return filteredAlerts(snapshot, req);
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

import { readFile } from "node:fs/promises";

const snapshotPath = new URL("../../src/lib/oneview-real-snapshot.safe.json", import.meta.url);
let snapshotPromise;

function loadSnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = readFile(snapshotPath, "utf8").then(JSON.parse);
  }
  return snapshotPromise;
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, count }));
}

function filteredAlerts(snapshot, req) {
  let items = [...snapshot.alerts];
  const one = (key) => Array.isArray(req.query?.[key]) ? req.query[key][0] : req.query?.[key];
  const clientName = one("client_name");
  const severity = one("severity");
  const status = one("status_internal");
  const acknowledged = one("acknowledged");
  if (clientName) items = items.filter((item) => item.client_name === clientName);
  if (severity) items = items.filter((item) => item.severity === severity);
  if (status) items = items.filter((item) => item.status_internal === status);
  if (acknowledged === "true" || acknowledged === "false") {
    const expected = acknowledged === "true";
    items = items.filter((item) => Boolean(item.acknowledged_internal || item.acknowledged_source) === expected);
  }
  const offset = Math.max(Number.parseInt(one("offset") || "0", 10) || 0, 0);
  const limit = Math.min(Math.max(Number.parseInt(one("limit") || "500", 10) || 500, 1), 1000);
  return { items: items.slice(offset, offset + limit), total: items.length, generated_at: snapshot.generated_at };
}

export async function getOneViewSnapshotPayload(routeName, req) {
  const snapshot = await loadSnapshot();
  const alerts = snapshot.alerts || [];
  const dataSources = snapshot.data_sources || [];
  const active = alerts.filter((alert) => alert.status_source !== "resolved");

  switch (routeName) {
    case "health":
      return { status: "ok", generated_at: snapshot.generated_at, alerts_count: snapshot.alerts_count || alerts.length };
    case "dashboard-summary":
      return {
        generated_at: snapshot.generated_at,
        alerts_total: snapshot.alerts_count || alerts.length,
        alerts_sample_size: alerts.length,
        active_total: active.length,
        resolved_total: alerts.length - active.length,
        by_severity: countBy(alerts, (alert) => alert.severity).map(({ key: severity, count }) => ({ severity, count })),
      };
    case "grafana-summary":
      return {
        generated_at: snapshot.generated_at,
        data_sources: dataSources.map((source) => ({
          id: source.id,
          name: source.name,
          status: source.status,
          last_sync_at: source.last_sync_at,
          last_sync_status: source.last_sync_status,
          alerts_count: source.alerts_count || 0,
        })),
        sync_logs: snapshot.sync_logs || [],
      };
    case "alerts":
      return filteredAlerts(snapshot, req);
    case "clients-summary":
      return {
        generated_at: snapshot.generated_at,
        clients: dataSources.map((source) => ({
          id: source.id,
          name: source.client_name || source.name,
          status: source.status,
          alerts_count: source.alerts_count || 0,
          last_sync_at: source.last_sync_at,
        })),
      };
    default:
      return null;
  }
}

export function resetOneViewSnapshotCacheForTests() {
  snapshotPromise = undefined;
}

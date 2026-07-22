import type { AlertMetrics, DataSource, OneViewAlert } from "@/lib/oneview-api";
import safeSnapshotJson from "@/lib/oneview-real-snapshot.safe.json";

interface SnapshotSyncLog {
  id: string;
  datasource: string;
  data_source_id: string;
  status: string;
  fetched: number;
  upserted: number;
  detail: string;
  created_at: string;
}

interface SnapshotSummary {
  total_alerts: number;
  active_alerts: number;
  datasources_total: number;
  datasources_active: number;
  datasources_error: number;
  critical_high: number;
}

interface SnapshotGrafanaSummary {
  total: number;
  acknowledged: number;
  unacknowledged: number;
  average: number;
  high: number;
  disaster: number;
  by_client: Array<{ client: string; count: number }>;
  last_updated_at: string | null;
}

interface SnapshotClientSummary {
  client: string;
  datasource: string;
  total: number;
  active: number;
  acknowledged: number;
  unacknowledged: number;
  average: number;
  high: number;
  disaster: number;
  last_seen_at: string | null;
}

interface SnapshotOperationalView {
  recentes: number;
  em_acompanhamento: number;
  historicos: number;
  sem_tratamento: number;
  criticos: number;
  por_datasource: Array<{
    datasource: string;
    total: number;
    active: number;
    resolved: number;
    critical: number;
    untreated: number;
  }>;
}

interface SafeSnapshot {
  generated_at: string;
  alerts_count: number;
  exported_alerts_count?: number;
  summary?: SnapshotSummary;
  grafana_summary?: SnapshotGrafanaSummary;
  clients_summary?: SnapshotClientSummary[];
  operational_view?: SnapshotOperationalView;
  data_sources: Array<Omit<DataSource, "api_url">>;
  sync_logs: SnapshotSyncLog[];
  alerts: Array<Omit<OneViewAlert, "host_name" | "host_ip" | "payload_normalized"> & { host_alias?: string }>;
}

const snapshot = safeSnapshotJson as unknown as SafeSnapshot;

export const SNAPSHOT_GENERATED_AT = snapshot.generated_at;
export const SNAPSHOT_TOTAL_ALERTS = Math.max(0, Number(snapshot.summary?.total_alerts ?? snapshot.alerts_count) || snapshot.alerts.length);
export const SNAPSHOT_EXPORTED_ALERTS = Math.max(0, Number(snapshot.exported_alerts_count) || snapshot.alerts.length);
export const SNAPSHOT_SUMMARY: SnapshotSummary = snapshot.summary ?? {
  total_alerts: SNAPSHOT_TOTAL_ALERTS,
  active_alerts: snapshot.alerts.filter((alert) => alert.status_source !== "resolved").length,
  datasources_total: snapshot.data_sources.length,
  datasources_active: snapshot.data_sources.filter((source) => source.status === "active").length,
  datasources_error: snapshot.data_sources.filter((source) => source.status === "error").length,
  critical_high: snapshot.alerts.filter((alert) => ["high", "disaster"].includes(alert.severity)).length,
};
export const SNAPSHOT_GRAFANA_SUMMARY = snapshot.grafana_summary;
export const SNAPSHOT_CLIENT_SUMMARIES = snapshot.clients_summary ?? [];
export const SNAPSHOT_OPERATIONAL_VIEW = snapshot.operational_view;
export const SNAPSHOT_LAST_UPDATED_AT = snapshot.grafana_summary?.last_updated_at ?? snapshot.generated_at;
export const SNAPSHOT_READ_ONLY_MESSAGE =
  "Ações operacionais desabilitadas neste modo de leitura. Nenhum ACK real é executado.";

export const demoAlerts: OneViewAlert[] = snapshot.alerts.map((alert) => ({
  ...alert,
  enrichment_state: alert.customer_source === "datasource_fallback"
    || alert.customer_key === "unclassified"
    || alert.customer_name === "Cliente não classificado"
    || alert.customer_name === "Cliente não identificado"
    ? "unclassified"
    : !alert.customer_name
      ? "legacy"
      : alert.customer_confidence === "high" ? "complete" : "partial",
  customer_name: alert.customer_source === "datasource_fallback"
    || alert.customer_key === "unclassified"
    || alert.customer_name === "Cliente não classificado"
    || alert.customer_name === "Cliente não identificado"
    ? null
    : alert.customer_name,
  customer_key: alert.customer_source === "datasource_fallback"
    || alert.customer_key === "unclassified"
    ? "unclassified"
    : alert.customer_key,
  host_name: alert.host_alias ?? "Host protegido",
  host_ip: null,
  payload_normalized: {},
}));

const alertCountByDataSource = new Map<string, number>();
const alertCountByClient = new Map<string, number>();
demoAlerts.forEach((alert) => {
  alertCountByDataSource.set(alert.data_source_id, (alertCountByDataSource.get(alert.data_source_id) ?? 0) + 1);
  alertCountByClient.set(alert.client_name, (alertCountByClient.get(alert.client_name) ?? 0) + 1);
});

export const demoDataSources: DataSource[] = snapshot.data_sources.map((source) => {
  const legacyAlertCount = Number((source as DataSource & { alert_count?: number }).alert_count ?? source.alerts_count ?? 0);
  const computedAlertCount = alertCountByDataSource.get(source.id) ?? alertCountByClient.get(source.name) ?? 0;
  return {
    ...source,
    api_url: "",
    alerts_count: legacyAlertCount > 0 ? legacyAlertCount : computedAlertCount,
  };
});
export const demoSyncLogs: SnapshotSyncLog[] = snapshot.sync_logs.map((log) => ({ ...log }));

const activeAlerts = demoAlerts.filter((alert) => alert.status_source !== "resolved");
const activeAcknowledged = activeAlerts.filter(
  (alert) => alert.acknowledged_internal || alert.acknowledged_source,
);

const countBy = <T,>(items: T[], keyOf: (item: T) => string) => {
  const counts = new Map<string, number>();
  items.forEach((item) => {
    const key = keyOf(item) || "Não informado";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
};

const severityCounts = countBy(demoAlerts, (alert) => alert.severity);
const statusCounts = countBy(demoAlerts, (alert) => alert.status_internal);
const serviceCounts = countBy(demoAlerts, (alert) => alert.service_name ?? "Não informado");
const hostCounts = countBy(demoAlerts, (alert) => alert.host_name ?? "Host não identificado");

export const demoAlertMetrics: AlertMetrics = {
  active_total: SNAPSHOT_SUMMARY.active_alerts,
  by_severity: SNAPSHOT_GRAFANA_SUMMARY
    ? [
        { severity: "average", count: SNAPSHOT_GRAFANA_SUMMARY.average },
        { severity: "high", count: SNAPSHOT_GRAFANA_SUMMARY.high },
        { severity: "disaster", count: SNAPSHOT_GRAFANA_SUMMARY.disaster },
      ]
    : [...severityCounts].map(([severity, count]) => ({ severity, count })),
  by_status: [...statusCounts].map(([status_internal, count]) => ({ status_internal, count })),
  by_client: SNAPSHOT_CLIENT_SUMMARIES.length > 0
    ? SNAPSHOT_CLIENT_SUMMARIES.map((client) => ({ client_name: client.client, count: client.active }))
    : demoDataSources.map((source) => ({
        client_name: source.client_name,
        count: source.alerts_count ?? demoAlerts.filter((alert) => alert.data_source_id === source.id).length,
      })),
  by_service: [...serviceCounts].map(([service_name, count]) => ({
    service_name,
    environment: "internal",
    count,
  })),
  top_hosts: [...hostCounts]
    .sort(([, countA], [, countB]) => countB - countA)
    .slice(0, 10)
    .map(([host_name, count]) => ({ host_name, count })),
  unacknowledged_total: SNAPSHOT_OPERATIONAL_VIEW?.sem_tratamento ?? activeAlerts.length - activeAcknowledged.length,
  longest_duration: [...demoAlerts]
    .sort((alertA, alertB) => alertB.duration_seconds - alertA.duration_seconds)
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

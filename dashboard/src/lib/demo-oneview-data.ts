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

interface SafeSnapshot {
  generated_at: string;
  alerts_count: number;
  data_sources: DataSource[];
  sync_logs: SnapshotSyncLog[];
  alerts: OneViewAlert[];
}

const snapshot = safeSnapshotJson as unknown as SafeSnapshot;

export const SNAPSHOT_GENERATED_AT = snapshot.generated_at;
export const DEMO_TOTAL_ALERTS = Math.max(0, Number(snapshot.alerts_count) || snapshot.alerts.length);
export const DEMO_SAMPLE_SIZE = snapshot.alerts.length;
export const DEMO_READ_ONLY_MESSAGE =
  "Ações desabilitadas na apresentação. O snapshot real do banco OneView é somente leitura e nenhum ACK real foi executado.";

export const demoDataSources: DataSource[] = snapshot.data_sources.map((source) => ({ ...source }));
export const demoAlerts: OneViewAlert[] = snapshot.alerts.map((alert) => ({
  ...alert,
  payload_normalized: { ...alert.payload_normalized },
}));
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
  active_total: activeAlerts.length,
  by_severity: [...severityCounts].map(([severity, count]) => ({ severity, count })),
  by_status: [...statusCounts].map(([status_internal, count]) => ({ status_internal, count })),
  by_client: demoDataSources.map((source) => ({
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
  unacknowledged_total: activeAlerts.length - activeAcknowledged.length,
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

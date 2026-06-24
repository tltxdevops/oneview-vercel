import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(dashboardRoot, "src/lib/oneview-real-snapshot.json");
const outputPath = resolve(dashboardRoot, "src/lib/oneview-real-snapshot.safe.json");
const secretKeyPattern = /(token|password|senha|secret|credential|authorization)/i;
const secretValuePattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|bearer\s+[a-z0-9._~+/=-]{20,}|(?:token|password|senha|secret|authorization)\s*[:=]\s*["']?[a-z0-9._~+/=-]{8,}|https?:\/\/[^/\s:@]+:[^@\s/]+@)/i;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const asRecord = (value) => isRecord(value) ? value : {};
const asArray = (value) => Array.isArray(value) ? value : [];

function firstValue(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}
//teste
function asText(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function sanitizeText(value, fallback = "", maxLength = 1000) {
  return asText(value, fallback)
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:token|password|senha|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, maxLength);
}

function asNumber(value, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (["true", "1", "yes", "sim", "active"].includes(value.trim().toLowerCase())) return true;
    if (["false", "0", "no", "nao", "não", "inactive"].includes(value.trim().toLowerCase())) return false;
  }
  return fallback;
}

function safeUrl(value) {
  const raw = asText(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return sanitizeText(raw, "", 500);
  }
}

function normalizeSeverity(value) {
  const raw = asText(value, "not_classified").toLowerCase();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return ["not_classified", "information", "warning", "average", "high", "disaster"][Math.max(0, Math.min(5, numeric))];
  }
  if (["disaster", "critical", "critico", "crítico"].includes(raw)) return "disaster";
  if (["high", "alta", "alto"].includes(raw)) return "high";
  if (["average", "media", "média", "medium"].includes(raw)) return "average";
  if (["warning", "aviso", "warn"].includes(raw)) return "warning";
  if (["information", "informativo", "info"].includes(raw)) return "information";
  return "not_classified";
}

function normalizeAlertStatus(record) {
  const isActive = firstValue(record, ["is_active"]);
  if (isActive !== undefined) return asBoolean(isActive, true) ? "active" : "resolved";
  const raw = asText(firstValue(record, ["status_source", "status", "state"]), "active").toLowerCase();
  if (["resolved", "closed", "normal", "normalized", "ok", "inactive", "false", "0"].includes(raw)) return "resolved";
  return "active";
}

function normalizeDataSourceStatus(value) {
  const raw = asText(value, "inactive").toLowerCase();
  if (raw === "active") return "active";
  if (["error", "failed", "failure"].includes(raw)) return "error";
  return "inactive";
}

function normalizeEnvironment(value) {
  return asText(value).toLowerCase() === "external" ? "external" : "internal";
}

function assertNoSecretKeys(value, path = "snapshot") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (secretKeyPattern.test(key)) throw new Error(`Campo proibido no snapshot seguro: ${path}.${key}`);
    assertNoSecretKeys(child, `${path}.${key}`);
  }
}

function countSecretKeys(value) {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countSecretKeys(item), 0);
  if (!isRecord(value)) return 0;
  return Object.entries(value).reduce(
    (count, [key, child]) => count + (secretKeyPattern.test(key) ? 1 : 0) + countSecretKeys(child),
    0,
  );
}

const sourceText = await readFile(sourcePath, "utf8");
const source = JSON.parse(sourceText);
if (!isRecord(source)) throw new Error("Snapshot OneView invalido: raiz deve ser objeto.");
const sourceSecretKeyCount = countSecretKeys(source);
if (sourceSecretKeyCount > 0) {
  throw new Error(`Snapshot OneView bloqueado: ${sourceSecretKeyCount} campo(s) com nome sensivel.`);
}
if (secretValuePattern.test(sourceText)) {
  throw new Error("Snapshot OneView bloqueado: possivel valor de segredo detectado.");
}

const generatedAt = asText(source.generated_at, new Date(0).toISOString());
const alertsCount = Math.max(0, asNumber(source.alerts_count, 0));
const sourceDataSources = asArray(source.data_sources).map(asRecord);
const sourceSyncLogs = asArray(source.sync_logs).map(asRecord);

const dataSourceNames = new Map(
  sourceDataSources.map((row) => [
    asText(row.id),
    sanitizeText(firstValue(row, ["name", "client_name"]), "Datasource OneView", 120),
  ]),
);

const syncLogs = sourceSyncLogs.map((row, index) => {
  const dataSourceId = asText(firstValue(row, ["data_source_id", "datasource_id", "source"]));
  const status = asText(row.status, "unknown").toLowerCase();
  const workerId = sanitizeText(firstValue(row, ["worker_id"]), "Worker não identificado", 160);
  const error = sanitizeText(firstValue(row, ["error", "technical_error"]), "Falha registrada no snapshot", 700);
  return {
    id: asText(row.id, `snapshot-sync-${index + 1}`),
    datasource: dataSourceNames.get(dataSourceId) ?? dataSourceId ?? "Datasource não identificado",
    data_source_id: dataSourceId,
    status,
    fetched: Math.max(0, asNumber(firstValue(row, ["fetched_count", "fetched"]), 0)),
    upserted: Math.max(0, asNumber(firstValue(row, ["upserted_count", "upserted"]), 0)),
    detail: status === "success" ? `Worker ${workerId}` : error,
    created_at: asText(firstValue(row, ["finished_at", "created_at", "started_at"]), generatedAt),
  };
});

const successfulDataSourceIds = new Set(
  syncLogs.filter((log) => log.status === "success").map((log) => log.data_source_id),
);

const dataSources = sourceDataSources.map((row, index) => {
  const id = asText(row.id, `snapshot-datasource-${index + 1}`);
  const name = sanitizeText(firstValue(row, ["name", "client_name"]), "Datasource OneView", 120);
  const lastError = sanitizeText(firstValue(row, ["last_error", "last_sync_error"]), "", 700) || null;
  return {
    id,
    name,
    client_name: sanitizeText(firstValue(row, ["client_name", "name"]), name, 120),
    type: "zabbix",
    environment: normalizeEnvironment(row.environment),
    api_url: safeUrl(row.api_url),
    problem_group_filter: sanitizeText(row.problem_group_filter, "", 250) || null,
    status: normalizeDataSourceStatus(row.status),
    sync_enabled: asBoolean(row.sync_enabled, false),
    sync_interval_seconds: Math.max(0, asNumber(row.sync_interval_seconds, 0)),
    via_vpn: asBoolean(row.via_vpn, false),
    observation: sanitizeText(row.observation, "", 700) || null,
    last_sync_at: asText(row.last_sync_at) || null,
    last_sync_status: asText(row.last_sync_status) || null,
    last_sync_error: sanitizeText(row.last_sync_error, "", 700) || null,
    last_success_at: asText(row.last_success_at) || null,
    last_error: lastError,
    failure_count: Math.max(0, asNumber(row.failure_count, 0)),
    sync_locked_at: null,
    sync_lock_owner: null,
    display_order: Math.max(0, asNumber(row.display_order, index + 1)),
    created_at: asText(row.created_at, generatedAt),
    updated_at: asText(row.updated_at, generatedAt),
    alerts_count: successfulDataSourceIds.has(id) ? alertsCount : 0,
    pending_reason: lastError,
  };
});

const clientNames = new Map(dataSources.map((sourceRow) => [sourceRow.id, sourceRow.client_name]));

const alerts = asArray(source.alerts).map((value, index) => {
  const row = asRecord(value);
  const normalized = asRecord(row.payload_normalized);
  const id = asText(row.id, `snapshot-alert-${index + 1}`);
  const dataSourceId = asText(firstValue(row, ["data_source_id", "datasource_id", "source"]));
  const status = normalizeAlertStatus(row);
  const acknowledgedSource = asBoolean(firstValue(row, ["acknowledged_source", "acknowledged"]), false);
  const acknowledgedInternal = asBoolean(row.acknowledged_internal, false);
  const firstSeenAt = asText(firstValue(row, ["first_seen_at", "started_at", "created_at"]), generatedAt);
  const lastSeenAt = asText(firstValue(row, ["last_seen_at", "updated_at"]), firstSeenAt);
  const severity = normalizeSeverity(firstValue(row, ["severity", "priority"]));
  const sourceEventId = asText(firstValue(row, ["source_event_id", "eventid", "event_id", "id"]), id);

  return {
    id,
    data_source_id: dataSourceId,
    client_name: sanitizeText(firstValue(row, ["client_name", "client"]), clientNames.get(dataSourceId) ?? "Cliente OneView", 160),
    source_type: sanitizeText(row.source_type, "zabbix", 60),
    source_event_id: sourceEventId,
    source_problem_id: asText(firstValue(row, ["source_problem_id", "problemid"])) || null,
    source_trigger_id: asText(firstValue(row, ["source_trigger_id", "triggerid"])) || null,
    source_host_id: asText(firstValue(row, ["source_host_id", "hostid"])) || null,
    host_name: sanitizeText(firstValue(row, ["host", "host_name", "hostname", "hostid", "source_host_id"]), "Host não identificado", 240),
    host_ip: sanitizeText(row.host_ip, "", 100) || null,
    host_group: sanitizeText(row.host_group, "", 240) || null,
    service_name: sanitizeText(row.service_name, "", 240) || null,
    problem_name: sanitizeText(firstValue(row, ["problem", "problem_name", "name", "event_name", "description"]), "Alerta Zabbix sincronizado", 700),
    severity,
    status_source: status,
    status_internal: sanitizeText(row.status_internal, status === "resolved" ? "normalized" : "new", 80),
    acknowledged_source: acknowledgedSource,
    acknowledged_internal: acknowledgedInternal,
    first_seen_at: firstSeenAt,
    last_seen_at: lastSeenAt,
    resolved_at: status === "resolved" ? (asText(row.resolved_at, lastSeenAt) || lastSeenAt) : null,
    duration_seconds: Math.max(0, asNumber(row.duration_seconds, 0)),
    fingerprint: `snapshot-${id}`,
    payload_normalized: {
      eventid: sourceEventId,
      triggerid: asText(firstValue(row, ["source_trigger_id", "triggerid", "source_problem_id"])),
      severity,
      opdata: `${status === "resolved" ? "Resolvido" : "Ativo"} · ${acknowledgedSource || acknowledgedInternal ? "ACK" : "Sem ACK"}`,
      suppressed: asBoolean(normalized.suppressed, false),
      tags: [
        { tag: "datasource", value: dataSourceNames.get(dataSourceId) ?? dataSourceId },
        { tag: "origem", value: "snapshot-real-oneview" },
      ],
      acknowledges: [],
      suppression_data: [],
    },
    created_at: asText(row.created_at, firstSeenAt),
    updated_at: asText(row.updated_at, lastSeenAt),
  };
});

const safeSnapshot = {
  generated_at: generatedAt,
  alerts_count: alertsCount || alerts.length,
  data_sources: dataSources,
  sync_logs: syncLogs,
  alerts,
};

assertNoSecretKeys(safeSnapshot);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(safeSnapshot, null, 2)}\n`, "utf8");

console.log(`Snapshot seguro gerado: alerts_count=${safeSnapshot.alerts_count}, alerts=${alerts.length}, data_sources=${dataSources.length}, sync_logs=${syncLogs.length}`);

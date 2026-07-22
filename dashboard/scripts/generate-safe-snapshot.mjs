import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(dashboardRoot, "src/lib/oneview-real-snapshot.json");
const buildSnapshotPath = resolve(dashboardRoot, "src/lib/oneview-real-snapshot.safe.json");

// A URL existe somente neste script local. Nunca e gravada no snapshot ou bundle.
const liveApiBaseUrl = "http://127.0.0.1:18001";
const alertPageSize = 500;
const maxSnapshotAlerts = 3000;
const requestTimeoutMs = 10_000;

const secretKeyPattern = /(token|password|senha|secret|credential|authorization)/i;
const forbiddenOutputKeyPattern = /^(api_url|host_name|hostname|host_ip|payload_raw|payload_normalized|worker_id)$/i;
const secretValuePattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|bearer\s+[a-z0-9._~+/=-]{20,}|(?:token|password|senha|secret|authorization)\s*[:=]\s*["']?[a-z0-9._~+/=-]{8,}|https?:\/\/[^/\s:@]+:[^@\s/]+@)/i;
const endpointOrIpPattern = /(?:https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b)/i;

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

function asText(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
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

function sanitizeText(value, fallback = "", maxLength = 1000) {
  return asText(value, fallback)
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:token|password|senha|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:token|password|senha|secret|authorization|bearer)\b/gi, "[DADO_PROTEGIDO]")
    .replace(/https?:\/\/[^\s,;)]+/gi, "[ENDPOINT_PROTEGIDO]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[IP_PROTEGIDO]")
    .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, "[IP_PROTEGIDO]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:local|lan|internal|corp|intra)\b/gi, "[HOST_PROTEGIDO]")
    .slice(0, maxLength);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceInternalHost(value, rawHost, hostAlias, fallback = "", maxLength = 1000) {
  const sanitized = sanitizeText(value, fallback, maxLength);
  if (!rawHost) return sanitized;
  return sanitized.replace(new RegExp(escapeRegExp(rawHost), "gi"), hostAlias);
}

function redactKnownHosts(value, hostAliases) {
  if (hostAliases.size === 0) return value;
  const aliasesByHost = new Map(
    [...hostAliases].map(([host, alias]) => [host.toLocaleLowerCase("pt-BR"), alias]),
  );
  const hostPattern = new RegExp(
    [...hostAliases.keys()]
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|"),
    "gi",
  );
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    if (typeof item !== "string") return item;
    return item.replace(hostPattern, (host) => aliasesByHost.get(host.toLocaleLowerCase("pt-BR")) ?? "Host protegido");
  };
  return visit(value);
}

function normalizeSeverity(value) {
  const raw = asText(value, "not_classified").toLowerCase();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return ["not_classified", "information", "warning", "average", "high", "disaster"][Math.max(0, Math.min(5, numeric))];
  }
  if (raw === "disaster") return "disaster";
  if (["critical", "critico", "crítico"].includes(raw)) return "critical";
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

function genericFailureDetail(record) {
  return firstValue(record, ["error", "technical_error", "last_error", "last_sync_error"])
    ? "Falha registrada; detalhes técnicos protegidos."
    : null;
}

function assertSafeSnapshot(snapshot, internalHosts = []) {
  const findTextPath = (value, needle, path = "snapshot") => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const match = findTextPath(value[index], needle, `${path}[${index}]`);
        if (match) return match;
      }
      return null;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        const match = findTextPath(child, needle, `${path}.${key}`);
        if (match) return match;
      }
      return null;
    }
    return typeof value === "string" && value.toLocaleLowerCase("pt-BR").includes(needle) ? path : null;
  };

  const visit = (value, path = "snapshot") => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (secretKeyPattern.test(key)) throw new Error(`Campo sensível proibido: ${path}.${key}`);
        if (forbiddenOutputKeyPattern.test(key)) throw new Error(`Campo interno proibido: ${path}.${key}`);
        visit(child, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === "string" && endpointOrIpPattern.test(value)) {
      throw new Error(`Endpoint ou IP proibido: ${path}`);
    }
  };

  visit(snapshot);
  const serialized = JSON.stringify(snapshot);
  if (secretValuePattern.test(serialized)) throw new Error("Possível segredo detectado no snapshot.");

  for (const rawHost of internalHosts) {
    const normalizedHost = asText(rawHost).toLocaleLowerCase("pt-BR");
    const path = normalizedHost.length >= 4 ? findTextPath(snapshot, normalizedHost) : null;
    if (path) {
      throw new Error(`Hostname interno detectado após sanitização em ${path}.`);
    }
  }
}

async function fetchJson(path, timeoutMs = requestTimeoutMs) {
  const response = await fetch(`${liveApiBaseUrl}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`API live retornou HTTP ${response.status} em ${path.split("?")[0]}.`);
  return response.json();
}

async function isLiveApiAvailable() {
  try {
    const health = asRecord(await fetchJson("/health", 2500));
    return asText(health.status).toLowerCase() === "ok";
  } catch {
    return false;
  }
}

async function fetchRecentActiveAlerts(activeTotal) {
  const target = Math.min(maxSnapshotAlerts, Math.max(0, asNumber(activeTotal, maxSnapshotAlerts)));
  const alertsById = new Map();

  for (let offset = 0; alertsById.size < target; offset += alertPageSize) {
    const page = asArray(await fetchJson(`/alerts?limit=${alertPageSize}&offset=${offset}&scope=active`));
    if (page.length === 0) break;

    for (const value of page) {
      const row = asRecord(value);
      if (normalizeAlertStatus(row) !== "active") continue;
      const id = asText(row.id, `snapshot-alert-${offset + alertsById.size + 1}`);
      alertsById.set(id, row);
      if (alertsById.size >= target) break;
    }

    if (page.length < alertPageSize) break;
  }

  return [...alertsById.values()]
    .sort((left, right) => {
      const leftTime = Date.parse(asText(firstValue(left, ["started_at", "last_seen_at"]), "1970-01-01T00:00:00Z"));
      const rightTime = Date.parse(asText(firstValue(right, ["started_at", "last_seen_at"]), "1970-01-01T00:00:00Z"));
      return rightTime - leftTime;
    })
    .slice(0, target);
}

function normalizeSummary(value) {
  const row = asRecord(value);
  return {
    total_alerts: Math.max(0, asNumber(row.total_alerts, 0)),
    active_alerts: Math.max(0, asNumber(row.active_alerts, 0)),
    datasources_total: Math.max(0, asNumber(row.datasources_total, 0)),
    datasources_active: Math.max(0, asNumber(row.datasources_active, 0)),
    datasources_error: Math.max(0, asNumber(row.datasources_error, 0)),
    critical_high: Math.max(0, asNumber(row.critical_high, 0)),
  };
}

function normalizeGrafanaSummary(value) {
  const row = asRecord(value);
  return {
    total: Math.max(0, asNumber(row.total, 0)),
    acknowledged: Math.max(0, asNumber(row.acknowledged, 0)),
    unacknowledged: Math.max(0, asNumber(row.unacknowledged, 0)),
    average: Math.max(0, asNumber(row.average, 0)),
    high: Math.max(0, asNumber(row.high, 0)),
    disaster: Math.max(0, asNumber(row.disaster, 0)),
    by_client: asArray(row.by_client).map((item) => {
      const client = asRecord(item);
      return {
        client: sanitizeText(client.client, "Cliente OneView", 160),
        count: Math.max(0, asNumber(client.count, 0)),
      };
    }),
    last_updated_at: asText(row.last_updated_at) || null,
  };
}

function normalizeClientSummaries(value) {
  return asArray(value).map((item) => {
    const row = asRecord(item);
    return {
      client: sanitizeText(row.client, "Cliente OneView", 160),
      datasource: sanitizeText(row.datasource, "Datasource OneView", 160),
      total: Math.max(0, asNumber(row.total, 0)),
      active: Math.max(0, asNumber(row.active, 0)),
      acknowledged: Math.max(0, asNumber(row.acknowledged, 0)),
      unacknowledged: Math.max(0, asNumber(row.unacknowledged, 0)),
      average: Math.max(0, asNumber(row.average, 0)),
      high: Math.max(0, asNumber(row.high, 0)),
      disaster: Math.max(0, asNumber(row.disaster, 0)),
      last_seen_at: asText(row.last_seen_at) || null,
    };
  });
}

function normalizeOperationalView(value) {
  const row = asRecord(value);
  return {
    recentes: Math.max(0, asNumber(row.recentes, 0)),
    em_acompanhamento: Math.max(0, asNumber(row.em_acompanhamento, 0)),
    historicos: Math.max(0, asNumber(row.historicos, 0)),
    sem_tratamento: Math.max(0, asNumber(row.sem_tratamento, 0)),
    criticos: Math.max(0, asNumber(row.criticos, 0)),
    por_datasource: asArray(row.por_datasource).map((item) => {
      const source = asRecord(item);
      return {
        datasource: sanitizeText(source.datasource, "Datasource OneView", 160),
        total: Math.max(0, asNumber(source.total, 0)),
        active: Math.max(0, asNumber(source.active, 0)),
        resolved: Math.max(0, asNumber(source.resolved, 0)),
        critical: Math.max(0, asNumber(source.critical, 0)),
        untreated: Math.max(0, asNumber(source.untreated, 0)),
      };
    }),
  };
}

function buildSafeSnapshot(raw) {
  const generatedAt = new Date().toISOString();
  const summary = normalizeSummary(raw.summary);
  const sourceDataSources = asArray(raw.dataSources).map(asRecord);
  const rawAlerts = asArray(raw.alerts).map(asRecord);

  const dataSourceNames = new Map();
  const dataSourceIdsByName = new Map();
  sourceDataSources.forEach((row, index) => {
    const id = asText(row.id, `snapshot-datasource-${index + 1}`);
    const name = sanitizeText(firstValue(row, ["name", "client_name"]), "Datasource OneView", 160);
    dataSourceNames.set(id, name);
    dataSourceIdsByName.set(name.toLocaleLowerCase("pt-BR"), id);
  });

  const rawHosts = [...new Set(rawAlerts
    .map((row) => asText(firstValue(row, ["host_name", "hostname", "host"])))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const hostAliases = new Map(rawHosts.map((host, index) => [
    host,
    `Host protegido ${String(index + 1).padStart(4, "0")}`,
  ]));

  const dataSources = sourceDataSources.map((row, index) => {
    const id = asText(row.id, `snapshot-datasource-${index + 1}`);
    const name = dataSourceNames.get(id) ?? "Datasource OneView";
    const failureDetail = genericFailureDetail(row);
    return {
      id,
      name,
      client_name: sanitizeText(firstValue(row, ["client_name", "name"]), name, 160),
      type: "zabbix",
      environment: normalizeEnvironment(row.environment),
      problem_group_filter: null,
      status: normalizeDataSourceStatus(row.status),
      sync_enabled: asBoolean(row.sync_enabled, false),
      sync_interval_seconds: 0,
      via_vpn: false,
      observation: null,
      last_sync_at: asText(row.last_sync_at) || null,
      last_sync_status: asText(row.last_sync_status) || null,
      last_sync_error: failureDetail,
      last_success_at: asText(row.last_success_at) || null,
      last_error: failureDetail,
      failure_count: Math.max(0, asNumber(row.failure_count, 0)),
      sync_locked_at: null,
      sync_lock_owner: null,
      display_order: index + 1,
      created_at: generatedAt,
      updated_at: asText(firstValue(row, ["last_sync_at", "last_success_at"]), generatedAt),
      alerts_count: Math.max(0, asNumber(firstValue(row, ["alert_count", "alerts_count"]), 0)),
      pending_reason: failureDetail,
    };
  });

  const clientNames = new Map(dataSources.map((source) => [source.id, source.client_name]));
  const syncLogs = asArray(raw.syncLogs).map((value, index) => {
    const row = asRecord(value);
    const datasource = sanitizeText(firstValue(row, ["datasource", "datasource_name"]), "Datasource OneView", 160);
    const dataSourceId = asText(firstValue(row, ["data_source_id", "datasource_id"]), dataSourceIdsByName.get(datasource.toLocaleLowerCase("pt-BR")) ?? "");
    const status = asText(row.status, "unknown").toLowerCase();
    return {
      id: asText(firstValue(row, ["sync_log_id", "id"]), `snapshot-sync-${index + 1}`),
      datasource,
      data_source_id: dataSourceId,
      status,
      fetched: Math.max(0, asNumber(firstValue(row, ["fetched_count", "fetched"]), 0)),
      upserted: Math.max(0, asNumber(firstValue(row, ["upserted_count", "upserted"]), 0)),
      detail: status === "success" ? "Sincronização concluída." : "Falha registrada; detalhes técnicos protegidos.",
      created_at: asText(firstValue(row, ["finished_at", "created_at", "started_at"]), generatedAt),
    };
  });

  const alerts = rawAlerts.map((row, index) => {
    const id = asText(row.id, `snapshot-alert-${index + 1}`);
    const dataSourceId = asText(firstValue(row, ["data_source_id", "datasource_id", "source"]));
    const status = normalizeAlertStatus(row);
    const rawHost = asText(firstValue(row, ["host_name", "hostname", "host"]));
    const hostAlias = hostAliases.get(rawHost) ?? "Host protegido";
    const startedAt = asText(firstValue(row, ["started_at", "first_seen_at", "created_at"]), generatedAt);
    const lastSeenAt = asText(firstValue(row, ["last_seen_at", "updated_at"]), startedAt);
    return {
      id,
      data_source_id: dataSourceId,
      datasource_name: sanitizeText(row.datasource_name, dataSourceNames.get(dataSourceId) ?? "Datasource OneView", 160),
      client_name: sanitizeText(firstValue(row, ["client_name", "client"]), clientNames.get(dataSourceId) ?? "Cliente OneView", 160),
      source_type: "zabbix",
      source_event_id: asText(firstValue(row, ["source_event_id", "eventid", "event_id"]), id),
      source_problem_id: null,
      source_trigger_id: null,
      source_host_id: null,
      host_alias: hostAlias,
      host_group: null,
      service_name: replaceInternalHost(row.service_name, rawHost, hostAlias, "", 240) || null,
      problem_name: replaceInternalHost(firstValue(row, ["problem_name", "problem", "name", "event_name", "description"]), rawHost, hostAlias, "Alerta sincronizado", 700),
      severity: normalizeSeverity(firstValue(row, ["severity", "priority"])),
      status_source: status,
      status_internal: sanitizeText(row.status_internal, status === "resolved" ? "normalized" : "new", 80),
      acknowledged_source: asBoolean(firstValue(row, ["acknowledged_source", "acknowledged"]), false),
      acknowledged_internal: asBoolean(row.acknowledged_internal, false),
      first_seen_at: startedAt,
      started_at: startedAt,
      last_seen_at: lastSeenAt,
      resolved_at: status === "resolved" ? (asText(row.resolved_at, lastSeenAt) || lastSeenAt) : null,
      duration_seconds: Math.max(0, asNumber(row.duration_seconds, 0)),
      fingerprint: `snapshot-${id}`,
      created_at: startedAt,
      updated_at: lastSeenAt,
    };
  });

  const safeSnapshot = redactKnownHosts({
    generated_at: generatedAt,
    snapshot_status: "updated",
    snapshot_read_only: true,
    alerts_count: summary.total_alerts || alerts.length,
    exported_alerts_count: alerts.length,
    summary,
    grafana_summary: normalizeGrafanaSummary(raw.grafanaSummary),
    clients_summary: normalizeClientSummaries(raw.clientSummaries),
    operational_view: normalizeOperationalView(raw.operationalView),
    data_sources: dataSources,
    sync_logs: syncLogs,
    alerts,
  }, hostAliases);

  assertSafeSnapshot(safeSnapshot, rawHosts);
  return safeSnapshot;
}

async function importLiveSnapshot() {
  const [summary, grafanaSummary, clientSummaries, dataSources, syncLogs, operationalView] = await Promise.all([
    fetchJson("/dashboard/summary"),
    fetchJson("/dashboard/grafana-summary?scope=active"),
    fetchJson("/clients/summary?scope=active"),
    fetchJson("/data-sources"),
    fetchJson("/sync-logs/latest"),
    fetchJson("/operational-view"),
  ]);
  const normalizedSummary = normalizeSummary(summary);
  const alerts = await fetchRecentActiveAlerts(normalizedSummary.active_alerts);

  return buildSafeSnapshot({
    summary,
    grafanaSummary,
    clientSummaries,
    dataSources,
    syncLogs,
    operationalView,
    alerts,
  });
}

async function readFallbackSnapshot() {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (!isRecord(snapshot)) throw new Error("Snapshot fallback inválido: raiz deve ser objeto.");
  assertSafeSnapshot(snapshot);
  return snapshot;
}

const liveAvailable = await isLiveApiAvailable();
const safeSnapshot = liveAvailable ? await importLiveSnapshot() : await readFallbackSnapshot();

await mkdir(dirname(buildSnapshotPath), { recursive: true });
if (liveAvailable) {
  await writeFile(snapshotPath, `${JSON.stringify(safeSnapshot, null, 2)}\n`, "utf8");
}
await writeFile(buildSnapshotPath, `${JSON.stringify(safeSnapshot, null, 2)}\n`, "utf8");

console.log(
  `Snapshot ${liveAvailable ? "importado da API live" : "gerado pelo fallback seguro"}: `
  + `generated_at=${safeSnapshot.generated_at}, alerts_count=${safeSnapshot.alerts_count}, `
  + `alerts=${safeSnapshot.alerts.length}, data_sources=${safeSnapshot.data_sources.length}, `
  + `sync_logs=${safeSnapshot.sync_logs.length}`,
);

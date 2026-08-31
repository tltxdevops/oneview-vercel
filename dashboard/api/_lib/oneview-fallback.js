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
  isActiveAlert,
  isResolvedAlert,
  operationalDayBounds,
  safeCustomerIdentity,
} from "./oneview-db.js";
import { deriveOperationalScope } from "./oneview-operational-scope.js";
import { emptyAlertRecurrenceReadModel } from "./oneview-recurrence.js";
import { getOperationalDataSourceNames } from "./oneview-scope.js";
import { deriveAlertTemporalIntegrity } from "./oneview-temporal-integrity.js";

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
  const temporal = deriveAlertTemporalIntegrity(alert, Date.parse(generatedAt));
  const enrichmentState = classifyAlertEnrichment({
    customer_name: alert.customer_name,
    customer_key: alert.customer_key,
    customer_source: alert.customer_source,
    customer_confidence: alert.customer_confidence,
  });
  const customerIdentity = safeCustomerIdentity(alert);
  const operationalScope = deriveOperationalScope({
    customer_name: alert.customer_name,
    customer_key: alert.customer_key,
    customer_source: alert.customer_source,
    host_name: alert.host_name,
    host_visible_name: alert.host_visible_name,
    host_technical_name: alert.host_technical_name,
    host_groups: alert.host_groups,
  });
  return {
    id: String(alert.id || ""),
    data_source_id: String(alert.data_source_id || ""),
    datasource_name: String(alert.datasource_name || alert.client_name || "Datasource OneView"),
    client_name: String(alert.client_name || "Cliente OneView"),
    customer_name: customerIdentity.customerName,
    customer_key: customerIdentity.customerKey,
    customer_source: alert.customer_source ? String(alert.customer_source) : null,
    customer_confidence: alert.customer_confidence ? String(alert.customer_confidence) : null,
    operational_scope: operationalScope.operational_scope,
    operational_scope_label: operationalScope.operational_scope_label,
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
    acknowledged_source_at: alert.acknowledged_source_at || alert.acknowledged_at || null,
    acknowledged_source_by: alert.acknowledged_source_by || alert.acknowledged_by || null,
    acknowledged_internal_at: alert.acknowledged_internal_at || null,
    acknowledged_internal_by: alert.acknowledged_internal_by || null,
    acknowledged_internal_comment: alert.acknowledged_internal_comment || null,
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
    duration_seconds: temporal.duration_seconds,
    temporal_integrity: temporal.temporal_integrity,
    created_at: alert.created_at || alert.first_seen_at || generatedAt,
    updated_at: alert.updated_at || alert.last_seen_at || generatedAt,
  };
}

function snapshotAlerts(snapshot) {
  return (snapshot.alerts || []).map((alert) => snapshotAlert(alert, snapshot.generated_at));
}

function scopedSnapshot(snapshot, dataSourceNames) {
  const scopedNames = new Set(dataSourceNames.map((name) => String(name).toLowerCase()));
  const sourceIds = new Set(
    (snapshot.data_sources || [])
      .filter((source) => scopedNames.has(String(source.name || "").toLowerCase()))
      .map((source) => String(source.id || "")),
  );
  return {
    ...snapshot,
    alerts: (snapshot.alerts || []).filter((alert) => (
      scopedNames.has(String(alert.datasource_name || alert.client_name || "").toLowerCase())
      || sourceIds.has(String(alert.data_source_id || ""))
    )),
    data_sources: (snapshot.data_sources || []).filter((source) => (
      scopedNames.has(String(source.name || "").toLowerCase())
    )),
    sync_logs: (snapshot.sync_logs || []).filter((log) => (
      scopedNames.has(String(log.datasource || "").toLowerCase())
      || sourceIds.has(String(log.data_source_id || ""))
    )),
  };
}

function attentionRequiredPayload(snapshot, req, thresholds = getAttentionThresholds(), dataSourceNames) {
  const { limit, firstSeenFrom, firstSeenTo } = buildAttentionRequiredQuery(req, thresholds, dataSourceNames);
  const matching = snapshotAlerts(snapshot)
    .map((alert) => {
      const state = attentionRequiredState(alert, thresholds, Date.now(), { firstSeenFrom, firstSeenTo });
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
  const critical = matching.filter(({ alert }) => alert.severity === "critical").length;
  const high = matching.filter(({ alert }) => alert.severity === "high").length;
  const average = matching.filter(({ alert }) => alert.severity === "average").length;
  const low = matching.filter(({ alert }) => ["warning", "information", "not_classified"].includes(alert.severity)).length;

  return {
    generated_at: snapshot.generated_at,
    summary: {
      total: matching.length,
      disaster,
      critical,
      high,
      average,
      low,
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
      low_minutes: thresholds.lowMinutes,
    },
    items: matching.slice(0, limit).map(({ alert, unacknowledgedMinutes }) => ({
      id: alert.id,
      customer_name: alert.customer_name,
      customer_confidence: alert.customer_confidence || "unclassified",
      datasource_name: alert.datasource_name,
      // OV-P0-52 — não promover "Host protegido" para host_visible_name.
      host_visible_name: alert.host_visible_name || null,
      host_technical_name: alert.host_technical_name || null,
      host_name: /^host protegido\b/i.test(String(alert.host_name || ""))
        ? null
        : (alert.host_name || null),
      problem: alert.problem_name,
      severity: alert.severity,
      first_seen_at: alert.first_seen_at,
      last_seen_at: alert.last_seen_at,
      unacknowledged_minutes: unacknowledgedMinutes,
      acknowledged: false,
    })),
    snapshot_coverage: {
      partial: Number(snapshot.alerts_count || 0) > Number(snapshot.alerts?.length || 0),
      total_persisted: Number(snapshot.alerts?.length || 0),
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

function filteredAlerts(snapshot, req, dataSourceNames) {
  let items = snapshotAlerts(snapshot);
  const { page, pageSize, offset, filters } = buildAlertListQuery(req, dataSourceNames);

  if (filters.clients.length) items = items.filter((item) => filters.clients.includes(item.client_name));
  if (filters.customers.length) items = items.filter((item) => filters.customers.includes(item.customer_key || "unclassified"));
  if (filters.datasources.length) items = items.filter((item) => filters.datasources.includes(item.datasource_name));
  if (filters.customerConfidences.length) {
    items = items.filter((item) => filters.customerConfidences.includes(item.customer_confidence || "unclassified"));
  }
  if (filters.severities.length) items = items.filter((item) => filters.severities.includes(item.severity));
  if (filters.status === "active") items = items.filter(isActiveAlert);
  if (filters.status === "resolved") items = items.filter(isResolvedAlert);
  if (filters.acknowledged) {
    const expected = filters.acknowledged === "true";
    items = items.filter((item) => Boolean(item.acknowledged_internal || item.acknowledged_source) === expected);
  }
  if (filters.acknowledgedSource) {
    const expected = filters.acknowledgedSource === "true";
    items = items.filter((item) => Boolean(item.acknowledged_source) === expected);
  }
  if (filters.acknowledgedInternal) {
    const expected = filters.acknowledgedInternal === "true";
    items = items.filter((item) => Boolean(item.acknowledged_internal) === expected);
  }
  if (filters.search) {
    const search = filters.search.toLocaleLowerCase("pt-BR");
    const searchField = String(filters.searchField || "all").toLowerCase();
    items = items.filter((item) => {
      const host = [item.host_visible_name, item.host_technical_name, item.host_name]
        .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(search));
      const problem = String(item.problem_name || "").toLocaleLowerCase("pt-BR").includes(search);
      const customer = [item.customer_name, item.client_name, item.customer_key]
        .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(search));
      const eventId = [item.source_event_id, item.id]
        .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(search));
      if (searchField === "host") return host;
      if (searchField === "problem") return problem;
      if (searchField === "customer") return customer;
      if (searchField === "eventid") return eventId;
      return host || problem || customer || eventId
        || String(item.service_name || "").toLocaleLowerCase("pt-BR").includes(search);
    });
  }
  if (filters.hostSearch) {
    const hostSearch = filters.hostSearch.toLocaleLowerCase("pt-BR");
    items = items.filter((item) => [item.host_visible_name, item.host_technical_name, item.host_name]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(hostSearch)));
  }
  if (filters.problemSearch) {
    const problemSearch = filters.problemSearch.toLocaleLowerCase("pt-BR");
    items = items.filter((item) => String(item.problem_name || "").toLocaleLowerCase("pt-BR").includes(problemSearch));
  }

  const baseItems = [...items];
  if (filters.dateFrom) items = items.filter((item) => Date.parse(item.last_seen_at) >= Date.parse(filters.dateFrom));
  if (filters.dateTo) items = items.filter((item) => Date.parse(item.last_seen_at) <= Date.parse(filters.dateTo));
  if (filters.firstSeenFrom) items = items.filter((item) => Date.parse(item.first_seen_at) >= Date.parse(filters.firstSeenFrom));
  if (filters.firstSeenTo) items = items.filter((item) => Date.parse(item.first_seen_at) <= Date.parse(filters.firstSeenTo));
  if (filters.lastSeenFrom) items = items.filter((item) => Date.parse(item.last_seen_at) >= Date.parse(filters.lastSeenFrom));
  if (filters.lastSeenTo) items = items.filter((item) => Date.parse(item.last_seen_at) <= Date.parse(filters.lastSeenTo));
  if (filters.resolvedFrom) items = items.filter((item) => item.resolved_at && Date.parse(item.resolved_at) >= Date.parse(filters.resolvedFrom));
  if (filters.resolvedTo) items = items.filter((item) => item.resolved_at && Date.parse(item.resolved_at) <= Date.parse(filters.resolvedTo));
  if (filters.acknowledgedFrom) {
    items = items.filter((item) => {
      const acknowledgedAt = item.acknowledged_source_at || item.acknowledged_at;
      return acknowledgedAt && Date.parse(acknowledgedAt) >= Date.parse(filters.acknowledgedFrom);
    });
  }
  if (filters.acknowledgedTo) {
    items = items.filter((item) => {
      const acknowledgedAt = item.acknowledged_source_at || item.acknowledged_at;
      return acknowledgedAt && Date.parse(acknowledgedAt) <= Date.parse(filters.acknowledgedTo);
    });
  }

  const severityRank = { disaster: 7, critical: 6, high: 5, average: 4, warning: 3, information: 2, not_classified: 1 };
  const valueOf = (item) => {
    if (filters.sort === "severity") return severityRank[item.severity] ?? 0;
    if (filters.sort === "client") return item.customer_name || item.client_name;
    if (filters.sort === "datasource") return item.datasource_name;
    if (filters.sort === "host") return item.host_name;
    if (filters.sort === "problem") return item.problem_name;
    if (filters.sort === "duration") return item.duration_seconds ?? -1;
    if (filters.sort === "status") return isResolvedAlert(item) ? 1 : 0;
    if (filters.sort === "acknowledged_source") return item.acknowledged_source ? 1 : 0;
    if (filters.sort === "acknowledged_at") return Date.parse(item.acknowledged_source_at || item.acknowledged_at || "") || 0;
    return Date.parse(item[filters.sort] || item.last_seen_at) || 0;
  };
  const secondaryValueOf = (item) => {
    if (filters.sortSecondary === "duration") return item.duration_seconds ?? -1;
    if (filters.sortSecondary === "resolved_at") return Date.parse(item.resolved_at || "") || 0;
    if (filters.sortSecondary === "acknowledged_at") {
      return Date.parse(item.acknowledged_source_at || item.acknowledged_at || "") || 0;
    }
    if (filters.sortSecondary === "first_seen_at") return Date.parse(item.first_seen_at || "") || 0;
    if (filters.sortSecondary === "last_seen_at") return Date.parse(item.last_seen_at || "") || 0;
    if (filters.sort === "severity") return Date.parse(item.first_seen_at || "") || 0;
    return Date.parse(item.last_seen_at || "") || 0;
  };
  items.sort((left, right) => {
    const leftValue = valueOf(left);
    const rightValue = valueOf(right);
    const comparison = typeof leftValue === "string"
      ? leftValue.localeCompare(String(rightValue), "pt-BR")
      : Number(leftValue) - Number(rightValue);
    if (comparison !== 0) return filters.order === "asc" ? comparison : -comparison;
    return Number(secondaryValueOf(right)) - Number(secondaryValueOf(left));
  });

  const filteredItems = items;
  const filteredTotal = filteredItems.length;
  const totalPages = filteredTotal === 0 ? 0 : Math.ceil(filteredTotal / pageSize);
  const countSince = (source, field, milliseconds) => {
    const threshold = Date.now() - milliseconds;
    return source.filter((item) => item[field] && Date.parse(item[field]) >= threshold).length;
  };
  const temporalGroup = (field, include30Days = false) => ({
    "15m": countSince(baseItems, field, 15 * 60_000),
    "1h": countSince(baseItems, field, 60 * 60_000),
    "6h": countSince(baseItems, field, 6 * 60 * 60_000),
    "24h": countSince(baseItems, field, 24 * 60 * 60_000),
    "7d": countSince(baseItems, field, 7 * 24 * 60 * 60_000),
    ...(include30Days ? { "30d": countSince(baseItems, field, 30 * 24 * 60 * 60_000) } : {}),
  });
  // OV-P0-39B: summary no conjunto filtrado completo, antes do slice de paginação.
  // by_severity = information/warning/average/high/disaster; critical legado → high;
  // not_classified separado; items da resposta permanecem limitados a page_size (máx. 100).
  const filteredSummary = {
    total: filteredTotal,
    active: filteredItems.filter(isActiveAlert).length,
    resolved: filteredItems.filter(isResolvedAlert).length,
    acknowledged_source: filteredItems.filter((item) => Boolean(item.acknowledged_source)).length,
    unacknowledged_source: filteredItems.filter((item) => !item.acknowledged_source).length,
    by_severity: {
      information: filteredItems.filter((item) => item.severity === "information").length,
      warning: filteredItems.filter((item) => item.severity === "warning").length,
      average: filteredItems.filter((item) => item.severity === "average").length,
      high: filteredItems.filter((item) => item.severity === "high" || item.severity === "critical").length,
      disaster: filteredItems.filter((item) => item.severity === "disaster").length,
    },
    not_classified: filteredItems.filter((item) => item.severity === "not_classified").length,
  };

  return {
    generated_at: snapshot.generated_at,
    items: filteredItems.slice(offset, offset + pageSize),
    filtered_summary: filteredSummary,
    temporal_counts: {
      created: temporalGroup("first_seen_at"),
      updated: temporalGroup("last_seen_at"),
      resolved: temporalGroup("resolved_at", true),
    },
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
      total_persisted: Number(snapshot.alerts?.length || 0),
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

function isWithinDay(value, day) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp)
    && timestamp >= Date.parse(day.from)
    && timestamp < Date.parse(day.to);
}

function dashboardSummaryPayload(snapshot, timeZone) {
  const alerts = snapshotAlerts(snapshot);
  const active = alerts.filter((alert) => alert.status_source === "active" && !alert.resolved_at);
  const alertsTotal = alerts.length;
  const activeTotal = active.length;
  const day = operationalDayBounds(timeZone);

  return {
    generated_at: snapshot.generated_at,
    alerts_total: alertsTotal,
    alerts_sample_size: Math.max(0, Number(snapshot.exported_alerts_count) || alerts.length),
    active_total: activeTotal,
    resolved_today: alerts.filter((alert) => isWithinDay(alert.resolved_at, day)).length,
    source_acknowledgements_today: alerts.filter((alert) => (
      alert.acknowledged_source && isWithinDay(alert.acknowledged_source_at ?? alert.acknowledged_at, day)
    )).length,
    oneview_acknowledgements_today: alerts.filter((alert) => (
      alert.acknowledged_internal && isWithinDay(alert.acknowledged_internal_at, day)
    )).length,
    operational_day: { timezone: day.timeZone, from: day.from, to: day.to },
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
    unacknowledged_total: active.filter((alert) => !(alert.acknowledged_internal || alert.acknowledged_source)).length,
    longest_duration: [...active]
      .filter((alert) => Number.isFinite(alert.duration_seconds) && alert.duration_seconds >= 0)
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
  const acknowledged = alerts.filter((alert) => alert.acknowledged_internal || alert.acknowledged_source).length;
  const total = alerts.length;

  return {
    generated_at: snapshot.generated_at,
    total,
    acknowledged,
    unacknowledged: Math.max(total - acknowledged, 0),
    average: alerts.filter((alert) => ["average", "warning"].includes(alert.severity)).length,
    high: alerts.filter((alert) => alert.severity === "high").length,
    disaster: alerts.filter((alert) => alert.severity === "disaster").length,
    by_client: countBy(alerts, (alert) => alert.client_name, (client, count) => ({ client, count })),
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

function clientsSummaryPayload(snapshot, req = {}) {
  const alerts = snapshotAlerts(snapshot).filter((alert) => alert.status_source === "active" && !alert.resolved_at);
  const severityRank = (value) => {
    const severity = String(value || "").toLowerCase();
    if (severity === "disaster") return 7;
    if (severity === "critical") return 6;
    if (severity === "high") return 5;
    if (severity === "average") return 4;
    if (severity === "warning") return 2;
    if (severity === "information") return 1;
    return 0;
  };
  const severityFromRank = (rank) => {
    if (rank >= 7) return "disaster";
    if (rank >= 6) return "critical";
    if (rank >= 5) return "high";
    if (rank >= 4) return "average";
    if (rank >= 2) return "warning";
    if (rank >= 1) return "information";
    return "not_classified";
  };

  const firstSeenFromRaw = oneQueryValue(req, "first_seen_from");
  const firstSeenToRaw = oneQueryValue(req, "first_seen_to");
  const firstSeenFromMs = firstSeenFromRaw ? Date.parse(String(firstSeenFromRaw)) : NaN;
  const firstSeenToMs = firstSeenToRaw ? Date.parse(String(firstSeenToRaw)) : NaN;
  const hasWindow = Boolean(firstSeenFromRaw);

  // OV-P0-42B: modo janela — espelho do SQL server-side.
  if (hasWindow) {
    const limit = asInt(oneQueryValue(req, "limit") || 5, 5, { min: 1, max: 50 });
    const fromIso = Number.isFinite(firstSeenFromMs) ? new Date(firstSeenFromMs).toISOString() : String(firstSeenFromRaw);
    const toIso = firstSeenToRaw && Number.isFinite(firstSeenToMs) ? new Date(firstSeenToMs).toISOString() : null;
    const windowed = alerts.filter((alert) => {
      const seen = Date.parse(alert.first_seen_at || "");
      if (!Number.isFinite(seen)) return false;
      if (Number.isFinite(firstSeenFromMs) && seen < firstSeenFromMs) return false;
      if (Number.isFinite(firstSeenToMs) && seen > firstSeenToMs) return false;
      return true;
    });

    const groups = new Map();
    for (const alert of windowed) {
      const identity = safeCustomerIdentity(alert);
      const key = identity.customerKey || "unclassified";
      const name = identity.unidentified
        ? "Cliente não identificado"
        : (identity.customerName || alert.customer_name || "Cliente não identificado");
      const current = groups.get(key);
      if (current) current.count += 1;
      else groups.set(key, { customer_key: key, customer_name: name, count: 1 });
    }

    let totalActive = 0;
    let unclassifiedCount = 0;
    const identified = [];
    for (const item of groups.values()) {
      totalActive += item.count;
      if (item.customer_key === "unclassified") {
        unclassifiedCount = item.count;
        continue;
      }
      identified.push(item);
    }
    identified.sort((left, right) => right.count - left.count || String(left.customer_name).localeCompare(String(right.customer_name)));

    return {
      generated_at: snapshot.generated_at,
      window: {
        field: "first_seen_at",
        from: fromIso,
        to: toIso,
      },
      total_active: totalActive,
      top_clients: identified.slice(0, limit),
      unclassified_count: unclassifiedCount,
      partial: identified.length > limit,
      clients: [],
      customers: [],
      datasources: [],
    };
  }

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
        const group = alerts.filter((alert) => (alert.customer_key || "unclassified") === key);
        const item = group[0];
        const maxRank = group.reduce((current, alert) => Math.max(current, severityRank(alert.severity)), 0);
        return {
          key,
          name: item?.customer_name || "Cliente não identificado",
          alerts_count: count,
          disaster_count: group.filter((alert) => ["disaster", "critical"].includes(String(alert.severity || "").toLowerCase())).length,
          high_count: group.filter((alert) => String(alert.severity || "").toLowerCase() === "high").length,
          unacknowledged_count: group.filter((alert) => !alert.acknowledged_source).length,
          max_severity: severityFromRank(maxRank),
          high_confidence_count: group.filter((alert) => alert.customer_confidence === "high").length,
          low_confidence_count: group.filter((alert) => alert.customer_confidence === "low").length,
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

function globalHistoryPayload(snapshot, req) {
  const page = Math.max(1, Number.parseInt(String(oneQueryValue(req, "page") || "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(oneQueryValue(req, "page_size") || "50"), 10) || 50));
  const eventType = String(oneQueryValue(req, "event_type") || "all").toLowerCase();
  const eventGroups = {
    operational: [
      "problem_created",
      "created_from_zabbix",
      "acknowledged",
      "ack_message",
      "severity_changed",
      "recovered",
      "maintenance",
      "suppressed",
      "unsuppressed",
    ],
    identified: ["problem_created", "created_from_zabbix"],
    actions: [
      "acknowledged",
      "ack_message",
      "severity_changed",
      "recovered",
      "maintenance",
      "suppressed",
      "unsuppressed",
    ],
    ack: ["acknowledged"],
    ack_comment: ["ack_message"],
    acks: ["acknowledged", "ack_message"],
    resolution: ["recovered"],
    severity: ["severity_changed"],
    maintenance: ["maintenance", "suppressed", "unsuppressed"],
    update: ["problem_seen", "status_changed", "reopened", "problem_created", "created_from_zabbix"],
  };
  if (eventType !== "all" && !Object.hasOwn(eventGroups, eventType)) throw fallbackError("invalid_query", 400);

  // Snapshot seguro não inclui alert_history global; retorna lista vazia paginada.
  return {
    generated_at: snapshot.generated_at,
    items: [],
    pagination: {
      page,
      page_size: pageSize,
      total_items: 0,
      total_pages: 1,
      has_next: false,
      has_previous: false,
    },
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
  const source_ack = {
    acknowledged: Boolean(item.acknowledged_source),
    actor_name: item.acknowledged_source_by || item.acknowledged_by || null,
    acknowledged_at: item.acknowledged_source_at || item.acknowledged_at || null,
    comment: null,
    acknowledge_id: null,
    history_available: false,
  };
  if (source_ack.actor_name && /^\d+$/.test(String(source_ack.actor_name).trim())) {
    source_ack.actor_name = null;
  }
  return {
    generated_at: snapshot.generated_at,
    item: {
      ...item,
      ...emptyAlertRecurrenceReadModel(),
      history_count: 0,
      acknowledgement_count: 0,
      source_ack,
    },
  };
}

function alertHistoryPayload(snapshot, req) {
  const item = requestedAlert(snapshot, req);
  const acknowledgedSource = Boolean(item.acknowledged_source);
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
    has_ack: acknowledgedSource,
    acknowledgement_count: 0,
    first_ack_at: null,
    latest_ack_at: null,
    has_ack_comment: false,
    ack_actor_summary: acknowledgedSource ? "ACK atual confirmado pela origem" : "Sem ACK",
  };
}

function operationsHealthPayload(snapshot, dataSourceNames) {
  const logsBySource = new Map();
  for (const log of snapshot.sync_logs || []) {
    const current = logsBySource.get(log.data_source_id);
    if (!current || Date.parse(log.created_at || "") > Date.parse(current.created_at || "")) {
      logsBySource.set(log.data_source_id, log);
    }
  }
  const now = Date.now();
  const scopedNames = new Set(dataSourceNames.map((name) => String(name).toLowerCase()));
  const sources = (snapshot.data_sources || []).filter((source) => {
    return scopedNames.has(String(source.name || "").toLowerCase());
  });
  const items = sources.map((source) => {
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
  const loadedSnapshot = await loadSnapshot();
  const allowedDataSourceNames = new Set(getOperationalDataSourceNames());
  const requestedDataSourceNames = Array.isArray(config.operationalDataSourceNames)
    ? config.operationalDataSourceNames
    : getOperationalDataSourceNames();
  const dataSourceNames = requestedDataSourceNames.filter((name) => allowedDataSourceNames.has(String(name).toLowerCase()));
  const snapshot = scopedSnapshot(loadedSnapshot, dataSourceNames);
  const alerts = snapshot.alerts || [];

  switch (routeName) {
    case "health":
      return {
        status: "ok",
        database_reachable: false,
        counts: {
          total_alerts: alerts.length,
          active_alerts: snapshotAlerts(snapshot).filter(isActiveAlert).length,
        },
        capabilities: { acknowledgement: false },
        thresholds: { alert_stale_minutes: Number(config.alertStaleMinutes) || 15 },
      };
    case "dashboard-summary":
      return dashboardSummaryPayload(snapshot, config.operationalTimezone);
    case "grafana-summary":
      return grafanaSummaryPayload(snapshot);
    case "alerts":
      return filteredAlerts(snapshot, req, dataSourceNames);
    case "attention-required":
      return attentionRequiredPayload(snapshot, req, config.attentionThresholds, dataSourceNames);
    case "alert-detail":
      return alertDetailPayload(snapshot, req);
    case "alert-history":
      return alertHistoryPayload(snapshot, req);
    case "history":
      return globalHistoryPayload(snapshot, req);
    case "operations-health":
      return operationsHealthPayload(snapshot, dataSourceNames);
    case "clients-summary":
      return clientsSummaryPayload(snapshot, req);
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

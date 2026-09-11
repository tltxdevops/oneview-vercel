/**
 * OV-P0-281 — Runtime Health Truth V3
 *
 * Separates SYNC_PROCESS from source connectivity/auth/API/freshness/active truth.
 * last_success_at alone must never produce HEALTHY.
 * Write paths that are ready but disabled stay READY_DISABLED (never DOWN).
 */

export const RUNTIME_TRUTH_STATUS = Object.freeze({
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  DOWN: "DOWN",
  STALE: "STALE",
  READY_DISABLED: "READY_DISABLED",
  CONFIG_MISSING: "CONFIG_MISSING",
  UNKNOWN: "UNKNOWN",
});

export const SILENT_BADGE = "HEALTHY_SILENT";
export const SILENT_BADGE_LABEL = "Origem silenciosa";
export const SILENT_STALE_MS = 24 * 60 * 60 * 1000;

const STATUS_RANK = Object.freeze({
  HEALTHY: 0,
  READY_DISABLED: 1,
  UNKNOWN: 2,
  STALE: 3,
  DEGRADED: 4,
  CONFIG_MISSING: 5,
  DOWN: 6,
});

function text(value) {
  return String(value || "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function isoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function ageMs(value, now) {
  const parsed = Date.parse(String(value || ""));
  if (!value || Number.isNaN(parsed)) return null;
  return Math.max(0, now - parsed);
}

function dim(status, { checkedAt = null, evidenceAt = null, detail = null, cause = null } = {}) {
  return {
    status,
    checked_at: isoOrNull(checkedAt),
    evidence_at: isoOrNull(evidenceAt),
    detail: detail || null,
    cause: cause || null,
  };
}

export function worstStatus(statuses) {
  let worst = null;
  let rank = -1;
  for (const status of statuses || []) {
    if (!status) continue;
    const current = STATUS_RANK[status] ?? STATUS_RANK.UNKNOWN;
    if (current > rank) {
      rank = current;
      worst = status;
    }
  }
  return worst || RUNTIME_TRUTH_STATUS.UNKNOWN;
}

export function classifyTlsCause(error) {
  const value = lower(error);
  if (!value) return null;
  if (value.includes("tls_hostname_mismatch") && value.includes("private_ca_not_in_system_trust")) {
    return "TLS_HOSTNAME_MISMATCH+PRIVATE_CA_NOT_IN_SYSTEM_TRUST";
  }
  if (value === "tls_hostname_mismatch" || value.includes("tls_hostname_mismatch+")) {
    return value.includes("private_ca")
      ? "TLS_HOSTNAME_MISMATCH+PRIVATE_CA_NOT_IN_SYSTEM_TRUST"
      : "TLS_HOSTNAME_MISMATCH";
  }
  const hostnameMismatch = /(hostname|cert.*(mismatch|does not match)|altnames|err_tls_cert_altname|cn mismatch|san)/.test(value)
    || (value.includes("fraport-brasil.local") && /(ip|hostname|tls|cert)/.test(value));
  const privateCa = /(unable to verify|self[- ]signed|local issuer|unknown ca|private[_ ]ca|certificate_verify_failed|untrusted)/.test(value);
  if (hostnameMismatch && privateCa) return "TLS_HOSTNAME_MISMATCH+PRIVATE_CA_NOT_IN_SYSTEM_TRUST";
  if (hostnameMismatch) return "TLS_HOSTNAME_MISMATCH";
  if (privateCa) return "PRIVATE_CA_NOT_IN_SYSTEM_TRUST";
  if (/(tls|certificate|ssl|handshake)/.test(value)) return "TLS_FAILURE";
  return null;
}

export function classifyErrorCause(error) {
  const value = lower(error);
  if (!value) return null;
  const tls = classifyTlsCause(value);
  if (tls) return tls;
  if (/(auth|token|unauthori[sz]ed|forbidden|login|invalid.*(key|token|credential))/.test(value)) return "AUTH_FAILURE";
  if (/(econnrefused|enotfound|ehostunreach|enetunreach|tcp|network|socket|timeout|etimedout)/.test(value)) return "TCP_FAILURE";
  if (/(api|jsonrpc|http\/?\s*[45]\d\d|bad request|server error)/.test(value)) return "API_FAILURE";
  return "UNKNOWN_ERROR";
}

function probeFlag(probe, key) {
  if (!probe || typeof probe !== "object") return null;
  const value = probe[key];
  if (value === true || value === "HEALTHY" || value === "WORKING" || value === "PASS") return "HEALTHY";
  if (value === false || value === "FAILED" || value === "FAIL" || value === "DOWN") return "FAILED";
  if (value == null || value === "") return null;
  return String(value).toUpperCase();
}

export function classifyActiveTruth({
  sourceActive = null,
  dbActive = null,
  missing = null,
  extra = null,
  extraExplained = null,
  checkedAt = null,
  evidenceAt = null,
} = {}) {
  const source = sourceActive == null ? null : Number(sourceActive);
  const db = dbActive == null ? null : Number(dbActive);
  const missingCount = missing == null ? null : Number(missing);
  const extraCount = extra == null ? null : Number(extra);
  const explained = extraExplained == null ? 0 : Number(extraExplained);
  const unexplainedExtra = extraCount == null
    ? null
    : Math.max(0, extraCount - (Number.isFinite(explained) ? explained : 0));

  let status = RUNTIME_TRUTH_STATUS.UNKNOWN;
  if (source != null && db != null && missingCount != null && extraCount != null) {
    status = (missingCount > 0 || unexplainedExtra > 0)
      ? RUNTIME_TRUTH_STATUS.DEGRADED
      : RUNTIME_TRUTH_STATUS.HEALTHY;
  }

  return {
    dimension: dim(status, {
      checkedAt,
      evidenceAt,
      detail: status === RUNTIME_TRUTH_STATUS.DEGRADED
        ? "MISSING ou EXTRA inexplicado entre origem e DB"
        : status === RUNTIME_TRUTH_STATUS.HEALTHY
          ? "Active truth alinhada"
          : "Sem SOURCE_ACTIVE comparável",
    }),
    metrics: {
      SOURCE_ACTIVE: source,
      DB_ACTIVE: db,
      MISSING: missingCount,
      EXTRA: extraCount,
      EXTRA_EXPLAINED: explained,
    },
  };
}

/**
 * Multi-dimension Zabbix source truth.
 * last_success_at / SYNC_PROCESS alone never yields overall HEALTHY.
 */
export function classifyZabbixSourceTruth({
  sourceName = "",
  enabled = true,
  configured = true,
  lastSuccessAt = null,
  lastSyncAt = null,
  lastDbEventAt = null,
  lastSourceEventAt = null,
  intervalSeconds = 60,
  lastError = null,
  failureCount = 0,
  probe = null,
  activeTruth = null,
  now = Date.now(),
  silentStaleMs = SILENT_STALE_MS,
} = {}) {
  const checkedAt = new Date(now).toISOString();
  const name = lower(sourceName);
  const currentFailure = Number(failureCount || 0) > 0;
  const currentError = currentFailure ? lastError : null;
  const tlsCause = (probe?.cause && String(probe.cause).includes("TLS_"))
    ? String(probe.cause)
    : classifyTlsCause(currentError)
      || classifyTlsCause(probe?.tls_cause)
      || classifyTlsCause(probe?.cause)
      || null;
  const errorCause = classifyErrorCause(currentError);

  const syncProcess = (() => {
    if (!configured) {
      return dim(RUNTIME_TRUTH_STATUS.CONFIG_MISSING, {
        checkedAt,
        evidenceAt: lastSuccessAt,
        detail: "Configuração pendente",
      });
    }
    if (!enabled) {
      return dim(RUNTIME_TRUTH_STATUS.READY_DISABLED, {
        checkedAt,
        evidenceAt: lastSuccessAt,
        detail: "Sync desabilitado",
      });
    }
    const successAge = ageMs(lastSuccessAt, now);
    if (successAge == null) {
      return dim(RUNTIME_TRUTH_STATUS.UNKNOWN, { checkedAt, detail: "Sem last_success_at" });
    }
    const ratio = successAge / (Math.max(1, Number(intervalSeconds) || 60) * 1000);
    if (ratio <= 2) {
      return dim(RUNTIME_TRUTH_STATUS.HEALTHY, {
        checkedAt,
        evidenceAt: lastSuccessAt,
        detail: "Worker/sync recente",
      });
    }
    if (ratio <= 3) {
      return dim(RUNTIME_TRUTH_STATUS.DEGRADED, {
        checkedAt,
        evidenceAt: lastSuccessAt,
        detail: "Sync atrasado",
      });
    }
    return dim(RUNTIME_TRUTH_STATUS.STALE, {
      checkedAt,
      evidenceAt: lastSuccessAt,
      detail: "Sync desatualizado",
    });
  })();

  const hasProbe = Boolean(probe && typeof probe === "object");
  const tcpFlag = probeFlag(probe, "tcp");
  const authFlag = probeFlag(probe, "auth");
  const apiFlag = probeFlag(probe, "api");
  const tlsStrictFlag = probeFlag(probe, "tls_strict");
  const tlsInsecureFlag = probeFlag(probe, "tls_insecure");

  const tcpStatus = hasProbe
    ? (tcpFlag === "HEALTHY"
      ? RUNTIME_TRUTH_STATUS.HEALTHY
      : tcpFlag === "FAILED"
        ? RUNTIME_TRUTH_STATUS.DOWN
        : RUNTIME_TRUTH_STATUS.UNKNOWN)
    : currentFailure && errorCause === "TCP_FAILURE"
      ? RUNTIME_TRUTH_STATUS.DOWN
      : lastSuccessAt
        ? RUNTIME_TRUTH_STATUS.HEALTHY
        : RUNTIME_TRUTH_STATUS.UNKNOWN;

  const authStatus = hasProbe
    ? (authFlag === "HEALTHY"
      ? RUNTIME_TRUTH_STATUS.HEALTHY
      : authFlag === "FAILED"
        ? RUNTIME_TRUTH_STATUS.DOWN
        : RUNTIME_TRUTH_STATUS.UNKNOWN)
    : currentFailure && errorCause === "AUTH_FAILURE"
      ? RUNTIME_TRUTH_STATUS.DOWN
      : lastSuccessAt
        ? RUNTIME_TRUTH_STATUS.HEALTHY
        : RUNTIME_TRUTH_STATUS.UNKNOWN;

  const apiStatus = hasProbe
    ? (apiFlag === "HEALTHY"
      ? RUNTIME_TRUTH_STATUS.HEALTHY
      : apiFlag === "FAILED"
        ? RUNTIME_TRUTH_STATUS.DOWN
        : RUNTIME_TRUTH_STATUS.UNKNOWN)
    : currentFailure && errorCause === "API_FAILURE"
      ? RUNTIME_TRUTH_STATUS.DOWN
      : lastSuccessAt
        ? RUNTIME_TRUTH_STATUS.HEALTHY
        : RUNTIME_TRUTH_STATUS.UNKNOWN;

  const tlsStrictStatus = hasProbe
    ? (tlsStrictFlag === "HEALTHY"
      ? RUNTIME_TRUTH_STATUS.HEALTHY
      : tlsStrictFlag === "FAILED"
        ? RUNTIME_TRUTH_STATUS.DEGRADED
        : RUNTIME_TRUTH_STATUS.UNKNOWN)
    : tlsCause
      ? RUNTIME_TRUTH_STATUS.DEGRADED
      : RUNTIME_TRUTH_STATUS.UNKNOWN;

  const tlsInsecureStatus = hasProbe
    ? (tlsInsecureFlag === "HEALTHY"
      ? RUNTIME_TRUTH_STATUS.HEALTHY
      : tlsInsecureFlag === "FAILED"
        ? RUNTIME_TRUTH_STATUS.DOWN
        : RUNTIME_TRUTH_STATUS.UNKNOWN)
    : tlsCause && (apiStatus === RUNTIME_TRUTH_STATUS.HEALTHY || authStatus === RUNTIME_TRUTH_STATUS.HEALTHY)
      ? RUNTIME_TRUTH_STATUS.HEALTHY
      : RUNTIME_TRUTH_STATUS.UNKNOWN;

  // Rede/TCP stays independent of TLS: TLS_STRICT is its own dimension.
  const connectivity = dim(tcpStatus, {
    checkedAt,
    evidenceAt: probe?.checked_at || lastSyncAt || lastSuccessAt,
    detail: tlsCause ? "TCP ok; TLS estrito falhou" : null,
  });

  const sourceAuth = dim(authStatus, {
    checkedAt,
    evidenceAt: probe?.checked_at || lastSuccessAt,
    cause: errorCause === "AUTH_FAILURE" ? errorCause : null,
  });
  const sourceApi = dim(apiStatus, {
    checkedAt,
    evidenceAt: probe?.checked_at || lastSuccessAt,
    cause: errorCause === "API_FAILURE" ? errorCause : null,
  });

  const eventAt = lastSourceEventAt || lastDbEventAt;
  const eventAge = ageMs(eventAt, now);
  const pathHealthy = [tcpStatus, authStatus, apiStatus].every((status) => status === RUNTIME_TRUTH_STATUS.HEALTHY);
  const syncHealthy = syncProcess.status === RUNTIME_TRUTH_STATUS.HEALTHY;
  const silentEligible = enabled && configured && syncHealthy && pathHealthy && !currentFailure && eventAge != null;
  const silent = silentEligible && eventAge >= silentStaleMs;

  const freshnessStatus = (() => {
    if (!enabled) return RUNTIME_TRUTH_STATUS.READY_DISABLED;
    if (!configured) return RUNTIME_TRUTH_STATUS.CONFIG_MISSING;
    if (silent) return RUNTIME_TRUTH_STATUS.STALE;
    if (eventAge == null && !lastSuccessAt) return RUNTIME_TRUTH_STATUS.UNKNOWN;
    if (eventAge == null || eventAge <= silentStaleMs) return RUNTIME_TRUTH_STATUS.HEALTHY;
    return RUNTIME_TRUTH_STATUS.STALE;
  })();

  const freshness = dim(freshnessStatus, {
    checkedAt,
    evidenceAt: eventAt,
    detail: silent
      ? "Origem acessível e sincronizada; nenhum novo evento existe no Zabbix."
      : null,
  });

  const active = classifyActiveTruth({
    sourceActive: activeTruth?.source_active,
    dbActive: activeTruth?.db_active,
    missing: activeTruth?.missing,
    extra: activeTruth?.extra,
    extraExplained: activeTruth?.extra_explained,
    checkedAt,
    evidenceAt: activeTruth?.evidence_at || checkedAt,
  });

  const fraportTlsDegraded = (name === "fraport-for" || name === "fraport-poa")
    && tlsStrictStatus === RUNTIME_TRUTH_STATUS.DEGRADED
    && (apiStatus === RUNTIME_TRUTH_STATUS.HEALTHY || tlsInsecureStatus === RUNTIME_TRUTH_STATUS.HEALTHY);

  // ACTIVE_TRUTH UNKNOWN (no comparable SOURCE_ACTIVE) must not pull overall down.
  const activeForOverall = active.dimension.status === RUNTIME_TRUTH_STATUS.UNKNOWN
    ? null
    : active.dimension.status;
  const sourceDims = [
    connectivity.status,
    sourceAuth.status,
    sourceApi.status,
    freshness.status,
    activeForOverall,
    tlsStrictStatus === RUNTIME_TRUTH_STATUS.DEGRADED ? RUNTIME_TRUTH_STATUS.DEGRADED : null,
  ].filter(Boolean);

  // Sync HEALTHY alone must not win. Overall is worst of source-relevant dims,
  // with sync only able to worsen the result.
  let overall = worstStatus(sourceDims);
  if (syncProcess.status !== RUNTIME_TRUTH_STATUS.HEALTHY) {
    overall = worstStatus([overall, syncProcess.status]);
  }
  if (fraportTlsDegraded) overall = RUNTIME_TRUTH_STATUS.DEGRADED;

  // False-green gate: sync success + TLS failure => never HEALTHY
  if (syncHealthy && tlsStrictStatus === RUNTIME_TRUTH_STATUS.DEGRADED && overall === RUNTIME_TRUTH_STATUS.HEALTHY) {
    overall = RUNTIME_TRUTH_STATUS.DEGRADED;
  }

  // False-green gate: sync success + active mismatch => DEGRADED
  if (syncHealthy && active.dimension.status === RUNTIME_TRUTH_STATUS.DEGRADED) {
    overall = RUNTIME_TRUTH_STATUS.DEGRADED;
  }

  // False-green gate: sync success + silent/stale must not hide STALE
  if (syncHealthy && silent) {
    overall = RUNTIME_TRUTH_STATUS.STALE;
  }

  const recommendedAction = (fraportTlsDegraded || tlsCause)
    ? "Usar endpoint DNS compatível com *.fraport-brasil.local ou instalar/confiar a CA privada e usar hostname válido. Não usar verify_tls=false como solução definitiva."
    : silent
      ? "Nenhuma ação no worker: origem sem novos eventos no Zabbix."
      : active.dimension.status === RUNTIME_TRUTH_STATUS.DEGRADED
        ? "Investigar MISSING/EXTRA inexplicados entre origem e DB."
        : null;

  return {
    status: overall,
    badge: silent ? SILENT_BADGE : null,
    badge_label: silent ? SILENT_BADGE_LABEL : null,
    cause: tlsCause || (active.dimension.status === RUNTIME_TRUTH_STATUS.DEGRADED ? "ACTIVE_TRUTH_MISMATCH" : null),
    recommended_action: recommendedAction,
    detail: silent
      ? "Origem acessível e sincronizada; nenhum novo evento existe no Zabbix."
      : fraportTlsDegraded
        ? "Certificado *.fraport-brasil.local acessado por IP/hostname incompatível."
        : null,
    dimensions: {
      SYNC_PROCESS: syncProcess,
      SOURCE_CONNECTIVITY: connectivity,
      SOURCE_AUTH: sourceAuth,
      SOURCE_API: sourceApi,
      SOURCE_FRESHNESS: freshness,
      ACTIVE_TRUTH: active.dimension,
      TCP: dim(tcpStatus, { checkedAt, evidenceAt: probe?.checked_at || lastSuccessAt }),
      TLS_STRICT: dim(tlsStrictStatus, {
        checkedAt,
        evidenceAt: probe?.checked_at || lastSyncAt,
        cause: tlsCause,
      }),
      TLS_INSECURE: dim(tlsInsecureStatus, {
        checkedAt,
        evidenceAt: probe?.checked_at || lastSuccessAt,
      }),
      API: sourceApi,
      AUTH: sourceAuth,
    },
    last_successful_sync_at: isoOrNull(lastSuccessAt),
    last_db_event_at: isoOrNull(lastDbEventAt),
    last_source_event_at: isoOrNull(lastSourceEventAt || lastDbEventAt),
    source_db_lag_seconds: (() => {
      const sourceTs = Date.parse(String(lastSourceEventAt || ""));
      const dbTs = Date.parse(String(lastDbEventAt || ""));
      if (Number.isNaN(sourceTs) || Number.isNaN(dbTs)) return null;
      return Math.max(0, Math.round(Math.abs(dbTs - sourceTs) / 1000));
    })(),
    active_truth: active.metrics,
    checked_at: checkedAt,
  };
}

export function classifyCustomerIntegrity({
  activeClassifiableButUnclassified = 0,
  dbClassifiedHostButAlertUnclassified = 0,
  checkedAt = null,
} = {}) {
  const a = Math.max(0, Number(activeClassifiableButUnclassified) || 0);
  const b = Math.max(0, Number(dbClassifiedHostButAlertUnclassified) || 0);
  const degraded = a > 0 || b > 0;
  return {
    status: degraded ? RUNTIME_TRUTH_STATUS.DEGRADED : RUNTIME_TRUTH_STATUS.HEALTHY,
    metrics: {
      ACTIVE_CLASSIFIABLE_BUT_UNCLASSIFIED: a,
      DB_CLASSIFIED_HOST_BUT_ALERT_UNCLASSIFIED: b,
    },
    detail: degraded ? "Integridade de cliente fora da meta 0" : "Meta 0 atendida",
    checked_at: isoOrNull(checkedAt) || new Date().toISOString(),
  };
}

export function classifyHostRegistry({
  total = null,
  classified = null,
  sourceInsufficient = null,
  needsMapping = null,
  checkedAt = null,
} = {}) {
  const checked = isoOrNull(checkedAt) || new Date().toISOString();
  if (total == null && classified == null && needsMapping == null) {
    return {
      status: RUNTIME_TRUTH_STATUS.UNKNOWN,
      metrics: { TOTAL: null, CLASSIFIED: null, SOURCE_INSUFFICIENT: null, NEEDS_MAPPING: null },
      detail: "Sem telemetria de host registry",
      warning: null,
      checked_at: checked,
    };
  }
  const needs = Math.max(0, Number(needsMapping) || 0);
  const insufficient = Math.max(0, Number(sourceInsufficient) || 0);
  return {
    status: needs > 0 ? RUNTIME_TRUTH_STATUS.DEGRADED : RUNTIME_TRUTH_STATUS.HEALTHY,
    metrics: {
      TOTAL: total == null ? null : Number(total),
      CLASSIFIED: classified == null ? null : Number(classified),
      SOURCE_INSUFFICIENT: insufficient,
      NEEDS_MAPPING: needs,
    },
    detail: needs > 0 ? "NEEDS_MAPPING > 0" : "Host registry ok",
    warning: insufficient > 0
      ? "SOURCE_INSUFFICIENT conhecido/documentado — warning informativo; não inventar cliente"
      : null,
    checked_at: checked,
  };
}

export function classifyLinkHealth({
  total = null,
  customerMismatch = 0,
  nonLinkContamination = 0,
  carrierKnown = null,
  checkedAt = null,
} = {}) {
  const checked = isoOrNull(checkedAt) || new Date().toISOString();
  if (total == null) {
    return {
      status: RUNTIME_TRUTH_STATUS.UNKNOWN,
      metrics: { TOTAL_LINKS: null, CUSTOMER_MISMATCH: null, NON_LINK_CONTAMINATION: null },
      detail: "Sem inventário de links",
      warning: null,
      checked_at: checked,
    };
  }
  const mismatch = Math.max(0, Number(customerMismatch) || 0);
  const contamination = Math.max(0, Number(nonLinkContamination) || 0);
  const degraded = mismatch > 0 || contamination > 0;
  const carrierMissing = carrierKnown === 0 || carrierKnown === "0";
  return {
    status: degraded ? RUNTIME_TRUTH_STATUS.DEGRADED : RUNTIME_TRUTH_STATUS.HEALTHY,
    metrics: {
      TOTAL_LINKS: Number(total),
      CUSTOMER_MISMATCH: mismatch,
      NON_LINK_CONTAMINATION: contamination,
    },
    detail: degraded ? "Contaminação ou mismatch de cliente em links" : "Inventário de links ok",
    warning: carrierMissing ? "Carrier metadata unavailable in source" : null,
    checked_at: checked,
  };
}

export function classifyWriteReadiness({
  apiSupported = false,
  executorReady = false,
  executionEnabled = false,
  label = "write",
  waitingReason = "Aguardando SSO/permissão de escrita/canário autorizado.",
  checkedAt = null,
} = {}) {
  const checked = isoOrNull(checkedAt) || new Date().toISOString();
  if (!apiSupported || !executorReady) {
    return {
      status: RUNTIME_TRUTH_STATUS.CONFIG_MISSING,
      metrics: {
        ACK_API_SUPPORTED: apiSupported ? "YES" : "NO",
        ACK_EXECUTOR_READY: executorReady ? "YES" : "NO",
        ACK_EXECUTION_ENABLED: Boolean(executionEnabled),
      },
      detail: `${label}: executor/API não pronto`,
      recommended_action: waitingReason,
      checked_at: checked,
    };
  }
  if (!executionEnabled) {
    return {
      status: RUNTIME_TRUTH_STATUS.READY_DISABLED,
      metrics: {
        ACK_API_SUPPORTED: "YES",
        ACK_EXECUTOR_READY: "YES",
        ACK_EXECUTION_ENABLED: false,
      },
      detail: waitingReason,
      recommended_action: waitingReason,
      checked_at: checked,
    };
  }
  return {
    status: RUNTIME_TRUTH_STATUS.HEALTHY,
    metrics: {
      ACK_API_SUPPORTED: "YES",
      ACK_EXECUTOR_READY: "YES",
      ACK_EXECUTION_ENABLED: true,
    },
    detail: `${label}: execução habilitada`,
    recommended_action: null,
    checked_at: checked,
  };
}

export function classifyServiceNowWriteReadiness({
  executorReady = false,
  executionEnabled = false,
  checkedAt = null,
} = {}) {
  const checked = isoOrNull(checkedAt) || new Date().toISOString();
  if (!executorReady) {
    return {
      status: RUNTIME_TRUTH_STATUS.CONFIG_MISSING,
      detail: "ServiceNow write executor não pronto",
      recommended_action: "Aguardando SSO/permissão de escrita/canário autorizado.",
      checked_at: checked,
    };
  }
  if (!executionEnabled) {
    return {
      status: RUNTIME_TRUTH_STATUS.READY_DISABLED,
      detail: "Aguardando SSO/permissão de escrita/canário autorizado.",
      recommended_action: "Aguardando SSO/permissão de escrita/canário autorizado.",
      checked_at: checked,
    };
  }
  return {
    status: RUNTIME_TRUTH_STATUS.HEALTHY,
    detail: "ServiceNow write habilitado",
    recommended_action: null,
    checked_at: checked,
  };
}

/**
 * Theo/Webex runtime health.
 *
 * Legacy algorithm (do not restore): a single integration_outbox row for
 * theo_webex_notification (BFF/smoke created_by) plus classifyRuntimeHealth
 * with enabled forced to true and intervalSeconds=86400. That marked Theo
 * STALE/FAILED when operator reminders and auto-dispatch succeeded on other
 * action_types, and painted DISABLED as if the dispatcher were enabled.
 */
export const THEO_HEALTH_ACTION_TYPES = Object.freeze([
  "theo_webex_notification",
  "theo_alert_notification_v1",
  "theo_unseen_alert_notification_v1",
  "theo_operator_reminder_v1",
]);
export const THEO_DISPATCHER_HEARTBEAT_WORKER_ID = "theo_dispatcher";
export const THEO_HEARTBEAT_FRESH_MS = 3 * 60 * 1000;
export const THEO_HEARTBEAT_STALE_MS = 5 * 60 * 1000;
export const THEO_DISPATCH_RECENT_MS = 15 * 60 * 1000;
export const THEO_BACKLOG_OLD_MS = 10 * 60 * 1000;
export const THEO_TERMINAL_FAILURE_RECENT_MS = 15 * 60 * 1000;

export const THEO_SEMANTIC_STATUS = Object.freeze({
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  DISABLED: "DISABLED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN",
});

function sanitizeTheoError(value) {
  const raw = String(value || "").split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  if (!raw) return null;
  return raw
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bBearer\s+\S+/gi, "[token]")
    .replace(/\b(password|senha|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[db]")
    .slice(0, 140) || null;
}

function theoHeartbeatState(heartbeatAt, now, queryFailed) {
  if (queryFailed) return "unavailable";
  const age = ageMs(heartbeatAt, now);
  if (age == null) return "unavailable";
  if (age <= THEO_HEARTBEAT_FRESH_MS) return "fresh";
  if (age <= THEO_HEARTBEAT_STALE_MS) return "stale";
  return "severe";
}

function theoSemanticToRuntime(semantic) {
  if (semantic === THEO_SEMANTIC_STATUS.DISABLED) return RUNTIME_TRUTH_STATUS.READY_DISABLED;
  if (semantic === THEO_SEMANTIC_STATUS.FAILED) return RUNTIME_TRUTH_STATUS.DOWN;
  if (semantic === THEO_SEMANTIC_STATUS.UNKNOWN) return RUNTIME_TRUTH_STATUS.UNKNOWN;
  if (semantic === THEO_SEMANTIC_STATUS.DEGRADED) return RUNTIME_TRUTH_STATUS.DEGRADED;
  return RUNTIME_TRUTH_STATUS.HEALTHY;
}

function theoResult({
  semantic,
  heartbeat,
  detail,
  currentError = null,
  lastSuccessAt = null,
  lastFailedAt = null,
  lastSuccessActionType = null,
  pendingCount = 0,
  retryCount = 0,
  cause = null,
  configured = true,
} = {}) {
  return {
    semantic,
    status: semantic === "CONFIG_MISSING" ? RUNTIME_TRUTH_STATUS.CONFIG_MISSING : theoSemanticToRuntime(semantic),
    heartbeat,
    detail,
    current_error: sanitizeTheoError(currentError),
    last_success_at: isoOrNull(lastSuccessAt),
    last_error_at: isoOrNull(lastFailedAt),
    last_success_action_type: lastSuccessActionType || null,
    pending: Math.max(0, Number(pendingCount) || 0),
    retrying: Math.max(0, Number(retryCount) || 0),
    cause,
    configured,
  };
}

export function classifyTheoWebexHealth({
  automationEnabled = false,
  configured = true,
  heartbeatAt = null,
  lastSuccessAt = null,
  lastSuccessActionType = null,
  lastFailedAt = null,
  lastError = null,
  pendingCount = 0,
  retryCount = 0,
  oldestPendingAt = null,
  signalsQueryFailed = false,
  heartbeatQueryFailed = false,
  now = Date.now(),
} = {}) {
  const pending = Math.max(0, Number(pendingCount) || 0);
  const retrying = Math.max(0, Number(retryCount) || 0);
  const heartbeat = theoHeartbeatState(heartbeatAt, now, heartbeatQueryFailed);
  const successAge = ageMs(lastSuccessAt, now);
  const failAge = ageMs(lastFailedAt, now);
  const oldestPendingAge = ageMs(oldestPendingAt, now);
  const recentSuccess = successAge != null && successAge <= THEO_DISPATCH_RECENT_MS;
  const relevantTerminalFailure = failAge != null
    && failAge <= THEO_TERMINAL_FAILURE_RECENT_MS
    && (successAge == null || failAge < successAge);
  const inFlightPending = pending > 0 && retrying === 0 && oldestPendingAge != null && oldestPendingAge <= THEO_HEARTBEAT_FRESH_MS;
  const delayedPending = pending > 0 && oldestPendingAge != null && oldestPendingAge > THEO_HEARTBEAT_FRESH_MS;
  const staleBacklog = pending > 0 && oldestPendingAge != null && oldestPendingAge > THEO_BACKLOG_OLD_MS;
  const retryBacklog = pending > 0 && retrying > 0;
  const backlogIssue = retryBacklog || staleBacklog || delayedPending || (pending > 0 && !inFlightPending && oldestPendingAge == null);

  const base = {
    lastSuccessAt,
    lastFailedAt: relevantTerminalFailure ? lastFailedAt : null,
    lastSuccessActionType,
    pendingCount: pending,
    retryCount: retrying,
    configured,
  };

  if (!automationEnabled) {
    return theoResult({
      ...base,
      semantic: THEO_SEMANTIC_STATUS.DISABLED,
      heartbeat,
      detail: "Desativado",
      lastFailedAt: null,
    });
  }

  if (!configured) {
    return theoResult({
      ...base,
      semantic: "CONFIG_MISSING",
      heartbeat,
      detail: "Secrets server-side pendentes",
    });
  }

  if (signalsQueryFailed || heartbeatQueryFailed) {
    const telemetryDetail = recentSuccess
      ? "Dispatch Theo recente; problema de telemetria/heartbeat"
      : "Falha ao consultar health Theo; não afirmar indisponibilidade";
    return theoResult({
      ...base,
      semantic: THEO_SEMANTIC_STATUS.DEGRADED,
      heartbeat: heartbeatQueryFailed ? "unavailable" : heartbeat,
      detail: telemetryDetail,
      currentError: heartbeatQueryFailed ? "heartbeat_unavailable" : "database_unavailable",
      cause: "TELEMETRY",
    });
  }

  if (heartbeat === "fresh" && !backlogIssue && !relevantTerminalFailure) {
    return theoResult({
      ...base,
      semantic: THEO_SEMANTIC_STATUS.HEALTHY,
      heartbeat,
      detail: "Dispatcher operacional",
    });
  }

  if (heartbeat === "fresh" && (backlogIssue || relevantTerminalFailure)) {
    return theoResult({
      ...base,
      semantic: THEO_SEMANTIC_STATUS.DEGRADED,
      heartbeat,
      detail: relevantTerminalFailure
        ? "Falha terminal recente no dispatch Theo"
        : "Fila Theo com retry ou itens pendentes",
      currentError: relevantTerminalFailure ? lastError : null,
    });
  }

  if (recentSuccess && (heartbeat === "stale" || heartbeat === "severe" || heartbeat === "unavailable")) {
    return theoResult({
      ...base,
      semantic: THEO_SEMANTIC_STATUS.DEGRADED,
      heartbeat,
      detail: "Dispatch Theo recente; heartbeat/telemetria com problema",
      currentError: heartbeat === "unavailable" ? "heartbeat_unavailable" : null,
      cause: "TELEMETRY",
    });
  }

  if (heartbeat === "severe" && !recentSuccess) {
    return theoResult({
      ...base,
      semantic: THEO_SEMANTIC_STATUS.FAILED,
      heartbeat,
      detail: "Dispatcher sem heartbeat recente e sem dispatch Theo recente",
      currentError: lastError,
    });
  }

  if (heartbeat === "stale") {
    return theoResult({
      ...base,
      semantic: THEO_SEMANTIC_STATUS.DEGRADED,
      heartbeat,
      detail: backlogIssue || relevantTerminalFailure
        ? "Heartbeat atrasado e fila/erro Theo"
        : "Heartbeat do dispatcher atrasado",
      currentError: relevantTerminalFailure ? lastError : null,
    });
  }

  return theoResult({
    ...base,
    semantic: THEO_SEMANTIC_STATUS.UNKNOWN,
    heartbeat,
    detail: "Sem evidência suficiente de health Theo",
  });
}

/** Fraport probe evidence must be supplied by a current live probe, never replayed from a prior audit. */
export function fraportProbeForSource(sourceName, override = null) {
  const name = lower(sourceName);
  if (name === "fraport-for" || name === "fraport-poa") {
    return override && typeof override === "object" ? { ...override } : null;
  }
  return override;
}

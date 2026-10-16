/**
 * Operational alert queues.
 *
 * status_internal=new is the worker default for an open problem.
 * It never selects a queue by itself.
 *
 * Suppression is read only from persisted Zabbix evidence:
 * payload_normalized.suppressed + suppression_data, or the alert columns
 * when the payload key is absent. The browser does not invent a window.
 * Current suppression requires membership in the latest identified origin
 * snapshot (sync_logs.id + snapshot_mode/snapshot_complete), not fetched_count
 * heuristics and not age-from-now. Incomplete or failed snapshots keep flags.
 *
 * History keeps two evidence levels. Proven requires a non-zero
 * source_recovery_event_id. Legacy is status_source=resolved with
 * resolved_at and no recovery id. Age never classifies a row.
 *
 * This module only classifies the read model. It does not mutate suppression,
 * enqueue actions or change Theo/ServiceNow behavior.
 */

export const OPERATIONAL_QUEUE_VIEWS = Object.freeze([
  "pending",
  "acknowledged",
  "suppressed",
  "history",
  "unconfirmed",
]);

const PROVEN_RECOVERY_ID_SQL = `nullif(btrim(coalesce(a.source_recovery_event_id, '')), '') is not null
  and btrim(a.source_recovery_event_id) !~ '^0+$'`;

const PROVEN_RESOLVED_SQL = `(
  lower(coalesce(a.status_source, '')) = 'resolved'
  and a.resolved_at is not null
  and ${PROVEN_RECOVERY_ID_SQL}
)`;

const LEGACY_RESOLVED_SQL = `(
  lower(coalesce(a.status_source, '')) = 'resolved'
  and a.resolved_at is not null
  and not (${PROVEN_RECOVERY_ID_SQL})
)`;

const HISTORY_SQL = `(${PROVEN_RESOLVED_SQL} or ${LEGACY_RESOLVED_SQL})`;

const OPEN_PROBLEM_SQL = `(
  lower(coalesce(a.status_source, '')) in ('active', 'suppressed')
  and a.resolved_at is null
  and not (${PROVEN_RECOVERY_ID_SQL})
)`;

const SUPPRESSION_WINDOW_OPEN_SQL = `not (
  jsonb_typeof(a.payload_normalized->'suppression_data') = 'array'
  and jsonb_array_length(a.payload_normalized->'suppression_data') > 0
  and not exists (
    select 1
      from jsonb_array_elements(a.payload_normalized->'suppression_data') entry
     where coalesce(entry->>'suppress_until', '') in ('', '0')
        or (
          entry->>'suppress_until' ~ '^[0-9]+$'
          and (entry->>'suppress_until')::bigint > 0
          and to_timestamp((entry->>'suppress_until')::bigint) > now()
        )
  )
)`;

const SUPPRESSION_CONFIRMED_SQL = `lower(coalesce(a.payload_normalized->>'suppression_confirmation', '')) <> 'unconfirmed'`;

const EXPLICIT_UNCONFIRMED_SUPPRESSION_SQL = `(
  ${OPEN_PROBLEM_SQL}
  and lower(coalesce(a.payload_normalized->>'suppression_confirmation', '')) = 'unconfirmed'
)`;

const SUPPRESSION_FLAG_SQL = `(
  (
    lower(coalesce(a.payload_normalized->>'suppressed_source', a.payload_normalized->>'suppressed', '')) in ('true', '1')
    and ${SUPPRESSION_WINDOW_OPEN_SQL}
    and (
      coalesce(a.payload_normalized->>'suppress_until', '') = ''
      or (
        a.payload_normalized->>'suppress_until' ~ '^[0-9]{4}-'
        and (a.payload_normalized->>'suppress_until')::timestamptz > now()
      )
    )
  )
  or (
    coalesce(a.suppressed, false) = true
    and coalesce(a.payload_normalized->>'suppressed_source', a.payload_normalized->>'suppressed', '') = ''
    and coalesce(a.payload_normalized->>'suppression_confirmation', '') = ''
    and (a.suppressed_until is null or a.suppressed_until > now())
  )
)`;

/**
 * Latest automatic problem.get cycle for the datasource.
 * event_stream_fast is not a snapshot. Completeness comes from the Worker
 * payload: snapshot_complete=true, or legacy_limit below its own fetch limit.
 * An explicitly incomplete cycle makes the snapshot unavailable.
 */
export const ORIGIN_SNAPSHOT_JOIN_SQL = `left join (
  select distinct on (sl.data_source_id)
         sl.data_source_id,
         sl.id as origin_snapshot_id,
         sl.started_at as origin_snapshot_started_at,
         sl.finished_at as origin_snapshot_finished_at,
         sl.fetched_count as origin_snapshot_fetched,
         sl.payload->>'snapshot_mode' as origin_snapshot_mode,
         case
           when coalesce(sl.payload->>'snapshot_complete', '') in ('true', 't') then true
           when coalesce(sl.payload->>'snapshot_mode', '') = 'legacy_limit'
            and sl.fetched_count < coalesce(nullif(sl.payload->>'limit', '')::int, 1000)
           then true
           else false
         end as origin_snapshot_complete
    from sync_logs sl
   where lower(coalesce(sl.status, '')) in ('success', 'ok', 'partial_success')
     and coalesce(sl.sync_type, 'automatic') <> 'event_stream_fast'
   order by sl.data_source_id, coalesce(sl.finished_at, sl.started_at) desc
) origin_snap on origin_snap.data_source_id = d.id`;

const ORIGIN_SNAPSHOT_UNAVAILABLE_SQL = `(
  origin_snap.origin_snapshot_complete is not true
  or lower(coalesce(d.last_sync_status, '')) in ('failed', 'error')
)`;

const SEEN_IN_LATEST_ORIGIN_SNAPSHOT_SQL = `(
  origin_snap.origin_snapshot_complete is true
  and a.last_seen_at is not null
  and origin_snap.origin_snapshot_started_at is not null
  and a.last_seen_at >= origin_snap.origin_snapshot_started_at
)`;

const CURRENT_ORIGIN_SUPPRESSION_SQL = `(
  lower(coalesce(a.payload_normalized->>'origin_seen_in_complete_snapshot', '')) = 'true'
  or (
    coalesce(a.payload_normalized->>'origin_seen_in_complete_snapshot', '') = ''
    and (${ORIGIN_SNAPSHOT_UNAVAILABLE_SQL} or ${SEEN_IN_LATEST_ORIGIN_SNAPSHOT_SQL})
  )
)`;

const SUPPRESSION_ACTIVE_SQL = `(
  ${OPEN_PROBLEM_SQL}
  and ${SUPPRESSION_CONFIRMED_SQL}
  and ${SUPPRESSION_FLAG_SQL}
  and ${CURRENT_ORIGIN_SUPPRESSION_SQL}
)`;

const STALE_SUPPRESSION_SQL = `(
  ${OPEN_PROBLEM_SQL}
  and ${SUPPRESSION_CONFIRMED_SQL}
  and ${SUPPRESSION_FLAG_SQL}
  and lower(coalesce(a.payload_normalized->>'origin_seen_in_complete_snapshot', '')) <> 'true'
  and not (${ORIGIN_SNAPSHOT_UNAVAILABLE_SQL})
  and not (${SEEN_IN_LATEST_ORIGIN_SNAPSHOT_SQL})
)`;

const CLEAN_ACTIVE_SQL = `(
  lower(coalesce(a.status_source, '')) = 'active'
  and a.resolved_at is null
  and not (${PROVEN_RECOVERY_ID_SQL})
  and lower(coalesce(a.status_internal, '')) not in ('normalized', 'resolved', 'hidden')
  and not (${SUPPRESSION_ACTIVE_SQL})
  and not (${STALE_SUPPRESSION_SQL})
  and not (${EXPLICIT_UNCONFIRMED_SUPPRESSION_SQL})
  and not (
    lower(coalesce(a.payload_normalized->>'suppressed_source', a.payload_normalized->>'suppressed', '')) in ('false', '0')
    and coalesce(a.suppressed, false) = true
  )
)`;

const QUEUE_SQL = Object.freeze({
  pending: `(${CLEAN_ACTIVE_SQL} and coalesce(a.acknowledged_source, false) = false)`,
  acknowledged: `(${CLEAN_ACTIVE_SQL} and coalesce(a.acknowledged_source, false) = true)`,
  suppressed: SUPPRESSION_ACTIVE_SQL,
  history: HISTORY_SQL,
  unconfirmed: `(not ${HISTORY_SQL} and not ${CLEAN_ACTIVE_SQL} and not ${SUPPRESSION_ACTIVE_SQL})`,
});

export function operationalQueueSql(view) {
  const sql = QUEUE_SQL[view];
  if (!sql) throw new Error("invalid_operational_view");
  return sql;
}

export function isOperationalQueueView(value) {
  return OPERATIONAL_QUEUE_VIEWS.includes(String(value || "").trim().toLowerCase());
}

function text(value) {
  return String(value ?? "").trim();
}

function provenRecoveryId(value) {
  const id = text(value);
  return Boolean(id) && !/^0+$/.test(id);
}

function entries(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === "object");
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === "object") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function sourceId(value) {
  const id = text(value);
  if (!id || id === "0") return null;
  return id;
}

function untilMs(value) {
  if (!/^[0-9]+$/.test(text(value))) return null;
  const seconds = Number(text(value));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

function payloadFlag(alert) {
  const raw = alert?.payload_suppressed_source ?? alert?.payload_suppressed;
  if (raw === undefined || raw === null || text(raw) === "") return null;
  return ["true", "1"].includes(text(raw).toLowerCase());
}

function columnFlag(alert) {
  return alert?.suppressed === true || text(alert?.suppressed).toLowerCase() === "true";
}

function emptySuppression(state, evidence, confirmation = "unconfirmed", explicitUnconfirmed = false) {
  return {
    state,
    confirmation,
    explicit_unconfirmed: explicitUnconfirmed,
    origin: null,
    maintenance_id: null,
    user_id: null,
    started_at: null,
    suppress_until: null,
    suppress_until_kind: null,
    remaining_seconds: null,
    evidence,
  };
}

/**
 * Grounded suppression read model.
 * active: Zabbix still reports the problem suppressed and the window has not ended.
 * expired: the persisted window is in the past, so the open problem leaves Suprimidos.
 * none: the payload explicitly says suppressed=false and there is no past window.
 * unavailable: the payload key is missing, or the column and the payload disagree.
 */
export function describeSuppression(alert, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const flagged = payloadFlag(alert);
  const column = columnFlag(alert);
  const data = entries(alert?.payload_suppression_data);
  const maintenanceId = sourceId(alert?.payload_suppression_maintenance_id)
    || data.map((entry) => sourceId(entry.maintenanceid)).find(Boolean)
    || null;
  const userId = sourceId(alert?.payload_suppression_user_id)
    || data.map((entry) => sourceId(entry.userid)).find(Boolean)
    || null;
  const namedOrigin = text(alert?.payload_suppression_origin).toLowerCase();
  const origin = ["maintenance", "manual", "unspecified"].includes(namedOrigin)
    ? namedOrigin
    : (maintenanceId ? "maintenance" : userId ? "manual" : null);
  if (text(alert?.payload_suppression_confirmation).toLowerCase() === "unconfirmed") {
    return emptySuppression("unavailable", "unavailable", "unconfirmed", true);
  }
  const finite = data.map((entry) => untilMs(entry.suppress_until)).filter((value) => value != null);
  const openEnded = data.some((entry) => untilMs(entry.suppress_until) == null);
  const future = finite.filter((value) => value > nowMs);
  const allFinitePast = data.length > 0 && !openEnded && finite.length === data.length && future.length === 0;
  const evidence = flagged == null ? "column" : "problem_get";
  const explicitUntil = Date.parse(alert?.payload_suppress_until || "");
  const latestFinite = finite.length ? new Date(Math.max(...finite)).toISOString() : (Number.isFinite(explicitUntil) ? new Date(explicitUntil).toISOString() : null);
  const nextFuture = future.length
    ? new Date(Math.min(...future)).toISOString()
    : (Number.isFinite(explicitUntil) && explicitUntil > nowMs ? new Date(explicitUntil).toISOString() : null);
  const explicitPast = Number.isFinite(explicitUntil) && explicitUntil <= nowMs && future.length === 0;

  if (flagged === false && column) {
    return { ...emptySuppression("unavailable", "conflict", "unconfirmed"), maintenance_id: maintenanceId, user_id: userId };
  }
  if (flagged == null && !column) return emptySuppression("unavailable", "unavailable", "unconfirmed");
  if (flagged === false || explicitPast) {
    const expired = allFinitePast || explicitPast;
    return {
      state: expired ? "expired" : "none",
      confirmation: "confirmed",
      explicit_unconfirmed: false,
      origin: expired ? origin : null,
      maintenance_id: expired ? maintenanceId : null,
      user_id: expired ? userId : null,
      started_at: null,
      suppress_until: expired ? latestFinite : null,
      suppress_until_kind: expired ? "finite" : null,
      remaining_seconds: null,
      evidence: "problem_get",
    };
  }
  if (flagged === true && allFinitePast) {
    return {
      state: "expired",
      confirmation: "confirmed",
      explicit_unconfirmed: false,
      origin,
      maintenance_id: maintenanceId,
      user_id: userId,
      started_at: null,
      suppress_until: latestFinite,
      suppress_until_kind: "finite",
      remaining_seconds: null,
      evidence,
    };
  }
  const columnUntil = Date.parse(alert?.suppressed_until || "");
  if (flagged == null && column && Number.isFinite(columnUntil) && columnUntil <= nowMs) {
    return {
      state: "expired",
      confirmation: "confirmed",
      explicit_unconfirmed: false,
      origin: null,
      maintenance_id: null,
      user_id: null,
      started_at: null,
      suppress_until: new Date(columnUntil).toISOString(),
      suppress_until_kind: "finite",
      remaining_seconds: null,
      evidence: "column",
    };
  }
  const activeUntil = flagged === true
    ? nextFuture
    : (Number.isFinite(columnUntil) ? new Date(columnUntil).toISOString() : null);
  const untilMsValue = Date.parse(activeUntil || "");
  return {
    state: "active",
    confirmation: "confirmed",
    explicit_unconfirmed: false,
    origin: origin || "unspecified",
    maintenance_id: maintenanceId,
    user_id: userId,
    started_at: null,
    suppress_until: activeUntil,
    suppress_until_kind: text(alert?.payload_suppress_until_kind).toLowerCase()
      || (openEnded ? "indefinite" : activeUntil ? "finite" : "unknown"),
    remaining_seconds: Number.isFinite(untilMsValue) ? Math.max(0, Math.floor((untilMsValue - nowMs) / 1000)) : null,
    evidence,
  };
}

export function recoveryEvidenceOf(alert) {
  const source = text(alert?.status_source).toLowerCase();
  if (source !== "resolved" || !alert?.resolved_at) return null;
  return provenRecoveryId(alert?.source_recovery_event_id) ? "proven" : "legacy";
}

function openForSuppression(alert) {
  const source = text(alert?.status_source).toLowerCase();
  return (source === "active" || source === "suppressed")
    && !alert?.resolved_at
    && !provenRecoveryId(alert?.source_recovery_event_id);
}

function snapshotCompleteFlag(alert) {
  const raw = alert?.origin_snapshot_complete;
  if (raw === true || raw === false) return raw;
  const value = text(raw).toLowerCase();
  if (value === "true" || value === "t") return true;
  if (value === "false" || value === "f") return false;
  return null;
}

function originSnapshotUnavailable(alert) {
  const status = text(alert?.last_sync_status).toLowerCase();
  if (status === "failed" || status === "error") return true;
  if (snapshotCompleteFlag(alert) === false) return true;
  const started = clockMs(alert?.origin_snapshot_started_at);
  return !Number.isFinite(started);
}

function seenInLatestOriginSnapshot(alert) {
  if (text(alert?.payload_origin_seen_in_complete_snapshot).toLowerCase() === "true") return true;
  if (text(alert?.payload_origin_seen_in_complete_snapshot).toLowerCase() === "false") return false;
  const started = clockMs(alert?.origin_snapshot_started_at);
  const seen = clockMs(alert?.last_seen_at);
  if (!Number.isFinite(started) || !Number.isFinite(seen)) return null;
  return seen >= started;
}

export function classifyOperationalQueue(alert, now = Date.now()) {
  if (recoveryEvidenceOf(alert)) return "history";
  const suppression = describeSuppression(alert, now);
  if (openForSuppression(alert) && (
    suppression.evidence === "conflict"
    || (suppression.explicit_unconfirmed && text(alert?.payload_suppression_confirmation).toLowerCase() === "unconfirmed")
  )) {
    return "unconfirmed";
  }
  if (suppression.state === "active" && openForSuppression(alert)) {
    const seen = seenInLatestOriginSnapshot(alert);
    if (seen === false && !originSnapshotUnavailable(alert)) return "unconfirmed";
    return "suppressed";
  }
  const source = text(alert?.status_source).toLowerCase();
  const internal = text(alert?.status_internal).toLowerCase();
  const cleanActive = source === "active"
    && !alert?.resolved_at
    && !provenRecoveryId(alert?.source_recovery_event_id)
    && !["normalized", "resolved", "hidden"].includes(internal);
  if (!cleanActive) return "unconfirmed";
  return alert?.acknowledged_source ? "acknowledged" : "pending";
}

function clockMs(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined || value === "") return Number.NaN;
  return Date.parse(String(value));
}

/** Start of the current episode. A reopen replaces the original first_seen. Inverted clocks are unavailable. */
export function episodeStartMs(alert) {
  const first = clockMs(alert?.first_seen_at);
  const reopened = clockMs(alert?.last_reopened_at);
  if (Number.isFinite(reopened)) {
    if (!Number.isFinite(first) || reopened < first) return Number.NaN;
    return reopened;
  }
  return first;
}

function secondsBetweenMs(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 1000);
}

/** Proven recovery minus the current episode start. Null while the problem is open or the recovery is unverified. */
export function recoveryDurationSeconds(alert) {
  if (recoveryEvidenceOf(alert) !== "proven") return null;
  return secondsBetweenMs(episodeStartMs(alert), clockMs(alert?.resolved_at));
}

/**
 * First confirmed source ACK minus the current episode start.
 * The alerts.acknowledged_at column, aliased as acknowledged_source_at, is not proof:
 * an older sync rewrote it. Only alert_history.occurred_at for acknowledged/ack_message counts.
 */
export function timeToAckSeconds(alert) {
  if (!alert?.acknowledged_source && !alert?.source_ack?.acknowledged) return null;
  const historyMs = clockMs(alert?.ack_history_first_at);
  const sourceAckMs = alert?.source_ack?.history_available ? clockMs(alert?.source_ack?.first_ack_at) : Number.NaN;
  const ackMs = Number.isFinite(historyMs) ? historyMs : sourceAckMs;
  if (!Number.isFinite(ackMs)) return null;
  const alertEvent = String(alert?.source_event_id || "").trim();
  const ackEvent = String(alert?.ack_source_event_id || "").trim();
  if (alertEvent && ackEvent && alertEvent !== ackEvent) return null;
  return secondsBetweenMs(episodeStartMs(alert), ackMs);
}

/**
 * Origin sync signal. Unknown timestamps are not treated as a recovered queue.
 * A failed status or a success older than max(3 intervals, 15 min) is stale.
 */
export function describeDatasourceSync(row, now = Date.now()) {
  const status = text(row?.last_sync_status).toLowerCase();
  const failed = status === "failed" || status === "error";
  const success = Date.parse(row?.last_success_at || row?.last_sync_at || "");
  const snapshotStarted = Date.parse(row?.origin_snapshot_started_at || "");
  const snapshotFetched = Number(row?.origin_snapshot_fetched);
  const complete = snapshotCompleteFlag(row);
  const snapshot = {
    id: text(row?.origin_snapshot_id) || null,
    started_at: Number.isFinite(snapshotStarted) ? new Date(snapshotStarted).toISOString() : null,
    fetched: Number.isFinite(snapshotFetched) ? snapshotFetched : null,
    mode: text(row?.origin_snapshot_mode) || null,
    complete,
    available: complete === true,
  };
  if (!Number.isFinite(success)) {
    return { state: failed ? "failed" : "unknown", stale: failed, last_success_at: null, snapshot };
  }
  const intervalSeconds = Number(row?.sync_interval_seconds);
  const interval = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 300;
  const thresholdMs = Math.max(interval * 3, 15 * 60) * 1000;
  const stale = failed || now - success > thresholdMs;
  return {
    state: stale ? (failed ? "failed" : "stale") : "fresh",
    stale,
    last_success_at: new Date(success).toISOString(),
    snapshot,
  };
}

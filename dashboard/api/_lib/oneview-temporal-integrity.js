export const TEMPORAL_INTEGRITY_SOURCE_CLOCK_INCONSISTENT = "source_clock_inconsistent";
export const TEMPORAL_INTEGRITY_RECOVERY_UNVERIFIED = "source_recovery_unverified";

function milliseconds(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined || value === "") return Number.NaN;
  return Date.parse(String(value));
}

function recovered(alert) {
  const sourceStatus = String(alert?.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert?.status_internal || "").trim().toLowerCase();
  return Boolean(alert?.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

function acknowledged(alert) {
  return Boolean(alert?.acknowledged_source || alert?.acknowledged_internal || alert?.source_ack?.acknowledged);
}

function earliestFiniteMs(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? Math.min(...valid) : Number.NaN;
}

function acknowledgementFreezeMs(alert) {
  const values = [];
  if (alert?.acknowledged_source || alert?.source_ack?.acknowledged) {
    values.push(
      milliseconds(alert?.source_ack?.acknowledged_at),
      milliseconds(alert?.acknowledged_source_at),
      milliseconds(alert?.acknowledged_at),
    );
  }
  if (alert?.acknowledged_internal) {
    values.push(milliseconds(alert?.acknowledged_internal_at));
  }
  return earliestFiniteMs(values);
}

function durationFreezeMs(alert) {
  const values = [acknowledgementFreezeMs(alert)];
  if (recovered(alert)) values.push(milliseconds(alert?.resolved_at));
  return earliestFiniteMs(values);
}

function frozenDuration(firstSeenMs, freezeMs) {
  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(freezeMs) || freezeMs < firstSeenMs) {
    return Object.freeze({ duration_seconds: null, temporal_integrity: TEMPORAL_INTEGRITY_SOURCE_CLOCK_INCONSISTENT });
  }
  return Object.freeze({ duration_seconds: Math.floor((freezeMs - firstSeenMs) / 1000), temporal_integrity: null });
}

/** Derives safe display/metric duration from raw source times, without repairing them. */
export function deriveAlertTemporalIntegrity(alert, now = Date.now()) {
  const firstSeenMs = milliseconds(alert?.first_seen_at);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const freezeMs = durationFreezeMs(alert);
  const isRecovered = recovered(alert);
  const isAcknowledged = acknowledged(alert);

  if (isRecovered && !String(alert?.source_recovery_event_id || "").trim() && !Number.isFinite(acknowledgementFreezeMs(alert))) {
    return Object.freeze({ duration_seconds: null, temporal_integrity: TEMPORAL_INTEGRITY_RECOVERY_UNVERIFIED });
  }

  if (isRecovered || isAcknowledged) {
    return frozenDuration(firstSeenMs, freezeMs);
  }

  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(nowMs) || firstSeenMs > nowMs) {
    return Object.freeze({ duration_seconds: null, temporal_integrity: TEMPORAL_INTEGRITY_SOURCE_CLOCK_INCONSISTENT });
  }
  return Object.freeze({ duration_seconds: Math.floor((nowMs - firstSeenMs) / 1000), temporal_integrity: null });
}

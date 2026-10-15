import { fetchApi } from "@/lib/oneview-api";

export type SuppressAccepted = {
  status: "accepted" | "confirmed";
  ui_state: string;
  origin_confirmed: boolean;
  outbox_id: string | null;
  idempotent?: boolean;
  reason?: string | null;
  error?: string;
};

export type SuppressStatus = {
  ui_state: string;
  origin_confirmed: boolean;
  outbox_status: string | null;
  reason: string | null;
  periods: Array<Record<string, unknown>>;
  period_count: number;
  unsuppress: {
    enabled: boolean;
    reason: string | null;
    expected_suppress_until?: number | null;
    expected_userid?: string | null;
  };
};

function alertPath(alertId: string, suffix: string) {
  return `/oneview/alerts/${encodeURIComponent(alertId)}/${suffix}`;
}

export function probeSuppressAccess(alertId: string) {
  return fetchApi<{ actor_suppress_access: boolean | "unknown"; reason: string | null; pending: boolean; ui_state?: string }>(
    alertPath(alertId, "suppress-access"),
    { method: "POST" },
  );
}

export function requestSuppress(alertId: string, body: {
  source_event_id: string;
  reason: string;
  duration_seconds: number;
  indefinite_confirmed: boolean;
}, idempotencyKey: string) {
  return fetchApi<SuppressAccepted>(alertPath(alertId, "suppress"), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function requestUnsuppress(alertId: string, body: {
  source_event_id: string;
  expected_suppress_until: number;
  expected_userid: string;
}, idempotencyKey: string) {
  return fetchApi<SuppressAccepted>(alertPath(alertId, "unsuppress"), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function fetchSuppressStatus(alertId: string, outboxId?: string | null) {
  const query = outboxId ? `?outbox_id=${encodeURIComponent(outboxId)}` : "";
  return fetchApi<SuppressStatus>(`${alertPath(alertId, "suppress-status")}${query}`);
}

import { loginRequest, msalInstance, isSsoEnvironmentReady } from "@/lib/auth/msal";
import { serverAuthEnabled } from "@/lib/server-auth";

async function suppressHeaders(): Promise<Record<string, string>> {
  if (serverAuthEnabled()) return {};
  if (import.meta.env.VITE_ONEVIEW_API_AUTH_DISABLED === "true") return {};
  if (!msalInstance || !isSsoEnvironmentReady) return {};
  const account = msalInstance.getActiveAccount();
  if (!account) return {};
  try {
    const result = await msalInstance.acquireTokenSilent({ ...loginRequest, account });
    const token = result.idToken || result.accessToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function suppressFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(await suppressHeaders()),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body.error === "string" ? body.error : "request_failed";
    const error = new Error(code);
    (error as Error & { code?: string }).code = code;
    throw error;
  }
  return body as T;
}

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
  return suppressFetch<{ actor_suppress_access: boolean | "unknown"; reason: string | null; pending: boolean; ui_state?: string }>(
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
  return suppressFetch<SuppressAccepted>(alertPath(alertId, "suppress"), {
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
  return suppressFetch<SuppressAccepted>(alertPath(alertId, "unsuppress"), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function fetchSuppressStatus(alertId: string, outboxId?: string | null) {
  const query = outboxId ? `?outbox_id=${encodeURIComponent(outboxId)}` : "";
  return suppressFetch<SuppressStatus>(`${alertPath(alertId, "suppress-status")}${query}`);
}

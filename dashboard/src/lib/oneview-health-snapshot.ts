import type {
  RuntimeHealthComponent,
  RuntimeHealthResponse,
  RuntimeHealthStatus,
} from "@/lib/oneview-api";

export const RUNTIME_HEALTH_SNAPSHOT_KEY = "oneview:runtime-health-snapshot:v1";

type CompactHealthComponent = {
  id: string;
  name: string;
  category: RuntimeHealthComponent["category"];
  status: RuntimeHealthStatus;
  last_success_at: string | null;
  duration_ms?: number | null;
  badge?: string | null;
  badge_label?: string | null;
  cause?: string | null;
  current_error?: string | null;
  metrics?: Record<string, unknown> | null;
};

type CompactHealthSnapshot = {
  overall_status: RuntimeHealthStatus;
  generated_at: string;
  captured_at: string;
  components: CompactHealthComponent[];
};

function compactMetrics(metrics: Record<string, unknown> | null | undefined) {
  if (!metrics || typeof metrics !== "object") return null;
  const pending = metrics.pending;
  const heartbeat = metrics.heartbeat;
  if (pending == null && heartbeat == null) return null;
  return {
    ...(pending != null ? { pending } : {}),
    ...(heartbeat != null ? { heartbeat } : {}),
  };
}

export function compactRuntimeHealthSnapshot(
  health: RuntimeHealthResponse,
  now = Date.now(),
): CompactHealthSnapshot {
  return {
    overall_status: health.overall_status,
    generated_at: health.generated_at,
    captured_at: new Date(now).toISOString(),
    components: (health.components ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      status: item.status,
      last_success_at: item.last_success_at ?? null,
      duration_ms: item.duration_ms ?? null,
      badge: item.badge ?? null,
      badge_label: item.badge_label ?? null,
      cause: item.cause ?? null,
      current_error: item.current_error ?? null,
      metrics: compactMetrics(item.metrics),
    })),
  };
}

function hydrateComponent(item: CompactHealthComponent): RuntimeHealthComponent {
  return {
    id: item.id,
    category: item.category,
    name: item.name,
    enabled: true,
    status: item.status,
    connectivity: "",
    auth: "",
    freshness: null,
    last_success_at: item.last_success_at ?? null,
    last_observed_at: null,
    last_error_at: null,
    interval_seconds: null,
    duration_ms: item.duration_ms ?? null,
    hostname: null,
    version: null,
    failure_count: 0,
    current_error: item.current_error ?? null,
    last_historical_error: null,
    detail: null,
    badge: item.badge,
    badge_label: item.badge_label,
    cause: item.cause,
    metrics: item.metrics ?? null,
  };
}

export function parseRuntimeHealthSnapshot(raw: string | null | undefined): RuntimeHealthResponse | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CompactHealthSnapshot;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.components)) return null;
    if (!parsed.overall_status || !parsed.generated_at) return null;
    return {
      overall_status: parsed.overall_status,
      generated_at: parsed.generated_at,
      checked_at: parsed.captured_at || parsed.generated_at,
      components: parsed.components.map(hydrateComponent),
    };
  } catch {
    return null;
  }
}

export function readRuntimeHealthSnapshot(): RuntimeHealthResponse | null {
  if (typeof window === "undefined") return null;
  try {
    return parseRuntimeHealthSnapshot(window.sessionStorage.getItem(RUNTIME_HEALTH_SNAPSHOT_KEY));
  } catch {
    return null;
  }
}

export function writeRuntimeHealthSnapshot(health: RuntimeHealthResponse, now = Date.now()) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      RUNTIME_HEALTH_SNAPSHOT_KEY,
      JSON.stringify(compactRuntimeHealthSnapshot(health, now)),
    );
  } catch {
    // sessionStorage is best-effort; a quota or private-mode failure must not break the strip.
  }
}

export function clearRuntimeHealthSnapshot() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RUNTIME_HEALTH_SNAPSHOT_KEY);
  } catch {
    // ignore
  }
}

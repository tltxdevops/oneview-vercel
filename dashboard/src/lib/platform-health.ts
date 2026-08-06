import type {
  DataSource,
  OneViewHealthResponse,
  OneViewSyncLog,
  OperationsHealthResponse,
  OperationalStatus,
} from "@/lib/oneview-api";

export const TELETEX_DATASOURCE_NAME = "teletex-http";
export const DEFAULT_SYNC_INTERVAL_SECONDS = 300;

export type HealthLevel = "ok" | "warn" | "down" | "unknown";

export type PlatformHealthItem = {
  key: "database" | "worker" | "teletex";
  name: string;
  level: HealthLevel;
  technicalName?: string;
  tooltipLines: string[];
  lastSuccessAt?: string | null;
};

export type PlatformHealthSnapshot = {
  items: PlatformHealthItem[];
  lastSyncAt: string | null;
};

export function statusLabel(level: HealthLevel) {
  if (level === "ok") return "Saudável";
  if (level === "warn") return "Atenção";
  if (level === "down") return "Crítico";
  return "Sem informação";
}

export function dotClass(level: HealthLevel) {
  if (level === "ok") return "bg-emerald-500";
  if (level === "warn") return "bg-amber-400";
  if (level === "down") return "bg-red-500";
  return "bg-muted-foreground/50";
}

export function findTeletexSource<T extends { name?: string | null }>(items: T[] | null | undefined): T | null {
  return (items ?? []).find((item) => String(item.name || "").toLowerCase() === TELETEX_DATASOURCE_NAME) ?? null;
}

export function resolveSyncIntervalSeconds(...candidates: Array<number | null | undefined>) {
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_SYNC_INTERVAL_SECONDS;
}

export function sanitizeOperationalError(value?: string | null) {
  if (!value) return null;
  let text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  text = text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bBearer\s+\S+/gi, "[token]")
    .replace(/\b(password|senha|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[db]")
    .slice(0, 180);
  return text || null;
}

export function formatPtBrDateTime(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("pt-BR");
}

export function formatRelativePtBr(value?: string | null, now = Date.now()) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes === 1) return "há 1 minuto";
  if (minutes < 60) return `há ${minutes} minutos`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "há 1 hora";
  if (hours < 48) return `há ${hours} horas`;
  const days = Math.round(hours / 24);
  return days === 1 ? "há 1 dia" : `há ${days} dias`;
}

export function estimatedMissedCycles(lastSuccessAt: string | null | undefined, intervalSeconds: number, now = Date.now()) {
  const lastMs = Date.parse(String(lastSuccessAt || ""));
  if (!lastSuccessAt || Number.isNaN(lastMs)) return null;
  const intervalMs = Math.max(1, intervalSeconds) * 1000;
  return Math.floor(Math.max(0, now - lastMs) / intervalMs);
}

/**
 * Worker / Teletex cadence rules (OV-P0-38):
 * - green: last success < 1.5 intervals AND failure_count = 0
 * - yellow: last success in [1.5, 3) intervals OR failure_count 1–2
 * - red: last success ≥ 3 intervals OR failure_count ≥ 3 OR explicit critical error
 * - gray: no last success / incomplete contract
 * With interval=300s: green <7m30s, yellow 7m30s–<15m, red ≥15m.
 * Failure or absence never becomes green.
 */
export function syncAgeRatio(
  lastSuccessAt: string | null | undefined,
  intervalSeconds: number,
  now = Date.now(),
): number | null {
  const lastMs = Date.parse(String(lastSuccessAt || ""));
  if (!lastSuccessAt || Number.isNaN(lastMs)) return null;
  const intervalMs = Math.max(1, intervalSeconds) * 1000;
  return Math.max(0, now - lastMs) / intervalMs;
}

export function levelFromSyncCadence(params: {
  lastSuccessAt?: string | null;
  failureCount?: number | null;
  intervalSeconds: number;
  operationalStatus?: OperationalStatus | string | null;
  now?: number;
}): HealthLevel {
  const status = String(params.operationalStatus || "").toLowerCase();
  if (status === "error") return "down";

  const ratio = syncAgeRatio(params.lastSuccessAt, params.intervalSeconds, params.now ?? Date.now());
  if (ratio == null) return "unknown";

  const hasFailureCount = Number.isFinite(params.failureCount);
  const failures = hasFailureCount ? Math.max(0, Number(params.failureCount)) : 0;

  if (ratio >= 3 || (hasFailureCount && failures >= 3)) return "down";
  if ((ratio >= 1.5 && ratio < 3) || (hasFailureCount && failures >= 1 && failures <= 2)) return "warn";
  // Verde: menos de 1,5 intervalo sem sucesso e sem falhas (ausência de failure_count no worker não bloqueia).
  if (ratio < 1.5 && (!hasFailureCount || failures === 0)) return "ok";
  return "unknown";
}

/** Motivo operacional da cor Worker/Teletex (OV-P0-38). */
export function syncCadenceReason(params: {
  level: HealthLevel;
  lastSuccessAt?: string | null;
  failureCount?: number | null;
  intervalSeconds: number;
  operationalStatus?: OperationalStatus | string | null;
  now?: number;
}): string {
  const status = String(params.operationalStatus || "").toLowerCase();
  if (params.level === "unknown" || !params.lastSuccessAt) {
    return "Motivo: sem last_success_at ou contrato insuficiente";
  }
  if (status === "error") {
    return "Motivo: erro crítico na origem";
  }

  const hasFailureCount = Number.isFinite(params.failureCount);
  const failures = hasFailureCount ? Math.max(0, Number(params.failureCount)) : 0;
  const ratio = syncAgeRatio(params.lastSuccessAt, params.intervalSeconds, params.now ?? Date.now()) ?? 0;
  const cycles = estimatedMissedCycles(params.lastSuccessAt, params.intervalSeconds, params.now ?? Date.now()) ?? 0;

  if (hasFailureCount && failures >= 3) {
    return `Motivo: failure_count ${failures} (≥ 3)`;
  }
  if (ratio >= 3) {
    return `Motivo: atraso de ${cycles} ciclos (≥ 3 intervalos)`;
  }
  if (hasFailureCount && failures >= 1 && failures <= 2) {
    return `Motivo: failure_count ${failures} (1–2)`;
  }
  if (ratio >= 1.5 && ratio < 3) {
    return `Motivo: atraso entre 1,5 e 3 intervalos (${cycles} ciclos estimados)`;
  }
  if (params.level === "ok") {
    return "Motivo: último sucesso dentro de 1,5 intervalo e sem falhas";
  }
  return `Motivo: ${statusLabel(params.level)}`;
}

export function levelFromDatabase(health: OneViewHealthResponse | null): HealthLevel {
  if (!health) return "unknown";
  if (health.database_reachable === true) return "ok";
  if (health.database_reachable === false) return "down";
  return "unknown";
}

function isTeletexSyncLog(log: OneViewSyncLog) {
  const source = `${log.datasource || ""} ${log.data_source_id || ""}`.toLowerCase();
  return source.includes("teletex");
}

export function latestTeletexSyncError(logs: OneViewSyncLog[]) {
  const sorted = [...logs]
    .filter(isTeletexSyncLog)
    .sort((left, right) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""));
  for (const log of sorted) {
    const status = String(log.status || "").toLowerCase();
    if (status === "success" || status === "ok") continue;
    return sanitizeOperationalError(log.detail);
  }
  return null;
}

export function buildPlatformHealthSnapshot(params: {
  health: OneViewHealthResponse | null;
  operations: OperationsHealthResponse | null;
  dataSources: DataSource[] | null;
  syncLogs?: OneViewSyncLog[];
  now?: number;
}): PlatformHealthSnapshot {
  const now = params.now ?? Date.now();
  const teletexOps = findTeletexSource(params.operations?.items);
  const teletexDs = findTeletexSource(params.dataSources);
  const intervalSeconds = resolveSyncIntervalSeconds(
    teletexOps?.sync_interval_seconds,
    teletexDs?.sync_interval_seconds,
  );
  const failureCount = teletexOps?.failure_count ?? teletexDs?.failure_count ?? null;
  const teletexLastSuccess = teletexOps?.last_success_at || teletexDs?.last_success_at || null;
  const workerLastSuccess = params.operations?.worker?.last_activity_at || null;
  const syncLogAt = (params.syncLogs ?? []).find((log) => log.created_at)?.created_at ?? null;
  const lastSyncAt = teletexLastSuccess || teletexDs?.last_sync_at || workerLastSuccess || syncLogAt || null;
  const syncError = sanitizeOperationalError(teletexDs?.last_error || teletexDs?.last_sync_error)
    || latestTeletexSyncError(params.syncLogs ?? []);

  const databaseLevel = levelFromDatabase(params.health);
  const workerLevel = levelFromSyncCadence({
    lastSuccessAt: workerLastSuccess,
    failureCount: null,
    intervalSeconds,
    now,
  });

  const teletexLevel = levelFromSyncCadence({
    lastSuccessAt: teletexLastSuccess,
    failureCount,
    intervalSeconds,
    operationalStatus: teletexOps?.operational_status,
    now,
  });

  const workerCycles = estimatedMissedCycles(workerLastSuccess, intervalSeconds, now);
  const teletexCycles = estimatedMissedCycles(teletexLastSuccess, intervalSeconds, now);
  const responseTimeMs = Number((params.health as { response_time_ms?: number } | null)?.response_time_ms);
  const workerReason = syncCadenceReason({
    level: workerLevel,
    lastSuccessAt: workerLastSuccess,
    failureCount: null,
    intervalSeconds,
    now,
  });
  const teletexReason = syncCadenceReason({
    level: teletexLevel,
    lastSuccessAt: teletexLastSuccess,
    failureCount,
    intervalSeconds,
    operationalStatus: teletexOps?.operational_status,
    now,
  });

  return {
    lastSyncAt,
    items: [
      {
        key: "database",
        name: "Banco",
        level: databaseLevel,
        tooltipLines: [
          `Banco — ${statusLabel(databaseLevel)}`,
          params.health?.checked_at
            ? `Última verificação: ${formatPtBrDateTime(params.health.checked_at)}`
            : "Última verificação: Sem informação",
          Number.isFinite(responseTimeMs) ? `Tempo de resposta: ${Math.round(responseTimeMs)} ms` : null,
        ].filter(Boolean) as string[],
      },
      {
        key: "worker",
        name: "Worker",
        level: workerLevel,
        lastSuccessAt: workerLastSuccess,
        tooltipLines: [
          `Estado: ${statusLabel(workerLevel)}`,
          workerLastSuccess
            ? `Último sync: ${formatPtBrDateTime(workerLastSuccess)}`
            : "Último sync: Sem informação",
          formatRelativePtBr(workerLastSuccess, now) ? `Tempo relativo: ${formatRelativePtBr(workerLastSuccess, now)}` : null,
          `Intervalo esperado: ${intervalSeconds}s`,
          workerCycles != null ? `Ciclos estimados sem sucesso: ${workerCycles}` : "Ciclos estimados sem sucesso: Sem informação",
          "failure_count: Sem informação",
          workerReason,
          syncError ? `Último erro: ${syncError}` : null,
        ].filter(Boolean) as string[],
      },
      {
        key: "teletex",
        name: "Teletex",
        technicalName: TELETEX_DATASOURCE_NAME,
        level: teletexLevel,
        lastSuccessAt: teletexLastSuccess,
        tooltipLines: [
          "Fonte Teletex",
          `Nome técnico: ${TELETEX_DATASOURCE_NAME}`,
          `Estado: ${statusLabel(teletexLevel)}`,
          teletexLastSuccess
            ? `Último sync: ${formatPtBrDateTime(teletexLastSuccess)}`
            : "Último sync: Sem informação",
          formatRelativePtBr(teletexLastSuccess, now) ? `Tempo relativo: ${formatRelativePtBr(teletexLastSuccess, now)}` : null,
          `Intervalo esperado: ${intervalSeconds}s`,
          teletexCycles != null ? `Ciclos estimados sem sucesso: ${teletexCycles}` : "Ciclos estimados sem sucesso: Sem informação",
          `failure_count: ${failureCount == null ? "Sem informação" : failureCount}`,
          teletexReason,
          syncError ? `Último erro: ${syncError}` : null,
        ].filter(Boolean) as string[],
      },
    ],
  };
}

export function buildPlatformHealthItems(params: {
  health: OneViewHealthResponse | null;
  operations: OperationsHealthResponse | null;
  dataSources: DataSource[] | null;
  syncLogs?: OneViewSyncLog[];
  now?: number;
}): PlatformHealthItem[] {
  return buildPlatformHealthSnapshot(params).items;
}

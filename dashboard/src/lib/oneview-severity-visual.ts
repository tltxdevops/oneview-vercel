/**
 * OV-P0-77 — Fonte única de verdade visual para severidade (badge).
 * Labels oficiais vêm de ONEVIEW_SEVERITY_CATALOG; cores não duplicam catálogo de dados.
 */
import {
  ONEVIEW_SEVERITY_CATALOG,
  formatOneViewSeverityLabel,
  normalizeOneViewSeverity,
  type OneViewSeverity,
} from "@/lib/oneview-api";

/**
 * Tokens de badge (light + dark) — OV-P0-77 / OV-P0-78.
 * Information=sky · Warning=yellow · Average=amber · High=vermelho claro · Disaster=vermelho forte.
 * High e Disaster NÃO compartilham o mesmo tom.
 */
export const ONEVIEW_SEVERITY_TONE: Record<OneViewSeverity, string> = {
  information:
    "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-400/40 dark:bg-sky-950/30 dark:text-sky-200",
  warning:
    "border-yellow-300 bg-yellow-50 text-yellow-800 dark:border-yellow-400/40 dark:bg-yellow-950/30 dark:text-yellow-100",
  average:
    "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-400/50 dark:bg-amber-950/35 dark:text-amber-100",
  high:
    "border-red-300 bg-red-50 text-red-700 font-semibold dark:border-red-400/45 dark:bg-red-950/35 dark:text-red-200",
  disaster:
    "border-red-800 bg-red-200 text-red-950 font-semibold dark:border-red-500 dark:bg-red-950/80 dark:text-red-50",
  /** OV-P0-102 — critical legado usa o mesmo tom visual de High. */
  critical:
    "border-red-300 bg-red-50 text-red-700 font-semibold dark:border-red-400/45 dark:bg-red-950/35 dark:text-red-200",
  not_classified:
    "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-500/40 dark:bg-slate-900/50 dark:text-slate-200",
};

/** Atalhos de filtro (Alertas) — não são labels oficiais. */
export const ONEVIEW_SEVERITY_SHORT: Record<OneViewSeverity, string> = {
  disaster: "P1",
  /** Família High (OV-P0-102) — sem chip Critical. */
  critical: "P2",
  high: "P2",
  average: "P3",
  warning: "P4",
  information: "P5",
  not_classified: "N/C",
};

export type SeverityUiEntry = {
  label: string;
  short: string;
  tone: string;
};

/** Metadados de UI compostos a partir do catálogo de dados + tokens visuais. */
export function severityUiEntry(severity: OneViewSeverity): SeverityUiEntry {
  // OV-P0-102: critical legado apresenta-se como High (sem chip próprio).
  if (severity === "critical") {
    return {
      label: "High",
      short: ONEVIEW_SEVERITY_SHORT.high,
      tone: ONEVIEW_SEVERITY_TONE.high,
    };
  }
  return {
    label: ONEVIEW_SEVERITY_CATALOG[severity].label,
    short: ONEVIEW_SEVERITY_SHORT[severity],
    tone: ONEVIEW_SEVERITY_TONE[severity],
  };
}

/** Catálogo de UI completo (um registro por severidade canônica). */
export const ONEVIEW_SEVERITY_UI: Record<OneViewSeverity, SeverityUiEntry> = {
  disaster: severityUiEntry("disaster"),
  critical: severityUiEntry("critical"),
  high: severityUiEntry("high"),
  average: severityUiEntry("average"),
  warning: severityUiEntry("warning"),
  information: severityUiEntry("information"),
  not_classified: severityUiEntry("not_classified"),
};

/** Classes Tailwind do badge para qualquer valor bruto de severidade. */
export function severityTone(value?: string | number | null): string {
  const normalized = normalizeOneViewSeverity(value == null ? null : String(value));
  // OV-P0-102: critical legado → tom High.
  return ONEVIEW_SEVERITY_TONE[normalized === "critical" ? "high" : normalized];
}

export { formatOneViewSeverityLabel, normalizeOneViewSeverity };

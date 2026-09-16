export const ONEVIEW_OPERATIONAL_UI_V1_1 = {
  name: "OneView Operational UI v1.1",
  status: "frozen",
  statement: "ONEVIEW OPERATIONAL UI v1.1 IS FROZEN",
  adoption: [
    "Reutilizar token oficial.",
    "Reutilizar componente oficial.",
    "Reutilizar Pattern oficial.",
  ],
  extensionPolicy: "Se não existir solução, atualizar primeiro /ui-kit e depois consumir na página.",
  legacyPolicy: "Legacy permanece somente por compatibilidade e não deve ser usado em código novo.",
} as const;

/** @deprecated Use ONEVIEW_OPERATIONAL_UI_V1_1. */
export const ONEVIEW_OPERATIONAL_UI_V1 = ONEVIEW_OPERATIONAL_UI_V1_1;

export const ONEVIEW_COLOR_TOKENS = [
  ["background", "--ov-color-background"],
  ["surface", "--ov-color-surface"],
  ["surface-muted", "--ov-color-surface-muted"],
  ["border", "--ov-color-border"],
  ["text-primary", "--ov-color-text-primary"],
  ["text-secondary", "--ov-color-text-secondary"],
  ["text-muted", "--ov-color-text-muted"],
  ["primary", "--ov-color-primary"],
  ["accent-blue", "--ov-color-accent-blue"],
  ["success", "--ov-color-success"],
  ["warning", "--ov-color-warning"],
  ["danger", "--ov-color-danger"],
  ["info", "--ov-color-info"],
  ["neutral", "--ov-color-neutral"],
  ["recurrence", "--ov-color-recurrence"],
] as const;

export const ONEVIEW_RADIUS_DECISIONS = [
  { name: "CONTROL_RADIUS", value: "8px", variable: "--ov-radius-control", use: "Button, input, select, search, tabs e pequenos controles" },
  { name: "SURFACE_RADIUS", value: "12px", variable: "--ov-radius-surface", use: "Panel, card, KPI, tabela, modal e seções de drawer" },
  { name: "PILL_RADIUS", value: "999px", variable: "--ov-radius-pill", use: "Exclusivo para badge, status, severity e filter chip" },
] as const;

export const ONEVIEW_SPACING_TOKENS = [
  { pixels: 4, variable: "--ov-space-4", use: "Micro gap: ícone/texto e interior de badge" },
  { pixels: 8, variable: "--ov-space-8", use: "Controles relacionados" },
  { pixels: 12, variable: "--ov-space-12", use: "Padding compacto, tabela e pequenos grupos" },
  { pixels: 16, variable: "--ov-space-16", use: "Padding padrão de componente" },
  { pixels: 24, variable: "--ov-space-24", use: "Seções relacionadas" },
  { pixels: 32, variable: "--ov-space-32", use: "Separação estrutural de página" },
] as const;

export const ONEVIEW_CONTROL_HEIGHTS = [
  { name: "CONTROL_COMPACT", value: "32px", variable: "--ov-control-height-compact", use: "Padrão operacional quando o pattern exigir alta densidade" },
  { name: "CONTROL_DEFAULT", value: "36px", variable: "--ov-control-height-default", use: "Forms, Settings e contexto padrão" },
] as const;

export const ONEVIEW_ICON_RULES = [
  { size: "16px", use: "Ícone inline" },
  { size: "18px", use: "Controles" },
  { size: "20px", use: "Navegação" },
  { size: "24px", use: "Ação principal" },
] as const;

export const ONEVIEW_TYPOGRAPHY_TOKENS = [
  { name: "PAGE TITLE", className: "ov-type-page-title", specification: "JetBrains Mono · 20px / 600" },
  { name: "SECTION TITLE", className: "ov-type-section-title", specification: "JetBrains Mono · 16px / 600" },
  { name: "BODY", className: "ov-type-body", specification: "Lato · 14px / 400" },
  { name: "SECONDARY", className: "ov-type-secondary", specification: "Lato · 13px / 400" },
  { name: "CAPTION", className: "ov-type-caption", specification: "Lato · 12px / 400" },
  { name: "METRIC", className: "ov-type-metric", specification: "JetBrains Mono · 24px / 700" },
] as const;

export const ONEVIEW_BUTTON_VARIANTS = ["Primary", "Secondary", "Ghost", "Danger"] as const;

export const ONEVIEW_ACTION_COLORS = {
  Primary: "black",
  Secondary: "neutral surface",
  Ghost: "transparent",
  Danger: "red",
} as const;

export const ONEVIEW_TABLE_RULE = {
  headerHeight: "40px",
  rowHeight: "48px",
  horizontalPadding: "16px",
  verticalAlignment: "center",
  border: "neutral bottom border",
  hover: "surface-muted discreto",
} as const;

export const ONEVIEW_LAYOUT_RULES = {
  operational: "Full-width com padding lateral consistente",
  documentation: "Max-width controlado para leitura",
  form: "Max-width menor quando o conteúdo não exige largura operacional",
} as const;

export const ONEVIEW_DESIGN_RULES = [
  "Neutral surface first.",
  "Black is primary action.",
  "Accent blue is brand, navigation and selection — never a fifth action color.",
  "Color communicates state, not decoration.",
  "Controls use 8px radius.",
  "Surfaces use 12px radius.",
  "Pills exist only for metadata, status or filter.",
  "No decorative gradients.",
  "No card shadows.",
  "One control height per context.",
  "Use an official Pattern before creating layout.",
] as const;

export const ONEVIEW_LEGACY_COMPATIBILITY = {
  radius: ["radius-sm", "radius-md", "radius-lg", "radius-xl", "radius-full"],
  spacing: ["space-20"],
  typography: ["card-title", "small", "table-header", "table-row"],
  controlHeight: ["control-height-sm", "control-height-md", "control-height-lg"],
  note: "Compatibilidade temporária. Não usar em código novo.",
} as const;

export type OneViewSemanticStatus =
  | "monitoring-down"
  | "monitoring-normalized"
  | "incident-new"
  | "incident-progress"
  | "incident-waiting"
  | "incident-resolved"
  | "incident-closed"
  | "incident-cancelled"
  | "divergence"
  | "recurrence"
  | "classification-pending";

export type OneViewStatusDefinition = {
  label: string;
  group: "Monitoramento" | "ServiceNow" | "Operacional";
  className: string;
  tone: "success" | "warning" | "danger" | "info" | "neutral" | "recurrence";
};

export const ONEVIEW_STATUS_CATALOG: Record<OneViewSemanticStatus, OneViewStatusDefinition> = {
  "monitoring-down": { label: "Em falha", group: "Monitoramento", className: "ov-status-monitoring-down", tone: "danger" },
  "monitoring-normalized": { label: "Normalizado", group: "Monitoramento", className: "ov-status-monitoring-normalized", tone: "success" },
  "incident-new": { label: "Novo", group: "ServiceNow", className: "ov-status-incident-new", tone: "info" },
  "incident-progress": { label: "Em andamento", group: "ServiceNow", className: "ov-status-incident-progress", tone: "info" },
  "incident-waiting": { label: "Em espera", group: "ServiceNow", className: "ov-status-incident-waiting", tone: "warning" },
  "incident-resolved": { label: "Resolvido", group: "ServiceNow", className: "ov-status-incident-resolved", tone: "success" },
  "incident-closed": { label: "Fechado", group: "ServiceNow", className: "ov-status-incident-closed", tone: "neutral" },
  "incident-cancelled": { label: "Cancelado", group: "ServiceNow", className: "ov-status-incident-cancelled", tone: "neutral" },
  divergence: { label: "Divergência", group: "Operacional", className: "ov-status-divergence", tone: "warning" },
  recurrence: { label: "Recorrência", group: "Operacional", className: "ov-status-recurrence", tone: "recurrence" },
  "classification-pending": { label: "Classificação pendente", group: "Operacional", className: "ov-status-classification-pending", tone: "warning" },
};

export const ONEVIEW_INCIDENT_STATE_STATUS: Record<string, OneViewSemanticStatus> = {
  "1": "incident-new",
  "2": "incident-progress",
  "3": "incident-waiting",
  "6": "incident-resolved",
  "7": "incident-closed",
  "8": "incident-cancelled",
};

/**
 * Includes legacy `critical` and the Zabbix zero-severity state so a row from
 * the API can never make the semantic badge fail to render. `critical` keeps
 * the official High visual treatment.
 */
export type OneViewSeverity = "information" | "warning" | "average" | "high" | "disaster" | "critical" | "not_classified";

export const ONEVIEW_SEVERITY_CATALOG: Record<OneViewSeverity, { label: string; className: string }> = {
  information: { label: "Information", className: "ov-severity-information" },
  warning: { label: "Warning", className: "ov-severity-warning" },
  average: { label: "Average", className: "ov-severity-average" },
  high: { label: "High", className: "ov-severity-high" },
  disaster: { label: "Disaster", className: "ov-severity-disaster" },
  critical: { label: "High", className: "ov-severity-high" },
  not_classified: { label: "Not classified", className: "ov-severity-not-classified" },
};

export const ONEVIEW_COMPONENT_RULES = {
  controls: "8px radius · 32px ou 36px · mesma altura no mesmo contexto",
  panel: "12px radius · 1px border · 16px padding · sem shadow",
  overlays: "Shadow somente em modal, drawer overlay, popover, dropdown e floating menu",
  badges: "Pill radius · foreground forte · soft background · border · dot opcional de 6px",
  feedback: "Soft background · indicador/ícone à esquerda · border · título · descrição opcional",
  tables: "Header 40px · row 48px · padding horizontal 16px · border-bottom neutra",
  filters: "Context filter · Search · Mais filtros; quick filters abaixo quando necessários",
} as const;

export type OneViewFeedbackTone = "success" | "warning" | "error" | "info";

export const ONEVIEW_FEEDBACK_CATALOG: Record<OneViewFeedbackTone, {
  label: string;
  className: string;
  icon: "feedbackSuccess" | "feedbackWarning" | "feedbackError" | "feedbackInfo";
}> = {
  success: { label: "Success message", className: "ov-feedback-success", icon: "feedbackSuccess" },
  warning: { label: "Warning message", className: "ov-feedback-warning", icon: "feedbackWarning" },
  error: { label: "Error message", className: "ov-feedback-error", icon: "feedbackError" },
  info: { label: "Info message", className: "ov-feedback-info", icon: "feedbackInfo" },
};

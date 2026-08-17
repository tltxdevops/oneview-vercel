/**
 * OV-P0-78 — tokens do design system operacional OneView.
 * Padroniza filtros / CTAs / tipografia sem redesenhar telas.
 */

/** Controles de filtro (Select, combobox, chips de filtro). */
export const OV_FILTER_CONTROL =
  "h-8 rounded-md border border-border/70 bg-card text-xs shadow-sm hover:border-foreground/30 hover:bg-card";

/** Largura fixa do combobox Cliente. */
export const OV_CLIENT_FILTER_WIDTH = "w-[12rem] min-w-[12rem] max-w-[12rem]";

/** Trigger padrão do ClientFilterCombobox. */
export const OV_CLIENT_FILTER_TRIGGER = `${OV_FILTER_CONTROL} ${OV_CLIENT_FILTER_WIDTH} justify-between px-2`;

/** Chip/botão de filtro (severidade, janela) — mesma altura dos demais filtros. */
export const OV_FILTER_CHIP = "h-8 px-2.5 text-xs";

/** Item do segmented control (Prioritários/Todos). */
export const OV_SEGMENTED_ITEM = "h-8 px-2.5 text-xs";

/** Grupo segmented. */
export const OV_SEGMENTED_GROUP =
  "inline-flex items-center rounded-md border border-border/70 bg-card p-0.5";

/** Separador visual entre grupos de filtro (Cliente | Modo | Severidade | Período). */
export const OV_FILTER_DIVIDER = "hidden h-6 w-px shrink-0 bg-border/80 sm:block";

/** CTAs operacionais: Ver todos / Abrir / Limpar. */
export const OV_CTA = "h-7 px-2 text-xs";

/** Célula/coluna de duração ou ação — alinhamento à direita. */
export const OV_COL_END = "text-right tabular-nums";

/** Header de tabela operacional. */
export const OV_TABLE_HEAD = "text-left text-xs font-medium text-muted-foreground";

/** Linha de lista operacional — altura consistente. */
export const OV_LIST_ROW = "min-h-10 py-2";

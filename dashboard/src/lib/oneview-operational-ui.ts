/**
 * OV-P0-78 — tokens do design system operacional OneView.
 * Padroniza filtros / CTAs / tipografia sem redesenhar telas.
 */

/** Controles de filtro (Select, combobox, chips de filtro). */
export const OV_FILTER_CONTROL =
  "ov-filter-control";

/** Largura fixa do combobox Cliente. */
export const OV_CLIENT_FILTER_WIDTH = "w-[12rem] min-w-[12rem] max-w-[12rem]";

/** Trigger padrão do ClientFilterCombobox. */
export const OV_CLIENT_FILTER_TRIGGER = `${OV_FILTER_CONTROL} ${OV_CLIENT_FILTER_WIDTH} justify-between px-2`;

/** Chip/botão de filtro (severidade, janela) — mesma altura dos demais filtros. */
export const OV_FILTER_CHIP = "ov-filter-chip";

/** Item do segmented control (Prioritários/Todos). */
export const OV_SEGMENTED_ITEM = "ov-segmented-item";

/** Grupo segmented. */
export const OV_SEGMENTED_GROUP =
  "ov-segmented-control";

/** Separador visual entre grupos de filtro (Cliente | Modo | Severidade | Período). */
export const OV_FILTER_DIVIDER = "hidden h-6 w-px shrink-0 bg-border/80 sm:block";

/** CTAs operacionais: Ver todos / Abrir / Limpar. */
export const OV_CTA = "ov-cta";

/** Célula/coluna de duração ou ação — alinhamento à direita. */
export const OV_COL_END = "text-right tabular-nums";

/** Header de tabela operacional. */
export const OV_TABLE_HEAD = "ov-table-head text-left";

/** Linha de lista operacional — altura consistente. */
export const OV_LIST_ROW = "ov-list-row";

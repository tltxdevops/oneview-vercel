/** SN-P0-28 — busca ^INC\d+$ → number exato no BFF. */
export const INCIDENT_EXACT_NUMBER_SEARCH_RE = /^INC\d+$/i;

/** Prefixo de número INC enquanto o analista digita (autocomplete). */
export const INCIDENT_NUMBER_DRAFT_RE = /^INC\d*$/i;

/**
 * Normaliza rascunho de busca por INC: `inc` → `INC`, `inc008` → `INC008`.
 * Texto livre (cliente/descrição) e dígitos soltos permanecem inalterados.
 */
export function normalizeIncSearchDraft(raw: string): string {
  const value = raw;
  if (INCIDENT_NUMBER_DRAFT_RE.test(value.trim())) {
    const trimmed = value.trim();
    const digits = trimmed.slice(3);
    return `INC${digits}`;
  }
  return raw;
}

export function resolveIncidentSearch(search: string): { search?: string; number?: string } {
  const trimmed = search.trim();
  if (!trimmed) return {};
  if (INCIDENT_EXACT_NUMBER_SEARCH_RE.test(trimmed)) {
    return { number: trimmed.toUpperCase() };
  }
  return { search: trimmed };
}

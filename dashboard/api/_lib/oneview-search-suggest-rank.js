/** Ranking e merge de sugestões de busca (BFF). */

const KIND_PRIORITY = Object.freeze({
  customer: 0,
  company: 0,
  host: 1,
  link: 2,
  problem: 3,
  number: 4,
  description: 5,
  actor: 6,
  event: 7,
});

const KIND_HINT = Object.freeze({
  customer: "Filtrar por cliente",
  company: "Filtrar por cliente",
  host: "Filtrar por host",
  link: "Filtrar por link ou circuito",
  problem: "Filtrar por problema",
  number: "Abrir chamado",
  description: "Filtrar por descrição",
  actor: "Filtrar por ator",
  event: "Filtrar por evento",
});

function normalizeForMatch(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** 0 = prefixo, 1 = contém, 2 = resto */
export function matchRank(label, query) {
  const hay = normalizeForMatch(label);
  const needle = normalizeForMatch(query);
  if (!needle || !hay) return 2;
  if (hay.startsWith(needle)) return 0;
  if (hay.includes(needle)) return 1;
  return 2;
}

export function withSearchHint(item, query) {
  const kind = String(item.kind || "description");
  const hint = item.hint || KIND_HINT[kind] || "Filtrar tabela";
  const rank = matchRank(item.label || item.value, query);
  const kindPriority = KIND_PRIORITY[kind] ?? 9;
  return { ...item, hint, _rank: rank * 10 + kindPriority };
}

export function mergeRankedSuggestions(items, query, limit = 10) {
  const seen = new Set();
  const ranked = [];
  for (const raw of items) {
    if (!raw?.value) continue;
    const key = `${raw.kind || "?"}:${String(raw.value).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(withSearchHint(raw, query));
  }
  ranked.sort((a, b) => {
    if (a._rank !== b._rank) return a._rank - b._rank;
    return String(a.label || a.value).localeCompare(String(b.label || b.value), "pt-BR");
  });
  return ranked
    .slice(0, limit)
    .map(({ _rank, ...item }) => item);
}

export function sqlMatchOrder(alias, paramRef) {
  return `case
    when lower(${alias}) like lower(${paramRef}) || '%' then 0
    when lower(${alias}) like '%' || lower(${paramRef}) || '%' then 1
    else 2
  end`;
}

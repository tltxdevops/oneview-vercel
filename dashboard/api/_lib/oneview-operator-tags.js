/**
 * Classificação canônica OV-P0-247. Somente tags Zabbix persistidas;
 * nunca host, cliente, título ou descrição livre.
 */
export const OPERATOR_TAG_KEYS = Object.freeze(["description"]);
export const OPERATOR_TAG_KEY_ALIASES = Object.freeze(["operadora", "operador", "escalonamento"]);
export const OPERATOR_TAG_VALUES = Object.freeze([
  "EMBRATEL-MPLS-10MB-abordagem-operadora | SPO/IP/09330",
  "EMBRATEL-MPLS-16MB-abordagem-operadora | CTA/IP/01805",
  "EMBRATEL-MPLS-300MB-abordagem-operadora|SPO/IP/53219",
  "NET-BLC-120MB | Operadora | SOC/IP/06137",
  "NET-BLC-120MB | Operadora | STS/IP/17573",
  "OPERADORA-4G",
  "OPERADORA-BLC-XXXMB-abordagem-operadora",
]);
export const OPERATOR_TAG_VALUE_TOKENS = Object.freeze(["operadora", "operador", "escalonamento"]);

const OPERATOR_VALUE_TOKEN_RE = /(operadora|operador|escalonamento)/i;
const OPERATOR_KEY_ALIAS_RE = /^(operadora|operador|escalonamento)$/i;

/** SQL para alerts com alias canônico `a`. */
export const OPERATOR_TAG_EXISTS_SQL = `
exists (
  select 1
  from (
    select jsonb_array_elements(
      case when jsonb_typeof(coalesce(a.event_tags, '[]'::jsonb)) = 'array'
           then a.event_tags else '[]'::jsonb end
    ) as tag
    union all
    select jsonb_array_elements(
      case when jsonb_typeof(coalesce(a.trigger_tags, '[]'::jsonb)) = 'array'
           then a.trigger_tags else '[]'::jsonb end
    )
    union all
    select jsonb_array_elements(
      case when jsonb_typeof(coalesce(a.host_tags, '[]'::jsonb)) = 'array'
           then a.host_tags else '[]'::jsonb end
    )
  ) tags
  where lower(btrim(coalesce(tags.tag->>'tag', tags.tag->>'name', ''))) ~ '^(operadora|operador|escalonamento)$'
     or lower(btrim(coalesce(tags.tag->>'value', ''))) ~ '(operadora|operador|escalonamento)'
)`;

function asTagList(alertOrTags = {}) {
  const bags = [
    alertOrTags.event_tags,
    alertOrTags.trigger_tags,
    alertOrTags.host_tags,
    alertOrTags.template_tags,
  ];
  const out = [];
  for (const group of bags) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (!item || typeof item !== "object") continue;
      const tag = String(item.tag ?? item.name ?? "").trim();
      const value = String(item.value ?? "").trim();
      if (tag || value) out.push({ tag, value });
    }
  }
  return out;
}

export function isOperatorTagKey(key) {
  return OPERATOR_KEY_ALIAS_RE.test(String(key || "").trim());
}

export function isOperatorTagValue(value) {
  return OPERATOR_VALUE_TOKEN_RE.test(String(value || ""));
}

export function extractOperatorTags(alertOrTags) {
  return asTagList(alertOrTags).filter((item) => isOperatorTagKey(item.tag) || isOperatorTagValue(item.value));
}

export function alertHasOperatorTag(alertOrTags) {
  return extractOperatorTags(alertOrTags).length > 0;
}

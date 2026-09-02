/**
 * OV-P0-274 — exibição de tag objetiva de operadora já persistida.
 * Espelha a seleção do BFF; não classifica pelo nome do alerta.
 */

const OPERATOR_KEY_RE = /^(operadora|operador|escalonamento)$/i;
const OPERATOR_VALUE_RE = /(operadora|operador|escalonamento)/i;

type TagLike = { tag?: string | null; name?: string | null; value?: string | null };

export type PersistedOperatorTag = {
  tag: string;
  value: string;
};

function asTagList(alertOrTags?: {
  event_tags?: TagLike[] | null;
  trigger_tags?: TagLike[] | null;
  host_tags?: TagLike[] | null;
  template_tags?: TagLike[] | null;
} | null): PersistedOperatorTag[] {
  const bags = [
    alertOrTags?.event_tags,
    alertOrTags?.trigger_tags,
    alertOrTags?.host_tags,
    alertOrTags?.template_tags,
  ];
  const out: PersistedOperatorTag[] = [];
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

export function extractPersistedOperatorTags(alertOrTags?: Parameters<typeof asTagList>[0]): PersistedOperatorTag[] {
  return asTagList(alertOrTags).filter((item) => OPERATOR_KEY_RE.test(item.tag) || OPERATOR_VALUE_RE.test(item.value));
}

export function primaryPersistedOperatorTag(alertOrTags?: Parameters<typeof asTagList>[0]): PersistedOperatorTag | null {
  const tags = extractPersistedOperatorTags(alertOrTags);
  if (!tags.length) return null;
  return tags.find((item) => item.value) || tags[0];
}

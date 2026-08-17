/**
 * SN-P0-27 / OV-P0-108 — extração de INC / tags ServiceNow (espelha BFF).
 */

const SERVICENOW_INC_NUMBER_RE = /\bINC\d+\b/gi;
const SAFE_SYS_ID = /^[a-f0-9]{32}$/i;
const INTERNAL_TAG_PREFIX = /^__zbx_/i;

export const ZBX_SERVICENOW_TAG = {
  SYS_ID: "__zbx_servicenow_sys_id",
  NUMBER: "__zbx_servicenow_number",
  LINK: "__zbx_servicenow_link",
} as const;

export function extractServiceNowIncidentNumbers(input: unknown): string[] {
  const chunks = Array.isArray(input) ? input : [input];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const chunk of chunks) {
    const text = String(chunk ?? "");
    if (!text) continue;
    const re = new RegExp(SERVICENOW_INC_NUMBER_RE.source, SERVICENOW_INC_NUMBER_RE.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const number = String(match[0] || "").toUpperCase();
      if (!number || seen.has(number)) continue;
      seen.add(number);
      ordered.push(number);
    }
  }
  return ordered;
}

type HistoryLike = {
  comment?: string | null;
  description?: string | null;
  title?: string | null;
  message?: string | null;
  ack_message?: string | null;
  previous_value?: unknown;
  current_value?: unknown;
};

export function extractServiceNowIncidentNumbersFromHistory(
  items: HistoryLike[] | null | undefined = [],
  extraTexts: unknown[] | unknown = [],
): string[] {
  const texts: unknown[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    texts.push(
      item.comment,
      item.description,
      item.title,
      item.message,
      item.ack_message,
      item.previous_value,
      item.current_value,
    );
  }
  const extras = Array.isArray(extraTexts) ? extraTexts : [extraTexts];
  for (const extra of extras) texts.push(extra);
  return extractServiceNowIncidentNumbers(texts);
}

type TagLike = { tag?: string | null; name?: string | null; value?: string | null };

type AlertTagsLike = {
  event_tags?: TagLike[] | null;
  trigger_tags?: TagLike[] | null;
  host_tags?: TagLike[] | null;
  template_tags?: TagLike[] | null;
};

function asTagList(...groups: Array<TagLike[] | null | undefined | unknown>): Array<{ tag: string; value: string }> {
  const out: Array<{ tag: string; value: string }> = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (!item || typeof item !== "object") continue;
      const tag = String((item as TagLike).tag ?? (item as TagLike).name ?? "").trim();
      const value = String((item as TagLike).value ?? "").trim();
      if (!tag) continue;
      out.push({ tag, value });
    }
  }
  return out;
}

export function normalizeServiceNowSysId(value?: string | null): string {
  const id = String(value || "").trim();
  return SAFE_SYS_ID.test(id) ? id.toLowerCase() : "";
}

export function isInternalZabbixIntegrationTag(tagName?: string | null): boolean {
  const tag = String(tagName || "").trim();
  return Boolean(tag) && INTERNAL_TAG_PREFIX.test(tag);
}

export function filterOperationalAlertTags(tags: TagLike[] | null | undefined = []): Array<{ tag: string; value: string }> {
  return asTagList(tags).filter((item) => !isInternalZabbixIntegrationTag(item.tag));
}

export function extractServiceNowRefsFromAlertTags(alertOrTags: AlertTagsLike | TagLike[] | null | undefined = null): {
  sysIds: string[];
  numbers: string[];
  links: string[];
} {
  const bags = alertOrTags && typeof alertOrTags === "object" && !Array.isArray(alertOrTags)
    ? [
      (alertOrTags as AlertTagsLike).event_tags,
      (alertOrTags as AlertTagsLike).trigger_tags,
      (alertOrTags as AlertTagsLike).host_tags,
      (alertOrTags as AlertTagsLike).template_tags,
    ]
    : [alertOrTags as TagLike[] | null];

  const tags = asTagList(...bags);
  const sysIds: string[] = [];
  const numbers: string[] = [];
  const links: string[] = [];
  const seenSys = new Set<string>();
  const seenNum = new Set<string>();
  const seenLink = new Set<string>();

  for (const item of tags) {
    const key = item.tag.toLowerCase();
    const value = item.value;
    if (!value) continue;

    if (key === ZBX_SERVICENOW_TAG.SYS_ID) {
      const id = normalizeServiceNowSysId(value);
      if (!id || seenSys.has(id)) continue;
      seenSys.add(id);
      sysIds.push(id);
      continue;
    }

    if (key === ZBX_SERVICENOW_TAG.NUMBER) {
      for (const number of extractServiceNowIncidentNumbers(value)) {
        if (seenNum.has(number)) continue;
        seenNum.add(number);
        numbers.push(number);
      }
      continue;
    }

    if (key === ZBX_SERVICENOW_TAG.LINK) {
      const link = value.trim();
      if (!link || seenLink.has(link)) continue;
      seenLink.add(link);
      links.push(link);
    }
  }

  return { sysIds, numbers, links };
}

/** Deep link local (sem HTTP SN) — `/incident.do?sys_id=`. */
export function buildServiceNowIncidentDeepLink(baseUrl?: string | null, sysId?: string | null): string | null {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const id = normalizeServiceNowSysId(sysId);
  if (!base || !id) return null;
  try {
    const url = new URL("/incident.do", `${base}/`);
    url.searchParams.set("sys_id", id);
    return url.toString();
  } catch {
    return null;
  }
}

export type AlertServiceNowReference = {
  number: string | null;
  sys_id: string | null;
  url: string | null;
  extra_count: number;
};

/**
 * OV-P0-109 — referência SN já conhecida nas tags (sem consulta ServiceNow).
 */
export function projectServiceNowReferenceFromAlertTags(
  alertOrTags: AlertTagsLike | TagLike[] | null | undefined = null,
  options: { baseUrl?: string | null } = {},
): AlertServiceNowReference | null {
  const refs = extractServiceNowRefsFromAlertTags(alertOrTags);
  const number = refs.numbers[0] || null;
  const sys_id = refs.sysIds[0] || null;
  if (!number && !sys_id) return null;

  const linkFromTag = refs.links.find((link) => /^https?:\/\//i.test(String(link || "").trim())) || null;
  const url = buildServiceNowIncidentDeepLink(options.baseUrl, sys_id) || linkFromTag;

  return {
    number,
    sys_id,
    url,
    extra_count: Math.max(0, refs.numbers.length - (number ? 1 : 0)),
  };
}

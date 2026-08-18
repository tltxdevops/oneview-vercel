/**
 * SN-P0-27 / OV-P0-108 — Correlação explícita INC Zabbix → ServiceNow (read-only).
 * Prioridade:
 * 1. __zbx_servicenow_sys_id (tags)
 * 2. __zbx_servicenow_number (tags)
 * 3. INC explícito em comentário/histórico
 * 4. zabbix_event_id
 * 5. none
 * Sem fallback por host. Sem POST/write.
 */

import {
  RELATED_INCIDENTS_MAX,
  enrichIncident,
  fetchIncidentsBySourceEventId,
} from "./oneview-incidents.js";
import { SERVICENOW_INCIDENT_FIELDS_CSV } from "./servicenow-normalize.js";
import {
  ServiceNowClientError,
  getServiceNowConfig,
  normalizeServiceNowSysId,
  serviceNowGet,
} from "./servicenow-client.js";

/** Case-insensitive; captura INC + dígitos como token. */
export const SERVICENOW_INC_NUMBER_RE = /\bINC\d+\b/gi;

/** Metadados internos Zabbix → ServiceNow (OV-P0-108). Não exibir como tags operacionais. */
export const ZBX_SERVICENOW_TAG = Object.freeze({
  SYS_ID: "__zbx_servicenow_sys_id",
  NUMBER: "__zbx_servicenow_number",
  LINK: "__zbx_servicenow_link",
});

/** Base canônica para links externos; não depende do ambiente DEV. */
export const SERVICENOW_PROD_BASE_URL = "https://teletexprod.service-now.com";

export const RELATION_SOURCE = Object.freeze({
  ZABBIX_SERVICENOW_SYS_ID: "zabbix_servicenow_sys_id",
  ZABBIX_SERVICENOW_NUMBER: "zabbix_servicenow_number",
  ZABBIX_INC_REFERENCE: "zabbix_inc_reference",
  ZABBIX_EVENT_ID: "zabbix_event_id",
  NONE: "none",
});

const INTERNAL_TAG_PREFIX = /^__zbx_/i;

/**
 * Extrai números INC de texto(s), normaliza UPPERCASE e deduplica (ordem de aparição).
 * @param {unknown} input string | string[] | null
 * @returns {string[]}
 */
export function extractServiceNowIncidentNumbers(input) {
  const chunks = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const ordered = [];
  for (const chunk of chunks) {
    const text = String(chunk ?? "");
    if (!text) continue;
    const re = new RegExp(SERVICENOW_INC_NUMBER_RE.source, SERVICENOW_INC_NUMBER_RE.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      const number = String(match[0] || "").toUpperCase();
      if (!number || seen.has(number)) continue;
      seen.add(number);
      ordered.push(number);
    }
  }
  return ordered;
}

/**
 * Fontes permitidas: comentários, ACK message, eventos/timeline do BFF.
 * Campos típicos de history item + strings soltas (ex.: source_ack.comment).
 */
export function extractServiceNowIncidentNumbersFromHistory(items = [], extraTexts = []) {
  const texts = [];
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
  for (const extra of Array.isArray(extraTexts) ? extraTexts : [extraTexts]) {
    texts.push(extra);
  }
  return extractServiceNowIncidentNumbers(texts);
}

function asTagList(...groups) {
  const out = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (!item || typeof item !== "object") continue;
      const tag = String(item.tag ?? item.name ?? "").trim();
      const value = String(item.value ?? "").trim();
      if (!tag) continue;
      out.push({ tag, value });
    }
  }
  return out;
}

export function isInternalZabbixIntegrationTag(tagName) {
  const tag = String(tagName || "").trim();
  if (!tag) return false;
  if (INTERNAL_TAG_PREFIX.test(tag)) return true;
  return false;
}

/** Tags operacionais (oculta __zbx_* e metadados internos de integração). */
export function filterOperationalAlertTags(tags = []) {
  return asTagList(tags).filter((item) => !isInternalZabbixIntegrationTag(item.tag));
}

/**
 * Lê referências ServiceNow das tags do alerta (event/trigger/host/template).
 * @returns {{ sysIds: string[], numbers: string[], links: string[] }}
 */
export function extractServiceNowRefsFromAlertTags(alertOrTags = null) {
  const bags = alertOrTags && typeof alertOrTags === "object" && !Array.isArray(alertOrTags)
    ? [
      alertOrTags.event_tags,
      alertOrTags.trigger_tags,
      alertOrTags.host_tags,
      alertOrTags.template_tags,
    ]
    : [alertOrTags];

  const tags = asTagList(...bags);
  const sysIds = [];
  const numbers = [];
  const links = [];
  const seenSys = new Set();
  const seenNum = new Set();
  const seenLink = new Set();

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
      const list = extractServiceNowIncidentNumbers(value);
      for (const number of list) {
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

export const EXPLICIT_SN_CORRELATION_CLASS = Object.freeze({
  CORRELATED_EXACT: "correlated_exact",
  CORRELATED_BY_SYS_ID_ONLY: "correlated_by_sys_id_only",
  CORRELATED_BY_NUMBER_ONLY: "correlated_by_number_only",
  MISMATCH: "mismatch",
  MISSING_IN_SERVICENOW: "missing_in_servicenow",
  MALFORMED_TAG: "malformed_tag",
});

/**
 * Extrai sys_id explícito de deep link ServiceNow (`sys_id=`). Sem heurística de host.
 */
export function parseSysIdFromServiceNowLink(link) {
  const raw = String(link || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const direct = normalizeServiceNowSysId(url.searchParams.get("sys_id"));
    if (direct) return { sys_id: direct, host: url.host, href: url.toString() };
    const uri = String(url.searchParams.get("uri") || "");
    if (uri) {
      const nested = new URL(uri, `${url.origin}/`);
      const nestedId = normalizeServiceNowSysId(nested.searchParams.get("sys_id"));
      if (nestedId) return { sys_id: nestedId, host: url.host, href: url.toString() };
    }
    return { sys_id: null, host: url.host, href: url.toString() };
  } catch {
    const match = raw.match(/[?&]sys_id=([a-f0-9]{32})\b/i);
    if (match?.[1]) {
      return { sys_id: normalizeServiceNowSysId(match[1]), host: null, href: raw };
    }
    return null;
  }
}

/**
 * Inspeção crua das tags explícitas (inclui valores malformados que o extract descarta).
 */
export function inspectExplicitServiceNowTags(alertOrTags = null) {
  const bags = alertOrTags && typeof alertOrTags === "object" && !Array.isArray(alertOrTags)
    ? [
      alertOrTags.event_tags,
      alertOrTags.trigger_tags,
      alertOrTags.host_tags,
      alertOrTags.template_tags,
    ]
    : [alertOrTags];
  const tags = asTagList(...bags);
  const rawSysIds = [];
  const rawNumbers = [];
  const rawLinks = [];
  const validSysIds = [];
  const validNumbers = [];
  const linkSysIds = [];
  const malformed = [];
  const seenSys = new Set();
  const seenNum = new Set();
  const seenLink = new Set();
  const seenLinkId = new Set();

  for (const item of tags) {
    const key = item.tag.toLowerCase();
    const value = item.value;
    if (key === ZBX_SERVICENOW_TAG.SYS_ID) {
      if (!value) {
        malformed.push({ tag: item.tag, value: "", reason: "empty_sys_id" });
        continue;
      }
      rawSysIds.push(value);
      const id = normalizeServiceNowSysId(value);
      if (!id) {
        malformed.push({ tag: item.tag, value: value.slice(0, 80), reason: "malformed_sys_id" });
        continue;
      }
      if (!seenSys.has(id)) {
        seenSys.add(id);
        validSysIds.push(id);
      }
      continue;
    }
    if (key === ZBX_SERVICENOW_TAG.NUMBER) {
      if (!value) {
        malformed.push({ tag: item.tag, value: "", reason: "empty_number" });
        continue;
      }
      rawNumbers.push(value);
      const numbers = extractServiceNowIncidentNumbers(value);
      if (!numbers.length) {
        malformed.push({ tag: item.tag, value: value.slice(0, 80), reason: "malformed_number" });
        continue;
      }
      for (const number of numbers) {
        if (seenNum.has(number)) continue;
        seenNum.add(number);
        validNumbers.push(number);
      }
      continue;
    }
    if (key === ZBX_SERVICENOW_TAG.LINK) {
      if (!value) {
        malformed.push({ tag: item.tag, value: "", reason: "empty_link" });
        continue;
      }
      rawLinks.push(value);
      if (seenLink.has(value)) continue;
      seenLink.add(value);
      const parsed = parseSysIdFromServiceNowLink(value);
      if (!parsed) {
        const redacted = /^\[[^\]]*(redacted|protegido)[^\]]*\]$/i.test(value);
        malformed.push({
          tag: item.tag,
          value: value.slice(0, 120),
          reason: redacted ? "redacted_link" : "malformed_link",
        });
        continue;
      }
      if (!parsed.sys_id) {
        malformed.push({ tag: item.tag, value: value.slice(0, 120), reason: "link_missing_sys_id" });
        continue;
      }
      if (!seenLinkId.has(parsed.sys_id)) {
        seenLinkId.add(parsed.sys_id);
        linkSysIds.push(parsed.sys_id);
      }
    }
  }

  return {
    raw_sys_id_tags: rawSysIds,
    raw_number_tags: rawNumbers,
    raw_link_tags: rawLinks,
    valid_sys_ids: validSysIds,
    valid_numbers: validNumbers,
    link_sys_ids: linkSysIds,
    malformed,
    has_any_explicit_tag: Boolean(rawSysIds.length || rawNumbers.length || rawLinks.length),
  };
}

function incidentFieldsPresent(incident) {
  if (!incident) {
    return { state: false, priority: false, assigned_to: false };
  }
  return {
    state: Boolean(incident.state || incident.state_display),
    priority: Boolean(incident.priority || incident.priority_display),
    assigned_to: incident.assigned_to != null || Boolean(incident.assigned_to_display),
  };
}

/**
 * Classifica uma linha alerta↔INC por referências explícitas (sem host, sem heurística).
 * Lookups já resolvidos: bySysId / byNumber são Maps sys_id|number → incidente|null.
 */
export function classifyExplicitServiceNowCorrelation({
  inspect,
  bySysId = new Map(),
  byNumber = new Map(),
} = {}) {
  const info = inspect || inspectExplicitServiceNowTags(null);
  const causes = [];
  const validSysIds = info.valid_sys_ids || [];
  const validNumbers = info.valid_numbers || [];
  const linkSysIds = info.link_sys_ids || [];
  const malformed = info.malformed || [];
  const lookupSysIds = [];
  const seenLookup = new Set();
  for (const id of [...validSysIds, ...linkSysIds]) {
    if (!id || seenLookup.has(id)) continue;
    seenLookup.add(id);
    lookupSysIds.push(id);
  }

  const sysHits = lookupSysIds.map((id) => ({ id, incident: bySysId.get(id) || null }));
  const numberHits = validNumbers.map((number) => ({ number, incident: byNumber.get(number) || null }));
  const foundBySysId = sysHits.filter((row) => row.incident);
  const foundByNumber = numberHits.filter((row) => row.incident);
  const missingSysIds = sysHits.filter((row) => !row.incident).map((row) => row.id);
  const missingNumbers = numberHits.filter((row) => !row.incident).map((row) => row.number);

  const sysIdSet = new Set(foundBySysId.map((row) => normalizeServiceNowSysId(row.incident.sys_id) || row.id));
  const numberSysIds = new Set(
    foundByNumber.map((row) => normalizeServiceNowSysId(row.incident.sys_id)).filter(Boolean),
  );
  const tagSysIdSet = new Set(validSysIds);
  const linkMismatch = linkSysIds.some((id) => tagSysIdSet.size && !tagSysIdSet.has(id));
  const multiSysId = validSysIds.length > 1;
  const multiNumber = validNumbers.length > 1;
  const tagPairMismatch = foundBySysId.length > 0 && foundByNumber.length > 0
    && ![...sysIdSet].some((id) => numberSysIds.has(id));
  const tagSysIdDisagreesWithNumber = validSysIds.length > 0 && foundByNumber.length > 0
    && !validSysIds.some((id) => numberSysIds.has(id));
  const bothTagsPresentOneMissing = validSysIds.length > 0 && validNumbers.length > 0
    && (foundBySysId.filter((row) => validSysIds.includes(row.id)).length === 0) !== (foundByNumber.length === 0);
  const bothTagsPresentBothMissing = validSysIds.length > 0 && validNumbers.length > 0
    && foundBySysId.length === 0 && foundByNumber.length === 0;
  const linkVsResolvedMismatch = linkSysIds.length > 0 && (sysIdSet.size > 0 || numberSysIds.size > 0)
    && !linkSysIds.some((id) => sysIdSet.has(id) || numberSysIds.has(id));

  if (malformed.length) causes.push("malformed_tag_value");
  if (multiSysId) causes.push("multiple_sys_id_tags");
  if (multiNumber) causes.push("multiple_number_tags");
  if (linkMismatch) causes.push("link_sys_id_diverges_from_tag");
  if (tagPairMismatch) causes.push("number_and_sys_id_point_to_different_incidents");
  if (tagSysIdDisagreesWithNumber) causes.push("tag_sys_id_differs_from_number_incident");
  if (bothTagsPresentOneMissing) causes.push("one_explicit_ref_missing_in_servicenow");
  if (linkVsResolvedMismatch) causes.push("link_does_not_open_resolved_incident");

  let classification = EXPLICIT_SN_CORRELATION_CLASS.MISSING_IN_SERVICENOW;
  if (!lookupSysIds.length && !validNumbers.length) {
    classification = EXPLICIT_SN_CORRELATION_CLASS.MALFORMED_TAG;
    if (!causes.includes("malformed_tag_value")) causes.push("no_parseable_explicit_ref");
  } else if (
    tagPairMismatch
    || tagSysIdDisagreesWithNumber
    || bothTagsPresentOneMissing
    || linkMismatch
    || linkVsResolvedMismatch
  ) {
    classification = EXPLICIT_SN_CORRELATION_CLASS.MISMATCH;
  } else if (foundBySysId.length && foundByNumber.length) {
    classification = EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_EXACT;
  } else if (foundBySysId.length) {
    classification = EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_BY_SYS_ID_ONLY;
    if (!validNumbers.length) causes.push("number_tag_absent");
  } else if (foundByNumber.length) {
    classification = EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_BY_NUMBER_ONLY;
    if (!validSysIds.length) causes.push("sys_id_tag_absent");
  } else if (bothTagsPresentBothMissing || missingSysIds.length || missingNumbers.length) {
    classification = EXPLICIT_SN_CORRELATION_CLASS.MISSING_IN_SERVICENOW;
    causes.push("explicit_ref_not_found_in_servicenow");
  } else {
    classification = EXPLICIT_SN_CORRELATION_CLASS.MALFORMED_TAG;
  }

  const resolved = foundBySysId[0]?.incident || foundByNumber[0]?.incident || null;
  const fields = incidentFieldsPresent(resolved);
  const resolvedSysId = normalizeServiceNowSysId(resolved?.sys_id);
  const linkOpensSame = Boolean(
    resolvedSysId && linkSysIds.length && linkSysIds.includes(resolvedSysId),
  );

  return {
    classification,
    causes,
    has_sys_id: validSysIds.length > 0,
    has_number: validNumbers.length > 0,
    has_link: (info.raw_link_tags || []).length > 0,
    valid_sys_ids: validSysIds,
    valid_numbers: validNumbers,
    link_sys_ids: linkSysIds,
    sys_id_exists: foundBySysId.length > 0,
    number_exists: foundByNumber.length > 0,
    same_incident: classification === EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_EXACT,
    link_opens_same_incident: linkOpensSame,
    malformed,
    resolved: resolved
      ? {
        sys_id: resolved.sys_id || null,
        number: resolved.number || null,
        state: resolved.state || null,
        state_display: resolved.state_display || null,
        priority: resolved.priority || null,
        priority_display: resolved.priority_display || null,
        assigned_to: resolved.assigned_to || null,
        assigned_to_display: resolved.assigned_to_display || null,
        fields_recovered: fields,
      }
      : null,
  };
}

/** Deep link local (sem HTTP SN) — `/incident.do?sys_id=`. */
export function buildServiceNowIncidentDeepLink(baseUrl, sysId) {
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

/**
 * OV-P0-109 — projeta referência SN já conhecida nas tags do alerta.
 * Sem consulta ServiceNow (somente metadados explícitos Zabbix).
 * @returns {{ number: string|null, sys_id: string|null, url: string|null, extra_count: number } | null}
 */
export function projectServiceNowReferenceFromAlertTags(alertOrTags = null, {
  baseUrl,
  allowLinkTagFallback = true,
} = {}) {
  const refs = extractServiceNowRefsFromAlertTags(alertOrTags);
  const number = refs.numbers[0] || null;
  const sys_id = refs.sysIds[0] || null;
  if (!number && !sys_id) return null;

  const linkFromTag = refs.links.find((link) => /^https?:\/\//i.test(String(link || "").trim())) || null;
  const url = buildServiceNowIncidentDeepLink(baseUrl, sys_id)
    || (allowLinkTagFallback ? linkFromTag : null);

  return {
    number,
    sys_id,
    url,
    extra_count: Math.max(0, refs.numbers.length - (number ? 1 : 0)),
  };
}

/** Query SN: numberIN… (números já normalizados). Sem filtro por host/caller. */
export function buildExactIncidentNumbersSysparmQuery(numbers) {
  const list = extractServiceNowIncidentNumbers(
    (Array.isArray(numbers) ? numbers : [numbers]).join(" "),
  );
  if (!list.length) return null;
  if (list.length === 1) {
    return `number=${list[0]}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`;
  }
  return `numberIN${list.join(",")}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`;
}

export function buildExactIncidentSysIdsSysparmQuery(sysIds) {
  const list = [];
  const seen = new Set();
  for (const raw of Array.isArray(sysIds) ? sysIds : [sysIds]) {
    const id = normalizeServiceNowSysId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }
  if (!list.length) return null;
  if (list.length === 1) {
    return `sys_id=${list[0]}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`;
  }
  return `sys_idIN${list.join(",")}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`;
}

/**
 * Lookup ServiceNow por number(s) exatos. Deduplica por number/sys_id.
 */
export async function fetchIncidentsByExactNumbers(numbers, {
  config = getServiceNowConfig(),
  fetchImpl,
  getPage = serviceNowGet,
  maxRecords = RELATED_INCIDENTS_MAX,
} = {}) {
  if (!config.configured) {
    throw new ServiceNowClientError("servicenow_not_configured");
  }

  const wanted = extractServiceNowIncidentNumbers(
    (Array.isArray(numbers) ? numbers : [numbers]).join(" "),
  );
  if (!wanted.length) {
    return {
      incident_numbers: [],
      matched: false,
      incidents: [],
      candidates_returned: 0,
      data_source: "servicenow",
      checked_at: new Date().toISOString(),
    };
  }

  const sysparm_query = buildExactIncidentNumbersSysparmQuery(wanted);
  const pageResult = await getPage("incident", {
    config,
    fetchImpl,
    sysparm_query,
    sysparm_fields: SERVICENOW_INCIDENT_FIELDS_CSV,
    sysparm_limit: Math.min(Math.max(Number(maxRecords) || RELATED_INCIDENTS_MAX, 1), RELATED_INCIDENTS_MAX),
    sysparm_offset: 0,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });

  const candidates = Array.isArray(pageResult.records) ? pageResult.records : [];
  const wantedSet = new Set(wanted);
  const seen = new Set();
  const incidents = [];

  for (const raw of candidates) {
    const item = enrichIncident(raw, config);
    const number = String(item.number || "").trim().toUpperCase();
    if (!number || !wantedSet.has(number)) continue;
    const dedupeKey = String(item.sys_id || number);
    if (seen.has(dedupeKey) || seen.has(number)) continue;
    seen.add(dedupeKey);
    seen.add(number);
    incidents.push(item);
  }

  incidents.sort((left, right) => {
    const li = wanted.indexOf(String(left.number || "").toUpperCase());
    const ri = wanted.indexOf(String(right.number || "").toUpperCase());
    return (li < 0 ? 999 : li) - (ri < 0 ? 999 : ri);
  });

  return {
    incident_numbers: wanted,
    matched: incidents.length > 0,
    incidents,
    candidates_returned: candidates.length,
    data_source: "servicenow",
    checked_at: new Date().toISOString(),
  };
}

/**
 * OV-P0-108 — lookup ServiceNow por sys_id(s) exatos.
 */
export async function fetchIncidentsByExactSysIds(sysIds, {
  config = getServiceNowConfig(),
  fetchImpl,
  getPage = serviceNowGet,
  maxRecords = RELATED_INCIDENTS_MAX,
} = {}) {
  if (!config.configured) {
    throw new ServiceNowClientError("servicenow_not_configured");
  }

  const wanted = [];
  const seenWanted = new Set();
  for (const raw of Array.isArray(sysIds) ? sysIds : [sysIds]) {
    const id = normalizeServiceNowSysId(raw);
    if (!id || seenWanted.has(id)) continue;
    seenWanted.add(id);
    wanted.push(id);
  }

  if (!wanted.length) {
    return {
      incident_sys_ids: [],
      matched: false,
      incidents: [],
      candidates_returned: 0,
      data_source: "servicenow",
      checked_at: new Date().toISOString(),
    };
  }

  const sysparm_query = buildExactIncidentSysIdsSysparmQuery(wanted);
  const pageResult = await getPage("incident", {
    config,
    fetchImpl,
    sysparm_query,
    sysparm_fields: SERVICENOW_INCIDENT_FIELDS_CSV,
    sysparm_limit: Math.min(Math.max(Number(maxRecords) || RELATED_INCIDENTS_MAX, 1), RELATED_INCIDENTS_MAX),
    sysparm_offset: 0,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });

  const candidates = Array.isArray(pageResult.records) ? pageResult.records : [];
  const wantedSet = new Set(wanted);
  const seen = new Set();
  const incidents = [];

  for (const raw of candidates) {
    const item = enrichIncident(raw, config);
    const sysId = normalizeServiceNowSysId(item.sys_id);
    if (!sysId || !wantedSet.has(sysId)) continue;
    if (seen.has(sysId)) continue;
    seen.add(sysId);
    incidents.push(item);
  }

  incidents.sort((left, right) => {
    const li = wanted.indexOf(normalizeServiceNowSysId(left.sys_id));
    const ri = wanted.indexOf(normalizeServiceNowSysId(right.sys_id));
    return (li < 0 ? 999 : li) - (ri < 0 ? 999 : ri);
  });

  return {
    incident_sys_ids: wanted,
    matched: incidents.length > 0,
    incidents,
    candidates_returned: candidates.length,
    data_source: "servicenow",
    checked_at: new Date().toISOString(),
  };
}

/**
 * Prioridade OV-P0-108:
 * 1. __zbx_servicenow_sys_id
 * 2. __zbx_servicenow_number
 * 3. INC explícito no histórico/comentário
 * 4. source_event_id → zabbix_event_id
 * 5. none
 * Nunca usa host.
 */
export async function correlateAlertRelatedIncidents({
  sourceEventId = null,
  /** INC vindos do histórico/comentário (?inc=&text=). */
  incidentNumbers = [],
  /** Números vindos de __zbx_servicenow_number (?sn_number=). */
  tagIncidentNumbers = [],
  /** sys_ids de __zbx_servicenow_sys_id (?sys_id=). */
  incidentSysIds = [],
  alertTags = null,
  historyItems = [],
  extraTexts = [],
  lookupBySysId = fetchIncidentsByExactSysIds,
  lookupByNumber = fetchIncidentsByExactNumbers,
  lookupByEventId = fetchIncidentsBySourceEventId,
  config,
  getPage,
  fetchImpl,
} = {}) {
  const fromTags = extractServiceNowRefsFromAlertTags(alertTags);

  const sysIds = [];
  const seenSys = new Set();
  for (const raw of [...fromTags.sysIds, ...(Array.isArray(incidentSysIds) ? incidentSysIds : [incidentSysIds])]) {
    const id = normalizeServiceNowSysId(raw);
    if (!id || seenSys.has(id)) continue;
    seenSys.add(id);
    sysIds.push(id);
  }

  const tagNumbers = extractServiceNowIncidentNumbers([
    ...fromTags.numbers,
    ...(Array.isArray(tagIncidentNumbers) ? tagIncidentNumbers : [tagIncidentNumbers]),
  ]);

  const fromHistory = extractServiceNowIncidentNumbersFromHistory(historyItems, extraTexts);
  const fromParams = extractServiceNowIncidentNumbers(
    (Array.isArray(incidentNumbers) ? incidentNumbers : [incidentNumbers]).join(" "),
  );
  const historyNumbers = extractServiceNowIncidentNumbers([
    ...fromParams,
    ...fromHistory,
  ]).filter((number) => !tagNumbers.includes(number));

  const eventId = String(sourceEventId || "").trim() || null;
  const checkedAt = new Date().toISOString();
  const opts = { config, getPage, fetchImpl };
  const allNumbers = extractServiceNowIncidentNumbers([...tagNumbers, ...historyNumbers]);

  if (sysIds.length) {
    const bySysId = await lookupBySysId(sysIds, opts);
    if (bySysId.incidents?.length) {
      return {
        matched: true,
        relation_source: RELATION_SOURCE.ZABBIX_SERVICENOW_SYS_ID,
        source_event_id: eventId,
        incident_numbers: allNumbers,
        incident_sys_ids: sysIds,
        incidents: bySysId.incidents,
        data_source: "servicenow",
        checked_at: bySysId.checked_at || checkedAt,
      };
    }
  }

  if (tagNumbers.length) {
    const byTagNumber = await lookupByNumber(tagNumbers, opts);
    if (byTagNumber.incidents?.length) {
      return {
        matched: true,
        relation_source: RELATION_SOURCE.ZABBIX_SERVICENOW_NUMBER,
        source_event_id: eventId,
        incident_numbers: tagNumbers,
        incident_sys_ids: sysIds,
        incidents: byTagNumber.incidents,
        data_source: "servicenow",
        checked_at: byTagNumber.checked_at || checkedAt,
      };
    }
  }

  if (historyNumbers.length) {
    const byNumber = await lookupByNumber(historyNumbers, opts);
    if (byNumber.incidents?.length) {
      return {
        matched: true,
        relation_source: RELATION_SOURCE.ZABBIX_INC_REFERENCE,
        source_event_id: eventId,
        incident_numbers: historyNumbers,
        incident_sys_ids: sysIds,
        incidents: byNumber.incidents,
        data_source: "servicenow",
        checked_at: byNumber.checked_at || checkedAt,
      };
    }
  }

  if (eventId) {
    const byEvent = await lookupByEventId(eventId, opts);
    if (byEvent.incidents?.length) {
      return {
        matched: true,
        relation_source: RELATION_SOURCE.ZABBIX_EVENT_ID,
        source_event_id: eventId,
        incident_numbers: allNumbers,
        incident_sys_ids: sysIds,
        incidents: byEvent.incidents,
        data_source: "servicenow",
        checked_at: byEvent.checked_at || checkedAt,
      };
    }
  }

  return {
    matched: false,
    relation_source: RELATION_SOURCE.NONE,
    source_event_id: eventId,
    incident_numbers: allNumbers,
    incident_sys_ids: sysIds,
    incidents: [],
    data_source: "servicenow",
    checked_at: checkedAt,
  };
}

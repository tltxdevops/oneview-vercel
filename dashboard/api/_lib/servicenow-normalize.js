/**
 * SN-P0-01 / SN-P0-06 — normalização read-only de incidentes ServiceNow.
 * Parser de description extrai campos Zabbix quando presentes (sem relacionar registros).
 */

export const SERVICENOW_INCIDENT_FIELDS = Object.freeze([
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "caller_id",
  "contact_type",
  "assignment_group",
  "assigned_to",
  "company",
  "opened_at",
  "resolved_at",
  "closed_at",
  "sys_created_on",
  "sys_updated_on",
  "correlation_id",
  "u_hostname_zabbix",
  "u_ip_zabbix",
]);

export const SERVICENOW_INCIDENT_FIELDS_CSV = SERVICENOW_INCIDENT_FIELDS.join(",");

/** Campos derivados do parser de description (SN-P0-06). */
export const SERVICENOW_PARSED_ZABBIX_FIELDS = Object.freeze([
  "zabbix_event_id",
  "zabbix_host",
  "zabbix_ip",
]);

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/**
 * Extrai valor escalar de campo Table API (string | number | { value, display_value }).
 */
export function extractServiceNowValue(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "object") {
    if (Object.prototype.hasOwnProperty.call(raw, "value")) {
      return emptyToNull(raw.value);
    }
    return null;
  }
  return emptyToNull(raw);
}

export function extractServiceNowDisplay(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "object") {
    if (Object.prototype.hasOwnProperty.call(raw, "display_value")) {
      return emptyToNull(raw.display_value);
    }
    if (Object.prototype.hasOwnProperty.call(raw, "value")) {
      return emptyToNull(raw.value);
    }
    return null;
  }
  return emptyToNull(raw);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return emptyToNull(match[1]);
  }
  return null;
}

/**
 * SN-P0-06 — parser read-only de description Zabbix → ServiceNow.
 * Não usa u_* nem correlation_id. Não relaciona registros.
 *
 * Formatos observados:
 *   Host: <hostname>
 *   ID original do problema: <eventid>
 *   ...tr_events.php?triggerid=...&eventid=<eventid>
 *   IP: <addr> / IP address: <addr> (quando existir; nunca o IP do servidor Zabbix do link)
 */
/**
 * Formato observado em integrações MAPS / compactas: `fqdn.host: texto do problema`.
 */
export function parseColonHostProblemLine(description) {
  const firstLine = String(description || "").trim().split(/\n/)[0]?.trim() || "";
  const colon = firstLine.indexOf(":");
  if (colon <= 0) return { host: null, problem: null };
  const host = firstLine.slice(0, colon).trim();
  const problem = firstLine.slice(colon + 1).trim();
  if (!host || host.length > 253) return { host: null, problem: problem || null };
  if (!host.includes(".") && host.length < 5) return { host: null, problem: problem || null };
  return { host, problem: problem || null };
}

export function parseZabbixHostFromColonDescription(description) {
  return parseColonHostProblemLine(description).host;
}

export function parseZabbixFieldsFromDescription(description) {
  const text = String(description || "").replace(/\r\n/g, "\n");
  if (!text.trim()) {
    return {
      zabbix_event_id: null,
      zabbix_host: null,
      zabbix_ip: null,
    };
  }

  let zabbix_host = firstMatch(text, [
    /^Host:\s*(.+)$/im,
    /\nHost:\s*(.+)$/im,
  ]);

  if (!zabbix_host) {
    zabbix_host = parseZabbixHostFromColonDescription(text);
  }

  const zabbix_event_id = firstMatch(text, [
    /^ID original do problema:\s*(\d+)\s*$/im,
    /\nID original do problema:\s*(\d+)\s*$/im,
    /[?&]eventid=(\d+)\b/i,
    /\beventid\s*[:=]\s*(\d+)\b/i,
  ]);

  // Somente IP explicitamente rotulado — evita capturar o IP do servidor Zabbix no link.
  const zabbix_ip = firstMatch(text, [
    /^IP(?:\s*address)?\s*[:=]\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/im,
    /\nIP(?:\s*address)?\s*[:=]\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/im,
    /\bIP do host\s*[:=]\s*(\d{1,3}(?:\.\d{1,3}){3})\b/i,
  ]);

  return {
    zabbix_event_id,
    zabbix_host,
    zabbix_ip,
  };
}

/**
 * Normaliza um registro incident para o contrato OneView (somente campos listados).
 * Valores de referência/choice ficam como string (sys_id / código), sem links.
 * Inclui campos parseados de description (SN-P0-06), sem correlacionar.
 */
export function normalizeServiceNowIncident(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const field of SERVICENOW_INCIDENT_FIELDS) {
    out[field] = extractServiceNowValue(source[field]);
  }
  const parsed = parseZabbixFieldsFromDescription(out.description);
  out.zabbix_event_id = parsed.zabbix_event_id;
  out.zabbix_host = parsed.zabbix_host;
  out.zabbix_ip = parsed.zabbix_ip;
  return out;
}

export function normalizeServiceNowIncidents(records = []) {
  if (!Array.isArray(records)) return [];
  return records.map((item) => normalizeServiceNowIncident(item));
}

/**
 * Exemplo sanitizado para logs/relatórios de discovery (sem credenciais).
 */
export function sanitizeIncidentExample(incident = {}) {
  const normalized = normalizeServiceNowIncident(incident);
  return {
    sys_id: normalized.sys_id,
    number: normalized.number,
    short_description: normalized.short_description
      ? String(normalized.short_description).slice(0, 120)
      : null,
    state: normalized.state,
    priority: normalized.priority,
    caller_id: normalized.caller_id,
    contact_type: normalized.contact_type,
    assignment_group: normalized.assignment_group,
    assigned_to: normalized.assigned_to,
    company: normalized.company,
    opened_at: normalized.opened_at,
    resolved_at: normalized.resolved_at,
    closed_at: normalized.closed_at,
    sys_created_on: normalized.sys_created_on,
    sys_updated_on: normalized.sys_updated_on,
    correlation_id: normalized.correlation_id,
    u_hostname_zabbix: normalized.u_hostname_zabbix,
    u_ip_zabbix: normalized.u_ip_zabbix,
    zabbix_event_id: normalized.zabbix_event_id,
    zabbix_host: normalized.zabbix_host,
    zabbix_ip: normalized.zabbix_ip,
  };
}

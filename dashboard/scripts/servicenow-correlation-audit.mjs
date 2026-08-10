/**
 * SN-P0-04 — Auditoria de correlação Zabbix ↔ ServiceNow (somente GET).
 * Sem frontend/DB/deploy. Nunca imprime senha/token.
 *
 * Query fixa:
 *   contact_type=monitoring^caller_id=aa62f29f47477610082e3d02e26d4358
 *
 * Uso:
 *   node scripts/servicenow-correlation-audit.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getServiceNowConfig,
  sanitizeServiceNowError,
  serviceNowGetAll,
  ServiceNowClientError,
} from "../api/_lib/servicenow-client.js";
import {
  extractServiceNowDisplay,
  extractServiceNowValue,
} from "../api/_lib/servicenow-normalize.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const ZABBIX_CALLER_ID = "aa62f29f47477610082e3d02e26d4358";
const QUERY = `contact_type=monitoring^caller_id=${ZABBIX_CALLER_ID}`;
const MAX_RECORDS = 500;
const RECENT_EXAMPLES = 10;

const AUDIT_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "caller_id",
  "contact_type",
  "company",
  "opened_at",
  "sys_updated_on",
  "correlation_id",
  "origin_id",
  "u_hostname_zabbix",
  "u_ip_zabbix",
].join(",");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

function hostOnly(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

function filled(value) {
  const text = extractServiceNowValue(value);
  return Boolean(text);
}

function pct(count, total) {
  if (!total) return 0;
  return Number(((count / total) * 100).toFixed(1));
}

function truncate(value, max = 160) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textOf(raw) {
  return extractServiceNowValue(raw) || extractServiceNowDisplay(raw) || "";
}

/** Detectores de correlacionáveis em texto livre. */
const DETECTORS = [
  {
    key: "host",
    label: "host",
    test: (text) => /\bhost(?:name)?\b/i.test(text)
      || /\bHOST-[A-Z0-9._-]+\b/.test(text)
      || /\[[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\]/i.test(text),
  },
  {
    key: "eventid",
    label: "eventid",
    test: (text) => /\bevent[\s_-]?id\b/i.test(text)
      || /\beventid\s*[:=]\s*\d+/i.test(text)
      || /\bevent\s*[#:]?\s*\d{5,}\b/i.test(text),
  },
  {
    key: "trigger_or_event",
    label: "trigger/event",
    test: (text) => /\btrigger\b/i.test(text)
      || /\bevent\b/i.test(text)
      || /\[PROBLEM\]|\[RESOLVED\]|\[OK\]/i.test(text),
  },
  {
    key: "zabbix_problem_id",
    label: "Zabbix problem id",
    test: (text) => /\bproblem[\s_-]?id\b/i.test(text)
      || /\bzabbix[\s_-]?problem\b/i.test(text)
      || /\bproblem\s*[#:]?\s*\d{5,}\b/i.test(text),
  },
  {
    key: "ip",
    label: "IP",
    test: (text) => /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)
      || /\bip(?:v4)?\s*[:=]/i.test(text),
  },
];

const SHORT_DESC_PATTERNS = [
  {
    key: "emoji_problem",
    label: "🔴[PROBLEM] …",
    test: (text) => /🔴\s*\[PROBLEM\]/i.test(text) || /^\[PROBLEM\]/i.test(text),
  },
  {
    key: "emoji_resolved",
    label: "🟢/🔄[RESOLVED] …",
    test: (text) => /[🟢🔄]\s*\[RESOLVED\]/i.test(text) || /^\[RESOLVED\]/i.test(text),
  },
  {
    key: "icmp_ping",
    label: "ICMP ping / Unavailable",
    test: (text) => /ICMP|Unavailable by ICMP/i.test(text),
  },
  {
    key: "meraki_status",
    label: "Meraki status",
    test: (text) => /Meraki/i.test(text),
  },
  {
    key: "cisco_ios",
    label: "Cisco IOS",
    test: (text) => /Cisco IOS/i.test(text),
  },
  {
    key: "bracket_site_code",
    label: "Código entre colchetes [XXXX-XXXX-XXXX]",
    test: (text) => /\[[A-Z0-9]{3,}-[A-Z0-9]{3,}-[A-Z0-9]{3,}\]/i.test(text),
  },
  {
    key: "customer_prefix",
    label: "Prefixo cliente (SANEPAR/PROTEGE/…)",
    test: (text) => /\b(SANEPAR|PROTEGE|SESI|HAVAN|FRAPORT|COPEL)\b/i.test(text),
  },
];

function tallyPatterns(texts, patterns) {
  const counts = Object.fromEntries(patterns.map((item) => [item.key, 0]));
  for (const text of texts) {
    for (const pattern of patterns) {
      if (pattern.test(text)) counts[pattern.key] += 1;
    }
  }
  return patterns.map((pattern) => ({
    key: pattern.key,
    label: pattern.label,
    count: counts[pattern.key],
    pct: pct(counts[pattern.key], texts.length),
  })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function scanFieldsForSignals(records) {
  const fieldNames = [
    "short_description",
    "description",
    "correlation_id",
    "origin_id",
    "u_hostname_zabbix",
    "u_ip_zabbix",
    "number",
  ];

  const report = {};
  for (const detector of DETECTORS) {
    report[detector.key] = {
      label: detector.label,
      fields: {},
      any_field_count: 0,
      any_field_pct: 0,
    };
    for (const field of fieldNames) {
      report[detector.key].fields[field] = { count: 0, pct: 0, examples: [] };
    }
  }

  for (const raw of records) {
    const matchedDetectors = new Set();
    for (const field of fieldNames) {
      const text = textOf(raw?.[field]);
      if (!text) continue;
      for (const detector of DETECTORS) {
        if (!detector.test(text)) continue;
        const bucket = report[detector.key].fields[field];
        bucket.count += 1;
        if (bucket.examples.length < 3) {
          bucket.examples.push({
            number: extractServiceNowValue(raw?.number),
            snippet: truncate(text, 100),
          });
        }
        matchedDetectors.add(detector.key);
      }
    }
    for (const key of matchedDetectors) {
      report[key].any_field_count += 1;
    }
  }

  const total = records.length;
  for (const detector of DETECTORS) {
    const entry = report[detector.key];
    entry.any_field_pct = pct(entry.any_field_count, total);
    for (const field of fieldNames) {
      entry.fields[field].pct = pct(entry.fields[field].count, total);
    }
  }

  return report;
}

function sanitizeExample(raw) {
  return {
    number: extractServiceNowValue(raw?.number),
    short_description: truncate(textOf(raw?.short_description), 140),
    description: truncate(textOf(raw?.description), 160),
    state: extractServiceNowValue(raw?.state),
    priority: extractServiceNowValue(raw?.priority),
    company: extractServiceNowDisplay(raw?.company) || extractServiceNowValue(raw?.company),
    opened_at: extractServiceNowValue(raw?.opened_at),
    sys_updated_on: extractServiceNowValue(raw?.sys_updated_on),
    correlation_id: extractServiceNowValue(raw?.correlation_id),
    origin_id: extractServiceNowValue(raw?.origin_id),
    u_hostname_zabbix: extractServiceNowValue(raw?.u_hostname_zabbix),
    u_ip_zabbix: extractServiceNowValue(raw?.u_ip_zabbix),
  };
}

async function main() {
  const config = getServiceNowConfig();
  if (!config.configured) {
    console.error(JSON.stringify({
      event: "servicenow_correlation_audit_failed",
      error: "servicenow_not_configured",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const orderedQuery = `${QUERY}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`;
  const startedAt = Date.now();
  let pageResult;

  try {
    pageResult = await serviceNowGetAll("incident", {
      config,
      sysparm_query: orderedQuery,
      sysparm_fields: AUDIT_FIELDS,
      sysparm_limit: 100,
      sysparm_display_value: "all",
      sysparm_exclude_reference_link: "true",
      maxRecords: MAX_RECORDS,
    });
  } catch (error) {
    const code = error instanceof ServiceNowClientError
      ? error.code
      : sanitizeServiceNowError(error);
    console.error(JSON.stringify({
      event: "servicenow_correlation_audit_failed",
      error: code,
      status: error?.status ?? null,
      query: QUERY,
      duration_ms: Date.now() - startedAt,
      base_host: hostOnly(config.baseUrl),
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const records = pageResult.records || [];
  const total = records.length;

  const withHostname = records.filter((item) => filled(item.u_hostname_zabbix)).length;
  const withIp = records.filter((item) => filled(item.u_ip_zabbix)).length;
  const withCorrelation = records.filter((item) => filled(item.correlation_id)).length;
  const withOrigin = records.filter((item) => filled(item.origin_id)).length;

  const shortTexts = records.map((item) => textOf(item.short_description)).filter(Boolean);
  const descriptionTexts = records.map((item) => textOf(item.description)).filter(Boolean);

  const report = {
    event: "servicenow_correlation_audit_sn_p0_04",
    mode: "read_only_get",
    base_host: hostOnly(config.baseUrl),
    query: QUERY,
    caller_id: ZABBIX_CALLER_ID,
    caller_display: "zabbix monitoring",
    sample_size: total,
    x_total_count: pageResult.totalCount,
    truncated: pageResult.truncated,
    paginas_consultadas: pageResult.pages,
    duration_ms: Date.now() - startedAt,
    preenchimento: {
      u_hostname_zabbix: { count: withHostname, pct: pct(withHostname, total) },
      u_ip_zabbix: { count: withIp, pct: pct(withIp, total) },
      correlation_id: { count: withCorrelation, pct: pct(withCorrelation, total) },
      origin_id: { count: withOrigin, pct: pct(withOrigin, total) },
    },
    padroes: {
      short_description: {
        non_empty: shortTexts.length,
        patterns: tallyPatterns(shortTexts, SHORT_DESC_PATTERNS),
      },
      description: {
        non_empty: descriptionTexts.length,
        patterns: tallyPatterns(descriptionTexts, SHORT_DESC_PATTERNS),
        avg_length: descriptionTexts.length
          ? Math.round(descriptionTexts.reduce((sum, text) => sum + text.length, 0) / descriptionTexts.length)
          : 0,
      },
    },
    sinais_em_campos: scanFieldsForSignals(records),
    exemplos_recentes_sanitizados: records.slice(0, RECENT_EXAMPLES).map((item) => sanitizeExample(item)),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: "servicenow_correlation_audit_failed",
    error: sanitizeServiceNowError(error),
  }, null, 2));
  process.exitCode = 1;
});

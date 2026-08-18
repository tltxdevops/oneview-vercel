/**
 * OV-P0-50 — Auditoria drawer (somente leitura).
 * Compara banco → BFF (mapAlertRows/detail) → apresentação do drawer.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import pg from "pg";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const { getOneViewDbConfig } = require("../api/_lib/oneview-db.js");
const { fetchOneViewDatabase } = require("../api/_lib/oneview-db.js");
const { getOneViewConfig } = require("../api/_lib/oneview-config.js");

const UNCLASSIFIED_LABEL = "Cliente não classificado";
const MISSING_HOST = "Host não informado";

function ssl() {
  return process.env.ONEVIEW_DB_SSL_REJECT_UNAUTHORIZED === "false"
    ? { rejectUnauthorized: false }
    : true;
}

function nfd(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isDatasourceLike(normalized) {
  if (!normalized) return false;
  return (
    normalized === "teletex-http"
    || normalized.includes("datasource")
    || /(^|[\s_-])http($|[\s_-])/.test(normalized)
    || normalized.endsWith("-http")
  );
}

function isPlaceholderClient(normalized) {
  if (!normalized) return true;
  return [
    "unclassified",
    "cliente-nao-classificado",
    "cliente nao classificado",
    "cliente nao identificado",
    "sem classificacao",
  ].includes(normalized);
}

function isUnclassifiedClient(customer) {
  const name = String(customer?.name || "").trim();
  const key = String(customer?.key || "").trim();
  const source = String(customer?.source || "").trim().toLowerCase();
  const nn = nfd(name);
  const nk = nfd(key);
  if (name && !isPlaceholderClient(nn) && !isDatasourceLike(nn)) return false;
  if (key && !isPlaceholderClient(nk) && !isDatasourceLike(nk)) return false;
  if (source === "datasource_fallback") return true;
  if (isPlaceholderClient(nk) || isPlaceholderClient(nn)) return true;
  if (isDatasourceLike(nn) || isDatasourceLike(nk)) return true;
  return !nn && !nk;
}

function canonicalClientName(customer) {
  if (isUnclassifiedClient(customer)) return UNCLASSIFIED_LABEL;
  const name = String(customer?.name || "").trim();
  const key = String(customer?.key || "").trim();
  if (name && !isPlaceholderClient(nfd(name)) && !isDatasourceLike(nfd(name))) return name;
  if (key && !isPlaceholderClient(nfd(key)) && !isDatasourceLike(nfd(key))) return key;
  return UNCLASSIFIED_LABEL;
}

function isMissingHost(value) {
  const text = String(value || "").trim();
  if (!text || text === "-" || /^host$/i.test(text)) return true;
  if (/^host protegido\b/i.test(text)) return true;
  const normalized = nfd(text);
  return ["host nao informado", "host nao identificado", "host nao disponivel"].includes(normalized);
}

function canonicalHostName(host) {
  for (const candidate of [host?.host_visible_name, host?.host_technical_name, host?.host_name]) {
    const value = String(candidate || "").trim();
    if (value && !isMissingHost(value)) return value;
  }
  return MISSING_HOST;
}

function safeHostIp(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || ["-", "[redacted]", "[ip_protegido]"].includes(candidate.toLowerCase())) return null;
  const ipv4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return null;
    const [first, second] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224) return null;
    if (first === 100 && second >= 64 && second <= 127) return null;
    if (first === 169 && second === 254) return null;
    if (first === 172 && second >= 16 && second <= 31) return null;
    if (first === 192 && second === 168) return null;
    return candidate;
  }
  return null;
}

function interfaceFromTags(alert) {
  const tags = [...(alert.event_tags ?? []), ...(alert.trigger_tags ?? []), ...(alert.host_tags ?? [])];
  for (const tag of tags) {
    const name = String(tag.tag || "").trim().toLowerCase();
    const value = String(tag.value || "").trim();
    if (!value) continue;
    if (name === "interface" || name === "if" || name === "ifname" || name === "net.if") return value;
  }
  return null;
}

function isResolved(alert) {
  const sourceStatus = String(alert.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert.status_internal || "").trim().toLowerCase();
  return Boolean(alert.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

function drawerView(bffItem) {
  const customer = {
    key: bffItem.customer_key,
    name: bffItem.customer_name,
    source: bffItem.customer_source,
  };
  const unclassified = isUnclassifiedClient(customer);
  return {
    customer_name_display: canonicalClientName(customer),
    customer_name_raw: bffItem.customer_name,
    customer_source: bffItem.customer_source,
    customer_confidence: bffItem.customer_confidence,
    unclassified,
    classification_pending: unclassified ? "Classificação ainda não determinada" : null,
    host: canonicalHostName(bffItem),
    host_visible_name: bffItem.host_visible_name,
    host_technical_name: bffItem.host_technical_name,
    host_name: bffItem.host_name,
    severity: bffItem.severity,
    status: isResolved(bffItem) ? "Resolvido" : "Ativo",
    ack: bffItem.acknowledged_source ? "ACK" : "ACK pendente",
    problem: String(bffItem.problem_name || "").trim() || "Alerta sem descrição",
    first_seen_at: bffItem.first_seen_at,
    last_seen_at: bffItem.last_seen_at,
    resolved_at: bffItem.resolved_at,
    duration_seconds: bffItem.duration_seconds,
    ip: safeHostIp(bffItem.host_ip),
    interface: interfaceFromTags(bffItem),
  };
}

function expectedDbHost(row) {
  for (const candidate of [row.host_visible_name, row.host_technical_name, row.host_name]) {
    const value = String(candidate || "").trim();
    if (value && !isMissingHost(value)) return value;
  }
  return MISSING_HOST;
}

function dbIsUnclassified(row) {
  return isUnclassifiedClient({
    key: row.customer_key,
    name: row.customer_name,
    source: row.customer_source,
  });
}

function pushDiv(list, alertId, field, detail) {
  list.push({ alert_id: alertId, field, ...detail });
}

function hasBadPrimitive(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (value === "undefined" || value === "NaN") return String(value);
  return null;
}

async function selectSample(client) {
  const base = `
    from alerts a
    join data_sources d on d.id = a.data_source_id
   where lower(d.name) = 'teletex-http'
  `;
  const classifiedSql = `
    not (
      a.customer_name is null or btrim(a.customer_name) = ''
      or lower(btrim(a.customer_name)) in ('cliente não classificado','cliente nao classificado','cliente não identificado','cliente nao identificado','unclassified','teletex-http')
      or lower(coalesce(a.customer_source,'')) = 'datasource_fallback'
      or lower(coalesce(a.customer_key,'')) in ('unclassified','cliente-nao-classificado')
    )
  `;
  const unclassifiedSql = `
    (
      a.customer_name is null or btrim(a.customer_name) = ''
      or lower(btrim(a.customer_name)) in ('cliente não classificado','cliente nao classificado','cliente não identificado','cliente nao identificado','unclassified','teletex-http')
      or lower(coalesce(a.customer_source,'')) = 'datasource_fallback'
      or lower(coalesce(a.customer_key,'')) in ('unclassified','cliente-nao-classificado')
    )
  `;
  const activeSql = `
    a.resolved_at is null
    and lower(coalesce(a.status_source,'active')) = 'active'
    and lower(coalesce(a.status_internal,'')) not in ('resolved','normalized')
  `;
  const resolvedSql = `
    a.resolved_at is not null
    or lower(coalesce(a.status_source,'')) = 'resolved'
    or lower(coalesce(a.status_internal,'')) in ('resolved','normalized')
  `;

  const picks = [];

  // 5 classified customers (distinct)
  const classified = await client.query(`
    select distinct on (a.customer_key)
      a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
      a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
      a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
      a.problem_name, a.severity, a.status_source, a.status_internal,
      a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
    ${base}
      and ${classifiedSql}
      and a.customer_key is not null
    order by a.customer_key, a.last_seen_at desc
    limit 5
  `);
  picks.push(...classified.rows.map((r) => ({ ...r, bucket: "classified" })));

  // 3 real unclassified
  const unclassified = await client.query(`
    select
      a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
      a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
      a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
      a.problem_name, a.severity, a.status_source, a.status_internal,
      a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
    ${base}
      and ${unclassifiedSql}
    order by a.last_seen_at desc
    limit 3
  `);
  picks.push(...unclassified.rows.map((r) => ({ ...r, bucket: "unclassified" })));

  // severities Information/Warning/Average/High (prefer missing ones)
  for (const severity of ["information", "warning", "average", "high"]) {
    if (picks.some((p) => String(p.severity).toLowerCase() === severity)) continue;
    const { rows } = await client.query(`
      select
        a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
        a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
        a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
        a.problem_name, a.severity, a.status_source, a.status_internal,
        a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
      ${base}
        and lower(a.severity) = $1
      order by a.last_seen_at desc
      limit 1
    `, [severity]);
    if (rows[0]) picks.push({ ...rows[0], bucket: `severity:${severity}` });
  }

  // active + resolved coverage
  if (!picks.some((p) => !p.resolved_at)) {
    const { rows } = await client.query(`
      select a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
             a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
             a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
             a.problem_name, a.severity, a.status_source, a.status_internal,
             a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
      ${base} and ${activeSql}
      order by a.last_seen_at desc limit 1
    `);
    if (rows[0]) picks.push({ ...rows[0], bucket: "active" });
  }
  if (!picks.some((p) => p.resolved_at)) {
    const { rows } = await client.query(`
      select a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
             a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
             a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
             a.problem_name, a.severity, a.status_source, a.status_internal,
             a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
      ${base} and (${resolvedSql})
      order by a.resolved_at desc nulls last limit 1
    `);
    if (rows[0]) picks.push({ ...rows[0], bucket: "resolved" });
  }

  // ACK / no ACK
  if (!picks.some((p) => p.acknowledged_source === true)) {
    const { rows } = await client.query(`
      select a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
             a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
             a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
             a.problem_name, a.severity, a.status_source, a.status_internal,
             a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
      ${base} and a.acknowledged_source = true
      order by a.last_seen_at desc limit 1
    `);
    if (rows[0]) picks.push({ ...rows[0], bucket: "ack" });
  }
  if (!picks.some((p) => p.acknowledged_source === false)) {
    const { rows } = await client.query(`
      select a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
             a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
             a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
             a.problem_name, a.severity, a.status_source, a.status_internal,
             a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
      ${base} and coalesce(a.acknowledged_source,false) = false
      order by a.last_seen_at desc limit 1
    `);
    if (rows[0]) picks.push({ ...rows[0], bucket: "no-ack" });
  }

  // with / without public IP (DB column; BFF may null)
  if (!picks.some((p) => safeHostIp(p.host_ip))) {
    const { rows } = await client.query(`
      select a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
             a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
             a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
             a.problem_name, a.severity, a.status_source, a.status_internal,
             a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
      ${base}
        and a.host_ip is not null and btrim(a.host_ip) <> ''
        and a.host_ip !~ '^(10\\.|127\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.)'
      order by a.last_seen_at desc limit 1
    `);
    if (rows[0]) picks.push({ ...rows[0], bucket: "with-ip" });
  }
  if (!picks.some((p) => !safeHostIp(p.host_ip))) {
    const { rows } = await client.query(`
      select a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
             a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
             a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
             a.problem_name, a.severity, a.status_source, a.status_internal,
             a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
      ${base} and (a.host_ip is null or btrim(a.host_ip) = '')
      order by a.last_seen_at desc limit 1
    `);
    if (rows[0]) picks.push({ ...rows[0], bucket: "no-ip" });
  }

  // interface tag if any
  if (!picks.some((p) => interfaceFromTags(p))) {
    const { rows } = await client.query(`
      select a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
             a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
             a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
             a.problem_name, a.severity, a.status_source, a.status_internal,
             a.acknowledged_source, a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
      ${base}
        and (
          exists (select 1 from jsonb_array_elements(coalesce(a.event_tags,'[]'::jsonb)) t where lower(coalesce(t->>'tag','')) in ('interface','if','ifname','net.if') and btrim(coalesce(t->>'value','')) <> '')
          or exists (select 1 from jsonb_array_elements(coalesce(a.trigger_tags,'[]'::jsonb)) t where lower(coalesce(t->>'tag','')) in ('interface','if','ifname','net.if') and btrim(coalesce(t->>'value','')) <> '')
          or exists (select 1 from jsonb_array_elements(coalesce(a.host_tags,'[]'::jsonb)) t where lower(coalesce(t->>'tag','')) in ('interface','if','ifname','net.if') and btrim(coalesce(t->>'value','')) <> '')
        )
      order by a.last_seen_at desc limit 1
    `);
    if (rows[0]) picks.push({ ...rows[0], bucket: "with-interface" });
  }

  // dedupe by id
  const seen = new Set();
  const unique = [];
  for (const row of picks) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    unique.push(row);
  }
  return unique;
}

async function fetchBffDetail(alertId) {
  const config = getOneViewConfig(process.env);
  const req = {
    method: "GET",
    query: { id: alertId },
    headers: {},
  };
  const payload = await fetchOneViewDatabase("alert-detail", req, config);
  return payload?.item ?? null;
}

function compareAlert(dbRow, bffItem) {
  const divergences = [];
  const proofs = [];
  const drawer = drawerView(bffItem);
  const id = dbRow.id;

  // proofs
  if (drawer.customer_name_display === "teletex-http" || isDatasourceLike(nfd(drawer.customer_name_display))) {
    pushDiv(divergences, id, "customer_name", {
      kind: "datasource_as_client",
      db: dbRow.customer_name,
      bff: bffItem.customer_name,
      drawer: drawer.customer_name_display,
    });
  } else {
    proofs.push("datasource_not_client");
  }

  if (dbIsUnclassified(dbRow)) {
    if (!drawer.unclassified || drawer.customer_name_display !== UNCLASSIFIED_LABEL) {
      pushDiv(divergences, id, "customer_name", {
        kind: "unclassified_not_preserved",
        db: { name: dbRow.customer_name, key: dbRow.customer_key, source: dbRow.customer_source },
        bff: { name: bffItem.customer_name, key: bffItem.customer_key, source: bffItem.customer_source },
        drawer: drawer.customer_name_display,
      });
    } else {
      proofs.push("unclassified_preserved");
    }
  }

  // frontend inference: drawer client must come only from customer_* fields
  const inferredFromHost = nfd(drawer.customer_name_display) === nfd(dbRow.host_visible_name)
    || nfd(drawer.customer_name_display) === nfd(dbRow.host_name);
  if (
    drawer.unclassified === false
    && inferredFromHost
    && nfd(drawer.customer_name_display) !== nfd(dbRow.customer_name)
    && nfd(drawer.customer_name_display) !== nfd(dbRow.customer_key)
  ) {
    pushDiv(divergences, id, "customer_name", {
      kind: "frontend_inferred_from_host",
      drawer: drawer.customer_name_display,
      db_customer: dbRow.customer_name,
      host: dbRow.host_visible_name || dbRow.host_name,
    });
  } else {
    proofs.push("no_frontend_client_inference");
  }

  // host cascade
  const expectedHost = expectedDbHost(dbRow);
  // BFF may alias host_name; drawer must prefer visible/technical
  if (drawer.host !== expectedHost) {
    // Allow if DB host_name was private and visible/technical empty → BFF aliases host_name
    const dbOnlyRawHost = !dbRow.host_visible_name && !dbRow.host_technical_name && dbRow.host_name;
    if (dbOnlyRawHost && /^Host protegido\b/i.test(String(bffItem.host_name || ""))) {
      // drawer should treat Host protegido as missing and fall through — isMissingHost true
      if (drawer.host !== MISSING_HOST && drawer.host !== bffItem.host_name) {
        pushDiv(divergences, id, "host", {
          kind: "host_cascade_mismatch",
          expected: expectedHost,
          drawer: drawer.host,
          bff: {
            visible: bffItem.host_visible_name,
            technical: bffItem.host_technical_name,
            host_name: bffItem.host_name,
          },
        });
      } else {
        proofs.push("host_cascade_ok_aliased");
      }
    } else {
      pushDiv(divergences, id, "host", {
        kind: "host_cascade_mismatch",
        expected: expectedHost,
        drawer: drawer.host,
        bff: {
          visible: bffItem.host_visible_name,
          technical: bffItem.host_technical_name,
          host_name: bffItem.host_name,
        },
      });
    }
  } else {
    proofs.push("host_cascade_ok");
  }

  // severity / status / ack / problem
  if (String(bffItem.severity || "").toLowerCase() !== String(dbRow.severity || "").toLowerCase()) {
    pushDiv(divergences, id, "severity", { db: dbRow.severity, bff: bffItem.severity, drawer: drawer.severity });
  }
  const dbResolved = Boolean(dbRow.resolved_at)
    || String(dbRow.status_source || "").toLowerCase() === "resolved"
    || ["resolved", "normalized"].includes(String(dbRow.status_internal || "").toLowerCase());
  if ((drawer.status === "Resolvido") !== dbResolved) {
    pushDiv(divergences, id, "status", {
      db: { resolved_at: dbRow.resolved_at, status_source: dbRow.status_source, status_internal: dbRow.status_internal },
      drawer: drawer.status,
    });
  }
  if (Boolean(bffItem.acknowledged_source) !== Boolean(dbRow.acknowledged_source)) {
    pushDiv(divergences, id, "ack", { db: dbRow.acknowledged_source, bff: bffItem.acknowledged_source, drawer: drawer.ack });
  }
  if (String(bffItem.problem_name || "").includes("undefined") || drawer.problem.includes("undefined")) {
    pushDiv(divergences, id, "problem", { kind: "undefined_in_problem", bff: bffItem.problem_name, drawer: drawer.problem });
  }

  // timestamps / duration — compare presence and NaN, allow ISO formatting diffs
  for (const field of ["first_seen_at", "last_seen_at", "resolved_at"]) {
    const dbVal = dbRow[field] ? new Date(dbRow[field]).getTime() : null;
    const bffVal = bffItem[field] ? new Date(bffItem[field]).getTime() : null;
    if ((dbVal == null) !== (bffVal == null)) {
      pushDiv(divergences, id, field, { db: dbRow[field], bff: bffItem[field] });
    } else if (dbVal != null && bffVal != null && Math.abs(dbVal - bffVal) > 1000) {
      pushDiv(divergences, id, field, { kind: "timestamp_skew", db: dbRow[field], bff: bffItem[field] });
    }
  }
  const dbDur = Number(dbRow.duration_seconds);
  const bffDur = Number(bffItem.duration_seconds);
  if (!Number.isFinite(bffDur) || Number.isNaN(bffDur)) {
    pushDiv(divergences, id, "duration", { kind: "nan", db: dbRow.duration_seconds, bff: bffItem.duration_seconds });
  } else if (Number.isFinite(dbDur) && Math.abs(dbDur - bffDur) > 1) {
    // duration can drift for active alerts; only flag large gaps if both resolved
    if (dbResolved) {
      pushDiv(divergences, id, "duration", { db: dbDur, bff: bffDur });
    }
  }

  // customer_source / confidence pass-through (BFF may keep source even when name nulled)
  if (String(bffItem.customer_source || "") !== String(dbRow.customer_source || "")) {
    // allow null vs empty
    if (String(bffItem.customer_source || "").trim() !== String(dbRow.customer_source || "").trim()) {
      pushDiv(divergences, id, "customer_source", { db: dbRow.customer_source, bff: bffItem.customer_source });
    }
  }
  if (String(bffItem.customer_confidence || "").trim() !== String(dbRow.customer_confidence || "").trim()) {
    pushDiv(divergences, id, "customer_confidence", { db: dbRow.customer_confidence, bff: bffItem.customer_confidence });
  }

  // classified customer_name: BFF should keep real name
  if (!dbIsUnclassified(dbRow)) {
    if (String(bffItem.customer_name || "").trim() !== String(dbRow.customer_name || "").trim()) {
      pushDiv(divergences, id, "customer_name", {
        kind: "classified_name_mismatch",
        db: dbRow.customer_name,
        bff: bffItem.customer_name,
        drawer: drawer.customer_name_display,
      });
    }
    if (drawer.customer_name_display !== String(dbRow.customer_name || "").trim()
      && drawer.customer_name_display !== String(dbRow.customer_key || "").trim()) {
      pushDiv(divergences, id, "customer_name", {
        kind: "drawer_display_mismatch",
        db: dbRow.customer_name,
        drawer: drawer.customer_name_display,
      });
    }
  }

  // IP/interface: contract currently forces BFF host_ip=null
  const dbIp = safeHostIp(dbRow.host_ip);
  if (dbIp && bffItem.host_ip !== null && bffItem.host_ip !== undefined && safeHostIp(bffItem.host_ip) !== dbIp) {
    pushDiv(divergences, id, "ip", { db: dbIp, bff: bffItem.host_ip, drawer: drawer.ip });
  }
  if (dbIp && bffItem.host_ip == null && drawer.ip != null) {
    pushDiv(divergences, id, "ip", { kind: "drawer_invented_ip", db: dbIp, bff: null, drawer: drawer.ip });
  }
  // intentional contract note tracked separately, not as fixable divergence unless drawer invents

  const dbIface = interfaceFromTags(dbRow);
  const bffIface = interfaceFromTags(bffItem);
  if (dbIface && bffIface && dbIface !== bffIface) {
    pushDiv(divergences, id, "interface", { db: dbIface, bff: bffIface, drawer: drawer.interface });
  }
  if (dbIface && !bffIface && drawer.interface) {
    pushDiv(divergences, id, "interface", { kind: "drawer_invented_interface", drawer: drawer.interface });
  }

  // undefined/NaN scan on drawer outputs
  for (const [key, value] of Object.entries(drawer)) {
    const bad = hasBadPrimitive(value);
    if (bad) pushDiv(divergences, id, key, { kind: "bad_primitive", value: bad, raw: value });
    if (typeof value === "string" && /\b(undefined|NaN)\b/.test(value)) {
      pushDiv(divergences, id, key, { kind: "bad_string_token", value });
    }
  }

  return { divergences, proofs, drawer, bucket: dbRow.bucket };
}

async function main() {
  const client = new pg.Client({
    host: process.env.ONEVIEW_DB_HOST,
    port: Number(process.env.ONEVIEW_DB_PORT || 443),
    database: process.env.ONEVIEW_DB_NAME,
    user: process.env.ONEVIEW_DB_USER,
    password: process.env.POSTGRES_READONLY_PASSWORD,
    ssl: ssl(),
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
  });
  await client.connect();

  const sample = await selectSample(client);
  const coverage = {
    classified_customers: new Set(sample.filter((s) => s.bucket === "classified").map((s) => s.customer_key)).size,
    unclassified: sample.filter((s) => s.bucket === "unclassified" || dbIsUnclassified(s)).length,
    severities: [...new Set(sample.map((s) => String(s.severity || "").toLowerCase()))],
    active: sample.filter((s) => !s.resolved_at).length,
    resolved: sample.filter((s) => s.resolved_at).length,
    with_ack: sample.filter((s) => s.acknowledged_source).length,
    without_ack: sample.filter((s) => !s.acknowledged_source).length,
    db_public_ip: sample.filter((s) => safeHostIp(s.host_ip)).length,
    db_no_public_ip: sample.filter((s) => !safeHostIp(s.host_ip)).length,
    with_interface_tag: sample.filter((s) => interfaceFromTags(s)).length,
    sample_size: sample.length,
  };

  const allDivergences = [];
  const intentional = [];
  const rows = [];

  for (const dbRow of sample) {
    const bffItem = await fetchBffDetail(dbRow.id);
    if (!bffItem) {
      allDivergences.push({ alert_id: dbRow.id, field: "bff", kind: "missing_detail" });
      continue;
    }
    const result = compareAlert(dbRow, bffItem);

    // intentional contract: DB IP present, BFF always null
    const dbIp = safeHostIp(dbRow.host_ip);
    if (dbIp && bffItem.host_ip == null) {
      intentional.push({
        alert_id: dbRow.id,
        field: "ip",
        kind: "contract_host_ip_always_null",
        db: dbIp,
        bff: null,
        drawer: result.drawer.ip,
      });
    }

    // intentional: BFF nulls unclassified customer_name
    if (dbIsUnclassified(dbRow) && bffItem.customer_name == null && result.drawer.customer_name_display === UNCLASSIFIED_LABEL) {
      intentional.push({
        alert_id: dbRow.id,
        field: "customer_name",
        kind: "bff_nulls_unclassified_name_drawer_label_ok",
        db: dbRow.customer_name,
        bff: bffItem.customer_name,
        drawer: result.drawer.customer_name_display,
      });
    }

    allDivergences.push(...result.divergences);
    rows.push({
      id: dbRow.id,
      bucket: dbRow.bucket,
      customer_db: dbRow.customer_name,
      customer_drawer: result.drawer.customer_name_display,
      host_drawer: result.drawer.host,
      severity: dbRow.severity,
      ack: dbRow.acknowledged_source,
      resolved: Boolean(dbRow.resolved_at),
      proofs: result.proofs,
    });
  }

  await client.end();

  // Filter intentional from actionable divergences (already separate)
  const actionable = allDivergences.filter((d) => d.kind !== "contract_host_ip_always_null");

  console.log(JSON.stringify({
    ok: actionable.length === 0,
    coverage,
    sample: rows,
    divergences: actionable,
    intentional_contract_notes: intentional,
  }, null, 2));

  process.exit(actionable.length ? 1 : 0);
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    error: String(error?.message || error),
    code: error?.code || null,
    stack: String(error?.stack || "").split("\n").slice(0, 8),
  }, null, 2));
  process.exit(2);
});

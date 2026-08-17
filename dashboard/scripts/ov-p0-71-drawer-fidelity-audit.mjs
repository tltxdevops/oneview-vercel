/**
 * OV-P0-71 — Drawer Fidelity Final (somente leitura).
 * Amostra 30 alertas reais → BFF alert-detail → espelho do drawer (AlertOperationalSummary + ACK).
 *
 * Uso: node scripts/ov-p0-71-drawer-fidelity-audit.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import pg from "pg";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const { fetchOneViewDatabase } = require("../api/_lib/oneview-db.js");
const { getOneViewConfig } = require("../api/_lib/oneview-config.js");

const UNCLASSIFIED_LABEL = "Cliente não classificado";
const UNKNOWN_SCOPE_LABEL = "Cliente não identificado";
const PLATFORM_SCOPE_LABEL = "Infraestrutura de monitoramento";
const TEST_SCOPE_LABEL = "Ambiente de teste";
const MISSING_HOST = "Host não informado";
const CLASSIFICATION_PENDING = "Classificação ainda não determinada";

const TARGET_CUSTOMERS = [
  "sanepar",
  "prefosasco",
  "osasco",
  "unicap",
  "protege",
  "nissan",
  "havan",
  "jfsc",
  "banrisul",
  "teletex",
];

const LOGO_ALIASES = {
  sanepar: true,
  osasco: true,
  prefosasco: true,
  unicap: true,
  protege: true,
  nissan: true,
  havan: true,
  teletex: true,
  // JFSC / Banrisul podem não ter logo no catálogo — reportar como coverage, não bug.
};

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

function normalizeScope(value) {
  const scope = String(value || "").trim().toLowerCase();
  if (scope === "customer" || scope === "platform" || scope === "test" || scope === "unknown") return scope;
  return null;
}

/** Mirror FE operationalClientLabel (HOTFIX-P0-CLIENT-LABEL). */
function operationalClientLabel(entity) {
  if (!isUnclassifiedClient(entity)) return canonicalClientName(entity);
  const scope = normalizeScope(entity?.operational_scope);
  const label = String(entity?.operational_scope_label || "").trim();
  if (scope === "platform") return label || PLATFORM_SCOPE_LABEL;
  if (scope === "test") return label || TEST_SCOPE_LABEL;
  if (scope === "unknown") return label || UNKNOWN_SCOPE_LABEL;
  if (label === PLATFORM_SCOPE_LABEL || label === TEST_SCOPE_LABEL || label === UNKNOWN_SCOPE_LABEL) return label;
  if (scope === "customer" && label) return label;
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
  if (!ipv4) return null;
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

function logoExpected(customer) {
  if (isUnclassifiedClient(customer)) return null;
  const normalized = nfd(`${customer.key || ""} ${customer.name || ""}`);
  for (const alias of Object.keys(LOGO_ALIASES)) {
    if (normalized.includes(alias)) return `/tltx/clientes/logos/*${alias}*`;
  }
  return null;
}

function hasLogoCatalogHit(customer) {
  if (isUnclassifiedClient(customer)) return false;
  const normalized = nfd(`${customer.key || ""} ${customer.name || ""}`);
  return Object.keys(LOGO_ALIASES).some((alias) => normalized.includes(alias));
}

function ackActor(bffItem) {
  const sourceAck = bffItem.source_ack;
  if (sourceAck?.acknowledged) {
    return {
      acknowledged: true,
      actor: sourceAck.actor_name || bffItem.acknowledged_source_by || null,
      at: sourceAck.acknowledged_at || bffItem.acknowledged_source_at || null,
      comment: sourceAck.comment || null,
    };
  }
  return {
    acknowledged: Boolean(bffItem.acknowledged_source),
    actor: bffItem.acknowledged_source_by || null,
    at: bffItem.acknowledged_source_at || null,
    comment: null,
  };
}

/** Espelho do drawer Alertas: AlertOperationalSummary + bloco Reconhecimento. */
function drawerView(bffItem) {
  const customer = {
    key: bffItem.customer_key,
    name: bffItem.customer_name,
    source: bffItem.customer_source,
    operational_scope: bffItem.operational_scope,
    operational_scope_label: bffItem.operational_scope_label,
  };
  const hasReal = !isUnclassifiedClient(customer);
  const scope = normalizeScope(bffItem.operational_scope);
  const clientName = operationalClientLabel(customer);
  const ack = ackActor(bffItem);
  return {
    customer: clientName,
    customer_raw: bffItem.customer_name,
    customer_key: bffItem.customer_key,
    logo: hasReal && hasLogoCatalogHit(customer),
    logo_expected: logoExpected(customer),
    host: canonicalHostName(bffItem),
    problem: String(bffItem.problem_name || "").trim() || "Alerta sem descrição",
    severity: String(bffItem.severity || "not_classified"),
    status: isResolved(bffItem) ? "Resolvido" : "Ativo",
    ack: ack.acknowledged ? "ACK" : "ACK pendente",
    ack_actor: ack.actor,
    ack_at: ack.at,
    first_seen_at: bffItem.first_seen_at ?? null,
    last_seen_at: bffItem.last_seen_at ?? null,
    resolved_at: bffItem.resolved_at ?? null,
    duration_seconds: bffItem.duration_seconds,
    ip: safeHostIp(bffItem.host_ip),
    interface: interfaceFromTags(bffItem),
    scope,
    scope_label: bffItem.operational_scope_label ?? null,
    classification_pending: scope === "unknown" || (!scope && !bffItem.customer_name)
      ? CLASSIFICATION_PENDING
      : null,
  };
}

function badPrimitive(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (value === "undefined" || value === "NaN") return String(value);
  return null;
}

function scanBad(obj, pathPrefix = "") {
  const hits = [];
  if (obj == null || typeof obj !== "object") {
    const bad = badPrimitive(obj);
    if (bad) hits.push({ path: pathPrefix || "(root)", bad });
    return hits;
  }
  for (const [key, value] of Object.entries(obj)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      hits.push(...scanBad(value, path));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => hits.push(...scanBad(item, `${path}[${index}]`)));
    } else {
      const bad = badPrimitive(value);
      if (bad) hits.push({ path, bad });
    }
  }
  return hits;
}

const SELECT_FIELDS = `
  a.id, a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
  a.host_name, a.host_visible_name, a.host_technical_name, a.host_ip,
  a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
  a.problem_name, a.severity, a.status_source, a.status_internal,
  a.acknowledged_source,
  a.acknowledged_by as acknowledged_source_by,
  a.acknowledged_at as acknowledged_source_at,
  a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds
`;

const BASE = `
  from alerts a
  join data_sources d on d.id = a.data_source_id
 where lower(d.name) = 'teletex-http'
`;

async function pickOne(client, sql, params = [], bucket) {
  const { rows } = await client.query(sql, params);
  return rows[0] ? { ...rows[0], bucket } : null;
}

async function selectSample(client) {
  const picks = [];
  const push = (row) => {
    if (!row) return;
    if (picks.some((p) => p.id === row.id)) return;
    picks.push(row);
  };

  for (const needle of TARGET_CUSTOMERS) {
    const row = await pickOne(
      client,
      `
      select ${SELECT_FIELDS}
      ${BASE}
        and (
          lower(coalesce(a.customer_key,'')) like $1
          or lower(coalesce(a.customer_name,'')) like $1
        )
      order by a.last_seen_at desc nulls last
      limit 1
      `,
      [`%${needle}%`],
      `customer:${needle}`,
    );
    push(row);
  }

  // platform / test / unknown — evidência alinhada a deriveOperationalScope (host_groups.name / host)
  const platformClause = `(
      coalesce(a.host_groups::text, '') ~* 'zabbix.?server'
      or coalesce(a.host_groups::text, '') ~* 'zabbix\\s*/\\s*proxies'
      or lower(coalesce(a.host_name,'')) ~* 'zabbix.?server'
      or lower(coalesce(a.host_visible_name,'')) ~* 'zabbix.?server'
      or lower(coalesce(a.host_technical_name,'')) ~* 'zabbix.?server'
    )`;
  const testClause = `(
      coalesce(a.host_groups::text, '') ~* 'tltx\\s*/\\s*testes'
      or coalesce(a.host_groups::text, '') ~* '(^|[^a-z])hml([^a-z]|$)'
      or coalesce(a.host_groups::text, '') ~* '(^|[^a-z])poc([^a-z]|$)'
    )`;
  const unknownCustomerClause = `(
      a.customer_name is null or btrim(a.customer_name) = ''
      or lower(btrim(a.customer_name)) in ('cliente não classificado','cliente nao classificado','cliente não identificado','cliente nao identificado','unclassified')
      or lower(coalesce(a.customer_source,'')) = 'datasource_fallback'
    )`;

  for (const [bucket, clause] of [
    ["scope:platform", platformClause],
    ["scope:test", testClause],
    // unknown sem evidência platform/test — senão cai no mesmo id do bucket platform
    ["scope:unknown", `(${unknownCustomerClause}) and not ${platformClause} and not ${testClause}`],
  ]) {
    const row = await pickOne(
      client,
      `select ${SELECT_FIELDS} ${BASE} and ${clause} order by a.last_seen_at desc nulls last limit 1`,
      [],
      bucket,
    );
    push(row);
  }

  for (const severity of ["information", "warning", "average", "high", "disaster", "not_classified"]) {
    if (picks.some((p) => String(p.severity).toLowerCase() === severity)) continue;
    push(await pickOne(
      client,
      `select ${SELECT_FIELDS} ${BASE} and lower(a.severity) = $1 order by a.last_seen_at desc nulls last limit 1`,
      [severity],
      `severity:${severity}`,
    ));
  }

  if (!picks.some((p) => p.acknowledged_source === true)) {
    push(await pickOne(
      client,
      `select ${SELECT_FIELDS} ${BASE} and a.acknowledged_source = true order by a.last_seen_at desc nulls last limit 1`,
      [],
      "ack",
    ));
  }
  if (!picks.some((p) => !p.acknowledged_source)) {
    push(await pickOne(
      client,
      `select ${SELECT_FIELDS} ${BASE} and coalesce(a.acknowledged_source,false) = false order by a.last_seen_at desc nulls last limit 1`,
      [],
      "no-ack",
    ));
  }

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
  if (!picks.some((p) => !p.resolved_at && String(p.status_source || "active").toLowerCase() === "active")) {
    push(await pickOne(
      client,
      `select ${SELECT_FIELDS} ${BASE} and ${activeSql} order by a.last_seen_at desc nulls last limit 1`,
      [],
      "active",
    ));
  }
  if (!picks.some((p) => p.resolved_at)) {
    push(await pickOne(
      client,
      `select ${SELECT_FIELDS} ${BASE} and (${resolvedSql}) order by a.resolved_at desc nulls last limit 1`,
      [],
      "resolved",
    ));
  }

  // Fill to 30 with recent classified / diverse
  while (picks.length < 30) {
    const exclude = picks.map((p) => String(p.id));
    const row = await pickOne(
      client,
      `
      select ${SELECT_FIELDS}
      ${BASE}
        and a.id::text <> all($1::text[])
      order by a.last_seen_at desc nulls last
      limit 1
      `,
      [exclude],
      "fill",
    );
    if (!row) break;
    push(row);
  }

  return picks.slice(0, 30);
}

async function fetchBffDetail(alertId) {
  const config = getOneViewConfig(process.env);
  const payload = await fetchOneViewDatabase(
    "alert-detail",
    { method: "GET", query: { id: alertId }, headers: {} },
    config,
  );
  return payload?.item ?? null;
}

function compareAlert(dbRow, bffItem) {
  const divergences = [];
  const drawer = drawerView(bffItem);
  const id = dbRow.id;

  const push = (field, kind, detail = {}) => {
    divergences.push({ alert_id: id, field, kind, bucket: dbRow.bucket, ...detail });
  };

  // NaN / undefined anywhere in BFF item or drawer projection
  for (const hit of scanBad(bffItem)) {
    push(hit.path, `bff_${hit.bad}`, { value: hit.bad });
  }
  for (const hit of scanBad(drawer)) {
    push(hit.path, `drawer_${hit.bad}`, { value: hit.bad });
  }

  // datasource never as client
  if (isDatasourceLike(nfd(drawer.customer)) || drawer.customer === "teletex-http") {
    push("customer", "datasource_as_client", {
      drawer: drawer.customer,
      bff: bffItem.customer_name,
      source: bffItem.customer_source,
    });
  }

  // real customer never overwritten by scope
  if (!isUnclassifiedClient({ key: bffItem.customer_key, name: bffItem.customer_name, source: bffItem.customer_source })) {
    const expected = canonicalClientName({
      key: bffItem.customer_key,
      name: bffItem.customer_name,
      source: bffItem.customer_source,
    });
    if (drawer.customer !== expected) {
      push("customer", "real_customer_overridden_by_scope", {
        expected,
        drawer: drawer.customer,
        scope: drawer.scope,
        scope_label: drawer.scope_label,
      });
    }
  } else {
    // scope labels when no real customer
    if (drawer.scope === "platform" && drawer.customer !== PLATFORM_SCOPE_LABEL
      && drawer.customer !== (drawer.scope_label || PLATFORM_SCOPE_LABEL)) {
      push("scope", "platform_label_mismatch", { drawer: drawer.customer, expected: PLATFORM_SCOPE_LABEL });
    }
    if (drawer.scope === "test" && drawer.customer !== TEST_SCOPE_LABEL
      && drawer.customer !== (drawer.scope_label || TEST_SCOPE_LABEL)) {
      push("scope", "test_label_mismatch", { drawer: drawer.customer, expected: TEST_SCOPE_LABEL });
    }
    if (drawer.scope === "unknown" && drawer.customer !== UNKNOWN_SCOPE_LABEL
      && drawer.customer !== (drawer.scope_label || UNKNOWN_SCOPE_LABEL)
      && drawer.customer !== UNCLASSIFIED_LABEL) {
      // unknown may still show UNCLASSIFIED if scope_label absent and helper falls through — check FE contract
      if (drawer.customer !== UNKNOWN_SCOPE_LABEL && drawer.customer !== UNCLASSIFIED_LABEL) {
        push("scope", "unknown_label_mismatch", { drawer: drawer.customer, expected: UNKNOWN_SCOPE_LABEL });
      }
    }
  }

  // host cascade
  const expectedHost = canonicalHostName(dbRow);
  if (drawer.host !== canonicalHostName(bffItem)) {
    push("host", "host_drawer_bff_mismatch", { drawer: drawer.host, bff_host: canonicalHostName(bffItem) });
  }
  // BFF should preserve cascade from DB
  if (canonicalHostName(bffItem) !== expectedHost && expectedHost !== MISSING_HOST) {
    // only flag if BFF lost a good host
    if (drawer.host === MISSING_HOST && expectedHost !== MISSING_HOST) {
      push("host", "host_lost_in_bff", { db: expectedHost, drawer: drawer.host });
    }
  }

  // problem
  const expectedProblem = String(bffItem.problem_name || "").trim() || "Alerta sem descrição";
  if (drawer.problem !== expectedProblem) {
    push("problem", "problem_mismatch", { drawer: drawer.problem, bff: bffItem.problem_name });
  }

  // severity / status / ack badges from BFF
  if (!drawer.severity || drawer.severity === "undefined") {
    push("severity", "missing_severity");
  }
  const expectedStatus = isResolved(bffItem) ? "Resolvido" : "Ativo";
  if (drawer.status !== expectedStatus) {
    push("status", "status_mismatch", { drawer: drawer.status, expected: expectedStatus });
  }
  const expectedAck = bffItem.acknowledged_source || bffItem.source_ack?.acknowledged ? "ACK" : "ACK pendente";
  if (drawer.ack !== expectedAck) {
    push("ack", "ack_badge_mismatch", { drawer: drawer.ack, expected: expectedAck });
  }

  // ACK ator/horário: drawer oficial usa source_ack quando presente
  const ack = ackActor(bffItem);
  if (ack.acknowledged && bffItem.source_ack?.acknowledged) {
    if (ack.actor !== (bffItem.source_ack.actor_name || null)) {
      push("ack_actor", "ack_actor_mismatch", {
        drawer: ack.actor,
        source_ack: bffItem.source_ack.actor_name,
        flat: bffItem.acknowledged_source_by,
      });
    }
    const expectedAt = bffItem.source_ack.acknowledged_at || bffItem.acknowledged_source_at || null;
    if (ack.at !== expectedAt) {
      push("ack_at", "ack_at_mismatch", {
        drawer: ack.at,
        source_ack: bffItem.source_ack.acknowledged_at,
        flat: bffItem.acknowledged_source_at,
      });
    }
  }

  // times present as null or ISO — never undefined
  for (const field of ["first_seen_at", "last_seen_at", "resolved_at", "ack_actor", "ack_at"]) {
    if (drawer[field] === undefined) push(field, "undefined_time");
  }
  if (drawer.duration_seconds !== undefined && drawer.duration_seconds !== null) {
    if (typeof drawer.duration_seconds === "number" && !Number.isFinite(drawer.duration_seconds)) {
      push("duration_seconds", "nan_duration");
    }
  }

  // IP contract: BFF host_ip always null → drawer ip must be null (not invented)
  if (bffItem.host_ip != null && bffItem.host_ip !== "") {
    // If BFF starts returning IP, drawer may show public only — OK
  } else if (drawer.ip != null) {
    push("ip", "ip_invented_from_null_bff", { drawer: drawer.ip });
  }

  // no FE inference from host/group into customer when BFF has no customer
  if (isUnclassifiedClient({ key: bffItem.customer_key, name: bffItem.customer_name, source: bffItem.customer_source })) {
    const hostHit = nfd(drawer.customer) === nfd(dbRow.host_visible_name)
      || nfd(drawer.customer) === nfd(dbRow.host_name)
      || nfd(drawer.customer) === nfd(dbRow.host_technical_name);
    if (hostHit && ![PLATFORM_SCOPE_LABEL, TEST_SCOPE_LABEL, UNKNOWN_SCOPE_LABEL, UNCLASSIFIED_LABEL].includes(drawer.customer)) {
      push("customer", "frontend_inferred_from_host", {
        drawer: drawer.customer,
        host: dbRow.host_visible_name || dbRow.host_name,
      });
    }
  }

  return { drawer, divergences };
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
    query_timeout: 60000,
  });

  await client.connect();
  let sample = [];
  try {
    sample = await selectSample(client);
  } finally {
    await client.end();
  }

  const results = [];
  const allDivergences = [];
  const coverage = {
    customers: {},
    scopes: {},
    severities: {},
    ack: { yes: 0, no: 0 },
    status: { active: 0, resolved: 0 },
  };

  for (const row of sample) {
    let bffItem = null;
    let error = null;
    try {
      bffItem = await fetchBffDetail(row.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (!bffItem) {
      allDivergences.push({
        alert_id: row.id,
        field: "alert-detail",
        kind: "bff_detail_failed",
        bucket: row.bucket,
        error,
      });
      results.push({ id: row.id, bucket: row.bucket, error: error || "empty" });
      continue;
    }

    const { drawer, divergences } = compareAlert(row, bffItem);
    allDivergences.push(...divergences);

    const custKey = nfd(drawer.customer_key || drawer.customer_raw || drawer.customer).slice(0, 40);
    coverage.customers[custKey] = (coverage.customers[custKey] || 0) + 1;
    coverage.scopes[drawer.scope || "null"] = (coverage.scopes[drawer.scope || "null"] || 0) + 1;
    coverage.severities[drawer.severity] = (coverage.severities[drawer.severity] || 0) + 1;
    if (drawer.ack === "ACK") coverage.ack.yes += 1;
    else coverage.ack.no += 1;
    if (drawer.status === "Resolvido") coverage.status.resolved += 1;
    else coverage.status.active += 1;

    results.push({
      id: row.id,
      bucket: row.bucket,
      drawer: {
        customer: drawer.customer,
        logo: drawer.logo,
        host: drawer.host,
        severity: drawer.severity,
        status: drawer.status,
        ack: drawer.ack,
        scope: drawer.scope,
        problem: String(drawer.problem).slice(0, 80),
      },
      divergences: divergences.length,
    });
  }

  const byKind = {};
  for (const d of allDivergences) {
    byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  }

  const missingTargets = TARGET_CUSTOMERS.filter((needle) =>
    !sample.some((row) => nfd(`${row.customer_key} ${row.customer_name}`).includes(needle)));

  const report = {
    card: "OV-P0-71",
    ok: allDivergences.length === 0,
    sampled: sample.length,
    target: 30,
    missing_target_customers: missingTargets,
    coverage,
    divergence_count: allDivergences.length,
    divergences_by_kind: byKind,
    divergences: allDivergences.slice(0, 100),
    sample_preview: results.slice(0, 30),
    notes: [
      "Drawer espelhado: AlertOperationalSummary + ACK (source_ack / acknowledged_source_*).",
      "host_ip no BFF é contrato null — IP no drawer só se BFF passar valor público.",
      "Logo: true quando catálogo FE tem alias (Sanepar/Osasco/Unicap/Protege/Nissan/Havan/Teletex).",
      "JFSC/Banrisul sem logo no catálogo não é divergência de fidelidade BFF→drawer.",
      "Cliente real + scope platform/test: drawer mostra o cliente (HOTFIX), não o label de scope.",
      "ACK ator/horário: drawer consome source_ack quando presente (pode diferir do flat acknowledged_source_by).",
    ],
  };

  const coverageGaps = [];
  for (const needle of TARGET_CUSTOMERS) {
    if (!sample.some((row) => nfd(`${row.customer_key} ${row.customer_name}`).includes(needle === "osasco" ? "osasco" : needle))) {
      coverageGaps.push(`customer:${needle}`);
    }
  }
  for (const scope of ["platform", "test", "unknown"]) {
    if (!results.some((r) => r.drawer?.scope === scope || r.bucket === `scope:${scope}`)) {
      coverageGaps.push(`scope:${scope}`);
    }
  }
  for (const sev of ["information", "warning", "average", "high", "disaster", "not_classified"]) {
    if (!Object.keys(coverage.severities).map((s) => s.toLowerCase()).includes(sev)) {
      coverageGaps.push(`severity:${sev}`);
    }
  }
  if (!coverage.ack.yes) coverageGaps.push("ack:yes");
  if (!coverage.ack.no) coverageGaps.push("ack:no");
  if (!coverage.status.active) coverageGaps.push("status:active");
  if (!coverage.status.resolved) coverageGaps.push("status:resolved");
  report.coverage_gaps = coverageGaps;

  console.log(JSON.stringify(report, null, 2));
  process.exit(allDivergences.length ? 1 : 0);
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(2);
});

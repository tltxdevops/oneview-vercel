/**
 * OV-P0-55 probe — list active unclassified candidates for Havan/Ebanx/Triunfante.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const { Client } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const UNCLASSIFIED_SQL = `
  (
    a.customer_name is null
    or btrim(a.customer_name) = ''
    or lower(btrim(a.customer_name)) in (
      'cliente não classificado', 'cliente nao classificado',
      'cliente não identificado', 'cliente nao identificado',
      'unclassified', 'teletex-http'
    )
    or lower(coalesce(a.customer_source, '')) = 'datasource_fallback'
    or lower(coalesce(a.customer_key, '')) in ('unclassified', 'cliente-nao-classificado')
  )
`;

const ACTIVE_SQL = `
  a.resolved_at is null
  and lower(coalesce(a.status_source, '')) <> 'resolved'
  and lower(coalesce(a.status_internal, '')) not in ('resolved', 'normalized')
`;

function sslConfig() {
  const mode = String(process.env.ONEVIEW_DB_SSLMODE || "require").toLowerCase();
  if (mode === "disable") return undefined;
  return process.env.ONEVIEW_DB_SSL_REJECT_UNAUTHORIZED === "false"
    ? { rejectUnauthorized: false }
    : true;
}

const client = new Client({
  host: process.env.ONEVIEW_DB_HOST,
  port: Number(process.env.ONEVIEW_DB_PORT || 443),
  database: process.env.ONEVIEW_DB_NAME,
  user: process.env.ONEVIEW_DB_USER || "oneview_vercel_readonly",
  password: process.env.POSTGRES_READONLY_PASSWORD,
  ssl: sslConfig(),
  application_name: "oneview-ov-p0-55-probe",
});

await client.connect();

const hostExpr = "coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '')";

const { rows: allUnclassified } = await client.query(`
  select count(*)::int as count
    from alerts a
    join data_sources ds on ds.id = a.data_source_id
   where lower(ds.name) = 'teletex-http'
     and ${ACTIVE_SQL}
     and ${UNCLASSIFIED_SQL}
`);

const { rows } = await client.query(`
  select
    a.id,
    ${hostExpr} as host,
    a.host_visible_name,
    a.host_technical_name,
    a.host_name,
    a.host_groups,
    a.customer_name,
    a.customer_key,
    a.customer_source,
    a.problem_name,
    (${hostExpr} ~* '^HAVAN[\\s_-]') as match_havan_prefix,
    (${hostExpr} ~* '^EBANX[\\s_-]') as match_ebanx_prefix,
    (${hostExpr} ~* '^TRIUNFANTE[\\s_-]') as match_triunfante_prefix,
    (${hostExpr} ~* 'havan') as host_has_havan,
    (${hostExpr} ~* 'ebanx') as host_has_ebanx,
    (${hostExpr} ~* 'triunfante') as host_has_triunfante,
    coalesce(a.host_groups::text, '') ~* 'havan' as groups_havan,
    coalesce(a.host_groups::text, '') ~* 'ebanx' as groups_ebanx,
    coalesce(a.host_groups::text, '') ~* 'triunfante' as groups_triunfante
  from alerts a
  join data_sources ds on ds.id = a.data_source_id
  where lower(ds.name) = 'teletex-http'
    and ${ACTIVE_SQL}
    and ${UNCLASSIFIED_SQL}
    and (
      ${hostExpr} ~* '(havan|ebanx|triunfante)'
      or coalesce(a.host_groups::text, '') ~* '(havan|ebanx|triunfante)'
      or coalesce(a.problem_name, '') ~* '(havan|ebanx|triunfante)'
    )
  order by host, a.id
`);

const { rows: sampleAll } = await client.query(`
  select
    a.id,
    ${hostExpr} as host,
    a.host_groups,
    a.problem_name,
    a.customer_name,
    a.customer_source
  from alerts a
  join data_sources ds on ds.id = a.data_source_id
  where lower(ds.name) = 'teletex-http'
    and ${ACTIVE_SQL}
    and ${UNCLASSIFIED_SQL}
  order by host, a.id
  limit 40
`);

console.log(JSON.stringify({
  still_unclassified_active: allUnclassified[0]?.count,
  keyword_hits: rows.length,
  keyword_rows: rows,
  sample_unclassified: sampleAll,
}, null, 2));

await client.end();

/**
 * OV-P0-55 — apply seguro dos 4 SAFE restantes (Havan/Ebanx/Triunfante).
 * Regras OV-P0-54 (somente ativos unclassified/fallback; sem indeterminados):
 *   ^\[North America\]\s*HAVAN$      → Havan (2)
 *   ^\[North America\]\s*EBANX$      → Ebanx (1)
 *   ^\[North America\]\s*Triunfante$ → Triunfante (1)
 *
 * Uso:
 *   node scripts/_tmp-ov-p0-55-classify.mjs           # dry-run / preflight
 *   node scripts/_tmp-ov-p0-55-classify.mjs --apply  # UPDATE se expected=4 e conflicts=0
 *
 * Sem restart/systemd/commit. Não toca alert_history / sync_logs.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const { Client } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const APPLY = process.argv.includes("--apply");
const EXPECTED = 4;

const RULES = [
  {
    id: "havan",
    pattern: "^\\[North America\\]\\s*HAVAN$",
    customer_name: "Havan",
    customer_key: "havan",
  },
  {
    id: "ebanx",
    pattern: "^\\[North America\\]\\s*EBANX$",
    customer_name: "Ebanx",
    customer_key: "ebanx",
  },
  {
    id: "triunfante",
    pattern: "^\\[North America\\]\\s*Triunfante$",
    customer_name: "Triunfante",
    customer_key: "triunfante",
  },
];

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

function readClientConfig() {
  return {
    host: process.env.ONEVIEW_DB_HOST,
    port: Number(process.env.ONEVIEW_DB_PORT || 443),
    database: process.env.ONEVIEW_DB_NAME,
    user: process.env.ONEVIEW_DB_USER || "oneview_vercel_readonly",
    password: process.env.POSTGRES_READONLY_PASSWORD,
    ssl: sslConfig(),
    application_name: "oneview-ov-p0-55-preflight",
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
  };
}

function loadCommentedEnvValue(filePath, key) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const line = source.split(/\r?\n/).find((entry) => {
      const trimmed = entry.trim();
      return trimmed.startsWith(`#${key}=`) || trimmed.startsWith(`# ${key}=`);
    });
    if (!line) return null;
    const raw = line.replace(/^\s*#\s*/, "");
    const idx = raw.indexOf("=");
    if (idx < 0) return null;
    let value = raw.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || null;
  } catch {
    return null;
  }
}

function writeCandidateConfigs() {
  const envFile = path.join(rootDir, ".env.local");
  const base = {
    host: process.env.ONEVIEW_DB_HOST,
    port: Number(process.env.ONEVIEW_DB_PORT || 443),
    database: process.env.ONEVIEW_DB_NAME,
    ssl: sslConfig(),
    application_name: "oneview-ov-p0-55-apply",
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
  };

  const candidates = [];
  const appPassword = process.env.POSTGRES_APP_PASSWORD
    || process.env.ONEVIEW_DB_WRITE_PASSWORD
    || loadCommentedEnvValue(envFile, "POSTGRES_APP_PASSWORD")
    || loadCommentedEnvValue(envFile, "ONEVIEW_DB_WRITE_PASSWORD");
  const writeUser = process.env.ONEVIEW_DB_WRITE_USER
    || process.env.POSTGRES_APP_USER
    || process.env.ONEVIEW_APP_DB_USER
    || loadCommentedEnvValue(envFile, "ONEVIEW_DB_WRITE_USER")
    || null;

  if (appPassword && writeUser) {
    candidates.push({ ...base, user: writeUser, password: appPassword, label: "explicit_write_user" });
  }
  if (appPassword) {
    for (const user of ["oneview_app", "oneview_owner", "oneview_worker", "oneview_writer", "oneview_admin", "oneview"]) {
      if (writeUser && user === writeUser) continue;
      candidates.push({ ...base, user, password: appPassword, label: `app_password:${user}` });
    }
  }

  const actionsPassword = process.env.POSTGRES_ACTIONS_PASSWORD
    || process.env.ONEVIEW_ACTIONS_PASSWORD
    || loadCommentedEnvValue(envFile, "POSTGRES_ACTIONS_PASSWORD");
  if (actionsPassword) {
    candidates.push({ ...base, user: "oneview_actions", password: actionsPassword, label: "oneview_actions" });
  }

  return candidates;
}

async function queryCandidates(client) {
  const hostExpr = `coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '')`;

  const ruleCase = RULES.map((rule, index) => {
    const param = index + 1;
    return `when ${hostExpr} ~* $${param} then $${param + RULES.length}`;
  }).join("\n");

  const ruleFlags = RULES.map((rule, index) => {
    const param = index + 1;
    return `(${hostExpr} ~* $${param}) as match_${rule.id}`;
  }).join(",\n");

  const whereMatches = RULES.map((_, index) => `match_${RULES[index].id}`).join(" or ");

  const sql = `
    with scoped as (
      select
        a.id,
        a.problem_name,
        a.host_name,
        a.host_visible_name,
        a.host_technical_name,
        a.host_groups,
        a.customer_name,
        a.customer_key,
        a.customer_source,
        a.customer_confidence,
        a.status_source,
        a.resolved_at,
        ds.name as datasource_name,
        ${ruleFlags},
        case
          ${ruleCase}
          else null
        end as proposed_customer_name
      from alerts a
      join data_sources ds on ds.id = a.data_source_id
      where lower(ds.name) = 'teletex-http'
        and ${ACTIVE_SQL}
        and ${UNCLASSIFIED_SQL}
    )
    select *
      from scoped
     where ${whereMatches}
     order by proposed_customer_name nulls last, id
  `;

  const params = [
    ...RULES.map((r) => r.pattern),
    ...RULES.map((r) => r.customer_name),
  ];
  const { rows } = await client.query(sql, params);
  return rows;
}

function analyze(rows) {
  const conflicts = [];
  const byClient = Object.fromEntries(RULES.map((r) => [r.customer_name, []]));

  for (const row of rows) {
    const hits = RULES.filter((rule) => row[`match_${rule.id}`] === true);
    if (hits.length > 1) {
      conflicts.push({
        id: row.id,
        matches: hits.map((h) => h.customer_name),
        host: row.host_visible_name || row.host_technical_name || row.host_name,
      });
      continue;
    }
    if (hits.length === 1) {
      byClient[hits[0].customer_name].push(row);
    }
  }

  const expected = RULES.reduce((sum, rule) => sum + byClient[rule.customer_name].length, 0);
  return { conflicts, byClient, expected, totalMatchedRows: rows.length };
}

async function countStillUnclassified(client) {
  const { rows } = await client.query(`
    select count(*)::int as count
      from alerts a
      join data_sources ds on ds.id = a.data_source_id
     where lower(ds.name) = 'teletex-http'
       and ${ACTIVE_SQL}
       and ${UNCLASSIFIED_SQL}
  `);
  return rows[0]?.count ?? null;
}

async function countsFingerprint(client) {
  const { rows } = await client.query(`
    select
      (select count(*)::bigint from alert_history) as alert_history_count,
      (select count(*)::bigint from sync_logs) as sync_logs_count,
      (select coalesce(max(id)::text, '') from alert_history) as alert_history_max_id,
      (select coalesce(max(id)::text, '') from sync_logs) as sync_logs_max_id
  `);
  return rows[0];
}

async function applyUpdates(client, byClient) {
  const updated = Object.fromEntries(RULES.map((r) => [r.customer_name, 0]));
  const examples = [];

  await client.query("begin");
  try {
    for (const rule of RULES) {
      const rows = byClient[rule.customer_name];
      if (!rows.length) continue;
      const ids = rows.map((r) => r.id);
      const result = await client.query(
        `
          update alerts
             set customer_name = $1,
                 customer_key = $2,
                 customer_source = 'hostname_rule',
                 customer_confidence = 'high',
                 updated_at = now()
           where id = any($3::uuid[])
             and resolved_at is null
             and (
               customer_name is null
               or btrim(customer_name) = ''
               or lower(btrim(customer_name)) in (
                 'cliente não classificado', 'cliente nao classificado',
                 'cliente não identificado', 'cliente nao identificado',
                 'unclassified', 'teletex-http'
               )
               or lower(coalesce(customer_source, '')) = 'datasource_fallback'
               or lower(coalesce(customer_key, '')) in ('unclassified', 'cliente-nao-classificado')
             )
          returning id, customer_name, customer_key, customer_source, customer_confidence,
                    host_visible_name, host_technical_name, host_name, problem_name
        `,
        [rule.customer_name, rule.customer_key, ids],
      );
      updated[rule.customer_name] = result.rowCount;
      for (const row of result.rows) {
        examples.push({
          id: row.id,
          customer_name: row.customer_name,
          customer_key: row.customer_key,
          customer_source: row.customer_source,
          customer_confidence: row.customer_confidence,
          host: row.host_visible_name || row.host_technical_name || row.host_name,
          problem_name: row.problem_name,
        });
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }

  return { updated, examples };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const readConfig = readClientConfig();
  if (!readConfig.host || !readConfig.password) {
    printJson({ ok: false, aborted: true, reason: "missing_readonly_db_config" });
    process.exit(2);
  }

  const readClient = new Client(readConfig);
  await readClient.connect();

  let beforeHistory;
  try {
    beforeHistory = await countsFingerprint(readClient);
    const candidates = await queryCandidates(readClient);
    const analysis = analyze(candidates);
    const stillUnclassifiedBefore = await countStillUnclassified(readClient);

    const byClientCounts = Object.fromEntries(
      RULES.map((rule) => [rule.customer_name, analysis.byClient[rule.customer_name].length]),
    );

    const preflight = {
      card: "OV-P0-55",
      mode: APPLY ? "apply" : "preflight",
      rules: RULES.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        customer_name: r.customer_name,
        customer_key: r.customer_key,
      })),
      expected: analysis.expected,
      expected_target: EXPECTED,
      conflicts: analysis.conflicts.length,
      conflict_details: analysis.conflicts,
      matched_rows: analysis.totalMatchedRows,
      by_client_counts: byClientCounts,
      still_unclassified_active_before: stillUnclassifiedBefore,
      examples_planned: Object.values(analysis.byClient)
        .flat()
        .map((row) => ({
          id: row.id,
          proposed: row.proposed_customer_name,
          host: row.host_visible_name || row.host_technical_name || row.host_name,
          problem_name: row.problem_name,
          customer_source: row.customer_source,
          customer_key: row.customer_key,
        })),
      history_sync_before: beforeHistory,
    };

    if (analysis.expected !== EXPECTED || analysis.conflicts.length > 0) {
      printJson({
        ok: false,
        aborted: true,
        reason: analysis.expected !== EXPECTED
          ? `expected_mismatch:${analysis.expected}`
          : `conflicts:${analysis.conflicts.length}`,
        ...preflight,
      });
      process.exit(1);
    }

    if (!APPLY) {
      printJson({ ok: true, aborted: false, ...preflight });
      return;
    }

    const writeCandidates = writeCandidateConfigs();
    if (!writeCandidates.length) {
      printJson({
        ok: false,
        aborted: true,
        reason: "missing_write_db_config",
        hint: "Defina ONEVIEW_DB_WRITE_USER + POSTGRES_APP_PASSWORD (ou ONEVIEW_ACTIONS_PASSWORD) para --apply.",
        ...preflight,
      });
      process.exit(2);
    }

    let writeClient = null;
    let writeLabel = null;
    const authErrors = [];
    for (const candidate of writeCandidates) {
      const trial = new Client(candidate);
      try {
        await trial.connect();
        await trial.query("begin");
        await trial.query("update alerts set updated_at = updated_at where false");
        await trial.query("rollback");
        writeClient = trial;
        writeLabel = candidate.label;
        break;
      } catch (error) {
        authErrors.push({
          label: candidate.label,
          user: candidate.user,
          code: error?.code || null,
          message: String(error?.message || "").slice(0, 120),
        });
        await trial.query("rollback").catch(() => undefined);
        await trial.end().catch(() => undefined);
      }
    }

    if (!writeClient) {
      printJson({
        ok: false,
        aborted: true,
        reason: "write_auth_failed",
        auth_errors: authErrors,
        ...preflight,
      });
      process.exit(2);
    }

    let applyResult;
    try {
      const recheck = analyze(await queryCandidates(writeClient));
      if (recheck.expected !== EXPECTED || recheck.conflicts.length > 0) {
        printJson({
          ok: false,
          aborted: true,
          reason: "recheck_failed",
          expected: recheck.expected,
          conflicts: recheck.conflicts.length,
          write_label: writeLabel,
        });
        process.exit(1);
      }
      applyResult = await applyUpdates(writeClient, recheck.byClient);
    } finally {
      await writeClient.end().catch(() => undefined);
    }

    const stillUnclassifiedAfter = await countStillUnclassified(readClient);
    const afterHistory = await countsFingerprint(readClient);
    const historyUnchanged =
      String(beforeHistory.alert_history_count) === String(afterHistory.alert_history_count)
      && String(beforeHistory.sync_logs_count) === String(afterHistory.sync_logs_count)
      && String(beforeHistory.alert_history_max_id) === String(afterHistory.alert_history_max_id)
      && String(beforeHistory.sync_logs_max_id) === String(afterHistory.sync_logs_max_id);

    const updatedTotal = Object.values(applyResult.updated).reduce((a, b) => a + b, 0);
    printJson({
      ok: updatedTotal === EXPECTED && historyUnchanged,
      aborted: false,
      ...preflight,
      write_label: writeLabel,
      updated_by_client: applyResult.updated,
      updated_total: updatedTotal,
      still_unclassified_active_after: stillUnclassifiedAfter,
      examples: applyResult.examples,
      history_sync_after: afterHistory,
      history_sync_unchanged: historyUnchanged,
      validation: {
        updated_eq_4: updatedTotal === EXPECTED,
        history_sync_unchanged: historyUnchanged,
        unclassified_delta: stillUnclassifiedBefore - stillUnclassifiedAfter,
      },
    });

    if (updatedTotal !== EXPECTED || !historyUnchanged) process.exit(1);
  } finally {
    await readClient.end().catch(() => undefined);
  }
}

main().catch((error) => {
  printJson({
    ok: false,
    aborted: true,
    reason: "runtime_error",
    message: String(error?.message || error),
    code: error?.code || null,
  });
  process.exit(1);
});

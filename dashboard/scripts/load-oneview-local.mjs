import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionToken } from "../api/_lib/session.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const DEFINITIVE_SCENARIOS = Object.freeze([
  { name: "smoke", users: 2, durationMs: 5_000, run: 1 },
  { name: "10-users-run-1", users: 10, durationMs: 2 * 60_000, run: 1 },
  { name: "10-users-run-2", users: 10, durationMs: 2 * 60_000, run: 2 },
  { name: "25-users-run-1", users: 25, durationMs: 3 * 60_000, run: 1 },
  { name: "25-users-run-2", users: 25, durationMs: 3 * 60_000, run: 2 },
]);
const WARMUP_MS = 30_000;
const ROUTE_NAMES = Object.freeze([
  "dashboard-summary",
  "alerts-list",
  "alert-detail",
  "alert-history",
  "operations-health",
  "attention-required",
]);
const LEAK_PATTERNS = Object.freeze([
  /postgres(?:ql)?:\/\//i,
  /"(?:password|senha|client_secret|token_encrypted|payload_raw|payload_normalized|api_url)"\s*:/i,
  /\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
]);

function integerEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(String(process.env[name] || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, percentage) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(Math.ceil((percentage / 100) * sorted.length) - 1, sorted.length - 1);
  return Number(sorted[Math.max(index, 0)].toFixed(2));
}

function localBaseUrl() {
  const value = process.env.ONEVIEW_LOAD_BASE_URL || "http://127.0.0.1:8787";
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("ONEVIEW_LOAD_BASE_URL deve apontar exclusivamente para localhost");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function firstCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).find(Boolean) || "";
}

function controlledSessionEmail() {
  const explicit = String(process.env.ONEVIEW_LOAD_TEST_EMAIL || "").trim().toLowerCase();
  if (explicit) return explicit;
  const allowedDomain = firstCsv(process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS).toLowerCase().replace(/^@+/, "") || "teletex.com.br";
  return `oneview-load-test@${allowedDomain}`;
}

function authHeaders() {
  const bearer = String(process.env.ONEVIEW_LOAD_TEST_BEARER_TOKEN || "").trim();
  if (bearer) return { mode: "bearer", headers: { Authorization: `Bearer ${bearer}` } };

  const cookie = String(process.env.ONEVIEW_LOAD_TEST_COOKIE || "").trim();
  if (cookie) return { mode: "cookie", headers: { Cookie: cookie } };

  if (!process.env.APP_SESSION_SECRET && !process.env.ONEVIEW_SESSION_SECRET) {
    throw new Error("Sessão controlada indisponível: configure APP_SESSION_SECRET localmente");
  }
  const session = createSessionToken({
    id: "oneview-load-test",
    email: controlledSessionEmail(),
    name: "OneView Load Test",
    roles: ["viewer"],
  });
  return { mode: "controlled_session", headers: { Authorization: `Bearer ${session.token}` } };
}

function selectedScenarios() {
  const cli = process.argv.slice(2);
  if (cli.includes("--help")) {
    console.info([
      "Uso: npm run test:load-local",
      "Smoke: npm run test:load-local -- --smoke",
      "Cenário isolado: npm run test:load-local -- --scenario=10|25",
      "Padrão: smoke, 10 usuários duas vezes e 25 usuários duas vezes.",
      "O BFF local deve estar ativo em http://127.0.0.1:8787.",
    ].join("\n"));
    process.exit(0);
  }
  if (cli.includes("--smoke") || process.env.ONEVIEW_LOAD_PROFILE === "smoke") return [DEFINITIVE_SCENARIOS[0]];
  const requested = cli.find((item) => item.startsWith("--scenario="))?.split("=")[1]
    || process.env.ONEVIEW_LOAD_SCENARIO
    || "all";
  if (requested === "all") return DEFINITIVE_SCENARIOS;
  const users = Number.parseInt(requested, 10);
  const selected = DEFINITIVE_SCENARIOS.filter((scenario) => scenario.users === users);
  if (!selected.length) throw new Error("Cenário inválido; use 10, 25 ou all");
  return selected;
}

function newRouteMetric() {
  return {
    requests: 0,
    success: 0,
    errors: 0,
    timeouts: 0,
    leaks: 0,
    latencies: [],
    sources: { database: 0, snapshot: 0, unknown: 0 },
    error_codes: {},
  };
}

function recordError(metric, code, timedOut = false) {
  metric.errors += 1;
  if (timedOut) metric.timeouts += 1;
  metric.error_codes[code] = (metric.error_codes[code] || 0) + 1;
}

function routePath(routeName, alertId) {
  if (routeName === "dashboard-summary") return "/api/oneview/dashboard-summary";
  if (routeName === "alerts-list") return "/api/oneview/alerts?page=1&page_size=50";
  if (routeName === "alert-detail") return `/api/oneview/alerts/${encodeURIComponent(alertId)}`;
  if (routeName === "alert-history") return `/api/oneview/alerts/${encodeURIComponent(alertId)}/history`;
  if (routeName === "operations-health") return "/api/oneview/operations/health";
  return "/api/oneview/attention-required";
}

async function timedFetch(baseUrl, pathname, headers, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        ...headers,
        Accept: "application/json",
        "User-Agent": "oneview-local-load-test",
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    let responseErrorCode = null;
    if (!response.ok) {
      try {
        const parsed = JSON.parse(raw || "{}");
        if (typeof parsed?.error === "string" && /^[a-z0-9_]{1,80}$/i.test(parsed.error)) responseErrorCode = parsed.error;
      } catch {
        responseErrorCode = null;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      raw,
      source: response.headers.get("x-oneview-data-source") || "unknown",
      durationMs: performance.now() - startedAt,
      errorCode: responseErrorCode,
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      raw: "",
      source: "unknown",
      durationMs: performance.now() - startedAt,
      errorCode: error?.name === "AbortError" ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function controlRequest(baseUrl, pathname, headers, method = "GET") {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    cache: "no-store",
    headers: { ...headers, "X-OneView-Load-Probe": "1", Accept: "application/json" },
  });
  const payload = response.ok ? await response.json() : {};
  if (!response.ok) throw new Error(`Controle local indisponível: ${pathname} HTTP ${response.status}`);
  return payload;
}

async function warmUp(context, durationMs = WARMUP_MS) {
  const startedAt = Date.now();
  const endAt = startedAt + durationMs;
  const result = { requests: 0, errors: 0, database: 0, snapshot: 0, unknown: 0 };
  async function worker(workerIndex) {
    let iteration = 0;
    while (Date.now() < endAt) {
      for (const routeName of ROUTE_NAMES) {
        if (Date.now() >= endAt) break;
        const alertId = context.alertIds[(workerIndex + iteration) % context.alertIds.length];
        const response = await timedFetch(context.baseUrl, routePath(routeName, alertId), context.headers, context.timeoutMs);
        result.requests += 1;
        if (!response.ok) result.errors += 1;
        if (response.source === "database") result.database += 1;
        else if (response.source === "snapshot") result.snapshot += 1;
        else result.unknown += 1;
      }
      iteration += 1;
      if (Date.now() < endAt) await sleep(Math.max(context.thinkMs, 250));
    }
  }
  await Promise.all([worker(0), worker(1)]);
  return {
    ...result,
    duration_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
    passed: result.errors === 0 && result.snapshot === 0 && result.unknown === 0,
  };
}

async function bootstrap(baseUrl, headers, timeoutMs) {
  const authCheck = await timedFetch(baseUrl, "/api/oneview/dashboard-summary", headers, timeoutMs);
  if (authCheck.status === 401 || authCheck.status === 403) throw new Error(`Autenticação do teste recusada: HTTP ${authCheck.status}`);
  if (!authCheck.ok) throw new Error(`BFF local indisponível: HTTP ${authCheck.status || 0}`);

  const alerts = await timedFetch(baseUrl, "/api/oneview/alerts?page=1&page_size=50", headers, timeoutMs);
  if (!alerts.ok) throw new Error(`Não foi possível preparar IDs de alerta: HTTP ${alerts.status || 0}`);
  const payload = JSON.parse(alerts.raw || "{}");
  const alertIds = Array.isArray(payload.items)
    ? payload.items.map((item) => String(item?.id || "")).filter(Boolean)
    : [];
  if (!alertIds.length) throw new Error("Nenhum alerta disponível para testar detalhe e histórico");
  return alertIds;
}

async function samplePool(baseUrl, headers, expectedGeneration, expectedPid, state, telemetry, intervalMs) {
  while (state.running) {
    try {
      const response = await fetch(`${baseUrl}/__oneview/load/pool`, {
        method: "GET",
        cache: "no-store",
        headers: { ...headers, "X-OneView-Load-Probe": "1" },
      });
      const payload = response.ok ? await response.json() : {};
      const sample = payload?.pool;
      if (Number(payload?.generation) !== expectedGeneration || Number(payload?.pid) !== expectedPid) {
        telemetry.generation_mismatches += 1;
      } else if (sample && Number.isFinite(Number(sample.total))) {
        telemetry.samples += 1;
        telemetry.available = true;
        telemetry.max_configured = Math.max(telemetry.max_configured, Number(sample.max || 0));
        telemetry.max_total = Math.max(telemetry.max_total, Number(sample.total || 0));
        telemetry.max_idle = Math.max(telemetry.max_idle, Number(sample.idle || 0));
        telemetry.max_waiting = Math.max(telemetry.max_waiting, Number(sample.waiting || 0));
        if (Number(sample.max || 0) > 0 && Number(sample.total || 0) >= Number(sample.max) && Number(sample.waiting || 0) > 0) {
          telemetry.exhausted_samples += 1;
        }
      } else {
        telemetry.unavailable_samples += 1;
      }
    } catch {
      telemetry.unavailable_samples += 1;
    }
    await sleep(intervalMs);
  }
}

function summarizeMetric(metric) {
  return {
    requests: metric.requests,
    success: metric.success,
    errors: metric.errors,
    timeouts: metric.timeouts,
    leaks: metric.leaks,
    p50_ms: percentile(metric.latencies, 50),
    p95_ms: percentile(metric.latencies, 95),
    p99_ms: percentile(metric.latencies, 99),
    sources: metric.sources,
    error_codes: metric.error_codes,
  };
}

function scenarioGates(scenario, summary) {
  if (scenario.users === 10) {
    return {
      zero_errors: summary.errors === 0,
      zero_timeouts: summary.timeouts === 0,
      p95_below_2s: summary.p95_ms < 2_000,
      database_only: summary.database === summary.success && summary.snapshot === 0 && summary.unknown === 0,
      pool_generation_stable: summary.pool.generation_mismatches === 0,
    };
  }
  if (scenario.users === 25) {
    const poolTimeouts = Object.values(summary.routes).reduce(
      (total, route) => total + Number(route.error_codes.database_timeout || 0) + Number(route.error_codes.pool_timeout || 0),
      0,
    );
    return {
      zero_errors: summary.errors === 0,
      zero_timeouts: summary.timeouts === 0,
      p95_below_2_5s: summary.p95_ms < 2_500,
      pool_telemetry_available: summary.pool.available,
      no_pool_timeout: poolTimeouts === 0,
      database_only: summary.database === summary.success && summary.snapshot === 0 && summary.unknown === 0,
      pool_generation_stable: summary.pool.generation_mismatches === 0,
    };
  }
  return {
    zero_errors: summary.errors === 0,
    zero_timeouts: summary.timeouts === 0,
    no_sensitive_leak: summary.leaks === 0,
    database_only: summary.database === summary.success && summary.snapshot === 0 && summary.unknown === 0,
  };
}

async function runScenario(scenario, context, previousSummary = null) {
  const startedAt = Date.now();
  const endAt = startedAt + scenario.durationMs;
  const metrics = Object.fromEntries(ROUTE_NAMES.map((name) => [name, newRouteMetric()]));
  const successWindows = new Set();
  const requestWindows = new Set();
  const pool = {
    available: false,
    samples: 0,
    unavailable_samples: 0,
    max_configured: 0,
    max_total: 0,
    max_idle: 0,
    max_waiting: 0,
    exhausted_samples: 0,
    generation_mismatches: 0,
    generation: context.generation,
    current_scenario_only: true,
  };
  const poolState = { running: true };
  const poolSampler = samplePool(
    context.baseUrl,
    context.headers,
    context.generation,
    context.bffManifest.pid,
    poolState,
    pool,
    context.poolSampleMs,
  );

  console.info(JSON.stringify({
    event: "oneview_load_scenario_start",
    scenario: scenario.name,
    users: scenario.users,
    duration_seconds: scenario.durationMs / 1000,
    run: scenario.run,
    measured_at: new Date(startedAt).toISOString(),
    bff_pid: context.bffManifest.pid,
    code_hash: context.bffManifest.code_hash,
    code_version: context.bffManifest.version,
    pool_max: context.bffManifest.pool?.max || 0,
    target_url: context.baseUrl,
    timeout_ms: context.timeoutMs,
    think_ms: context.thinkMs,
    warmup_seconds: WARMUP_MS / 1000,
    cache_state: context.cacheState,
    telemetry_generation: context.generation,
  }));

  async function virtualUser(userIndex) {
    let iteration = 0;
    while (Date.now() < endAt) {
      for (const routeName of ROUTE_NAMES) {
        if (Date.now() >= endAt) break;
        const metric = metrics[routeName];
        const alertId = context.alertIds[(userIndex + iteration) % context.alertIds.length];
        const window = Math.floor((Date.now() - startedAt) / 5_000);
        requestWindows.add(window);
        metric.requests += 1;
        const result = await timedFetch(
          context.baseUrl,
          routePath(routeName, alertId),
          context.headers,
          context.timeoutMs,
        );
        metric.latencies.push(result.durationMs);
        if (result.source === "database" || result.source === "snapshot") metric.sources[result.source] += 1;
        else metric.sources.unknown += 1;

        const leakDetected = LEAK_PATTERNS.some((pattern) => pattern.test(result.raw));
        if (leakDetected) {
          metric.leaks += 1;
          recordError(metric, "sensitive_response");
        } else if (!result.ok) {
          recordError(metric, result.errorCode || `http_${result.status}`, result.errorCode === "timeout");
        } else {
          metric.success += 1;
          successWindows.add(window);
        }
      }
      iteration += 1;
      if (Date.now() < endAt) await sleep(context.thinkMs);
    }
  }

  await Promise.all(Array.from({ length: scenario.users }, (_, index) => virtualUser(index)));
  poolState.running = false;
  await poolSampler;

  const durationSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const routeSummaries = Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, summarizeMetric(metric)]));
  const allLatencies = Object.values(metrics).flatMap((metric) => metric.latencies);
  const totals = Object.values(metrics).reduce((result, metric) => ({
    requests: result.requests + metric.requests,
    success: result.success + metric.success,
    errors: result.errors + metric.errors,
    timeouts: result.timeouts + metric.timeouts,
    leaks: result.leaks + metric.leaks,
    database: result.database + metric.sources.database,
    snapshot: result.snapshot + metric.sources.snapshot,
    unknown: result.unknown + metric.sources.unknown,
  }), { requests: 0, success: 0, errors: 0, timeouts: 0, leaks: 0, database: 0, snapshot: 0, unknown: 0 });
  const completeOutageWindows = [...requestWindows].filter((window) => !successWindows.has(window)).length;
  const summary = {
    scenario: scenario.name,
    users: scenario.users,
    configured_duration_seconds: scenario.durationMs / 1000,
    measured_duration_seconds: Number(durationSeconds.toFixed(2)),
    ...totals,
    p50_ms: percentile(allLatencies, 50),
    p95_ms: percentile(allLatencies, 95),
    p99_ms: percentile(allLatencies, 99),
    throughput_rps: Number((totals.requests / durationSeconds).toFixed(2)),
    complete_outage_windows: completeOutageWindows,
    pool,
    routes: routeSummaries,
    degradation_vs_previous_p95_percent: previousSummary?.p95_ms
      ? Number((((percentile(allLatencies, 95) / previousSummary.p95_ms) - 1) * 100).toFixed(2))
      : null,
  };
  summary.gates = scenarioGates(scenario, summary);
  summary.safety_pass = summary.leaks === 0 && summary.complete_outage_windows === 0;
  summary.functional_pass = Object.values(summary.gates).every(Boolean);
  summary.passed = summary.safety_pass && summary.functional_pass;

  console.info(JSON.stringify({
    event: "oneview_load_scenario_complete",
    ...summary,
  }));
  return summary;
}

async function main() {
  const scenarios = selectedScenarios();
  const baseUrl = localBaseUrl();
  const auth = authHeaders();
  const timeoutMs = integerEnv("ONEVIEW_LOAD_TIMEOUT_MS", 10_000, 1_000, 60_000);
  const thinkMs = integerEnv("ONEVIEW_LOAD_THINK_MS", 1_000, 0, 30_000);
  const poolSampleMs = integerEnv("ONEVIEW_LOAD_POOL_SAMPLE_MS", 500, 100, 5_000);
  const alertIds = await bootstrap(baseUrl, auth.headers, timeoutMs);
  const results = [];
  const skipped = [];
  const initialManifest = await controlRequest(baseUrl, "/__oneview/load/state", auth.headers);
  if (!Number.isInteger(Number(initialManifest.pid)) || !initialManifest.code_hash) {
    throw new Error("BFF local não expôs identidade reproduzível");
  }

  console.info(JSON.stringify({
    event: "oneview_load_start",
    target: "local_bff",
    target_url: baseUrl,
    auth_mode: auth.mode,
    bff_pid: initialManifest.pid,
    code_hash: initialManifest.code_hash,
    code_version: initialManifest.version,
    bff_started_at: initialManifest.started_at,
    oneview_db_pool_max: initialManifest.pool?.max || 0,
    scenarios: scenarios.map(({ name, users, durationMs }) => ({ name, users, duration_seconds: durationMs / 1000 })),
    timeout_ms: timeoutMs,
    think_ms: thinkMs,
    warmup_seconds: WARMUP_MS / 1000,
    runtime_cache: initialManifest.load_state?.cache?.implemented ? "available" : "not_configured",
    started_at: new Date().toISOString(),
  }));

  for (const scenario of scenarios) {
    if (scenario.users === 10) {
      const smoke = results.find((result) => result.scenario === "smoke");
      if (scenarios.some((candidate) => candidate.name === "smoke") && !smoke?.passed) {
        skipped.push({ scenario: scenario.name, reason: "smoke_gate_failed" });
        continue;
      }
    }
    if (scenario.users === 25) {
      const tenUserRuns = results.filter((result) => result.users === 10);
      if (tenUserRuns.length !== 2 || !tenUserRuns.every((result) => result.passed)) {
        skipped.push({ scenario: scenario.name, reason: "10_user_gate_failed" });
        continue;
      }
    }

    const resetBeforeWarmup = await controlRequest(baseUrl, "/__oneview/load/reset", auth.headers, "POST");
    const manifestBeforeWarmup = await controlRequest(baseUrl, "/__oneview/load/state", auth.headers);
    if (Number(manifestBeforeWarmup.pid) !== Number(initialManifest.pid) || manifestBeforeWarmup.code_hash !== initialManifest.code_hash) {
      throw new Error("Processo ou versão do BFF mudou durante o teste");
    }
    const warmup = await warmUp({ baseUrl, headers: auth.headers, timeoutMs, thinkMs, alertIds });
    console.info(JSON.stringify({
      event: "oneview_load_warmup_complete",
      scenario: scenario.name,
      generation: resetBeforeWarmup.generation,
      ...warmup,
    }));
    if (!warmup.passed) {
      results.push({
        scenario: scenario.name,
        users: scenario.users,
        run: scenario.run,
        passed: false,
        safety_pass: true,
        functional_pass: false,
        skipped_measurement: true,
        warmup,
        failure_code: "warmup_failed",
      });
      continue;
    }

    const measurementReset = await controlRequest(baseUrl, "/__oneview/load/reset", auth.headers, "POST");
    const cacheState = manifestBeforeWarmup.load_state?.cache?.implemented ? "warmed" : "not_configured";
    const result = await runScenario(scenario, {
      baseUrl,
      headers: auth.headers,
      timeoutMs,
      thinkMs,
      poolSampleMs,
      alertIds,
      generation: Number(measurementReset.generation),
      bffManifest: initialManifest,
      cacheState,
    }, results.at(-1));
    result.warmup = warmup;
    result.reset = {
      generation: Number(measurementReset.generation),
      reset_at: measurementReset.load_state?.reset_at || measurementReset.checked_at,
      max_waiting_current_scenario_only: result.pool.generation_mismatches === 0,
    };
    results.push(result);
  }

  const tenRuns = results.filter((result) => result.users === 10);
  const twentyFiveRuns = results.filter((result) => result.users === 25);
  const smokeRun = results.find((result) => result.scenario === "smoke");
  const fullProfile = scenarios.length === DEFINITIVE_SCENARIOS.length;
  const definitivePassed = Boolean(smokeRun?.passed)
    && tenRuns.length === 2
    && twentyFiveRuns.length === 2
    && [...tenRuns, ...twentyFiveRuns].every((result) => result.passed);

  const report = {
    generated_at: new Date().toISOString(),
    target: "local_bff",
    auth_mode: auth.mode,
    read_only: true,
    bff: {
      pid: initialManifest.pid,
      code_hash: initialManifest.code_hash,
      version: initialManifest.version,
      started_at: initialManifest.started_at,
      pool_max: initialManifest.pool?.max || 0,
    },
    scenarios: results,
    skipped,
    definitive_gate: {
      ten_user_consecutive_runs: tenRuns.length,
      twenty_five_user_consecutive_runs: twentyFiveRuns.length,
    },
    passed: fullProfile ? definitivePassed : results.length === scenarios.length && results.every((result) => result.passed),
  };
  const reportDir = path.resolve(rootDir, process.env.ONEVIEW_LOAD_REPORT_DIR || "reports/load");
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `oneview-load-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({
    event: "oneview_load_complete",
    status: report.passed ? "passed" : "failed",
    scenarios: results.length,
    report_file: path.relative(rootDir, reportPath).replaceAll("\\", "/"),
  }));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: "oneview_load_failed",
    code: String(error?.code || "LOAD_TEST_FAILED").slice(0, 80),
    message: String(error?.message || "Falha no teste de carga").replace(/https?:\/\/\S+/g, "[LOCAL_URL]").slice(0, 240),
  }));
  process.exitCode = 1;
});

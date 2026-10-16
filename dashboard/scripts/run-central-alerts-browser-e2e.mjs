import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOneViewSnapshotPayload } from "../api/_lib/oneview-fallback.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function firstExisting(paths) {
  for (const candidate of paths) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try next installed browser.
    }
  }
  throw new Error("chromium_browser_not_found");
}

function queryObject(url) {
  const result = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    result[key] = values.length > 1 ? values : values[0];
  }
  return result;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function emptyAlerts() {
  return {
    generated_at: new Date().toISOString(),
    items: [],
    pagination: { page: 1, page_size: 50, total_items: 0, total_pages: 0, has_next: false, has_previous: false },
    filtered_summary: { total: 0, active: 0, resolved: 0, acknowledged: 0, unacknowledged: 0, by_severity: {} },
    operational_queues: { pending: 0, acknowledged: 0, suppressed: 0, history: 0, unconfirmed: 0 },
    origin_sync: [],
  };
}

async function createFixtureServer() {
  let scenario = "snapshot";
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/__e2e__/scenario") {
        scenario = requestUrl.searchParams.get("value") || "snapshot";
        return json(res, 200, { scenario });
      }
      if (requestUrl.pathname === "/api/auth/config") {
        return json(res, 200, { ONEVIEW_READ_ONLY_MODE: "true" });
      }
      if (requestUrl.pathname === "/api/auth/me") {
        return json(res, 200, { user: { id: "browser-e2e", name: "Browser E2E", email: "browser-e2e@example.invalid" } });
      }
      if (requestUrl.pathname === "/api/oneview/alerts") {
        if (scenario === "401") return json(res, 401, { error: "authentication_required" });
        if (scenario === "empty") return json(res, 200, emptyAlerts());
        const payload = await getOneViewSnapshotPayload("alerts", { query: queryObject(requestUrl) }, {});
        return json(res, 200, { ...payload, data_source: "snapshot", fallback_code: "browser_e2e" });
      }
      const alertRoute = requestUrl.pathname.match(/^\/api\/oneview\/alerts\/([0-9a-f-]+)(\/history)?$/i);
      if (alertRoute) {
        const routeName = alertRoute[2] ? "alert-history" : "alert-detail";
        const payload = await getOneViewSnapshotPayload(routeName, { query: { id: alertRoute[1] } }, {});
        return json(res, 200, { ...payload, data_source: "snapshot", fallback_code: "browser_e2e" });
      }
      if (requestUrl.pathname === "/api/oneview/metrics") {
        return json(res, 200, { active_total: 0, acknowledged_total: 0, unacknowledged_total: 0, by_severity: [], data_source: "database" });
      }
      if (requestUrl.pathname === "/api/oneview/health") {
        return json(res, 200, { counts: { active_alerts: 0 }, data_source: "database" });
      }
      if (requestUrl.pathname === "/api/oneview/facets") {
        return json(res, 200, { customers: [], data_sources: [], data_source: "database" });
      }
      if (requestUrl.pathname === "/api/oneview/sync-logs") {
        return json(res, 200, { items: [], data_source: "database" });
      }
      if (requestUrl.pathname === "/api/oneview/history") {
        const payload = await getOneViewSnapshotPayload("history", { query: queryObject(requestUrl) }, {});
        return json(res, 200, { ...payload, data_source: "snapshot", fallback_code: "browser_e2e" });
      }
      if (requestUrl.pathname === "/api/oneview/reminders/inbox") {
        return json(res, 200, { items: [], pagination: { total_items: 0 }, data_source: "database" });
      }
      if (requestUrl.pathname === "/api/oneview/clients-summary") {
        return json(res, 200, { clients: [], items: [], data_source: "database" });
      }
      if (requestUrl.pathname === "/api/oneview/dashboard-summary") {
        return json(res, 200, { active_total: 0, acknowledged_total: 0, unacknowledged_total: 0, by_severity: [], data_source: "database" });
      }
      if (requestUrl.pathname === "/api/oneview/data-sources") {
        return json(res, 200, { items: [], data_sources: [], data_source: "database" });
      }
      if (requestUrl.pathname === "/api/oneview/operations/health") {
        return json(res, 200, { status: "healthy", summary: {}, items: [], worker: { status: "healthy" }, data_source: "database" });
      }
      if (requestUrl.pathname === "/api/oneview/runtime-health") {
        return json(res, 200, { status: "healthy", items: [], data_source: "database" });
      }
      if (requestUrl.pathname.startsWith("/api/")) {
        return json(res, 200, { items: [], data_source: "database" });
      }

      if (scenario === "chunk-failure" && /^\/assets\/Alerts-.*\.js$/.test(requestUrl.pathname)) {
        return json(res, 404, { error: "chunk_unavailable" });
      }

      const relative = requestUrl.pathname.startsWith("/assets/")
        ? requestUrl.pathname.slice(1)
        : "index.html";
      const file = path.resolve(dist, relative);
      if (!file.startsWith(`${dist}${path.sep}`) && file !== path.join(dist, "index.html")) {
        return json(res, 400, { error: "invalid_path" });
      }
      const body = await readFile(file);
      const contentType = file.endsWith(".js")
        ? "application/javascript; charset=utf-8"
        : file.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/html; charset=utf-8";
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": contentType, "Content-Length": body.length });
      res.end(body);
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : "fixture_failure" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_unavailable");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function waitForDevToolsFile(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return (await readFile(file, "utf8")).trim().split(/\r?\n/);
    } catch {
      await delay(50);
    }
  }
  throw new Error("devtools_endpoint_timeout");
}

async function openCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params || {});
  });
  return {
    on(method, listener) {
      const values = listeners.get(method) || [];
      values.push(listener);
      listeners.set(method, values);
    },
    send(method, params = {}) {
      const commandId = ++id;
      socket.send(JSON.stringify({ id: commandId, method, params }));
      return new Promise((resolve, reject) => pending.set(commandId, { resolve, reject }));
    },
    close() { socket.close(); },
  };
}

async function runBrowserCases(origin, { scenarioOrigin = origin, cases: requestedCases } = {}) {
  const chrome = await firstExisting(chromeCandidates);
  const profile = await mkdtemp(path.join(os.tmpdir(), "oneview-central-e2e-"));
  const browser = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let browserStderr = "";
  browser.stderr.on("data", (chunk) => { browserStderr += String(chunk); });

  try {
    const [port] = await waitForDevToolsFile(path.join(profile, "DevToolsActivePort"));
    const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" }).then((response) => response.json());
    const cdp = await openCdp(target.webSocketDebuggerUrl);
    const exceptions = [];
    const consoleErrors = [];
    const responses = [];
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => exceptions.push(exceptionDetails));
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error") consoleErrors.push(event);
    });
    cdp.on("Network.responseReceived", ({ response, type }) => {
      if (type === "Script" || type === "Stylesheet" || response.url.includes("/api/")) {
        responses.push({ status: response.status, type, url: response.url.replace(origin, "") });
      }
    });
    await Promise.all([cdp.send("Runtime.enable"), cdp.send("Network.enable"), cdp.send("Page.enable")]);

    const sample = await getOneViewSnapshotPayload("alerts", { query: { operational_view: "pending", page: "1", page_size: "1" } }, {});
    const sampleAlertId = sample.items?.[0]?.id;
    if (!sampleAlertId) throw new Error("browser_e2e_sample_alert_missing");
    const cases = requestedCases || [
      { name: "clean", path: "/central-alertas", scenario: "snapshot" },
      { name: "legacy", path: "/central-alertas?view=recent&severity=average&severity=disaster&severity=high&status=active&date_field=first_seen&sort=first_seen_at&order=desc", scenario: "snapshot" },
      { name: "alertas-alias", path: "/alertas?view=recent", scenario: "snapshot" },
      { name: "alerts-alias", path: "/alerts", scenario: "snapshot" },
      { name: "pagination-100", path: "/central-alertas?page_size=100", scenario: "snapshot" },
      { name: "suppressed", path: "/central-alertas?view=suppressed", scenario: "snapshot" },
      { name: "unconfirmed", path: "/central-alertas?view=unconfirmed", scenario: "snapshot" },
      { name: "drawer-tabs", path: `/central-alertas?alert=${encodeURIComponent(sampleAlertId)}`, scenario: "snapshot" },
      { name: "history-production", path: "/historico", scenario: "snapshot" },
      { name: "empty", path: "/central-alertas", scenario: "empty" },
      { name: "unauthorized", path: "/central-alertas", scenario: "401" },
    ];
    const results = [];
    for (const testCase of cases) {
      await fetch(`${scenarioOrigin}/__e2e__/scenario?value=${testCase.scenario}`);
      exceptions.length = 0;
      consoleErrors.length = 0;
      responses.length = 0;
      await cdp.send("Page.navigate", { url: `${origin}${testCase.path}` });
      await delay(1_500);
      const evaluated = await cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify({ text: document.body?.innerText || "", href: location.href, title: document.title })`,
        returnByValue: true,
      });
      const page = JSON.parse(evaluated.result.value || "{}");
      results.push({
        name: testCase.name,
        href: page.href?.replace(origin, ""),
        central_visible: /Central de Alertas/i.test(page.text || ""),
        table_visible: /filtrados por/i.test(page.text || ""),
        error_boundary: /Não foi possível exibir esta tela/i.test(page.text || ""),
        drawer_tabs: testCase.name !== "drawer-tabs" || ["Resumo", "Histórico", "Técnico"].every((label) => (page.text || "").includes(label)),
        legacy_history_visible: String(page.href || "").includes("/historico")
          && ["Histórico", "Alertas", "Eventos"].every((label) => (page.text || "").includes(label)),
        exceptions: exceptions.map((item) => ({ text: item.text, description: item.exception?.description || null, stack: item.stackTrace || null })),
        console_errors: consoleErrors.map((item) => item.args?.map((arg) => arg.description || arg.value || arg.type).join(" ") || item.type),
        response_failures: responses.filter((item) => item.status >= 400),
      });
    }
    await cdp.send("Browser.close").catch(() => undefined);
    cdp.close();
    return { results, browser_stderr: browserStderr.slice(0, 2000) };
  } finally {
    if (!browser.killed) browser.kill();
    await Promise.race([
      new Promise((resolve) => browser.once("close", resolve)),
      delay(1_000),
    ]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(profile, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await delay(200);
      }
    }
  }
}

const fixture = await createFixtureServer();
try {
  const production = await runBrowserCases(fixture.origin);
  const chunkFailure = await runBrowserCases(fixture.origin, {
    cases: [{ name: "chunk-unavailable", path: "/central-alertas", scenario: "chunk-failure" }],
  });
  const productionFailures = production.results.filter((result) => (
    !result.central_visible
    || !result.table_visible
    || result.error_boundary
    || !result.drawer_tabs
    || result.exceptions.length > 0
    || result.console_errors.length > 0
    || (result.name === "history-production" && (result.legacy_history_visible || !result.href.startsWith("/central-alertas")))
  ));
  const chunkResult = chunkFailure.results[0];
  const chunkFailureContained = Boolean(
    chunkResult?.error_boundary
    && chunkResult.response_failures.some((item) => item.status === 404 && item.type === "Script"),
  );
  const report = {
    pass: productionFailures.length === 0 && chunkFailureContained,
    production: production.results,
    chunk_unavailable: chunkResult,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  fixture.server.closeAllConnections?.();
  await Promise.race([
    new Promise((resolve) => fixture.server.close(resolve)),
    delay(5_000),
  ]);
}
process.exit(process.exitCode || 0);

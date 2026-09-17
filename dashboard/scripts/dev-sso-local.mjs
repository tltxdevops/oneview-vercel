import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const apiPort = Number(process.env.ONEVIEW_LOCAL_API_PORT || 8000);
const appPort = Number(process.env.VITE_DEV_SERVER_PORT || process.env.PORT || 6565);
const oneViewBffPort = Number(process.env.ONEVIEW_LOCAL_BFF_PORT || 8787);

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const loadedKeys = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rawValue] = trimmed.split("=");
    const key = rawKey.trim();
    if (loadedKeys.has(key)) {
      throw new Error(`[local-config] Chave duplicada em .env.local: ${key}. Mantenha apenas uma definição.`);
    }
    loadedKeys.add(key);
    let value = rawValue.join("=").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotenv(path.join(rootDir, ".env.local"));
process.env.VITE_AUTH_MODE ||= "server";
process.env.ONEVIEW_API_AUTH_REQUIRED ||= "true";
process.env.ONEVIEW_PUBLIC_ORIGIN ||= `http://localhost:${appPort}`;
process.env.MICROSOFT_REDIRECT_URI ||= `http://localhost:${appPort}/api/auth/microsoft/callback`;

const routeMap = new Map([
  ["/api/auth/config", "./api/auth/config.js"],
  ["/api/auth/me", "./api/auth/me.js"],
  ["/api/auth/logout", "./api/auth/logout.js"],
  ["/api/auth/microsoft/login", "./api/auth/microsoft/login.js"],
  ["/api/auth/microsoft/callback", "./api/auth/microsoft/callback.js"],
]);

const handlers = new Map();

async function loadHandler(relativePath) {
  if (!handlers.has(relativePath)) {
    const mod = await import(pathToFileURL(path.join(rootDir, relativePath)).href);
    handlers.set(relativePath, mod.default);
  }
  return handlers.get(relativePath);
}

function attachVercelResponseHelpers(res) {
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  return res;
}

function buildQuery(url) {
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }
  return query;
}

async function readBody(req) {
  if (!["POST", "PUT", "PATCH"].includes(req.method || "")) return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("application/json")) return JSON.parse(raw);
  return raw;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${apiPort}`}`);
  const route = routeMap.get(url.pathname);

  if (!route) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
    return;
  }

  try {
    req.query = buildQuery(url);
    req.body = await readBody(req);
    const handler = await loadHandler(route);
    await handler(req, attachVercelResponseHelpers(res));
  } catch (error) {
    console.error("[local-api]", error?.message || error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
    }
    res.end(JSON.stringify({ error: "local_api_error" }));
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `[oneview-local-api] Porta ${apiPort} já está em uso. ` +
      "Um npm run dev anterior ainda está rodando — use http://localhost:" + appPort + " " +
      "ou encerre o processo na porta " + apiPort + " antes de iniciar outro.",
    );
    process.exit(1);
  }
  throw error;
});

server.listen(apiPort, () => {
  console.log(`[oneview-local-api] http://localhost:${apiPort}`);
});

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
// `npm run dev` is the single local command. Spawn the raw Vite target here
// so this runner does not recursively start another local API server.
const vite = spawn(npmCommand, ["run", "dev:vite"], {
  cwd: rootDir,
  stdio: "inherit",
  // Node 25 on Windows can reject a direct .cmd spawn with EINVAL.
  shell: process.platform === "win32",
  env: {
    ...process.env,
    VITE_AUTH_MODE: "server",
    ...(process.env.ONEVIEW_READ_ONLY_MODE
      ? { VITE_ONEVIEW_READ_ONLY_MODE: process.env.ONEVIEW_READ_ONLY_MODE }
      : {}),
    VITE_DEV_SERVER_PORT: String(appPort),
    VITE_API_PROXY_TARGET: `http://localhost:${apiPort}`,
    VITE_ONEVIEW_API_PROXY_TARGET: `http://127.0.0.1:${oneViewBffPort}`,
  },
});

function shutdown() {
  server.close();
  vite.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
vite.on("exit", (code) => {
  server.close(() => process.exit(code ?? 0));
});

/**
 * SN-P0-11 — validação sequencial do pipeline local de incidentes.
 * Para no primeiro ponto que falhar. Não imprime senha/token.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./_lib/local-env.mjs";
import {
  getServiceNowConfig,
  sanitizeServiceNowError,
  serviceNowGet,
  ServiceNowClientError,
} from "../api/_lib/servicenow-client.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const REQUIRED = ["SERVICENOW_BASE_URL", "SERVICENOW_USERNAME", "SERVICENOW_PASSWORD"];
const BFF = process.env.ONEVIEW_LOCAL_BFF_URL || "http://127.0.0.1:8787";
const VITE = process.env.VITE_DEV_URL || "http://127.0.0.1:6565";

function missingEnv() {
  return REQUIRED.filter((key) => !String(process.env[key] || "").trim());
}

function fail(point, payload) {
  console.log(JSON.stringify({
    event: "sn_p0_11_pipeline_failed",
    first_failure: point,
    ...payload,
  }, null, 2));
  process.exitCode = 1;
}

function ok(point, payload = {}) {
  console.log(JSON.stringify({ event: "sn_p0_11_step_ok", point, ...payload }));
}

async function step1DirectServiceNow() {
  const missing = missingEnv();
  if (missing.length) {
    fail("1_servicenow_dev_direto", {
      status_http: null,
      error: "servicenow_not_configured",
      env_ausente: missing,
    });
    return false;
  }

  const config = getServiceNowConfig();
  const url = `${config.baseUrl}/api/now/table/incident?sysparm_limit=1&sysparm_fields=sys_id,number&sysparm_query=contact_type=monitoring`;
  const auth = Buffer.from(`${config.username}:${config.password}`).toString("base64");

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${auth}`,
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    fail("1_servicenow_dev_direto", {
      status_http: null,
      error: sanitizeServiceNowError(error),
      env_ausente: [],
      base_host: (() => { try { return new URL(config.baseUrl).host; } catch { return null; } })(),
    });
    return false;
  }

  if (!response.ok) {
    fail("1_servicenow_dev_direto", {
      status_http: response.status,
      error: sanitizeServiceNowError(new ServiceNowClientError(
        response.status === 401 ? "servicenow_authentication_failed"
          : response.status === 403 ? "servicenow_access_forbidden"
            : response.status === 404 ? "servicenow_not_found"
              : [502, 503, 504].includes(response.status) ? "servicenow_unavailable"
                : "servicenow_request_failed",
        { status: response.status },
      )),
      env_ausente: [],
    });
    return false;
  }

  const body = await response.json().catch(() => null);
  const count = Array.isArray(body?.result) ? body.result.length : 0;
  ok("1_servicenow_dev_direto", { status_http: response.status, rows: count });
  return true;
}

async function step2Client() {
  try {
    const page = await serviceNowGet("incident", {
      sysparm_query: "contact_type=monitoring",
      sysparm_fields: "sys_id,number",
      sysparm_limit: 1,
      sysparm_display_value: "all",
    });
    ok("2_servicenow_client", {
      status_http: 200,
      rows: page.records?.length ?? 0,
      totalCount: page.totalCount ?? null,
    });
    return true;
  } catch (error) {
    fail("2_servicenow_client", {
      status_http: error?.status ?? null,
      error: sanitizeServiceNowError(error),
      env_ausente: missingEnv(),
    });
    return false;
  }
}

async function step3Bff() {
  const url = `${BFF}/api/oneview/incidents?page=1&page_size=5`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    fail("3_get_api_oneview_incidents", {
      status_http: null,
      error: sanitizeServiceNowError(error?.cause || error),
      env_ausente: [],
      hint: "BFF local inacessível em 127.0.0.1:8787 — reinicie com SERVICENOW_* carregadas",
      bff: BFF,
    });
    return false;
  }

  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const error = typeof body?.error === "string" ? body.error : (!response.ok ? `http_${response.status}` : null);

  if (!response.ok) {
    fail("3_get_api_oneview_incidents", {
      status_http: response.status,
      error: sanitizeServiceNowError(error || "servicenow_unavailable"),
      env_ausente: error === "servicenow_not_configured" ? missingEnv() : [],
      data_source: body?.data_source ?? response.headers.get("x-oneview-data-source"),
    });
    return false;
  }

  ok("3_get_api_oneview_incidents", {
    status_http: response.status,
    rows: body?.items?.length ?? 0,
    total_items: body?.pagination?.total_items ?? null,
    data_source: body?.data_source ?? null,
  });
  return true;
}

async function step4FrontendProxy() {
  const url = `${VITE}/api/oneview/incidents?page=1&page_size=5`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    fail("4_fetchIncidents_frontend_proxy", {
      status_http: null,
      error: sanitizeServiceNowError(error?.cause || error),
      env_ausente: [],
      vite: VITE,
    });
    return false;
  }

  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const error = typeof body?.error === "string" ? body.error : (!response.ok ? `http_${response.status}` : null);

  if (!response.ok) {
    fail("4_fetchIncidents_frontend_proxy", {
      status_http: response.status,
      error: sanitizeServiceNowError(error || "servicenow_unavailable"),
      env_ausente: error === "servicenow_not_configured" ? missingEnv() : [],
    });
    return false;
  }

  ok("4_fetchIncidents_frontend_proxy", {
    status_http: response.status,
    rows: body?.items?.length ?? 0,
    total_items: body?.pagination?.total_items ?? null,
  });
  return true;
}

async function main() {
  const missing = missingEnv();
  console.log(JSON.stringify({
    event: "sn_p0_11_env_check",
    servicenow_env_present: {
      SERVICENOW_BASE_URL: Boolean(process.env.SERVICENOW_BASE_URL?.trim()),
      SERVICENOW_USERNAME: Boolean(process.env.SERVICENOW_USERNAME?.trim()),
      SERVICENOW_PASSWORD: Boolean(process.env.SERVICENOW_PASSWORD),
      SERVICENOW_INCIDENTS_ENABLED: process.env.SERVICENOW_INCIDENTS_ENABLED || null,
    },
    env_ausente: missing,
  }));

  if (!(await step1DirectServiceNow())) return;
  if (!(await step2Client())) return;
  if (!(await step3Bff())) return;
  if (!(await step4FrontendProxy())) return;

  console.log(JSON.stringify({
    event: "sn_p0_11_pipeline_ok",
    message: "Pipeline local de incidentes OK nos 4 pontos",
  }, null, 2));
}

main().catch((error) => {
  fail("unexpected", {
    status_http: null,
    error: sanitizeServiceNowError(error),
    env_ausente: missingEnv(),
  });
});

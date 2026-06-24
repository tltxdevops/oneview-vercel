import { PublicClientApplication, type Configuration, type RedirectRequest, LogLevel } from "@azure/msal-browser";
import { getRuntimeAppBasePath } from "@/lib/basePath";
import { isDemoMode } from "@/lib/demo-mode";

declare global {
  interface Window {
    __APP_CONFIG__?: Record<string, string | undefined>;
  }
}

const baseUrl = getRuntimeAppBasePath();
const origin = typeof window !== "undefined" ? window.location.origin : "";
const isLocalhost = typeof window !== "undefined" && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(window.location.origin);
const runtimeConfig = typeof window !== "undefined" ? window.__APP_CONFIG__ ?? {} : {};

const PLACEHOLDER_PATTERNS = [
  /^0{8}-0{4}-0{4}-0{4}-0{12}$/i,
  /[<>]/,
  /application\s*\(client\)\s*id/i,
  /directory\s*\(tenant\)\s*id/i,
  /seu[_\s-]*(tenant|client|dominio|domínio|guid|id)/i,
  /(tenant|client)[_\s-]*guid/i,
  /^undefined$/i,
  /^null$/i,
];

function cleanAuthValue(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  if (!normalized) return "";
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized))) return "";
  return normalized;
}

function readAuthConfig(...keys: string[]) {
  for (const key of keys) {
    const cleanedRuntimeValue = cleanAuthValue(runtimeConfig[key]);
    if (cleanedRuntimeValue) return cleanedRuntimeValue;

    const cleanedBuildValue = cleanAuthValue(import.meta.env[key]);
    if (cleanedBuildValue) return cleanedBuildValue;
  }

  return "";
}

const isBrowser = typeof window !== "undefined";
const hasCryptoSupport = !isBrowser
  ? true
  : (() => {
      const nativeCrypto = window.crypto || (window as unknown as { msCrypto?: Crypto }).msCrypto;
      return Boolean(nativeCrypto && ("subtle" in nativeCrypto));
    })();
const isSecureContext = !isBrowser ? true : window.isSecureContext !== false;

const fallbackRedirectPath = `${baseUrl}/sso/callback`;
const fallbackLogoutPath = `${baseUrl}/login`;
const currentOriginRedirectUri =
  origin ? `${origin}${fallbackRedirectPath.startsWith("/") ? fallbackRedirectPath : `/${fallbackRedirectPath}`}` : fallbackRedirectPath || "/sso/callback";
const currentOriginLogoutUri =
  origin ? `${origin}${fallbackLogoutPath.startsWith("/") ? fallbackLogoutPath : `/${fallbackLogoutPath}`}` : fallbackLogoutPath || "/login";

const configuredRedirectUri = readAuthConfig("VITE_AZURE_REDIRECT_URI", "MICROSOFT_REDIRECT_URI");
const configuredLogoutUri = readAuthConfig("VITE_AZURE_POST_LOGOUT_URI", "MICROSOFT_POST_LOGOUT_URI");
const localRedirectUri = cleanAuthValue(import.meta.env.VITE_AZURE_REDIRECT_URI_LOCAL);
const localLogoutUri = cleanAuthValue(import.meta.env.VITE_AZURE_POST_LOGOUT_URI_LOCAL);

const resolvedRedirectUri =
  (isLocalhost && localRedirectUri) ? localRedirectUri :
  configuredRedirectUri || currentOriginRedirectUri;

const resolvedLogoutUri =
  (isLocalhost && localLogoutUri) ? localLogoutUri :
  configuredLogoutUri || currentOriginLogoutUri;

const tenantId = readAuthConfig(
  "VITE_AZURE_TENANT_ID",
  "AZURE_TENANT_ID",
  "MICROSOFT_TENANT_ID",
  "NEXT_PUBLIC_MICROSOFT_TENANT_ID",
);
const clientId = readAuthConfig(
  "VITE_AZURE_CLIENT_ID",
  "AZURE_CLIENT_ID",
  "MICROSOFT_CLIENT_ID",
  "NEXT_PUBLIC_MICROSOFT_CLIENT_ID",
);

export const hasConfiguredClient = Boolean(clientId);
export const hasConfiguredTenant = Boolean(tenantId);

if (!isDemoMode && !hasConfiguredClient) {
  console.warn("[auth] VITE_AZURE_CLIENT_ID não definido. Configure o .env para habilitar o SSO.");
}
if (!isDemoMode && !hasConfiguredTenant) {
  console.warn("[auth] VITE_AZURE_TENANT_ID não definido. Configure o .env para habilitar o SSO.");
}
if (isBrowser && !hasCryptoSupport) {
  console.error("[auth] O navegador não expõe window.crypto em um contexto seguro. A autenticação SSO exige https ou localhost.");
}
if (isBrowser && !isSecureContext) {
  console.error("[auth] O contexto não é seguro (https). A autenticação SSO só funciona em conexões seguras.");
}

const authority =
  readAuthConfig("VITE_AZURE_AUTHORITY", "MICROSOFT_AUTHORITY") ||
  (tenantId ? `https://login.microsoftonline.com/${tenantId}` : "https://login.microsoftonline.com/common");

const scopesEnv = readAuthConfig("VITE_AZURE_SCOPES", "MICROSOFT_SCOPE") || "openid profile email offline_access User.Read";
const scopes = scopesEnv.split(/[,\s]+/).filter(Boolean);

const logLevelFromEnv = (() => {
  const level = (readAuthConfig("VITE_MSAL_LOG_LEVEL") || "warning").toString().trim().toLowerCase();
  switch (level) {
    case "verbose":
    case "trace":
      return LogLevel.Verbose;
    case "info":
      return LogLevel.Info;
    case "error":
      return LogLevel.Error;
    case "warning":
    default:
      return LogLevel.Warning;
  }
})();

type MsalLogEntry = {
  level: LogLevel;
  label: string;
  message: string;
  timestamp: string;
};

function pushMsalLog(level: LogLevel, message: string) {
  if (!isBrowser) return;
  const win = window as unknown as { __MSAL_LOGS__?: MsalLogEntry[] };
  if (!win.__MSAL_LOGS__) {
    win.__MSAL_LOGS__ = [];
  }
  const entry: MsalLogEntry = {
    level,
    label: LogLevel[level],
    message,
    timestamp: new Date().toISOString(),
  };
  win.__MSAL_LOGS__.push(entry);
  if (win.__MSAL_LOGS__.length > 200) {
    win.__MSAL_LOGS__.shift();
  }
}

const msalConfig: Configuration = {
  auth: {
    clientId: clientId || "00000000-0000-0000-0000-000000000000",
    authority,
    redirectUri: resolvedRedirectUri,
    postLogoutRedirectUri: resolvedLogoutUri,
    navigateToLoginRequestUrl: false,
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      logLevel: logLevelFromEnv,
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        pushMsalLog(level, message);
        const prefix = `[MSAL ${LogLevel[level]}]`;
        if (level === LogLevel.Error) {
          console.error(prefix, message);
        } else if (level === LogLevel.Warning) {
          console.warn(prefix, message);
        } else {
          console.info(prefix, message);
        }
      },
    },
  },
};

export const hasSecureCryptoSupport = hasCryptoSupport;
export const isRunningInSecureContext = isSecureContext;

export const isSsoEnvironmentReady = hasConfiguredClient && hasConfiguredTenant && hasCryptoSupport && isSecureContext;

export const msalInstance = isSsoEnvironmentReady ? new PublicClientApplication(msalConfig) : null;

export const loginRequest: RedirectRequest = {
  scopes: scopes.length > 0 ? scopes : ["openid", "profile", "email"],
  prompt: "select_account",
};

export const graphConfig = {
  userInfo: "https://graph.microsoft.com/v1.0/me",
  photo: "https://graph.microsoft.com/v1.0/me/photo/$value",
};

export const appBasePath = baseUrl || "";
export const postLogoutRedirectUri = resolvedLogoutUri;

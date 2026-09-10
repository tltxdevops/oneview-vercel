import type { AccountInfo } from "@azure/msal-browser";

export type ServerAuthUser = {
  id: string | null;
  name: string;
  email: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  jobTitle?: string;
  photo?: string;
};

const API_BASE = typeof window !== "undefined" ? `${window.location.origin}/api` : "/api";
const OAUTH_STATE_KEY = "oneview_oauth_state";

function randomState() {
  if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function serverAuthEnabled() {
  return import.meta.env.VITE_AUTH_MODE !== "msal";
}

function callbackParamsFromUrl() {
  if (typeof window === "undefined") return null;
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
  const get = (key: string) => search.get(key) || hash.get(key) || "";
  const code = get("code");
  const state = get("state");
  const error = get("sso_error") || get("error");
  return code || state || error ? { code, state, error } : null;
}

function clearCallbackParamsFromUrl() {
  if (typeof window !== "undefined") window.history.replaceState({}, document.title, window.location.pathname || "/");
}

export async function startServerMicrosoftLogin() {
  const state = randomState();
  window.sessionStorage.setItem(OAUTH_STATE_KEY, state);
  const response = await fetch(`${API_BASE}/auth/microsoft/login?state=${encodeURIComponent(state)}`, {
    credentials: "include", cache: "no-store",
  });
  if (!response.ok) {
    let errorCode = "";
    try {
      const body = await response.json() as { error?: unknown };
      errorCode = typeof body.error === "string" ? body.error : "";
    } catch { /* safe generic message */ }
    if (errorCode === "microsoft_sso_not_configured") {
      throw new Error("SSO server-side não configurado. Defina MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET e APP_SESSION_SECRET no ambiente local.");
    }
    throw new Error("Não foi possível iniciar o login Microsoft.");
  }
  const payload = (await response.json()) as { authUrl?: string };
  if (!payload.authUrl) throw new Error("URL de autenticação Microsoft não retornada.");
  window.location.href = payload.authUrl;
}

export async function completeServerMicrosoftLoginFromUrl(): Promise<ServerAuthUser | null> {
  const params = callbackParamsFromUrl();
  if (!params) return null;
  try {
    if (params.error) throw new Error(`SSO Microsoft retornou erro: ${params.error}`);
    const expectedState = window.sessionStorage.getItem(OAUTH_STATE_KEY) || "";
    if (!params.state || params.state !== expectedState) throw new Error("Estado SSO inválido. Inicie o login novamente.");
    if (!params.code) throw new Error("Código SSO ausente. Inicie o login novamente.");
    const response = await fetch(`${API_BASE}/auth/microsoft/callback`, {
      method: "POST", credentials: "include", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: params.code }),
    });
    if (!response.ok) throw new Error(`Falha ao finalizar SSO Microsoft: ${response.status}`);
    const payload = (await response.json()) as { user?: ServerAuthUser | null };
    if (!payload.user?.id) throw new Error("Sessão SSO não retornou usuário válido.");
    window.sessionStorage.removeItem(OAUTH_STATE_KEY);
    return payload.user;
  } finally {
    clearCallbackParamsFromUrl();
  }
}

/** Cookie HttpOnly is the sole browser credential; no auth token reaches storage. */
export async function fetchServerAuthUser(): Promise<ServerAuthUser | null> {
  const response = await fetch(`${API_BASE}/auth/me`, { credentials: "include", cache: "no-store" });
  if (!response.ok) return null;
  const payload = (await response.json()) as { user?: ServerAuthUser | null };
  return payload.user?.id ? payload.user : null;
}

export async function logoutServerAuth() {
  const response = await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => null);
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(OAUTH_STATE_KEY);
  if (!response?.ok) return;
  const payload = await response.json().catch(() => ({})) as { logout_url?: unknown };
  if (typeof payload.logout_url === "string" && payload.logout_url) window.location.assign(payload.logout_url);
}

export function accountFromServerUser(user: ServerAuthUser): AccountInfo {
  return {
    homeAccountId: user.id || user.email,
    environment: "server-session",
    tenantId: "",
    username: user.email,
    localAccountId: user.id || user.email,
    name: user.name,
  };
}

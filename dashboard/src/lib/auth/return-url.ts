const AUTH_RETURN_TO_KEY = "oneview_auth_return_to";
const AUTH_ENTRY_PATHS = new Set(["/login", "/sso/callback", "/auth/microsoft/callback"]);

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Allows only a same-app pathname plus query; never an absolute redirect target. */
export function normalizeAuthReturnTo(value?: string | null): string | null {
  const raw = String(value || "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  try {
    const url = new URL(raw, "https://oneview.invalid");
    if (url.origin !== "https://oneview.invalid" || AUTH_ENTRY_PATHS.has(url.pathname)) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function authReturnToFromLocation(location: Pick<Location, "pathname" | "search">): string {
  return normalizeAuthReturnTo(`${location.pathname || "/"}${location.search || ""}`) || "/";
}

export function rememberAuthReturnTo(value?: string | null): string {
  const target = normalizeAuthReturnTo(value) || "/";
  browserStorage()?.setItem(AUTH_RETURN_TO_KEY, target);
  return target;
}

export function consumeAuthReturnTo(fallback?: string | null): string {
  const storage = browserStorage();
  const stored = normalizeAuthReturnTo(storage?.getItem(AUTH_RETURN_TO_KEY));
  storage?.removeItem(AUTH_RETURN_TO_KEY);
  return stored || normalizeAuthReturnTo(fallback) || "/";
}

const configuredBase = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

function detectRuntimeBase(): string {
  if (configuredBase && configuredBase !== "/") {
    return configuredBase;
  }

  if (typeof window === "undefined") {
    return "";
  }

  const allowedHosts = (import.meta.env.VITE_RUNTIME_BASE_HOSTS ?? "devops.teletex.com.br")
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);

  const isAllowedHost = allowedHosts.length === 0
    ? true
    : allowedHosts.some((h) => window.location.hostname === h || window.location.hostname.endsWith(`.${h}`));

  if (!isAllowedHost) {
    return "";
  }

  const hints = (import.meta.env.VITE_RUNTIME_BASE_HINTS ?? "noc")
    .split(/[\s,]+/)
    .map((hint) => hint.trim())
    .filter(Boolean);

  if (hints.length === 0) {
    return "";
  }

  const segments = window.location.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }

  const first = segments[0];
  return hints.includes(first) ? `/${first}` : "";
}

export function getAppBasePath() {
  return detectRuntimeBase();
}

export function getBrowserRouterBase() {
  const base = detectRuntimeBase();
  return base || undefined;
}

export function getRuntimeAppBasePath() {
  return detectRuntimeBase();
}

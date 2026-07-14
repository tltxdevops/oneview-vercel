declare global {
  interface Window {
    __APP_CONFIG__?: Record<string, string | undefined>;
  }
}

function readConfigValue(...keys: string[]) {
  for (const key of keys) {
    const runtimeValue = typeof window !== "undefined" ? window.__APP_CONFIG__?.[key] : undefined;
    const value = runtimeValue ?? import.meta.env[key];
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return "";
}

function readBooleanFlag(defaultValue: boolean, ...keys: string[]) {
  const value = readConfigValue(...keys).toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return defaultValue;
}

// Auth bypass is independent from the OneView data source.
export const isDemoMode = readBooleanFlag(false, "ONEVIEW_AUTH_BYPASS_MODE", "VITE_AUTH_BYPASS_MODE");

export const isReadOnlyMode = readBooleanFlag(
  true,
  "ONEVIEW_READ_ONLY_MODE",
  "NEXT_PUBLIC_ONEVIEW_READ_ONLY_MODE",
  "VITE_ONEVIEW_READ_ONLY_MODE",
);

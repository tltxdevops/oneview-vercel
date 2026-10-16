function buildBoolean(value: string | undefined, fallback: boolean) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

/**
 * The standalone legacy history screen is a local-development diagnostic only.
 * Production and Preview builds always fail closed to the Central history queue.
 */
export const legacyHistoryRouteEnabled = import.meta.env.DEV
  && buildBoolean(import.meta.env.VITE_ENABLE_LEGACY_HISTORY_PAGE, true);

export const DEFAULT_ONEVIEW_PRIMARY_DATA_SOURCE_NAME = "teletex-http";

export function getPrimaryDataSourceName(env = process.env) {
  const configured = String(env.ONEVIEW_PRIMARY_DATA_SOURCE_NAME || "").trim().toLowerCase();
  return configured || DEFAULT_ONEVIEW_PRIMARY_DATA_SOURCE_NAME;
}

/**
 * Production operational scope. Keep this allowlist server-side so a request
 * can narrow the result, but can never add Maps or an arbitrary datasource.
 */
export const ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES = Object.freeze([
  "teletex-http",
  "rhp",
  "castrolanda",
  "zurich",
  "fraport-for",
  "fraport-poa",
]);

export function getOperationalDataSourceNames() {
  return [...ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES];
}

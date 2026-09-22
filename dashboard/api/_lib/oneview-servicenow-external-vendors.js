/**
 * V1 allow-list for u_external_vendor on direct ServiceNow hold writes.
 * No ServiceNow choice-table lookup in this card — values come from env or defaults.
 */
export const DEFAULT_EXTERNAL_VENDORS = Object.freeze(["Cisco"]);

function clean(value) {
  return String(value || "").trim();
}

export function parseExternalVendorsCsv(raw) {
  const items = String(raw || "")
    .split(",")
    .map((item) => clean(item))
    .filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item.slice(0, 120));
  }
  return result.length ? result : [...DEFAULT_EXTERNAL_VENDORS];
}

export function getServiceNowExternalVendorsConfig(env = process.env) {
  const configured = clean(env.ONEVIEW_SERVICENOW_EXTERNAL_VENDORS);
  return Object.freeze({
    externalVendors: parseExternalVendorsCsv(configured),
    source: configured
      ? "env:ONEVIEW_SERVICENOW_EXTERNAL_VENDORS"
      : "default:oneview-servicenow-external-vendors",
  });
}

export function resolveExternalVendor(value, config = getServiceNowExternalVendorsConfig()) {
  const needle = clean(value).toLowerCase();
  if (!needle) return null;
  return config.externalVendors.find((item) => item.toLowerCase() === needle) || null;
}

export function publicExternalVendorOptions(config = getServiceNowExternalVendorsConfig()) {
  return {
    external_vendors: [...config.externalVendors],
    vendor_source: config.source,
    hold_reason_label: "Aguardando fornecedor",
  };
}

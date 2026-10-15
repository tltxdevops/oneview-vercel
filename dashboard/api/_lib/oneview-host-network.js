const INTERFACE_TYPE_LABELS = Object.freeze({
  1: "Agent",
  2: "SNMP",
  3: "IPMI",
  4: "JMX",
});

function text(value, maxLength = 500) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim().slice(0, maxLength);
  return normalized || null;
}

function flag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function typeNumber(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : null;
}

function safeIp(value) {
  const normalized = text(value, 128);
  return normalized && /^[0-9a-f:.%]+$/i.test(normalized) ? normalized : null;
}

function safeDns(value) {
  const normalized = text(value, 253);
  return normalized && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(normalized) ? normalized : null;
}

function safePort(value) {
  const normalized = text(value, 80);
  return normalized && /^[a-zA-Z0-9_{}$.:+-]+$/.test(normalized) ? normalized : null;
}

function safeError(value) {
  const normalized = text(value, 500);
  return normalized ? normalized.replace(/\b(?:token|password|senha|secret|authorization|bearer)\s*[:=]\s*\S+/gi, "[DADO_PROTEGIDO]") : null;
}

export function normalizeHostInterfaces(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    const type = typeNumber(item?.type);
    return {
      interfaceid: text(item?.interfaceid, 80),
      type,
      main: flag(item?.main),
      useip: flag(item?.useip),
      ip: safeIp(item?.ip),
      dns: safeDns(item?.dns),
      port: safePort(item?.port),
      available: text(item?.available, 16),
      error: safeError(item?.error),
      interface_type: type ? INTERFACE_TYPE_LABELS[type] : "Desconhecida",
    };
  });
}

export function buildHostNetwork(value) {
  const interfaces = normalizeHostInterfaces(value);
  // Never promote a secondary interface. Only Zabbix's explicit main interface
  // is allowed to define primary IP/DNS and connection metadata.
  const main = interfaces.find((item) => item.main) || null;
  if (!main) {
    return {
      primary_ip: null,
      primary_dns: null,
      interface_type: null,
      port: null,
      available: null,
      interfaces,
    };
  }
  return {
    primary_ip: main.useip && main.ip ? main.ip : null,
    primary_dns: main.dns,
    interface_type: main.interface_type,
    port: main.port,
    available: main.available,
    interfaces,
  };
}

/**
 * Maintenance windows. This module plans and refuses.
 * It does not call Zabbix, does not write the database and does not notify Theo.
 *
 * ACK permission and suppress_problems do not authorize maintenance.create.
 * Admin or Super admin is never implied by being signed in.
 */

export const MAINTENANCE_WRITES_ENABLED_ENV = "ONEVIEW_MAINTENANCE_WRITES_ENABLED";
export const MAINTENANCE_OPERATORS_ENV = "ONEVIEW_MAINTENANCE_OPERATOR_EMAILS";

export const MAINTENANCE_DURATION_PRESETS = Object.freeze([
  { id: "30m", seconds: 30 * 60 },
  { id: "2h", seconds: 2 * 60 * 60 },
  { id: "8h", seconds: 8 * 60 * 60 },
  { id: "custom", seconds: null },
]);

export const DEFAULT_MAINTENANCE_PRESET = "2h";
export const DEFAULT_COLLECT_DATA = true;
export const MAX_MAINTENANCE_HOSTS = 50;
export const MAX_MAINTENANCE_TAGS = 10;
export const MAX_MAINTENANCE_SECONDS = 14 * 24 * 60 * 60;

/**
 * Expected versions. They describe compatibility, not a live probe.
 * write_ready stays false until the datasource version is read from that Zabbix.
 */
export const ZABBIX_MAINTENANCE_COMPATIBILITY = Object.freeze({
  "teletex-http": { expected_version: "7.4.11", maintenance_get: true, maintenance_create: true, write_ready: false },
  zurich: { expected_version: "7.2.2", maintenance_get: true, maintenance_create: true, write_ready: false },
  rhp: { expected_version: "7.0.22", maintenance_get: true, maintenance_create: true, write_ready: false },
  maps: { expected_version: "6.0.5", maintenance_get: true, maintenance_create: true, write_ready: false },
  "fraport-for": { expected_version: "7.2.5", maintenance_get: true, maintenance_create: true, write_ready: false },
  "fraport-poa": { expected_version: "7.2.5", maintenance_get: true, maintenance_create: true, write_ready: false },
  castrolanda: { expected_version: "7.4.4", maintenance_get: true, maintenance_create: true, write_ready: false },
});

const HOST_ID = /^[0-9]{1,20}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,120}$/;

export function maintenanceWritesEnabled(env = process.env) {
  return String(env?.[MAINTENANCE_WRITES_ENABLED_ENV] || "").trim() === "true";
}

export function authorizeMaintenanceCreate(actor, env = process.env) {
  if (!maintenanceWritesEnabled(env)) {
    return { allowed: false, reason: "maintenance_writes_disabled" };
  }
  const email = String(actor?.email || "").trim().toLowerCase();
  const allow = String(env?.[MAINTENANCE_OPERATORS_ENV] || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !EMAIL.test(email) || !allow.includes(email)) {
    return { allowed: false, reason: "maintenance_permission_denied" };
  }
  return { allowed: true, reason: null };
}

function text(value, max) {
  const cleaned = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.slice(0, max);
}

function invalid(reason) {
  const error = new Error(reason);
  error.code = "invalid_query";
  error.reason = reason;
  return error;
}

/**
 * Server-side draft check. Host names are not hostids.
 * A customer is never expanded to a host group.
 */
export function validateMaintenanceDraft(input, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("invalid_body");
  const customer = text(input.customer, 160);
  const datasource = text(input.datasource, 80);
  const reason = text(input.reason, 500);
  const requester = text(input.requester, 160);
  const preset = text(input.duration_preset || DEFAULT_MAINTENANCE_PRESET, 16);
  const hosts = Array.isArray(input.hosts) ? input.hosts : null;
  const groups = Array.isArray(input.groups) ? input.groups : [];
  const tags = Array.isArray(input.tags) ? input.tags : [];
  if (!customer) throw invalid("customer_required");
  if (!ZABBIX_MAINTENANCE_COMPATIBILITY[datasource]) throw invalid("datasource_unknown");
  if (!reason || reason.length < 3) throw invalid("reason_required");
  if (!requester) throw invalid("requester_required");
  if (!hosts || hosts.length < 1 || hosts.length > MAX_MAINTENANCE_HOSTS) throw invalid("hosts_required");
  if (groups.length && input.groups_allowed !== true) throw invalid("groups_not_allowed");
  if (groups.length > MAX_MAINTENANCE_HOSTS) throw invalid("groups_limit");
  if (tags.length > MAX_MAINTENANCE_TAGS) throw invalid("tags_limit");
  if (!MAINTENANCE_DURATION_PRESETS.some((item) => item.id === preset)) throw invalid("duration_invalid");

  const normalizedHosts = hosts.map((host) => {
    if (!host || typeof host !== "object") throw invalid("host_invalid");
    const hostid = text(host.hostid, 20);
    const name = text(host.name, 200);
    if (hostid && !HOST_ID.test(hostid)) throw invalid("hostid_invalid");
    if (!hostid && !name) throw invalid("host_invalid");
    return { hostid: hostid || null, name: name || null, resolved: Boolean(hostid) };
  });
  const normalizedTags = tags.map((tag) => {
    if (!tag || typeof tag !== "object") throw invalid("tag_invalid");
    const tagName = text(tag.tag, 80);
    const value = text(tag.value, 160);
    if (!tagName) throw invalid("tag_invalid");
    return { tag: tagName, value };
  });

  const startMs = Date.parse(input.active_since || "");
  const endMs = Date.parse(input.active_till || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw invalid("window_invalid");
  if (endMs <= startMs) throw invalid("window_invalid");
  const period = Math.floor((endMs - startMs) / 1000);
  if (period < 60 || period > MAX_MAINTENANCE_SECONDS) throw invalid("duration_invalid");
  if (startMs < now - 30 * 60 * 1000) throw invalid("window_in_the_past");
  if (startMs > now + 90 * 24 * 60 * 60 * 1000) throw invalid("window_too_far");

  return {
    customer,
    datasource,
    reason,
    requester,
    duration_preset: preset,
    collect_data: input.collect_data !== false,
    hosts: normalizedHosts,
    groups: [],
    tags: normalizedTags,
    active_since: new Date(startMs).toISOString(),
    active_till: new Date(endMs).toISOString(),
    period_seconds: period,
    maintenance_type: 0,
    timeperiod_type: 0,
  };
}

export function planMaintenanceOperations(drafts, { writesEnabled = false } = {}) {
  const list = Array.isArray(drafts) ? drafts : [drafts];
  return list.map((draft) => {
    const compatibility = ZABBIX_MAINTENANCE_COMPATIBILITY[draft.datasource];
    const unresolved = draft.hosts.filter((host) => !host.resolved);
    const blockers = [];
    if (!compatibility?.write_ready) blockers.push("live_version_not_confirmed");
    if (unresolved.length) blockers.push("hostids_not_confirmed");
    if (!writesEnabled) blockers.push("maintenance_writes_disabled");
    return {
      datasource: draft.datasource,
      expected_version: compatibility?.expected_version || null,
      maintenance_get: Boolean(compatibility?.maintenance_get),
      maintenance_create: "not_sent",
      host_count: draft.hosts.length,
      unresolved_hosts: unresolved.length,
      customer_is_not_a_hostgroup: true,
      can_confirm: false,
      blockers,
      idempotency_key: null,
    };
  });
}

export const REMINDER_MILESTONES = Object.freeze(["before_end_15m", "ended", "ended_with_active"]);

export function reminderDedupeKey({ datasource, maintenanceId, milestone }) {
  const source = text(datasource, 80);
  const id = text(maintenanceId, 40);
  const mark = text(milestone, 40);
  if (!source || !HOST_ID.test(id) || !REMINDER_MILESTONES.includes(mark)) return null;
  return `${source}:${id}:${mark}`;
}

export function planMaintenanceReminders({ datasource, maintenanceId, customer, hostCount }) {
  return REMINDER_MILESTONES.map((milestone) => ({
    dedupe_key: reminderDedupeKey({ datasource, maintenanceId, milestone }),
    milestone,
    customer: text(customer, 160),
    host_count: Number.isInteger(hostCount) ? hostCount : null,
    channels: ["oneview", "theo"],
    status: "not_sent",
    theo: "withheld_containment",
  }));
}

export function maintenanceHistoryIntent(draft, actorEmail) {
  return {
    persisted: false,
    datasource: draft.datasource,
    maintenanceid: null,
    customer: draft.customer,
    requester: draft.requester,
    operator_email: text(actorEmail, 160).toLowerCase() || null,
    hosts: draft.hosts,
    active_since: draft.active_since,
    active_till: draft.active_till,
    reason: draft.reason,
  };
}

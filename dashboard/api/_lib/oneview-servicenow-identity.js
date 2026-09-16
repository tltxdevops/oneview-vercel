/**
 * ServiceNow identity read contract for future OneView actions.
 *
 * Only trusted Entra actors reach this module. It performs Table API GETs only
 * and keeps ServiceNow sys_ids on the backend.
 */
import {
  getServiceNowConfig,
  normalizeServiceNowSysId,
  serviceNowGet,
} from "./servicenow-client.js";
import { withOneViewRuntimeCacheEntry } from "./oneview-runtime-cache.js";

export const SERVICENOW_IDENTITY_ERROR = Object.freeze({
  USER_NOT_FOUND: "SERVICENOW_USER_NOT_FOUND",
  USER_AMBIGUOUS: "SERVICENOW_USER_AMBIGUOUS",
  USER_INACTIVE: "SERVICENOW_USER_INACTIVE",
  NOC_MEMBERSHIP_REQUIRED: "SERVICENOW_NOC_MEMBERSHIP_REQUIRED",
  UNAVAILABLE: "SERVICENOW_UNAVAILABLE",
});

export const SERVICENOW_USER_FIELDS = "sys_id,name,email,user_name,active";
export const SERVICENOW_MEMBERSHIP_FIELDS = "sys_id,user,group";
const USER_CACHE_TTL_MS = 15 * 60 * 1000;
const MEMBERSHIP_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;

export class ServiceNowIdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = "ServiceNowIdentityError";
    this.code = code;
  }
}

function clean(value) {
  return String(value || "").trim();
}

function positiveInt(value, fallback, { min = 1_000, max = 3_600_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizedEmail(value) {
  const email = clean(value).toLowerCase();
  return /^[^\s^=]+@[^\s^=]+\.[^\s^=]+$/.test(email) ? email : "";
}

function referenceValue(value) {
  if (value && typeof value === "object") {
    return clean(value.value || value.display_value || value.sys_id || "");
  }
  return clean(value);
}

function isActive(value) {
  return ["true", "1", "yes"].includes(referenceValue(value).toLowerCase());
}

function userFromRecord(record) {
  return Object.freeze({
    sys_id: normalizeServiceNowSysId(referenceValue(record?.sys_id)),
    name: clean(record?.name),
    email: normalizedEmail(referenceValue(record?.email)),
    username: clean(record?.user_name),
    active: isActive(record?.active),
  });
}

function safeUserQuery(email, activeOnly = true) {
  return activeOnly ? `email=${email}^active=true` : `email=${email}`;
}

function identityError(code) {
  return new ServiceNowIdentityError(code);
}

function throwUnavailable(error) {
  if (error instanceof ServiceNowIdentityError) throw error;
  throw identityError(SERVICENOW_IDENTITY_ERROR.UNAVAILABLE);
}

export function getServiceNowIdentityConfig(env = process.env) {
  return Object.freeze({
    nocAssignmentGroupSysId: normalizeServiceNowSysId(env.SERVICENOW_NOC_ASSIGNMENT_GROUP_SYS_ID),
    nocAssignmentGroupName: clean(env.SERVICENOW_NOC_ASSIGNMENT_GROUP_NAME),
    userCacheTtlMs: positiveInt(env.SERVICENOW_USER_CACHE_TTL_MS, USER_CACHE_TTL_MS),
    membershipCacheTtlMs: positiveInt(env.SERVICENOW_NOC_MEMBERSHIP_CACHE_TTL_MS, MEMBERSHIP_CACHE_TTL_MS),
  });
}

export function publicServiceNowIdentityError(error) {
  const code = error?.code;
  return Object.values(SERVICENOW_IDENTITY_ERROR).includes(code)
    ? code
    : SERVICENOW_IDENTITY_ERROR.UNAVAILABLE;
}

export function createServiceNowIdentityResolver({
  env = process.env,
  getPage = serviceNowGet,
  serviceNowConfigProvider = getServiceNowConfig,
  identityConfigProvider = getServiceNowIdentityConfig,
  cache = withOneViewRuntimeCacheEntry,
  now = () => Date.now(),
} = {}) {
  const identityConfig = identityConfigProvider(env);
  const serviceNowConfig = serviceNowConfigProvider(env);

  async function queryUsers(email, activeOnly) {
    try {
      const result = await getPage("sys_user", {
        config: serviceNowConfig,
        sysparm_query: safeUserQuery(email, activeOnly),
        sysparm_fields: SERVICENOW_USER_FIELDS,
        sysparm_limit: 2,
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
      });
      return (result?.records || []).slice(0, 2).map(userFromRecord);
    } catch (error) {
      throwUnavailable(error);
    }
  }

  async function resolveServiceNowUser(actor) {
    const email = normalizedEmail(actor?.actor_username);
    if (!email) throw identityError(SERVICENOW_IDENTITY_ERROR.USER_NOT_FOUND);
    const cacheKey = `servicenow:user:${email}`;
    const entry = await cache(cacheKey, async () => {
      const activeUsers = await queryUsers(email, true);
      if (activeUsers.length > 1) throw identityError(SERVICENOW_IDENTITY_ERROR.USER_AMBIGUOUS);
      if (activeUsers.length === 1) {
        const user = activeUsers[0];
        if (!user.sys_id || !user.email || !user.active) throw identityError(SERVICENOW_IDENTITY_ERROR.USER_INACTIVE);
        return user;
      }

      // The active query is canonical. This second diagnostic read only
      // distinguishes a missing user from an inactive/ambiguous account.
      const users = await queryUsers(email, false);
      if (users.length === 0) throw identityError(SERVICENOW_IDENTITY_ERROR.USER_NOT_FOUND);
      if (users.length > 1) throw identityError(SERVICENOW_IDENTITY_ERROR.USER_AMBIGUOUS);
      const user = users[0];
      if (!user.sys_id || !user.email || !user.active) throw identityError(SERVICENOW_IDENTITY_ERROR.USER_INACTIVE);
      return user;
    }, {
      ttlMs: identityConfig.userCacheTtlMs,
      maxEntries: CACHE_MAX_ENTRIES,
      now,
    });
    return { user: entry.value, cache: entry };
  }

  async function resolveNocMembership(userSysId) {
    const userId = normalizeServiceNowSysId(userSysId);
    const groupId = identityConfig.nocAssignmentGroupSysId;
    if (!userId || !groupId) throw identityError(SERVICENOW_IDENTITY_ERROR.UNAVAILABLE);
    const cacheKey = `servicenow:noc-membership:${userId}:${groupId}`;
    const entry = await cache(cacheKey, async () => {
      try {
        const result = await getPage("sys_user_grmember", {
          config: serviceNowConfig,
          sysparm_query: `user=${userId}^group=${groupId}`,
          sysparm_fields: SERVICENOW_MEMBERSHIP_FIELDS,
          sysparm_limit: 1,
          sysparm_display_value: "false",
          sysparm_exclude_reference_link: "true",
        });
        return Boolean((result?.records || []).length);
      } catch (error) {
        throwUnavailable(error);
      }
    }, {
      ttlMs: identityConfig.membershipCacheTtlMs,
      maxEntries: CACHE_MAX_ENTRIES,
      now,
    });
    return { noc_member: entry.value, cache: entry };
  }

  async function resolveOperationalServiceNowIdentity(actor) {
    const resolvedUser = await resolveServiceNowUser(actor);
    const membership = await resolveNocMembership(resolvedUser.user.sys_id);
    return Object.freeze({
      user: resolvedUser.user,
      noc_member: membership.noc_member,
      cache: Object.freeze({
        user: resolvedUser.cache,
        membership: membership.cache,
      }),
    });
  }

  return Object.freeze({
    resolveServiceNowUser,
    resolveNocMembership,
    resolveOperationalServiceNowIdentity,
  });
}

export async function resolveServiceNowUser(actor, options = {}) {
  return createServiceNowIdentityResolver(options).resolveServiceNowUser(actor);
}

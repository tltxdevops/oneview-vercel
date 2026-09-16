import assert from "node:assert/strict";
import test from "node:test";

import { resetOneViewRuntimeCacheForTests } from "../api/_lib/oneview-runtime-cache.js";
import {
  SERVICENOW_IDENTITY_ERROR,
  createServiceNowIdentityResolver,
} from "../api/_lib/oneview-servicenow-identity.js";
import { createServiceNowMeHandler } from "../api/_lib/oneview-servicenow-me.js";

const USER_SYS_ID = "11111111111111111111111111111111";
const GROUP_SYS_ID = "2abab0fe47622610082e3d02e26d4325";
const ACTOR = Object.freeze({
  actor_id: "entra-oid-123",
  actor_name: "Guilherme Franco",
  actor_username: "guilherme.franco@teletex.com.br",
});

function identityConfig(overrides = {}) {
  return {
    nocAssignmentGroupSysId: GROUP_SYS_ID,
    nocAssignmentGroupName: "N1 - Serviços - NOC",
    userCacheTtlMs: 15 * 60 * 1000,
    membershipCacheTtlMs: 10 * 60 * 1000,
    ...overrides,
  };
}

function activeUser(overrides = {}) {
  return {
    sys_id: USER_SYS_ID,
    name: "Guilherme Franco",
    email: ACTOR.actor_username,
    user_name: "guilherme.franco",
    active: "true",
    ...overrides,
  };
}

function createResolver(getPage, { config = identityConfig(), now } = {}) {
  return createServiceNowIdentityResolver({
    getPage,
    identityConfigProvider: () => config,
    serviceNowConfigProvider: () => ({ configured: true }),
    now,
  });
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.payload = body ? JSON.parse(body) : null; },
  };
}

test("OV-P0-304 resolve usuário ativo pelo email Entra e membership NOC", async () => {
  resetOneViewRuntimeCacheForTests();
  const calls = [];
  const resolver = createResolver(async (table, options) => {
    calls.push({ table, options });
    if (table === "sys_user") return { records: [activeUser()] };
    return { records: [{ sys_id: "membership" }] };
  });

  const result = await resolver.resolveOperationalServiceNowIdentity(ACTOR);
  assert.equal(result.user.sys_id, USER_SYS_ID);
  assert.equal(result.user.email, ACTOR.actor_username);
  assert.equal(result.noc_member, true);
  assert.equal(calls[0].table, "sys_user");
  assert.equal(calls[0].options.sysparm_query, `email=${ACTOR.actor_username}^active=true`);
  assert.equal(calls[0].options.sysparm_fields, "sys_id,name,email,user_name,active");
  assert.equal(calls[1].table, "sys_user_grmember");
  assert.equal(calls[1].options.sysparm_query, `user=${USER_SYS_ID}^group=${GROUP_SYS_ID}`);
});

test("OV-P0-304 diferencia usuário ausente, ambíguo e inativo", async () => {
  resetOneViewRuntimeCacheForTests();
  const notFound = createResolver(async () => ({ records: [] }));
  await assert.rejects(
    () => notFound.resolveServiceNowUser(ACTOR),
    { code: SERVICENOW_IDENTITY_ERROR.USER_NOT_FOUND },
  );

  resetOneViewRuntimeCacheForTests();
  const ambiguous = createResolver(async () => ({ records: [activeUser(), activeUser({ sys_id: "22222222222222222222222222222222" })] }));
  await assert.rejects(
    () => ambiguous.resolveServiceNowUser(ACTOR),
    { code: SERVICENOW_IDENTITY_ERROR.USER_AMBIGUOUS },
  );

  resetOneViewRuntimeCacheForTests();
  let userRead = 0;
  const inactive = createResolver(async () => {
    userRead += 1;
    return { records: userRead === 1 ? [] : [activeUser({ active: "false" })] };
  });
  await assert.rejects(
    () => inactive.resolveServiceNowUser(ACTOR),
    { code: SERVICENOW_IDENTITY_ERROR.USER_INACTIVE },
  );
});

test("OV-P0-304 membership ausente não autoriza capacidade NOC", async () => {
  resetOneViewRuntimeCacheForTests();
  const resolver = createResolver(async (table) => ({ records: table === "sys_user" ? [activeUser()] : [] }));
  const result = await resolver.resolveOperationalServiceNowIdentity(ACTOR);
  assert.equal(result.noc_member, false);
});

test("OV-P0-304 cache evita GET repetido e expira por TTL", async () => {
  resetOneViewRuntimeCacheForTests();
  let clock = 1_000;
  let userReads = 0;
  let membershipReads = 0;
  const resolver = createResolver(async (table) => {
    if (table === "sys_user") { userReads += 1; return { records: [activeUser()] }; }
    membershipReads += 1;
    return { records: [{ sys_id: "membership" }] };
  }, {
    config: identityConfig({ userCacheTtlMs: 1_000, membershipCacheTtlMs: 1_000 }),
    now: () => clock,
  });

  await resolver.resolveOperationalServiceNowIdentity(ACTOR);
  clock += 999;
  const cacheHit = await resolver.resolveOperationalServiceNowIdentity(ACTOR);
  assert.equal(cacheHit.cache.user.cacheHit, true);
  assert.equal(cacheHit.cache.membership.cacheHit, true);
  assert.deepEqual({ userReads, membershipReads }, { userReads: 1, membershipReads: 1 });

  clock += 2;
  await resolver.resolveOperationalServiceNowIdentity(ACTOR);
  assert.deepEqual({ userReads, membershipReads }, { userReads: 2, membershipReads: 2 });
});

test("OV-P0-304 deduplica lookups simultâneos e não persiste indisponibilidade", async () => {
  resetOneViewRuntimeCacheForTests();
  let userReads = 0;
  let membershipReads = 0;
  const resolver = createResolver(async (table) => {
    if (table === "sys_user") userReads += 1;
    else membershipReads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { records: table === "sys_user" ? [activeUser()] : [{ sys_id: "membership" }] };
  });
  await Promise.all([
    resolver.resolveOperationalServiceNowIdentity(ACTOR),
    resolver.resolveOperationalServiceNowIdentity(ACTOR),
  ]);
  assert.deepEqual({ userReads, membershipReads }, { userReads: 1, membershipReads: 1 });

  resetOneViewRuntimeCacheForTests();
  let failedReads = 0;
  const unavailable = createResolver(async () => {
    failedReads += 1;
    throw new Error("network unavailable");
  });
  await assert.rejects(() => unavailable.resolveServiceNowUser(ACTOR), { code: SERVICENOW_IDENTITY_ERROR.UNAVAILABLE });
  await assert.rejects(() => unavailable.resolveServiceNowUser(ACTOR), { code: SERVICENOW_IDENTITY_ERROR.UNAVAILABLE });
  assert.equal(failedReads, 2);
});

test("OV-P0-304 endpoint /me usa somente actor autenticado e não expõe sys_id", async () => {
  const loggerEntries = [];
  const handler = createServiceNowMeHandler({
    authorize: async () => true,
    actorProvider: () => ACTOR,
    resolver: {
      resolveOperationalServiceNowIdentity: async (actor) => {
        assert.equal(actor.actor_username, ACTOR.actor_username);
        return {
          user: { sys_id: USER_SYS_ID, name: "Guilherme Franco", email: ACTOR.actor_username },
          noc_member: true,
          cache: { user: { cacheHit: false }, membership: { cacheHit: false } },
        };
      },
    },
    logger: (entry) => loggerEntries.push(entry),
  });
  const res = responseRecorder();
  await handler({
    method: "GET",
    query: { actor: "attacker@invalid.example", email: "attacker@invalid.example" },
    body: { actor: "attacker@invalid.example" },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    available: true,
    service_now_user: { name: "Guilherme Franco", email: ACTOR.actor_username },
    noc_member: true,
  });
  assert.doesNotMatch(JSON.stringify(res.payload), new RegExp(USER_SYS_ID));
  assert.equal(loggerEntries[0].result, "noc_member");
});

test("OV-P0-304 endpoint /me informa membership ausente e erros sanitizados", async () => {
  const notMember = createServiceNowMeHandler({
    authorize: async () => true,
    actorProvider: () => ACTOR,
    resolver: {
      resolveOperationalServiceNowIdentity: async () => ({
        user: { sys_id: USER_SYS_ID, name: "Guilherme Franco", email: ACTOR.actor_username },
        noc_member: false,
        cache: { user: { cacheHit: true }, membership: { cacheHit: true } },
      }),
    },
    logger: () => undefined,
  });
  const membershipRes = responseRecorder();
  await notMember({ method: "GET" }, membershipRes);
  assert.equal(membershipRes.statusCode, 200);
  assert.equal(membershipRes.payload.error, SERVICENOW_IDENTITY_ERROR.NOC_MEMBERSHIP_REQUIRED);
  assert.equal(membershipRes.payload.noc_member, false);

  const unavailable = createServiceNowMeHandler({
    authorize: async () => true,
    actorProvider: () => ACTOR,
    resolver: { resolveOperationalServiceNowIdentity: async () => { throw new Error("password=secret"); } },
    logger: () => undefined,
  });
  const unavailableRes = responseRecorder();
  await unavailable({ method: "GET" }, unavailableRes);
  assert.equal(unavailableRes.statusCode, 503);
  assert.deepEqual(unavailableRes.payload, { available: false, error: SERVICENOW_IDENTITY_ERROR.UNAVAILABLE });
});

test("OV-P0-304 endpoint aceita somente GET", async () => {
  const handler = createServiceNowMeHandler({ logger: () => undefined });
  const res = responseRecorder();
  await handler({ method: "POST" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
  assert.deepEqual(res.payload, { error: "method_not_allowed" });
});

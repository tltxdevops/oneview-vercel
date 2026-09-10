import assert from "node:assert/strict";
import test from "node:test";

import { entraClaimDiagnostic } from "../api/_lib/microsoft-sso.js";
import { createSessionToken, verifySessionToken } from "../api/_lib/session.js";

const expected = {
  tenant: "tenant-1",
  audience: "oneview-client-1",
  issuer: "https://login.microsoftonline.com/tenant-1/v2.0",
};

function signedPayload(overrides = {}) {
  return {
    aud: expected.audience,
    iss: expected.issuer,
    tid: expected.tenant,
    ...overrides,
  };
}

test("OV-P0-293 records aggregate Entra claim diagnostics without claim values", () => {
  const absentRoles = entraClaimDiagnostic(signedPayload(), expected);
  assert.equal(absentRoles.has_roles_claim, false);
  assert.equal(absentRoles.roles_count, 0);
  assert.equal(absentRoles.has_groups_claim, false);
  assert.equal(absentRoles.groups_count, 0);
  assert.equal(absentRoles.aud_matches_expected, true);
  assert.equal(absentRoles.tenant_matches_expected, true);
  assert.equal(absentRoles.issuer_matches_expected, true);

  const emptyRoles = entraClaimDiagnostic(signedPayload({ roles: [], groups: [] }), expected);
  assert.equal(emptyRoles.has_roles_claim, true);
  assert.equal(emptyRoles.roles_count, 0);
  assert.equal(emptyRoles.has_groups_claim, true);
  assert.equal(emptyRoles.groups_count, 0);

  const populatedClaims = entraClaimDiagnostic(signedPayload({
    roles: ["OneView.Operator"],
    groups: ["group-value-not-logged"],
  }), expected);
  assert.equal(populatedClaims.roles_count, 1);
  assert.equal(populatedClaims.groups_count, 1);
  assert.doesNotMatch(JSON.stringify(populatedClaims), /OneView\.Operator|group-value-not-logged/);

  const wrongAudience = entraClaimDiagnostic(signedPayload({ aud: "other-client" }), expected);
  assert.equal(wrongAudience.aud_matches_expected, false);
  assert.equal(wrongAudience.issuer_matches_expected, true);
  assert.equal(wrongAudience.tenant_matches_expected, true);
});

test("OV-P0-293 preserves trusted roles through the signed server session", () => {
  const originalSecret = process.env.APP_SESSION_SECRET;
  try {
    process.env.APP_SESSION_SECRET = "entra-diagnostic-unit-test-secret";
    const { token } = createSessionToken({
      oid: "user-1",
      id: "user-1",
      tid: "test-tenant",
      sub: "test-subject",
      email: "user@example.com",
      name: "Test User",
      roles: ["OneView.Operator"],
      groups: [],
    });
    assert.deepEqual(verifySessionToken(token)?.roles, ["OneView.Operator"]);
  } finally {
    if (originalSecret === undefined) delete process.env.APP_SESSION_SECRET;
    else process.env.APP_SESSION_SECRET = originalSecret;
  }
});

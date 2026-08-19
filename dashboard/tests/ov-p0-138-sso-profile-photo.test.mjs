import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fetchMicrosoftProfilePhoto } from "../api/_lib/microsoft-sso.js";

test("foto do perfil Graph é convertida no backend em data URL segura", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  };

  try {
    const photo = await fetchMicrosoftProfilePhoto("access-token-test");
    assert.match(photo, /^data:image\/jpeg;base64,/);
    assert.equal(request.url, "https://graph.microsoft.com/v1.0/me/photo/$value");
    assert.equal(request.init.headers.Authorization, "Bearer access-token-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ausência de foto no Graph não falha o login", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    assert.equal(await fetchMicrosoftProfilePhoto("access-token-test"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("frontend recebe foto exclusivamente do callback SSO e mantém fallback de iniciais", async () => {
  const [callback, context, sidebar, msal] = await Promise.all([
    readFile(new URL("../api/auth/microsoft/callback.js", import.meta.url), "utf8"),
    readFile(new URL("../src/context/AuthContext.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/layout/Sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/auth/msal.ts", import.meta.url), "utf8"),
  ]);

  assert.match(callback, /fetchMicrosoftProfilePhoto\(tokenPayload\.access_token\)/);
  assert.match(callback, /setSessionCookie\(res, req, user\)/);
  assert.match(context, /hydrateCachedPhoto/);
  assert.doesNotMatch(context, /graph\.microsoft\.com/);
  assert.doesNotMatch(msal, /graph\.microsoft\.com/);
  assert.match(sidebar, /onError=\{\(\) => setProfilePhotoFailed\(true\)\}/);
});

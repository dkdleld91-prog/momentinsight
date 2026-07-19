import assert from "node:assert/strict";
import test from "node:test";
import { checkReadiness, createReadinessHandler } from "./ready.mjs";

const configuredEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
};

const validJwk = { kty: "RSA", kid: "test", n: "test-modulus", e: "AQAB" };

function successfulReadinessResponse(url) {
  return new URL(url).pathname.includes(".well-known/jwks.json")
    ? new Response(JSON.stringify({ keys: [validJwk] }), { status: 200 })
    : new Response("[]", { status: 200 });
}

test("readiness does not expose missing environment names", async () => {
  const handler = createReadinessHandler({ env: {}, cache: new Map() });
  const response = await handler(new Request("https://insight.momentlabs.co.kr/api/ready"));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "SERVER_NOT_READY");
  assert.equal(body.missingCount, 4);
  assert.doesNotMatch(JSON.stringify(body), /SUPABASE_SECRET_KEY/);
});

test("readiness probes Supabase once during the cache window", async () => {
  let calls = 0;
  const paths = [];
  let clock = 1000;
  const cache = new Map();
  const options = {
    env: configuredEnv,
    cache,
    now: () => clock,
    fetchImpl: async (url, request) => {
      calls += 1;
      const pathname = new URL(url).pathname;
      paths.push(pathname + new URL(url).search);
      if (pathname.startsWith("/rest/v1/")) {
        assert.equal(request.headers.apikey, "sb_secret_test");
        assert.equal(request.headers.authorization, undefined);
      } else if (pathname === "/auth/v1/settings") {
        assert.equal(request.headers.apikey, "sb_publishable_test");
        assert.equal(request.headers.authorization, undefined);
      }
      return successfulReadinessResponse(url);
    },
  };
  assert.equal((await checkReadiness(options)).ok, true);
  clock += 1000;
  assert.equal((await checkReadiness(options)).ok, true);
  assert.equal(calls, 5);
  assert.ok(paths.some((path) => path.includes("/auth/v1/settings")));
  assert.ok(paths.some((path) => path.includes("/rest/v1/clients") && path.includes("select=id")));
  assert.ok(paths.some((path) => path.includes("/rest/v1/naver_rank_trackers") && path.includes("processing_started_at")));
  assert.ok(paths.some((path) => path.includes("/rest/v1/naver_place_rank_trackers") && path.includes("processing_token")));
});

test("readiness parses named Supabase keys and uses Bearer only for legacy JWT keys", async () => {
  const seen = [];
  const legacyJwt = "header.payload.signature";
  const base = {
    SUPABASE_URL: configuredEnv.SUPABASE_URL,
    SUPABASE_JWKS_URL: configuredEnv.SUPABASE_JWKS_URL,
  };

  const namedResult = await checkReadiness({
    env: {
      ...base,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_default", web: "sb_publishable_web" }),
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_default", automation: "sb_secret_automation" }),
      SUPABASE_JWKS: JSON.stringify({ keys: [{ ...validJwk, kid: "inline" }] }),
    },
    cache: new Map(),
    fetchImpl: async (_url, request) => {
      seen.push(request.headers);
      return successfulReadinessResponse(_url);
    },
  });
  assert.equal(namedResult.ok, true);
  assert.equal(seen[0].apikey, "sb_secret_default");
  assert.equal(seen[0].authorization, undefined);

  seen.length = 0;
  const legacyResult = await checkReadiness({
    env: {
      ...base,
      SUPABASE_PUBLISHABLE_KEY: legacyJwt,
      SUPABASE_SECRET_KEY: legacyJwt,
    },
    cache: new Map(),
    fetchImpl: async (_url, request) => {
      seen.push(request.headers);
      return successfulReadinessResponse(_url);
    },
  });
  assert.equal(legacyResult.ok, true);
  assert.equal(seen[0].authorization, `Bearer ${legacyJwt}`);
});

test("readiness rejects an insecure remote JWKS URL before dependency probes", async () => {
  let calls = 0;
  const result = await checkReadiness({
    env: { ...configuredEnv, SUPABASE_JWKS_URL: "http://example.com/jwks.json" },
    cache: new Map(),
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ keys: [validJwk] }), { status: 200 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.dependency, "not_configured");
  assert.equal(calls, 0);
});

test("readiness rejects a remote JWKS response without usable keys", async () => {
  const result = await checkReadiness({
    env: configuredEnv,
    cache: new Map(),
    fetchImpl: async (url) => new URL(url).pathname.includes(".well-known/jwks.json")
      ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      : new Response("[]", { status: 200 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.dependency, "unavailable");
});

test("readiness rejects malformed inline JWKS before dependency probes", async () => {
  let calls = 0;
  const result = await checkReadiness({
    env: { ...configuredEnv, SUPABASE_JWKS: "{not-json" },
    cache: new Map(),
    fetchImpl: async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.dependency, "not_configured");
  assert.equal(calls, 0);
});

test("readiness rejects structurally unusable inline JWKS keys", async () => {
  let calls = 0;
  const result = await checkReadiness({
    env: { ...configuredEnv, SUPABASE_JWKS: JSON.stringify({ keys: [{ kty: "RSA" }] }) },
    cache: new Map(),
    fetchImpl: async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.dependency, "not_configured");
  assert.equal(calls, 0);
});

test("readiness treats plural key configuration as authoritative", async () => {
  let calls = 0;
  const result = await checkReadiness({
    env: {
      ...configuredEnv,
      SUPABASE_PUBLISHABLE_KEYS: "{not-json",
      SUPABASE_SECRET_KEYS: JSON.stringify({ automation: "sb_secret_automation" }),
    },
    cache: new Map(),
    fetchImpl: async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.dependency, "not_configured");
  assert.equal(calls, 0);
});

test("readiness reports dependency failure without leaking its response", async () => {
  const handler = createReadinessHandler({
    env: configuredEnv,
    cache: new Map(),
    fetchImpl: async (url) => {
      if (new URL(url).pathname.includes(".well-known/jwks.json")) return successfulReadinessResponse(url);
      return new Response("database details", {
        status: new URL(url).pathname.includes("naver_rank_trackers") ? 400 : 200,
      });
    },
  });
  const response = await handler(new Request("https://insight.momentlabs.co.kr/api/ready"));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.dependency.supabase, "unavailable");
  assert.doesNotMatch(JSON.stringify(body), /database details/);
});

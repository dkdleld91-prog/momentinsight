import assert from "node:assert/strict";
import test from "node:test";
import { createSessionClaims, sealSession } from "./code-session.mjs";
import {
  authorizeCodeSession,
  boundedApiRequest,
  internalRequestForSession,
  requiresCodeSession,
  roleAllowsPath,
  sessionScopeAllowsPath,
  sessionActivityValid,
} from "./session-gate.mjs";

const ENV = {
  NODE_ENV: "production",
  MI_SESSION_SECRET: "test-only-session-secret-with-at-least-32-bytes",
  MI_SUPER_ADMIN_CODE: "server-only-super-secret",
  MI_RANK_ADMIN_CODE: "server-only-rank-secret",
  MI_PRIMARY_AGENCY_CODE: "mml93-a01",
  SUPABASE_SECRET_KEY: "sb_secret_server_only",
};

function requestWithSession(path, claims, options = {}) {
  const token = sealSession(claims, ENV);
  const headers = new Headers(options.headers || {});
  headers.set("cookie", `__Host-mi-session=${token}`);
  if (options.csrf !== false) headers.set("x-mi-csrf", claims.csrf);
  return new Request(`https://insight.momentlabs.co.kr${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });
}

test("health, session and cron paths remain outside the code-session gate", () => {
  assert.equal(requiresCodeSession(new Request("https://example.test/api/health")), false);
  assert.equal(requiresCodeSession(new Request("https://example.test/api/session")), false);
  assert.equal(requiresCodeSession(new Request("https://example.test/api/naver-rank-cron")), false);
  assert.equal(requiresCodeSession(new Request("https://example.test/api/report-center")), true);
});

test("roles cannot cross owner and admin boundaries", () => {
  assert.equal(roleAllowsPath("owner", "/api/admin/reports"), true);
  assert.equal(roleAllowsPath("team", "/api/admin/reports"), false);
  assert.equal(roleAllowsPath("client", "/api/team/agency-codes"), false);
  assert.equal(roleAllowsPath("client", "/api/agency-code/validate"), false);
  assert.equal(roleAllowsPath("team", "/api/agency-code/validate"), false);
  assert.equal(roleAllowsPath("client", "/api/report-center"), true);
});

test("an unlinked team is limited to its account provisioning endpoint", async () => {
  const claims = createSessionClaims({ role: "team", teamCode: "mml93-t01", teamId: "team-1" });
  assert.equal(sessionScopeAllowsPath(claims, "/api/team-agency-codes"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/naver-rank-trackers"), false);
  const blocked = await authorizeCodeSession(requestWithSession("/api/naver-rank-trackers", claims), ENV, {
    activityCheck: async () => true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.response.status, 403);
  assert.equal((await blocked.response.json()).code, "ADVERTISER_SCOPE_REQUIRED");
});

test("middleware strips browser credentials and injects only server credentials", () => {
  const claims = createSessionClaims({ role: "owner", accountLabel: "mml93-a01", agencyCode: "mml93-a01" });
  const request = new Request("https://insight.momentlabs.co.kr/api/admin/reports", {
    headers: {
      authorization: "Bearer browser-secret",
      apikey: "browser-key",
      "x-mi-super-admin-code": "browser-super",
      "x-mi-agency-code": "mml93-a09",
    },
  });
  const internal = internalRequestForSession(request, claims, ENV);

  assert.equal(internal.headers.get("authorization"), null);
  assert.equal(internal.headers.get("apikey"), "sb_secret_server_only");
  assert.equal(internal.headers.get("x-mi-super-admin-code"), "server-only-super-secret");
  assert.equal(internal.headers.get("x-mi-agency-code"), "mml93-a09");
  assert.equal(internal.headers.get("x-mi-session-role"), "owner");
});

test("mutations require both same-origin and csrf", async () => {
  const claims = createSessionClaims({ role: "team", teamCode: "mml93-t01", teamId: "team-1", agencyCode: "mml93-a02", clientId: "client-2" });
  const okRequest = requestWithSession("/api/report-center", claims, {
    method: "POST",
    headers: { origin: "https://insight.momentlabs.co.kr", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal((await authorizeCodeSession(okRequest, ENV, { activityCheck: async () => true })).ok, true);

  const missingCsrf = requestWithSession("/api/report-center", claims, {
    method: "POST",
    csrf: false,
    headers: { origin: "https://insight.momentlabs.co.kr", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal((await authorizeCodeSession(missingCsrf, ENV)).response.status, 403);

  const foreignOrigin = requestWithSession("/api/report-center", claims, {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal((await authorizeCodeSession(foreignOrigin, ENV)).response.status, 403);
});

test("hosted sessions fail closed when account activity cannot be verified", async () => {
  const claims = createSessionClaims({
    role: "client",
    accountLabel: "mml93-a02",
    agencyCode: "mml93-a02",
    clientId: "client-2",
  });
  assert.equal(await sessionActivityValid(claims, {
    VERCEL_ENV: "preview",
    MI_SESSION_SECRET: "s".repeat(32),
  }), false);
});

test("client session activity is tied to the exact active client and agency code", async () => {
  const claims = createSessionClaims({
    role: "client",
    accountLabel: "mml93-a02",
    agencyCode: "mml93-a02",
    clientId: "client-2",
  });
  const env = {
    VERCEL_ENV: "preview",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_test_only",
  };
  const activeFetch = async (url) => {
    const parsed = new URL(url);
    assert.match(parsed.pathname, /clients/);
    assert.equal(parsed.searchParams.get("id"), "eq.client-2");
    assert.equal(parsed.searchParams.get("agency_code"), "eq.mml93-a02");
    return Response.json([{ id: "client-2", agency_code: "mml93-a02", status: "active", disconnected_at: null }]);
  };
  const revokedFetch = async () => Response.json([]);
  assert.equal(await sessionActivityValid(claims, env, { fetchImpl: activeFetch }), true);
  assert.equal(await sessionActivityValid(claims, env, { fetchImpl: revokedFetch }), false);
});

test("team session activity is invalidated when its client mapping changes", async () => {
  const claims = createSessionClaims({
    role: "team",
    accountLabel: "mml93-t01",
    teamCode: "mml93-t01",
    teamId: "team-1",
    agencyCode: "mml93-a02",
    clientId: "client-2",
  });
  const env = {
    VERCEL_ENV: "preview",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_test_only",
  };
  const fetchImpl = async (url) => String(url).includes("operation_team_codes")
    ? Response.json([{ id: "team-1", team_code: "mml93-t01", client_id: "client-9", status: "active", revoked_at: null }])
    : Response.json([{ id: "client-2", agency_code: "mml93-a02", status: "active", disconnected_at: null }]);
  assert.equal(await sessionActivityValid(claims, env, { fetchImpl }), false);
});

test("oversized or compressed API bodies fail before handlers", async () => {
  const oversized = new Request("https://example.test/api/session", {
    method: "POST",
    headers: { "content-length": "20000" },
    body: "{}",
  });
  assert.equal((await boundedApiRequest(oversized)).response.status, 413);

  const compressed = new Request("https://example.test/api/report-center", {
    method: "POST",
    headers: { "content-encoding": "gzip" },
    body: "compressed",
  });
  assert.equal((await boundedApiRequest(compressed)).response.status, 415);

  const invalidLimit = new Request("https://example.test/api/session", {
    method: "POST",
    body: "x".repeat(20_000),
  });
  assert.equal((await boundedApiRequest(invalidLimit, { maxBytes: "not-a-number" })).response.status, 413);
});

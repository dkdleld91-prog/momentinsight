import assert from "node:assert/strict";
import test from "node:test";
import { createSessionClaims, sealSession } from "./code-session.mjs";
import {
  SESSION_ACTIVITY_ACTIVE,
  SESSION_ACTIVITY_REVOKED,
  SESSION_ACTIVITY_UNAVAILABLE,
  authorizeCodeSession,
  boundedApiRequest,
  internalRequestForSession,
  isTrialClaims,
  requiresCodeSession,
  roleAllowsPath,
  sessionScopeAllowsPath,
  sessionActivityState,
  sessionActivityValid,
  trialAllowsPath,
} from "./session-gate.mjs";

const ENV = {
  NODE_ENV: "production",
  MI_SESSION_SECRET: "test-only-session-secret-with-at-least-32-bytes",
  MI_SUPER_ADMIN_CODE: "server-only-super-secret",
  MI_OWNER_LOGIN_CODE: "test-only-owner-login-secret",
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

test("health, session, cron and signed local worker paths remain outside the code-session gate", () => {
  assert.equal(requiresCodeSession(new Request("https://example.test/api/health")), false);
  assert.equal(requiresCodeSession(new Request("https://example.test/api/session")), false);
  assert.equal(requiresCodeSession(new Request("https://example.test/api/naver-rank-cron")), false);
  assert.equal(requiresCodeSession(new Request("https://example.test/api/naver-shopping-local-worker")), false);
  assert.equal(requiresCodeSession(new Request("https://example.test/api/naver-shopping-local-worker/other")), true);
  assert.equal(requiresCodeSession(new Request("https://example.test/api/report-center")), true);
});

test("roles cannot cross owner and admin boundaries", () => {
  assert.equal(roleAllowsPath("owner", "/api/admin/reports"), true);
  assert.equal(roleAllowsPath("owner", "/api/owner/tool"), true);
  assert.equal(roleAllowsPath("team", "/api/owner/tool"), false);
  assert.equal(roleAllowsPath("client", "/api/owner/tool"), false);
  assert.equal(roleAllowsPath("team", "/api/admin/reports"), false);
  assert.equal(roleAllowsPath("client", "/api/team/agency-codes"), false);
  assert.equal(roleAllowsPath("client", "/api/agency-code/validate"), false);
  assert.equal(roleAllowsPath("team", "/api/agency-code/validate"), false);
  assert.equal(roleAllowsPath("client", "/api/report-center"), true);
});

test("owner, linked team and client sessions can use all five core tools", () => {
  const paths = [
    "/api/naver-keyword",
    "/api/naver-product-seo-audit",
    "/api/naver-shopping-rank",
    "/api/naver-shopping-rank-jobs",
    "/api/naver-rank-trackers",
    "/api/naver-place-rank-trackers",
  ];
  const sessions = [
    createSessionClaims({ role: "owner", agencyCode: "mml93-a01" }),
    createSessionClaims({ role: "team", teamId: "team-1", clientId: "client-1", agencyCode: "mml93-a02" }),
    createSessionClaims({ role: "client", clientId: "client-1", agencyCode: "mml93-a02" }),
  ];

  sessions.forEach((claims) => {
    paths.forEach((path) => {
      assert.equal(roleAllowsPath(claims.role, path), true, `${claims.role} role ${path}`);
      assert.equal(sessionScopeAllowsPath(claims, path), true, `${claims.role} scope ${path}`);
    });
  });
});

test("owner session is bound to the exact primary account identity", async () => {
  const owner = createSessionClaims({ role: "owner", agencyCode: "mml93-a01" });
  const stale = createSessionClaims({ role: "owner", agencyCode: "mml93-a02" });
  const missing = createSessionClaims({ role: "owner" });
  assert.equal(await sessionActivityValid(owner, ENV), true);
  assert.equal(await sessionActivityValid(stale, ENV), false);
  assert.equal(await sessionActivityValid(missing, ENV), false);
  assert.equal(await sessionActivityValid(owner, { ...ENV, MI_PRIMARY_AGENCY_CODE: "MML93-A01" }), false);
  assert.equal(await sessionActivityValid(owner, { ...ENV, MI_PRIMARY_AGENCY_CODE: "" }), false);
});

test("an unlinked team can use isolated rank trackers without crossing advertiser scope", async () => {
  const claims = createSessionClaims({ role: "team", teamCode: "mml93-t01", teamId: "team-1" });
  assert.equal(sessionScopeAllowsPath(claims, "/api/team-agency-codes"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/naver-keyword"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/naver-product-seo-audit"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/naver-shopping-rank"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/naver-shopping-rank-jobs"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/meta-ads"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/naver-keyword/private"), false);
  assert.equal(sessionScopeAllowsPath(claims, "/api/report-center"), false);
  // 2026-09-07: 광고주 미연결 운영팀도 뉴스(홈 피드)·키워드 조사·조사 노트는 연다. 보고서·공개 상태는 여전히 닫힌다.
  assert.equal(sessionScopeAllowsPath(claims, "/api/client/home-feed"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/client/keyword-research"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/client/keyword-notes"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/client/public-state"), false);
  assert.equal(sessionScopeAllowsPath(claims, "/api/client/work-items"), false);
  assert.equal(sessionScopeAllowsPath(claims, "/api/naver-rank-trackers"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/naver-place-rank-trackers"), true);
  assert.equal(sessionScopeAllowsPath(claims, "/api/demo/public-state"), false);

  const allowed = await authorizeCodeSession(requestWithSession("/api/naver-keyword?keyword=test", claims), ENV, {
    activityCheck: async () => true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.request.headers.get("x-mi-session-role"), "team");
  assert.equal(allowed.request.headers.get("x-mi-session-scope"), "account-only");
  assert.equal(allowed.request.headers.get("x-mi-team-code"), "mml93-t01");
  assert.equal(allowed.request.headers.get("x-mi-agency-code"), null);
  assert.equal(allowed.request.headers.get("x-mi-rank-access-code"), null);

  for (const path of ["/api/naver-rank-trackers", "/api/naver-place-rank-trackers"]) {
    const rankAllowed = await authorizeCodeSession(requestWithSession(path, claims, {
      headers: {
        "x-mi-team-code": "mml93-t99",
        "x-mi-agency-code": "mml93-a99",
        "x-mi-rank-access-code": "forged-browser-secret",
        "x-mi-session-role": "owner",
        "x-mi-session-scope": "advertiser",
      },
    }), ENV, {
      activityCheck: async () => true,
    });
    assert.equal(rankAllowed.ok, true);
    assert.equal(rankAllowed.request.headers.get("x-mi-session-role"), "team");
    assert.equal(rankAllowed.request.headers.get("x-mi-session-scope"), "account-only");
    assert.equal(rankAllowed.request.headers.get("x-mi-team-code"), "mml93-t01");
    assert.equal(rankAllowed.request.headers.get("x-mi-agency-code"), "mml93-t01");
    assert.equal(rankAllowed.request.headers.get("x-mi-rank-access-code"), "mml93-t01");
  }

  const blocked = await authorizeCodeSession(requestWithSession("/api/report-center", claims), ENV, {
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
  const state = await sessionActivityState(claims, {
    VERCEL_ENV: "preview",
    MI_SESSION_SECRET: "s".repeat(32),
  });
  assert.equal(state, SESSION_ACTIVITY_UNAVAILABLE);
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
  const unavailableFetch = async () => new Response(JSON.stringify({ code: "PGRST000" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await sessionActivityState(claims, env, { fetchImpl: activeFetch }), SESSION_ACTIVITY_ACTIVE);
  assert.equal(await sessionActivityState(claims, env, { fetchImpl: revokedFetch }), SESSION_ACTIVITY_REVOKED);
  assert.equal(await sessionActivityState(claims, env, { fetchImpl: unavailableFetch }), SESSION_ACTIVITY_UNAVAILABLE);
  assert.equal(await sessionActivityValid(claims, env, { fetchImpl: activeFetch }), true);
  assert.equal(await sessionActivityValid(claims, env, { fetchImpl: revokedFetch }), false);
});

test("temporary activity-check outages return 503 without clearing the session cookie", async () => {
  const claims = createSessionClaims({
    role: "client",
    accountLabel: "mml93-a02",
    agencyCode: "mml93-a02",
    clientId: "client-2",
  });
  const result = await authorizeCodeSession(requestWithSession("/api/naver-rank-trackers", claims), ENV, {
    activityCheck: async () => SESSION_ACTIVITY_UNAVAILABLE,
  });
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get("set-cookie"), null);
  assert.equal((await result.response.json()).code, "SESSION_VALIDATION_UNAVAILABLE");
});

test("confirmed inactive sessions still return the revoked response", async () => {
  const claims = createSessionClaims({
    role: "client",
    accountLabel: "mml93-a02",
    agencyCode: "mml93-a02",
    clientId: "client-2",
  });
  const result = await authorizeCodeSession(requestWithSession("/api/naver-rank-trackers", claims), ENV, {
    activityCheck: async () => SESSION_ACTIVITY_REVOKED,
  });
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 401);
  assert.equal((await result.response.json()).code, "SESSION_REVOKED");
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

function trialClaims() {
  return createSessionClaims({
    role: "client",
    agencyCode: "trial-10293847",
    trial: true,
    googleSub: "102938475647382910111",
  });
}

test("trial sessions carry the trial marker and only open the keyword tool paths", async () => {
  const claims = trialClaims();
  assert.equal(claims.trial, 1);
  assert.equal(claims.gsub, "102938475647382910111");
  assert.equal(isTrialClaims(claims), true);
  assert.equal(isTrialClaims(createSessionClaims({ role: "client", clientId: "client-1", agencyCode: "mml93-a02" })), false);
  ["/api/naver-keyword", "/api/client/keyword-research", "/api/client/keyword-notes", "/api/client/public-state", "/api/client/home-feed"]
    .forEach((path) => assert.equal(trialAllowsPath(path), true, path));
  ["/api/naver-rank-trackers", "/api/naver-place-rank-trackers", "/api/naver-shopping-rank", "/api/report-center", "/api/work-items", "/api/my/google-login", "/api/client/work-items"]
    .forEach((path) => assert.equal(trialAllowsPath(path), false, path));

  // 순위 목록 GET 은 이제 예시 응답(별도 테스트)이라, 잠금 확인은 다른 광고주 경로로 한다.
  const locked = await authorizeCodeSession(requestWithSession("/api/naver-shopping-rank?keyword=x", claims), ENV, { activityCheck: async () => true });
  assert.equal(locked.ok, false);
  assert.equal(locked.response.status, 403);
  assert.equal((await locked.response.json()).code, "TRIAL_LOCKED");
});

test("trial keyword lookups consume the daily quota through the rpc and stop at the limit", async () => {
  const claims = trialClaims();
  const rpcCalls = [];
  const fetchFor = (allowed, used) => async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/rpc/mi_trial_keyword_consume")) {
      rpcCalls.push(JSON.parse(String(init.body)));
      assert.equal(init.method, "POST");
      return Response.json([{ allowed, used_count: used }]);
    }
    assert.fail(`unexpected fetch ${parsed.pathname}`);
  };
  const env = { ...ENV, SUPABASE_URL: "https://project.supabase.co" };

  const full = await authorizeCodeSession(requestWithSession("/api/naver-keyword?keyword=%EC%9B%90%EB%91%90&profile=full", claims), env, {
    activityCheck: async () => true,
    fetchImpl: fetchFor(true, 1),
  });
  assert.equal(full.ok, true);
  assert.deepEqual(rpcCalls, [{ p_sub: "102938475647382910111", p_limit: 5 }]);
  assert.equal(full.request.headers.get("x-mi-session-role"), "client");
  assert.equal(full.request.headers.get("x-mi-session-scope"), "trial");
  assert.equal(full.request.headers.get("x-mi-agency-code"), "trial-10293847");
  assert.equal(full.request.headers.get("x-mi-rank-access-code"), null);

  const compare = await authorizeCodeSession(requestWithSession("/api/naver-keyword?keyword=%EC%9B%90%EB%91%90&profile=compare", claims), env, {
    activityCheck: async () => true,
    fetchImpl: fetchFor(true, 2),
  });
  assert.equal(compare.ok, true);
  assert.equal(rpcCalls.length, 1);

  const exhausted = await authorizeCodeSession(requestWithSession("/api/naver-keyword?keyword=%EC%9B%90%EB%91%90", claims), env, {
    activityCheck: async () => true,
    fetchImpl: fetchFor(false, 5),
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.response.status, 429);
  assert.equal(exhausted.response.headers.get("x-mi-trial-quota"), "5/5");
  const body = await exhausted.response.json();
  assert.equal(body.code, "TRIAL_QUOTA");
  assert.equal(body.used, 5);
  assert.equal(body.limit, 5);

  const outage = await authorizeCodeSession(requestWithSession("/api/naver-keyword?keyword=%EC%9B%90%EB%91%90", claims), env, {
    activityCheck: async () => true,
    fetchImpl: async () => new Response("down", { status: 503 }),
  });
  assert.equal(outage.ok, true);

  const research = await authorizeCodeSession(requestWithSession("/api/client/keyword-research?keyword=%EC%9B%90%EB%91%90", claims), env, {
    activityCheck: async () => true,
    fetchImpl: fetchFor(false, 5),
  });
  assert.equal(research.ok, true);
  // 전체 조회 1건 + 한도 초과 확인 1건. 비교 프로필·조사 API·장애 응답은 세지 않았다.
  assert.equal(rpcCalls.length, 2);
});

test("trial session activity follows the trial login identity row", async () => {
  const claims = trialClaims();
  const env = {
    VERCEL_ENV: "preview",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_test_only",
  };
  const activeFetch = async (url) => {
    const parsed = new URL(url);
    assert.match(parsed.pathname, /login_identities/);
    assert.equal(parsed.searchParams.get("google_sub"), "eq.102938475647382910111");
    assert.equal(parsed.searchParams.get("role"), "eq.trial");
    return Response.json([{ google_sub: "102938475647382910111", role: "trial", code: "102938475647382910111" }]);
  };
  const revokedFetch = async () => Response.json([]);
  const unavailableFetch = async () => new Response(JSON.stringify({ code: "PGRST000" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await sessionActivityState(claims, env, { fetchImpl: activeFetch }), SESSION_ACTIVITY_ACTIVE);
  assert.equal(await sessionActivityState(claims, env, { fetchImpl: revokedFetch }), SESSION_ACTIVITY_REVOKED);
  assert.equal(await sessionActivityState(claims, env, { fetchImpl: unavailableFetch }), SESSION_ACTIVITY_UNAVAILABLE);
});

// 체험 세션의 순위 목록 GET 은 핸들러 대신 예시 응답(200)을 받는다. 등록(POST)은 여전히 TRIAL_LOCKED 다.
test("trial sessions get sample tracker lists instead of the rank handlers, but cannot write", async () => {
  const claims = createSessionClaims({
    role: "client",
    clientId: "trial-10293847",
    agencyCode: "trial-10293847",
    trial: true,
    googleSub: "102938475647382910111",
  });
  for (const path of ["/api/naver-rank-trackers", "/api/naver-place-rank-trackers"]) {
    const result = await authorizeCodeSession(requestWithSession(`${path}?limit=500`, claims), ENV, { activityCheck: async () => true });
    assert.equal(result.ok, false, path);
    assert.equal(result.response.status, 200, path);
    const payload = await result.response.json();
    assert.equal(payload.ok, true, path);
    assert.equal(payload.sample, true, path);
    assert.equal(payload.complete, true, path);
    assert.equal(payload.hasMore, false, path);
    assert.equal(payload.scopeClientId, "trial-10293847", path);
    assert.equal(payload.returnedCount, payload.trackers.length, path);
    assert.ok(payload.trackers.length >= 2, path);
    assert.equal(new Set(payload.trackers.map((tracker) => tracker.id)).size, payload.trackers.length, path);
    for (const tracker of payload.trackers) {
      assert.equal(tracker.sample, true);
      assert.equal(tracker.status, "active");
      assert.ok(new Date(tracker.nextCheckAt).getTime() > Date.now(), "nextCheckAt must be in the future");
      assert.equal(tracker.snapshots.length, 30);
      assert.ok(String(tracker.productTitle || tracker.placeName).startsWith("[예시]"));
    }
    const write = await authorizeCodeSession(requestWithSession(path, claims, { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: "https://insight.momentlabs.co.kr" } }), ENV, { activityCheck: async () => true });
    assert.equal(write.ok, false, path);
    assert.equal(write.response.status, 403, path);
    assert.equal((await write.response.json()).code, "TRIAL_LOCKED", path);
  }
  // 코드 광고주 세션은 예시가 아니라 핸들러로 간다(게이트 통과).
  const real = createSessionClaims({ role: "client", clientId: "client-1", agencyCode: "mml93-a02" });
  const passed = await authorizeCodeSession(requestWithSession("/api/naver-rank-trackers?limit=500", real), ENV, { activityCheck: async () => true });
  assert.equal(passed.ok, true);
});

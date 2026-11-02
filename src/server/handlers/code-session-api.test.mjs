import assert from "node:assert/strict";
import test from "node:test";
import {
  activeClientByCode,
  activeTeamByCode,
  consumeRateLimit,
  loginRateConfiguration,
  loginRateKeys,
  loginRequestAllowed,
  normalizeLoginCode,
  normalizeRequestedLoginCode,
  ownerCredentialConfigured,
  ownerCredentialMatches,
  sessionActivityState,
  sessionStillActive,
} from "./code-session-api.mjs";
import sessionApi from "./code-session-api.mjs";
import { resolveGoogleLoginAccess } from "./google-calendar-api.mjs";
import { SESSION_ACTIVITY_UNAVAILABLE } from "../session-gate.mjs";
import { createSessionClaims, sealSession } from "../code-session.mjs";

function contextWithRows(rows) {
  let index = 0;
  return {
    supabaseAdmin: {
      from() {
        const query = {
          select() { return query; },
          ilike() { return query; },
          eq() { return query; },
          maybeSingle() { return Promise.resolve(rows[index++] || { data: null, error: null }); },
        };
        return query;
      },
    },
  };
}

test("login codes reject whitespace, control characters and oversized values", () => {
  assert.equal(normalizeLoginCode("mml93-a02"), "mml93-a02");
  assert.equal(normalizeLoginCode("short"), "");
  assert.equal(normalizeLoginCode("mml93 a02"), "");
  assert.equal(normalizeLoginCode("mml93-a%"), "");
  assert.equal(normalizeLoginCode("mml93-a_"), "");
  assert.equal(normalizeLoginCode("a".repeat(129)), "");
});

test("legacy five-character candidates are limited to active advertiser lookup", () => {
  assert.equal(normalizeRequestedLoginCode("abc12", "client"), "abc12");
  assert.equal(normalizeRequestedLoginCode("abc12", "operator"), "");
  assert.equal(normalizeRequestedLoginCode("abc12", "admin"), "");
  assert.equal(normalizeRequestedLoginCode("abcd", "client"), "");
  assert.equal(normalizeRequestedLoginCode("abcdef", "operator"), "abcdef");
  assert.equal(normalizeLoginCode("abc12"), "");
});

test("owner login fails closed in production without a separate credential", () => {
  const env = { NODE_ENV: "production", MI_PRIMARY_AGENCY_CODE: "mml93-a01" };
  assert.equal(ownerCredentialConfigured(env), false);
  assert.equal(ownerCredentialMatches("mml93-a01", env), false);
});

test("owner login accepts configured secret or sha256 digest", () => {
  assert.equal(ownerCredentialMatches("strong-owner-secret", {
    NODE_ENV: "production",
    MI_PRIMARY_AGENCY_CODE: "mml93-a01",
    MI_OWNER_LOGIN_CODE: "strong-owner-secret",
  }), true);
  assert.equal(ownerCredentialMatches("strong-owner-secret", {
    NODE_ENV: "production",
    MI_PRIMARY_AGENCY_CODE: "mml93-a01",
    MI_OWNER_LOGIN_CODE_SHA256: "ce10fd031c0c609b88de3dbcc3d597d55f111a1c036fbe9638af2ae47008907e",
  }), true);
});

test("owner login rejects a missing or mismatched production primary identity", () => {
  const base = { NODE_ENV: "production", MI_OWNER_LOGIN_CODE: "strong-owner-secret" };
  assert.equal(ownerCredentialMatches("strong-owner-secret", base), false);
  assert.equal(ownerCredentialMatches("strong-owner-secret", { ...base, MI_PRIMARY_AGENCY_CODE: "mml93-a02" }), false);
  assert.equal(ownerCredentialMatches("strong-owner-secret", { ...base, MI_PRIMARY_AGENCY_CODE: "MML93-A01" }), false);
  assert.equal(ownerCredentialMatches("strong-owner-secret", { ...base, MI_PRIMARY_AGENCY_CODE: "mml93-a01" }), true);
});

test("login rate limiting shares an IP bucket across sequential account codes", () => {
  const request = new Request("https://example.com/api/session", {
    headers: { "x-vercel-forwarded-for": "203.0.113.42" },
  });
  const first = loginRateKeys(request, "client", "mml93-a02");
  const second = loginRateKeys(request, "client", "mml93-a03");
  assert.equal(first.ip, second.ip);
  assert.notEqual(first.credential, second.credential);
});

test("login rate limiting isolates different source IP addresses", () => {
  const first = loginRateKeys(new Request("https://example.com/api/session", {
    headers: { "x-vercel-forwarded-for": "203.0.113.42" },
  }), "client", "mml93-a02");
  const second = loginRateKeys(new Request("https://example.com/api/session", {
    headers: { "x-vercel-forwarded-for": "203.0.113.43" },
  }), "client", "mml93-a02");
  assert.notEqual(first.ip, second.ip);
  assert.notEqual(first.credential, second.credential);
});

test("login rate limiting starts independent IP and credential checks together", async () => {
  const pending = [];
  const ctx = {
    supabaseAdmin: {
      rpc(_name, args) {
        return new Promise((resolve) => pending.push({ args, resolve }));
      },
    },
  };
  const request = new Request("https://insight.momentlabs.co.kr/api/session", {
    headers: { "x-vercel-forwarded-for": "203.0.113.42" },
  });

  const resultPromise = consumeRateLimit(request, ctx, "client", "mml93-a02");
  assert.equal(pending.length, 2);
  assert.notEqual(pending[0].args.p_key_hash, pending[1].args.p_key_hash);
  pending[0].resolve({ data: { allowed: true, retry_after: 0 }, error: null });
  pending[1].resolve({ data: { allowed: true, retry_after: 0 }, error: null });

  const result = await resultPromise;
  assert.equal(result.allowed, true);
  assert.equal(result.durable, true);
  assert.equal(result.credentialKey, pending[1].args.p_key_hash);
});

test("invalid login rate environment values fall back to bounded protection", () => {
  assert.deepEqual(loginRateConfiguration({
    MI_CODE_LOGIN_WINDOW_SECONDS: "NaN",
    MI_CODE_LOGIN_ATTEMPT_LIMIT: "0",
    MI_CODE_LOGIN_IP_ATTEMPT_LIMIT: "Infinity",
  }), {
    windowSeconds: 900,
    attemptLimit: 5,
    ipAttemptLimit: 30,
  });
  assert.deepEqual(loginRateConfiguration({
    MI_CODE_LOGIN_WINDOW_SECONDS: "600",
    MI_CODE_LOGIN_ATTEMPT_LIMIT: "4",
    MI_CODE_LOGIN_IP_ATTEMPT_LIMIT: "12",
  }), {
    windowSeconds: 600,
    attemptLimit: 4,
    ipAttemptLimit: 12,
  });
});

test("login accepts only same-origin JSON requests", () => {
  assert.equal(loginRequestAllowed(new Request("https://insight.momentlabs.co.kr/api/session", {
    method: "POST",
    headers: { origin: "https://insight.momentlabs.co.kr", "content-type": "application/json; charset=utf-8" },
  })), true);
  assert.equal(loginRequestAllowed(new Request("https://insight.momentlabs.co.kr/api/session", {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
  })), false);
  assert.equal(loginRequestAllowed(new Request("https://insight.momentlabs.co.kr/api/session", {
    method: "POST",
    headers: { "content-type": "text/plain" },
  })), false);
});

test("revoked teams and teams attached to disconnected clients cannot authenticate", async () => {
  const revoked = await activeTeamByCode(contextWithRows([{
    data: { id: "team-1", team_code: "mml93-t01", status: "active", client_id: null, revoked_at: "2026-07-19T00:00:00Z" },
    error: null,
  }]), "mml93-t01");
  assert.equal(revoked.data, null);

  const disconnected = await activeTeamByCode(contextWithRows([
    { data: { id: "team-1", team_code: "mml93-t01", status: "active", client_id: "client-2", revoked_at: null }, error: null },
    { data: { id: "client-2", agency_code: "mml93-a02", status: "active", disconnected_at: "2026-07-19T00:00:00Z" }, error: null },
  ]), "mml93-t01");
  assert.equal(disconnected.data, null);
});

test("restored sessions remain bound to the original team and client ids", async () => {
  const wrongTeam = await sessionStillActive(contextWithRows([{
    data: { id: "team-2", team_code: "mml93-t01", status: "active", client_id: null, revoked_at: null },
    error: null,
  }]), { role: "team", teamCode: "mml93-t01", teamId: "team-1" });
  assert.equal(wrongTeam, null);

  const wrongClient = await sessionStillActive(contextWithRows([{
    data: { id: "client-2", agency_code: "mml93-a02", status: "active", disconnected_at: null },
    error: null,
  }]), { role: "client", agencyCode: "mml93-a02", clientId: "client-1" });
  assert.equal(wrongClient, null);
});

test("restored sessions distinguish database outages from confirmed revocation", async () => {
  const claims = { role: "client", agencyCode: "mml93-a02", clientId: "client-2" };
  const unavailable = await sessionActivityState(contextWithRows([{
    data: null,
    error: { message: "temporary database outage" },
  }]), claims);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.active, null);

  const revoked = await sessionActivityState(contextWithRows([{
    data: null,
    error: null,
  }]), claims);
  assert.equal(revoked.state, "revoked");
  assert.equal(revoked.active, null);

  const active = await sessionActivityState(contextWithRows([{
    data: { id: "client-2", agency_code: "mml93-a02", status: "active", disconnected_at: null },
    error: null,
  }]), claims);
  assert.equal(active.state, "active");
  assert.equal(active.active.client.id, "client-2");
});

test("trial sessions stay active only while their trial login identity row exists", async () => {
  const claims = { role: "client", agencyCode: "trial-10293847", trial: 1, gsub: "102938475647382910111" };
  const active = await sessionStillActive(contextWithRows([{
    data: { google_sub: "102938475647382910111", google_email: "trial@example.com", role: "trial", code: "102938475647382910111", linked_at: null },
    error: null,
  }]), claims);
  assert.equal(active.role, "client");
  assert.equal(active.trial, true);
  assert.equal(active.client.name, "체험 계정");
  assert.equal(active.client.trial, true);
  assert.equal(active.client.agency_code, "trial-10293847");

  const removed = await sessionStillActive(contextWithRows([{ data: null, error: null }]), claims);
  assert.equal(removed, null);

  const outage = await sessionActivityState(contextWithRows([{ data: null, error: { message: "down" } }]), claims);
  assert.equal(outage.state, SESSION_ACTIVITY_UNAVAILABLE);

  const missingSub = await sessionStillActive(contextWithRows([]), { role: "client", agencyCode: "trial-x", trial: 1, gsub: "" });
  assert.equal(missingSub, null);
});

// ── 검수 2026-10-03 긴급 ①: '*' 가 PostgREST ilike 에서 '아무 글자'로 해석돼 코드 일부만으로 로그인되던 결함 ──
test("접속 코드는 '*' 를 받지 않는다(광고주 5자·운영팀 6자 모두)", () => {
  for (const [code, mode] of [["alst*", "client"], ["*****", "client"], ["******", "operator"], ["a*b*c*", "admin"], ["alstj4492*", "client"]]) {
    assert.equal(normalizeRequestedLoginCode(code, mode), "", `${code} (${mode}) 는 거절해야 한다`);
  }
  assert.equal(normalizeLoginCode("abc*123"), "");
  // 기존 허용 문자는 그대로다.
  assert.equal(normalizeRequestedLoginCode("alstj4492", "client"), "alstj4492");
  assert.equal(normalizeLoginCode("mml93-a01"), "mml93-a01");
});

test("패턴 문자(* % _ \\)가 섞인 코드는 조회 자체를 하지 않고, 정상 코드는 소문자 정확 값으로만 ilike 한다", async () => {
  const patterns = [];
  const ctx = {
    supabaseAdmin: {
      from() {
        const query = {
          select() { return query; },
          ilike(_column, value) { patterns.push(value); return query; },
          eq() { return query; },
          maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        };
        return query;
      },
    },
  };
  for (const code of ["alst*", "a%", "ab_c1", "a\\b"]) {
    assert.deepEqual(await activeClientByCode(ctx, code), { data: null, error: null });
    assert.deepEqual(await activeTeamByCode(ctx, code), { data: null, error: null });
  }
  assert.deepEqual(patterns, [], "패턴 문자가 있으면 DB 조회를 하지 않는다");
  await activeClientByCode(ctx, "  ALSTJ4492 ");
  await activeTeamByCode(ctx, "Team-01");
  assert.deepEqual(patterns, ["alstj4492", "team-01"]);
});

// ── 점검 2026-11-02 F00: 대표 코드·옛 대표 코드로는 광고주 화면을 열지 않는다 ──
const RESERVED_TEST_ENV = {
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_PUBLISHABLE_KEY: "pub-test",
  SUPABASE_PUBLISHABLE_KEYS: undefined,
  SUPABASE_SECRET_KEY: "secret-test",
  SUPABASE_SECRET_KEYS: undefined,
  MI_SESSION_SECRET: "session-secret-for-reserved-code-tests-0123456789",
  MI_SESSION_SECRET_PREVIOUS: undefined,
  MI_SESSION_TTL_SECONDS: undefined,
  MI_PRIMARY_AGENCY_CODE: "mml93-a01",
  MI_OWNER_LOGIN_CODE: "strong-owner-secret",
  MI_OWNER_LOGIN_CODE_SHA256: undefined,
  MI_LEGACY_AGENCY_CODES: "old-owner01, Older-Owner2",
  MI_GOOGLE_LOGIN_ROLES: undefined,
  NODE_ENV: undefined,
  VERCEL_ENV: undefined,
};
const RESERVED_VARIANTS = ["mml93-a01", "  MML93-A01 ", "Mml93-A01", "ｍｍｌ９３－ａ０１", "old-owner01", "OLDER-OWNER2", " ｏｌｄ－ｏｗｎｅｒ０１ "];
const OWNER_BRAND_ROW = { id: "client-owner-brand", name: "브랜드 A", business_name: "", agency_code: "mml93-a01", status: "active", disconnected_at: null };
const LEGACY_BRAND_ROW = { id: "client-old-owner", name: "옛 대표", business_name: "", agency_code: "old-owner01", status: "active", disconnected_at: null };
const NORMAL_BRAND_ROW = { id: "client-normal", name: "일반 광고주", business_name: "", agency_code: "brand-b02", status: "active", disconnected_at: null };
const TEAM_ROW = { id: "team-1", team_name: "운영 1팀", team_code: "ops-team01", status: "active", client_id: "client-owner-brand", revoked_at: null };

async function withEnv(overrides, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function rowMatches(row, searchParams) {
  for (const [key, raw] of searchParams) {
    if (["select", "limit"].includes(key)) continue;
    const value = String(row[key] ?? "");
    if (raw.startsWith("eq.")) {
      if (value !== raw.slice(3)) return false;
    } else if (raw.startsWith("ilike.")) {
      if (value.toLowerCase() !== raw.slice(6).toLowerCase()) return false;
    } else {
      throw new Error(`unsupported filter ${key}=${raw}`);
    }
  }
  return true;
}

// withSupabase 가 ctx 를 만들므로 PostgREST 로 나가는 요청을 가로챈다. 표 행은 DB 처럼 걸러 돌려준다.
function sessionDbStub({ clients = [OWNER_BRAND_ROW, LEGACY_BRAND_ROW, NORMAL_BRAND_ROW], teams = [TEAM_ROW] } = {}) {
  const calls = [];
  const tables = { clients, operation_team_codes: teams };
  const impl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : String(input.url));
    const method = String(init.method || "GET").toUpperCase();
    const single = String(new Headers(init.headers || {}).get("accept") || "").includes("vnd.pgrst.object+json");
    calls.push({ method, path: url.pathname, url });
    if (url.pathname === "/rest/v1/rpc/consume_code_login_rate_limit") return Response.json([{ allowed: true, retry_after: 0 }]);
    if (url.pathname.startsWith("/rest/v1/rpc/")) return Response.json(null);
    if (url.pathname === "/rest/v1/code_login_rate_limits") return new Response(null, { status: 204 });
    const table = tables[url.pathname.replace("/rest/v1/", "")];
    if (!table || method !== "GET") throw new Error(`unexpected fetch: ${method} ${url}`);
    const rows = table.filter((row) => rowMatches(row, url.searchParams));
    return single ? Response.json(rows[0] ?? null) : Response.json(rows);
  };
  return { calls, impl };
}

async function callSessionApi(request, stub, env = {}) {
  return withEnv({ ...RESERVED_TEST_ENV, ...env }, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stub.impl;
    try {
      const response = await sessionApi.fetch(typeof request === "function" ? request() : request);
      return { response, payload: await response.json() };
    } finally {
      globalThis.fetch = original;
    }
  });
}

function loginRequest(mode, code) {
  return new Request("http://localhost:8784/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.90" },
    body: JSON.stringify({ mode, code }),
  });
}

// 봉인 비밀값이 env 에서 오므로 callSessionApi 안에서 만든다.
function restoreRequest(claims) {
  return () => new Request("http://localhost:8784/api/session", {
    headers: { cookie: `mi-session=${sealSession(createSessionClaims(claims, { ttlSeconds: 3600 }))}` },
  });
}

function clientLookups(stub) {
  return stub.calls.filter((call) => call.path === "/rest/v1/clients");
}

test("대표 코드·옛 대표 코드는 대소문자·공백·전각이 달라도 DB 를 보지 않고 없는 광고주로 돌려준다", async () => {
  await withEnv({ MI_LEGACY_AGENCY_CODES: "old-owner01, Older-Owner2" }, async () => {
    for (const code of RESERVED_VARIANTS) {
      const ctx = { supabaseAdmin: { from() { throw new Error(`no lookup expected for ${code}`); } } };
      assert.deepEqual(await activeClientByCode(ctx, code), { data: null, error: null }, code);
    }
    const normal = await activeClientByCode(contextWithRows([{ data: NORMAL_BRAND_ROW, error: null }]), "Brand-B02");
    assert.equal(normal.data.id, "client-normal");
  });
});

test("대표 코드로 남은 광고주 세션은 복원 판정에서 해지로 끝난다(장애로 보지 않는다)", async () => {
  await withEnv({ MI_LEGACY_AGENCY_CODES: "old-owner01" }, async () => {
    const untouched = { supabaseAdmin: { from() { throw new Error("no lookup expected"); } } };
    for (const claims of [
      { role: "client", agencyCode: "mml93-a01", clientId: "client-owner-brand" },
      { role: "client", agencyCode: "MML93-A01", clientId: "client-owner-brand" },
      { role: "client", agencyCode: "old-owner01", clientId: "client-old-owner" },
    ]) {
      const state = await sessionActivityState(untouched, claims);
      assert.equal(state.state, "revoked", claims.agencyCode);
      assert.equal(state.active, null);
    }
  });
});

test("광고주 코드 로그인: 대표 코드·옛 코드는 없는 코드와 같은 답으로 거절하고 일반 광고주는 그대로 들어간다", async () => {
  const unknownStub = sessionDbStub();
  const unknown = await callSessionApi(loginRequest("client", "no-such-brand"), unknownStub);
  assert.equal(unknown.response.status, 401);

  for (const code of ["mml93-a01", "  MML93-A01 ", "Mml93-A01", "old-owner01", "OLDER-OWNER2"]) {
    const stub = sessionDbStub();
    const { response, payload } = await callSessionApi(loginRequest("client", code), stub);
    assert.equal(response.status, 401, code);
    assert.deepEqual(payload, unknown.payload, `${code} 거절 문구는 없는 코드와 같아야 한다`);
    assert.equal(response.headers.get("set-cookie"), null, `${code} 는 세션 쿠키를 받지 않는다`);
    assert.equal(clientLookups(stub).length, 0, `${code} 는 광고주 표를 조회하지 않는다`);
  }

  // 전각 입력은 원래부터 접속 형식에서 걸러진다(어떤 코드든 같은 400).
  const fullWidth = await callSessionApi(loginRequest("client", "ｍｍｌ９３－ａ０１"), sessionDbStub());
  const fullWidthOther = await callSessionApi(loginRequest("client", "ｂｒａｎｄ－ｂ０２"), sessionDbStub());
  assert.equal(fullWidth.response.status, 400);
  assert.deepEqual(fullWidth.payload, fullWidthOther.payload);

  const normal = await callSessionApi(loginRequest("client", "Brand-B02"), sessionDbStub());
  assert.equal(normal.response.status, 200);
  assert.equal(normal.payload.session.role, "client");
  assert.equal(normal.payload.client.id, "client-normal");
});

test("총관리자 로그인과 운영팀 로그인은 대표 코드 차단의 영향을 받지 않는다", async () => {
  const owner = await callSessionApi(loginRequest("admin", "strong-owner-secret"), sessionDbStub());
  assert.equal(owner.response.status, 200);
  assert.equal(owner.payload.session.role, "owner");

  // 대표 광고주(브랜드 A)에 연결된 운영팀도 그대로 들어간다 — 운영팀 경로는 광고주 코드 조회를 쓰지 않는다.
  const team = await callSessionApi(loginRequest("operator", "OPS-TEAM01"), sessionDbStub());
  assert.equal(team.response.status, 200);
  assert.equal(team.payload.session.role, "team");
  assert.equal(team.payload.team.client.id, "client-owner-brand");
  const teamByAdminMode = await callSessionApi(loginRequest("admin", "ops-team01"), sessionDbStub());
  assert.equal(teamByAdminMode.response.status, 200);
  assert.equal(teamByAdminMode.payload.session.role, "team");
});

test("세션 복원: 대표 코드·옛 코드 광고주 세션은 401 로 쿠키를 지우고, 일반 광고주·총관리자·운영팀 세션은 그대로다", async () => {
  for (const claims of [
    { role: "client", agencyCode: "mml93-a01", clientId: "client-owner-brand" },
    { role: "client", agencyCode: "MML93-A01", clientId: "client-owner-brand" },
    { role: "client", agencyCode: "old-owner01", clientId: "client-old-owner" },
  ]) {
    const stub = sessionDbStub();
    const { response, payload } = await callSessionApi(restoreRequest(claims), stub);
    assert.equal(response.status, 401, claims.agencyCode);
    assert.equal(payload.ok, false);
    assert.match(String(response.headers.get("set-cookie") || ""), /Max-Age=0/i, `${claims.agencyCode} 쿠키를 지운다`);
    assert.equal(clientLookups(stub).length, 0);
  }

  const normal = await callSessionApi(restoreRequest({ role: "client", agencyCode: "brand-b02", clientId: "client-normal" }), sessionDbStub());
  assert.equal(normal.response.status, 200);
  assert.equal(normal.payload.client.id, "client-normal");

  const owner = await callSessionApi(restoreRequest({ role: "owner", agencyCode: "mml93-a01" }), sessionDbStub());
  assert.equal(owner.response.status, 200);
  assert.equal(owner.payload.session.role, "owner");

  const team = await callSessionApi(restoreRequest({
    role: "team", teamCode: "ops-team01", teamId: "team-1", clientId: "client-owner-brand", agencyCode: "mml93-a01",
  }), sessionDbStub());
  assert.equal(team.response.status, 200);
  assert.equal(team.payload.session.role, "team");
});

test("구글 광고주 로그인도 대표 코드·옛 코드 연결이면 '없는 계정'으로 끝나고, 일반 광고주와 총관리자는 그대로다", async () => {
  const env = { MI_GOOGLE_LOGIN_ROLES: "owner,team,client", MI_PRIMARY_AGENCY_CODE: "mml93-a01" };
  await withEnv({ MI_LEGACY_AGENCY_CODES: "old-owner01" }, async () => {
    const untouched = { supabaseAdmin: { from() { throw new Error("no lookup expected"); } } };
    for (const code of ["mml93-a01", "MML93-A01", "old-owner01"]) {
      assert.deepEqual(await resolveGoogleLoginAccess({ role: "client", code }, untouched, env), { ok: false, reason: "inactive" }, code);
    }
    // 없는 코드와 같은 답이다.
    assert.deepEqual(
      await resolveGoogleLoginAccess({ role: "client", code: "no-such-brand" }, contextWithRows([{ data: null, error: null }]), env),
      { ok: false, reason: "inactive" },
    );
    assert.deepEqual(
      await resolveGoogleLoginAccess({ role: "client", code: "brand-b02" }, contextWithRows([{ data: NORMAL_BRAND_ROW, error: null }]), env),
      { ok: true, access: { role: "client", clientId: "client-normal", agencyCode: "brand-b02" } },
    );
    assert.deepEqual(
      await resolveGoogleLoginAccess({ role: "owner", code: "mml93-a01" }, untouched, env),
      { ok: true, access: { role: "owner", agencyCode: "mml93-a01" } },
    );
  });
});

test("광고주 코드 조회(activeClientByCode)는 광고주 역할 경로에서만 쓴다 — 관리자 '광고주 미리보기' 경로는 쓰지 않는다", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const handlerDir = new URL("./", import.meta.url);
  const users = [];
  for (const name of await readdir(handlerDir)) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs") || name === "code-session-api.mjs") continue;
    if ((await readFile(new URL(name, handlerDir), "utf8")).includes("activeClientByCode")) users.push(name);
  }
  // 구글 광고주 로그인·연결(google-calendar-api), 광고주 개인 일정(personal-identity) 두 곳뿐이다.
  assert.deepEqual(users.sort(), ["google-calendar-api.mjs", "personal-identity.mjs"]);
});

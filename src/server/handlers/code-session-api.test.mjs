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
import { SESSION_ACTIVITY_UNAVAILABLE } from "../session-gate.mjs";

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

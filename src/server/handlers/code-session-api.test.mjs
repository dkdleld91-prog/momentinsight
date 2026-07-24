import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTeamByCode,
  consumeRateLimit,
  loginRateConfiguration,
  loginRateKeys,
  loginRequestAllowed,
  normalizeLoginCode,
  ownerCredentialConfigured,
  ownerCredentialMatches,
  sessionActivityState,
  sessionStillActive,
} from "./code-session-api.mjs";

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

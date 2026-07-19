import assert from "node:assert/strict";
import test from "node:test";
import {
  clearedSessionCookies,
  createSessionClaims,
  csrfMatches,
  openSession,
  publicSession,
  sealSession,
  sessionConfiguration,
  sessionCookie,
  sessionFromRequest,
} from "./code-session.mjs";

const ENV = {
  NODE_ENV: "production",
  MI_SESSION_SECRET: "test-only-session-secret-with-at-least-32-bytes",
  MI_SESSION_TTL_SECONDS: "3600",
};

test("encrypted session round-trips without exposing claims", () => {
  const claims = createSessionClaims({
    role: "client",
    accountLabel: "mml93-a02",
    agencyCode: "mml93-a02",
    clientId: "client-1",
  }, { now: 1_800_000_000_000, ttlSeconds: 3600 });
  const token = sealSession(claims, ENV);

  assert.equal(token.includes("mml93-a02"), false);
  assert.equal(token.includes("client-1"), false);
  assert.deepEqual(openSession(token, ENV, { now: 1_800_000_100_000 }), claims);
  assert.equal(openSession(`${token}x`, ENV, { now: 1_800_000_100_000 }), null);
});

test("expired sessions and wrong keys are rejected", () => {
  const claims = createSessionClaims({ role: "team", teamCode: "mml93-t01" }, {
    now: 1_800_000_000_000,
    ttlSeconds: 300,
  });
  const token = sealSession(claims, ENV);

  assert.equal(openSession(token, ENV, { now: 1_800_000_301_000 }), null);
  assert.equal(openSession(token, { ...ENV, MI_SESSION_SECRET: "another-32-byte-test-secret-not-the-same" }, {
    now: 1_800_000_100_000,
  }), null);
});

test("production cookie is host-only, secure, httpOnly and strict", () => {
  const claims = createSessionClaims({ role: "owner", accountLabel: "mml93-a01" });
  const token = sealSession(claims, ENV);
  const cookie = sessionCookie(token, ENV);
  const request = new Request("https://insight.momentlabs.co.kr/api/session", {
    headers: { cookie: cookie.split(";")[0] },
  });

  assert.match(cookie, /^__Host-mi-session=/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.equal(sessionFromRequest(request, ENV)?.role, "owner");
  assert.equal(clearedSessionCookies(ENV).length, 2);
});

test("csrf token is timing-safe and public session omits credentials", () => {
  const claims = createSessionClaims({
    role: "team",
    accountLabel: "mml93-t01",
    teamCode: "mml93-t01",
    agencyCode: "mml93-a02",
  });
  const visible = publicSession(claims);

  assert.equal(csrfMatches(claims, claims.csrf), true);
  assert.equal(csrfMatches(claims, `${claims.csrf}x`), false);
  assert.equal("teamCode" in visible, false);
  assert.equal("agencyCode" in visible, false);
  assert.match(visible.scopeKey, /^[A-Za-z0-9_-]{24}$/);
  assert.equal("accountLabel" in visible, false);
  assert.equal(JSON.stringify(visible).includes("mml93-t01"), false);
});

test("production rejects undersized session secrets", () => {
  assert.equal(sessionConfiguration({ NODE_ENV: "production", MI_SESSION_SECRET: "short" }).valid, false);
});

test("production rejects an undersized previous rotation secret", () => {
  const env = {
    NODE_ENV: "production",
    MI_SESSION_SECRET: "a".repeat(32),
    MI_SESSION_SECRET_PREVIOUS: "weak",
  };
  assert.equal(sessionConfiguration(env).valid, false);
  const weakToken = sealSession(createSessionClaims({ role: "client" }), {
    NODE_ENV: "development",
    MI_SESSION_SECRET: "weak",
  });
  assert.equal(openSession(weakToken, env), null);
});

test("production accepts only the __Host session cookie", () => {
  const env = { NODE_ENV: "production", MI_SESSION_SECRET: "s".repeat(32) };
  const claims = createSessionClaims({ role: "client", accountLabel: "mml93-a02" });
  const token = sealSession(claims, env);
  const legacy = new Request("https://insight.momentlabs.co.kr/api/test", {
    headers: { cookie: `mi-session=${token}` },
  });
  const hostOnly = new Request("https://insight.momentlabs.co.kr/api/test", {
    headers: { cookie: `__Host-mi-session=${token}` },
  });
  assert.equal(sessionFromRequest(legacy, env), null);
  assert.equal(sessionFromRequest(hostOnly, env)?.role, "client");
});

test("invalid session ttl values fail closed and never emit NaN", () => {
  const env = {
    NODE_ENV: "production",
    MI_SESSION_SECRET: "s".repeat(32),
    MI_SESSION_TTL_SECONDS: "not-a-number",
  };
  const config = sessionConfiguration(env);
  assert.equal(config.valid, false);
  assert.equal(Number.isFinite(config.ttl), true);
  assert.doesNotMatch(sessionCookie("token", env), /NaN/);
});

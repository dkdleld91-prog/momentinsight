import assert from "node:assert/strict";
import test from "node:test";
import {
  PERSISTENT_SESSION_SECONDS,
  clearedSessionCookies,
  createSessionClaims,
  csrfMatches,
  openSession,
  publicSession,
  reissueSessionOptions,
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

// ── 자동 로그인(30일) ────────────────────────────────────────

test("자동 로그인 세션은 30일 클레임과 30일 쿠키로 발급된다", () => {
  assert.equal(PERSISTENT_SESSION_SECONDS, 2_592_000);
  const claims = createSessionClaims({ role: "owner", agencyCode: "mml93-a01" }, {
    now: 1_800_000_000_000,
    ttlSeconds: PERSISTENT_SESSION_SECONDS,
    persist: true,
  });
  assert.equal(claims.pst, 1);
  assert.equal(claims.exp - claims.iat, 2_592_000);

  const token = sealSession(claims, ENV);
  assert.equal(openSession(token, ENV, { now: 1_800_000_100_000 })?.role, "owner");

  const cookie = sessionCookie(token, ENV, { maxAge: PERSISTENT_SESSION_SECONDS });
  assert.match(cookie, /^__Host-mi-session=/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /Max-Age=2592000/);
});

test("표식 없는 긴 세션은 열리지 않는다", () => {
  // 위조 방어의 핵심. 봉인은 서버 키로만 만들어지지만, 표식 없는 토큰이 30일을
  // 주장하면 그것은 옛 규칙 위반이므로 열지 않는다.
  const claims = createSessionClaims({ role: "team", teamCode: "mml93-t01" }, {
    now: 1_800_000_000_000,
    ttlSeconds: 2_592_000,
  });
  assert.equal(claims.pst, undefined);
  assert.equal(openSession(sealSession(claims, ENV), ENV, { now: 1_800_000_100_000 }), null);
});

test("기본 쿠키와 로그아웃 쿠키는 그대로다", () => {
  const token = sealSession(createSessionClaims({ role: "client" }), ENV);
  assert.match(sessionCookie(token, ENV), new RegExp(`Max-Age=${sessionConfiguration(ENV).ttl}`));
  const cleared = clearedSessionCookies(ENV);
  assert.equal(cleared.length, 2);
  for (const cookie of cleared) assert.match(cookie, /Max-Age=0/);
});

test("재발급은 자동 로그인의 원래 만료를 물려주고 늘리지 않는다", () => {
  const now = 1_800_000_000_000;
  const nowSeconds = Math.floor(now / 1000);
  assert.deepEqual(
    reissueSessionOptions({ pst: 1, exp: nowSeconds + 2_592_000 }, ENV, now),
    { ttlSeconds: 2_592_000, persist: true },
  );
  // 10일 지난 세션은 남은 20일만 물려받는다 — 재발급이 수명을 되감지 않는다.
  const tenDaysLater = now + 10 * 24 * 60 * 60 * 1000;
  assert.deepEqual(
    reissueSessionOptions({ pst: 1, exp: nowSeconds + 2_592_000 }, ENV, tenDaysLater),
    { ttlSeconds: 1_728_000, persist: true },
  );
  // 코드 로그인(비지속) 은 오늘과 같은 모양이다.
  assert.deepEqual(reissueSessionOptions({ role: "team" }, ENV), { ttlSeconds: sessionConfiguration(ENV).ttl });
});

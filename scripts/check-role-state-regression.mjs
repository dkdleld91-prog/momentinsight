import assert from "node:assert/strict";
import fs from "node:fs";

import { createSessionClaims, sealSession } from "../src/server/code-session.mjs";
import {
  authorizeCodeSession,
  internalRequestForSession,
  roleAllowsPath,
  sessionScopeAllowsPath,
} from "../src/server/session-gate.mjs";

const ENV = {
  NODE_ENV: "production",
  MI_SESSION_SECRET: "role-state-regression-session-secret-32-bytes",
  MI_SUPER_ADMIN_CODE: "role-state-regression-super-admin",
  MI_OWNER_LOGIN_CODE: "role-state-regression-owner-login",
  MI_RANK_ADMIN_CODE: "role-state-regression-rank-admin",
  MI_PRIMARY_AGENCY_CODE: "mml93-a01",
  SUPABASE_SECRET_KEY: "role-state-regression-supabase-secret",
};

const CORE_FEATURE_PATHS = [
  "/api/naver-keyword",
  "/api/naver-product-seo-audit",
  "/api/naver-shopping-rank",
  "/api/naver-rank-trackers",
  "/api/naver-place-rank-trackers",
];

const ROLE_STATES = [
  {
    id: "owner",
    claims: createSessionClaims({ role: "owner", accountLabel: "mml93-a01", agencyCode: "mml93-a01" }),
    coreAllowed: true,
    reportAllowed: true,
    teamAdminAllowed: true,
  },
  {
    id: "linked-team",
    claims: createSessionClaims({
      role: "team",
      teamId: "team-linked",
      teamCode: "mml93-t01",
      clientId: "client-linked",
      agencyCode: "mml93-a02",
    }),
    coreAllowed: true,
    reportAllowed: true,
    teamAdminAllowed: true,
  },
  {
    id: "account-only-team",
    claims: createSessionClaims({
      role: "team",
      teamId: "team-account-only",
      teamCode: "mml93-t02",
    }),
    coreAllowed: true,
    reportAllowed: false,
    teamAdminAllowed: true,
  },
  {
    id: "client",
    claims: createSessionClaims({
      role: "client",
      clientId: "client-linked",
      agencyCode: "mml93-a02",
    }),
    coreAllowed: true,
    reportAllowed: true,
    teamAdminAllowed: false,
  },
];

function requestWithSession(path, claims, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("cookie", `__Host-mi-session=${sealSession(claims, ENV)}`);
  headers.set("x-mi-csrf", claims.csrf);
  return new Request(`https://insight.momentlabs.co.kr${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });
}

for (const state of ROLE_STATES) {
  for (const path of CORE_FEATURE_PATHS) {
    assert.equal(roleAllowsPath(state.claims.role, path), state.coreAllowed, `${state.id} role ${path}`);
    assert.equal(sessionScopeAllowsPath(state.claims, path), state.coreAllowed, `${state.id} scope ${path}`);
    const authorized = await authorizeCodeSession(requestWithSession(path, state.claims), ENV, {
      activityCheck: async () => true,
    });
    assert.equal(authorized.ok, state.coreAllowed, `${state.id} runtime ${path}`);
  }
  assert.equal(
    roleAllowsPath(state.claims.role, "/api/report-center")
      && sessionScopeAllowsPath(state.claims, "/api/report-center"),
    state.reportAllowed,
    `${state.id} report scope`,
  );
  assert.equal(
    roleAllowsPath(state.claims.role, "/api/team-agency-codes")
      && sessionScopeAllowsPath(state.claims, "/api/team-agency-codes"),
    state.teamAdminAllowed,
    `${state.id} team administration`,
  );

  const report = await authorizeCodeSession(requestWithSession("/api/report-center", state.claims), ENV, {
    activityCheck: async () => true,
  });
  assert.equal(report.ok, state.reportAllowed, `${state.id} runtime report scope`);
  const teamAdmin = await authorizeCodeSession(requestWithSession("/api/team-agency-codes", state.claims), ENV, {
    activityCheck: async () => true,
  });
  assert.equal(teamAdmin.ok, state.teamAdminAllowed, `${state.id} runtime team administration`);
}

const accountOnly = ROLE_STATES.find((state) => state.id === "account-only-team").claims;
for (const path of ["/api/naver-rank-trackers", "/api/naver-place-rank-trackers"]) {
  const hostile = new Request(`https://insight.momentlabs.co.kr${path}`, {
    headers: {
      "x-mi-team-code": "mml93-t99",
      "x-mi-agency-code": "mml93-a99",
      "x-mi-rank-access-code": "forged-browser-secret",
      "x-mi-session-role": "owner",
      "x-mi-session-scope": "advertiser",
    },
  });
  const trusted = internalRequestForSession(hostile, accountOnly, ENV);
  assert.equal(trusted.headers.get("x-mi-team-code"), accountOnly.teamCode, `${path} trusted team`);
  assert.equal(trusted.headers.get("x-mi-agency-code"), accountOnly.teamCode, `${path} isolated agency`);
  assert.equal(trusted.headers.get("x-mi-rank-access-code"), accountOnly.teamCode, `${path} isolated rank`);
  assert.equal(trusted.headers.get("x-mi-session-role"), "team", `${path} trusted role`);
  assert.equal(trusted.headers.get("x-mi-session-scope"), "account-only", `${path} trusted scope`);
}

const revokedRequest = requestWithSession("/api/naver-rank-trackers", accountOnly);
const revoked = await authorizeCodeSession(revokedRequest, ENV, {
  activityCheck: async () => false,
});
assert.equal(revoked.ok, false, "revoked team must fail");
assert.equal(revoked.response.status, 401, "revoked team status");
assert.equal((await revoked.response.json()).code, "SESSION_REVOKED", "revoked team code");

const adminSource = fs.readFileSync(new URL("../src/pages/admin.html", import.meta.url), "utf8");
const clientSource = fs.readFileSync(new URL("../src/pages/client.html", import.meta.url), "utf8");
const operationalDocs = [
  "../docs/WORK_STATUS.md",
  "../docs/NEXT_ACTIONS.md",
  "../docs/08-work-spec-autosave.md",
  "../docs/TEST_EVIDENCE.md",
].map((path) => fs.readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
const staleAccountOnlyCopy = [
  "보고서와 30일 추적은 광고주 연결 후 활성화됩니다.",
  "광고주 데이터인 N 상품/플레이스 30일 추적은 기존대로 차단",
  "N 상품/플레이스 30일 추적은 광고주 연결 전 계속 차단",
];
for (const phrase of staleAccountOnlyCopy) {
  assert.equal(adminSource.includes(phrase), false, `stale account-only copy: ${phrase}`);
  assert.equal(operationalDocs.includes(phrase), false, `stale operational documentation: ${phrase}`);
}
for (const marker of [
  "광고주 연결 전에도 조회 도구와 두 30일 순위 추적을 사용할 수 있으며",
  "보고서·공개 데이터는 광고주 연결 후 활성화됩니다.",
  'key: clientId ? "team:" + clientId : "team-account:" + teamId',
  'payload.scopeMode === "team-account"',
]) {
  assert.equal(adminSource.includes(marker), true, `admin account-only marker: ${marker}`);
}
assert.equal(
  operationalDocs.includes("광고주 연결 전에도 두 추적 기능의 조회·등록·갱신이 가능"),
  true,
  "current account-only tracking policy documentation",
);
for (const screen of [
  "keyword-tool",
  "seo-check",
  "naver-rank",
  "naver-rank-tracking",
  "naver-place-rank-tracking",
]) {
  assert.equal(clientSource.includes(`data-mi-view="${screen}"`), true, `client screen: ${screen}`);
}

console.log(JSON.stringify({
  ok: true,
  checkedStates: [...ROLE_STATES.map((state) => state.id), "revoked-team"],
  checkedFeatures: CORE_FEATURE_PATHS,
  checkedBoundaries: [
    "report-scope",
    "team-administration",
    "forged-header-replacement",
    "account-only-ui-copy",
    "client-core-screens",
  ],
}, null, 2));

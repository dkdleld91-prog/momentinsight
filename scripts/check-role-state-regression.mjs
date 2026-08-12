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
  "/api/work-items",
  "/api/naver-keyword",
  "/api/naver-product-seo-audit",
  "/api/naver-shopping-rank",
  "/api/naver-shopping-rank-jobs",
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

  const ownerToolAllowed = state.id === "owner";
  assert.equal(roleAllowsPath(state.claims.role, "/api/owner/tool"), ownerToolAllowed, `${state.id} owner tool role`);
  const ownerTool = await authorizeCodeSession(requestWithSession("/api/owner/tool", state.claims), ENV, {
    activityCheck: async () => true,
  });
  assert.equal(ownerTool.ok, ownerToolAllowed, `${state.id} runtime owner tool`);
  if (ownerToolAllowed) {
    assert.equal(ownerTool.request.headers.get("x-mi-session-role"), "owner", "owner tool trusted role");
    assert.equal(ownerTool.request.headers.get("x-mi-owner-agency-code"), "mml93-a01", "owner tool exact primary identity");
  }
}

const wrongOwnerClaims = createSessionClaims({ role: "owner", accountLabel: "mml93-a02", agencyCode: "mml93-a02" });
const wrongOwner = await authorizeCodeSession(requestWithSession("/api/owner/tool", wrongOwnerClaims), ENV);
assert.equal(wrongOwner.ok, false, "non-primary owner identity must fail");
assert.equal(wrongOwner.response.status, 401, "non-primary owner status");

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
const ownerToolSource = fs.readFileSync(new URL("../src/server/handlers/owner-tool-api.mjs", import.meta.url), "utf8");
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
  "naver-rank-tracking",
  "naver-place-rank-tracking",
]) {
  assert.equal(clientSource.includes(`data-mi-view="${screen}"`), true, `client screen: ${screen}`);
}

const staticAdminProductRankMenu = /<a\b[^>]*data-mi-admin-screen="naver-rank"/u;
const staticClientProductRankMenu = /<a\b[^>]*data-mi-screen="naver-rank"/u;
const staticAdminProductRankView = /<section\b[^>]*data-mi-admin-view="naver-rank"/u;
const staticClientProductRankView = /<section\b[^>]*data-mi-view="naver-rank"/u;
assert.equal(staticAdminProductRankMenu.test(adminSource), false, "admin product rank lookup menu hidden");
assert.equal(staticClientProductRankMenu.test(clientSource), false, "client product rank lookup menus hidden");
assert.equal(staticAdminProductRankView.test(adminSource), false, "admin product rank lookup view hidden");
assert.equal(staticClientProductRankView.test(clientSource), false, "client product rank lookup view hidden");
assert.equal(adminSource.includes('data-mi-admin-view="naver-rank-tracking"'), true, "admin product 30-day view remains");
assert.equal(clientSource.includes('data-mi-view="naver-rank-tracking"'), true, "client product 30-day view remains");

const staticOwnerDevelopmentMarkup = /<(?:a|div|section)\b[^>]*data-mi-admin-(?:screen|view)="owner-(?:development|utility)"/u;
const staticWorkerOperationsPanel = /<(?:div|section)\b[^>]*data-rank-worker-operations(?:\s|>|=)/u;
assert.equal(staticOwnerDevelopmentMarkup.test(adminSource), false, "admin source must not statically disclose owner development DOM");
assert.equal(staticOwnerDevelopmentMarkup.test(clientSource), false, "client source must not disclose owner development DOM");
assert.equal(staticWorkerOperationsPanel.test(adminSource), false, "admin source must not statically disclose worker operations panel");
assert.equal(staticWorkerOperationsPanel.test(clientSource), false, "client source must not disclose worker operations panel");

for (const marker of [
  'data-mi-admin-screen="owner-development"',
  'data-mi-admin-view="owner-development"',
  'data-mi-admin-screen="owner-utility"',
  'data-mi-admin-view="owner-utility"',
  "data-rank-worker-operations",
  "mi-nav-group",
]) {
  assert.equal(ownerToolSource.includes(marker), true, `server-delivered owner tool marker: ${marker}`);
}
assert.match(ownerToolSource, /개발\s+(?:&lt;\/?&gt;|<\/?\s*>)/u, "owner development group label");
assert.equal(ownerToolSource.includes('request.headers.get("x-mi-session-role") === "owner"'), true, "owner tool exact role check");
assert.equal(ownerToolSource.includes('request.headers.get("x-mi-owner-agency-code") === PRIMARY_AGENCY_CODE'), true, "owner tool primary identity check");
const ownerLoaderStart = adminSource.indexOf("async function loadOwnerTool() {");
const ownerLoaderEnd = adminSource.indexOf("function applySecureSession(", ownerLoaderStart);
assert.equal(ownerLoaderStart >= 0 && ownerLoaderEnd > ownerLoaderStart, true, "owner tool loader boundaries");
const ownerToolLoader = adminSource.slice(ownerLoaderStart, ownerLoaderEnd);
assert.equal(ownerToolLoader.includes("menuGroup"), true, "dynamic owner menu group");
assert.equal(ownerToolLoader.includes('querySelectorAll(":scope > section[data-mi-admin-view]")'), true, "dynamic owner views");
assert.equal(ownerToolLoader.includes('getAttribute("data-mi-admin-view") === "owner-development"'), true, "dynamic owner development validation");
assert.match(ownerToolLoader, /nav\.appendChild\(menuGroup\)/u, "dynamic owner menu mount");
assert.match(ownerToolLoader, /wrap\.appendChild\(view\)/u, "dynamic owner view mount");
assert.equal(ownerToolLoader.includes('CustomEvent("mi:rank-owner-tool-mounted")'), true, "dynamic owner operations mount signal");
assert.equal(adminSource.includes('document.querySelectorAll("[data-owner-tool-menu-root], [data-owner-tool-view-root], [data-owner-tool-style-root]")'), true, "owner logout removes menu views and head style");

const naverTrackingStart = adminSource.indexOf('<section class="mi-view" data-mi-admin-view="naver-rank-tracking"');
const naverTrackingEnd = adminSource.indexOf('<section class="mi-view" data-mi-admin-view="naver-place-rank-tracking"', naverTrackingStart);
assert.equal(naverTrackingStart >= 0 && naverTrackingEnd > naverTrackingStart, true, "N 30-day view boundaries");
const naverTrackingView = adminSource.slice(naverTrackingStart, naverTrackingEnd);
assert.equal(staticWorkerOperationsPanel.test(naverTrackingView), false, "N 30-day view must not contain worker operations panel");
assert.equal(naverTrackingView.includes("N 쇼핑 수집 운영센터"), false, "N 30-day view must stay separate from development operations");

const routerStart = adminSource.indexOf("function setScreen(");
const routerEnd = adminSource.indexOf('root.addEventListener("click"', routerStart);
assert.equal(routerStart >= 0 && routerEnd > routerStart, true, "admin screen router boundaries");
const adminScreenRouter = adminSource.slice(routerStart, routerEnd);
assert.equal(adminSource.includes("owner-development") && adminSource.includes("owner-utility"), true, "owner screen identifiers");
assert.equal(adminScreenRouter.includes("/^owner-/"), true, "owner hash namespace guard");
assert.equal(adminScreenRouter.includes("/^#mi-admin-owner-/"), true, "restored team owner hash guard");
assert.equal(adminScreenRouter.includes('secureSession.role !== "owner"'), true, "forged owner hash role guard");
assert.equal(adminScreenRouter.includes('"agency-code"') && adminScreenRouter.includes('"home"'), true, "forged owner hash fallback");
assert.equal(adminScreenRouter.includes("window.history.replaceState"), true, "forged owner hash canonical replacement");
assert.equal(adminScreenRouter.includes('target === "naver-rank"'), true, "hidden product rank hash guard");
assert.equal(adminScreenRouter.includes("rejectedProductRankTarget"), true, "hidden product rank hash canonical replacement");

const clientRouterStart = clientSource.indexOf("function setScreen(");
const clientRouterEnd = clientSource.indexOf('      links.forEach(function (link) {\n        link.addEventListener', clientRouterStart);
assert.equal(clientRouterStart >= 0 && clientRouterEnd > clientRouterStart, true, "client screen router boundaries");
const clientScreenRouter = clientSource.slice(clientRouterStart, clientRouterEnd);
assert.equal(clientScreenRouter.includes('target === "naver-rank"'), true, "client hidden product rank hash guard");
assert.equal(clientScreenRouter.includes('target = "dashboard"'), true, "client hidden product rank hash fallback");
assert.equal(clientScreenRouter.includes("window.history.replaceState"), true, "client hidden product rank hash canonical replacement");

assert.match(adminSource, /root\.querySelector\(\s*['"][^'"]*\[data-rank-worker-operations\][^'"]*['"]\s*\)/u, "global worker operations lookup");
assert.equal(adminSource.includes("rankWorkerOperationsPanel()"), true, "global worker operations helper use");
assert.equal(adminSource.includes('card.querySelector("[data-rank-worker-operations]")'), false, "worker operations must not depend on N 30-day card");
assert.equal(clientSource.includes("data-rank-worker-operations"), false, "client worker operations selector isolation");

console.log(JSON.stringify({
  ok: true,
  checkedStates: [...ROLE_STATES.map((state) => state.id), "revoked-team"],
  checkedFeatures: CORE_FEATURE_PATHS,
  checkedBoundaries: [
    "report-scope",
    "team-administration",
    "forged-header-replacement",
    "owner-development-dom-isolation",
    "owner-development-hash-fallback",
    "owner-tool-primary-identity",
    "account-only-ui-copy",
    "product-rank-lookup-hidden",
    "client-core-screens",
  ],
}, null, 2));

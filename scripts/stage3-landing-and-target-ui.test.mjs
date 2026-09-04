import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// UI 고도화 3단계: 역할별 착지 화면과 "대상 광고주 한 번만 고르기" 계약을 지킨다.
// 잠긴 함수(bindOwnerAssistant · initRankTracking · initPlaceRankTracking)는 건드리지 않고,
// 그것들이 이미 읽는 입력값과 이벤트만 바깥 글루에서 채웠는지 원본에서 확인한다.
const source = fs.readFileSync(new URL("../src/pages/admin.html", import.meta.url), "utf8");

function block(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source block not found: ${start}`);
  return source.slice(from, to);
}

const activateSessionSource = block("async function activateAdminSession(payload, restored, requestGeneration) {", "async function logoutAdmin() {");
const homeFeedMarkup = block('<section class="mi-view is-active mi-ops-home"', "<section class=\"mi-view mi-work-shell\"");
const modeStripMarkup = block('<div class="mi-mode-strip"', "</div>\n\n        <section");
const targetGlueSource = block("var GLOBAL_ADVERTISER_MANUAL_VALUE", 'var codeSaveButton = root.querySelector("[data-admin-code-save]");');
const homeStatusSource = block("function renderOperationHomeClientStatus() {", "function applyState(state) {");
const ownerAssistantSource = block("function bindOwnerAssistant(view, generation) {", "function googleLoginNotice(code) {");

test("owner session lands in the executive room, not the operations home", () => {
  assert.match(
    activateSessionSource,
    /var ownerLandingHash = \(window\.location\.hash \|\| ""\)\.replace\("#mi-admin-", ""\);\s*\n\s*if \(!ownerLandingHash && ownerToolScreens\.indexOf\("owner-assistant"\) >= 0\) \{\s*\n\s*setScreen\("owner-assistant", !restored\);/u,
  );
  // 운영 홈은 메뉴에서 사라지지 않는다.
  assert.ok(source.includes('data-mi-admin-screen="home">뉴스</a>'));
});

test("team session lands on the operations home summary regardless of client linkage", () => {
  assert.ok(activateSessionSource.includes('setScreen(personalCalendarNoticePending() ? "my-calendar" : "home", !restored);'));
  assert.ok(!activateSessionSource.includes('teamHasClient ? "agency-code" : "home"'));
});

// 시장 홈 13안: "지금 상황" 5카드·빠른 실행·운영 루틴·공개 전 확인 묶음은 걷어내고
// 오늘 일정 → 순위 급변 → 온라인 기사 → 내 키워드 지표 → 내 키워드 뉴스 순서로 간다.
test("the operations home leads with today's schedule and rank swings, then the market sections", () => {
  for (const hook of [
    "data-home-schedule-strip",
    "data-home-swing-strip",
    "data-home-feed-news",
    "data-home-feed-metrics",
    "data-home-feed-keyword-news",
  ]) {
    assert.ok(homeFeedMarkup.includes(hook), `missing home section: ${hook}`);
  }
  const order = [
    "data-home-schedule-strip",
    "data-home-swing-strip",
    "data-home-feed-news",
    "data-home-feed-metrics",
    "data-home-feed-keyword-news",
  ].map((hook) => homeFeedMarkup.indexOf(hook));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "홈 섹션 순서가 시안과 다릅니다.");

  // 옛 카드 묶음은 되살아나지 않는다.
  assert.ok(!source.includes('class="mi-ops-status-board"'));
  assert.ok(!source.includes('class="mi-ops-quick-grid"'));
  // 임의 집계 금지 표식은 새 홈으로 옮겨서 그대로 남는다.
  assert.ok(homeFeedMarkup.includes("data-admin-home-truthful-state"));
  assert.ok(homeFeedMarkup.includes("실제 연결 데이터가 없는 수치는 임의 집계하지 않습니다."));
  // 기사 링크는 새 탭으로 열되 opener 를 넘기지 않는다.
  assert.ok(!/<a\b[^>]*target="_blank"(?![^>]*rel="noopener")/u.test(homeFeedMarkup));
});

test("the home feed asks the server and lets only the owner retarget the advertiser", () => {
  const feedSource = block("async function refreshHomeFeed() {", "// 오늘 일정 띠는 서버를");
  // 라우터가 잠겨 있어 이미 열린 /api/client 접두사에 얹는다.
  assert.ok(source.includes('return window.location.origin + "/api/client/home-feed";'));
  // 운영팀·광고주 세션은 대상을 헤더로 바꿀 수 없다(서버 세션이 정한다).
  assert.ok(feedSource.includes('if (secureSession.role === "owner" && targetCode) headers.set("x-mi-agency-code", targetCode);'));
  // 세션이 바뀐 뒤 도착한 늦은 응답은 그리지 않는다.
  assert.ok(feedSource.includes("adminSessionIsCurrent(session.generation, session.role, session.scopeKey)"));
  // 홈이 실패해도 다른 화면 초기화를 막지 않는다.
  assert.ok(source.includes("          renderHomeFeedFailure();"));
});

test("summary cards read existing sources only and invent no new detection", () => {
  // 담당 광고주: 보안 세션이 이미 확인한 연결 상태.
  assert.ok(homeStatusSource.includes("currentOperationTeam && currentOperationTeam.client"));
  assert.ok(homeStatusSource.includes("연결된 광고주 없음"));
  // 오늘 일정: 이미 있는 /api/my/work-items.
  assert.ok(source.includes('return window.location.origin + "/api/my/work-items";'));
  assert.ok(homeStatusSource.includes('endpoint.searchParams.set("from", today)'));
  assert.ok(homeStatusSource.includes("items.filter(workItemNeedsAction)"));
  // 순위 급변: 이미 있는 추적 조회와 이미 있는 하락 판정만 재사용한다.
  assert.ok(homeStatusSource.includes("getRankTrackerApiUrl()"));
  assert.ok(homeStatusSource.includes("getPlaceRankTrackerApiUrl()"));
  assert.ok(homeStatusSource.includes('rankTrackerTrend(tracker) === "dropped"'));
  assert.ok(homeStatusSource.includes('placeTrackerTrend(tracker) === "dropped"'));
  assert.ok(homeStatusSource.includes("verifiedRankTrackerScope()"));
  // 매출·보고서는 2단계 실경로를 그대로 쓴다.
  assert.ok(source.includes("function renderOperationHomeSalesStatus"));
  assert.ok(source.includes("function refreshOperationHomeReportStatus"));
  assert.ok(source.includes("refreshOperationHomeStatus();"));
});

test("one global advertiser picker exists and offers a free text fallback", () => {
  assert.ok(modeStripMarkup.includes("data-mi-target-picker"));
  assert.ok(modeStripMarkup.includes("data-mi-target-select"));
  assert.ok(modeStripMarkup.includes("data-mi-target-manual"));
  assert.equal((source.match(/data-mi-target-select/g) || []).length, 3);
  assert.ok(targetGlueSource.includes('var GLOBAL_ADVERTISER_MANUAL_VALUE = "__manual__";'));
  assert.ok(targetGlueSource.includes(">코드 직접 입력</option>"));
  assert.ok(targetGlueSource.includes('"mi-global-advertiser-target:" + (normalizeStorageCode(secureSession.scopeKey) || "session")'));
  assert.ok(targetGlueSource.includes("window.sessionStorage.setItem(globalAdvertiserStorageKey(), code)"));
  // 총관리자 목록은 이미 있는 요청(requestOwnerCodes GET → renderOwnerCodeList)에서만 채운다.
  assert.ok(targetGlueSource.includes("activeOwnerClients(ownerCodeSnapshot)"));
  assert.ok(source.includes("        syncOwnerCodeDefaults(payload);\n        renderGlobalAdvertiserPicker();"));
});

test("the picker drives all three consumers from one place", () => {
  // 1) 공개 관리 코드 입력
  assert.ok(targetGlueSource.includes('var publicCodeInput = root.querySelector("[data-admin-code]");'));
  assert.ok(targetGlueSource.includes("publicCodeInput.value = nextPublicCode;"));
  // 2) 대표실 광고주 범위 입력
  assert.ok(targetGlueSource.includes('var workScopeInput = root.querySelector("[data-work-owner-client-code]");'));
  assert.ok(targetGlueSource.includes("workScopeInput.value = nextWorkCode;"));
  // 3) 순위 화면은 범위 변경 이벤트로 다시 읽는다.
  assert.ok(targetGlueSource.includes('window.dispatchEvent(new CustomEvent("mi:rank-scope-changed"));'));
  assert.ok(targetGlueSource.includes("applyState(readState());"));
  // 순위 화면 두 곳에 현재 대상이 보인다(마크업 2 + 갱신 셀렉터 1).
  assert.equal((source.match(/<span class="mi-target-echo" data-mi-target-echo>/g) || []).length, 2);
  assert.ok(source.includes('root.querySelectorAll("[data-mi-target-echo]")'));
  assert.ok(targetGlueSource.includes('node.textContent = "대상 광고주 · " + label;'));
  // 반대 방향도 하나로 모인다: 대표실 범위 입력과 실장 음성 전환이 전역 값을 갱신한다.
  assert.ok(source.includes("applyGlobalAdvertiserTarget(workOwnerClientInput.value, { force: true, reloadWork: false });"));
  assert.ok(source.includes("applyGlobalAdvertiserTarget(targetCode, { force: true, reloadWork: false });"));
});

test("locked owner assistant binding stays free of the new picker glue", () => {
  for (const marker of ["data-mi-target-select", "applyGlobalAdvertiserTarget", "renderGlobalAdvertiserPicker"]) {
    assert.ok(!ownerAssistantSource.includes(marker), `bindOwnerAssistant must not carry ${marker}`);
  }
});

// ── 순위 조회 범위 계약 ──────────────────────────────────────────
// 문자열 대조가 아니라 admin.html 원본에서 함수를 그대로 떼어 내 실행한다.
// 화면은 대표 코드를 알지 못한다: "총관리자 내부"는 자리표시자만 보내고,
// 서버가 대표 코드로 풀어 되돌려 준 응답을 그대로 받아들여야 한다.
const PAGE_FUNCTION_CLOSE = "\n      }";

function pageFunction(name) {
  const marker = `\n      function ${name}(`;
  const from = source.indexOf(marker);
  assert.ok(from >= 0, `page function not found: ${name}`);
  const to = source.indexOf(PAGE_FUNCTION_CLOSE + "\n", from);
  assert.ok(to > from, `page function end not found: ${name}`);
  return source.slice(from + 1, to + PAGE_FUNCTION_CLOSE.length);
}

function rankScopeSandbox(options) {
  const settings = options || {};
  const context = {
    root: {
      classList: { contains: (name) => Boolean(settings.locked) && name === "is-locked" },
      querySelector: (selector) => (selector === "[data-admin-code]" ? { value: settings.publicCode || "" } : null),
    },
    secureSession: Object.assign({ role: "", scopeKey: "", clientId: "", teamId: "" }, settings.session || {}),
    primaryAgencyCode: Object.prototype.hasOwnProperty.call(settings, "primaryAgencyCode")
      ? settings.primaryAgencyCode
      : "owner-session",
    ownerCodeSnapshot: settings.ownerCodeSnapshot || null,
    currentOperationTeam: settings.operationTeam || null,
  };
  vm.createContext(context);
  vm.runInContext([
    pageFunction("normalizeStorageCode"),
    pageFunction("isOwnerScopePlaceholder"),
    pageFunction("operationTeamClientCode"),
    pageFunction("ownerTargetAgencyCode"),
    pageFunction("currentPublicCode"),
    pageFunction("ownerTargetClientId"),
    pageFunction("rankAgencyCode"),
    pageFunction("verifiedRankTrackerScope"),
    pageFunction("scopedRankTrackerPayload"),
    // readState 는 저장소 접근만 감싸므로 코드 계산 경로만 그대로 재현한다.
    "function readState() { return { code: currentPublicCode() }; }",
  ].join("\n\n"), context);
  return context;
}

function scopeSnapshot(options) {
  const scope = rankScopeSandbox(options).verifiedRankTrackerScope();
  return scope === null ? null : JSON.parse(JSON.stringify(scope));
}

function trackerPayload(scopeAgencyCode) {
  return { ok: true, trackers: [{ id: "tracker-1" }], returnedCount: 1, scopeAgencyCode: scopeAgencyCode };
}

const OWNER_INTERNAL_SCOPE = {
  key: "owner-internal",
  role: "owner",
  agencyCode: "owner-session",
  clientId: "",
};

test("총관리자 내부 범위는 자리표시자 코드를 가진 정식 순위 범위다", () => {
  // 활성 계정 목록을 받기 전: 공개 코드 입력은 아직 자리표시자다.
  assert.deepEqual(
    scopeSnapshot({ session: { role: "owner", scopeKey: "owner" }, publicCode: "owner-session" }),
    OWNER_INTERNAL_SCOPE,
  );
  // 활성 계정 목록을 받은 뒤: 입력은 대표 코드지만 화면 밖으로는 자리표시자만 나간다.
  assert.deepEqual(
    scopeSnapshot({
      session: { role: "owner", scopeKey: "owner" },
      publicCode: "mml93-a01",
      primaryAgencyCode: "mml93-a01",
    }),
    OWNER_INTERNAL_SCOPE,
  );
  // 대표 코드는 페이지 원본 어디에도 박혀 있지 않다.
  assert.ok(!source.includes("mml93-a01"));
});

test("광고주를 고른 총관리자 범위와 운영팀 범위는 그대로다", () => {
  assert.deepEqual(
    scopeSnapshot({
      session: { role: "owner", scopeKey: "owner" },
      publicCode: "hadn-a02",
      primaryAgencyCode: "mml93-a01",
      ownerCodeSnapshot: { clients: [{ id: "client-hadn", agencyCode: "hadn-a02" }] },
    }),
    { key: "owner:hadn-a02", role: "owner", agencyCode: "hadn-a02", clientId: "" },
  );
  // 활성 계정 목록에 없는 코드는 여전히 조회 범위로 인정하지 않는다.
  assert.equal(
    scopeSnapshot({
      session: { role: "owner", scopeKey: "owner" },
      publicCode: "unknown-a09",
      primaryAgencyCode: "mml93-a01",
      ownerCodeSnapshot: { clients: [{ id: "client-hadn", agencyCode: "hadn-a02" }] },
    }),
    null,
  );
  // 운영팀은 손대지 않았다.
  assert.deepEqual(
    scopeSnapshot({ session: { role: "team", teamId: "team-7", clientId: "client-9" } }),
    { key: "team:client-9", role: "team", agencyCode: "", clientId: "client-9", accountOnly: false },
  );
  assert.deepEqual(
    scopeSnapshot({ session: { role: "team", teamId: "team-7" } }),
    { key: "team-account:team-7", role: "team", agencyCode: "", clientId: "", accountOnly: true },
  );
  // 잠긴 화면은 어떤 역할이든 범위를 만들지 않는다.
  assert.equal(scopeSnapshot({ session: { role: "owner" }, publicCode: "hadn-a02", locked: true }), null);
});

test("서버가 대표 코드로 풀어 되돌려 준 내부 범위 응답을 받아들인다", () => {
  const unresolved = rankScopeSandbox({ session: { role: "owner", scopeKey: "owner" }, publicCode: "owner-session" });
  const internalScope = unresolved.verifiedRankTrackerScope();
  // 요청은 owner-session, 응답은 대표 코드 — 이 어긋남 때문에 내부 범위가 0건으로 보였다.
  assert.equal(unresolved.scopedRankTrackerPayload(trackerPayload("mml93-a01"), internalScope), true);
  assert.equal(unresolved.scopedRankTrackerPayload(trackerPayload(""), internalScope), false);

  // 대표 코드를 이미 받아 둔 화면은 그 값과 정확히 대조한다.
  const resolved = rankScopeSandbox({
    session: { role: "owner", scopeKey: "owner" },
    publicCode: "mml93-a01",
    primaryAgencyCode: "mml93-a01",
  });
  const resolvedInternalScope = resolved.verifiedRankTrackerScope();
  assert.equal(resolved.scopedRankTrackerPayload(trackerPayload("mml93-a01"), resolvedInternalScope), true);
  assert.equal(resolved.scopedRankTrackerPayload(trackerPayload("hadn-a02"), resolvedInternalScope), false);

  // 광고주를 고른 범위는 예전 그대로 정확 일치만 인정한다.
  const advertiser = rankScopeSandbox({
    session: { role: "owner", scopeKey: "owner" },
    publicCode: "hadn-a02",
    primaryAgencyCode: "mml93-a01",
    ownerCodeSnapshot: { clients: [{ id: "client-hadn", agencyCode: "hadn-a02" }] },
  });
  const advertiserScope = advertiser.verifiedRankTrackerScope();
  assert.equal(advertiser.scopedRankTrackerPayload(trackerPayload("hadn-a02"), advertiserScope), true);
  assert.equal(advertiser.scopedRankTrackerPayload(trackerPayload("mml93-a01"), advertiserScope), false);
});

test("N 30일과 N 플레이스 30일이 같은 범위 계약을 쓴다", () => {
  const productLoad = block("async function loadRankTrackers(silent) {", "async function refreshAllRankTrackers(refreshAllButton) {");
  const placeLoad = block("async function loadPlaceTrackers(silent) {", "function syncPlaceKeywordFromMain() {");
  for (const [name, loadSource] of [["product", productLoad], ["place", placeLoad]]) {
    assert.ok(loadSource.includes("completeRankTrackerPayload(payload, scope)"), `${name} load lost the scope guard`);
  }
  assert.ok(block("async function requestRankTrackers(method, body, expectedScope) {", "async function runRankWorkerControl(")
    .includes('"x-mi-agency-code": agencyCode'));
  assert.ok(block("async function requestPlaceTrackers(method, body, expectedScope) {", "function activatePlaceTrackerScope() {")
    .includes('"x-mi-agency-code": agencyCode'));
});

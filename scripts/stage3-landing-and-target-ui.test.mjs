import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

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
const statusBoardMarkup = block('<section class="mi-ops-status-board"', "</section>");
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
  assert.ok(source.includes('data-mi-admin-screen="home">운영 홈</a>'));
});

test("team session lands on the operations home summary regardless of client linkage", () => {
  assert.ok(activateSessionSource.includes('setScreen(personalCalendarNoticePending() ? "my-calendar" : "home", !restored);'));
  assert.ok(!activateSessionSource.includes('teamHasClient ? "agency-code" : "home"'));
});

test("the operations home leads with a five card 지금 상황 summary and keeps the quick links", () => {
  assert.ok(statusBoardMarkup.includes("<strong>지금 상황</strong>"));
  for (const hook of ["client", "sales", "report", "schedule", "rank"]) {
    assert.ok(statusBoardMarkup.includes(`data-ops-home-${hook}-state`), `missing card: ${hook}`);
    assert.ok(statusBoardMarkup.includes(`data-ops-home-${hook}-title`), `missing card title: ${hook}`);
    assert.ok(statusBoardMarkup.includes(`data-ops-home-${hook}-detail`), `missing card detail: ${hook}`);
  }
  // 요약이 먼저, 기존 빠른 실행은 그대로 아래에 남는다.
  assert.ok(source.indexOf('class="mi-ops-status-board"') < source.indexOf('class="mi-ops-quick-grid"'));
  assert.ok(source.includes('class="mi-ops-quick-grid" data-admin-home-truthful-state'));
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

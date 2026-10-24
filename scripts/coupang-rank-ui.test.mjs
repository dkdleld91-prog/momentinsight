// C 30일 순위(쿠팡) 관리자 화면 계약 테스트 — 명세 v3 §8.9(WP5).
// - admin.html 구조(메뉴·구역·CSS/JS 링크·연결 코드·setScreen 네 군데)
// - 세션 전 해시 유지(P6): setScreen 조각과 연결 코드를 node:vm 에 올려 확인
// - 금지 패턴(N30 속성 이름·innerHTML·인라인 이벤트·16진 색)
// - 잠긴 함수 해시가 그대로인지
// - 모듈 internals(칸 문구·툴팁·배지·추세·다음 예정·필터·범위 검증·파일명·캐시 키·용량 경고)
// - 화면 흐름(가짜 DOM): 목록·캐시·부분 목록·총관리자 머리글·삭제 확인·잠금 reset·선택 이미지 저장
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  ATTENTION_REASONS,
  BULK_IDS_MAX,
  COLLECTOR_STATES,
  COUPANG_TRACKERS_PATH,
  DAY_RESULTS,
  DEFAULT_GROUP,
  GROUP_MAX,
  KEYWORD_MAX,
  RANK_TOP,
  TRACKER_LIST_MAX,
} from "../src/server/coupang-rank/contract.mjs";
// ① 지금 확인 서버 계약 상수(spec-manual §6.1)는 서버 담당이 더한다. 있으면 화면 문구가 모두 덮는지 본다.
import * as contract from "../src/server/coupang-rank/contract.mjs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const adminSource = read("src/pages/admin.html");
const moduleSource = read("public/mi-coupang-rank.js");
const cssSource = read("public/mi-coupang-rank.css");

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/gu;
// 대표 결정 2026-10-23: '순위 조회·추적' 묶음, '(개발중)' 표시 없음, 총관리자만(세션 전에는 hidden).
const NAV_LINK = '<a href="#mi-admin-coupang-rank-tracking" data-mi-admin-screen="coupang-rank-tracking" data-coupang-rank-nav hidden>C 30일 순위</a>';
const PLACE_LINK = '<a href="#mi-admin-naver-place-rank-tracking" data-mi-admin-screen="naver-place-rank-tracking">N 플레이스 30일 순위</a>';
const SECTION_OPEN = '<section class="mi-view" data-mi-admin-view="coupang-rank-tracking" id="mi-admin-coupang-rank-tracking">';
// 캐시 꼬리표: ① 지금 확인(spec-manual §7.9)으로 c30-v2 → c30-v3, 화면 디테일 고도화(대표 승인 2026-10-23)로 c30-v3 → c30-v4,
// '전체 확인'(대표 승인 2026-10-24)으로 c30-v4 → c30-v5.
// CSS·JS 를 함께 바꾸므로 두 꼬리표를 같이 올린다(새 JS + 옛 CSS 가 섞이지 않게).
const CSS_LINK = '<link rel="stylesheet" href="/mi-coupang-rank.css?v=c30-v5" />';
const SCRIPT_TAG = '<script src="/mi-coupang-rank.js?v=c30-v5"></script>';
const GLUE_START = "      var coupangRankController = null;";
const GLUE_END = "      var personalCalendarController = null;";

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `시작 표식이 없습니다: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `끝 표식이 없습니다: ${end}`);
  return source.slice(from, to);
}

// check-protected-rank-features.mjs 의 함수 블록 추출 규칙과 같다(문자열·주석 안 괄호 무시).
function functionBlock(source, name) {
  const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`함수를 찾을 수 없습니다: ${name}`);
  const open = source.indexOf("{", match.index);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`함수 끝을 찾을 수 없습니다: ${name}`);
}

const glueSource = between(adminSource, GLUE_START, GLUE_END);
const setScreenSource = functionBlock(adminSource, "setScreen");
const sectionSource = between(adminSource, SECTION_OPEN, "</section>");

// ── admin.html 구조 ─────────────────────────────────────────────

test("C30 메뉴는 '순위 조회·추적'의 N 플레이스 다음에 hidden 으로 하나만 있고, 실험실에는 없다(대표 결정 2026-10-23)", () => {
  assert.equal(adminSource.split(NAV_LINK).length - 1, 1);
  assert.equal((adminSource.match(/<a\b[^>]*\bdata-coupang-rank-nav(?:\s|>)/gu) || []).length, 1);
  const lab = between(adminSource, '<div class="mi-nav-lab-items" id="mi-admin-nav-lab">', "</div>");
  assert.doesNotMatch(lab, /coupang-rank-tracking|data-coupang-rank-nav/u);
  assert.ok(adminSource.includes('data-mi-nav-lab-toggle aria-expanded="false" aria-controls="mi-admin-nav-lab"'));
  const rankGroup = adminSource.match(/<div class="mi-nav-group">\s*<p class="mi-nav-title">순위 조회·추적<\/p>([\s\S]*?)<\/div>/u)?.[1] || "";
  assert.deepEqual(rankGroup.match(/<a\b[^>]*>[\s\S]*?<\/a>/gu), [
    '<a href="#mi-admin-naver-rank-tracking" data-mi-admin-screen="naver-rank-tracking">N 30일 순위</a>',
    PLACE_LINK,
    NAV_LINK
  ]);
  assert.doesNotMatch(NAV_LINK, /개발중/u);
  // #mi-admin .mi-nav a 는 display:flex 라 [hidden] 규칙이 따로 있어야 숨겨진다.
  assert.ok(adminSource.includes("#mi-admin .mi-nav a[hidden]"));
});

test("구역은 플레이스 구역 뒤·meta-ads 앞에 있고 data-coupang-rank-root 는 1개다", () => {
  const placeAt = adminSource.indexOf('data-mi-admin-view="naver-place-rank-tracking"');
  const sectionAt = adminSource.indexOf(SECTION_OPEN);
  const metaAt = adminSource.indexOf('<section class="mi-view" data-mi-admin-view="meta-ads"');
  assert.ok(placeAt > 0 && sectionAt > placeAt && metaAt > sectionAt);
  // 플레이스 구역을 닫은 바로 다음이 C 구역이다.
  assert.ok(adminSource.includes(`        </section>\n\n        ${SECTION_OPEN}`));
  assert.equal((adminSource.match(/<div data-coupang-rank-root><\/div>/g) || []).length, 1);
  assert.equal((adminSource.match(/data-coupang-rank-root/g) || []).length, 2, "마크업 1 + 연결 코드 셀렉터 1");
  // 화면 머리는 한 겹(kicker · h1 · 한 문장 + 오른쪽 대상 알약). '관리자 확인용' 배지와 큰 카드 머리는 없다(C30 만, 대표 결정 2026-10-23).
  assert.ok(sectionSource.includes('<header class="mi-head mi-coupang-rank-screen-head"><div>'));
  assert.ok(sectionSource.includes("<h1>쿠팡 검색 일반 순위를 30일 기록합니다.</h1>"));
  // 머리 문장은 기록 방식(지금 확인·자동 수집)을 단정하지 않는다 — 지금 방식은 상태판이 말한다(2026-10-23 재검사).
  assert.ok(sectionSource.includes("<p>쿠팡 검색 1쪽(로그인 안 한 상태)에서 광고를 뺀 일반 상품 순위를 하루 단위로 그날 칸에 기록합니다.</p>"));
  assert.doesNotMatch(sectionSource, /누를 때만/u);
  // 대상 알약 문구·마크업은 공용 스크립트 그대로(N30·N 플레이스와 같은 '대상 광고주 · …'), 자리만 오른쪽(배지 자리)으로 옮겼다.
  assert.ok(sectionSource.includes('</div><span class="mi-target-echo" data-mi-target-echo>대상 광고주 확인 중</span></header>'));
  assert.doesNotMatch(sectionSource, /관리자 확인용|mi-badge|수집기 PC가 켜져 있을 때만 잽니다/u);
  // N30 화면 머리는 그대로다(C30 만 바꾼다).
  const n30Head = between(adminSource, '<section class="mi-view" data-mi-admin-view="naver-rank-tracking" id="mi-admin-naver-rank-tracking">', "</header>");
  assert.ok(n30Head.includes('<span class="mi-badge">관리자 확인용</span>'));
  assert.ok(n30Head.includes('<span class="mi-target-echo" data-mi-target-echo>대상 광고주 확인 중</span>'));
});

test("CSS 는 캘린더 CSS 다음, 스크립트는 defer 없이 /mi-capture.js 앞에 있다", () => {
  assert.ok(adminSource.includes(`<link rel="stylesheet" href="/mi-personal-calendar.css?v=cal-v7-20260827" />\n${CSS_LINK}\n`));
  assert.equal(adminSource.split(SCRIPT_TAG).length - 1, 1);
  const scriptAt = adminSource.indexOf(SCRIPT_TAG);
  const nudgeAt = adminSource.indexOf('<script src="/mi-google-nudge.js');
  const captureAt = adminSource.indexOf('<script src="/mi-capture.js');
  assert.ok(nudgeAt > 0 && scriptAt > nudgeAt && captureAt > scriptAt);
  assert.doesNotMatch(SCRIPT_TAG, /defer|async/);
  // 인라인 스크립트(세션·setScreen)보다 먼저 읽혀야 mount 가 window.MomentCoupangRank 를 찾는다.
  assert.ok(scriptAt < adminSource.indexOf("<script>\n    (function () {"));
});

test("연결 코드는 var personalCalendarController = null; 바로 앞에 있고 허용된 인라인 함수만 부른다", () => {
  assert.ok(adminSource.includes(`      });\n\n${GLUE_END}\n`));
  assert.ok(adminSource.indexOf(GLUE_START) < adminSource.indexOf(GLUE_END));
  assert.ok(adminSource.indexOf(GLUE_END) - adminSource.indexOf(GLUE_START) < 4000);
  for (const name of ["miFetch", "verifiedRankTrackerScope", "isOwnerScopePlaceholder", "normalizeStorageCode", "ensureRankExportStage",
    "serializeRankExportSheet", "rankExportImageBlob", "showRankDownloadReady", "primaryAgencyCode"]) {
    assert.ok(glueSource.includes(name), `${name} 을 넘겨야 합니다`);
  }
  for (const forbidden of ["requestRankTrackers", "scopedRankTrackerPayload", "renderTrackerDailyBoard", "groupRankSnapshotsByDay", "renderRankHistory",
    "renderRankTrackerCard", "renderRankBulkBar", "updateRankFilterPanel", "renderRankExportSheet", "initRankTracking", "initPlaceRankTracking", "resetAdminAsyncControls"]) {
    assert.ok(!glueSource.includes(forbidden), `N30 함수 ${forbidden} 를 부르면 안 됩니다`);
  }
  assert.ok(glueSource.includes('window.addEventListener("mi:rank-auth-ready", syncCoupangRankAccess);'));
  assert.ok(glueSource.includes('mode: "admin",'));
  // 총관리자 전용(대표 결정 2026-10-23): 메뉴는 역할만 보고, 운영팀 공개 여부를 서버에 묻지 않는다.
  assert.equal(functionBlock(glueSource, "coupangRankMenuVisible").replace(/\s+/g, " "), 'function coupangRankMenuVisible() { return secureSession.role === "owner"; }');
  for (const removed of ["view=access", "coupangRankOpen", "coupangRankAccessSeq", "refreshCoupangRankAccess", '"team"', '"client"']) {
    assert.ok(!glueSource.includes(removed), `${removed} 가 남아 있습니다`);
  }
});

test("setScreen 에 rejectedCoupangTarget 3곳과 mount 1줄이 있다", () => {
  assert.ok(setScreenSource.includes('var rejectedCoupangTarget = target === "coupang-rank-tracking" && Boolean(secureSession.role) && !coupangRankMenuVisible();'));
  assert.ok(setScreenSource.includes('if (rejectedNoticeTarget) target = "home";\n        if (rejectedCoupangTarget) target = "home";'));
  assert.ok(setScreenSource.includes("((rejectedOwnerTarget || hasOwnerHashWithoutOwner || rejectedCoupangTarget || hasCoupangHashWithoutOwner) && secureSession.role)"));
  assert.equal((setScreenSource.match(/rejectedCoupangTarget/g) || []).length, 3);
  // 새로고침으로 C 주소를 연 운영팀 세션: 홈으로 올 때 남은 C 해시도 홈으로 바꾼다.
  assert.ok(setScreenSource.includes('var hasCoupangHashWithoutOwner = Boolean(secureSession.role) && !coupangRankMenuVisible() && window.location.hash === "#mi-admin-coupang-rank-tracking";'));
  assert.equal((setScreenSource.match(/hasCoupangHashWithoutOwner/g) || []).length, 2);
  assert.ok(setScreenSource.includes('else unmountPersonalCalendar();\n        if (target === "coupang-rank-tracking") mountCoupangRank();'));
  // 정의는 rejectedNoticeTarget 다음 줄 묶음 안에 있다.
  assert.ok(setScreenSource.indexOf("var rejectedCoupangTarget") > setScreenSource.indexOf("var rejectedNoticeTarget"));
});

test("세션 적용 직후(첫 await 전)와 로그아웃에서 C 메뉴·화면을 역할에 맞춘다", () => {
  // 줄 주석은 빼고 본다(주석 안의 'await' 낱말을 실제 await 로 세지 않는다).
  const activate = functionBlock(adminSource, "activateAdminSession").replace(/^\s*\/\/.*$/gmu, "");
  const applied = activate.indexOf("applySecureSession(payload);");
  const coupang = activate.indexOf("applyCoupangRankSession();");
  assert.ok(applied >= 0 && coupang > applied, "세션을 적용한 뒤에 부른다");
  assert.equal(activate.split("applyCoupangRankSession();").length - 1, 1);
  // 운영팀 분기의 await(광고주 자료 받기) 동안 C 머리글이 보이지 않도록 첫 await 보다 먼저 부른다.
  assert.ok(activate.indexOf("await ") > coupang, "첫 await 전에 불러야 합니다");
  const logout = functionBlock(adminSource, "logoutAdmin");
  const cleared = logout.indexOf("clearAdminAuthCode();");
  const discarded = logout.indexOf("discardCoupangRank();\n        syncCoupangRankMenu();");
  assert.ok(cleared >= 0 && discarded > cleared, "역할을 비운 뒤 C 화면·캐시를 지우고 메뉴를 숨긴다");
  assert.ok(discarded < logout.indexOf('root.classList.add("is-locked");'));
});

// ── 세션 전 해시 유지(P6) ────────────────────────────────────────

function classListFor(names) {
  const set = new Set(names);
  return {
    add: (name) => set.add(name),
    remove: (...items) => items.forEach((name) => set.delete(name)),
    toggle: (name, force) => {
      const want = force === undefined ? !set.has(name) : Boolean(force);
      if (want) set.add(name);
      else set.delete(name);
      return want;
    },
    contains: (name) => set.has(name),
  };
}

function screenHarness({ role = "", hash = "#mi-admin-coupang-rank-tracking", accessPayload = { ok: true, open: false } } = {}) {
  const names = ["home", "naver-place-rank-tracking", "coupang-rank-tracking", "meta-ads", "my-calendar", "agency-code"];
  const views = names.map((name) => ({ name, classList: classListFor([]), getAttribute: () => name }));
  const links = names.map((name) => ({ name, classList: classListFor([]), getAttribute: () => name, setAttribute() {}, removeAttribute() {} }));
  const navLink = { hidden: true };
  const host = { id: "host" };
  const replaceCalls = [];
  const mounts = [];
  const shows = [];
  const destroys = [];
  const listeners = {};
  const fetchCalls = [];
  const root = {
    classList: classListFor([]),
    querySelectorAll(selector) {
      if (selector === "[data-mi-admin-view]") return views;
      if (selector === "[data-mi-admin-screen]") return links;
      throw new Error(`예상하지 못한 셀렉터: ${selector}`);
    },
    querySelector(selector) {
      if (selector === "a[data-coupang-rank-nav]") return navLink;
      if (selector === '[data-mi-admin-view="coupang-rank-tracking"]') return views.find((view) => view.name === "coupang-rank-tracking");
      if (selector === "[data-coupang-rank-root]") return host;
      return null;
    },
  };
  const window = {
    location: { hash, pathname: "/admin", search: "", protocol: "https:" },
    // 실제 브라우저처럼 replaceState 는 주소창 해시를 바꾼다(hashchange 는 없다).
    history: {
      replaceState: (...args) => {
        replaceCalls.push(args);
        const at = String(args[2] || "").indexOf("#");
        window.location.hash = at >= 0 ? String(args[2]).slice(at) : "";
      },
    },
    requestAnimationFrame: (fn) => fn(),
    scrollTo() {},
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    MomentCoupangRank: {
      mount(mountHost, deps) {
        mounts.push({ host: mountHost, deps });
        return { show: () => shows.push(true), scopeChanged() {}, destroy: () => destroys.push(mountHost) };
      },
    },
  };
  const context = vm.createContext({
    window,
    root,
    secureSession: { role },
    Boolean,
    Promise,
    miFetch: (url, options) => {
      fetchCalls.push({ url, options });
      return Promise.resolve({ json: () => Promise.resolve(accessPayload) });
    },
    verifiedRankTrackerScope: () => ({ key: "owner-internal", role: "owner", agencyCode: "owner-session", clientId: "" }),
    isOwnerScopePlaceholder: () => true,
    normalizeStorageCode: (value) => String(value || "").trim().toLowerCase(),
    primaryAgencyCode: "owner-session",
    ensureRankExportStage() {},
    serializeRankExportSheet() {},
    rankExportImageBlob() {},
    showRankDownloadReady() {},
    personalCalendarEnabled: () => false,
    workScreenEnabled: () => true,
    isWorkSectionEmbedded: () => false,
    ownerToolScreens: [],
    deactivateWorkOperation() {},
    mountPersonalCalendar() {},
    unmountPersonalCalendar() {},
    refreshOperationHomeStatus() {},
    maybeLoadOperationHistory() {},
    maybeLoadAdminKpiTarget() {},
    loadSiteNoticeEditor() {},
    refreshAdminClientPreview: () => Promise.resolve(),
    loadWorkItems() {},
    maybeSyncGoogleCalendar: () => Promise.resolve(),
    ownerAssistantOfficeController: null,
    openNavLabForScreen() {},
    scrollToActiveAccounts() {},
  });
  vm.runInContext(`${glueSource}\n${setScreenSource}\n`, context, { filename: "admin-coupang-glue.js" });
  const active = () => views.filter((view) => view.classList.contains("is-active")).map((view) => view.name);
  return { context, views, navLink, replaceCalls, mounts, shows, destroys, listeners, fetchCalls, window, active };
}

const flushMicrotasks = async () => {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("세션 전(role 없음) setScreen 은 C 해시를 지우지 않고 C 화면을 연다(P6)", () => {
  const harness = screenHarness({ role: "" });
  harness.context.setScreen("coupang-rank-tracking", false);
  assert.deepEqual(harness.replaceCalls, [], "세션 전에는 해시를 바꾸지 않습니다");
  assert.deepEqual(harness.active(), ["coupang-rank-tracking"]);
  assert.equal(harness.mounts.length, 0, "세션 전에는 모듈을 붙이지 않습니다");
});

test("세션 확인 뒤 총관리자면 syncCoupangRankScreen 이 모듈을 붙인다", () => {
  const harness = screenHarness({ role: "" });
  harness.context.setScreen("coupang-rank-tracking", false);
  harness.context.secureSession.role = "owner";
  harness.context.syncCoupangRankScreen();
  assert.equal(harness.mounts.length, 1);
  assert.equal(harness.shows.length, 1);
  const deps = harness.mounts[0].deps;
  assert.equal(deps.mode, "admin");
  assert.equal(typeof deps.fetch, "function");
  assert.deepEqual(Object.keys(deps.exportTools).sort(), ["ensureStage", "serialize", "showReady", "toBlob"]);
  assert.equal(deps.isOwner(), true);
  assert.equal(deps.ownerPrimaryCode(), "owner-session");
  // mi:rank-auth-ready 리스너가 접근 확인을 부른다. 총관리자는 요청 없이 메뉴를 연다.
  assert.equal(harness.listeners["mi:rank-auth-ready"].length, 1);
  harness.listeners["mi:rank-auth-ready"][0]();
  assert.equal(harness.navLink.hidden, false);
  assert.equal(harness.fetchCalls.length, 0);
  assert.deepEqual(harness.active(), ["coupang-rank-tracking"]);
});

for (const accessPayload of [{ ok: true, open: false }, { ok: true, open: true }]) {
  test(`운영팀 세션은 서버 공개 값(open:${accessPayload.open})과 상관없이 메뉴가 숨고 C 화면은 홈으로 간다(서버에 묻지 않음)`, async () => {
    const harness = screenHarness({ role: "", accessPayload });
    harness.context.setScreen("coupang-rank-tracking", false);
    harness.context.secureSession.role = "team";
    harness.listeners["mi:rank-auth-ready"][0]();
    await flushMicrotasks();
    assert.equal(harness.fetchCalls.length, 0, "view=access 를 부르지 않는다");
    assert.equal(harness.navLink.hidden, true);
    assert.deepEqual(harness.active(), ["home"]);
    assert.equal(harness.mounts.length, 0);
    // 남은 C 해시(새로고침·새 탭으로 연 주소)도 홈으로 바뀐다.
    assert.deepEqual(harness.replaceCalls.map((call) => call[2]), ["/admin#mi-admin-home"]);
    assert.equal(harness.window.location.hash, "#mi-admin-home");
    // 세션이 있는 상태에서 C 해시로 직접 들어오면(hashchange) 거절되고 주소창도 홈으로 바뀐다.
    harness.window.location.hash = "#mi-admin-coupang-rank-tracking";
    harness.context.setScreen("coupang-rank-tracking", false);
    assert.deepEqual(harness.active(), ["home"]);
    assert.equal(harness.replaceCalls.length, 2);
    assert.equal(harness.replaceCalls[1][2], "/admin#mi-admin-home");
    assert.equal(harness.window.location.hash, "#mi-admin-home");
    // 메뉴를 눌러도(해시 기록) 홈으로 간다.
    harness.context.setScreen("coupang-rank-tracking", true);
    assert.deepEqual(harness.active(), ["home"]);
    assert.equal(harness.window.location.hash, "#mi-admin-home");
    assert.equal(harness.mounts.length, 0);
    assert.equal(harness.fetchCalls.length, 0);
  });
}

// activateAdminSession 순서 그대로: 첫 setScreen(세션 전) → 세션 적용 → applyCoupangRankSession(첫 await 전)
// → 착지 setScreen("home", !restored) → mi:rank-auth-ready.
test("운영팀이 C 주소로 새로고침하면 첫 await 전에 화면·주소창이 홈이 되고 메뉴는 숨는다", async () => {
  const harness = screenHarness({ role: "" });
  harness.context.setScreen("coupang-rank-tracking", false);
  assert.deepEqual(harness.active(), ["coupang-rank-tracking"], "세션 전에는 해시를 남긴다(P6)");
  harness.context.secureSession.role = "team";
  harness.context.applyCoupangRankSession();
  assert.deepEqual(harness.active(), ["home"], "광고주 자료를 기다리는 동안 C 구역이 열려 있지 않다");
  assert.equal(harness.window.location.hash, "#mi-admin-home");
  assert.deepEqual(harness.replaceCalls.map((call) => call[2]), ["/admin#mi-admin-home"]);
  assert.equal(harness.navLink.hidden, true);
  harness.context.setScreen("home", false);
  harness.listeners["mi:rank-auth-ready"][0]();
  await flushMicrotasks();
  assert.deepEqual(harness.active(), ["home"]);
  assert.equal(harness.window.location.hash, "#mi-admin-home");
  assert.equal(harness.replaceCalls.length, 1, "이미 홈 해시라 다시 바꾸지 않는다");
  assert.equal(harness.mounts.length, 0);
  assert.equal(harness.fetchCalls.length, 0);
});

test("applyCoupangRankSession 없이도 운영팀 착지 setScreen(\"home\", false) 가 남은 C 해시를 홈으로 바꾼다", () => {
  const harness = screenHarness({ role: "" });
  harness.context.setScreen("coupang-rank-tracking", false);
  harness.context.secureSession.role = "team";
  harness.context.setScreen("home", false);
  assert.deepEqual(harness.active(), ["home"]);
  assert.deepEqual(harness.replaceCalls.map((call) => call[2]), ["/admin#mi-admin-home"]);
  assert.equal(harness.window.location.hash, "#mi-admin-home");
});

test("총관리자는 세션 적용 직후 메뉴만 열고(붙이기는 auth-ready), C 해시를 그대로 둔다", () => {
  const harness = screenHarness({ role: "" });
  harness.context.setScreen("coupang-rank-tracking", false);
  harness.context.secureSession.role = "owner";
  harness.context.applyCoupangRankSession();
  assert.equal(harness.navLink.hidden, false);
  assert.equal(harness.mounts.length, 0, "범위 확인(loadOwnerCodes) 전에는 붙이지 않는다");
  assert.deepEqual(harness.active(), ["coupang-rank-tracking"]);
  assert.deepEqual(harness.replaceCalls, []);
  harness.listeners["mi:rank-auth-ready"][0]();
  assert.equal(harness.mounts.length, 1);
  assert.deepEqual(harness.replaceCalls, []);
  assert.equal(harness.window.location.hash, "#mi-admin-coupang-rank-tracking");
});

test("총관리자 로그아웃 → 같은 탭 운영팀 로그인: 로그아웃 때 C 화면·캐시를 지우고 메뉴를 숨겨 운영팀 세션 확인 전에도 보이지 않는다", () => {
  const harness = screenHarness({ role: "owner" });
  harness.context.setScreen("coupang-rank-tracking", false);
  harness.listeners["mi:rank-auth-ready"][0]();
  assert.equal(harness.navLink.hidden, false);
  assert.equal(harness.mounts.length, 1);
  // logoutAdmin: clearAdminAuthCode(역할 비움) → discardCoupangRank → syncCoupangRankMenu → setScreen("home")
  harness.context.secureSession.role = "";
  harness.context.discardCoupangRank();
  harness.context.syncCoupangRankMenu();
  harness.context.setScreen("home", false);
  assert.equal(harness.destroys.length, 1, "총관리자 목록·캐시를 지운다(destroy → reset → pruneCache)");
  assert.equal(harness.navLink.hidden, true);
  harness.context.discardCoupangRank();
  assert.equal(harness.destroys.length, 1, "두 번 지우지 않는다");
  // 운영팀 로그인: 세션 적용 직후(auth-ready 전) 메뉴는 이미 숨어 있고 붙지 않는다.
  harness.context.secureSession.role = "team";
  harness.context.applyCoupangRankSession();
  assert.equal(harness.navLink.hidden, true);
  harness.context.setScreen("coupang-rank-tracking", true);
  assert.deepEqual(harness.active(), ["home"]);
  assert.equal(harness.mounts.length, 1);
  // 다시 총관리자로 로그인하면 새로 붙인다(지운 컨트롤러를 다시 쓰지 않는다).
  harness.context.secureSession.role = "owner";
  harness.context.applyCoupangRankSession();
  harness.context.setScreen("coupang-rank-tracking", true);
  assert.equal(harness.mounts.length, 2);
  assert.deepEqual(harness.active(), ["coupang-rank-tracking"]);
});

test("로그아웃 없이 총관리자 → 운영팀 세션이 적용돼도 총관리자 때 붙은 C 화면을 지운다", () => {
  const harness = screenHarness({ role: "owner" });
  harness.context.setScreen("coupang-rank-tracking", false);
  harness.listeners["mi:rank-auth-ready"][0]();
  assert.equal(harness.mounts.length, 1);
  harness.context.secureSession.role = "team";
  harness.context.applyCoupangRankSession();
  assert.equal(harness.destroys.length, 1);
  assert.equal(harness.navLink.hidden, true);
  assert.deepEqual(harness.active(), ["home"]);
  assert.equal(harness.window.location.hash, "#mi-admin-home");
});

test("총관리자 세션에서 운영팀 세션으로 바뀌면 메뉴가 다시 숨는다", () => {
  const harness = screenHarness({ role: "owner", hash: "#mi-admin-home" });
  harness.listeners["mi:rank-auth-ready"][0]();
  assert.equal(harness.navLink.hidden, false);
  harness.context.secureSession.role = "team";
  harness.listeners["mi:rank-auth-ready"][0]();
  assert.equal(harness.navLink.hidden, true);
  harness.context.secureSession.role = "";
  harness.listeners["mi:rank-auth-ready"][0]();
  assert.equal(harness.navLink.hidden, true);
  assert.equal(harness.fetchCalls.length, 0);
});

// ── 금지 패턴 ─────────────────────────────────────────────────

test("C 구역·연결 코드·모듈·CSS 에 N30 속성 이름이 없다", () => {
  for (const [name, source] of [["구역", sectionSource], ["연결 코드", glueSource], ["모듈", moduleSource], ["CSS", cssSource]]) {
    assert.ok(!source.includes("data-rank-"), `${name}: data-rank- 가 있습니다`);
    assert.ok(!source.includes("data-place-rank-"), `${name}: data-place-rank- 가 있습니다`);
    assert.ok(!source.includes("data-rank-volume-id"), `${name}: data-rank-volume-id 가 있습니다`);
  }
  // 모듈이 만드는 속성은 data-coupang-rank-* 뿐이다.
  const dataAttributes = new Set([...moduleSource.matchAll(/["'](data-[a-z0-9-]+)["']/g)].map((match) => match[1]));
  for (const attribute of dataAttributes) assert.match(attribute, /^data-coupang-rank-/);
});

test("모듈에 innerHTML·인라인 이벤트 속성이 없고 전역은 MomentCoupangRank 하나다", () => {
  assert.ok(!moduleSource.includes("innerHTML"));
  assert.ok(!moduleSource.includes("outerHTML"));
  assert.ok(!moduleSource.includes("insertAdjacentHTML"));
  assert.doesNotMatch(moduleSource, /\bon[a-z]+=/);
  assert.doesNotMatch(moduleSource, /\.on[a-z]+\s*=(?!=)/);
  assert.doesNotMatch(moduleSource, /setAttribute\(\s*["']on/);
  assert.ok(moduleSource.includes('"use strict";'));
  const { window } = loadModule();
  assert.deepEqual(Object.keys(window).filter((key) => !BASE_WINDOW_KEYS.includes(key)), ["MomentCoupangRank"]);
  assert.deepEqual(Object.keys(window.MomentCoupangRank).sort(), ["internals", "mount"]);
});

test("CSS·JS 에 16진 색이 없고 색은 var(--mi-*) 토큰만 쓴다", () => {
  assert.deepEqual(moduleSource.match(HEX) || [], []);
  assert.deepEqual(cssSource.match(HEX) || [], []);
  assert.doesNotMatch(cssSource, /\b(?:rgba?|hsla?)\(/);
  assert.doesNotMatch(moduleSource, /\b(?:rgba?|hsla?)\(/);
  assert.deepEqual(sectionSource.match(HEX) || [], []);
  assert.deepEqual(glueSource.match(HEX) || [], []);
  const colorDeclarations = [...cssSource.matchAll(/(?:^|[;{\s])((?:background|color|border-color|accent-color|border(?:-top|-right|-bottom|-left)?))\s*:\s*([^;]+);/gm)];
  assert.ok(colorDeclarations.length > 20);
  for (const [, property, value] of colorDeclarations) {
    if (property.startsWith("border") && !property.endsWith("color") && !/var\(/.test(value)) {
      assert.match(value.trim(), /^(?:0|none)$/, `${property}: ${value}`);
      continue;
    }
    assert.match(value, /var\(--mi-[a-z0-9-]+\)|^\s*(?:transparent|inherit|currentColor|none|0)\s*$/, `${property}: ${value}`);
  }
  // 모듈의 인라인 style(내보내기 시트)도 토큰만 쓴다.
  const inlineCellSource = functionBlock(moduleSource, "inlineCell");
  assert.deepEqual([...inlineCellSource.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter((v) => /^var\(|^#|^rgb/.test(v)),
    ["var(--mi-navy)", "var(--mi-orange)", "var(--mi-muted)"]);
  for (const match of moduleSource.matchAll(/style: "([^"]+)"/g)) {
    for (const declaration of match[1].split(";").filter(Boolean)) {
      // "color:" + 변수 처럼 이어 붙인 값은 아래 inlineCell 검사에서 본다.
      if (/^(?:color|background|border)/.test(declaration) && /:./.test(declaration)) {
        assert.ok(/var\(--mi-/.test(declaration) || /^border-radius/.test(declaration), declaration);
      }
    }
  }
});

test("CSS 선택자는 #mi-admin .mi-coupang-rank-… 또는 #mi-clean .mi-coupang-rank-… 로만 시작한다", () => {
  const withoutComments = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [];
  const rulePattern = /([^{}]+)\{/g;
  let match;
  while ((match = rulePattern.exec(withoutComments))) {
    const head = match[1].trim();
    if (head.startsWith("@media")) continue;
    head.split(",").forEach((selector) => selectors.push(selector.trim()));
  }
  assert.ok(selectors.length > 100);
  for (const selector of selectors) assert.match(selector, /^#mi-(?:admin|clean) \.mi-coupang-rank-/, selector);
  const adminCount = selectors.filter((selector) => selector.startsWith("#mi-admin ")).length;
  const cleanCount = selectors.filter((selector) => selector.startsWith("#mi-clean ")).length;
  assert.equal(adminCount, cleanCount, "2b 용 #mi-clean 짝이 모두 있어야 합니다");
  assert.ok(cssSource.includes("@media (max-width: 720px)"));
});

test("휴대폰 폭(900px 이하)에서 카드 운영줄·현재/최고 알약은 줄을 바꿔 카드 밖으로 넘치지 않는다(대표 결정 2026-10-17)", () => {
  const withoutComments = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const phone = withoutComments.slice(withoutComments.indexOf("@media (max-width: 900px)"));
  const block = phone.slice(0, phone.indexOf("@media (max-width: 720px)"));
  const ruleStart = block.indexOf("#mi-admin .mi-coupang-rank-card .mi-rank-ops-row > span,");
  assert.ok(ruleStart > 0, "900px 규칙 안에 운영줄 알약 규칙이 있다");
  const rule = block.slice(ruleStart, block.indexOf("}", ruleStart));
  for (const selector of [".mi-rank-ops-row > span", ".mi-rank-ops-row > button", ".mi-rank-row-actions > .mi-rank-pill"]) {
    assert.ok(rule.includes(`#mi-admin .mi-coupang-rank-card ${selector}`) && rule.includes(`#mi-clean .mi-coupang-rank-card ${selector}`), selector);
  }
  for (const declaration of ["max-width: 100%;", "min-width: 0;", "white-space: normal;", "overflow-wrap: anywhere;"]) assert.ok(rule.includes(declaration), declaration);
});

// ── 잠긴 함수 ─────────────────────────────────────────────────

test("잠긴 함수 해시가 그대로다(check-protected-rank-features 의 함수 항목)", () => {
  const lock = JSON.parse(read("scripts/protected-rank-features.lock.json"));
  assert.ok(lock.functions.length >= 20);
  for (const entry of lock.functions) {
    const hash = crypto.createHash("sha256").update(functionBlock(read(entry.file), entry.name)).digest("hex");
    assert.equal(hash, entry.sha256, `${entry.id}: ${entry.file}#${entry.name}`);
  }
});

// ── 모듈(가짜 window·DOM) ────────────────────────────────────────

const BASE_WINDOW_KEYS = ["sessionStorage", "confirm", "requestAnimationFrame", "confirmCalls"];

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    dump: () => Object.fromEntries(map),
  };
}

const layout = { sheetHeight: 900 };

function matchesSimple(element, selector) {
  const match = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/.exec(selector);
  if (!match) throw new Error(`가짜 DOM 이 지원하지 않는 셀렉터: ${selector}`);
  if (match[1] && element.tagName !== match[1].toUpperCase()) return false;
  for (const part of match[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || []) {
    if (part[0] === "#") {
      if (element.id !== part.slice(1)) return false;
    } else if (part[0] === ".") {
      if (!element.classList.contains(part.slice(1))) return false;
    } else {
      const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      if (!attribute) throw new Error(`가짜 DOM 이 지원하지 않는 속성 셀렉터: ${part}`);
      if (!element.hasAttribute(attribute[1])) return false;
      if (attribute[2] !== undefined && element.getAttribute(attribute[1]) !== attribute[2]) return false;
    }
  }
  return true;
}

function makeDocument() {
  const document = { activeElement: null, hidden: false, listeners: {} };
  document.addEventListener = (type, fn) => { (document.listeners[type] ||= []).push(fn); };
  document.removeEventListener = (type, fn) => { document.listeners[type] = (document.listeners[type] || []).filter((entry) => entry !== fn); };
  class FakeText {
    constructor(text) {
      this.nodeType = 3;
      this.parentNode = null;
      this.data = String(text);
    }
    get textContent() { return this.data; }
    set textContent(value) { this.data = String(value); }
  }
  class FakeElement {
    constructor(tag) {
      this.nodeType = 1;
      this.tagName = String(tag).toUpperCase();
      this.parentNode = null;
      this.childNodes = [];
      this.attributes = new Map();
      this.listeners = {};
      this.value = "";
      this.checked = false;
      this.indeterminate = false;
      this.clicks = 0;
      const element = this;
      this.classList = {
        list: () => (element.getAttribute("class") || "").split(/\s+/).filter(Boolean),
        add(...names) { element.setAttribute("class", [...new Set([...this.list(), ...names])].join(" ")); },
        remove(...names) { element.setAttribute("class", this.list().filter((name) => !names.includes(name)).join(" ")); },
        toggle(name, force) {
          const want = force === undefined ? !this.contains(name) : Boolean(force);
          if (want) this.add(name);
          else this.remove(name);
          return want;
        },
        contains(name) { return this.list().includes(name); },
      };
    }
    get className() { return this.getAttribute("class") || ""; }
    set className(value) { this.setAttribute("class", String(value)); }
    get id() { return this.getAttribute("id") || ""; }
    set id(value) { this.setAttribute("id", String(value)); }
    get type() { return this.getAttribute("type") || ""; }
    get hidden() { return this.hasAttribute("hidden"); }
    set hidden(value) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
    get disabled() { return this.hasAttribute("disabled"); }
    set disabled(value) { if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
    get open() { return this.hasAttribute("open"); }
    set open(value) { if (value) this.setAttribute("open", ""); else this.removeAttribute("open"); }
    get scrollWidth() { return 0; }
    get scrollHeight() { return this.classList.contains("mi-rank-export-sheet") ? layout.sheetHeight : 0; }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === "value") this.value = String(value);
    }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    }
    replaceChildren(...nodes) {
      this.childNodes.slice().forEach((child) => this.removeChild(child));
      nodes.forEach((node) => this.appendChild(node));
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
    get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
    set textContent(value) {
      this.replaceChildren();
      if (String(value)) this.appendChild(new FakeText(value));
    }
    contains(node) {
      for (let current = node; current; current = current.parentNode) if (current === this) return true;
      return false;
    }
    matches(selector) { return selector.split(",").some((part) => matchesSimple(this, part.trim())); }
    closest(selector) {
      for (let current = this; current && current.nodeType === 1; current = current.parentNode) if (current.matches(selector)) return current;
      return null;
    }
    querySelectorAll(selector) {
      const found = [];
      const walk = (node) => node.children.forEach((child) => {
        if (child.matches(selector)) found.push(child);
        walk(child);
      });
      walk(this);
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, fn, capture) { (this.listeners[type] ||= []).push({ fn, capture: capture === true }); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((entry) => entry.fn !== fn); }
    focus() { document.activeElement = this; }
    click() { this.clicks += 1; }
  }
  document.createElement = (tag) => new FakeElement(tag);
  document.createTextNode = (text) => new FakeText(text);
  return document;
}

function dispatch(target, type) {
  const path = [];
  for (let node = target; node; node = node.parentNode) path.push(node);
  const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const node of path.slice().reverse()) (node.listeners?.[type] || []).filter((entry) => entry.capture).forEach((entry) => entry.fn(event));
  for (const node of type === "toggle" ? [target] : path) (node.listeners?.[type] || []).filter((entry) => !entry.capture).forEach((entry) => entry.fn(event));
  return event;
}

// clock 을 넘기면 모듈 안의 Date.now() 가 clock.now 를 돌려준다(2초 합치기 창 시험용).
function clockDate(clock) {
  return class ClockDate extends Date {
    static now() { return clock.now; }
  };
}

// local: window.localStorage(① 지금 확인의 보내지 못한 결과), chrome: window.chrome(기본 확장 다리 시험),
// deferTimersFrom: 이 ms 이상인 setTimeout 은 바로 돌리지 않고 timeouts 에 모아 둔다(시험이 직접 돌린다).
function loadModule({ confirm = () => true, storage = makeStorage(), MutationObserver, clock, local, chrome, userAgent, deferTimersFrom } = {}) {
  const document = makeDocument();
  const confirmCalls = [];
  const window = {
    sessionStorage: storage,
    confirm: (message) => {
      confirmCalls.push(message);
      return confirm(message);
    },
    requestAnimationFrame: (fn) => fn(),
    confirmCalls,
  };
  if (local) window.localStorage = local;
  if (chrome) window.chrome = chrome;
  const intervals = [];
  const timeouts = [];
  const context = vm.createContext({
    window,
    document,
    navigator: userAgent ? { userAgent } : {},
    Blob,
    console,
    MutationObserver,
    // 1.5초 재시도·검색 지연은 바로 돌린다. 60초 새로 받기는 기록만 한다.
    setTimeout: (fn, ms) => {
      if (deferTimersFrom !== undefined && Number(ms) >= deferTimersFrom) {
        const entry = { fn, ms, cleared: false, id: 1000 + timeouts.length };
        timeouts.push(entry);
        return entry.id;
      }
      queueMicrotask(fn);
      return 1;
    },
    clearTimeout(id) {
      const entry = timeouts.find((item) => item.id === id);
      if (entry) entry.cleared = true;
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {},
    ...(clock ? { Date: clockDate(clock) } : {}),
  });
  vm.runInContext(moduleSource, context, { filename: "mi-coupang-rank.js" });
  return { window, document, storage, api: window.MomentCoupangRank, intervals, timeouts, confirmCalls };
}

const flush = async () => {
  for (let index = 0; index < 30; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function days30(from = "2026-10-17") {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: 30 }, (_, index) => new Date(start - index * 86400000).toISOString().slice(0, 10));
}

function trackerFixture(overrides = {}) {
  return {
    id: "6c1f0000-0000-4000-8000-000000000001",
    keyword: "아이폰 18프로 사생활 보호 필름",
    keywordKey: "아이폰 18프로 사생활 보호 필름",
    productId: "8533720933",
    productUrl: "https://www.coupang.com/vp/products/8533720933",
    vendorItemId: "96009802650",
    productTitle: "아이쉘 360도 액정보호 풀커버 강화유리 사생활보호 필름, 2개",
    groupName: "기본 그룹",
    sortOrder: 100,
    status: "active",
    createdAt: "2026-10-16T03:00:00.000Z",
    createdDay: "2026-10-16",
    pausedAt: null,
    pausedDay: null,
    current: { result: "found", rank: 28, organicCount: 50, adOrder: 8, sameOption: true, checkedAt: "2026-10-17T02:11:05.000Z" },
    nextCheckAt: "2026-10-17T07:41:00.000Z",
    nextCheckState: "scheduled",
    keywordHealth: { consecutiveFailures: 0, consecutiveUnsupported: 0, lastStatus: "ok" },
    summary: { best30: 25, avg7: 27.5, foundDays7: 2, measuredDays7: 2, trend: "up", trendDelta: 3, attention: false, attentionReasons: [], lastFoundAt: "2026-10-17T02:11:05.000Z" },
    days: [
      { d: "2026-10-17", s: "found", r: 28, n: 50, a: 8, t: "11:11", c: 1, f: 0, b: 28, k: 0 },
      { d: "2026-10-16", s: "found", r: 31, n: 50, a: null, t: "19:02", c: 2, f: 1, b: 25, k: 1 },
    ],
    ...overrides,
  };
}

function listPayload(overrides = {}) {
  const trackers = overrides.trackers || [
    trackerFixture(),
    trackerFixture({ id: "6c1f0000-0000-4000-8000-000000000002", keyword: "강화유리 필름", keywordKey: "강화유리 필름", groupName: "필름", current: null, summary: { trend: "new", attention: false, attentionReasons: [] }, days: [] }),
  ];
  return {
    ok: true,
    setupRequired: false,
    scopeKey: "owner:mml93-a01",
    scopeAgencyCode: "mml93-a01",
    scopeClientId: "",
    scopeMode: "owner",
    readOnly: false,
    returnedCount: trackers.length,
    totalCount: trackers.length,
    hasMore: false,
    complete: true,
    todayKst: "2026-10-17",
    days30: days30(),
    limit: { used: 3, max: 100, globalUsed: 41, globalMax: 150, capacity: 60 },
    collector: { state: "ok", lastSuccessAt: "2026-10-17T02:11:05.000Z", checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: null },
    ...overrides,
    trackers,
  };
}

const OWNER_SCOPE = { key: "owner:mml93-a01", role: "owner", agencyCode: "mml93-a01", clientId: "" };

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(payload)) };
}

function mountWith(options = {}) {
  const loaded = loadModule(options);
  const document = loaded.document;
  const root = document.createElement("section");
  root.id = "mi-admin";
  const view = document.createElement("section");
  view.className = "mi-view is-active";
  const host = document.createElement("div");
  host.setAttribute("data-coupang-rank-root", "");
  root.appendChild(view);
  view.appendChild(host);
  const calls = [];
  let scope = options.scope === undefined ? OWNER_SCOPE : options.scope;
  const responder = options.fetch || (async (url) => {
    if (String(url).includes("view=collector")) return response(options.collectorPayload || collectorPayload());
    return response(options.payload || listPayload());
  });
  const deps = {
    mode: options.mode || "admin",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responder(url, init, calls.length);
    },
    scope: () => scope,
    isOwner: () => options.isOwner !== false,
    ownerPrimaryCode: () => "mml93-a01",
    isOwnerScopePlaceholder: (value) => {
      const normalized = String(value || "").trim().toLowerCase();
      return !normalized || normalized === "owner-session" || normalized === "session";
    },
    normalizeCode: (value) => String(value || "").trim().toLowerCase(),
    exportTools: options.exportTools,
    ...(options.extensionBridge ? { extensionBridge: options.extensionBridge } : {}),
  };
  const controller = loaded.api.mount(host, deps);
  return { ...loaded, root, view, host, calls, controller, setScope: (next) => { scope = next; } };
}

function collectorPayload(overrides = {}) {
  return {
    ok: true,
    release: "abc1234",
    bundleVersion: "1.0.0",
    settings: {
      enabled: false, teamAccessEnabled: false, clientViewEnabled: false, checksPerDay: 2, minGapSeconds: 240, gapJitterSeconds: 120,
      maxRunsPerHour: 12, maxRunsPerDay: 120, activeFromHour: 8, activeToHour: 23, defaultAccountLimit: 20, globalKeywordLimit: 150,
      windowMode: "offscreen", minCollectorVersion: null, maxStorageMb: 60, dbSizeStopMb: 450, cooldownUntil: null, cooldownReason: null,
      needsOwnerReview: false, reviewReason: null, budgetBlocked: false, budgetReason: null, rateChangedAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z",
    },
    collectors: [{ id: "c1", label: "윈도우 데스크탑", tokenHint: "x9Qa", platform: "windows", createdAt: "2026-10-16T01:00:00.000Z", revokedAt: null,
      lastSeenAt: "2026-10-17T02:00:00.000Z", lastVersion: "1.0.0", lastNode: "22.12.0", lastBrowser: "edge 141.0.3537.71", lastOs: "Windows 10.0.26100",
      lastGuard: "none", lastClaimAt: "2026-10-17T02:00:00.000Z", lastClaimReason: "gap" }],
    accountLimits: [{ agencyCode: "mml93-a01", keywordLimit: 100, kind: "owner", label: "총관리자" }, { agencyCode: "old-a01", keywordLimit: 5, kind: "unknown", label: "연결 없음" }],
    stats: { runs24h: { ok: 20, timeout: 1 }, blocked48h: 0, empty48h: 0, success48h: 50, blockCooldowns7d: 0, activeKeywords: 41, ineligibleActiveTrackers: 2,
      recentCooldowns: [], storage: { coupangBytes: 1048576, databaseBytes: 104857600 } },
    capacity: { runsPerDay: 120, keywordsAtChecks: 60, activeKeywords: 41, over: false },
    raise: { allowed: true, nextStep: 24, reasons: [] },
    oneLiners: { windowsInstall: "iwr … -Release abc1234", windowsCheck: "Get-ScheduledTaskInfo …", windowsUninstall: "iwr … -Uninstall",
      macInstall: "curl … --release abc1234", macCheck: "launchctl print …", macUninstall: "curl … --uninstall" },
    ...overrides,
  };
}

const internals = loadModule().api.internals;

test("모듈 상수가 §3 공유 계약과 같다", () => {
  assert.ok(moduleSource.includes(`var API_PATH = "${COUPANG_TRACKERS_PATH}";`));
  assert.ok(moduleSource.includes(`var LIST_LIMIT = ${TRACKER_LIST_MAX};`));
  assert.ok(moduleSource.includes(`var BULK_IDS_MAX = ${BULK_IDS_MAX};`));
  assert.ok(moduleSource.includes(`var KEYWORD_MAX = ${KEYWORD_MAX};`));
  assert.ok(moduleSource.includes(`var GROUP_MAX = ${GROUP_MAX};`));
  assert.ok(moduleSource.includes(`var DEFAULT_GROUP = "${DEFAULT_GROUP}";`));
  assert.ok(moduleSource.includes(`var RANK_TOP = ${RANK_TOP};`));
  assert.ok(moduleSource.includes('var CACHE_PREFIX = "miCoupangRank:v1:";'));
  assert.ok(moduleSource.includes("var CACHE_TTL_MS = 12 * 60 * 60 * 1000;"));
  assert.ok(moduleSource.includes("var CACHE_MAX_CHARS = 200000;"));
});

test("수집 상태 띠: 11가지 상태 모두 관리자·광고주 문구가 있다(§8.3 표)", () => {
  const admin = {
    delayed: "지연 — 예정 시각이 지난 키워드가 있습니다",
    idle_hours: "수집 시간이 아닙니다(08~23시)",
    offline: "수집기 응답 없음(30분 넘음) — 수집기 PC가 켜져 있는지 확인하세요",
    review: "대표 확인 필요 — 차단이 7일 안 3번 감지됐습니다",
    budget: "저장 용량 상한으로 멈춤 — 대표 확인 필요",
    outdated: "수집기 업데이트 필요",
    disabled: "수집 꺼짐",
    not_connected: "수집기 연결 안 됨",
    setup_required: "대표 SQL 실행 전입니다(설정 필요)",
  };
  const readonly = { ok: "정상", delayed: "갱신 대기", idle_hours: "갱신 대기", offline: "갱신 대기", cooldown: "일시 중단", review: "일시 중단",
    budget: "일시 중단", outdated: "일시 중단", disabled: "일시 중단", not_connected: "일시 중단" };
  const base = { checksPerDay: 2, activeFromHour: 8, activeToHour: 23, lastSuccessAt: "2026-10-17T02:11:05.000Z", cooldownUntil: "2026-10-17T09:30:00.000Z" };
  for (const state of COLLECTOR_STATES) {
    const strip = internals.stripText({ ...base, state }, "admin");
    assert.equal(strip.state, state);
    assert.ok(strip.text, state);
    assert.equal(strip.sub, "수집기 PC가 켜져 있을 때만 수집합니다");
    if (admin[state]) assert.equal(strip.text, admin[state]);
    if (readonly[state]) assert.equal(internals.stripText({ ...base, state }, "readonly").text, readonly[state]);
  }
  assert.equal(internals.stripText({ ...base, state: "ok" }, "admin").text, "정상 · 마지막 수집 11:11 · 하루 2회(08~23시)");
  assert.equal(internals.stripText({ ...base, state: "cooldown" }, "admin").text, "쉬는 중 ~10-17 18:30(쿠팡 차단 또는 연속 오류 감지)");
});

test("30일 판 칸 글자·작은 글·툴팁 표 전부(§8.3, N30 하루 칸 모양)", () => {
  const created = "2026-10-10";
  const rows = [
    [{ d: "2026-10-17", s: "found", r: 28, n: 50, a: 8, t: "11:11", c: 1, f: 0, b: 28 }, "28위", "순위", "11:11 일반 28위 · 광고 8번째 · 하루 1회(실패 0) · 그날 최고 28위"],
    [{ d: "2026-10-16", s: "found", r: 31, n: 50, a: null, t: "19:02", c: 2, f: 1, b: 25 }, "31위", "순위", "19:02 일반 31위 · 하루 2회(실패 1) · 그날 최고 25위"],
    [{ d: "2026-10-15", s: "out", n: 50 }, "50위 밖", "순위", "50위 밖 · 일반 50개 중 1~50위에 없음"],
    [{ d: "2026-10-14", s: "short", n: 23 }, "없음", "순위", "일반 23개 중 없음"],
    [{ d: "2026-10-13", s: "noresult" }, "결과 없음", "검색", "검색 결과 없음"],
    [{ d: "2026-10-12", s: "failed", f: 3 }, "실패", "측정", "3회 모두 실패"],
    [{ d: "2026-10-11", s: "unsupported" }, "이동", "측정", "쿠팡이 검색 결과가 아닌 쪽으로 보냈습니다"],
  ];
  // 화면 칸 모양(C30 만, 2026-10-23): 순위 · 잰 결과 순위 밖(50위 밖·없음·결과 없음) · 실패/이동 · 안 잰 날
  const kinds = ["is-found", "is-found", "is-out", "is-out", "is-out", "is-fail", "is-fail"];
  rows.forEach(([cell, text, label, tooltip], index) => {
    assert.equal(internals.cellText(cell, cell.d, created), text, cell.s);
    assert.equal(internals.cellLabel(cell), label, cell.s);
    assert.equal(internals.cellTooltip(cell, cell.d, created), tooltip, cell.s);
    assert.equal(internals.dayKind(cell), kinds[index], cell.s);
  });
  assert.equal(internals.dayKind(null), "is-none");
  assert.equal(internals.cellLabel(null), "순위");
  // 행 없음 / 등록 전. 빈 날은 원인을 하나로 단정하지 않는다(지금 확인 이전 날·꺼진 날·시간 밖·그날 중지·자동 수집 멈춤).
  assert.equal(internals.cellText(null, "2026-10-12", created), "-");
  assert.equal(internals.cellTooltip(null, "2026-10-12", created), "그날 기록 없음(지금 확인을 누르지 않았거나, 꺼짐·시간 밖·그날 중지·자동 수집 멈춤이었을 수 있습니다)");
  assert.doesNotMatch(internals.cellTooltip(null, "2026-10-12", created), /^그날 '지금 확인'을 누르지 않아/u);
  // 칸을 누르면 보이는 한 줄: 일시중지 기간의 빈 날만 '일시중지 중'으로 단정한다.
  const pausedTracker = { createdDay: created, status: "paused", pausedDay: "2026-10-15" };
  assert.equal(internals.dayDetailText(null, "2026-10-16", pausedTracker), "10-16(금) · - — 일시중지 중이라 확인하지 않았습니다");
  assert.match(internals.dayDetailText(null, "2026-10-14", pausedTracker), /— 그날 기록 없음\(지금 확인을 누르지 않았거나/u);
  assert.equal(internals.dayDetailText(rows[0][0], "2026-10-17", { createdDay: created }), "10-17(토) · 28위 — 11:11 일반 28위 · 광고 8번째 · 하루 1회(실패 0) · 그날 최고 28위");
  assert.match(internals.dayDetailText(rows[5][0], "2026-10-12", { createdDay: created }), /3회 모두 실패\. 자세한 사유는 '측정 기록'에서 봅니다$/u);
  assert.equal(internals.cellText(null, "2026-10-09", created), "");
  assert.equal(internals.cellTooltip(null, "2026-10-09", created), "");
  // 서버 DAY_RESULTS 의 모든 값에 글자가 있다.
  for (const result of DAY_RESULTS) assert.notEqual(internals.cellText({ s: result, r: 1, n: 50, f: 1 }, "2026-10-17", created), "-", result);
  // 날짜 이름은 서버의 d 를 UTC 로 읽어 요일을 구한다.
  assert.equal(internals.dayLabel("2026-10-17"), "10-17(토)");
  assert.equal(internals.dayLabel("2026-10-18"), "10-18(일)");
});

test("현재 값·전회 대비·판정·다음 갱신 문구(N30 카드와 같은 말)", () => {
  const badge = (current) => internals.currentBadge({ current }).text;
  assert.equal(badge({ result: "found", rank: 28 }), "28위");
  assert.equal(badge({ result: "out", organicCount: 50 }), "50위 밖");
  assert.equal(badge({ result: "short", organicCount: 23 }), "일반 23개 중 없음");
  assert.equal(badge({ result: "noresult" }), "결과 없음");
  assert.equal(badge(null), "측정 전");
  // 카드 '현재' 알약: 측정 전이면 N30 처럼 '-'.
  const current = (value) => internals.currentText({ current: value });
  assert.equal(current({ result: "found", rank: 28 }), "28위");
  assert.equal(current({ result: "out", organicCount: 50 }), "50위 밖");
  assert.equal(current({ result: "short", organicCount: 23 }), "일반 23개 중 없음");
  assert.equal(current({ result: "noresult" }), "결과 없음");
  assert.equal(current(null), "-");

  // 전회 대비: 서버 trendDelta = 이전 순위 - 지금 순위(양수 = 상승).
  assert.equal(internals.changeText({ trend: "up", trendDelta: 3 }), "전회 대비 3위 상승");
  assert.equal(internals.changeText({ trend: "down", trendDelta: -5 }), "전회 대비 5위 하락");
  assert.equal(internals.changeText({ trend: "same", trendDelta: 0 }), "전회 대비 변동 없음");
  assert.equal(internals.changeText({ trend: "enter", trendDelta: null }), "전회 대비 50위 안 진입");
  assert.equal(internals.changeText({ trend: "exit", trendDelta: null }), "전회 대비 50위 밖 이탈");
  assert.equal(internals.changeText({ trend: "new", trendDelta: null }), "전회 데이터 대기");
  assert.equal(internals.changeText(null), "전회 데이터 대기");

  // 판정 알약: 서버 확인 사유가 먼저, 지금 50위 밖이면 N30 300위 밖과 같은 '점검 필요'(빨강), 없으면 N30 규칙.
  // 측정 전처럼 지금 순위가 없으면 단정하지 않는다.
  const verdict = (tracker) => JSON.parse(JSON.stringify(internals.verdictPills(tracker)));
  assert.deepEqual(verdict({ current: { result: "found", rank: 30 }, summary: { attentionReasons: ["drop10", "keyword_failing"] } }),
    [{ text: "10위 이상 하락", tone: "is-warn" }, { text: "이 키워드 측정이 연속 실패", tone: "is-error" }]);
  assert.deepEqual(verdict({ current: { result: "out" }, summary: { attentionReasons: ["keyword_failing"] } }),
    [{ text: "이 키워드 측정이 연속 실패", tone: "is-error" }, { text: "점검 필요", tone: "is-error" }], "50위 밖이 이어지면 서버 사유와 함께 '점검 필요'");
  assert.deepEqual(verdict({ current: { result: "out" }, summary: { attentionReasons: ["exit"] } }), [{ text: "50위 밖으로 이탈", tone: "is-error" }],
    "막 이탈한 회차는 서버 '이탈' 알약 하나(점검 필요를 겹쳐 쓰지 않는다)");
  const found = (rank, trend) => verdict({ current: { result: "found", rank }, summary: { trend, attentionReasons: [] } });
  assert.deepEqual(found(28, "up"), [{ text: "상승 흐름", tone: "is-ok" }]);
  assert.deepEqual(found(28, "enter"), [{ text: "상승 흐름", tone: "is-ok" }]);
  assert.deepEqual(found(8, "down"), [{ text: "하락 확인", tone: "is-warn" }]);
  assert.deepEqual(found(7, "same"), [{ text: "상위권 유지", tone: "is-ok" }]);
  assert.deepEqual(found(28, "new"), [{ text: "정상 추적", tone: "is-ok" }]);
  assert.deepEqual(verdict({ current: null, summary: { trend: "new", attentionReasons: [] } }), [], "측정 전은 판정 없음");
  // 대표 결정 2026-10-17: 일반 50위 밖이 이어지는 카드(서버 사유 없음)도 N30 300위 밖처럼 '점검 필요'(빨강).
  assert.deepEqual(verdict({ current: { result: "out" }, summary: { trend: "same", attentionReasons: [] } }), [{ text: "점검 필요", tone: "is-error" }]);
  assert.deepEqual(verdict({ current: { result: "short", organicCount: 32 }, summary: { trend: "same", attentionReasons: [] } }), [{ text: "점검 필요", tone: "is-error" }],
    "'일반 N개 중 없음'도 50위 밖 필터와 같은 기준");
  assert.deepEqual(verdict({ status: "paused", current: { result: "out" }, summary: { trend: "same", attentionReasons: [] } }), [{ text: "점검 필요", tone: "is-error" }],
    "N30 처럼 일시중지여도 확인 필요로 본다");
  assert.deepEqual(verdict({ current: { result: "noresult" }, summary: { trend: "same", attentionReasons: [] } }), [], "검색 결과 없음은 50위 밖 기준에 넣지 않는다");
  // 확인 필요 기준(알약·요약칸 개수·필터가 같이 쓴다)
  assert.equal(internals.needsAttention({ current: { result: "out" }, summary: { attention: false } }), true);
  assert.equal(internals.needsAttention({ current: { result: "short" }, summary: { attention: false } }), true);
  assert.equal(internals.needsAttention({ current: { result: "found", rank: 50 }, summary: { attention: false } }), false);
  assert.equal(internals.needsAttention({ current: { result: "noresult" }, summary: { attention: false } }), false);
  assert.equal(internals.needsAttention({ current: null, summary: { attention: false } }), false);
  assert.equal(internals.needsAttention({ current: { result: "found", rank: 3 }, summary: { attention: true } }), true);
  // 7일 평균 문구(카드·공유 이미지 같은 글)
  assert.equal(internals.avg7Text({ avg7: 27.5, foundDays7: 2 }), "7일 평균 27.5위(50위 안 2일)");
  assert.equal(internals.avg7Text({ avg7: null, foundDays7: 0 }), "7일 평균 -");
  assert.equal(internals.avg7Text(null), "7일 평균 -");

  // 다음: 남은 시간(N30 formatRankRemain 계산). 수집기가 멈췄거나 쉬는 중이면 그 사실을 쓴다.
  const now = Date.parse("2026-10-17T07:00:00.000Z");
  const next = (tracker, state = "ok") => internals.nextCheckText(tracker, state, now);
  assert.equal(next({ nextCheckState: "scheduled", nextCheckAt: "2026-10-17T07:41:00.000Z" }), "41분");
  assert.equal(next({ nextCheckState: "scheduled", nextCheckAt: "2026-10-17T23:05:00.000Z" }), "17시간");
  assert.equal(next({ nextCheckState: "scheduled", nextCheckAt: "2026-10-19T08:00:00.000Z" }), "3일");
  assert.equal(next({ nextCheckState: "scheduled", nextCheckAt: "2026-10-17T06:59:00.000Z" }), "대기");
  assert.equal(next({ nextCheckState: "due", nextCheckAt: "2026-10-17T01:00:00.000Z" }), "대기");
  assert.equal(next({ nextCheckState: "replan", nextCheckAt: null }), "다음 수집 때 정함");
  assert.equal(next({ nextCheckState: "paused", nextCheckAt: null }), "-");
  for (const state of ["disabled", "review", "budget", "outdated", "not_connected", "setup_required"]) {
    assert.equal(next({ nextCheckState: "due", nextCheckAt: "2026-10-17T01:00:00.000Z" }, state), "정지", state);
  }
  assert.equal(next({ nextCheckState: "scheduled", nextCheckAt: "2026-10-17T07:41:00.000Z" }, "cooldown"), "쉬는 중");
  assert.equal(next({ nextCheckState: "scheduled", nextCheckAt: "2026-10-17T07:41:00.000Z" }, "offline"), "41분");
  assert.equal(next({ status: "paused", nextCheckState: "paused", nextCheckAt: null }, "disabled"), "-", "일시중지가 먼저");
  // 최근·다음 갱신 시각은 N30 formatRankShortAt 과 같은 모양(KST 고정).
  assert.match(internals.shortAt("2026-10-17T02:11:05.000Z"), /^10\.\s?17\.\s?오전\s?11:11$/);
  assert.equal(internals.shortAt(null), "-");
});

test("날짜 줄 범위: 등록한 날부터 오늘까지만(등록 전 빈칸 없음)", () => {
  const range = (createdDay, days) => internals.boardDays({ createdDay, days: days || [] }, days30()).dates;
  assert.deepEqual(range("2026-10-16"), ["2026-10-17", "2026-10-16"]);
  assert.equal(range("2026-09-01").length, 30, "30일보다 오래된 추적은 30칸");
  assert.equal(range("").length, 30, "등록일을 모르면 30칸");
  const cells = [{ d: "2026-10-16", s: "out" }, { d: "2026-10-16", s: "found", r: 3 }];
  const byDay = internals.boardDays({ createdDay: "2026-10-16", days: cells }, days30()).byDay;
  assert.equal(byDay["2026-10-16"].s, "out", "같은 날 칸은 서버가 보낸 첫 칸");
});

test("그룹 입력: '미분류'는 기본 그룹(빈 값)으로 본다", () => {
  assert.equal(internals.normalizeGroupInput("미분류"), "");
  assert.equal(internals.normalizeGroupInput("  미분류 "), "");
  assert.equal(internals.normalizeGroupInput("A  업체"), "A 업체");
  assert.equal(internals.normalizeGroupInput("기본 그룹"), "기본 그룹");
});

test("자동추적 요약칸: 수집기 상태 → 확인 필요 → 대기 → 정상 순서로 알약을 정한다(N30 자리·색 규칙)", () => {
  const now = Date.now();
  const soon = new Date(now + 3600e3).toISOString();
  const later = new Date(now + 7200e3).toISOString();
  const base = { lastSuccessAt: "2026-10-17T02:11:05.000Z", checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: "2026-10-17T09:30:00.000Z" };
  const list = [
    { status: "active", nextCheckState: "scheduled", nextCheckAt: later, summary: { attention: false } },
    { status: "active", nextCheckState: "scheduled", nextCheckAt: soon, summary: { attention: false } },
    { status: "paused", nextCheckState: "paused", nextCheckAt: null, summary: { attention: false } },
  ];
  const summary = (state, items = list, mode = "admin") => JSON.parse(JSON.stringify(internals.autoSummary({ ...base, state }, items, { mode })));
  const ok = summary("ok");
  assert.deepEqual(ok.pill, { text: "정상 운영", tone: "" });
  assert.equal(ok.small, "2개 운영 · 0개 대기 · 0개 확인");
  assert.deepEqual(ok.metrics.map((metric) => metric.label), ["최근 갱신", "다음 갱신", "확인 필요"]);
  assert.match(ok.metrics[0].value, /^10\.\s?17\.\s?오전\s?11:11$/);
  assert.equal(ok.metrics[0].note, "수집기 PC");
  assert.equal(ok.metrics[1].value, internals.shortAt(soon), "가장 이른 다음 예정");
  assert.equal(ok.metrics[1].note, "하루 2회 자동 갱신 · 08~23시");
  assert.equal(ok.metrics[1].tone, "is-ok");
  assert.deepEqual([ok.metrics[2].value, ok.metrics[2].tone], ["0개", "is-ok"]);
  // 수집기 상태가 먼저다.
  assert.deepEqual(summary("disabled").pill, { text: "수집 꺼짐", tone: "is-error" });
  assert.equal(summary("disabled").small, "수집 꺼짐 · 수집기 PC가 켜져 있을 때만 수집합니다");
  assert.deepEqual([summary("disabled").metrics[1].value, summary("disabled").metrics[1].tone], ["정지", "is-error"]);
  assert.deepEqual(summary("not_connected").pill, { text: "연결 안 됨", tone: "is-error" });
  assert.deepEqual(summary("offline").pill, { text: "응답 없음", tone: "is-error" });
  assert.deepEqual(summary("setup_required").pill, { text: "설정 필요", tone: "is-warn" });
  assert.deepEqual(summary("cooldown").pill, { text: "쉬는 중", tone: "is-warn" });
  assert.match(summary("cooldown").metrics[1].value, /^쉬는 중 ~10\.\s?17\.\s?오후\s?06:30$/);
  assert.deepEqual(summary("delayed").pill, { text: "갱신 대기", tone: "is-warn" });
  assert.deepEqual(summary("idle_hours").pill, { text: "수집 시간 아님", tone: "" });
  // 그다음 확인 필요 → 대기.
  const attention = [{ status: "active", nextCheckState: "due", nextCheckAt: soon, summary: { attention: true } }, ...list];
  const flagged = summary("ok", attention);
  assert.deepEqual(flagged.pill, { text: "확인 필요", tone: "is-error" });
  assert.equal(flagged.small, "3개 운영 · 1개 대기 · 1개 확인");
  assert.deepEqual([flagged.metrics[2].value, flagged.metrics[2].tone], ["1개", "is-error"]);
  // 50위 밖이 이어지는 추적(서버 사유 없음)도 확인 필요로 센다(N30 rankTrackerOpsSummary 의 errors 와 같은 규칙).
  const outList = [{ status: "active", nextCheckState: "scheduled", nextCheckAt: later, current: { result: "out" }, summary: { attention: false } }, ...list];
  const outFlagged = summary("ok", outList);
  assert.deepEqual(outFlagged.pill, { text: "확인 필요", tone: "is-error" });
  assert.equal(outFlagged.small, "3개 운영 · 0개 대기 · 1개 확인");
  assert.deepEqual([outFlagged.metrics[2].value, outFlagged.metrics[2].tone], ["1개", "is-error"]);
  const due = summary("ok", [{ status: "active", nextCheckState: "due", nextCheckAt: soon, summary: { attention: false } }]);
  assert.deepEqual(due.pill, { text: "갱신 대기", tone: "is-warn" });
  assert.equal(due.metrics[1].tone, "is-warn");
  assert.deepEqual(summary("ok", []).pill, { text: "대기", tone: "" }, "추적이 0개여도 요약칸은 보인다");
  // 광고주(읽기 전용)는 광고주용 문구만.
  assert.deepEqual(summary("ok", list, "readonly").pill, { text: "정상", tone: "" });
  assert.deepEqual(summary("disabled", list, "readonly").pill, { text: "일시 중단", tone: "is-warn" });
  assert.equal(summary("disabled", list, "readonly").small, "수집기 PC가 켜져 있을 때만 수집합니다");
  // 수집 상태를 아직 못 받았으면 '확인 중'.
  const none = JSON.parse(JSON.stringify(internals.autoSummary(null, [], { mode: "admin", loading: true })));
  assert.deepEqual(none.pill, { text: "확인 중", tone: "is-warn" });
  assert.equal(none.small, "수집 상태 확인 중 · 수집기 PC가 켜져 있을 때만 수집합니다");
});

test("필터: 검색(키워드·상품번호·상품명·그룹)·그룹·상태 버튼", () => {
  const base = trackerFixture();
  const match = (tracker, filter) => internals.filterMatches(tracker, filter);
  assert.equal(match(base, { query: "18프로" }), true);
  assert.equal(match(base, { query: "8533720933" }), true);
  assert.equal(match(base, { query: "아이쉘" }), true);
  // 그룹 검색은 화면에 보이는 이름으로: 기본 그룹은 '미분류'로 걸리고, 화면에 없는 서버 값 '기본 그룹'으로는 걸리지 않는다.
  assert.equal(match(base, { query: "미분류" }), true);
  assert.equal(match(base, { query: "기본" }), false);
  assert.equal(match(trackerFixture({ groupName: "필름" }), { query: "필름" }), true);
  assert.equal(match(base, { query: "없는말" }), false);
  assert.equal(match(base, { group: "필름" }), false);
  assert.equal(match(base, { group: "기본 그룹" }), true);
  const withTrend = (trend) => trackerFixture({ summary: { trend, attention: false } });
  assert.equal(match(withTrend("up"), { status: "up" }), true);
  assert.equal(match(withTrend("enter"), { status: "up" }), true);
  assert.equal(match(withTrend("down"), { status: "up" }), false);
  assert.equal(match(withTrend("down"), { status: "down" }), true);
  assert.equal(match(withTrend("exit"), { status: "down" }), true);
  assert.equal(match(withTrend("same"), { status: "down" }), false);
  assert.equal(match(trackerFixture({ summary: { attention: true, attentionReasons: ["drop10"] } }), { status: "attention" }), true);
  assert.equal(match(base, { status: "attention" }), false);
  assert.equal(match(trackerFixture({ current: { result: "out" }, summary: { trend: "same", attention: false, attentionReasons: [] } }), { status: "attention" }), true, "50위 밖이 이어지면 확인 필요");
  assert.equal(match(trackerFixture({ current: { result: "short" }, summary: { trend: "same", attention: false, attentionReasons: [] } }), { status: "attention" }), true);
  assert.equal(match(trackerFixture({ current: { result: "noresult" }, summary: { trend: "same", attention: false, attentionReasons: [] } }), { status: "attention" }), false);
  assert.equal(match(trackerFixture({ current: null, summary: { trend: "new", attention: false, attentionReasons: [] } }), { status: "attention" }), false);
  assert.equal(match(trackerFixture({ current: { result: "out" } }), { status: "out" }), true);
  assert.equal(match(trackerFixture({ current: { result: "short" } }), { status: "out" }), true);
  assert.equal(match(trackerFixture({ current: { result: "noresult" } }), { status: "out" }), false);
  assert.equal(match(trackerFixture({ status: "paused" }), { status: "paused" }), true);
  assert.equal(match(base, { status: "paused" }), false);
  assert.equal(match(base, { status: "all" }), true);
});

test("범위 검증: N30 원본 3갈래 + 그 밖 갈래의 scopeMode 조건(M4)", () => {
  const deps = (primary = "mml93-a01") => ({
    normalizeCode: (value) => String(value || "").trim().toLowerCase(),
    isOwnerScopePlaceholder: (value) => ["", "owner-session", "session"].includes(String(value || "").trim().toLowerCase()),
    ownerPrimaryCode: () => primary,
  });
  const payload = (extra = {}) => ({ ok: true, trackers: [{ id: "a" }, { id: "b" }], returnedCount: 2, ...extra });
  const check = (body, scope, primary) => internals.scopedPayload(body, scope, deps(primary));
  // 공통 조건
  assert.equal(check(payload({ scopeAgencyCode: "mml93-a01", returnedCount: 3 }), OWNER_SCOPE), false);
  assert.equal(check(payload({ scopeAgencyCode: "mml93-a01", trackers: [{ id: "a" }, { id: "a" }] }), OWNER_SCOPE), false);
  assert.equal(check(payload({ scopeAgencyCode: "mml93-a01", trackers: [{ id: "a" }, { id: " " }] }), OWNER_SCOPE), false);
  assert.equal(check({ ...payload({ scopeAgencyCode: "mml93-a01" }), ok: false }, OWNER_SCOPE), false);
  assert.equal(check(payload({ scopeAgencyCode: "mml93-a01" }), null), false);
  // ① 총관리자: 자리표시자가 아니면 대상 코드와 같아야 한다.
  assert.equal(check(payload({ scopeAgencyCode: "MML93-A01" }), OWNER_SCOPE), true);
  assert.equal(check(payload({ scopeAgencyCode: "other-a01" }), OWNER_SCOPE), false);
  // ② 자리표시자 범위: 대표 코드를 알면 그 값과 대조.
  const internalScope = { key: "owner-internal", role: "owner", agencyCode: "owner-session", clientId: "" };
  assert.equal(check(payload({ scopeAgencyCode: "mml93-a01" }), internalScope, "mml93-a01"), true);
  assert.equal(check(payload({ scopeAgencyCode: "other-a01" }), internalScope, "mml93-a01"), false);
  // ③ 대표 코드도 모르면 비어 있지 않은 응답 범위만 인정.
  assert.equal(check(payload({ scopeAgencyCode: "mml93-a01" }), internalScope, "owner-session"), true);
  assert.equal(check(payload({ scopeAgencyCode: "" }), internalScope, "owner-session"), false);
  // 계정 전용 운영팀
  const accountOnly = { key: "team-account:t1", role: "team", agencyCode: "", clientId: "", accountOnly: true };
  assert.equal(check(payload({ scopeMode: "team-account", scopeClientId: "" }), accountOnly), true);
  assert.equal(check(payload({ scopeMode: "team-account", scopeClientId: "c1" }), accountOnly), false);
  assert.equal(check(payload({ scopeMode: "advertiser", scopeClientId: "" }), accountOnly), false);
  // 그 밖(광고주 연결 운영팀): scopeMode 가 team-account 면 clientId 가 같아도 거절.
  const teamScope = { key: "team:c1", role: "team", agencyCode: "", clientId: "c1" };
  assert.equal(check(payload({ scopeMode: "advertiser", scopeClientId: "C1" }), teamScope), true);
  assert.equal(check(payload({ scopeMode: "advertiser", scopeClientId: "c2" }), teamScope), false);
  assert.equal(check(payload({ scopeMode: "team-account", scopeClientId: "c1" }), teamScope), false);
  // 원본 규칙을 그대로 옮겼는지(문장 단위)
  for (const line of [
    "if (!payload || payload.ok !== true || !Array.isArray(payload.trackers) || !scope) return false;",
    "if (!Number.isSafeInteger(payload.returnedCount) || payload.returnedCount !== payload.trackers.length) return false;",
    "return payload.scopeMode === \"team-account\" && !normalize(payload.scopeClientId);",
    "return payload.scopeMode !== \"team-account\" && normalize(payload.scopeClientId) === scope.clientId;",
  ]) assert.ok(moduleSource.includes(line), line);
  assert.ok(adminSource.includes('return payload.scopeMode !== "team-account" && normalizeStorageCode(payload.scopeClientId) === scope.clientId;'));
});

test("파일명·캐시 키·용량 경고 문구", () => {
  const one = [{ keyword: "아이폰 필름" }];
  const many = [{ keyword: "아이폰 필름" }, { keyword: "b" }, { keyword: "c" }];
  assert.equal(internals.exportFileName(one, "png"), "아이폰-필름-C30일순위.png");
  assert.equal(internals.exportFileName(many, "jpg"), "아이폰-필름-외-2개-C30일순위.jpg");
  assert.equal(internals.exportFileName([{ keyword: "a/b:c*?\"<>|d" }], "svg"), "a-b-c-d-C30일순위.svg");
  const long = internals.exportFileName([{ keyword: "가".repeat(50) }, { keyword: "x" }], "png");
  assert.ok(long.length <= 90 && long.endsWith(".png"));
  assert.equal(internals.cacheKey({ key: "owner:mml93-a01" }), "miCoupangRank:v1:owner:mml93-a01");
  assert.equal(internals.capacityText({ globalUsed: 41, capacity: 60 }, 2), "");
  assert.equal(internals.capacityText({ globalUsed: 70, capacity: 60 }, 2),
    "지금 설정으로는 하루 2번 키워드 약 60개까지 제때 잽니다(지금 70개). 더 등록하면 일부 키워드가 늦게 잡힙니다");
  assert.equal(internals.capacityText(null, 2), "");
  // 등록 줄 한도 알약은 이 계정 추적 수만. 여러 계정이 나눠 쓰는 전체 한도는 '자동 수집' 칸 용량 줄로 옮겼다.
  assert.equal(internals.limitText({ used: 3, max: 100, globalUsed: 41, globalMax: 150 }), "추적 3 / 100개");
  assert.equal(internals.globalLimitText({ used: 3, max: 100, globalUsed: 41, globalMax: 150 }), "전체 고유 키워드 41 / 150개(모든 계정 합)");
  assert.equal(internals.globalLimitText(null), "");
});

test("확인 필요 사유·오류 문구가 계약 값 전부를 덮는다", () => {
  for (const reason of ATTENTION_REASONS) assert.ok(new RegExp(`\\b${reason}: "`).test(moduleSource), reason);
  assert.equal(internals.errorText({ code: "COUPANG_SCOPE_NO_CREATE" }), "이 팀 코드 범위에서는 새로 등록하거나 다시 시작할 수 없습니다(조회·중지·삭제만)");
  assert.match(internals.errorText({ code: "COUPANG_KEYWORD_LIMIT_REACHED", limit: 20, count: 20 }), /키워드 한도\(20개\).*지금 20개/);
  assert.match(internals.errorText({ code: "COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED", limit: 150, count: 150 }), /전체 고유 키워드 한도\(150개\)/);
  assert.equal(internals.errorText({ code: "COUPANG_SHORT_LINK_UNSUPPORTED" }), "상품 페이지를 연 뒤 주소창 주소를 붙여 주세요");
  assert.match(internals.errorText({ code: "COUPANG_RAISE_NOT_ALLOWED", reasons: ["quiet_window_short", "ladder_step"] }), /48시간이 지나지 않았습니다 · 한 번에 한 단계/);
  assert.equal(internals.errorText({ code: "X", message: "서버 문구" }), "서버 문구");
});

test("설정 patch: 범위 오류·바뀐 칸만·속도 올림 판정", () => {
  const current = collectorPayload().settings;
  const values = { checksPerDay: "2", maxRunsPerHour: "6", activeFromHour: "8", activeToHour: "23", minCollectorVersion: "", windowMode: "offscreen", teamAccessEnabled: false };
  const lower = internals.settingsPatch(current, values);
  assert.deepEqual(JSON.parse(JSON.stringify(lower.errors)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(lower.patch)), { maxRunsPerHour: 6 });
  assert.equal(internals.isRaise(current, lower.patch), false);
  assert.equal(internals.isRaise(current, { maxRunsPerHour: 24 }), true);
  assert.equal(internals.isRaise(current, { maxRunsPerDay: 200 }), true);
  assert.equal(internals.isRaise(current, { minGapSeconds: 120 }), true);
  assert.equal(internals.isRaise(current, { activeFromHour: 7 }), true);
  assert.equal(internals.isRaise(current, { activeToHour: 24 }), true);
  assert.equal(internals.isRaise(current, { activeToHour: 22, maxRunsPerDay: 60 }), false);
  const bad = internals.settingsPatch(current, { checksPerDay: "7", minGapSeconds: "abc", activeFromHour: "20", activeToHour: "10", minCollectorVersion: "1.0" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["activeToHour", "checksPerDay", "minCollectorVersion", "minGapSeconds"]);
  assert.deepEqual(JSON.parse(JSON.stringify(bad.patch)), {});
  // 운영팀·광고주 공개 칸은 화면 설정에 없다(대표 결정 2026-10-23: 총관리자 전용). 값이 들어와도 patch 에 싣지 않는다.
  assert.deepEqual(JSON.parse(JSON.stringify(internals.settingsPatch(current, { minCollectorVersion: "1.0.1", teamAccessEnabled: true, clientViewEnabled: true }).patch)), { minCollectorVersion: "1.0.1" });
  // 광고주 안내 문구(복붙 템플릿)는 대표 결정(2026-10-23)으로 지웠다.
  assert.equal(internals.templateText, undefined);
});

// ── 화면 흐름 ─────────────────────────────────────────────────

test("대상이 없으면 '대상 광고주를 먼저 고르세요'만 보이고 요청하지 않는다", async () => {
  const screen = mountWith({ scope: null });
  screen.controller.show();
  await flush();
  assert.ok(screen.host.textContent.includes("대상 광고주를 먼저 고르세요"));
  assert.equal(screen.calls.length, 0);
});

// 모듈이 만든 요소의 첫 data-coupang-rank-* 속성 이름(없으면 class). 뼈대 순서를 볼 때 쓴다.
const hookOf = (node) => [...node.attributes.keys()].find((name) => name.startsWith("data-coupang-rank-")) || node.className;

test("목록: 큰 카드(등록 줄·목록 패널)·보조 상자(사용 방법·자동 수집)·그룹·카드 3행·날짜 칸이 그려지고 캐시가 저장된다", async () => {
  const storage = makeStorage({ "miCoupangRank:v1:owner:other": "{}", "miRankTrackerLastGood:v1:x": "keep" });
  const screen = mountWith({ storage });
  screen.controller.show();
  await flush();
  assert.equal(screen.calls.length, 1);
  assert.equal(screen.calls[0].url, `${COUPANG_TRACKERS_PATH}?limit=500`);
  assert.equal(screen.calls[0].init.method, "GET");
  assert.equal(screen.calls[0].init.timeoutMs, 30000);
  assert.equal(screen.calls[0].init.headers["x-mi-agency-code"], "mml93-a01");
  // 뼈대: 큰 카드 하나(등록 줄·상태줄·목록) + 아래 보조 상자 하나(접힌 줄: 사용 방법 · 내 크롬 확장 · 자동 수집). 큰 카드 머리는 없다.
  const sections = screen.host.children;
  assert.deepEqual(sections.map((node) => node.tagName), ["ARTICLE", "SECTION"]);
  const main = sections[0];
  assert.ok(main.classList.contains("mi-card") && main.classList.contains("mi-card-pad") && main.classList.contains("mi-rank-card"));
  assert.equal(main.querySelectorAll(".mi-card-head").length, 0, "큰 카드 머리(꼬리표·제목·규칙 상자)는 화면 머리 한 겹으로 합쳤다");
  assert.ok(main.contains(screen.host.querySelector("[data-coupang-rank-form]")));
  assert.ok(main.contains(screen.host.querySelector("[data-coupang-rank-status]")));
  assert.ok(main.contains(screen.host.querySelector("[data-coupang-rank-board]")));
  const aux = sections[1];
  assert.ok(aux.hasAttribute("data-coupang-rank-aux"));
  assert.deepEqual(aux.children.map((node) => [node.tagName, hookOf(node)]), [["DETAILS", "data-coupang-rank-guide"], ["DETAILS", "data-coupang-rank-ext"], ["DETAILS", "data-coupang-rank-owner"]]);
  assert.equal(screen.host.querySelector("[data-coupang-rank-ext]").hidden, true, "서버 manual 칸이 없으면 '내 크롬 확장' 줄은 숨는다");
  assert.equal(screen.host.querySelector("[data-coupang-rank-template]"), null, "광고주 안내 문구 칸은 없다(대표 결정 2026-10-23)");
  assert.ok(!screen.host.textContent.includes("광고주 안내 문구"));
  const board = screen.host.querySelector("[data-coupang-rank-board]");
  assert.deepEqual(board.children.map(hookOf),
    ["mi-coupang-rank-board-head", "data-coupang-rank-list-note", "data-coupang-rank-manual-box", "data-coupang-rank-strip", "data-coupang-rank-filter", "data-coupang-rank-bulk", "data-coupang-rank-list"]);
  assert.equal(board.children[0].querySelector("h3").textContent, "상품별 일별 순위");
  // ① 지금 확인 상태판은 서버 manual 칸이 없으면 숨고, 자동 수집이 돌면(collector ok) 자동추적 칸이 보인다.
  assert.equal(board.querySelector("[data-coupang-rank-manual-box]").hidden, true);
  // 등록 줄(입력 3칸 + 버튼) + 안내 한 줄 + 한도 알약. 버튼처럼 생긴 고정 칩 '일반 50위 이내'는 없다.
  assert.equal(screen.host.querySelector("[data-coupang-rank-keyword]").getAttribute("placeholder"), "키워드");
  assert.equal(screen.host.querySelector("[data-coupang-rank-product-url]").getAttribute("placeholder"), "쿠팡 상품 URL 붙여넣기");
  assert.equal(screen.host.querySelector("[data-coupang-rank-group-input]").getAttribute("placeholder"), "그룹(비우면 미분류)");
  assert.equal(screen.host.querySelector("[data-coupang-rank-create]").textContent, "순위 추적");
  const createForm = screen.host.querySelector("[data-coupang-rank-create-form]");
  assert.ok(createForm.classList.contains("mi-rank-form"));
  assert.deepEqual(createForm.children.map((node) => node.tagName), ["INPUT", "INPUT", "INPUT", "DATALIST", "BUTTON"]);
  assert.ok(!screen.host.textContent.includes("일반 50위 이내"));
  assert.equal(screen.host.querySelector(".mi-coupang-rank-form-hint").textContent, "상품 페이지 주소창의 주소(또는 상품번호) · 일반 상품 50위까지 기록 · 같은 상품이면 옵션이 달라도 인정");
  assert.equal(screen.host.querySelector("[data-coupang-rank-limit]").textContent, "추적 3 / 100개");
  assert.ok(!screen.host.textContent.includes("전체 41 / 150"), "전체 한도는 자동 수집 칸으로 옮겼다");
  // 맨 위 상태줄은 할 말이 있을 때만(불러옴 알림·기본 안내문 없음).
  const status = screen.host.querySelector("[data-coupang-rank-status]");
  assert.equal(status.hidden, true);
  assert.equal(status.textContent, "");
  // 필터 줄: 버튼마다 개수, 끝에 '오늘 안 함'. 개수 글은 목록 제목 옆 평범한 글.
  assert.equal(screen.host.querySelector("[data-coupang-rank-filter-search]").getAttribute("placeholder"), "키워드, 상품명, 상품번호 검색");
  assert.deepEqual(screen.host.querySelector("[data-coupang-rank-filter-group]").children.map((option) => option.textContent), ["전체 그룹", "필름"]);
  assert.deepEqual(screen.host.querySelectorAll("[data-coupang-rank-filter-status]").map((node) => node.textContent),
    ["전체 2", "확인 필요 0", "상승 1", "하락 0", "50위 밖 0", "일시중지 0", "오늘 안 함 1"]);
  assert.equal(screen.host.querySelector('[data-coupang-rank-filter-status="all"]').getAttribute("aria-pressed"), "true");
  const count = screen.host.querySelector("[data-coupang-rank-filter-count]");
  assert.equal(count.textContent, "2개 중 2개 표시");
  assert.ok(board.children[0].contains(count), "개수는 목록 제목 줄에");
  assert.equal(screen.host.querySelectorAll(".mi-rank-filter-help").length, 0, "도움말 한 줄은 사용 방법으로 옮겼다");
  // 선택 항목 정리: 고르기 전에는 한 줄(안내 + '보이는 항목 전체 선택'), 동작 줄은 접혀 있다. '●'·동작 이름은 C30 만 바뀜.
  const bulk = screen.host.querySelector("[data-coupang-rank-bulk]");
  assert.equal(bulk.classList.contains("is-open"), false);
  // 동작 줄은 안내 글과 같은 칸에 겹쳐 두고 감춘다(hidden 이 아니라 CSS visibility + aria-hidden — 체크해도 막대 높이가 그대로).
  assert.equal(bulk.querySelector("[data-coupang-rank-bulk-actions]").getAttribute("aria-hidden"), "true");
  assert.equal(bulk.querySelector("[data-coupang-rank-selected-count]").hidden, true);
  assert.equal(bulk.querySelector(".mi-coupang-rank-bulk-hint").textContent, "카드를 체크하면 그룹 옮기기 · 일시중지 · 삭제 · 이미지 저장을 한 번에 할 수 있습니다.");
  // '정리 열기 ▴'는 휴대폰 아래 막대 머리의 펼치기 단추(넓은 화면 CSS 는 숨김, 고르기 전에는 hidden).
  assert.deepEqual(bulk.querySelectorAll("button").map((node) => node.textContent),
    ["보이는 항목 전체 선택", "정리 열기 ▴", "그룹으로 옮기기", "그룹 해제", "일시중지", "다시 시작", "선택 이미지 저장", "선택 해제", "선택 삭제"]);
  assert.equal(bulk.querySelector('[data-coupang-rank-action="bulk-sheet-toggle"]').hidden, true);
  // 그룹 머리(N30 틀: 전체 선택 · 미분류 · N개 추적 · 지금 최고 N위)
  const groupHeads = screen.host.querySelectorAll("[data-coupang-rank-group]");
  assert.equal(groupHeads[0].getAttribute("data-coupang-rank-group"), "기본 그룹", "data 값은 서버 값 그대로");
  assert.equal(groupHeads[0].querySelector(".mi-rank-group-head").textContent, "미분류1개 추적 · 지금 최고 28위접기");
  assert.equal(groupHeads[0].querySelector(".mi-rank-group-select").textContent, "전체 선택");
  assert.equal(groupHeads[1].querySelector(".mi-rank-group-head").textContent, "필름1개 추적접기");
  assert.ok(groupHeads[0].querySelector(".mi-rank-group-items").classList.contains("mi-rank-daily-list"));

  const cards = screen.host.querySelectorAll("[data-coupang-rank-card]");
  assert.equal(cards.length, 2);
  const card = cards[0];
  assert.ok(card.classList.contains("mi-rank-tracker-card") && card.classList.contains("mi-coupang-rank-card"));
  assert.equal(card.tagName, "SECTION");
  assert.ok(!card.hasAttribute("draggable"), "끌어서 순서 바꾸기는 없다");
  const text = card.textContent;
  for (const expected of ["선택", "아이폰 18프로 사생활 보호 필름", "상품번호 8533720933", "아이쉘 360도 액정보호 풀커버 강화유리 사생활보호 필름, 2개",
    "현재 28위", "30일 최고 25위", "일시중지", "삭제", "상승 흐름", "전회 대비 3위 상승", "7일 평균 27.5위(50위 안 2일)", "광고 8번째", "오늘 11:11 확인", "그룹 변경", "측정 기록"]) {
    assert.ok(text.includes(expected), expected);
  }
  // 자동 수집이 돌 때는 '다음'이 보인다(지금 확인만 쓸 때는 없음).
  assert.match(text, /다음 (?:\d+분|\d+시간|\d+일|대기)/);
  assert.equal(text.split("8533720933").length - 1, 1, "상품번호는 한 곳에만");
  // 늘 같은 알약(상태 운영중 · 그룹 X · 광고 -)과 긴 '최근' 날짜는 두지 않는다.
  for (const old of ["상태 운영중", "그룹 미분류", "광고 -", "최근 ", "상품정보 · ", "▲3", "추적 중"]) assert.ok(!text.includes(old), old);
  // '선택' 글자는 화면 읽기용(체크칸 label 은 그대로라 누르는 자리는 줄지 않는다)
  const selectLabel = card.querySelector(".mi-rank-select");
  assert.ok(selectLabel.querySelector(".mi-coupang-rank-sr"));
  assert.equal(selectLabel.querySelector("input").getAttribute("aria-label"), "아이폰 18프로 사생활 보호 필름 선택");
  const keywordLink = card.querySelector("a");
  assert.ok(keywordLink.classList.contains("mi-rank-keyword-name"));
  assert.equal(keywordLink.textContent, "아이폰 18프로 사생활 보호 필름↗", "링크임이 보이게 ↗");
  assert.equal(keywordLink.querySelector(".mi-coupang-rank-ext-mark").getAttribute("aria-hidden"), "true");
  assert.equal(keywordLink.getAttribute("href"), `https://www.coupang.com/np/search?q=${encodeURIComponent("아이폰 18프로 사생활 보호 필름")}`);
  assert.equal(keywordLink.getAttribute("target"), "_blank");
  assert.equal(keywordLink.getAttribute("rel"), "noopener noreferrer");
  const titleLink = card.querySelector("a.mi-rank-product-title");
  assert.equal(titleLink.getAttribute("href"), "https://www.coupang.com/vp/products/8533720933");
  assert.equal(titleLink.getAttribute("rel"), "noopener noreferrer");
  // 1행 오른쪽: 현재(굵게) · 30일 최고 | 일시중지 · 삭제(세로 줄 뒤 도구 묶음)
  const rowActions = card.querySelector(".mi-rank-row-actions");
  assert.deepEqual(rowActions.children.map((node) => node.textContent), ["현재 28위", "30일 최고 25위", "일시중지삭제"]);
  assert.equal(rowActions.children[0].querySelector("b").textContent, "28위");
  assert.ok(rowActions.children[2].classList.contains("mi-coupang-rank-card-tools"));
  // 날짜 줄: 등록한 날(10-16)부터 오늘(10-17)까지, 오늘 칸은 '오늘 10-17', 칸마다 작은 글 없이 값만. 칸은 버튼이다.
  const dayCells = card.querySelectorAll(".mi-rank-day-card");
  assert.equal(dayCells.length, 2, "등록 전 빈칸을 그리지 않는다");
  assert.ok(dayCells[0].classList.contains("is-sat") && dayCells[0].classList.contains("is-today") && dayCells[0].classList.contains("is-found"));
  assert.ok(!dayCells[1].classList.contains("is-today"));
  assert.equal(dayCells[0].getAttribute("role"), "listitem");
  assert.equal(dayCells[0].querySelector("strong").textContent, "오늘 10-17");
  assert.equal(dayCells[1].querySelector("strong").textContent, "10-16(금)");
  assert.equal(dayCells[0].querySelectorAll("small").length, 0, "칸마다 반복되던 작은 글 '순위'는 없다");
  assert.equal(dayCells[0].querySelector("b").textContent, "28위");
  assert.equal(dayCells[1].querySelector("b").textContent, "31위");
  assert.equal(dayCells[0].getAttribute("title"), "11:11 일반 28위 · 광고 8번째 · 하루 1회(실패 0) · 그날 최고 28위");
  const dayButtons = card.querySelectorAll("[data-coupang-rank-day]");
  assert.deepEqual(dayButtons.map((node) => [node.tagName, node.getAttribute("tabindex"), node.getAttribute("aria-pressed")]), [["BUTTON", "0", "false"], ["BUTTON", "-1", "false"]],
    "날짜 줄의 탭 정지는 한 칸뿐(roving tabindex)");
  assert.equal(card.querySelector(".mi-rank-day-grid").getAttribute("role"), "list");
  assert.equal(card.querySelector("[data-coupang-rank-day-detail]").hidden, true);
  // 측정 전 카드: 날짜 줄 대신 작은 안내 상자(무엇을 하면 기록되는지)
  const pending = cards[1];
  assert.equal(pending.querySelectorAll(".mi-rank-day-card").length, 0);
  assert.equal(pending.querySelector(".mi-rank-state").textContent, "아직 순위 기록이 없습니다. 다음 자동 수집 때 첫 순위가 기록됩니다.");
  for (const expected of ["현재 -", "30일 최고 -", "전회 데이터 대기", "7일 평균 -", "아직 확인 전"]) assert.ok(pending.textContent.includes(expected), expected);
  for (const old of ["측정 전", "광고 -", "그룹 필름", "최근 -"]) assert.ok(!pending.textContent.includes(old), old);
  assert.equal(pending.querySelectorAll(".mi-rank-insight-pill").length, 0, "지금 순위가 없으면 판정 알약을 두지 않는다");
  // 자동추적 요약칸(자동 수집이 돌 때만, 지금 확인 상태판 아래)
  const strip = screen.host.querySelector("[data-coupang-rank-strip]");
  assert.equal(strip.hidden, false);
  assert.ok(strip.classList.contains("mi-rank-auto-center"));
  assert.equal(strip.querySelector("[data-coupang-rank-strip-status]").textContent, "정상 운영");
  assert.ok(strip.textContent.includes("자동추적2개 운영 · 0개 대기 · 0개 확인"));
  assert.ok(strip.textContent.includes("최근 갱신") && strip.textContent.includes("다음 갱신") && strip.textContent.includes("하루 2회 자동 갱신 · 08~23시"));
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-group]").length, 2);
  // 사용 방법(보조 상자의 첫 줄, 접힘). 지금 확인 칸이 없는 화면은 자동 수집 설명을 쓴다.
  const guide = screen.host.querySelector("[data-coupang-rank-guide]");
  assert.equal(guide.tagName, "DETAILS");
  assert.equal(guide.open, false);
  assert.equal(guide.querySelectorAll("li").length, 9);
  assert.ok(guide.textContent.includes("하루 2회, 08~23시"));
  assert.ok(guide.textContent.includes("칸을 누르면(키보드는 화살표로 옮기고 Enter) 그날 기록이 카드 아래 한 줄에 보입니다"));
  assert.ok(guide.textContent.includes("'오늘 안 함'은 일시중지가 아니면서 오늘 아직 확인하지 않은 상품입니다"));
  assert.ok(!guide.textContent.includes("즉시 갱신 버튼은 없습니다"));
  assert.equal(screen.host.querySelector("[data-coupang-rank-owner]").hidden, false);
  // 캐시: 같은 접두사의 다른 범위 키는 지우고, N30 캐시는 건드리지 않는다.
  const saved = storage.dump();
  assert.ok(saved["miCoupangRank:v1:owner:mml93-a01"]);
  assert.equal(saved["miCoupangRank:v1:owner:other"], undefined);
  assert.equal(saved["miRankTrackerLastGood:v1:x"], "keep");
  const cached = JSON.parse(saved["miCoupangRank:v1:owner:mml93-a01"]);
  assert.ok(cached.savedAt > 0 && cached.payload.trackers.length === 2);
});

test("광고주 안내 문구 칸·복사 동작은 없다(대표 결정 2026-10-23: 칸 삭제)", async () => {
  const screen = mountWith();
  screen.controller.show();
  await flush();
  assert.equal(screen.host.querySelectorAll('[data-coupang-rank-action="template-fill"]').length, 0);
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-template-text]").length, 0);
  assert.doesNotMatch(moduleSource, /template-fill|templateText|광고주 안내 문구/u);
  assert.doesNotMatch(cssSource, /mi-coupang-rank-template/u);
});

test("캐시로 먼저 그리고, 부분 목록(complete=false)이면 이전 목록을 유지한다", async () => {
  const storage = makeStorage({
    "miCoupangRank:v1:owner:mml93-a01": JSON.stringify({ savedAt: Date.now(), payload: listPayload() }),
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const screen = mountWith({
    storage,
    fetch: async () => {
      await gate;
      return response(listPayload({ complete: false, hasMore: true, totalCount: 600, trackers: [trackerFixture({ id: "6c1f0000-0000-4000-8000-0000000000ff", keyword: "새 목록" })] }));
    },
  });
  screen.controller.show();
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 2, "캐시로 먼저 그린다");
  release();
  await flush();
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 2, "부분 목록으로 바꾸지 않는다");
  assert.ok(!screen.host.textContent.includes("새 목록"));
  assert.ok(screen.host.textContent.includes("목록 일부만 받아 화면을 바꾸지 않았습니다"));
});

test("캐시는 12시간이 지났거나 범위가 다르면 버린다", async () => {
  const stale = makeStorage({ "miCoupangRank:v1:owner:mml93-a01": JSON.stringify({ savedAt: Date.now() - 13 * 3600 * 1000, payload: listPayload() }) });
  const screen = mountWith({ storage: stale, fetch: () => new Promise(() => {}) });
  screen.controller.show();
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 0);
  assert.equal(stale.getItem("miCoupangRank:v1:owner:mml93-a01"), null);
  const wrong = makeStorage({ "miCoupangRank:v1:owner:mml93-a01": JSON.stringify({ savedAt: Date.now(), payload: listPayload({ scopeAgencyCode: "other-a01" }) }) });
  const second = mountWith({ storage: wrong, fetch: () => new Promise(() => {}) });
  second.controller.show();
  assert.equal(second.host.querySelectorAll("[data-coupang-rank-card]").length, 0);
});

test("범위가 다른 응답은 그리지 않는다", async () => {
  const screen = mountWith({ payload: listPayload({ scopeAgencyCode: "other-a01" }) });
  screen.controller.show();
  await flush();
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 0);
  assert.ok(screen.host.textContent.includes("받은 목록의 범위가 지금 대상과 달라 화면을 바꾸지 않았습니다"));
});

test("목록 요청이 연결 실패로 던지면 한 번만 다시 시도한다", async () => {
  const screen = mountWith({
    fetch: async (url, init, count) => {
      if (count === 1) throw new Error("API 요청 시간이 초과되었습니다.");
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  assert.equal(screen.calls.length, 2);
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 2);
});

test("대표 SQL 전(setupRequired)이면 띠가 '설정 필요'이고 등록 폼을 숨긴다", async () => {
  const screen = mountWith({ payload: { ok: true, setupRequired: true, trackers: [], returnedCount: 0, totalCount: 0, hasMore: false, complete: true, collector: { state: "setup_required" } } });
  screen.controller.show();
  await flush();
  assert.ok(screen.host.querySelector("[data-coupang-rank-strip]").textContent.includes("대표 SQL 실행 전입니다(설정 필요)"));
  assert.equal(screen.host.querySelector("[data-coupang-rank-form]").hidden, true);
});

test("readonly 모드는 쓰기 버튼·등록 폼·총관리자 패널이 없고 띠는 광고주 문구다", async () => {
  const teamScope = { key: "team:c1", role: "team", agencyCode: "", clientId: "c1" };
  const screen = mountWith({ mode: "readonly", isOwner: false, scope: teamScope, payload: listPayload({ scopeMode: "advertiser", scopeClientId: "c1", readOnly: true, limit: null }) });
  screen.controller.show();
  await flush();
  assert.equal(screen.calls[0].init.headers["x-mi-agency-code"], undefined, "총관리자가 아니면 대상 머리글을 붙이지 않는다");
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 2);
  assert.equal(screen.host.querySelector("[data-coupang-rank-form]").hidden, true);
  assert.equal(screen.host.querySelector("[data-coupang-rank-owner]").hidden, true);
  assert.equal(screen.host.querySelectorAll('[data-coupang-rank-action="delete"]').length, 0);
  assert.equal(screen.host.querySelectorAll('[data-coupang-rank-action="pause"]').length, 0);
  assert.equal(screen.host.querySelector("[data-coupang-rank-strip-status]").textContent, "정상", "요약칸 알약은 광고주용 문구");
  // 읽기 전용은 등록 줄과 한도 알약만 숨긴다. 상태줄은 결과 문구가 있을 때만 보인다.
  assert.equal(screen.host.querySelector("[data-coupang-rank-limit]").hidden, true);
  assert.equal(screen.host.querySelector("[data-coupang-rank-status]").hidden, true);
  const card = screen.host.querySelector("[data-coupang-rank-card]");
  assert.deepEqual(card.querySelector(".mi-rank-row-actions").children.map((node) => node.textContent), ["현재 28위", "30일 최고 25위"]);
  assert.equal(card.querySelectorAll('[data-coupang-rank-action="group-edit"]').length, 0);
  assert.equal(card.querySelectorAll('[data-coupang-rank-action="runs"]').length, 1, "측정 기록은 읽기 전용에서도 본다");
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-box]").hidden, true, "읽기 전용에는 지금 확인 상태판이 없다");
  // 선택 항목 정리: 화면에 보이는 버튼만(조상 중 하나라도 숨으면 안 보임). 고르기 전에는 '보이는 항목 전체 선택'만, 고르면 이미지 저장·선택 해제.
  const bulk = screen.host.querySelector("[data-coupang-rank-bulk]");
  // 겹친 칸에서 감춘 동작 줄(aria-hidden)과 휴대폰 전용 아래 막대 머리(넓은 화면 CSS 는 숨김)도 안 보이는 것으로 센다.
  const shown = () => bulk.querySelectorAll("button").filter((node) => {
    for (let current = node; current && current !== bulk; current = current.parentNode) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true" || current.classList.contains("mi-coupang-rank-bulk-dock-head")) return false;
    }
    return true;
  }).map((node) => node.textContent);
  assert.deepEqual(shown(), ["보이는 항목 전체 선택"]);
  assert.equal(bulk.querySelector(".mi-coupang-rank-bulk-hint").textContent, "카드를 체크하면 한 장의 이미지로 저장할 수 있습니다.");
  const check = screen.host.querySelector('[data-coupang-rank-select="6c1f0000-0000-4000-8000-000000000001"]');
  check.checked = true;
  dispatch(check, "change");
  assert.deepEqual(shown(), ["보이는 항목 전체 선택", "선택 이미지 저장", "선택 해제"]);
});

test("삭제는 'n개와 30일 기록이 지워집니다' 확인을 거치고, 취소하면 요청하지 않는다", async () => {
  let answer = false;
  const screen = mountWith({ confirm: () => answer });
  screen.controller.show();
  await flush();
  const first = screen.host.querySelector('[data-coupang-rank-select="6c1f0000-0000-4000-8000-000000000001"]');
  first.checked = true;
  dispatch(first, "change");
  const second = screen.host.querySelector('[data-coupang-rank-select="6c1f0000-0000-4000-8000-000000000002"]');
  second.checked = true;
  dispatch(second, "change");
  dispatch(screen.host.querySelector('[data-coupang-rank-action="bulk-delete"]'), "click");
  await flush();
  assert.match(screen.confirmCalls.at(-1), /^2개와 30일 기록이 지워집니다/);
  assert.equal(screen.calls.length, 1, "취소하면 POST 하지 않는다");
  answer = true;
  dispatch(screen.host.querySelector('[data-coupang-rank-action="bulk-delete"]'), "click");
  await flush();
  const post = screen.calls.find((call) => call.init.method === "POST");
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.init.body), { action: "delete", ids: ["6c1f0000-0000-4000-8000-000000000001", "6c1f0000-0000-4000-8000-000000000002"] });
  assert.equal(post.init.headers["content-type"], "application/json");
  assert.equal(post.init.headers["x-mi-agency-code"], "mml93-a01");
  assert.equal(post.init.timeoutMs, 20000);
});

test("등록: create 요청을 보내고 firstCheck 문구를 보여 준다", async () => {
  const created = trackerFixture({ id: "6c1f0000-0000-4000-8000-000000000003", keyword: "새 키워드", current: null, days: [] });
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") return response({ ok: true, firstCheck: "queued", tracker: created, limit: { used: 4, max: 100, globalUsed: 42, globalMax: 150, capacity: 60 } });
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  screen.host.querySelector("[data-coupang-rank-keyword]").value = "새 키워드";
  screen.host.querySelector("[data-coupang-rank-product-url]").value = "https://www.coupang.com/vp/products/123456";
  dispatch(screen.host.querySelector("[data-coupang-rank-create-form]"), "submit");
  await flush();
  const post = screen.calls.find((call) => call.init.method === "POST");
  assert.deepEqual(JSON.parse(post.init.body), { action: "create", keyword: "새 키워드", productUrl: "https://www.coupang.com/vp/products/123456" });
  // 이 목록은 자동 수집이 도는 상태(collector ok, 지금 확인 칸 없음)라 서버 firstCheck(queued) 문구를 그대로 쓴다.
  assert.equal(screen.host.querySelector("[data-coupang-rank-status]").textContent, "등록했습니다. 다음 수집 때(수집기가 켜져 있을 때) 첫 순위가 기록됩니다.");
  assert.equal(screen.host.querySelector("[data-coupang-rank-limit]").textContent, "추적 4 / 100개");
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 3);
});


test("총관리자 패널: 열면 view=collector 를 받고 60초마다 다시 받으며, 속도 올림은 확인 뒤 confirmRaise 로 보낸다", async () => {
  const posts = [];
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") {
        posts.push(JSON.parse(init.body));
        return response({ ok: false, code: "COUPANG_RAISE_NOT_ALLOWED", reasons: ["quiet_window_short"], blocked48h: 0, empty48h: 0, success48h: 50 }, 409);
      }
      if (String(url).includes("view=collector")) return response(collectorPayload());
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  // 화면 열기에서는 카드 '다음' 글자만 다시 계산하는 60초 타이머 하나가 걸린다(요청 없음).
  const intervalsBefore = screen.intervals.length;
  const details = screen.host.querySelector("[data-coupang-rank-owner]");
  details.open = true;
  dispatch(details, "toggle");
  await flush();
  assert.ok(screen.calls.some((call) => call.url === `${COUPANG_TRACKERS_PATH}?view=collector` && call.init.headers["x-mi-agency-code"] === "mml93-a01"));
  assert.equal(screen.intervals.length, intervalsBefore + 1, "패널을 열면 60초 다시 받기 타이머가 하나 더 걸린다");
  assert.equal(screen.intervals.at(-1).ms, 60000);
  const panelText = details.textContent;
  for (const expected of ["수집 꺼짐", "하루 최대 측정 120회 → 하루 2번이면 키워드 약 60개 · 지금 활성 41개", "연결 해제·해지된 범위의 활성 추적기 2개(수집·한도에서 제외, 다시 연결되면 자동 재개)",
    "윈도우 데스크탑", "끝 4자리 x9Qa", "연결 없음", "제거 뒤 연결 코드도 폐기하세요", "전체 한도를 60으로 맞추기", "윈도우 설치·업데이트(관리자 PowerShell)", "맥 제거(터미널)"]) {
    assert.ok(panelText.includes(expected), expected);
  }
  assert.equal(details.querySelectorAll('[data-coupang-rank-action="line-copy"]').length, 6);
  // 운영팀·광고주 공개 켜기는 없다(대표 결정 2026-10-23: 총관리자 전용).
  assert.equal(details.querySelector('[data-coupang-rank-setting="teamAccessEnabled"]'), null);
  assert.equal(details.querySelector('[data-coupang-rank-setting="clientViewEnabled"]'), null);
  for (const removed of ["운영팀 공개", "광고주 공개", "운영팀 메뉴", "광고주 읽기 화면"]) assert.ok(!panelText.includes(removed), removed);
  // 시간당 12 → 24 로 올림: 확인 창에 48시간 수치를 보여 주고 confirmRaise:true 로 보낸다.
  const input = details.querySelector('[data-coupang-rank-setting="maxRunsPerHour"]');
  input.value = "24";
  dispatch(input, "input");
  dispatch(details.querySelector("[data-coupang-rank-settings-form]"), "submit");
  await flush();
  const confirmText = screen.confirmCalls.at(-1);
  assert.match(confirmText, /48시간 차단 0 · 빈 쪽 0 · 성공 50회 · 마지막 상향 뒤 \d+시간/);
  assert.match(confirmText, /다음 단계: 시간당 24회/);
  assert.deepEqual(posts.at(-1), { action: "settings-update", settings: { maxRunsPerHour: 24 }, confirmRaise: true });
  assert.ok(details.textContent.includes("지금은 속도를 올릴 수 없습니다: 마지막 속도 변경 뒤 48시간이 지나지 않았습니다"));
  // 실패하면 입력한 값이 그대로 남는다(다시 받기로 지우지 않음).
  assert.equal(details.querySelector('[data-coupang-rank-setting="maxRunsPerHour"]').value, "24");
  // 범위 오류는 칸 아래에 띄우고 보내지 않는다.
  const before = posts.length;
  details.querySelector('[data-coupang-rank-setting="checksPerDay"]').value = "9";
  dispatch(details.querySelector("[data-coupang-rank-settings-form]"), "submit");
  await flush();
  assert.equal(posts.length, before);
  assert.equal(details.querySelector('[data-coupang-rank-field-error="checksPerDay"]').hidden, false);
  // 수집 끄기·켜기·쉬는 중 해제는 확인을 거친다.
  dispatch(details.querySelector('[data-coupang-rank-action="collector-enable"]'), "click");
  await flush();
  assert.match(screen.confirmCalls.at(-1), /수집을 켭니다/);
  assert.deepEqual(posts.at(-1), { action: "collector-enable" });
  // 패널을 닫으면 새로 받기를 멈춘다(원문 코드도 지움).
  details.open = false;
  dispatch(details, "toggle");
  screen.controller.destroy();
});

test("연결 코드 원문은 한 번만 보이고 캐시에 남지 않는다", async () => {
  const storage = makeStorage();
  const token = "mic1_" + "A".repeat(43);
  const screen = mountWith({
    storage,
    fetch: async (url, init) => {
      if (init.method === "POST") return response({ ok: true, id: "c2", label: "맥 미니", token, tokenHint: "AAAA" });
      if (String(url).includes("view=collector")) return response(collectorPayload());
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  const details = screen.host.querySelector("[data-coupang-rank-owner]");
  details.open = true;
  dispatch(details, "toggle");
  await flush();
  details.querySelector("[data-coupang-rank-token-label]").value = "맥 미니";
  dispatch(details.querySelector("[data-coupang-rank-token-form]"), "submit");
  await flush();
  const box = details.querySelector("[data-coupang-rank-token-box]");
  assert.equal(box.hidden, false);
  assert.equal(box.querySelector("input").value, token);
  assert.ok(box.textContent.includes("이 창을 닫으면 다시 볼 수 없습니다. 수집기 PC의 설치 창에만 붙여 넣으세요"));
  assert.ok(!JSON.stringify(storage.dump()).includes(token));
  details.open = false;
  dispatch(details, "toggle");
  assert.equal(details.querySelector("[data-coupang-rank-token-box]").hidden, true);
  assert.equal(details.querySelector("[data-coupang-rank-token-box]").textContent, "");
  screen.controller.destroy();
});

test("루트에 is-locked 가 붙으면 스스로 reset 하고 캐시를 지운다", async () => {
  let observerCallback = null;
  class FakeMutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const storage = makeStorage();
  const screen = mountWith({ storage, MutationObserver: FakeMutationObserver });
  screen.controller.show();
  await flush();
  assert.ok(screen.host.querySelectorAll("[data-coupang-rank-card]").length > 0);
  assert.ok(storage.getItem("miCoupangRank:v1:owner:mml93-a01"));
  screen.root.classList.add("is-locked");
  observerCallback([]);
  assert.equal(screen.host.childNodes.length, 0);
  assert.equal(storage.getItem("miCoupangRank:v1:owner:mml93-a01"), null);
});

test("scopeChanged 는 화면이 보일 때만 다시 받는다", async () => {
  const clock = { now: Date.now() };
  const screen = mountWith({ clock });
  screen.controller.show();
  await flush();
  // 방금(2초 안) 받은 같은 범위 목록은 다시 받지 않으므로, 합치기 창이 지난 뒤를 본다.
  clock.now += 3000;
  const count = screen.calls.length;
  screen.view.classList.remove("is-active");
  screen.controller.scopeChanged();
  await flush();
  assert.equal(screen.calls.length, count);
  screen.view.classList.add("is-active");
  screen.controller.scopeChanged();
  await flush();
  assert.equal(screen.calls.length, count + 1);
});

// ── N30 틀 맞춤(2026-10-16): 상품번호 한 번·다음 정지·그룹 해제·미분류 ─────────────

const TITLELESS_ID = "6c1f0000-0000-4000-8000-000000000001";

test("상품명이 아직 없으면 상품번호는 '상품정보 · 번호' 한 번만, 상품명 자리는 '상품 페이지 열기'(카드·이미지 시트)", async () => {
  layout.sheetHeight = 900;
  const record = { sheets: [] };
  let screen;
  const tools = {
    ensureStage() { return record.stage || (record.stage = screen.document.createElement("div")); },
    serialize(sheet) { record.sheets.push(sheet); return "<div xmlns=\"http://www.w3.org/1999/xhtml\"></div>"; },
    toBlob: async () => ({ blob: new Blob(["x"]), ext: "png" }),
    showReady() { return screen.document.createElement("a"); },
  };
  screen = mountWith({ exportTools: tools, payload: listPayload({ trackers: [trackerFixture({ productTitle: null })] }) });
  screen.controller.show();
  await flush();
  const card = screen.host.querySelector("[data-coupang-rank-card]");
  assert.equal(card.textContent.split("8533720933").length - 1, 1);
  const title = card.querySelector("a.mi-rank-product-title");
  assert.equal(title.textContent, "상품 페이지 열기");
  assert.equal(title.getAttribute("href"), "https://www.coupang.com/vp/products/8533720933");
  assert.equal(title.getAttribute("title"), "상품명은 검색 1쪽에서 이 상품을 찾은 뒤 채워집니다");
  const check = screen.host.querySelector(`[data-coupang-rank-select="${TITLELESS_ID}"]`);
  check.checked = true;
  dispatch(check, "change");
  dispatch(screen.host.querySelector('[data-coupang-rank-action="bulk-export"]'), "click");
  await flush();
  const sheetText = record.sheets[0].textContent;
  assert.equal(sheetText.split("8533720933").length - 1, 1, "시트에도 상품번호는 한 번만");
  assert.ok(sheetText.includes("상품정보 · 8533720933"));
});

test("자동 수집이 꺼져 있으면 카드에 '다음' 알약이 없고(늘 '정지'라 소음), 지금 확인 상태판이 없는 화면은 요약칸이 '수집 꺼짐'", async () => {
  const payload = listPayload({ collector: { state: "disabled", lastSuccessAt: null, checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: null } });
  payload.trackers.forEach((tracker) => { tracker.nextCheckState = "due"; tracker.nextCheckAt = "2026-10-17T01:00:00.000Z"; });
  const screen = mountWith({ payload });
  screen.controller.show();
  await flush();
  for (const card of screen.host.querySelectorAll("[data-coupang-rank-card]")) {
    assert.equal(card.querySelectorAll("[data-coupang-rank-next]").length, 0, card.textContent);
    assert.ok(!card.textContent.includes("다음 정지") && !card.textContent.includes("다음 대기"));
    assert.equal(card.querySelectorAll(".is-wait").length, 0);
  }
  // 지금 확인 상태판이 없는 화면(서버 manual 칸 없음)은 예전처럼 자동추적 칸을 둔다(상태가 아무 데도 없지 않게).
  const strip = screen.host.querySelector("[data-coupang-rank-strip]");
  assert.equal(strip.hidden, false);
  assert.equal(strip.querySelector("[data-coupang-rank-strip-status]").textContent, "수집 꺼짐");
  assert.ok(strip.textContent.includes("다음 갱신정지"));
});

test("자동 수집이 돌고 대기 중인 카드는 '다음 대기' 알약이 대기(is-wait) 색이다('상태 운영중' 알약은 없다)", async () => {
  const payload = listPayload();
  payload.trackers[0].nextCheckState = "due";
  const screen = mountWith({ payload });
  screen.controller.show();
  await flush();
  const card = screen.host.querySelector("[data-coupang-rank-card]");
  assert.equal(card.querySelector(".is-wait").textContent, "다음 대기");
  assert.ok(!card.textContent.includes("상태 운영중"));
});

test("일시중지 카드: '일시중지 · MM-DD부터', 마지막 확인, '다시 시작' 버튼, 다음 '-'", async () => {
  const payload = listPayload({ trackers: [trackerFixture({ status: "paused", pausedAt: "2026-10-16T05:00:00.000Z", pausedDay: "2026-10-16", nextCheckState: "paused", nextCheckAt: null })] });
  const screen = mountWith({ payload });
  screen.controller.show();
  await flush();
  const card = screen.host.querySelector("[data-coupang-rank-card]");
  assert.ok(card.classList.contains("is-paused"));
  const ops = card.querySelector(".mi-rank-ops-row");
  assert.equal(ops.children[0].textContent, "일시중지 · 10-16부터");
  assert.ok(ops.textContent.includes("마지막 확인 10-17 11:11"), ops.textContent);
  assert.ok(!ops.textContent.includes("오늘 아직"), "일시중지 카드는 '오늘 아직'으로 재촉하지 않는다");
  assert.ok(card.textContent.includes("다음 -"));
  assert.deepEqual(card.querySelector(".mi-rank-row-actions").children.map((node) => node.textContent), ["현재 28위", "30일 최고 25위", "다시 시작삭제"]);
});

test("'다음'은 응답 없음·광고주 화면에서 요약칸과 같은 말을 쓴다", () => {
  const now = Date.parse("2026-10-17T07:00:00.000Z");
  const due = { nextCheckState: "due", nextCheckAt: "2026-10-17T01:00:00.000Z" };
  const soon = { nextCheckState: "scheduled", nextCheckAt: "2026-10-17T07:41:00.000Z" };
  const next = (tracker, state, mode) => internals.nextCheckText(tracker, state, now, mode);
  // 관리자: 수집기 응답이 없으면 예정이 지난 항목은 '응답 대기'(요약칸 '응답 없음'), 남은 시간은 그대로.
  assert.equal(next(due, "offline"), "응답 대기");
  assert.equal(next({ nextCheckState: "scheduled", nextCheckAt: "2026-10-17T06:00:00.000Z" }, "offline"), "응답 대기");
  assert.equal(next(soon, "offline"), "41분");
  assert.equal(next(due, "delayed"), "대기");
  // 광고주(읽기 전용): 내부 상태 대신 광고주 문구.
  for (const state of ["disabled", "review", "budget", "outdated", "not_connected", "cooldown"]) {
    assert.equal(next(due, state, "readonly"), "일시 중단", state);
  }
  assert.equal(next(due, "setup_required", "readonly"), "설정 필요");
  assert.equal(next(due, "offline", "readonly"), "갱신 대기");
  assert.equal(next(soon, "ok", "readonly"), "41분");
  assert.equal(next({ status: "paused", nextCheckState: "paused" }, "review", "readonly"), "-");
  // 요약칸 '다음 갱신'도 광고주 화면에서는 같은 문구(내부 '정지'·'쉬는 중 ~시각'을 보이지 않음).
  const base = { lastSuccessAt: "2026-10-17T02:11:05.000Z", checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: "2026-10-17T09:30:00.000Z" };
  const metric = (state, mode) => internals.autoSummary({ ...base, state }, [soon], { mode }).metrics[1];
  assert.deepEqual([metric("review", "readonly").value, metric("review", "readonly").tone], ["일시 중단", "is-warn"]);
  assert.deepEqual([metric("cooldown", "readonly").value, metric("cooldown", "readonly").tone], ["일시 중단", "is-warn"]);
  assert.deepEqual([metric("setup_required", "readonly").value, metric("setup_required", "readonly").tone], ["설정 필요", "is-warn"]);
  assert.deepEqual([metric("review", "admin").value, metric("review", "admin").tone], ["정지", "is-error"]);
  assert.match(metric("cooldown", "admin").value, /^쉬는 중 ~/);
});

test("응답 없음(offline)이면 예정이 지난 카드는 '다음 응답 대기'이고 대기(is-wait) 파랑을 쓰지 않는다", async () => {
  const payload = listPayload({ collector: { state: "offline", lastSuccessAt: "2026-10-17T02:11:05.000Z", checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: null } });
  payload.trackers[0].nextCheckState = "due";
  payload.trackers[0].nextCheckAt = "2026-10-17T01:00:00.000Z";
  const screen = mountWith({ payload });
  screen.controller.show();
  await flush();
  const card = screen.host.querySelector("[data-coupang-rank-card]");
  assert.ok(card.textContent.includes("다음 응답 대기"), card.textContent);
  assert.equal(card.querySelectorAll(".is-wait").length, 0);
  assert.equal(screen.host.querySelector("[data-coupang-rank-strip-status]").textContent, "응답 없음");
});

test("카드 '다음' 남은 시간은 60초마다 다시 계산한다(목록 요청 없음, 숨은 탭은 건너뜀)", async () => {
  const clock = { now: Date.parse("2026-10-17T07:00:00.000Z") };
  const screen = mountWith({ clock, payload: listPayload({ trackers: [trackerFixture()] }) });
  screen.controller.show();
  await flush();
  const nextText = () => screen.host.querySelector("[data-coupang-rank-next]").textContent;
  const statePill = () => screen.host.querySelector("[data-coupang-rank-next]");
  assert.equal(nextText(), "다음 41분");
  assert.equal(statePill().classList.contains("is-wait"), false);
  const ticker = screen.intervals.find((entry) => entry.ms === 60000);
  assert.ok(ticker, "화면 열기에서 60초 타이머가 걸린다");
  const gets = screen.calls.length;
  clock.now = Date.parse("2026-10-17T07:20:30.000Z");
  ticker.fn();
  assert.equal(nextText(), "다음 21분");
  // 숨은 탭에서는 바꾸지 않는다.
  screen.document.hidden = true;
  clock.now = Date.parse("2026-10-17T09:30:00.000Z");
  ticker.fn();
  assert.equal(nextText(), "다음 21분");
  screen.document.hidden = false;
  ticker.fn();
  assert.equal(nextText(), "다음 대기");
  assert.equal(statePill().classList.contains("is-wait"), true, "예정 시각이 지나면 N30 처럼 대기 파랑");
  assert.equal(screen.calls.length, gets, "다시 계산은 요청을 보내지 않는다");
  // 다시 열어도 타이머는 하나다.
  screen.controller.show();
  await flush();
  assert.equal(screen.intervals.filter((entry) => entry.ms === 60000).length, 1);
});

test("30일 넘게 기록이 없는 옛 추적: '첫 순위 확인' 안내 대신 '-' 칸, 옛 값으로 판정하지 않는다", async () => {
  const old = trackerFixture({
    status: "paused", pausedAt: "2026-08-20T05:00:00.000Z", pausedDay: "2026-08-20", createdAt: "2026-07-01T03:00:00.000Z", createdDay: "2026-07-01",
    nextCheckState: "paused", nextCheckAt: null,
    current: { result: "found", rank: 5, organicCount: 50, adOrder: null, sameOption: true, checkedAt: "2026-08-19T02:00:00.000Z" },
    summary: { best30: null, avg7: null, foundDays7: 0, measuredDays7: 0, trend: "new", trendDelta: null, attention: false, attentionReasons: [], lastFoundAt: "2026-08-19T02:00:00.000Z" },
    days: [],
  });
  // 판정·안내 규칙(순수 함수)
  assert.deepEqual(JSON.parse(JSON.stringify(internals.verdictPills(old, days30()))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(internals.verdictPills({ ...old, status: "active" }, days30()))), [], "마지막 측정이 30일 창 밖");
  assert.deepEqual(JSON.parse(JSON.stringify(internals.verdictPills({ ...old, status: "active", current: { ...old.current, checkedAt: "2026-10-17T02:00:00.000Z" } }, days30()))),
    [{ text: "상위권 유지", tone: "is-ok" }], "창 안이면 N30 규칙 그대로");
  assert.deepEqual(JSON.parse(JSON.stringify(internals.verdictPills({ ...old, summary: { ...old.summary, attention: true, attentionReasons: ["keyword_failing"] } }, days30()))),
    [{ text: "이 키워드 측정이 연속 실패", tone: "is-error" }], "서버 확인 사유는 일시중지여도 보인다(확인 필요 개수와 같은 기준)");
  assert.equal(internals.emptyBoardText(old, days30()), "");
  assert.equal(internals.emptyBoardText({ ...old, current: null, summary: { trend: "new", attentionReasons: [] } }, days30()), "첫 순위 확인 후 이 상품만의 일별 기록판이 생성됩니다.");
  assert.equal(internals.emptyBoardText({ ...old, createdDay: "" }, []), "최근 30일 측정 기록이 없습니다.");
  // 화면
  const screen = mountWith({ payload: listPayload({ trackers: [old] }) });
  screen.controller.show();
  await flush();
  const card = screen.host.querySelector("[data-coupang-rank-card]");
  assert.ok(!card.textContent.includes("첫 순위 확인 후"), card.textContent);
  const cells = card.querySelectorAll(".mi-rank-day-card");
  assert.equal(cells.length, 30, "등록이 30일보다 오래됐으면 30칸 모두 '-'");
  assert.ok(cells.every((cell) => cell.querySelector("b").textContent === "-"));
  assert.equal(card.querySelectorAll(".mi-rank-insight-pill").length, 0, "판정 알약 없음");
});

test("확인 필요 사유는 판정 자리 알약으로(따로 있던 경고 상자 없음)", async () => {
  const payload = listPayload({ trackers: [trackerFixture({ current: { result: "out", organicCount: 50, adOrder: null, sameOption: null, checkedAt: "2026-10-17T02:11:05.000Z" },
    summary: { best30: 25, avg7: null, foundDays7: 0, measuredDays7: 2, trend: "exit", trendDelta: null, attention: true, attentionReasons: ["exit"], lastFoundAt: null } })] });
  const screen = mountWith({ payload });
  screen.controller.show();
  await flush();
  const card = screen.host.querySelector("[data-coupang-rank-card]");
  const pills = card.querySelectorAll(".mi-rank-insight-pill");
  assert.deepEqual(pills.map((node) => [node.textContent, node.classList.contains("is-error")]), [["50위 밖으로 이탈", true]]);
  // 이탈은 한 번만: 판정 알약이 '50위 밖으로 이탈'이면 같은 뜻의 '전회 대비 50위 밖 이탈'은 두지 않는다. '현재'는 빨간 테두리.
  assert.ok(card.textContent.includes("현재 50위 밖"));
  assert.ok(!card.textContent.includes("전회 대비 50위 밖 이탈"));
  assert.ok(card.querySelector(".mi-coupang-rank-current").classList.contains("is-out"));
  assert.equal(card.querySelectorAll(".mi-coupang-rank-attention").length, 0);
  assert.equal(screen.host.querySelector("[data-coupang-rank-strip-status]").textContent, "확인 필요");
});

test("50위 밖이 이어지는 카드: 판정 자리 '점검 필요'(빨강) · 요약칸 확인 필요 1개 · '확인 필요' 필터가 서로 맞는다(대표 결정 2026-10-17)", async () => {
  const outTracker = trackerFixture({
    id: "6c1f0000-0000-4000-8000-000000000003", keyword: "강화유리 보호필름", groupName: "필름",
    current: { result: "out", organicCount: 50, adOrder: null, sameOption: null, checkedAt: "2026-10-17T02:11:05.000Z" },
    summary: { best30: 32, avg7: 42, foundDays7: 1, measuredDays7: 2, trend: "same", trendDelta: null, attention: false, attentionReasons: [], lastFoundAt: "2026-10-11T10:00:00.000Z" },
    days: [{ d: "2026-10-17", s: "out", r: null, n: 50, a: null, t: "11:11", c: 1, f: 0, b: null, k: 0 }, { d: "2026-10-16", s: "out", r: null, n: 50, a: null, t: "19:02", c: 2, f: 0, b: null, k: 1 }],
  });
  const screen = mountWith({ payload: listPayload({ trackers: [trackerFixture(), outTracker] }) });
  screen.controller.show();
  await flush();
  const host = screen.host;
  const card = host.querySelector('[data-coupang-rank-id="6c1f0000-0000-4000-8000-000000000003"][data-coupang-rank-card]');
  const pills = card.querySelectorAll(".mi-rank-insight-pill");
  assert.deepEqual(pills.map((node) => [node.textContent, node.classList.contains("is-error")]), [["점검 필요", true]]);
  assert.ok(card.textContent.includes("현재 50위 밖") && card.textContent.includes("전회 대비 변동 없음"));
  const strip = host.querySelector("[data-coupang-rank-strip]");
  assert.equal(strip.querySelector("[data-coupang-rank-strip-status]").textContent, "확인 필요");
  assert.ok(strip.textContent.includes("2개 운영 · 0개 대기 · 1개 확인"), strip.textContent);
  const metric = strip.querySelectorAll(".mi-rank-auto-metric")[2];
  assert.equal(metric.querySelector("strong").textContent, "1개");
  assert.ok(metric.classList.contains("is-error"));
  dispatch(host.querySelector('[data-coupang-rank-filter-status="attention"]'), "click");
  assert.deepEqual(host.querySelectorAll("[data-coupang-rank-card]").map((node) => node.getAttribute("data-coupang-rank-id")), ["6c1f0000-0000-4000-8000-000000000003"]);
  assert.equal(host.querySelector("[data-coupang-rank-filter-count]").textContent, "2개 중 1개 표시");
  // 대표 결정 2026-10-23: '점검 필요' 알약은 그대로 두고, '현재'도 빨간 테두리로 보인다.
  assert.ok(card.querySelector(".mi-coupang-rank-current").classList.contains("is-out"));
  assert.equal(host.querySelector('[data-coupang-rank-filter-status="attention"]').textContent, "확인 필요 1");
});

test("그룹 필터를 건 채 '선택 항목 정리' 그룹명 입력칸·카드 그룹 변경 칸의 change 는 그룹 필터를 풀지 않고, '그룹 생성/적용' 첫 클릭이 그대로 보낸다(N30 결함 확인, 대표 결정 2026-10-17)", async () => {
  const posts = [];
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") {
        posts.push(JSON.parse(init.body));
        return response({ ok: true, updated: JSON.parse(init.body).ids.length });
      }
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  const host = screen.host;
  const groupFilter = host.querySelector("[data-coupang-rank-filter-group]");
  groupFilter.value = "필름";
  dispatch(groupFilter, "change");
  const filmId = "6c1f0000-0000-4000-8000-000000000002";
  const check = host.querySelector(`[data-coupang-rank-select="${filmId}"]`);
  check.checked = true;
  dispatch(check, "change");
  const cardBefore = host.querySelector(`[data-coupang-rank-card][data-coupang-rank-id="${filmId}"]`);
  // 카드 '그룹 변경' 칸을 열어 적고 change 를 낸다(칸에서 나갈 때 브라우저가 내는 change).
  dispatch(host.querySelector(`[data-coupang-rank-action="group-edit"][data-coupang-rank-id="${filmId}"]`), "click");
  const editInput = host.querySelector(`[data-coupang-rank-group-edit-input="${filmId}"]`);
  editInput.value = "다른 그룹";
  dispatch(editInput, "change");
  assert.equal(host.querySelector(`[data-coupang-rank-group-edit-input="${filmId}"]`), editInput, "카드를 다시 그리지 않는다");
  assert.equal(host.querySelector("[data-coupang-rank-filter-group]").value, "필름");
  dispatch(host.querySelector(`[data-coupang-rank-action="group-cancel"][data-coupang-rank-id="${filmId}"]`), "click");
  // 선택 항목 정리의 그룹명 입력칸
  const input = host.querySelector("[data-coupang-rank-bulk-group-input]");
  input.value = "새 그룹";
  dispatch(input, "change");
  assert.equal(host.querySelector("[data-coupang-rank-filter-group]").value, "필름", "그룹 필터가 그대로다");
  assert.deepEqual(host.querySelectorAll("[data-coupang-rank-card]").map((node) => node.getAttribute("data-coupang-rank-id")), [filmId], "목록이 전체로 풀리지 않는다");
  assert.equal(host.querySelector("[data-coupang-rank-selected-count]").textContent, "1개 선택");
  assert.ok(cardBefore, "필터 결과 카드가 있었다");
  dispatch(host.querySelector('[data-coupang-rank-action="bulk-group"]'), "click");
  await flush();
  assert.deepEqual(posts, [{ action: "group", ids: [filmId], groupName: "새 그룹" }], "첫 클릭 한 번에 보낸다");
  // 결과는 누른 자리(선택 항목 정리 막대 안 한 줄)에. 선택을 비워 막대가 한 줄로 접혀도 결과 줄은 보인다.
  const note = host.querySelector("[data-coupang-rank-bulk-note]");
  assert.equal(note.textContent, "1개 추적 항목을 새 그룹 그룹으로 넣고 전체 그룹으로 돌아왔습니다.");
  assert.equal(note.hidden, false);
  assert.equal(note.getAttribute("aria-live"), "polite");
  assert.equal(host.querySelector("[data-coupang-rank-bulk-actions]").getAttribute("aria-hidden"), "true", "선택을 비워 막대는 접혔다");
  assert.equal(host.querySelector("[data-coupang-rank-bulk]").classList.contains("is-open"), false);
  assert.equal(host.querySelector("[data-coupang-rank-status]").hidden, true, "성공은 맨 위 상태줄에 겹쳐 쓰지 않는다");
});

test("'그룹 해제'는 group 동작에 빈 그룹 이름을 보내고, 적용 뒤 선택·그룹 필터를 비운다", async () => {
  const posts = [];
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") {
        posts.push(JSON.parse(init.body));
        return response({ ok: true, updated: JSON.parse(init.body).ids.length });
      }
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  const host = screen.host;
  // 그룹 필터로 '필름'만 본 상태에서 하나를 골라 해제한다.
  const groupFilter = host.querySelector("[data-coupang-rank-filter-group]");
  groupFilter.value = "필름";
  dispatch(groupFilter, "change");
  assert.equal(host.querySelectorAll("[data-coupang-rank-card]").length, 1);
  dispatch(host.querySelector('[data-coupang-rank-action="bulk-ungroup"]'), "click");
  await flush();
  assert.deepEqual(posts, [], "선택이 없으면 보내지 않는다(버튼도 꺼져 있다)");
  const check = host.querySelector('[data-coupang-rank-select="6c1f0000-0000-4000-8000-000000000002"]');
  check.checked = true;
  dispatch(check, "change");
  dispatch(host.querySelector('[data-coupang-rank-action="bulk-ungroup"]'), "click");
  await flush();
  assert.deepEqual(posts, [{ action: "group", ids: ["6c1f0000-0000-4000-8000-000000000002"], groupName: "" }]);
  assert.equal(host.querySelector("[data-coupang-rank-bulk-note]").textContent, "1개 추적 항목을 그룹에서 해제했습니다.");
  assert.equal(host.querySelector("[data-coupang-rank-selected-count]").hidden, true, "선택을 비우면 'n개 선택'이 사라지고 막대가 한 줄로 접힌다");
  assert.equal(host.querySelectorAll("[data-coupang-rank-card]").length, 2, "전체 그룹으로 돌아온다");
});

test("'그룹 생성/적용': N30 과 같은 안내, '미분류'라고 적으면 그룹 해제와 같다", async () => {
  const posts = [];
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") {
        posts.push(JSON.parse(init.body));
        return response({ ok: true, updated: JSON.parse(init.body).ids.length });
      }
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  const host = screen.host;
  const pick = () => {
    const check = host.querySelector(`[data-coupang-rank-select="${TITLELESS_ID}"]`);
    check.checked = true;
    dispatch(check, "change");
  };
  pick();
  const input = host.querySelector("[data-coupang-rank-bulk-group-input]");
  assert.equal(input.getAttribute("placeholder"), "그룹명 선택 또는 입력");
  dispatch(host.querySelector('[data-coupang-rank-action="bulk-group"]'), "click");
  await flush();
  assert.equal(host.querySelector("[data-coupang-rank-bulk-note]").textContent, "만들거나 이동할 그룹명을 입력해주세요.");
  assert.ok(host.querySelector("[data-coupang-rank-bulk-note]").classList.contains("is-warn"));
  input.value = "A 업체";
  dispatch(host.querySelector('[data-coupang-rank-action="bulk-group"]'), "click");
  await flush();
  assert.deepEqual(posts.at(-1), { action: "group", ids: [TITLELESS_ID], groupName: "A 업체" });
  assert.equal(host.querySelector("[data-coupang-rank-bulk-note]").textContent, "1개 추적 항목을 A 업체 그룹으로 넣고 전체 그룹으로 돌아왔습니다.");
  assert.equal(input.value, "", "적용 뒤 입력을 비운다");
  pick();
  input.value = "미분류";
  dispatch(host.querySelector('[data-coupang-rank-action="bulk-group"]'), "click");
  await flush();
  assert.deepEqual(posts.at(-1), { action: "group", ids: [TITLELESS_ID], groupName: "" }, "'미분류'라는 그룹을 따로 만들지 않는다");
});

test("등록·그룹 변경 칸에 '미분류'를 적으면 기본 그룹으로 보낸다", async () => {
  const posts = [];
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        posts.push(body);
        return response(body.action === "create" ? { ok: true, firstCheck: "queued", tracker: trackerFixture({ id: "6c1f0000-0000-4000-8000-000000000009", keyword: "새 키워드" }) } : { ok: true, updated: 1 });
      }
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  const host = screen.host;
  host.querySelector("[data-coupang-rank-keyword]").value = "새 키워드";
  host.querySelector("[data-coupang-rank-product-url]").value = "https://www.coupang.com/vp/products/123456";
  host.querySelector("[data-coupang-rank-group-input]").value = "미분류";
  dispatch(host.querySelector("[data-coupang-rank-create-form]"), "submit");
  await flush();
  assert.deepEqual(posts.at(-1), { action: "create", keyword: "새 키워드", productUrl: "https://www.coupang.com/vp/products/123456" });
  // 그룹 변경: 기본 그룹이면 입력칸이 비어 있고 placeholder 는 '비우면 미분류'.
  dispatch(host.querySelector(`[data-coupang-rank-action="group-edit"][data-coupang-rank-id="${TITLELESS_ID}"]`), "click");
  const editor = host.querySelector("[data-coupang-rank-group-edit-input]");
  assert.equal(editor.value, "");
  assert.equal(editor.getAttribute("placeholder"), "비우면 미분류");
  editor.value = "미분류";
  dispatch(host.querySelector('[data-coupang-rank-action="group-save"]'), "click");
  await flush();
  assert.deepEqual(posts.at(-1), { action: "group", ids: [TITLELESS_ID], groupName: "" });
});

test("빈 칸 등록은 N30 과 같은 안내를 띄우고 보내지 않는다", async () => {
  const screen = mountWith();
  screen.controller.show();
  await flush();
  const before = screen.calls.length;
  dispatch(screen.host.querySelector("[data-coupang-rank-create-form]"), "submit");
  await flush();
  assert.equal(screen.host.querySelector("[data-coupang-rank-status]").textContent, "키워드를 입력해주세요.");
  screen.host.querySelector("[data-coupang-rank-keyword]").value = "필름";
  dispatch(screen.host.querySelector("[data-coupang-rank-create-form]"), "submit");
  await flush();
  assert.equal(screen.host.querySelector("[data-coupang-rank-status]").textContent, "쿠팡 상품 URL을 입력해주세요.");
  assert.ok(screen.host.querySelector("[data-coupang-rank-status]").classList.contains("is-warn"));
  assert.equal(screen.calls.length, before);
});

test("그룹 안 일부만 고르면 그룹 머리가 '전체 선택 (n/m)'으로 바뀐다", async () => {
  const payload = listPayload({ trackers: [trackerFixture(), trackerFixture({ id: "6c1f0000-0000-4000-8000-000000000002", keyword: "강화유리 필름" })] });
  const screen = mountWith({ payload });
  screen.controller.show();
  await flush();
  const check = screen.host.querySelector(`[data-coupang-rank-select="${TITLELESS_ID}"]`);
  check.checked = true;
  dispatch(check, "change");
  assert.equal(screen.host.querySelector(".mi-rank-group-select").textContent, "전체 선택 (1/2)");
  assert.equal(screen.host.querySelector("[data-coupang-rank-selected-count]").textContent, "1개 선택");
});

test("빈 목록·필터 0개 문구는 N30 과 같다", async () => {
  const empty = mountWith({ payload: listPayload({ trackers: [] }) });
  empty.controller.show();
  await flush();
  assert.equal(empty.host.querySelector("[data-coupang-rank-list]").textContent, "아직 등록한 상품이 없습니다. 위에 키워드와 쿠팡 상품 주소를 넣고 '순위 추적'을 누르세요.");
  assert.equal(empty.host.querySelector("[data-coupang-rank-strip]").hidden, false, "추적이 0개여도 수집기 상태는 보인다");
  const screen = mountWith();
  screen.controller.show();
  await flush();
  dispatch(screen.host.querySelector('[data-coupang-rank-filter-status="paused"]'), "click");
  assert.equal(screen.host.querySelector("[data-coupang-rank-list]").textContent, "조건에 맞는 순위 추적 항목이 없습니다. 검색어 또는 상태 필터를 조정해주세요.");
});

// ── 통합 검토 결함: 같은 목록 두 번 받기·500개 초과 막다른 화면 ─────────────

const LIST_URL = `${COUPANG_TRACKERS_PATH}?limit=500`;
const countCalls = (screen, match) => screen.calls.filter((call) => (typeof match === "string" ? String(call.url).includes(match) : match(call))).length;

test("메뉴 한 번(setScreen + hashchange 로 show 두 번)에 목록 GET 은 한 번만 나가고, 2초 안의 scopeChanged·show 도 다시 받지 않는다", async () => {
  const clock = { now: Date.now() };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const screen = mountWith({
    clock,
    fetch: async () => {
      await gate;
      return response(listPayload());
    },
  });
  const listCalls = () => countCalls(screen, (call) => call.url === LIST_URL);
  screen.controller.show(); // ① 메뉴 클릭 → setScreen → mountCoupangRank → show
  screen.controller.show(); // ② hashchange → setScreen → mountCoupangRank → show(첫 요청이 아직 받는 중)
  await flush();
  assert.equal(listCalls(), 1, "받는 중인 같은 범위 목록은 다시 보내지 않는다");
  release();
  await flush();
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 2, "합친 요청의 응답으로 그린다");
  // 세션 동기화: mi:rank-scope-changed → scopeChanged, mi:rank-auth-ready → show
  clock.now += 1500;
  screen.controller.scopeChanged();
  screen.controller.show();
  await flush();
  assert.equal(listCalls(), 1, "2초 안에 받은 같은 범위 목록은 다시 받지 않는다");
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 2, "다시 받지 않아도 화면은 그대로 그린다");
  // 2초가 지나면 다시 받는다.
  clock.now += 1000;
  screen.controller.show();
  await flush();
  assert.equal(listCalls(), 2);
  // 범위가 바뀌면 2초 안이어도 새 범위 목록을 받는다.
  screen.setScope({ key: "owner:other-a01", role: "owner", agencyCode: "other-a01", clientId: "" });
  screen.controller.show();
  await flush();
  assert.equal(listCalls(), 3);
});

test("총관리자 패널이 열린 채로 메뉴를 다시 열면(show 두 번) view=collector 도 한 번만 나간다", async () => {
  const clock = { now: Date.now() };
  const screen = mountWith({ clock });
  screen.controller.show();
  await flush();
  const details = screen.host.querySelector("[data-coupang-rank-owner]");
  details.open = true;
  dispatch(details, "toggle");
  await flush();
  assert.equal(countCalls(screen, "view=collector"), 1);
  clock.now += 3000; // 다른 화면에 갔다가 3초 뒤 메뉴로 돌아온다.
  screen.controller.show();
  screen.controller.show();
  await flush();
  assert.equal(countCalls(screen, (call) => call.url === LIST_URL), 2, "목록은 한 번만 더 받는다");
  assert.equal(countCalls(screen, "view=collector"), 2, "수집기 상태도 한 번만 더 받는다");
  screen.controller.destroy();
});

test("합치기는 화면 열기에만 쓴다: 실패한 목록은 다시 열면 다시 받고, 쓰기 뒤에는 2초 안이어도 다시 받는다", async () => {
  const clock = { now: Date.now() };
  let fail = true;
  const screen = mountWith({
    clock,
    fetch: async (url, init) => {
      if (init.method === "POST") return response({ ok: true, updated: 1 });
      if (fail) return response({ ok: false, code: "COUPANG_RANK_TRACKERS_FAILED" }, 500);
      return response(listPayload());
    },
  });
  const listCalls = () => countCalls(screen, (call) => call.url === LIST_URL);
  screen.controller.show();
  await flush();
  assert.equal(listCalls(), 1);
  fail = false;
  screen.controller.show();
  await flush();
  assert.equal(listCalls(), 2, "실패한 목록은 합치지 않는다");
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 2);
  dispatch(screen.host.querySelector('[data-coupang-rank-action="pause"]'), "click");
  await flush();
  assert.equal(countCalls(screen, (call) => call.init.method === "POST"), 1);
  assert.equal(listCalls(), 3, "일시중지 뒤 새로 받기는 합치지 않는다");
});

function manyTrackers(count, activeCount) {
  return Array.from({ length: count }, (_, index) => {
    const paused = index >= activeCount;
    const productId = String(9000000000 + index);
    return trackerFixture({
      id: `6c1f0000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      keyword: `키워드 ${index + 1}`,
      keywordKey: `키워드 ${index + 1}`,
      productId,
      productUrl: `https://www.coupang.com/vp/products/${productId}`,
      status: paused ? "paused" : "active",
      pausedAt: paused ? "2026-10-16T05:00:00.000Z" : null,
      pausedDay: paused ? "2026-10-16" : null,
      current: null,
      days: [],
      summary: { trend: "new", attention: false, attentionReasons: [] },
    });
  });
}

test("한 범위 추적이 500개를 넘으면(hasMore) 받은 500개를 경고와 함께 정리용으로 그리고 일시중지·삭제만 허용한다", async () => {
  const storage = makeStorage();
  const received = manyTrackers(500, 80); // 활성 80 + 일시중지 420(전체 501개 중 500개)
  const posts = [];
  let cleaned = false;
  const screen = mountWith({
    storage,
    fetch: async (url, init) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        posts.push(body);
        if (body.action === "delete") cleaned = true;
        return response({ ok: true, deleted: body.ids ? body.ids.length : 0, updated: 0 });
      }
      if (cleaned) return response(listPayload({ trackers: received.slice(2, 100) }));
      return response(listPayload({ trackers: received, totalCount: 501, hasMore: true, complete: false }));
    },
  });
  screen.controller.show();
  await flush();
  const host = screen.host;
  assert.equal(host.querySelectorAll("[data-coupang-rank-card]").length, 500, "빈 화면 대신 받은 500개를 그린다");
  const note = host.querySelector("[data-coupang-rank-list-note]");
  assert.equal(note.hidden, false);
  assert.ok(note.classList.contains("is-warn"));
  assert.match(note.textContent, /500개를 넘어\(전체 501개\) 500개만 받았습니다/);
  assert.match(note.textContent, /정리용 화면이라 일시중지·삭제만 됩니다/);
  assert.match(note.textContent, /일시중지한 추적도 500개에 세므로/);
  // 선택 도구: 일시중지·삭제만 보인다.
  const bulk = host.querySelector("[data-coupang-rank-bulk]");
  assert.equal(bulk.hidden, false, "선택 도구를 숨기지 않는다");
  const bulkButton = (action) => bulk.querySelector(`[data-coupang-rank-action="${action}"]`);
  assert.equal(bulkButton("bulk-pause").hidden, false);
  assert.equal(bulkButton("bulk-delete").hidden, false);
  assert.equal(bulkButton("bulk-resume").hidden, true);
  assert.equal(bulkButton("bulk-group").hidden, true);
  assert.equal(bulkButton("bulk-ungroup").hidden, true);
  assert.equal(host.querySelector("[data-coupang-rank-bulk-group-input]").hidden, true);
  assert.equal(bulk.querySelector(".mi-coupang-rank-bulk-group").hidden, true, "빈 그룹 이동 칸을 남기지 않는다");
  // 카드: 활성은 일시중지·삭제, 일시중지는 삭제만(다시 시작·그룹 변경 없음).
  assert.equal(host.querySelectorAll('[data-coupang-rank-action="pause"]').length, 80);
  assert.equal(host.querySelectorAll('[data-coupang-rank-action="delete"]').length, 500);
  assert.equal(host.querySelectorAll('[data-coupang-rank-action="resume"]').length, 0);
  assert.equal(host.querySelectorAll('[data-coupang-rank-action="group-edit"]').length, 0);
  // 등록은 막는다(행이 더 늘어난다). 이유는 등록 칸 아래에 적는다.
  assert.equal(host.querySelector("[data-coupang-rank-create]").disabled, true);
  const capacity = host.querySelector("[data-coupang-rank-capacity]");
  assert.equal(capacity.hidden, false);
  assert.match(capacity.textContent, /등록할 수 없습니다/);
  assert.equal(host.querySelector("[data-coupang-rank-filter-count]").textContent, "받은 500개(전체 501개) 중 500개 표시");
  // 일부 목록은 캐시하지 않는다.
  assert.equal(storage.getItem("miCoupangRank:v1:owner:mml93-a01"), null);
  // 막힌 동작은 숨긴 버튼·제출 경로로 들어와도 보내지 않는다.
  const firstCheck = host.querySelector(`[data-coupang-rank-select="${received[100].id}"]`);
  firstCheck.checked = true;
  dispatch(firstCheck, "change");
  dispatch(bulkButton("bulk-resume"), "click");
  await flush();
  host.querySelector("[data-coupang-rank-keyword]").value = "새 키워드";
  host.querySelector("[data-coupang-rank-product-url]").value = "https://www.coupang.com/vp/products/123456";
  dispatch(host.querySelector("[data-coupang-rank-create-form]"), "submit");
  await flush();
  assert.deepEqual(posts, [], "정리용 화면에서는 다시 시작·등록을 보내지 않는다");
  firstCheck.checked = false;
  dispatch(firstCheck, "change");
  // 두 개를 지우면 POST 뒤 다시 받고, 전체 목록(complete)이면 정상 화면으로 돌아온다.
  for (const tracker of received.slice(0, 2)) {
    const check = host.querySelector(`[data-coupang-rank-select="${tracker.id}"]`);
    check.checked = true;
    dispatch(check, "change");
  }
  dispatch(bulkButton("bulk-delete"), "click");
  await flush();
  assert.deepEqual(posts, [{ action: "delete", ids: [received[0].id, received[1].id] }]);
  assert.equal(host.querySelectorAll("[data-coupang-rank-card]").length, 98);
  assert.equal(host.querySelector("[data-coupang-rank-list-note]").hidden, true);
  assert.equal(host.querySelector("[data-coupang-rank-create]").disabled, false);
  assert.equal(host.querySelectorAll('[data-coupang-rank-action="resume"]').length, 20, "정상 화면에서는 다시 시작이 돌아온다");
  assert.equal(bulkButton("bulk-resume").hidden, false);
  assert.equal(bulk.querySelector(".mi-coupang-rank-bulk-group").hidden, false);
  assert.ok(storage.getItem("miCoupangRank:v1:owner:mml93-a01"), "전체 목록은 다시 캐시한다");
});

test("이전 전체 목록이 있으면 500개 초과 응답에도 그 목록을 두고(옛 캐시는 지움), 지운 뒤 받은 일부 목록은 정리용으로 바꿔 그린다", async () => {
  const storage = makeStorage({
    "miCoupangRank:v1:owner:mml93-a01": JSON.stringify({ savedAt: Date.now(), payload: listPayload() }),
  });
  const received = manyTrackers(500, 500);
  const screen = mountWith({
    storage,
    fetch: async (url, init) => {
      if (init.method === "POST") return response({ ok: true, deleted: 1 });
      return response(listPayload({ trackers: received, totalCount: 520, hasMore: true, complete: false }));
    },
  });
  screen.controller.show();
  await flush();
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 2, "화면에 있던 목록을 유지한다(§8.2)");
  assert.match(screen.host.querySelector("[data-coupang-rank-list-note]").textContent, /목록 일부만 받아 화면을 바꾸지 않았습니다\(전체 520개\)/);
  assert.equal(storage.getItem("miCoupangRank:v1:owner:mml93-a01"), null, "500개를 넘은 범위의 옛 캐시는 지운다");
  dispatch(screen.host.querySelector('[data-coupang-rank-action="delete"]'), "click");
  await flush();
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 500, "지운 뒤에는 옛 목록 대신 지금 받은 500개를 그린다");
  assert.match(screen.host.querySelector("[data-coupang-rank-list-note]").textContent, /정리용 화면/);
});

// ── 선택 이미지 저장(§8.5) ───────────────────────────────────────

function exportHarness({ toBlob }) {
  const record = { ensureStage: 0, serialize: [], toBlob: 0, showReady: [], links: [], stageClears: 0, stageFills: 0 };
  let screen;
  const tools = {
    ensureStage(card) {
      record.ensureStage += 1;
      assert.equal(card, screen.host);
      if (!record.stage) {
        const stage = screen.document.createElement("div");
        const original = stage.replaceChildren.bind(stage);
        stage.replaceChildren = (...nodes) => {
          if (nodes.length) record.stageFills += 1;
          else record.stageClears += 1;
          original(...nodes);
        };
        record.stage = stage;
      }
      return record.stage;
    },
    serialize(sheet, rootId) {
      record.serialize.push({ sheet, rootId });
      return "<div xmlns=\"http://www.w3.org/1999/xhtml\"></div>";
    },
    toBlob: async (rendered, svg, width, height) => {
      record.toBlob += 1;
      record.svg = svg;
      record.size = [width, height];
      assert.ok(rendered.stage && rendered.sheet);
      return toBlob();
    },
    showReady(card, blob, fileName, count) {
      const link = screen.document.createElement("a");
      record.showReady.push({ card, blob, fileName, count });
      record.links.push(link);
      return link;
    },
  };
  screen = mountWith({ exportTools: tools });
  return { screen, record };
}

async function selectAndExport(screen, ids) {
  screen.controller.show();
  await flush();
  for (const id of ids) {
    const check = screen.host.querySelector(`[data-coupang-rank-select="${id}"]`);
    check.checked = true;
    dispatch(check, "change");
  }
  dispatch(screen.host.querySelector('[data-coupang-rank-action="bulk-export"]'), "click");
  await flush();
}

test("내보내기: toBlob 이 {blob, ext} 를 주면 확장자가 ext 로 바뀌고 click 1회·무대 비우기 1회", async () => {
  layout.sheetHeight = 900;
  const { screen, record } = exportHarness({ toBlob: async () => ({ blob: new Blob(["x"], { type: "image/jpeg" }), ext: "jpg" }) });
  await selectAndExport(screen, ["6c1f0000-0000-4000-8000-000000000001"]);
  assert.equal(record.toBlob, 1);
  assert.equal(record.serialize.length, 1);
  assert.equal(record.serialize[0].rootId, "mi-admin");
  assert.ok(record.serialize[0].sheet.classList.contains("mi-rank-export-sheet"));
  assert.ok(record.serialize[0].sheet.textContent.includes("Moment Insight · Coupang Search Rank"));
  assert.match(record.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1320" height="900"><foreignObject width="100%" height="100%">/);
  assert.equal(record.showReady.length, 1);
  assert.equal(record.showReady[0].fileName, "아이폰-18프로-사생활-보호-필름-C30일순위.jpg");
  assert.equal(record.showReady[0].count, 1);
  assert.equal(record.links[0].clicks, 1);
  assert.equal(record.stageFills, 1);
  assert.equal(record.stageClears, 1);
  assert.ok(screen.host.textContent.includes("1개 순위 항목의 공유 이미지(JPG)가 준비되었습니다."));
  // 내보내기 시트는 공용 mi-rank-* 클래스와 인라인 style 만 쓴다.
  const sheet = record.serialize[0].sheet;
  // 날짜 범위·문구는 화면 카드와 같다(등록한 10-16 부터 오늘 10-17 까지, '오늘' 표시 없음).
  assert.equal(sheet.querySelectorAll(".mi-rank-day-card").length, 2);
  const sheetText = sheet.textContent;
  for (const expected of ["상품정보 · 8533720933 · 아이쉘 360도", "현재 28위", "최고 25위", "7일 평균 27.5위(50위 안 2일)", "전회 대비 3위 상승", "10-17(토)순위28위"]) assert.ok(sheetText.includes(expected), expected);
  for (const old of ["오늘", "상품번호", "30일 최고", "▲"]) assert.ok(!sheetText.includes(old), old);
  // 광고주에게 보내는 이미지: 운영줄 내부용 알약(상태·판정·광고·그룹·측정 기록·최근·다음)은 넣지 않는다(대표 결정 2026-10-17).
  for (const internal of ["상태 운영중", "상승 흐름", "광고 8번째", "그룹 미분류", "그룹 변경", "측정 기록", "최근 ", "다음 ", "점검 필요"]) assert.ok(!sheetText.includes(internal), internal);
  // 알약 순서: 현재 · 최고 · 전회 대비 · 7일 평균(C30 화면 카드 운영줄·N30 이미지와 같은 순서)
  const sheetPills = sheet.querySelectorAll("article")[0].querySelectorAll("span").map((node) => node.textContent).filter((value) => /^(현재|최고|7일 평균|전회)/.test(value));
  assert.deepEqual(sheetPills, ["현재 28위", "최고 25위", "전회 대비 3위 상승", "7일 평균 27.5위(50위 안 2일)"]);
  assert.ok(sheet.querySelectorAll("[style]").length > 0);
  assert.equal(sheet.querySelectorAll("[class]").filter((node) => node.className.includes("mi-coupang-rank")).length, 0);
});

test("내보내기: toBlob 이 실패하면 .svg 로 click 하고 무대를 비운다", async () => {
  layout.sheetHeight = 900;
  const { screen, record } = exportHarness({ toBlob: async () => { throw new Error("canvas blocked"); } });
  await selectAndExport(screen, ["6c1f0000-0000-4000-8000-000000000001", "6c1f0000-0000-4000-8000-000000000002"]);
  assert.equal(record.showReady.length, 1);
  assert.equal(record.showReady[0].fileName, "아이폰-18프로-사생활-보호-필름-외-1개-C30일순위.svg");
  assert.equal(record.showReady[0].blob.type, "image/svg+xml;charset=utf-8");
  assert.equal(record.links[0].clicks, 1);
  assert.equal(record.stageClears, 1);
  assert.ok(screen.host.textContent.includes("이미지 변환이 막혀 SVG 파일로 준비했습니다. 크롬 브라우저에서 다시 시도해주세요."));
});

test("내보내기: 높이 30000 초과면 무대를 비우고 나눠 저장하라고 안내한다", async () => {
  layout.sheetHeight = 40000;
  const { screen, record } = exportHarness({ toBlob: async () => ({ blob: new Blob(["x"]), ext: "png" }) });
  await selectAndExport(screen, ["6c1f0000-0000-4000-8000-000000000001"]);
  assert.equal(record.toBlob, 0);
  assert.equal(record.stageClears, 1);
  assert.ok(screen.host.textContent.includes("선택 항목이 너무 많습니다. 20개 이하로 나눠 저장해주세요."));
  layout.sheetHeight = 900;
});

// ── ① 지금 확인(spec-manual §7, 2026-10-23 다시 구현) ─────────────────
// 사람이 누를 때만: hello → manual-claim → 확장 check(확장이 창을 열기 전에 서버에 직접 확인) → manual-record → 목록.
// 간격·하루 상한·시간·그날 중지는 서버가 서버 시각으로 정한다. 화면은 확장이 기억한 차단으로 먼저 막지 않는다.

const EXT_ID = "pclpapjdlciiajmojlcnpepfljeaoohb";
const SERVER_NOW = Date.parse("2026-10-23T03:00:00.000Z"); // KST 12:00(09~19시 안)
const CLAIM_ID = "7d2a0000-0000-4000-8000-000000000001";
const CLAIM_TOKEN = `mcm1_${"A".repeat(43)}`;
const KEYWORD = "아이폰 18프로 사생활 보호 필름";
const TRACKER_ID = "6c1f0000-0000-4000-8000-000000000001";
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const iso = (ms) => new Date(ms).toISOString();

function manualPayload(overrides = {}) {
  return {
    state: "ready", enabled: true, usedToday: 3, maxPerDay: 30, minGapSeconds: 180, fromHour: 9, toHour: 19,
    nextAt: null, busyUntil: null, stoppedDay: null, stoppedAt: null, serverTime: iso(SERVER_NOW),
    extensionId: EXT_ID, minExtensionVersion: "1.0.0", extensionZipPath: "/coupang-check/mi-coupang-check-1.0.0.zip",
    ...overrides,
  };
}

function helloReply(overrides = {}) {
  return { ok: true, type: "hello", version: "1.0.0", incognitoAllowed: true, hostAccess: true, incognitoWindowOpen: false, busy: false, browser: "chrome 141", ...overrides };
}

function helloOk(overrides = {}) {
  return internals.parseHelloReply({ ok: true, reply: helloReply(overrides) });
}

function measuredPage(overrides = {}) {
  return {
    status: "ok", httpStatus: 200, loginWall: true, stable: true, noResultText: false, blockedText: false, itemCount: 60,
    organic: [{ p: "8533720933", v: "96009802650", s: 12 }], ads: [], finalHost: "www.coupang.com", finalPath: "/np/search",
    errorCode: null, query: KEYWORD, ...overrides,
  };
}

function measuredReply(page = measuredPage(), extra = {}) {
  return { ok: true, outcome: "measured", page, durationMs: 14231, extensionVersion: "1.0.0", browser: "chrome 141", ...extra };
}

// 가짜 확장 다리: 보낸 메시지를 모으고, hello·check 답을 시험이 정한다.
function fakeBridge({ hello = { ok: true, reply: helloReply() }, check } = {}) {
  const bridge = {
    messages: [],
    hello,
    check: check || (async () => ({ ok: true, reply: measuredReply() })),
    async send(id, message, timeoutMs) {
      bridge.messages.push({ id, message: JSON.parse(JSON.stringify(message)), timeoutMs });
      if (message.type === "mi-coupang-hello") return typeof bridge.hello === "function" ? bridge.hello() : bridge.hello;
      return bridge.check(message);
    },
    of: (type) => bridge.messages.filter((entry) => entry.message.type === type),
  };
  return bridge;
}

// 가짜 서버: GET 목록에는 지금 manual 칸을 싣고, POST 는 동작별 처리기로 답한다.
// 처리기는 payload, { __status, payload }, 또는 Error(연결 실패)를 돌려준다.
function fakeServer({ manual = manualPayload(), claim, record, settings, listOverrides = {} } = {}) {
  const server = { posts: [], gets: [], manual };
  const reply = (value) => {
    if (value instanceof Error) throw value;
    if (value && value.__status) return response(value.payload, value.__status);
    return response(value);
  };
  server.respond = async (url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      server.posts.push({ body, init });
      if (body.action === "manual-claim") {
        if (typeof claim === "function") return reply(await claim(body, server));
        if (claim) return reply(claim);
        server.manual = manualPayload({ state: "busy", usedToday: 4, busyUntil: iso(SERVER_NOW + 60000) });
        return reply({
          ok: true, claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, keyword: KEYWORD, keywordKey: KEYWORD, expiresAt: iso(SERVER_NOW + 60000), expiresInSeconds: 60,
          serverTime: iso(SERVER_NOW), manual: server.manual,
        });
      }
      if (body.action === "manual-record") {
        if (typeof record === "function") return reply(await record(body, server));
        if (record) return reply(record);
        // 실제 서버처럼 기록 뒤 목록 GET 도 같은 manual(간격 대기)을 준다
        server.manual = manualPayload({ state: "gap", usedToday: 4, nextAt: iso(SERVER_NOW + 180000), serverTime: iso(SERVER_NOW + 20000) });
        return reply({
          ok: true, accepted: true, duplicate: false, outcome: body.outcome, status: "ok", errorCode: null, matched: 1, counted: true, stopped: false, stopCode: null, late: false,
          tracker: { trackerId: TRACKER_ID, result: "found", rank: 12, organicCount: 50, adOrder: null, checkedAt: iso(SERVER_NOW + 20000) },
          manual: server.manual,
        });
      }
      if (body.action === "settings-update") return reply(typeof settings === "function" ? await settings(body, server) : (settings || { ok: true }));
      return reply({ ok: false, code: "COUPANG_ACTION_INVALID" });
    }
    server.gets.push(String(url));
    if (String(url).includes("view=collector")) return response(collectorPayload());
    return response(listPayload({ ...listOverrides, ...(server.manual == null ? {} : { manual: server.manual }) }));
  };
  server.of = (action) => server.posts.filter((entry) => entry.body.action === action);
  return server;
}

function mountManual(options = {}) {
  const server = options.server || fakeServer(options);
  const bridge = options.bridge || fakeBridge(options);
  const local = options.local || makeStorage();
  const screen = mountWith({ fetch: server.respond, extensionBridge: bridge, local, deferTimersFrom: 15000, userAgent: CHROME_UA, ...(options.mount || {}) });
  return { ...screen, server, bridge, local };
}

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await flush();
};

const manualLine = (screen) => screen.host.querySelector("[data-coupang-rank-manual-line]");
// 상태판 '직전 확인(HH:MM): …' 줄의 결과 문구(지금 확인 결과는 맨 위 상태줄이 아니라 상태판과 누른 카드에 보인다).
const resultText = (screen) => screen.host.querySelector("[data-coupang-rank-manual-result]").textContent.replace(/^직전 확인\(\d{2}:\d{2}\): /u, "");
const manualPill = (screen) => screen.host.querySelector("[data-coupang-rank-manual-state]").textContent;
const manualMetric = (screen, key) => screen.host.querySelector(`[data-coupang-rank-manual-metric="${key}"]`).querySelector("strong").textContent;
const cardNoteFor = (screen, id = TRACKER_ID) => {
  const card = screen.host.querySelector(`[data-coupang-rank-card][data-coupang-rank-id="${id}"]`);
  const note = card && card.querySelector("[data-coupang-rank-card-note]");
  return note ? note.textContent : "";
};
const manualBanner = (screen) => screen.host.querySelector("[data-coupang-rank-manual-banner]");
const manualResult = (screen) => screen.host.querySelector("[data-coupang-rank-manual-result]");
const manualButtons = (screen) => screen.host.querySelectorAll("[data-coupang-rank-manual]");
const manualButtonFor = (screen, id = TRACKER_ID) => screen.host.querySelector(`[data-coupang-rank-manual][data-coupang-rank-id="${id}"]`);
const view = (input) => internals.manualView({ now: SERVER_NOW, hello: helloOk(), userAgent: CHROME_UA, ...input, server: input.server === undefined ? manualPayload() : input.server });

test("지금 확인: 확장 메시지 이름·서버 코드·확장 코드 전부 쉬운 문구가 있다(계약 상수가 있으면 그것까지)", () => {
  assert.ok(moduleSource.includes('var MANUAL_HELLO_TYPE = "mi-coupang-hello";'));
  assert.ok(moduleSource.includes('var MANUAL_CHECK_TYPE = "mi-coupang-check";'));
  assert.ok(moduleSource.includes('var MANUAL_FOLDER_NAME = "mi-coupang-check";'), "zip 안 폴더는 버전 없는 고정 이름");
  // 명세 §4.3·§4.7·§6.1 의 확장 코드 + 반박 검토 코드(사이트 액세스 막힘·windows.create 빈 값)
  const extensionCodes = ["incognito_not_allowed", "incognito_window_open", "busy", "too_soon", "bad_request", "window_create_failed", "window_create_null",
    "host_access_withheld", "origin_rejected", "extension_missing", "extension_outdated", "extension_no_response", "extension_timeout",
    "page_timeout", "window_closed", "browser_hard_cap", "page_load_failed", "page_unreadable", "extract_failed", "query_mismatch", "user_navigated", "login_state_unknown"];
  for (const code of extensionCodes) assert.doesNotMatch(internals.manualCodeText(code), /사유 코드|사유를 받지/u, code);
  assert.match(internals.manualCodeText("brand_new_code"), /사유 코드 brand_new_code/u, "모르는 코드는 코드를 그대로 보인다");
  // 명세 §6.2 서버 코드
  const serverCodes = ["COUPANG_MANUAL_SETUP_REQUIRED", "COUPANG_MANUAL_OFF", "COUPANG_MANUAL_BUDGET", "COUPANG_MANUAL_STOPPED", "COUPANG_MANUAL_COOLDOWN",
    "COUPANG_MANUAL_HOURS", "COUPANG_MANUAL_BUSY", "COUPANG_MANUAL_DAILY_CAP", "COUPANG_MANUAL_GAP", "COUPANG_MANUAL_TRACKER_PAUSED", "COUPANG_MANUAL_TRACKER_INELIGIBLE",
    "COUPANG_MANUAL_CLAIM_NOT_FOUND", "COUPANG_MANUAL_CLAIM_MISMATCH", "COUPANG_MANUAL_CLAIM_CLOSED", "COUPANG_MANUAL_CLAIM_EXPIRED", "COUPANG_MANUAL_RECORD_INVALID"];
  const fallback = internals.errorText({ code: "NOPE" });
  for (const code of serverCodes) assert.notEqual(internals.errorText({ code }), fallback, code);
  assert.match(internals.errorText({ code: "COUPANG_MANUAL_RECORD_INVALID", field: "page.organic" }), /\(칸 page\.organic\)/u);
});

test("지금 확인: 서버 계약 상수(MANUAL_*)가 있으면 코드·상태 전부 화면 문구가 덮는다", (t) => {
  if (!Array.isArray(contract.MANUAL_STATES)) {
    t.skip("서버 계약 상수(MANUAL_STATES 등)가 아직 이 트리에 없다 — 통합 뒤 다시 돌면 검사한다");
    return;
  }
  for (const code of [...(contract.MANUAL_NOT_STARTED_CODES || []), ...(contract.MANUAL_LOST_CODES || []), ...(contract.MANUAL_EXTENSION_ERROR_CODES || [])]) {
    assert.doesNotMatch(internals.manualCodeText(code), /사유 코드|사유를 받지/u, code);
  }
  const fallback = internals.errorText({ code: "NOPE" });
  for (const code of Object.keys(contract.ERROR_HTTP_STATUS).filter((name) => name.startsWith("COUPANG_MANUAL_"))) {
    assert.notEqual(internals.errorText({ code }), fallback, code);
  }
  for (const stateName of contract.MANUAL_STATES) {
    const result = view({ server: manualPayload({ state: stateName, nextAt: iso(SERVER_NOW + 60000), busyUntil: iso(SERVER_NOW + 60000), stoppedDay: "2026-10-23" }) });
    assert.doesNotMatch(result.text, /알 수 없습니다/u, stateName);
  }
  for (const code of contract.MANUAL_STOP_CODES || []) {
    const text = internals.manualStopText(manualPayload({ state: "stopped", stoppedDay: "2026-10-23", stoppedAt: null, stoppedCode: code }), "");
    assert.match(text, /멈췄습니다\(.+\)\. 내일/u, `그날 중지 사유 ${code}`);
  }
  if (contract.MANUAL_EXTENSION_FOLDER) assert.ok(moduleSource.includes(`var MANUAL_FOLDER_NAME = "${contract.MANUAL_EXTENSION_FOLDER}";`), "zip 안 폴더 이름이 계약과 같다");
  if (contract.MANUAL_EXTENSION_ID) assert.match(contract.MANUAL_EXTENSION_ID, /^[a-p]{32}$/u);
  if (contract.MANUAL_EXTENSION_ZIP_PATH) assert.match(contract.MANUAL_EXTENSION_ZIP_PATH, /^\/coupang-check\/[A-Za-z0-9._-]+\.zip$/u, "화면이 받는 zip 경로 모양");
});

test("지금 확인: 확장 메시지 이름·확장 사유 코드(확장 lib/protocol.js)가 화면과 맞다", async (t) => {
  const url = new URL("../tools/coupang-rank-check-extension/lib/protocol.js", import.meta.url);
  if (!fs.existsSync(url)) {
    t.skip("확장 폴더가 아직 이 트리에 없다 — 통합 뒤 다시 돌면 검사한다");
    return;
  }
  const extension = await import(url.href);
  assert.ok(moduleSource.includes(`var MANUAL_HELLO_TYPE = "${extension.MESSAGE_TYPES.hello}";`));
  assert.ok(moduleSource.includes(`var MANUAL_CHECK_TYPE = "${extension.MESSAGE_TYPES.check}";`));
  if (extension.MESSAGE_TYPES.ack) assert.ok(moduleSource.includes(`var MANUAL_ACK_TYPE = "${extension.MESSAGE_TYPES.ack}";`));
  for (const code of [...(extension.NOT_STARTED_CODES || []), ...(extension.PAGE_ERROR_CODES || [])]) {
    assert.doesNotMatch(internals.manualCodeText(code), /사유 코드|사유를 받지/u, `확장 코드 ${code}`);
  }
});

test("지금 확인 상태 줄: 위에서부터 처음 맞는 것(spec-manual §7.3 + 반박 검토)", () => {
  // 꺼짐·SQL 전·서버 칸 없음 → 숨김
  assert.equal(view({ server: null }).visible, false);
  assert.equal(view({ server: manualPayload({ state: "off" }) }).visible, false);
  assert.equal(view({ server: manualPayload({ state: "setup_required" }) }).visible, false);
  // 그날 중지: 확장이 없어도 띠가 먼저, 원인을 단정하지 않는다
  const stopped = view({ server: manualPayload({ state: "stopped", stoppedDay: "2026-10-23", stoppedAt: "2026-10-23T02:05:00.000Z" }), hello: { status: "missing" } });
  assert.equal(stopped.banner, true);
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.text, "오늘 쿠팡 확인 중 차단으로 보이는 화면이 나와 '지금 확인'을 모두 멈췄습니다(11:05). 내일 09시부터 저절로 다시 됩니다.");
  assert.match(view({ server: manualPayload({ state: "stopped", stoppedDay: "2026-10-23", stoppedCode: "blocked_http_403" }) }).text, /\(쿠팡 응답 HTTP 403\)/u);
  assert.match(view({ server: manualPayload({ state: "stopped", stoppedDay: "2026-10-23", stoppedCode: "extension_reported" }) }).text, /확장이 오늘 차단으로 보이는 화면을 봤다고 알림/u);
  assert.doesNotMatch(view({ server: manualPayload({ state: "stopped", stoppedDay: "2026-10-23", stoppedCode: "made_up" }) }).text, /made_up/u, "모르는 사유는 쓰지 않는다");
  assert.match(view({ server: manualPayload({ state: "stopped", stoppedDay: "2026-10-23" }), stopDetail: "검색이 아닌 곳(로그인 화면 등)으로 보내져 읽지 못함" }).text, /로그인 화면 등/u);
  // 하루가 바뀌면 그날 중지는 풀린 것으로 보인다(누르면 서버가 다시 정한다)
  assert.equal(view({ server: manualPayload({ state: "stopped", stoppedDay: "2026-10-22" }) }).banner, false);
  assert.equal(view({ server: manualPayload({ state: "stopped", stoppedDay: "2026-10-23" }), now: SERVER_NOW + 86400000 }).state, "ready");
  // 진행 중
  // 2026-10-23 검토: 첫 읽기 전에 창을 닫으면 차단 신호를 잃을 수 있어 '직접 닫지 말라'를 함께 안내한다.
  // 디테일 고도화(2026-10-23)로 문장은 짧게 했지만 금지 네 가지(창 닫기·창 안 누르기·창 내리기/가리기·이 화면 닫기)는 그대로다.
  const running = view({ run: { phase: "check" } }).text;
  assert.equal(running, "확인 중입니다… 새 시크릿 창이 약 20초 열렸다 저절로 닫힙니다. 그 창을 닫거나 누르거나 내리지(가리지) 말고, 이 화면도 닫지 마세요.");
  for (const warning of ["창을 닫거나", "누르거나", "내리지(가리지)", "이 화면도 닫지 마세요"]) assert.ok(running.includes(warning), warning);
  assert.match(view({ run: { phase: "check", slow: true } }).text, /확장 응답이 늦습니다\. 최대 9분까지 기다립니다/u);
  assert.match(view({ run: { phase: "record", resumed: true } }).text, /앞서 보내지 못한 확인 결과/u);
  // 확장 쪽 문제(창을 열기 전에 멈춤)
  assert.match(view({ hello: null }).text, /확장을 확인하는 중입니다/u);
  const missing = view({ hello: { status: "missing" } });
  assert.equal(missing.enabled, false);
  assert.equal(missing.guide, true);
  assert.equal(missing.text, "지금 확인: 이 크롬에 '모먼트 인사이트 쿠팡 순위 확인' 확장이 없거나 꺼져 있습니다. chrome://extensions 에서 개발자 모드와 확장 스위치가 켜져 있는지 확인하고, 처음이면 설치 안내를 따라 주세요.");
  assert.match(view({ hello: { status: "missing" }, userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15" }).text, /크롬에서만 됩니다/u);
  assert.match(view({ hello: { status: "noid" } }).text, /확장 ID/u);
  assert.match(view({ hello: { status: "invalid" } }).text, /알 수 없는 답/u);
  assert.match(view({ hello: { status: "rejected" } }).text, /insight\.momentlabs\.co\.kr/u);
  assert.match(view({ hello: helloOk({ version: "0.9.0" }) }).text, /지금 v0\.9\.0, 필요 v1\.0\.0/u);
  assert.match(view({ hello: helloOk({ browser: "edge 141" }) }).text, /크롬에서만 됩니다/u);
  assert.match(view({ hello: helloOk({ incognitoAllowed: false }) }).text, /'시크릿 모드에서 허용'이 꺼져 있습니다/u);
  assert.match(view({ hello: helloOk({ hostAccess: false }) }).text, /'사이트 액세스'가 막혀 있습니다/u);
  // 확장은 사이트 액세스·다른 시크릿 창을 확인하지 못하면(null) 창을 열지 않는다 → 화면도 같은 기준으로 먼저 멈춘다
  assert.match(view({ hello: helloOk({ hostAccess: null }) }).text, /사이트 액세스' 상태를 알려 주지 않았습니다/u);
  assert.equal(view({ hello: helloOk({ hostAccess: null }) }).enabled, false);
  assert.equal(view({ hello: helloOk({ incognitoWindowOpen: null }) }).enabled, false);
  // 서버 관문(서버 시각 기준)
  assert.match(view({ server: manualPayload({ state: "budget" }) }).text, /저장 용량 상한/u);
  assert.match(view({ server: manualPayload({ state: "review" }) }).text, /대표 확인/u);
  assert.match(view({ server: manualPayload({ state: "cooldown", cooldownUntil: "2026-10-23T09:00:00.000Z" }) }).text, /쉬는 중입니다\(~/u);
  assert.equal(view({ server: manualPayload({ state: "hours" }), now: Date.parse("2026-10-23T11:00:00.000Z") }).text, "지금 확인은 09~19시에만 됩니다(서버 시각 기준).");
  assert.equal(view({ now: Date.parse("2026-10-23T10:30:00.000Z") }).state, "hours", "가능이어도 KST 19:30 이면 시간 밖");
  assert.equal(view({ server: manualPayload({ state: "hours" }) }).state, "ready", "시간 밖이었어도 지금이 09~19시 안이면 누를 수 있다(서버가 다시 정함)");
  assert.match(view({ server: manualPayload({ state: "busy", busyUntil: iso(SERVER_NOW + 60000) }) }).text, /다른 확인이 진행 중입니다/u);
  assert.match(view({ server: manualPayload({ state: "busy", busyUntil: iso(SERVER_NOW + 60000) }), ownPending: true }).text, /방금 누른 확인이 아직 진행 중/u);
  assert.equal(view({ server: manualPayload({ state: "busy", busyUntil: iso(SERVER_NOW - 1000) }) }).state, "ready");
  assert.equal(view({ server: manualPayload({ state: "daily_cap", usedToday: 30 }) }).text, "지금 확인: 오늘 30번을 모두 썼습니다. 내일 09시부터 다시 됩니다.");
  assert.equal(view({ server: manualPayload({ state: "daily_cap", usedToday: 30 }), now: SERVER_NOW + 86400000 }).state, "ready");
  const gap = view({ server: manualPayload({ state: "gap", nextAt: iso(SERVER_NOW + 125000) }) });
  assert.equal(gap.text, "다음 확인은 2분 05초 뒤에 할 수 있습니다(검색 사이 3분 · 오늘 3/30번).");
  assert.equal(gap.countdown, true);
  assert.equal(gap.enabled, false);
  assert.equal(view({ server: manualPayload({ state: "gap", nextAt: iso(SERVER_NOW + 9000) }) }).text.startsWith("다음 확인은 9초 뒤"), true);
  assert.equal(view({ server: manualPayload({ state: "gap", nextAt: iso(SERVER_NOW - 1) }) }).enabled, true, "간격이 지나면 서버 요청 없이 가능");
  // 확장 작업 중·다른 시크릿 창(누를 때 다시 묻는다)
  assert.equal(view({ hello: helloOk({ busy: true }) }).enabled, false);
  const incognito = view({ hello: helloOk({ incognitoWindowOpen: true }) });
  assert.equal(incognito.enabled, true);
  assert.match(incognito.text, /다른 시크릿 창이 열려 있습니다\. 모든 시크릿 창을 닫고 눌러 주세요/u);
  assert.match(view({ hello: helloOk({ incognitoWindowOpen: true, leftover: { closed: 0, unknown: true } }) }).text, /지난번에 연 시크릿 창이 남아 있습니다/u);
  // 확장이 따로 기억한 '오늘 차단'으로 화면이 먼저 막지 않는다(차단 보고는 서버 기록 경로로 간다)
  assert.equal(view({ hello: helloOk({ blockedToday: true }) }).enabled, true);
  const ready = view({});
  assert.equal(ready.enabled, true);
  assert.equal(ready.text, "지금 확인: 오늘 3/30번 · 09~19시 · 검색 사이 3분 · 누르면 새 시크릿 창이 잠깐 열렸다 닫힙니다.");
});

test("누르기 직전 검사: 확장 문제·다른 시크릿 창·확장 작업 중이면 그 문구, 아니면 빈 글", () => {
  const server = manualPayload();
  assert.equal(internals.manualPreflightText(helloOk(), server, CHROME_UA), "");
  assert.match(internals.manualPreflightText(helloOk({ incognitoWindowOpen: true }), server, CHROME_UA), /다른 시크릿 창이 열려 있습니다.*쿠팡 검색은 하지 않았습니다\.$/u);
  assert.match(internals.manualPreflightText(helloOk({ incognitoWindowOpen: null }), server, CHROME_UA), /알려 주지 않았습니다/u, "창을 볼 수 없으면 열기 전에 멈춘다");
  assert.match(internals.manualPreflightText(helloOk({ busy: true }), server, CHROME_UA), /다른 확인을 하는 중/u);
  assert.match(internals.manualPreflightText(helloOk({ incognitoAllowed: false }), server, CHROME_UA), /시크릿 모드에서 허용/u);
  assert.match(internals.manualPreflightText({ status: "missing" }, server, CHROME_UA), /확장이 없거나 꺼져 있습니다/u);
});

test("확장 답 읽기: hello·check 모양, 기록 본문(spec-manual §6.4)", () => {
  assert.equal(internals.parseHelloReply({ ok: false, code: "extension_no_response" }).status, "missing");
  assert.equal(internals.parseHelloReply({ ok: true, reply: undefined }).status, "invalid");
  assert.equal(internals.parseHelloReply({ ok: true, reply: { ok: false, code: "origin_rejected" } }).status, "rejected");
  assert.equal(internals.parseHelloReply({ ok: true, reply: helloReply({ version: "1.0" }) }).status, "invalid");
  // 확장 hello 의 남은 창(leftover)·보고 안 된 결과(pending) 모양(확장 background.js hello())
  const hello = helloOk({ leftover: { closed: 2, unknown: true }, pending: { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, stop: true, serverDay: "2026-10-23", ageMs: 1000, reply: measuredReply() } });
  assert.equal(hello.status, "ok");
  assert.equal(hello.leftoverWindow, true);
  assert.equal(hello.leftoverClosed, 2);
  assert.equal(hello.pending.claimId, CLAIM_ID);
  assert.equal(hello.pending.claimToken, CLAIM_TOKEN);
  assert.equal(hello.pending.stop, true);
  assert.equal(hello.pending.reply.outcome, "measured");
  assert.equal(helloOk({ pending: { claimToken: CLAIM_TOKEN } }).pending, null, "확인 번호 없는 결과는 버린다");
  assert.match(internals.manualExtensionText(hello), /남은 시크릿 창 있음\(직접 닫기\) · 지난번 남은 시크릿 창 2개를 닫음/u);
  // 시작 못 함의 덧붙임(서버 거절 코드·다시 누를 시간·확장이 들고 있는 결과)
  const refused = internals.parseCheckReply({ ok: true, reply: { ok: false, outcome: "not_started", code: "verify_refused", serverCode: "COUPANG_MANUAL_GAP", retryAfterSec: 70 } });
  assert.equal(refused.serverCode, "COUPANG_MANUAL_GAP");
  assert.equal(refused.retryAfterSec, 70);
  const reportPending = internals.parseCheckReply({ ok: true, reply: { ok: false, outcome: "not_started", code: "report_pending", pending: { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, reply: measuredReply() } } });
  assert.equal(reportPending.held.claimId, CLAIM_ID);
  assert.deepEqual(JSON.parse(JSON.stringify(internals.parseCheckReply({ ok: false, code: "extension_timeout" }))), { outcome: "lost", code: "extension_timeout" });
  assert.deepEqual(JSON.parse(JSON.stringify(internals.parseCheckReply({ ok: false, code: "extension_no_response" }))), { outcome: "lost", code: "extension_no_response" });
  assert.equal(internals.parseCheckReply({ ok: false, code: "extension_missing" }).outcome, "not_started");
  assert.equal(internals.parseCheckReply({ ok: true, reply: { ok: false, outcome: "not_started", code: "host_access_withheld" } }).code, "host_access_withheld");
  assert.equal(internals.parseCheckReply({ ok: true, reply: { ok: false, outcome: "not_started", code: "BAD CODE" } }).code, "extension_refused");
  assert.equal(internals.parseCheckReply({ ok: true, reply: { ok: true } }).outcome, "lost");
  const measured = internals.parseCheckReply({ ok: true, reply: measuredReply(measuredPage(), { windowLeftOpen: true }) });
  assert.equal(measured.outcome, "measured");
  assert.equal(measured.windowLeftOpen, true);
  const claim = { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN };
  const body = internals.manualRecordBody(claim, measured, helloOk());
  assert.deepEqual(Object.keys(body), ["action", "claimId", "claimToken", "outcome", "page", "durationMs", "extensionVersion", "browser"]);
  assert.equal(body.action, "manual-record");
  assert.equal(body.outcome, "measured");
  // 확장 버전·브라우저가 답에 없으면 hello 값을 쓴다
  const bare = internals.manualRecordBody(claim, internals.parseCheckReply({ ok: true, reply: { outcome: "measured", page: measuredPage() } }), helloOk({ version: "1.0.1", browser: "chrome 142" }));
  assert.equal(bare.extensionVersion, "1.0.1");
  assert.equal(bare.browser, "chrome 142");
  assert.deepEqual(JSON.parse(JSON.stringify(internals.manualRecordBody(claim, { outcome: "not_started", code: "incognito_window_open" }, null))),
    { action: "manual-record", claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, outcome: "not_started", outcomeCode: "incognito_window_open" });
  assert.deepEqual(JSON.parse(JSON.stringify(internals.manualRecordBody(claim, { outcome: "lost", code: "extension_no_response" }, null))),
    { action: "manual-record", claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, outcome: "lost", outcomeCode: "extension_no_response" });
});

test("결과 문구: 서버 판정·사유별 쉬운 문구, 차단은 '차단으로 보이는' 화면으로만 쓰고 빈 목록은 차단으로 단정하지 않는다", () => {
  const measured = (page = measuredPage()) => ({ outcome: "measured", page });
  const ok = (payload) => ({ payload: { ok: true, accepted: true, duplicate: false, stopped: false, manual: manualPayload({ usedToday: 4 }), ...payload }, httpStatus: 200 });
  const text = (recorded, parsed = measured()) => internals.manualRecordText(recorded, parsed, KEYWORD, manualPayload());
  assert.deepEqual(JSON.parse(JSON.stringify(text(ok({ status: "ok", matched: 2, tracker: { result: "found", rank: 12, organicCount: 50 } })))),
    { text: `확인 완료: '${KEYWORD}' 일반 12위(일반 50개 중) · 같은 키워드 추적 2개에 기록. (오늘 4/30번 사용)`, tone: "is-ok" });
  assert.match(text(ok({ status: "ok", matched: 1, tracker: { result: "out", adOrder: 4 } })).text, /'50위 밖'으로 기록했습니다\(광고 칸 4번째에만 보임\)\./u);
  assert.match(text(ok({ status: "ok", matched: 1, tracker: { result: "short", organicCount: 20 } })).text, /1쪽 일반 상품 20개 안에 없어 '없음'으로 기록했습니다\./u);
  assert.match(text(ok({ status: "ok", matched: 0, tracker: null })).text, /기록했습니다\. 카드의 '현재' 값을 새로 받습니다/u);
  assert.match(text(ok({ status: "noresult", matched: 1 })).text, /'결과 없음'으로 기록했습니다/u);
  assert.match(text(ok({ status: "ok", duplicate: true, accepted: false, tracker: null })).text, /^이미 기록한 확인입니다\./u);
  // 차단: 그날 중지 · 사유는 보낸 쪽 결과에서
  const blocked = text(ok({ status: "blocked", stopped: true }), measured(measuredPage({ status: "blocked", httpStatus: 403, organic: [], itemCount: 0 })));
  assert.equal(blocked.stopped, true);
  assert.equal(blocked.detail, "쿠팡 응답 HTTP 403");
  assert.equal(blocked.text, "확인한 화면이 차단으로 보여(쿠팡 응답 HTTP 403) 오늘 '지금 확인'을 모두 멈췄습니다. 내일 09시부터 저절로 다시 됩니다.");
  assert.equal(text(ok({ status: "blocked", stopped: true }), measured(measuredPage({ httpStatus: 200, blockedText: true }))).detail, "쿠팡 '사용권한' 안내 화면");
  assert.match(text(ok({ status: "blocked", stopped: true }), measured(measuredPage({ errorCode: "page_unreadable", finalHost: "" }))).detail, /로그인 화면 등/u);
  // 빈 목록(광고만 있고 일반 0개 포함)은 차단이 아니다
  const empty = text(ok({ status: "empty" }), measured(measuredPage({ organic: [], ads: [{ p: "1", v: "", s: 1 }], itemCount: 1 })));
  assert.equal(empty.stopped, undefined);
  assert.match(empty.text, /원인은 확인하지 못했고, 차단으로 보지 않았습니다\)\. 순위는 기록하지 않았습니다\./u);
  // 서버 사유 코드별 문구('오류'로만 보이지 않게)
  assert.match(text(ok({ status: "error", errorCode: "query_mismatch" })).text, /창의 검색어가 요청한 키워드와 달랐습니다/u);
  assert.match(text(ok({ status: "error", errorCode: "login_state_unknown" })).text, /로그인하지 않은 화면인지 확인하지 못해/u);
  assert.match(text(ok({ status: "error", errorCode: "user_navigated" })).text, /창 안을 누르지 마세요/u);
  assert.match(text(ok({ status: "error" }), measured(measuredPage({ status: "error", errorCode: "window_closed" }))).text, /시크릿 창이 닫혔습니다/u);
  assert.match(text(ok({ status: "timeout" }), measured(measuredPage({ status: "timeout", errorCode: "page_timeout" }))).text, /45초 안에/u);
  assert.match(text(ok({ status: "partial" }), measured(measuredPage({ stable: false, wasHidden: true }))).text, /창이 가려지거나 내려가/u);
  assert.match(text(ok({ status: "partial" })).text, /상품 수가 바뀌었습니다/u);
  assert.match(text(ok({ status: "unsupported" })).text, /'이동'으로 기록\)\. \(오늘/u);
  for (const status of ["error", "timeout", "partial", "empty", "unsupported"]) assert.doesNotMatch(text(ok({ status })).text, /\(오류\)/u, status);
  // 시작 못 함·응답 없음(검색 여부를 사실대로)
  assert.match(text(ok({ accepted: false, outcome: "not_started" }), { outcome: "not_started", code: "incognito_window_open" }).text, /다른 시크릿 창이 열려 있어 시작하지 않았습니다.*쿠팡 검색은 하지 않았습니다\. \(오늘 4\/30번 사용\)$/u);
  assert.match(text({ payload: { ok: false, code: "COUPANG_MANUAL_CLAIM_CLOSED" }, httpStatus: 409 }, { outcome: "not_started", code: "claim_expired" }).text, /쿠팡 검색은 하지 않았습니다/u);
  assert.match(text(ok({ accepted: false, outcome: "lost" }), { outcome: "lost", code: "extension_no_response" }).text, /검색이 됐는지는 확인하지 못했습니다/u);
  // 보내기 실패는 브라우저 영어 문구 대신 쉬운 문구
  const transport = text({ payload: { ok: false }, transport: true, httpStatus: 0 });
  assert.match(transport.text, /^결과를 서버에 보내지 못했습니다\(인터넷 연결을 확인해 주세요\)/u);
  assert.doesNotMatch(transport.text, /Failed|fetch|network/iu);
  assert.match(text({ payload: { ok: false, code: "SESSION_REQUIRED" }, httpStatus: 401 }).text, /로그인이 풀려/u);
  assert.match(text({ payload: { ok: false, message: "응답을 확인할 수 없습니다(HTTP 502)." }, httpStatus: 502 }).text, /서버 처리 중 오류/u);
  assert.equal(text({ payload: { ok: false, code: "COUPANG_MANUAL_CLAIM_EXPIRED", stopped: true }, httpStatus: 410 },
    measured(measuredPage({ httpStatus: 429 }))).stopped, true, "기한이 지난 차단 보고도 그날 중지로 보인다");
  assert.match(text({ payload: { ok: false, code: "COUPANG_MANUAL_RECORD_INVALID", field: "page.organic" }, httpStatus: 400 }).text, /칸 page\.organic/u);
  assert.match(text(ok({ status: "ok", tracker: { result: "found", rank: 3 } }), { ...measured(), windowLeftOpen: true }).text, /열린 시크릿 창을 직접 닫아 주세요/u);
});

// 2026-10-23 3차 재검사: 측정 중 쿼리만 바뀐 user_navigated 는 사람 탓을 하지 않고 바뀐 이름을 보인다(대표 첫 시험에서 무시 목록 판단용).
test("결과 문구: 측정 중 쿼리만 바뀐 이동은 '검색 창 주소가 바뀌어' + 바뀐 이름, 경로·q 가 바뀌면 '다른 쪽으로 옮겨짐' 그대로", () => {
  const ok = (payload) => ({ payload: { ok: true, accepted: true, duplicate: false, stopped: false, manual: manualPayload({ usedToday: 4 }), ...payload }, httpStatus: 200 });
  const navigated = (changedParams) => ({ outcome: "measured", page: measuredPage({ status: "error", errorCode: "user_navigated", organic: [], itemCount: 0, ...(changedParams === undefined ? {} : { changedParams }) }) });
  const text = (parsed, payload = { status: "error", errorCode: "user_navigated" }) => internals.manualRecordText(ok(payload), parsed, KEYWORD, manualPayload()).text;
  const queryOnly = text(navigated(["channel", "traceId"]));
  assert.equal(queryOnly, `'${KEYWORD}' 확인 중에 검색 창 주소가 바뀌어 순위를 기록하지 않았습니다(바뀐 값: channel, traceId). 창 안을 누르지 않았다면 알려 주세요. (오늘 4/30번 사용)`);
  assert.doesNotMatch(queryOnly, /창 안을 누르지 마세요|순위는 기록하지 않았습니다/u, "사람 탓 문구·중복 문장 없음");
  assert.equal(internals.manualRecordText(ok({ status: "error", errorCode: "user_navigated" }), navigated(["traceId"]), KEYWORD, manualPayload()).tone, "is-warn");
  // 이름을 받지 못한 쿼리만 바뀜(빈 목록)
  assert.match(text(navigated([])), /검색 창 주소가 바뀌어 순위를 기록하지 않았습니다\. 창 안을 누르지 않았다면 알려 주세요\./u);
  // 화면도 이름을 다시 맞춘다(문자열·제어 문자 없음·40자·10개)
  assert.deepEqual(JSON.parse(JSON.stringify(internals.manualChangedParams({ changedParams: ["a", 1, "", "b\u0001", "가".repeat(41), "a", ...Array.from({ length: 12 }, (_, index) => `n${index}`)] }))),
    ["a", "n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]);
  assert.equal(internals.manualChangedParams({}), null);
  // 경로가 바뀜(이름 없음)·q 가 바뀜·옛 확장(이름 칸 없음) → '다른 쪽으로 옮겨짐' 문구 그대로
  for (const parsed of [navigated(undefined), navigated(["q", "channel"]), navigated("traceId")]) {
    const moved = text(parsed);
    assert.match(moved, /확인 중에 창 안에서 다른 쪽으로 옮겨졌습니다\(창 안을 누르지 마세요\)\. 순위는 기록하지 않았습니다\./u, JSON.stringify(parsed.page.changedParams));
  }
  // 서버 판정이 user_navigated 가 아니면 이름이 있어도 쓰지 않는다
  assert.match(text(navigated(["traceId"]), { status: "error", errorCode: "window_closed" }), /시크릿 창이 닫혔습니다/u);
});

test("claim 거절 문구: 쿠팡 검색 전이라는 사실을 덧붙이고 간격은 남은 시간을 보인다", () => {
  const refuse = (payload, extra = {}) => internals.manualClaimRefusalText({ payload: { ok: false, ...payload }, httpStatus: 409, ...extra }, manualPayload());
  assert.equal(refuse({ code: "COUPANG_MANUAL_GAP", retryAfterSec: 65 }), "검색 사이 간격(3분)을 기다리는 중입니다(1분 05초 남음). 쿠팡 검색은 하지 않았습니다.");
  assert.equal(refuse({ code: "COUPANG_MANUAL_HOURS" }), "지금 확인은 09~19시에만 됩니다. 쿠팡 검색은 하지 않았습니다.");
  assert.equal(refuse({ code: "COUPANG_MANUAL_BUSY", retryAfterSec: 40 }), "다른 확인이 진행 중입니다(약 40초 뒤 다시 눌러 주세요). 쿠팡 검색은 하지 않았습니다.");
  assert.equal(refuse({ code: "COUPANG_MANUAL_DAILY_CAP" }), "오늘 확인 30번을 모두 썼습니다. 내일 다시 됩니다. 쿠팡 검색은 하지 않았습니다.");
  assert.match(refuse({ code: "COUPANG_MANUAL_STOPPED", manual: manualPayload({ state: "stopped" }) }), /차단으로 보이는 화면/u);
  assert.match(refuse({ code: "COUPANG_OWNER_ONLY" }), /총관리자만 할 수 있습니다\. 쿠팡 검색은 하지 않았습니다\./u);
  assert.match(refuse({}, { transport: true, httpStatus: 0 }), /서버에 연결하지 못해/u);
  assert.match(refuse({ message: "x" }, { httpStatus: 500 }), /서버 처리 중 오류/u);
});

test("확장의 서버 확인 거절·횟수 문구가 원인과 맞다(2026-10-23 검토: 401 은 '다시 로그인'이 아닐 수 있음·기한은 1분·확인 뒤 멈춤은 횟수에 듦)", () => {
  const text = (recorded, parsed) => internals.manualRecordText(recorded, parsed, KEYWORD, manualPayload());
  const ok = (payload = {}) => ({ payload: { ok: true, accepted: false, duplicate: false, outcome: "not_started", stopped: false, manual: manualPayload({ usedToday: 4 }), ...payload }, httpStatus: 200 });
  const refused = (serverCode, httpStatus) => internals.parseCheckReply({ ok: true, reply: { ok: false, outcome: "not_started", code: "verify_refused", serverCode, httpStatus } });
  // 401(확장 요청에 로그인 정보가 안 실렸을 수 있음) — 화면 쪽 '다시 로그인해주세요'를 그대로 붙이지 않는다
  for (const parsed of [refused("SESSION_REQUIRED", 401), refused("COUPANG_SESSION_REQUIRED", 401), refused(undefined, 401)]) {
    const line = text(ok(), parsed).text;
    assert.match(line, /서버가 로그인 정보를 받지 못했다고 해 시작하지 않았습니다\(화면은 로그인돼 있어도 확장 요청에 로그인 정보가 실리지 않았을 수 있습니다/u);
    assert.doesNotMatch(line, /다시 로그인해주세요/u);
    assert.match(line, /쿠팡 검색은 하지 않았습니다\./u);
  }
  // 확인 요청 기한(60초) — 결과 저장 기한(10분) 문구와 섞지 않는다
  const expired = text(ok(), refused("COUPANG_MANUAL_CLAIM_EXPIRED", 410)).text;
  assert.match(expired, /^확인 요청의 1분 기한이 지나 확장이 시작하지 않았습니다\. 다시 눌러 주세요\. 쿠팡 검색은 하지 않았습니다\./u);
  assert.doesNotMatch(expired, /10분|저장하지 않았습니다/u);
  // 그 밖의 거절은 서버 사유를 그대로 덧붙인다
  assert.match(text(ok(), refused("COUPANG_MANUAL_GAP", 409)).text, /허락하지 않아 확장이 시작하지 않았습니다\(검색 사이 간격/u);
  // 서버 확인 뒤에 멈춤(검색 0번이지만 횟수에 듦) — 서버 counted 가 사실
  const early = { outcome: "not_started", code: "window_closed_early" };
  assert.equal(text(ok({ counted: true }), early).text,
    "쿠팡 검색 전에 시크릿 창이 닫혀 확장이 검색하지 않았습니다(확장이 연 창은 직접 닫지 마세요). 쿠팡 검색은 하지 않았지만 이번 1번은 오늘 횟수에 들어갔고, 3분 뒤 다시 누를 수 있습니다. (오늘 4/30번 사용)");
  // 서버 확인 전에 멈춤(창 만들기 실패 등)은 횟수에 들지 않는다 — 문구도 그대로
  assert.match(text(ok({ counted: false }), { outcome: "not_started", code: "window_create_failed" }).text, /시크릿 창을 열지 못했습니다.*쿠팡 검색은 하지 않았습니다\. \(오늘 4\/30번 사용\)$/u);
});

test("응답 없음(lost) 뒤 서버가 그 확인을 잠시 '진행 중'으로 셀 때 상태 줄은 '다른 확인'이 아니라 '방금 확인이 응답 없이 끝남'", async () => {
  assert.match(view({ server: manualPayload({ state: "busy", busyUntil: iso(SERVER_NOW + 95000) }), ownLost: true }).text,
    /^지금 확인: 방금 확인이 확장 응답 없이 끝났습니다\(약 1분 35초 뒤 다시 누를 수 있습니다\)\.$/u);
  assert.match(view({ server: manualPayload({ state: "busy", busyUntil: iso(SERVER_NOW + 95000) }), ownLost: false }).text, /다른 확인이 진행 중입니다/u);
  const screen = mountManual({ check: async () => ({ ok: false, code: "extension_no_response" }), record: { ok: true, accepted: false, outcome: "lost", counted: true } });
  screen.controller.show();
  await settle();
  dispatch(manualButtonFor(screen), "click");
  await settle();
  // 기록 뒤 목록 GET 의 manual 은 claim 때의 '진행 중'(60초) 그대로다
  assert.match(manualLine(screen).textContent, /방금 확인이 확장 응답 없이 끝났습니다/u);
  assert.doesNotMatch(manualLine(screen).textContent, /다른 확인이 진행 중/u);
  assert.match(manualResult(screen).textContent, /검색이 됐는지는 확인하지 못했습니다/u);
});

// 2026-10-23 재검사: 결과 보내기(manual-record)가 연결 실패로 끝난 뒤 상태 줄이 '다른 확인이 진행 중'이라고 했다(본인 확인이다).
// 2026-10-23 재검사 2차: 그 고침이 시각(150초)만 봐서 다른 사람 확인도 본인 확인으로 불렀다 → 요청 id(claimId)로 기억하고,
// 서버 요약이 준 진행 중 요청 id 가 이 요청일 때만 본인 문구. 서버가 알려 주지 않으면 단정하지 않는 문구(처음 실패 뒤 150초 안) 또는 일반 문구.
const OTHER_CLAIM_ID = "7d2a0000-0000-4000-8000-0000000000ff";
const UNSENT_OWN = "지금 확인: 방금 확인 결과를 서버에 보내지 못했습니다. 이 화면을 열어 두면 잠시 뒤(약 1분 35초) 저절로 다시 보냅니다. 안 되면 버튼이 켜질 때 다시 눌러 주세요(앞 결과부터 보냅니다).";
const UNSENT_MAYBE = "지금 확인: 진행 중인 확인이 있습니다(약 1분 35초 뒤 끝남). 이 화면이 서버에 보내지 못한 결과는 화면을 열어 두면 잠시 뒤 저절로 다시 보냅니다. 안 되면 버튼이 켜질 때 다시 눌러 주세요(앞 결과부터 보냅니다).";

test("보내지 못함 문구: 본인 문구(ownUnsent)·단정하지 않는 문구(unsentMaybe)·일반 문구, 진행 중 요청 id 비교(manualBusyMine)", () => {
  const busy = manualPayload({ state: "busy", busyUntil: iso(SERVER_NOW + 95000) });
  assert.equal(view({ server: busy, ownUnsent: true }).text, UNSENT_OWN);
  assert.equal(view({ server: busy, ownUnsent: true }).countdown, true);
  assert.match(view({ server: busy, ownUnsent: true, ownLost: true }).text, /결과를 서버에 보내지 못했습니다/u, "보내지 못함이 응답 없음보다 먼저");
  assert.equal(view({ server: busy, unsentMaybe: true }).text, UNSENT_MAYBE);
  assert.equal(view({ server: busy, unsentMaybe: true }).countdown, true);
  assert.doesNotMatch(view({ server: busy, unsentMaybe: true }).text, /방금 확인 결과|다른 확인/u, "누구 것인지 단정하지 않는다");
  assert.match(view({ server: busy, ownUnsent: false }).text, /다른 확인이 진행 중입니다/u);
  // 진행 중 요청 id: 서버가 줄 때만 같음·다름을 안다(대소문자 무시). 주지 않거나 모양이 틀리면 모름(null).
  const mine = internals.manualBusyMine;
  assert.equal(mine({ busyClaimId: CLAIM_ID }, CLAIM_ID), true);
  assert.equal(mine({ busyClaimId: CLAIM_ID.toUpperCase() }, CLAIM_ID), true);
  assert.equal(mine({ busyClaimId: OTHER_CLAIM_ID }, CLAIM_ID), false);
  for (const server of [busy, { busyClaimId: "not-a-uuid" }, { busyClaimId: 7 }, null]) assert.equal(mine(server, CLAIM_ID), null);
  assert.equal(mine({ busyClaimId: CLAIM_ID }, ""), null);
});

// 보내기가 계속 연결 실패하는 화면(record 처리기는 online 이 될 때까지 Error)
function unsentScreen({ clock, claimManual, online = () => false }) {
  return mountManual({
    mount: { clock },
    claim: (body, server) => {
      server.manual = claimManual();
      return {
        ok: true, claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, keyword: KEYWORD, keywordKey: KEYWORD, expiresAt: iso(SERVER_NOW + 60000), expiresInSeconds: 60,
        serverTime: iso(SERVER_NOW), manual: server.manual,
      };
    },
    record: (body, server) => {
      if (!online()) return new Error("offline");
      server.manual = manualPayload({ state: "gap", usedToday: 4, nextAt: iso(SERVER_NOW + 180000) });
      return { ok: true, accepted: true, duplicate: false, outcome: body.outcome, status: "ok", errorCode: null, matched: 1, counted: true, stopped: false, stopCode: null, late: false,
        tracker: { trackerId: TRACKER_ID, result: "found", rank: 12, organicCount: 50, adOrder: null, checkedAt: iso(SERVER_NOW + 20000) }, manual: server.manual };
    },
  });
}

test("결과를 보내지 못한 뒤 서버가 누구 것인지 알려 주지 않는 '진행 중'이면 단정하지 않는 문구, 다시 보내면 지운다(지금 서버 요약 = busyClaimId 없음)", async () => {
  const clock = { now: Date.now() };
  let online = false;
  const screen = unsentScreen({ clock, online: () => online, claimManual: () => manualPayload({ state: "busy", usedToday: 4, busyUntil: iso(SERVER_NOW + 60000) }) });
  screen.controller.show();
  await settle();
  dispatch(manualButtonFor(screen), "click");
  await settle();
  assert.equal(screen.server.of("manual-record").length, 3, "같은 실행 안에서 3번 보내 봤지만 연결 실패");
  assert.match(manualResult(screen).textContent, /결과를 서버에 보내지 못했습니다\(인터넷 연결을 확인해 주세요\)/u);
  // 기록 뒤 목록 GET 의 manual 은 claim 때의 '진행 중'(60초) 그대로이고 요청 id 가 없다 — 본인이라고도, 다른 사람이라고도 하지 않는다
  assert.match(manualLine(screen).textContent, /^진행 중인 확인이 있습니다\(약 [^)]+ 뒤 끝남\)\. 이 화면이 서버에 보내지 못한 결과는/u);
  assert.doesNotMatch(manualLine(screen).textContent, /방금 확인 결과를 서버에 보내지 못했습니다|다른 확인이 진행 중/u);
  // 진행 중이 끝날 때(+2초) 목록을 다시 받으며 남긴 결과를 저절로 다시 보낸다(30초 간격 뒤) → 보냈으면 그 문구를 지운다
  online = true;
  clock.now += 31000;
  const refresh = screen.timeouts.filter((entry) => !entry.cleared && entry.ms >= 61000 && entry.ms <= 63000);
  assert.equal(refresh.length, 1);
  refresh[0].fn();
  await settle();
  assert.equal(screen.server.of("manual-record").length, 4);
  assert.equal(screen.local.getItem("miCoupangRankManual:v1:pending"), null);
  assert.doesNotMatch(manualLine(screen).textContent, /보내지 못한|보내지 못했습니다|다른 확인이 진행 중/u);
  assert.match(resultText(screen), /^앞서 끝나지 않은 확인 결과를 보냈습니다\. 확인 완료/u);
});

test("서버 요약의 진행 중 요청 id 가 이 요청이면 본인 문구, 다른 요청이면 '다른 확인'(시각과 무관)", async () => {
  for (const [busyClaimId, expected, pill] of [[CLAIM_ID, /^방금 확인 결과를 서버에 보내지 못했습니다\. 이 화면을 열어 두면 잠시 뒤/u, "결과 보내지 못함"], [OTHER_CLAIM_ID, /^다른 확인이 진행 중입니다\./u, "다른 확인 진행 중"]]) {
    const clock = { now: Date.now() };
    const screen = unsentScreen({ clock, claimManual: () => ({ ...manualPayload({ state: "busy", usedToday: 4, busyUntil: iso(SERVER_NOW + 60000) }), busyClaimId }) });
    screen.controller.show();
    await settle();
    dispatch(manualButtonFor(screen), "click");
    await settle();
    assert.equal(screen.server.of("manual-record").length, 3);
    assert.match(manualLine(screen).textContent, expected, busyClaimId);
    assert.equal(manualPill(screen), pill, busyClaimId);
  }
});

// 재검사 2차 r2 장면: 내 결과는 계속 못 보내고(다시 보내기도 실패), 내 확인의 '진행 중'이 끝난 뒤 다른 사람 확인이 시작된다.
test("내 결과를 계속 못 보내는 동안 다른 사람 확인이 진행 중이면(처음 실패 뒤 150초 지남) 본인 문구가 아니라 '다른 확인' — 다시 보내기 실패가 시각을 새로 잡지 않는다", async () => {
  const clock = { now: Date.now() };
  const screen = unsentScreen({ clock, claimManual: () => manualPayload({ state: "busy", usedToday: 4, busyUntil: iso(SERVER_NOW + 60000) }) });
  screen.controller.show();
  await settle();
  dispatch(manualButtonFor(screen), "click");
  await settle();
  assert.equal(screen.server.of("manual-record").length, 3);
  assert.match(manualLine(screen).textContent, /^진행 중인 확인이 있습니다/u);
  // 151초 뒤: 내 확인(확인 뒤 150초)은 서버에서 끝났고, 다른 사람의 열린 요청이 '진행 중'(요청 id 는 서버가 주지 않음)
  clock.now += 151000;
  screen.server.manual = manualPayload({ state: "busy", usedToday: 5, busyUntil: iso(SERVER_NOW + 151000 + 60000), serverTime: iso(SERVER_NOW + 151000) });
  const refresh = screen.timeouts.filter((entry) => !entry.cleared && entry.ms >= 61000 && entry.ms <= 63000);
  assert.equal(refresh.length, 1);
  refresh[0].fn();
  await settle();
  assert.ok(screen.server.of("manual-record").length >= 4, "목록을 다시 받으며 남긴 결과를 다시 보내 봤다(또 실패)");
  assert.match(manualLine(screen).textContent, /^다른 확인이 진행 중입니다\./u);
  assert.doesNotMatch(manualLine(screen).textContent, /보내지 못했습니다|보내지 못한/u);
});

test("카드 '지금 확인': 총관리자·관리자 화면·활성 추적·지금 확인 켜짐일 때만 일시중지 앞에 있다", async () => {
  const screen = mountManual();
  screen.controller.show();
  await settle();
  const cards = screen.host.querySelectorAll("[data-coupang-rank-card]");
  // 1행 오른쪽: 현재 · 30일 최고 · 지금 확인(주 버튼) | 일시중지 · 삭제(세로 줄 뒤 도구 묶음)
  assert.deepEqual(cards[0].querySelector(".mi-rank-row-actions").children.map((node) => node.textContent), ["현재 28위", "30일 최고 25위", "지금 확인", "일시중지삭제"]);
  const buttonNode = manualButtonFor(screen);
  assert.equal(buttonNode.getAttribute("data-coupang-rank-action"), "manual-check");
  assert.equal(buttonNode.disabled, false);
  assert.ok(buttonNode.classList.contains("mi-coupang-rank-manual-button"));
  assert.ok(buttonNode.classList.contains("is-done"), "오늘(목록 todayKst 10-17) 이미 확인한 카드는 테두리 모양(보조)");
  assert.ok(!manualButtonFor(screen, "6c1f0000-0000-4000-8000-000000000002").classList.contains("is-done"), "오늘 아직인 카드만 채운 주 버튼");
  assert.equal(manualButtons(screen).length, 2);
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-box]").hidden, false);
  // 상태판: 알약 · 한 줄 설명 · 칸 3개 · 끄기
  assert.equal(manualPill(screen), "바로 확인 가능");
  assert.equal(manualLine(screen).textContent, "카드의 '지금 확인'을 누르면 이 크롬이 새 시크릿 창으로 쿠팡 검색 1쪽을 한 번 열고 닫습니다.");
  assert.equal(manualMetric(screen, "next"), "지금 가능");
  assert.equal(manualMetric(screen, "used"), "3 / 30번");
  assert.equal(manualMetric(screen, "today"), "1 / 2개");
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-toggle]").textContent, "지금 확인 끄기");
  // 자동 수집이 돌지 않는 화면이 아니라(collector ok) 자동추적 칸도 함께 보인다(서버는 둘이 함께 켜지지 않게 막는다).
  assert.equal(screen.host.querySelector("[data-coupang-rank-strip]").hidden, false);
  assert.equal(screen.bridge.of("mi-coupang-hello").length, 1, "화면을 열면 확장에 한 번 묻는다");
  assert.equal(screen.bridge.messages[0].id, EXT_ID);
  assert.equal(screen.bridge.of("mi-coupang-check").length, 0, "열기만 해서는 검색하지 않는다");
  assert.equal(screen.server.posts.length, 0);

  const paused = mountManual({ listOverrides: { trackers: [trackerFixture({ status: "paused", pausedDay: "2026-10-17" })] } });
  paused.controller.show();
  await settle();
  assert.equal(manualButtons(paused).length, 0, "일시중지 추적에는 버튼이 없다");
  assert.deepEqual(paused.host.querySelector(".mi-rank-row-actions").children.map((node) => node.textContent), ["현재 28위", "30일 최고 25위", "다시 시작삭제"]);
  // 꺼짐이면 카드 버튼은 숨기지만 상태판은 본문에 남아 '꺼짐'과 '지금 확인 켜기'를 보인다. SQL 전·서버 칸 없음이면 상태판도 숨긴다.
  const cases = [
    ["지금 확인 꺼짐", { manual: manualPayload({ state: "off", enabled: false }) }, false],
    ["대표 SQL 전", { manual: manualPayload({ state: "setup_required" }) }, true],
    ["서버 manual 칸 없음", { manual: null }, true],
  ];
  for (const [name, options, boardHidden] of cases) {
    const other = mountManual(options);
    other.controller.show();
    await settle();
    assert.equal(manualButtons(other).length, 0, name);
    assert.equal(other.host.querySelector("[data-coupang-rank-manual-box]").hidden, boardHidden, name);
    assert.equal(other.bridge.messages.length, 0, `${name}: 확장에 묻지 않는다`);
    if (!boardHidden) {
      assert.equal(manualPill(other), "꺼짐");
      assert.equal(manualLine(other).textContent, "자동 수집으로 기록 중입니다(지금 확인은 꺼짐). 카드의 '지금 확인' 버튼은 숨겨져 있습니다.", "목록의 collector 가 ok(자동 수집이 도는 중)");
      const toggle = other.host.querySelector("[data-coupang-rank-manual-toggle]");
      assert.equal(toggle.textContent, "지금 확인 켜기");
      assert.equal(toggle.getAttribute("data-coupang-rank-action"), "manual-enable");
    }
  }
  const team = mountManual({ mount: { isOwner: false } });
  team.controller.show();
  await settle();
  assert.equal(manualButtons(team).length, 0, "운영팀 화면(총관리자 아님)");
  const readonly = mountManual({ mount: { mode: "readonly", isOwner: false, scope: { key: "team:c1", role: "team", agencyCode: "", clientId: "c1" } }, listOverrides: { scopeMode: "advertiser", scopeClientId: "c1", readOnly: true } });
  readonly.controller.show();
  await settle();
  assert.equal(manualButtons(readonly).length, 0, "읽기 전용");
  const cleanup = mountManual({ listOverrides: { complete: false, hasMore: true, totalCount: 600 } });
  cleanup.controller.show();
  await settle();
  assert.ok(cleanup.host.querySelectorAll("[data-coupang-rank-card]").length > 0);
  assert.equal(manualButtons(cleanup).length, 0, "정리용 부분 목록");
});

test("누르기 흐름: hello → manual-claim → check(claimId·claimToken·keyword) → manual-record → 목록 다시 받기", async () => {
  const screen = mountManual();
  screen.controller.show();
  await settle();
  const getsBefore = screen.server.gets.length;
  dispatch(manualButtonFor(screen), "click");
  await settle();
  assert.equal(screen.bridge.of("mi-coupang-hello").length, 2, "누르기 직전에 확장에 다시 묻는다(캐시 무시)");
  const checks = screen.bridge.of("mi-coupang-check");
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].message, { type: "mi-coupang-check", claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, keyword: KEYWORD });
  assert.equal(checks[0].id, EXT_ID);
  assert.equal(checks[0].timeoutMs, 540000, "확장 답은 늦은 보고 창(10분) 안인 9분까지 기다린다");
  const claims = screen.server.of("manual-claim");
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].body, { action: "manual-claim", trackerId: TRACKER_ID });
  assert.equal(claims[0].init.timeoutMs, 20000);
  assert.equal(claims[0].init.headers["x-mi-agency-code"], "mml93-a01");
  const records = screen.server.of("manual-record");
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0].body), ["action", "claimId", "claimToken", "outcome", "page", "durationMs", "extensionVersion", "browser"]);
  assert.equal(records[0].body.claimToken, CLAIM_TOKEN);
  assert.equal(records[0].body.outcome, "measured");
  assert.deepEqual(records[0].body.page, measuredPage());
  assert.equal(records[0].init.timeoutMs, 30000);
  assert.equal(screen.server.posts.map((entry) => entry.body.action).join(","), "manual-claim,manual-record");
  assert.ok(screen.server.gets.length > getsBefore, "기록 뒤 목록을 다시 받는다");
  const expected = `확인 완료: '${KEYWORD}' 일반 12위(일반 50개 중). (오늘 4/30번 사용)`;
  assert.equal(resultText(screen), expected);
  assert.match(manualResult(screen).textContent, new RegExp(`^직전 확인\\(\\d{2}:\\d{2}\\): ${expected.replace(/[().]/gu, "\\$&")}$`, "u"));
  assert.equal(screen.local.getItem("miCoupangRankManual:v1:pending"), null, "서버가 받으면 남겨 둔 결과를 지운다");
  assert.ok(!JSON.stringify(screen.storage.dump()).includes(CLAIM_TOKEN), "1회용 토큰은 목록 캐시에 남지 않는다");
  // 목록 응답의 manual(간격)을 다시 받아 버튼은 꺼지고, 남은 시간은 버튼 글자와 상태판 '다음 확인' 칸에 보인다
  assert.equal(manualPill(screen), "3분 간격 기다리는 중");
  assert.equal(manualLine(screen).textContent, "카드의 '지금 확인'을 누르면 이 크롬이 새 시크릿 창으로 쿠팡 검색 1쪽을 한 번 열고 닫습니다.");
  assert.match(manualMetric(screen, "next"), /^\d분 \d{2}초 뒤$/u);
  assert.equal(manualButtonFor(screen).disabled, true);
  assert.match(manualButtonFor(screen).textContent, /^\d분 \d{2}초 뒤$/u);
  // 결과는 누른 카드 운영줄 첫 칸에도 짧게(한 곳만, 맨 위 상태줄에는 겹쳐 쓰지 않는다)
  assert.match(cardNoteFor(screen), /^방금 확인 \d{2}:\d{2} · 일반 12위로 기록$/u);
  assert.equal(screen.host.querySelector("[data-coupang-rank-status]").hidden, true);
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card-note]").length, 1);
  // 확장에 check 를 보내는 곳은 startManualCheck 하나이고, 사람이 누른 동작에서만 부른다(예약·자동 반복 없음).
  // 부르는 곳은 카드 '지금 확인'(runManualCheck)과 상태판 '전체 확인'의 한 건 시작(allStartItem) 둘뿐이다(대표 승인 2026-10-24).
  assert.equal((moduleSource.match(/type: MANUAL_CHECK_TYPE/gu) || []).length, 1);
  assert.ok(functionBlock(moduleSource, "startManualCheck").includes("type: MANUAL_CHECK_TYPE"));
  assert.equal((moduleSource.match(/runManualCheck\(/gu) || []).length, 2, "정의 1 + 클릭 동작 1");
  assert.ok(functionBlock(moduleSource, "onClick").includes('case "manual-check":\n          runManualCheck(id);'));
  assert.equal((moduleSource.match(/startManualCheck\(/gu) || []).length, 3, "정의 1 + runManualCheck 1 + allStartItem 1");
  assert.ok(functionBlock(moduleSource, "allStartItem").includes("startManualCheck(tracker.id)"));
  assert.ok(functionBlock(moduleSource, "onClick").includes('case "manual-all-start":\n          manualAllStart();'));
  assert.equal((moduleSource.match(/extensionBridge\.send\(/gu) || []).length, 3, "hello 1 + check 1 + ack 1(검색 아님)");
  assert.ok(functionBlock(moduleSource, "sendManualAck").includes("type: MANUAL_ACK_TYPE"));
  // 서버가 받은 측정 결과는 확장에 ack 를 보내 확장이 남긴 결과를 지우게 한다
  assert.deepEqual(screen.bridge.of("mi-coupang-ack").map((entry) => entry.message), [{ type: "mi-coupang-ack", claimId: CLAIM_ID }]);
  assert.doesNotMatch(moduleSource, /chrome\.alarms|setInterval\([^)]*startManualCheck/u);
});

test("확장이 막히면 서버 요청 0번(횟수 안 씀), claim 이 거절되면 확장 check 0번", async () => {
  // 시크릿 허용 꺼짐: 화면을 열 때부터 버튼이 꺼진다
  const off = mountManual({ hello: { ok: true, reply: helloReply({ incognitoAllowed: false }) } });
  off.controller.show();
  await settle();
  assert.equal(manualButtonFor(off).disabled, true);
  assert.match(manualLine(off).textContent, /시크릿 모드에서 허용/u);
  // 열 때는 괜찮았는데 누를 때 다른 시크릿 창이 열림 → 서버 요청 없이 멈춤
  const bridge = fakeBridge();
  const later = mountManual({ bridge });
  later.controller.show();
  await settle();
  bridge.hello = { ok: true, reply: helloReply({ incognitoWindowOpen: true }) };
  dispatch(manualButtonFor(later), "click");
  await settle();
  assert.equal(later.server.posts.length, 0);
  assert.equal(bridge.of("mi-coupang-check").length, 0);
  assert.match(resultText(later), /다른 시크릿 창이 열려 있습니다.*쿠팡 검색은 하지 않았습니다\./u);
  // 확장이 사라짐(개발자 모드 꺼짐 등) → 서버 요청 없음
  const gone = fakeBridge();
  const vanished = mountManual({ bridge: gone });
  vanished.controller.show();
  await settle();
  gone.hello = { ok: false, code: "extension_no_response" };
  dispatch(manualButtonFor(vanished), "click");
  await settle();
  assert.equal(vanished.server.posts.length, 0);
  assert.match(manualLine(vanished).textContent, /확장이 없거나 꺼져 있습니다/u);
  assert.equal(vanished.host.querySelector('[data-coupang-rank-action="manual-guide-open"]').hidden, false, "설치 안내 열기 단추");
  // 서버 거절(간격): check 0번, 남은 시간 문구, 응답의 manual 로 줄을 바꾼다
  const refused = mountManual({ claim: { __status: 409, payload: { ok: false, code: "COUPANG_MANUAL_GAP", retryAfterSec: 100, manual: manualPayload({ state: "gap", nextAt: iso(SERVER_NOW + 100000) }) } } });
  refused.controller.show();
  await settle();
  dispatch(manualButtonFor(refused), "click");
  await settle();
  assert.equal(refused.bridge.of("mi-coupang-check").length, 0);
  assert.equal(refused.server.of("manual-record").length, 0);
  assert.equal(resultText(refused), "검색 사이 간격(3분)을 기다리는 중입니다(1분 40초 남음). 쿠팡 검색은 하지 않았습니다.");
  assert.equal(manualMetric(refused, "next"), "1분 40초 뒤");
  assert.equal(manualButtonFor(refused).textContent, "1분 40초 뒤");
  // 확인을 시작하지 않았으므로 머리말은 '방금 확인'이 아니라 '방금 누름'(2026-10-23 재검사)
  assert.match(cardNoteFor(refused), /^방금 누름 \d{2}:\d{2} · 시작하지 않음 · 쿠팡 검색 안 함$/u);
});

test("시작 못 함·응답 없음 보고 모양, 응답 없음 뒤에는 확장을 한 번 깨운다", async () => {
  const notStarted = mountManual({ check: async () => ({ ok: true, reply: { ok: false, outcome: "not_started", code: "host_access_withheld" } }),
    record: { ok: true, accepted: false, outcome: "not_started", manual: manualPayload({ state: "gap", usedToday: 4, nextAt: iso(SERVER_NOW + 180000) }) } });
  notStarted.controller.show();
  await settle();
  dispatch(manualButtonFor(notStarted), "click");
  await settle();
  assert.deepEqual(notStarted.server.of("manual-record")[0].body, { action: "manual-record", claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, outcome: "not_started", outcomeCode: "host_access_withheld" });
  assert.match(resultText(notStarted), /사이트 액세스'가 막혀 있어 시작하지 않았습니다\. 쿠팡 검색은 하지 않았습니다\. \(오늘 4\/30번 사용\)/u);

  const lost = mountManual({ check: async () => ({ ok: false, code: "extension_no_response" }), record: { ok: true, accepted: false, outcome: "lost", manual: manualPayload({ usedToday: 4 }) } });
  lost.controller.show();
  await settle();
  const hellosBefore = lost.bridge.of("mi-coupang-hello").length;
  dispatch(manualButtonFor(lost), "click");
  await settle();
  assert.deepEqual(lost.server.of("manual-record")[0].body, { action: "manual-record", claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, outcome: "lost", outcomeCode: "extension_no_response" });
  assert.equal(lost.bridge.of("mi-coupang-hello").length, hellosBefore + 2, "누르기 직전 1번 + 응답 없음 뒤 깨우기 1번");
  assert.match(resultText(lost), /검색이 됐는지는 확인하지 못했습니다/u);

  const timeout = mountManual({ check: async () => ({ ok: false, code: "extension_timeout" }), record: { ok: true, accepted: false, outcome: "lost" } });
  timeout.controller.show();
  await settle();
  dispatch(manualButtonFor(timeout), "click");
  await settle();
  assert.equal(timeout.server.of("manual-record")[0].body.outcomeCode, "extension_timeout");
});

test("진행 중에는 두 번 눌러도 claim 1번, 누른 카드는 '확인 중…', 150초가 지나면 '늦습니다'만 알린다", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const screen = mountManual({ check: async () => { await gate; return { ok: true, reply: measuredReply() }; } });
  screen.controller.show();
  await settle();
  dispatch(manualButtonFor(screen), "click");
  await settle();
  dispatch(manualButtonFor(screen), "click");
  dispatch(manualButtonFor(screen, "6c1f0000-0000-4000-8000-000000000002"), "click");
  await settle();
  assert.equal(screen.server.of("manual-claim").length, 1);
  assert.equal(screen.bridge.of("mi-coupang-check").length, 1);
  assert.equal(manualButtonFor(screen).textContent, "확인 중…");
  assert.ok(manualButtons(screen).every((node) => node.disabled), "진행 중에는 모든 '지금 확인'이 꺼진다");
  assert.match(manualLine(screen).textContent, /^확인 중입니다… 새 시크릿 창이 약 20초 열렸다 저절로 닫힙니다\. 그 창을 닫거나 누르거나 내리지\(가리지\) 말고, 이 화면도 닫지 마세요\.$/u);
  assert.equal(manualPill(screen), "확인 중");
  assert.equal(manualMetric(screen, "next"), "확인 중");
  const pending = JSON.parse(screen.local.getItem("miCoupangRankManual:v1:pending"));
  assert.equal(pending.claimId, CLAIM_ID, "결과를 받기 전에도 확인 번호를 남겨 둔다(새로고침 대비)");
  const slow = screen.timeouts.find((entry) => entry.ms === 150000);
  assert.ok(slow);
  slow.fn();
  assert.match(manualLine(screen).textContent, /확장 응답이 늦습니다\. 최대 9분까지 기다립니다/u);
  assert.equal(screen.server.of("manual-record").length, 0, "150초에는 '응답 없음'을 보내지 않는다");
  release();
  await settle();
  assert.equal(screen.server.of("manual-record").length, 1);
  assert.equal(slow.cleared, true);
  // 끝나면 '확인 중…'이 풀리고, 서버가 준 간격(3분)을 버튼 글자로 센다.
  assert.match(manualButtonFor(screen).textContent, /^\d분 \d{2}초 뒤$/u);
  assert.ok(!manualButtonFor(screen).classList.contains("is-running"));
});

test("확장이 본 차단은 서버 기록 경로로 가서 그날 중지가 걸린다(화면이 먼저 막지 않는다)", async () => {
  const blockedPage = measuredPage({ status: "blocked", httpStatus: 403, blockedText: true, organic: [], itemCount: 0, loginWall: false });
  const screen = mountManual({
    hello: { ok: true, reply: helloReply({ blockedToday: true }) },
    check: async () => ({ ok: true, reply: measuredReply(blockedPage) }),
    record: (body, server) => {
      server.manual = manualPayload({ state: "stopped", stoppedDay: "2026-10-23", stoppedAt: "2026-10-23T03:00:20.000Z", usedToday: 4 });
      return { ok: true, accepted: true, duplicate: false, status: "blocked", matched: 0, stopped: true, tracker: null, manual: server.manual };
    },
  });
  screen.controller.show();
  await settle();
  assert.equal(manualButtonFor(screen).disabled, false, "확장이 기억한 오늘 차단으로 버튼을 먼저 끄지 않는다");
  dispatch(manualButtonFor(screen), "click");
  await settle();
  const record = screen.server.of("manual-record")[0];
  assert.ok(record, "차단 결과도 서버에 보낸다");
  assert.equal(record.body.page.httpStatus, 403);
  assert.equal(record.body.page.blockedText, true);
  const banner = manualBanner(screen);
  assert.equal(banner.hidden, false);
  assert.equal(banner.getAttribute("role"), "alert");
  assert.equal(banner.textContent, "오늘 쿠팡 확인 중 차단으로 보이는 화면이 나와 '지금 확인'을 모두 멈췄습니다(12:00 · 쿠팡 응답 HTTP 403). 내일 09시부터 저절로 다시 됩니다.");
  assert.equal(manualLine(screen).hidden, true);
  assert.ok(manualButtons(screen).every((node) => node.disabled));
  assert.equal(resultText(screen), "확인한 화면이 차단으로 보여(쿠팡 응답 HTTP 403) 오늘 '지금 확인'을 모두 멈췄습니다. 내일 09시부터 저절로 다시 됩니다.");
  // 서버가 받은 차단 결과는 확장에 '지워도 된다'(ack)를 보내 확장의 남은 결과·새 검색 막힘을 푼다
  assert.deepEqual(screen.bridge.of("mi-coupang-ack").map((entry) => entry.message), [{ type: "mi-coupang-ack", claimId: CLAIM_ID }]);
});

test("결과를 보내지 못하면 2번 더 보내고, 끝내 못 보내면 남겨 두었다가 먼저 보낸다(그 전에는 새 검색을 하지 않는다)", async () => {
  let online = false;
  const local = makeStorage();
  const server = fakeServer({
    record: (body, current) => {
      if (!online) return new Error("Failed to fetch");
      current.manual = manualPayload({ state: "stopped", stoppedDay: "2026-10-23", stoppedAt: "2026-10-23T03:01:00.000Z", usedToday: 4 });
      return { ok: true, accepted: true, status: "blocked", stopped: true, matched: 0, tracker: null, manual: current.manual };
    },
  });
  const blockedPage = measuredPage({ status: "blocked", httpStatus: 403, organic: [], itemCount: 0 });
  const bridge = fakeBridge({ check: async () => ({ ok: true, reply: measuredReply(blockedPage) }) });
  const screen = mountManual({ server, bridge, local });
  screen.controller.show();
  await settle();
  dispatch(manualButtonFor(screen), "click");
  await settle();
  assert.equal(server.of("manual-record").length, 3, "처음 1번 + 다시 2번");
  const status = resultText(screen);
  assert.match(status, /^결과를 서버에 보내지 못했습니다\(인터넷 연결을 확인해 주세요\)\. 이 화면을 10분 안에 다시 열면 저절로 다시 보냅니다\.$/u);
  assert.doesNotMatch(status, /Failed to fetch/u);
  const kept = JSON.parse(local.getItem("miCoupangRankManual:v1:pending"));
  assert.equal(kept.report.outcome, "measured");
  assert.equal(kept.report.page.httpStatus, 403);
  // 새 탭(같은 브라우저 저장소): 화면을 열면 남긴 결과를 저절로 보낸다
  online = true;
  const tab = mountManual({ server, bridge: fakeBridge(), local });
  tab.controller.show();
  await settle();
  assert.equal(server.of("manual-record").length, 4);
  assert.equal(server.of("manual-claim").length, 1, "남긴 결과를 보낼 때는 새 확인을 받지 않는다");
  assert.equal(local.getItem("miCoupangRankManual:v1:pending"), null);
  assert.equal(manualBanner(tab).hidden, false, "보낸 결과가 차단이면 그날 중지 띠");
  assert.match(resultText(tab), /^앞서 끝나지 않은 확인 결과를 보냈습니다\. 확인한 화면이 차단으로 보여/u);
});

test("누를 때 남은 결과가 있으면 그것을 먼저 보내고 새 확인은 하지 않는다", async () => {
  const local = makeStorage({ "miCoupangRankManual:v1:pending": JSON.stringify({ claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, trackerId: TRACKER_ID, keyword: KEYWORD, savedAt: Date.now(),
    report: { action: "manual-record", claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, outcome: "lost", outcomeCode: "extension_no_response" } }) });
  let failFirst = true;
  const screen = mountManual({ local, record: () => (failFirst ? new Error("offline") : { ok: true, accepted: false, outcome: "lost", manual: manualPayload({ usedToday: 4 }) }) });
  screen.controller.show();
  await settle();
  assert.equal(screen.server.of("manual-record").length, 3, "화면을 열 때 다시 보내 봤지만 연결 실패");
  failFirst = false;
  dispatch(manualButtonFor(screen), "click");
  await settle();
  assert.equal(screen.server.of("manual-record").length, 4);
  assert.equal(screen.server.of("manual-claim").length, 0);
  assert.equal(screen.bridge.of("mi-coupang-check").length, 0);
  assert.match(resultText(screen), /^앞서 끝나지 않은 확인 결과를 먼저 보냈습니다\. 새 확인은 다시 눌러 주세요\./u);
  assert.equal(local.getItem("miCoupangRankManual:v1:pending"), null);
});

test("확장이 들고 있는 결과(hello.pending)를 보낸다: 탭을 닫았거나 다른 탭에서 받은 확인도, 이미 보낸 결과면 ack 만", async () => {
  const held = (page = measuredPage()) => ({ claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, stop: false, serverDay: "2026-10-23", ageMs: 5000, reply: { ...measuredReply(page), claimId: CLAIM_ID, keyword: KEYWORD } });
  // 이 브라우저에는 아무 기록이 없어도(탭을 닫음) 확장이 토큰과 함께 들고 있으면 보낸다
  const otherTab = mountManual({ hello: { ok: true, reply: helloReply({ pending: { ...held(measuredPage({ status: "blocked", httpStatus: 403, organic: [], itemCount: 0 })), stop: true } }) } });
  otherTab.controller.show();
  await settle();
  const sent = otherTab.server.of("manual-record");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.claimToken, CLAIM_TOKEN);
  assert.equal(sent[0].body.page.httpStatus, 403);
  assert.equal(otherTab.server.of("manual-claim").length, 0, "남은 결과를 보낼 때는 새 확인을 받지 않는다");
  assert.deepEqual(otherTab.bridge.of("mi-coupang-ack").map((entry) => entry.message), [{ type: "mi-coupang-ack", claimId: CLAIM_ID }]);
  assert.match(resultText(otherTab), /^앞서 끝나지 않은 확인 결과를 보냈습니다\./u);
  // 같은 탭에 남긴 확인 번호 + 확장 결과(토큰은 이 브라우저 것을 쓴다)
  const pendingOnly = JSON.stringify({ claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, trackerId: TRACKER_ID, keyword: KEYWORD, savedAt: Date.now() });
  const same = mountManual({ local: makeStorage({ "miCoupangRankManual:v1:pending": pendingOnly }), hello: { ok: true, reply: helloReply({ pending: { ...held(), claimToken: "" } }) } });
  same.controller.show();
  await settle();
  assert.equal(same.server.of("manual-record").length, 1);
  assert.equal(same.server.of("manual-record")[0].body.claimToken, CLAIM_TOKEN);
  assert.equal(same.local.getItem("miCoupangRankManual:v1:pending"), null);
  // 토큰이 어디에도 없으면 보내지 않는다(꾸밀 수 없게 서버가 토큰을 본다)
  const noToken = mountManual({ hello: { ok: true, reply: helloReply({ pending: { ...held(), claimToken: "" } }) } });
  noToken.controller.show();
  await settle();
  assert.equal(noToken.server.of("manual-record").length, 0);
  // 확장이 아직 그 확인을 하는 중이면 15초 뒤 다시 묻는다(한 번에 하나)
  const busy = mountManual({ local: makeStorage({ "miCoupangRankManual:v1:pending": pendingOnly }), hello: { ok: true, reply: helloReply({ busy: true }) } });
  busy.controller.show();
  await settle();
  assert.equal(busy.timeouts.filter((entry) => entry.ms === 15000).length, 1);
  busy.bridge.hello = { ok: true, reply: helloReply({ pending: held() }) };
  busy.timeouts.find((entry) => entry.ms === 15000).fn();
  await settle();
  assert.equal(busy.server.of("manual-record").length, 1);
});

test("확장이 '보고 안 된 앞 결과'(report_pending)로 시작하지 않으면 지금 claim 을 닫고 그 결과를 바로 보낸다", async () => {
  const heldBlocked = { claimId: "7d2a0000-0000-4000-8000-0000000000aa", claimToken: `mcm1_${"B".repeat(43)}`, stop: true, reply: { ...measuredReply(measuredPage({ status: "blocked", httpStatus: 429, organic: [], itemCount: 0 })), keyword: KEYWORD } };
  const screen = mountManual({ check: async () => ({ ok: true, reply: { ok: false, outcome: "not_started", code: "report_pending", claimId: CLAIM_ID, pending: heldBlocked } }),
    record: (body, server) => {
      if (body.outcome !== "measured") return { ok: true, accepted: false, outcome: body.outcome, manual: manualPayload({ usedToday: 4 }) };
      server.manual = manualPayload({ state: "stopped", stoppedDay: "2026-10-23", stoppedCode: "blocked_http_429" });
      return { ok: true, accepted: true, status: "blocked", stopped: true, stopCode: "blocked_http_429", matched: 0, tracker: null, manual: server.manual };
    } });
  screen.controller.show();
  await settle();
  dispatch(manualButtonFor(screen), "click");
  await settle();
  const records = screen.server.of("manual-record").map((entry) => entry.body);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { action: "manual-record", claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, outcome: "not_started", outcomeCode: "report_pending" });
  assert.equal(records[1].claimId, heldBlocked.claimId);
  assert.equal(records[1].claimToken, heldBlocked.claimToken);
  assert.equal(records[1].page.httpStatus, 429);
  assert.equal(manualBanner(screen).hidden, false);
  assert.match(manualBanner(screen).textContent, /쿠팡 응답 HTTP 429/u);
});

test("간격 초 세기는 서버 시각 기준(내 맥 시계가 10분 빨라도 같다), 화면이 보일 때만 1초 타이머, 0이 되면 서버 요청 없이 가능", async () => {
  const clock = { now: SERVER_NOW + 600000 };
  const screen = mountManual({ manual: manualPayload({ state: "gap", nextAt: iso(SERVER_NOW + 125000) }), mount: { clock } });
  screen.controller.show();
  await settle();
  assert.equal(manualMetric(screen, "next"), "2분 05초 뒤");
  assert.equal(manualButtonFor(screen).textContent, "2분 05초 뒤");
  const tickers = () => screen.intervals.filter((entry) => entry.ms === 1000);
  assert.equal(tickers().length, 1);
  const getsBefore = screen.server.gets.length;
  clock.now += 5000;
  tickers().at(-1).fn();
  assert.equal(manualMetric(screen, "next"), "2분 00초 뒤");
  assert.equal(manualButtonFor(screen).textContent, "2분 00초 뒤");
  assert.equal(manualButtonFor(screen).disabled, true);
  // 초 세기는 화면 읽기 프로그램에 매초 알리지 않는다(알림 칸은 상태 알약이 바뀔 때만 바뀐다)
  const announce = screen.host.querySelector("[data-coupang-rank-manual-announce]");
  assert.equal(announce.textContent, "지금 확인 상태: 3분 간격 기다리는 중");
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-line]").getAttribute("aria-live"), null);
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-box]").getAttribute("role"), "group", "상태판은 알림 칸(role=status)이 아니다");
  clock.now += 121000;
  tickers().at(-1).fn();
  assert.equal(manualMetric(screen, "next"), "지금 가능");
  assert.equal(manualPill(screen), "바로 확인 가능");
  assert.equal(announce.textContent, "지금 확인 상태: 바로 확인 가능");
  assert.equal(manualButtonFor(screen).textContent, "지금 확인");
  assert.equal(manualButtonFor(screen).disabled, false);
  assert.equal(screen.server.gets.length, getsBefore, "초 세기는 서버에 묻지 않는다");
  // 탭이 숨으면 타이머를 멈추고, 다시 보이면 다시 그린다
  const hidden = mountManual({ manual: manualPayload({ state: "gap", nextAt: iso(SERVER_NOW + 125000) }) });
  hidden.controller.show();
  await settle();
  const count = hidden.intervals.filter((entry) => entry.ms === 1000).length;
  hidden.document.hidden = true;
  hidden.intervals.filter((entry) => entry.ms === 1000).at(-1).fn();
  hidden.document.listeners.visibilitychange.forEach((fn) => fn());
  hidden.document.hidden = false;
  hidden.document.listeners.visibilitychange.forEach((fn) => fn());
  assert.equal(hidden.intervals.filter((entry) => entry.ms === 1000).length, count + 1, "다시 보이면 타이머를 새로 건다");
  hidden.controller.destroy();
  assert.equal(hidden.document.listeners.visibilitychange.length, 0, "destroy 가 문서 리스너를 지운다");
});

test("서버가 '다른 확인 진행 중'이면 끝날 시각 + 2초에 목록을 한 번만 다시 받는다", async () => {
  const screen = mountManual({ manual: manualPayload({ state: "busy", busyUntil: iso(SERVER_NOW + 30000) }) });
  screen.controller.show();
  await settle();
  assert.match(manualLine(screen).textContent, /다른 확인이 진행 중입니다/u);
  const refresh = screen.timeouts.filter((entry) => entry.ms >= 31000 && entry.ms <= 32500);
  assert.equal(refresh.length, 1);
  const before = screen.server.gets.length;
  refresh[0].fn();
  await settle();
  assert.equal(screen.server.gets.length, before + 1);
  assert.equal(screen.timeouts.filter((entry) => entry.ms >= 31000 && entry.ms <= 32500).length, 1, "같은 busyUntil 이면 다시 걸지 않는다");
});

test("'내 크롬 확장' 줄: 상태 알약·확장 상태·ID·zip 내려받기·설치 안내(접이식). 끄기(바로)·켜기(확인 창)는 상태판에서, 결과는 누른 자리 옆에", async () => {
  const screen = mountManual();
  screen.controller.show();
  await settle();
  // 확장 칸은 자동 수집 칸과 따로 있다(자동 수집 칸을 펼치지 않아도 보이고, 펼쳐도 수집기 상태 요청을 따라 보내지 않는다).
  const ext = screen.host.querySelector("[data-coupang-rank-ext]");
  assert.equal(ext.tagName, "DETAILS");
  assert.equal(ext.hidden, false);
  assert.equal(ext.querySelector("summary").textContent, "내 크롬 확장정상설치됨 v1.0.0 · 시크릿 허용 켜짐 · 사이트 액세스 허용 · 확장 내려받기 · 설치 안내");
  const owner = screen.host.querySelector("[data-coupang-rank-owner]");
  assert.equal(owner.querySelector('[data-coupang-rank-owner-section="manual"]'), null, "자동 수집 칸 안에는 지금 확인 구역이 없다");
  const section = ext.querySelector('[data-coupang-rank-owner-section="manual"]');
  assert.equal(ext.querySelector("[data-coupang-rank-owner-manual-state]").textContent, "정상");
  assert.deepEqual(section.querySelector("[data-coupang-rank-manual-owner-lines]").children.map((node) => node.textContent), [
    "켜짐 · 오늘 3/30번 · 09~19시 · 검색 사이 3분",
    "확장: 설치됨 v1.0.0 · 시크릿 허용 켜짐 · 사이트 액세스 허용",
  ]);
  assert.equal(section.querySelectorAll('[data-coupang-rank-action="manual-disable"]').length, 0, "켜기·끄기는 상태판 한 곳에만");
  assert.equal(section.querySelector("[data-coupang-rank-manual-id]").textContent, EXT_ID);
  const link = section.querySelector("[data-coupang-rank-manual-download]");
  assert.equal(link.tagName, "A");
  assert.equal(link.getAttribute("href"), "/coupang-check/mi-coupang-check-1.0.0.zip", "서버가 준 빌드 산출물 경로");
  assert.equal(link.getAttribute("download"), "mi-coupang-check-1.0.0.zip");
  const guide = section.querySelector("[data-coupang-rank-manual-guide]");
  assert.equal(guide.tagName, "DETAILS");
  assert.equal(guide.open, false, "설치 안내는 접혀 있다");
  const steps = guide.querySelectorAll("li");
  assert.equal(steps.length, 9);
  const guideText = guide.textContent;
  for (const expected of ["mi-coupang-check-1.0.0.zip 이 생깁니다", "생긴 mi-coupang-check 폴더를 홈 폴더", "압축해제된 확장 프로그램 로드(Load unpacked)", "시크릿 모드에서 허용(Allow in Incognito)",
    "'사이트 액세스'는 바꾸지 않습니다", "업데이트: 홈/모먼트인사이트 의 옛 mi-coupang-check 폴더를 휴지통에", "N30 크롬 재시작과 겹치면"]) {
    assert.ok(guideText.includes(expected), expected);
  }
  assert.ok(!guideText.includes("mi-coupang-check-1.0.0 폴더"), "zip 안 폴더는 버전 없는 고정 이름");
  const bold = guide.querySelectorAll("strong").map((node) => node.textContent);
  assert.ok(bold.some((text) => text.includes("Profile 3") && text.includes("Profile 5")));
  assert.ok(bold.includes("개발자 모드는 계속 켜 두세요. 끄면 이 확장도 바로 꺼집니다."));
  // 확장 상태 다시 보기 → hello. 결과는 이 칸 안 한 줄(aria-live)에 쓴다(자동 수집 패널 문구 자리가 아니라).
  const hellos = screen.bridge.of("mi-coupang-hello").length;
  dispatch(section.querySelector('[data-coupang-rank-action="manual-hello"]'), "click");
  await settle();
  assert.equal(screen.bridge.of("mi-coupang-hello").length, hellos + 1);
  const extNote = ext.querySelector("[data-coupang-rank-ext-note]");
  assert.equal(extNote.getAttribute("aria-live"), "polite");
  assert.match(extNote.textContent, /^확장 상태를 다시 확인했습니다\. 확장: 설치됨 v1\.0\.0/u);
  assert.equal(owner.querySelector("[data-coupang-rank-owner-status]").textContent, "");
  assert.equal(countCalls(screen, "view=collector"), 0, "확장 칸은 수집기 상태를 따로 받지 않는다");
  // 끄기: 상태판에서 확인 창 없이 바로(비상 정지), 카드 버튼이 바로 사라지고 상태판은 '꺼짐'으로 남는다.
  const confirms = screen.confirmCalls.length;
  screen.server.manual = manualPayload({ state: "off", enabled: false });
  dispatch(screen.host.querySelector('[data-coupang-rank-action="manual-disable"]'), "click");
  assert.equal(manualButtons(screen).length, 0, "응답을 기다리지 않고 숨긴다");
  assert.equal(manualPill(screen), "꺼짐");
  await settle();
  assert.equal(screen.confirmCalls.length, confirms);
  assert.deepEqual(screen.server.of("settings-update").at(-1).body, { action: "settings-update", settings: { manualEnabled: false } });
  const note = screen.host.querySelector("[data-coupang-rank-manual-note]");
  assert.equal(note.textContent, "지금 확인을 껐습니다. 카드의 '지금 확인' 버튼이 사라지고, 서버도 새 확인을 받지 않습니다.");
  assert.equal(note.getAttribute("aria-live"), "polite");
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-box]").hidden, false, "꺼져도 상태판은 본문에 남는다");
  assert.equal(ext.querySelector("[data-coupang-rank-owner-manual-state]").textContent, "지금 확인 꺼짐");
  assert.ok(ext.textContent.includes("꺼짐 — 위 '지금 확인' 상태판에서 켤 수 있습니다"));
  // 켜기: 확인 창(대표 결정값 문구) → 취소면 요청 없음
  const before = screen.server.of("settings-update").length;
  screen.window.confirm = (message) => { screen.confirmCalls.push(message); return false; };
  dispatch(screen.host.querySelector('[data-coupang-rank-action="manual-enable"]'), "click");
  await settle();
  assert.equal(screen.server.of("settings-update").length, before);
  assert.match(screen.confirmCalls.at(-1), /검색 사이 3분 · 하루 30번 · 09~19시, 차단으로 보이는 화면이 나오면 그날 중지/u);
  screen.window.confirm = (message) => { screen.confirmCalls.push(message); return true; };
  screen.server.manual = manualPayload();
  dispatch(screen.host.querySelector('[data-coupang-rank-action="manual-enable"]'), "click");
  await settle();
  assert.deepEqual(screen.server.of("settings-update").at(-1).body, { action: "settings-update", settings: { manualEnabled: true } });
  assert.equal(manualButtons(screen).length, 2);
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-note]").textContent, "지금 확인을 켰습니다. 카드마다 '지금 확인' 버튼이 보입니다.");
});

test("끄기가 서버에서 거절되면 목록을 다시 받아 원래대로 돌리고, 그 이유를 상태판 안 한 줄에 남긴다", async () => {
  const screen = mountManual({ settings: { __status: 500, payload: { ok: false, code: "COUPANG_RANK_TRACKERS_FAILED" } } });
  screen.controller.show();
  await settle();
  dispatch(screen.host.querySelector('[data-coupang-rank-action="manual-disable"]'), "click");
  assert.equal(manualPill(screen), "꺼짐", "누르면 바로 숨긴다");
  await settle();
  assert.equal(manualPill(screen), "바로 확인 가능", "서버 값으로 돌아왔다");
  assert.equal(manualButtons(screen).length, 2);
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-note]").textContent, "끄지 못해 원래 상태로 돌렸습니다: 서버 처리 중 오류가 났습니다. 잠시 뒤 다시 시도하세요.");
});

test("'내 크롬 확장' 줄: SQL 전이면 켜기 단추 없음, 이상한 zip 경로·확장 ID 는 그리지 않는다, '설치 안내 열기'는 이 줄과 안내만 연다", async () => {
  const setup = mountManual({ manual: manualPayload({ state: "setup_required" }) });
  setup.controller.show();
  await settle();
  const setupSection = setup.host.querySelector('[data-coupang-rank-owner-section="manual"]');
  assert.equal(setup.host.querySelector("[data-coupang-rank-ext]").hidden, false);
  assert.ok(setupSection.textContent.includes("대표 SQL(지금 확인) 실행 전입니다"));
  assert.equal(setup.host.querySelectorAll('[data-coupang-rank-action="manual-enable"]').length, 0);
  assert.equal(setup.host.querySelector("[data-coupang-rank-manual-box]").hidden, true, "SQL 전이면 상태판은 숨긴다");
  const odd = mountManual({ manual: manualPayload({ extensionZipPath: "https://example.com/x.zip", extensionId: "NOT-AN-ID" }) });
  odd.controller.show();
  await settle();
  const oddSection = odd.host.querySelector('[data-coupang-rank-owner-section="manual"]');
  assert.equal(oddSection.querySelectorAll("[data-coupang-rank-manual-download]").length, 0);
  assert.ok(oddSection.textContent.includes("확장 내려받기 파일 경로를 서버에서 받지 못했습니다"));
  assert.equal(oddSection.querySelector("[data-coupang-rank-manual-id]").textContent, "서버에서 받지 못함");
  assert.equal(odd.bridge.messages.length, 0, "확장 ID 가 없으면 아무 확장에도 묻지 않는다");
  assert.match(manualLine(odd).textContent, /확장 ID/u);
  assert.equal(manualPill(odd), "확장 확인 필요");
  const missing = mountManual({ hello: { ok: false, code: "extension_no_response" } });
  missing.controller.show();
  await settle();
  assert.equal(manualPill(missing), "확장 확인 필요");
  assert.equal(missing.host.querySelector("[data-coupang-rank-owner-manual-state]").textContent, "확인 필요");
  dispatch(missing.host.querySelector('[data-coupang-rank-action="manual-guide-open"]'), "click");
  assert.equal(missing.host.querySelector("[data-coupang-rank-ext]").open, true);
  assert.equal(missing.host.querySelector("[data-coupang-rank-manual-guide]").open, true);
  assert.equal(missing.host.querySelector("[data-coupang-rank-owner]").open, false, "자동 수집 칸은 펼치지 않는다");
  await settle();
  assert.equal(countCalls(missing, "view=collector"), 0, "설치 안내를 열어도 수집기 상태 요청이 따라가지 않는다");
});

test("기본 확장 다리: chrome.runtime.sendMessage(확장 ID, 메시지, 콜백), lastError 는 콜백 안에서 읽는다", async () => {
  const sent = [];
  const runtime = {
    lastError: null,
    sendMessage(id, message, callback) {
      sent.push({ id, message });
      runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
      callback(undefined);
      runtime.lastError = null;
    },
  };
  const server = fakeServer();
  const screen = mountWith({ fetch: server.respond, local: makeStorage(), chrome: { runtime }, userAgent: CHROME_UA, deferTimersFrom: 15000 });
  screen.controller.show();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ id: EXT_ID, message: { type: "mi-coupang-hello" } }]);
  assert.match(manualLine(screen).textContent, /확장이 없거나 꺼져 있습니다/u);
  assert.equal(screen.timeouts.filter((entry) => entry.ms === 5000).length, 0, "5초 hello 제한은 15초 미만이라 바로 돈다(시험 시계)");
  const okRuntime = { lastError: null, sendMessage(id, message, callback) { callback(helloReply()); } };
  const okScreen = mountWith({ fetch: fakeServer().respond, local: makeStorage(), chrome: { runtime: okRuntime }, userAgent: CHROME_UA });
  okScreen.controller.show();
  await settle();
  assert.equal(manualPill(okScreen), "바로 확인 가능");
  assert.equal(manualLine(okScreen).textContent, "카드의 '지금 확인'을 누르면 이 크롬이 새 시크릿 창으로 쿠팡 검색 1쪽을 한 번 열고 닫습니다.");
  const none = mountWith({ fetch: fakeServer().respond, local: makeStorage(), userAgent: CHROME_UA });
  none.controller.show();
  await settle();
  assert.match(manualLine(none).textContent, /확장이 없거나 꺼져 있습니다/u, "chrome.runtime 이 없으면 확장 없음");
});

test("지금 확인 칸은 목록 캐시에 남기지 않고, 캐시로 먼저 그릴 때는 버튼이 없다", async () => {
  const storage = makeStorage();
  const screen = mountManual({ mount: { storage } });
  screen.controller.show();
  await settle();
  const cached = JSON.parse(storage.getItem("miCoupangRank:v1:owner:mml93-a01"));
  assert.equal(Object.hasOwn(cached.payload, "manual"), false);
  assert.ok(!JSON.stringify(cached).includes(EXT_ID));
  const second = mountManual({ mount: { storage }, server: { respond: () => new Promise(() => {}), posts: [], gets: [], of: () => [] } });
  second.controller.show();
  assert.ok(second.host.querySelectorAll("[data-coupang-rank-card]").length > 0, "캐시로 먼저 그린다");
  assert.equal(manualButtons(second).length, 0, "서버 값을 받기 전에는 지금 확인을 보이지 않는다");
});

test("claim 을 받는 사이 화면이 잠기면(reset) 확장에 check 를 보내지 않는다", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let observerCallback = null;
  class FakeMutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const screen = mountManual({ claim: async () => { await gate; return { ok: true, claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, keyword: KEYWORD, manual: manualPayload({ state: "busy" }) }; },
    mount: { MutationObserver: FakeMutationObserver } });
  screen.controller.show();
  await settle();
  dispatch(manualButtonFor(screen), "click");
  await settle();
  screen.root.classList.add("is-locked");
  observerCallback([]);
  release();
  await settle();
  assert.equal(screen.bridge.of("mi-coupang-check").length, 0);
});

test("지금 확인 CSS: 새 선택자 짝·토큰 색·휴대폰 줄바꿈", () => {
  for (const name of ["mi-coupang-rank-manual", "mi-coupang-rank-manual-line", "mi-coupang-rank-manual-banner", "mi-coupang-rank-manual-result", "mi-coupang-rank-manual-button",
    "mi-coupang-rank-manual-guide", "mi-coupang-rank-manual-steps", "mi-coupang-rank-manual-id", "mi-coupang-rank-manual-download"]) {
    assert.ok(new RegExp(`#mi-admin [^{]*\\.${name}\\b`, "u").test(cssSource), `#mi-admin ${name}`);
    assert.ok(new RegExp(`#mi-clean [^{]*\\.${name}\\b`, "u").test(cssSource), `#mi-clean ${name}`);
  }
  const banner = cssSource.slice(cssSource.indexOf("#mi-admin .mi-coupang-rank-manual-banner,"));
  const rule = banner.slice(0, banner.indexOf("}"));
  for (const declaration of ["border: 1px solid var(--mi-warn);", "background: var(--mi-warn-bg);", "overflow-wrap: anywhere;"]) assert.ok(rule.includes(declaration), declaration);
  const phone = cssSource.slice(cssSource.indexOf("@media (max-width: 720px)"));
  assert.ok(phone.includes("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-manual-line,"));
});

// ── 화면 디테일 고도화(대표 승인 2026-10-23) ─────────────────────────

test("등록 결과의 첫 기록 안내는 지금 방식(지금 확인 켜짐·자동 수집·둘 다 꺼짐)에 맞춘다", async () => {
  const created = trackerFixture({ id: "6c1f0000-0000-4000-8000-000000000003", keyword: "새 키워드", current: null, days: [] });
  const cases = [
    [{ manual: manualPayload() }, "등록했습니다. 새 카드의 '지금 확인'을 누르면 첫 순위가 기록됩니다."],
    [{ manual: manualPayload({ state: "off", enabled: false }), collector: { state: "not_connected" } }, "등록했습니다. '지금 확인'을 켠 뒤 새 카드의 '지금 확인'을 누르면 첫 순위가 기록됩니다."],
    // 자동 수집이 실제로 기록 중일 때만 '다음 수집 때', 켜 둔 뒤의 경보면 언제 기록될지 단정하지 않는다(2026-10-23 재검사)
    [{ manual: manualPayload({ state: "off", enabled: false }), collector: { state: "ok" } }, "등록했습니다. 다음 수집 때(수집기가 켜져 있을 때) 첫 순위가 기록됩니다."],
    [{ manual: manualPayload({ state: "off", enabled: false }), collector: { state: "review" } }, "등록했습니다. 자동 수집이 멈췄거나 확인이 필요한 상태라 첫 순위가 언제 기록될지 알 수 없습니다(자동추적 칸 참고)."],
  ];
  for (const [overrides, expected] of cases) {
    const screen = mountWith({
      local: makeStorage(),
      userAgent: CHROME_UA,
      extensionBridge: fakeBridge(),
      fetch: async (url, init) => {
        if (init.method === "POST") return response({ ok: true, firstCheck: "queued", tracker: created });
        return response(listPayload(overrides));
      },
    });
    screen.controller.show();
    await settle();
    screen.host.querySelector("[data-coupang-rank-keyword]").value = "새 키워드";
    screen.host.querySelector("[data-coupang-rank-product-url]").value = "https://www.coupang.com/vp/products/123456";
    dispatch(screen.host.querySelector("[data-coupang-rank-create-form]"), "submit");
    await settle();
    assert.equal(screen.host.querySelector("[data-coupang-rank-status]").textContent, expected);
    const newCard = screen.host.querySelector('[data-coupang-rank-card][data-coupang-rank-id="6c1f0000-0000-4000-8000-000000000003"]');
    assert.ok(newCard, "새 카드가 목록에 있다");
  }
  // 오늘 같은 키워드를 이미 확인했으면 서버가 바로 채운다(recorded).
  assert.ok(moduleSource.includes('recorded: "오늘 같은 키워드를 확인한 기록으로 바로 채웠습니다"'));
});

const boardOf = (input) => JSON.parse(JSON.stringify(internals.manualBoardModel({ now: SERVER_NOW, trackers: [], todayKst: "2026-10-23", autoActive: false, ...input })));

test("상태판 알약은 manualView 의 모든 갈래를 덮고(꺼짐·용량·대표 확인·쉬는 중·보내지 못함·응답 없음·다른 창 등), 숫자는 서버 값으로 쓴다", () => {
  const server = (overrides) => manualPayload({ busyUntil: iso(SERVER_NOW + 60000), stoppedDay: "2026-10-23", ...(overrides.state === "gap" ? { nextAt: iso(SERVER_NOW + 60000) } : {}), ...overrides });
  const pillOf = (input) => boardOf({ server: input.server, view: view(input) }).pill;
  // 서버 상태 전부(SQL 전은 상태판을 숨기므로 뺀다). 모르는 상태 문구('확인 필요(코드 …)')가 나오지 않는다.
  for (const stateName of ["off", "budget", "stopped", "cooldown", "hours", "busy", "daily_cap", "gap", "ready"]) {
    const input = { server: server({ state: stateName }), ...(stateName === "hours" ? { now: Date.parse("2026-10-23T11:00:00.000Z") } : {}) };
    const pill = boardOf({ server: input.server, now: input.now, view: view(input) }).pill;
    assert.ok(pill.text && !/확인 필요\(코드/u.test(pill.text), `${stateName}: ${pill.text}`);
  }
  if (Array.isArray(contract.MANUAL_STATES)) {
    for (const stateName of contract.MANUAL_STATES.filter((name) => name !== "setup_required")) {
      assert.doesNotMatch(pillOf({ server: server({ state: stateName }) }).text, /확인 필요\(코드/u, stateName);
    }
  }
  assert.deepEqual(pillOf({ server: server({ state: "ready" }) }), { text: "바로 확인 가능", tone: "is-ok" });
  assert.deepEqual(pillOf({ server: server({ state: "gap" }) }), { text: "3분 간격 기다리는 중", tone: "is-wait" });
  assert.deepEqual(pillOf({ server: server({ state: "off", enabled: false }) }), { text: "꺼짐", tone: "is-muted" });
  assert.deepEqual(pillOf({ server: server({ state: "stopped" }) }), { text: "오늘은 멈춤", tone: "is-warn" });
  assert.deepEqual(pillOf({ server: server({ state: "budget" }) }), { text: "용량 상한으로 멈춤", tone: "is-warn" });
  assert.deepEqual(pillOf({ server: server({ state: "review" }) }), { text: "대표 확인 필요", tone: "is-warn" });
  assert.deepEqual(pillOf({ server: server({ state: "cooldown" }) }), { text: "쉬는 중", tone: "is-warn" });
  assert.deepEqual(pillOf({ server: server({ state: "daily_cap", usedToday: 30 }) }), { text: "오늘 30번 다 씀", tone: "is-muted" });
  assert.deepEqual(pillOf({ server: server({ state: "busy" }) }), { text: "다른 확인 진행 중", tone: "is-wait" });
  assert.deepEqual(pillOf({ server: server({ state: "busy" }), ownUnsent: true }), { text: "결과 보내지 못함", tone: "is-warn" });
  assert.deepEqual(pillOf({ server: server({ state: "busy" }), unsentMaybe: true }), { text: "보내지 못한 결과 있음", tone: "is-warn" });
  assert.deepEqual(pillOf({ server: server({ state: "busy" }), ownLost: true }), { text: "응답 없이 끝남", tone: "is-warn" });
  assert.deepEqual(pillOf({ server: server({ state: "busy" }), ownPending: true }), { text: "확인 중", tone: "is-wait" });
  assert.deepEqual(pillOf({ server: server({ state: "ready" }), run: { phase: "check" } }), { text: "확인 중", tone: "is-wait" });
  assert.deepEqual(pillOf({ server: server({ state: "ready" }), hello: null }), { text: "확장 확인 중", tone: "is-muted" });
  assert.deepEqual(pillOf({ server: server({ state: "ready" }), hello: { status: "missing" } }), { text: "확장 확인 필요", tone: "is-warn" });
  assert.deepEqual(pillOf({ server: server({ state: "ready" }), hello: helloOk({ busy: true }) }), { text: "확장 작업 중", tone: "is-wait" });
  assert.deepEqual(pillOf({ server: server({ state: "ready" }), hello: helloOk({ incognitoWindowOpen: true }) }), { text: "다른 시크릿 창 열림", tone: "is-warn" });
  assert.deepEqual(pillOf({ server: server({ state: "made_up" }) }), { text: "확인 필요(코드 made_up)", tone: "is-warn" });
  // 숫자(간격·하루 상한·시간)는 서버 값으로 채운다(DB 에서 바뀔 수 있다).
  const custom = manualPayload({ state: "gap", minGapSeconds: 240, maxPerDay: 20, usedToday: 7, fromHour: 10, toHour: 18, nextAt: iso(SERVER_NOW + 95000) });
  const model = boardOf({ server: custom, view: view({ server: custom }) });
  assert.equal(model.pill.text, "4분 간격 기다리는 중");
  assert.deepEqual([model.metrics.next.value, model.metrics.next.note], ["1분 35초 뒤", "검색 사이 4분"]);
  assert.deepEqual([model.metrics.used.value, model.metrics.used.note], ["7 / 20번", "10~18시 · 내일 10시에 다시 20번"]);
  assert.equal(boardOf({ server: manualPayload({ state: "daily_cap", maxPerDay: 20, usedToday: 20 }), view: view({ server: manualPayload({ state: "daily_cap", maxPerDay: 20, usedToday: 20 }) }) }).pill.text, "오늘 20번 다 씀");
  // 쉬는 중·대표 확인·용량 상한은 자동 수집 칸의 '쉬는 중 해제'로 안내한다(지금 확인이 막혀도 그 칸을 열 이유를 보인다).
  for (const stateName of ["cooldown", "review", "budget"]) assert.equal(boardOf({ server: server({ state: stateName }), view: view({ server: server({ state: stateName }) }) }).jump, true, stateName);
  assert.equal(boardOf({ server: server({ state: "ready" }), view: view({ server: server({ state: "ready" }) }) }).jump, false);
  // 시간 밖: 다음에 열리는 시각(서버 시각 기준)
  const late = Date.parse("2026-10-23T11:00:00.000Z"); // KST 20:00
  assert.equal(boardOf({ server: server({ state: "hours" }), now: late, view: view({ server: server({ state: "hours" }), now: late }) }).metrics.next.value, "내일 09:00");
  const early = Date.parse("2026-10-22T22:30:00.000Z"); // KST 07:30
  assert.equal(boardOf({ server: server({ state: "hours", serverTime: iso(early) }), now: early, view: view({ server: server({ state: "hours", serverTime: iso(early) }), now: early }) }).metrics.next.value, "오늘 09:00");
  // 꺼짐인데 자동 수집이 도는 중이면 '순위가 기록되지 않는다'고 하지 않는다(서버는 둘을 함께 켜지 않는다).
  const off = server({ state: "off", enabled: false });
  assert.equal(boardOf({ server: off, view: view({ server: off }), autoActive: true }).line, "자동 수집으로 기록 중입니다(지금 확인은 꺼짐). 카드의 '지금 확인' 버튼은 숨겨져 있습니다.");
  assert.equal(boardOf({ server: off, view: view({ server: off }), autoActive: false }).line, "꺼져 있어 지금은 새 순위를 기록하지 않습니다. 카드의 '지금 확인' 버튼도 숨겨져 있습니다.");
  // 켜 둔 뒤의 경보·모르는 상태에서는 '기록 중'이라고 하지 않는다(자동추적 칸으로 보낸다).
  assert.equal(boardOf({ server: off, view: view({ server: off }), autoState: "recording" }).line, "자동 수집으로 기록 중입니다(지금 확인은 꺼짐). 카드의 '지금 확인' 버튼은 숨겨져 있습니다.");
  assert.equal(boardOf({ server: off, view: view({ server: off }), autoState: "alarm" }).line,
    "자동 수집이 켜져 있지만 멈췄거나 확인이 필요한 상태입니다. 아래 자동추적 칸의 경보를 확인하세요(지금 확인은 꺼짐). 카드의 '지금 확인' 버튼은 숨겨져 있습니다.");
  assert.equal(boardOf({ server: off, view: view({ server: off }), autoState: "unknown", autoCode: "zzz_unknown" }).line,
    "자동 수집 상태를 알 수 없습니다(코드 zzz_unknown). 아래 자동추적 칸을 확인하세요(지금 확인은 꺼짐). 카드의 '지금 확인' 버튼은 숨겨져 있습니다.");
  assert.doesNotMatch(boardOf({ server: off, view: view({ server: off }), autoState: "" }).line, /기록되지 않습니다/u, "앞으로의 일만 말한다(진행 중이던 확인은 기록될 수 있다)");
  assert.equal(boardOf({ server: off, view: view({ server: off }) }).toggle, "enable");
  // 상태판 한 줄은 '지금 확인:' 머리말을 뺀다(제목이 이미 '지금 확인').
  assert.equal(boardOf({ server: server({ state: "budget" }), view: view({ server: server({ state: "budget" }) }) }).line, "저장 용량 상한으로 멈춰 있습니다(대표 확인 필요).");
});

test("카드 '지금 확인' 버튼 글자가 곧 상태다: 지금 확인 · N분 NN초 뒤 · 확인 중… · 내일/오늘 HH:00", () => {
  const label = (server, extra = {}) => internals.manualButtonLabel(view({ server, ...extra }), extra.mine === true, server, extra.now ?? SERVER_NOW);
  assert.equal(label(manualPayload()), "지금 확인");
  assert.equal(label(manualPayload({ state: "gap", nextAt: iso(SERVER_NOW + 118000) })), "1분 58초 뒤");
  assert.equal(label(manualPayload(), { mine: true }), "확인 중…");
  assert.equal(label(manualPayload({ state: "daily_cap", usedToday: 30 })), "내일 09:00");
  assert.equal(label(manualPayload({ state: "stopped", stoppedDay: "2026-10-23" })), "내일 09:00");
  assert.equal(label(manualPayload({ state: "hours" }), { now: Date.parse("2026-10-23T11:00:00.000Z") }), "내일 09:00");
});

test("누른 카드의 짧은 결과(방금 확인 …)는 결과 갈래마다 맞는 말이고, 실패는 주황", () => {
  const ok = (payload) => ({ payload: { ok: true, accepted: true, duplicate: false, stopped: false, ...payload }, httpStatus: 200 });
  const measured = { outcome: "measured", page: measuredPage() };
  const note = (recorded, parsed = measured) => JSON.parse(JSON.stringify(internals.manualCardNote(internals.manualRecordText(recorded, parsed, KEYWORD, manualPayload()), recorded, parsed)));
  assert.deepEqual(note(ok({ status: "ok", matched: 1, tracker: { result: "found", rank: 12 } })), { text: "일반 12위로 기록", tone: "is-ok" });
  assert.deepEqual(note(ok({ status: "ok", matched: 2, tracker: { result: "out" } })), { text: "50위 밖으로 기록 · 같은 키워드 2개 함께", tone: "is-ok" });
  assert.deepEqual(note(ok({ status: "noresult", matched: 1 })), { text: "'결과 없음'으로 기록", tone: "is-ok" });
  assert.deepEqual(note(ok({ status: "blocked", stopped: true })), { text: "차단으로 보여 오늘 멈춤", tone: "is-warn" });
  assert.deepEqual(note(ok({ status: "partial" })), { text: "실패: 순위를 기록하지 않음(사유는 위 '직전 확인')", tone: "is-warn" });
  assert.deepEqual(note({ payload: { ok: false }, transport: true, httpStatus: 0 }), { text: "결과를 서버에 보내지 못함(위 상태판 참고)", tone: "is-warn" });
  assert.deepEqual(note(ok({ accepted: false, outcome: "not_started" }), { outcome: "not_started", code: "busy" }), { text: "시작하지 않음 · 쿠팡 검색 안 함", tone: "is-warn", notStarted: true });
  assert.deepEqual(note(ok({ accepted: false, outcome: "lost" }), { outcome: "lost", code: "extension_no_response" }), { text: "확장 응답 없음 · 검색 여부 모름", tone: "is-warn" });
});

test("'오늘 확인' 판정은 한 함수(응답 todayKst 기준): 카드 알약 · '오늘 안 함' 필터·개수 · 상태판 '오늘 확인한 상품'이 같은 값을 쓴다", async () => {
  const todayKst = "2026-10-17";
  // ① 오늘 성공 ② 오늘 실패(실패도 그날 칸이 생긴다) ③ 어제까지만 ④ 일시중지(오늘 칸 없음) ⑤ 기록 없음
  const trackers = [
    trackerFixture({ id: "6c1f0000-0000-4000-8000-0000000000a1", keyword: "가", keywordKey: "가" }),
    trackerFixture({ id: "6c1f0000-0000-4000-8000-0000000000a2", keyword: "나", keywordKey: "나", days: [{ d: todayKst, s: "failed", r: null, n: null, a: null, t: "16:31", c: 0, f: 2, b: null, k: 0 }, { d: "2026-10-16", s: "found", r: 9, n: 50, a: null, t: "10:05", c: 1, f: 0, b: 9, k: 0 }] }),
    trackerFixture({ id: "6c1f0000-0000-4000-8000-0000000000a3", keyword: "다", keywordKey: "다", days: [{ d: "2026-10-16", s: "found", r: 31, n: 50, a: null, t: "19:02", c: 1, f: 0, b: 31, k: 0 }] }),
    trackerFixture({ id: "6c1f0000-0000-4000-8000-0000000000a4", keyword: "라", keywordKey: "라", status: "paused", pausedDay: "2026-10-16", days: [{ d: "2026-10-15", s: "found", r: 5, n: 50, a: null, t: "09:00", c: 1, f: 0, b: 5, k: 0 }] }),
    trackerFixture({ id: "6c1f0000-0000-4000-8000-0000000000a5", keyword: "마", keywordKey: "마", current: null, days: [], summary: { trend: "new", attention: false, attentionReasons: [] } }),
  ];
  // 순수 함수: 브라우저 날짜가 아니라 넘긴 todayKst 로만 판단한다.
  assert.equal(internals.checkedToday(trackers[1], todayKst), true);
  assert.equal(internals.checkedToday(trackers[1], "2026-10-18"), false);
  assert.equal(internals.checkedToday(trackers[1], ""), false);
  assert.equal(internals.todayCellOf(trackers[0], todayKst).t, "11:11");
  const pillOf = (tracker) => JSON.parse(JSON.stringify(internals.todayPill(tracker, todayKst)));
  assert.deepEqual(pillOf(trackers[0]), { text: "오늘 11:11 확인", tone: "is-today" });
  assert.deepEqual(pillOf(trackers[1]), { text: "오늘 실패 16:31", tone: "is-warn" });
  assert.deepEqual(pillOf(trackers[2]), { text: "오늘 아직 · 마지막 10-16 19:02", tone: "" });
  assert.deepEqual(pillOf(trackers[3]), { text: "마지막 확인 10-15 09:00", tone: "" });
  assert.deepEqual(pillOf(trackers[4]), { text: "아직 확인 전", tone: "" });
  assert.equal(internals.todayPill(trackers[0], ""), null, "오늘 날짜를 모르면 단정하지 않는다");
  assert.deepEqual(trackers.filter((tracker) => internals.filterMatches(tracker, { status: "today-none" }, todayKst)).map((tracker) => tracker.keyword), ["다", "마"]);
  assert.equal(trackers.filter((tracker) => internals.filterMatches(tracker, { status: "today-none" }, "")).length, 0);
  // 화면: 상태판 '오늘 확인한 상품' = 활성 4개 중 오늘 칸 있는 2개, '오늘 안 함 2', 링크 '안 한 상품 2개 보기'
  const screen = mountManual({ listOverrides: { trackers, todayKst } });
  screen.controller.show();
  await settle();
  assert.equal(manualMetric(screen, "today"), "2 / 4개");
  assert.equal(screen.host.querySelector('[data-coupang-rank-filter-status="today-none"]').textContent, "오늘 안 함 2");
  const link = screen.host.querySelector("[data-coupang-rank-manual-today]");
  assert.equal(link.textContent, "안 한 상품 2개 보기");
  assert.ok(link.parentNode.textContent.includes("일시중지 1개 빼고"));
  const failedCard = screen.host.querySelector('[data-coupang-rank-card][data-coupang-rank-id="6c1f0000-0000-4000-8000-0000000000a2"]');
  const failedPill = failedCard.querySelector("[data-coupang-rank-today]");
  assert.equal(failedPill.textContent, "오늘 실패 16:31");
  assert.ok(failedPill.classList.contains("is-warn"));
  dispatch(link, "click");
  assert.deepEqual(screen.host.querySelectorAll("[data-coupang-rank-card]").map((node) => node.getAttribute("data-coupang-rank-id")),
    ["6c1f0000-0000-4000-8000-0000000000a3", "6c1f0000-0000-4000-8000-0000000000a5"]);
  assert.equal(screen.host.querySelector('[data-coupang-rank-filter-status="today-none"]').getAttribute("aria-pressed"), "true");
  assert.equal(screen.host.querySelector("[data-coupang-rank-filter-count]").textContent, "5개 중 2개 표시");
});

test("'오늘 안 함' 필터에서 누른 카드는 기록 뒤 목록을 다시 받아도 다음 필터 변경 전까지 남고, 그 카드에 '방금 확인'이 보인다", async () => {
  const todayKst = "2026-10-17";
  const pendingId = "6c1f0000-0000-4000-8000-000000000002";
  const overrides = { todayKst, trackers: [trackerFixture(), trackerFixture({ id: pendingId, keyword: "강화유리 필름", keywordKey: "강화유리 필름", days: [] })] };
  const screen = mountManual({
    listOverrides: overrides,
    record: (body, server) => {
      // 기록 뒤 목록에서는 그 카드에 오늘 칸이 생긴다(필터 기준으로는 빠진다).
      overrides.trackers = [trackerFixture(), trackerFixture({ id: pendingId, keyword: "강화유리 필름", keywordKey: "강화유리 필름", days: [{ d: todayKst, s: "found", r: 7, n: 50, a: null, t: "12:00", c: 1, f: 0, b: 7, k: 0 }] })];
      server.manual = manualPayload({ state: "gap", usedToday: 4, nextAt: iso(SERVER_NOW + 180000) });
      return { ok: true, accepted: true, duplicate: false, outcome: body.outcome, status: "ok", matched: 1, counted: true, stopped: false,
        tracker: { trackerId: pendingId, result: "found", rank: 7, organicCount: 50, adOrder: null, checkedAt: iso(SERVER_NOW + 20000) }, manual: server.manual };
    },
  });
  screen.controller.show();
  await settle();
  dispatch(screen.host.querySelector('[data-coupang-rank-filter-status="today-none"]'), "click");
  assert.deepEqual(screen.host.querySelectorAll("[data-coupang-rank-card]").map((node) => node.getAttribute("data-coupang-rank-id")), [pendingId]);
  dispatch(manualButtonFor(screen, pendingId), "click");
  await settle();
  assert.deepEqual(screen.host.querySelectorAll("[data-coupang-rank-card]").map((node) => node.getAttribute("data-coupang-rank-id")), [pendingId], "방금 누른 카드는 남는다");
  assert.match(cardNoteFor(screen, pendingId), /^방금 확인 \d{2}:\d{2} · 일반 7위로 기록$/u);
  assert.equal(screen.host.querySelector('[data-coupang-rank-filter-status="today-none"]').textContent, "오늘 안 함 0");
  assert.match(resultText(screen), /^확인 완료: .+ 일반 7위/u, "상태판 '직전 확인' 줄에도 남는다");
  // 필터를 바꾸면 놓아 준다.
  dispatch(screen.host.querySelector('[data-coupang-rank-filter-status="all"]'), "click");
  dispatch(screen.host.querySelector('[data-coupang-rank-filter-status="today-none"]'), "click");
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 0);
  assert.match(resultText(screen), /일반 7위/u, "카드가 목록에 없어도 결과는 상태판에 그대로 보인다");
});

test("결과의 추적 id 를 모르면(다른 탭·확장이 들고 있던 결과) 카드 표시 없이 상태판 '직전 확인'에만 보인다", async () => {
  const held = { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, stop: false, reply: { ...measuredReply(), claimId: CLAIM_ID, keyword: KEYWORD } };
  const screen = mountManual({
    hello: { ok: true, reply: helloReply({ pending: held }) },
    record: (body, server) => ({ ok: true, accepted: true, duplicate: false, status: "ok", matched: 1, stopped: false, tracker: null, manual: server.manual }),
  });
  screen.controller.show();
  await settle();
  assert.match(resultText(screen), /^앞서 끝나지 않은 확인 결과를 보냈습니다\. 확인 완료/u);
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card-note]").length, 0);
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-result]").getAttribute("aria-live"), "polite");
});

test("같은 키워드 카드가 2장 이상이면 '지금 확인' 옆에 '같은 키워드 N개 함께 기록'을 보인다(서버가 같은 keyword_key 를 함께 기록)", async () => {
  const twin = trackerFixture({ id: "6c1f0000-0000-4000-8000-0000000000b2", productId: "9000000001", productUrl: "https://www.coupang.com/vp/products/9000000001", days: [] });
  const screen = mountManual({ listOverrides: { trackers: [trackerFixture(), twin, trackerFixture({ id: "6c1f0000-0000-4000-8000-0000000000b3", keyword: "다른 말", keywordKey: "다른 말" })] } });
  screen.controller.show();
  await settle();
  const sameOf = (id) => {
    const card = screen.host.querySelector(`[data-coupang-rank-card][data-coupang-rank-id="${id}"]`);
    const node = card.querySelector(".mi-coupang-rank-same-kw");
    return node ? node.textContent : "";
  };
  assert.equal(sameOf(TRACKER_ID), "같은 키워드 2개 함께 기록");
  assert.equal(sameOf("6c1f0000-0000-4000-8000-0000000000b2"), "같은 키워드 2개 함께 기록");
  assert.equal(sameOf("6c1f0000-0000-4000-8000-0000000000b3"), "");
  assert.ok(screen.host.querySelector("[data-coupang-rank-guide]").textContent.includes("같은 키워드 카드는 한 번 누르면 함께 기록됩니다"));
});

test("자동추적 칸 표시 조건: 지금 확인 상태판이 있으면 수집기 0대·꺼짐일 때 숨기고, 켜 둔 뒤의 경보(review·budget·outdated·offline)는 보인다", async () => {
  const cases = [["not_connected", true], ["disabled", true], ["ok", false], ["idle_hours", false], ["review", false], ["budget", false], ["outdated", false], ["offline", false], ["cooldown", false], ["delayed", false]];
  for (const [stateName, hidden] of cases) {
    const screen = mountManual({ manual: manualPayload({ state: "off", enabled: false }), listOverrides: { collector: { state: stateName, lastSuccessAt: null, checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: null } } });
    screen.controller.show();
    await settle();
    assert.equal(screen.host.querySelector("[data-coupang-rank-strip]").hidden, hidden, stateName);
    assert.equal(screen.host.querySelector("[data-coupang-rank-manual-box]").hidden, false, stateName);
    // 카드 '다음' 알약도 같은 기준(자동 수집이 돌 때만)
    assert.equal(screen.host.querySelectorAll("[data-coupang-rank-next]").length, hidden ? 0 : 2, stateName);
    const line = manualLine(screen).textContent;
    // '기록 중'은 정상·갱신 대기·시간 밖만. 경보(review·budget·cooldown·outdated·offline)는 자동추적 칸 경보로 보낸다(2026-10-23 재검사).
    const recording = ["ok", "idle_hours", "delayed"].includes(stateName);
    assert.equal(line.startsWith("자동 수집으로 기록 중입니다"), recording, `${stateName}: ${line}`);
    if (!hidden && !recording) assert.ok(line.startsWith("자동 수집이 켜져 있지만 멈췄거나 확인이 필요한 상태입니다"), `${stateName}: ${line}`);
    if (hidden) assert.ok(line.startsWith("꺼져 있어 지금은 새 순위를 기록하지 않습니다"), `${stateName}: ${line}`);
  }
  // 빈 기록판·등록 문구도 같은 판정을 쓴다(지금 확인 꺼짐 + 자동 수집 없음 → '켜면 기록할 수 있습니다').
  const idle = mountManual({ manual: manualPayload({ state: "off", enabled: false }), listOverrides: { collector: { state: "not_connected" } } });
  idle.controller.show();
  await settle();
  assert.equal(idle.host.querySelectorAll(".mi-coupang-rank-board-empty")[0].textContent,
    "아직 순위 기록이 없습니다. 위 상태판에서 '지금 확인'을 켜면 이 카드에서 첫 순위를 기록할 수 있습니다.");
  const on = mountManual();
  on.controller.show();
  await settle();
  assert.equal(on.host.querySelectorAll(".mi-coupang-rank-board-empty")[0].textContent, "아직 순위 기록이 없습니다. 이 카드의 '지금 확인'을 누르면 첫 순위가 기록됩니다(검색 1번).");
});

function keydown(target, key) {
  const path = [];
  for (let node = target; node; node = node.parentNode) path.push(node);
  const event = { type: "keydown", key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const node of path) (node.listeners?.keydown || []).filter((entry) => !entry.capture).forEach((entry) => entry.fn(event));
  return event;
}

test("날짜 칸: 누르면(마우스·터치·Enter) 카드 아래 한 줄에 그날 기록, 다시 그려도 유지, 줄마다 탭 정지 하나 + 화살표로 옮김", async () => {
  const screen = mountWith();
  screen.controller.show();
  await flush();
  const card = () => screen.host.querySelector(`[data-coupang-rank-card][data-coupang-rank-id="${TRACKER_ID}"]`);
  const buttons = () => card().querySelectorAll("[data-coupang-rank-day]");
  const detail = () => card().querySelector("[data-coupang-rank-day-detail]");
  dispatch(buttons()[1], "click");
  assert.equal(detail().hidden, false);
  assert.equal(detail().textContent, "10-16(금) · 31위 — 19:02 일반 31위 · 하루 2회(실패 1) · 그날 최고 25위");
  assert.equal(detail().getAttribute("aria-live"), "polite");
  assert.deepEqual(buttons().map((node) => [node.getAttribute("aria-pressed"), node.getAttribute("tabindex")]), [["false", "-1"], ["true", "0"]]);
  assert.ok(buttons()[1].parentNode.classList.contains("is-selected"));
  // 목록을 다시 그려도(필터 바꿈 등) 펼친 날은 남는다.
  dispatch(screen.host.querySelector('[data-coupang-rank-filter-status="all"]'), "click");
  assert.equal(detail().hidden, false);
  assert.equal(buttons()[1].getAttribute("tabindex"), "0", "펼친 날이 탭 정지");
  // 화살표: ← 로 오늘 칸, Home·End
  const moved = keydown(buttons()[1], "ArrowLeft");
  assert.equal(moved.defaultPrevented, true);
  assert.equal(screen.document.activeElement, buttons()[0]);
  assert.deepEqual(buttons().map((node) => node.getAttribute("tabindex")), ["0", "-1"]);
  assert.equal(keydown(buttons()[0], "ArrowLeft").defaultPrevented, false, "끝에서는 그대로");
  keydown(buttons()[0], "End");
  assert.equal(screen.document.activeElement, buttons()[1]);
  assert.equal(keydown(buttons()[1], "Tab").defaultPrevented, false, "Tab 은 다음 카드로 그대로 나간다");
  // 다시 누르면 닫힌다(목록을 다시 그리지 않아 키보드 위치를 잃지 않는다).
  const before = buttons()[1];
  dispatch(before, "click");
  assert.equal(detail().hidden, true);
  assert.equal(buttons()[1], before, "카드를 다시 그리지 않았다");
});

test("자동 수집 칸: 접힌 머리는 목록 응답의 collector.state 로만(따로 요청하지 않음), 보류 중이면 안내 한 줄, 60초 다시 받기는 켜짐·연결 코드 30분 안일 때만", async () => {
  const idle = mountWith({ payload: listPayload({ collector: { state: "not_connected" } }) });
  idle.controller.show();
  await flush();
  const owner = idle.host.querySelector("[data-coupang-rank-owner]");
  assert.equal(owner.querySelector("summary").textContent, "자동 수집보류 중수집기 0대 · 설정·연결 코드·설치 줄은 그대로 있습니다");
  assert.equal(owner.querySelector("[data-coupang-rank-owner-hold]").hidden, false);
  assert.doesNotMatch(owner.querySelector("summary").textContent, /총관리자 전용|펼치면 상태를 받습니다|윙·광고센터/u, "머리에는 상태만(고정 사유 문장은 사용 방법으로)");
  assert.equal(countCalls(idle, "view=collector"), 0);
  owner.open = true;
  dispatch(owner, "toggle");
  await flush();
  assert.equal(countCalls(idle, "view=collector"), 1, "펼칠 때 1번");
  const tick = idle.intervals.filter((entry) => entry.ms === 60000).at(-1);
  assert.ok(tick, "패널 타이머는 걸린다");
  tick.fn();
  await flush();
  assert.equal(countCalls(idle, "view=collector"), 1, "꺼져 있으면 60초마다 다시 받지 않는다");
  // '수집 켜기'는 보조 버튼이고, 수집기 0대면 이유와 함께 막는다. 설정 칸 위에는 적용 범위 한 줄.
  const enable = owner.querySelector('[data-coupang-rank-action="collector-enable"]');
  assert.equal(enable.disabled, true);
  assert.ok(!enable.classList.contains("mi-button"));
  assert.equal(owner.querySelector("[data-coupang-rank-enable-block]").textContent, "연결된 수집기가 없어 켤 수 없습니다(아래 '연결 코드'부터).");
  assert.equal(owner.querySelector("[data-coupang-rank-settings-scope]").textContent, "이 설정은 자동 수집에만 적용됩니다. 지금 확인과는 따로입니다.");
  assert.ok(owner.textContent.includes("전체 고유 키워드 41 / 150개(모든 계정 합)"));
  idle.controller.destroy();

  const running = mountWith({ payload: listPayload({ collector: { state: "ok", lastSuccessAt: null, checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: null } }) });
  running.controller.show();
  await flush();
  assert.equal(running.host.querySelector("[data-coupang-rank-owner]").querySelector("[data-coupang-rank-owner-summary-state]").textContent, "켜짐");
  assert.equal(running.host.querySelector("[data-coupang-rank-owner-hold]").hidden, true);
  const panel = running.host.querySelector("[data-coupang-rank-owner]");
  panel.open = true;
  dispatch(panel, "toggle");
  await flush();
  const runningTick = running.intervals.filter((entry) => entry.ms === 60000).at(-1);
  runningTick.fn();
  await flush();
  assert.equal(countCalls(running, "view=collector"), 2, "자동 수집이 돌면 60초마다 다시 받는다");
  running.controller.destroy();
});

test("연결 코드를 만든 뒤 30분 안에는 자동 수집이 꺼져 있어도 60초마다 수집기 상태를 다시 받는다", async () => {
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") return response({ ok: true, id: "c2", label: "맥 미니", token: "mic1_" + "A".repeat(43), tokenHint: "AAAA" });
      if (String(url).includes("view=collector")) return response(collectorPayload({ collectors: [] }));
      return response(listPayload({ collector: { state: "not_connected" } }));
    },
  });
  screen.controller.show();
  await flush();
  const panel = screen.host.querySelector("[data-coupang-rank-owner]");
  panel.open = true;
  dispatch(panel, "toggle");
  await flush();
  const tick = screen.intervals.filter((entry) => entry.ms === 60000).at(-1);
  const before = countCalls(screen, "view=collector");
  tick.fn();
  await flush();
  assert.equal(countCalls(screen, "view=collector"), before, "코드 만들기 전: 다시 받지 않음");
  panel.querySelector("[data-coupang-rank-token-label]").value = "맥 미니";
  dispatch(panel.querySelector("[data-coupang-rank-token-form]"), "submit");
  await flush();
  const afterToken = countCalls(screen, "view=collector");
  tick.fn();
  await flush();
  assert.equal(countCalls(screen, "view=collector"), afterToken + 1, "코드를 만든 뒤에는 다시 받는다");
  screen.controller.destroy();
});

test("'수집 켜기'를 서버가 거절할 사유(지금 확인 켜짐·오늘 그날 중지)를 화면이 먼저 막고 이유를 쓴다, 거절 문구는 사유별로", async () => {
  for (const [manual, expected] of [
    [manualPayload(), "지금 확인이 켜져 있어 켤 수 없습니다(먼저 위 상태판의 '지금 확인 끄기')."],
    [manualPayload({ state: "off", enabled: false, stoppedDay: "2026-10-17" }), "오늘은 지금 확인이 차단으로 멈춘 날이라 내일 켤 수 있습니다."],
  ]) {
    const screen = mountManual({ manual });
    screen.controller.show();
    await settle();
    const owner = screen.host.querySelector("[data-coupang-rank-owner]");
    owner.open = true;
    dispatch(owner, "toggle");
    await settle();
    assert.equal(owner.querySelector('[data-coupang-rank-action="collector-enable"]').disabled, true);
    assert.equal(owner.querySelector("[data-coupang-rank-enable-block]").textContent, expected);
    assert.match(owner.querySelector("[data-coupang-rank-settings-scope]").textContent, /지금 확인\(검색 사이 3분 · 하루 30번 · 09~19시\)과는 따로입니다/u);
    screen.controller.destroy();
  }
  assert.equal(internals.errorText({ code: "COUPANG_COLLECTOR_MANUAL_CONFLICT", reason: "manual_enabled" }), "지금 확인이 켜져 있어 자동 수집을 켜지 않았습니다. 먼저 위 상태판에서 '지금 확인 끄기'를 누르세요.");
  assert.equal(internals.errorText({ code: "COUPANG_COLLECTOR_MANUAL_CONFLICT", reason: "manual_stopped_today" }), "오늘은 지금 확인이 차단으로 멈춘 날이라 자동 수집을 켜지 않았습니다. 내일 다시 켜 주세요.");
  assert.match(internals.errorText({ code: "COUPANG_COLLECTOR_MANUAL_CONFLICT", reason: "settings_changed" }), /지금 확인'이 켜져 있거나 오늘 지금 확인이 차단으로 멈춘 날/u);
});

test("카드 한 장 동작의 결과는 그 카드에, 실패는 맨 위 상태줄에도. 선택 삭제 결과는 막대가 한 줄로 접혀도 보인다", async () => {
  let fail = false;
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        if (fail) return response({ ok: false, code: "COUPANG_RANK_TRACKERS_FAILED" }, 500);
        return response({ ok: true, updated: body.ids.length, deleted: body.action === "delete" ? body.ids.length : 0 });
      }
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  dispatch(screen.host.querySelector(`[data-coupang-rank-action="pause"][data-coupang-rank-id="${TRACKER_ID}"]`), "click");
  await flush();
  const noteOf = (id) => screen.host.querySelector(`[data-coupang-rank-card][data-coupang-rank-id="${id}"]`).querySelector("[data-coupang-rank-card-note]");
  assert.equal(noteOf(TRACKER_ID).textContent, "1개 일시중지했습니다.");
  assert.equal(screen.host.querySelector("[data-coupang-rank-status]").hidden, true);
  fail = true;
  dispatch(screen.host.querySelector(`[data-coupang-rank-action="pause"][data-coupang-rank-id="${TRACKER_ID}"]`), "click");
  await flush();
  assert.equal(noteOf(TRACKER_ID).textContent, "서버 처리 중 오류가 났습니다. 잠시 뒤 다시 시도하세요.");
  assert.ok(noteOf(TRACKER_ID).classList.contains("is-warn"));
  assert.equal(screen.host.querySelector("[data-coupang-rank-status]").textContent, "서버 처리 중 오류가 났습니다. 잠시 뒤 다시 시도하세요.");
  fail = false;
  for (const id of [TRACKER_ID, "6c1f0000-0000-4000-8000-000000000002"]) {
    const check = screen.host.querySelector(`[data-coupang-rank-select="${id}"]`);
    check.checked = true;
    dispatch(check, "change");
  }
  assert.equal(screen.host.querySelector("[data-coupang-rank-bulk]").classList.contains("is-open"), true);
  assert.equal(screen.host.querySelector("[data-coupang-rank-selected-count]").textContent, "2개 선택");
  dispatch(screen.host.querySelector('[data-coupang-rank-action="bulk-delete"]'), "click");
  await flush();
  assert.equal(screen.host.querySelector("[data-coupang-rank-bulk-actions]").getAttribute("aria-hidden"), "true", "삭제 뒤 선택이 비어 막대가 접혔다");
  const bulkNote = screen.host.querySelector("[data-coupang-rank-bulk-note]");
  assert.equal(bulkNote.hidden, false);
  assert.equal(bulkNote.textContent, "2개 삭제했습니다.");
});

test("목록 받기 연결 실패는 쉬운 말로, 브라우저 원문은 title 에만", async () => {
  const screen = mountWith({ fetch: async () => { throw new Error("Failed to fetch"); } });
  screen.controller.show();
  await flush();
  const note = screen.host.querySelector("[data-coupang-rank-list-note]");
  assert.equal(note.textContent, "서버에 연결하지 못해 목록을 받지 못했습니다(인터넷 연결 확인). 화면의 이전 목록을 그대로 둡니다.");
  assert.equal(note.getAttribute("title"), "Failed to fetch");
  assert.doesNotMatch(note.textContent, /Failed|fetch/u);
});

test("C30 CSS 는 지금 너비 규칙(900px · 901~1180px · 901~1360px · 720px)만 쓰고, 색·포커스·비활성 규칙이 C30 범위 안에 있다", () => {
  const medias = [...new Set([...cssSource.matchAll(/@media \(([^{]+)\)\s*\{/gu)].map((match) => match[1]))];
  assert.deepEqual(medias.sort(), ["max-width: 720px", "max-width: 900px", "min-width: 901px) and (max-width: 1180px", "min-width: 901px) and (max-width: 1360px"].sort());
  assert.doesNotMatch(cssSource, /760px/u);
  assert.ok(cssSource.includes("#mi-admin .mi-coupang-rank-root button:focus-visible,"), "C30 안 버튼 포커스 테두리");
  assert.ok(cssSource.includes("outline: 2px solid var(--mi-navy);"));
  const disabled = cssSource.slice(cssSource.indexOf("#mi-admin .mi-coupang-rank-root .mi-link-button:disabled,"));
  assert.ok(disabled.slice(0, disabled.indexOf("}")).includes("opacity: 1;"), "비활성은 흐림 대신 회색 바탕·진회색 글자");
  // 오른쪽 아래 카카오 단추가 마지막 칸을 가리지 않게 C30 맨 아래 여백
  const root = cssSource.slice(cssSource.indexOf("#mi-admin .mi-coupang-rank-root,"));
  assert.ok(root.slice(0, root.indexOf("}")).includes("padding-bottom: 96px;"));
  // N30 공용 클래스는 C30 범위 선택자로만 덮는다(인라인 공용 규칙 무변경).
  assert.doesNotMatch(cssSource, /^#mi-(?:admin|clean) \.mi-rank-/mu);
});

// ── 2026-10-23 재검사 결함 수정(지금 확인 끄기·버튼 글자·결과 자리·포커스·막대·CSS) ─────────────────

// 기록 뒤에도 서버 manual 을 그대로 돌려주는 기록 처리기(끈 뒤 끝난 확인 등).
const recordKeepingManual = (body, server) => ({
  ok: true, accepted: true, duplicate: false, outcome: body.outcome, status: "ok", errorCode: null, matched: 1, counted: true, stopped: false, stopCode: null, late: false,
  tracker: { trackerId: TRACKER_ID, result: "found", rank: 12, organicCount: 50, adOrder: null, checkedAt: iso(SERVER_NOW + 20000) },
  manual: server.manual,
});

test("진행 중에 '지금 확인 끄기'를 누르면 경고 네 가지는 끝날 때까지 남고 '끝까지 기록' 한 줄이 붙으며, 끝나면 결과가 보인다", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const screen = mountManual({ check: async () => { await gate; return { ok: true, reply: measuredReply() }; }, record: recordKeepingManual,
    listOverrides: { collector: { state: "not_connected" } } });
  screen.controller.show();
  await settle();
  dispatch(manualButtonFor(screen), "click");
  await settle();
  const warn = /그 창을 닫거나 누르거나 내리지\(가리지\) 말고, 이 화면도 닫지 마세요/u;
  assert.equal(manualPill(screen), "확인 중");
  assert.match(manualLine(screen).textContent, warn);
  // 화면 읽기 프로그램에도 경고 문장을 한 번 읽힌다(초 세기 없음)
  assert.match(screen.host.querySelector("[data-coupang-rank-manual-announce]").textContent, /이 화면도 닫지 마세요/u);
  // 진행 중에 끈다(비상 정지는 막지 않는다). 서버는 이제 off 를 준다.
  screen.server.manual = manualPayload({ state: "off", enabled: false });
  const toggle = screen.host.querySelector("[data-coupang-rank-manual-toggle]");
  assert.equal(toggle.disabled, false);
  dispatch(toggle, "click");
  await settle();
  assert.equal(screen.server.of("settings-update").length, 1);
  assert.equal(manualPill(screen), "확인 중", "꺼짐으로 바꾸지 않는다");
  assert.match(manualLine(screen).textContent, warn);
  assert.match(manualLine(screen).textContent, /지금 확인을 껐지만, 이미 시작한 이 확인은 끝까지 마치고 결과를 기록합니다/u);
  assert.doesNotMatch(manualLine(screen).textContent, /기록되지 않습니다/u);
  assert.equal(screen.host.querySelector("[data-coupang-rank-manual-toggle]").textContent, "지금 확인 켜기", "버튼은 서버 상태(꺼짐)를 따른다");
  release();
  await settle();
  assert.equal(manualPill(screen), "꺼짐");
  assert.equal(manualLine(screen).textContent, "꺼져 있어 지금은 새 순위를 기록하지 않습니다. 카드의 '지금 확인' 버튼도 숨겨져 있습니다.");
  assert.match(resultText(screen), /^확인 완료: /u, "결과는 상태판 '직전 확인' 줄에 남는다");
  assert.match(cardNoteFor(screen), /^방금 확인 \d{2}:\d{2} · 일반 12위로 기록$/u);
  // 순수 함수: 서버가 off 여도 진행 중이면 run 갈래
  const off = manualPayload({ state: "off", enabled: false });
  const running = view({ server: off, run: { phase: "check" } });
  assert.equal(running.kind, "run");
  assert.equal(running.visible, true);
  assert.equal(boardOf({ server: off, view: running }).toggle, "enable");
  assert.equal(boardOf({ server: off, view: running }).pill.text, "확인 중");
  assert.equal(view({ server: off }).kind, "off");
});

test("카드 '지금 확인' 버튼 글자가 막힌 이유를 말한다(다른 확인·응답 없음·보내지 못함·확장·멈춤), 이른 아침은 '오늘 09시부터'", () => {
  const label = (server, extra = {}) => internals.manualButtonLabel(view({ server, ...extra }), false, server, extra.now ?? SERVER_NOW);
  const busy = manualPayload({ state: "busy", busyUntil: iso(SERVER_NOW + 90000) });
  assert.equal(label(busy), "약 1분 30초 뒤");
  assert.equal(label(busy, { ownLost: true }), "약 1분 30초 뒤");
  assert.equal(label(busy, { ownUnsent: true }), "약 1분 30초 뒤");
  assert.equal(label(busy, { unsentMaybe: true }), "약 1분 30초 뒤");
  assert.equal(label(busy, { ownPending: true }), "확인 중…");
  assert.equal(view({ server: busy }).countdown, true, "다른 확인도 1초마다 다시 센다(버튼 글자가 남은 시간)");
  assert.equal(label(manualPayload(), { hello: helloOk({ busy: true }) }), "잠시 뒤");
  assert.equal(label(manualPayload(), { hello: { status: "missing" } }), "확장 확인 필요");
  assert.equal(label(manualPayload(), { hello: null }), "확장 확인 중");
  for (const stateName of ["budget", "review", "cooldown"]) assert.equal(label(manualPayload({ state: stateName })), "멈춤", stateName);
  assert.equal(label(manualPayload(), { hello: helloOk({ incognitoWindowOpen: true }) }), "지금 확인", "켜진 버튼은 그대로");
  // 00~09시(시간 밖 이른 아침): '다음 확인 오늘 09:00'과 '오늘 쓴 횟수' 아래 줄이 같은 날을 말한다
  const early = Date.parse("2026-10-22T23:30:00.000Z"); // KST 08:30
  const morning = manualPayload({ state: "hours", serverTime: iso(early) });
  const model = boardOf({ server: morning, now: early, view: view({ server: morning, now: early }) });
  assert.equal(model.metrics.next.value, "오늘 09:00");
  assert.equal(model.metrics.used.note, "09~19시 · 오늘 09시부터 30번");
  assert.equal(label(morning, { now: early }), "오늘 09:00");
  const late = Date.parse("2026-10-23T11:00:00.000Z"); // KST 20:00
  const evening = manualPayload({ state: "hours", serverTime: iso(late) });
  assert.equal(boardOf({ server: evening, now: late, view: view({ server: evening, now: late }) }).metrics.used.note, "09~19시 · 내일 09시에 다시 30번");
});

test("자동 수집 보류 안내는 지금 확인 상태를 따르고, 꺼짐 + 자동 수집 경보면 빈 기록판이 '기록된다'고 하지 않는다", async () => {
  const holdOf = async (manual, collector = { state: "not_connected" }) => {
    const screen = mountManual({ manual, listOverrides: { collector } });
    screen.controller.show();
    await settle();
    return screen;
  };
  const on = await holdOf(manualPayload());
  assert.match(on.host.querySelector("[data-coupang-rank-owner-hold]").textContent, /지금은 카드의 '지금 확인'으로만 기록합니다/u);
  const off = await holdOf(manualPayload({ state: "off", enabled: false }));
  const hold = off.host.querySelector("[data-coupang-rank-owner-hold]");
  assert.equal(hold.hidden, false);
  assert.match(hold.textContent, /지금 확인도 꺼져 있어 지금은 새 순위를 기록하지 않습니다/u);
  assert.doesNotMatch(hold.textContent, /'지금 확인'으로만 기록합니다/u, "상태판의 '꺼짐'과 다른 말을 하지 않는다");
  for (const stateName of ["review", "budget", "cooldown", "outdated", "offline", "zzz_unknown"]) {
    const alarm = await holdOf(manualPayload({ state: "off", enabled: false }), { state: stateName, lastSuccessAt: null, checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: null });
    assert.doesNotMatch(manualLine(alarm).textContent, /기록 중/u, stateName);
    const empty = alarm.host.querySelectorAll(".mi-coupang-rank-board-empty")[0];
    assert.equal(empty.textContent, "아직 순위 기록이 없습니다. 자동 수집이 멈췄거나 확인이 필요한 상태라 언제 기록될지 알 수 없습니다(위 자동추적 칸 참고).", stateName);
    assert.equal(alarm.host.querySelector("[data-coupang-rank-strip]").hidden, false, `${stateName}: 자동추적 칸 경보는 그대로 보인다`);
  }
  const unknown = await holdOf(manualPayload({ state: "off", enabled: false }), { state: "zzz_unknown" });
  assert.match(manualLine(unknown).textContent, /^자동 수집 상태를 알 수 없습니다\(코드 zzz_unknown\)/u);
});

test("카드 한 장 동작 성공은 화면 읽기 자리에도 쓰고, 앞선 결과 줄은 다음 동작 때 지우며, 모두 지워 목록이 비면 결과를 맨 위 상태줄에 쓴다", async () => {
  let deleted = new Set();
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        if (body.action === "delete") body.ids.forEach((id) => deleted.add(id));
        return response({ ok: true, updated: body.ids.length, deleted: body.action === "delete" ? body.ids.length : 0 });
      }
      const payload = listPayload();
      return response(listPayload({ trackers: payload.trackers.filter((tracker) => !deleted.has(tracker.id)) }));
    },
  });
  screen.controller.show();
  await flush();
  const status = () => screen.host.querySelector("[data-coupang-rank-status]");
  const bulkNote = () => screen.host.querySelector("[data-coupang-rank-bulk-note]");
  // 앞선 동작이 남긴 상태줄
  dispatch(screen.host.querySelector("[data-coupang-rank-create-form]"), "submit");
  assert.equal(status().textContent, "키워드를 입력해주세요.");
  // 묶음 결과 줄도 하나 남겨 둔다(하나 고르고 그룹명 없이 '그룹으로 옮기기')
  const pick = screen.host.querySelector(`[data-coupang-rank-select="${TRACKER_ID}"]`);
  pick.checked = true;
  dispatch(pick, "change");
  dispatch(screen.host.querySelector('[data-coupang-rank-action="bulk-group"]'), "click");
  assert.equal(bulkNote().textContent, "만들거나 이동할 그룹명을 입력해주세요.");
  dispatch(screen.host.querySelector(`[data-coupang-rank-action="pause"][data-coupang-rank-id="${TRACKER_ID}"]`), "click");
  await flush();
  assert.equal(status().hidden, true, "앞선 상태줄은 지웠다");
  assert.equal(bulkNote().hidden, true, "앞선 묶음 결과 줄도 지웠다");
  const live = screen.host.querySelector("[data-coupang-rank-sr-live]");
  assert.equal(live.getAttribute("aria-live"), "polite");
  assert.equal(live.textContent, "1개 일시중지했습니다.");
  // 보이는 항목 전체 선택 → 선택 삭제 → 목록이 비면 막대는 '결과 줄만' 모양(넓은 화면은 CSS 가 숨김)이라 결과를 맨 위 상태줄에도 쓴다.
  // 휴대폰은 맨 위 상태줄이 화면 밖이라 아래 막대 안 결과 줄이 잠시 보인다(2026-10-23 재검사 2차).
  dispatch(screen.host.querySelector('[data-coupang-rank-action="select-visible"]'), "click");
  dispatch(screen.host.querySelector('[data-coupang-rank-action="bulk-delete"]'), "click");
  await flush();
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 0);
  const bulk = screen.host.querySelector("[data-coupang-rank-bulk]");
  assert.equal(bulk.hidden, false, "결과 한 줄이 떠 있는 동안은 남는다");
  assert.ok(bulk.classList.contains("is-note-only"));
  assert.equal(bulk.classList.contains("is-open"), false);
  assert.ok(screen.host.querySelector("[data-coupang-rank-bulk-dock]").classList.contains("is-shown"));
  assert.equal(screen.host.querySelector("[data-coupang-rank-bulk-dock-note]").textContent, "2개 삭제했습니다.");
  assert.equal(screen.host.querySelector('[data-coupang-rank-action="bulk-sheet-toggle"]').hidden, true, "고를 것이 없으니 펼치기 단추는 없다");
  assert.equal(status().hidden, false);
  assert.equal(status().textContent, "2개 삭제했습니다.");
});

test("휴대폰 아래 막대: 고르면 접힌 한 줄, 단추로 펼침, 선택이 0개가 되어도 결과 한 줄은 막대 안에 잠시 남는다", async () => {
  const screen = mountWith({
    fetch: async (url, init) => {
      if (init.method === "POST") return response({ ok: true, updated: JSON.parse(init.body).ids.length });
      return response(listPayload());
    },
  });
  screen.controller.show();
  await flush();
  const host = screen.host;
  const dock = () => host.querySelector("[data-coupang-rank-bulk-dock]");
  const toggle = () => host.querySelector('[data-coupang-rank-action="bulk-sheet-toggle"]');
  assert.equal(dock().classList.contains("is-shown"), false);
  const check = host.querySelector(`[data-coupang-rank-select="${TRACKER_ID}"]`);
  check.checked = true;
  dispatch(check, "change");
  assert.equal(dock().classList.contains("is-shown"), true);
  assert.equal(dock().classList.contains("is-expanded"), false, "처음에는 접힌 한 줄");
  assert.equal(host.querySelector(".mi-coupang-rank-bulk-sheet-count").textContent, "1개 선택");
  assert.equal(toggle().getAttribute("aria-expanded"), "false");
  assert.equal(toggle().getAttribute("aria-controls"), host.querySelector("[data-coupang-rank-bulk-actions]").id);
  dispatch(toggle(), "click");
  assert.equal(dock().classList.contains("is-expanded"), true);
  assert.equal(toggle().textContent, "접기 ▾");
  assert.equal(toggle().getAttribute("aria-expanded"), "true");
  // 체크해도 겹친 칸의 안내 글은 그대로 남는다(감추기는 CSS, 높이가 바뀌지 않게)
  assert.equal(host.querySelector(".mi-coupang-rank-bulk-hint").textContent, "카드를 체크하면 그룹 옮기기 · 일시중지 · 삭제 · 이미지 저장을 한 번에 할 수 있습니다.");
  assert.equal(host.querySelector("[data-coupang-rank-bulk-actions]").getAttribute("aria-hidden"), "false");
  // 그룹 해제(선택을 비운다) → 막대는 접히지만 결과 한 줄은 아래 막대 안에 남는다
  dispatch(host.querySelector('[data-coupang-rank-action="bulk-ungroup"]'), "click");
  await flush();
  assert.equal(host.querySelector("[data-coupang-rank-bulk]").classList.contains("is-open"), false);
  assert.equal(dock().classList.contains("is-shown"), true, "결과 한 줄 때문에 잠시 남는다");
  assert.equal(dock().classList.contains("is-expanded"), false, "선택이 0개면 접는다");
  const dockNote = host.querySelector("[data-coupang-rank-bulk-dock-note]");
  assert.equal(dockNote.textContent, "1개 추적 항목을 그룹에서 해제했습니다.");
  assert.equal(dockNote.getAttribute("aria-hidden"), "true", "같은 글을 두 번 읽지 않는다(막대 안 결과 줄이 읽는다)");
  assert.equal(host.querySelector("[data-coupang-rank-bulk-note]").textContent, dockNote.textContent);
});

test("목록을 다시 그려도 키보드 포커스는 같은 자리로 돌아오고, 날짜 줄의 화살표 위치를 지키며, 꺼진 버튼 대신 카드에 맡긴다", async () => {
  const screen = mountWith();
  screen.controller.show();
  await flush();
  const card = () => screen.host.querySelector(`[data-coupang-rank-card][data-coupang-rank-id="${TRACKER_ID}"]`);
  const days = () => card().querySelectorAll("[data-coupang-rank-day]");
  days()[0].focus();
  keydown(days()[0], "ArrowRight");
  assert.equal(screen.document.activeElement, days()[1]);
  // 다시 그리기(필터 '전체' 누름 → 목록을 통째로 새로 만든다)
  dispatch(screen.host.querySelector('[data-coupang-rank-filter-status="all"]'), "click");
  assert.equal(screen.document.activeElement, days()[1], "같은 날짜 칸(새 노드)으로 돌아온다");
  assert.deepEqual(days().map((node) => node.getAttribute("tabindex")), ["-1", "0"], "화살표로 옮긴 칸이 탭 정지로 남는다");
  // 카드 버튼
  const pause = () => screen.host.querySelector(`[data-coupang-rank-action="pause"][data-coupang-rank-id="${TRACKER_ID}"]`);
  pause().focus();
  dispatch(screen.host.querySelector('[data-coupang-rank-filter-status="all"]'), "click");
  assert.equal(screen.document.activeElement, pause());

  // 지금 확인: 누른 버튼이 꺼지면 카드에 맡기고(몸통으로 사라지지 않음), 다시 켜져 그려지면 버튼으로 돌린다
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const manual = mountManual({ check: async () => { await gate; return { ok: true, reply: measuredReply() }; },
    record: (body, server) => { server.manual = manualPayload({ usedToday: 4 }); return recordKeepingManual(body, server); } });
  manual.controller.show();
  await settle();
  manualButtonFor(manual).focus();
  dispatch(manualButtonFor(manual), "click");
  await settle();
  const manualCard = manual.host.querySelector(`[data-coupang-rank-card][data-coupang-rank-id="${TRACKER_ID}"]`);
  assert.equal(manual.document.activeElement, manualCard, "꺼진 버튼 대신 카드");
  assert.equal(manualCard.getAttribute("tabindex"), "-1");
  release();
  await settle();
  assert.equal(manualButtonFor(manual).disabled, false);
  assert.equal(manual.document.activeElement, manualButtonFor(manual), "버튼이 다시 켜지면 버튼으로");
});

test("날짜 줄 오른쪽 끝 흐림은 옆으로 더 있을 때만(끝까지 밀면 사라짐)", async () => {
  const screen = mountWith();
  screen.controller.show();
  await flush();
  const wrap = screen.host.querySelector(".mi-coupang-rank-days-scroll");
  const grid = wrap.querySelector(".mi-rank-day-grid");
  assert.equal(wrap.classList.contains("has-more"), false, "잴 수 없으면(넘침 0) 흐리지 않는다");
  Object.defineProperty(grid, "scrollWidth", { value: 900, configurable: true });
  Object.defineProperty(grid, "clientWidth", { value: 300, configurable: true });
  grid.scrollLeft = 0;
  dispatch(grid, "scroll");
  assert.equal(wrap.classList.contains("has-more"), true);
  grid.scrollLeft = 600;
  dispatch(grid, "scroll");
  assert.equal(wrap.classList.contains("has-more"), false, "끝까지 밀었다");
});

test("시작하지 않은 결과(서버 거절·누르기 직전 확장 검사)는 카드에 '방금 누름', 확인한 결과는 '방금 확인'", async () => {
  // 누르기 직전 확장 검사에서 막힘(화면을 연 뒤 시크릿 허용을 껐다)
  let helloCalls = 0;
  const blocked = mountManual({ hello: () => { helloCalls += 1; return { ok: true, reply: helloReply(helloCalls > 1 ? { incognitoAllowed: false } : {}) }; } });
  blocked.controller.show();
  await settle();
  dispatch(manualButtonFor(blocked), "click");
  await settle();
  assert.equal(blocked.server.posts.length, 0);
  assert.match(cardNoteFor(blocked), /^방금 누름 \d{2}:\d{2} · 시작하지 않음 · 쿠팡 검색 안 함$/u);
  const refused = mountManual({ claim: { __status: 500, payload: {} } });
  refused.controller.show();
  await settle();
  dispatch(manualButtonFor(refused), "click");
  await settle();
  assert.match(cardNoteFor(refused), /^방금 누름 \d{2}:\d{2} · 시작하지 않음 · 쿠팡 검색 안 함$/u);
  const done = mountManual();
  done.controller.show();
  await settle();
  dispatch(manualButtonFor(done), "click");
  await settle();
  assert.match(cardNoteFor(done), /^방금 확인 \d{2}:\d{2} · 일반 12위로 기록$/u);
});

test("C30 CSS: 카드 1행 칸 비율(키워드·상품번호 먼저) · 날짜 칸 포커스 안쪽 테두리 · 흐림 조건 · 겹친 칸 · 아래 막대 · 누르는 자리 · 화면 머리", () => {
  const ruleOf = (selector) => {
    const at = cssSource.indexOf(selector);
    assert.ok(at >= 0, selector);
    const open = cssSource.indexOf("{", at);
    return cssSource.slice(open, cssSource.indexOf("}", open));
  };
  // 1366~1920px 에서 키워드·상품번호가 잘리지 않게(줄어드는 몫은 상품명이 먼저)
  assert.ok(ruleOf("#mi-admin .mi-coupang-rank-card .mi-rank-track-primary,").includes("grid-template-columns: max-content minmax(68px, max-content) max-content minmax(84px, 1fr);"));
  // 날짜 칸 포커스: 넘침 자르기에 잘리지 않게 안쪽(-3px), 펼친 날은 다른 모양(아래 파란 줄)
  const focus = ruleOf("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-card .mi-coupang-rank-day-button:focus-visible,");
  assert.ok(focus.includes("outline-offset: -3px;") && focus.includes("z-index: 1;"));
  const selected = ruleOf("#mi-admin .mi-coupang-rank-day.is-selected,");
  assert.ok(selected.includes("inset 0 -3px 0 var(--mi-blue)"));
  assert.doesNotMatch(selected, /inset 0 0 0 2px var\(--mi-navy\)/u, "포커스처럼 보이는 남색 테두리를 쓰지 않는다");
  // 흐림은 has-more 일 때만
  assert.ok(ruleOf("#mi-admin .mi-coupang-rank-days-scroll::after,").includes("opacity: 0;"));
  assert.ok(ruleOf("#mi-admin .mi-coupang-rank-days-scroll.has-more::after,").includes("opacity: 1;"));
  assert.ok(ruleOf("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-card .mi-rank-day-grid,").includes("scroll-padding-inline: 0 40px;"));
  // 겹친 칸: 안내 글·동작 줄이 같은 자리, 고르면 visibility 만 바꾼다(높이 그대로)
  assert.ok(ruleOf("#mi-admin .mi-coupang-rank-bulk-msg,").includes("grid-area: 1 / 1;"));
  assert.ok(ruleOf("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-bulk.is-open .mi-coupang-rank-bulk-msg,").includes("visibility: hidden;"));
  // 고르기 전에도 동작 줄 자리를 잡아 둔다(고를 때 목록이 밀리지 않게, 2026-10-23 재검사 3차 — display: none 은 901~1230px 에서 42px 밀렸다)
  assert.ok(ruleOf("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-bulk:not(.is-open) .mi-coupang-rank-bulk-actions,").includes("visibility: hidden;"));
  assert.doesNotMatch(ruleOf("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-bulk:not(.is-open) .mi-coupang-rank-bulk-actions,"), /display:\s*none/u);
  assert.doesNotMatch(cssSource, /\.mi-coupang-rank-bulk\.is-open,\s*#mi-clean[^{]*\{\s*padding/u, "고를 때 막대 여백을 바꾸지 않는다");
  // 휴대폰 아래 막대(카카오 단추 위) · 맨 아래 여백 = 막대 높이 + 96px
  const phone = cssSource.slice(cssSource.indexOf("@media (max-width: 900px)"), cssSource.indexOf("@media (max-width: 720px)"));
  const dock = phone.slice(phone.indexOf("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-bulk-dock,"));
  assert.ok(dock.slice(0, dock.indexOf("}")).includes("position: fixed;") && dock.slice(0, dock.indexOf("}")).includes("bottom: 84px;"));
  assert.ok(phone.includes(".mi-coupang-rank-bulk-dock:not(.is-expanded) .mi-coupang-rank-bulk-actions"));
  assert.ok(phone.includes("padding-bottom: calc(96px + var(--mi-coupang-rank-dock-space, 0px));"));
  // 누르는 자리 44px(최소 40px)
  const text = phone.slice(phone.indexOf("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-text-button,"));
  assert.ok(text.slice(0, text.indexOf("}")).includes("min-height: 44px;"));
  assert.ok(phone.includes("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-filter-actions .mi-rank-filter-button:focus-visible,"));
  // 화면 머리: 901~1180px 도 대상 알약을 제목 아래로, 제목은 낱말 단위로 줄바꿈
  const mid = cssSource.slice(cssSource.indexOf("@media (min-width: 901px) and (max-width: 1180px)"), cssSource.indexOf("@media (max-width: 900px)"));
  assert.ok(mid.includes("#mi-admin .mi-coupang-rank-screen-head.mi-head,"));
  assert.ok(ruleOf("#mi-admin .mi-coupang-rank-screen-head h1,").includes("word-break: keep-all;"));
});

// ── 2026-10-23 재검사 2차: 남은 결함 7건(사용 방법 문장 · 휴대폰 삭제 결과 · 작은 넘침 흐림 · 되돌린 날짜 칸 · 포커스 잘림 · 끈 뒤 확인 중 · 접힌 막대) ──

// 가짜 배치: 옆으로 미는 줄(날짜 줄 300px · 필터 줄 200px)과 그 안 칸(72px · 80px). 칸 위치 = 순서 × 폭 − 줄의 scrollLeft.
function fakeRowLayout(screen) {
  const proto = Object.getPrototypeOf(screen.host);
  const rowOf = (node) => (node.classList.contains("mi-rank-day-grid") ? { client: 300, cell: 72 } : (node.classList.contains("mi-coupang-rank-filter-actions") ? { client: 200, cell: 80 } : null));
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { const row = rowOf(this); return row ? row.client : 0; } });
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get() { const row = rowOf(this); return row ? this.children.length * row.cell : 0; } });
  proto.getBoundingClientRect = function () {
    const own = rowOf(this);
    if (own) return { left: 0, right: own.client, top: 0, bottom: 58, width: own.client, height: 58 };
    const parent = this.parentNode;
    const row = parent && parent.classList ? rowOf(parent) : null;
    if (row) {
      const left = parent.children.indexOf(this) * row.cell - (Number(parent.scrollLeft) || 0);
      return { left, right: left + row.cell, top: 0, bottom: 58, width: row.cell, height: 58 };
    }
    return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  };
}

test("사용 방법 상자는 지금 방식(지금 확인 켜짐 · 자동 수집 · 둘 다 꺼짐)에 맞는 문장만 쓰고, 켜고 끄면 바로 바뀐다(2026-10-23 재검사 2차)", async () => {
  const guideOf = (screen) => {
    const guide = screen.host.querySelector("[data-coupang-rank-guide]");
    return { sub: guide.querySelector(".mi-coupang-rank-aux-sub").textContent, items: guide.querySelectorAll("li").map((li) => li.textContent), text: guide.textContent };
  };
  const mountOf = async (manual, collector) => {
    const screen = mountManual({ manual, listOverrides: { collector } });
    screen.controller.show();
    await settle();
    return screen;
  };
  const idle = { state: "not_connected" };
  const off = () => manualPayload({ state: "off", enabled: false });
  // ① 지금 확인 켜짐(자동 수집 보류)
  const on = await mountOf(manualPayload(), idle);
  let guide = guideOf(on);
  assert.equal(guide.sub, "지금 확인 · 칸 읽는 법 · 필터 · 멈추기와 삭제");
  assert.equal(guide.items[0], "기록: 카드의 '지금 확인'을 누를 때만 잽니다(검색 사이 3분 · 하루 30번 · 09~19시). 쿠팡이 차단으로 보이는 화면을 보내면 그날은 멈추고, 다음 날 09시부터 다시 됩니다.");
  assert.ok(guide.text.includes("같은 키워드 카드는 한 번 누르면 함께 기록됩니다"));
  assert.match(guide.items.at(-1), /대표 결정\(2026-10-17\)으로 보류 중입니다/u);
  assert.doesNotMatch(guide.text, /자동 수집: 수집기 PC가/u);
  // ② 둘 다 꺼짐: '누를 때만 잽니다'라고 하지 않고 켜는 법을 말한다
  const none = await mountOf(off(), idle);
  guide = guideOf(none);
  assert.equal(guide.sub, "켜는 법 · 칸 읽는 법 · 필터 · 멈추기와 삭제");
  assert.equal(guide.items[0], "기록: 지금은 지금 확인과 자동 수집이 모두 꺼져 있어 새 순위를 기록하지 않습니다. 위 상태판의 '지금 확인 켜기'를 누르면 카드에 '지금 확인' 버튼이 생기고, 그 버튼을 누를 때만 잽니다(검색 사이 3분 · 하루 30번 · 09~19시).");
  assert.match(guide.items[1], /꺼져 있어도 등록은 되고, '지금 확인'을 켠 뒤 새 카드의 '지금 확인'을 누르면 첫 순위가 기록됩니다\.$/u);
  assert.doesNotMatch(guide.text, /'지금 확인'을 누를 때만 잽니다|같은 키워드 카드는 한 번 누르면|자동 수집: 수집기 PC가/u);
  assert.match(guide.items.at(-1), /보류 중입니다/u);
  // ③ 자동 수집(지금 확인 꺼짐): 자동 수집 문장만, 보류 안내·'누를 때만'은 없다
  const auto = await mountOf(off(), { state: "ok", lastSuccessAt: null, checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: null });
  guide = guideOf(auto);
  assert.equal(guide.sub, "등록 · 읽는 법 · 멈추기 · 수집 시간");
  assert.equal(guide.items[0], "기록: 자동 수집으로 잽니다(수집기 PC가 켜져 있을 때, 하루 2회, 08~23시). 지금 확인은 꺼져 있어 카드에 '지금 확인' 버튼이 없습니다(지금 확인과 자동 수집은 함께 켜지지 않습니다).");
  assert.equal(guide.items[2], "첫 기록: 오늘 같은 키워드를 이미 쟀으면 바로 기록되고, 없으면 다음 수집 때 기록됩니다.");
  assert.doesNotMatch(guide.text, /누를 때만 잽니다|보류 중입니다|같은 키워드 카드는 한 번 누르면/u);
  // ④ 자동 수집을 켜 둔 뒤의 경보: '다음 수집 때 기록'이라고 단정하지 않는다
  const alarm = await mountOf(off(), { state: "review", lastSuccessAt: null, checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: null });
  guide = guideOf(alarm);
  assert.match(guide.items[0], /지금은 자동 수집이 멈췄거나 확인이 필요한 상태입니다\(위 자동추적 칸 참고\)\.$/u);
  assert.doesNotMatch(guide.text, /없으면 다음 수집 때 기록됩니다/u);
  // ⑤ 켜진 화면에서 끄면 바로 '둘 다 꺼짐' 문장으로
  on.server.manual = off();
  dispatch(on.host.querySelector("[data-coupang-rank-manual-toggle]"), "click");
  await settle();
  assert.match(guideOf(on).items[0], /^기록: 지금은 지금 확인과 자동 수집이 모두 꺼져 있어/u);
  assert.doesNotMatch(guideOf(on).text, /'지금 확인'을 누를 때만 잽니다/u);
});

test("휴대폰 '전체 선택 → 선택 삭제'로 목록이 비어도 결과 한 줄이 아래 막대 안에 6초 남고, 그 뒤 막대가 숨는다(2026-10-23 재검사 2차)", async () => {
  const clock = { now: Date.parse("2026-10-17T03:00:00.000Z") };
  const deleted = new Set();
  const screen = mountWith({
    clock,
    deferTimersFrom: 6000,
    fetch: async (url, init) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        body.ids.forEach((id) => deleted.add(id));
        return response({ ok: true, deleted: body.ids.length });
      }
      const payload = listPayload();
      return response(listPayload({ trackers: payload.trackers.filter((tracker) => !deleted.has(tracker.id)) }));
    },
  });
  screen.controller.show();
  await flush();
  const bulk = () => screen.host.querySelector("[data-coupang-rank-bulk]");
  const dock = () => screen.host.querySelector("[data-coupang-rank-bulk-dock]");
  dispatch(screen.host.querySelector('[data-coupang-rank-action="select-visible"]'), "click");
  dispatch(screen.host.querySelector('[data-coupang-rank-action="bulk-sheet-toggle"]'), "click");
  assert.ok(dock().classList.contains("is-expanded"));
  const remove = screen.host.querySelector('[data-coupang-rank-action="bulk-delete"]');
  assert.ok(screen.host.querySelector("[data-coupang-rank-bulk-dock]").contains(remove), "선택 삭제는 아래 막대 안");
  dispatch(remove, "click");
  await flush();
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 0);
  assert.equal(bulk().hidden, false);
  assert.ok(bulk().classList.contains("is-note-only"));
  assert.ok(dock().classList.contains("is-shown"));
  assert.equal(dock().classList.contains("is-expanded"), false, "결과 줄만 보인다(동작 줄은 접는다)");
  assert.equal(screen.host.querySelector("[data-coupang-rank-bulk-dock-note]").hidden, false);
  assert.equal(screen.host.querySelector("[data-coupang-rank-bulk-dock-note]").textContent, "2개 삭제했습니다.");
  assert.equal(screen.host.querySelector("[data-coupang-rank-status]").textContent, "2개 삭제했습니다.", "넓은 화면·화면 읽기용 맨 위 상태줄");
  // 6초 뒤: 막대(결과 줄 포함)가 숨는다
  clock.now += 6200;
  const timers = screen.timeouts.filter((entry) => entry.ms === 6100 && !entry.cleared);
  assert.ok(timers.length >= 1, "결과 줄 시간이 끝나면 다시 그리는 타이머");
  timers.forEach((entry) => entry.fn());
  assert.equal(bulk().hidden, true);
  assert.equal(bulk().classList.contains("is-note-only"), false);
});

test("카드 '삭제'로 마지막 카드를 지워 목록이 비면 결과가 아래 막대 안 결과 줄에도 보인다(휴대폰 화면 밖 상태줄 보완, 2026-10-23 재검사 3차)", async () => {
  const clock = { now: Date.parse("2026-10-17T03:00:00.000Z") };
  const deleted = new Set();
  const screen = mountWith({
    clock,
    deferTimersFrom: 6000,
    fetch: async (url, init) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        body.ids.forEach((id) => deleted.add(id));
        return response({ ok: true, deleted: body.ids.length });
      }
      const payload = listPayload();
      return response(listPayload({ trackers: payload.trackers.filter((tracker) => !deleted.has(tracker.id)) }));
    },
  });
  screen.controller.show();
  await flush();
  const ids = Array.from(screen.host.querySelectorAll("[data-coupang-rank-card]")).map((card) => card.getAttribute("data-coupang-rank-id"));
  assert.ok(ids.length >= 2);
  const removeCard = async (id) => {
    dispatch(screen.host.querySelector(`[data-coupang-rank-action="delete"][data-coupang-rank-id="${id}"]`), "click");
    await flush();
  };
  await removeCard(ids[0]);
  assert.equal(screen.host.querySelector("[data-coupang-rank-bulk]").classList.contains("is-note-only"), false, "카드가 남아 있으면 결과 줄만 모양이 아니다");
  assert.equal(screen.host.querySelector("[data-coupang-rank-bulk-dock-note]").hidden, true, "카드가 남아 있으면 아래 막대 결과 줄을 쓰지 않는다(넓은 화면 막대 높이 그대로)");
  for (const id of ids.slice(1)) await removeCard(id);
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-card]").length, 0);
  const bulk = screen.host.querySelector("[data-coupang-rank-bulk]");
  assert.equal(bulk.hidden, false);
  assert.ok(bulk.classList.contains("is-note-only"));
  assert.ok(screen.host.querySelector("[data-coupang-rank-bulk-dock]").classList.contains("is-shown"));
  assert.equal(screen.host.querySelector("[data-coupang-rank-bulk-dock-note]").textContent, "1개 삭제했습니다.");
  assert.equal(screen.host.querySelector("[data-coupang-rank-status]").textContent, "1개 삭제했습니다.", "맨 위 상태줄도 그대로");
});

test("날짜 줄 흐림: 가려진 몫이 16px 이하(1440~1920px 12칸 카드의 4px 넘침 · 글자가 안 잘리는 17px 미만)면 흐리지 않는다(2026-10-23 재검사 2·3차)", async () => {
  const screen = mountWith();
  screen.controller.show();
  await flush();
  const wrap = screen.host.querySelector(".mi-coupang-rank-days-scroll");
  const grid = wrap.querySelector(".mi-rank-day-grid");
  Object.defineProperty(grid, "clientWidth", { value: 1004, configurable: true });
  const fadeAt = (scrollWidth, scrollLeft = 0) => {
    Object.defineProperty(grid, "scrollWidth", { value: scrollWidth, configurable: true });
    grid.scrollLeft = scrollLeft;
    dispatch(grid, "scroll");
    return wrap.classList.contains("has-more");
  };
  assert.equal(fadeAt(1008), false, "12칸 × 84px = 1008px, 보이는 폭 1004px");
  assert.equal(fadeAt(1020), false, "16px 까지는 칸 오른쪽 여백·테두리뿐");
  assert.equal(fadeAt(1021), true, "17px 부터는 흐린다");
  assert.equal(fadeAt(1260), true, "15칸");
  assert.equal(fadeAt(1260, 250), false, "끝에서 6px 남으면 흐림을 뗀다");
  assert.ok(moduleSource.includes("var DAY_FADE_PX = 40;") && cssSource.includes("width: 40px;") && cssSource.includes("scroll-padding-inline: 0 40px;"), "JS·CSS 흐림 폭이 같다");
});

test("다시 그려도 날짜 줄을 옆으로 민 자리를 지키고, 되돌린 포커스 칸이 줄 밖·흐림 밑이면 그 줄만 민다(2026-10-23 재검사 2차)", async () => {
  const screen = mountWith({ payload: listPayload({ trackers: [trackerFixture({ createdDay: "2026-10-08" })] }) });
  fakeRowLayout(screen);
  screen.controller.show();
  await flush();
  const grid = () => screen.host.querySelector(".mi-rank-day-grid");
  const days = () => grid().querySelectorAll("[data-coupang-rank-day]");
  const redraw = () => dispatch(screen.host.querySelector('[data-coupang-rank-filter-status="all"]'), "click");
  assert.equal(days().length, 10, "10-17 ~ 10-08 열 칸(720px)");
  // ① 마우스로 옆으로 민 자리(포커스 없음)는 새로 그린 줄에도 그대로
  grid().scrollLeft = 150;
  redraw();
  assert.equal(grid().scrollLeft, 150);
  // ② End 로 맨 끝 칸 → 줄이 처음 자리(0)에서 다시 그려지면, 되돌린 포커스 칸이 보이게 끝까지 민다(끝이라 흐림 없음)
  days()[0].focus();
  keydown(days()[0], "End");
  assert.equal(screen.document.activeElement, days()[9]);
  grid().scrollLeft = 0;
  redraw();
  assert.equal(screen.document.activeElement, days()[9], "같은 날짜 칸(새 노드)");
  assert.equal(grid().scrollLeft, 420, "720 − 300");
  // ③ 가운데 칸(5번째, 288~360px)은 오른쪽 흐림(40px) 밖에 오게: 360 − (300 − 40) = 100
  keydown(days()[9], "Home");
  keydown(days()[0], "ArrowRight");
  keydown(days()[1], "ArrowRight");
  keydown(days()[2], "ArrowRight");
  keydown(days()[3], "ArrowRight");
  assert.equal(screen.document.activeElement, days()[4]);
  grid().scrollLeft = 0;
  redraw();
  assert.equal(grid().scrollLeft, 100);
  // ④ 왼쪽으로 가려진 칸: 줄을 끝까지 민 채 Home → 다시 그리면 맨 앞으로
  keydown(days()[4], "Home");
  grid().scrollLeft = 420;
  redraw();
  assert.equal(screen.document.activeElement, days()[0]);
  assert.equal(grid().scrollLeft, 0);
});

test("휴대폰 필터 줄: 키보드 포커스(:focus-visible)가 일부만 보이는 버튼에 오면 그 줄을 밀고, 마우스로 누를 때는 그대로 둔다(2026-10-23 재검사 2차)", async () => {
  const screen = mountWith();
  fakeRowLayout(screen);
  screen.controller.show();
  await flush();
  const row = screen.host.querySelector(".mi-coupang-rank-filter-actions");
  const button = screen.host.querySelector('[data-coupang-rank-filter-status="out"]');
  const index = row.children.indexOf(button);
  assert.ok(index * 80 + 80 > 200, "보이는 폭(200px) 밖에 있는 버튼");
  const focusWith = (keyboard) => {
    const original = button.matches.bind(button);
    button.matches = (selector) => (selector === ":focus-visible" ? keyboard : original(selector));
    dispatch(button, "focusin");
    button.matches = original;
  };
  row.scrollLeft = 0;
  focusWith(false);
  assert.equal(row.scrollLeft, 0, "마우스로 누르는 사이 줄이 움직이지 않는다");
  focusWith(true);
  assert.equal(row.scrollLeft, index * 80 + 80 - 200, "버튼 오른쪽 끝이 줄 끝에 맞는다(필터 줄은 흐림 없음)");
});

test("진행 중에 '지금 확인'을 끄면 다른 카드 버튼은 숨기고, 재고 있는 카드만 끝날 때까지 '확인 중…'을 남긴다(2026-10-23 재검사 2차)", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const screen = mountManual({ check: async () => { await gate; return { ok: true, reply: measuredReply() }; }, record: recordKeepingManual,
    listOverrides: { collector: { state: "not_connected" } } });
  screen.controller.show();
  await settle();
  const buttons = () => manualButtons(screen).map((node) => [node.getAttribute("data-coupang-rank-id"), node.textContent, node.disabled]);
  assert.equal(manualButtons(screen).length, 2);
  dispatch(manualButtonFor(screen), "click");
  await settle();
  assert.deepEqual(buttons()[0], [TRACKER_ID, "확인 중…", true]);
  screen.server.manual = manualPayload({ state: "off", enabled: false });
  dispatch(screen.host.querySelector("[data-coupang-rank-manual-toggle]"), "click");
  await settle();
  assert.deepEqual(buttons(), [[TRACKER_ID, "확인 중…", true]], "재고 있는 카드만, 꺼진 '확인 중…'");
  assert.ok(manualButtonFor(screen).classList.contains("is-running"));
  assert.equal(screen.host.querySelectorAll(".mi-coupang-rank-same-kw").length, 0);
  release();
  await settle();
  assert.equal(manualButtons(screen).length, 0, "끝나면 꺼짐 그대로(버튼 없음)");
  assert.match(cardNoteFor(screen), /^방금 확인 \d{2}:\d{2} · 일반 12위로 기록$/u);
  // 꺼져 있고 진행 중인 확인이 없으면 버튼이 없다
  const idle = mountManual({ manual: manualPayload({ state: "off", enabled: false }), listOverrides: { collector: { state: "not_connected" } } });
  idle.controller.show();
  await settle();
  assert.equal(manualButtons(idle).length, 0);
});

test("체크칸을 누르는 순간 '선택 항목 정리' 막대가 늘거나 줄면 그만큼 화면을 함께 옮겨 누른 체크칸이 밀리지 않는다(2026-10-23 재검사 2차)", async () => {
  const screen = mountWith();
  const scrolls = [];
  screen.window.scrollBy = (x, y) => scrolls.push([x, y]);
  // 가짜 배치: 막대가 열리면(is-open, 약 901~1230px 에서 동작 줄 두 줄) 그 아래 카드·그룹 머리 체크칸이 42px 내려간다
  const proto = Object.getPrototypeOf(screen.host);
  let grow = 42;
  proto.getBoundingClientRect = function () {
    const bulk = screen.host.querySelector("[data-coupang-rank-bulk]");
    const checkbox = this.hasAttribute("data-coupang-rank-select") || this.hasAttribute("data-coupang-rank-group-select");
    const top = checkbox ? 400 + (bulk && bulk.classList.contains("is-open") ? grow : 0) : 0;
    return { left: 0, right: 16, top, bottom: top + 16, width: 16, height: 16 };
  };
  screen.controller.show();
  await flush();
  const check = screen.host.querySelector(`[data-coupang-rank-select="${TRACKER_ID}"]`);
  check.checked = true;
  dispatch(check, "change");
  assert.deepEqual(scrolls, [[0, 42]], "고르면 늘어난 만큼 아래로");
  check.checked = false;
  dispatch(check, "change");
  assert.deepEqual(scrolls, [[0, 42], [0, -42]], "풀면 줄어든 만큼 위로");
  // 그룹 머리 '전체 선택'(목록을 다시 그림)은 새로 그린 같은 그룹 체크칸 기준
  const name = screen.host.querySelector("[data-coupang-rank-group-select]").getAttribute("data-coupang-rank-group-select");
  const group = screen.host.querySelector(`[data-coupang-rank-group-select="${name}"]`);
  group.checked = true;
  dispatch(group, "change");
  assert.deepEqual(scrolls.at(-1), [0, 42]);
  assert.notEqual(screen.host.querySelector(`[data-coupang-rank-group-select="${name}"]`), group, "다시 그린 새 노드");
  // 높이가 그대로인 너비(1231px 이상 · 휴대폰 아래 막대)는 옮기지 않는다
  grow = 0;
  const count = scrolls.length;
  const again = screen.host.querySelector(`[data-coupang-rank-group-select="${name}"]`);
  again.checked = false;
  dispatch(again, "change");
  assert.equal(scrolls.length, count);
});

test("C30 CSS(2026-10-23 재검사 2차): 접힌 막대 한 줄 · 결과 줄만 모양 · 휴대폰 포커스 테두리가 잘리지 않는 자리", () => {
  const withoutComments = cssSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleOf = (source, selector) => {
    const at = source.indexOf(selector);
    assert.ok(at >= 0, selector);
    const open = source.indexOf("{", at);
    return source.slice(open, source.indexOf("}", open));
  };
  const wide = withoutComments.slice(0, withoutComments.indexOf("@media"));
  const phone = withoutComments.slice(withoutComments.indexOf("@media (max-width: 900px)"), withoutComments.indexOf("@media (max-width: 720px)"));
  // 결함 7: 겹친 칸은 단추 한 줄 높이(34px)를 지키고, 휴대폰은 자리를 잡지 않는다(동작 줄은 아래 막대)
  assert.ok(ruleOf(wide, "#mi-admin .mi-coupang-rank-bulk-stack,").includes("min-height: 34px;"));
  assert.ok(ruleOf(phone, "#mi-admin .mi-coupang-rank-bulk-stack,").includes("min-height: 0;"));
  // 결함 2: 결과 줄만(is-note-only) — 넓은 화면은 숨기고, 휴대폰은 막대 상자 없이 아래 막대 안 결과 줄만
  assert.ok(ruleOf(wide, "#mi-admin .mi-coupang-rank-root .mi-coupang-rank-bulk.is-note-only,").includes("display: none;"));
  assert.ok(ruleOf(phone, "#mi-admin .mi-coupang-rank-root .mi-coupang-rank-bulk.is-note-only,").includes("display: contents;"));
  assert.ok(phone.includes("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-bulk.is-note-only .mi-coupang-rank-bulk-stack,"));
  assert.ok(ruleOf(phone, "#mi-admin .mi-coupang-rank-root .mi-coupang-rank-bulk.is-note-only > :not(.mi-coupang-rank-bulk-stack),").includes("display: none;"));
  // 결함 5: 검색칸·그룹 고르기 테두리는 안쪽, 카드 1행 칸은 자르는 상자만 사방 4px 넓힌다(칸 자리는 그대로)
  const input = ruleOf(phone, "#mi-admin .mi-coupang-rank-root .mi-coupang-rank-filterbar .mi-input:focus-visible,");
  assert.ok(input.includes("outline-offset: -2px;"));
  assert.ok(phone.includes("#mi-admin .mi-coupang-rank-root .mi-coupang-rank-filterbar select:focus-visible,"));
  const main = ruleOf(phone, "#mi-admin .mi-coupang-rank-root .mi-coupang-rank-card .mi-rank-track-main,");
  assert.ok(main.includes("margin: -4px;") && main.includes("padding: 4px;"));
  // 넓은 화면에는 카드 1행 칸 규칙을 더하지 않는다(901px 이상은 잘림 0 — 실측)
  assert.ok(!wide.includes(".mi-coupang-rank-card .mi-rank-track-main,"));
});

// ── 전체 확인(대표 승인 2026-10-24: '지금 확인 끄기' 옆, 오늘 안 한 상품을 키워드마다 한 번씩 차례로) ─────────────────

const ALL_GAP_MS = 180000;
const ALL_PAD_MS = 2000;
const allId = (n) => `6c1f0000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const allClaimId = (n) => `7d2a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// 지금 확인 경고 문장(금지 네 가지)을 그대로 쓴다.
const MANUAL_WARN_SENTENCE = "새 시크릿 창이 약 20초 열렸다 저절로 닫힙니다. 그 창을 닫거나 누르거나 내리지(가리지) 말고, 이 화면도 닫지 마세요.";
const ALL_WAIT_TEXT = `전체 확인 중입니다. 키워드마다 ${MANUAL_WARN_SENTENCE}`;

// 화면 차례: 기본 그룹(T1 키워드 A · T3 C · T5 D 일시중지 · T6 E 오늘 확인함) → 필름 그룹(T2 B · T4 A(같은 키워드) · T7 F).
// 대기열 = A(T1·T4) → C(T3) → B(T2) → F(T7): 키워드 4개 · 상품 5개.
function allTrackers(todayKst) {
  const make = (n, keyword, groupName, extra = {}) => trackerFixture({
    id: allId(n), keyword, keywordKey: keyword, groupName, productId: String(8000000000 + n), current: null, days: [],
    summary: { trend: "new", attention: false, attentionReasons: [] }, ...extra,
  });
  return [
    make(1, "키워드 A", "기본 그룹"),
    make(2, "키워드 B", "필름"),
    make(3, "키워드 C", "기본 그룹"),
    make(4, "키워드 A", "필름"),
    make(5, "키워드 D", "기본 그룹", { status: "paused", pausedAt: "2026-10-20T03:00:00.000Z", pausedDay: "2026-10-20" }),
    make(6, "키워드 E", "기본 그룹", { days: [{ d: todayKst, s: "found", r: 9, n: 50, a: null, t: "10:02", c: 1, f: 0, b: 9, k: 0 }] }),
    make(7, "키워드 F", "필름"),
  ];
}

// 시계를 따르는 가짜 서버: claim 은 서버 시각으로 간격(3분)·하루 상한·시간(09~19시)·그날 중지를 지키고,
// record 는 같은 키워드의 활성 추적을 모두 오늘 칸에 기록한다(실제 서버의 keyword_key 함께 기록). 모든 요청을 차례대로 log 에 남긴다.
function allServer(clock, options = {}) {
  const today = () => internals.kstDayAt(clock.now);
  const world = {
    trackers: options.trackers || allTrackers(today()),
    used: options.used ?? 3,
    max: options.max ?? 30,
    lastSearchAt: options.lastSearchAt ?? null,
    stoppedDay: null,
    off: false,
    open: null,
    seq: 0,
    claims: new Map(),
    log: [],
    claimTimes: [],
  };
  const base = () => ({
    enabled: !world.off, usedToday: world.used, maxPerDay: world.max, minGapSeconds: 180, fromHour: 9, toHour: 19, nextAt: null, busyUntil: null,
    stoppedDay: world.stoppedDay, stoppedAt: null, serverTime: iso(clock.now), extensionId: EXT_ID, minExtensionVersion: "1.0.0",
    extensionZipPath: "/coupang-check/mi-coupang-check-1.0.0.zip",
  });
  world.manual = () => {
    const info = base();
    const hour = internals.kstHourAt(clock.now);
    if (world.off) return { ...info, state: "off" };
    if (world.stoppedDay === today()) return { ...info, state: "stopped", stoppedAt: iso(clock.now - 60000), stoppedCode: "blocked_http_403" };
    if (hour < 9 || hour >= 19) return { ...info, state: "hours" };
    if (world.open && world.open.busyUntil > clock.now) return { ...info, state: "busy", busyUntil: iso(world.open.busyUntil) };
    if (world.used >= world.max) return { ...info, state: "daily_cap" };
    if (world.lastSearchAt !== null && world.lastSearchAt + ALL_GAP_MS > clock.now) return { ...info, state: "gap", nextAt: iso(world.lastSearchAt + ALL_GAP_MS) };
    return { ...info, state: "ready" };
  };
  const CODES = { gap: "COUPANG_MANUAL_GAP", busy: "COUPANG_MANUAL_BUSY", daily_cap: "COUPANG_MANUAL_DAILY_CAP", hours: "COUPANG_MANUAL_HOURS", stopped: "COUPANG_MANUAL_STOPPED", off: "COUPANG_MANUAL_OFF" };
  world.respond = async (url, init) => {
    world.log.push({ method: init.method, url: String(url), body: init.body ?? null, headers: { ...init.headers }, cache: init.cache, timeoutMs: init.timeoutMs });
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      if (body.action === "manual-claim") {
        world.claimTimes.push({ at: clock.now, trackerId: body.trackerId });
        const hooked = options.claim && options.claim(body, world);
        if (hooked) return response(hooked.payload, hooked.status || 200);
        const manual = world.manual();
        if (manual.state !== "ready") {
          const extra = manual.state === "gap" ? { retryAfterSec: Math.ceil((Date.parse(manual.nextAt) - clock.now) / 1000) } : {};
          return response({ ok: false, code: CODES[manual.state], message: "거절", ...extra, manual }, 409);
        }
        const tracker = world.trackers.find((item) => item.id === body.trackerId);
        if (!tracker || tracker.status !== "active") return response({ ok: false, code: "COUPANG_MANUAL_TRACKER_PAUSED", manual }, 409);
        world.seq += 1;
        world.used += 1;
        world.lastSearchAt = clock.now;
        const claim = { id: allClaimId(world.seq), token: `mcm1_${String(world.seq).padStart(43, "B")}`, tracker };
        world.claims.set(claim.id, claim);
        world.open = { busyUntil: clock.now + 150000 };
        return response({ ok: true, claimId: claim.id, claimToken: claim.token, keyword: tracker.keyword, keywordKey: tracker.keywordKey, expiresAt: iso(clock.now + 60000),
          expiresInSeconds: 60, serverTime: iso(clock.now), manual: world.manual() });
      }
      if (body.action === "manual-record") {
        world.open = null;
        const claim = world.claims.get(body.claimId);
        const hooked = options.record && options.record(body, world, claim);
        if (hooked) return response({ ...hooked, manual: world.manual() });
        if (body.outcome !== "measured") return response({ ok: true, accepted: true, outcome: body.outcome, status: null, matched: 0, counted: true, stopped: false, tracker: null, manual: world.manual() });
        const day = today();
        let matched = 0;
        world.trackers.forEach((tracker) => {
          if (tracker.status !== "active" || tracker.keywordKey !== claim.tracker.keywordKey) return;
          tracker.days = [{ d: day, s: "found", r: 12, n: 50, a: null, t: "12:00", c: 1, f: 0, b: 12, k: 0 }, ...tracker.days.filter((cell) => cell.d !== day)];
          matched += 1;
        });
        return response({ ok: true, accepted: true, duplicate: false, outcome: "measured", status: "ok", errorCode: null, matched, counted: true, stopped: false, stopCode: null, late: false,
          tracker: { trackerId: claim.tracker.id, result: "found", rank: 12, organicCount: 50, adOrder: null, checkedAt: iso(clock.now) }, manual: world.manual() });
      }
      if (body.action === "pause") {
        body.ids.forEach((id) => { const tracker = world.trackers.find((item) => item.id === id); if (tracker) tracker.status = "paused"; });
        return response({ ok: true, updated: body.ids.length });
      }
      if (body.action === "settings-update") {
        world.off = body.settings.manualEnabled === false;
        return response({ ok: true, manual: world.manual() });
      }
      return response({ ok: false, code: "COUPANG_ACTION_INVALID" }, 400);
    }
    // failGets: 목록 GET 이 서버 오류로 답한다(시험이 켜고 끈다)
    if (world.failGets) return response({ ok: false, code: "SERVER_ERROR", message: "잠시 뒤 다시 시도하세요." }, 503);
    const day = today();
    return response(listPayload({ trackers: JSON.parse(JSON.stringify(world.trackers)), todayKst: day, days30: days30(day), manual: world.manual() }));
  };
  world.of = (action) => world.log.filter((entry) => entry.method === "POST" && JSON.parse(entry.body).action === action);
  return world;
}

// 1초 재확인 타이머(1000ms)는 바로 돌리지 않고 모아 두었다가 시험이 시계를 옮기며 돌린다(deferTimersFrom: 1000).
function mountAll(options = {}) {
  const clock = options.clock || { now: SERVER_NOW };
  const server = options.server || allServer(clock, options);
  const bridge = options.bridge || fakeBridge(options);
  const screen = mountWith({ fetch: server.respond, extensionBridge: bridge, local: makeStorage(), deferTimersFrom: 1000, userAgent: CHROME_UA, clock,
    ...(options.confirm ? { confirm: options.confirm } : {}), ...(options.MutationObserver ? { MutationObserver: options.MutationObserver } : {}) });
  return { ...screen, server, bridge, clock };
}

const allButtonOf = (screen) => screen.host.querySelector("[data-coupang-rank-all-button]");
// 전체 확인 버튼은 꺼도 disabled 를 쓰지 않는다(누른 버튼이 꺼질 때 포커스가 사라지지 않게 aria-disabled).
const allOff = (screen) => {
  const node = allButtonOf(screen);
  assert.equal(node.disabled, false, "전체 확인 버튼에는 disabled 를 쓰지 않는다");
  return node.getAttribute("aria-disabled") === "true";
};
const allHintOf = (screen) => screen.host.querySelector("[data-coupang-rank-all-hint]").textContent;
const allStepOf = (screen) => screen.host.querySelector("[data-coupang-rank-all-step]").textContent;
const allCountdownOf = (screen) => screen.host.querySelector("[data-coupang-rank-all-countdown]").textContent;
const allSummaryOf = (screen) => {
  const node = screen.host.querySelector("[data-coupang-rank-all-summary]");
  return node.hidden ? "" : node.textContent;
};
// 모듈(vm)에서 만든 객체는 시험 쪽과 프로토타입이 달라 그대로 deepStrictEqual 하면 틀린다 → 평범한 값으로 바꿔 비교한다.
const plain = (value) => JSON.parse(JSON.stringify(value));
const claimedIds = (screen) => screen.server.claimTimes.map((entry) => entry.trackerId);
const pendingTicks = (screen) => screen.timeouts.filter((entry) => entry.ms === 1000 && !entry.cleared && !entry.ran);

async function runTicks(screen) {
  const due = pendingTicks(screen);
  due.forEach((entry) => {
    entry.ran = true;
    entry.fn();
  });
  await settle();
  return due.length;
}

// 시계를 step 만큼씩 옮기며 그때마다 1초 재확인을 돌린다(숨은 탭의 늦은 타이머는 큰 step 으로 흉내 낸다).
async function advanceAll(screen, ms, step = 1000) {
  for (let passed = 0; passed < ms; passed += step) {
    screen.clock.now += Math.min(step, ms - passed);
    await runTicks(screen);
  }
}

async function startAll(screen) {
  screen.controller.show();
  await settle();
  dispatch(allButtonOf(screen), "click");
  await settle();
}

test("전체 확인 계획: 화면 차례 · 오늘 안 한 활성 상품만 · 같은 키워드는 하나 · 남은 횟수만큼 자르고 모자란 수를 센다", () => {
  const plan = internals.manualAllPlan(allTrackers("2026-10-23"), "2026-10-23");
  assert.deepEqual(plain(plan.items).map((item) => [item.keyword, item.trackerIds]), [
    ["키워드 A", [allId(1), allId(4)]],
    ["키워드 C", [allId(3)]],
    ["키워드 B", [allId(2)]],
    ["키워드 F", [allId(7)]],
  ]);
  assert.equal(plan.products, 5);
  assert.deepEqual(plain(internals.manualAllPlan(allTrackers("2026-10-23"), "")), { items: [], products: 0 }, "오늘 날짜를 모르면 대상 없음");
  assert.deepEqual(plain(internals.manualAllTake(plan, 30)), { take: 4, shortage: 0 });
  assert.deepEqual(plain(internals.manualAllTake(plan, 2)), { take: 2, shortage: 2 });
  assert.deepEqual(plain(internals.manualAllTake(plan, 0)), { take: 0, shortage: 4 });
  assert.equal(internals.manualAllHint(4, 0, manualPayload()), "키워드 4개 · 약 12분");
  assert.equal(internals.manualAllHint(2, 2, manualPayload()), "키워드 2개 · 약 6분 · 2개는 횟수 모자람");
});

test("전체 확인 버튼 사유: 그날 중지 · 오늘 횟수 다 씀 · 시간 밖 · 다른 확인 진행 중 · 확장 확인 필요 · 확인할 상품 없음 (글로 보인다)", () => {
  const block = (kind, extra = {}) => internals.manualAllBlock({ view: { kind }, keywords: 3, remaining: 10, ...extra });
  assert.equal(block("ready"), "");
  assert.equal(block("gap"), "", "간격 대기 중에도 시작할 수 있다(첫 키워드가 간격을 기다린다)");
  assert.equal(block("incognito"), "", "다른 시크릿 창은 첫 키워드 직전에 확장에 다시 묻는다(카드 버튼과 같다)");
  assert.equal(block("stopped"), "그날 중지");
  assert.equal(block("daily_cap"), "오늘 횟수 다 씀");
  assert.equal(block("ready", { remaining: 0 }), "오늘 횟수 다 씀");
  assert.equal(block("hours"), "시간 밖");
  for (const kind of ["run", "own_pending", "busy_other", "own_lost", "own_unsent", "unsent_maybe", "ext_busy"]) assert.equal(block(kind), "다른 확인 진행 중", kind);
  assert.equal(block("ready", { running: true }), "다른 확인 진행 중");
  assert.equal(block("hello_block"), "확장 확인 필요");
  assert.equal(block("hello_pending"), "확장 확인 중");
  assert.equal(block("ready", { keywords: 0 }), "확인할 상품 없음");
  assert.equal(block("budget"), "용량 상한으로 멈춤");
  assert.equal(block("review"), "대표 확인 필요");
  assert.equal(block("cooldown"), "쉬는 중");
  assert.equal(block("unknown"), "상태를 알 수 없음");
  assert.equal(block("ready", { busy: true }), "다른 작업 중");
  assert.equal(block("ready", { cleanup: true }), "정리용 화면이라 쓸 수 없음");
});

test("전체 확인 결과 판정·멈춤 사유·요약 한 줄", () => {
  const verdict = internals.manualAllRecordVerdict;
  assert.deepEqual(plain(verdict({ step: "record", outcome: "measured", final: true, payload: { ok: true, status: "ok", matched: 2 } })), { success: true, matched: 2 });
  assert.deepEqual(plain(verdict({ step: "record", outcome: "measured", final: true, payload: { ok: true, status: "noresult", matched: 0 } })), { success: true, matched: 1 });
  assert.match(verdict({ outcome: "measured", final: true, stopped: true, payload: { ok: true, status: "blocked" } }).reason, /^쿠팡 차단으로 보이는 화면이 나와 오늘 지금 확인이 멈췄습니다$/u);
  assert.match(verdict({ outcome: "measured", final: false, payload: { ok: false } }).reason, /^결과를 서버에 보내지 못해 멈췄습니다/u);
  assert.match(verdict({ outcome: "not_started", final: true, payload: { ok: true } }).reason, /^확장이 확인을 시작하지 않아 멈췄습니다/u);
  assert.match(verdict({ outcome: "lost", final: true, payload: { ok: true } }).reason, /^확장 응답이 없어 멈췄습니다/u);
  assert.match(verdict({ outcome: "measured", final: true, payload: { ok: true, status: "error", errorCode: "window_closed" } }).reason, /^순위를 기록하지 못해 멈췄습니다/u);
  assert.match(verdict({ outcome: "measured", final: true, payload: { ok: false, code: "COUPANG_MANUAL_CLAIM_EXPIRED" } }).reason, /^확인 결과를 저장하지 못해 멈췄습니다/u);
  const server = manualPayload();
  assert.equal(internals.manualAllClaimStopText({ code: "COUPANG_MANUAL_DAILY_CAP" }, server), "오늘 확인 횟수를 모두 써서 멈췄습니다");
  assert.equal(internals.manualAllClaimStopText({ code: "COUPANG_MANUAL_HOURS" }, server), "정해진 시간(09~19시) 밖이 되어 멈췄습니다");
  assert.equal(internals.manualAllClaimStopText({ code: "COUPANG_MANUAL_STOPPED" }, server), "쿠팡 차단으로 보이는 화면이 나와 오늘 지금 확인이 멈췄습니다");
  assert.equal(internals.manualAllClaimStopText({ code: "COUPANG_MANUAL_GAP" }, server), "간격을 기다린 뒤에도 서버가 간격을 이유로 받지 않아 멈췄습니다");
  assert.equal(internals.manualAllClaimStopText({ code: "COUPANG_MANUAL_BUSY" }, server), "다른 확인이 진행 중이라 멈췄습니다");
  assert.equal(internals.manualAllClaimStopText({ transport: true }, server), "서버에 연결하지 못해 멈췄습니다");
  for (const stateName of ["ready", "gap", "busy"]) assert.equal(internals.manualAllStateStopText(stateName, server), "", stateName);
  assert.equal(internals.manualAllStateStopText("weird", server), "지금 확인 상태를 알 수 없어 멈췄습니다(코드 weird)");
  assert.deepEqual(plain(internals.manualAllSummary({ total: 5, checked: 5, recorded: 7, failed: 0 })), { text: "전체 확인 끝: 5개 키워드 · 상품 7개 기록 · 실패 0.", tone: "is-ok" });
  assert.deepEqual(plain(internals.manualAllSummary({ reason: "멈추기를 눌러 멈췄습니다", at: { number: 2, keyword: "키워드 C" }, total: 5, checked: 1, recorded: 2, failed: 0, left: 4, skipped: 1, shortage: 2 })), {
    text: "전체 확인 멈춤(2 / 5 '키워드 C'에서): 멈추기를 눌러 멈췄습니다. 1개 키워드 · 상품 2개 기록 · 실패 0 · 건너뜀 1개(일시중지·삭제·이미 확인) · 남은 4개 키워드는 하지 않음 · 키워드 2개는 오늘 횟수가 모자라 못 함.",
    tone: "is-warn",
  });
});

test("전체 확인: 화면 차례대로 키워드마다 한 번(같은 키워드는 함께 기록), 서버 간격(3분)+2초가 지난 뒤에만 다음 키워드, 끝나면 요약 한 줄", async () => {
  const screen = mountAll();
  screen.controller.show();
  await settle();
  // 시작 전: '지금 확인 끄기' 옆(같은 자리 위) 버튼과 예상 한 줄
  const side = screen.host.querySelector(".mi-coupang-rank-manual-side");
  assert.ok(side.children[0].hasAttribute("data-coupang-rank-all"), "전체 확인 자리가 먼저");
  assert.ok(side.children[1].hasAttribute("data-coupang-rank-manual-toggle"), "바로 옆(아래)이 '지금 확인 끄기'");
  assert.equal(allButtonOf(screen).textContent, "전체 확인");
  assert.equal(allOff(screen), false);
  assert.equal(allHintOf(screen), "키워드 4개 · 약 12분");
  // 확인 창 취소면 확인 창 전의 목록 GET 1번(화면 목록 요청과 같은 것) 말고는 요청이 없다(claim·확장 check 없음)
  const logBefore = screen.server.log.length;
  screen.window.confirm = (message) => { screen.confirmCalls.push(message); return false; };
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.deepEqual(screen.server.log.slice(logBefore).map((entry) => `${entry.method} ${entry.url}`), ["GET /api/coupang-rank-trackers?limit=500"]);
  assert.equal(screen.bridge.of("mi-coupang-check").length, 0);
  assert.equal(allOff(screen), false, "취소하면 다시 누를 수 있다");
  const confirmText = screen.confirmCalls.at(-1);
  assert.match(confirmText, /^'전체 확인'을 시작합니다\.\n오늘 아직 확인 안 한 상품 5개\(일시중지 빼고 · 키워드 4개\)를 키워드마다 한 번씩 차례로 확인합니다\./u);
  assert.ok(confirmText.includes("\n키워드 4개 · 약 12분(검색 사이 3분)\n"));
  // 금지 네 가지(창 닫기·창 안 누르기·창 내리기/가리기·이 화면 닫기)는 지금 확인 경고 문장 그대로(검토 결함: '내리지(가리지)' 빠짐)
  assert.ok(confirmText.includes(`진행하는 동안 키워드마다 ${MANUAL_WARN_SENTENCE} '멈추기'로 언제든 멈출 수 있습니다`));
  assert.ok(confirmText.includes("내리지(가리지)"));
  assert.doesNotMatch(confirmText, /횟수가 모자라|정해진 시간/u);
  // 확인 → 첫 키워드(A)는 바로(서버가 바로 가능)
  screen.window.confirm = (message) => { screen.confirmCalls.push(message); return true; };
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.deepEqual(claimedIds(screen), [allId(1)]);
  assert.equal(screen.bridge.of("mi-coupang-check").length, 1);
  assert.equal(manualPill(screen), "전체 확인 2 / 4");
  assert.equal(allStepOf(screen), "전체 확인 2 / 4 · '키워드 C'");
  assert.equal(allCountdownOf(screen), " · 다음 확인 3분 00초 뒤");
  assert.equal(screen.host.querySelector("[data-coupang-rank-all-step]").getAttribute("aria-live"), "polite");
  assert.equal(screen.host.querySelector("[data-coupang-rank-all-countdown]").getAttribute("aria-live"), null, "1초 초 세기는 aria-live 밖");
  assert.equal(manualLine(screen).textContent, ALL_WAIT_TEXT);
  assert.equal(manualMetric(screen, "next"), "3분 00초 뒤", "상태판 '다음 확인'과 같은 근거");
  assert.equal(allButtonOf(screen).textContent, "멈추기");
  assert.equal(allHintOf(screen), "누르면 남은 3개 취소");
  // 카드: 기록한 A 두 장·오늘 한 E 는 '잠김(전체 확인 중)', 나머지는 차례, 모두 꺼짐. 카드를 눌러도 claim 없음.
  const label = (n) => manualButtonFor(screen, allId(n)).textContent;
  assert.deepEqual([1, 2, 3, 4, 6, 7].map(label), ["잠김(전체 확인 중)", "대기 2번째", "대기 1번째", "잠김(전체 확인 중)", "잠김(전체 확인 중)", "대기 3번째"]);
  assert.ok(manualButtons(screen).every((node) => node.disabled));
  manualButtonFor(screen, allId(3)).disabled = false;
  dispatch(manualButtonFor(screen, allId(3)), "click");
  await settle();
  assert.deepEqual(claimedIds(screen), [allId(1)], "대기열 중 카드 '지금 확인'은 막힌다");
  // 간격 + 2초 전까지는 누르지 않는다(1초마다 다시 봐도)
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS - 1000, 10000);
  assert.deepEqual(claimedIds(screen), [allId(1)]);
  assert.equal(allCountdownOf(screen), " · 곧 시작");
  await advanceAll(screen, 1000);
  assert.deepEqual(claimedIds(screen), [allId(1), allId(3)]);
  assert.equal(manualPill(screen), "전체 확인 3 / 4");
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS, 2000);
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS, 2000);
  assert.deepEqual(claimedIds(screen), [allId(1), allId(3), allId(2), allId(7)], "같은 키워드 A 의 두 번째 카드(T4)는 따로 검색하지 않는다");
  const times = screen.server.claimTimes.map((entry) => entry.at);
  for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= ALL_GAP_MS + ALL_PAD_MS, `간격 ${times[index] - times[index - 1]}`);
  assert.equal(screen.server.of("manual-record").length, 4);
  assert.equal(allSummaryOf(screen), "전체 확인 끝: 4개 키워드 · 상품 5개 기록 · 실패 0.");
  assert.ok(screen.host.querySelector("[data-coupang-rank-all-summary]").classList.contains("is-ok"));
  assert.equal(screen.host.querySelector("[data-coupang-rank-all-summary]").getAttribute("aria-live"), "polite");
  assert.equal(screen.host.querySelector("[data-coupang-rank-all-progress]").hidden, true);
  assert.equal(allButtonOf(screen).textContent, "전체 확인");
  assert.equal(allOff(screen), true);
  assert.equal(allHintOf(screen), "확인할 상품 없음");
  assert.equal(manualPill(screen), "3분 간격 기다리는 중");
  assert.equal(pendingTicks(screen).length, 0, "끝나면 재확인 타이머가 없다");
  await advanceAll(screen, 600000, 60000);
  assert.equal(screen.server.claimTimes.length, 4);
});

test("전체 확인 한 건의 서버 요청·확장 메시지는 카드 '지금 확인' 한 번 누른 것과 바이트 단위로 같다(새 API·새 파라미터 없음)", async () => {
  const card = mountAll();
  card.controller.show();
  await settle();
  const cardLog = card.server.log.length;
  const cardMessages = card.bridge.messages.length;
  dispatch(manualButtonFor(card, allId(1)), "click");
  await settle();
  const queue = mountAll();
  queue.controller.show();
  await settle();
  const queueLog = queue.server.log.length;
  const queueMessages = queue.bridge.messages.length;
  dispatch(allButtonOf(queue), "click");
  await settle();
  const fromCard = card.server.log.slice(cardLog);
  const fromQueue = queue.server.log.slice(queueLog);
  // 화면을 열 때 받은 목록 GET(카드 한 번 누름에서도 같은 요청이 끝에 한 번 나간다)
  const listGet = queue.server.log[0];
  assert.equal(`${listGet.method} ${listGet.url}`, "GET /api/coupang-rank-trackers?limit=500");
  assert.deepEqual(fromCard.map((entry) => `${entry.method} ${entry.url}`), [
    "POST /api/coupang-rank-trackers", "POST /api/coupang-rank-trackers", "GET /api/coupang-rank-trackers?limit=500",
  ]);
  // 전체 확인은 시작 직전(확인 창 전)에 우리 서버 목록 GET 1번(지휘 결정 2026-10-24 — 쿠팡 요청 아님)을 더할 뿐, 그 뒤는 카드 한 번과 같다.
  assert.deepEqual(fromQueue.map((entry) => `${entry.method} ${entry.url}`), [
    "GET /api/coupang-rank-trackers?limit=500", "POST /api/coupang-rank-trackers", "POST /api/coupang-rank-trackers", "GET /api/coupang-rank-trackers?limit=500",
  ]);
  assert.deepEqual(fromQueue[0], listGet, "시작 직전 GET 은 화면 목록 요청과 바이트 단위로 같다(새 파라미터 없음)");
  assert.deepEqual(fromQueue.slice(1), fromCard, "claim·record·뒤 목록 GET 은 본문(JSON 바이트)·머리글·cache·timeoutMs 까지 카드 한 번과 같다");
  assert.equal(fromQueue[1].body, JSON.stringify({ action: "manual-claim", trackerId: allId(1) }));
  assert.deepEqual(queue.bridge.messages.slice(queueMessages), card.bridge.messages.slice(cardMessages));
  assert.deepEqual(queue.bridge.messages.slice(queueMessages).map((entry) => entry.message.type), ["mi-coupang-hello", "mi-coupang-check", "mi-coupang-ack"]);
  // 다음 키워드: 직전에 같은 목록 GET 1번 → claim(trackerId 하나뿐) → record → 목록 GET. 확장에는 hello·check·ack 그대로.
  const secondFrom = queue.server.log.length;
  const secondMessages = queue.bridge.messages.length;
  await advanceAll(queue, ALL_GAP_MS + ALL_PAD_MS, 3000);
  const second = queue.server.log.slice(secondFrom);
  assert.deepEqual(second.map((entry) => `${entry.method} ${entry.url}`), [
    "GET /api/coupang-rank-trackers?limit=500", "POST /api/coupang-rank-trackers", "POST /api/coupang-rank-trackers", "GET /api/coupang-rank-trackers?limit=500",
  ]);
  assert.deepEqual(second[0], listGet, "매 건 직전 GET 도 화면 목록 요청과 같다");
  assert.equal(second[1].body, JSON.stringify({ action: "manual-claim", trackerId: allId(3) }));
  assert.deepEqual(Object.keys(JSON.parse(second[2].body)), ["action", "claimId", "claimToken", "outcome", "page", "durationMs", "extensionVersion", "browser"]);
  assert.deepEqual(queue.bridge.messages.slice(secondMessages).map((entry) => entry.message.type), ["mi-coupang-hello", "mi-coupang-check", "mi-coupang-ack"]);
});

test("전체 확인: 매 건 직전에 다시 고른다 — 그사이 일시중지·이미 오늘 확인(다른 탭)한 키워드는 건너뛰고, 요약에 건너뜀 수", async () => {
  const screen = mountAll();
  await startAll(screen);
  assert.deepEqual(claimedIds(screen), [allId(1)]);
  // 다른 탭이 F 를 확인했고, 이 화면에서 C 카드를 일시중지한다(목록을 다시 받는다)
  const today = internals.kstDayAt(screen.clock.now);
  screen.server.trackers.find((tracker) => tracker.id === allId(7)).days = [{ d: today, s: "found", r: 3, n: 50, a: null, t: "12:01", c: 1, f: 0, b: 3, k: 0 }];
  dispatch(screen.host.querySelector(`[data-coupang-rank-action="pause"][data-coupang-rank-id="${allId(3)}"]`), "click");
  await settle();
  assert.equal(screen.server.of("pause").length, 1);
  await runTicks(screen);
  assert.equal(allStepOf(screen), "전체 확인 3 / 4 · '키워드 B'", "C 를 건너뛰고 B 가 다음");
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS, 3000);
  assert.deepEqual(claimedIds(screen), [allId(1), allId(2)]);
  assert.equal(allSummaryOf(screen), "전체 확인 끝: 2개 키워드 · 상품 3개 기록 · 실패 0 · 건너뜀 2개(일시중지·삭제·이미 확인).");
  assert.equal(pendingTicks(screen).length, 0);
});

test("전체 확인: 서버가 간격으로 거절하면 응답의 다음 시각까지 한 번만 다시 기다리고, 두 번째 거절이면 멈춘다(쿠팡 검색·확장 check 없음)", async () => {
  const once = mountAll({
    claim: (body, world) => (world.claimTimes.length === 1
      ? { status: 409, payload: { ok: false, code: "COUPANG_MANUAL_GAP", retryAfterSec: 60, manual: { ...world.manual(), state: "gap", nextAt: iso(world.claimTimes[0].at + 60000) } } }
      : null),
  });
  await startAll(once);
  assert.equal(once.server.claimTimes.length, 1);
  assert.equal(once.bridge.of("mi-coupang-check").length, 0);
  assert.equal(resultText(once), "검색 사이 간격(3분)을 기다리는 중입니다(1분 00초 남음). 쿠팡 검색은 하지 않았습니다.");
  assert.equal(manualPill(once), "전체 확인 1 / 4");
  assert.equal(allCountdownOf(once), " · 다음 확인 1분 00초 뒤");
  await advanceAll(once, 60000 + ALL_PAD_MS - 1000, 5000);
  assert.equal(once.server.claimTimes.length, 1, "다음 시각 + 2초 전에는 다시 누르지 않는다");
  await advanceAll(once, 1000);
  assert.deepEqual(claimedIds(once), [allId(1), allId(1)], "같은 키워드를 다시");
  assert.equal(once.bridge.of("mi-coupang-check").length, 1);
  assert.equal(manualPill(once), "전체 확인 2 / 4");

  const twice = mountAll({
    claim: (body, world) => ({ status: 409, payload: { ok: false, code: "COUPANG_MANUAL_GAP", retryAfterSec: 30, manual: { ...world.manual(), state: "gap", nextAt: iso(world.claimTimes.at(-1).at + 30000) } } }),
  });
  await startAll(twice);
  await advanceAll(twice, 30000 + ALL_PAD_MS, 2000);
  assert.equal(twice.server.claimTimes.length, 2);
  assert.equal(twice.bridge.of("mi-coupang-check").length, 0);
  assert.equal(allSummaryOf(twice), "전체 확인 멈춤(1 / 4 '키워드 A'에서): 간격을 기다린 뒤에도 서버가 간격을 이유로 받지 않아 멈췄습니다. 0개 키워드 · 상품 0개 기록 · 실패 0 · 남은 4개 키워드는 하지 않음.");
  assert.equal(pendingTicks(twice).length, 0);
  await advanceAll(twice, 600000, 60000);
  assert.equal(twice.server.claimTimes.length, 2);

  // 거절 응답에 manual 칸이 없어도 서버가 준 남은 초(retryAfterSec)+2초 전에는 다시 누르지 않는다(내 시계만 믿고 앞당기지 않음).
  const bare = mountAll({
    claim: (body, world) => (world.claimTimes.length === 1 ? { status: 409, payload: { ok: false, code: "COUPANG_MANUAL_GAP", retryAfterSec: 45 } } : null),
  });
  await startAll(bare);
  await advanceAll(bare, 45000 + ALL_PAD_MS - 1000, 5000);
  assert.equal(bare.server.claimTimes.length, 1);
  await advanceAll(bare, 1000);
  assert.equal(bare.server.claimTimes.length, 2);
  assert.equal(bare.bridge.of("mi-coupang-check").length, 1);
});

test("전체 확인: 차단(그날 중지)이면 그 자리에서 멈추고 남은 키워드를 하지 않는다", async () => {
  const blockedPage = measuredPage({ status: "blocked", httpStatus: 403, blockedText: true, organic: [], itemCount: 0, loginWall: false });
  const screen = mountAll({
    check: async (message) => ({ ok: true, reply: measuredReply(message.claimId === allClaimId(2) ? blockedPage : measuredPage()) }),
    record: (body, world, claim) => {
      if (claim.id !== allClaimId(2)) return null;
      world.stoppedDay = internals.kstDayAt(world.claimTimes.at(-1).at);
      return { ok: true, accepted: true, duplicate: false, outcome: "measured", status: "blocked", errorCode: "blocked_http_403", matched: 1, counted: true, stopped: true, stopCode: "blocked_http_403" };
    },
  });
  await startAll(screen);
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS, 3000);
  assert.deepEqual(claimedIds(screen), [allId(1), allId(3)]);
  // 위 그날 중지 띠(role=alert)가 사유를 이미 보이고 읽으므로, 끝 요약(aria-live)은 같은 사유를 짧게 가리킨다(같은 말을 두 번 보이거나 읽지 않게).
  assert.equal(allSummaryOf(screen), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 그날 중지(위 안내 참고). 1개 키워드 · 상품 2개 기록 · 실패 1 · 남은 2개 키워드는 하지 않음.");
  assert.equal(manualBanner(screen).hidden, false, "그날 중지 띠");
  assert.match(manualBanner(screen).textContent, /차단으로 보이는 화면/u);
  assert.doesNotMatch(allSummaryOf(screen), /차단으로 보이는 화면/u);
  assert.equal(manualResult(screen).hidden, true, "'직전 확인' 줄도 띠와 겹치면 숨는다(기존 규칙)");
  assert.equal(allOff(screen), true);
  assert.equal(allHintOf(screen), "그날 중지");
  assert.equal(pendingTicks(screen).length, 0);
  await advanceAll(screen, 600000, 60000);
  assert.equal(screen.server.claimTimes.length, 2);
});

test("전체 확인: 시작할 때 남은 횟수가 모자라면 할 수 있는 만큼만 하고 알린다 · 중간에 횟수가 다 차면 멈춘다", async () => {
  const short = mountAll({ used: 28 });
  short.controller.show();
  await settle();
  assert.equal(allHintOf(short), "키워드 2개 · 약 6분 · 2개는 횟수 모자람");
  assert.ok(short.host.querySelector("[data-coupang-rank-all-hint]").classList.contains("is-warn"));
  dispatch(allButtonOf(short), "click");
  await settle();
  assert.ok(short.confirmCalls.at(-1).includes("오늘 남은 횟수가 2번이라 키워드 2개만 하고, 2개는 오늘 횟수가 모자라 못 합니다."));
  assert.ok(short.confirmCalls.at(-1).includes("키워드 2개 · 약 6분(검색 사이 3분)"));
  assert.equal(manualPill(short), "전체 확인 2 / 2");
  await advanceAll(short, ALL_GAP_MS + ALL_PAD_MS, 3000);
  assert.deepEqual(claimedIds(short), [allId(1), allId(3)]);
  assert.equal(allSummaryOf(short), "전체 확인 끝: 2개 키워드 · 상품 3개 기록 · 실패 0 · 키워드 2개는 오늘 횟수가 모자라 못 함.");
  assert.equal(allHintOf(short), "오늘 횟수 다 씀");

  // 중간에 다른 탭이 남은 횟수를 다 썼다: 다음 건 직전 목록 GET 이 '오늘 횟수 다 씀'을 받아 claim 없이 멈춘다.
  const mid = mountAll();
  await startAll(mid);
  mid.server.used = mid.server.max;
  await advanceAll(mid, ALL_GAP_MS + ALL_PAD_MS, 3000);
  assert.equal(mid.server.claimTimes.length, 1, "목록 GET 으로 먼저 알아 claim 을 보내지 않는다");
  assert.equal(mid.bridge.of("mi-coupang-check").length, 1);
  assert.equal(allSummaryOf(mid), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 오늘 확인 횟수를 모두 써서 멈췄습니다. 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  // 목록 GET 뒤 claim 사이에 마지막 횟수가 쓰였으면 서버가 claim 을 거절한다(쿠팡 검색 없음) → 그 자리에서 멈춘다.
  const race = mountAll({ claim: (body, world) => (world.claimTimes.length === 2 ? { status: 409, payload: { ok: false, code: "COUPANG_MANUAL_DAILY_CAP", manual: { ...world.manual(), state: "daily_cap", usedToday: 30 } } } : null) });
  await startAll(race);
  await advanceAll(race, ALL_GAP_MS + ALL_PAD_MS, 3000);
  assert.equal(race.server.claimTimes.length, 2);
  assert.equal(race.bridge.of("mi-coupang-check").length, 1, "거절된 claim 은 확장에 보내지 않는다");
  assert.equal(allSummaryOf(race), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 오늘 확인 횟수를 모두 써서 멈췄습니다. 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  assert.equal(pendingTicks(race).length, 0);
});

test("전체 확인: 정해진 시간(19시)이 지나면 다음 키워드를 누르지 않고 멈춘다(시작 전 확인 창에 미리 알림)", async () => {
  const clock = { now: Date.parse("2026-10-23T09:58:00.000Z") }; // KST 18:58
  const screen = mountAll({ clock });
  screen.controller.show();
  await settle();
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.ok(screen.confirmCalls.at(-1).includes("정해진 시간(09~19시)이 지나면 남은 키워드는 하지 못하고 멈춥니다."));
  assert.deepEqual(claimedIds(screen), [allId(1)]);
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS, 3000);
  assert.deepEqual(claimedIds(screen), [allId(1)], "19시가 지나 누르지 않는다");
  assert.equal(allSummaryOf(screen), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 정해진 시간(09~19시) 밖이 되어 멈췄습니다. 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
});

test("전체 확인: 그 밖의 실패(확장 응답 없음 · 시작 안 함 · 기록 실패)는 그 자리에서 안전하게 멈추고 어디서 왜 멈췄는지 알린다", async () => {
  const cases = [
    { check: async () => ({ ok: false, code: "extension_no_response" }), reason: "확장 응답이 없어 멈췄습니다(위 '직전 확인' 참고)", detail: /검색이 됐는지는 확인하지 못했습니다/u },
    { check: async () => ({ ok: true, reply: { ok: false, outcome: "not_started", code: "window_closed_early" } }), reason: "확장이 확인을 시작하지 않아 멈췄습니다(위 '직전 확인' 참고)", detail: /시크릿 창이 닫혀/u },
    { record: () => ({ ok: true, accepted: true, outcome: "measured", status: "error", errorCode: "window_closed", matched: 0, counted: true, stopped: false }), reason: "순위를 기록하지 못해 멈췄습니다(위 '직전 확인' 참고)", detail: /확인 중에 시크릿 창이 닫혔습니다/u },
  ];
  for (const item of cases) {
    const screen = mountAll(item);
    await startAll(screen);
    assert.equal(screen.server.claimTimes.length, 1);
    assert.equal(allSummaryOf(screen), `전체 확인 멈춤(1 / 4 '키워드 A'에서): ${item.reason}. 0개 키워드 · 상품 0개 기록 · 실패 1 · 남은 3개 키워드는 하지 않음.`);
    assert.match(resultText(screen), item.detail, "자세한 사유는 '직전 확인' 줄");
    assert.equal(pendingTicks(screen).length, 0);
    await advanceAll(screen, 600000, 60000);
    assert.equal(screen.server.claimTimes.length, 1);
  }
});

test("전체 확인 '멈추기': 기다리는 중이면 바로 멈추고, 확인 중이면 그 1건은 끝까지 기록한 뒤 멈춘다", async () => {
  const waiting = mountAll();
  await startAll(waiting);
  const tick = pendingTicks(waiting)[0];
  assert.ok(tick);
  dispatch(allButtonOf(waiting), "click");
  await settle();
  assert.equal(tick.cleared, true, "재확인 타이머를 지운다");
  assert.equal(allSummaryOf(waiting), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 멈추기를 눌러 멈췄습니다. 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  assert.ok(waiting.host.querySelector("[data-coupang-rank-all-summary]").classList.contains("is-warn"));
  assert.equal(allButtonOf(waiting).textContent, "전체 확인");
  assert.match(manualButtonFor(waiting, allId(3)).textContent, /^\d분 \d{2}초 뒤$/u, "카드 버튼은 원래 글자로");
  await advanceAll(waiting, 600000, 60000);
  assert.equal(waiting.server.claimTimes.length, 1);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = mountAll({ check: async () => { await gate; return { ok: true, reply: measuredReply() }; } });
  await startAll(running);
  assert.equal(manualLine(running).textContent, `확인 중입니다… ${MANUAL_WARN_SENTENCE}`, "확인 중에는 지금 확인 경고 문장 그대로");
  assert.equal(allCountdownOf(running), " · 확인 중");
  assert.equal(manualButtonFor(running, allId(1)).textContent, "확인 중…");
  assert.equal(manualButtonFor(running, allId(4)).textContent, "확인 중…", "같은 키워드 카드도 함께 확인 중");
  dispatch(allButtonOf(running), "click");
  await settle();
  assert.equal(allButtonOf(running).textContent, "멈추는 중…");
  assert.equal(allOff(running), true);
  assert.equal(allStepOf(running), "전체 확인 1 / 4 · '키워드 A' · 멈추는 중(진행 중인 1건은 끝까지 기록합니다)");
  assert.equal(manualButtonFor(running, allId(3)).textContent, "잠김(전체 확인 중)", "남은 대기열은 바로 취소");
  assert.equal(running.server.of("manual-record").length, 0);
  release();
  await settle();
  assert.equal(running.server.of("manual-record").length, 1, "진행 중인 1건은 끝까지 기록");
  assert.equal(allSummaryOf(running), "전체 확인 멈춤(1 / 4 '키워드 A'에서): 멈추기를 눌러 멈췄습니다. 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  assert.equal(pendingTicks(running).length, 0);
  await advanceAll(running, 600000, 60000);
  assert.equal(running.server.claimTimes.length, 1);
});

test("전체 확인: '지금 확인 끄기' · 화면 이동이면 대기열도 멈춘다", async () => {
  const off = mountAll();
  await startAll(off);
  dispatch(off.host.querySelector("[data-coupang-rank-manual-toggle]"), "click");
  await settle();
  assert.deepEqual(JSON.parse(off.server.of("settings-update").at(-1).body), { action: "settings-update", settings: { manualEnabled: false } });
  assert.equal(allSummaryOf(off), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 지금 확인을 꺼서 멈췄습니다. 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  assert.equal(off.host.querySelector("[data-coupang-rank-all]").hidden, true, "꺼지면 전체 확인 버튼도 숨는다");
  await advanceAll(off, 600000, 60000);
  assert.equal(off.server.claimTimes.length, 1);

  const moved = mountAll();
  await startAll(moved);
  moved.view.classList.remove("is-active");
  await runTicks(moved);
  assert.equal(allSummaryOf(moved), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 화면을 옮기거나 화면이 잠겨 멈췄습니다. 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  moved.view.classList.add("is-active");
  await advanceAll(moved, 600000, 60000);
  assert.equal(moved.server.claimTimes.length, 1);
});

test("전체 확인: controller.destroy(로그아웃 잠금과 같은 reset)면 재확인 타이머를 지우고, 남은 타이머가 돌아도 요청하지 않는다", async () => {
  const screen = mountAll();
  await startAll(screen);
  const tick = pendingTicks(screen)[0];
  assert.ok(tick);
  screen.controller.destroy();
  assert.equal(tick.cleared, true);
  const logLength = screen.server.log.length;
  const messages = screen.bridge.messages.length;
  screen.clock.now += ALL_GAP_MS + 60000;
  tick.fn();
  await settle();
  assert.equal(screen.server.log.length, logLength);
  assert.equal(screen.bridge.messages.length, messages);
  assert.equal(screen.host.childNodes.length, 0);
});

test("전체 확인: 숨은 탭에서 재확인이 늦어지면 늦게 시작할 뿐 앞당기지 않고, 탭이 다시 보이면 바로 한 번 다시 본다", async () => {
  const screen = mountAll();
  await startAll(screen);
  const first = screen.server.claimTimes[0].at;
  screen.document.hidden = true;
  (screen.document.listeners.visibilitychange || []).forEach((fn) => fn());
  // 숨은 탭: 재확인이 50초마다(늦게) 돈다 → 간격+2초(182초)가 지난 첫 재확인(200초)에 시작
  await advanceAll(screen, 200000, 50000);
  assert.equal(screen.server.claimTimes.length, 2);
  assert.equal(screen.server.claimTimes[1].at - first, 200000, "늦게 시작");
  // 탭이 다시 보이면 남은 타이머를 기다리지 않고 바로 다시 본다(절대 시각 기준이라 앞당기지 않음)
  screen.clock.now += ALL_GAP_MS + ALL_PAD_MS - 1000;
  screen.document.hidden = false;
  (screen.document.listeners.visibilitychange || []).forEach((fn) => fn());
  await settle();
  assert.equal(screen.server.claimTimes.length, 2, "간격+2초 전이면 보이게 돼도 누르지 않는다");
  screen.clock.now += 5000;
  screen.document.hidden = true;
  (screen.document.listeners.visibilitychange || []).forEach((fn) => fn());
  screen.document.hidden = false;
  (screen.document.listeners.visibilitychange || []).forEach((fn) => fn());
  await settle();
  assert.equal(screen.server.claimTimes.length, 3);
  const times = screen.server.claimTimes.map((entry) => entry.at);
  for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= ALL_GAP_MS + ALL_PAD_MS);
});

test("전체 확인 버튼(화면): 꺼짐이면 숨고, 못 누르는 사유를 버튼 아래 글로 보인다", async () => {
  const today = "2026-10-23";
  const reasonOf = async (options, prepare) => {
    const screen = mountAll(options);
    if (prepare) prepare(screen);
    screen.controller.show();
    await settle();
    const block = screen.host.querySelector("[data-coupang-rank-all]");
    return { hidden: block.hidden, disabled: allOff(screen), hint: allHintOf(screen), title: allButtonOf(screen).getAttribute("title") };
  };
  let seen = await reasonOf({ used: 30 });
  assert.deepEqual([seen.disabled, seen.hint], [true, "오늘 횟수 다 씀"]);
  assert.equal(seen.title, "지금은 전체 확인을 할 수 없습니다: 오늘 횟수 다 씀");
  seen = await reasonOf({ clock: { now: Date.parse("2026-10-23T11:00:00.000Z") } }); // KST 20:00
  assert.deepEqual([seen.disabled, seen.hint], [true, "시간 밖"]);
  seen = await reasonOf({}, (screen) => { screen.server.stoppedDay = today; });
  assert.deepEqual([seen.disabled, seen.hint], [true, "그날 중지"]);
  seen = await reasonOf({ trackers: allTrackers(today).map((tracker) => ({ ...tracker, days: [{ d: today, s: "found", r: 5, n: 50, a: null, t: "10:00", c: 1, f: 0, b: 5, k: 0 }] })) });
  assert.deepEqual([seen.disabled, seen.hint], [true, "확인할 상품 없음"]);
  seen = await reasonOf({ hello: { ok: true, reply: helloReply({ incognitoAllowed: false }) } });
  assert.deepEqual([seen.disabled, seen.hint], [true, "확장 확인 필요"]);
  seen = await reasonOf({}, (screen) => { screen.server.open = { busyUntil: screen.clock.now + 90000 }; });
  assert.deepEqual([seen.disabled, seen.hint], [true, "다른 확인 진행 중"]);
  seen = await reasonOf({ lastSearchAt: SERVER_NOW - 60000 });
  assert.deepEqual([seen.disabled, seen.hint], [false, "키워드 4개 · 약 12분"], "간격 대기 중에도 누를 수 있다");
  seen = await reasonOf({}, (screen) => { screen.server.off = true; });
  assert.equal(seen.hidden, true, "지금 확인이 꺼져 있으면 숨는다");
  // 사용 방법 상자에도 한 줄
  const screen = mountAll();
  screen.controller.show();
  await settle();
  const items = screen.host.querySelector("[data-coupang-rank-guide]").querySelectorAll("li").map((li) => li.textContent);
  assert.equal(items[2], `전체 확인: 위 상태판의 '전체 확인'을 누르면 오늘 아직 확인 안 한 상품(일시중지 빼고)을 키워드마다 한 번씩, 검색 사이 3분을 기다리며 차례로 확인합니다(키워드 수 × 약 3분). 진행하는 동안 키워드마다 ${MANUAL_WARN_SENTENCE} '멈추기'를 누르면 남은 키워드를 바로 취소합니다.`);
  assert.ok(items[2].includes("내리지(가리지)"), "금지 네 가지를 줄이지 않는다");
});

test("전체 확인 CSS: 새 선택자 짝 · 토큰 색 · 진행 줄과 요약은 상태판 한 줄 전체", () => {
  for (const name of ["mi-coupang-rank-all", "mi-coupang-rank-all-button", "mi-coupang-rank-all-hint", "mi-coupang-rank-all-progress", "mi-coupang-rank-all-countdown", "mi-coupang-rank-all-summary"]) {
    assert.ok(new RegExp(`#mi-admin [^{]*\\.${name}\\b`, "u").test(cssSource), `#mi-admin ${name}`);
    assert.ok(new RegExp(`#mi-clean [^{]*\\.${name}\\b`, "u").test(cssSource), `#mi-clean ${name}`);
  }
  for (const selector of ["#mi-admin .mi-coupang-rank-all-progress,", "#mi-admin .mi-coupang-rank-all-summary,"]) {
    const at = cssSource.indexOf(selector);
    assert.ok(at >= 0, selector);
    const rule = cssSource.slice(at, cssSource.indexOf("}", at));
    assert.ok(rule.includes("grid-column: 1 / -1;") && rule.includes("overflow-wrap: anywhere;"), selector);
  }
});

// ── 전체 확인 검토 결함 고정(2026-10-24 검토 11건) ──

// 노드의 textContent 쓰기를 모두 기록한다(aria-live 줄이 같은 말을 또 쓰는지 본다).
function recordWrites(node) {
  const writes = [];
  const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "textContent");
  Object.defineProperty(node, "textContent", {
    configurable: true,
    get() { return proto.get.call(this); },
    set(value) { writes.push(String(value)); proto.set.call(this, value); },
  });
  return writes;
}

const otherTabChecked = (screen, keyword) => {
  const today = internals.kstDayAt(screen.clock.now);
  const cell = { d: today, s: "found", r: 4, n: 50, a: null, t: "12:00", c: 1, f: 0, b: 4, k: 0 };
  screen.server.trackers.filter((tracker) => tracker.keywordKey === keyword && tracker.status === "active").forEach((tracker) => {
    tracker.days = [cell, ...tracker.days.filter((day) => day.d !== today)];
  });
  screen.server.used += 1;
  screen.server.lastSearchAt = screen.clock.now;
};

test("전체 확인(검토 1): 시작 직전(확인 창 전)에 우리 서버 목록 GET 1번으로 다시 고른다 — 화면을 연 뒤 다른 탭·다른 PC가 오늘 확인한 키워드는 확인 창에도 대기열에도 넣지 않는다", async () => {
  const screen = mountAll();
  screen.controller.show();
  await settle();
  assert.equal(allHintOf(screen), "키워드 4개 · 약 12분");
  // 다른 탭이 키워드 A(T1·T4 함께 기록)를 확인했고 4분이 지났다(서버 간격도 지남). 이 화면 목록은 옛 것이다.
  otherTabChecked(screen, "키워드 A");
  screen.clock.now += 240000;
  const logBefore = screen.server.log.length;
  dispatch(allButtonOf(screen), "click");
  await settle();
  const sent = screen.server.log.slice(logBefore).map((entry) => `${entry.method} ${entry.url}${entry.body ? ` ${JSON.parse(entry.body).action}` : ""}`);
  assert.deepEqual(sent.slice(0, 2), ["GET /api/coupang-rank-trackers?limit=500", "POST /api/coupang-rank-trackers manual-claim"], "확인 창 전에 목록 GET, 확인 창을 바로 누르면 첫 키워드는 다시 받지 않는다");
  assert.match(screen.confirmCalls.at(-1), /오늘 아직 확인 안 한 상품 3개\(일시중지 빼고 · 키워드 3개\)/u, "확인 창도 최신 목록 기준");
  assert.deepEqual(claimedIds(screen), [allId(3)], "A 는 다시 검색하지 않고 C 부터");
  assert.deepEqual(screen.bridge.of("mi-coupang-check").map((entry) => entry.message.keyword), ["키워드 C"]);
  assert.equal(manualPill(screen), "전체 확인 2 / 3");
  // 확인 창 전 목록을 받지 못하면 시작하지 않는다(쿠팡 검색·claim 없음)
  const offline = mountAll();
  offline.controller.show();
  await settle();
  offline.server.failGets = true;
  const confirms = offline.confirmCalls.length;
  dispatch(allButtonOf(offline), "click");
  await settle();
  assert.equal(offline.confirmCalls.length, confirms, "확인 창을 띄우지 않는다");
  assert.equal(offline.server.claimTimes.length, 0);
  // failGets = 서버 오류(503): 인터넷 연결이 아니라 서버 오류라고 쓴다(2026-10-24 재검사 2차)
  assert.equal(allSummaryOf(offline), "전체 확인을 시작하지 않았습니다: 서버 오류로 최신 목록을 받지 못했습니다(잠시 뒤 다시 눌러 주세요). 쿠팡 검색은 하지 않았습니다.");
  assert.equal(allOff(offline), false, "다시 누를 수 있다");
});

test("전체 확인(검토 1): 매 건 시작 직전에도 목록 GET 1번 — 기다리는 3분 사이 다른 탭이 다음 키워드를 확인했으면 건너뛰고, 새 간격을 기다려 간격 거절 없이 다음으로 간다", async () => {
  const screen = mountAll();
  await startAll(screen);
  assert.deepEqual(claimedIds(screen), [allId(1)]);
  assert.equal(allStepOf(screen), "전체 확인 2 / 4 · '키워드 C'");
  // 2분 뒤 다른 탭이 C 를 확인했다(서버 간격이 그때부터 다시 3분). 이 화면은 아직 모른다.
  await advanceAll(screen, 120000, 10000);
  otherTabChecked(screen, "키워드 C");
  const otherAt = screen.clock.now;
  const gets = () => screen.server.log.filter((entry) => entry.method === "GET").length;
  const getsBefore = gets();
  // 이 화면 기준 간격(첫 확인 + 3분 + 2초)이 지나면 누르기 직전에 목록을 받는다 → C 는 건너뛰고, 새 간격(다른 탭 + 3분 + 2초)을 기다린다.
  await advanceAll(screen, 62000 + 1000, 1000);
  assert.equal(gets() - getsBefore, 1, "누르기 직전 목록 GET 1번");
  assert.deepEqual(claimedIds(screen), [allId(1)], "C 를 다시 claim 하지 않고, 새 간격 전이라 B 도 아직");
  assert.equal(allStepOf(screen), "전체 확인 3 / 4 · '키워드 B'");
  assert.match(allCountdownOf(screen), /^ · 다음 확인 \d분 \d{2}초 뒤$/u);
  await advanceAll(screen, otherAt + ALL_GAP_MS + ALL_PAD_MS - screen.clock.now, 1000);
  assert.deepEqual(claimedIds(screen), [allId(1), allId(2)]);
  assert.ok(screen.server.claimTimes[1].at >= otherAt + ALL_GAP_MS + ALL_PAD_MS, "다른 탭 확인으로 늘어난 서버 간격을 지킨다");
  assert.equal(screen.server.log.filter((entry) => entry.method === "POST" && /COUPANG_MANUAL_GAP/u.test(entry.body || "")).length, 0);
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS, 2000);
  assert.deepEqual(claimedIds(screen), [allId(1), allId(2), allId(7)]);
  assert.equal(screen.bridge.of("mi-coupang-check").filter((entry) => entry.message.keyword === "키워드 C").length, 0, "C 는 쿠팡에서 다시 검색하지 않았다");
  assert.equal(allSummaryOf(screen), "전체 확인 끝: 3개 키워드 · 상품 4개 기록 · 실패 0 · 건너뜀 1개(일시중지·삭제·이미 확인).");
  assert.equal(screen.server.used, 3 + 4, "하루 횟수: 이 화면 3번 + 다른 탭 1번");
  // 매 건 직전 GET 은 '새 목록을 받는 중입니다…' 줄을 띄우지 않는다(진행 줄이 이미 말한다)
  assert.equal(pendingTicks(screen).length, 0);
});

test("전체 확인(검토 1): 매 건 직전 목록 GET 이 실패하면 옛 목록으로 누르지 않고 멈춘다", async () => {
  const screen = mountAll();
  await startAll(screen);
  screen.server.failGets = true;
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS + 1000, 3000);
  assert.equal(screen.server.claimTimes.length, 1);
  assert.equal(allSummaryOf(screen), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 서버 오류로 최신 목록을 받지 못하고 멈췄습니다(잠시 뒤 다시 눌러 주세요). 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  assert.equal(pendingTicks(screen).length, 0);
});

test("전체 확인(검토 2): '멈추기'를 두 번 누르면(더블클릭·Enter 반복) 두 번째 누름이 바로 바뀐 '전체 확인'을 시작하지 않는다", async () => {
  const screen = mountAll();
  await startAll(screen);
  const confirms = screen.confirmCalls.length;
  const logLength = screen.server.log.length;
  dispatch(allButtonOf(screen), "click");
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.match(allSummaryOf(screen), /^전체 확인 멈춤\(2 \/ 4 '키워드 C'에서\): 멈추기를 눌러 멈췄습니다\./u);
  assert.equal(allButtonOf(screen).textContent, "전체 확인");
  assert.equal(screen.confirmCalls.length, confirms, "확인 창이 뜨지 않는다");
  assert.equal(screen.server.log.length, logLength, "목록 GET 도 보내지 않는다");
  screen.clock.now += 900;
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.equal(screen.confirmCalls.length, confirms, "1초 안의 누름은 받지 않는다");
  // 막은 누름마다 다시 센다(2026-10-24 재검사 2차): 끝난 지 1.1초여도 막은 누름 0.2초 뒤면 받지 않는다(누름 유지 · Enter 되풀이)
  screen.clock.now += 200;
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.equal(screen.confirmCalls.length, confirms, "누름이 1초 넘게 끊기지 않았으면 받지 않는다");
  // 누름이 1초 끊긴 뒤의 누름은 사람이 다시 누른 것이다 → 목록을 받고 확인 창
  screen.clock.now += 1000;
  screen.window.confirm = (message) => { screen.confirmCalls.push(message); return false; };
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.equal(screen.confirmCalls.length, confirms + 1);
  // 확인 중에 누른 '멈추기'는 '멈추는 중…'(꺼짐)이라 두 번째 누름을 받지 않는다
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = mountAll({ check: async () => { await gate; return { ok: true, reply: measuredReply() }; } });
  await startAll(running);
  dispatch(allButtonOf(running), "click");
  dispatch(allButtonOf(running), "click");
  await settle();
  assert.equal(allButtonOf(running).textContent, "멈추는 중…");
  release();
  await settle();
  const runningConfirms = running.confirmCalls.length;
  dispatch(allButtonOf(running), "click");
  await settle();
  assert.equal(running.confirmCalls.length, runningConfirms, "끝난 직후(1초 안) 누름도 받지 않는다");
});

test("전체 확인(검토 3): 한 건 확인 중에 다른 메뉴로 갔다가 그 건이 끝나기 전에 돌아와도 대기열은 멈춘다(그 1건은 끝까지 기록)", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const screen = mountAll({ check: async (message) => { if (message.claimId === allClaimId(2)) await gate; return { ok: true, reply: measuredReply() }; } });
  await startAll(screen);
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS, 3000);
  assert.deepEqual(claimedIds(screen), [allId(1), allId(3)]);
  assert.equal(allCountdownOf(screen), " · 확인 중");
  assert.ok(pendingTicks(screen).length >= 1, "확인 중에도 1초마다 화면 이동을 본다");
  screen.view.classList.remove("is-active");
  await runTicks(screen);
  assert.equal(allButtonOf(screen).textContent, "멈추는 중…");
  screen.view.classList.add("is-active");
  await runTicks(screen);
  release();
  await settle();
  assert.equal(screen.server.of("manual-record").length, 2, "진행 중인 1건은 끝까지 기록");
  assert.equal(allSummaryOf(screen), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 화면을 옮기거나 화면이 잠겨 멈췄습니다. 2개 키워드 · 상품 3개 기록 · 실패 0 · 남은 2개 키워드는 하지 않음.");
  assert.equal(pendingTicks(screen).length, 0);
  await advanceAll(screen, 600000, 60000);
  assert.equal(screen.server.claimTimes.length, 2, "돌아와도 이어 가지 않는다");
});

test("전체 확인(검토 3): 화면 칸 class 가 바뀌는 순간(지켜보기) 멈춘다 — 1초 재확인이 돌기 전에 돌아와도 이어 가지 않는다", async () => {
  const callbacks = [];
  const observed = [];
  class FakeMutationObserver {
    constructor(callback) { callbacks.push(callback); }
    observe(node, options) { observed.push({ node, options }); }
    disconnect() {}
  }
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const screen = mountAll({ MutationObserver: FakeMutationObserver, check: async () => { await gate; return { ok: true, reply: measuredReply() }; } });
  assert.equal(callbacks.length, 1, "지켜보기는 하나(루트 잠김 · 화면 칸)");
  assert.deepEqual(observed.map((entry) => entry.node), [screen.root, screen.view]);
  await startAll(screen);
  assert.equal(allCountdownOf(screen), " · 확인 중");
  screen.view.classList.remove("is-active");
  callbacks[0]([]);
  screen.view.classList.add("is-active");
  callbacks[0]([]);
  screen.controller.show();
  await settle();
  assert.equal(allButtonOf(screen).textContent, "멈추는 중…", "재확인 타이머가 돌지 않았어도 바로 멈춤");
  release();
  await settle();
  assert.equal(screen.server.of("manual-record").length, 1, "진행 중인 1건은 끝까지 기록");
  assert.equal(allSummaryOf(screen), "전체 확인 멈춤(1 / 4 '키워드 A'에서): 화면을 옮기거나 화면이 잠겨 멈췄습니다. 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  await advanceAll(screen, 600000, 60000);
  assert.equal(screen.server.claimTimes.length, 1);
  // 대기열이 없을 때 화면 칸이 바뀌어도 아무 일도 하지 않는다(루트 잠김 reset 은 그대로)
  screen.view.classList.remove("is-active");
  callbacks[0]([]);
  assert.ok(screen.host.childNodes.length > 0);
  screen.root.classList.add("is-locked");
  callbacks[0]([]);
  assert.equal(screen.host.childNodes.length, 0, "잠기면 reset");
});

test("전체 확인(검토 4): 남은 횟수만큼 자른 대기열에서 앞 키워드를 건너뛰면 횟수가 모자라 뺀 키워드로 채운다(요약도 사실대로)", async () => {
  const screen = mountAll({ used: 28 });
  screen.controller.show();
  await settle();
  assert.equal(allHintOf(screen), "키워드 2개 · 약 6분 · 2개는 횟수 모자람");
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.equal(manualPill(screen), "전체 확인 2 / 2");
  // 기다리는 중에 C 를 일시중지한다 → 1번이 남으므로 뺐던 B 를 채운다
  dispatch(screen.host.querySelector(`[data-coupang-rank-action="pause"][data-coupang-rank-id="${allId(3)}"]`), "click");
  await settle();
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS, 3000);
  assert.deepEqual(claimedIds(screen), [allId(1), allId(2)]);
  assert.equal(screen.server.used, 30, "오늘 횟수를 남김없이 썼다(서버 상한은 그대로)");
  assert.equal(allSummaryOf(screen), "전체 확인 끝: 2개 키워드 · 상품 3개 기록 · 실패 0 · 건너뜀 1개(일시중지·삭제·이미 확인) · 키워드 1개는 오늘 횟수가 모자라 못 함.");
  assert.equal(allHintOf(screen), "오늘 횟수 다 씀");
});

test("전체 확인(검토 5): 버튼을 꺼도 disabled 를 쓰지 않아(aria-disabled) 키보드 포커스가 같은 버튼에 남고, 꺼진 동안 누름은 받지 않는다", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // 같은 키워드만 남은 목록: 끝나면 '확인할 상품 없음'으로 꺼진다
  const screen = mountAll({ check: async () => { await gate; return { ok: true, reply: measuredReply() }; }, trackers: allTrackers("2026-10-23").filter((tracker) => tracker.keyword === "키워드 A") });
  screen.controller.show();
  await settle();
  const node = allButtonOf(screen);
  node.focus();
  dispatch(node, "click");
  await settle();
  assert.equal(allButtonOf(screen), node, "같은 버튼 노드(포커스 자리 그대로)");
  assert.equal(node.textContent, "멈추기");
  dispatch(node, "click");
  await settle();
  assert.equal(node.textContent, "멈추는 중…");
  assert.equal(allOff(screen), true);
  assert.equal(screen.document.activeElement, node);
  assert.ok(screen.host.contains(screen.document.activeElement));
  release();
  await settle();
  assert.equal(allButtonOf(screen), node);
  assert.equal(node.textContent, "전체 확인");
  assert.equal(allOff(screen), true);
  assert.equal(allHintOf(screen), "확인할 상품 없음");
  assert.equal(screen.document.activeElement, node, "끝나 사유로 꺼져도 포커스가 같은 버튼에");
  // 꺼진(aria-disabled) 버튼 누름은 받지 않는다
  screen.clock.now += 5000;
  const confirms = screen.confirmCalls.length;
  const logLength = screen.server.log.length;
  dispatch(node, "click");
  await settle();
  assert.equal(screen.confirmCalls.length, confirms);
  assert.equal(screen.server.log.length, logLength);
});

test("전체 확인(검토 8): 끝나는 순간 aria-live 줄이 같은 말을 또 쓰지 않고, 알약 바뀜도 따로 읽지 않는다(끝 요약 한 줄이 읽는다)", async () => {
  const screen = mountAll({ trackers: allTrackers("2026-10-23").filter((tracker) => ["키워드 A", "키워드 C"].includes(tracker.keyword)) });
  screen.controller.show();
  await settle();
  const listWrites = recordWrites(screen.host.querySelector("[data-coupang-rank-list-note]"));
  const announceWrites = recordWrites(screen.host.querySelector("[data-coupang-rank-manual-announce]"));
  dispatch(allButtonOf(screen), "click");
  await settle();
  await advanceAll(screen, ALL_GAP_MS + ALL_PAD_MS, 3000);
  assert.equal(screen.server.claimTimes.length, 2);
  assert.match(allSummaryOf(screen), /^전체 확인 끝: 2개 키워드/u);
  const loadingWrites = listWrites.filter((text) => text === "새 목록을 받는 중입니다…").length;
  assert.equal(loadingWrites, 2, `기록 뒤 목록 GET 마다 1번씩(끝날 때 두 번 쓰지 않고, 시작·매 건 직전 GET 은 띄우지 않는다): ${JSON.stringify(listWrites)}`);
  // 상태 알림 줄은 시크릿 창 경고 문장만 읽는다. 끝나는 순간 알약('3분 간격 기다리는 중' 등) 바뀜은 끝 요약이 대신한다.
  assert.deepEqual(announceWrites, [`지금 확인 상태: 확인 중입니다… ${MANUAL_WARN_SENTENCE}`]);
});

test("전체 확인(검토 11): 다음 키워드 상품을 일시중지하면 뒤 카드의 '대기 n번째'·'누르면 남은 n개 취소'가 바로 한 칸씩 당겨진다", async () => {
  const screen = mountAll();
  await startAll(screen);
  const label = (n) => manualButtonFor(screen, allId(n)).textContent;
  assert.deepEqual([3, 2, 7].map(label), ["대기 1번째", "대기 2번째", "대기 3번째"]);
  assert.equal(allHintOf(screen), "누르면 남은 3개 취소");
  dispatch(screen.host.querySelector(`[data-coupang-rank-action="pause"][data-coupang-rank-id="${allId(3)}"]`), "click");
  await settle();
  assert.equal(manualButtonFor(screen, allId(3)), null, "일시중지한 카드는 버튼이 없다");
  assert.deepEqual([2, 7].map(label), ["대기 1번째", "대기 2번째"]);
  assert.equal(allHintOf(screen), "누르면 남은 2개 취소");
  await runTicks(screen);
  assert.deepEqual([2, 7].map(label), ["대기 1번째", "대기 2번째"], "1초 재확인 뒤에도 같다");
});

test("전체 확인 CSS(검토 5·9): 꺼진 버튼은 aria-disabled 로 같은 모양 · 넓은 화면에서 전체 확인 자리는 오른쪽 칸 폭을 넓히지 않는다(contain: inline-size)", () => {
  const rule = (selector) => {
    const at = cssSource.indexOf(selector);
    assert.ok(at >= 0, selector);
    return cssSource.slice(at, cssSource.indexOf("}", at));
  };
  assert.ok(!/mi-coupang-rank-all-button:disabled/u.test(cssSource), "disabled 선택자는 쓰지 않는다");
  const off = rule('#mi-admin .mi-coupang-rank-root .mi-coupang-rank-manual-side .mi-coupang-rank-all-button[aria-disabled="true"],');
  assert.ok(off.includes("color: var(--mi-muted);") && off.includes("transform: none;") && off.includes("box-shadow: none;"), off);
  assert.ok(cssSource.includes('#mi-clean .mi-coupang-rank-root .mi-coupang-rank-manual-side .mi-coupang-rank-all-button[aria-disabled="true"]'));
  // 전체 확인 자리는 오른쪽 칸 폭 계산에서 빠지고(넓은 화면), 900px 이하(한 줄 전체 폭)는 푼다.
  const base = rule("#mi-admin .mi-coupang-rank-all,\n#mi-clean .mi-coupang-rank-all {");
  assert.ok(base.includes("contain: inline-size;"), base);
  const phone = cssSource.slice(cssSource.indexOf("@media (max-width: 900px) {"));
  const phoneRule = phone.slice(phone.indexOf("  #mi-admin .mi-coupang-rank-all,\n  #mi-clean .mi-coupang-rank-all {"));
  assert.ok(phoneRule.slice(0, phoneRule.indexOf("}")).includes("contain: none;"), "900px 이하는 contain 을 푼다");
});

// ── 전체 확인 재검사 2차 결함 고정(2026-10-24, 5건) ──

// 목록 GET 을 잡아 둘 수 있는 서버(holdGets = true 면 GET 이 풀릴 때까지 기다린다).
function heldGetServer(clock, options = {}) {
  const world = allServer(clock, options);
  const inner = world.respond;
  world.holdGets = false;
  world.held = [];
  world.respond = async (url, init) => {
    if (init.method === "GET" && world.holdGets) await new Promise((resolve) => world.held.push(resolve));
    return inner(url, init);
  };
  world.releaseGets = () => world.held.splice(0).forEach((resolve) => resolve());
  return world;
}

// dispatch 와 같고, 이벤트에 칸(repeat·key 등)을 덧붙인다.
function dispatchWith(target, type, extra) {
  const path = [];
  for (let node = target; node; node = node.parentNode) path.push(node);
  const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  for (const node of path.slice().reverse()) (node.listeners?.[type] || []).filter((entry) => entry.capture).forEach((entry) => entry.fn(event));
  for (const node of path) (node.listeners?.[type] || []).filter((entry) => !entry.capture).forEach((entry) => entry.fn(event));
  return event;
}

test("전체 확인(재검사 2차 1): 누른 뒤 목록 GET 을 받는 사이(준비 중) 다른 메뉴로 가면 확인 창을 다른 화면 위에 띄우지 않고, 준비 중에는 카드 '지금 확인'도 막는다", async () => {
  const clock = { now: SERVER_NOW };
  const world = heldGetServer(clock);
  const screen = mountAll({ clock, server: world });
  screen.controller.show();
  await settle();
  const confirms = screen.confirmCalls.length;
  world.holdGets = true;
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.equal(world.held.length, 1, "확인 창 전 목록 GET 이 잡혀 있다");
  assert.equal(allOff(screen), true);
  assert.equal(allHintOf(screen), "최신 목록을 받는 중…");
  const card = manualButtonFor(screen, allId(3));
  assert.equal(card.disabled, true, "준비 중에도 카드 '지금 확인'은 꺼진다");
  assert.equal(card.getAttribute("title"), "전체 확인을 시작하려고 최신 목록을 받는 중이라 카드의 '지금 확인'은 잠시 막아 두었습니다");
  dispatch(card, "click");
  await settle();
  assert.equal(world.claimTimes.length, 0, "카드 확인이 끼어들지 않는다");
  // 다른 메뉴로 간 뒤 GET 이 온다 → 확인 창 없음 · claim 없음 · 왜 시작하지 않았는지 한 줄
  screen.view.classList.remove("is-active");
  await settle();
  clock.now += 1500;
  world.holdGets = false;
  world.releaseGets();
  await settle();
  assert.equal(screen.confirmCalls.length, confirms, "다른 화면 위에 확인 창을 띄우지 않는다");
  assert.equal(world.claimTimes.length, 0);
  assert.equal(allSummaryOf(screen), "전체 확인을 시작하지 않았습니다: 최신 목록을 받는 사이 화면을 옮겼습니다. 쿠팡 검색은 하지 않았습니다.");
  assert.equal(pendingTicks(screen).length, 0);
  // 돌아오면 다시 누를 수 있고 카드도 다시 켜진다
  screen.view.classList.add("is-active");
  screen.controller.show();
  await settle();
  assert.equal(allOff(screen), false);
  assert.equal(manualButtonFor(screen, allId(3)).disabled, false);

  // 지켜보기(MutationObserver): 준비 중에 잠깐 갔다가 GET 이 오기 전에 돌아와도 확인 창을 띄우지 않는다
  const callbacks = [];
  class FakeMutationObserver {
    constructor(callback) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  }
  const clock2 = { now: SERVER_NOW };
  const world2 = heldGetServer(clock2);
  const quick = mountAll({ clock: clock2, server: world2, MutationObserver: FakeMutationObserver });
  quick.controller.show();
  await settle();
  const quickConfirms = quick.confirmCalls.length;
  world2.holdGets = true;
  dispatch(allButtonOf(quick), "click");
  await settle();
  quick.view.classList.remove("is-active");
  callbacks[0]([]);
  quick.view.classList.add("is-active");
  callbacks[0]([]);
  world2.holdGets = false;
  world2.releaseGets();
  await settle();
  assert.equal(quick.confirmCalls.length, quickConfirms);
  assert.equal(world2.claimTimes.length, 0);
  assert.equal(allSummaryOf(quick), "전체 확인을 시작하지 않았습니다: 최신 목록을 받는 사이 화면을 옮겼습니다. 쿠팡 검색은 하지 않았습니다.");

  // 옮기지 않았으면 그대로 확인 창(거절하면 카드는 다시 켜진다)
  const stay = mountAll({ confirm: () => false });
  stay.controller.show();
  await settle();
  dispatch(allButtonOf(stay), "click");
  await settle();
  assert.equal(stay.confirmCalls.length, 1);
  assert.equal(manualButtonFor(stay, allId(3)).disabled, false, "확인 창을 거절하면 카드 '지금 확인'을 다시 켠다");
  assert.equal(stay.server.claimTimes.length, 0);
});

test("전체 확인(재검사 2차 2): 다른 탭이 확인해서(그쪽이 횟수 1번을 씀) 건너뛴 키워드 자리는 횟수가 모자라 뺀 키워드로 채우지 않는다 — '끝'으로 끝나고 못 한 키워드는 '횟수 모자람'에 센다", async () => {
  const screen = mountAll({ used: 28 });
  await startAll(screen);
  assert.equal(manualPill(screen), "전체 확인 2 / 2");
  await advanceAll(screen, 60000, 1000);
  otherTabChecked(screen, "키워드 C");
  await advanceAll(screen, ALL_GAP_MS * 2, 1000);
  assert.deepEqual(claimedIds(screen), [allId(1)], "B 를 채워 claim 하지 않는다");
  assert.equal(screen.server.used, 30);
  assert.equal(screen.server.log.filter((entry) => entry.method === "POST").length, 2, "POST 는 A claim·record 두 번뿐(하루 상한 거절 없음)");
  assert.equal(allSummaryOf(screen), "전체 확인 끝: 1개 키워드 · 상품 2개 기록 · 실패 0 · 건너뜀 1개(일시중지·삭제·이미 확인) · 키워드 2개는 오늘 횟수가 모자라 못 함.");
  assert.ok(screen.host.querySelector("[data-coupang-rank-all-summary]").classList.contains("is-ok"), "아무 일 없이 끝났으므로 경고 색이 아니다");
  assert.equal(pendingTicks(screen).length, 0);

  // 일시중지로 건너뛰어도, 그사이 다른 탭이 오늘 남은 횟수를 다 썼으면(서버가 준 최신 값) 채우지 않는다
  const spent = mountAll({ used: 28 });
  await startAll(spent);
  otherTabChecked(spent, "키워드 B");
  dispatch(spent.host.querySelector(`[data-coupang-rank-action="pause"][data-coupang-rank-id="${allId(3)}"]`), "click");
  await settle();
  await advanceAll(spent, ALL_GAP_MS * 2, 1000);
  assert.deepEqual(claimedIds(spent), [allId(1)]);
  assert.equal(spent.server.log.filter((entry) => entry.method === "POST" && JSON.parse(entry.body).action === "manual-claim").length, 1, "F 를 채워 하루 상한 거절을 받지 않는다");
  assert.equal(allSummaryOf(spent), "전체 확인 끝: 1개 키워드 · 상품 2개 기록 · 실패 0 · 건너뜀 1개(일시중지·삭제·이미 확인) · 키워드 1개는 오늘 횟수가 모자라 못 함.");
});

test("전체 확인(재검사 2차 3): 목록 GET 을 받지 못한 이유를 나눠 쓴다 — 로그인 풀림(401) · 서버 오류(5xx) · 연결 실패, 시작 전과 도중 모두", async () => {
  const list = internals.manualAllListFailText;
  assert.equal(list("transport", true), "서버에 연결하지 못해 최신 목록을 받지 못하고 멈췄습니다(인터넷 연결 확인)");
  assert.equal(list("session", true), "로그인이 풀려 최신 목록을 받지 못하고 멈췄습니다(다시 로그인해 주세요)");
  assert.equal(list("server", true), "서버 오류로 최신 목록을 받지 못하고 멈췄습니다(잠시 뒤 다시 눌러 주세요)");
  assert.equal(list("other", true), "최신 목록을 받지 못하고 멈췄습니다(목록 안내 줄 참고)");
  assert.equal(list("", false), "최신 목록을 받지 못했습니다(목록 안내 줄 참고)");
  assert.equal(list("constructor", false), "최신 목록을 받지 못했습니다(목록 안내 줄 참고)");
  assert.equal(list("session", false), "로그인이 풀려 최신 목록을 받지 못했습니다(다시 로그인해 주세요)");

  const withGets = (answer) => {
    const clock = { now: SERVER_NOW };
    const world = allServer(clock);
    const inner = world.respond;
    world.answer = null;
    world.respond = async (url, init) => {
      if (init.method === "GET" && world.answer) return world.answer();
      return inner(url, init);
    };
    world.set = (fn) => { world.answer = fn; };
    return { clock, world };
  };
  // 도중: 매 건 직전 GET 이 401
  const a = withGets();
  const mid = mountAll({ clock: a.clock, server: a.world });
  await startAll(mid);
  a.world.set(() => response({ ok: false, code: "SESSION_REQUIRED", message: "로그인이 필요합니다." }, 401));
  await advanceAll(mid, ALL_GAP_MS + ALL_PAD_MS + 2000, 1000);
  assert.equal(allSummaryOf(mid), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 로그인이 풀려 최신 목록을 받지 못하고 멈췄습니다(다시 로그인해 주세요). 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  assert.equal(mid.host.querySelector("[data-coupang-rank-list-note]").textContent, "로그인이 필요합니다. 다시 로그인해주세요. 화면의 이전 목록을 그대로 둡니다.");
  assert.equal(a.world.claimTimes.length, 1);
  // 시작 전: 401
  const b = withGets();
  const before = mountAll({ clock: b.clock, server: b.world });
  before.controller.show();
  await settle();
  b.world.set(() => response({ ok: false, code: "SESSION_REQUIRED", message: "로그인이 필요합니다." }, 401));
  const confirms = before.confirmCalls.length;
  dispatch(allButtonOf(before), "click");
  await settle();
  assert.equal(before.confirmCalls.length, confirms);
  assert.equal(allSummaryOf(before), "전체 확인을 시작하지 않았습니다: 로그인이 풀려 최신 목록을 받지 못했습니다(다시 로그인해 주세요). 쿠팡 검색은 하지 않았습니다.");
  // 도중: 연결 실패(두 번 모두 — 1.5초 뒤 한 번 다시 시도)
  const c = withGets();
  const offline = mountAll({ clock: c.clock, server: c.world });
  await startAll(offline);
  c.world.set(() => { throw new TypeError("Failed to fetch"); });
  await advanceAll(offline, ALL_GAP_MS + ALL_PAD_MS + 1000, 1000);
  const retries = offline.timeouts.filter((entry) => entry.ms === 1500 && !entry.cleared && !entry.ran);
  assert.equal(retries.length, 1, "연결 실패는 1.5초 뒤 한 번 다시 시도한다");
  retries.forEach((entry) => { entry.ran = true; entry.fn(); });
  await settle();
  assert.equal(allSummaryOf(offline), "전체 확인 멈춤(2 / 4 '키워드 C'에서): 서버에 연결하지 못해 최신 목록을 받지 못하고 멈췄습니다(인터넷 연결 확인). 1개 키워드 · 상품 2개 기록 · 실패 0 · 남은 3개 키워드는 하지 않음.");
  assert.equal(c.world.claimTimes.length, 1);
});

test("전체 확인(재검사 2차 5): '멈추기' 위에서 Enter 를 누르고 있어도(30ms 마다 누름 · 키 되풀이) 확인 창이 다시 뜨지 않고, 손을 뗀 뒤 다시 누르면 받는다", async () => {
  const screen = mountAll();
  await startAll(screen);
  screen.window.confirm = (message) => { screen.confirmCalls.push(message); return false; };
  const confirms = screen.confirmCalls.length;
  const gets = () => screen.server.log.filter((entry) => entry.method === "GET").length;
  const getsBefore = gets();
  // 30ms 마다 누름 1.5초(크롬은 버튼 위 Enter 되풀이마다 click 을 보낸다): 첫 누름이 '멈추기', 나머지는 바뀐 '전체 확인' 위
  for (let ms = 0; ms <= 1500; ms += 30) {
    dispatch(allButtonOf(screen), "click");
    await settle();
    screen.clock.now += 30;
  }
  assert.match(allSummaryOf(screen), /^전체 확인 멈춤\(2 \/ 4 '키워드 C'에서\): 멈추기를 눌러 멈췄습니다\./u);
  assert.equal(screen.confirmCalls.length, confirms, "누르고 있는 동안 확인 창이 다시 뜨지 않는다");
  assert.equal(gets(), getsBefore, "목록 GET 도 보내지 않는다");
  // 손을 떼고 1초 뒤 다시 누르면 받는다
  screen.clock.now += 1000;
  dispatch(allButtonOf(screen), "click");
  await settle();
  assert.equal(screen.confirmCalls.length, confirms + 1);

  // 키 되풀이 첫 간격이 1초보다 긴 경우: 끝난 지 2초 뒤라도 되풀이된 keydown 바로 뒤의 누름은 받지 않는다
  const slow = mountAll();
  await startAll(slow);
  slow.window.confirm = (message) => { slow.confirmCalls.push(message); return false; };
  const button = allButtonOf(slow);
  dispatchWith(button, "keydown", { key: "Enter", repeat: false });
  dispatch(button, "click");
  await settle();
  assert.equal(button.textContent, "전체 확인");
  const slowConfirms = slow.confirmCalls.length;
  slow.clock.now += 2000;
  dispatchWith(button, "keydown", { key: "Enter", repeat: true });
  dispatch(button, "click");
  await settle();
  assert.equal(slow.confirmCalls.length, slowConfirms, "되풀이된 Enter 의 누름은 받지 않는다");
  slow.clock.now += 1200;
  dispatchWith(button, "keydown", { key: "Enter", repeat: false });
  dispatch(button, "click");
  await settle();
  assert.equal(slow.confirmCalls.length, slowConfirms + 1, "손을 뗐다가 새로 누른 Enter 는 받는다");
});

test("전체 확인(재검사 2차 4): 작은 글은 단어 단위로만 줄을 바꾸고, '횟수 모자람'은 넓은 화면에서 따로 다음 줄(줄 앞 '·' 없음) · 901~1360px 는 오른쪽 칸을 정한 폭으로 넓힌다", async () => {
  const rule = (source, selector) => {
    const at = source.indexOf(selector);
    assert.ok(at >= 0, selector);
    return source.slice(at, source.indexOf("}", at));
  };
  const hint = rule(cssSource, "#mi-admin .mi-coupang-rank-all-hint,\n#mi-clean .mi-coupang-rank-all-hint {");
  assert.ok(hint.includes("word-break: keep-all;") && hint.includes("overflow-wrap: break-word;"), hint);
  assert.ok(!hint.includes("anywhere"), "글자 사이 꺾임(overflow-wrap: anywhere)을 쓰지 않는다");
  assert.ok(rule(cssSource, "#mi-admin .mi-coupang-rank-all-hint-sep,\n#mi-clean .mi-coupang-rank-all-hint-sep {").includes("display: none;"));
  assert.ok(rule(cssSource, "#mi-admin .mi-coupang-rank-all-hint-more,\n#mi-clean .mi-coupang-rank-all-hint-more {").includes("display: block;"));
  for (const name of ["mi-coupang-rank-all-hint-sep", "mi-coupang-rank-all-hint-more"]) {
    assert.ok(new RegExp(`#mi-admin [^{]*\\.${name}\\b`, "u").test(cssSource), `#mi-admin ${name}`);
    assert.ok(new RegExp(`#mi-clean [^{]*\\.${name}\\b`, "u").test(cssSource), `#mi-clean ${name}`);
  }
  const mid = cssSource.slice(cssSource.indexOf("@media (min-width: 901px) and (max-width: 1360px) {"), cssSource.indexOf("@media (min-width: 901px) and (max-width: 1180px) {"));
  assert.ok(rule(mid, "  #mi-admin .mi-coupang-rank-all,\n  #mi-clean .mi-coupang-rank-all {").includes("width: 136px;"), "901~1360px 는 정한 폭(글 길이를 따르지 않음)");
  const phone = cssSource.slice(cssSource.indexOf("@media (max-width: 900px) {"));
  assert.ok(rule(phone, "  #mi-admin .mi-coupang-rank-all-hint-sep,\n  #mi-admin .mi-coupang-rank-all-hint-more,").includes("display: inline;"), "900px 이하는 ' · '로 이어 쓴다");

  // 화면: 글은 그대로(' · ' 포함), ' · '와 '횟수 모자람'은 따로 둔 칸
  assert.deepEqual(plain(internals.manualAllHintParts(2, 2, manualPayload())), ["키워드 2개 · 약 6분", "2개는 횟수 모자람"]);
  const screen = mountAll({ used: 28 });
  screen.controller.show();
  await settle();
  const node = screen.host.querySelector("[data-coupang-rank-all-hint]");
  assert.equal(node.textContent, "키워드 2개 · 약 6분 · 2개는 횟수 모자람");
  assert.equal(node.querySelector(".mi-coupang-rank-all-hint-sep").textContent, " · ");
  assert.equal(node.querySelector(".mi-coupang-rank-all-hint-more").textContent, "2개는 횟수 모자람");
  const full = mountAll();
  full.controller.show();
  await settle();
  const fullNode = full.host.querySelector("[data-coupang-rank-all-hint]");
  assert.equal(fullNode.textContent, "키워드 4개 · 약 12분");
  assert.equal(fullNode.querySelector(".mi-coupang-rank-all-hint-more"), null, "모자람이 없으면 따로 둔 칸도 없다");
});

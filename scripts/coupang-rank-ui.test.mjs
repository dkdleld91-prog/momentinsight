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

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const adminSource = read("src/pages/admin.html");
const moduleSource = read("public/mi-coupang-rank.js");
const cssSource = read("public/mi-coupang-rank.css");

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/gu;
const NAV_LINK = '<a href="#mi-admin-coupang-rank-tracking" data-mi-admin-screen="coupang-rank-tracking" data-coupang-rank-nav hidden>C 30일 순위</a>';
const PLACE_LINK = '<a href="#mi-admin-naver-place-rank-tracking" data-mi-admin-screen="naver-place-rank-tracking">N 플레이스 30일 순위</a>';
const SECTION_OPEN = '<section class="mi-view" data-mi-admin-view="coupang-rank-tracking" id="mi-admin-coupang-rank-tracking">';
const CSS_LINK = '<link rel="stylesheet" href="/mi-coupang-rank.css?v=c30-v1" />';
const SCRIPT_TAG = '<script src="/mi-coupang-rank.js?v=c30-v1"></script>';
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

test("메뉴 링크는 N 플레이스 링크 바로 뒤에 hidden 으로 하나만 있다", () => {
  assert.equal(adminSource.split(NAV_LINK).length - 1, 1);
  assert.ok(adminSource.includes(`${PLACE_LINK}\n          ${NAV_LINK}\n`));
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
  assert.ok(sectionSource.includes("<h1>쿠팡 30일 순위</h1>"));
  assert.ok(sectionSource.includes('<span class="mi-target-echo" data-mi-target-echo>대상 광고주 확인 중</span>'));
  assert.ok(sectionSource.includes("쿠팡 검색 1쪽에서 광고를 뺀 일반 상품 순위를 하루 단위로 기록합니다."));
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
  assert.ok(glueSource.includes('window.addEventListener("mi:rank-auth-ready", refreshCoupangRankAccess);'));
  assert.ok(glueSource.includes('miFetch("/api/coupang-rank-trackers?view=access", { method: "GET", timeoutMs: 15000 })'));
  assert.ok(glueSource.includes('mode: "admin",'));
  // 운영팀 접근 응답을 기다리는 동안 미리 false 로 되돌리지 않는다(세션 갱신 때 튕김 방지).
  const teamBranch = glueSource.slice(glueSource.indexOf("miFetch(\"/api/coupang-rank-trackers?view=access\""));
  assert.ok(!between(glueSource, "function refreshCoupangRankAccess() {", "miFetch(").includes("coupangRankOpen = false;\n        }\n        coupangRankOpen = false"));
  assert.ok(teamBranch.includes("coupangRankOpen = Boolean(payload && payload.ok === true && payload.open === true);"));
});

test("setScreen 에 rejectedCoupangTarget 3곳과 mount 1줄이 있다", () => {
  assert.ok(setScreenSource.includes('var rejectedCoupangTarget = target === "coupang-rank-tracking" && Boolean(secureSession.role) && !coupangRankMenuVisible();'));
  assert.ok(setScreenSource.includes('if (rejectedNoticeTarget) target = "home";\n        if (rejectedCoupangTarget) target = "home";'));
  assert.ok(setScreenSource.includes("((rejectedOwnerTarget || hasOwnerHashWithoutOwner || rejectedCoupangTarget) && secureSession.role)"));
  assert.equal((setScreenSource.match(/rejectedCoupangTarget/g) || []).length, 3);
  assert.ok(setScreenSource.includes('else unmountPersonalCalendar();\n        if (target === "coupang-rank-tracking") mountCoupangRank();'));
  // 정의는 rejectedNoticeTarget 다음 줄 묶음 안에 있다.
  assert.ok(setScreenSource.indexOf("var rejectedCoupangTarget") > setScreenSource.indexOf("var rejectedNoticeTarget"));
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
    history: { replaceState: (...args) => replaceCalls.push(args) },
    requestAnimationFrame: (fn) => fn(),
    scrollTo() {},
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    MomentCoupangRank: {
      mount(mountHost, deps) {
        mounts.push({ host: mountHost, deps });
        return { show: () => shows.push(true), scopeChanged() {} };
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
  return { context, views, navLink, replaceCalls, mounts, shows, listeners, fetchCalls, window, active };
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

test("운영팀 + 공개 꺼짐이면 setScreen(\"home\") 으로 보내고, 해시로 들어와도 홈으로 돌린다", async () => {
  const harness = screenHarness({ role: "" });
  harness.context.setScreen("coupang-rank-tracking", false);
  harness.context.secureSession.role = "team";
  harness.listeners["mi:rank-auth-ready"][0]();
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, `${COUPANG_TRACKERS_PATH}?view=access`);
  await flushMicrotasks();
  assert.equal(harness.navLink.hidden, true);
  assert.deepEqual(harness.active(), ["home"]);
  assert.equal(harness.mounts.length, 0);
  // 세션이 있는 상태에서 C 해시로 직접 들어오면 거절되고 주소창도 홈으로 바뀐다.
  harness.context.setScreen("coupang-rank-tracking", false);
  assert.deepEqual(harness.active(), ["home"]);
  assert.equal(harness.replaceCalls.length, 1);
  assert.equal(harness.replaceCalls[0][2], "/admin#mi-admin-home");
});

test("운영팀 + 공개 켜짐이면 메뉴가 보이고 C 화면에서 모듈을 붙인다", async () => {
  const harness = screenHarness({ role: "", accessPayload: { ok: true, open: true } });
  harness.context.setScreen("coupang-rank-tracking", false);
  harness.context.secureSession.role = "team";
  harness.listeners["mi:rank-auth-ready"][0]();
  await flushMicrotasks();
  assert.equal(harness.navLink.hidden, false);
  assert.equal(harness.mounts.length, 1);
  assert.equal(harness.mounts[0].deps.isOwner(), false);
  assert.deepEqual(harness.active(), ["coupang-rank-tracking"]);
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
  const document = { activeElement: null, hidden: false };
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

function loadModule({ confirm = () => true, storage = makeStorage(), MutationObserver, clock } = {}) {
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
  const intervals = [];
  const context = vm.createContext({
    window,
    document,
    navigator: {},
    Blob,
    console,
    MutationObserver,
    // 1.5초 재시도·검색 지연은 바로 돌린다. 60초 새로 받기는 기록만 한다.
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    clearTimeout() {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {},
    ...(clock ? { Date: clockDate(clock) } : {}),
  });
  vm.runInContext(moduleSource, context, { filename: "mi-coupang-rank.js" });
  return { window, document, storage, api: window.MomentCoupangRank, intervals, confirmCalls };
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
    trackerFixture({ id: "6c1f0000-0000-4000-8000-000000000002", keyword: "강화유리 필름", groupName: "필름", current: null, summary: { trend: "new", attention: false, attentionReasons: [] }, days: [] }),
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

test("30일 판 칸 글자·툴팁 표 전부(§8.3)", () => {
  const created = "2026-10-10";
  const rows = [
    [{ d: "2026-10-17", s: "found", r: 28, n: 50, a: 8, t: "11:11", c: 1, f: 0, b: 28 }, "28", "11:11 일반 28위 · 광고 8번째 · 하루 1회(실패 0) · 그날 최고 28위"],
    [{ d: "2026-10-16", s: "found", r: 31, n: 50, a: null, t: "19:02", c: 2, f: 1, b: 25 }, "31", "19:02 일반 31위 · 하루 2회(실패 1) · 그날 최고 25위"],
    [{ d: "2026-10-15", s: "out", n: 50 }, "밖", "50위 밖 · 일반 50개 중 1~50위에 없음"],
    [{ d: "2026-10-14", s: "short", n: 23 }, "없음", "일반 23개 중 없음"],
    [{ d: "2026-10-13", s: "noresult" }, "결과없음", "검색 결과 없음"],
    [{ d: "2026-10-12", s: "failed", f: 3 }, "실패", "3회 모두 실패"],
    [{ d: "2026-10-11", s: "unsupported" }, "이동", "쿠팡이 검색 결과가 아닌 쪽으로 보냈습니다"],
  ];
  for (const [cell, text, tooltip] of rows) {
    assert.equal(internals.cellText(cell, cell.d, created), text, cell.s);
    assert.equal(internals.cellTooltip(cell, cell.d, created), tooltip, cell.s);
  }
  // 행 없음 / 등록 전
  assert.equal(internals.cellText(null, "2026-10-12", created), "-");
  assert.equal(internals.cellTooltip(null, "2026-10-12", created), "측정 없음(수집기 꺼짐·시간대 밖·일시중지·쉬는 중)");
  assert.equal(internals.cellText(null, "2026-10-09", created), "");
  assert.equal(internals.cellTooltip(null, "2026-10-09", created), "");
  // 서버 DAY_RESULTS 의 모든 값에 글자가 있다.
  for (const result of DAY_RESULTS) assert.notEqual(internals.cellText({ s: result, r: 1, n: 50, f: 1 }, "2026-10-17", created), "-", result);
  // 날짜 이름은 서버의 d 를 UTC 로 읽어 요일을 구한다.
  assert.equal(internals.dayLabel("2026-10-17"), "10-17(토)");
  assert.equal(internals.dayLabel("2026-10-18"), "10-18(일)");
});

test("현재 배지·추세 문구·다음 예정 4갈래", () => {
  const badge = (current) => internals.currentBadge({ current }).text;
  assert.equal(badge({ result: "found", rank: 28 }), "28위");
  assert.equal(badge({ result: "out", organicCount: 50 }), "50위 밖");
  assert.equal(badge({ result: "short", organicCount: 23 }), "일반 23개 중 없음");
  assert.equal(badge({ result: "noresult" }), "결과 없음");
  assert.equal(badge(null), "측정 전");

  assert.equal(internals.trendText({ trend: "up", trendDelta: 3 }), "▲3");
  assert.equal(internals.trendText({ trend: "down", trendDelta: -5 }), "▼5");
  assert.equal(internals.trendText({ trend: "enter", trendDelta: null }), "진입");
  assert.equal(internals.trendText({ trend: "exit", trendDelta: null }), "이탈");
  assert.equal(internals.trendText({ trend: "same", trendDelta: 0 }), "-");
  assert.equal(internals.trendText({ trend: "new", trendDelta: null }), "-");
  assert.equal(internals.trendText(null), "-");

  const next = (tracker) => internals.nextCheckText(tracker, "2026-10-17");
  assert.equal(next({ nextCheckState: "scheduled", nextCheckAt: "2026-10-17T07:41:00.000Z" }), "16:41");
  assert.equal(next({ nextCheckState: "scheduled", nextCheckAt: "2026-10-17T23:05:00.000Z" }), "10-18 08:05");
  assert.equal(next({ nextCheckState: "due", nextCheckAt: "2026-10-17T01:00:00.000Z" }), "대기 중");
  assert.equal(next({ nextCheckState: "replan", nextCheckAt: null }), "다음 수집 때 정함");
  assert.equal(next({ nextCheckState: "paused", nextCheckAt: null }), "");
});

test("필터: 검색(키워드·상품번호·상품명·그룹)·그룹·상태 버튼", () => {
  const base = trackerFixture();
  const match = (tracker, filter) => internals.filterMatches(tracker, filter);
  assert.equal(match(base, { query: "18프로" }), true);
  assert.equal(match(base, { query: "8533720933" }), true);
  assert.equal(match(base, { query: "아이쉘" }), true);
  assert.equal(match(base, { query: "기본" }), true);
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
  assert.equal(internals.limitText({ used: 3, max: 100, globalUsed: 41, globalMax: 150 }), "사용 3 / 100 · 전체 41 / 150");
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
  assert.deepEqual(JSON.parse(JSON.stringify(internals.settingsPatch(current, { minCollectorVersion: "1.0.1", teamAccessEnabled: true }).patch)), { minCollectorVersion: "1.0.1", teamAccessEnabled: true });
  assert.match(internals.templateText(2), /^쿠팡 순위는 로그인하지 않은 검색 1쪽에서 광고를 뺀 일반 상품 순서입니다\. 하루 2회 측정하고/);
});

// ── 화면 흐름 ─────────────────────────────────────────────────

test("대상이 없으면 '대상 광고주를 먼저 고르세요'만 보이고 요청하지 않는다", async () => {
  const screen = mountWith({ scope: null });
  screen.controller.show();
  await flush();
  assert.ok(screen.host.textContent.includes("대상 광고주를 먼저 고르세요"));
  assert.equal(screen.calls.length, 0);
});

test("목록: 총관리자 머리글·카드·30일 칸·사용 방법·템플릿이 그려지고 캐시가 저장된다", async () => {
  const storage = makeStorage({ "miCoupangRank:v1:owner:other": "{}", "miRankTrackerLastGood:v1:x": "keep" });
  const screen = mountWith({ storage });
  screen.controller.show();
  await flush();
  assert.equal(screen.calls.length, 1);
  assert.equal(screen.calls[0].url, `${COUPANG_TRACKERS_PATH}?limit=500`);
  assert.equal(screen.calls[0].init.method, "GET");
  assert.equal(screen.calls[0].init.timeoutMs, 30000);
  assert.equal(screen.calls[0].init.headers["x-mi-agency-code"], "mml93-a01");
  const cards = screen.host.querySelectorAll("[data-coupang-rank-card]");
  assert.equal(cards.length, 2);
  const card = cards[0];
  assert.ok(card.classList.contains("mi-card") && card.classList.contains("mi-card-pad") && card.classList.contains("mi-rank-card") && card.classList.contains("mi-coupang-rank-card"));
  assert.equal(card.tagName, "ARTICLE");
  const text = card.textContent;
  for (const expected of ["아이폰 18프로 사생활 보호 필름", "상품번호 8533720933", "28위", "30일 최고", "25위", "27.5위(50위 안 2일)", "▲3", "광고 8번째", "16:41", "추적 중"]) {
    assert.ok(text.includes(expected), expected);
  }
  const link = card.querySelector("a");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  const dayCells = card.querySelectorAll(".mi-rank-day-card");
  assert.equal(dayCells.length, 30);
  assert.ok(dayCells[0].classList.contains("is-today") && dayCells[0].textContent.includes("오늘"));
  assert.ok(dayCells[0].classList.contains("is-sat"));
  assert.equal(dayCells[0].getAttribute("title"), "11:11 일반 28위 · 광고 8번째 · 하루 1회(실패 0) · 그날 최고 28위");
  assert.equal(dayCells[2].querySelector(".mi-coupang-rank-cell").textContent, "", "등록 전 칸은 비운다");
  // 측정 전 카드
  assert.ok(cards[1].textContent.includes("측정 전"));
  // 띠·한도·사용 방법·템플릿·그룹 구역
  assert.equal(screen.host.querySelector("[data-coupang-rank-strip]").textContent.includes("정상 · 마지막 수집 11:11 · 하루 2회(08~23시)"), true);
  assert.ok(screen.host.textContent.includes("사용 3 / 100 · 전체 41 / 150"));
  assert.ok(screen.host.textContent.includes("비로그인 검색 1쪽 · 광고 제외 일반 순위 · 같은 상품이면 옵션이 달라도 인정"));
  assert.ok(screen.host.textContent.includes("일반 50위 이내"));
  assert.equal(screen.host.querySelectorAll("[data-coupang-rank-group]").length, 2);
  const guide = screen.host.querySelector("[data-coupang-rank-guide]");
  assert.equal(guide.tagName, "DETAILS");
  assert.equal(guide.open, false);
  assert.equal(guide.querySelectorAll("li").length, 8);
  assert.ok(guide.textContent.includes("하루 2회, 08~23시"));
  assert.equal(screen.host.querySelector("[data-coupang-rank-owner]").hidden, false);
  // 캐시: 같은 접두사의 다른 범위 키는 지우고, N30 캐시는 건드리지 않는다.
  const saved = storage.dump();
  assert.ok(saved["miCoupangRank:v1:owner:mml93-a01"]);
  assert.equal(saved["miCoupangRank:v1:owner:other"], undefined);
  assert.equal(saved["miRankTrackerLastGood:v1:x"], "keep");
  const cached = JSON.parse(saved["miCoupangRank:v1:owner:mml93-a01"]);
  assert.ok(cached.savedAt > 0 && cached.payload.trackers.length === 2);
});

test("복붙 템플릿은 입력란만 채운다(저장 요청 없음)", async () => {
  const screen = mountWith();
  screen.controller.show();
  await flush();
  const before = screen.calls.length;
  dispatch(screen.host.querySelector('[data-coupang-rank-action="template-fill"]'), "click");
  await flush();
  assert.equal(screen.calls.length, before);
  assert.match(screen.host.querySelector("[data-coupang-rank-template-text]").value, /하루 2회 측정하고, 그날 마지막 측정을 기록합니다\. '50위 밖'은/);
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
  assert.equal(screen.host.querySelector("[data-coupang-rank-strip]").textContent.startsWith("정상수집기"), true);
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
  assert.ok(screen.host.textContent.includes("다음 수집 때(수집기가 켜져 있을 때) 첫 순위가 기록됩니다"));
  assert.ok(screen.host.textContent.includes("사용 4 / 100 · 전체 42 / 150"));
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
  const details = screen.host.querySelector("[data-coupang-rank-owner]");
  details.open = true;
  dispatch(details, "toggle");
  await flush();
  assert.ok(screen.calls.some((call) => call.url === `${COUPANG_TRACKERS_PATH}?view=collector` && call.init.headers["x-mi-agency-code"] === "mml93-a01"));
  assert.equal(screen.intervals.length, 1);
  assert.equal(screen.intervals[0].ms, 60000);
  const panelText = details.textContent;
  for (const expected of ["수집 꺼짐", "하루 최대 측정 120회 → 하루 2번이면 키워드 약 60개 · 지금 활성 41개", "연결 해제·해지된 범위의 활성 추적기 2개(수집·한도에서 제외, 다시 연결되면 자동 재개)",
    "윈도우 데스크탑", "끝 4자리 x9Qa", "연결 없음", "제거 뒤 연결 코드도 폐기하세요", "전체 한도를 60으로 맞추기", "윈도우 설치·업데이트(관리자 PowerShell)", "맥 제거(터미널)"]) {
    assert.ok(panelText.includes(expected), expected);
  }
  assert.equal(details.querySelectorAll('[data-coupang-rank-action="line-copy"]').length, 6);
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
  // 운영팀 세션 동기화: mi:rank-scope-changed → scopeChanged, mi:rank-auth-ready → view=access → show
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
  assert.match(host.querySelector("[data-coupang-rank-filter-count]").textContent, /500개 표시 · 받은 500개\(전체 501개\)/);
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
  assert.ok(screen.host.textContent.includes("1개 순위 이미지(JPG)가 준비되었습니다."));
  // 내보내기 시트는 공용 mi-rank-* 클래스와 인라인 style 만 쓴다.
  const sheet = record.serialize[0].sheet;
  assert.equal(sheet.querySelectorAll(".mi-rank-day-card").length, 30);
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

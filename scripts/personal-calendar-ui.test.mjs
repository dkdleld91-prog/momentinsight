// 개인 캘린더 공유 컴포넌트(public/mi-personal-calendar.js) 계약 테스트.
//
// 두 가지를 증명한다.
//  1) 공유 스크립트가 실제로 무엇을 그리고 어디를 부르는가 — 파일을 vm 으로 올려
//     window.MomentPersonalCalendar 에서 값을 직접 읽는다(문자열 추측이 아니다).
//  2) admin.html 업무 운영 화면에서 옮겨 적은 표·로직이 어긋나지 않았는가 —
//     work-calendar-ui.test.mjs 의 색 팔레트 드리프트 테스트와 같은 방식으로
//     admin.html(그리고 서버 표)을 읽어 대조한다.
//
// 네트워크·환경변수·DOM 없이 돌아간다.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { EVENT_COLOR_PALETTE, EVENT_COLOR_DISPLAY_ORDER } from "../src/server/google-calendar-client.mjs";

const sharedSource = fs.readFileSync(new URL("../public/mi-personal-calendar.js", import.meta.url), "utf8");
const sharedStyle = fs.readFileSync(new URL("../public/mi-personal-calendar.css", import.meta.url), "utf8");
const adminSource = fs.readFileSync(new URL("../src/pages/admin.html", import.meta.url), "utf8");
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// 공유 스크립트는 로드 시점에 window 에 붙는 것 말고는 아무 것도 하지 않는다.
// document 없이 올라가는 것 자체가 "마운트 전에는 부작용이 없다" 의 증명이다.
const sandboxWindow = {};
vm.runInNewContext(sharedSource, { window: sandboxWindow });
const shared = sandboxWindow.MomentPersonalCalendar;
const markup = shared.markupHtml();

// vm 이 만든 값은 다른 realm 의 프로토타입을 갖는다. deepEqual 이 구조가 아니라
// 프로토타입 동일성에서 걸리므로, 비교 전에 평범한 값으로 되돌린다.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// 주석은 근거가 아니다. "여기서는 /api/owner/ 를 부르지 않는다" 같은 설명문이
// 금지 문자열을 담고 있으므로, 경로·선택자 판정은 코드만 남기고 한다
// (scripts/check-personal-isolation.mjs 와 같은 원칙).
function stripJsComments(source) {
  let output = "";
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || "";
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }
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
      output += char;
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
    if (char === '"' || char === "'" || char === "`") quote = char;
    output += char;
  }
  return output;
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

const sharedCode = stripJsComments(sharedSource);
const sharedStyleCode = stripCssComments(sharedStyle);

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `기준 문자열을 찾지 못했습니다: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `끝 기준 문자열을 찾지 못했습니다: ${endMarker}`);
  return source.slice(start, end);
}

function labelTable(block) {
  const table = {};
  for (const match of block.matchAll(/(?:^|[\s{,])"?([a-z_-]+)"?\s*:\s*"([^"]*)"/g)) {
    table[match[1]] = match[2];
  }
  return table;
}

function stringArray(source, name) {
  const match = source.match(new RegExp(`var ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `admin.html 에서 ${name} 배열을 찾지 못했습니다.`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map((entry) => entry[1]);
}

const adminEventColorTable = slice(adminSource, "var workEventColors = [", "];");
const adminStatusLabelBlock = slice(adminSource, "function workStatusLabel(value) {", "function workTypeLabel(value) {");
const adminTypeLabelBlock = slice(adminSource, "function workTypeLabel(value) {", "function workItemCanEdit(item) {");
const adminLoginNoticeBlock = slice(adminSource, "function googleLoginNotice(code) {", "async function initOwnerGoogleCalendarBanner(");
const adminScreenRouter = slice(adminSource, "function setScreen(name, shouldPushHash) {", 'root.addEventListener("click"');
const adminGlueBlock = slice(adminSource, "var personalCalendarController = null;", "function setScreen(name, shouldPushHash) {");
const adminInlineScript = adminSource.slice(adminSource.indexOf("<script>\n    (function () {"));
const adminWorkView = slice(
  adminSource,
  '<section class="mi-view mi-work-shell" data-mi-admin-view="work"',
  '<section class="mi-view" data-mi-admin-view="my-calendar"',
);
const adminPersonalView = slice(
  adminSource,
  '<section class="mi-view" data-mi-admin-view="my-calendar"',
  '<section class="mi-view" data-mi-admin-view="client-preview"',
);

// ─────────────────────────────────────────────────────────────
// 1. 공유 스크립트 자체
// ─────────────────────────────────────────────────────────────

test("shared calendar ships as a classic public script with a mount entry point", () => {
  // .mjs 는 check-public-build-security.mjs 의 blockedExtensions 라 배포가 거부된다.
  assert.equal(new URL("../public/mi-personal-calendar.js", import.meta.url).pathname.endsWith(".js"), true);
  assert.equal(/^\s*(?:import|export)\b/m.test(sharedSource), false, "공유 스크립트는 모듈이 아니라 클래식 스크립트여야 합니다.");
  assert.equal(typeof shared.mount, "function");
  assert.equal(typeof shared.markupHtml, "function");
  assert.match(shared.VERSION, /^cal-v\d+-\d{8}$/);
  // seo-evaluation.js 와 같은 방식으로 두 곳에서 참조된다(설계 §6.1).
  assert.ok(adminSource.includes('<script src="/mi-personal-calendar.js?v=' + shared.VERSION + '"></script>'));
  assert.ok(adminSource.includes('<link rel="stylesheet" href="/mi-personal-calendar.css?v=' + shared.VERSION + '" />'));
});

test("mount refuses to run without an injected fetch so the page keeps the auth contract", () => {
  const node = { querySelector() { return null; }, querySelectorAll() { return []; }, innerHTML: "" };
  assert.throws(() => shared.mount(node, { apiBase: "/api/my" }), /fetch/);
  assert.throws(() => shared.mount(null, { apiBase: "/api/my", fetch() {} }), /노드/);
});

test("every request target is /api/my and never the owner surface or the shared work feed", () => {
  assert.ok(sharedSource.includes('var apiBase = String(config.apiBase || "/api/my");'));
  for (const suffix of ["/work-items", "/google-calendar", "/google-login"]) {
    assert.ok(sharedSource.includes(`apiUrl("${suffix}")`), `개인 경로 호출이 없습니다: ${suffix}`);
  }
  for (const forbidden of ["/api/owner/", '"/api/work-items"', "/api/auth/", "/api/admin/"]) {
    assert.equal(sharedCode.includes(forbidden), false, `공유 스크립트가 금지된 경로를 부릅니다: ${forbidden}`);
  }
  // 스스로 fetch 하지 않는다 — 페이지가 주입한 구현만 쓴다(설계 §6.1).
  assert.equal(/[^A-Za-z_$.]fetch\s*\(/.test(sharedCode), false, "공유 스크립트는 자체 fetch 를 호출하면 안 됩니다.");
  assert.equal(sharedCode.includes("XMLHttpRequest"), false);
  assert.equal(sharedCode.includes("window.fetch"), false);
});

test("shared markup renders the rail, the month grid, the agenda and the dialogs itself", () => {
  for (const marker of [
    "data-cal-rail",
    "data-cal-rail-list",
    "data-cal-rail-refresh",
    "data-cal-rail-new",
    "data-cal-acl-panel",
    "data-cal-acl-rules",
    "data-cal-invite-chips",
    "data-cal-agenda",
    "data-cal-agenda-title",
    "data-cal-calendar",
    "data-cal-month-picker",
    "data-cal-month-grid",
    "data-cal-summary-filter",
    "data-cal-modal",
    "data-cal-form",
    "data-cal-recurrence-modal",
    "data-cal-scope-modal",
    "data-cal-move-modal",
    "data-cal-status",
  ]) assert.ok(markup.includes(marker), `공유 마크업에 없는 계약: ${marker}`);

  // 페이지는 컨테이너 한 개만 갖는다 — 마크업 드리프트가 생길 자리를 남기지 않는다.
  assert.ok(adminPersonalView.includes("<div data-mi-personal-calendar></div>"));
  assert.equal(adminPersonalView.includes("data-cal-calendar"), false, "admin.html 이 캘린더 마크업을 복제하면 안 됩니다.");
  assert.equal(adminSource.includes("mi-cal-shell"), false, "공유 컴포넌트의 마크업은 admin.html 에 존재하면 안 됩니다.");
});

test("dialog keeps the google-style contract: all-day default, time, recurrence, attendees, meet, colour", () => {
  // 종일이 기본값이고, "시간 추가" 를 눌러야 시간 칸이 열린다.
  assert.match(markup, /data-cal-all-day checked hidden/);
  assert.match(markup, /data-cal-time-toggle aria-expanded="false">시간 추가</);
  assert.match(markup, /data-cal-start-time-field hidden/);
  assert.ok(sharedSource.includes("var allDay = item ? Boolean(item.isAllDay) : true;"));

  for (const preset of ["none", "daily", "weekly", "monthly_day", "monthly_nth", "yearly", "weekday", "custom"]) {
    assert.ok(markup.includes(`<option value="${preset}"`), `반복 프리셋 누락: ${preset}`);
  }
  assert.ok(markup.includes("맞춤 반복"));
  assert.ok(markup.includes("data-cal-recurrence-interval"));
  assert.ok(markup.includes("data-cal-recurrence-until"));
  assert.ok(markup.includes("data-cal-recurrence-count"));

  assert.ok(markup.includes("data-cal-attendee-input"));
  assert.ok(markup.includes("초대 메일 보내기"));
  assert.ok(markup.includes("data-cal-send-updates"));
  assert.ok(markup.includes("Google Meet 화상 회의 추가"));
  assert.ok(markup.includes("data-cal-location"));
  assert.ok(markup.includes("data-cal-description"));
  assert.ok(markup.includes("data-cal-google-calendar-dot"));
  assert.ok(markup.includes("data-cal-swatches"));

  // 맞춤 반복 창은 편집 폼 안에 떠 있다. Enter 가 폼 제출로 새면 안 된다.
  assert.ok(sharedCode.includes('if (target.closest && target.closest("[data-cal-recurrence-modal]")) {'));
  assert.ok(sharedCode.includes('if (event.key !== "Enter" || target.tagName === "BUTTON") return;'));

  // 반복 범위 확인창은 언제나 "이 일정만" 이 기본이다.
  assert.match(markup, /data-cal-recurrence-scope checked \/><span>이 일정만/);
  assert.ok(markup.includes("<span>모든 일정</span>"));
  assert.ok(sharedSource.includes('scopeMode = mode === "delete" ? "delete" : "save";'));
});

test("google banners carry the connect, sync and needs_reconnect states", () => {
  assert.ok(markup.includes("data-cal-glogin-banner"));
  assert.ok(markup.includes("data-cal-gcal-banner"));
  assert.ok(markup.includes("data-cal-gcal-sync"));
  assert.ok(markup.includes("data-cal-gcal-last"));
  assert.ok(markup.includes(">지금 동기화<"));
  assert.ok(sharedSource.includes('statusCopy.textContent = "구글 연결이 만료되었습니다. 다시 연결해주세요.";'));
  assert.ok(sharedSource.includes('connectButton.textContent = "다시 연결";'));
  assert.ok(sharedSource.includes('gcalState.syncStatus = "needs_reconnect";'));
  // 콜백 알림(gcal / glogin)을 이 화면이 소비하고 주소창에서 지운다.
  assert.ok(sharedSource.includes('pageUrl.searchParams.get("gcal")'));
  assert.ok(sharedSource.includes('pageUrl.searchParams.get("glogin")'));
  assert.ok(sharedSource.includes('pageUrl.searchParams.delete("gcal")'));
  assert.ok(sharedSource.includes('pageUrl.searchParams.delete("glogin")'));
  assert.ok(sharedSource.includes("window.history.replaceState"));
});

test("calendar create and participant management follow the same v1 policy the server enforces", () => {
  // 서버가 광고주에게 calendar-create / calendar-acl 을 막는다(설계 §7.3).
  // 화면은 그 판정을 응답의 canManageCalendars 로 받아 같은 조건으로만 연다.
  assert.ok(sharedSource.includes('var canManageCalendars = role !== "client";'));
  assert.ok(sharedSource.includes('if (typeof state.canManageCalendars === "boolean") canManageCalendars = state.canManageCalendars;'));
  assert.ok(sharedSource.includes("if (newButton) newButton.hidden = !canManageCalendars;"));
  assert.ok(sharedSource.includes("if (!canManageCalendars || railBusy) return;"));
  assert.ok(sharedSource.includes("var manageable = canManageCalendars && Boolean(entry"));
});

test("no inline event handlers survive into the rendered markup", () => {
  // CSP 는 script-src-attr 'none' 이다. on*= 속성이 하나라도 남으면 그 자리는 죽는다.
  assert.equal(/\son[a-z]+\s*=/i.test(markup), false, "인라인 핸들러 속성이 마크업에 남아 있습니다.");
  assert.equal(markup.includes("javascript:"), false);
  assert.equal(sharedSource.includes("innerHTML = markupHtml()") || sharedSource.includes("node.innerHTML = markupHtml();"), true);
});

test("shared stylesheet stays page-agnostic", () => {
  assert.equal(sharedStyleCode.includes("#mi-admin"), false, "공유 CSS 는 페이지 루트에 의존하면 안 됩니다.");
  assert.equal(sharedStyleCode.includes("#mi-client"), false);
  assert.equal(sharedStyleCode.includes("#mi-dashboard"), false);
  assert.match(sharedStyleCode, /\.mi-cal-shell\s*\{/);
  // 좁은 폭에서 레일이 서랍으로 접히고 그리드가 한 줄이 된다(대표님 캘린더와 같은 반응형).
  assert.match(sharedStyle, /@media \(max-width: 1180px\)[\s\S]{0,400}\.mi-cal-body\.has-rail\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(sharedStyle, /@media \(max-width: 760px\)[\s\S]{0,900}\.mi-cal-summary\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
  // TODAY·TOMORROW 띠는 레일과 함께 넓은 화면에서 붙어 따라온다.
  assert.match(sharedStyle, /\.mi-cal-side\s*\{[\s\S]{0,160}position: sticky;/);
});

// ─────────────────────────────────────────────────────────────
// 2. admin.html 통합 (운영팀 전용 화면)
// ─────────────────────────────────────────────────────────────

test("admin exposes 내 캘린더 as the 14th screen, right after 업무 운영", () => {
  assert.ok(adminSource.includes('<a class="mi-nav-personal" hidden href="#mi-admin-my-calendar" data-mi-admin-screen="my-calendar">내 캘린더</a>'));
  const workAt = adminSource.indexOf('data-mi-admin-screen="work">업무 운영</a>');
  const personalAt = adminSource.indexOf('data-mi-admin-screen="my-calendar">내 캘린더</a>');
  const previewAt = adminSource.indexOf('data-mi-admin-screen="client-preview">광고주 미리보기</a>');
  assert.ok(workAt > -1 && personalAt > workAt && previewAt > personalAt, "메뉴 순서: 업무 운영 → 내 캘린더 → 광고주 미리보기");
  assert.ok(adminSource.includes('<section class="mi-view" data-mi-admin-view="my-calendar" id="mi-admin-my-calendar">'));
  // .mi-nav a 가 display:flex 라 [hidden] 만으로는 감춰지지 않는다.
  assert.ok(adminSource.includes("#mi-admin .mi-nav a.mi-nav-personal[hidden]"));
  const screens = [...new Set([...adminSource.matchAll(/data-mi-admin-screen="([^"]+)"/g)].map((entry) => entry[1]))];
  assert.equal(screens.length, 14);
  assert.ok(screens.includes("my-calendar"));
});

test("javascript selectors for the new screen use single-quoted attribute syntax", () => {
  // 기준(check-release-baseline.mjs)이 큰따옴표 리터럴을 세므로, JS 쪽 셀렉터가
  // 화면 개수를 흔들지 않게 작은따옴표 속성 문법을 쓴다.
  const doubleQuoted = [...adminSource.matchAll(/data-mi-admin-screen="my-calendar"/g)].length;
  assert.equal(doubleQuoted, 1, "my-calendar 큰따옴표 리터럴은 마크업 앵커 하나뿐이어야 합니다.");
  assert.ok(adminSource.includes(`root.querySelector("a[data-mi-admin-screen='my-calendar']")`));
  assert.equal(adminInlineScript.includes('data-mi-admin-screen="my-calendar"'), false);
});

test("the screen and its menu belong to operation-team sessions only", () => {
  assert.ok(adminGlueBlock.includes('return secureSession.role === "team";'));
  assert.ok(adminGlueBlock.includes("function personalCalendarEnabled()"));
  assert.ok(adminGlueBlock.includes("function syncPersonalCalendarMenu()"));
  assert.ok(adminGlueBlock.includes("link.hidden = !personalCalendarEnabled();"));
  assert.ok(adminScreenRouter.includes('var rejectedPersonalTarget = target === "my-calendar" && !personalCalendarEnabled();'));
  assert.ok(adminScreenRouter.includes('if (rejectedPersonalTarget) target = "home";'));
  assert.ok(adminScreenRouter.includes("rejectedPersonalTarget ||"), "거절된 개인 화면 해시는 주소창에서 정리돼야 합니다.");
  // 대표실은 그대로 둔다 — 대표님은 P6 전까지 owner-assistant 를 쓴다.
  assert.equal(adminGlueBlock.includes('secureSession.role === "owner"'), false);
});

test("admin glue only mounts, unmounts and routes — the heavy code stays in public/", () => {
  assert.ok(adminScreenRouter.includes('if (target === "my-calendar") mountPersonalCalendar();'));
  assert.ok(adminScreenRouter.includes("else unmountPersonalCalendar();"));
  assert.ok(adminGlueBlock.includes('apiBase: "/api/my",'));
  assert.ok(adminGlueBlock.includes("fetch: miFetch,"));
  assert.ok(adminGlueBlock.includes("role: secureSession.role"));
  assert.ok(adminGlueBlock.includes("window.MomentPersonalCalendar.mount(host, {"));
  assert.ok(adminSource.includes("syncPersonalCalendarMenu();"));
  assert.ok(adminSource.includes("unmountPersonalCalendar();\n        syncPersonalCalendarMenu();"), "로그아웃에서 컴포넌트를 떼야 합니다.");
  // 글루는 짧아야 한다. 길어지면 캘린더 코드가 다시 인라인으로 새어 들어온 것이다.
  assert.ok(adminGlueBlock.split("\n").length < 60, `admin 글루가 너무 큽니다: ${adminGlueBlock.split("\n").length}줄`);
  assert.equal(/data-cal-[a-z-]+/.test(adminGlueBlock), false, "글루가 컴포넌트 내부 선택자를 알면 안 됩니다.");
});

test("team google callbacks land on the personal calendar screen", () => {
  // 팀 콜백은 /admin?gcal=... · /admin?glogin=... 으로 돌아온다(해시 없음).
  assert.ok(adminGlueBlock.includes('pageUrl.searchParams.get("gcal") || pageUrl.searchParams.get("glogin")'));
  assert.ok(adminSource.includes('setScreen(personalCalendarNoticePending() ? "my-calendar" : (teamHasClient ? "agency-code" : "home"), !restored);'));
});

test("the existing 업무 운영 screen is untouched by this component", () => {
  assert.equal(adminWorkView.includes("data-mi-personal-calendar"), false);
  assert.equal(/data-cal-[a-z-]+/.test(adminWorkView), false);
  assert.equal(sharedCode.includes("data-work-"), false, "공유 스크립트가 업무 운영 선택자를 쓰면 안 됩니다.");
  assert.ok(adminSource.includes('<section class="mi-view mi-work-shell" data-mi-admin-view="work" id="mi-admin-work">'));
  assert.ok(adminSource.includes("function renderWorkOperation() {"));
  assert.ok(adminSource.includes("async function loadWorkItems() {"));
});

// ─────────────────────────────────────────────────────────────
// 3. 드리프트 — admin.html · 서버 표와 대조
// ─────────────────────────────────────────────────────────────

test("event colour palette matches the server table and admin.html, entry for entry and in order", () => {
  assert.equal(shared.EVENT_COLORS.length, 11);
  assert.deepEqual(plain(shared.EVENT_COLORS).map((entry) => entry.id), EVENT_COLOR_DISPLAY_ORDER);

  let cursor = 0;
  for (const entry of plain(shared.EVENT_COLORS)) {
    const serverEntry = EVENT_COLOR_PALETTE.find((candidate) => candidate.id === entry.id);
    assert.ok(serverEntry, `서버 팔레트에 없는 colorId: ${entry.id}`);
    assert.equal(entry.hex, serverEntry.modern, `모던 16진값 불일치: ${entry.id}`);
    assert.equal(entry.name, serverEntry.nameKo, `한국어 이름 불일치: ${entry.id}`);
    // admin.html 의 같은 줄이 같은 순서로 있어야 한다.
    const mirrored = `{ id: "${entry.id}", hex: "${entry.hex}", name: "${entry.name}" }`;
    const at = adminEventColorTable.indexOf(mirrored, cursor);
    assert.notEqual(at, -1, `admin.html 과 어긋납니다: ${mirrored}`);
    cursor = at + mirrored.length;
  }

  // 레거시(API) 값은 화면으로 나가면 안 된다.
  for (const entry of EVENT_COLOR_PALETTE) {
    assert.equal(sharedSource.includes(entry.legacy), false, `레거시 16진값이 공유 스크립트로 샜습니다: ${entry.legacy}`);
  }
});

test("status and schedule-type labels match admin.html", () => {
  assert.deepEqual(plain(shared.STATUS_LABELS), labelTable(adminStatusLabelBlock));
  assert.deepEqual(plain(shared.TYPE_LABELS), labelTable(adminTypeLabelBlock));
  assert.equal(shared.statusLabel("needs_check"), "확인 필요");
  assert.equal(shared.statusLabel("nonsense"), "예정");
  assert.equal(shared.typeLabel("meeting"), "미팅");
  assert.equal(shared.typeLabel("nonsense"), "업무");
});

test("google login notice copy matches admin.html word for word", () => {
  assert.deepEqual(plain(shared.LOGIN_NOTICES), labelTable(adminLoginNoticeBlock));
  assert.equal(shared.loginNotice("already-linked"), "이 구글 계정은 이미 다른 계정에 연결되어 있습니다.");
  assert.equal(shared.loginNotice("unknown-code"), "");
  assert.equal(shared.loginNotice("constructor"), "", "프로토타입 키가 안내문으로 새면 안 됩니다.");
});

test("recurrence day tables, attendee limit and email pattern match admin.html", () => {
  assert.deepEqual(plain(shared.RECURRENCE_DAY_CODES), stringArray(adminSource, "workRecurrenceDayCodes"));
  assert.deepEqual(plain(shared.RECURRENCE_DAY_NAMES), stringArray(adminSource, "workRecurrenceDayNames"));
  assert.deepEqual(plain(shared.RECURRENCE_ORDINAL_NAMES), stringArray(adminSource, "workRecurrenceOrdinalNames"));

  const limitMatch = adminSource.match(/var workAttendeeLimit = (\d+);/);
  assert.ok(limitMatch);
  assert.equal(shared.ATTENDEE_LIMIT, Number(limitMatch[1]));

  const patternMatch = adminSource.match(/var workEmailPattern = (\/.+\/);/);
  assert.ok(patternMatch);
  assert.equal(`/${shared.EMAIL_PATTERN.source}/`, patternMatch[1]);
});

test("colour precedence and recurrence parsing behave exactly like the admin implementation", () => {
  // 칠하는 순서: 일정 색 → 캘린더 색 → 중립 기본값. admin.html 과 같은 문장이 있어야 한다.
  assert.match(adminSource, /function workItemColor\(item\) \{\s*return workGcalColor\(item && item\.eventColor\) \|\| workGcalColor\(item && item\.calendarColor\);\s*\}/);
  assert.match(sharedSource, /function itemColor\(item\) \{\s*return gcalColor\(item && item\.eventColor\) \|\| gcalColor\(item && item\.calendarColor\);\s*\}/);
  assert.match(adminSource, /function workItemTextColor\(item\) \{\s*if \(workGcalColor\(item && item\.eventColor\)\) return workGcalColor\(item && item\.eventTextColor\) \|\| "#ffffff";\s*return workGcalColor\(item && item\.calendarTextColor\) \|\| "#ffffff";\s*\}/);
  assert.match(sharedSource, /function itemTextColor\(item\) \{\s*if \(gcalColor\(item && item\.eventColor\)\) return gcalColor\(item && item\.eventTextColor\) \|\| "#ffffff";\s*return gcalColor\(item && item\.calendarTextColor\) \|\| "#ffffff";\s*\}/);

  assert.equal(shared.itemColor({ eventColor: "#d50000", calendarColor: "#039be5" }), "#d50000");
  assert.equal(shared.itemColor({ calendarColor: "#039be5" }), "#039be5");
  assert.equal(shared.itemColor({ eventColor: "red" }), "");
  assert.equal(shared.itemTextColor({ eventColor: "#d50000" }), "#ffffff");
  assert.equal(shared.itemTextColor({ calendarColor: "#039be5", calendarTextColor: "#111111" }), "#111111");

  // 6자리 HEX 만 style 로 나간다.
  assert.equal(shared.gcalColor("#0B8043"), "#0B8043");
  assert.equal(shared.gcalColor("javascript:alert(1)"), "");
  assert.equal(shared.gcalColor("#fff"), "");
  assert.equal(shared.eventColorId("11"), "11");
  assert.equal(shared.eventColorId("99"), "");

  const parsed = plain(shared.parseRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU;INTERVAL=2"]));
  assert.deepEqual(parsed, { FREQ: "WEEKLY", BYDAY: "MO,TU", INTERVAL: "2" });
  assert.equal(shared.parseRecurrence(["EXDATE:20260101"]), null);
  assert.equal(shared.parseRecurrence(null), null);
  // admin.html 의 같은 함수가 같은 규칙을 쓰는지 문자열로 못 박는다.
  assert.ok(adminSource.includes('if (/^RRULE:/i.test(String(list[index] || ""))) {'));
  assert.ok(sharedSource.includes('if (/^RRULE:/i.test(String(list[index] || ""))) {'));
});

test("last-sync copy matches the admin banner wording", () => {
  const now = Date.now();
  assert.equal(shared.syncAgeLabel(""), "동기화 기록 없음");
  assert.equal(shared.syncAgeLabel("not-a-date"), "동기화 기록 없음");
  assert.equal(shared.syncAgeLabel(new Date(now - 5000).toISOString()), "마지막 동기화 방금 전");
  assert.equal(shared.syncAgeLabel(new Date(now - 5 * 60000).toISOString()), "마지막 동기화 5분 전");
  assert.equal(shared.syncAgeLabel(new Date(now - 3 * 3600000).toISOString()), "마지막 동기화 3시간 전");
  for (const copy of ["동기화 기록 없음", "마지막 동기화 방금 전", "마지막 동기화 "]) {
    assert.ok(adminSource.includes(copy), `admin.html 과 문구가 갈렸습니다: ${copy}`);
  }
});

test("escapeHtml closes the same four holes admin.html closes", () => {
  assert.equal(shared.escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(shared.escapeHtml("a & b"), "a &amp; b");
  assert.equal(shared.escapeHtml(null), "");
});

test("date keys stay local-time and round-trip", () => {
  assert.equal(shared.dateKey(new Date(2026, 7, 3)), "2026-08-03");
  assert.equal(shared.dateKey("not-a-date"), "");
  const back = shared.dateFromKey("2026-08-03");
  assert.equal(back.getFullYear(), 2026);
  assert.equal(back.getMonth(), 7);
  assert.equal(back.getDate(), 3);
});

test("this suite is wired into npm test", () => {
  assert.ok(String(packageJson.scripts?.test || "").includes("scripts/personal-calendar-ui.test.mjs"));
  assert.ok(String(packageJson.scripts?.test || "").includes("scripts/work-calendar-ui.test.mjs"));
});

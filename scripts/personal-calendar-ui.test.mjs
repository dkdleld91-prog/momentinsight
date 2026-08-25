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
const clientSource = fs.readFileSync(new URL("../src/pages/client.html", import.meta.url), "utf8");
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
// 정규식 리터럴은 나눗셈과 같은 글자(/)로 시작한다. 값 뒤(식별자 · 숫자 · 닫는
// 괄호)에 오는 / 만 나눗셈이고, 그 밖에는 정규식의 시작이다.
function regexLiteralStarts(tail) {
  const trimmed = tail.replace(/\s+$/, "");
  if (!trimmed) return true;
  const last = trimmed[trimmed.length - 1];
  if (last === ")" || last === "]") return false;
  if (!/[A-Za-z0-9_$]/.test(last)) return true;
  // return / typeof 처럼 뒤에 값이 오는 키워드 다음은 정규식이다.
  return /(?:^|[^A-Za-z0-9_$.])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(trimmed);
}

function stripJsComments(source) {
  let output = "";
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let regexLiteral = false;
  let charClass = false;
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
    // 정규식도 문자열처럼 통째로 건너뛴다. escapeHtml 의 /"/g 처럼 따옴표를 품은
    // 정규식을 문자열 시작으로 오해하면 그 뒤의 주석이 통째로 코드로 남아,
    // "주석은 근거가 아니다" 라는 이 헬퍼의 전제 자체가 뒤집힌다.
    if (regexLiteral) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (charClass) charClass = char !== "]";
      else if (char === "[") charClass = true;
      else if (char === "/") regexLiteral = false;
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
    if (char === "/" && regexLiteralStarts(output.slice(-48))) {
      regexLiteral = true;
      charClass = false;
      output += char;
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
const clientLoginNoticeBlock = slice(clientSource, "function googleLoginNotice(code) {", "function consumeLoginGoogleNotice() {");
// setScreen 안에도 links.forEach 가 있으므로 끝 기준은 클릭 위임 등록까지 붙여 잡는다.
const clientScreenRouter = slice(
  clientSource,
  "function setScreen(name, shouldPushHash) {",
  '      links.forEach(function (link) {\n        link.addEventListener("click", function (event) {',
);
const clientGlueBlock = slice(clientSource, "var personalCalendarController = null;", "function setScreen(name, shouldPushHash) {");
const clientInlineScript = clientSource.slice(clientSource.indexOf("<script>\n    (function () {"));
const clientLegacyScheduleView = slice(
  clientSource,
  '<section class="mi-view" id="mi-schedule" data-mi-view="schedule"',
  '<section class="mi-view" data-mi-view="my-calendar"',
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
  for (const page of [adminSource, clientSource]) {
    assert.ok(page.includes('<script src="/mi-personal-calendar.js?v=' + shared.VERSION + '"></script>'));
    assert.ok(page.includes('<link rel="stylesheet" href="/mi-personal-calendar.css?v=' + shared.VERSION + '" />'));
  }
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
  // 지표 요약은 대표실의 640px 규칙과 같게 2열로 접힌다(한 줄이 아니다).
  assert.match(sharedStyle, /@media \(max-width: 760px\)[\s\S]*?\.mi-cal-summary\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
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
// 2b. client.html 글루 (P5) — 대표 결재(2026-08-25) 반영
//     "기존 MI 공유 일정 개념은 없는 것으로 가정. 광고주 화면의 공개 일정 뷰는
//      개인 캘린더로 대체(레거시 데이터 보존, 신규 공개 경로 없음)."
// ─────────────────────────────────────────────────────────────

test("client exposes 내 캘린더 in both navs, in place of the retired 일정표 entry", () => {
  // 사이드바와 모바일 내비 두 곳 모두에 있어야 한다(client.html 은 메뉴가 두 벌이다).
  const menus = [...clientSource.matchAll(/data-mi-screen="my-calendar">내 캘린더<\/a>/g)];
  assert.equal(menus.length, 2, "사이드바와 모바일 내비 두 곳에 있어야 합니다.");
  assert.ok(clientSource.includes('<a class="mi-nav-personal" hidden href="#mi-my-calendar" data-mi-screen="my-calendar">내 캘린더</a>'));
  const salesAt = clientSource.indexOf('data-mi-screen="sales">매출 현황</a>');
  const personalAt = clientSource.indexOf('data-mi-screen="my-calendar">내 캘린더</a>');
  const agencyAt = clientSource.indexOf('data-mi-screen="agency-code">대행사 연결</a>');
  assert.ok(salesAt > -1 && personalAt > salesAt && agencyAt > personalAt, "메뉴 순서: 매출 현황 → 내 캘린더 → 대행사 연결");
  assert.ok(clientSource.includes('<section class="mi-view" data-mi-view="my-calendar" id="mi-my-calendar">'));
  assert.ok(clientSource.includes("[data-mi-personal-calendar]"));
  // .mi-nav a / .mi-mobile-nav a 가 display:flex 라 [hidden] 만으로는 감춰지지 않는다.
  assert.ok(clientSource.includes("#mi-clean .mi-nav a.mi-nav-personal[hidden]"));
  assert.ok(clientSource.includes("#mi-clean .mi-mobile-nav a.mi-nav-personal[hidden]"));
});

test("client javascript selectors for the new screen use single-quoted attribute syntax", () => {
  // 기준(check-release-baseline.mjs)이 큰따옴표 리터럴을 세므로, JS 쪽 셀렉터가
  // 화면 개수를 흔들지 않게 작은따옴표 속성 문법을 쓴다.
  const doubleQuoted = [...clientSource.matchAll(/data-mi-screen="my-calendar"/g)].length;
  assert.equal(doubleQuoted, 2, "my-calendar 큰따옴표 리터럴은 두 내비의 마크업 앵커뿐이어야 합니다.");
  assert.ok(clientSource.includes(`root.querySelectorAll("a[data-mi-screen='my-calendar']")`));
  assert.equal(clientInlineScript.includes('data-mi-screen="my-calendar"'), false);
});

test("every registered advertiser gets the calendar — the only gate is the client session itself", () => {
  // 대표 지시: 등록된 광고주 전원 즉시 사용. 별도 플래그·화이트리스트를 두지 않는다.
  assert.ok(clientGlueBlock.includes('return secureClientSession.role === "client";'));
  assert.ok(clientGlueBlock.includes("function personalCalendarEnabled()"));
  assert.ok(clientGlueBlock.includes("function syncPersonalCalendarMenu()"));
  assert.ok(clientGlueBlock.includes("link.hidden = !enabled;"));
  assert.equal(/localStorage|flag|allowlist|canary/i.test(clientGlueBlock), false, "광고주 게이트를 새로 만들면 안 됩니다.");
  assert.ok(clientScreenRouter.includes('var rejectedPersonalTarget = target === "my-calendar" && !personalCalendarEnabled();'));
  assert.ok(clientScreenRouter.includes('if (rejectedPersonalTarget) target = "dashboard";'));
  assert.ok(clientScreenRouter.includes("rejectedPersonalTarget)"), "거절된 개인 화면 해시는 주소창에서 정리돼야 합니다.");
});

test("client glue only mounts, unmounts and routes — the heavy code stays in public/", () => {
  assert.ok(clientScreenRouter.includes('if (target === "my-calendar") mountPersonalCalendar();'));
  assert.ok(clientScreenRouter.includes("else unmountPersonalCalendar();"));
  assert.ok(clientGlueBlock.includes('apiBase: "/api/my",'));
  assert.ok(clientGlueBlock.includes("fetch: miFetch,"));
  assert.ok(clientGlueBlock.includes("role: secureClientSession.role"));
  assert.ok(clientGlueBlock.includes("window.MomentPersonalCalendar.mount(host, {"));
  assert.ok(clientSource.includes("syncPersonalCalendarMenu();"));
  assert.ok(clientSource.includes("unmountPersonalCalendar();\n        syncPersonalCalendarMenu();"), "로그아웃에서 컴포넌트를 떼야 합니다.");
  // 글루는 짧아야 한다. 길어지면 캘린더 코드가 다시 인라인으로 새어 들어온 것이다.
  assert.ok(clientGlueBlock.split("\n").length < 60, `client 글루가 너무 큽니다: ${clientGlueBlock.split("\n").length}줄`);
  assert.equal(/data-cal-[a-z-]+/.test(clientGlueBlock), false, "글루가 컴포넌트 내부 선택자를 알면 안 됩니다.");
});

test("client google callbacks land on the personal calendar screen", () => {
  // 광고주 콜백은 /client?gcal=... · /client?glogin=... 으로 돌아온다(해시 없음).
  assert.ok(clientGlueBlock.includes('pageUrl.searchParams.get("gcal") || pageUrl.searchParams.get("glogin")'));
  assert.ok(clientSource.includes('if (personalCalendarNoticePending()) setScreen("my-calendar", false);'));
});

test("the client page calls /api/my only — never the owner surface or the shared work feed", () => {
  // 개인 캘린더가 부르는 경로는 공유 스크립트 안에만 있다. 글루에는 경로가 없어야 한다.
  assert.equal(clientGlueBlock.includes("/api/work-items"), false);
  assert.equal(clientGlueBlock.includes("/api/owner/"), false);
  assert.equal(clientGlueBlock.includes("/api/admin/"), false);
  assert.equal(clientSource.includes("/api/auth/"), false);
  assert.equal(clientSource.includes("/api/owner/"), false);
});

test("the retired 공개 일정 view keeps its markup but loses every entry path", () => {
  // 대표 결재: 레거시 데이터·마크업은 보존하되 신규 공개 경로는 없다.
  assert.ok(clientLegacyScheduleView.includes("운영팀이 공개한 일정과 진행 상태만"), "레거시 뷰 마크업은 남겨 둔다(데이터 보존).");
  assert.ok(clientSource.includes("async function loadClientWorkItems("), "레거시 렌더러도 삭제하지 않는다.");
  assert.equal(/<a\b[^>]*data-mi-screen="schedule"/u.test(clientSource), false, "옛 일정표 메뉴가 남아 있으면 안 됩니다.");
  assert.ok(clientScreenRouter.includes('var retiredScheduleTarget = target === "schedule";'));
  assert.ok(clientScreenRouter.includes('if (retiredScheduleTarget) target = "my-calendar";'));
  // 옛 뷰로 가는 마지막 경로였던 setScreen 안의 지연 로드도 사라졌다.
  assert.equal(clientScreenRouter.includes("loadClientWorkItems"), false);
  assert.equal(clientLegacyScheduleView.includes("data-mi-personal-calendar"), false);
});

test("client login screen offers google sign-in with the same copy as admin", () => {
  assert.ok(clientSource.includes('<button class="mi-button is-ghost" type="button" data-google-login-start>Google 계정으로 로그인</button>'));
  assert.ok(clientSource.includes('<small class="mi-login-google-note">연결해 둔 계정만 로그인됩니다</small>'));
  assert.ok(clientSource.includes('window.location.href = "/api/google-login/start";'));
  assert.ok(clientSource.includes("if (restored !== true) consumeLoginGoogleNotice();"));
  // 역할이 로그인 대상이 아니면 서버가 glogin=not-ready 로 되돌린다 — 문구가 준비돼 있어야 한다.
  assert.deepEqual(labelTable(clientLoginNoticeBlock), labelTable(adminLoginNoticeBlock));
  assert.deepEqual(labelTable(clientLoginNoticeBlock), plain(shared.LOGIN_NOTICES));
  assert.ok(clientLoginNoticeBlock.includes("이 계정은 아직 구글 로그인 대상이 아닙니다."));
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

// ─────────────────────────────────────────────────────────────
// 4. 실장 비서 (P6) — 팀·광고주 공용 패널, 계정별 격리
//    대표실(owner-assistant)의 상호작용을 공유 스크립트로 옮겨 적었다.
//    페이지(admin.html / client.html)는 손대지 않았으므로 CSP 해시도 그대로다.
// ─────────────────────────────────────────────────────────────

const ownerToolApiSource = fs.readFileSync(new URL("../src/server/handlers/owner-tool-api.mjs", import.meta.url), "utf8");
const assistantMarkup = slice(markup, '<article class="mi-cal-panel-card mi-cal-assistant"', "</article>");
const ownerRangeLabelBlock = slice(adminSource, "var OWNER_ASSISTANT_RANGE_LABELS =", "var OWNER_ASSISTANT_WEEKDAYS");
const standbyErrorBlock = slice(sharedSource, "recognition.onerror = function (event) {", "recognition.onend = function () {");

// 대표실 원본(owner-tool-api.mjs)에서 옮겨 적은 문구·좌표를 다시 뽑아 온다.
// 개인 화면은 대표실 디자인의 사본이므로, 원본이 바뀌면 사본이 조용히 갈라진다.
// 아래 블록이 그 갈라짐을 테스트 실패로 드러내는 유일한 장치다.
const ownerAssistantView = slice(ownerToolApiSource, "const assistantViewHtml = String.raw`", "const viewHtml = String.raw`");
const ownerAssistantCss = slice(ownerToolApiSource, "const assistantCss = String.raw`", "const utilityViewHtml = String.raw`");

function ownerMatch(pattern, label) {
  const found = ownerAssistantView.match(pattern);
  assert.ok(found, `대표실 원본에서 ${label} 을(를) 찾지 못했습니다.`);
  return found;
}

const ownerHero = ownerMatch(
  /<div class="mi-assistant-hero-copy"><small>([^<]*)<\/small><h1>([^<]*)<\/h1><p>([^<]*)<\/p><\/div>/u,
  "히어로",
);
const ownerScopeTitle = ownerMatch(/<div class="mi-assistant-scope"><span>([^<]*)<\/span>/u, "스코프 카드")[1];
const ownerOrgHead = ownerMatch(
  /<div class="mi-assistant-panel-head"><div><h2>([^<]*)<\/h2><p>([^<]*)<\/p><\/div>/u,
  "조직 카드 머리말",
);
const ownerOfficeIdleState = ownerMatch(/<strong data-owner-assistant-office-state>([^<]*)<\/strong>/u, "조직도 대기 문구")[1];
const ownerOfficeIdleNote = ownerMatch(
  /<span class="mi-assistant-office-activity"[^>]*>([^<]*)<\/span>/u,
  "조직도 안내 문구",
)[1];
const ownerStations = [...ownerAssistantView.matchAll(
  /<div class="mi-assistant-station is-([a-z]+)"><strong>([^<]*)<\/strong><small>([^<]*)<\/small><\/div>/gu,
)].map((entry) => ({ role: entry[1], name: entry[2], desc: entry[3] }));
const ownerAgents = [...ownerAssistantView.matchAll(
  /data-owner-assistant-role="([a-z]+)" data-home-x="(\d+)" data-home-y="(\d+)" data-mobile-x="(\d+)" data-mobile-y="(\d+)"[^>]*--agent-breathe:([0-9.]+s)"[^>]*aria-label="([^"]*)"><span class="mi-assistant-agent-bubble">([^<]*)<\/span>[\s\S]*?<span class="mi-assistant-agent-body">([^<]*)<\/span>[\s\S]*?<span class="mi-assistant-agent-label"><strong>([^<]*)<\/strong><small>([^<]*)<\/small>/gu,
)].map((entry) => ({
  role: entry[1],
  homeX: entry[2],
  homeY: entry[3],
  mobileX: entry[4],
  mobileY: entry[5],
  breathe: entry[6],
  aria: entry[7],
  bubble: entry[8],
  body: entry[9],
  name: entry[10],
  desc: entry[11],
}));

test("the assistant panel ships every data-cal-assistant hook and sits above the calendar", () => {
  for (const marker of [
    "data-cal-assistant",
    "data-cal-assistant-briefing",
    "data-cal-assistant-agenda",
    "data-cal-assistant-input",
    "data-cal-assistant-send",
    "data-cal-assistant-mic",
    "data-cal-assistant-wake",
    "data-cal-assistant-read",
    "data-cal-assistant-voice-status",
    "data-cal-assistant-status",
    "data-cal-assistant-results",
  ]) assert.ok(assistantMarkup.includes(marker), `실장 비서 마크업에 없는 계약: ${marker}`);

  // 대표실과 같은 차례다: 히어로 → 구글 배너 → 조직 카드 → 지표 요약 →
  // 실장 패널 → (대표실이 업무 화면을 끼워 넣듯) 캘린더.
  const heroAt = markup.indexOf('<header class="mi-cal-hero">');
  const bannerAt = markup.indexOf("data-cal-gcal-banner");
  const loginBannerAt = markup.indexOf("data-cal-glogin-banner");
  const orgAt = markup.indexOf("data-cal-org");
  const summaryAt = markup.indexOf('<div class="mi-cal-summary"');
  const assistantAt = markup.indexOf('<article class="mi-cal-panel-card mi-cal-assistant"');
  const workAt = markup.indexOf('<section class="mi-cal-work">');
  const order = [heroAt, bannerAt, loginBannerAt, orgAt, summaryAt, assistantAt, workAt];
  assert.equal(order.some((at) => at < 0), false, `순서 기준을 찾지 못했습니다: ${order.join(",")}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `대표실과 배치 순서가 다릅니다: ${order.join(",")}`);

  assert.ok(assistantMarkup.includes('aria-label="실장 비서"'));
  // 상태줄 두 개(음성 · 일반)는 읽어 주는 자리다.
  assert.equal([...assistantMarkup.matchAll(/aria-live="polite"/g)].length, 2);
  // 상시 호출 토글은 눌린 상태를 알리고, 계정 태그가 오기 전에는 잠겨 있다.
  assert.ok(assistantMarkup.includes('data-cal-assistant-wake aria-pressed="false" aria-label="실장 상시 호출 켜고 끄기" disabled'));
  for (const hook of ["mic", "read"]) {
    assert.match(assistantMarkup, new RegExp(`data-cal-assistant-${hook} aria-label="[^"]+"`), `아이콘 버튼에 이름이 없습니다: ${hook}`);
  }

  // 페이지는 여전히 컨테이너 한 개만 갖는다 — 마크업이 새어 나가면 CSP 해시가 움직인다.
  assert.equal(adminSource.includes("data-cal-assistant"), false);
  assert.equal(clientSource.includes("data-cal-assistant"), false);
  assert.equal(adminSource.includes("mi-cal-assistant"), false);
  assert.equal(clientSource.includes("mi-cal-assistant"), false);
});

test("the assistant markup carries no inline handler and binds through the unbindable helper", () => {
  assert.equal(/\son[a-z]+\s*=/i.test(assistantMarkup), false, "실장 비서 마크업에 인라인 핸들러가 남아 있습니다.");
  assert.equal(assistantMarkup.includes("javascript:"), false);
  // 버튼은 mount() 안에서 on(...) 으로 묶는다. destroy() 가 같은 목록으로 되돌린다.
  for (const hook of ["send", "mic", "wake", "read"]) {
    assert.ok(sharedSource.includes(`on(${hook}Button, "click"`), `${hook} 버튼이 on(...) 으로 묶이지 않았습니다.`);
  }
  assert.ok(sharedSource.includes('on(input, "input", syncAssistantControls);'));
});

test("the assistant adds exactly one new call target: /api/my/assistant-chat", () => {
  const targets = [...new Set([...sharedCode.matchAll(/apiUrl\("([^"]+)"\)/g)].map((entry) => entry[1]))].sort();
  assert.deepEqual(targets, ["/assistant-chat", "/google-calendar", "/google-login", "/work-items"]);
  // apiBase 를 그대로 물려받는다 — 그래서 /api/my 밖으로 나갈 수 없다.
  assert.ok(sharedSource.includes('doFetch(apiUrl("/assistant-chat")'));
  assert.equal(sharedCode.includes("/api/owner/"), false);
  assert.equal(sharedCode.includes('"/api/work-items"'), false);
  assert.equal(/[^A-Za-z_$.]fetch\s*\(/.test(sharedCode), false, "실장 비서도 자체 fetch 를 부르면 안 됩니다.");
  assert.equal(sharedCode.includes("XMLHttpRequest"), false);
  assert.equal(sharedCode.includes("window.fetch"), false);

  // 대화에 실어 보내는 것은 화면에 보이는 내 행뿐이고, 히스토리는 12개로 잘린다.
  assert.ok(sharedSource.includes("history: assistantChatHistory.slice(-12),"));
  assert.ok(sharedSource.includes("schedule: assistantScheduleSnapshot()"));
  assert.ok(sharedSource.includes("while (assistantChatHistory.length > 12) assistantChatHistory.shift();"));
  assert.ok(sharedSource.includes(".slice(0, 60)"));
  assert.ok(sharedSource.includes('return visibleItems()\n        .filter(function (item) { return item.status !== "done" && item.startsAt; })'));
  // 실패 문구는 서버가 준 message 를 그대로 보여 준다.
  assert.ok(sharedSource.includes('throw new Error(payload && payload.message ? payload.message : "실장 응답에 실패했습니다.");'));
  // 대화가 꺼져 있으면(ready:false) 보내기는 막히지만 브리핑·완료는 계속 돈다.
  assert.ok(sharedSource.includes('return setAssistantStatus("실장 대화 기능이 아직 연결되지 않았습니다.", "warn");'));
  assert.ok(sharedSource.includes("sendButton.disabled = !assistantChatReady && !assistantLocalIntent(text);"));
});

test("the 완료 command goes through requestWorkItems and only after a human confirms", () => {
  assert.ok(sharedSource.includes('requestWorkItems("PATCH", { action: "assistant-complete", id: item.id, expectedUpdatedAt: item.updatedAt })'));
  assert.ok(sharedSource.includes(`window.confirm('"' + (item.title || "제목 없는 업무") + '" 업무를 완료 처리할까요?')`));
  assert.ok(sharedSource.includes("if (!confirmAssistantComplete(target))"));
  assert.ok(sharedSource.includes('payload && payload.unchanged ? "이미 완료된 업무였습니다."'));
  // 0건 · 2건 이상은 안내만 하고 아무 것도 쓰지 않는다(대표실과 같은 문장).
  assert.ok(sharedSource.includes("’와 일치하는 미완료 업무를 찾지 못했습니다."));
  assert.ok(sharedSource.includes("’는 여러 업무와 일치합니다: "));
  assert.ok(sharedSource.includes(". 더 정확한 제목으로 말씀해주세요."));
  for (const copy of ["와 일치하는 미완료 업무를 찾지 못했습니다.", "는 여러 업무와 일치합니다: ", " 업무를 완료 처리할까요?", "이미 완료된 업무였습니다."]) {
    assert.ok(adminSource.includes(copy), `대표실과 문구가 갈렸습니다: ${copy}`);
  }
  // 대상은 이미 불러온 행에서만 고른다 — 새 조회가 없다.
  assert.ok(sharedSource.includes('if (item.status === "done" || !item.id || !item.updatedAt) return false;'));
  assert.ok(sharedSource.includes("title.indexOf(normalizedQuery) !== -1 || normalizedQuery.indexOf(title) !== -1"));
});

test("standby only fires on final recognition and turns itself off when the mic is blocked", () => {
  assert.match(shared.ASSISTANT_WAKE_PATTERN.source, /실장\(\?:님\|아\)\?/);
  assert.equal(shared.ASSISTANT_WAKE_PATTERN.exec(" 실장 오늘 일정 알려줘")[1], "오늘 일정 알려줘");
  // 중간(interim) 결과로는 절대 실행하지 않는다 — 말하는 중에 완료가 먼저 나가면 되돌릴 수 없다.
  assert.ok(sharedSource.includes("var newFinal = finals.slice(processedFinalLength).trim();"));
  assert.ok(sharedSource.includes("if (!newFinal) {"), "중간 인식 결과에서 곧바로 빠져나오는 가드가 없습니다.");
  assert.ok(sharedSource.includes('return setAssistantVoiceStatus("브리핑을 읽는 중에는 새 명령을 받지 않습니다.");'));
  // 마이크가 막히면 상시 대기를 꺼 둔다(안전 기본값 = off).
  assert.ok(standbyErrorBlock.includes('event.error === "not-allowed" || event.error === "service-not-allowed"'));
  assert.ok(standbyErrorBlock.includes("writeStandbyPreference(false);"));
  assert.ok(standbyErrorBlock.includes("stopRecognition();"));
  // 호출어가 없을 때 받는 것은 브리핑·완료 문장뿐이다.
  assert.ok(sharedSource.includes("if (!assistantLocalIntent(newFinal))"));
  assert.ok(sharedSource.includes("return assistantBriefingIntent(text) || Boolean(parseAssistantCompletion(text));"));
});

test("the standby toggle is remembered per account, never under a shared key", () => {
  assert.equal(shared.assistantStandbyKey("0123456789abcdef"), "mi-personal-assistant-standby:0123456789abcdef");
  assert.equal(shared.assistantStandbyKey(""), "", "태그가 없으면 키를 만들지 않는다.");
  assert.equal(shared.assistantStandbyKey(null), "");
  assert.equal(
    sharedSource.includes("mi-owner-assistant-standby"),
    false,
    "대표실 공용 키가 넘어오면 한 브라우저의 두 계정이 서로의 토글을 물려받습니다.",
  );
  assert.ok(sharedSource.includes("var key = assistantStandbyKey(assistantAccountTag);"));
  assert.ok(sharedSource.includes("if (!key) return false;"));
  // 시크릿 모드는 localStorage 접근 자체가 던진다 — 읽기·쓰기 모두 감싼다.
  assert.ok(sharedSource.includes('try { return window.localStorage.getItem(key) === "on"; } catch (error) { return false; }'));
  assert.ok(sharedSource.includes('try { window.localStorage.setItem(key, nextOn ? "on" : "off"); } catch (error) {}'));
  // 태그가 오기 전에는 토글이 잠겨 있고 상시 대기도 켜지지 않는다.
  assert.ok(sharedSource.includes("var enabled = Boolean(SpeechRecognition) && Boolean(assistantAccountTag);"));
  assert.ok(sharedSource.includes("wakeButton.disabled = !enabled;"));
  assert.ok(sharedSource.includes("if (!enabled || wakeMode) return;"));
  // 태그는 GET /api/my/assistant-chat 한 번으로 받는다.
  assert.ok(sharedSource.includes('assistantAccountTag = String(payload.accountTag || "");'));
  assert.ok(sharedSource.includes("assistantChatReady = payload.ready === true;"));
});

test("speech is feature-detected so the panel degrades to text instead of throwing", () => {
  assert.ok(sharedSource.includes("var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;"));
  assert.ok(sharedSource.includes('return Boolean(window.speechSynthesis) && typeof window.SpeechSynthesisUtterance === "function";'));
  assert.ok(sharedSource.includes("if (micButton) micButton.hidden = true;"));
  assert.ok(sharedSource.includes("if (wakeButton) wakeButton.hidden = true;"));
  assert.ok(sharedSource.includes("if (!assistantSpeechSupported() && readButton) readButton.hidden = true;"));
  // 음성 API 는 mount() 안에서만 만진다. 로드 시점에는 window 밖에 없다
  // (이 파일 맨 위에서 document 없는 컨텍스트로 이미 올렸다).
  assert.ok(
    sharedSource.indexOf("var SpeechRecognition = window.SpeechRecognition") > sharedSource.indexOf("function mount(node, options) {"),
    "음성 감지는 mount() 안에 있어야 합니다.",
  );
  assert.doesNotThrow(() => vm.runInNewContext(sharedSource, { window: {} }));
  assert.equal(typeof shared.mount, "function");
  // destroy() 가 인식·읽기·타이머를 모두 되돌린다.
  assert.ok(sharedSource.includes("      stopAssistant();"));
  assert.ok(sharedSource.includes("if (assistantSpeechOwned && window.speechSynthesis) window.speechSynthesis.cancel();"));
  assert.ok(sharedSource.includes("window.clearTimeout(wakeTimer);"));
  assert.ok(sharedSource.includes("if (destroyed) return;"));
});

test("owner-only assistant features never crossed over into the shared panel", () => {
  // 디자인은 대표실을 그대로 옮겼지만 owner 전용 기능·표식은 하나도 넘어오지 않는다.
  // 조직도는 .mi-cal-office 네임스페이스로 다시 썼으므로 원본 선택자는 여전히 금지어다.
  for (const forbidden of ["switchOwnerAssistantScope", "assistant-draft", "goodmorning", "mi-assistant-office", "data-owner-assistant"]) {
    assert.equal(sharedCode.includes(forbidden), false, `대표실 전용 기능이 넘어왔습니다: ${forbidden}`);
  }
  // 제외 사유는 주석으로 남긴다 — "왜 없는가" 가 사라지면 다음 사람이 다시 옮겨 온다.
  for (const noted of ["switchOwnerAssistantScope", "assistant-draft", "mi-assistant-office", "maybeRunOwnerAssistantGoodMorning"]) {
    assert.ok(sharedSource.includes(noted), `제외 사유 주석이 없습니다: ${noted}`);
  }
  // 화면에 찍히는 문구에도 owner 표식이 없어야 한다. 광고주·운영팀이 보는 화면에
  // "owner canary" 나 "mml93-a01 전용" 이 보이면 그 자체가 남의 계정 정보다.
  for (const leak of ["owner canary", "CANARY", "mml93-a01", "총관리자 전용", "광고주 범위", "총관리자 내부 일정"]) {
    assert.equal(markup.includes(leak), false, `owner 전용 문구가 화면에 남았습니다: ${leak}`);
  }
  // 범위 전환·초안 등록은 마크업에도 자리가 없다.
  for (const hook of ["data-cal-scope-switch", "data-cal-assistant-draft", "data-cal-owner"]) {
    assert.equal(markup.includes(hook), false, `대표실 전용 훅이 넘어왔습니다: ${hook}`);
  }
});

// ─────────────────────────────────────────────────────────────
// 4-1. 대표실 디자인 드리프트 — 원본(owner-tool-api.mjs)과 대조
//      개인 화면은 대표실의 사본이다. 사본이라는 사실을 테스트가 붙들지 않으면
//      대표실을 고친 다음 사람이 이 화면이 갈라진 것을 알아차릴 방법이 없다.
// ─────────────────────────────────────────────────────────────

test("hero copy is the 대표실 hero minus the owner canary marker", () => {
  const heroMarkup = slice(markup, '<header class="mi-cal-hero">', "</header>");
  // 아이브로우: 대표실은 "실장 · owner canary" 다. 개인 화면은 그 앞머리만 쓴다.
  assert.equal(shared.ASSISTANT_HERO_EYEBROW, "실장");
  assert.ok(ownerHero[1].startsWith(shared.ASSISTANT_HERO_EYEBROW), `대표실 아이브로우가 바뀌었습니다: ${ownerHero[1]}`);
  assert.equal(ownerHero[1].includes("owner canary"), true, "대표실이 canary 표식을 버렸다면 이 사본도 다시 봐야 합니다.");
  assert.ok(heroMarkup.includes(`<small>${shared.ASSISTANT_HERO_EYEBROW}</small>`));

  // 헤드라인은 글자 하나까지 같다.
  assert.equal(shared.ASSISTANT_HERO_HEADLINE, ownerHero[2]);
  assert.ok(heroMarkup.includes(`<h1>${ownerHero[2]}</h1>`));

  // 부연 문구는 뒷문장만 원본과 같다. 앞문장은 일부러 다르다 — 개인 화면에는
  // 자연어 초안(assistant-draft) 경로가 없어서 "초안으로 정리합니다" 가 거짓말이 된다.
  const ownerTail = ownerHero[3].slice(ownerHero[3].indexOf("확인하기 전에는"));
  assert.ok(ownerTail.startsWith("확인하기 전에는"), `대표실 부연 문구 구조가 바뀌었습니다: ${ownerHero[3]}`);
  assert.ok(shared.ASSISTANT_HERO_SUB.endsWith(ownerTail), "대표실과 안전 문구가 갈렸습니다.");
  assert.equal(shared.ASSISTANT_HERO_SUB.includes("초안"), false, "개인 화면에는 초안 경로가 없습니다.");
});

test("the scope card prints this account's own name and nothing else", () => {
  const heroMarkup = slice(markup, '<header class="mi-cal-hero">', "</header>");
  assert.equal(shared.ASSISTANT_SCOPE_TITLE, ownerScopeTitle);
  assert.ok(heroMarkup.includes(`<span>${ownerScopeTitle}</span>`));
  assert.ok(heroMarkup.includes(`<strong data-cal-scope>${shared.ASSISTANT_SCOPE_FALLBACK}</strong>`));
  // 대표실의 "광고주 범위는 업무 운영에서 선택" 은 owner 전용이라 옮기지 않는다.
  assert.ok(ownerAssistantView.includes("광고주 범위는 업무 운영에서 선택"));
  assert.equal(heroMarkup.includes("광고주 범위"), false);
  assert.ok(heroMarkup.includes(shared.ASSISTANT_SCOPE_NOTE));

  // 이름은 서버가 세션 계정에서 정해 준 값만 쓴다. 화면이 계정을 추측하면 격리 구멍이다.
  assert.ok(sharedSource.includes('if (typeof state.accountLabel === "string" && state.accountLabel) setScopeLabel(state.accountLabel);'));
  assert.ok(sharedCode.includes("function setScopeLabel("));
  const scopeSetter = slice(sharedCode, "function setScopeLabel(", "\n    }");
  assert.ok(scopeSetter.includes("textContent"), "이름은 textContent 로만 찍는다.");
  assert.equal(scopeSetter.includes("innerHTML"), false);
  // 서버가 그 필드를 실제로 실어 보낸다(운영 피드에서는 언제나 빈 문자열).
  const workItemsSource = fs.readFileSync(new URL("../src/server/handlers/work-items.mjs", import.meta.url), "utf8");
  assert.ok(workItemsSource.includes('accountLabel: access.personalKey ? (access.personalLabel || "") : "",'));
});

test("the 비서실 운영실 organization card matches the owner roster station for station", () => {
  assert.equal(shared.ASSISTANT_ORG_TITLE, ownerOrgHead[1]);
  assert.equal(shared.ASSISTANT_ORG_NOTE, ownerOrgHead[2]);
  assert.ok(markup.includes(`<h2>${ownerOrgHead[1]}</h2><p>${ownerOrgHead[2]}</p>`));

  assert.equal(ownerStations.length, 6, "대표실 스테이션이 6개가 아닙니다.");
  // 필드 이름은 이 파일의 것(title/note)이고 값만 대표실에서 온다.
  assert.deepEqual(
    plain(shared.ASSISTANT_STATIONS).map((entry) => ({ role: entry.role, name: entry.title, desc: entry.note })),
    ownerStations,
  );
  for (const station of ownerStations) {
    assert.ok(
      markup.includes(`<div class="mi-cal-station is-${station.role}"><strong>${station.name}</strong><small>${station.desc}</small></div>`),
      `스테이션 마크업이 갈렸습니다: ${station.role}`,
    );
  }

  assert.equal(ownerAgents.length, 6, "대표실 담당 직원이 6명이 아닙니다.");
  assert.deepEqual(
    plain(shared.ASSISTANT_AGENTS).map((entry) => ({
      role: entry.role,
      homeX: String(entry.homeX),
      homeY: String(entry.homeY),
      mobileX: String(entry.mobileX),
      mobileY: String(entry.mobileY),
      breathe: entry.breathe,
      aria: entry.label,
      bubble: entry.bubble,
      body: entry.body,
      name: entry.title,
      desc: entry.note,
    })),
    ownerAgents,
  );
  for (const agent of ownerAgents) {
    assert.ok(
      markup.includes(`data-cal-agent-role="${agent.role}" data-home-x="${agent.homeX}" data-home-y="${agent.homeY}" data-mobile-x="${agent.mobileX}" data-mobile-y="${agent.mobileY}" style="left:${agent.homeX}%;top:${agent.homeY}%;--agent-breathe:${agent.breathe}" aria-label="${agent.aria}"`),
      `담당 직원 좌표·이름이 갈렸습니다: ${agent.role}`,
    );
  }
  assert.equal([...markup.matchAll(/data-cal-agent-role="/g)].length, 6);

  // 대기 문구도 같다. 조직도가 "무엇을 표현하는 그림인지" 를 말해 주는 문장이다.
  assert.equal(shared.ASSISTANT_OFFICE_IDLE_STATE, ownerOfficeIdleState);
  assert.equal(shared.ASSISTANT_OFFICE_IDLE_NOTE, ownerOfficeIdleNote);
  assert.ok(markup.includes(`<strong data-cal-office-state>${ownerOfficeIdleState}</strong>`));
  assert.ok(markup.includes(ownerOfficeIdleNote));
  assert.ok(markup.includes("collaboration hub"));
  assert.ok(markup.includes("MomentLabs operations office"));
});

test("clicking a 담당 loads a command this account can actually run", () => {
  const roles = ownerAgents.map((agent) => agent.role);
  assert.deepEqual(Object.keys(plain(shared.ASSISTANT_ROLE_COMMANDS)).sort(), [...roles].sort());
  // 대표실의 roleTemplates 는 등록형 문장이다. 개인 화면에는 자연어 등록 경로가
  // 없으므로(초안 파서는 대표실 전용) 눌러도 도는 브리핑·완료 문장만 넣는다.
  for (const [role, command] of Object.entries(plain(shared.ASSISTANT_ROLE_COMMANDS))) {
    const runnable = shared.assistantBriefingIntent(command) || Boolean(shared.parseAssistantCompletion(command));
    assert.ok(runnable, `담당 명령 예시가 실제로 동작하지 않습니다: ${role} · ${command}`);
    assert.equal(command.includes("등록"), false, `등록형 예시는 개인 화면에서 아무 일도 하지 않습니다: ${role}`);
  }
  for (const chip of plain(shared.ASSISTANT_EXAMPLE_CHIPS)) {
    const runnable = shared.assistantBriefingIntent(chip.command) || Boolean(shared.parseAssistantCompletion(chip.command));
    assert.ok(runnable, `칩 예시가 실제로 동작하지 않습니다: ${chip.command}`);
    assert.ok(markup.includes(`data-cal-assistant-example="${chip.command}"`));
  }
  assert.equal([...markup.matchAll(/data-cal-assistant-example="/g)].length, 3);
  // 조직도·칩·새로고침은 전부 on(...) 으로 묶여 destroy() 가 되돌린다.
  for (const bound of ['"[data-cal-agent]"', '"[data-cal-assistant-example]"', "[data-cal-assistant-refresh]"]) {
    assert.ok(sharedCode.includes(bound), `묶여야 할 훅을 찾지 못했습니다: ${bound}`);
  }
  assert.ok(sharedCode.includes('on(window, "resize"'), "조직도 리사이즈 감시가 on(...) 밖에 있습니다.");
});

test("the ported stylesheet keeps the 대표실 geometry, value for value", () => {
  // 대표실 CSS 의 숫자가 바뀌면 이 사본은 조용히 다른 화면이 된다. 눈에 띄는
  // 골격 값 몇 개를 원본에서 그대로 뽑아 대조한다(선택자만 네임스페이스가 다르다).
  const pairs = [
    [/\.mi-assistant-hero\{[^}]*border-radius:(\d+px)/u, /\.mi-cal-hero\s*\{[^}]*border-radius:\s*([0-9]+px)/u, "히어로 모서리"],
    [/\.mi-assistant-office\{[^}]*min-height:(\d+px)/u, /\.mi-cal-office\s*\{[^}]*min-height:\s*([0-9]+px)/u, "조직도 높이"],
    [/\.mi-assistant-agent\{[^}]*width:(\d+px)/u, /\.mi-cal-agent\s*\{[^}]*width:\s*([0-9]+px)/u, "직원 폭"],
    [/\.mi-assistant-panel\{[^}]*border-radius:(\d+px)/u, /\.mi-cal-panel-card\s*\{[^}]*border-radius:\s*([0-9]+px)/u, "패널 모서리"],
    [/\.mi-assistant-metric\{[^}]*padding:([^;]+);/u, /\.mi-cal-metric\s*\{[^}]*padding:\s*([^;]+);/u, "지표 여백"],
    [/\.mi-assistant-agenda-item\{[^}]*grid-template-columns:([^;]+);/u, /\.mi-cal-assistant-agenda-item\s*\{[^}]*grid-template-columns:\s*([^;]+);/u, "일정표 칸"],
  ];
  for (const [ownerPattern, sharedPattern, label] of pairs) {
    const ownerValue = ownerAssistantCss.match(ownerPattern);
    assert.ok(ownerValue, `대표실 CSS 에서 ${label} 값을 찾지 못했습니다.`);
    const sharedValue = sharedStyleCode.match(sharedPattern);
    assert.ok(sharedValue, `공유 CSS 에서 ${label} 값을 찾지 못했습니다.`);
    assert.equal(
      sharedValue[1].replace(/\s+/g, " ").trim(),
      ownerValue[1].replace(/,\s*/g, ", ").replace(/\s+/g, " ").trim(),
      `${label} 이 대표실과 갈렸습니다.`,
    );
  }
  // 어두운 조직도 팔레트는 대표실 그대로다(토큰으로 흐려 놓으면 다른 화면이 된다).
  for (const literal of ["#071a35", "#0a2444", "#0d2c50", "#102f55"]) {
    assert.ok(ownerAssistantCss.includes(literal), `대표실 팔레트가 바뀌었습니다: ${literal}`);
    assert.ok(sharedStyleCode.includes(literal), `조직도 팔레트가 갈렸습니다: ${literal}`);
  }
  // 다만 그 어두운 색은 .mi-cal-assistant* 규칙 밖에만 산다(공용 토큰 규칙 유지).
  assert.equal(/\.mi-cal-assistant[^{]*\{[^}]*#0[0-9a-f]{5}/i.test(sharedStyleCode), false);
});

test("assistant range labels, weekdays and command regexes match the owner and server copies", () => {
  assert.deepEqual(plain(shared.ASSISTANT_RANGE_LABELS), labelTable(ownerRangeLabelBlock));
  assert.deepEqual(plain(shared.ASSISTANT_WEEKDAYS), stringArray(adminSource, "OWNER_ASSISTANT_WEEKDAYS"));

  const ownerIntent = adminSource.match(/var OWNER_ASSISTANT_BRIEFING_INTENT = (\/.+\/)u;/);
  assert.ok(ownerIntent, "admin.html 에서 브리핑 의도 정규식을 찾지 못했습니다.");
  assert.equal(`/${shared.ASSISTANT_BRIEFING_INTENT.source}/`, ownerIntent[1]);

  // 개인 빌드에는 서버 초안 파서가 없다. 완료 명령 해석이 브라우저로 내려왔으므로
  // 원본(owner-tool-api.mjs)과 정규식이 갈리면 같은 말이 화면마다 다르게 먹힌다.
  const serverCompletion = ownerToolApiSource.match(/const ASSISTANT_COMPLETION_PATTERN = (\/.+\/)u;/);
  assert.ok(serverCompletion, "서버에서 완료 명령 정규식을 찾지 못했습니다.");
  assert.equal(`/${shared.ASSISTANT_COMPLETION_PATTERN.source}/`, serverCompletion[1]);
});

test("assistant command parsing behaves like the owner and the server parser", () => {
  assert.equal(shared.parseAssistantBriefingRange("다음 주 일정 알려줘"), "next_week");
  assert.equal(shared.parseAssistantBriefingRange("모레"), "day_after");
  assert.equal(shared.parseAssistantBriefingRange("내일 일정"), "tomorrow");
  assert.equal(shared.parseAssistantBriefingRange("이번 주 일정"), "this_week");
  assert.equal(shared.parseAssistantBriefingRange("다가오는 일정"), "upcoming");
  assert.equal(shared.parseAssistantBriefingRange("아무 말"), "today");
  assert.equal(shared.assistantBriefingIntent("오늘 일정 알려줘"), true);
  assert.equal(shared.assistantBriefingIntent("브리핑"), true);
  assert.equal(shared.assistantBriefingIntent("내일 회의 준비"), false);

  assert.equal(shared.parseAssistantCompletion("광고주 미팅 완료로 해줘"), "광고주 미팅");
  assert.equal(shared.parseAssistantCompletion("완료해줘"), "");
  assert.equal(shared.parseAssistantCompletion("내일 회의 준비"), "");

  // 브리핑 문장은 넘겨받은 행(=화면에 보이는 내 일정)에서만 만든다.
  assert.equal(shared.buildAssistantBriefingSpeech("today", []).text, "오늘 일정이 없습니다.");
  assert.equal(shared.buildAssistantBriefingSpeech("next_week", []).text, "다음 주 일정이 없습니다.");
  const at = new Date();
  at.setHours(14, 0, 0, 0);
  const spoken = shared.buildAssistantBriefingSpeech("today", [{ title: "광고주 미팅", startsAt: at.toISOString(), status: "planned" }]);
  assert.equal(spoken.label, "오늘");
  assert.match(spoken.text, /^오늘 일정은 .+ 광고주 미팅입니다\.$/);
  assert.ok(spoken.text.includes("오후 2시"));
  // 완료된 행은 브리핑에서 빠진다.
  assert.equal(
    shared.buildAssistantBriefingSpeech("today", [{ title: "끝난 일", startsAt: at.toISOString(), status: "done" }]).text,
    "오늘 일정이 없습니다.",
  );
});

test("the assistant stylesheet stays inside the shared tokens and folds on narrow screens", () => {
  assert.match(sharedStyleCode, /\.mi-cal-assistant\s*\{/);
  assert.equal(/\.mi-cal-assistant[^{]*\{[^}]*#0[0-9a-f]{5}/i.test(sharedStyleCode), false, "패널은 토큰 밖의 색을 직접 쓰면 안 됩니다.");
  for (const token of ["--mi-cal-shadow", "--mi-cal-line", "--mi-cal-accent", "--mi-cal-muted", "--mi-cal-soft"]) {
    assert.ok(sharedStyleCode.includes(token));
  }
  assert.equal(sharedStyleCode.includes("#mi-admin"), false);
  assert.equal(sharedStyleCode.includes("#mi-client"), false);
  // 지표는 이제 대표실처럼 패널 밖 요약 줄이다(.mi-cal-assistant-metrics 는 사라졌다).
  assert.equal(sharedStyleCode.includes(".mi-cal-assistant-metrics"), false);
  assert.match(sharedStyle, /@media \(max-width: 1180px\)[\s\S]*?\.mi-cal-assistant-grid\s*\{\s*grid-template-columns: 1fr;/);
  assert.match(sharedStyle, /@media \(max-width: 760px\)[\s\S]*\.mi-cal-assistant-actions\s*\{\s*[\s\S]{0,60}flex-direction: column;/);
  // 조직도 애니메이션은 접근성 설정에서 완전히 멈춘다(대표실 425행과 같은 계약).
  assert.match(sharedStyle, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.mi-cal-agent[\s\S]*?animation: none/);
});

test("this suite is wired into npm test", () => {
  assert.ok(String(packageJson.scripts?.test || "").includes("scripts/personal-calendar-ui.test.mjs"));
  assert.ok(String(packageJson.scripts?.test || "").includes("scripts/work-calendar-ui.test.mjs"));
});

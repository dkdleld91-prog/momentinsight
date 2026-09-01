import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { EVENT_COLOR_PALETTE, EVENT_COLOR_DISPLAY_ORDER } from "../src/server/google-calendar-client.mjs";

const source = fs.readFileSync(new URL("../src/pages/admin.html", import.meta.url), "utf8");
const workViewStart = source.indexOf('<section class="mi-view mi-work-shell"');
const editorStart = source.indexOf('<div class="mi-work-modal" data-work-modal', workViewStart);
const moveDialogStart = source.indexOf('<div class="mi-work-modal" data-work-move-modal', editorStart);
const workViewMarkup = source.slice(workViewStart, editorStart);
const editorMarkup = source.slice(editorStart, moveDialogStart);
const formPayloadSource = source.slice(
  source.indexOf("function workFormPayload() {"),
  source.indexOf("function workDropDayFromPoint(")
);
const openDialogSource = source.slice(
  source.indexOf("function openWorkDialog(item, dateKey) {"),
  source.indexOf("function closeWorkDialog() {")
);
const submitHandlerSource = source.slice(
  source.indexOf('workForm.addEventListener("submit"'),
  source.indexOf('var workDelete = root.querySelector("[data-work-delete]");')
);
const deleteHandlerSource = source.slice(
  source.indexOf('var workDelete = root.querySelector("[data-work-delete]");'),
  source.indexOf('var workOwnerClientInput = root.querySelector("[data-work-owner-client-code]");')
);
const syncHandlerSource = source.slice(
  source.indexOf("async function maybeSyncGoogleCalendar(trigger) {"),
  source.indexOf("async function initOwnerGoogleLoginBanner(view, generation) {")
);
// 반복 범위 확인창은 편집 다이얼로그 바깥의 독립 모달이다.
const scopeModalStart = source.indexOf('<div class="mi-work-modal" data-work-scope-modal');
const scopeModalMarkup = source.slice(scopeModalStart, source.indexOf("</section>", scopeModalStart));
const scopeModalSource = source.slice(
  source.indexOf("function openWorkScopeModal(mode) {"),
  source.indexOf("function workFormPayload() {")
);
const scopeListenerSource = source.slice(
  source.indexOf('var workScopeModalNode = root.querySelector("[data-work-scope-modal]");'),
  source.indexOf('var workGoogleCalendarSelect = root.querySelector("[data-work-google-calendar]");')
);
// 데스크톱(레일이 살아 있는 폭) 규칙과 좁은 폭 규칙을 갈라서 본다.
const narrowMediaStart = source.indexOf("@media (max-width: 1180px)");
const mobileMediaStart = source.indexOf("@media (max-width: 760px)", narrowMediaStart);
const railContextCss = source.slice(0, narrowMediaStart);
const narrowMediaCss = source.slice(narrowMediaStart, mobileMediaStart);
const mobileMediaCss = source.slice(mobileMediaStart);

test("representative schedule is a wide personal calendar without list or sharing controls", () => {
  assert.ok(workViewStart >= 0 && editorStart > workViewStart, "representative schedule markup must exist");
  // 달력이 한 줄을 다 쓰고, 아젠다는 그 아래 가로 띠로 내려갔다.
  assert.match(source, /#mi-admin \.mi-work-layout\s*\{[\s\S]{0,180}grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]{0,100}align-items:\s*start/);
  assert.match(source, /@media \(max-width: 1180px\)\s*\{\s*#mi-admin \.mi-work-body\.has-gcal-rail\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]{0,320}#mi-admin \.mi-work-gcal-rail\s*\{\s*position:\s*static;\s*display:\s*none;/);

  for (const marker of [
    "mi-work-calendar-rail",
    "data-work-calendar-list",
    "data-work-calendar-create",
    "data-work-calendar-filter",
    "data-work-calendar-color",
    "data-work-calendar-grant",
    "data-work-calendar-share",
    "data-work-calendar-invite-code",
    "data-work-calendar-join",
    "data-work-calendar-leave"
  ]) assert.equal(workViewMarkup.includes(marker), false, `personal schedule must not render: ${marker}`);
});

test("month title opens an accessible year and month picker", () => {
  assert.match(workViewMarkup, /<button[^>]+data-work-month-picker-trigger[^>]+aria-haspopup="dialog"[^>]+aria-expanded="false"[^>]*>\s*<span data-work-month-label>/);
  assert.match(workViewMarkup, /data-work-month-picker[^>]+role="dialog"[^>]+aria-label="이동할 월 선택"[^>]+hidden/);
  assert.match(workViewMarkup, /data-work-month-picker-year/);
  assert.match(workViewMarkup, /data-work-picker-year-prev[^>]+aria-label="이전 연도"/);
  assert.match(workViewMarkup, /data-work-picker-year-next[^>]+aria-label="다음 연도"/);
  assert.match(workViewMarkup, /data-work-month-grid/);
});

test("month picker renders twelve months and reloads the selected calendar month", () => {
  assert.match(source, /var workMonthPickerYear = workMonthCursor\.getFullYear\(\)/);
  assert.match(source, /function renderWorkMonthPicker\(\)[\s\S]{0,1200}for \(var month = 0; month < 12; month \+= 1\)[\s\S]{0,500}data-work-picker-month/);
  assert.match(source, /function openWorkMonthPicker\(\)[\s\S]{0,900}aria-expanded[\s\S]{0,500}focus\(\)/);
  assert.match(source, /function closeWorkMonthPicker\(restoreFocus\)[\s\S]{0,700}aria-expanded[\s\S]{0,350}restoreFocus/);
  assert.match(source, /data-work-month-picker-trigger[\s\S]{0,1000}openWorkMonthPicker\(\)/);
  assert.match(source, /data-work-picker-year-prev[\s\S]{0,900}workMonthPickerYear \+=/);
  assert.match(source, /data-work-picker-month[\s\S]{0,1000}workMonthCursor = new Date\(workMonthPickerYear, selectedMonth, 1\)[\s\S]{0,500}loadWorkItems\(\)/);
  assert.match(source, /event\.key !== "Escape"[\s\S]{0,240}closeWorkMonthPicker\(true\)/);
  assert.match(source, /window\.addEventListener\("focusin"[\s\S]{0,500}!navigation\.contains\(event\.target\)[\s\S]{0,120}closeWorkMonthPicker\(false\)/);
});

test("date and create clicks open the personal editor while preserving existing work fields", () => {
  assert.ok(editorStart >= 0 && moveDialogStart > editorStart, "work editor markup must exist");
  assert.match(workViewMarkup, /data-work-create>일정 추가<\/button>/);
  assert.match(source, /aria-label="' \+ key \+ ' 일정 추가"/);
  for (const marker of [
    "data-work-title",
    "data-work-start",
    "data-work-state",
    "data-work-all-day",
    "data-work-repeat-monthly",
    "data-work-repeat-no-end",
    "data-work-repeat-until",
    "data-work-type",
    "data-work-end",
    "data-work-assignee",
    "data-work-priority",
    "data-work-internal",
    "반복 종료일 · 포함"
  ]) assert.ok(editorMarkup.includes(marker), `missing personal editor contract: ${marker}`);

  for (const marker of [
    "data-work-calendar-select",
    "data-work-calendar-color",
    "data-work-calendar-grant",
    "data-work-calendar-share",
    "data-work-calendar-invite-code",
    "data-work-calendar-join",
    "data-work-calendar-leave"
  ]) assert.equal(editorMarkup.includes(marker), false, `personal editor must not render: ${marker}`);

  assert.match(editorMarkup, /data-work-dialog-title>개인 일정 등록</);
  assert.match(source, /var create = event\.target\.closest\("\[data-work-create\]"\);[\s\S]{0,180}openWorkDialog\(null, ""\)/);
  assert.match(source, /var dateButton = event\.target\.closest\("\[data-work-date\]"\);[\s\S]{0,180}openWorkDialog\(null, dateButton\.getAttribute\("data-work-date"\)\)/);
  assert.match(source, /var dateCell = event\.target\.closest\("\[data-work-cell-date\]"\);[\s\S]{0,220}openWorkDialog\(null, dateCell\.getAttribute\("data-work-cell-date"\)\)/);
  assert.match(formPayloadSource, /calendarId:\s*""/);

  // 미연동(구글 캘린더 목록이 빈) 사용자는 기존 매월 반복 키를 그대로 보낸다.
  assert.match(formPayloadSource, /var repeatMonthly = Boolean\(repeatToggle && repeatToggle\.checked && !id && !workGoogleConnected\(\)\)/);
  assert.match(formPayloadSource, /payload\.repeat = repeatMonthly \? "monthly" : ""/);
  assert.match(formPayloadSource, /payload\.repeatNoEnd = repeatMonthly && repeatNoEnd/);
  assert.match(formPayloadSource, /payload\.repeatUntil = repeatMonthly && !repeatNoEnd/);
  assert.match(formPayloadSource, /payload\.requestId = !id && repeatMonthly \? workRepeatRequestId/);
  assert.match(source, /!id\s*&&\s*repeatMonthly\s*&&\s*!workRepeatRequestId[\s\S]{0,100}crypto\.randomUUID\(\)/);
  assert.match(formPayloadSource, /expectedUpdatedAt/);
  assert.match(source, /var body = \{ id: id, expectedUpdatedAt: expectedUpdatedAt \};[\s\S]{0,200}requestWorkItems\("DELETE", body\)/);
  assert.match(source, /\.mi-work-modal\[data-work-modal\][\s\S]{0,220}justify-items:\s*end/);
  assert.match(source, /@media \(max-width: 760px\)[\s\S]*\.mi-work-editor-dialog/);
});

test("schedule and task tabs render with the task tab disabled until google tasks ship", () => {
  assert.match(editorMarkup, /<button[^>]+data-work-kind-tab="event"[^>]*>일정<\/button>/);
  assert.match(editorMarkup, /<button[^>]+data-work-kind-tab="task"[^>]*>할 일<\/button>/);
  const taskTab = editorMarkup.slice(editorMarkup.indexOf('data-work-kind-tab="task"') - 200, editorMarkup.indexOf("할 일</button>"));
  assert.match(taskTab, /aria-disabled="true"/);
  assert.match(taskTab, /\sdisabled/);
  assert.match(taskTab, /title="다음 단계: 구글 할 일 연동 후"/);
  assert.match(editorMarkup, /data-work-task-note>다음 단계: 구글 할 일 연동 후<\/small>/);
  // 클릭은 아무 동작도 하지 않는다 (인라인 핸들러 없이 위임 핸들러에서 즉시 반환).
  assert.match(source, /var kindTab = event\.target\.closest\("\[data-work-kind-tab\]"\);\s*\n\s*if \(kindTab\) return;/);
});

test("all day is the default and 시간 추가 reveals start and end time inputs", () => {
  assert.match(editorMarkup, /<input[^>]+type="checkbox"[^>]*data-work-all-day[^>]*checked[^>]*hidden/);
  assert.match(editorMarkup, /<input class="mi-input" type="date" data-work-start required/);
  assert.match(editorMarkup, /<input class="mi-input" type="date" data-work-end/);
  assert.match(editorMarkup, /data-work-start-time-field hidden[\s\S]{0,160}type="time" data-work-start-time/);
  assert.match(editorMarkup, /data-work-end-time-field hidden[\s\S]{0,160}type="time" data-work-end-time/);
  assert.match(editorMarkup, /<button[^>]+data-work-time-toggle[^>]+aria-expanded="false"[^>]*>시간 추가<\/button>/);
  assert.match(source, /function syncWorkTimeFields\(\)[\s\S]{0,900}button\.textContent = timed \? "종일" : "시간 추가"/);
  assert.match(source, /var timeToggle = event\.target\.closest\("\[data-work-time-toggle\]"\);[\s\S]{0,320}allDayState\.checked = !allDayState\.checked;[\s\S]{0,80}syncWorkTimeFields\(\)/);
  assert.match(openDialogSource, /var allDay = item \? Boolean\(item\.isAllDay\) : true;/);
  assert.match(formPayloadSource, /startsAt: startDate \? \(allDay \? startDate : startDate \+ "T" \+ startTime\) : ""/);
  assert.match(formPayloadSource, /endsAt: endDate \? \(allDay \? endDate : endDate \+ "T" \+ endTime\) : ""/);
});

test("recurrence editor covers google presets, a custom rule builder, and the legacy no planned end path", () => {
  for (const value of ["none", "daily", "weekly", "monthly_day", "monthly_nth", "yearly", "weekday", "custom"]) {
    assert.match(editorMarkup, new RegExp(`<option value="${value}"`), `missing recurrence preset: ${value}`);
  }
  assert.match(editorMarkup, /data-work-recurrence-preset/);
  assert.match(editorMarkup, /반복 안함<\/option>/);
  assert.match(editorMarkup, /주중 매일\(월~금\)<\/option>/);
  assert.match(editorMarkup, /맞춤…<\/option>/);
  assert.match(editorMarkup, /data-work-recurrence-custom[^>]*hidden/);
  assert.match(editorMarkup, /type="number"[^>]*data-work-recurrence-interval/);
  assert.match(editorMarkup, /data-work-recurrence-unit[\s\S]{0,320}<option value="DAILY">일<\/option>[\s\S]{0,200}<option value="YEARLY">년<\/option>/);
  assert.match(editorMarkup, /data-work-recurrence-days[\s\S]{0,900}data-work-recurrence-day="MO"/);
  assert.match(editorMarkup, /data-work-recurrence-end[\s\S]{0,260}<option value="never">없음<\/option>[\s\S]{0,120}<option value="until">날짜<\/option>[\s\S]{0,120}<option value="count">횟수<\/option>/);
  assert.match(editorMarkup, /data-work-recurrence-until-field[^>]*hidden/);
  assert.match(editorMarkup, /data-work-recurrence-count-field[^>]*hidden/);

  // 프리셋 라벨은 선택한 시작 날짜에서 다시 만든다.
  assert.match(source, /if \(weekly\) weekly\.textContent = "매주 " \+ dayName \+ "요일"/);
  assert.match(source, /if \(monthlyDay\) monthlyDay\.textContent = "매월 " \+ date\.getDate\(\) \+ "일"/);
  assert.match(source, /if \(monthlyNth\) monthlyNth\.textContent = "매월 " \+ ordinal \+ " " \+ dayName \+ "요일"/);

  // RRULE 조립.
  assert.match(source, /if \(preset === "daily"\) return "RRULE:FREQ=DAILY"/);
  assert.match(source, /if \(preset === "weekly"\) return "RRULE:FREQ=WEEKLY;BYDAY=" \+ day/);
  assert.match(source, /if \(preset === "monthly_day"\) return "RRULE:FREQ=MONTHLY;BYMONTHDAY=" \+ date\.getDate\(\)/);
  assert.match(source, /if \(preset === "monthly_nth"\) return "RRULE:FREQ=MONTHLY;BYDAY=" \+ \(Math\.floor\(\(date\.getDate\(\) - 1\) \/ 7\) \+ 1\) \+ day/);
  assert.match(source, /if \(preset === "yearly"\) return "RRULE:FREQ=YEARLY"/);
  assert.match(source, /if \(preset === "weekday"\) return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"/);
  assert.match(source, /if \(interval > 1\) rule \+= ";INTERVAL=" \+ interval/);
  assert.match(source, /rule \+= ";COUNT=" \+ count/);
  assert.match(source, /return raw\.replace\(\/-\/g, ""\) \+ "T145959Z"/);
  assert.match(source, /function workRecurrenceRules\(\)[\s\S]{0,200}return rule \? \[rule\] : \[\]/);

  // 반복 인스턴스 수정 범위. 라디오는 다이얼로그 안이 아니라 확인창에 있다.
  assert.match(editorMarkup, /data-work-recurrence-summary/);
  assert.equal(editorMarkup.includes('name="mi-work-recurrence-scope"'), false, "범위 선택은 다이얼로그가 아니라 확인창에 있다");
  assert.match(scopeModalMarkup, /data-work-recurrence-scope[^>]*checked[\s\S]{0,60}이 일정만/);
  assert.match(scopeModalMarkup, /value="all" data-work-recurrence-scope[\s\S]{0,60}모든 일정/);
  assert.match(formPayloadSource, /payload\.recurrenceScope = scopeChoice && scopeChoice\.value === "all" \? "all" : "instance"/);

  // 기존 로컬 매월 반복(미연동 사용자)은 종료 예정 없음 경로까지 그대로 남는다.
  assert.match(editorMarkup, /<strong>종료 예정 없음<\/strong>/);
  assert.match(editorMarkup, /향후 60회[^<]*우선 생성/);
  assert.match(editorMarkup, /data-work-repeat-fields[^>]+aria-live="polite"/);
  assert.match(editorMarkup, /data-work-legacy-repeat/);
  assert.match(source, /function syncWorkRepeatFields\(\)[\s\S]{0,1400}noEnd\.disabled\s*=\s*Boolean\(id\)[\s\S]{0,500}until\.disabled\s*=\s*Boolean\(id\)\s*\|\|\s*!toggle\.checked\s*\|\|\s*noEnd\.checked[\s\S]{0,300}until\.required\s*=\s*!id\s*&&\s*toggle\.checked\s*&&\s*!noEnd\.checked/);
  assert.match(source, /repeatNoEndToggle\.addEventListener\("change"[\s\S]{0,400}until\.value\s*=\s*""[\s\S]{0,300}syncWorkRepeatFields\(\)/);
  assert.match(source, /payload\.repeat\s*===\s*"monthly"\s*&&\s*!payload\.repeatNoEnd[\s\S]{0,220}!payload\.repeatUntil/);
});

test("attendee chips validate emails and the invite mail toggle drives sendUpdates", () => {
  assert.match(editorMarkup, /data-work-expand="attendees"[^>]*aria-expanded="false"/);
  assert.match(editorMarkup, /참석자 추가<\/span>/);
  assert.match(editorMarkup, /data-work-attendee-chips/);
  assert.match(editorMarkup, /data-work-attendee-input/);
  assert.match(editorMarkup, /data-work-attendee-error[^>]*role="alert"[^>]*hidden/);
  assert.match(editorMarkup, /초대 메일 보내기<\/strong>/);
  assert.match(editorMarkup, /<input type="checkbox" data-work-send-updates checked \/>/);
  assert.match(source, /var workAttendeeLimit = 50;/);
  assert.match(source, /if \(event\.key !== "Enter" && event\.key !== "," && event\.key !== ";"\) return;/);
  assert.match(source, /workAttendeeInput\.addEventListener\("blur"[\s\S]{0,140}commitWorkAttendeeInput\(\)/);
  assert.match(source, /if \(!workEmailPattern\.test\(text\)\)[\s\S]{0,140}setWorkAttendeeError\("이메일 형식이 올바르지 않습니다: " \+ text\)/);
  assert.match(source, /if \(workAttendeeDraft\.length >= workAttendeeLimit\)/);
  assert.match(source, /data-work-attendee-remove="/);
  assert.match(formPayloadSource, /payload\.sendUpdates = sendUpdatesToggle && sendUpdatesToggle\.checked \? "all" : "none"/);
});

test("meet, location, description, and calendar selection follow google progressive disclosure", () => {
  assert.match(editorMarkup, /Google Meet 화상 회의 추가<\/strong>/);
  assert.match(editorMarkup, /<input type="checkbox" data-work-conference \/>/);
  assert.match(editorMarkup, /data-work-conference-link[^>]*hidden[\s\S]{0,200}target="_blank" rel="noopener" data-work-conference-url/);
  assert.match(openDialogSource, /if \(conferenceLink\) conferenceLink\.hidden = !conferenceUri/);
  assert.match(openDialogSource, /if \(conferenceWrap\) conferenceWrap\.hidden = !workGoogleConnected\(\) \|\| Boolean\(conferenceUri\)/);

  assert.match(editorMarkup, /data-work-expand="location"[^>]*aria-expanded="false"/);
  assert.match(editorMarkup, /위치 추가<\/span>/);
  assert.match(editorMarkup, /data-work-panel="location"[^>]*hidden[\s\S]{0,200}data-work-location maxlength="500"/);
  assert.match(editorMarkup, /data-work-expand="description"[^>]*aria-expanded="false"/);
  assert.match(editorMarkup, /설명 추가<\/span>/);
  assert.match(editorMarkup, /data-work-panel="description"[^>]*hidden[\s\S]{0,240}data-work-description maxlength="4000"/);
  assert.match(source, /function setWorkDisclosure\(name, expanded\)[\s\S]{0,420}button\.setAttribute\("aria-expanded", expanded \? "true" : "false"\)/);
  assert.match(source, /var disclosure = event\.target\.closest\("\[data-work-expand\]"\);/);
  assert.match(openDialogSource, /setWorkDisclosure\("location", Boolean\(item && String\(item\.location \|\| ""\)\.trim\(\)\)\)/);
  assert.match(openDialogSource, /setWorkDisclosure\("description", Boolean\(item && String\(item\.description \|\| ""\)\.trim\(\)\)\)/);

  assert.match(editorMarkup, /data-work-google-calendar-field hidden[\s\S]{0,140}<select class="mi-select" data-work-google-calendar><\/select>/);
  assert.match(source, /function workDefaultGoogleCalendarId\(\)[\s\S]{0,520}if \(calendar\.dedicated\) return String\(calendar\.id \|\| ""\)/);
  assert.match(source, /\(calendar\.dedicated \? "모먼트 인사이트" : id\)/);
  assert.match(source, /if \(!workGoogleConnected\(\)\)[\s\S]{0,120}field\.hidden = true/);
  assert.match(source, /workGoogleCalendars = Array\.isArray\(payload\.googleCalendars\) \? payload\.googleCalendars : \[\]/);
});

test("edit mode restores description, location, attendees, meet, calendar and recurrence", () => {
  assert.match(openDialogSource, /setValue\("\[data-work-location\]", item && item\.location \|\| ""\)/);
  assert.match(openDialogSource, /setValue\("\[data-work-description\]", item && item\.description \|\| ""\)/);
  assert.match(openDialogSource, /var attendees = item && Array\.isArray\(item\.attendees\) \? item\.attendees : \[\]/);
  assert.match(openDialogSource, /renderWorkGoogleCalendarOptions\(item && item\.googleCalendarId \|\| ""\)/);
  assert.match(openDialogSource, /workDialogRecurringInstance = Boolean\(item && item\.isRecurringInstance\)/);
  assert.match(openDialogSource, /summary\.textContent = String\(item && item\.recurrenceSummary \|\| ""\)\.trim\(\)/);
  assert.match(openDialogSource, /applyWorkRecurrence\(item\)/);
  assert.match(source, /function applyWorkRecurrence\(item\)[\s\S]{0,600}workParseRecurrence\(item && item\.recurrence\)/);
});

test("work form payload emits every google calendar contract key only for connected owners", () => {
  for (const key of [
    /id: id,/,
    /title: value\("\[data-work-title\]"\)/,
    /scheduleType: value\("\[data-work-type\]"\)/,
    /status: value\("\[data-work-state\]"\)/,
    /priority: value\("\[data-work-priority\]"\)/,
    /startsAt:/,
    /endsAt:/,
    /assigneeName: value\("\[data-work-assignee\]"\)/,
    /internalNote: value\("\[data-work-internal\]"\)/,
    /calendarId: ""/,
    /expectedUpdatedAt: value\("\[data-work-updated-at\]"\)/,
    /isAllDay: allDay/,
    /isClientVisible:/,
    /publicTitle: value\("\[data-work-public-title\]"\)/,
    /publicComment: value\("\[data-work-public-comment\]"\)/,
    /payload\.allDay = allDay/,
    /payload\.recurrence = workRecurrenceRules\(\)/,
    /payload\.attendees = workAttendeeDraft\.map/,
    /payload\.sendUpdates =/,
    /payload\.conference =/,
    /payload\.location = value\("\[data-work-location\]"\)/,
    /payload\.description = value\("\[data-work-description\]"\)/,
    /payload\.googleCalendarId = value\("\[data-work-google-calendar\]"\)/,
    /payload\.recurrenceScope =/
  ]) assert.match(formPayloadSource, key);

  // 새 키는 구글 연동 분기에서만 나가고, 미연동 분기는 legacy 키만 보낸다.
  const googleBranch = formPayloadSource.slice(formPayloadSource.indexOf("if (workGoogleConnected()) {"));
  assert.match(googleBranch, /payload\.googleCalendarId/);
  const legacyBranch = formPayloadSource.slice(formPayloadSource.indexOf("payload.repeat = repeatMonthly"));
  for (const forbidden of ["payload.recurrence", "payload.attendees", "payload.sendUpdates", "payload.conference", "payload.googleCalendarId"]) {
    assert.equal(legacyBranch.includes(forbidden), false, `legacy branch must not send: ${forbidden}`);
  }
  assert.equal(formPayloadSource.includes("payload.repeat = repeatMonthly"), true);
  assert.match(source, /function workGoogleConnected\(\)[\s\S]{0,140}return workGoogleCalendars\.length > 0/);
});

test("google write failure keeps the editor open so the owner can retry", () => {
  assert.match(source, /failure\.status = response\.status;/);
  assert.match(source, /failure\.code = payload && payload\.code \? String\(payload\.code\) : "";/);
  const catchBlock = submitHandlerSource.slice(submitHandlerSource.indexOf("} catch (error) {"));
  assert.match(catchBlock, /error\.status === 502/);
  assert.match(catchBlock, /google_write_failed/);
  assert.match(catchBlock, /needs_reconnect/);
  assert.match(catchBlock, /setWorkStatus\(error\.message \|\| "업무를 저장하지 못했습니다\.", "warn"\)/);
  assert.equal(catchBlock.includes("closeWorkDialog()"), false, "502 must not close the dialog");
  assert.equal(catchBlock.includes("loadWorkItems()"), false, "502 must not reload the calendar");
});

// 삭제 실패는 다이얼로그를 닫지 않고 서버 사유를 그 자리에 띄워야 한다.
// 뒤쪽 상태줄은 오버레이에 가리므로 다이얼로그 안 상태줄이 반드시 있어야 한다.
test("a failed delete keeps the editor open and surfaces the server message inside the dialog", () => {
  assert.ok(deleteHandlerSource.length > 0, "delete handler must exist");
  assert.match(deleteHandlerSource, /var body = \{ id: id, expectedUpdatedAt: expectedUpdatedAt \};/);
  assert.match(deleteHandlerSource, /await requestWorkItems\("DELETE", body\)/);
  const catchBlock = deleteHandlerSource.slice(deleteHandlerSource.indexOf("} catch (error) {"));
  assert.match(catchBlock, /setWorkStatus\(error\.message \|\| "업무를 삭제하지 못했습니다\.", "warn"\)/);
  assert.equal(catchBlock.includes("closeWorkDialog()"), false, "삭제 실패는 다이얼로그를 닫지 않는다");
  assert.equal(catchBlock.includes("loadWorkItems()"), false, "삭제 실패는 목록을 다시 읽지 않는다");
  assert.match(editorMarkup, /data-work-dialog-status[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(source, /function setWorkDialogStatus\(message, state\)/);
  assert.match(source, /function setWorkStatus\(message, state\)[\s\S]{0,480}if \(modal && !modal\.hidden\) setWorkDialogStatus\(message, state\)/);
  assert.match(source, /function closeWorkDialog\(\)[\s\S]{0,200}setWorkDialogStatus\(""/);
});

// 구글은 반복 일정을 고칠 때 "이 일정 / 모든 일정" 을 묻는다. MI 도 저장·삭제
// 순간에 같은 것을 묻고, 확인을 누르기 전에는 아무것도 보내지 않아야 한다.
test("a recurring row asks 이 일정만/모든 일정 before it saves or deletes", () => {
  assert.ok(scopeModalStart > 0, "반복 범위 확인창이 있어야 한다");
  assert.match(scopeModalMarkup, /role="alertdialog"[^>]*aria-modal="true"/);
  assert.match(scopeModalMarkup, /data-work-scope-title>반복 일정 수정</);
  assert.match(scopeModalMarkup, /data-work-scope-cancel[^>]*>취소</);
  assert.match(scopeModalMarkup, /data-work-scope-confirm>확인</);
  // 인라인 핸들러 금지(CSP). 확인창의 동작은 전부 addEventListener 로 붙는다.
  assert.equal(/\son(?:click|change|submit)=/u.test(scopeModalMarkup), false, "인라인 이벤트 핸들러 금지");

  // 제목·설명은 저장/삭제에 따라 갈린다.
  assert.match(scopeModalSource, /title\.textContent = workScopeMode === "delete" \? "반복 일정 삭제" : "반복 일정 수정"/);
  // 기본값은 언제나 "이 일정만" 이다 — 앞선 선택이 남지 않는다.
  assert.match(scopeModalSource, /var instance = root\.querySelector\('\[data-work-recurrence-scope\]\[value="instance"\]'\);[\s\S]{0,80}instance\.checked = true/);
  assert.match(scopeModalSource, /function workScopeValue\(\)[\s\S]{0,220}return choice && choice\.value === "all" \? "all" : "instance"/);

  // 반복 인스턴스일 때만 창이 뜨고, 그전에는 요청이 나가지 않는다.
  assert.match(submitHandlerSource, /if \(payload\.id && workDialogRecurringInstance && openWorkScopeModal\("save"\)\) return;/);
  assert.match(deleteHandlerSource, /if \(workDialogRecurringInstance && openWorkScopeModal\("delete"\)\) return;/);
  // 반복이 아니면 예전 경로 그대로다(확인 프롬프트 → 바로 삭제).
  assert.match(deleteHandlerSource, /if \(!window\.confirm\("이 업무를 삭제할까요\?"\)\) return;[\s\S]{0,60}performWorkDelete\(\);/);
  assert.match(deleteHandlerSource, /if \(workDialogRecurringInstance\) body\.recurrenceScope = workScopeValue\(\);/);

  // 취소는 아무것도 보내지 않고 창만 닫는다. 확인만이 실제 요청으로 이어진다.
  assert.match(scopeListenerSource, /data-work-scope-cancel[\s\S]{0,80}closeWorkScopeModal\(\);[\s\S]{0,40}return;/);
  assert.equal(/data-work-scope-cancel[\s\S]{0,200}requestWorkItems/u.test(scopeListenerSource), false, "취소는 요청을 보내지 않는다");
  assert.match(scopeListenerSource, /if \(mode === "delete"\) performWorkDelete\(\);[\s\S]{0,80}else if \(mode === "save"\) submitWorkForm\(\);/);
  assert.match(scopeListenerSource, /if \(event\.key !== "Escape"\) return;[\s\S]{0,200}closeWorkScopeModal\(\)/);
  // 확인창이 떠 있으면 포커스는 그 안에 갇힌다.
  assert.match(source, /var openScopeModal = root\.querySelector\("\[data-work-scope-modal\]"\);[\s\S]{0,120}editorModal = openScopeModal/);
});

// push 만 일어난 동기화도 DB 의 updated_at 을 올린다. 그때 목록을 다시 읽지 않으면
// 화면이 낡은 updated_at 을 들고 있게 되어 삭제·수정이 서버에서 어긋난다.
test("a push-only google sync reloads the calendar so the cached updated_at never goes stale", () => {
  assert.ok(syncHandlerSource.length > 0, "google sync handler must exist");
  assert.match(syncHandlerSource, /var syncTouchedRows = Number\(outcome\.changed\) > 0 \|\| Number\(outcome\.pushed\) > 0;/);
  assert.match(syncHandlerSource, /outcome\.ok === true && outcome\.throttled !== true && syncTouchedRows\) loadWorkItems\(\)/);
});

test("agenda rows keep the title, time and google chip while gaining one compact detail line", () => {
  assert.match(source, /function workAgendaMetaLine\(item\)[\s\S]{0,900}참석자 " \+ attendees \+ "명"/);
  assert.match(source, /if \(item\.conferenceUri\) parts\.push\("Meet"\)/);
  assert.match(source, /if \(calendarName\) parts\.push\(calendarName\)/);
  assert.match(source, /if \(recurrenceSummary\) parts\.push\(recurrenceSummary\)/);
  assert.match(source, /'<small class="mi-work-agenda-meta">' \+ escapeHtml\(parts\.join\(" · "\)\) \+ "<\/small>"/);
  assert.match(source, /escapeHtml\(workStatusLabel\(item\.status\)\) \+ '<\/span>' \+ workAgendaMetaLine\(item\) \+ '<\/button>/);
  assert.match(source, /function workGoogleChip\(item\)[\s\S]{0,420}data-work-google-link/);
});

test("dialog stays csp safe with no inline event handlers", () => {
  assert.equal(/\son(?:click|change|input|submit|focus|blur|keydown|keyup)\s*=/i.test(editorMarkup), false, "editor markup must not use inline handlers");
  assert.equal(/\son(?:click|change|input|submit|focus|blur|keydown|keyup)\s*=/i.test(workViewMarkup), false, "work view markup must not use inline handlers");
});

test("calendar loading is date-bounded and month navigation reloads server data", () => {
  assert.match(source, /fromDate\.setDate\(1 - fromDate\.getDay\(\)\)/);
  assert.match(source, /toDate\.setDate\(toDate\.getDate\(\) \+ 41\)/);
  assert.match(source, /params\.set\("limit", "300"\)/);
  assert.match(source, /payload\.truncated[\s\S]{0,220}일정이 많아/);
  assert.match(source, /requestWorkItems\("GET", null, workItemsQuery\(\)\)/);
  assert.match(source, /data-work-month-next[\s\S]{0,900}loadWorkItems\(\)/);
});

test("overflow events open the date agenda and editor focus is restored", () => {
  assert.ok(source.includes("data-work-date-overflow"));
  assert.match(source, /workAgendaDateKey/);
  assert.match(source, /workDialogReturnFocus/);
  assert.match(source, /event\.key === "Tab"/);
});

// 구글 캘린더 목록(왼쪽 레일). 표시/숨김은 서버 카탈로그를 그대로 따라가고,
// 체크를 다시 켜면 서버가 빼두었던 행을 다시 읽어와야 화면과 브리핑이 어긋나지 않는다.
const railRenderSource = source.slice(
  source.indexOf("function workGcalGroupHtml(groupKey, title, entries) {"),
  source.indexOf("function renderWorkOperation() {")
);
const calendarVisibilitySource = source.slice(
  source.indexOf("async function toggleWorkCalendarVisibility(calendarId) {"),
  source.indexOf("async function refreshWorkCalendarCatalog(button) {")
);
const calendarRefreshSource = source.slice(
  source.indexOf("async function refreshWorkCalendarCatalog(button) {"),
  source.indexOf("function syncWorkPublicFields() {")
);
const assistantSnapshotSource = source.slice(
  source.indexOf("function ownerAssistantScheduleSnapshot() {"),
  source.indexOf("function speakOwnerAssistantText(text) {")
);
const briefingSpeechSource = source.slice(
  source.indexOf("function buildOwnerAssistantBriefingSpeech(rangeKey) {"),
  source.indexOf("function matchOwnerAssistantCompletionTargets(query) {")
);
const briefingRenderSource = source.slice(
  source.indexOf("function renderOwnerAssistantBriefing(view) {"),
  source.indexOf("function bindOwnerAssistant(view, generation) {")
);

test("the google calendar rail lists every calendar without reintroducing the shared-calendar controls", () => {
  assert.ok(railRenderSource.length > 0, "rail renderer must exist");

  // 레일 골격은 업무 화면 마크업에 정적으로 있어야 한다(빈 카탈로그면 hidden).
  assert.match(workViewMarkup, /<div class="mi-work-body" data-work-gcal-body>/);
  assert.match(workViewMarkup, /<aside class="mi-work-gcal-rail" id="mi-work-gcal-rail" data-work-gcal-rail hidden aria-label="캘린더 목록">/);
  assert.match(workViewMarkup, /data-work-gcal-refresh aria-label="구글 캘린더 목록 새로고침"/);
  assert.match(workViewMarkup, /<div class="mi-work-gcal-list" data-work-gcal-list><\/div>/);
  assert.match(workViewMarkup, /data-work-gcal-drawer aria-expanded="false" aria-controls="mi-work-gcal-rail" hidden/);
  // 레일은 기존 7fr/3fr 레이아웃을 감싸는 바깥 그리드로만 붙는다.
  assert.ok(workViewMarkup.indexOf('<div class="mi-work-body"') < workViewMarkup.indexOf('<div class="mi-work-layout">'));

  // 행과 그룹 머리글은 레일 렌더러가 만든다.
  assert.match(railRenderSource, /data-work-gcal-group="' \+ escapeHtml\(groupKey\)/);
  assert.match(railRenderSource, /<span class="mi-work-gcal-chevron" aria-hidden="true">⌄<\/span>/);
  assert.match(railRenderSource, /class="mi-work-gcal-item" role="checkbox" aria-checked="' \+ \(checked \? "true" : "false"\)/);
  assert.match(railRenderSource, /data-work-gcal-toggle="' \+ escapeHtml\(id\)/);
  assert.match(railRenderSource, /style="--mi-gcal-color:' \+ color/);
  assert.match(railRenderSource, /<span class="mi-work-gcal-box" aria-hidden="true"><\/span>/);
  assert.match(railRenderSource, /entry\.writable === false \? '<span class="mi-work-gcal-tag">읽기 전용<\/span>'/);
  assert.match(railRenderSource, /workGcalGroupHtml\("own", "내 캘린더", own\) \+ workGcalGroupHtml\("other", "다른 캘린더", other\)/);
  assert.match(railRenderSource, /\.sort\(function \(a, b\)[\s\S]{0,120}primary === true \? 1 : 0/);
  assert.match(railRenderSource, /rail\.hidden = true/);

  // 서버가 준 색상은 6자리 HEX 만 통과시킨다.
  assert.match(source, /function workGcalColor\(value\)[\s\S]{0,240}\/\^#\[0-9a-fA-F\]\{6\}\$\/\.test\(color\) \? color : ""/);

  // 잠긴 레이아웃 규칙과 새 바깥 그리드 CSS.
  assert.match(source, /#mi-admin \.mi-work-body \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(source, /#mi-admin \.mi-work-body\.has-gcal-rail \{\s*grid-template-columns: minmax\(0, 300px\) minmax\(0, 1fr\);/);
  assert.match(source, /#mi-admin \.mi-work-gcal-item\[aria-checked="true"\] \.mi-work-gcal-box \{/);

  // 공유 캘린더 UI 는 여전히 없다.
  for (const marker of [
    "mi-work-calendar-rail",
    "data-work-calendar-list",
    "data-work-calendar-create",
    "data-work-calendar-filter",
    "data-work-calendar-color",
    "data-work-calendar-grant",
    "data-work-calendar-share",
    "data-work-calendar-invite-code",
    "data-work-calendar-join",
    "data-work-calendar-leave",
    "data-work-calendar-select"
  ]) {
    assert.equal(workViewMarkup.includes(marker), false, `calendar rail must not reintroduce: ${marker}`);
    assert.equal(editorMarkup.includes(marker), false, `personal editor must not reintroduce: ${marker}`);
  }
});

test("hidden calendars drop out of the grid, the agenda, the counters and the 실장 브리핑", () => {
  assert.match(source, /function workItemCalendarVisible\(item\)[\s\S]{0,320}entry\.visible !== false/);
  assert.match(source, /function visibleWorkItems\(\)[\s\S]{0,160}workItems\.filter\(function \(item\) \{ return workItemCalendarVisible\(item\); \}\)/);
  assert.match(source, /function filteredWorkItems\(\)[\s\S]{0,220}workItemMatchesFilter\(item, workActiveFilter\) && workItemCalendarVisible\(item\)/);
  assert.match(source, /function renderWorkSummary\(\)[\s\S]{0,120}var summaryItems = visibleWorkItems\(\);/);
  assert.match(source, /workCalendarCatalog = Array\.isArray\(payload\.googleCalendarCatalog\) \? payload\.googleCalendarCatalog : \[\]/);
  assert.match(source, /function renderWorkOperation\(\)[\s\S]{0,200}renderWorkGcalRail\(\)/);

  assert.match(assistantSnapshotSource, /return visibleWorkItems\(\)/);
  assert.equal(assistantSnapshotSource.includes("return workItems"), false, "브리핑 스냅샷은 숨긴 캘린더를 읽지 않는다");
  assert.match(briefingSpeechSource, /var items = visibleWorkItems\(\)\.filter\(/);
  assert.match(briefingRenderSource, /var openItems = visibleWorkItems\(\)\.filter\(function \(item\) \{ return item\.status !== "done"; \}\)/);
});

test("toggling a calendar posts calendar-visibility and reloads the rows the server had filtered out", () => {
  assert.ok(calendarVisibilitySource.length > 0, "visibility handler must exist");
  assert.match(source, /var gcalToggle = event\.target\.closest\("\[data-work-gcal-toggle\]"\);[\s\S]{0,200}toggleWorkCalendarVisibility\(gcalToggle\.getAttribute\("data-work-gcal-toggle"\) \|\| ""\)/);
  assert.match(source, /var gcalGroup = event\.target\.closest\("\[data-work-gcal-group\]"\);[\s\S]{0,520}setAttribute\("aria-expanded"/);
  assert.match(source, /var gcalRefresh = event\.target\.closest\("\[data-work-gcal-refresh\]"\);[\s\S]{0,160}refreshWorkCalendarCatalog\(gcalRefresh\)/);
  assert.match(source, /var gcalDrawer = event\.target\.closest\("\[data-work-gcal-drawer\]"\);[\s\S]{0,320}classList\.toggle\("is-gcal-open"\)/);

  assert.match(calendarVisibilitySource, /secureSession\.role !== "owner" \|\| workGcalBusy\) return/);
  assert.match(calendarVisibilitySource, /miFetch\(getOwnerGoogleCalendarApiUrl\(\)/);
  assert.match(calendarVisibilitySource, /action: "calendar-visibility", calendarId: id, visible: nextVisible/);
  assert.match(calendarVisibilitySource, /readApiPayload\(response/);
  assert.match(calendarVisibilitySource, /if \(Array\.isArray\(payload\.calendars\)\) workCalendarCatalog = payload\.calendars;[\s\S]{0,220}await loadWorkItems\(\)/);
  const revert = calendarVisibilitySource.slice(calendarVisibilitySource.indexOf("} catch (error) {"));
  assert.match(revert, /workCalendarCatalog = previousCatalog;/);
  assert.match(revert, /renderWorkOperation\(\)/);
  assert.match(revert, /setWorkStatus\(error\.message \|\| "캘린더 표시 설정을 저장하지 못했습니다\.", "warn"\)/);

  assert.match(calendarRefreshSource, /action: "calendar-refresh"/);
  assert.match(calendarRefreshSource, /if \(button\) button\.disabled = true;/);
  assert.match(calendarRefreshSource, /workCalendarCatalog = Array\.isArray\(payload\.calendars\) \? payload\.calendars : \[\][\s\S]{0,260}await loadWorkItems\(\)/);
});

test("calendar colour and read-only state reach the chips, the agenda line and the editor", () => {
  assert.match(source, /var chipColor = workItemColor\(item\);[\s\S]{0,420}\(chipColor \? ' data-gcal="1" style="--mi-gcal-color:' \+ chipColor \+ '"' : ""\)/);
  assert.match(source, /var rowColor = workItemColor\(item\);[\s\S]{0,420}\(rowColor \? ' data-gcal="1" style="--mi-gcal-color:' \+ rowColor \+ '"' : ""\)/);
  assert.match(source, /#mi-admin \.mi-work-day-item\[data-gcal="1"\] \{\s*border-left: 3px solid var\(--mi-gcal-color/);
  assert.match(source, /#mi-admin \.mi-work-agenda-item\[data-gcal="1"\] > i \{\s*background: var\(--mi-gcal-color/);
  assert.match(source, /if \(calendarName\) parts\.push\(calendarName\)[\s\S]{0,160}if \(item\.readOnly\) parts\.push\("읽기 전용"\)/);

  assert.match(editorMarkup, /data-work-gcal-readonly hidden><\/p>/);
  assert.match(openDialogSource, /var calendarReadOnly = Boolean\(item && item\.readOnly === true\)/);
  assert.match(openDialogSource, /noteParts\.push\("캘린더 · " \+ calendarLabel\)/);
  assert.match(openDialogSource, /var readOnly = Boolean\(item && \(!workItemCanEdit\(item\) \|\| calendarReadOnly\)\)/);
  assert.match(openDialogSource, /if \(save\) \{\s*save\.hidden = readOnly;\s*save\.disabled = readOnly;/);
  assert.match(openDialogSource, /if \(remove\) \{\s*remove\.hidden = !item \|\| readOnly;\s*remove\.disabled = readOnly;/);
});

// 서버는 읽기 전용 캘린더의 행에 대해 PATCH/DELETE 를 403 calendar_read_only 로 막는다.
// 날짜 드래그도 같은 PATCH 라, 화면이 먼저 잠그지 않으면 옮길 수 있는 것처럼 보였다가
// 실패한다. workItemCanEdit 이 그 단일 관문이다.
test("a read-only calendar row is not draggable because the server rejects the same PATCH", () => {
  const canEditSource = source.slice(
    source.indexOf("function workItemCanEdit(item) {"),
    source.indexOf("function workDateKey(value) {")
  );
  assert.ok(canEditSource.length > 0, "workItemCanEdit must exist");
  assert.match(canEditSource, /return Boolean\(item\) && item\.readOnly !== true;/);
  assert.match(source, /var canEdit = workItemCanEdit\(item\);/);
});

// 가까운 업무는 달력 아래 띠가 아니라 왼쪽 칸, 캘린더 카드 바로 아래로 들어간다.
// 왼쪽 칸은 컨테이너 하나(.mi-work-side)로 묶이고 행 span(grid-row: 1 / -1) 을 쓰지 않는다 —
// 그래서 캘린더 카드가 TODAY 묶음을 덮거나 잘라먹지 못한다.
// 어젠다는 서랍(.mi-work-gcal-rail)의 자식이 아니라 형제라 서랍이 접히는 761~1180px 에서도 살아 있다.
test("the agenda sits in the left rail column under the Calendars card and stacks its cards vertically", () => {
  assert.match(source, /#mi-admin \.mi-work-layout\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  // 두 묶음은 두 칸으로 서지 않는다 — 한 칸짜리 세로 스택이다.
  assert.match(source, /#mi-admin \.mi-work-agenda\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.equal(
    /#mi-admin \.mi-work-agenda\s*\{[^}]*repeat\(2,/.test(source),
    false,
    "아젠다 묶음이 두 칸으로 되돌아가면 안 된다"
  );

  // === DOM: 왼쪽 칸은 레일 + 어젠다를 담은 컨테이너 하나다 ===
  const bodyOpen = workViewMarkup.indexOf('<div class="mi-work-body" data-work-gcal-body>');
  assert.ok(bodyOpen >= 0, ".mi-work-body 컨테이너가 있어야 한다");
  const bodyMarkup = workViewMarkup.slice(bodyOpen);
  assert.match(
    bodyMarkup,
    /<div class="mi-work-body" data-work-gcal-body>\s*<div class="mi-work-side">\s*<aside class="mi-work-gcal-rail"/,
    "왼쪽 칸(.mi-work-side)이 캘린더 카드를 먼저 담아야 한다"
  );
  // 서랍 안에 넣으면 761~1180px 에서 통째로 사라진다 — 레일 aside 가 먼저 닫히고, 둘은 같은 깊이의 형제다.
  assert.match(
    bodyMarkup,
    /\n(\s+)<aside class="mi-work-gcal-rail"[\s\S]*?\n\1<\/aside>\s*\n\1<aside class="mi-work-agenda-card">/,
    "어젠다 카드는 레일 aside 의 형제여야 한다(자식이면 서랍에 같이 숨는다)"
  );
  // 왼쪽 칸이 닫힌 다음에 월간 그리드가 온다 = 둘은 .mi-work-body 의 두 칸이다.
  assert.match(
    bodyMarkup,
    /<\/aside>\s*<\/div>\s*<div class="mi-work-layout">\s*<article class="mi-work-calendar-card">/,
    "월간 그리드는 왼쪽 칸 밖, .mi-work-body 의 두 번째 칸이어야 한다"
  );
  assert.equal(
    /<div class="mi-work-layout">[\s\S]*?mi-work-agenda-card[\s\S]*?<\/article>/.test(bodyMarkup),
    false,
    "어젠다 카드를 .mi-work-layout 안에 도로 넣으면 안 된다"
  );

  // === 데스크톱 배치: 두 칸뿐이고 행 span 꼼수는 없다 ===
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-side \{\s*display: flex;\s*flex-direction: column;\s*min-width: 0;\s*gap: 16px;/
  );
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail \{\s*grid-template-columns: minmax\(0, 300px\) minmax\(0, 1fr\);\s*\}/
  );
  assert.equal(
    /grid-row: 1 \/ -1/.test(railContextCss.replace(/\/\*[\s\S]*?\*\//g, "")),
    false,
    "행 span 꼼수가 남으면 캘린더 카드가 TODAY 묶음을 덮는다"
  );
  assert.equal(
    /#mi-admin \.mi-work-body\.has-gcal-rail[^{]*\{[^}]*grid-template-rows:/.test(source),
    false,
    "두 칸 배치에는 명시 행이 필요 없다"
  );
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-layout \{\s*grid-column: 2;\s*align-self: start;/
  );

  // === 왼쪽 칸은 붙박이고, 넘치면 어젠다 목록이 스스로 스크롤한다 ===
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-side \{\s*position: sticky;\s*top: 18px;\s*grid-column: 1;\s*align-self: start;\s*max-height: calc\(100vh - 36px\);/,
    "월간 그리드를 굴려도 왼쪽 칸은 화면에 붙어 있어야 한다"
  );
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-side > \.mi-work-gcal-rail \{\s*flex: 0 0 auto;\s*min-height: 0;\s*max-height: 40vh;\s*overflow-y: auto;/,
    "캘린더 카드가 어젠다 몫까지 먹으면 안 된다 — 40vh 에서 스스로 스크롤한다"
  );
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-side > \.mi-work-agenda-card \{\s*flex: 1 1 auto;\s*min-height: 0;/
  );
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-side > \.mi-work-agenda-card > \.mi-work-agenda \{\s*overflow-y: auto;\s*max-height: calc\(100vh - 36px - 210px\);/,
    "페이지 스크롤은 달력 몫이고, 어젠다 목록은 안쪽에서 스크롤한다"
  );
  // 붙박이는 왼쪽 칸 하나로 모은다 — 레일이 따로 붙박이면 컨테이너 안에서 어긋난다.
  assert.equal(
    /#mi-admin \.mi-work-gcal-rail \{\s*position: sticky/.test(railContextCss),
    false,
    "붙박이는 왼쪽 칸 하나뿐이어야 한다"
  );
  // 구글 미연동(레일 없음)이면 왼쪽 칸이 풀려서 달력 → 가까운 업무 순서로 한 칸에 쌓인다.
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-body:not\(\.has-gcal-rail\) > \.mi-work-side \{\s*position: static;\s*display: contents;\s*max-height: none;/
  );
  assert.match(railContextCss, /#mi-admin \.mi-work-gcal-rail \{[^}]{0,80}order: 1;/);
  assert.match(railContextCss, /#mi-admin \.mi-work-layout \{[^}]{0,220}order: 2;/);
  assert.match(railContextCss, /#mi-admin \.mi-work-agenda-card \{[^}]{0,160}order: 3;/);

  // === 레일 안에서는 카드가 한 줄에 하나씩 세로로 쌓인다 ===
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-agenda-row \{\s*display: grid;\s*min-width: 0;\s*grid-template-columns: minmax\(0, 1fr\);/
  );
  assert.equal(
    /repeat\(auto-fill, minmax\(260px, 1fr\)\)/.test(railContextCss),
    false,
    "좁은 레일에서는 가로 auto-fill 그리드가 남으면 안 된다"
  );
  assert.equal(
    /#mi-admin \.mi-work-agenda-row \{[^}]*overflow-x:/.test(source),
    false,
    "카드 줄은 가로 스크롤이 아니라 줄바꿈으로 넘긴다"
  );
  assert.match(source, /#mi-admin \.mi-work-agenda-row > \.mi-work-agenda-item \{\s*min-width: 0;\s*max-width: 100%;/);

  // === 761~1180px: 왼쪽 칸이 풀리고 붙박이·내부 스크롤이 꺼진다 ===
  assert.match(narrowMediaCss, /#mi-admin \.mi-work-body\.has-gcal-rail \{\s*grid-template-columns: minmax\(0, 1fr\);\s*\}/);
  assert.match(
    narrowMediaCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-side \{\s*position: static;\s*display: contents;\s*max-height: none;/,
    "좁은 폭에서는 붙박이를 꺼야 서랍·세로 스택이 정상으로 흐른다"
  );
  assert.match(
    narrowMediaCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-side > \.mi-work-agenda-card > \.mi-work-agenda \{\s*overflow-y: visible;\s*max-height: none;/
  );
  // display: contents 로 왼쪽 칸이 풀리면 달력·어젠다가 .mi-work-body 의 직계
  // 그리드 아이템이 된다. 넓은 화면용 `grid-column: 2` 가 남아 있으면 1칸 그리드에
  // 암시적 두 번째 칸이 생겨 달력이 절반으로 눌리고 어젠다가 그 옆에 붙는다
  // (1100px 실측: grid-template-columns 가 446px 590px 로 잡혔다).
  // 칸 지정을 풀고 order 로 달력→어젠다 순서만 정한다.
  assert.match(
    narrowMediaCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-layout \{\s*grid-column: auto;\s*order: 1;\s*\}/,
    "761~1180px 에서 달력의 grid-column: 2 를 풀지 않으면 암시적 2칸이 생겨 달력이 눌린다"
  );
  assert.match(
    narrowMediaCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-side > \.mi-work-agenda-card \{\s*grid-column: auto;\s*order: 2;\s*\}/,
    "어젠다는 달력 아래(order 2)로 내려가야 한다"
  );
  // display: contents 로 왼쪽 칸이 풀리면 넓은 화면용 grid-column 이 그대로 남아 암시적 두 번째 칸이 생긴다.
  // 1100px 실측에서 .mi-work-body 가 202px 590px 두 칸으로 잡혀 달력이 절반으로 눌렸다.
  assert.match(
    narrowMediaCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-layout \{\s*grid-column: auto;/,
    "좁은 폭에서 grid-column: 2 가 남으면 달력이 절반으로 눌리고 어젠다가 그 옆에 붙는다"
  );
  assert.match(
    narrowMediaCss,
    /#mi-admin \.mi-work-body\.has-gcal-rail > \.mi-work-side > \.mi-work-agenda-card \{\s*grid-column: auto;/
  );
  // 서랍이 감추는 선택자는 레일 하나뿐이다 — 왼쪽 칸이나 어젠다를 같이 감추면 761~1180px 에서 사라진다.
  for (const rule of narrowMediaCss.match(/[^{}]+\{[^{}]*display:\s*none[^{}]*\}/g) || []) {
    const selector = rule.slice(0, rule.indexOf("{")).trim();
    assert.equal(
      /mi-work-side|mi-work-agenda/.test(selector),
      false,
      `761~1180px 에서 감추는 규칙이 어젠다까지 건드리면 안 된다: ${selector}`
    );
  }
  assert.equal(
    /is-gcal-open[^{]*\.mi-work-agenda-card/.test(source),
    false,
    "어젠다 표시를 서랍 열림 상태에 묶으면 안 된다"
  );
  // 폭이 다시 넓어지는 구간에서만 카드가 가로로 흐른다.
  assert.match(narrowMediaCss, /#mi-admin \.mi-work-agenda-row \{\s*grid-template-columns: repeat\(auto-fill, minmax\(260px, 1fr\)\);/);

  // === 760px 이하: 어젠다는 달력 아래 전체 폭, 카드는 세로로 쌓인다 ===
  assert.match(mobileMediaCss, /#mi-admin \.mi-work-body \.mi-work-agenda-card \{\s*grid-column: 1 \/ -1;/);
  assert.match(mobileMediaCss, /#mi-admin \.mi-work-agenda-row \{\s*grid-template-columns: minmax\(0, 1fr\);/);

  // 라벨은 영문 TODAY/TOMORROW 이고, 카드는 라벨 아래 줄바꿈 컨테이너에 담긴다.
  assert.match(source, /agenda\.innerHTML = renderWorkAgendaGroup\("TODAY", todayItems\) \+\s*\n\s*renderWorkAgendaGroup\("TOMORROW", tomorrowItems\);/);
  assert.match(
    source,
    /'<section class="mi-work-agenda-group"><strong>' \+ escapeHtml\(title\) \+\s*\n\s*'<\/strong><div class="mi-work-agenda-row">' \+ content \+ '<\/div><\/section>'/
  );
  // 라벨은 기존 kicker\/label 처리를 그대로 쓴다.
  assert.match(source, /#mi-admin \.mi-work-agenda-group > strong \{[\s\S]{0,180}letter-spacing: \.05em;\s*text-transform: uppercase;/);
  // "가까운 업무" 제목은 그대로 남는다.
  assert.match(workViewMarkup, /<h2 data-work-agenda-title>가까운 업무<\/h2>/);
  assert.match(source, /if \(title\) title\.textContent = "가까운 업무";/);

  assert.equal(source.includes('renderWorkAgendaGroup("오늘"'), false, "한국어 오늘 라벨은 남으면 안 된다");
  assert.equal(source.includes('renderWorkAgendaGroup("내일"'), false, "한국어 내일 라벨은 남으면 안 된다");
  assert.equal(source.includes('renderWorkAgendaGroup("Next"'), false, "NEXT 묶음은 남으면 안 된다");
  assert.equal(source.includes("nextItems"), false, "NEXT 필터도 함께 사라져야 한다");
  assert.equal(source.includes("var nextDate"), false, "NEXT 기준 날짜도 남으면 안 된다");
  assert.equal(source.includes('renderWorkAgendaGroup("Today"'), false, "대소문자가 다른 라벨 상수는 남으면 안 된다");
  assert.equal(source.includes('renderWorkAgendaGroup("Tomorrow"'), false, "대소문자가 다른 라벨 상수는 남으면 안 된다");

  // 비어 있어도 칸이 사라지지 않고 한국어 안내가 한 줄을 다 쓴다.
  assert.match(source, /'<div class="mi-work-agenda-empty">등록된 업무가 없습니다\.<\/div>'/);
  assert.match(source, /#mi-admin \.mi-work-agenda-row > \.mi-work-agenda-empty \{\s*grid-column: 1 \/ -1;/);
  // 세로 스택이 기본이라, 한 묶음만 그리는 경로를 위한 is-single 예외는 필요 없다.
  assert.equal(source.includes("is-single"), false, "세로 스택에서 is-single 예외는 남으면 안 된다");
});

// 좁은 왼쪽 칸에서 카드 글자가 "오전 12:00 · 예" / "정" / "d…" 처럼 한 글자씩 끊기던 버그의 방지선.
// 원인은 두 가지였다 — 줄어들지 못하는 자식(flex 기본 min-width: auto)이 글자 칸을 몇 px 로 짓눌렀고,
// 한글 기본값(word-break: normal)은 음절 사이 아무 데서나 끊는다.
test("narrow-rail agenda cards shrink instead of breaking korean text one character per line", () => {
  // 칩이 min-content 를 요구하던 auto 칸은 사라지고, 넘치면 칩 줄이 제목 아래로 접힌다.
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-agenda-item \{\s*display: flex;\s*flex-wrap: wrap;\s*min-width: 0;/
  );
  assert.equal(
    /#mi-admin \.mi-work-agenda-item \{[^}]*grid-template-columns: 9px minmax\(0, 1fr\) auto 32px;/.test(source),
    false,
    "줄어들지 못하는 auto 칩 칸이 되살아나면 안 된다"
  );

  // 줄어들 수 있는 자식은 전부 min-width: 0 이다(= flex/grid 기본 min-width: auto 해제).
  for (const [selector, pattern] of [
    [".mi-work-agenda-card", /#mi-admin \.mi-work-agenda-card \{[^}]{0,160}min-width: 0;/],
    [".mi-work-agenda-head", /#mi-admin \.mi-work-agenda-head \{[^}]{0,160}min-width: 0;/],
    [".mi-work-agenda-head > div", /#mi-admin \.mi-work-agenda-head > div \{\s*min-width: 0;/],
    [".mi-work-agenda", /#mi-admin \.mi-work-agenda \{[^}]{0,160}min-width: 0;/],
    [".mi-work-agenda-group", /#mi-admin \.mi-work-agenda-group \{[^}]{0,120}min-width: 0;/],
    [".mi-work-agenda-row", /#mi-admin \.mi-work-agenda-row \{[^}]{0,120}min-width: 0;/],
    [".mi-work-agenda-item", /#mi-admin \.mi-work-agenda-item \{[^}]{0,120}min-width: 0;/],
    [".mi-work-agenda-edit", /#mi-admin \.mi-work-agenda-edit \{[^}]{0,120}min-width: 0;/],
    [".mi-work-badges", /#mi-admin \.mi-work-badges,[^}]{0,200}min-width: 0;/],
    [".mi-work-agenda-meta", /#mi-admin \.mi-work-agenda-meta \{[^}]{0,160}min-width: 0;/]
  ]) assert.match(railContextCss, pattern, `${selector} 는 실제로 줄어들 수 있어야 한다(min-width: 0)`);

  // 한글은 낱말 경계에서만 끊고, 띄어쓰기 없는 긴 토큰만 예외로 아무 데서나 끊는다.
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-agenda-edit \{[^}]{0,400}word-break: keep-all;[^}]{0,260}overflow-wrap: anywhere;/,
    "word-break: keep-all 이 빠지면 좁은 칸에서 한 글자씩 잘린다"
  );
  // 제목은 최대 두 줄까지 보여주고 그다음은 말줄임이다.
  assert.match(railContextCss, /#mi-admin \.mi-work-agenda-edit strong \{[^}]{0,260}-webkit-line-clamp: 2;/);
  // "8. 25. (화) 오전 12:00 · 예정" 줄과 상세 줄은 언제나 한 줄 + 말줄임이다.
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-agenda-edit span \{[^}]{0,220}text-overflow: ellipsis;\s*white-space: nowrap;/
  );
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-agenda-meta \{[^}]{0,260}text-overflow: ellipsis;\s*white-space: nowrap;/
  );

  // 칩(내 일정 / 구글)은 제목 아래 제 줄을 쓰고, 스스로는 줄어들지 않는다.
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-agenda-item > \.mi-work-badges \{\s*flex: 0 0 100%;\s*order: 4;/
  );
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-badges > em,\s*#mi-admin \.mi-work-badges > a \{\s*flex: 0 0 auto;/
  );
  // 완료 체크는 줄 오른쪽 끝에 서고 절대 줄어들지 않는다.
  assert.match(
    railContextCss,
    /#mi-admin \.mi-work-quick-done \{\s*display: grid;\s*flex: 0 0 auto;\s*order: 3;/
  );
  // 한 줄 안의 순서: 동그라미(1) → 글자 칸(2) → 완료 체크(3), 그리고 칩 줄(4)이 그 아래.
  assert.match(railContextCss, /#mi-admin \.mi-work-agenda-item > i \{[^}]{0,120}order: 1;/);
  assert.match(railContextCss, /#mi-admin \.mi-work-agenda-edit \{\s*flex: 1 1 0;\s*order: 2;/);
});

// 구글 월간 뷰처럼 캘린더 배경색으로 꽉 찬 칩은 그대로 남는다. 색은 6자리 HEX 만 style 로 나가고,
// 완료·공개 표시는 색 위에 그대로 남아야 한다.
// 반대로 달력 아래 아젠다 카드는 색을 칠하지 않는다 — 색은 제목 앞 동그라미 하나뿐이다.
test("month chips keep the google colour fill while agenda cards keep only the colour dot", () => {
  assert.match(source, /function workGcalColor\(value\)[\s\S]{0,240}\/\^#\[0-9a-fA-F\]\{6\}\$\/\.test\(color\) \? color : ""/);
  assert.match(source, /var chipText = workItemTextColor\(item\);/);
  assert.match(source, /chipStyle = chipStyle\.slice\(0, -1\) \+ ";--mi-gcal-text:" \+ chipText \+ '"'/);

  // 월간 칩 색 규칙은 이번 변경에서 손대지 않았다.
  assert.match(source, /#mi-admin \.mi-work-day-item\[data-gcal="1"\] \{[\s\S]{0,220}background: var\(--mi-gcal-color, var\(--mi-navy\)\);\s*color: var\(--mi-gcal-text, #fff\);/);
  assert.match(source, /#mi-admin \.mi-work-day-item\[data-gcal="1"\] \{\s*border-left: 3px solid var\(--mi-gcal-color/);
  assert.match(source, /#mi-admin \.mi-work-day-dot \{[\s\S]{0,180}background: var\(--mi-gcal-color, var\(--mi-navy\)\);/);

  // 아젠다 카드는 중립 패널이다: 색 채움도, 글자색 계약도 없다.
  assert.match(
    source,
    /#mi-admin \.mi-work-agenda-item \{[\s\S]{0,260}border: 1px solid var\(--mi-line\);\s*border-radius: 14px;\s*background: var\(--mi-panel\);\s*color: var\(--mi-ink\);/
  );
  assert.match(source, /#mi-admin \.mi-work-agenda-edit strong \{[\s\S]{0,120}color: var\(--mi-ink\);/);
  assert.match(source, /#mi-admin \.mi-work-agenda-edit span \{[\s\S]{0,120}color: var\(--mi-muted\);/);
  assert.equal(
    /#mi-admin \.mi-work-agenda-item\[data-gcal="1"\] \.mi-work-agenda-edit/.test(source),
    false,
    "아젠다 카드 본문을 캘린더 색으로 칠하면 안 된다"
  );
  assert.equal(source.includes("var rowText"), false, "칠하지 않는 카드에 글자색 계산은 남으면 안 된다");
  assert.equal(source.includes(';--mi-gcal-text:" + rowText'), false, "아젠다 style 에 글자색을 붙이면 안 된다");

  // 색이 닿는 곳은 제목 앞 동그라미 하나뿐이고, 색이 없으면 중립 토큰이 남는다.
  assert.match(source, /'><i aria-hidden="true"><\/i><button type="button" class="mi-work-agenda-edit"/);
  assert.match(source, /#mi-admin \.mi-work-agenda-item > i \{\s*width: 9px;\s*height: 9px;[\s\S]{0,120}border-radius: 50%;\s*background: #7183a0;/);
  assert.match(source, /#mi-admin \.mi-work-agenda-item\[data-gcal="1"\] > i \{\s*background: var\(--mi-gcal-color, var\(--mi-navy\)\);/);

  assert.match(source, /#mi-admin \.mi-work-day-item\[data-gcal="1"\]\[data-status="done"\] \{\s*opacity: [^;]+;\s*text-decoration: line-through;/);
  // 완료·공개 표시는 중립 카드 위에서도 그대로 남는다.
  assert.match(source, /#mi-admin \.mi-work-agenda-item\[data-status="done"\] \{\s*opacity: [^;]+;/);
  assert.match(source, /#mi-admin \.mi-work-agenda-item\[data-status="done"\] \.mi-work-agenda-edit strong \{\s*text-decoration: line-through;/);
  assert.match(source, /\(item\.visibility === "client_visible" \? " is-public" : ""\)/);
  assert.match(source, /#mi-admin \.mi-work-day-item\[data-public="true"\]::before/);

  // 종일과 시간 지정 칩은 구글처럼 다르게 그린다(꽉 찬 블록 vs 색 점 + 글자).
  assert.match(source, /var chipAllDay = item\.isAllDay === false \? "false" : "true";/);
  assert.match(source, /' data-allday="' \+ chipAllDay \+ '"/);
  assert.match(source, /chipColor && chipAllDay === "false" \? '<i class="mi-work-day-dot" aria-hidden="true"><\/i>' : ""/);
  assert.match(source, /#mi-admin \.mi-work-day-item\[data-gcal="1"\]\[data-allday="false"\] \{/);
});

// 체크가 조용히 되돌아가면 대표님은 이유를 알 수 없다. 마이그레이션 미적용 503 같은
// 서버 사유를 레일 안내문에 그대로 남기고, 다음 성공에서 지운다.
test("a failed visibility toggle explains itself in the rail note instead of silently snapping back", () => {
  assert.match(workViewMarkup, /<p class="mi-work-gcal-note" data-work-gcal-note hidden><\/p>/);
  assert.match(source, /function setWorkGcalNote\(message\)[\s\S]{0,320}note\.hidden = !text;/);
  assert.match(source, /#mi-admin \.mi-work-gcal-rail \.mi-work-gcal-note\[hidden\] \{\s*display: none;/);

  assert.match(calendarVisibilitySource, /visibilityNote = payload && payload\.message \? String\(payload\.message\) : "캘린더 설정 저장에는 관리자 DB 업데이트가 필요합니다\.";/);
  assert.match(calendarVisibilitySource, /setWorkGcalNote\(""\);/);
  const revert = calendarVisibilitySource.slice(calendarVisibilitySource.indexOf("} catch (error) {"));
  assert.match(revert, /workCalendarCatalog = previousCatalog;/);
  assert.match(revert, /setWorkGcalNote\(visibilityNote \|\| error\.message \|\| "캘린더 설정 저장에는 관리자 DB 업데이트가 필요합니다\."\)/);
});

// 새 캘린더 만들기와 참가자 관리는 gcal 접두사 계약만 쓴다.
test("the rail creates calendars and manages participants through the gcal-prefixed contract", () => {
  assert.match(workViewMarkup, /data-work-gcal-new aria-expanded="false" aria-controls="mi-work-gcal-new-form"/);
  assert.match(workViewMarkup, /＋ 새 캘린더 만들기<\/button>/);
  assert.match(workViewMarkup, /data-work-gcal-new-form hidden/);
  assert.match(workViewMarkup, /data-work-gcal-new-name/);
  assert.match(workViewMarkup, /data-work-gcal-invite-chips/);
  assert.match(workViewMarkup, /data-work-gcal-invite-input/);
  assert.match(workViewMarkup, /data-work-gcal-invite-role[\s\S]{0,220}<option value="writer">편집 가능<\/option>[\s\S]{0,140}<option value="reader">보기만<\/option>/);
  assert.match(workViewMarkup, /data-work-gcal-create>만들기<\/button>/);
  assert.match(workViewMarkup, /data-work-gcal-new-cancel>취소<\/button>/);

  assert.match(source, /action: "calendar-create", summary: summary, invites: invites/);
  assert.match(source, /function commitWorkGcalInvite\(raw\)[\s\S]{0,320}if \(!workEmailPattern\.test\(text\)\)/);
  assert.match(source, /async function createWorkCalendarFromForm\(\)[\s\S]{0,1600}if \(Array\.isArray\(payload\.calendars\)\) workCalendarCatalog = payload\.calendars;[\s\S]{0,260}await loadWorkItems\(\)/);
  assert.match(source, /var failed = Array\.isArray\(payload\.failedInvites\) \? payload\.failedInvites : \[\];/);
  assert.match(source, /setWorkGcalNote\("초대하지 못한 참가자: "/);

  assert.match(railRenderSource, /var manageable = Boolean\(entry && String\(entry\.accessRole \|\| ""\) === "owner" && entry\.primary !== true\);/);
  assert.match(railRenderSource, /manageable \? '<button type="button" class="mi-work-gcal-acl" data-work-gcal-acl="' \+ escapeHtml\(id\)/);
  assert.match(workViewMarkup, /data-work-gcal-acl-panel hidden/);
  assert.match(workViewMarkup, /data-work-gcal-acl-rules/);
  assert.match(workViewMarkup, /data-work-gcal-acl-email/);
  assert.match(workViewMarkup, /data-work-gcal-acl-add>추가<\/button>/);
  assert.match(source, /var body = \{ action: "calendar-acl", calendarId: id, op: op \};/);
  assert.match(source, /workGcalAclRules = Array\.isArray\(payload\.rules\) \? payload\.rules : \[\];/);
  assert.match(source, /data-work-gcal-acl-remove="' \+ escapeHtml\(String\(rule && rule\.id \|\| ""\)\)/);
  assert.match(source, /requestWorkCalendarAcl\("list", \{ calendarId: gcalAclTarget \}\)/);
  assert.match(source, /requestWorkCalendarAcl\("delete", \{ ruleId: gcalAclRemove\.getAttribute\("data-work-gcal-acl-remove"\) \|\| "" \}\)/);
  assert.match(source, /function addWorkCalendarAclEmail\(\)[\s\S]{0,320}if \(!workEmailPattern\.test\(email\)\)/);
  assert.match(source, /requestWorkCalendarAcl\("insert", \{ email: email, role: role \}\)/);

  // 요청 중에는 레일 전체가 잠긴다.
  assert.match(source, /function syncWorkGcalBusy\(\)[\s\S]{0,420}control\.disabled = workGcalBusy;/);
  assert.match(source, /async function requestWorkCalendarAcl\(op, options\)[\s\S]{0,200}workGcalBusy\) return;/);
  assert.match(source, /async function createWorkCalendarFromForm\(\)[\s\S]{0,120}workGcalBusy\) return;/);

  for (const marker of [
    "mi-work-calendar-rail",
    "data-work-calendar-list",
    "data-work-calendar-create",
    "data-work-calendar-filter",
    "data-work-calendar-color",
    "data-work-calendar-grant",
    "data-work-calendar-share",
    "data-work-calendar-invite-code",
    "data-work-calendar-join",
    "data-work-calendar-leave",
    "data-work-calendar-select"
  ]) assert.equal(workViewMarkup.includes(marker), false, `새 캘린더 UI 가 되살리면 안 되는 문자열: ${marker}`);
});

// 맞춤 반복은 인라인 박스가 아니라 구글식 창에서 고른다.
test("the custom recurrence editor is a modal with radio end options and a monthly nth-weekday choice", () => {
  assert.match(editorMarkup, /<div class="mi-work-modal" data-work-recurrence-modal hidden>/);
  assert.match(editorMarkup, /data-work-recurrence-cancel aria-label="닫기"/);
  assert.match(editorMarkup, /data-work-recurrence-cancel>취소<\/button>/);
  assert.match(editorMarkup, /data-work-recurrence-done>완료<\/button>/);
  assert.ok(
    editorMarkup.indexOf('data-work-recurrence-modal') < editorMarkup.indexOf('data-work-recurrence-custom'),
    "맞춤 반복 상자는 창 안으로 들어간다"
  );

  assert.match(editorMarkup, /<option value="MONTHLY">개월<\/option>/);
  assert.match(editorMarkup, /data-work-recurrence-monthly-field[^>]*hidden/);
  assert.match(editorMarkup, /data-work-recurrence-monthly-option="bymonthday">매월 N일<\/option>/);
  assert.match(editorMarkup, /data-work-recurrence-monthly-option="byday">매월 N번째 X요일<\/option>/);

  assert.match(editorMarkup, /role="radiogroup" aria-label="반복 종료"/);
  for (const value of ["never", "until", "count"]) {
    assert.match(
      editorMarkup,
      new RegExp(`type="radio" name="mi-work-recurrence-end-choice" value="${value}" data-work-recurrence-end-choice`),
      `종료 라디오가 없습니다: ${value}`
    );
  }
  assert.match(editorMarkup, /다음 N회 반복<\/span>/);

  // 라벨은 선택한 시작 날짜에서 다시 만든다.
  assert.match(source, /if \(customByDate\) customByDate\.textContent = "매월 " \+ date\.getDate\(\) \+ "일"/);
  assert.match(source, /if \(customByDay\) customByDay\.textContent = "매월 " \+ ordinal \+ " " \+ dayName \+ "요일"/);

  // 완료는 기존 페이로드 빌더가 이미 보내는 RFC5545 줄을 그대로 만든다.
  assert.match(source, /if \(monthlyMode === "byday"\) rule \+= ";BYDAY=" \+ \(Math\.floor\(\(date\.getDate\(\) - 1\) \/ 7\) \+ 1\) \+ day;/);
  assert.match(source, /else rule \+= ";BYMONTHDAY=" \+ date\.getDate\(\);/);
  assert.match(source, /setWorkValue\("\[data-work-recurrence-end\]", radio\.value\)/);
  assert.match(source, /radio\.checked = radio\.value === endMode;/);
  assert.match(source, /setWorkValue\("\[data-work-recurrence-monthly-mode\]", freq === "MONTHLY" && \/\^-\?\\d\[A-Z\]\{2\}\$\/\.test\(byDay\) \? "byday" : "bymonthday"\)/);

  // 맞춤을 고르면 창이 열리고, 취소는 열기 전 값으로 되돌린다.
  assert.match(source, /if \(workRecurrencePreset\.value === "custom"\) openWorkRecurrenceModal\(\)/);
  assert.match(source, /function openWorkRecurrenceModal\(\)[\s\S]{0,300}workRecurrenceSnapshotBeforeEdit = workRecurrenceSnapshot\(\)/);
  assert.match(source, /function closeWorkRecurrenceModal\(revert\)[\s\S]{0,260}restoreWorkRecurrenceSnapshot\(workRecurrenceSnapshotBeforeEdit\)/);
  assert.match(source, /var recurrenceDone = event\.target\.closest\("\[data-work-recurrence-done\]"\);[\s\S]{0,120}closeWorkRecurrenceModal\(false\)/);
  assert.match(source, /var recurrenceCancel = event\.target\.closest\("\[data-work-recurrence-cancel\]"\);[\s\S]{0,120}closeWorkRecurrenceModal\(true\)/);
});

// 날짜 줄은 구글처럼 한 줄, 캘린더 줄에는 그 캘린더 색 점을 둔다.
test("the dialog puts 시작 and 종료 on one compact line and marks the calendar with its colour dot", () => {
  assert.match(editorMarkup, /<div class="mi-work-form-grid mi-work-when-row">/);
  const whenRow = editorMarkup.slice(
    editorMarkup.indexOf('class="mi-work-form-grid mi-work-when-row"'),
    editorMarkup.indexOf('class="mi-work-when-actions"')
  );
  assert.ok(whenRow.indexOf("data-work-start-time-field") < whenRow.indexOf("data-work-end-label"), "시작 시간이 종료 날짜 앞에 온다");
  assert.ok(whenRow.indexOf("data-work-end-label") < whenRow.indexOf("data-work-end-time-field"), "종료 날짜가 종료 시간 앞에 온다");
  assert.match(source, /#mi-admin \.mi-work-when-row \{\s*display: flex;/);
  assert.match(editorMarkup, /<button[^>]+data-work-time-toggle[^>]+aria-expanded="false"[^>]*>시간 추가<\/button>/);

  assert.match(editorMarkup, /<i class="mi-work-gcal-dot" data-work-google-calendar-dot aria-hidden="true"><\/i>/);
  assert.match(source, /function syncWorkGoogleCalendarDot\(\)[\s\S]{0,700}dot\.style\.setProperty\("--mi-gcal-color", color \|\| "var\(--mi-navy\)"\)/);
  assert.match(source, /#mi-admin \.mi-work-gcal-dot \{[\s\S]{0,220}background: var\(--mi-gcal-color, var\(--mi-navy\)\);/);
});

// 구글이 API 로 주는 16진값(레거시)과 웹 UI 가 실제로 칠하는 값(모던)이 다르다.
// admin.html 은 정적이라 서버 표를 import 할 수 없어 손으로 옮겨 적었다. 그 두 벌이
// 한 글자라도 어긋나면 대표님 화면 색이 구글과 달라지므로 여기서 서버 표를 읽어 대조한다.
const eventColorTableSource = source.slice(
  source.indexOf("var workEventColors = ["),
  source.indexOf("function workEventColorId(")
);

test("the dialog mirrors the server event colour palette exactly and in the google korean order", () => {
  assert.ok(eventColorTableSource.length > 0, "admin.html must carry the mirrored event colour table");
  assert.equal(EVENT_COLOR_PALETTE.length, 11);
  assert.equal(EVENT_COLOR_DISPLAY_ORDER.length, 11);

  const ordered = EVENT_COLOR_DISPLAY_ORDER.map((id) => {
    const entry = EVENT_COLOR_PALETTE.find((candidate) => candidate.id === id);
    assert.ok(entry, `서버 팔레트에 없는 colorId: ${id}`);
    return entry;
  });

  // 구글 한국어 UI 가 늘어놓는 순서 그대로.
  assert.deepEqual(
    ordered.map((entry) => entry.nameKo),
    ["토마토", "플라밍고", "탠저린", "바나나", "세이지", "바질", "피콕", "블루베리", "라벤더", "포도", "흑연"]
  );

  // 16진값·이름·순서 세 가지를 한 줄로 못 박는다.
  let cursor = 0;
  for (const entry of ordered) {
    const mirrored = `{ id: "${entry.id}", hex: "${entry.modern}", name: "${entry.nameKo}" }`;
    const at = eventColorTableSource.indexOf(mirrored, cursor);
    assert.notEqual(at, -1, `admin.html 이 서버 표와 다릅니다. 이 줄이 이 순서로 있어야 합니다: ${mirrored}`);
    cursor = at + mirrored.length;
  }

  // 레거시(API) 값은 화면에 그대로 나가면 안 된다 — "하나만 달라도 헷갈립니다"의 그 하나다.
  for (const entry of EVENT_COLOR_PALETTE) {
    assert.equal(source.includes(entry.legacy), false, `레거시 16진값이 화면으로 샜습니다: ${entry.legacy} (${entry.nameKo})`);
  }
});

// 칠하는 순서는 구글 웹 UI 와 같다: 일정에 지정된 색 → 캘린더 색 → 중립 기본값.
// 칩은 그 색으로 배경을 칠하고, 아젠다는 같은 색을 동그라미 하나에만 쓴다.
test("month chips and the agenda dot paint the event colour first, then the calendar colour, then the neutral token", () => {
  assert.match(source, /function workItemColor\(item\) \{\s*return workGcalColor\(item && item\.eventColor\) \|\| workGcalColor\(item && item\.calendarColor\);\s*\}/);
  assert.match(
    source,
    /function workItemTextColor\(item\) \{\s*if \(workGcalColor\(item && item\.eventColor\)\) return workGcalColor\(item && item\.eventTextColor\) \|\| "#ffffff";\s*return workGcalColor\(item && item\.calendarTextColor\) \|\| "#ffffff";\s*\}/
  );
  assert.match(source, /var chipColor = workItemColor\(item\);/);
  assert.match(source, /var chipText = workItemTextColor\(item\);/);
  // 아젠다도 같은 precedence 를 쓰지만, 나가는 변수는 색 하나뿐이다.
  assert.match(
    source,
    /var rowColor = workItemColor\(item\);\s*\n\s*var rowStyle = \(rowColor \? ' data-gcal="1" style="--mi-gcal-color:' \+ rowColor \+ '"' : ""\);/
  );
  assert.equal(source.includes("var rowText = workItemTextColor(item);"), false, "중립 카드에는 글자색 계약이 필요 없다");

  // 두 색 모두 6자리 HEX 관문을 지나야 style 로 나간다.
  assert.match(source, /function workGcalColor\(value\)[\s\S]{0,240}\/\^#\[0-9a-fA-F\]\{6\}\$\/\.test\(color\) \? color : ""/);
  // 색이 하나도 없으면 style 자체를 내보내지 않고 기존 중립 토큰이 남는다.
  assert.match(source, /#mi-admin \.mi-work-day-item\[data-gcal="1"\] \{[\s\S]{0,220}background: var\(--mi-gcal-color, var\(--mi-navy\)\);\s*color: var\(--mi-gcal-text, #fff\);/);
  assert.match(source, /#mi-admin \.mi-work-agenda-item\[data-gcal="1"\] > i \{\s*background: var\(--mi-gcal-color, var\(--mi-navy\)\);/);
});

// 색 줄은 구글처럼 "캘린더 색" 기본값 + 일정 색 11개 동그라미다.
// 인라인 핸들러 없이(CSP script-src-attr 'none') 위임 핸들러가 선택을 받는다.
test("the colour row offers the calendar default plus eleven event swatches without inline handlers", () => {
  const swatchRenderSource = source.slice(
    source.indexOf("function renderWorkEventColorSwatches() {"),
    source.indexOf("function syncWorkGoogleMode() {")
  );
  assert.ok(swatchRenderSource.length > 0, "swatch renderer must exist");

  assert.match(editorMarkup, /<div class="mi-work-field is-full" data-work-google-only data-work-gcal-swatch-field hidden><span>색<\/span>/);
  assert.match(editorMarkup, /<div class="mi-work-gcal-swatches" role="group" aria-label="일정 색" data-work-gcal-swatches><\/div>/);

  assert.match(swatchRenderSource, /<button type="button" class="mi-work-gcal-swatch is-default" data-work-gcal-swatch="" aria-pressed="' \+\s*\(workEventColorDraft \? "false" : "true"\)/);
  assert.match(swatchRenderSource, /aria-label="캘린더 색" title="캘린더 색"/);
  assert.match(swatchRenderSource, /<button type="button" class="mi-work-gcal-swatch" data-work-gcal-swatch="' \+ swatch\.id \+/);
  assert.match(swatchRenderSource, /aria-pressed="' \+ \(selected \? "true" : "false"\) \+ '" aria-label="' \+ escapeHtml\(swatch\.name\)/);
  assert.match(swatchRenderSource, /style="--mi-gcal-color:' \+ swatch\.hex/);
  assert.match(swatchRenderSource, /<span class="mi-work-gcal-swatch-check" aria-hidden="true">✓<\/span>/);
  assert.equal(/\son(?:click|change|input|submit|focus|blur|keydown|keyup)\s*=/i.test(swatchRenderSource), false, "스와치는 인라인 핸들러를 쓰지 않는다");

  // 선택 표시는 aria-pressed 하나로 접근성·시각 양쪽을 만든다.
  assert.match(source, /#mi-admin \.mi-work-gcal-swatch\[aria-pressed="true"\] \{/);
  assert.match(source, /#mi-admin \.mi-work-gcal-swatch\[aria-pressed="true"\] \.mi-work-gcal-swatch-check \{\s*opacity: 1;/);
  assert.match(source, /#mi-admin \.mi-work-gcal-swatch \{[\s\S]{0,320}background: var\(--mi-gcal-color, var\(--mi-navy\)\);/);

  // 위임 핸들러가 선택을 받아 다시 그린다.
  assert.match(source, /var gcalSwatch = event\.target\.closest\("\[data-work-gcal-swatch\]"\);[\s\S]{0,260}workEventColorDraft = workEventColorId\(gcalSwatch\.getAttribute\("data-work-gcal-swatch"\) \|\| ""\);[\s\S]{0,80}renderWorkEventColorSwatches\(\)/);
  // 표에 없는 값은 전부 기본값으로 되돌린다.
  assert.match(source, /function workEventColorId\(value\)[\s\S]{0,360}return "";\s*\}/);
  // 읽기 전용 일정에서는 button 이라 폼 잠금에 걸리지 않으므로 따로 잠근다.
  assert.match(openDialogSource, /root\.querySelectorAll\("\[data-work-gcal-swatch\]"\)\.forEach\(function \(control\) \{ control\.disabled = readOnly; \}\)/);

  // 금지된 공유 캘린더 계약 이름을 색 줄이 되살리지 않는다.
  for (const marker of ["data-work-calendar-color", "data-work-calendar-select"]) {
    assert.equal(editorMarkup.includes(marker), false, `색 줄이 되살리면 안 되는 문자열: ${marker}`);
  }
});

test("the colour choice travels as colorId and edit mode preselects the current colour", () => {
  assert.match(formPayloadSource, /payload\.colorId = workEventColorDraft;/);
  // 기본값은 빈 문자열로 나가고, 서버가 그때 캘린더 색을 쓴다.
  assert.match(source, /var workEventColorDraft = "";/);
  // 색은 캘린더 목록보다 먼저 정해야 처음 그릴 때 선택 상태가 맞는다.
  assert.match(openDialogSource, /workEventColorDraft = workEventColorId\(item && item\.colorId\);/);
  assert.ok(
    openDialogSource.indexOf("workEventColorDraft = workEventColorId(item && item.colorId);") <
      openDialogSource.indexOf("renderWorkGoogleCalendarOptions(item && item.googleCalendarId"),
    "색 선택은 캘린더 옵션을 그리기 전에 정해진다"
  );
  // 캘린더를 바꾸면 기본 스와치 색도 같이 따라간다.
  assert.match(source, /function syncWorkGoogleCalendarDot\(\)[\s\S]{0,420}renderWorkEventColorSwatches\(\)/);
  assert.match(source, /function workDialogCalendarColor\(\)[\s\S]{0,520}return workGcalColor\(calendar\.color\)/);

  // 미연동 사용자는 색 줄 자체가 없으므로 legacy 분기에는 colorId 가 나가지 않는다.
  const legacyBranch = formPayloadSource.slice(formPayloadSource.indexOf("payload.repeat = repeatMonthly"));
  assert.equal(legacyBranch.includes("payload.colorId"), false, "미연동 분기는 colorId 를 보내지 않는다");
});

// ─────────────────────────────────────────────────────────────
// 슬롯 일정 도우미 (대표실 · 일정 추가 버튼 옆 접이식 폼)
//
// 날짜 계산은 화면 상태를 읽지 않는 순수 함수라 admin.html 원본을 그대로
// 샌드박스에서 실행해 값으로 검증한다(rank-collection-stability.test.mjs 규약).
// ─────────────────────────────────────────────────────────────
const PAGE_FUNCTION_CLOSE = "\n      }";

function slotPageFunction(name) {
  const marker = `\n      function ${name}(`;
  const from = source.indexOf(marker);
  assert.ok(from >= 0, `page function not found: ${name}`);
  const to = source.indexOf(PAGE_FUNCTION_CLOSE + "\n", from);
  assert.ok(to > from, `page function end not found: ${name}`);
  return source.slice(from + 1, to + PAGE_FUNCTION_CLOSE.length);
}

function slotPlanContext() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(slotPageFunction("workSlotDateKey"), context);
  vm.runInContext(slotPageFunction("workSlotPlan"), context);
  return context;
}

function slotPlan(site, vendor, startKey, days) {
  const context = slotPlanContext();
  Object.assign(context, { __site: site, __vendor: vendor, __start: startKey, __days: days });
  // 샌드박스가 만든 객체는 프로토타입이 달라 deepStrictEqual 이 걸린다. 값만 옮겨 담는다.
  return { ...vm.runInContext("workSlotPlan(__site, __vendor, __start, __days)", context) };
}

const workSlotScopeSource = source.slice(
  source.indexOf("function syncWorkOwnerScope() {"),
  source.indexOf("function deactivateWorkOperation() {")
);
const workSlotPayloadSource = source.slice(
  source.indexOf("function workSlotItemPayload(title, startKey, endKey) {"),
  source.indexOf("async function submitWorkSlotSchedule() {")
);
const workSlotSubmitSource = source.slice(
  source.indexOf("async function submitWorkSlotSchedule() {"),
  source.indexOf('var workSlotToggle = root.querySelector("[data-work-slot-toggle]");')
);
const workSlotBindingSource = source.slice(
  source.indexOf('var workSlotToggle = root.querySelector("[data-work-slot-toggle]");'),
  source.indexOf('window.addEventListener("keydown", function (event) {', source.indexOf('var workSlotToggle = root.querySelector("[data-work-slot-toggle]");'))
);

test("slot helper sits beside the representative schedule create button and stays collapsed", () => {
  // 일정 추가 버튼 바로 앞에 붙는다 — 대표실 일정 등록 동선을 벗어나지 않는다.
  assert.match(
    workViewMarkup,
    /<button class="mi-link-button" type="button" data-work-slot-toggle aria-expanded="false" aria-controls="mi-work-slot-form" hidden>슬롯 일정 추가<\/button>\s*<button class="mi-link-button is-primary" type="button" data-work-create>일정 추가<\/button>/
  );
  // 폼은 접힌 채로 시작한다(hidden). 헤더 바깥의 독립 form 이라 편집 다이얼로그와 섞이지 않는다.
  assert.match(workViewMarkup, /<form class="mi-work-slot" id="mi-work-slot-form" data-work-slot-form hidden>/);
  assert.ok(workViewMarkup.indexOf("data-work-slot-form") > workViewMarkup.indexOf("</header>"));

  for (const [selector, pattern] of [
    ["data-work-slot-site", /<span>사이트명<\/span><input class="mi-input" data-work-slot-site maxlength="40" required/],
    ["data-work-slot-vendor", /<span>업체\/수량<\/span><input class="mi-input" data-work-slot-vendor maxlength="40" required placeholder="예: 거보 10슬롯"/],
    ["data-work-slot-start", /<span>시작일<\/span><input class="mi-input" type="date" data-work-slot-start required/],
    ["data-work-slot-days", /<input class="mi-input" type="number" min="1" max="365" step="1" value="30" data-work-slot-days required/]
  ]) {
    assert.ok(workViewMarkup.includes(selector), `슬롯 폼 입력이 없다: ${selector}`);
    assert.match(workViewMarkup, pattern);
  }
  assert.match(workViewMarkup, /<button class="mi-link-button is-primary" type="submit" data-work-slot-submit>슬롯 일정 등록<\/button>/);
  // 옛 문구·옛 선택자가 남지 않는다.
  assert.equal(workViewMarkup.includes("data-work-slot-account"), false);
  assert.equal(workViewMarkup.includes("슬롯 일정 2건 등록"), false);
  assert.match(workViewMarkup, /<span class="mi-work-slot-status" data-work-slot-status aria-live="polite"><\/span>/);
  // 인라인 핸들러를 쓰지 않는다(CSP script-src-attr 'none').
  assert.equal(/\son(?:click|change|input|submit|focus|blur|keydown|keyup)\s*=/i.test(workViewMarkup.slice(workViewMarkup.indexOf("data-work-slot-form"))), false);

  // 토큰만 쓰고 새 색을 만들지 않는다.
  assert.match(source, /#mi-admin \.mi-work-slot \{[\s\S]{0,260}border: 1px solid var\(--line\);[\s\S]{0,120}background: var\(--mi-panel\);/);
  assert.match(source, /#mi-admin \.mi-work-slot-status\.is-ok \{\s*color: var\(--mi-green\);/);
  assert.match(source, /#mi-admin \.mi-work-slot-status\.is-warn \{\s*color: var\(--mi-orange\);/);
});

test("slot helper is representative-only and the toggle drives aria-expanded", () => {
  assert.match(workSlotScopeSource, /slotToggle\.hidden = secureSession\.role !== "owner";/);
  assert.match(workSlotScopeSource, /if \(slotForm && secureSession\.role !== "owner"\) \{\s*slotForm\.hidden = true;/);
  assert.match(workSlotScopeSource, /slotToggle\.setAttribute\("aria-expanded", "false"\)/);

  assert.match(workSlotBindingSource, /var opening = workSlotForm\.hidden;\s*workSlotForm\.hidden = !opening;\s*workSlotToggle\.setAttribute\("aria-expanded", opening \? "true" : "false"\);/);
  // 처음 펼치면 오늘 날짜를 채워 두고 첫 입력으로 포커스를 옮긴다.
  assert.match(workSlotBindingSource, /if \(startInput && !startInput\.value\) startInput\.value = workDateKey\(new Date\(\)\);/);
  assert.match(workSlotBindingSource, /if \(siteInput\) siteInput\.focus\(\);/);
  assert.match(workSlotBindingSource, /workSlotForm\.addEventListener\("submit", function \(event\) \{\s*event\.preventDefault\(\);\s*submitWorkSlotSchedule\(\);/);
});

test("slot helper reuses the existing work item creation path for two all-day events", () => {
  // 대표실 일정 초안 저장과 같은 경로다: requestWorkItems("POST", workItemPayload(...)).
  const posts = workSlotSubmitSource.match(/await requestWorkItems\("POST", workSlotItemPayload\(/g) || [];
  assert.equal(posts.length, 2, "슬롯 등록은 기존 생성 경로로 2건을 보낸다");
  assert.equal(workSlotSubmitSource.includes("fetch("), false, "새 API 호출을 만들지 않는다");
  assert.match(workSlotPayloadSource, /var payload = workItemPayload\(\{[\s\S]{0,200}isAllDay: true\s*\}\);/);

  // A: 기간 종일 일정(시작일~종료일). 기존 경로가 종일 기간을 그대로 지원한다.
  assert.match(workSlotSubmitSource, /workSlotItemPayload\(plan\.slotTitle, plan\.startKey, plan\.endKey\)/);
  // B: 연장 결정 알림 — 하루짜리 종일 일정.
  assert.match(workSlotSubmitSource, /workSlotItemPayload\(plan\.decisionTitle, plan\.decisionKey, plan\.decisionKey\)/);
});

test("slot events are pinned to the dialog palette yellow (google event colour 5 · banana)", () => {
  // 노란색은 구글 이벤트 팔레트 id "5"(Banana · 바나나)다. 서버 표를 그대로 확인한다.
  const yellow = EVENT_COLOR_PALETTE.find((entry) => entry.id === "5");
  assert.ok(yellow, "이벤트 팔레트에 id 5 가 있어야 한다");
  assert.equal(yellow.name, "Banana");
  assert.equal(yellow.nameKo, "바나나");
  assert.equal(yellow.modern, "#f6bf26");
  // 다이얼로그 스와치와 같은 표를 쓰므로 노란색 스와치가 실제로 존재한다.
  assert.ok(EVENT_COLOR_DISPLAY_ORDER.includes("5"));

  assert.match(source, /var WORK_SLOT_COLOR_ID = "5";/);
  // 다이얼로그(workFormPayload)와 같은 필드 이름·같은 연동 조건으로 나간다.
  assert.match(formPayloadSource, /payload\.colorId = workEventColorDraft;/);
  assert.match(workSlotPayloadSource, /if \(workGoogleConnected\(\)\) payload\.colorId = WORK_SLOT_COLOR_ID;/);
  // 미연동 분기는 색 필드를 보내지 않는다는 기존 계약을 슬롯도 지킨다.
  assert.equal(/payload\.colorId = WORK_SLOT_COLOR_ID;\s*\n\s*return payload;/.test(workSlotPayloadSource), true);
});

test("slot helper reports success, server messages and partial failure honestly", () => {
  assert.match(workSlotSubmitSource, /setWorkSlotStatus\("슬롯 일정 2건을 등록했습니다 — 구글 캘린더에 곧 반영됩니다", "ok"\)/);
  // 실패 문구는 서버 message 를 그대로 싣는다.
  const serverMessagePassthrough = workSlotSubmitSource.match(/error && error\.message \? error\.message : "등록에 실패했습니다\."/g) || [];
  assert.equal(serverMessagePassthrough.length, 2);
  // 한 건만 성공해도 합쳐서 성공이라고 말하지 않는다.
  assert.match(workSlotSubmitSource, /created \? "2건 중 " \+ created \+ "건만 등록했습니다\. " : "2건 모두 등록하지 못했습니다\. "/);
  assert.match(workSlotSubmitSource, /if \(created\) await loadWorkItems\(\);/);
  assert.match(source, /function setWorkSlotStatus\(message, state\)[\s\S]{0,420}classList\.toggle\("is-warn", Boolean\(message\) && state === "warn"\)/);
});

test("slot dates cover month end, leap day, year rollover and the D-1 clamp", () => {
  const base = slotPlan("프라다", "거보 10슬롯", "2026-09-01", 30);
  assert.equal(base.ok, true);
  assert.equal(base.endKey, "2026-09-30");
  assert.equal(base.decisionKey, "2026-09-29");
  assert.equal(base.slotTitle, "[프라다] 거보 10슬롯 슬롯");
  assert.equal(base.decisionTitle, "[프라다] 거보 10슬롯 연장 결정 (종료 D-1)");

  // 월말 넘김: 1월 31일 + 30일 = 3월 1일(2026 년은 평년) → D-1 은 2월 28일.
  const monthEnd = slotPlan("프라다", "거보 10슬롯", "2026-01-31", 30);
  assert.equal(monthEnd.endKey, "2026-03-01");
  assert.equal(monthEnd.decisionKey, "2026-02-28");

  // 윤년: 2028 년 2 월은 29 일까지라 2월 1일 + 30일 = 3월 1일, D-1 은 윤일(2월 29일)이다.
  const leap = slotPlan("프라다", "거보 10슬롯", "2028-02-01", 30);
  assert.equal(leap.endKey, "2028-03-01");
  assert.equal(leap.decisionKey, "2028-02-29");

  // 윤일 시작 + 1일 → 같은 날 종료, D-1 은 시작일보다 앞서므로 시작일로 보정.
  const leapDay = slotPlan("프라다", "거보 10슬롯", "2028-02-29", 1);
  assert.equal(leapDay.endKey, "2028-02-29");
  assert.equal(leapDay.decisionKey, "2028-02-29");

  // 연도 넘김.
  const yearRoll = slotPlan("프라다", "거보 10슬롯", "2026-12-20", 30);
  assert.equal(yearRoll.endKey, "2027-01-18");
  assert.equal(yearRoll.decisionKey, "2027-01-17");
  // 해가 바뀌는 지점에서도 보정은 시작일을 넘지 않는다(1월 1일 하루짜리).
  assert.equal(slotPlan("프라다", "거보 10슬롯", "2027-01-01", 1).decisionKey, "2027-01-01");

  // 상한 365 일.
  const full = slotPlan("프라다", "거보 10슬롯", "2027-01-01", 365);
  assert.equal(full.endKey, "2027-12-31");
  assert.equal(full.decisionKey, "2027-12-30");

  // D-1 보정 경계: 1일이면 종료일 하루 전이 시작일보다 앞서 시작일로 끌어올리고,
  // 2일이면 마침 시작일과 같아지며, 3일부터 시작일 다음 날로 떨어진다.
  assert.equal(slotPlan("프라다", "거보 10슬롯", "2026-09-01", 1).decisionKey, "2026-09-01");
  assert.equal(slotPlan("프라다", "거보 10슬롯", "2026-09-01", 2).decisionKey, "2026-09-01");
  assert.equal(slotPlan("프라다", "거보 10슬롯", "2026-09-01", 3).decisionKey, "2026-09-02");
  // 종료일 자체는 보정과 무관하게 시작일 + 일수 - 1 이다.
  assert.equal(slotPlan("프라다", "거보 10슬롯", "2026-09-01", 1).endKey, "2026-09-01");
  assert.equal(slotPlan("프라다", "거보 10슬롯", "2026-09-01", 2).endKey, "2026-09-02");
  assert.equal(slotPlan("프라다", "거보 10슬롯", "2026-09-01", 3).endKey, "2026-09-03");
});

test("slot plan refuses missing names, impossible dates and out-of-range spans", () => {
  assert.deepEqual(slotPlan("", "거보 10슬롯", "2026-09-01", 30), { ok: false, message: "사이트명을 입력해주세요." });
  assert.deepEqual(slotPlan("프라다", "  ", "2026-09-01", 30), { ok: false, message: "업체/수량을 입력해주세요." });
  // 달력에 없는 날짜는 3월 2일로 굴러가지 않고 그대로 거절된다.
  assert.deepEqual(slotPlan("프라다", "거보 10슬롯", "2026-02-30", 30), { ok: false, message: "시작일을 확인해주세요." });
  assert.deepEqual(slotPlan("프라다", "거보 10슬롯", "", 30), { ok: false, message: "시작일을 확인해주세요." });
  for (const days of [0, -1, 366, "", "abc"]) {
    assert.deepEqual(
      slotPlan("프라다", "거보 10슬롯", "2026-09-01", days),
      { ok: false, message: "일수는 1~365 사이로 입력해주세요." },
      `일수 ${JSON.stringify(days)} 는 거절한다`
    );
  }
  // 소수는 잘라서 판정한다(30.9 → 30일).
  assert.equal(slotPlan("프라다", "거보 10슬롯", "2026-09-01", 30.9).endKey, "2026-09-30");
});

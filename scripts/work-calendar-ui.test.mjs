import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

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

test("representative schedule is a wide personal calendar without list or sharing controls", () => {
  assert.ok(workViewStart >= 0 && editorStart > workViewStart, "representative schedule markup must exist");
  assert.match(source, /#mi-admin \.mi-work-layout\s*\{[\s\S]{0,180}grid-template-columns:\s*minmax\(0,\s*7fr\)\s+minmax\(280px,\s*3fr\);[\s\S]{0,100}align-items:\s*start/);
  assert.match(source, /@media \(max-width: 1180px\)[\s\S]{0,180}\.mi-work-layout\s*\{\s*grid-template-columns:\s*1fr;[\s\S]{0,120}\.mi-work-agenda-card\s*\{\s*grid-column:\s*auto;/);

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
  assert.match(source, /requestWorkItems\("DELETE", \{ id: id, expectedUpdatedAt: expectedUpdatedAt \}\)/);
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

  // 반복 인스턴스 수정 범위.
  assert.match(editorMarkup, /data-work-recurrence-summary/);
  assert.match(editorMarkup, /data-work-recurrence-scope[^>]*checked[\s\S]{0,60}이 일정만/);
  assert.match(editorMarkup, /value="all" data-work-recurrence-scope[\s\S]{0,60}모든 일정/);
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
  assert.match(deleteHandlerSource, /requestWorkItems\("DELETE", \{ id: id, expectedUpdatedAt: expectedUpdatedAt \}\)/);
  const catchBlock = deleteHandlerSource.slice(deleteHandlerSource.indexOf("} catch (error) {"));
  assert.match(catchBlock, /setWorkStatus\(error\.message \|\| "업무를 삭제하지 못했습니다\.", "warn"\)/);
  assert.equal(catchBlock.includes("closeWorkDialog()"), false, "삭제 실패는 다이얼로그를 닫지 않는다");
  assert.equal(catchBlock.includes("loadWorkItems()"), false, "삭제 실패는 목록을 다시 읽지 않는다");
  assert.match(editorMarkup, /data-work-dialog-status[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(source, /function setWorkDialogStatus\(message, state\)/);
  assert.match(source, /function setWorkStatus\(message, state\)[\s\S]{0,480}if \(modal && !modal\.hidden\) setWorkDialogStatus\(message, state\)/);
  assert.match(source, /function closeWorkDialog\(\)[\s\S]{0,200}setWorkDialogStatus\(""/);
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
  assert.match(source, /#mi-admin \.mi-work-body\.has-gcal-rail \{\s*grid-template-columns: minmax\(0, 232px\) minmax\(0, 1fr\);/);
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
  assert.match(source, /var chipColor = workGcalColor\(item\.calendarColor\);[\s\S]{0,420}\(chipColor \? ' data-gcal="1" style="--mi-gcal-color:' \+ chipColor \+ '"' : ""\)/);
  assert.match(source, /var rowColor = workGcalColor\(item\.calendarColor\);[\s\S]{0,420}\(rowColor \? ' data-gcal="1" style="--mi-gcal-color:' \+ rowColor \+ '"' : ""\)/);
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

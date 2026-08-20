import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/pages/admin.html", import.meta.url), "utf8");
const workViewStart = source.indexOf('<section class="mi-view mi-work-shell"');
const editorStart = source.indexOf('<div class="mi-work-modal" data-work-modal', workViewStart);
const moveDialogStart = source.indexOf('<div class="mi-work-modal" data-work-move-modal', editorStart);
const workViewMarkup = source.slice(workViewStart, editorStart);
const editorMarkup = source.slice(editorStart, moveDialogStart);

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
    "data-work-repeat-until",
    "data-work-public",
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
  assert.match(source, /calendarId:\s*""/);

  assert.match(source, /repeat:\s*repeatMonthly\s*\?\s*"monthly"\s*:\s*""/);
  assert.match(source, /!id\s*&&\s*repeatMonthly\s*&&\s*!workRepeatRequestId[\s\S]{0,100}crypto\.randomUUID\(\)/);
  assert.match(source, /requestId:\s*!id\s*&&\s*repeatMonthly\s*\?\s*workRepeatRequestId/);
  assert.match(source, /expectedUpdatedAt/);
  assert.match(source, /requestWorkItems\("DELETE", \{ id: id, expectedUpdatedAt: expectedUpdatedAt \}\)/);
  assert.match(source, /\.mi-work-modal\[data-work-modal\][\s\S]{0,220}justify-items:\s*end/);
  assert.match(source, /@media \(max-width: 760px\)[\s\S]*\.mi-work-editor-dialog/);
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

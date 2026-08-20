import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/pages/admin.html", import.meta.url), "utf8");

test("representative schedule exposes calendar lists and safe sharing controls", () => {
  for (const marker of [
    "data-work-calendar-list",
    "data-work-calendar-create",
    "data-work-calendar-filter=\"all\"",
    "data-work-calendar-filter=\"personal\"",
    "data-work-calendar-share",
    "data-work-calendar-invite-code",
    "data-work-calendar-join",
    "calendar-invite-create",
    "calendar-invite-accept",
    "calendar-leave"
  ]) assert.ok(source.includes(marker), `missing calendar UI contract: ${marker}`);

  assert.match(source, /workSelectedCalendarId\s*=\s*"all"/);
  assert.match(source, /item\.calendarId\s*\|\|\s*"personal"/);
  assert.match(source, /workCalendarColor/);
  assert.match(source, /value="navy"[\s\S]{0,500}value="slate"/);
  assert.match(source, /payload\.invite\s*&&\s*payload\.invite\.code/);
  assert.match(source, /calendar\.role === "owner" \|\| calendar\.role === "editor"/);
});

test("event editor is a responsive drawer with all-day and bounded monthly recurrence", () => {
  for (const marker of [
    "data-work-calendar-select",
    "data-work-all-day",
    "data-work-repeat-monthly",
    "data-work-repeat-until",
    "29~31일은 해당 월의 마지막 날",
    "각 일정은 개별 수정"
  ]) assert.ok(source.includes(marker), `missing editor contract: ${marker}`);

  assert.match(source, /repeat:\s*repeatMonthly\s*\?\s*"monthly"\s*:\s*""/);
  assert.match(source, /!id\s*&&\s*repeatMonthly\s*&&\s*!workRepeatRequestId[\s\S]{0,100}crypto\.randomUUID\(\)/);
  assert.match(source, /requestId:\s*!id\s*&&\s*repeatMonthly\s*\?\s*workRepeatRequestId/);
  assert.match(source, /expectedUpdatedAt/);
  assert.match(source, /calendarSelect\.disabled\s*=\s*Boolean\(item\)/);
  assert.match(source, /requestWorkItems\("DELETE", \{ id: id, expectedUpdatedAt: expectedUpdatedAt \}\)/);
  assert.match(source, /sharedCalendar[\s\S]{0,220}toggle\.disabled/);
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

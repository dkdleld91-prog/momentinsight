import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CALENDAR_COLORS,
  buildMonthlyOccurrences,
  calendarInviteDigest,
  createCalendarInviteCode,
  normalizeCalendarColor,
  normalizeCalendarName,
  normalizeInviteCode,
  seoulDateKey,
} from "./calendar-domain.mjs";

test("calendar names and colors are normalized against the public contract", () => {
  assert.equal(normalizeCalendarName("  모먼트   일정  "), "모먼트 일정");
  assert.equal(normalizeCalendarName("가".repeat(60)), "가".repeat(60));
  assert.throws(() => normalizeCalendarName("  "), /1~60자/);
  assert.throws(() => normalizeCalendarName("가".repeat(61)), /1~60자/);

  assert.deepEqual([...CALENDAR_COLORS], ["navy", "emerald", "amber", "rose", "violet", "sky", "slate"]);
  assert.equal(normalizeCalendarColor(" EMERALD "), "emerald");
  assert.throws(() => normalizeCalendarColor("red"), /색상/);
});

test("invite codes contain 128 random bits, remain base64url, and hash only normalized input", () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
  const code = createCalendarInviteCode((size) => {
    assert.equal(size, 16);
    return bytes;
  });

  assert.equal(code, "AAECAwQFBgcICQoLDA0ODw");
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(normalizeInviteCode(` \n${code.slice(0, 8)} ${code.slice(8)}\t`), code);
  assert.throws(() => normalizeInviteCode("short"), /초대 코드/);

  const expected = createHash("sha256").update(code, "utf8").digest("hex");
  assert.equal(calendarInviteDigest(` ${code} `), expected);
  assert.match(calendarInviteDigest(code), /^[a-f0-9]{64}$/);
});

test("monthly materialization uses Seoul local time, clamps month-end, and keeps duration", () => {
  const result = buildMonthlyOccurrences({
    startsAt: "2026-01-31T01:30:00.000Z",
    endsAt: "2026-01-31T03:30:00.000Z",
    repeatUntil: "2026-04-30",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [
    { occurrenceOn: "2026-01-31", startsAt: "2026-01-31T01:30:00.000Z", endsAt: "2026-01-31T03:30:00.000Z" },
    { occurrenceOn: "2026-02-28", startsAt: "2026-02-28T01:30:00.000Z", endsAt: "2026-02-28T03:30:00.000Z" },
    { occurrenceOn: "2026-03-31", startsAt: "2026-03-31T01:30:00.000Z", endsAt: "2026-03-31T03:30:00.000Z" },
    { occurrenceOn: "2026-04-30", startsAt: "2026-04-30T01:30:00.000Z", endsAt: "2026-04-30T03:30:00.000Z" },
  ]);
});

test("monthly materialization includes the end date and handles leap-day recurrence", () => {
  const result = buildMonthlyOccurrences({
    startsAt: "2028-01-31T01:00:00.000Z",
    endsAt: null,
    repeatUntil: "2028-02-29",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [
    { occurrenceOn: "2028-01-31", startsAt: "2028-01-31T01:00:00.000Z", endsAt: null },
    { occurrenceOn: "2028-02-29", startsAt: "2028-02-29T01:00:00.000Z", endsAt: null },
  ]);
});

test("monthly no-end mode materializes an explicit safe 60-occurrence horizon", () => {
  const result = buildMonthlyOccurrences({
    startsAt: "2026-01-31T01:30:00.000Z",
    endsAt: "2026-01-31T03:30:00.000Z",
    repeatNoEnd: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.length, 60);
  assert.deepEqual(result.value[0], {
    occurrenceOn: "2026-01-31",
    startsAt: "2026-01-31T01:30:00.000Z",
    endsAt: "2026-01-31T03:30:00.000Z",
  });
  assert.deepEqual(result.value.at(-1), {
    occurrenceOn: "2030-12-31",
    startsAt: "2030-12-31T01:30:00.000Z",
    endsAt: "2030-12-31T03:30:00.000Z",
  });
  assert.deepEqual(buildMonthlyOccurrences({
    startsAt: "2026-01-31T01:30:00.000Z",
    repeatNoEnd: true,
    repeatUntil: "2027-01-31",
  }), { ok: false, status: 400, message: "종료 예정 없음과 반복 종료일을 함께 설정할 수 없습니다." });
});

test("monthly materialization rejects invalid, unbounded, reversed, and oversized series", () => {
  assert.equal(buildMonthlyOccurrences({ startsAt: null, repeatUntil: "1970-02-01" }).ok, false);
  assert.deepEqual(
    buildMonthlyOccurrences({ startsAt: "bad", repeatUntil: "2026-02-01" }),
    { ok: false, status: 400, message: "반복 일정의 시작 일시를 확인해주세요." },
  );
  assert.deepEqual(
    buildMonthlyOccurrences({ startsAt: "2026-01-01T00:00:00.000Z" }),
    { ok: false, status: 400, message: "반복 종료일을 입력해주세요." },
  );
  assert.equal(buildMonthlyOccurrences({
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2025-12-31T23:00:00.000Z",
    repeatUntil: "2026-02-01",
  }).ok, false);
  assert.equal(buildMonthlyOccurrences({
    startsAt: "2026-01-01T00:00:00.000Z",
    repeatUntil: "2031-01-02",
  }).ok, false);
  assert.deepEqual(buildMonthlyOccurrences({
    startsAt: "2026-01-01T00:00:00.000Z",
    repeatUntil: "2026-06-01",
    maxOccurrences: 5,
  }), { ok: false, status: 400, message: "반복 일정은 최대 5개까지 만들 수 있습니다." });
});

test("Seoul date keys are strict and never normalize impossible calendar dates", () => {
  assert.equal(seoulDateKey("2026-08-14T15:00:00.000Z"), "2026-08-15");
  assert.equal(seoulDateKey("2026-02-30"), "");
  assert.equal(seoulDateKey("not-a-date"), "");
});

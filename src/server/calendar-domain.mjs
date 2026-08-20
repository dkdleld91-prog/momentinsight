import { createHash, randomBytes } from "node:crypto";

export const CALENDAR_COLORS = Object.freeze([
  "navy",
  "emerald",
  "amber",
  "rose",
  "violet",
  "sky",
  "slate",
]);

const CALENDAR_COLOR_SET = new Set(CALENDAR_COLORS);
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SEOUL_OFFSET_HOURS = 9;
const DEFAULT_MAX_OCCURRENCES = 60;

function domainError(message) {
  return new RangeError(message);
}

export function normalizeCalendarName(value) {
  const name = String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
  const length = Array.from(name).length;
  if (length < 1 || length > 60) throw domainError("캘린더 이름은 1~60자로 입력해주세요.");
  return name;
}

export function normalizeCalendarColor(value) {
  const color = String(value ?? "").trim().toLowerCase();
  if (!CALENDAR_COLOR_SET.has(color)) throw domainError("지원하지 않는 캘린더 색상입니다.");
  return color;
}

export function normalizeInviteCode(value) {
  const code = String(value ?? "").replace(/\s+/gu, "");
  if (!INVITE_CODE_PATTERN.test(code)) throw domainError("초대 코드를 확인해주세요.");
  return code;
}

export function createCalendarInviteCode(randomBytesFn = randomBytes) {
  const entropy = randomBytesFn(16);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) {
    throw new TypeError("초대 코드 생성기는 정확히 128비트를 반환해야 합니다.");
  }
  return Buffer.from(entropy).toString("base64url");
}

export function calendarInviteDigest(value) {
  return createHash("sha256").update(normalizeInviteCode(value), "utf8").digest("hex");
}

function invalid(message) {
  return { ok: false, status: 400, message };
}

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day, value: `${match[1]}-${match[2]}-${match[3]}` };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

function dateOnly(year, month, day) {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function hasValidCalendarDatePrefix(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[Tt])/u.exec(String(value ?? ""));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function seoulParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { ...values, millisecond: date.getUTCMilliseconds() };
}

function seoulTimeToIso(year, month, day, time) {
  return new Date(Date.UTC(
    year,
    month - 1,
    day,
    time.hour - SEOUL_OFFSET_HOURS,
    time.minute,
    time.second,
    time.millisecond,
  )).toISOString();
}

export function seoulDateKey(value) {
  if (!hasValidCalendarDatePrefix(value)) return "";
  const parsed = validDate(value);
  if (!parsed) return "";
  const parts = seoulParts(parsed);
  return dateOnly(parts.year, parts.month, parts.day);
}

export function buildMonthlyOccurrences({
  startsAt,
  endsAt = null,
  repeatUntil,
  repeatNoEnd = false,
  maxOccurrences = DEFAULT_MAX_OCCURRENCES,
} = {}) {
  const start = validDate(startsAt);
  if (!start) return invalid("반복 일정의 시작 일시를 확인해주세요.");

  let duration = null;
  if (endsAt !== null && endsAt !== undefined && endsAt !== "") {
    const end = validDate(endsAt);
    if (!end) return invalid("반복 일정의 종료 일시를 확인해주세요.");
    duration = end.getTime() - start.getTime();
    if (duration < 0) return invalid("종료 일시는 시작 일시보다 빠를 수 없습니다.");
  }

  if (typeof repeatNoEnd !== "boolean") {
    return invalid("반복 종료 방식을 확인해주세요.");
  }
  if (repeatNoEnd && repeatUntil !== null && repeatUntil !== undefined && repeatUntil !== "") {
    return invalid("종료 예정 없음과 반복 종료일을 함께 설정할 수 없습니다.");
  }
  if (!repeatNoEnd && (repeatUntil === null || repeatUntil === undefined || repeatUntil === "")) {
    return invalid("반복 종료일을 입력해주세요.");
  }
  const until = repeatNoEnd ? null : parseDateOnly(repeatUntil);
  if (!repeatNoEnd && !until) return invalid("반복 종료일을 확인해주세요.");
  if (!Number.isInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > DEFAULT_MAX_OCCURRENCES) {
    return invalid("반복 일정 수 제한을 확인해주세요.");
  }

  const localStart = seoulParts(start);
  const firstOn = dateOnly(localStart.year, localStart.month, localStart.day);
  if (until && until.value < firstOn) return invalid("반복 종료일은 시작일보다 빠를 수 없습니다.");

  const fiveYearDay = Math.min(localStart.day, daysInMonth(localStart.year + 5, localStart.month));
  const latestUntil = dateOnly(localStart.year + 5, localStart.month, fiveYearDay);
  if (until && until.value > latestUntil) return invalid("반복 일정은 시작일로부터 5년 이내로 설정해주세요.");

  const occurrences = [];
  let year = localStart.year;
  let month = localStart.month;
  while (true) {
    const day = Math.min(localStart.day, daysInMonth(year, month));
    const occurrenceOn = dateOnly(year, month, day);
    if (until && occurrenceOn > until.value) break;

    const occurrenceStart = seoulTimeToIso(year, month, day, localStart);
    occurrences.push({
      occurrenceOn,
      startsAt: occurrenceStart,
      endsAt: duration === null ? null : new Date(new Date(occurrenceStart).getTime() + duration).toISOString(),
    });
    if (repeatNoEnd && occurrences.length === maxOccurrences) break;
    if (occurrences.length > maxOccurrences) {
      return invalid(`반복 일정은 최대 ${maxOccurrences}개까지 만들 수 있습니다.`);
    }

    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }

  return { ok: true, value: occurrences };
}

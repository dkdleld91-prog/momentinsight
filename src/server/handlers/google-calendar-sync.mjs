import { createHash } from "node:crypto";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { seoulDateKey } from "../calendar-domain.mjs";
import {
  DEDICATED_CALENDAR_SUMMARY,
  DONE_PREFIX,
  EVENT_TIMEZONE,
  MAX_ATTENDEES,
  MAX_RECURRENCE_LINES,
  MAX_RECURRENCE_LINE_CHARS,
  buildGoogleEventPayload,
  cleanText,
  isAttendeeEmail,
  clientDisplayName,
  conferenceUriFromEvent,
  decorateGoogleSummary,
  googleFetch,
  googleOauthConfig,
  isEventColorId,
  loadOwnerGoogleIntegration,
  modernCalendarColor,
  normalizeCode,
  normalizeImportedTitle,
  readableTextColor,
  refreshAccessToken,
  seriesAnchorTimes,
  undecorateGoogleSummary,
} from "../google-calendar-client.mjs";

// 구글 캘린더 양방향 동기화 엔진.
//
// 루프 차단은 3중이다.
//  (1) 구조: inbound 쓰기는 이 모듈만 수행하고 이 모듈은 work-items 의 PATCH
//      경로를 타지 않는다. "inbound -> outbound" 코드 경로가 존재하지 않는다.
//  (2) 버전: 구글이 준 updated 를 그대로 저장해 두고, 그보다 새롭지 않은
//      inbound 는 우리가 쓴 메아리로 보고 버린다.
//  (3) 순서: 한 실행에서 push 를 먼저, pull 을 나중에 해서 같은 실행 안에
//      우리 쓰기가 (2)로 흡수되게 한다.

export const WINDOW_PAST_DAYS = 30;
export const WINDOW_FUTURE_DAYS = 365;
export const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
// full 승격 시각을 계정마다 흩뿌리는 폭. 계정 하나에 캘린더가 여러 개이므로
// 같은 날 연결한 계정들이 매일 같은 시각에 일제히 full 로 승격되면 그 순간
// 프로젝트 전체의 분당 요청 한도를 넘겨 전 계정이 함께 403 을 맞는다.
export const FULL_SYNC_JITTER_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_MAX_PAGES = 10;
export const DEFAULT_PAGE_SIZE = 250;
export const DEFAULT_PUSH_LIMIT = 50;
export const DEFAULT_PUSH_CONCURRENCY = 6;
export const DEFAULT_BUDGET_MS = 20000;
export const IMPORTED_SCHEDULE_TYPE = "meeting";
export const MAX_EXTRA_CALENDARS = 8;
export const EXTRA_CALENDAR_SCAN_LIMIT = 500;
export const MAX_CALENDAR_CATALOG = 250;
export const MAX_INSTANCE_PAGES = 3;
export const MAX_INSTANCE_PAGE_SIZE = 250;
// 한 실행이 도는 캘린더 수와 훑는 이벤트 수의 상한. 카탈로그 전체(읽기 전용
// 공휴일·공유 캘린더 포함)를 동기화 대상에 올리기 시작했으므로, 한 번의 실행이
// 무한정 길어지지 않도록 여기서 묶는다. 남은 몫은 다음 실행이 이어받는다.
export const MAX_SYNC_CALENDARS = 25;
export const MAX_FULL_SYNC_EVENTS = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SYNC_ROW_COLUMNS = [
  "id", "owner_agency_code", "client_id", "operation_team_id", "calendar_id",
  "title", "status", "starts_at", "ends_at", "is_all_day",
  "series_id", "occurrence_on", "recurrence_until",
  "google_event_id", "google_calendar_id", "google_etag", "google_updated_at",
  "google_source", "google_sync_state", "updated_at",
  "google_recurring_event_id", "google_recurrence", "google_conference_uri", "google_calendar_name",
  "google_color_id",
  "personal_role", "personal_code",
];

const CALENDAR_SYNC_COLUMNS = [
  "owner_agency_code", "google_calendar_id", "calendar_role", "sync_token",
  "full_sync_page_token", "window_start", "window_end",
  "last_synced_at", "last_full_sync_at", "last_error", "last_error_at",
];

// ─────────────────────────────────────────────────────────────
// 선택 열 우아한 저하 (배포 순서 안전장치)
//
// 코드가 먼저 배포되고 마이그레이션이 나중에 적용되는 창이 반드시 생긴다.
// 그 창에서 없는 열을 읽거나 쓰면 Postgres 는 42703, PostgREST 는 PGRST204 를
// 돌려주고, 그것을 그대로 올리면 대표님 화면은 500 이 된다. 여기서는 그 신호를
// 잡아 해당 열을 프로세스 전역에서 내려두고 한 번만 재시도한다.
// ─────────────────────────────────────────────────────────────
export const OPTIONAL_SCHEDULE_COLUMNS = ["google_recurrence", "google_conference_uri", "google_calendar_name"];
export const OPTIONAL_CALENDAR_SYNC_COLUMNS = [
  "calendar_summary", "calendar_access_role", "calendar_is_primary", "calendar_writable", "calendar_catalog_at",
];
// 사이드바(캘린더 목록) 마이그레이션이 더한 열. 위 묶음과 다른 마이그레이션이라
// 따로 둔다 — 둘 중 하나만 적용된 창에서도 각자 독립적으로 내려가야 한다.
export const OPTIONAL_CALENDAR_CATALOG_COLUMNS = [
  "calendar_background_color", "calendar_foreground_color", "calendar_selected", "calendar_visible",
];
// 일정별 색(google_color_id)을 더한 마이그레이션. 위 두 묶음과 또 다른
// 마이그레이션이므로 자기 묶음으로 둔다 — 색만 아직 없는 창에서 일정 상세
// 열까지 함께 내려가면 참석자·반복 요약이 이유 없이 사라진다.
export const OPTIONAL_EVENT_COLOR_COLUMNS = ["google_color_id"];
// 개인 캘린더(personal principal key) 마이그레이션이 더한 열. 또 다른
// 마이그레이션이므로 자기 묶음으로 둔다 — 이 두 열만 아직 없는 창에서 색이나
// 일정 상세 열까지 함께 내려가면 아무 관계 없는 화면이 같이 망가진다.
export const OPTIONAL_PERSONAL_COLUMNS = ["personal_role", "personal_code"];
// schedule_items 질의 하나가 두 마이그레이션의 선택 열을 함께 싣는다. 그래서
// 이 표를 기본 묶음으로 넘기고, 아래 강등 로직이 "오류가 지목한 열"의 묶음만
// 골라 내린다. 어느 쪽이 없든 나머지 한 묶음은 그대로 살아 있다.
export const OPTIONAL_SCHEDULE_GROUPS = [
  ...OPTIONAL_SCHEDULE_COLUMNS,
  ...OPTIONAL_EVENT_COLOR_COLUMNS,
  ...OPTIONAL_PERSONAL_COLUMNS,
];

// calendarList.accessRole 은 읽기 전용 필드이고 값은 이 다섯 중 하나다.
// freeBusyReader / reader / writerWithoutPrivateAccess / writer / owner.
// writerWithoutPrivateAccess 도 이벤트 읽기·쓰기 권한을 준다(비공개 일정만 못 본다).
export const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer", "writerWithoutPrivateAccess"]);
// "확인된 읽기 전용" 만 담는다. writable 의 여집합이 아니다 — 그것이 요점이다.
// resolveOwnerCalendars 가 새로 만든 행은 calendar_access_role 이 null 이고
// calendar_writable 이 열 기본값 false 라, 여집합으로 잠그면 처음 보는 캘린더의
// 일정이 전부 403 이 된다(운영에서 "삭제가 막힌다" 로 나타난 그 사고다).
export const READ_ONLY_ACCESS_ROLES = new Set(["reader", "freeBusyReader"]);

// 강등은 영구가 아니라 만료된다.
//
// 예전 구현은 열 이름을 담는 프로세스 전역 Set 하나였고, 한 번 들어간 열은
// 프로세스가 죽을 때까지 나오지 못했다. 마이그레이션 적용 전에 트래픽을 받은
// Vercel 람다는 그 뒤 SQL 이 들어와도 계속 열을 뺀 채로 질의해서, 대표님
// 화면에는 캘린더 색이 영영 없고 calendar-visibility 는 503(calendar_catalog_missing)
// 을 계속 냈으며, 되돌리는 방법이 재배포뿐이었다. 이번 운영 사고의 근본 원인이다.
//
// 그래서 상태를 "묶음 -> 내려간 시각" 으로 들고, TTL 이 지나면 스스로 다시 올려
// 다음 질의가 열을 싣게 한다. 열이 여전히 없으면 아래 강등 경로가 다시 내리며
// 타이머만 새로 감기므로 재프로브는 TTL 당 한 번으로 묶인다(플래핑 없음).
export const OPTIONAL_COLUMN_RETRY_MS = 90000;

// 시계는 주입 가능해야 한다 — 테스트가 90초를 실제로 기다릴 수 없고, 가짜
// 타이머는 이 파일이 쓰는 Date.now 를 전부 흔들어 부작용이 너무 크다.
const DEFAULT_OPTIONAL_COLUMN_CLOCK = () => Date.now();
let optionalColumnClock = DEFAULT_OPTIONAL_COLUMN_CLOCK;

export function setOptionalColumnClock(clock) {
  optionalColumnClock = typeof clock === "function" ? clock : DEFAULT_OPTIONAL_COLUMN_CLOCK;
}

function optionalColumnNow() {
  const at = Number(optionalColumnClock());
  return Number.isFinite(at) ? at : Date.now();
}

// 상태의 단위는 열이 아니라 "묶음"이다. 한 묶음은 한 마이그레이션에서 함께
// 생기므로 함께 내려가고 함께 만료되어야 하고, 다른 마이그레이션에서 온 묶음의
// 타이머는 절대 건드리면 안 된다. 한 열은 정확히 한 묶음에만 속한다.
const optionalColumnGroups = new Map();     // groupKey -> 열 이름 배열
const optionalGroupKeyByColumn = new Map(); // 열 이름 -> groupKey
const optionalGroupDemotedAt = new Map();   // groupKey -> 내려간 시각(ms)

function registerOptionalColumnGroup(key, columns) {
  optionalColumnGroups.set(key, columns);
  for (const column of columns) optionalGroupKeyByColumn.set(column, key);
  return key;
}

registerOptionalColumnGroup("schedule", OPTIONAL_SCHEDULE_COLUMNS);
registerOptionalColumnGroup("calendar_sync", OPTIONAL_CALENDAR_SYNC_COLUMNS);
registerOptionalColumnGroup("calendar_catalog", OPTIONAL_CALENDAR_CATALOG_COLUMNS);
registerOptionalColumnGroup("event_color", OPTIONAL_EVENT_COLOR_COLUMNS);
registerOptionalColumnGroup("personal", OPTIONAL_PERSONAL_COLUMNS);

// 호출부가 내용이 같은 새 배열을 넘겨도 같은 묶음으로 봐야 타이머가 하나로
// 유지된다. 등록된 열 이름으로 되짚고, 처음 보는 묶음이면 그 자리에서 등록한다.
function optionalGroupKey(group) {
  const columns = (Array.isArray(group) ? group : [group]).map((column) => cleanText(column)).filter(Boolean);
  for (const column of columns) {
    const key = optionalGroupKeyByColumn.get(column);
    if (key) return key;
  }
  if (!columns.length) return "";
  return registerOptionalColumnGroup(`adhoc:${[...columns].sort().join(",")}`, columns);
}

// 읽는 김에 만료시킨다(lazy expiry). 타이머도 스케줄러도 필요 없고, 서버리스
// 처럼 언제 깨어날지 모르는 실행 모델에서도 항상 옳다.
function optionalGroupDemoted(key) {
  if (!key) return false;
  const at = optionalGroupDemotedAt.get(key);
  if (at === undefined) return false;
  if (optionalColumnNow() - at >= OPTIONAL_COLUMN_RETRY_MS) {
    optionalGroupDemotedAt.delete(key);
    return false;
  }
  return true;
}

function demotedColumnSet() {
  const columns = new Set();
  for (const key of [...optionalGroupDemotedAt.keys()]) {
    if (!optionalGroupDemoted(key)) continue;
    for (const column of optionalColumnGroups.get(key) || []) columns.add(column);
  }
  return columns;
}

// 강등 상태와 주입한 시계를 모두 기본값으로 되돌린다(테스트의 finally 용).
export function resetOptionalColumns() {
  optionalGroupDemotedAt.clear();
  optionalColumnClock = DEFAULT_OPTIONAL_COLUMN_CLOCK;
}

// 지금 내려가 있는 "열 이름" 의 평평한 배열. 호출부 계약은 예전과 같다.
export function disabledOptionalColumns() {
  return [...demotedColumnSet()];
}

export function optionalColumnEnabled(column) {
  return !optionalGroupDemoted(optionalGroupKeyByColumn.get(cleanText(column)));
}

// 한 묶음의 열은 같은 마이그레이션에서 함께 생긴다. 그중 하나가 없다면 나머지도
// 없다고 보는 편이 맞고, 열 이름을 하나씩 떼어내며 여러 번 재시도하지 않아도 된다.
//
// 이미 내려가 있는 묶음이면 false 를 돌려 재시도를 막는다 — 열을 이미 뺀 질의가
// 같은 오류를 냈다면 원인은 다른 곳이다. 그때 타이머를 다시 감지 않는 것도
// 의도다. 실패가 잦은 프로세스에서 재프로브가 영원히 미뤄지면 TTL 이 무의미해진다.
//
// 한 호출부가 여러 묶음을 함께 넘길 수 있으므로(schedule_items 는 일정 묶음과
// 색 묶음을 같이 싣는다) "무엇이 없는가"를 최대한 좁혀 고른다. Postgres 42703
// 도 PostgREST PGRST204 도 없는 열 이름을 문구에 담아 주므로, 그 이름이 있으면
// 그 열의 묶음만 내린다. 이름이 없는 코드만 오면 아직 살아 있는 첫 묶음을
// 고른다 — 이미 내려간 묶음을 다시 집으면 재시도가 그 자리에서 멈춘다.
function demotionTargetKey(columns, named) {
  if (named) return optionalGroupKeyByColumn.get(cleanText(named)) || optionalGroupKey(columns);
  for (const column of columns) {
    const key = optionalGroupKeyByColumn.get(cleanText(column));
    if (key && !optionalGroupDemoted(key)) return key;
  }
  return optionalGroupKey(columns);
}

export function disableOptionalColumns(error, group = OPTIONAL_SCHEDULE_GROUPS) {
  if (!error) return false;
  const code = cleanText(error.code).toUpperCase();
  const columns = Array.isArray(group) ? group : [group];
  const text = `${cleanText(error.message)} ${cleanText(error.details)} ${cleanText(error.hint)}`;
  const named = columns.find((column) => column && text.includes(column)) || "";
  if (!named && code !== "42703" && code !== "PGRST204") return false;
  const key = demotionTargetKey(columns, named);
  if (!key || optionalGroupDemoted(key)) return false;
  optionalGroupDemotedAt.set(key, optionalColumnNow());
  return true;
}

export function activeColumns(columns) {
  const demoted = demotedColumnSet();
  return (Array.isArray(columns) ? columns : String(columns).split(","))
    .map((column) => cleanText(column))
    .filter((column) => column && !demoted.has(column));
}

export function withoutDisabledColumns(values) {
  if (Array.isArray(values)) return values.map((entry) => withoutDisabledColumns(entry));
  if (!values || typeof values !== "object") return values;
  const demoted = demotedColumnSet();
  if (!demoted.size) return values;
  const copy = {};
  for (const [key, value] of Object.entries(values)) {
    if (demoted.has(key)) continue;
    copy[key] = value;
  }
  return copy;
}

// TTL 을 기다리지 않고 푸는 두 번째 길: 성공한 SELECT 가 그 열을 실제로 들고
// 왔다면 마이그레이션이 들어왔다는 확실한 증거다. 한 결과 안의 행 모양은 같으니
// 첫 객체 행 하나만 본다(묶음 3 × 열 4 = 최대 12번의 hasOwn).
function noteOptionalColumnEvidence(result) {
  if (!optionalGroupDemotedAt.size) return;
  const data = result?.data;
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const sample = rows.find((row) => row && typeof row === "object" && !Array.isArray(row));
  if (!sample) return;
  for (const key of [...optionalGroupDemotedAt.keys()]) {
    const columns = optionalColumnGroups.get(key) || [];
    if (columns.some((column) => Object.hasOwn(sample, column))) optionalGroupDemotedAt.delete(key);
  }
}

// run() 은 매번 열 목록과 페이로드를 다시 만들어야 한다. 시도가 "없는 열" 로
// 실패하면 그 묶음을 내리고 다시 부른다.
//
// 반복은 "이번에 새 묶음을 실제로 내렸을 때" 만 이어진다. disableOptionalColumns
// 는 이미 내려간 묶음에 false 를 돌려주므로 등록된 묶음 수만큼에서 반드시
// 멈추고, 한 묶음만 넘긴 호출부는 예전과 똑같이 정확히 한 번만 재시도한다.
// 두 마이그레이션의 열을 함께 싣는 질의만 두 번까지 물러난다.
// 질의 결과가 모두 이 한 곳을 지나므로, 위의 "열이 돌아왔다" 증거 확인도 여기서 건다.
export async function runWithOptionalColumns(run, group = OPTIONAL_SCHEDULE_GROUPS) {
  for (;;) {
    let result = null;
    try {
      result = await run();
    } catch (error) {
      if (!disableOptionalColumns(error, group)) throw error;
      continue;
    }
    if (!result?.error || !disableOptionalColumns(result.error, group)) {
      noteOptionalColumnEvidence(result);
      return result;
    }
  }
}

function syncRowFields() {
  return activeColumns(SYNC_ROW_COLUMNS).join(",");
}

// 체크를 꺼 둔 캘린더도 동기화 대상 결정에 쓰이므로 표시 여부를 함께 읽는다.
// 열이 아직 없으면 activeColumns 가 떼어내고 호출부가 한 번 재시도한다.
function calendarSyncFields() {
  return activeColumns([...CALENDAR_SYNC_COLUMNS, "calendar_visible"]).join(",");
}

// calendarList 의 backgroundColor / foregroundColor 는 "#0088aa" 꼴이다.
// 그 밖의 값은 열 제약(^#[0-9a-fA-F]{6}$)에 걸려 저장 자체를 실패시키므로
// 여기서 소문자 #rrggbb 로 정규화하고, 아니면 null 로 떨어뜨린다.
export function hexColor(value) {
  const text = cleanText(value, 20).toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(text)) return text;
  if (!/^#[0-9a-f]{3}$/u.test(text)) return null;
  return `#${text.slice(1).split("").map((digit) => digit + digit).join("")}`;
}

function primaryAgencyCode(env = process.env) {
  return normalizeCode(env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
}

// 계정별 full sync 주기. 대표님 코드만은 예전 그대로 정확히 24시간이다 —
// 그 하나의 계정에 맞춰 잡아 둔 기존 동작·테스트를 흔들 이유가 없다.
//
// 나머지 계정은 24시간에 계정키에서 뽑은 고정 오프셋(0~6시간)을 더해 승격
// 시각을 흩뿌린다. 같은 날 연결한 계정들은 last_full_sync_at 이 몇 분 안에
// 몰려 있어서, 주기가 모두 정확히 24시간이면 다음 날 같은 순간에 전부 full 로
// 올라간다. full 은 캘린더당 페이지를 끝까지 훑으므로 그 순간 구글 요청이
// 계정 수만큼 곱해져 프로젝트 분당 한도를 넘기고, 그러면 그날 승격된 계정이
// 다 함께 실패한다. 오프셋을 해시로 뽑는 이유는 재배포·재시작 뒤에도 같은
// 계정이 같은 자리를 지켜야 승격이 흩어진 상태로 유지되기 때문이다.
export function fullSyncIntervalMs(code, env = process.env) {
  const key = normalizeCode(code);
  if (!key || key === primaryAgencyCode(env)) return FULL_SYNC_INTERVAL_MS;
  const digest = createHash("sha256").update(key).digest();
  return FULL_SYNC_INTERVAL_MS + (digest.readUInt32BE(0) % FULL_SYNC_JITTER_MS);
}

function isUuid(value) {
  return UUID_PATTERN.test(cleanText(value).toLowerCase());
}

function eventsPath(calendarId, eventId = "") {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 (테스트의 중심)
// ─────────────────────────────────────────────────────────────

export function syncWindow(now = Date.now()) {
  return {
    timeMin: new Date(now - WINDOW_PAST_DAYS * DAY_MS).toISOString(),
    timeMax: new Date(now + WINDOW_FUTURE_DAYS * DAY_MS).toISOString(),
  };
}

export function eventInWindow(startsAt, window) {
  const at = new Date(cleanText(startsAt)).getTime();
  if (!Number.isFinite(at)) return false;
  return at >= new Date(window.timeMin).getTime() && at <= new Date(window.timeMax).getTime();
}

function seoulMidnightIso(dateKey, dayOffset = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(cleanText(dateKey));
  if (!match) return "";
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayOffset, -9);
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function isoOrEmpty(value) {
  const parsed = new Date(cleanText(value));
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

// 종일 일정의 end.date 는 배타적이다. MI 는 마지막 날을 포함으로 저장하므로
// 하루를 빼서 서울 자정으로 되돌린다. 하루짜리면 ends_at === starts_at 이 되고
// schedule_items_date_order(ends_at >= starts_at) 를 그대로 만족한다.
export function googleEventTimes(event = {}) {
  const start = event.start || {};
  const end = event.end || {};
  if (start.date) {
    const startsAt = seoulMidnightIso(start.date);
    if (!startsAt) return { ok: false };
    const endsAt = seoulMidnightIso(end.date, -1) || startsAt;
    return {
      ok: true,
      isAllDay: true,
      startsAt,
      endsAt: new Date(endsAt).getTime() < new Date(startsAt).getTime() ? startsAt : endsAt,
    };
  }
  const startsAt = isoOrEmpty(start.dateTime);
  if (!startsAt) return { ok: false };
  const rawEnd = isoOrEmpty(end.dateTime);
  const endsAt = rawEnd || new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString();
  return {
    ok: true,
    isAllDay: false,
    startsAt,
    endsAt: new Date(endsAt).getTime() < new Date(startsAt).getTime() ? startsAt : endsAt,
  };
}

export function eventPrivateProps(event = {}) {
  const props = event.extendedProperties?.private;
  return props && typeof props === "object" ? props : {};
}

export function eventIsCancelled(event = {}) {
  return cleanText(event.status).toLowerCase() === "cancelled";
}

// (2) 버전 가드. 저장해 둔 값 자체가 구글에서 온 것이므로 같은 시각이 정상이고,
// 페이지가 날아오는 사이 더 새로운 outbound 가 값을 앞당겼을 수도 있어 <= 로 본다.
export function eventIsEcho(event = {}, row = null) {
  const known = new Date(cleanText(row?.google_updated_at)).getTime();
  const incoming = new Date(cleanText(event.updated)).getTime();
  if (!Number.isFinite(known) || !Number.isFinite(incoming)) return false;
  return incoming <= known;
}

export function googleMirrorFields(event = {}) {
  const attendees = Array.isArray(event.attendees) ? event.attendees.slice(0, MAX_ATTENDEES) : null;
  const recurrence = Array.isArray(event.recurrence)
    ? event.recurrence.map((line) => cleanText(line, MAX_RECURRENCE_LINE_CHARS)).filter(Boolean).slice(0, MAX_RECURRENCE_LINES)
    : null;
  const fields = {
    google_etag: cleanText(event.etag, 200) || null,
    google_updated_at: isoOrEmpty(event.updated) || null,
    google_html_link: cleanText(event.htmlLink, 1000) || null,
    google_recurring_event_id: cleanText(event.recurringEventId, 1024) || null,
    google_location: cleanText(event.location, 1000) || null,
    google_description: cleanText(event.description, 8000) || null,
    google_attendees: attendees,
  };
  // 반복 규칙은 마스터 이벤트에만 실려 온다. 인스턴스 응답이나 singleEvents
  // 목록에는 없으므로, 없다고 null 로 덮으면 인스턴스 행이 들고 있던 표시용
  // 사본("매월 13일")이 매 동기화마다 지워진다. 있으면 갱신, 없으면 생략한다.
  if (recurrence) fields.google_recurrence = recurrence;
  // conferenceDataVersion=0 응답에는 conferenceData 가 아예 없다. 없다고 해서
  // null 로 덮으면 events.list(버전 0) 한 번에 저장해 둔 Meet 링크가 사라진다.
  const conferenceUri = conferenceUriFromEvent(event);
  if (conferenceUri) fields.google_conference_uri = conferenceUri;
  // 일정 색도 같은 규율이다. colorId 는 색을 지정한 일정에만 실려 오므로,
  // 키가 없는 응답을 null 로 받아쓰면 대표님이 고른 색이 매 동기화마다 지워진다.
  // 키가 있는데 비어 있으면 그것은 "이 일정은 캘린더 색을 따른다" 는 명시적
  // 답이므로 null 로 반영한다.
  if (Object.hasOwn(event, "colorId")) {
    const colorId = cleanText(event.colorId, 4);
    fields.google_color_id = isEventColorId(colorId) ? colorId : null;
  }
  return fields;
}

// 메아리 가드를 딱 한 열만 비껴가는 좁은 보정.
//
// eventIsEcho 는 "구글의 updated 가 우리가 아는 값보다 새롭지 않다" 만 본다.
// google_color_id 열이 생기기 전에 들어온 행은 구글에서 그 일정을 다시 건드리지
// 않는 한 영영 색을 받지 못한다 — MI 에서만 캘린더 색으로 남던 일정들이 그것이다.
// 그래서 색만 메아리 가드 뒤에서 채운다.
//
// 규율은 googleMirrorFields 와 똑같다. colorId 키가 실려 있을 때만 손대고,
// 키가 아예 없으면 "색을 지웠다" 가 아니라 "말한 적 없다" 이므로 그냥 둔다.
// 제목·시각·etag·google_updated_at 은 절대 함께 쓰지 않는다 — 오래된 이벤트가
// 실제 내용을 덮어쓰는 길을 여는 순간 메아리 가드가 무의미해진다.
export function colorBackfillPatch(event = {}, row = {}) {
  if (!Object.hasOwn(event, "colorId")) return null;
  const colorId = cleanText(event.colorId, 4);
  const next = isEventColorId(colorId) ? colorId : null;
  // 열이 아직 없어 선택되지 않은 행은 undefined 로 온다. 읽지도 않은 값을
  // "다르다" 로 볼 이유가 없으므로 양쪽 다 null 로 맞춘 뒤 견준다.
  const current = cleanText(row?.google_color_id, 4) || null;
  if (next === current) return null;
  return { google_color_id: next };
}

export function mapGoogleEventToScheduleRow(event = {}, {
  ownerCode = "",
  calendarId = "",
  personalRole = "",
  personalCode = "",
} = {}) {
  const times = googleEventTimes(event);
  if (!times.ok) return null;
  const props = eventPrivateProps(event);
  // 두 값이 모두 있을 때만 개인 표식을 단다. 하나라도 비면 키를 아예 넣지
  // 않는다 — DB CHECK 가 두 열이 함께 차거나 함께 비기를 요구하기도 하지만,
  // 그보다 중요한 이유는 P6 이전 대표님 inbound 행이다. 그 행들은 표식 없이
  // 들어와야 운영 피드(personal_role IS NULL 필터)에 지금처럼 계속 보인다.
  const personal = cleanText(personalRole) && cleanText(personalCode)
    ? { personal_role: normalizeCode(personalRole), personal_code: normalizeCode(personalCode) }
    : {};
  return {
    ...personal,
    owner_agency_code: normalizeCode(ownerCode),
    client_id: null,
    operation_team_id: null,
    calendar_id: null,
    title: normalizeImportedTitle(undecorateGoogleSummary(event.summary, props)),
    schedule_type: IMPORTED_SCHEDULE_TYPE,
    status: "planned",
    priority: "medium",
    visibility: "internal",
    public_title: null,
    public_comment: null,
    internal_note: null,
    is_all_day: times.isAllDay,
    starts_at: times.startsAt,
    ends_at: times.endsAt,
    google_source: "google",
    google_calendar_id: cleanText(calendarId),
    google_event_id: cleanText(event.id, 1024),
    google_sync_state: "synced",
    google_sync_error: null,
    google_synced_at: new Date().toISOString(),
    ...googleMirrorFields(event),
  };
}

// 구글이 소유한 필드만 담은 패치를 만든다. schedule_type / priority / visibility /
// client_id / internal_note 등 MI 소유 필드는 절대 포함되지 않는다.
export function inboundUpdatePatch(event = {}, row = {}) {
  const times = googleEventTimes(event);
  if (!times.ok) return { ok: false, reason: "invalid_time" };
  const props = eventPrivateProps(event);
  const patch = {
    title: normalizeImportedTitle(undecorateGoogleSummary(event.summary, props)),
    starts_at: times.startsAt,
    ends_at: times.endsAt,
    is_all_day: times.isAllDay,
    google_sync_state: "synced",
    google_sync_error: null,
    google_synced_at: new Date().toISOString(),
    ...googleMirrorFields(event),
  };
  if (!row.google_calendar_id) patch.google_calendar_id = cleanText(event.calendarId) || undefined;

  // 시리즈 행은 occurrence_on 이 서울 기준 시작일과 같아야 하고
  // recurrence_until 을 넘을 수 없다(schedule_items_recurrence_coherent).
  if (row.series_id) {
    const occurrenceOn = seoulDateKey(times.startsAt);
    if (!occurrenceOn) return { ok: false, reason: "invalid_time" };
    if (row.recurrence_until && occurrenceOn > row.recurrence_until) {
      return { ok: false, reason: "series_window" };
    }
    patch.occurrence_on = occurrenceOn;
  }
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) delete patch[key];
  }
  return { ok: true, patch };
}

// (C-1) 자기 개인 공간의 행이면 광고주/운영팀 범위여도 구글로 민다.
//
// 게이트는 없앤 것이 아니라 다시 맨 것이다. 예전 질문은 "대표냐" 였고 지금
// 질문은 "자기 개인 공간이냐" 다 — 계정마다 개인 캘린더가 하나씩 생겼으니
// 대표 여부는 더 이상 경계선이 될 수 없다. 개인키가 없는 운영팀·광고주 세션은
// 여전히 빈 배열이다. 그것이 운영팀원이 만든 일정을 대표님 구글 캘린더로
// 흘려보내지 않는 유일한 방어선이고, 개인키를 든 세션은 자기 키와 같은
// owner_agency_code 행만 통과하므로 남의 공간으로 새지 않는다.
// owner_agency_code 는 selectFields 에 없을 수 있어 있을 때만 대조한다.
export function ownerSyncableRows(access, rows) {
  const personalKey = normalizeCode(access?.personalKey);
  if (!personalKey && access?.role !== "owner") return [];
  const ownerCode = personalKey || normalizeCode(access?.ownerAgencyCode);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || row.calendar_id) return false;
    if (row.owner_agency_code && normalizeCode(row.owner_agency_code) !== ownerCode) return false;
    return true;
  });
}

// (C-2) 구글 우선(Google-first) 경로는 "실제로 저장된 연동"에만 켜지는 옵트인이다.
// 연동 여부를 확인하려면 owner_google_integrations 조회가 가능해야 하는데,
// 최소한의 ctx(조회 스텁이 없는 호출부·테스트 컨텍스트)로는 그 조회 자체가
// 불가능하다. 그럴 때 조회를 강행하면 호출부의 다른 쿼리 흐름을 망가뜨리므로
// 여기서 먼저 물러난다. 연동 여부를 판정하지 못한 것은 "연동 없음"과 같게 다뤄
// 예전 로컬 저장 경로로 그대로 떨어지며, 절대 500 이나 ok:false 를 내지 않는다.
function canLoadOwnerIntegration(ctx) {
  return typeof ctx?.supabaseAdmin?.from === "function";
}

export function rowClientName(row = {}, clientsById = null) {
  if (row.client) return clientDisplayName(row.client);
  if (clientsById && row.client_id) return clientDisplayName(clientsById.get(row.client_id));
  return "";
}

// ─────────────────────────────────────────────────────────────
// 상태 기록
// ─────────────────────────────────────────────────────────────

async function recordSyncAudit(ctx, action, targetId, metadata) {
  try {
    await ctx.supabaseAdmin.from("audit_logs").insert({
      actor_id: null,
      client_id: null,
      action,
      target_table: "schedule_items",
      target_id: targetId || null,
      metadata: sanitizeAuditMetadata(metadata || {}),
    }).then(() => {}, () => {});
  } catch (error) {
    // 감사 기록은 동기화 결과를 바꾸지 않는다
  }
}

export async function markIntegrationSyncStatus(ctx, ownerCode, status, errorText = null) {
  try {
    await ctx.supabaseAdmin
      .from("owner_google_integrations")
      .update({
        sync_status: status,
        sync_error: errorText ? cleanText(errorText, 500) : null,
        updated_at: new Date().toISOString(),
      })
      .eq("owner_agency_code", normalizeCode(ownerCode))
      .then(() => {}, () => {});
  } catch (error) {
    // 상태 기록 실패가 동기화를 막지 않는다
  }
}

// 기록용 쓰기에만 나타나는 열. 이 목록 밖의 키가 하나라도 섞이면 실제 변경이다.
const BOOKKEEPING_COLUMNS = [
  "google_event_id", "google_etag", "google_updated_at", "google_html_link",
  "google_calendar_id", "google_sync_state", "google_sync_error",
  // 색 보정(colorBackfillPatch)도 기록용 쓰기다. 같은 값을 다시 써서 updated_at
  // 을 올리면 대표님의 삭제·수정이 기대하는 버전이 이유 없이 어긋난다.
  "google_color_id",
];

function sameBookkeepingValue(column, previous, next) {
  // 선택 목록에 없던 열은 undefined 로 온다. 읽지도 않은 열을 "바뀌었다" 로
  // 볼 이유가 없으므로 양쪽 다 null 로 맞춘 뒤 견준다.
  const before = previous === undefined ? null : previous;
  const after = next === undefined ? null : next;
  if (column === "google_updated_at") {
    // timestamptz 는 PostgREST 가 "+00:00" 으로 돌려주고 우리는 ".000Z" 로 쓴다.
    // 같은 순간을 다른 문자열이라는 이유로 변경으로 보지 않도록 시각으로 견준다.
    const beforeAt = new Date(cleanText(before)).getTime();
    const afterAt = new Date(cleanText(after)).getTime();
    if (Number.isFinite(beforeAt) && Number.isFinite(afterAt)) return beforeAt === afterAt;
  }
  return before === after;
}

// 값이 하나도 바뀌지 않는 "기록용" 쓰기인지 판정한다. google_synced_at 은 밀 때마다
// 새로 만들어지므로 비교에서 뺀다. 이전 행을 모르면 판정하지 못하니 항상 쓴다.
export function isNoopSyncBookkeeping(previousRow, values) {
  if (!previousRow || !values || typeof values !== "object") return false;
  for (const [column, value] of Object.entries(values)) {
    if (column === "google_synced_at") continue;
    if (!BOOKKEEPING_COLUMNS.includes(column)) return false;
    if (!sameBookkeepingValue(column, previousRow[column], value)) return false;
  }
  return true;
}

// updated_at 을 올리는 BEFORE UPDATE 트리거는 조건이 없어서 어떤 실제 쓰기든 그대로
// 버전을 올린다. 여기서 없애는 것은 값이 하나도 바뀌지 않는 "기록용" 쓰기뿐이며,
// handleDelete 는 더 이상 버전 일치에 의존하지 않는다.
async function markRowSyncState(ctx, rowId, values, previousRow = null) {
  if (isNoopSyncBookkeeping(previousRow, values)) return;
  try {
    await runWithOptionalColumns(() => {
      const payload = withoutDisabledColumns(values);
      // 선택 열만 담은 쓰기(색 보정)가 그 열의 강등으로 빈 객체가 될 수 있다.
      // 빈 UPDATE 는 아무것도 바꾸지 않으면서 updated_at 트리거만 올리므로 보내지 않는다.
      if (!Object.keys(payload).length) return Promise.resolve({ error: null });
      return ctx.supabaseAdmin
        .from("schedule_items")
        .update(payload)
        .eq("id", rowId)
        .then((result) => result || { error: null }, (error) => ({ error }));
    });
  } catch (error) {
    // 상태 기록 실패가 동기화를 막지 않는다
  }
}

// ─────────────────────────────────────────────────────────────
// outbound
// ─────────────────────────────────────────────────────────────

function syncedRowValues(event) {
  return {
    google_event_id: cleanText(event?.id, 1024) || null,
    google_etag: cleanText(event?.etag, 200) || null,
    google_updated_at: isoOrEmpty(event?.updated) || null,
    google_html_link: cleanText(event?.htmlLink, 1000) || null,
    google_sync_state: "synced",
    google_sync_error: null,
    google_synced_at: new Date().toISOString(),
  };
}

export async function pushRowToGoogle(ctx, env, options) {
  const { integration, accessToken, row, clientName = "", mode = "upsert", fetchImpl = fetch } = options;
  const ownerCode = normalizeCode(integration.owner_agency_code);
  // 원본 캘린더로 되돌려 쓴다. 이것을 전용 캘린더로 고정하면 primary 에서 온
  // 행을 지울 때 엉뚱한 캘린더에 404 를 날리고 "성공" 으로 처리하게 된다.
  // defaultCalendarId 는 그 두 개가 모두 비었을 때만 쓰는 마지막 바닥값이다
  // (전용 캘린더를 회수한 뒤 integration.calendar_id 가 null 인 경우).
  const calendarId = cleanText(row.google_calendar_id)
    || cleanText(integration.calendar_id)
    || cleanText(options.defaultCalendarId);
  if (!calendarId) return { ok: false, reason: "no_calendar" };

  if (mode === "delete") {
    if (!row.google_event_id) return { ok: true, skipped: true };
    // 반복 인스턴스는 DELETE 대신 status=cancelled 로 취소한다. 부모 시리즈까지
    // 지워질 가능성을 원천 차단한다.
    const result = row.google_recurring_event_id
      ? await googleFetch(accessToken, "PATCH", eventsPath(calendarId, row.google_event_id), { status: "cancelled" }, { fetchImpl })
      : await googleFetch(accessToken, "DELETE", eventsPath(calendarId, row.google_event_id), null, { fetchImpl });
    if (result.ok || result.status === 404 || result.status === 410) return { ok: true };
    return { ok: false, reason: `delete_${result.status}` };
  }

  const payload = buildGoogleEventPayload(row, { ownerCode, clientName });
  if (!payload) return { ok: false, reason: "invalid_row" };

  if (row.google_event_id) {
    const path = eventsPath(calendarId, row.google_event_id);
    const headers = row.google_etag ? { "if-match": row.google_etag } : {};
    let result = await googleFetch(accessToken, "PATCH", path, payload, { headers, fetchImpl });
    if (result.status === 412) {
      // 구글이 정본이다: 최신 etag 를 다시 받아 한 번만 재시도하고,
      // 그래도 충돌하면 다음 inbound 가 MI 를 구글 값으로 덮게 둔다.
      const fresh = await googleFetch(accessToken, "GET", path, null, { fetchImpl });
      if (fresh.ok && fresh.data?.etag) {
        result = await googleFetch(accessToken, "PATCH", path, payload, {
          headers: { "if-match": String(fresh.data.etag) },
          fetchImpl,
        });
      }
      if (result.status === 412) return { ok: false, reason: "etag_conflict" };
    }
    if (result.ok && result.data) {
      return { ok: true, values: { ...syncedRowValues(result.data), google_calendar_id: calendarId } };
    }
    if (result.status !== 404 && result.status !== 410) return { ok: false, reason: `patch_${result.status}` };
  }

  const created = await googleFetch(accessToken, "POST", eventsPath(calendarId), payload, { fetchImpl });
  if (!created.ok || !created.data?.id) return { ok: false, reason: `insert_${created.status}` };
  return { ok: true, values: { ...syncedRowValues(created.data), google_calendar_id: calendarId } };
}

// 삭제는 구글 우선(Google-first)이다. MI 행을 지우기 전에 구글에서 먼저 지우고,
// 지우지 못하면 MI 행을 남긴 채 호출자가 사용자에게 실패를 알리게 한다.
// 예전처럼 "지우고 나서 조용히 push" 하면 구글 호출이 어떤 이유로 실패해도
// (토큰 만료, 403, 5xx, 네트워크) 대표님 화면에서는 삭제가 성공한 것처럼 보이고
// 구글에는 일정이 그대로 남는다. 그 침묵이 이번 사고의 원인이다.
export async function deleteRowFromGoogle(ctx, env, access, row, fetchImpl = fetch) {
  if (!ownerSyncableRows(access, [row]).length) return { ok: true, skipped: true, reason: "scope" };
  if (!cleanText(row?.google_event_id)) return { ok: true, skipped: true, reason: "no-event" };
  // 연동 조회가 불가능한 ctx 면 DB 를 건드리기 전에 물러난다.
  if (!canLoadOwnerIntegration(ctx)) return { ok: true, skipped: true, reason: "no-storage" };
  const config = googleOauthConfig(env);
  if (!config.clientId || !config.clientSecret) return { ok: true, skipped: true, reason: "env" };
  const ownerCode = normalizeCode(access.ownerAgencyCode || primaryAgencyCode(env));
  // 조회가 터지면 예외가 그대로 올라가 삭제 응답이 500 이 된다. 연동 여부를
  // 판정하지 못한 것뿐이므로 "연동 없음"과 같게 다뤄 로컬 삭제를 계속한다.
  let integration = null;
  let error = null;
  try {
    const loaded = await loadOwnerGoogleIntegration(ctx, ownerCode);
    integration = loaded.integration;
    error = loaded.error;
  } catch (unexpected) {
    integration = null;
    error = unexpected;
  }
  // 연동을 끊은 뒤라면 구글 일정이 남는 것이 이미 약속된 동작이므로 로컬 삭제를 막지 않는다.
  if (error || !integration) return { ok: true, skipped: true, reason: "not-connected" };
  const token = await refreshAccessToken(integration.refresh_token, env, fetchImpl);
  if (!token.ok) {
    if (token.reason === "invalid_grant") {
      await markIntegrationSyncStatus(ctx, ownerCode, "needs_reconnect", "구글 재연결이 필요합니다.");
      return { ok: false, reason: "needs_reconnect" };
    }
    return { ok: false, reason: "token" };
  }
  try {
    const result = await pushRowToGoogle(ctx, env, {
      integration,
      accessToken: token.accessToken,
      row,
      mode: "delete",
      fetchImpl,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason || "delete_failed" };
  } catch (unexpected) {
    return { ok: false, reason: "network" };
  }
}

// 구글 삭제가 실패했을 때의 흔적. 행은 남으므로 상태를 failed 로 되돌려
// 다음 동기화가 재시도 대상으로 잡게 하고, 감사 로그도 남긴다.
export async function recordGoogleDeleteFailure(ctx, row, reason) {
  await markRowSyncState(ctx, row.id, {
    google_sync_state: "failed",
    google_sync_error: cleanText(`delete:${reason}`, 500),
  });
  try {
    await ctx.supabaseAdmin.from("audit_logs").insert({
      actor_id: null,
      client_id: row.client_id || null,
      action: "google_calendar_sync_failed",
      target_table: "schedule_items",
      target_id: row.id || null,
      metadata: sanitizeAuditMetadata({
        mode: "delete",
        reason,
        failed: 1,
        total: 1,
        calendarId: cleanText(row.google_calendar_id, 200) || null,
        eventId: cleanText(row.google_event_id, 200) || null,
      }),
    }).then(() => {}, () => {});
  } catch (unexpected) {
    // 감사 기록 실패가 응답을 바꾸지 않는다
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// 전용 캘린더를 회수한 뒤에는 integration.calendar_id 가 null 이다. 그때 아직
// 구글에 붙지 않은 행이 갈 곳은 대표님의 기본 캘린더다. 실행당 한 번만, 그것도
// 실제로 필요할 때만 구한다 — 원래 캘린더를 가진 행만 있으면 조회 자체를 하지 않는다.
async function defaultPushCalendarId(ctx, ownerCode, integration, rows, options = {}) {
  if (cleanText(integration?.calendar_id)) return "";
  const list = Array.isArray(rows) ? rows : [];
  if (!list.some((row) => !cleanText(row?.google_calendar_id))) return "";
  return (await resolveOwnerPrimaryCalendar(ctx, ownerCode, options)).id;
}

// MI 저장 직후의 즉시 push. 구글이 실패해도 저장을 막지 않는다 —
// 행은 google_sync_state='pending' 으로 남아 다음 동기화가 재시도한다.
export async function syncOwnerScheduleRows(ctx, env, access, rows, mode, fetchImpl = fetch) {
  try {
    const targets = ownerSyncableRows(access, rows);
    if (!targets.length) return { skipped: true, reason: "scope" };
    // 연동 조회가 불가능한 ctx 면 DB 를 건드리기 전에 물러난다.
    if (!canLoadOwnerIntegration(ctx)) return { skipped: true, reason: "no-storage" };
    const config = googleOauthConfig(env);
    if (!config.clientId || !config.clientSecret) return { skipped: true, reason: "env" };
    const ownerCode = normalizeCode(access.ownerAgencyCode || primaryAgencyCode(env));
    const { integration, error } = await loadOwnerGoogleIntegration(ctx, ownerCode);
    if (error || !integration) return { skipped: true, reason: "not-connected" };
    const token = await refreshAccessToken(integration.refresh_token, env, fetchImpl);
    if (!token.ok) {
      if (token.reason === "invalid_grant") {
        await markIntegrationSyncStatus(ctx, ownerCode, "needs_reconnect", "구글 재연결이 필요합니다.");
      }
      return { skipped: false, synced: 0, failed: targets.length, reason: "token" };
    }
    const defaultCalendarId = await defaultPushCalendarId(ctx, ownerCode, integration, targets, {
      accessToken: token.accessToken,
      fetchImpl,
    });

    const results = await mapWithConcurrency(targets, DEFAULT_PUSH_CONCURRENCY, async (row) => {
      try {
        const result = await pushRowToGoogle(ctx, env, {
          integration,
          accessToken: token.accessToken,
          row,
          clientName: rowClientName(row),
          mode,
          defaultCalendarId,
          fetchImpl,
        });
        if (result.ok && result.values) await markRowSyncState(ctx, row.id, result.values, row);
        if (!result.ok) {
          await markRowSyncState(ctx, row.id, {
            google_sync_state: "failed",
            google_sync_error: cleanText(result.reason, 500) || "push_failed",
          });
        }
        return { ok: result.ok };
      } catch (rowError) {
        return { ok: false };
      }
    });

    const failed = results.filter((result) => !result.ok).length;
    if (failed > 0) {
      await ctx.supabaseAdmin.from("audit_logs").insert({
        actor_id: null,
        client_id: null,
        action: "google_calendar_sync_failed",
        target_table: "schedule_items",
        target_id: targets[0]?.id || null,
        metadata: sanitizeAuditMetadata({ mode, failed, total: targets.length }),
      }).then(() => {}, () => {});
    }
    return { skipped: false, synced: results.length - failed, failed };
  } catch (error) {
    return { skipped: false, synced: 0, failed: Array.isArray(rows) ? rows.length : 0, reason: "unexpected" };
  }
}

export async function pushPendingRows(ctx, env, ownerCode, integration, accessToken, options = {}) {
  const limit = options.pushLimit || DEFAULT_PUSH_LIMIT;
  const fetchImpl = options.fetchImpl || fetch;
  const personal = options.personal || null;
  const { data, error } = await runWithOptionalColumns(() => {
    const query = ctx.supabaseAdmin
      .from("schedule_items")
      .select(syncRowFields())
      .eq("owner_agency_code", normalizeCode(ownerCode))
      .in("google_sync_state", ["pending", "failed"])
      .order("updated_at", { ascending: true })
      .limit(limit);
    // 개인 실행의 범위 술어는 선택 열 강등에 절대 딸려 내려가지 않는다.
    // 강등이 술어까지 지우면 재시도 한 번이 조회 범위를 계정 전체로 넓히는데,
    // 그렇게 넓어진 결과는 남의 개인 행을 이 계정의 구글 캘린더로 밀어 버린다.
    // 열이 아직 없으면 이 질의는 그냥 실패해야 한다(fail closed).
    return personal
      ? query.eq("personal_role", personal.role).eq("personal_code", personal.code)
      : query;
  });
  if (error) return { pushed: 0, pushFailed: 0 };
  const rows = (data || []).filter((row) => row && !row.calendar_id);
  if (!rows.length) return { pushed: 0, pushFailed: 0 };

  const clientIds = [...new Set(rows.map((row) => row.client_id).filter(Boolean))];
  const clientsById = new Map();
  if (clientIds.length) {
    const lookup = await ctx.supabaseAdmin.from("clients").select("id, name, business_name").in("id", clientIds);
    for (const client of lookup.data || []) clientsById.set(client.id, client);
  }
  const defaultCalendarId = await defaultPushCalendarId(ctx, ownerCode, integration, rows, {
    accessToken,
    fetchImpl,
  });

  const results = await mapWithConcurrency(rows, DEFAULT_PUSH_CONCURRENCY, async (row) => {
    try {
      const result = await pushRowToGoogle(ctx, env, {
        integration,
        accessToken,
        row,
        clientName: rowClientName(row, clientsById),
        mode: "upsert",
        defaultCalendarId,
        fetchImpl,
      });
      if (result.ok && result.values) await markRowSyncState(ctx, row.id, result.values, row);
      else if (!result.ok) {
        await markRowSyncState(ctx, row.id, {
          google_sync_state: "failed",
          google_sync_error: cleanText(result.reason, 500) || "push_failed",
        });
      }
      return result.ok;
    } catch (rowError) {
      return false;
    }
  });
  const pushFailed = results.filter((ok) => !ok).length;
  return { pushed: results.length - pushFailed, pushFailed };
}

// ─────────────────────────────────────────────────────────────
// inbound
// ─────────────────────────────────────────────────────────────

// 대표가 다이얼로그에서 제3 캘린더를 고르면 그 캘린더에도 MI 일정이 생긴다.
// 전용/기본만 pull 하면 그 일정의 구글 쪽 변경이 영원히 들어오지 못하므로,
// 이미 쓰인 적 있는 캘린더 id 를 몇 개까지 동기화 대상에 함께 올린다.
async function extraCalendarIds(ctx, code, skip) {
  try {
    const { data, error } = await ctx.supabaseAdmin
      .from("schedule_items")
      .select("google_calendar_id")
      .eq("owner_agency_code", code)
      .gt("google_calendar_id", "")
      .limit(EXTRA_CALENDAR_SCAN_LIMIT);
    if (error) return [];
    const ids = [];
    for (const row of data || []) {
      const id = cleanText(row?.google_calendar_id);
      if (!id || skip.has(id) || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length >= MAX_EXTRA_CALENDARS) break;
    }
    return ids;
  } catch (error) {
    return [];
  }
}

// 저장된 카탈로그 행에서 기본 캘린더를 뽑는다. calendar_role 이 정본이고,
// 아직 역할이 붙지 않은 행은 카탈로그가 채워 준 calendar_is_primary 로 본다.
// (calendar_is_primary 는 선택 열이라 마이그레이션 전에는 아예 오지 않는다.)
export function primaryCalendarFromRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (cleanText(row?.google_calendar_id) && row.calendar_role === "primary") {
      return { id: cleanText(row.google_calendar_id), name: cleanText(row.calendar_summary, 200) || "" };
    }
  }
  for (const row of list) {
    if (cleanText(row?.google_calendar_id) && row.calendar_is_primary === true) {
      return { id: cleanText(row.google_calendar_id), name: cleanText(row.calendar_summary, 200) || "" };
    }
  }
  return { id: "", name: "" };
}

// 대표님의 기본 캘린더 id 를 한 곳에서만 구한다. resolveOwnerCalendars / 전용
// 캘린더 회수 / 다이얼로그 쓰기가 모두 이 함수를 쓴다 — 같은 호출을 세 군데에
// 흩어 두면 셋이 서로 다른 답을 낼 수 있다.
//
// 캐시(카탈로그 행)가 먼저다. GET /api/work-items 와 다이얼로그 저장은 hot path 라
// 매번 구글을 부르면 안 된다. 캐시에 없을 때만 GET /calendars/primary 로 간다.
// 반환하는 id 는 "primary" 리터럴이 아니라 실제 id(이메일)다 — 리터럴로 두면
// 같은 캘린더가 두 id 로 두 번 동기화되어 행이 중복된다.
export async function resolveOwnerPrimaryCalendar(ctx, ownerCode, options = {}) {
  const code = normalizeCode(ownerCode);
  let rows = Array.isArray(options.rows) ? options.rows : null;
  if (!rows) {
    try {
      // calendar_summary / calendar_is_primary 는 선택 열이므로 재시도를 겹쳐 건다.
      const columns = ["google_calendar_id", "calendar_role", "calendar_summary", "calendar_is_primary"];
      const result = await runWithOptionalColumns(() => ctx.supabaseAdmin
        .from("owner_google_calendar_sync")
        .select(activeColumns(columns).join(","))
        .eq("owner_agency_code", code)
        .then((response) => response || { data: null, error: null }, (error) => ({ data: null, error })),
      OPTIONAL_CALENDAR_SYNC_COLUMNS);
      rows = Array.isArray(result?.data) ? result.data : [];
    } catch (error) {
      rows = [];
    }
  }
  const stored = primaryCalendarFromRows(rows);
  if (stored.id) return { ...stored, source: "catalog" };

  const accessToken = cleanText(options.accessToken);
  if (!accessToken) return { id: "", name: "", source: "" };
  try {
    const profile = await googleFetch(accessToken, "GET", "/calendars/primary", null, {
      fetchImpl: options.fetchImpl || fetch,
    });
    if (profile.ok && profile.data?.id) {
      return { id: String(profile.data.id), name: cleanText(profile.data.summary, 200) || "", source: "google" };
    }
  } catch (error) {
    // 기본 캘린더를 모르는 것은 실패가 아니다 — 호출부가 각자 물러난다.
  }
  return { id: "", name: "", source: "" };
}

export async function resolveOwnerCalendars(ctx, ownerCode, integration, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const code = normalizeCode(ownerCode);
  const { data } = await runWithOptionalColumns(() => ctx.supabaseAdmin
    .from("owner_google_calendar_sync")
    .select(calendarSyncFields())
    .eq("owner_agency_code", code)
    .then((response) => response || { data: null, error: null }, (error) => ({ data: null, error })),
  OPTIONAL_CALENDAR_CATALOG_COLUMNS);
  const known = new Map((data || []).map((row) => [row.google_calendar_id, row]));

  const wanted = [];
  const dedicated = cleanText(integration.calendar_id);
  if (dedicated) wanted.push({ id: dedicated, role: "dedicated" });

  // 이미 읽어 둔 행을 그대로 넘겨 카탈로그 재조회를 아낀다.
  const primaryId = (await resolveOwnerPrimaryCalendar(ctx, code, {
    rows: [...known.values()],
    accessToken: options.accessToken,
    fetchImpl,
  })).id;
  if (primaryId && primaryId !== dedicated) wanted.push({ id: primaryId, role: "primary" });

  const skip = new Set(wanted.map((entry) => entry.id));
  for (const id of await extraCalendarIds(ctx, code, skip)) {
    wanted.push({ id, role: "secondary" });
    skip.add(id);
  }

  // 카탈로그에 있는 나머지 캘린더도 함께 당긴다. 체크를 꺼 둔 캘린더까지 계속
  // 동기화해 두어야 다시 켰을 때 곧바로 채워져 보이고(=재체크가 즉시다),
  // 아래 상한이 그 대가로 한 실행이 길어지는 것을 막는다.
  const rest = [...known.values()].filter((row) => cleanText(row?.google_calendar_id) && !skip.has(row.google_calendar_id));
  for (const row of [
    ...rest.filter((row) => row.calendar_visible !== false),
    ...rest.filter((row) => row.calendar_visible === false),
  ]) {
    wanted.push({ id: row.google_calendar_id, role: "secondary" });
    skip.add(row.google_calendar_id);
  }

  const calendars = [];
  for (const entry of wanted.slice(0, MAX_SYNC_CALENDARS)) {
    const existing = known.get(entry.id);
    if (existing) {
      calendars.push(existing);
      continue;
    }
    const fresh = {
      owner_agency_code: code,
      google_calendar_id: entry.id,
      calendar_role: entry.role,
      sync_token: null,
      full_sync_page_token: null,
      window_start: null,
      window_end: null,
      last_synced_at: null,
      last_full_sync_at: null,
      last_error: null,
      last_error_at: null,
    };
    await ctx.supabaseAdmin
      .from("owner_google_calendar_sync")
      .upsert(fresh, { onConflict: "owner_agency_code,google_calendar_id" })
      .then(() => {}, () => {});
    calendars.push(fresh);
  }
  return calendars;
}

async function saveCalendarSyncState(ctx, calendarRow, values) {
  await ctx.supabaseAdmin
    .from("owner_google_calendar_sync")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("owner_agency_code", calendarRow.owner_agency_code)
    .eq("google_calendar_id", calendarRow.google_calendar_id)
    .then(() => {}, () => {});
}

// 조회 자체를 이 실행의 계정으로 좁힌다. 걸러지는 행은 matchRowForEvent 가
// 어차피 버리는 행(owner_agency_code 가 다른 행)뿐이라 동작은 그대로다 —
// 다만 계정이 대표님 하나가 아니게 된 뒤로는, 남의 행을 메모리로 끌어올린 다음
// 버리는 것과 애초에 읽지 않는 것의 차이가 크다. 실수 한 번의 사정거리가 다르다.
async function loadMatchingRows(ctx, ownerCode, calendarId, events) {
  const code = normalizeCode(ownerCode);
  const eventIds = [...new Set(events.map((event) => cleanText(event.id)).filter(Boolean))];
  const scheduleIds = [...new Set(events
    .map((event) => cleanText(eventPrivateProps(event).miScheduleId).toLowerCase())
    .filter(isUuid))];
  const byEvent = new Map();
  const byScheduleId = new Map();
  if (eventIds.length) {
    const { data } = await runWithOptionalColumns(() => ctx.supabaseAdmin
      .from("schedule_items")
      .select(syncRowFields())
      .eq("owner_agency_code", code)
      .eq("google_calendar_id", calendarId)
      .in("google_event_id", eventIds));
    for (const row of data || []) byEvent.set(row.google_event_id, row);
  }
  if (scheduleIds.length) {
    const { data } = await runWithOptionalColumns(() => ctx.supabaseAdmin
      .from("schedule_items")
      .select(syncRowFields())
      .eq("owner_agency_code", code)
      .in("id", scheduleIds));
    for (const row of data || []) byScheduleId.set(row.id, row);
  }
  return { byEvent, byScheduleId };
}

export function matchRowForEvent(event, maps, ownerCode) {
  const eventId = cleanText(event.id);
  const direct = maps.byEvent.get(eventId);
  if (direct) return { row: direct, via: "event" };
  const props = eventPrivateProps(event);
  const scheduleId = cleanText(props.miScheduleId).toLowerCase();
  if (!isUuid(scheduleId)) return { row: null, via: "" };
  const row = maps.byScheduleId.get(scheduleId);
  if (!row) return { row: null, via: "" };
  const propOwner = normalizeCode(props.miOwnerCode);
  if (propOwner && normalizeCode(ownerCode) !== propOwner) return { row: null, via: "" };
  if (row.owner_agency_code && normalizeCode(row.owner_agency_code) !== normalizeCode(ownerCode)) {
    return { row: null, via: "" };
  }
  // 대표가 구글에서 일정을 복사하면 같은 miScheduleId 가 둘이 된다. 매칭을
  // 허용하면 MI 행이 두 이벤트 사이를 오가며 진동하므로 복제본은 무시한다.
  if (row.google_event_id && row.google_event_id !== eventId) {
    return { row: null, via: "duplicate", conflictRow: row };
  }
  return { row, via: "schedule" };
}

async function applyEvents(ctx, ownerCode, calendarRow, events, window, counters, personal = null) {
  const calendarId = calendarRow.google_calendar_id;
  const maps = await loadMatchingRows(ctx, ownerCode, calendarId, events);

  for (const event of events) {
    const match = matchRowForEvent(event, maps, ownerCode);
    if (match.via === "duplicate") {
      counters.skipped += 1;
      if (match.conflictRow?.id) {
        await markRowSyncState(ctx, match.conflictRow.id, { google_sync_error: "duplicate_copy" });
      }
      continue;
    }
    const row = match.row;

    if (eventIsCancelled(event)) {
      if (!row) { counters.skipped += 1; continue; }
      await ctx.supabaseAdmin.from("schedule_items").delete().eq("id", row.id).then(() => {}, () => {});
      await recordSyncAudit(ctx, "google_calendar_item_deleted", row.id, {
        calendarId,
        eventId: cleanText(event.id, 200),
        title: cleanText(row.title, 200),
        startsAt: row.starts_at,
        status: row.status,
        googleSource: row.google_source,
      });
      counters.deleted += 1;
      continue;
    }

    // 메아리는 원칙적으로 버린다. 예외는 딱 하나, 열이 생기기 전에 들어와
    // 색만 비어 있는 행이다(colorBackfillPatch 참고). 열이 아직 없으면
    // withoutDisabledColumns 가 그 자리에서 비워 내므로 예전과 똑같이 건너뛴다.
    if (row && eventIsEcho(event, row)) {
      const backfill = colorBackfillPatch(event, row);
      const values = backfill ? withoutDisabledColumns(backfill) : null;
      if (values && Object.keys(values).length) {
        await markRowSyncState(ctx, row.id, values, row);
        counters.updated += 1;
      } else {
        counters.skipped += 1;
      }
      continue;
    }

    if (row) {
      const built = inboundUpdatePatch(event, row);
      if (!built.ok) {
        counters.skipped += 1;
        await markRowSyncState(ctx, row.id, {
          google_sync_state: "failed",
          google_sync_error: built.reason,
        });
        continue;
      }
      const patch = { ...built.patch };
      if (!row.google_calendar_id) patch.google_calendar_id = calendarId;
      if (!row.google_event_id) patch.google_event_id = cleanText(event.id, 1024);
      const { error } = await runWithOptionalColumns(() => ctx.supabaseAdmin
        .from("schedule_items").update(withoutDisabledColumns(patch)).eq("id", row.id));
      if (error) {
        counters.skipped += 1;
        await markRowSyncState(ctx, row.id, {
          google_sync_state: "failed",
          google_sync_error: error.code === "23505" ? "series_conflict" : cleanText(error.message, 500),
        });
        continue;
      }
      counters.updated += 1;
      continue;
    }

    const times = googleEventTimes(event);
    if (!times.ok) { counters.skipped += 1; continue; }
    // 이미 MI 에 있는 행은 윈도우와 무관하게 반영하지만, 새 이벤트는
    // 윈도우 밖이면 들이지 않는다. sync token 이 범위를 기억하든 말든 같은 결과가 된다.
    if (!eventInWindow(times.startsAt, window)) { counters.skipped += 1; continue; }
    const insertRow = mapGoogleEventToScheduleRow(event, {
      ownerCode,
      calendarId,
      personalRole: personal?.role || "",
      personalCode: personal?.code || "",
    });
    if (!insertRow) { counters.skipped += 1; continue; }
    const { error } = await runWithOptionalColumns(() => ctx.supabaseAdmin
      .from("schedule_items").insert(withoutDisabledColumns(insertRow)));
    if (error) { counters.skipped += 1; continue; }
    counters.imported += 1;
  }
}

export async function syncOneCalendar(ctx, ownerCode, calendarRow, accessToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  const nowMs = options.now || Date.now();
  const deadlineAt = options.deadlineAt || Number.POSITIVE_INFINITY;
  const counters = { imported: 0, updated: 0, deleted: 0, skipped: 0 };

  const resuming = Boolean(cleanText(calendarRow.full_sync_page_token));
  let incremental = resuming
    ? Boolean(cleanText(calendarRow.sync_token))
    : options.mode !== "full" && Boolean(cleanText(calendarRow.sync_token));
  let window = incremental && calendarRow.window_start && calendarRow.window_end
    ? { timeMin: new Date(calendarRow.window_start).toISOString(), timeMax: new Date(calendarRow.window_end).toISOString() }
    : syncWindow(nowMs);
  if (resuming && calendarRow.window_start && calendarRow.window_end) {
    window = { timeMin: new Date(calendarRow.window_start).toISOString(), timeMax: new Date(calendarRow.window_end).toISOString() };
  }

  let pageToken = resuming ? cleanText(calendarRow.full_sync_page_token) : "";
  let nextSyncToken = "";
  let pages = 0;
  let seen = 0;
  let partial = false;
  let fullResync = false;
  let recovered410 = false;
  let failure = "";

  while (true) {
    const query = { singleEvents: "true", showDeleted: "true", maxResults: String(options.pageSize || DEFAULT_PAGE_SIZE) };
    if (incremental) {
      query.syncToken = cleanText(calendarRow.sync_token);
    } else {
      // timeMin/timeMax 는 syncToken 과 함께 쓸 수 없다. full sync 에서만 붙인다.
      query.timeMin = window.timeMin;
      query.timeMax = window.timeMax;
    }
    if (pageToken) query.pageToken = pageToken;

    const result = await googleFetch(accessToken, "GET", eventsPath(calendarRow.google_calendar_id), null, { query, fetchImpl });

    if (result.status === 410 && !recovered410) {
      // sync token 무효 → 저장분을 버리고 같은 호출 안에서 full sync 로 되돌린다.
      recovered410 = true;
      fullResync = true;
      incremental = false;
      pageToken = "";
      nextSyncToken = "";
      pages = 0;
      window = syncWindow(nowMs);
      await saveCalendarSyncState(ctx, calendarRow, { sync_token: null, full_sync_page_token: null });
      calendarRow = { ...calendarRow, sync_token: null, full_sync_page_token: null };
      continue;
    }
    if (!result.ok) {
      failure = `list_${result.status}`;
      break;
    }

    const events = Array.isArray(result.data?.items) ? result.data.items : [];
    if (events.length) await applyEvents(ctx, ownerCode, calendarRow, events, window, counters, options.personal || null);

    pages += 1;
    seen += events.length;
    pageToken = cleanText(result.data?.nextPageToken);
    if (result.data?.nextSyncToken) nextSyncToken = String(result.data.nextSyncToken);
    if (!pageToken) break;
    // 이벤트 상한도 페이지·시간 상한과 같게 다룬다: 페이지 토큰을 그대로 남겨
    // 두고 물러나면 나머지는 다음 실행이 이어받는다.
    if (pages >= maxPages || Date.now() >= deadlineAt || seen >= MAX_FULL_SYNC_EVENTS) { partial = true; break; }
  }

  const nowIso = new Date(nowMs).toISOString();
  if (failure) {
    await saveCalendarSyncState(ctx, calendarRow, { last_error: cleanText(failure, 500), last_error_at: nowIso });
  } else if (partial) {
    // 중단 시 sync token 은 건드리지 않는다. nextSyncToken 은 마지막 페이지에만
    // 오므로, 반쯤 진행한 상태에서 토큰을 갱신하면 남은 변경을 영원히 잃는다.
    await saveCalendarSyncState(ctx, calendarRow, {
      full_sync_page_token: pageToken,
      window_start: window.timeMin,
      window_end: window.timeMax,
      last_error: null,
      last_error_at: null,
    });
  } else {
    await saveCalendarSyncState(ctx, calendarRow, {
      sync_token: nextSyncToken || calendarRow.sync_token || null,
      full_sync_page_token: null,
      window_start: window.timeMin,
      window_end: window.timeMax,
      last_synced_at: nowIso,
      ...(incremental ? {} : { last_full_sync_at: nowIso }),
      last_error: null,
      last_error_at: null,
    });
  }

  return {
    calendarId: calendarRow.google_calendar_id,
    role: calendarRow.calendar_role,
    ...counters,
    fullResync,
    partial,
    error: failure || null,
  };
}

// ─────────────────────────────────────────────────────────────
// 전용 캘린더 회수 (연동된 대표님은 기본 캘린더 하나만 쓴다)
// ─────────────────────────────────────────────────────────────

// 한 실행이 옮기는 이벤트 수의 상한. 넘치면 깨끗하게 멈추고 나머지는 다음
// 실행이 이어받는다 — 동기화 예산을 이 정리 작업이 다 써 버리면 안 된다.
export const MAX_RETIRE_MOVES = 500;

// 옮긴 이벤트를 물고 있던 MI 행을 새 캘린더로 다시 가리킨다. move 응답은 목적지
// 캘린더에서의 Event 이므로 id/etag 를 응답 값으로 정본 삼는다(구글이 id 를
// 바꿔 줄 수도 있다). google_calendar_name 은 선택 열이라 재시도를 건다.
async function repointMovedScheduleRows(ctx, code, dedicatedId, eventId, movedEvent, primary) {
  const values = {
    google_calendar_id: primary.id,
    google_calendar_name: primary.name || null,
    google_event_id: cleanText(movedEvent?.id, 1024) || eventId,
    google_etag: cleanText(movedEvent?.etag, 200) || null,
  };
  try {
    await runWithOptionalColumns(() => ctx.supabaseAdmin
      .from("schedule_items")
      .update(withoutDisabledColumns(values))
      .eq("owner_agency_code", code)
      .eq("google_calendar_id", dedicatedId)
      .eq("google_event_id", eventId)
      .then((response) => response || { error: null }, (error) => ({ error })));
  } catch (error) {
    // 행 갱신 실패는 아래 쓸어담기 update 와 다음 실행이 만회한다
  }
}

async function recordRetireAudit(ctx, metadata) {
  try {
    await ctx.supabaseAdmin.from("audit_logs").insert({
      actor_id: null,
      client_id: null,
      action: "google_calendar_dedicated_retired",
      target_table: "owner_google_integrations",
      target_id: null,
      metadata: sanitizeAuditMetadata(metadata || {}),
    }).then(() => {}, () => {});
  } catch (error) {
    // 감사 기록 실패는 회수 결과를 바꾸지 않는다
  }
}

// 대표님은 내 캘린더 아래에 기본 캘린더 하나만 두고 싶어 하신다. 연동 초기에
// 만들던 전용 "모먼트 인사이트" 캘린더를 비우고 지운다.
//
// 계약: 멱등이고, 절대 던지지 않으며, 절대 동기화를 실패시키지 않는다. 아무것도
// 할 일이 없으면 { ok:true, skipped:true, reason }, 도중에 막히면
// { ok:false, reason, ...counts } 를 돌려주고 전부 그대로 살려 둔다 — 다음 실행이
// 같은 자리에서 이어서 시도하면 된다.
export async function retireDedicatedCalendar(ctx, env, ownerCode, integration, accessToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const code = normalizeCode(ownerCode);
  const token = cleanText(accessToken);
  const dedicatedId = cleanText(integration?.calendar_id);
  // 구글을 부르기 전에 끝나는 no-op 들이 먼저다. 이미 회수한 뒤라면 구글 트래픽이
  // 단 한 번도 나가지 않아야 한다(멱등의 값이 여기서 나온다).
  if (!integration || !dedicatedId) return { ok: true, skipped: true, reason: "no_dedicated" };
  if (!token) return { ok: true, skipped: true, reason: "no_token" };

  let moved = 0;
  let skipped = 0;
  let failed = 0;
  try {
    const primary = await resolveOwnerPrimaryCalendar(ctx, code, { accessToken: token, fetchImpl });
    if (!primary.id) return { ok: true, skipped: true, reason: "no_primary" };
    // 전용 캘린더가 곧 기본 캘린더면 옮길 곳이 없다(있을 수 없는 조합이지만
    // 여기서 막지 않으면 자기 자신으로 move 하고 기본 캘린더를 지우게 된다).
    if (primary.id === dedicatedId) return { ok: true, skipped: true, reason: "already_primary" };

    // 여기에는 timeMin/timeMax 를 걸지 않는다. 일부러 캘린더 전체를 훑는다.
    //
    // 동기화 윈도우(-30일 ~ +365일)는 "MI 가 자기 테이블로 무엇을 당겨올지" 를
    // 정하는 값이다. 마지막에 캘린더를 통째로 지우는 이 일회성 이관에는 쓸 수
    // 없다 — 윈도우를 걸면 그 밖의 이벤트는 옮겨지지도 않은 채 캘린더와 함께
    // 구글에서 영구히 사라진다. 하필 아무도 안 보고 있는 오래된·먼 미래의
    // 일정만 조용히 지워지는 셈이다.
    // "남으면 지우지 않는다" 로 막는 것도 답이 아니다. 윈도우가 걸린 목록은 그
    // 이벤트들을 영영 보지 못하므로 회수가 끝나지 않고 전용 캘린더가 영원히 남는다.
    //
    // 한 실행이 길어지는 것은 아래 세 상한(MAX_RETIRE_MOVES · deadlineAt ·
    // 페이지 예산)이 막고, 다 훑지 못한 나머지는 다음 실행이 이어받는다.
    // 이벤트 수 상한만으로는 부족하다 — 500번의 move 는 람다 예산을 통째로 먹을
    // 수 있으므로 시간 상한도 같이 건다. 무엇에 걸리든 결과는 같다: 깨끗하게 멈춘다.
    const deadlineAt = options.deadlineAt || Number.POSITIVE_INFINITY;
    let pageToken = "";
    let capped = false;
    let gone = false;
    let listFailure = "";

    for (let page = 0; page < DEFAULT_MAX_PAGES; page += 1) {
      // singleEvents=false 여야 반복 일정이 마스터로 온다. 마스터는 옮길 수 있고
      // 인스턴스 하나만 따로 옮기는 것은 불가능하다.
      // https://developers.google.com/workspace/calendar/api/v3/reference/events/move
      const query = {
        singleEvents: "false",
        showDeleted: "false",
        maxResults: String(DEFAULT_PAGE_SIZE),
      };
      if (pageToken) query.pageToken = pageToken;
      const listed = await googleFetch(token, "GET", eventsPath(dedicatedId), null, { query, fetchImpl });
      // 캘린더가 이미 없으면 회수는 사실상 끝난 것이다. 남은 정리(행·연동)를
      // 그대로 이어서 해야 integration.calendar_id 가 죽은 id 에 묶이지 않는다.
      if (listed.status === 404 || listed.status === 410) { gone = true; break; }
      if (!listed.ok) { listFailure = `list_${listed.status}`; break; }

      for (const event of Array.isArray(listed.data?.items) ? listed.data.items : []) {
        const eventId = cleanText(event?.id, 1024);
        if (!eventId) { skipped += 1; continue; }
        // 취소된 이벤트는 옮길 것도 남을 것도 없다. showDeleted=false 라 보통
        // 오지도 않지만, 왔다고 회수를 영원히 막게 두지는 않는다(=세지 않는다).
        if (eventIsCancelled(event)) continue;
        // 반복 예외(인스턴스)는 마스터를 따라 옮겨진다. 따로 옮기려 하면 400 이다.
        if (cleanText(event.recurringEventId)) { skipped += 1; continue; }
        // 구글 문서: "Only `default` events can be moved; birthday, focusTime,
        // fromGmail, outOfOffice and workingLocation events cannot be moved."
        const eventType = cleanText(event.eventType);
        if (eventType && eventType !== "default") { skipped += 1; continue; }
        if (moved >= MAX_RETIRE_MOVES || Date.now() >= deadlineAt) { capped = true; break; }

        const result = await googleFetch(token, "POST", `${eventsPath(dedicatedId, eventId)}/move`, null, {
          // sendUpdates=none: 캘린더를 옮겼다고 참석자에게 메일이 가면 안 된다.
          query: { destination: primary.id, sendUpdates: "none" },
          fetchImpl,
        });
        if (!result.ok) { failed += 1; continue; }
        moved += 1;
        await repointMovedScheduleRows(ctx, code, dedicatedId, eventId, result.data, primary);
      }

      pageToken = cleanText(listed.data?.nextPageToken);
      if (!pageToken || capped) break;
    }

    if (listFailure) return { ok: false, reason: listFailure, moved, skipped, failed };
    // 하나라도 남았으면 캘린더를 지우지 않는다. 남은 일정을 들고 있는 캘린더를
    // 지우는 것은 되돌릴 수 없는 데이터 손실이다.
    // pageToken 이 남은 채로 페이지 예산이 끝난 경우도 "남았다" 로 센다 —
    // 보지도 못한 페이지가 있는데 비었다고 판정하면 그 일정들이 통째로 사라진다.
    if (!gone && (capped || Boolean(pageToken) || skipped > 0 || failed > 0)) {
      return { ok: false, reason: "pending", moved, skipped, failed };
    }

    // 쓸어담기 update. 위의 이벤트별 update 는 google_event_id 로 정확히 짚지만,
    // 반복 시리즈의 MI 행은 인스턴스 행이라 google_event_id 에 인스턴스 id 가,
    // google_recurring_event_id 에 마스터 id 가 들어 있다. 마스터를 옮겨도
    // 인스턴스 id 로는 잡히지 않으므로, 캘린더를 비운 것이 확인된 지금 한 번에
    // 남은 행 전부를 새 캘린더로 옮긴다. 두 패스가 모두 필요한 이유가 이것이다.
    const swept = await runWithOptionalColumns(() => ctx.supabaseAdmin
      .from("schedule_items")
      .update(withoutDisabledColumns({
        google_calendar_id: primary.id,
        google_calendar_name: primary.name || null,
      }))
      .eq("owner_agency_code", code)
      .eq("google_calendar_id", dedicatedId)
      .then((response) => response || { error: null }, (error) => ({ error })));
    if (swept?.error) return { ok: false, reason: "sweep", moved, skipped, failed };

    if (!gone) {
      // calendars.delete 는 보조 캘린더를 지운다.
      // DELETE https://www.googleapis.com/calendar/v3/calendars/{calendarId}
      const removed = await googleFetch(token, "DELETE", `/calendars/${encodeURIComponent(dedicatedId)}`, null, { fetchImpl });
      if (!removed.ok && removed.status !== 404 && removed.status !== 410) {
        return { ok: false, reason: `delete_${removed.status}`, moved, skipped, failed };
      }
    }

    await ctx.supabaseAdmin
      .from("owner_google_calendar_sync")
      .delete()
      .eq("owner_agency_code", code)
      .eq("google_calendar_id", dedicatedId)
      .then(() => {}, () => {});

    const cleared = await ctx.supabaseAdmin
      .from("owner_google_integrations")
      .update({ calendar_id: null, updated_at: new Date().toISOString() })
      .eq("owner_agency_code", code)
      .then((response) => response || { error: null }, (error) => ({ error }));
    // 여기서 실패하면 연동 행은 죽은 캘린더를 가리킨 채로 남는다. 다음 실행의
    // 목록 조회가 404 를 받아 gone 분기로 들어와 같은 자리를 다시 정리한다.
    if (cleared?.error) return { ok: false, reason: "storage", moved, skipped, failed };

    // ownerAgencyCode 는 담지 않는다 — sanitizeAuditMetadata 가 대행사 코드 키를
    // 통째로 지우므로 담아 봐야 사라진다.
    await recordRetireAudit(ctx, {
      calendarId: cleanText(dedicatedId, 200),
      primaryCalendarId: cleanText(primary.id, 200),
      moved,
      skipped,
      failed,
      alreadyGone: gone,
    });
    return { ok: true, retired: true, moved, skipped, failed, calendarId: dedicatedId, primaryId: primary.id };
  } catch (error) {
    // 어떤 예외도 동기화를 끌어내리지 않는다. 다음 실행이 다시 시도한다.
    return { ok: false, reason: "unexpected", moved, skipped, failed };
  }
}

// ─────────────────────────────────────────────────────────────
// 오케스트레이션
// ─────────────────────────────────────────────────────────────

export async function runOwnerCalendarSync(ctx, env, ownerCode, options = {}) {
  const code = normalizeCode(ownerCode || primaryAgencyCode(env));
  const fetchImpl = options.fetchImpl || fetch;
  const nowMs = options.now || Date.now();
  // 개인 캘린더 실행만 이 값을 싣는다({role, code}). 없으면 이 함수의 모든
  // 질의는 예전과 글자 하나 다르지 않다 — 대표님 운영 동기화가 그 경로다.
  const personal = options.personal || null;
  const empty = { pushed: 0, pushFailed: 0, calendars: [], changed: 0 };

  const config = googleOauthConfig(env);
  if (!config.clientId || !config.clientSecret) {
    return { ok: false, reason: "env", ...empty, lastSyncAt: null };
  }
  const { integration, error } = await loadOwnerGoogleIntegration(ctx, code);
  if (error || !integration) {
    return { ok: false, reason: "not-connected", ...empty, lastSyncAt: null };
  }
  // needs_reconnect 인 동안 구글을 계속 두드리면 400 폭풍이 난다.
  if (integration.sync_status === "needs_reconnect") {
    return { ok: true, needsReconnect: true, ...empty, lastSyncAt: integration.last_sync_at || null };
  }

  const token = await refreshAccessToken(integration.refresh_token, env, fetchImpl);
  if (!token.ok) {
    if (token.reason === "invalid_grant") {
      await markIntegrationSyncStatus(ctx, code, "needs_reconnect", "구글 재연결이 필요합니다.");
      return { ok: true, needsReconnect: true, ...empty, lastSyncAt: integration.last_sync_at || null };
    }
    await markIntegrationSyncStatus(ctx, code, "error", "구글 토큰을 갱신하지 못했습니다.");
    return { ok: false, reason: "token", ...empty, lastSyncAt: integration.last_sync_at || null };
  }

  const deadlineAt = Date.now() + (options.budgetMs || DEFAULT_BUDGET_MS);

  // 전용 캘린더 회수가 push/pull 보다 먼저다. 이 실행이 만드는 카탈로그가 이미
  // 정리된 상태를 반영해야, 방금 지운 캘린더가 같은 실행에서 다시 목록에 오르지 않는다.
  // 실패해도 결과를 바꾸지 않는다 — 다음 실행이 같은 자리에서 이어 시도한다.
  const retired = await retireDedicatedCalendar(ctx, env, code, integration, token.accessToken, {
    now: nowMs,
    deadlineAt,
    fetchImpl,
  });
  // 실제로 지웠다면 이번 실행의 나머지는 calendar_id 가 비어 있는 사본으로 돈다.
  // 그러지 않으면 resolveOwnerCalendars 가 죽은 캘린더를 다시 동기화 대상에 올린다.
  const activeIntegration = retired.retired ? { ...integration, calendar_id: null } : integration;

  const push = await pushPendingRows(ctx, env, code, activeIntegration, token.accessToken, {
    pushLimit: options.pushLimit,
    personal,
    fetchImpl,
  });

  const calendars = await resolveOwnerCalendars(ctx, code, activeIntegration, {
    accessToken: token.accessToken,
    fetchImpl,
  });

  // 쓰기 가능한 캘린더 목록 캐시를 이 실행에 얹어 갱신한다. 실패는 무시한다 —
  // 목록이 낡아도 동기화 자체는 성립하고, GET 은 캐시만 읽는다.
  await refreshOwnerCalendarCatalog(ctx, code, token.accessToken, { fetchImpl });

  // 마지막 full sync 가 하루 넘게 지났으면 이번 실행을 full 로 올린다.
  // incremental 은 "변경된" 이벤트만 주므로, 시간이 흘러 윈도우 안으로 들어온
  // (그러나 변경되지 않은) 이벤트는 full sync 없이는 영원히 오지 않는다.
  const results = [];
  const fullInterval = fullSyncIntervalMs(code, env);
  for (const calendarRow of calendars) {
    const lastFull = new Date(cleanText(calendarRow.last_full_sync_at)).getTime();
    const stale = !Number.isFinite(lastFull) || nowMs - lastFull >= fullInterval;
    const mode = options.mode === "full" || stale ? "full" : "incremental";
    results.push(await syncOneCalendar(ctx, code, calendarRow, token.accessToken, {
      mode,
      now: nowMs,
      deadlineAt,
      maxPages: options.maxPages,
      pageSize: options.pageSize,
      personal,
      fetchImpl,
    }));
  }

  const changed = results.reduce((total, result) => total + result.imported + result.updated + result.deleted, 0);
  const failed = results.find((result) => result.error);
  const lastSyncAt = new Date(nowMs).toISOString();
  await ctx.supabaseAdmin
    .from("owner_google_integrations")
    .update({
      last_sync_at: lastSyncAt,
      sync_status: failed ? "error" : "ok",
      sync_error: failed ? cleanText(failed.error, 500) : null,
      updated_at: lastSyncAt,
    })
    .eq("owner_agency_code", code)
    .then(() => {}, () => {});

  return {
    ok: true,
    needsReconnect: false,
    pushed: push.pushed,
    pushFailed: push.pushFailed,
    calendars: results,
    changed,
    lastSyncAt,
    error: failed ? failed.error : null,
  };
}

// ─────────────────────────────────────────────────────────────
// 쓰기 가능한 캘린더 목록
// ─────────────────────────────────────────────────────────────

// 구글에서 목록을 새로 받아 캐시에 적재한다. 실패해도 절대 던지지 않는다 —
// 이 갱신은 동기화의 부산물이지 성공 조건이 아니다.
export async function refreshOwnerCalendarCatalog(ctx, ownerCode, accessToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const code = normalizeCode(ownerCode);
  try {
    // minAccessRole 을 걸지 않는다 — 공휴일·구독한 공유 캘린더처럼 읽기 전용인
    // 것까지 전부 목록에 올려야 구글 사이드바와 같은 목록이 된다.
    // showHidden:"false" 는 유지한다(대표님이 구글에서 숨긴 것은 여기서도 안 보인다).
    const result = await googleFetch(accessToken, "GET", "/users/me/calendarList", null, {
      query: { showHidden: "false", showDeleted: "false", maxResults: String(MAX_CALENDAR_CATALOG) },
      fetchImpl,
    });
    if (!result.ok) return { ok: false, reason: `list_${result.status}`, saved: 0 };
    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    if (!items.length) return { ok: true, saved: 0 };

    // 이미 있는 행의 calendar_role 은 건드리지 않는다. dedicated/primary 를
    // secondary 로 덮으면 다음 동기화가 기본 캘린더를 다시 찾아 나선다.
    // calendar_visible 도 함께 읽는다 — 아래에서 "이미 아는 캘린더인가"를
    // 판정해 MI 토글을 덮어쓰지 않기 위해서다.
    let known = new Map();
    try {
      const columns = ["google_calendar_id", "calendar_role", "calendar_visible"];
      const { data } = await runWithOptionalColumns(() => ctx.supabaseAdmin
        .from("owner_google_calendar_sync")
        .select(activeColumns(columns).join(","))
        .eq("owner_agency_code", code)
        .then((response) => response || { data: null, error: null }, (error) => ({ data: null, error })),
      OPTIONAL_CALENDAR_CATALOG_COLUMNS);
      known = new Map((data || []).map((row) => [row.google_calendar_id, row]));
    } catch (error) {
      known = new Map();
    }

    const nowIso = new Date().toISOString();
    let saved = 0;
    for (const item of items) {
      if (!item || item.deleted === true) continue;
      const id = cleanText(item.id, 1024);
      if (!id) continue;
      const knownRow = known.get(id);
      // 캘린더 색의 정본은 colorId(1~24)다. 레거시 16진만 보고 옮기면 표에 없는
      // 값이나 어긋난 값이 미묘하게 다른 색으로 굳는다(대표님 기본 캘린더의
      // 파랑이 그랬다). 그래서 옮기는 일은 화면이 아니라 적재하는 여기서 딱
      // 한 번 한다 — colorId 가 먼저, 없으면 레거시 표, 그것도 없으면 원본 통과.
      // 글자색도 옮긴 색 위에서 다시 정한다. 구글이 준 foregroundColor 는 레거시
      // 배경에 맞춘 값이라 모던 팔레트 위에서는 대비가 어긋난다.
      const background = modernCalendarColor(item.backgroundColor, item.colorId);
      const values = {
        owner_agency_code: code,
        google_calendar_id: id,
        calendar_role: cleanText(knownRow?.calendar_role) || "secondary",
        calendar_summary: cleanText(item.summaryOverride || item.summary, 200) || null,
        calendar_access_role: cleanText(item.accessRole, 40) || null,
        calendar_is_primary: item.primary === true,
        calendar_writable: WRITABLE_ACCESS_ROLES.has(cleanText(item.accessRole)),
        calendar_catalog_at: nowIso,
        calendar_background_color: hexColor(background),
        calendar_foreground_color: hexColor(readableTextColor(background)),
        calendar_selected: item.selected === true,
        // calendar_visible 은 MI 안에서만 쓰는 토글이다. 이미 아는 캘린더면 대표님이
        // 눌러 둔 값을 절대 덮지 않고, 처음 보는 캘린더에만 기본값을 넣는다.
        // (구글에서 체크되어 있거나 기본 캘린더면 켜진 채로 시작한다.)
        calendar_visible: knownRow ? knownRow.calendar_visible !== false : (item.selected === true || item.primary === true),
      };
      // 두 마이그레이션은 따로 적용될 수 있으므로 재시도를 겹쳐 건다.
      const written = await runWithOptionalColumns(() => runWithOptionalColumns(() => ctx.supabaseAdmin
        .from("owner_google_calendar_sync")
        .upsert(withoutDisabledColumns(values), { onConflict: "owner_agency_code,google_calendar_id" })
        .then((response) => response || { error: null }, (error) => ({ error })), OPTIONAL_CALENDAR_CATALOG_COLUMNS),
      OPTIONAL_CALENDAR_SYNC_COLUMNS);
      if (!written?.error) saved += 1;
    }
    return { ok: true, saved };
  } catch (error) {
    return { ok: false, reason: "network", saved: 0 };
  }
}

// 연동 행이 가리키는 전용 캘린더만 아는 상태에서 만들어 내는 최소 항목.
// 카탈로그를 못 읽었을 때의 안전한 바닥값이다.
function inferredDedicatedEntry(integration) {
  const dedicatedId = cleanText(integration?.calendar_id);
  if (!dedicatedId) return null;
  return {
    id: dedicatedId,
    name: DEDICATED_CALENDAR_SUMMARY,
    primary: false,
    dedicated: true,
    accessRole: "owner",
    writable: true,
    readOnly: false,
    visible: true,
    selected: true,
    color: null,
    textColor: null,
    group: "own",
  };
}

// 사이드바(캘린더 목록) 전체. DB 만 읽는다 — GET /api/work-items 는 hot path 라
// 구글을 부르면 안 된다. 읽기 전용 캘린더도 그대로 담아 내보내고, 쓰기 가능
// 여부는 writable 로 알린다.
export async function listOwnerCalendarCatalog(ctx, ownerCode, integration = null) {
  const code = normalizeCode(ownerCode);
  const dedicatedId = cleanText(integration?.calendar_id);
  const inferred = inferredDedicatedEntry(integration);
  const fallback = inferred ? [inferred] : [];
  try {
    const columns = [
      "google_calendar_id", "calendar_role",
      ...OPTIONAL_CALENDAR_SYNC_COLUMNS,
      ...OPTIONAL_CALENDAR_CATALOG_COLUMNS,
    ];
    // 두 선택 열 묶음은 서로 다른 마이그레이션에서 온다. 한쪽만 적용된 창에서도
    // 각각 한 번씩 재시도해 내려가도록 재시도를 겹쳐 건다.
    const result = await runWithOptionalColumns(() => runWithOptionalColumns(() => ctx.supabaseAdmin
      .from("owner_google_calendar_sync")
      .select(activeColumns(columns).join(","))
      .eq("owner_agency_code", code)
      .then((response) => response || { data: null, error: null }, (error) => ({ data: null, error })),
    OPTIONAL_CALENDAR_CATALOG_COLUMNS), OPTIONAL_CALENDAR_SYNC_COLUMNS);
    const rows = Array.isArray(result?.data) ? result.data : [];

    const entries = new Map();
    for (const row of rows) {
      const id = cleanText(row?.google_calendar_id);
      if (!id) continue;
      const role = cleanText(row.calendar_role);
      const dedicated = Boolean(dedicatedId) && id === dedicatedId;
      const primary = row.calendar_is_primary === true || role === "primary";
      const accessRole = cleanText(row.calendar_access_role, 40) || (dedicated || primary ? "owner" : "");
      // 저장해 둔 값은 이제 refreshOwnerCalendarCatalog 가 colorId 로 옮겨 둔
      // 모던 16진이다. 그래도 여기서 한 번 더 부르는 이유는, 그 이전에 적재된
      // 행이 아직 레거시 값을 들고 있기 때문이다 — 그 행은 여기서 옮겨져 나가고
      // 다음 카탈로그 갱신 때 저장 값 자체가 바로잡힌다. 이미 옮겨진 값에는
      // 무해한 통과다(모던 16진은 레거시 표의 키가 아니라 원본 그대로 나온다).
      // 표에 없는 색도 원본이 그대로 나온다 — 모르는 색을 지어내지 않는다.
      const color = modernCalendarColor(row.calendar_background_color) || null;
      entries.set(id, {
        id,
        name: cleanText(row.calendar_summary, 200) || (dedicated ? DEDICATED_CALENDAR_SUMMARY : id),
        primary,
        dedicated,
        accessRole,
        // writable 과 readOnly 는 일부러 서로의 여집합이 아니다.
        //  · writable  = "여기에 써도 된다" 는 긍정 신호. 다이얼로그의 캘린더
        //    선택 목록을 채우는 데만 쓴다. 모르면 false(=목록에 올리지 않는다).
        //  · readOnly  = "여기에는 쓸 수 없다" 는 긍정 신호. 수정·삭제를 막는
        //    데만 쓴다. 모르면 false(=막지 않는다).
        // 둘 다 false 인 "아직 모르는 캘린더" 가 정상 상태이고, 그때는 목록에
        // 올리지 않되 편집은 허용한다. 여집합으로 묶으면 카탈로그가 차기 전의
        // 모든 캘린더가 잠긴다.
        writable: row.calendar_writable === true || dedicated || primary,
        // accessRole 이 비어 있으면(마이그레이션 전·resolveOwnerCalendars 가 막
        // 만든 행) 읽기 전용이라고 단정하지 않는다.
        readOnly: READ_ONLY_ACCESS_ROLES.has(accessRole),
        // 열이 없거나 null 이면 보이는 쪽이 기본이다(fail open).
        visible: row.calendar_visible !== false,
        selected: row.calendar_selected === true,
        color,
        // 글자색도 옮긴 색 위에서 다시 정한다. 구글이 준 foreground 는 레거시
        // 배경에 맞춘 값이라 현대 팔레트 위에서는 대비가 어긋날 수 있다.
        // 색을 모를 때만 구글이 준 값으로 떨어진다.
        textColor: readableTextColor(color) || cleanText(row.calendar_foreground_color, 7) || null,
        // 구글 사이드바의 "내 캘린더 / 다른 캘린더" 구분과 같은 기준이다.
        group: accessRole === "owner" || dedicated || primary ? "own" : "other",
      });
    }
    if (dedicatedId && !entries.has(dedicatedId) && inferred) entries.set(dedicatedId, inferred);

    return [...entries.values()].sort((left, right) => {
      if (left.group !== right.group) return left.group === "own" ? -1 : 1;
      if (left.primary !== right.primary) return left.primary ? -1 : 1;
      if (left.dedicated !== right.dedicated) return left.dedicated ? -1 : 1;
      return left.name.localeCompare(right.name, "ko");
    });
  } catch (error) {
    return fallback;
  }
}

// 카탈로그에서 다이얼로그용 "쓰기 가능한 캘린더" 목록을 뽑는다. 순수 함수라
// 목록을 이미 들고 있는 호출부는 DB 를 다시 읽지 않아도 된다.
export function writableCalendarsFromCatalog(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.writable)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      primary: entry.primary === true,
      // writable 이 참이면 최소한 writer 다. 카탈로그 열이 없어 역할을 모를 때의 바닥값.
      accessRole: entry.accessRole || "writer",
      dedicated: entry.dedicated === true,
    }))
    .sort((left, right) => {
      if (left.dedicated !== right.dedicated) return left.dedicated ? -1 : 1;
      if (left.primary !== right.primary) return left.primary ? -1 : 1;
      return left.name.localeCompare(right.name, "ko");
    });
}

// DB 만 읽는다. GET /api/work-items 는 hot path 라 구글을 부르면 안 된다.
export async function listOwnerWritableCalendars(ctx, ownerCode, integration = null) {
  return writableCalendarsFromCatalog(await listOwnerCalendarCatalog(ctx, ownerCode, integration));
}

// MI 사이드바 체크 상태만 바꾼다. 구글의 calendarList.selected 는 쓰기 가능한
// 필드지만 절대 되쓰지 않는다 — MI 에서 끈 것이 대표님의 구글 화면까지
// 바꿔서는 안 되기 때문이다. 그래서 이 함수는 구글을 전혀 부르지 않는다.
export async function setOwnerCalendarVisibility(ctx, ownerCode, calendarId, visible) {
  const code = normalizeCode(ownerCode);
  const id = cleanText(calendarId, 1024);
  if (!id) return { ok: false, reason: "not_found" };
  const run = () => {
    // 열이 이미 내려가 있으면 DB 를 건드리지 않고 "미지원"으로 돌아간다.
    if (!optionalColumnEnabled("calendar_visible")) return Promise.resolve({ data: null, error: null, unsupported: true });
    return ctx.supabaseAdmin
      .from("owner_google_calendar_sync")
      .update({ calendar_visible: Boolean(visible), updated_at: new Date().toISOString() })
      .eq("owner_agency_code", code)
      .eq("google_calendar_id", id)
      .select("google_calendar_id")
      .maybeSingle()
      .then((response) => response || { data: null, error: null }, (error) => ({ data: null, error }));
  };
  try {
    const result = await runWithOptionalColumns(run, OPTIONAL_CALENDAR_CATALOG_COLUMNS);
    if (result?.unsupported || !optionalColumnEnabled("calendar_visible")) return { ok: false, reason: "unsupported" };
    if (result?.error) return { ok: false, reason: "storage" };
    if (!result?.data) return { ok: false, reason: "not_found" };
    return { ok: true, updated: true };
  } catch (error) {
    return { ok: false, reason: "storage" };
  }
}

// ─────────────────────────────────────────────────────────────
// 다이얼로그 쓰기 (Google-first)
// ─────────────────────────────────────────────────────────────

// 대표가 다이얼로그에서 저장을 누른 경로 전용이다. 구글이 정본이므로 여기서
// 실패하면 호출자는 MI 에 아무것도 남기지 않고 502 를 돌려줘야 한다.
// skipped 를 돌려주면 예전 로컬 저장 경로를 그대로 타면 된다.
export async function writeRowToGoogleFirst(ctx, env, access, row, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  if (!ownerSyncableRows(access, [row]).length) return { ok: true, skipped: true, reason: "scope" };
  // 환경변수가 있어도 연동 조회를 못 하면 여기서 끝낸다. DB 접근보다 먼저다.
  if (!canLoadOwnerIntegration(ctx)) return { ok: true, skipped: true, reason: "no-storage" };
  const config = googleOauthConfig(env);
  if (!config.clientId || !config.clientSecret) return { ok: true, skipped: true, reason: "env" };
  const ownerCode = normalizeCode(access.ownerAgencyCode || primaryAgencyCode(env));

  // 조회가 터졌든(throw) 연동 행이 없든 결과는 같다 — skipped 로 물러나
  // 호출부가 예전 로컬 저장 경로를 그대로 타게 한다. ok:false 는 내지 않는다.
  let integration = null;
  try {
    const loaded = await loadOwnerGoogleIntegration(ctx, ownerCode);
    if (loaded.error || !loaded.integration) return { ok: true, skipped: true, reason: "not-connected" };
    integration = loaded.integration;
  } catch (error) {
    return { ok: true, skipped: true, reason: "not-connected" };
  }

  const token = await refreshAccessToken(integration.refresh_token, env, fetchImpl);
  if (!token.ok) {
    if (token.reason === "invalid_grant") {
      await markIntegrationSyncStatus(ctx, ownerCode, "needs_reconnect", "구글 재연결이 필요합니다.");
      return { ok: false, reason: "needs_reconnect" };
    }
    return { ok: false, reason: "token" };
  }

  let calendarId = cleanText(options.calendarId)
    || cleanText(row.google_calendar_id)
    || cleanText(integration.calendar_id);
  // 전용 캘린더를 회수한 뒤 integration.calendar_id 는 null 이다. 그때 MI 가 만든
  // 일정의 기본 목적지는 대표님의 기본 캘린더다. 카탈로그 캐시가 먼저라 다이얼로그
  // 저장(hot path)이 매번 구글을 부르지는 않는다.
  let primaryName = "";
  if (!calendarId) {
    const primary = await resolveOwnerPrimaryCalendar(ctx, ownerCode, {
      accessToken: token.accessToken,
      fetchImpl,
    });
    calendarId = primary.id;
    primaryName = primary.name;
  }
  if (!calendarId) return { ok: false, reason: "no_calendar" };

  const patching = options.mode === "patch";
  const createConference = options.createConference === true;
  const payload = buildGoogleEventPayload(row, {
    ownerCode,
    clientName: cleanText(options.clientName) || rowClientName(row),
    createConference,
    details: {
      mode: patching ? "patch" : "insert",
      ...(Array.isArray(options.detailFields) ? { fields: options.detailFields } : {}),
    },
  });
  if (!payload) return { ok: false, reason: "invalid_row" };

  // insert 는 항상 버전 1 이어야 Meet 생성 요청과 응답이 오간다.
  // patch 는 이번 요청이 실제로 회의를 만들 때만 버전 1 을 쓴다. 버전 0 patch 는
  // conferenceData 를 손대지 않으므로 기존 Meet 링크가 지워질 위험이 없다.
  const query = { sendUpdates: options.sendUpdates === "none" ? "none" : "all" };
  if (!patching || createConference) query.conferenceDataVersion = "1";

  try {
    let result = null;
    if (patching) {
      const targetEventId = cleanText(options.targetEventId) || cleanText(row.google_event_id);
      if (!targetEventId) return { ok: false, reason: "no_event" };
      // 반복 인스턴스 수정은 인스턴스 id 로 PATCH 한다. 구글 가이드는 update(PUT)
      // 를 권하지만 PATCH 는 부분 갱신이라 우리가 보내지 않은 필드를 지우지 않는다.
      const path = eventsPath(calendarId, targetEventId);
      const headers = cleanText(row.google_etag) ? { "if-match": cleanText(row.google_etag) } : {};
      // "모든 일정" 수정은 마스터를 고친다. 마스터의 기준 날짜를 인스턴스의
      // 날짜로 밀면 반복 전체가 끌려가므로, 마스터를 한 번 읽어 날짜는 지키고
      // 시각·길이만 옮긴다. 읽지 못하면 start/end 를 통째로 빼서 시리즈의
      // 시간을 건드리지 않는다.
      if (options.preserveSeriesAnchor === true) {
        delete payload.start;
        delete payload.end;
        const current = await googleFetch(token.accessToken, "GET", path, null, { fetchImpl });
        if (current.ok && current.data) {
          const anchored = seriesAnchorTimes(current.data, row);
          if (anchored) {
            payload.start = anchored.start;
            payload.end = anchored.end;
          }
        }
      }
      result = await googleFetch(token.accessToken, "PATCH", path, payload, { headers, query, fetchImpl });
      if (result.status === 412) {
        const fresh = await googleFetch(token.accessToken, "GET", path, null, { fetchImpl });
        if (fresh.ok && fresh.data?.etag) {
          result = await googleFetch(token.accessToken, "PATCH", path, payload, {
            headers: { "if-match": String(fresh.data.etag) },
            query,
            fetchImpl,
          });
        }
      }
    } else {
      result = await googleFetch(token.accessToken, "POST", eventsPath(calendarId), payload, { query, fetchImpl });
    }
    if (!result.ok || !result.data?.id) return { ok: false, reason: `google_${result.status}` };

    const event = result.data;
    let calendarName = cleanText(options.calendarName, 200) || cleanText(primaryName, 200);
    if (!calendarName) {
      const catalog = await listOwnerWritableCalendars(ctx, ownerCode, integration);
      calendarName = cleanText(catalog.find((entry) => entry.id === calendarId)?.name, 200);
    }
    return {
      ok: true,
      event,
      calendarId,
      calendarName: calendarName || null,
      integration,
      accessToken: token.accessToken,
      values: {
        ...syncedRowValues(event),
        google_calendar_id: calendarId,
        ...googleMirrorFields(event),
        google_calendar_name: calendarName || null,
      },
    };
  } catch (unexpected) {
    return { ok: false, reason: "network" };
  }
}

// 마스터 1개를 만든 직후 동기화 윈도우 안의 인스턴스를 받아온다. 행은 쓰지
// 않는다 — MI 소유 필드를 아는 쪽(work-items)이 조립해야 하기 때문이다.
export async function materializeRecurringInstances(ctx, env, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const accessToken = cleanText(options.accessToken);
  const calendarId = cleanText(options.calendarId);
  const masterEventId = cleanText(options.masterEventId);
  if (!accessToken || !calendarId || !masterEventId) return { ok: false, reason: "input", instances: [] };
  const window = syncWindow(options.now || Date.now());
  const instances = [];
  let pageToken = "";
  try {
    for (let page = 0; page < MAX_INSTANCE_PAGES; page += 1) {
      const query = {
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        maxResults: String(MAX_INSTANCE_PAGE_SIZE),
        showDeleted: "false",
      };
      if (pageToken) query.pageToken = pageToken;
      const result = await googleFetch(
        accessToken,
        "GET",
        `${eventsPath(calendarId, masterEventId)}/instances`,
        null,
        { query, fetchImpl },
      );
      if (!result.ok) return { ok: false, reason: `google_${result.status}`, instances };
      for (const item of Array.isArray(result.data?.items) ? result.data.items : []) {
        if (!item || !cleanText(item.id) || eventIsCancelled(item)) continue;
        instances.push(item);
      }
      pageToken = cleanText(result.data?.nextPageToken);
      if (!pageToken) break;
    }
  } catch (error) {
    return { ok: false, reason: "network", instances };
  }
  return { ok: true, instances };
}

// ─────────────────────────────────────────────────────────────
// 새 캘린더 만들기 + 참가자(ACL) 관리
//
// 일정마다 참석자를 넣는 대신 캘린더 자체를 공유해 두고 거기에 일정을 쌓는
// 방식이다. 공유는 구글이 정본이라 MI 에는 아무 상태도 만들지 않는다 —
// 규칙 목록은 매번 구글에서 읽는다.
//
// 확인한 구글 문서(재확인 불필요):
//   calendars.insert https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert
//     POST https://www.googleapis.com/calendar/v3/calendars, 필수 본문 필드는
//     summary 하나뿐이고 응답은 Calendars 리소스(id, summary…)다.
//     스코프는 https://www.googleapis.com/auth/calendar 면 충분하다.
//   acl.insert       https://developers.google.com/workspace/calendar/api/v3/reference/acl/insert
//     POST /calendars/{calendarId}/acl, 본문 { role, scope:{ type, value } },
//     role ∈ none|freeBusyReader|reader|writerWithoutPrivateAccess|writer|owner,
//     scope.type ∈ default|user|group|domain, 쿼리 sendNotifications 기본값 true.
//   acl.list   = GET    /calendars/{calendarId}/acl
//   acl.delete = DELETE /calendars/{calendarId}/acl/{ruleId}
//
// 이 파일의 규칙대로 아래 네 함수는 절대 던지지 않는다. 실패는 전부 좁은
// reason 문자열이 실린 결과 객체로 나가고, 문구는 HTTP 층에서만 정한다.
// ─────────────────────────────────────────────────────────────
export const MAX_CALENDAR_INVITES = 20;
// 화면에서 내주는 권한은 둘뿐이다. owner 를 남에게 주면 대표님이 캘린더 통제권을
// 잃고, freeBusyReader/none 은 MI 에서 쓸 데가 없다.
export const CALENDAR_INVITE_ROLES = new Set(["writer", "reader"]);

const CALENDAR_SUMMARY_MAX = 200;
const ACL_RULE_ID_MAX = 200;
// 특정 사람이 아니라 "범위 전체"를 가리키는 scope 다. 목록에는 보여야 하지만
// (화면의 "누구나 볼 수 있음") 지우게 하면 안 된다.
const ACL_SCOPE_LOCKED = new Set(["default", "domain"]);

function aclPath(calendarId, ruleId = "") {
  const base = `/calendars/${encodeURIComponent(calendarId)}/acl`;
  return ruleId ? `${base}/${encodeURIComponent(ruleId)}` : base;
}

// 초대 목록 검증. 실패 사유를 한 단어씩 따로 돌려준다 — 하나로 뭉치면 화면이
// 인원 초과에도 "이메일 주소를 확인해주세요" 를 띄우게 되고, 그러면 대표님은
// 멀쩡한 주소를 계속 고쳐 넣는다. 문구는 HTTP 층이 이 사유를 보고 정한다.
function normalizeCalendarInvites(value) {
  // 초대는 선택이다. 안 보내면 빈 목록이지 오류가 아니다.
  if (value === undefined || value === null) return { ok: true, invites: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "invites" };
  // 상한은 자르지 않고 거절한다. 조용히 자르면 초대했다고 믿은 사람이 빠진다.
  if (value.length > MAX_CALENDAR_INVITES) return { ok: false, reason: "invites_max" };
  const seen = new Set();
  const invites = [];
  for (const entry of value) {
    // 문자열 하나만 온 경우도 받는다(다이얼로그가 주소만 보낼 때가 있다).
    const source = typeof entry === "string" ? { email: entry } : (entry || {});
    // 구글이 거절할 주소는 우리 쪽에서 먼저 막는다. 소문자로 정규화한 뒤
    // 중복을 지운다 — A@b.com 과 a@B.com 은 구글에서 같은 규칙 하나다.
    const email = cleanText(source.email, 320).toLowerCase();
    if (!isAttendeeEmail(email)) return { ok: false, reason: "invite_email" };
    const role = cleanText(source.role, 40) || "writer";
    if (!CALENDAR_INVITE_ROLES.has(role)) return { ok: false, reason: "invite_role" };
    if (seen.has(email)) continue;
    seen.add(email);
    invites.push({ email, role });
  }
  return { ok: true, invites };
}

// 네 함수가 공통으로 필요한 "연동 행 + 액세스 토큰". 가드 순서는
// writeRowToGoogleFirst 와 같게 두되, 여기서는 조용히 물러나지 않고 사유를
// 올린다 — 이 경로는 대표님이 버튼을 누른 결과라 실패를 화면에 말해야 한다.
async function resolveOwnerCalendarSession(ctx, env, ownerCode, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const code = normalizeCode(ownerCode);
  // 호출부가 방금 발급한 토큰을 넘기면 그대로 쓴다. 한 요청이 insert 뒤에
  // list 를 이어 부를 때 refresh 가 두 번 나가는 것을 막는 유일한 장치다.
  const supplied = cleanText(options.accessToken);
  if (supplied) {
    return { ok: true, integration: options.integration || null, accessToken: supplied };
  }
  const config = googleOauthConfig(env);
  if (!config.clientId || !config.clientSecret) return { ok: false, reason: "env" };
  // 연동 조회 자체가 불가능한 ctx 면 DB 를 건드리기 전에 물러난다.
  if (!canLoadOwnerIntegration(ctx)) return { ok: false, reason: "no-storage" };
  let integration = null;
  try {
    const loaded = await loadOwnerGoogleIntegration(ctx, code);
    if (loaded.error || !loaded.integration) return { ok: false, reason: "not-connected" };
    integration = loaded.integration;
  } catch (unexpected) {
    // 조회가 터진 것과 연동 행이 없는 것은 화면에서 같은 뜻이다 — 아직 연결 안 됨.
    return { ok: false, reason: "not-connected" };
  }
  const token = await refreshAccessToken(integration.refresh_token, env, fetchImpl);
  if (!token.ok) {
    if (token.reason === "invalid_grant") {
      // 만료된 refresh token 을 조용히 삼키면 "다시 연결 필요" 배지가 영영 안 뜬다.
      await markIntegrationSyncStatus(ctx, code, "needs_reconnect", "구글 재연결이 필요합니다.");
      return { ok: false, reason: "needs_reconnect" };
    }
    return { ok: false, reason: "token" };
  }
  return { ok: true, integration, accessToken: token.accessToken };
}

// 공유 설정은 "대표님이 소유한" 캘린더에서만 만진다. writer 권한만 있는 남의
// 캘린더의 참가자를 우리가 고치면 그 캘린더 주인 모르게 사람이 늘어난다.
// listOwnerCalendarCatalog 는 전용/기본 캘린더 행의 accessRole 을 "owner" 로
// 채워 주므로 카탈로그 열이 아직 없는 배포 창에서도 판정이 선다.
async function ownsCalendar(ctx, ownerCode, calendarId, integration) {
  try {
    const catalog = await listOwnerCalendarCatalog(ctx, ownerCode, integration);
    return catalog.some((entry) => entry.id === calendarId && entry.accessRole === "owner");
  } catch (unexpected) {
    // 판정을 못 하면 막는다. 공유는 되돌리기 어려우므로 여기만은 fail closed.
    return false;
  }
}

function mapAclRule(item) {
  const scopeType = cleanText(item?.scope?.type, 20) || "user";
  const email = cleanText(item?.scope?.value, 320).toLowerCase();
  return {
    id: cleanText(item?.id, ACL_RULE_ID_MAX),
    // scope.value 는 default 규칙에 아예 없다. 빈 문자열 대신 null 로 내보내
    // 화면이 "주소 없는 규칙"과 "주소가 빈 규칙"을 헷갈리지 않게 한다.
    email: email || null,
    role: cleanText(item?.role, 40),
    scopeType,
    // default/domain 은 목록에서 빼지 않고 표식만 단다. 빼 버리면 화면이
    // "누구나 볼 수 있음" 을 보여줄 수 없고, 대표님은 왜 공개인지 모른 채로 둔다.
    editable: !ACL_SCOPE_LOCKED.has(scopeType),
  };
}

function mapAclRules(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map(mapAclRule).filter((rule) => rule.id);
}

// (1) 새 캘린더 + 초대. 검증은 전부 구글을 부르기 전에 끝낸다.
export async function createOwnerCalendar(ctx, env, ownerCode, { summary, invites } = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const code = normalizeCode(ownerCode);
  // 이름은 자르지 않고 거절한다. 자르면 대표님이 지은 이름과 구글에 남은
  // 이름이 달라지고, 그 차이를 알 방법이 화면에 없다.
  const name = cleanText(summary);
  if (!name || name.length > CALENDAR_SUMMARY_MAX) return { ok: false, reason: "summary" };
  const parsed = normalizeCalendarInvites(invites);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const session = await resolveOwnerCalendarSession(ctx, env, code, options);
  if (!session.ok) return { ok: false, reason: session.reason };

  // calendars.insert 의 필수 본문 필드는 summary 하나지만 timeZone 을 함께
  // 보낸다. 안 보내면 구글 계정 기본 시간대를 따르고, MI 가 만드는 일정은
  // 전부 EVENT_TIMEZONE 기준이라 하루 경계가 어긋난다.
  let created = null;
  try {
    created = await googleFetch(session.accessToken, "POST", "/calendars",
      { summary: name, timeZone: EVENT_TIMEZONE }, { fetchImpl });
  } catch (unexpected) {
    return { ok: false, reason: "network" };
  }
  if (!created.ok || !created.data?.id) return { ok: false, reason: `google_${created.status}` };
  const calendarId = String(created.data.id);

  // (2)(3)(4) 가 먼저 거는 "대표님이 이 캘린더의 주인인가" 관문이 여기에는
  // 없다. 방금 대표님의 토큰으로 calendars.insert 를 한 캘린더라 소유권은
  // 구성상 보장되고, 그러므로 그 확인은 여기서 공허하다.
  const invited = [];
  const failedInvites = [];
  for (const invite of parsed.invites) {
    // 초대 한 건이 실패해도 나머지를 멈추지 않고 캘린더도 되돌리지 않는다 —
    // 되돌리는 방법이 방금 만든 캘린더의 삭제뿐이라 그쪽이 훨씬 위험하다.
    let rule = null;
    try {
      rule = await googleFetch(session.accessToken, "POST", aclPath(calendarId),
        { role: invite.role, scope: { type: "user", value: invite.email } },
        { query: { sendNotifications: "true" }, fetchImpl });
    } catch (unexpected) {
      failedInvites.push({ ...invite, reason: "network" });
      continue;
    }
    if (rule.ok) invited.push({ ...invite });
    else failedInvites.push({ ...invite, reason: `google_${rule.status}` });
  }

  // 방금 만든 캘린더를 카탈로그에 바로 심는다. 다음 동기화까지 기다리면
  // 사이드바에 안 보이고, 안 보이는 캘린더는 다이얼로그에서 고를 수도 없다.
  const values = {
    owner_agency_code: code,
    google_calendar_id: calendarId,
    calendar_role: "secondary",
    calendar_summary: name,
    // 우리가 만들었으므로 소유자는 대표님이고, 그래서 쓰기 가능하다.
    calendar_access_role: "owner",
    calendar_is_primary: false,
    calendar_writable: true,
    calendar_visible: true,
    calendar_catalog_at: new Date().toISOString(),
  };
  try {
    // 두 선택 열 묶음은 서로 다른 마이그레이션에서 온다. 한쪽만 적용된 창에서도
    // 각각 한 번씩 내려가도록 refreshOwnerCalendarCatalog 와 똑같이 겹쳐 건다.
    await runWithOptionalColumns(() => runWithOptionalColumns(() => ctx.supabaseAdmin
      .from("owner_google_calendar_sync")
      .upsert(withoutDisabledColumns(values), { onConflict: "owner_agency_code,google_calendar_id" })
      .then((response) => response || { error: null }, (error) => ({ error })), OPTIONAL_CALENDAR_CATALOG_COLUMNS),
    OPTIONAL_CALENDAR_SYNC_COLUMNS);
  } catch (unexpected) {
    // 캐시 적재 실패가 "캘린더는 만들어졌다" 는 사실을 뒤집지는 않는다.
  }

  await recordSyncAudit(ctx, "google_calendar_created", null, {
    calendarId: cleanText(calendarId, ACL_RULE_ID_MAX),
    summary: name,
    invited: invited.length,
    failed: failedInvites.length,
  });
  return { ok: true, calendarId, summary: name, invited, failedInvites, integration: session.integration, accessToken: session.accessToken };
}

// (2) 참가자 목록. 구글이 정본이라 매번 읽는다.
export async function listOwnerCalendarAcl(ctx, env, ownerCode, calendarId, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const code = normalizeCode(ownerCode);
  const id = cleanText(calendarId, 1024);
  if (!id) return { ok: false, reason: "calendar" };
  const session = await resolveOwnerCalendarSession(ctx, env, code, options);
  if (!session.ok) return { ok: false, reason: session.reason };
  if (!(await ownsCalendar(ctx, code, id, session.integration))) return { ok: false, reason: "forbidden" };
  try {
    const result = await googleFetch(session.accessToken, "GET", aclPath(id), null, { fetchImpl });
    if (!result.ok) return { ok: false, reason: `google_${result.status}` };
    return { ok: true, rules: mapAclRules(result.data), integration: session.integration, accessToken: session.accessToken };
  } catch (unexpected) {
    return { ok: false, reason: "network" };
  }
}

// (3) 참가자 추가.
export async function insertOwnerCalendarAcl(ctx, env, ownerCode, calendarId, { email, role } = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const code = normalizeCode(ownerCode);
  const id = cleanText(calendarId, 1024);
  if (!id) return { ok: false, reason: "calendar" };
  // 한 건도 목록과 같은 규칙으로 검증한다 — 화면 두 곳이 다른 주소를 받아들이면
  // 초대는 되는데 캘린더 생성은 안 되는 식으로 어긋난다.
  const parsed = normalizeCalendarInvites([{ email, role }]);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const [invite] = parsed.invites;
  if (!invite) return { ok: false, reason: "invite_email" };

  const session = await resolveOwnerCalendarSession(ctx, env, code, options);
  if (!session.ok) return { ok: false, reason: session.reason };
  if (!(await ownsCalendar(ctx, code, id, session.integration))) return { ok: false, reason: "forbidden" };
  try {
    // sendNotifications 는 기본값이 true 지만 명시해 둔다. 초대 메일이 나가는
    // 것은 대표님이 의도한 동작이고, 기본값이 바뀌면 조용히 안 나가게 된다.
    const result = await googleFetch(session.accessToken, "POST", aclPath(id),
      { role: invite.role, scope: { type: "user", value: invite.email } },
      { query: { sendNotifications: "true" }, fetchImpl });
    if (!result.ok) return { ok: false, reason: `google_${result.status}` };
    return { ok: true, rule: mapAclRule(result.data), integration: session.integration, accessToken: session.accessToken };
  } catch (unexpected) {
    return { ok: false, reason: "network" };
  }
}

// (4) 참가자 삭제.
export async function deleteOwnerCalendarAcl(ctx, env, ownerCode, calendarId, ruleId, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const code = normalizeCode(ownerCode);
  const id = cleanText(calendarId, 1024);
  const rule = cleanText(ruleId, ACL_RULE_ID_MAX);
  if (!id) return { ok: false, reason: "calendar" };
  if (!rule) return { ok: false, reason: "rule" };
  // (2) 가 editable:false 로 표시해 내보낸 그 규칙들이다. 화면이 "지울 수 없음"
  // 으로 그린 것을 API 는 지워 준다면 두 층의 말이 어긋나므로 여기서 거절한다.
  if (rule === "default" || rule.startsWith("domain:")) return { ok: false, reason: "rule_locked" };

  const session = await resolveOwnerCalendarSession(ctx, env, code, options);
  if (!session.ok) return { ok: false, reason: session.reason };
  if (!(await ownsCalendar(ctx, code, id, session.integration))) return { ok: false, reason: "forbidden" };
  try {
    const removed = await googleFetch(session.accessToken, "DELETE", aclPath(id, rule), null, { fetchImpl });
    // 이미 사라진 규칙(404/410)은 우리가 원하던 최종 상태와 같으므로 성공이다.
    // 화면에서 두 번 누른 것을 오류로 되돌려 줄 이유가 없다.
    if (!removed.ok && removed.status !== 404 && removed.status !== 410) {
      return { ok: false, reason: `google_${removed.status}` };
    }
    return { ok: true, ruleId: rule, integration: session.integration, accessToken: session.accessToken };
  } catch (unexpected) {
    return { ok: false, reason: "network" };
  }
}

export { DONE_PREFIX, decorateGoogleSummary, normalizeImportedTitle, undecorateGoogleSummary };

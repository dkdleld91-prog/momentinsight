import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { seoulDateKey } from "../calendar-domain.mjs";
import {
  DEDICATED_CALENDAR_SUMMARY,
  DONE_PREFIX,
  MAX_ATTENDEES,
  MAX_RECURRENCE_LINES,
  MAX_RECURRENCE_LINE_CHARS,
  buildGoogleEventPayload,
  cleanText,
  clientDisplayName,
  conferenceUriFromEvent,
  decorateGoogleSummary,
  googleFetch,
  googleOauthConfig,
  loadOwnerGoogleIntegration,
  normalizeCode,
  normalizeImportedTitle,
  refreshAccessToken,
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

// calendarList.accessRole 은 읽기 전용 필드이고 값은 이 다섯 중 하나다.
// freeBusyReader / reader / writerWithoutPrivateAccess / writer / owner.
// writerWithoutPrivateAccess 도 이벤트 읽기·쓰기 권한을 준다(비공개 일정만 못 본다).
export const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer", "writerWithoutPrivateAccess"]);

const disabledColumns = new Set();

export function resetOptionalColumns() {
  disabledColumns.clear();
}

export function disabledOptionalColumns() {
  return [...disabledColumns];
}

export function optionalColumnEnabled(column) {
  return !disabledColumns.has(cleanText(column));
}

// 한 묶음의 열은 같은 마이그레이션에서 함께 생긴다. 그중 하나가 없다면 나머지도
// 없다고 보는 편이 맞고, 열 이름을 하나씩 떼어내며 여러 번 재시도하지 않아도 된다.
export function disableOptionalColumns(error, group = OPTIONAL_SCHEDULE_COLUMNS) {
  if (!error) return false;
  const code = cleanText(error.code).toUpperCase();
  const text = `${cleanText(error.message)} ${cleanText(error.details)} ${cleanText(error.hint)}`;
  const named = group.some((column) => text.includes(column));
  if (!named && code !== "42703" && code !== "PGRST204") return false;
  const fresh = group.filter((column) => !disabledColumns.has(column));
  for (const column of group) disabledColumns.add(column);
  return fresh.length > 0;
}

export function activeColumns(columns) {
  return (Array.isArray(columns) ? columns : String(columns).split(","))
    .map((column) => cleanText(column))
    .filter((column) => column && !disabledColumns.has(column));
}

export function withoutDisabledColumns(values) {
  if (Array.isArray(values)) return values.map((entry) => withoutDisabledColumns(entry));
  if (!values || typeof values !== "object") return values;
  if (!disabledColumns.size) return values;
  const copy = {};
  for (const [key, value] of Object.entries(values)) {
    if (disabledColumns.has(key)) continue;
    copy[key] = value;
  }
  return copy;
}

// run() 은 매번 열 목록과 페이로드를 다시 만들어야 한다. 첫 시도가 "없는 열"
// 로 실패하면 그 열을 내리고 정확히 한 번만 다시 부른다.
export async function runWithOptionalColumns(run, group = OPTIONAL_SCHEDULE_COLUMNS) {
  let first = null;
  try {
    first = await run();
  } catch (error) {
    if (!disableOptionalColumns(error, group)) throw error;
    return run();
  }
  if (!first?.error || !disableOptionalColumns(first.error, group)) return first;
  return run();
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
  return fields;
}

export function mapGoogleEventToScheduleRow(event = {}, { ownerCode = "", calendarId = "" } = {}) {
  const times = googleEventTimes(event);
  if (!times.ok) return null;
  const props = eventPrivateProps(event);
  return {
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

// (C-1) 대표가 만든 행이면 광고주/운영팀 범위여도 구글로 민다.
// access.role === "owner" 조건은 유지한다 — 운영팀원이 만든 일정이 대표 개인
// 캘린더로 흘러드는 것을 막는 유일한 방어선이다.
// owner_agency_code 는 selectFields 에 없을 수 있어 있을 때만 대조한다.
export function ownerSyncableRows(access, rows) {
  if (!access || access.role !== "owner") return [];
  const ownerCode = normalizeCode(access.ownerAgencyCode);
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
    await runWithOptionalColumns(() => ctx.supabaseAdmin
      .from("schedule_items")
      .update(withoutDisabledColumns(values))
      .eq("id", rowId)
      .then((result) => result || { error: null }, (error) => ({ error })));
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
  const calendarId = cleanText(row.google_calendar_id) || cleanText(integration.calendar_id);
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

    const results = await mapWithConcurrency(targets, DEFAULT_PUSH_CONCURRENCY, async (row) => {
      try {
        const result = await pushRowToGoogle(ctx, env, {
          integration,
          accessToken: token.accessToken,
          row,
          clientName: rowClientName(row),
          mode,
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
  const { data, error } = await runWithOptionalColumns(() => ctx.supabaseAdmin
    .from("schedule_items")
    .select(syncRowFields())
    .eq("owner_agency_code", normalizeCode(ownerCode))
    .in("google_sync_state", ["pending", "failed"])
    .order("updated_at", { ascending: true })
    .limit(limit));
  if (error) return { pushed: 0, pushFailed: 0 };
  const rows = (data || []).filter((row) => row && !row.calendar_id);
  if (!rows.length) return { pushed: 0, pushFailed: 0 };

  const clientIds = [...new Set(rows.map((row) => row.client_id).filter(Boolean))];
  const clientsById = new Map();
  if (clientIds.length) {
    const lookup = await ctx.supabaseAdmin.from("clients").select("id, name, business_name").in("id", clientIds);
    for (const client of lookup.data || []) clientsById.set(client.id, client);
  }

  const results = await mapWithConcurrency(rows, DEFAULT_PUSH_CONCURRENCY, async (row) => {
    try {
      const result = await pushRowToGoogle(ctx, env, {
        integration,
        accessToken,
        row,
        clientName: rowClientName(row, clientsById),
        mode: "upsert",
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

  let primaryId = "";
  for (const row of known.values()) {
    if (row.calendar_role === "primary") primaryId = row.google_calendar_id;
  }
  if (!primaryId && options.accessToken) {
    // primary 는 "primary" 리터럴이 아니라 실제 id(이메일)로 고정한다.
    // 그러지 않으면 같은 캘린더가 두 id 로 두 번 동기화되어 행이 중복된다.
    const profile = await googleFetch(options.accessToken, "GET", "/calendars/primary", null, { fetchImpl });
    if (profile.ok && profile.data?.id) primaryId = String(profile.data.id);
  }
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

async function loadMatchingRows(ctx, calendarId, events) {
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
      .eq("google_calendar_id", calendarId)
      .in("google_event_id", eventIds));
    for (const row of data || []) byEvent.set(row.google_event_id, row);
  }
  if (scheduleIds.length) {
    const { data } = await runWithOptionalColumns(() => ctx.supabaseAdmin
      .from("schedule_items")
      .select(syncRowFields())
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

async function applyEvents(ctx, ownerCode, calendarRow, events, window, counters) {
  const calendarId = calendarRow.google_calendar_id;
  const maps = await loadMatchingRows(ctx, calendarId, events);

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

    if (row && eventIsEcho(event, row)) { counters.skipped += 1; continue; }

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
    const insertRow = mapGoogleEventToScheduleRow(event, { ownerCode, calendarId });
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
    if (events.length) await applyEvents(ctx, ownerCode, calendarRow, events, window, counters);

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
// 오케스트레이션
// ─────────────────────────────────────────────────────────────

export async function runOwnerCalendarSync(ctx, env, ownerCode, options = {}) {
  const code = normalizeCode(ownerCode || primaryAgencyCode(env));
  const fetchImpl = options.fetchImpl || fetch;
  const nowMs = options.now || Date.now();
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
  const push = await pushPendingRows(ctx, env, code, integration, token.accessToken, {
    pushLimit: options.pushLimit,
    fetchImpl,
  });

  const calendars = await resolveOwnerCalendars(ctx, code, integration, {
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
  for (const calendarRow of calendars) {
    const lastFull = new Date(cleanText(calendarRow.last_full_sync_at)).getTime();
    const stale = !Number.isFinite(lastFull) || nowMs - lastFull >= FULL_SYNC_INTERVAL_MS;
    const mode = options.mode === "full" || stale ? "full" : "incremental";
    results.push(await syncOneCalendar(ctx, code, calendarRow, token.accessToken, {
      mode,
      now: nowMs,
      deadlineAt,
      maxPages: options.maxPages,
      pageSize: options.pageSize,
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
      const values = {
        owner_agency_code: code,
        google_calendar_id: id,
        calendar_role: cleanText(knownRow?.calendar_role) || "secondary",
        calendar_summary: cleanText(item.summaryOverride || item.summary, 200) || null,
        calendar_access_role: cleanText(item.accessRole, 40) || null,
        calendar_is_primary: item.primary === true,
        calendar_writable: WRITABLE_ACCESS_ROLES.has(cleanText(item.accessRole)),
        calendar_catalog_at: nowIso,
        calendar_background_color: hexColor(item.backgroundColor),
        calendar_foreground_color: hexColor(item.foregroundColor),
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
      entries.set(id, {
        id,
        name: cleanText(row.calendar_summary, 200) || (dedicated ? DEDICATED_CALENDAR_SUMMARY : id),
        primary,
        dedicated,
        accessRole,
        // 카탈로그 열이 아직 없으면 writable 을 확인할 길이 없다. 그때도 우리가
        // 역할로 아는 전용/기본 캘린더는 쓰기 가능으로 남는다.
        writable: row.calendar_writable === true || dedicated || primary,
        // 열이 없거나 null 이면 보이는 쪽이 기본이다(fail open).
        visible: row.calendar_visible !== false,
        selected: row.calendar_selected === true,
        color: cleanText(row.calendar_background_color, 7) || null,
        textColor: cleanText(row.calendar_foreground_color, 7) || null,
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

  const calendarId = cleanText(options.calendarId)
    || cleanText(row.google_calendar_id)
    || cleanText(integration.calendar_id);
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
    let calendarName = cleanText(options.calendarName, 200);
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

export { DONE_PREFIX, decorateGoogleSummary, normalizeImportedTitle, undecorateGoogleSummary };

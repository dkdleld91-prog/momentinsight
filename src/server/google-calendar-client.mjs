import crypto from "node:crypto";
import { seoulDateKey } from "./calendar-domain.mjs";

// 구글 캘린더 저수준 클라이언트. OAuth 핸들러(google-calendar-api.mjs)와 동기화
// 엔진(handlers/google-calendar-sync.mjs)이 모두 여기에 의존한다. 두 모듈이 서로를
// import 하지 않게 하려고 공통 조각만 이 파일에 모았다.

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
export const DEDICATED_CALENDAR_SUMMARY = "모먼트 인사이트";
export const DONE_PREFIX = "✓ ";
export const MI_PROPERTY_VERSION = "1";
export const MAX_TITLE_CHARS = 120;
export const MAX_CLIENT_NAME_CHARS = 60;
export const MAX_ATTENDEES = 50;
export const MAX_LOCATION_CHARS = 500;
export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_RECURRENCE_LINES = 4;
export const MAX_RECURRENCE_LINE_CHARS = 512;
export const EVENT_TIMEZONE = "Asia/Seoul";
// 다이얼로그가 실제로 보낸 필드만 구글로 나간다. 목록에 없으면 "건드리지 않음".
export const DETAIL_FIELDS = ["recurrence", "attendees", "location", "description"];

const RECURRENCE_PREFIX_PATTERN = /^(?:RRULE|EXRULE|RDATE|EXDATE):/iu;
// 로컬파트/도메인에 공백·따옴표가 없고 점 있는 도메인만 통과시킨다. 구글이
// 거절할 주소를 우리 쪽에서 먼저 400 으로 돌려주기 위한 최소 검사다.
const ATTENDEE_EMAIL_PATTERN = /^[^\s@"'<>,;]+@[^\s@"'<>,;.]+(?:\.[^\s@"'<>,;.]+)+$/u;
const WEEKDAY_LABELS = { MO: "월", TU: "화", WE: "수", TH: "목", FR: "금", SA: "토", SU: "일" };
const WEEKDAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAY_ONLY = ["MO", "TU", "WE", "TH", "FR"];

export function cleanText(value, max = 0) {
  const text = String(value ?? "").trim();
  return max ? text.slice(0, max) : text;
}

export function normalizeCode(value) {
  return cleanText(value).toLowerCase();
}

export function googleOauthConfig(env = process.env) {
  return {
    clientId: cleanText(env.GOOGLE_OAUTH_CLIENT_ID),
    clientSecret: cleanText(env.GOOGLE_OAUTH_CLIENT_SECRET),
    redirectUrl: cleanText(env.MI_GOOGLE_OAUTH_REDIRECT || "https://insight.momentlabs.co.kr/api/google-oauth/callback"),
  };
}

// 5번째 인자는 과거 호출부와의 호환을 위해 fetch 구현 또는 옵션 객체 둘 다 받는다.
export async function googleFetch(accessToken, method, path, body, fetchOrOptions = {}) {
  const options = typeof fetchOrOptions === "function" ? { fetchImpl: fetchOrOptions } : (fetchOrOptions || {});
  const fetchImpl = options.fetchImpl || fetch;
  const query = options.query && Object.keys(options.query).length
    ? `?${new URLSearchParams(options.query).toString()}`
    : "";
  const response = await fetchImpl(`${GOOGLE_CALENDAR_BASE}${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return { ok: true, status: 204, data: null };
  let data = null;
  try { data = await response.json(); } catch (error) { data = null; }
  return { ok: response.ok, status: response.status, data };
}

// 만료된 refresh token 을 조용히 삼키면 "다시 연결 필요" 를 띄울 수 없다.
// 구글은 이 경우 error=invalid_grant 를 돌려주므로 그것만은 구별해서 올린다.
export async function refreshAccessToken(refreshToken, env = process.env, fetchImpl = fetch) {
  const config = googleOauthConfig(env);
  let response = null;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
    });
  } catch (error) {
    return { ok: false, accessToken: "", reason: "network", status: 0 };
  }
  const data = await response.json().catch(() => null);
  if (response.ok && data?.access_token) {
    return { ok: true, accessToken: String(data.access_token), reason: "", status: response.status };
  }
  const errorCode = normalizeCode(data?.error);
  return {
    ok: false,
    accessToken: "",
    reason: errorCode === "invalid_grant" ? "invalid_grant" : "token_error",
    status: response.status,
  };
}

export async function loadOwnerGoogleIntegration(ctx, ownerCode) {
  const { data, error } = await ctx.supabaseAdmin
    .from("owner_google_integrations")
    .select("owner_agency_code, refresh_token, calendar_id, google_email, connected_at, last_sync_at, last_sync_attempt_at, sync_status, sync_error")
    .eq("owner_agency_code", normalizeCode(ownerCode))
    .maybeSingle();
  if (error) return { integration: null, error };
  return { integration: data || null, error: null };
}

// ─────────────────────────────────────────────────────────────
// 제목 장식: 쓰기 전용. inbound 는 우리가 그 장식을 썼다는 증거
// (miStatus / miClientName)가 있을 때만, 정확히 한 번만 되돌린다.
// ─────────────────────────────────────────────────────────────
export function decorateGoogleSummary(row = {}, clientName = "") {
  const title = String(row.title ?? "");
  const marker = cleanText(clientName, MAX_CLIENT_NAME_CHARS);
  const marked = marker ? `[${marker}] ${title}` : title;
  return row.status === "done" ? `${DONE_PREFIX}${marked}` : marked;
}

export function undecorateGoogleSummary(summary, privateProps = {}) {
  let text = String(summary ?? "");
  if (privateProps.miStatus === "done" && text.startsWith(DONE_PREFIX)) {
    text = text.slice(DONE_PREFIX.length);
  }
  const clientName = cleanText(privateProps.miClientName, MAX_CLIENT_NAME_CHARS);
  if (clientName) {
    const marker = `[${clientName}] `;
    if (text.startsWith(marker)) text = text.slice(marker.length);
  }
  return text;
}

export function normalizeImportedTitle(text) {
  const normalized = String(text ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
  // 코드포인트 단위로 잘라 서로게이트 쌍이 쪼개지지 않게 한다.
  const sliced = Array.from(normalized).slice(0, MAX_TITLE_CHARS).join("");
  return sliced || "(제목 없음)";
}

export function scheduleRowScope(row = {}) {
  if (row.client_id) return "client";
  if (row.operation_team_id) return "team";
  return "internal";
}

// 확장 속성은 항상 우리 키 "전체" 를 한 번에 쓴다. PATCH 가 맵을 병합하든
// 치환하든 우리 키의 최종 상태가 같아지므로 어느 쪽이어도 안전하다.
export function buildMiPrivateProperties(row = {}, { ownerCode = "", clientName = "" } = {}) {
  const props = {
    miScheduleId: cleanText(row.id, 64),
    miOwnerCode: normalizeCode(ownerCode || row.owner_agency_code),
    miStatus: cleanText(row.status, 20),
    miScope: scheduleRowScope(row),
    miVersion: MI_PROPERTY_VERSION,
  };
  const marker = cleanText(clientName, MAX_CLIENT_NAME_CHARS);
  if (marker) props.miClientName = marker;
  for (const key of Object.keys(props)) {
    if (!props[key]) delete props[key];
  }
  return props;
}

export function mapScheduleRowToGoogleEvent(row = {}) {
  const summary = cleanText(row.title, 200) || "모먼트 인사이트 일정";
  const startsAt = cleanText(row.starts_at);
  if (!startsAt) return null;
  const event = {
    summary: row.status === "done" ? `${DONE_PREFIX}${summary}` : summary,
    extendedProperties: { private: { miScheduleId: cleanText(row.id) } },
  };
  if (row.is_all_day) {
    const startDate = cleanText(row.occurrence_on) || seoulDateKey(startsAt);
    if (!startDate) return null;
    const endBase = (row.ends_at ? seoulDateKey(row.ends_at) : "") || startDate;
    const [endYear, endMonth, endDay] = endBase.split("-").map(Number);
    const endExclusive = new Date(Date.UTC(endYear, endMonth - 1, endDay + 1)).toISOString().slice(0, 10);
    event.start = { date: startDate };
    event.end = { date: endExclusive };
    return event;
  }
  const endsAt = cleanText(row.ends_at)
    || new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString();
  event.start = { dateTime: startsAt, timeZone: EVENT_TIMEZONE };
  event.end = { dateTime: endsAt, timeZone: EVENT_TIMEZONE };
  return event;
}

// ─────────────────────────────────────────────────────────────
// 일정 상세(참석자 · 반복 · 화상 회의)
// ─────────────────────────────────────────────────────────────

export function isAttendeeEmail(value) {
  const email = cleanText(value, 320).toLowerCase();
  return Boolean(email) && ATTENDEE_EMAIL_PATTERN.test(email);
}

// 문자열 배열과 {email,...} 배열을 모두 받아 구글이 받는 최소 모양으로 줄인다.
// responseStatus / displayName 은 값이 있을 때만 실어 RSVP 를 보존한다.
export function normalizeAttendeeList(value, max = MAX_ATTENDEES) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const attendees = [];
  for (const entry of list) {
    const source = typeof entry === "string" ? { email: entry } : (entry || {});
    const email = cleanText(source.email, 320).toLowerCase();
    if (!isAttendeeEmail(email) || seen.has(email)) continue;
    seen.add(email);
    const attendee = { email };
    const displayName = cleanText(source.displayName, 120);
    if (displayName) attendee.displayName = displayName;
    const responseStatus = cleanText(source.responseStatus, 20);
    if (responseStatus) attendee.responseStatus = responseStatus;
    attendees.push(attendee);
    if (attendees.length >= max) break;
  }
  return attendees;
}

export function validateRecurrenceLines(lines) {
  if (lines === undefined || lines === null || lines === "") return { ok: true, value: [] };
  if (!Array.isArray(lines)) return { ok: false, message: "반복 규칙 형식을 확인해주세요." };
  if (lines.length > MAX_RECURRENCE_LINES) {
    return { ok: false, message: `반복 규칙은 최대 ${MAX_RECURRENCE_LINES}줄까지 저장할 수 있습니다.` };
  }
  const value = [];
  for (const raw of lines) {
    if (typeof raw !== "string") return { ok: false, message: "반복 규칙 형식을 확인해주세요." };
    const line = raw.trim();
    if (!line) continue;
    if (line.length > MAX_RECURRENCE_LINE_CHARS) {
      return { ok: false, message: "반복 규칙이 너무 깁니다. 다시 선택해주세요." };
    }
    if (!RECURRENCE_PREFIX_PATTERN.test(line)) {
      return { ok: false, message: "반복 규칙은 RRULE/EXRULE/RDATE/EXDATE 로 시작해야 합니다." };
    }
    if (/^RRULE:/iu.test(line) && !/FREQ=/iu.test(line)) {
      return { ok: false, message: "반복 규칙에 반복 주기(FREQ)가 없습니다." };
    }
    value.push(line);
  }
  return { ok: true, value };
}

function rruleParts(line) {
  const parts = new Map();
  for (const chunk of line.slice("RRULE:".length).split(";")) {
    const [key, ...rest] = chunk.split("=");
    if (!key || !rest.length) continue;
    parts.set(key.trim().toUpperCase(), rest.join("=").trim().toUpperCase());
  }
  return parts;
}

// 화면에 그대로 쓰는 짧은 한국어 요약. 다이얼로그가 만들 수 있는 프리셋만
// 이름으로 부르고 나머지는 전부 "맞춤 반복" 으로 접는다.
export function describeRecurrence(lines) {
  const list = (Array.isArray(lines) ? lines : []).map((line) => cleanText(line)).filter(Boolean);
  if (!list.length) return "반복 안 함";
  if (list.length > 1) return "맞춤 반복";
  const line = list[0];
  if (!/^RRULE:/iu.test(line)) return "맞춤 반복";
  const parts = rruleParts(line);
  const interval = Number(parts.get("INTERVAL") || "1");
  if (Number.isFinite(interval) && interval > 1) return "맞춤 반복";
  const byDay = (parts.get("BYDAY") || "").split(",").map((value) => value.trim()).filter(Boolean);
  const weekdayOnly = byDay.length === WEEKDAY_ONLY.length && WEEKDAY_ONLY.every((day) => byDay.includes(day));
  const freq = parts.get("FREQ") || "";
  if (freq === "DAILY") return byDay.length ? (weekdayOnly ? "주중 매일" : "맞춤 반복") : "매일";
  if (freq === "WEEKLY") {
    if (weekdayOnly) return "주중 매일";
    if (!byDay.length) return "매주";
    if (byDay.some((day) => !WEEKDAY_LABELS[day])) return "맞춤 반복";
    return `매주 ${WEEKDAY_ORDER.filter((day) => byDay.includes(day)).map((day) => WEEKDAY_LABELS[day]).join(", ")}`;
  }
  if (freq === "MONTHLY") {
    const monthDay = Number(parts.get("BYMONTHDAY") || "");
    if (Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31) return `매월 ${monthDay}일`;
    return "맞춤 반복";
  }
  if (freq === "YEARLY") return "매년";
  return "맞춤 반복";
}

export function conferenceUriFromEvent(event = {}) {
  const hangout = cleanText(event.hangoutLink, 1000);
  if (hangout) return hangout;
  const entries = Array.isArray(event.conferenceData?.entryPoints) ? event.conferenceData.entryPoints : [];
  for (const entry of entries) {
    if (cleanText(entry?.entryPointType).toLowerCase() !== "video") continue;
    const uri = cleanText(entry.uri, 1000);
    if (uri) return uri;
  }
  return "";
}

function hasExistingConference(row = {}) {
  return Boolean(cleanText(row.google_conference_uri));
}

// 양방향 동기화용 페이로드. 시간 매핑은 mapScheduleRowToGoogleEvent 를 그대로
// 재사용하고 제목 장식과 부기 속성만 덧씌운다.
//
// details 가 없으면 summary / start / end / extendedProperties 만 보낸다.
// events.patch 는 배열 필드를 "통째로 교체" 하므로, 사용자가 편집하지 않은
// 백그라운드 push 가 attendees 를 다시 실으면 모든 참석자의 RSVP 가 초기화된다.
// 그래서 상세 필드는 다이얼로그에서 온 명시적 쓰기(details 전달)에서만,
// 그중에서도 details.fields 로 지목한 것만 나간다. 지목되지 않은 필드는
// "건드리지 않음" 이고, 지목된 채로 비어 있으면 "지움"(patch 시 ""/[])이다.
export function buildGoogleEventPayload(row = {}, options = {}) {
  const { ownerCode = "", clientName = "", createConference = false, details = null } = options;
  const base = mapScheduleRowToGoogleEvent(row);
  if (!base) return null;
  const payload = {
    ...base,
    summary: cleanText(decorateGoogleSummary(row, clientName), 1024) || "모먼트 인사이트 일정",
    extendedProperties: { private: buildMiPrivateProperties(row, { ownerCode, clientName }) },
  };
  // 종일 일정도 시간대를 명시한다. 반복 일정은 timeZone 이 없으면 구글이 거절한다.
  payload.start = { ...payload.start, timeZone: EVENT_TIMEZONE };
  payload.end = { ...payload.end, timeZone: EVENT_TIMEZONE };
  if (!details) return payload;

  const patching = details.mode === "patch";
  const include = new Set(Array.isArray(details.fields) ? details.fields : DETAIL_FIELDS);

  // 반복 규칙은 마스터에만 존재한다. 인스턴스 행이 recurrence 를 다시 밀면
  // 그 인스턴스가 별도의 시리즈로 승격되어 일정이 두 배로 늘어난다.
  if (include.has("recurrence") && !cleanText(row.google_recurring_event_id)) {
    const recurrence = (Array.isArray(row.google_recurrence) ? row.google_recurrence : [])
      .map((line) => cleanText(line, MAX_RECURRENCE_LINE_CHARS))
      .filter(Boolean)
      .slice(0, MAX_RECURRENCE_LINES);
    if (recurrence.length) payload.recurrence = recurrence;
    else if (patching) payload.recurrence = [];
  }

  if (include.has("attendees")) {
    const attendees = normalizeAttendeeList(row.google_attendees, MAX_ATTENDEES);
    if (attendees.length) payload.attendees = attendees;
    else if (patching) payload.attendees = [];
  }

  if (include.has("location")) {
    const location = cleanText(row.google_location, MAX_LOCATION_CHARS);
    if (location) payload.location = location;
    else if (patching) payload.location = "";
  }

  if (include.has("description")) {
    const description = cleanText(row.google_description, MAX_DESCRIPTION_CHARS);
    if (description) payload.description = description;
    else if (patching) payload.description = "";
  }

  if (createConference && !hasExistingConference(row)) {
    payload.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }
  return payload;
}

export function clientDisplayName(client) {
  if (!client) return "";
  return cleanText(client.name || client.business_name, MAX_CLIENT_NAME_CHARS);
}

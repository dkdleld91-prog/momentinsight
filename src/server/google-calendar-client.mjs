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
export const DETAIL_FIELDS = ["recurrence", "attendees", "location", "description", "colorId"];

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

  // 일정 색. 구글에서 "캘린더 색"(기본값)은 colorId 가 없는 상태 그 자체다.
  // 그래서 insert 는 값이 없으면 아예 싣지 않고, patch 는 null 을 실어야만
  // 이미 지정된 색이 지워져 캘린더 색으로 돌아간다("" 로는 지워지지 않는다).
  if (include.has("colorId")) {
    const colorId = cleanText(row.google_color_id, 4);
    if (isEventColorId(colorId)) payload.colorId = colorId;
    else if (patching) payload.colorId = null;
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

// ─────────────────────────────────────────────────────────────
// 구글 색상 팔레트: 레거시(API) → 모던(웹 UI)
//
// 여기에는 확인된 사실과 업계 관례가 섞여 있으므로 구분해 둔다.
//
// [사실] colors.get 은 calendar / event 두 맵을 돌려주고 각 항목은
//   background · foreground 를 가진다. calendarList.backgroundColor 와
//   event.colorId 가 각각 그 맵을 가리킨다.
//   https://developers.google.com/workspace/calendar/api/v3/reference/colors
//   https://developers.google.com/workspace/calendar/api/v3/reference/colors/get
// [사실] 두 문서 모두 실제 16진값을 싣지 않는다(2026-08 확인). API 가 실제로
//   돌려주는 값이 아래 legacy 열이다.
// [관례·비문서] 구글 캘린더 웹 UI 는 그 레거시 값을 그대로 칠하지 않고
//   현대화된 팔레트로 바꿔 그린다. 구글은 이 대응표를 문서화하지 않았다.
//   아래 modern 열이 웹 UI 가 쓰는 값으로 널리 알려진 팔레트이며, 대표님
//   화면(광복절 초록 ≈ Basil #0b8043, 타임딜 보라 ≈ Grape #8e24aa,
//   MI 일정 파랑 ≈ Peacock/Blueberry)과 일치함을 확인했다.
//
// 저장은 언제나 구글이 준 원본(legacy)으로 하고, 화면에 낼 때만 modern 으로
// 바꾼다. 그래야 구글이 팔레트를 또 바꿔도 표 하나만 고치면 된다.
// ─────────────────────────────────────────────────────────────

// calendarList 색(24개). id 는 colors.get 의 calendar 맵 키다.
export const CALENDAR_COLOR_PALETTE = [
  { id: "1", legacy: "#ac725e", modern: "#795548", name: "Cocoa" },
  { id: "2", legacy: "#d06b64", modern: "#e67c73", name: "Flamingo" },
  { id: "3", legacy: "#f83a22", modern: "#d50000", name: "Tomato" },
  { id: "4", legacy: "#fa573c", modern: "#f4511e", name: "Tangerine" },
  { id: "5", legacy: "#ff7537", modern: "#ef6c00", name: "Pumpkin" },
  { id: "6", legacy: "#ffad46", modern: "#f09300", name: "Mango" },
  { id: "7", legacy: "#42d692", modern: "#009688", name: "Eucalyptus" },
  { id: "8", legacy: "#16a765", modern: "#0b8043", name: "Basil" },
  { id: "9", legacy: "#7bd148", modern: "#7cb342", name: "Pistachio" },
  { id: "10", legacy: "#b3dc6c", modern: "#c0ca33", name: "Avocado" },
  { id: "11", legacy: "#fbe983", modern: "#e4c441", name: "Citron" },
  { id: "12", legacy: "#fad165", modern: "#f6bf26", name: "Banana" },
  { id: "13", legacy: "#92e1c0", modern: "#33b679", name: "Sage" },
  { id: "14", legacy: "#9fe1e7", modern: "#039be5", name: "Peacock" },
  { id: "15", legacy: "#9fc6e7", modern: "#4285f4", name: "Cobalt" },
  { id: "16", legacy: "#4986e7", modern: "#3f51b5", name: "Blueberry" },
  { id: "17", legacy: "#9a9cff", modern: "#7986cb", name: "Lavender" },
  { id: "18", legacy: "#b99aff", modern: "#b39ddb", name: "Wisteria" },
  { id: "19", legacy: "#c2c2c2", modern: "#616161", name: "Graphite" },
  { id: "20", legacy: "#cabdbf", modern: "#a79b8e", name: "Birch" },
  { id: "21", legacy: "#cca6ac", modern: "#ad1457", name: "Beetroot" },
  { id: "22", legacy: "#f691b2", modern: "#d81b60", name: "Cherry Blossom" },
  { id: "23", legacy: "#cd74e6", modern: "#8e24aa", name: "Grape" },
  { id: "24", legacy: "#a47ae2", modern: "#9e69af", name: "Amethyst" },
];

// 일정 색(11개). 다이얼로그의 동그란 스와치가 이 순서와 이름을 그대로 쓴다.
// nameKo 는 구글 한국어 UI 의 표기다.
export const EVENT_COLOR_PALETTE = [
  { id: "1", legacy: "#a4bdfc", modern: "#7986cb", name: "Lavender", nameKo: "라벤더" },
  { id: "2", legacy: "#7ae7bf", modern: "#33b679", name: "Sage", nameKo: "세이지" },
  { id: "3", legacy: "#dbadff", modern: "#8e24aa", name: "Grape", nameKo: "포도" },
  { id: "4", legacy: "#ff887c", modern: "#e67c73", name: "Flamingo", nameKo: "플라밍고" },
  { id: "5", legacy: "#fbd75b", modern: "#f6bf26", name: "Banana", nameKo: "바나나" },
  { id: "6", legacy: "#ffb878", modern: "#f4511e", name: "Tangerine", nameKo: "탠저린" },
  { id: "7", legacy: "#46d6db", modern: "#039be5", name: "Peacock", nameKo: "피콕" },
  { id: "8", legacy: "#e1e1e1", modern: "#616161", name: "Graphite", nameKo: "흑연" },
  { id: "9", legacy: "#5484ed", modern: "#3f51b5", name: "Blueberry", nameKo: "블루베리" },
  { id: "10", legacy: "#51b749", modern: "#0b8043", name: "Basil", nameKo: "바질" },
  { id: "11", legacy: "#dc2127", modern: "#d50000", name: "Tomato", nameKo: "토마토" },
];

// 구글 한국어 UI 가 스와치를 늘어놓는 순서(토마토부터 흑연까지).
export const EVENT_COLOR_DISPLAY_ORDER = ["11", "4", "6", "5", "2", "10", "7", "9", "1", "3", "8"];

const CALENDAR_COLOR_BY_ID = new Map(CALENDAR_COLOR_PALETTE.map((entry) => [entry.id, entry]));
const CALENDAR_COLOR_BY_LEGACY = new Map(CALENDAR_COLOR_PALETTE.map((entry) => [entry.legacy, entry]));
const EVENT_COLOR_BY_ID = new Map(EVENT_COLOR_PALETTE.map((entry) => [entry.id, entry]));

export function normalizeHexColor(value) {
  const text = cleanText(value, 20).toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(text)) return text;
  if (!/^#[0-9a-f]{3}$/u.test(text)) return "";
  return `#${text.slice(1).split("").map((digit) => digit + digit).join("")}`;
}

export function isEventColorId(value) {
  return EVENT_COLOR_BY_ID.has(cleanText(value, 4));
}

// 캘린더 색: colorId 를 알면 그것이 가장 정확하고, 없으면 레거시 16진으로 되짚는다.
// 표에 없는 값(구글이 팔레트를 넓혔거나 사용자 지정)은 원본을 그대로 돌려준다 —
// 모르는 색을 지어내는 것보다 구글이 준 값을 쓰는 편이 언제나 덜 틀린다.
export function modernCalendarColor(backgroundColor, colorId = "") {
  const byId = CALENDAR_COLOR_BY_ID.get(cleanText(colorId, 4));
  if (byId) return byId.modern;
  const hex = normalizeHexColor(backgroundColor);
  if (!hex) return "";
  return CALENDAR_COLOR_BY_LEGACY.get(hex)?.modern || hex;
}

export function modernEventColor(colorId) {
  return EVENT_COLOR_BY_ID.get(cleanText(colorId, 4))?.modern || "";
}

export function eventColorName(colorId) {
  return EVENT_COLOR_BY_ID.get(cleanText(colorId, 4))?.nameKo || "";
}

// 색 위에 얹을 글자색. 구글은 팔레트마다 고정 대비색을 쓰지만 그 표는 문서에도
// 없고 팔레트가 넓어지면 또 어긋난다. 상대 휘도로 정하면 새 색이 와도 항상 읽힌다.
export function readableTextColor(backgroundColor) {
  const hex = normalizeHexColor(backgroundColor);
  if (!hex) return "";
  const channel = (offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.55 ? "#1f1f1f" : "#ffffff";
}

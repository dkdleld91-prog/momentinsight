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
  event.start = { dateTime: startsAt, timeZone: "Asia/Seoul" };
  event.end = { dateTime: endsAt, timeZone: "Asia/Seoul" };
  return event;
}

// 양방향 동기화용 페이로드. 시간 매핑은 mapScheduleRowToGoogleEvent 를 그대로
// 재사용하고 제목 장식과 부기 속성만 덧씌운다.
export function buildGoogleEventPayload(row = {}, { ownerCode = "", clientName = "" } = {}) {
  const base = mapScheduleRowToGoogleEvent(row);
  if (!base) return null;
  return {
    ...base,
    summary: cleanText(decorateGoogleSummary(row, clientName), 1024) || "모먼트 인사이트 일정",
    extendedProperties: { private: buildMiPrivateProperties(row, { ownerCode, clientName }) },
  };
}

export function clientDisplayName(client) {
  if (!client) return "";
  return cleanText(client.name || client.business_name, MAX_CLIENT_NAME_CHARS);
}

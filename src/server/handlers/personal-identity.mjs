// 개인 캘린더 계정 주체 키(personal principal key).
//
// 이 파일의 유일한 책임은 "지금 요청을 보낸 계정이 누구인가" 를 세션이 심은
// 헤더에서만 뽑아 문자열 키 하나로 만드는 것이다. 요청 본문·쿼리·브라우저가
// 실어 보낸 헤더는 절대 읽지 않는다 — session-gate 가 CREDENTIAL_HEADERS 를
// 전부 지우고 세션 클레임에서 다시 심은 값만 여기 도달한다
// (session-gate.mjs 의 internalRequestForSession).
//
// 키 스킴:
//   owner  → 'mml93-a01'                       (= PRIMARY_AGENCY_CODE, 불변)
//   team   → 'team:'   || operation_team_codes.id  (uuid)
//   client → 'client:' || clients.id               (uuid)
//
// 접두사가 있어야 하는 이유는 취향이 아니다. 운영팀 코드 형식이 콜론을 허용하고
// (super-admin-api 의 코드 정규식), clients 에 agency_code = 'mml93-a01' 인 행이
// 실제로 있다(20260625043000_primary_agency_code.sql). 접두사가 없으면 대표님
// 키와 그 광고주 키가 같은 문자열이 된다. 코드가 아니라 uuid 를 쓰는 이유는
// 코드가 재발급·재활성화 대상이기 때문이다 — uuid 는 계정 수명과 같이 간다.

import { PRIMARY_AGENCY_CODE } from "../owner-identity.mjs";
import { activeClientByCode, activeTeamByCode } from "./code-session-api.mjs";

export const PERSONAL_WORK_ITEMS_PATH = "/api/my/work-items";
export const PERSONAL_GOOGLE_CALENDAR_PATH = "/api/my/google-calendar";
export const PERSONAL_GOOGLE_LOGIN_PATH = "/api/my/google-login";

export const PERSONAL_ROLES = new Set(["owner", "team", "client"]);

// DB CHECK(schedule_items_personal_key_matches_owner_code / *_principal_shape)
// 와 같은 형식이다. 여기서 통과한 값만 DB 에 닿는다.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function cleanText(value, max = 0) {
  const text = String(value ?? "").trim();
  return max ? text.slice(0, max) : text;
}

function normalizeCode(value) {
  return cleanText(value).toLowerCase();
}

export function primaryAgencyCode(env = process.env) {
  return normalizeCode(env.MI_PRIMARY_AGENCY_CODE || PRIMARY_AGENCY_CODE);
}

function normalizedUuid(value) {
  const id = normalizeCode(value);
  return UUID_PATTERN.test(id) ? id : "";
}

// (role, code) → 키. 만들 수 없으면 빈 문자열이다. 절대 추측하지 않는다.
export function personalPrincipalKey(role, code) {
  const personalRole = normalizeCode(role);
  const personalCode = normalizeCode(code);
  if (!personalCode) return "";
  if (personalRole === "owner") return personalCode;
  if (personalRole === "team" || personalRole === "client") {
    return normalizedUuid(personalCode) ? `${personalRole}:${personalCode}` : "";
  }
  return "";
}

// 키 → (role, code). 콜론이 없으면 대표님 키다(하위 호환 + 옛 state 해석).
export function parsePersonalPrincipalKey(key) {
  const value = normalizeCode(key);
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator < 0) return { role: "owner", code: value };
  const role = value.slice(0, separator);
  const code = value.slice(separator + 1);
  if (role !== "team" && role !== "client") return null;
  if (!normalizedUuid(code)) return null;
  return { role, code };
}

export function validPersonalPrincipalKey(key, env = process.env) {
  const parsed = parsePersonalPrincipalKey(key);
  if (!parsed) return false;
  if (parsed.role === "owner") return parsed.code === primaryAgencyCode(env);
  return true;
}

// 콜백은 세션 쿠키 없이 도착하므로(§4.2) 서명된 state 의 계정이 지금도 살아
// 있는지를 다시 확인해야 한다. 확인 없이는 해지된 운영팀·연결 해제된 광고주가
// state TTL(10분) 안에 연동을 완성할 수 있다. code 가 아니라 id 로 찾는 판본이
// 필요한 이유는 캘린더 목적의 state 가 uuid 를 싣기 때문이다.
export async function activeTeamById(ctx, id) {
  const teamId = normalizedUuid(id);
  if (!teamId) return { data: null, error: null };
  let result = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, team_code, team_name, status, client_id, revoked_at")
    .eq("id", teamId)
    .eq("status", "active")
    .maybeSingle();
  if (result.error && /revoked_at|schema cache/iu.test(result.error.message || "")) {
    result = await ctx.supabaseAdmin
      .from("operation_team_codes")
      .select("id, team_code, team_name, status, client_id")
      .eq("id", teamId)
      .eq("status", "active")
      .maybeSingle();
  }
  if (result.error || !result.data) return result;
  if (result.data.revoked_at) return { data: null, error: null };
  return result;
}

export async function activeClientById(ctx, id) {
  const clientId = normalizedUuid(id);
  if (!clientId) return { data: null, error: null };
  let result = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, disconnected_at")
    .eq("id", clientId)
    .eq("status", "active")
    .maybeSingle();
  if (result.error && /disconnected_at|schema cache/iu.test(result.error.message || "")) {
    result = await ctx.supabaseAdmin
      .from("clients")
      .select("id, name, business_name, agency_code, status")
      .eq("id", clientId)
      .eq("status", "active")
      .maybeSingle();
  }
  if (result.error || !result.data) return result;
  if (result.data.disconnected_at) return { data: null, error: null };
  return result;
}

// 키가 가리키는 계정이 지금도 활성인지 확인한다. 콜백(§4.2-4)과
// /api/my/google-calendar 가 같은 함수를 쓴다.
export async function activePersonalPrincipal(ctx, key, env = process.env) {
  const parsed = parsePersonalPrincipalKey(key);
  if (!parsed) return { ok: false, reason: "invalid" };
  if (parsed.role === "owner") {
    return parsed.code === primaryAgencyCode(env)
      ? { ok: true, role: "owner", code: parsed.code, loginCode: parsed.code }
      : { ok: false, reason: "invalid" };
  }
  if (parsed.role === "team") {
    const { data, error } = await activeTeamById(ctx, parsed.code);
    if (error) return { ok: false, reason: "lookup-failed" };
    if (!data) return { ok: false, reason: "inactive" };
    return { ok: true, role: "team", code: data.id, loginCode: normalizeCode(data.team_code), team: data };
  }
  const { data, error } = await activeClientById(ctx, parsed.code);
  if (error) return { ok: false, reason: "lookup-failed" };
  if (!data) return { ok: false, reason: "inactive" };
  return { ok: true, role: "client", code: data.id, loginCode: normalizeCode(data.agency_code), client: data };
}

function personalAccess(role, code, loginCode) {
  const personalKey = personalPrincipalKey(role, code);
  if (!personalKey) {
    return { ok: false, status: 403, message: "개인 캘린더 계정을 확인할 수 없습니다." };
  }
  return {
    ok: true,
    role,
    personalRole: role,
    personalCode: normalizeCode(code),
    personalKey,
    loginCode: normalizeCode(loginCode),
    // 개인 공간에는 운영 범위가 없다. 두 값이 null 이어야 광고주 공개(publish)
    // 경로가 열리지 않고, 개인 행은 운영 조회 술어에도 걸리지 않는다.
    client: null,
    team: null,
    // 동기화 엔진은 owner_agency_code 문자열 하나로 파라미터화돼 있다. 개인 행의
    // owner_agency_code 가 곧 개인키이므로 그대로 실어 준다(설계 D1).
    ownerAgencyCode: personalKey,
  };
}

// 개인 경로 전용 접근 판정. 운영 범위로 폴백하지 않는다 — 키를 못 만들면 끝이다.
export async function resolvePersonalAccess(request, ctx, env = process.env) {
  const role = normalizeCode(request.headers.get("x-mi-session-role"));
  if (!PERSONAL_ROLES.has(role)) {
    return { ok: false, status: 401, message: "안전한 접속 세션이 필요합니다." };
  }

  if (role === "owner") {
    const ownerCode = normalizeCode(request.headers.get("x-mi-owner-agency-code"));
    const primary = primaryAgencyCode(env);
    if (!primary || ownerCode !== primary) {
      return { ok: false, status: 403, message: "총관리자 세션을 확인할 수 없습니다." };
    }
    // 대표님이 고른 광고주(x-mi-agency-code)는 개인키 계산에 쓰지 않는다.
    // 대표실은 언제나 대표님 개인 공간 하나뿐이다.
    return personalAccess("owner", primary, primary);
  }

  if (role === "team") {
    // x-mi-agency-code 는 여기서 절대 읽지 않는다. 운영팀 세션에는 그 팀이 맡은
    // 광고주 코드가 실려 오므로(session-gate 의 internalRequestForSession),
    // 그것으로 키를 만들면 팀과 광고주가 같은 개인 캘린더를 쓰게 된다.
    const teamCode = normalizeCode(request.headers.get("x-mi-team-code"));
    if (!teamCode) return { ok: false, status: 403, message: "운영팀 세션을 확인할 수 없습니다." };
    const { data, error } = await activeTeamByCode(ctx, teamCode);
    if (error) return { ok: false, status: 500, message: "운영팀 범위 확인에 실패했습니다." };
    if (!data) return { ok: false, status: 404, message: "활성 운영팀을 찾을 수 없습니다." };
    return personalAccess("team", data.id, data.team_code);
  }

  const agencyCode = normalizeCode(request.headers.get("x-mi-agency-code"));
  if (!agencyCode) return { ok: false, status: 403, message: "광고주 세션을 확인할 수 없습니다." };
  // work-items 의 activeClientByAgencyCode 는 .eq("agency_code", 소문자) 라
  // 대문자 agency_code 를 못 찾는다(기본값이 upper() 로 생성된다). 개인 경로는
  // 언제나 code-session-api 의 ilike 판본만 쓴다.
  const { data, error } = await activeClientByCode(ctx, agencyCode);
  if (error) return { ok: false, status: 500, message: "광고주 범위 확인에 실패했습니다." };
  if (!data) return { ok: false, status: 404, message: "활성 광고주를 찾을 수 없습니다." };
  return personalAccess("client", data.id, data.agency_code);
}

// 개인 행에 서버가 채우는 세 값. 요청 본문에서는 절대 받지 않는다.
export function personalRowKeys(access) {
  return {
    personal_role: access.personalRole,
    personal_code: access.personalCode,
    owner_agency_code: access.personalKey,
  };
}

// C 30일 순위 화면 API 역할·범위 판정(명세 §5.2·§5.4, WP2).
// 게이트가 지우고 다시 심은 신뢰 머리글만 읽는다. body·query 의 자격 값은 아예 읽지 않는다.
// 실패는 던지지 않고 { ok: false, code } 로 돌려준다(문구는 핸들러가 붙인다). DB 오류만 던진다(stage = "access").
import { PRIMARY_AGENCY_CODE } from "../owner-identity.mjs";
import { safeEqual } from "../security.mjs";
import { selectPages } from "./db.mjs";

const OWNER_PLACEHOLDER_CODES = new Set(["", "owner-session", "session"]);
const SESSION_ROLES = new Set(["owner", "team", "client"]);

function header(request, name) {
  return String(request?.headers?.get?.(name) || "");
}

function sessionRole(request) {
  return header(request, "x-mi-session-role").trim().toLowerCase();
}

function sessionScope(request) {
  return header(request, "x-mi-session-scope").trim().toLowerCase();
}

function baseCode(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

function legacyAgencyCodes() {
  return String(process.env.MI_LEGACY_AGENCY_CODES || "")
    .split(",")
    .map((value) => baseCode(value))
    .filter(Boolean);
}

// NFKC → trim → 소문자. MI_LEGACY_AGENCY_CODES(쉼표 목록)에 있으면 대표 코드로 바꾼다. 저장·조회 모두 이 코드 하나로 한다.
export function canonicalAgencyCode(value) {
  const code = baseCode(value);
  if (!code) return "";
  if (legacyAgencyCodes().includes(code)) return PRIMARY_AGENCY_CODE;
  return code;
}

function ownerCodeMatches(request) {
  return safeEqual(header(request, "x-mi-owner-agency-code").trim(), PRIMARY_AGENCY_CODE);
}

function denied(code) {
  return { ok: false, code };
}

function granted(access) {
  return { ok: true, access };
}

function dbFailure(error) {
  const failure = new Error("coupang_rank_access_failed");
  failure.code = String(error?.code || "");
  failure.stage = "access";
  failure.cause = error;
  return failure;
}

// 활성 광고주(clients: agency_code = 코드, status = 'active', disconnected_at is null)의 id. 없으면 null.
async function activeClientId(ctx, agencyCode) {
  if (!agencyCode) return null;
  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, status, disconnected_at")
    .eq("agency_code", agencyCode)
    .eq("status", "active")
    .is("disconnected_at", null)
    .limit(1)
    .maybeSingle();
  if (error) throw dbFailure(error);
  if (!data || !data.id || String(data.status) !== "active" || data.disconnected_at) return null;
  return String(data.id);
}

// 대표 소유 팀 코드(lower(team_code) = 코드, owner_agency_code = 대표, 상태 무관)인지.
// team_code 는 대소문자가 섞여 저장될 수 있어 LIKE 대신 대표 소유 목록을 읽어 비교한다(와일드카드 '_' 함정 없음).
async function ownerTeamCodeExists(ctx, agencyCode) {
  if (!agencyCode) return false;
  const { data, error } = await selectPages(() => ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, team_code")
    .eq("owner_agency_code", PRIMARY_AGENCY_CODE)
    .order("id", { ascending: true }));
  if (error) throw dbFailure(error);
  return (data || []).some((row) => baseCode(row?.team_code) === agencyCode);
}

function ownerAccess(agencyCode, clientId, extra = {}) {
  return {
    role: "owner",
    owner: true,
    mode: "owner",
    agencyCode,
    clientId,
    readOnly: false,
    teamCodeScope: false,
    createdBy: "owner",
    ...extra,
  };
}

// 총관리자 세션 관문(대표 결정 2026-10-23: C 30일 순위는 총관리자 전용).
// 운영팀·광고주 세션은 설정의 공개 값(team_access_enabled·client_view_enabled)과 상관없이 COUPANG_OWNER_ONLY.
// 설정 칸·DB 는 그대로 둔다. 설정·DB 를 읽지 않으므로 핸들러가 설정을 읽기 전에 부른다.
// 반환: 통과면 "", 아니면 거절 코드.
export function ownerSessionDenial(request) {
  const role = sessionRole(request);
  if (!role) return "COUPANG_SESSION_REQUIRED";
  if (sessionScope(request) === "trial") return "TRIAL_LOCKED";
  if (role !== "owner") return "COUPANG_OWNER_ONLY";
  if (!ownerCodeMatches(request)) return "COUPANG_ACCESS_DENIED";
  return "";
}

// 역할·범위 판정(§5.2 표, 위에서부터 처음 맞는 행). 총관리자 세션만 통과한다(위 관문).
// options
// - create: 등록·다시 시작. 총관리자 ③(팀 코드 범위)이면 COUPANG_SCOPE_NO_CREATE.
// - ownerOnly: 총관리자 전용 동작·조회. 대상 범위와 무관하므로 범위를 찾지 않는다.
// 반환: { ok: true, access } | { ok: false, code }
// access = { role, owner, mode, agencyCode, clientId, readOnly, teamCodeScope, createdBy }
export async function resolveCoupangAccess(request, ctx, options = {}) {
  const create = options.create === true;
  const ownerOnly = options.ownerOnly === true;
  const denial = ownerSessionDenial(request);
  if (denial) return denied(denial);
  if (ownerOnly) return granted(ownerAccess(PRIMARY_AGENCY_CODE, null));
  const requested = canonicalAgencyCode(header(request, "x-mi-agency-code"));
  const target = OWNER_PLACEHOLDER_CODES.has(requested) ? PRIMARY_AGENCY_CODE : requested;
  // ① 대표 코드
  if (safeEqual(target, PRIMARY_AGENCY_CODE)) return granted(ownerAccess(PRIMARY_AGENCY_CODE, null));
  // ② 활성 광고주
  const clientId = await activeClientId(ctx, target);
  if (clientId) return granted(ownerAccess(target, clientId));
  // ③ 대표 소유 팀 코드(조회·중지·그룹·삭제만)
  if (await ownerTeamCodeExists(ctx, target)) {
    if (create) return denied("COUPANG_SCOPE_NO_CREATE");
    return granted(ownerAccess(target, null, { teamCodeScope: true }));
  }
  // ④
  return denied("COUPANG_SCOPE_NOT_FOUND");
}

// GET ?view=access(§5.4): 메뉴 노출 판단.
// 총관리자만 open:true 다(대표 결정 2026-10-23, 설정의 운영팀·광고주 공개 값은 보지 않는다).
// 핸들러는 ownerSessionDenial 관문을 지난 총관리자 세션에서만 부른다(운영팀·광고주는 설정을 읽기 전에 COUPANG_OWNER_ONLY).
// settings 가 null 이면 표가 없는 것(setupRequired). DB 를 읽지 않는다.
// 반환: { ok: true, open, role, readOnly, setupRequired } | { ok: false, code }(세션 없음·체험)
export function accessView(request, settings) {
  const role = sessionRole(request);
  if (!role) return denied("COUPANG_SESSION_REQUIRED");
  if (sessionScope(request) === "trial") return denied("TRIAL_LOCKED");
  const knownRole = SESSION_ROLES.has(role) ? role : "";
  const owner = knownRole === "owner" && ownerCodeMatches(request);
  const readOnly = knownRole === "client";
  return { ok: true, open: owner, role: knownRole, readOnly, setupRequired: !settings };
}

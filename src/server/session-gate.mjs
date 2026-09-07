import { csrfMatches, sessionFromRequest, trialKeywordDailyLimit } from "./code-session.mjs";
import { trialSampleTrackersPayload } from "./trial-sample-trackers.mjs";
import { planRestricted, planStatus } from "./account-plan.mjs";
import {
  ownerClaimsMatchPrimary,
  PRIMARY_AGENCY_CODE,
  primaryAgencyConfiguration,
} from "./owner-identity.mjs";
import { allowedOrigins, protectedJson } from "./security.mjs";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CREDENTIAL_HEADERS = [
  "authorization",
  "apikey",
  "x-demo-admin-code",
  "x-mi-agency-code",
  "x-mi-rank-access-code",
  "x-mi-super-admin-code",
  "x-mi-owner-agency-code",
  "x-mi-team-code",
  "x-mi-session-role",
  "x-mi-session-scope",
];
const SESSION_FREE_PATHS = new Set([
  "/health",
  "/api/health",
  "/ready",
  "/api/ready",
  "/api/session",
  "/api/naver-rank-cron",
  "/api/naver-place-rank-cron",
  // 이용 기간 만료 계정 정리 크론(대표 결정 2026-09-07). 크론 비밀키(Bearer)로만 열리고 세션 쿠키는 쓰지 않는다.
  "/api/account-expiry-cron",
  "/api/naver-shopping-local-worker",
  // 수집 정체 워치독이 무세션으로 폴링하는 집계 전용 경로. 계정 데이터를 반환하지 않는다.
  "/api/rank-collection-health",
  // 구글 OAuth 콜백은 구글이 세션 쿠키 없이 GET으로 호출하며, 서명된 state로 자체 검증한다.
  "/api/google-oauth/callback",
  // 구글 로그인 시작은 무세션 공개 진입점으로, 구글 인증 화면으로의 302만 반환한다.
  "/api/google-login/start",
]);
const TEAM_ACCOUNT_ONLY_RANK_PATHS = new Set([
  "/api/naver-rank-trackers",
  "/api/naver-place-rank-trackers",
]);
const TEAM_ACCOUNT_ONLY_TOOL_PATHS = new Set([
  "/api/work-items",
  "/api/naver-keyword",
  "/api/naver-product-seo-audit",
  "/api/naver-shopping-rank",
  "/api/naver-shopping-rank-jobs",
  "/api/meta-ads",
  ...TEAM_ACCOUNT_ONLY_RANK_PATHS,
]);
// 개인 캘린더 경로는 광고주 미연결 운영팀 세션에서도 열려야 한다. 개인 공간의
// 단위는 계정 자체이고 광고주 범위와는 무관하기 때문이다. 개인 일정 비서(실장)
// 대화도 같은 개인 공간의 일부이므로 같은 계정 단위 규칙을 그대로 따른다.
const ACCOUNT_ONLY_PERSONAL_PATHS = new Set([
  "/api/my/work-items",
  "/api/my/google-calendar",
  "/api/my/google-login",
  "/api/my/assistant-chat",
]);
// 광고주 미연결 운영팀 세션에서도 열려야 하는 광고주 화면 공용 경로(2026-09-07 대표 보고: 운영팀
// 콘솔 뉴스가 "불러오지 못했습니다"). 홈 피드의 뉴스는 플랫폼 공통이고 내 키워드 지표는 핸들러가
// no_target_account 로 비운다. 키워드 조사·조사 노트는 키워드 조회 도구의 일부라 팀 코드 범위로 저장된다.
const ACCOUNT_ONLY_CLIENT_TOOL_PATHS = new Set([
  "/api/client/home-feed",
  "/api/client/keyword-research",
  "/api/client/keyword-notes",
]);
// 체험 계정(구글 가입, 대표 승인 2026-09-07)은 키워드 조회 도구만 연다. 순위 추적·보고서·
// 일정 등 광고주 데이터 경로는 403 TRIAL_LOCKED 로 막고, 화면은 도입 문의 카드를 보여 준다.
const TRIAL_ALLOWED_PATHS = new Set([
  "/api/session",
  "/api/naver-keyword",
  "/api/client/keyword-research",
  "/api/client/keyword-notes",
  "/api/client/public-state",
  "/api/client/home-feed",
]);
const TRIAL_KEYWORD_LOOKUP_PATH = "/api/naver-keyword";
const TRIAL_QUOTA_RPC = "mi_trial_keyword_consume";
// 체험 세션의 순위 추적 목록 GET 은 핸들러로 보내지 않고 예시 응답을 돌려준다(대표 지시 2026-09-07
// "무료체험 계정에 예시로 나올 수 있게"). 순위 수집 코드·표는 무접촉이고, 등록·갱신(POST)은 TRIAL_LOCKED 그대로다.
const TRIAL_SAMPLE_TRACKER_PATHS = new Set([
  "/api/naver-rank-trackers",
  "/api/naver-place-rank-trackers",
]);
// 이용 기간이 끝난 광고주(만료~유예 5일, 대표 결정 2026-09-07): 세션은 살려 두고 읽기만 허용한다.
// 키워드 조회·뉴스·공개 상태는 열고, 순위 목록은 GET(기록 보기)만, 그 외·쓰기는 403 PLAN_EXPIRED.
const PLAN_EXPIRED_GET_PATHS = new Set([
  "/api/session",
  "/api/naver-keyword",
  "/api/client/keyword-research",
  "/api/client/keyword-notes",
  "/api/client/public-state",
  "/api/client/home-feed",
  "/api/naver-rank-trackers",
  "/api/naver-place-rank-trackers",
  "/api/my/google-login",
]);
const PLAN_EXPIRED_WRITE_PATHS = new Set([
  "/api/client/keyword-notes",
]);
// 요청마다 다시 읽지 않도록 활성 확인 때 읽은 만료 시각을 클레임 sid 별로 잠깐 기억한다(같은 인스턴스, 60초).
const planExpiryMemo = new Map();
const PLAN_MEMO_TTL_MS = 60 * 1000;

function rememberPlanExpiry(sid, value) {
  if (!sid) return;
  if (planExpiryMemo.size > 500) planExpiryMemo.clear();
  planExpiryMemo.set(sid, { value: value || null, at: Date.now() });
}

function recalledPlanExpiry(sid) {
  const hit = sid ? planExpiryMemo.get(sid) : null;
  if (!hit || Date.now() - hit.at > PLAN_MEMO_TTL_MS) return undefined;
  return hit.value;
}

export function planExpiredAllowsRequest(request, path) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return PLAN_EXPIRED_GET_PATHS.has(path);
  return PLAN_EXPIRED_WRITE_PATHS.has(path);
}

export const SESSION_ACTIVITY_ACTIVE = "active";
export const SESSION_ACTIVITY_REVOKED = "revoked";
export const SESSION_ACTIVITY_UNAVAILABLE = "unavailable";

function isProduction(env = process.env) {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

function primaryAgencyCode(env = process.env) {
  return primaryAgencyConfiguration(env).effective;
}

function requestHasExternalSupabaseCredential(request) {
  return Boolean(request.headers.get("authorization") || request.headers.get("apikey"));
}

function pathAcceptsExternalSupabaseCredential(path) {
  return path.startsWith("/api/client/") || path.startsWith("/api/admin/");
}

export function requiresCodeSession(request) {
  if (request.method === "OPTIONS") return false;
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/") || SESSION_FREE_PATHS.has(path)) return false;
  if (pathAcceptsExternalSupabaseCredential(path) && requestHasExternalSupabaseCredential(request)) return false;
  return true;
}

export function roleAllowsPath(role, path) {
  if (role === "owner") return true;
  if (role === "team") {
    return !path.startsWith("/api/owner/")
      && !path.startsWith("/api/super-admin/")
      && path !== "/api/super-admin-agency-codes"
      && !path.startsWith("/api/agency-code")
      && !path.startsWith("/api/admin/");
  }
  if (role === "client") {
    return !path.startsWith("/api/owner/")
      && !path.startsWith("/api/super-admin/")
      && path !== "/api/super-admin-agency-codes"
      && !path.startsWith("/api/agency-code")
      && !path.startsWith("/api/team/")
      && path !== "/api/team-agency-codes"
      && !path.startsWith("/api/admin/")
      && !path.startsWith("/api/demo/");
  }
  return false;
}

export function sessionScopeAllowsPath(claims, path) {
  if (claims?.role !== "team" || (claims.clientId && claims.agencyCode)) return true;
  return path.startsWith("/api/team/")
    || path === "/api/team-agency-codes"
    || TEAM_ACCOUNT_ONLY_TOOL_PATHS.has(path)
    || ACCOUNT_ONLY_PERSONAL_PATHS.has(path)
    || ACCOUNT_ONLY_CLIENT_TOOL_PATHS.has(path);
}

export function isTrialClaims(claims) {
  return claims?.role === "client" && claims.trial === 1 && Boolean(claims.gsub);
}

export function trialAllowsPath(path) {
  return TRIAL_ALLOWED_PATHS.has(path);
}

function mutationOriginAllowed(request) {
  if (SAFE_METHODS.has(request.method)) return true;
  const origin = String(request.headers.get("origin") || "");
  if (!origin) return true;
  return allowedOrigins().includes(origin);
}

function targetAgencyHeader(request) {
  return String(request.headers.get("x-mi-agency-code") || "").trim().toLowerCase();
}

function secretKey(env = process.env) {
  const direct = String(env.SUPABASE_SECRET_KEY || "").trim();
  if (direct) return direct;
  try {
    const named = JSON.parse(env.SUPABASE_SECRET_KEYS || "{}");
    return String(named.default || "").trim();
  } catch {
    return "";
  }
}

function supabaseUrl(env = process.env) {
  return String(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function hostedEnvironment(env = process.env) {
  return isProduction(env) || Boolean(String(env.VERCEL_ENV || "").trim());
}

function ownerSessionConfigured(env = process.env) {
  return Boolean(String(env.MI_OWNER_LOGIN_CODE_SHA256 || env.MI_OWNER_LOGIN_CODE || "").trim());
}

function legacyJwtKey(value) {
  return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || ""));
}

async function selectSessionRows(table, filters, env = process.env, fetchImpl = globalThis.fetch) {
  const baseUrl = supabaseUrl(env);
  const key = secretKey(env);
  if (!baseUrl || !key || typeof fetchImpl !== "function") return { ok: false, configuration: true };

  const url = new URL(`${baseUrl}/rest/v1/${table}`);
  for (const [name, value] of Object.entries(filters)) url.searchParams.set(name, value);
  const headers = { accept: "application/json", apikey: key };
  if (legacyJwtKey(key)) headers.authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      return { ok: false, status: response.status, errorCode: String(payload?.code || "") };
    }
    const rows = await response.json().catch(() => null);
    return { ok: Array.isArray(rows), rows: Array.isArray(rows) ? rows : [] };
  } catch {
    return { ok: false, network: true };
  } finally {
    clearTimeout(timeout);
  }
}

// 세션 게이트가 부르는 유일한 쓰기: 체험 계정 하루 한도 1회 소비(원자적 RPC). 표·함수는
// supabase/migrations/20260907013000_trial_keyword_quota.sql 이고 service_role 만 실행할 수 있다.
async function callSessionRpc(name, body, env = process.env, fetchImpl = globalThis.fetch) {
  const baseUrl = supabaseUrl(env);
  const key = secretKey(env);
  if (!baseUrl || !key || typeof fetchImpl !== "function") return { ok: false, configuration: true };

  const headers = { accept: "application/json", "content-type": "application/json", apikey: key };
  if (legacyJwtKey(key)) headers.authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      return { ok: false, status: response.status, errorCode: String(payload?.code || "") };
    }
    const rows = await response.json().catch(() => null);
    return { ok: Array.isArray(rows), rows: Array.isArray(rows) ? rows : [] };
  } catch {
    return { ok: false, network: true };
  } finally {
    clearTimeout(timeout);
  }
}

function optionalColumnUnavailable(result) {
  return result?.status === 400 && ["42703", "PGRST204"].includes(result.errorCode);
}

// 체험 계정은 clients 행이 없다. login_identities 의 (role=trial, google_sub) 행이 곧 계정이라
// 그 행이 지워지면(대표 정리·본인 해지) 세션도 같은 요청에서 끝난다.
async function activeTrialForClaims(claims, env, fetchImpl) {
  if (!claims.gsub) return SESSION_ACTIVITY_REVOKED;
  const result = await selectSessionRows("login_identities", {
    select: "google_sub,role,code",
    google_sub: `eq.${claims.gsub}`,
    role: "eq.trial",
    limit: "1",
  }, env, fetchImpl);
  if (!result.ok) return SESSION_ACTIVITY_UNAVAILABLE;
  return result.rows.length === 1 && String(result.rows[0]?.google_sub || "") === String(claims.gsub)
    ? SESSION_ACTIVITY_ACTIVE
    : SESSION_ACTIVITY_REVOKED;
}

function trialKeywordLookupRequest(request, path) {
  if (path !== TRIAL_KEYWORD_LOOKUP_PATH || request.method !== "GET") return false;
  // 비교용 프로필(두 번째 키워드부터)은 세지 않는다. 전체 지표 조회만 하루 한도에 든다.
  return new URL(request.url).searchParams.get("profile") !== "compare";
}

async function consumeTrialKeywordQuota(claims, env, options = {}) {
  const limit = trialKeywordDailyLimit(env);
  const result = await callSessionRpc(
    TRIAL_QUOTA_RPC,
    { p_sub: claims.gsub, p_limit: limit },
    env,
    options.fetchImpl || globalThis.fetch,
  );
  // 한도 함수가 잠시 안 되면 막지 않는다(fail-open). 체험은 도입 상담용이라 오류로 잠그는 손해가 더 크다.
  if (!result.ok || result.rows.length !== 1) return { allowed: true, used: null, limit, unavailable: true };
  const row = result.rows[0];
  return { allowed: row?.allowed !== false, used: Number(row?.used_count ?? 0), limit };
}

async function activeClientForClaims(claims, env, fetchImpl) {
  if (!claims.clientId || !claims.agencyCode) return SESSION_ACTIVITY_REVOKED;
  let result = await selectSessionRows("clients", {
    select: "id,agency_code,status,disconnected_at,plan_expires_at",
    id: `eq.${claims.clientId}`,
    agency_code: `eq.${claims.agencyCode}`,
    status: "eq.active",
    disconnected_at: "is.null",
    limit: "1",
  }, env, fetchImpl);
  if (optionalColumnUnavailable(result)) {
    // 플랜 열(2026-09-07)이 아직 없으면 그 열만 빼고 다시 읽는다. 만료 시각은 무기한으로 본다.
    result = await selectSessionRows("clients", {
      select: "id,agency_code,status,disconnected_at",
      id: `eq.${claims.clientId}`,
      agency_code: `eq.${claims.agencyCode}`,
      status: "eq.active",
      disconnected_at: "is.null",
      limit: "1",
    }, env, fetchImpl);
  }
  if (result.ok && result.rows.length === 1) rememberPlanExpiry(claims.sid, result.rows[0]?.plan_expires_at || null);
  if (optionalColumnUnavailable(result)) {
    return SESSION_ACTIVITY_UNAVAILABLE;
  }
  if (!result.ok) return SESSION_ACTIVITY_UNAVAILABLE;
  return result.rows.length === 1 && result.rows[0]?.id === claims.clientId
    ? SESSION_ACTIVITY_ACTIVE
    : SESSION_ACTIVITY_REVOKED;
}

function normalizedActivityState(value) {
  if ([SESSION_ACTIVITY_ACTIVE, SESSION_ACTIVITY_REVOKED, SESSION_ACTIVITY_UNAVAILABLE].includes(value)) {
    return value;
  }
  return value ? SESSION_ACTIVITY_ACTIVE : SESSION_ACTIVITY_REVOKED;
}

export async function sessionActivityState(claims, env = process.env, options = {}) {
  if (!claims) return SESSION_ACTIVITY_REVOKED;
  if (typeof options.activityCheck === "function") {
    try {
      return normalizedActivityState(await options.activityCheck(claims));
    } catch {
      return SESSION_ACTIVITY_UNAVAILABLE;
    }
  }
  if (claims.role === "owner") {
    return ownerClaimsMatchPrimary(claims, env)
      && (ownerSessionConfigured(env) || !hostedEnvironment(env))
      ? SESSION_ACTIVITY_ACTIVE
      : SESSION_ACTIVITY_REVOKED;
  }
  if (!supabaseUrl(env) || !secretKey(env)) {
    return hostedEnvironment(env) ? SESSION_ACTIVITY_UNAVAILABLE : SESSION_ACTIVITY_ACTIVE;
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (isTrialClaims(claims)) return activeTrialForClaims(claims, env, fetchImpl);
  if (claims.role === "client") return activeClientForClaims(claims, env, fetchImpl);
  if (claims.role !== "team" || !claims.teamId || !claims.teamCode) return SESSION_ACTIVITY_REVOKED;

  let result = await selectSessionRows("operation_team_codes", {
    select: "id,team_code,client_id,status,revoked_at",
    id: `eq.${claims.teamId}`,
    team_code: `eq.${claims.teamCode}`,
    status: "eq.active",
    revoked_at: "is.null",
    limit: "1",
  }, env, fetchImpl);
  if (optionalColumnUnavailable(result)) {
    result = await selectSessionRows("operation_team_codes", {
      select: "id,team_code,client_id,status",
      id: `eq.${claims.teamId}`,
      team_code: `eq.${claims.teamCode}`,
      status: "eq.active",
      limit: "1",
    }, env, fetchImpl);
  }
  if (!result.ok) return SESSION_ACTIVITY_UNAVAILABLE;
  if (result.rows.length !== 1) return SESSION_ACTIVITY_REVOKED;
  const team = result.rows[0];
  if (String(team.client_id || "") !== String(claims.clientId || "")) return SESSION_ACTIVITY_REVOKED;
  if (!claims.clientId) return SESSION_ACTIVITY_ACTIVE;
  return activeClientForClaims(claims, env, fetchImpl);
}

export async function sessionActivityValid(claims, env = process.env, options = {}) {
  return (await sessionActivityState(claims, env, options)) === SESSION_ACTIVITY_ACTIVE;
}

export function internalRequestForSession(request, claims, env = process.env) {
  const path = new URL(request.url).pathname;
  const requestedTarget = targetAgencyHeader(request);
  const headers = new Headers(request.headers);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  headers.delete("x-mi-csrf");
  const trial = isTrialClaims(claims);
  headers.set("x-mi-session-role", claims.role);
  headers.set("x-mi-session-scope", trial ? "trial" : (claims.agencyCode ? "advertiser" : "account-only"));

  if (claims.role === "owner") {
    const ownerCode = primaryAgencyCode(env);
    const superAdminCode = String(env.MI_SUPER_ADMIN_CODE || "").trim();
    const rankAdminCode = String(env.MI_RANK_ADMIN_CODE || env.MI_DEMO_ADMIN_CODE || "").trim();
    if (ownerCode === PRIMARY_AGENCY_CODE) headers.set("x-mi-owner-agency-code", ownerCode);
    if (superAdminCode) headers.set("x-mi-super-admin-code", superAdminCode);
    if (rankAdminCode) headers.set("x-demo-admin-code", rankAdminCode);
    if (requestedTarget) headers.set("x-mi-agency-code", requestedTarget);
    if (path.startsWith("/api/admin/")) {
      const key = secretKey(env);
      if (key) headers.set("apikey", key);
    }
  } else if (claims.role === "team") {
    if (claims.teamCode) headers.set("x-mi-team-code", claims.teamCode);
    if (claims.agencyCode) {
      headers.set("x-mi-agency-code", claims.agencyCode);
      headers.set("x-mi-rank-access-code", claims.agencyCode);
    } else if (claims.teamCode && TEAM_ACCOUNT_ONLY_RANK_PATHS.has(path)) {
      headers.set("x-mi-agency-code", claims.teamCode);
      headers.set("x-mi-rank-access-code", claims.teamCode);
    }
  } else if (claims.role === "client" && trial) {
    // 체험 계정: 대행사 코드 자리에 trial-xxxxxxxx 를 실어 조사 노트·홈 피드 범위를 가른다.
    // 순위 접근 코드는 주지 않는다 — 순위 경로 자체가 TRIAL_LOCKED 로 닫혀 있다.
    if (claims.agencyCode) headers.set("x-mi-agency-code", claims.agencyCode);
  } else if (claims.role === "client" && claims.agencyCode) {
    headers.set("x-mi-agency-code", claims.agencyCode);
    headers.set("x-mi-rank-access-code", claims.agencyCode);
  }

  return new Request(request, { headers });
}

export async function authorizeCodeSession(request, env = process.env, options = {}) {
  if (!requiresCodeSession(request)) return { ok: true, request, session: null };
  const path = new URL(request.url).pathname;
  const claims = sessionFromRequest(request, env);
  if (!claims) {
    return {
      ok: false,
      response: protectedJson(request, {
        ok: false,
        code: "SESSION_REQUIRED",
        message: "안전한 접속 세션이 필요합니다.",
      }, 401),
    };
  }
  if (!roleAllowsPath(claims.role, path)) {
    return {
      ok: false,
      response: protectedJson(request, { ok: false, message: "이 계정에는 해당 작업 권한이 없습니다." }, 403),
    };
  }
  const trialSample = isTrialClaims(claims) && request.method === "GET" && TRIAL_SAMPLE_TRACKER_PATHS.has(path);
  if (isTrialClaims(claims) && !trialSample && !trialAllowsPath(path)) {
    return {
      ok: false,
      response: protectedJson(request, {
        ok: false,
        code: "TRIAL_LOCKED",
        message: "체험 계정은 키워드 조회만 열려 있습니다. 순위 추적·보고서 등은 도입 문의 후 이용할 수 있습니다.",
      }, 403),
    };
  }
  if (!sessionScopeAllowsPath(claims, path)) {
    return {
      ok: false,
      response: protectedJson(request, {
        ok: false,
        code: "ADVERTISER_SCOPE_REQUIRED",
        message: "광고주 데이터 기능입니다. 광고주를 연결하면 현재 운영팀 세션에서 바로 활성화됩니다.",
      }, 403),
    };
  }
  if (!mutationOriginAllowed(request)) {
    return {
      ok: false,
      response: protectedJson(request, { ok: false, message: "허용되지 않은 요청 출처입니다." }, 403),
    };
  }
  if (!SAFE_METHODS.has(request.method) && !csrfMatches(claims, request.headers.get("x-mi-csrf"))) {
    return {
      ok: false,
      response: protectedJson(request, { ok: false, message: "요청 검증에 실패했습니다." }, 403),
    };
  }
  const activityState = await sessionActivityState(claims, env, options);
  if (activityState === SESSION_ACTIVITY_UNAVAILABLE) {
    return {
      ok: false,
      response: protectedJson(request, {
        ok: false,
        code: "SESSION_VALIDATION_UNAVAILABLE",
        message: "계정 연결 상태를 일시적으로 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
      }, 503),
    };
  }
  if (activityState !== SESSION_ACTIVITY_ACTIVE) {
    return {
      ok: false,
      response: protectedJson(request, {
        ok: false,
        code: "SESSION_REVOKED",
        message: "계정 연결 상태가 변경되어 다시 접속해야 합니다.",
      }, 401),
    };
  }
  if (claims.role === "client" && !isTrialClaims(claims)) {
    const expiresAt = recalledPlanExpiry(claims.sid);
    if (expiresAt && planRestricted(planStatus({ plan_expires_at: expiresAt })) && !planExpiredAllowsRequest(request, path)) {
      return {
        ok: false,
        response: protectedJson(request, {
          ok: false,
          code: "PLAN_EXPIRED",
          message: "이용 기간이 끝났습니다. 연장 문의는 카카오톡 채널로 주세요.",
        }, 403),
      };
    }
  }
  if (trialSample) {
    // 활성 확인을 지난 체험 세션에만 예시 목록을 준다. 응답 모양은 실제 핸들러와 같아 화면이 그대로 그린다.
    const sample = trialSampleTrackersPayload(path, claims, Date.now());
    if (sample) return { ok: false, response: protectedJson(request, sample, 200) };
  }
  if (isTrialClaims(claims) && trialKeywordLookupRequest(request, path)) {
    const quota = await consumeTrialKeywordQuota(claims, env, options);
    if (!quota.allowed) {
      return {
        ok: false,
        response: protectedJson(request, {
          ok: false,
          code: "TRIAL_QUOTA",
          message: `오늘 체험 조회 ${quota.limit}회를 모두 썼습니다. 내일 다시 열리거나, 도입 문의로 제한 없이 이용하세요.`,
          used: quota.used,
          limit: quota.limit,
        }, 429, { extraHeaders: { "x-mi-trial-quota": `${quota.used}/${quota.limit}` } }),
      };
    }
  }
  return { ok: true, request: internalRequestForSession(request, claims, env), session: claims };
}

export async function boundedApiRequest(request, options = {}) {
  if (SAFE_METHODS.has(request.method) || !request.body) return { ok: true, request };
  const url = new URL(request.url);
  const defaultLimit = url.pathname === "/api/session" ? 16 * 1024 : 12 * 1024 * 1024;
  const requestedLimit = options.maxBytes ?? process.env.MI_MAX_API_BODY_BYTES ?? defaultLimit;
  const parsedLimit = Number(requestedLimit);
  const maxBytes = Math.min(
    25 * 1024 * 1024,
    Math.max(1024, Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : defaultLimit),
  );
  const rawLength = request.headers.get("content-length");
  if (rawLength && (!/^\d+$/.test(rawLength) || Number(rawLength) > maxBytes)) {
    return { ok: false, response: protectedJson(request, { ok: false, message: "요청 본문이 너무 큽니다." }, 413) };
  }
  if (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity") {
    return { ok: false, response: protectedJson(request, { ok: false, message: "압축된 요청 본문은 허용하지 않습니다." }, 415) };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("request_body_too_large").catch(() => {});
      return { ok: false, response: protectedJson(request, { ok: false, message: "요청 본문이 너무 큽니다." }, 413) };
    }
    chunks.push(value);
  }

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  const headers = new Headers(request.headers);
  headers.set("content-length", String(body.length));
  return {
    ok: true,
    request: new Request(request.url, {
      method: request.method,
      headers,
      body,
    }),
  };
}

export function legacyCodeHeadersAllowed(env = process.env) {
  return !isProduction(env) && env.MI_ALLOW_LEGACY_CODE_HEADERS === "true";
}

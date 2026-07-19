import { csrfMatches, sessionFromRequest } from "./code-session.mjs";
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
]);

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
  return path.startsWith("/api/team/") || path === "/api/team-agency-codes";
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

function optionalColumnUnavailable(result) {
  return result?.status === 400 && ["42703", "PGRST204"].includes(result.errorCode);
}

async function activeClientForClaims(claims, env, fetchImpl) {
  if (!claims.clientId || !claims.agencyCode) return SESSION_ACTIVITY_REVOKED;
  let result = await selectSessionRows("clients", {
    select: "id,agency_code,status,disconnected_at",
    id: `eq.${claims.clientId}`,
    agency_code: `eq.${claims.agencyCode}`,
    status: "eq.active",
    disconnected_at: "is.null",
    limit: "1",
  }, env, fetchImpl);
  if (optionalColumnUnavailable(result)) {
    result = await selectSessionRows("clients", {
      select: "id,agency_code,status",
      id: `eq.${claims.clientId}`,
      agency_code: `eq.${claims.agencyCode}`,
      status: "eq.active",
      limit: "1",
    }, env, fetchImpl);
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
  headers.set("x-mi-session-role", claims.role);
  headers.set("x-mi-session-scope", claims.agencyCode ? "advertiser" : "account-only");

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
    }
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
  if (!sessionScopeAllowsPath(claims, path)) {
    return {
      ok: false,
      response: protectedJson(request, {
        ok: false,
        code: "ADVERTISER_SCOPE_REQUIRED",
        message: "연결된 광고주가 있어야 이 기능을 사용할 수 있습니다.",
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

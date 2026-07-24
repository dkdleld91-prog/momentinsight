import { createHash, timingSafeEqual } from "node:crypto";
import { withSupabase } from "@supabase/server";
import {
  clearedSessionCookies,
  createSessionClaims,
  csrfMatches,
  publicSession,
  sealSession,
  sessionConfiguration,
  sessionCookie,
  sessionFromRequest,
} from "../code-session.mjs";
import {
  ownerClaimsMatchPrimary,
  primaryAgencyConfiguration,
} from "../owner-identity.mjs";
import { allowedOrigins, corsHeaders } from "../security.mjs";

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function loginRateConfiguration(env = process.env) {
  const attemptLimit = boundedInteger(env.MI_CODE_LOGIN_ATTEMPT_LIMIT, 5, 3, 20);
  return {
    windowSeconds: boundedInteger(env.MI_CODE_LOGIN_WINDOW_SECONDS, 900, 60, 3600),
    attemptLimit,
    ipAttemptLimit: Math.max(
      attemptLimit,
      boundedInteger(env.MI_CODE_LOGIN_IP_ATTEMPT_LIMIT, 30, 5, 100),
    ),
  };
}

const LOGIN_RATE = loginRateConfiguration();
const LOGIN_WINDOW_SECONDS = LOGIN_RATE.windowSeconds;
const LOGIN_ATTEMPT_LIMIT = LOGIN_RATE.attemptLimit;
const LOGIN_IP_ATTEMPT_LIMIT = LOGIN_RATE.ipAttemptLimit;
const localRateBuckets = new Map();
const SESSION_ACTIVITY_ACTIVE = "active";
const SESSION_ACTIVITY_REVOKED = "revoked";
const SESSION_ACTIVITY_UNAVAILABLE = "unavailable";

function isProduction(env = process.env) {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

export function loginRequestAllowed(request) {
  const origin = String(request.headers.get("origin") || "").trim();
  const contentType = String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return false;
  return !origin || allowedOrigins().includes(origin);
}

function response(request, body, status = 200, cookies = []) {
  const headers = new Headers(corsHeaders(request, {
    methods: "GET, POST, OPTIONS",
    headers: "content-type, x-mi-csrf",
  }));
  headers.set("content-type", "application/json; charset=utf-8");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function normalizeLoginCode(value) {
  const code = String(value || "").trim();
  if (code.length < 6 || code.length > 128) return "";
  if (!/^[A-Za-z0-9.~!@#$^&*+=:-]+$/.test(code)) return "";
  return code;
}

function normalizedIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function primaryAgencyCode(env = process.env) {
  return primaryAgencyConfiguration(env).effective;
}

export function ownerCredentialConfigured(env = process.env) {
  return Boolean(String(env.MI_OWNER_LOGIN_CODE_SHA256 || env.MI_OWNER_LOGIN_CODE || "").trim());
}

export function ownerCredentialMatches(code, env = process.env) {
  if (!primaryAgencyConfiguration(env).valid) return false;
  const expectedHash = String(env.MI_OWNER_LOGIN_CODE_SHA256 || "").trim().toLowerCase();
  if (expectedHash) return safeEqual(sha256(code), expectedHash);
  const expected = String(env.MI_OWNER_LOGIN_CODE || "").trim();
  if (expected) return safeEqual(code, expected);
  if (!isProduction(env)) return safeEqual(normalizedIdentity(code), primaryAgencyCode(env));
  return false;
}

function clientIp(request) {
  const forwarded = request.headers.get("x-vercel-forwarded-for")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")
    || "anonymous";
  return String(forwarded).split(",")[0].trim().slice(0, 128) || "anonymous";
}

export function loginRateKeys(request, mode, code) {
  const ip = clientIp(request);
  return {
    ip: sha256(`ip\u0000${ip}`),
    credential: sha256(`credential\u0000${ip}\u0000${mode}\u0000${normalizedIdentity(code)}`),
  };
}

function consumeLocalRateLimit(key, attemptLimit = LOGIN_ATTEMPT_LIMIT) {
  const now = Date.now();
  const windowMs = LOGIN_WINDOW_SECONDS * 1000;
  const existing = localRateBuckets.get(key);
  const bucket = !existing || now - existing.startedAt >= windowMs
    ? { startedAt: now, count: 0 }
    : existing;
  bucket.count += 1;
  localRateBuckets.set(key, bucket);

  if (bucket.count > attemptLimit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000)),
    };
  }
  return { allowed: true, retryAfter: 0 };
}

async function consumeRateBucket(ctx, key, attemptLimit) {
  const result = await ctx.supabaseAdmin.rpc("consume_code_login_rate_limit", {
    p_key_hash: key,
    p_window_seconds: LOGIN_WINDOW_SECONDS,
    p_attempt_limit: attemptLimit,
  });

  if (!result.error) {
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    return {
      allowed: row?.allowed !== false,
      retryAfter: Number(row?.retry_after || 0),
      key,
      durable: true,
    };
  }

  if (isProduction()) {
    return { allowed: false, unavailable: true, retryAfter: 60, key, durable: false };
  }
  const local = consumeLocalRateLimit(key, attemptLimit);
  return { ...local, key, durable: false };
}

export async function consumeRateLimit(request, ctx, mode, code) {
  const keys = loginRateKeys(request, mode, code);
  const [ipRate, credentialRate] = await Promise.all([
    consumeRateBucket(ctx, keys.ip, LOGIN_IP_ATTEMPT_LIMIT),
    consumeRateBucket(ctx, keys.credential, LOGIN_ATTEMPT_LIMIT),
  ]);
  if (ipRate.unavailable || !ipRate.allowed) return { ...ipRate, credentialKey: keys.credential };
  return { ...credentialRate, credentialKey: keys.credential };
}

async function clearRateLimit(ctx, key) {
  if (!key) return;
  await ctx.supabaseAdmin.from("code_login_rate_limits").delete().eq("key_hash", key);
  localRateBuckets.delete(key);
}

async function activeClientByCode(ctx, code) {
  let query = ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, disconnected_at")
    .ilike("agency_code", normalizedIdentity(code))
    .eq("status", "active");
  const result = await query.maybeSingle();
  if (result.error && /disconnected_at|schema cache/i.test(result.error.message || "")) {
    return ctx.supabaseAdmin
      .from("clients")
      .select("id, name, business_name, agency_code, status")
      .ilike("agency_code", normalizedIdentity(code))
      .eq("status", "active")
      .maybeSingle();
  }
  if (result.data?.disconnected_at) return { data: null, error: null };
  return result;
}

export async function activeTeamByCode(ctx, code) {
  let result = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, team_name, team_code, status, client_id, revoked_at")
    .ilike("team_code", normalizedIdentity(code))
    .eq("status", "active")
    .maybeSingle();
  if (result.error && /revoked_at|schema cache/i.test(result.error.message || "")) {
    result = await ctx.supabaseAdmin
      .from("operation_team_codes")
      .select("id, team_name, team_code, status, client_id")
      .ilike("team_code", normalizedIdentity(code))
      .eq("status", "active")
      .maybeSingle();
  }
  if (result.error || !result.data) return result;
  if (result.data.revoked_at) return { data: null, error: null };

  let client = null;
  if (result.data.client_id) {
    let clientResult = await ctx.supabaseAdmin
      .from("clients")
      .select("id, name, business_name, agency_code, status, disconnected_at")
      .eq("id", result.data.client_id)
      .eq("status", "active")
      .maybeSingle();
    if (clientResult.error && /disconnected_at|schema cache/i.test(clientResult.error.message || "")) {
      clientResult = await ctx.supabaseAdmin
        .from("clients")
        .select("id, name, business_name, agency_code, status")
        .eq("id", result.data.client_id)
        .eq("status", "active")
        .maybeSingle();
    }
    if (clientResult.error) return { data: null, error: clientResult.error };
    if (!clientResult.data || clientResult.data.disconnected_at) return { data: null, error: null };
    client = clientResult.data;
  }
  return { data: { ...result.data, client }, error: null };
}

async function authenticateCode(ctx, mode, code) {
  if (mode === "admin" && ownerCredentialMatches(code)) {
    return {
      role: "owner",
      agencyCode: primaryAgencyCode(),
      client: null,
      team: null,
    };
  }

  if (mode === "admin" || mode === "operator") {
    const { data: team, error } = await activeTeamByCode(ctx, code);
    if (error) return { error };
    if (!team) return null;
    return {
      role: "team",
      teamCode: team.team_code,
      teamId: team.id,
      clientId: team.client?.id || "",
      agencyCode: team.client?.agency_code || "",
      client: team.client || null,
      team,
    };
  }

  if (mode === "client") {
    const { data: client, error } = await activeClientByCode(ctx, code);
    if (error) return { error };
    if (!client) return null;
    return {
      role: "client",
      clientId: client.id,
      agencyCode: client.agency_code,
      client,
      team: null,
    };
  }

  return null;
}

function visibleClient(client) {
  if (!client) return null;
  return {
    id: client.id,
    name: client.name || "",
    businessName: client.business_name || "",
    status: client.status || "active",
  };
}

function visibleTeam(team) {
  if (!team) return null;
  return {
    id: team.id,
    teamName: team.team_name || "",
    status: team.status || "active",
    client: visibleClient(team.client),
  };
}

export async function sessionActivityState(ctx, claims) {
  if (!claims) return { state: SESSION_ACTIVITY_REVOKED, active: null };
  if (claims.role === "owner") {
    const active = ownerClaimsMatchPrimary(claims)
      && (ownerCredentialConfigured() || !isProduction())
      ? { role: "owner" }
      : null;
    return { state: active ? SESSION_ACTIVITY_ACTIVE : SESSION_ACTIVITY_REVOKED, active };
  }

  try {
    if (claims.role === "team") {
      const result = await activeTeamByCode(ctx, claims.teamCode);
      if (result.error) return { state: SESSION_ACTIVITY_UNAVAILABLE, active: null, error: result.error };
      const active = result.data && (!claims.teamId || result.data.id === claims.teamId)
        ? { role: "team", team: result.data, client: result.data.client || null }
        : null;
      return { state: active ? SESSION_ACTIVITY_ACTIVE : SESSION_ACTIVITY_REVOKED, active };
    }
    if (claims.role === "client") {
      const result = await activeClientByCode(ctx, claims.agencyCode);
      if (result.error) return { state: SESSION_ACTIVITY_UNAVAILABLE, active: null, error: result.error };
      const active = result.data && (!claims.clientId || result.data.id === claims.clientId)
        ? { role: "client", client: result.data }
        : null;
      return { state: active ? SESSION_ACTIVITY_ACTIVE : SESSION_ACTIVITY_REVOKED, active };
    }
  } catch (error) {
    return { state: SESSION_ACTIVITY_UNAVAILABLE, active: null, error };
  }
  return { state: SESSION_ACTIVITY_REVOKED, active: null };
}

export async function sessionStillActive(ctx, claims) {
  const activity = await sessionActivityState(ctx, claims);
  return activity.state === SESSION_ACTIVITY_ACTIVE ? activity.active : null;
}

async function login(request, ctx) {
  if (!loginRequestAllowed(request)) {
    return response(request, {
      ok: false,
      code: "LOGIN_REQUEST_REJECTED",
      message: "허용되지 않은 접속 요청입니다.",
    }, 403);
  }

  const config = sessionConfiguration();
  if (!config.valid) {
    return response(request, {
      ok: false,
      code: "SESSION_CONFIGURATION_REQUIRED",
      message: "보안 세션 설정이 완료되지 않아 접속을 차단했습니다.",
    }, 503);
  }

  const ownerIdentity = primaryAgencyConfiguration();
  if (!ownerIdentity.valid) {
    return response(request, {
      ok: false,
      code: "PRIMARY_AGENCY_CONFIGURATION_REQUIRED",
      message: "총관리자 계정 기준 설정을 확인할 수 없어 접속을 차단했습니다.",
    }, 503);
  }

  const body = await readJson(request);
  const mode = String(body.mode || "client").trim().toLowerCase();
  const code = normalizeLoginCode(body.code);
  if (!code || !["admin", "operator", "client"].includes(mode)) {
    return response(request, { ok: false, message: "접속 정보를 확인해주세요." }, 400);
  }

  const rate = await consumeRateLimit(request, ctx, mode, code);
  if (rate.unavailable) {
    return response(request, {
      ok: false,
      code: "LOGIN_RATE_LIMIT_UNAVAILABLE",
      message: "로그인 보호 장치를 확인할 수 없어 안전을 위해 접속을 차단했습니다.",
    }, 503);
  }
  if (!rate.allowed) {
    return response(request, {
      ok: false,
      code: "LOGIN_RATE_LIMITED",
      message: "접속 시도가 많아 잠시 차단되었습니다.",
      retryAfter: rate.retryAfter,
    }, 429);
  }

  const access = await authenticateCode(ctx, mode, code);
  if (!access || access.error) {
    return response(request, {
      ok: false,
      code: "INVALID_ACCESS_CODE",
      message: "접속 코드 또는 권한을 확인해주세요.",
    }, 401);
  }

  // Keep the shared IP bucket so a successful login cannot reset protection
  // against sequential enumeration of other predictable account identifiers.
  await clearRateLimit(ctx, rate.credentialKey);
  const claims = createSessionClaims(access, { ttlSeconds: config.ttl });
  const token = sealSession(claims);
  return response(request, {
    ok: true,
    session: publicSession(claims),
    client: visibleClient(access.client),
    team: visibleTeam(access.team),
  }, 200, [sessionCookie(token)]);
}

async function currentSession(request, ctx) {
  const claims = sessionFromRequest(request);
  if (!claims) {
    return response(request, { ok: false, message: "접속 세션이 만료되었습니다." }, 401, clearedSessionCookies());
  }
  const activity = await sessionActivityState(ctx, claims);
  if (activity.state === SESSION_ACTIVITY_UNAVAILABLE) {
    return response(request, {
      ok: false,
      code: "SESSION_VALIDATION_UNAVAILABLE",
      message: "계정 연결 상태를 일시적으로 확인할 수 없습니다. 잠시 후 다시 시도해주세요.",
    }, 503);
  }
  if (activity.state !== SESSION_ACTIVITY_ACTIVE || !activity.active) {
    return response(request, { ok: false, message: "접속 세션이 만료되었습니다." }, 401, clearedSessionCookies());
  }
  const active = activity.active;
  let responseClaims = claims;
  const cookies = [];
  if (claims.role === "team") {
    const nextClientId = String(active.client?.id || "");
    const nextAgencyCode = String(active.client?.agency_code || "");
    if (String(claims.clientId || "") !== nextClientId || String(claims.agencyCode || "") !== nextAgencyCode) {
      const config = sessionConfiguration();
      if (!config.valid) {
        return response(request, { ok: false, message: "보안 세션 설정을 확인할 수 없습니다." }, 503);
      }
      responseClaims = createSessionClaims({
        role: "team",
        teamCode: active.team.team_code,
        teamId: active.team.id,
        clientId: nextClientId,
        agencyCode: nextAgencyCode,
      }, { ttlSeconds: config.ttl });
      cookies.push(sessionCookie(sealSession(responseClaims)));
    }
  }
  return response(request, {
    ok: true,
    session: publicSession(responseClaims),
    client: visibleClient(active.client),
    team: visibleTeam(active.team),
  }, 200, cookies);
}

async function logout(request) {
  const claims = sessionFromRequest(request);
  if (claims && !csrfMatches(claims, request.headers.get("x-mi-csrf"))) {
    return response(request, { ok: false, message: "요청 검증에 실패했습니다." }, 403);
  }
  return response(request, { ok: true }, 200, clearedSessionCookies());
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    const path = new URL(request.url).pathname;
    if (path !== "/api/session") return response(request, { ok: false, message: "Not found" }, 404);
    if (request.method === "GET") return currentSession(request, ctx);
    if (request.method !== "POST") return response(request, { ok: false, message: "Method not allowed" }, 405);
    const action = new URL(request.url).searchParams.get("action") || "login";
    if (action === "logout") return logout(request);
    return login(request, ctx);
  }),
};

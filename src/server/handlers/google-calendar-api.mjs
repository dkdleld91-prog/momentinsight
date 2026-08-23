import { withSupabase } from "@supabase/server";
import crypto from "node:crypto";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import {
  createSessionClaims,
  parseCookies,
  sealSession,
  sessionConfiguration,
  sessionCookie,
} from "../code-session.mjs";
import {
  DEDICATED_CALENDAR_SUMMARY,
  GOOGLE_TOKEN_URL,
  googleFetch,
  googleOauthConfig,
  loadOwnerGoogleIntegration,
  mapScheduleRowToGoogleEvent,
} from "../google-calendar-client.mjs";
import { readBody } from "../http.mjs";
import { protectedJson, safeEqual } from "../security.mjs";
import { activeClientByCode, activeTeamByCode } from "./code-session-api.mjs";
import {
  deleteRowFromGoogle,
  recordGoogleDeleteFailure,
  runOwnerCalendarSync,
  syncOwnerScheduleRows,
} from "./google-calendar-sync.mjs";

export {
  deleteRowFromGoogle,
  googleOauthConfig,
  loadOwnerGoogleIntegration,
  mapScheduleRowToGoogleEvent,
  recordGoogleDeleteFailure,
  syncOwnerScheduleRows,
};

const OWNER_API_PATH = "/api/owner/google-calendar";
const OWNER_LOGIN_API_PATH = "/api/owner/google-login";
const LOGIN_START_PATH = "/api/google-login/start";
const CALLBACK_PATH = "/api/google-oauth/callback";
const LOGIN_SCOPE = "openid email";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar";
const STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_NONCE_COOKIE = "mi-goauth-nonce";
const OAUTH_NONCE_MAX_AGE_SECONDS = 600;
const OAUTH_RATE_WINDOW_SECONDS = 15 * 60;
const OAUTH_RATE_ATTEMPT_LIMIT = 20;
const GOOGLE_ID_TOKEN_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const GOOGLE_ID_TOKEN_SKEW_SECONDS = 60;
const DEFAULT_GOOGLE_LOGIN_ROLES = "owner";
const AUDIT_LOGIN_TABLE = "login_identities";
const SYNC_AUTO_THROTTLE_SECONDS = 60;
const SYNC_MANUAL_THROTTLE_SECONDS = 10;
const oauthRateBuckets = new Map();

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "content-type, x-mi-csrf",
  });
}

function cleanText(value, max = 0) {
  const text = String(value ?? "").trim();
  return max ? text.slice(0, max) : text;
}

function primaryAgencyCode(env = process.env) {
  return cleanText(env.MI_PRIMARY_AGENCY_CODE || "mml93-a01").toLowerCase();
}

function isProduction(env = process.env) {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

// The OAuth callback arrives as a cross-site top-level navigation from
// accounts.google.com, which never carries SameSite=Strict cookies, so the
// browser binding has to be Lax to be readable exactly when it is verified.
function oauthNonceCookie(nonce, env = process.env) {
  const parts = [
    `${OAUTH_NONCE_COOKIE}=${cleanText(nonce, 128)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${OAUTH_NONCE_MAX_AGE_SECONDS}`,
  ];
  if (isProduction(env)) parts.push("Secure");
  return parts.join("; ");
}

function clearedOauthNonceCookie(env = process.env) {
  const parts = [`${OAUTH_NONCE_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isProduction(env)) parts.push("Secure");
  return parts.join("; ");
}

function withCookies(response, cookies = []) {
  if (!cookies.length) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function nonceMatches(expected, supplied) {
  const wanted = Buffer.from(cleanText(expected, 128), "utf8");
  const provided = Buffer.from(cleanText(supplied, 128), "utf8");
  return wanted.length > 0 && wanted.length === provided.length && crypto.timingSafeEqual(wanted, provided);
}

function clientIp(request) {
  const forwarded = request.headers.get("x-vercel-forwarded-for")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")
    || "anonymous";
  return String(forwarded).split(",")[0].trim().slice(0, 128) || "anonymous";
}

function oauthRateKey(request, endpoint) {
  return crypto.createHash("sha256")
    .update(`google-oauth:${endpoint}\u0000${clientIp(request)}`, "utf8")
    .digest("hex");
}

function consumeLocalOauthRate(key, now = Date.now()) {
  const windowMs = OAUTH_RATE_WINDOW_SECONDS * 1000;
  const existing = oauthRateBuckets.get(key);
  const bucket = !existing || now - existing.startedAt >= windowMs
    ? { startedAt: now, count: 0 }
    : existing;
  bucket.count += 1;
  oauthRateBuckets.set(key, bucket);
  return bucket.count <= OAUTH_RATE_ATTEMPT_LIMIT;
}

// Google OAuth throttling is abuse mitigation, never authentication: unlike code
// login it degrades to the per-instance bucket instead of failing closed, so a
// limiter outage can never lock the owner out of the console.
export async function consumeOauthRateLimit(ctx, request, endpoint) {
  const key = oauthRateKey(request, endpoint);
  try {
    const result = await ctx.supabaseAdmin.rpc("consume_code_login_rate_limit", {
      p_key_hash: key,
      p_window_seconds: OAUTH_RATE_WINDOW_SECONDS,
      p_attempt_limit: OAUTH_RATE_ATTEMPT_LIMIT,
    });
    if (!result.error) {
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      return row?.allowed !== false;
    }
  } catch (error) {
    // fall through to the local bucket below
  }
  return consumeLocalOauthRate(key);
}

async function recordLoginAudit(ctx, action, metadata) {
  try {
    await ctx.supabaseAdmin.from("audit_logs").insert({
      actor_id: null,
      client_id: null,
      action,
      target_table: AUDIT_LOGIN_TABLE,
      target_id: null,
      metadata: sanitizeAuditMetadata(metadata),
    }).then(() => {}, () => {});
  } catch (error) {
    // auditing never blocks or changes the login outcome
  }
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function stateSignature(payloadText, secret) {
  return crypto.createHmac("sha256", secret).update(payloadText).digest("base64url");
}

export function signOauthState(ownerCode, env = process.env, now = Date.now(), purpose = "calendar") {
  const config = googleOauthConfig(env);
  if (!config.clientSecret) return "";
  const payloadText = JSON.stringify({
    owner: cleanText(ownerCode).toLowerCase(),
    p: cleanText(purpose) || "calendar",
    exp: now + STATE_TTL_MS,
    nonce: crypto.randomBytes(12).toString("base64url"),
  });
  const encoded = base64UrlEncode(payloadText);
  return `${encoded}.${stateSignature(encoded, config.clientSecret)}`;
}

export function verifyOauthState(state, env = process.env, now = Date.now()) {
  const config = googleOauthConfig(env);
  const [encoded, signature] = cleanText(state).split(".");
  if (!config.clientSecret || !encoded || !signature) return null;
  const expected = stateSignature(encoded, config.clientSecret);
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.owner || Number(payload.exp) < now) return null;
    if (!payload.p) payload.p = "calendar";
    return payload;
  } catch (error) {
    return null;
  }
}

export function oauthStateNonce(state) {
  const [encoded] = cleanText(state).split(".");
  if (!encoded) return "";
  try {
    return cleanText(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).nonce, 128);
  } catch (error) {
    return "";
  }
}

// Reads the purpose out of an unverified state. The result only decides which
// query key the browser is redirected with; it is never used for authorization.
function unsignedStatePurpose(state) {
  const [encoded] = cleanText(state).split(".");
  if (!encoded) return "calendar";
  try {
    return cleanText(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).p) || "calendar";
  } catch (error) {
    return "calendar";
  }
}

export function buildGoogleAuthUrl(state, env = process.env, scope = GOOGLE_SCOPE, purpose = "calendar") {
  const config = googleOauthConfig(env);
  if (!config.clientId || !state) return "";
  // Signing in needs no refresh token, so the login flow asks for an account
  // picker instead of re-prompting for offline consent on every visit.
  const signIn = cleanText(purpose) === "login";
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUrl,
    response_type: "code",
    scope,
    ...(signIn ? { prompt: "select_account" } : { access_type: "offline", prompt: "consent" }),
    include_granted_scopes: "false",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function exchangeOauthCode(code, env, fetchImpl = fetch) {
  const config = googleOauthConfig(env);
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUrl,
      grant_type: "authorization_code",
    }).toString(),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) return { ok: false, status: response.status, data };
  return { ok: true, status: response.status, data };
}

// The token always arrives over TLS straight from Google's token endpoint, so
// the signature is already covered; what still has to be proven is that the
// token was minted for this client, by Google, and is not stale or unverified.
export function decodeGoogleIdToken(idToken, options = {}) {
  const env = options.env || process.env;
  const expectedAudience = cleanText(options.aud ?? googleOauthConfig(env).clientId);
  const nowSeconds = Math.floor(Number(options.now ?? Date.now()) / 1000);
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sub = cleanText(payload.sub, 128);
    if (!sub) return null;
    if (!expectedAudience || !safeEqual(cleanText(payload.aud), expectedAudience)) return null;
    if (!GOOGLE_ID_TOKEN_ISSUERS.has(cleanText(payload.iss))) return null;
    const expiresAt = Number(payload.exp);
    if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds - GOOGLE_ID_TOKEN_SKEW_SECONDS) return null;
    const email = payload.email_verified === true
      ? cleanText(payload.email, 256).toLowerCase() || null
      : null;
    return { sub, email };
  } catch (error) {
    return null;
  }
}

function googleLoginRoles(env = process.env) {
  const configured = cleanText(env.MI_GOOGLE_LOGIN_ROLES || DEFAULT_GOOGLE_LOGIN_ROLES)
    .toLowerCase()
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  return new Set(configured.length ? configured : [DEFAULT_GOOGLE_LOGIN_ROLES]);
}

// Returns the same access shape code login builds, so the session claims a
// google login mints are indistinguishable from a code login for that account.
export async function resolveGoogleLoginAccess(identity, ctx, env = process.env) {
  const role = cleanText(identity?.role).toLowerCase();
  const code = cleanText(identity?.code).toLowerCase();
  if (!googleLoginRoles(env).has(role)) return { ok: false, reason: "not-ready" };

  if (role === "owner") {
    const ownerCode = primaryAgencyCode(env);
    if (!safeEqual(code, ownerCode)) return { ok: false, reason: "not-ready" };
    return { ok: true, access: { role: "owner", agencyCode: ownerCode } };
  }

  if (role === "team") {
    const { data: team, error } = await activeTeamByCode(ctx, code);
    if (error) return { ok: false, reason: "lookup-failed" };
    if (!team) return { ok: false, reason: "inactive" };
    return {
      ok: true,
      access: {
        role: "team",
        teamCode: team.team_code,
        teamId: team.id,
        clientId: team.client?.id || "",
        agencyCode: team.client?.agency_code || "",
      },
    };
  }

  if (role === "client") {
    const { data: client, error } = await activeClientByCode(ctx, code);
    if (error) return { ok: false, reason: "lookup-failed" };
    if (!client) return { ok: false, reason: "inactive" };
    return { ok: true, access: { role: "client", clientId: client.id, agencyCode: client.agency_code } };
  }

  return { ok: false, reason: "not-ready" };
}

export async function findLoginIdentity(ctx, googleSub) {
  const { data, error } = await ctx.supabaseAdmin
    .from("login_identities")
    .select("google_sub, google_email, role, code, linked_at")
    .eq("google_sub", cleanText(googleSub, 128))
    .maybeSingle();
  if (error) return { identity: null, error };
  return { identity: data || null, error: null };
}

export async function upsertLoginIdentity(ctx, identity) {
  const { error } = await ctx.supabaseAdmin
    .from("login_identities")
    .upsert({
      google_sub: cleanText(identity.googleSub, 128),
      google_email: cleanText(identity.googleEmail, 256).toLowerCase() || null,
      role: cleanText(identity.role, 20),
      code: cleanText(identity.code, 128).toLowerCase(),
      linked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "google_sub" });
  return !error;
}

export async function findLinkTargetIdentity(ctx, linkTarget) {
  const { data, error } = await ctx.supabaseAdmin
    .from("login_identities")
    .select("google_sub, role, code")
    .eq("role", linkTarget.role)
    .eq("code", linkTarget.code)
    .maybeSingle();
  if (error) return { identity: null, error };
  return { identity: data || null, error: null };
}

// Re-linking a different google account to the caller's own login target is the
// user's authenticated intent. The move is one UPDATE rather than a delete plus
// an insert, so a transient failure leaves the previous mapping intact instead
// of stranding the account with no google login at all.
export async function rebindLinkTargetIdentity(ctx, linkTarget, profile) {
  const { data, error } = await ctx.supabaseAdmin
    .from("login_identities")
    .update({
      google_sub: cleanText(profile.sub, 128),
      google_email: cleanText(profile.email, 256).toLowerCase() || null,
      linked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("role", linkTarget.role)
    .eq("code", linkTarget.code)
    .select("google_sub");
  if (error) return false;
  return Array.isArray(data) && data.length === 1;
}

function ownerRequest(request, env = process.env) {
  return request.headers.get("x-mi-session-role") === "owner"
    && safeEqual(cleanText(request.headers.get("x-mi-owner-agency-code")).toLowerCase(), primaryAgencyCode(env));
}

async function handleOwnerApi(request, ctx) {
  if (!ownerRequest(request)) {
    return json(request, { ok: false, message: "총관리자 전용 기능입니다." }, 403);
  }
  const ownerCode = primaryAgencyCode();
  if (request.method === "GET") {
    const config = googleOauthConfig();
    let integration = null;
    let storageReady = true;
    try {
      const loaded = await loadOwnerGoogleIntegration(ctx, ownerCode);
      if (loaded.error) storageReady = false;
      else integration = loaded.integration;
    } catch (error) {
      storageReady = false;
    }
    return json(request, {
      ok: true,
      configured: Boolean(config.clientId && config.clientSecret),
      storageReady,
      connected: Boolean(integration),
      googleEmail: integration?.google_email || null,
      connectedAt: integration?.connected_at || null,
      syncStatus: integration?.sync_status || "ok",
      syncError: integration?.sync_error || null,
      lastSyncAt: integration?.last_sync_at || null,
    });
  }
  if (request.method !== "POST") return json(request, { ok: false, message: "Method not allowed" }, 405);
  const body = await readBody(request);
  const action = cleanText(body.action);
  if (action === "auth-url") {
    const config = googleOauthConfig();
    if (!config.clientId || !config.clientSecret) {
      return json(request, { ok: false, code: "missing_google_env", message: "구글 연동 환경변수(GOOGLE_OAUTH_CLIENT_ID/SECRET)가 아직 설정되지 않았습니다." }, 503);
    }
    const state = signOauthState(ownerCode);
    const url = buildGoogleAuthUrl(state);
    if (!url) return json(request, { ok: false, message: "구글 인증 주소를 만들지 못했습니다." }, 500);
    return withCookies(json(request, { ok: true, url }), [oauthNonceCookie(oauthStateNonce(state))]);
  }
  if (action === "sync") {
    const trigger = cleanText(body.trigger) === "manual" ? "manual" : "auto";
    const config = googleOauthConfig();
    if (!config.clientId || !config.clientSecret) {
      return json(request, { ok: false, code: "missing_google_env", message: "구글 연동 환경변수(GOOGLE_OAUTH_CLIENT_ID/SECRET)가 아직 설정되지 않았습니다." }, 503);
    }
    // 스로틀은 서버가 강제한다. 단일 UPDATE 로 슬롯을 선점하므로 동시 요청이
    // 겹쳐도 한 번만 통과한다. 자동 진입은 60초, 사람이 누른 버튼은 10초.
    let claimed = null;
    try {
      const claim = await ctx.supabaseAdmin.rpc("mi_claim_google_sync_slot", {
        p_owner_agency_code: ownerCode,
        p_min_seconds: trigger === "manual" ? SYNC_MANUAL_THROTTLE_SECONDS : SYNC_AUTO_THROTTLE_SECONDS,
      });
      if (claim.error) return json(request, { ok: false, message: "동기화 상태를 확인하지 못했습니다." }, 500);
      claimed = Array.isArray(claim.data) ? claim.data[0] : claim.data;
    } catch (error) {
      return json(request, { ok: false, message: "동기화 상태를 확인하지 못했습니다." }, 500);
    }
    if (!claimed) {
      const throttledState = await loadOwnerGoogleIntegration(ctx, ownerCode).catch(() => ({ integration: null }));
      return json(request, {
        ok: true,
        throttled: true,
        changed: 0,
        needsReconnect: throttledState.integration?.sync_status === "needs_reconnect",
        lastSyncAt: throttledState.integration?.last_sync_at || null,
      });
    }
    const result = await runOwnerCalendarSync(ctx, process.env, ownerCode, {});
    if (result.reason === "not-connected") {
      return json(request, { ok: false, message: "구글 캘린더가 아직 연결되지 않았습니다." }, 409);
    }
    return json(request, {
      ok: result.ok !== false,
      throttled: false,
      needsReconnect: Boolean(result.needsReconnect),
      changed: result.changed || 0,
      pushed: result.pushed || 0,
      lastSyncAt: result.lastSyncAt || null,
      error: result.error || result.reason || null,
    });
  }
  if (action === "disconnect") {
    const { error } = await ctx.supabaseAdmin
      .from("owner_google_integrations")
      .delete()
      .eq("owner_agency_code", ownerCode);
    if (error) return json(request, { ok: false, message: "구글 연동 해제에 실패했습니다.", detail: error.message }, 500);
    return json(request, { ok: true, message: "구글 캘린더 연동을 해제했습니다. 이미 등록된 구글 일정은 남아 있습니다." });
  }
  return json(request, { ok: false, message: "지원하지 않는 요청입니다." }, 400);
}

function callbackRedirect(message) {
  const target = `/admin?gcal=${encodeURIComponent(message)}#mi-admin-owner-assistant`;
  return new Response(null, { status: 302, headers: { location: target, "cache-control": "no-store" } });
}

function loginRedirect(message, cookies = []) {
  const headers = new Headers({
    location: `/admin?glogin=${encodeURIComponent(message)}`,
    "cache-control": "no-store",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function purposeRedirect(purpose, message) {
  return purpose === "login" || purpose === "link" ? loginRedirect(message) : callbackRedirect(message);
}

async function handleOwnerLoginApi(request, ctx) {
  if (!ownerRequest(request)) {
    return json(request, { ok: false, message: "총관리자 전용 기능입니다." }, 403);
  }
  const ownerCode = primaryAgencyCode();
  if (request.method === "GET") {
    const config = googleOauthConfig();
    let identity = null;
    let storageReady = true;
    try {
      const { data, error } = await ctx.supabaseAdmin
        .from("login_identities")
        .select("google_email, linked_at")
        .eq("role", "owner")
        .eq("code", ownerCode)
        .maybeSingle();
      if (error) storageReady = false;
      else identity = data || null;
    } catch (error) {
      storageReady = false;
    }
    return json(request, {
      ok: true,
      configured: Boolean(config.clientId && config.clientSecret),
      storageReady,
      linked: Boolean(identity),
      googleEmail: identity?.google_email || null,
      linkedAt: identity?.linked_at || null,
    });
  }
  if (request.method !== "POST") return json(request, { ok: false, message: "Method not allowed" }, 405);
  const body = await readBody(request);
  const action = cleanText(body.action);
  if (action === "link-url") {
    const config = googleOauthConfig();
    if (!config.clientId || !config.clientSecret) {
      return json(request, { ok: false, code: "missing_google_env", message: "구글 연동 환경변수(GOOGLE_OAUTH_CLIENT_ID/SECRET)가 아직 설정되지 않았습니다." }, 503);
    }
    const state = signOauthState(ownerCode, process.env, Date.now(), "link");
    const url = buildGoogleAuthUrl(state, process.env, LOGIN_SCOPE, "link");
    if (!url) return json(request, { ok: false, message: "구글 인증 주소를 만들지 못했습니다." }, 500);
    return withCookies(json(request, { ok: true, url }), [oauthNonceCookie(oauthStateNonce(state))]);
  }
  if (action === "unlink") {
    const { error } = await ctx.supabaseAdmin
      .from("login_identities")
      .delete()
      .eq("role", "owner")
      .eq("code", ownerCode);
    if (error) return json(request, { ok: false, message: "구글 로그인 연결 해제에 실패했습니다.", detail: error.message }, 500);
    await recordLoginAudit(ctx, "google_login_unlinked", { role: "owner" });
    return json(request, { ok: true, message: "구글 로그인 연결을 해제했습니다. 기존 코드 로그인은 그대로 사용할 수 있습니다." });
  }
  return json(request, { ok: false, message: "지원하지 않는 요청입니다." }, 400);
}

function handleLoginStart() {
  const config = googleOauthConfig();
  if (!config.clientId || !config.clientSecret) return loginRedirect("not-configured");
  const state = signOauthState(primaryAgencyCode(), process.env, Date.now(), "login");
  const url = buildGoogleAuthUrl(state, process.env, LOGIN_SCOPE, "login");
  if (!url) return loginRedirect("not-configured");
  return new Response(null, {
    status: 302,
    headers: {
      location: url,
      "cache-control": "no-store",
      "set-cookie": oauthNonceCookie(oauthStateNonce(state)),
    },
  });
}

async function handleLinkCallback(request, ctx, state, code) {
  // Today the target is always the owner canary; keeping it in one object is
  // what lets a future revision derive it from the caller's session claims.
  const linkTarget = { role: "owner", code: primaryAgencyCode() };
  if (!safeEqual(cleanText(state.owner), linkTarget.code)) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "invalid-state" });
    return loginRedirect("invalid");
  }
  const exchanged = await exchangeOauthCode(code, process.env);
  if (!exchanged.ok) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "exchange-failed" });
    return loginRedirect("exchange-failed");
  }
  const profile = decodeGoogleIdToken(exchanged.data.id_token);
  if (!profile) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "no-identity" });
    return loginRedirect("no-identity");
  }
  const { identity, error } = await findLoginIdentity(ctx, profile.sub);
  if (error) return loginRedirect("lookup-failed");
  const boundElsewhere = identity
    && (cleanText(identity.role).toLowerCase() !== linkTarget.role
      || cleanText(identity.code).toLowerCase() !== linkTarget.code);
  if (boundElsewhere) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "already-linked" });
    return loginRedirect("already-linked");
  }
  if (!identity) {
    const target = await findLinkTargetIdentity(ctx, linkTarget);
    if (target.error) return loginRedirect("lookup-failed");
    // The target already points at another google account: move that one row
    // instead of clearing it first, so no window exists without a mapping.
    if (target.identity) {
      if (!await rebindLinkTargetIdentity(ctx, linkTarget, profile)) return loginRedirect("save-failed");
      await recordLoginAudit(ctx, "google_login_linked", { role: linkTarget.role });
      return loginRedirect("linked");
    }
  }
  const saved = await upsertLoginIdentity(ctx, {
    googleSub: profile.sub,
    googleEmail: profile.email,
    role: linkTarget.role,
    code: linkTarget.code,
  });
  if (!saved) return loginRedirect("save-failed");
  await recordLoginAudit(ctx, "google_login_linked", { role: linkTarget.role });
  return loginRedirect("linked");
}

async function handleLoginCallback(request, ctx, code) {
  const exchanged = await exchangeOauthCode(code, process.env);
  if (!exchanged.ok) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "exchange-failed" });
    return loginRedirect("exchange-failed");
  }
  const profile = decodeGoogleIdToken(exchanged.data.id_token);
  if (!profile) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "no-identity" });
    return loginRedirect("no-identity");
  }
  const { identity, error } = await findLoginIdentity(ctx, profile.sub);
  if (error) return loginRedirect("lookup-failed");
  if (!identity) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "unlinked" });
    return loginRedirect("unlinked");
  }
  const resolved = await resolveGoogleLoginAccess(identity, ctx, process.env);
  if (!resolved.ok) {
    if (resolved.reason === "lookup-failed") return loginRedirect("lookup-failed");
    await recordLoginAudit(ctx, "google_login_failed", { reason: resolved.reason });
    return loginRedirect(resolved.reason);
  }
  let token = "";
  try {
    token = sealSession(createSessionClaims(resolved.access, {
      ttlSeconds: sessionConfiguration(process.env).ttl,
    }));
  } catch (sealError) {
    return loginRedirect("session-unavailable");
  }
  await recordLoginAudit(ctx, "google_login_succeeded", { role: resolved.access.role });
  return loginRedirect("success", [sessionCookie(token)]);
}

async function handleOauthCallback(request, ctx) {
  const url = new URL(request.url);
  const code = cleanText(url.searchParams.get("code"));
  const rawState = url.searchParams.get("state");
  const state = verifyOauthState(rawState);

  if (!code) {
    const purpose = state?.p || unsignedStatePurpose(rawState);
    const login = purpose === "login" || purpose === "link";
    const cancelled = login && cleanText(url.searchParams.get("error")) === "access_denied";
    return purposeRedirect(purpose, cancelled ? "cancelled" : "invalid");
  }
  if (!state) return callbackRedirect("invalid");

  // The signed state alone only proves this server issued it; the cookie proves
  // the browser finishing the flow is the browser that started it.
  if (!nonceMatches(state.nonce, parseCookies(request)[OAUTH_NONCE_COOKIE])) {
    if (state.p === "login" || state.p === "link") {
      await recordLoginAudit(ctx, "google_login_failed", { reason: "nonce-mismatch" });
    }
    return purposeRedirect(state.p, "invalid");
  }

  if (state.p === "link") return handleLinkCallback(request, ctx, state, code);
  if (state.p === "login") return handleLoginCallback(request, ctx, code);
  if (!safeEqual(cleanText(state.owner), primaryAgencyCode())) return callbackRedirect("invalid");
  const exchanged = await exchangeOauthCode(code, process.env);
  if (!exchanged.ok) return callbackRedirect("exchange-failed");
  const refreshToken = cleanText(exchanged.data.refresh_token);
  const accessToken = cleanText(exchanged.data.access_token);
  if (!refreshToken || !accessToken) return callbackRedirect("no-refresh-token");
  const calendarResult = await googleFetch(accessToken, "POST", "/calendars", { summary: DEDICATED_CALENDAR_SUMMARY, timeZone: "Asia/Seoul" });
  if (!calendarResult.ok || !calendarResult.data?.id) return callbackRedirect("calendar-failed");
  let googleEmail = null;
  const profile = await googleFetch(accessToken, "GET", "/calendars/primary", null);
  if (profile.ok && profile.data?.id && String(profile.data.id).includes("@")) googleEmail = String(profile.data.id);
  const { error } = await ctx.supabaseAdmin
    .from("owner_google_integrations")
    .upsert({
      owner_agency_code: cleanText(state.owner),
      refresh_token: refreshToken,
      calendar_id: String(calendarResult.data.id),
      google_email: googleEmail,
      connected_at: new Date().toISOString(),
      sync_status: "ok",
      sync_error: null,
      last_sync_attempt_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_agency_code" });
  if (error) return callbackRedirect("save-failed");
  await ctx.supabaseAdmin.from("audit_logs").insert({
    actor_id: null,
    client_id: null,
    action: "google_calendar_connected",
    target_table: "owner_google_integrations",
    target_id: null,
    metadata: sanitizeAuditMetadata({ calendarSummary: DEDICATED_CALENDAR_SUMMARY }),
  }).then(() => {}, () => {});
  return callbackRedirect("connected");
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    const path = new URL(request.url).pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    if (path === OWNER_API_PATH) return handleOwnerApi(request, ctx);
    if (path === OWNER_LOGIN_API_PATH) return handleOwnerLoginApi(request, ctx);
    if (path === LOGIN_START_PATH && request.method === "GET") {
      if (!await consumeOauthRateLimit(ctx, request, "start")) return loginRedirect("busy");
      return handleLoginStart();
    }
    if (path === CALLBACK_PATH && request.method === "GET") {
      // Whatever the outcome, the browser binding is spent: a state is single use.
      const cleared = [clearedOauthNonceCookie()];
      if (!await consumeOauthRateLimit(ctx, request, "callback")) {
        return withCookies(loginRedirect("busy"), cleared);
      }
      return withCookies(await handleOauthCallback(request, ctx), cleared);
    }
    return json(request, { ok: false, message: "Not found" }, 404);
  }),
};

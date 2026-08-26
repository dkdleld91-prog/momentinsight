import { withSupabase } from "@supabase/server";
import crypto from "node:crypto";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import {
  createSessionClaims,
  parseCookies,
  sealSession,
  sessionCookie,
  sessionLifetimeSeconds,
} from "../code-session.mjs";
import {
  GOOGLE_TOKEN_URL,
  googleFetch,
  googleOauthConfig,
  loadOwnerGoogleIntegration,
  mapScheduleRowToGoogleEvent,
  refreshAccessToken,
} from "../google-calendar-client.mjs";
import { readBody } from "../http.mjs";
import { protectedJson, safeEqual } from "../security.mjs";
import { activeClientByCode, activeTeamByCode } from "./code-session-api.mjs";
import {
  MAX_CALENDAR_INVITES,
  createOwnerCalendar,
  deleteOwnerCalendarAcl,
  deleteRowFromGoogle,
  insertOwnerCalendarAcl,
  listOwnerCalendarAcl,
  listOwnerCalendarCatalog,
  listOwnerWritableCalendars,
  recordGoogleDeleteFailure,
  refreshOwnerCalendarCatalog,
  runOwnerCalendarSync,
  setOwnerCalendarVisibility,
  syncOwnerScheduleRows,
  writeRowToGoogleFirst,
} from "./google-calendar-sync.mjs";
import {
  activePersonalPrincipal,
  PERSONAL_GOOGLE_CALENDAR_PATH,
  PERSONAL_GOOGLE_LOGIN_PATH,
  PERSONAL_ROLES,
  personalPrincipalKey,
  resolvePersonalAccess,
} from "./personal-identity.mjs";

export {
  deleteRowFromGoogle,
  googleOauthConfig,
  listOwnerCalendarCatalog,
  listOwnerWritableCalendars,
  loadOwnerGoogleIntegration,
  mapScheduleRowToGoogleEvent,
  recordGoogleDeleteFailure,
  refreshOwnerCalendarCatalog,
  setOwnerCalendarVisibility,
  syncOwnerScheduleRows,
  writeRowToGoogleFirst,
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

// r(계정 역할)과 owner(코드)는 서버가 세션 클레임에서만 채운다. 요청 본문·쿼리·
// 브라우저 헤더에서 한 글자라도 받으면 아무나 남의 계정으로 서명된 state 를
// 받아 가 그 계정에 구글을 연동할 수 있다. 서명(클라이언트 시크릿 HMAC-SHA256)이
// 이 값들의 유일한 권위다 — 콜백에는 세션 쿠키가 오지 않기 때문이다.
export function signOauthState(ownerCode, env = process.env, now = Date.now(), purpose = "calendar", role = "owner", persist = false) {
  const config = googleOauthConfig(env);
  if (!config.clientSecret) return "";
  const payloadText = JSON.stringify({
    owner: cleanText(ownerCode).toLowerCase(),
    r: cleanText(role).toLowerCase() || "owner",
    p: cleanText(purpose) || "calendar",
    exp: now + STATE_TTL_MS,
    nonce: crypto.randomBytes(12).toString("base64url"),
    ...(persist === true ? { k: 1 } : {}),
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
    // r 이 없는 state 는 이 필드가 생기기 전에 발급된 것이다. 대표님으로 읽어야
    // 배포 순간에 구글 화면에 가 있던 흐름이 콜백에서 끊기지 않는다. 폴백을
    // 영구히 남겨도 비용이 없고, 모르는 역할은 여기서 끝낸다.
    payload.r = cleanText(payload.r).toLowerCase() || "owner";
    if (!PERSONAL_ROLES.has(payload.r)) return null;
    // 자동 로그인 표식은 서명된 1 만 인정한다. 없거나 다른 값이면 전부 비지속이다.
    payload.k = payload.k === 1 ? 1 : 0;
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

// 캘린더 생성·공유 계열의 실패 사유 하나를 HTTP 응답 하나로 옮긴다. 사유
// 문자열은 엔진이 정하고 문구는 여기서만 정한다 — 두 곳에 흩어지면 어긋난다.
function calendarActionFailure(request, result) {
  const reason = cleanText(result?.reason);
  if (reason === "env") {
    return json(request, { ok: false, code: "missing_google_env", message: "구글 연동 환경변수(GOOGLE_OAUTH_CLIENT_ID/SECRET)가 아직 설정되지 않았습니다." }, 503);
  }
  if (reason === "not-connected") {
    return json(request, { ok: false, message: "구글 캘린더가 아직 연결되지 않았습니다." }, 409);
  }
  if (reason === "needs_reconnect") {
    return json(request, { ok: false, code: "needs_reconnect", message: "구글 연결이 만료되었습니다. 구글 캘린더를 다시 연결해주세요." }, 502);
  }
  if (reason === "forbidden") {
    return json(request, { ok: false, message: "내 소유가 아닌 캘린더는 공유 설정을 바꿀 수 없습니다." }, 403);
  }
  // 아래는 전부 "요청이 틀렸다"(400)다. 사유를 한 단어씩 나눠 받는 이유가
  // 이것 하나뿐이다 — 인원 초과에 "이메일을 확인해주세요" 를 띄우면 대표님은
  // 멀쩡한 주소를 계속 고쳐 넣게 된다.
  const badRequest = {
    summary: "캘린더 이름을 입력해주세요(200자 이내).",
    invites: "참가자 목록 형식을 확인해주세요.",
    invites_max: `참가자는 한 번에 최대 ${MAX_CALENDAR_INVITES}명까지 초대할 수 있습니다.`,
    invite_email: "참가자 이메일 주소를 확인해주세요.",
    invite_role: "참가자 권한은 편집(writer) 또는 보기(reader)만 고를 수 있습니다.",
    calendar: "캘린더를 선택해주세요.",
    rule: "삭제할 참가자를 선택해주세요.",
    // rule_locked 는 403 이 아니라 400 이다. 권한이 모자란 것이 아니라 애초에
    // 말이 안 되는 요청이기 때문이다 — 목록이 editable:false 로 내보낸 규칙을
    // 지워 달라고 되돌려 온 것이라, 권한을 올려 준다고 되는 일이 아니다.
    rule_locked: "전체 공개·도메인 공유 규칙은 여기서 지울 수 없습니다. 구글 캘린더에서 직접 바꿔주세요.",
  };
  if (badRequest[reason]) return json(request, { ok: false, message: badRequest[reason] }, 400);
  return json(request, {
    ok: false,
    message: "구글 캘린더가 요청을 거절했습니다. 잠시 후 다시 시도해주세요.",
    detail: reason || null,
  }, 502);
}

// 대표실(/api/owner/google-calendar)과 개인 공간(/api/my/google-calendar)은
// 계정 키 하나만 다른 같은 액션 집합이다. 본문을 두 벌로 나눠 두면 문구·상태
// 코드·검증 순서가 한쪽에서만 고쳐지는 날이 반드시 오므로 여기 한 곳에만 둔다.
//
// account = {
//   key       : owner_agency_code 자리에 들어가는 계정 키(개인키)
//   code      : OAuth state 에 실을 코드(대표님은 mml93-a01, 나머지는 uuid)
//   role      : owner | team | client
//   canManage : 캘린더 생성·참가자 초대 허용 여부(설계 §7.3)
//   personal  : 동기화 엔진에 넘길 개인 좌표. 대표실 경로는 null 이다.
// }
async function calendarAccountApi(request, ctx, account) {
  const ownerCode = account.key;
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
      // 개인 경로만 계정 역할과 캘린더 관리 권한을 함께 알린다. 대표실 응답
      // 모양은 그대로 둬야 이미 그 모양에 맞춰진 화면이 흔들리지 않는다.
      ...(account.personal ? { role: account.role, canManageCalendars: account.canManage } : {}),
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
    // state 에는 개인키가 아니라 코드만 싣는다. 콜백이 (r, owner) 로 키를 다시
    // 조립하므로 서명 안에 접두사를 넣을 이유가 없다.
    const state = signOauthState(account.code, process.env, Date.now(), "calendar", account.role);
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
    // 사람이 "지금 동기화" 를 누른 경우에는 항상 full 로 돈다.
    //
    // 증분 목록은 syncToken 이후 "바뀐" 이벤트만 준다. 그래서 구글에서 색만
    // 지정해 둔(=updated 가 그대로인) 옛 일정은 증분으로는 영영 다시 오지 않고,
    // 하루 한 번 승격되는 full sync 때만 다시 훑린다. 색 백필이 배포되기 전에
    // 오늘치 full 이 이미 돌아버리면 대표님은 내일까지 기다려야 색이 채워진다.
    // 사람이 버튼을 누른 순간은 "지금 맞춰줘" 라는 뜻이므로 그 대기를 없앤다.
    // 자동·진입 동기화는 그대로 증분이고 기존 24시간 승격 규칙을 따른다.
    const result = await runOwnerCalendarSync(ctx, process.env, ownerCode, {
      ...(account.personal ? { personal: account.personal } : {}),
      ...(trigger === "manual" ? { mode: "full" } : {}),
    });
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
  if (action === "calendars") {
    const config = googleOauthConfig();
    if (!config.clientId || !config.clientSecret) {
      return json(request, { ok: false, code: "missing_google_env", message: "구글 연동 환경변수(GOOGLE_OAUTH_CLIENT_ID/SECRET)가 아직 설정되지 않았습니다." }, 503);
    }
    const loaded = await loadOwnerGoogleIntegration(ctx, ownerCode).catch(() => ({ integration: null, error: true }));
    if (loaded.error || !loaded.integration) {
      return json(request, { ok: false, message: "구글 캘린더가 아직 연결되지 않았습니다." }, 409);
    }
    // 목록 새로고침은 사용자가 명시적으로 눌렀을 때만 구글을 부른다.
    // 실패해도 캐시에 있는 만큼은 돌려준다.
    const token = await refreshAccessToken(loaded.integration.refresh_token, process.env);
    if (token.ok) await refreshOwnerCalendarCatalog(ctx, ownerCode, token.accessToken, {});
    const calendars = await listOwnerWritableCalendars(ctx, ownerCode, loaded.integration);
    return json(request, { ok: true, calendars, refreshed: token.ok });
  }
  // 사이드바용 전체 캘린더 목록. "calendars" 와 달리 읽기 전용 캘린더까지 담고
  // 색·표시 여부를 함께 돌려준다.
  if (action === "calendar-refresh") {
    const config = googleOauthConfig();
    if (!config.clientId || !config.clientSecret) {
      return json(request, { ok: false, code: "missing_google_env", message: "구글 연동 환경변수(GOOGLE_OAUTH_CLIENT_ID/SECRET)가 아직 설정되지 않았습니다." }, 503);
    }
    const loaded = await loadOwnerGoogleIntegration(ctx, ownerCode).catch(() => ({ integration: null, error: true }));
    if (loaded.error || !loaded.integration) {
      return json(request, { ok: false, message: "구글 캘린더가 아직 연결되지 않았습니다." }, 409);
    }
    const token = await refreshAccessToken(loaded.integration.refresh_token, process.env);
    if (token.ok) await refreshOwnerCalendarCatalog(ctx, ownerCode, token.accessToken, {});
    return json(request, {
      ok: true,
      refreshed: token.ok,
      calendars: await listOwnerCalendarCatalog(ctx, ownerCode, loaded.integration),
    });
  }
  // MI 안에서만 쓰는 표시 토글. 구글의 calendarList.selected 로는 절대 되쓰지
  // 않으므로 이 분기는 구글을 한 번도 부르지 않는다.
  if (action === "calendar-visibility") {
    const config = googleOauthConfig();
    if (!config.clientId || !config.clientSecret) {
      return json(request, { ok: false, code: "missing_google_env", message: "구글 연동 환경변수(GOOGLE_OAUTH_CLIENT_ID/SECRET)가 아직 설정되지 않았습니다." }, 503);
    }
    const rawCalendarId = cleanText(body.calendarId);
    if (!rawCalendarId || rawCalendarId.length > 1024) {
      return json(request, { ok: false, message: "캘린더를 선택해주세요." }, 400);
    }
    if (typeof body.visible !== "boolean") {
      return json(request, { ok: false, message: "표시 여부 값을 확인해주세요." }, 400);
    }
    const loaded = await loadOwnerGoogleIntegration(ctx, ownerCode).catch(() => ({ integration: null, error: true }));
    if (loaded.error || !loaded.integration) {
      return json(request, { ok: false, message: "구글 캘린더가 아직 연결되지 않았습니다." }, 409);
    }
    const saved = await setOwnerCalendarVisibility(ctx, ownerCode, rawCalendarId, body.visible);
    if (saved.reason === "not_found") {
      return json(request, { ok: false, message: "해당 캘린더를 찾을 수 없습니다. 목록을 새로고침해주세요." }, 404);
    }
    if (saved.reason === "unsupported") {
      return json(request, {
        ok: false,
        code: "calendar_catalog_missing",
        message: "캘린더 목록 확장이 아직 적용되지 않았습니다. 데이터베이스 마이그레이션을 적용해주세요.",
      }, 503);
    }
    if (!saved.ok) {
      return json(request, { ok: false, message: "캘린더 표시 설정을 저장하지 못했습니다." }, 500);
    }
    return json(request, { ok: true, calendars: await listOwnerCalendarCatalog(ctx, ownerCode, loaded.integration) });
  }
  // 캘린더 자체를 만들고 사람을 초대한다. 일정마다 참석자를 넣지 않고 공유하는
  // 방법이라, 여기서 만든 캘린더에 쌓은 일정은 초대받은 사람에게 자동으로 보인다.
  if (action === "calendar-create") {
    if (!account.canManage) return calendarManageDenied(request);
    const config = googleOauthConfig();
    if (!config.clientId || !config.clientSecret) {
      return json(request, { ok: false, code: "missing_google_env", message: "구글 연동 환경변수(GOOGLE_OAUTH_CLIENT_ID/SECRET)가 아직 설정되지 않았습니다." }, 503);
    }
    // 입력 검증은 여기서 하지 않고 엔진 한 곳에만 둔다. 두 곳에 흩어 두면
    // "화면은 통과시켰는데 엔진이 거절" 같은 어긋남이 생기고, 엔진은 어차피
    // 구글을 부르기 전에 전부 검사하므로 잘못된 입력은 왕복 없이 400 이 된다.
    const created = await createOwnerCalendar(ctx, process.env, ownerCode, {
      summary: body.summary,
      invites: body.invites,
    });
    if (!created.ok) return calendarActionFailure(request, created);
    // 사이드바가 한 응답만으로 다시 그릴 수 있도록 "calendar-refresh" 와 같은
    // 전체 카탈로그를 함께 실어 보낸다. 연동 행은 방금 엔진이 읽은 것을 재사용한다.
    return json(request, {
      ok: true,
      calendarId: created.calendarId,
      failedInvites: created.failedInvites || [],
      calendars: await listOwnerCalendarCatalog(ctx, ownerCode, created.integration || null),
    });
  }

  // 참가자(ACL) 조회·추가·삭제. 세 갈래 모두 마지막에 구글에서 다시 읽은
  // rules 로 답한다 — 화면이 "지금 누가 들어 있는지" 를 추측하지 않게 하려는
  // 것이다. 추가/삭제 응답만 보고 로컬 배열을 손보면 구글에서 동시에 일어난
  // 변화(다른 기기에서 뺀 사람)를 놓친다.
  if (action === "calendar-acl") {
    const config = googleOauthConfig();
    if (!config.clientId || !config.clientSecret) {
      return json(request, { ok: false, code: "missing_google_env", message: "구글 연동 환경변수(GOOGLE_OAUTH_CLIENT_ID/SECRET)가 아직 설정되지 않았습니다." }, 503);
    }
    // "calendar-visibility" 와 같은 방식으로 검사한다 — 자르지 않고 거절한다.
    const calendarId = cleanText(body.calendarId);
    if (!calendarId || calendarId.length > 1024) {
      return json(request, { ok: false, message: "캘린더를 선택해주세요." }, 400);
    }
    // op 를 기본값으로 채우지 않는다. 오타 난 op 가 조용히 목록 조회가 되면
    // 화면은 "지웠다" 고 믿는데 아무것도 안 지워진 상태가 된다.
    const op = cleanText(body.op, 20);
    if (op !== "list" && op !== "insert" && op !== "delete") {
      return json(request, { ok: false, message: "지원하지 않는 참가자 요청입니다." }, 400);
    }
    // 목록 조회는 모두에게 열려 있다 — 지금 누가 들어 있는지 보는 것까지 막으면
    // 광고주는 자기 캘린더가 어디까지 공유돼 있는지 확인할 길이 없다.
    if (op !== "list" && !account.canManage) return calendarManageDenied(request);
    let result = null;
    if (op === "list") {
      result = await listOwnerCalendarAcl(ctx, process.env, ownerCode, calendarId);
    } else if (op === "insert") {
      result = await insertOwnerCalendarAcl(ctx, process.env, ownerCode, calendarId, {
        email: body.email,
        role: body.role,
      });
    } else {
      result = await deleteOwnerCalendarAcl(ctx, process.env, ownerCode, calendarId, body.ruleId);
    }
    if (!result.ok) return calendarActionFailure(request, result);
    if (op === "list") return json(request, { ok: true, rules: result.rules || [] });
    // 액세스 토큰은 요청당 한 번만 발급된다. 방금 엔진이 발급한 것을 그대로
    // 넘겨야 다시 읽기가 refresh 를 한 번 더 하지 않는다.
    const relisted = await listOwnerCalendarAcl(ctx, process.env, ownerCode, calendarId, {
      accessToken: result.accessToken,
      integration: result.integration,
    });
    if (!relisted.ok) return calendarActionFailure(request, relisted);
    return json(request, { ok: true, rules: relisted.rules || [] });
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

// 캘린더를 새로 만들고 사람을 초대하는 길은 우리 OAuth 클라이언트로 임의 주소에
// 초대 메일이 나가는 경로다. 광고주가 그것을 필요로 한다는 근거가 없어 v1 정책은
// owner·team 만 연다(설계 §7.3). 화면에서 버튼을 감추는 것만으로는 부족하다 —
// 요청은 화면 없이도 만들 수 있으므로 서버에서 끊는다.
function calendarManageDenied(request) {
  return json(request, {
    ok: false,
    message: "광고주 계정은 캘린더 목록 조회와 표시 설정만 사용할 수 있습니다.",
  }, 403);
}

async function handleOwnerApi(request, ctx) {
  if (!ownerRequest(request)) {
    return json(request, { ok: false, message: "총관리자 전용 기능입니다." }, 403);
  }
  const ownerCode = primaryAgencyCode();
  return calendarAccountApi(request, ctx, {
    key: ownerCode,
    code: ownerCode,
    role: "owner",
    canManage: true,
    personal: null,
  });
}

// 계정은 오직 resolvePersonalAccess 가 정한다 — 세션이 심은 헤더에서만 나오고
// 운영 범위로 폴백하지 않는다. ownerRequest 는 여기서 쓰지 않는다(대표님 전용
// 관문이라 운영팀·광고주 개인 공간을 통째로 막아 버린다).
async function handlePersonalCalendarApi(request, ctx) {
  const access = await resolvePersonalAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  return calendarAccountApi(request, ctx, {
    key: access.personalKey,
    code: access.personalCode,
    role: access.personalRole,
    canManage: access.personalRole !== "client",
    personal: { role: access.personalRole, code: access.personalCode },
  });
}

// 돌아갈 화면은 이 고정 표에서만 고른다. URL 파라미터로 받는 순간 구글 콜백이
// 오픈 리다이렉트가 된다. 앵커는 대표실 비서 카드가 있는 대표님 화면에만 붙인다 —
// 운영팀 화면에는 그 요소가 없어서 없는 곳으로 스크롤하게 된다.
const ROLE_REDIRECTS = {
  owner: { base: "/admin", hash: "#mi-admin-owner-assistant" },
  team: { base: "/admin", hash: "" },
  client: { base: "/client", hash: "" },
};

function roleRedirect(role) {
  return ROLE_REDIRECTS[cleanText(role).toLowerCase()] || ROLE_REDIRECTS.owner;
}

function callbackRedirect(message, role = "owner") {
  const destination = roleRedirect(role);
  const target = `${destination.base}?gcal=${encodeURIComponent(message)}${destination.hash}`;
  return new Response(null, { status: 302, headers: { location: target, "cache-control": "no-store" } });
}

function loginRedirect(message, cookies = [], role = "owner") {
  const headers = new Headers({
    location: `${roleRedirect(role).base}?glogin=${encodeURIComponent(message)}`,
    "cache-control": "no-store",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function purposeRedirect(purpose, message, role = "owner") {
  return purpose === "login" || purpose === "link"
    ? loginRedirect(message, [], role)
    : callbackRedirect(message, role);
}

// 구글 로그인 연결은 (role, 로그인코드) 한 쌍에 붙는다. 캘린더 쪽 개인키와는
// 다른 코드 공간이라는 점이 중요하다 — 캘린더는 계정 수명을 따라가는 uuid 를
// 쓰고(설계 §3.2), 로그인은 사람이 입력해 온 코드(team_code / agency_code /
// mml93-a01)를 쓴다. 두 값을 뒤바꾸면 login_identities 가 아무와도 맞지 않는다.
async function loginAccountApi(request, ctx, account) {
  const ownerCode = account.code;
  if (request.method === "GET") {
    const config = googleOauthConfig();
    let identity = null;
    let storageReady = true;
    try {
      const { data, error } = await ctx.supabaseAdmin
        .from("login_identities")
        .select("google_email, linked_at")
        .eq("role", account.role)
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
    const state = signOauthState(ownerCode, process.env, Date.now(), "link", account.role);
    const url = buildGoogleAuthUrl(state, process.env, LOGIN_SCOPE, "link");
    if (!url) return json(request, { ok: false, message: "구글 인증 주소를 만들지 못했습니다." }, 500);
    return withCookies(json(request, { ok: true, url }), [oauthNonceCookie(oauthStateNonce(state))]);
  }
  if (action === "unlink") {
    const { error } = await ctx.supabaseAdmin
      .from("login_identities")
      .delete()
      .eq("role", account.role)
      .eq("code", ownerCode);
    if (error) return json(request, { ok: false, message: "구글 로그인 연결 해제에 실패했습니다.", detail: error.message }, 500);
    await recordLoginAudit(ctx, "google_login_unlinked", { role: account.role });
    return json(request, { ok: true, message: "구글 로그인 연결을 해제했습니다. 기존 코드 로그인은 그대로 사용할 수 있습니다." });
  }
  return json(request, { ok: false, message: "지원하지 않는 요청입니다." }, 400);
}

async function handleOwnerLoginApi(request, ctx) {
  if (!ownerRequest(request)) {
    return json(request, { ok: false, message: "총관리자 전용 기능입니다." }, 403);
  }
  return loginAccountApi(request, ctx, { role: "owner", code: primaryAgencyCode() });
}

// 개인키(personalKey)가 아니라 loginCode 를 넘긴다. login_identities.code 는
// 사람이 입력하는 로그인 코드 공간이라 uuid 를 넣으면 아무 행과도 맞지 않는다.
async function handlePersonalLoginApi(request, ctx) {
  const access = await resolvePersonalAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  return loginAccountApi(request, ctx, { role: access.personalRole, code: access.loginCode });
}

function handleLoginStart(request) {
  const config = googleOauthConfig();
  if (!config.clientId || !config.clientSecret) return loginRedirect("not-configured");
  // 자동 로그인 선택은 쿼리 한 글자로만 들어오고, 이 서버가 서명한 state 안에서만 살아남는다.
  const persist = cleanText(new URL(request.url).searchParams.get("persist")) === "1";
  const state = signOauthState(primaryAgencyCode(), process.env, Date.now(), "login", "owner", persist);
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

// 콜백에는 세션 쿠키가 오지 않는다(구글이 크로스사이트 최상위 이동으로 부른다).
// 그래서 state 를 발급한 뒤 10분 안에 계정이 해지·연결 해제됐을 수 있는데,
// 여기서 다시 확인하지 않으면 이미 끊긴 운영팀·광고주가 그 창 안에서 구글 로그인
// 연결을 완성해 버린다. 코드도 재발급 대상이라 "그 코드가 지금 살아 있는가" 는
// 서명이 대신 답해 주지 못한다.
async function activeLinkTarget(ctx, linkTarget) {
  if (linkTarget.role === "owner") {
    return safeEqual(linkTarget.code, primaryAgencyCode()) ? { ok: true } : { ok: false, reason: "invalid" };
  }
  if (linkTarget.role === "team") {
    const { data, error } = await activeTeamByCode(ctx, linkTarget.code);
    if (error) return { ok: false, reason: "lookup-failed" };
    // ilike 조회라 대소문자만 다른 코드도 걸린다. 서명된 코드와 실제 행이
    // 같은 문자열인지 다시 맞춰야 엉뚱한 팀에 연결이 붙지 않는다.
    if (!data || cleanText(data.team_code).toLowerCase() !== linkTarget.code) {
      return { ok: false, reason: "inactive" };
    }
    return { ok: true };
  }
  const { data, error } = await activeClientByCode(ctx, linkTarget.code);
  if (error) return { ok: false, reason: "lookup-failed" };
  if (!data) return { ok: false, reason: "inactive" };
  return { ok: true };
}

async function handleLinkCallback(request, ctx, state, code) {
  // 연결 대상은 서명된 state 에서만 나온다. 본문·쿼리에서 받으면 남의 계정에
  // 자기 구글을 붙일 수 있으므로 여기서는 state 외의 입력을 보지 않는다.
  const linkTarget = { role: state.r || "owner", code: cleanText(state.owner).toLowerCase() };
  const target = await activeLinkTarget(ctx, linkTarget);
  if (!target.ok) {
    if (target.reason === "lookup-failed") return loginRedirect("lookup-failed", [], linkTarget.role);
    if (target.reason === "inactive") {
      await recordLoginAudit(ctx, "google_login_failed", { reason: "inactive", role: linkTarget.role });
      return loginRedirect("inactive", [], linkTarget.role);
    }
    await recordLoginAudit(ctx, "google_login_failed", { reason: "invalid-state" });
    return loginRedirect("invalid", [], linkTarget.role);
  }
  const exchanged = await exchangeOauthCode(code, process.env);
  if (!exchanged.ok) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "exchange-failed" });
    return loginRedirect("exchange-failed", [], linkTarget.role);
  }
  const profile = decodeGoogleIdToken(exchanged.data.id_token);
  if (!profile) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "no-identity" });
    return loginRedirect("no-identity", [], linkTarget.role);
  }
  const { identity, error } = await findLoginIdentity(ctx, profile.sub);
  if (error) return loginRedirect("lookup-failed", [], linkTarget.role);
  const boundElsewhere = identity
    && (cleanText(identity.role).toLowerCase() !== linkTarget.role
      || cleanText(identity.code).toLowerCase() !== linkTarget.code);
  if (boundElsewhere) {
    await recordLoginAudit(ctx, "google_login_failed", { reason: "already-linked" });
    return loginRedirect("already-linked", [], linkTarget.role);
  }
  if (!identity) {
    const bound = await findLinkTargetIdentity(ctx, linkTarget);
    if (bound.error) return loginRedirect("lookup-failed", [], linkTarget.role);
    // The target already points at another google account: move that one row
    // instead of clearing it first, so no window exists without a mapping.
    if (bound.identity) {
      if (!await rebindLinkTargetIdentity(ctx, linkTarget, profile)) {
        return loginRedirect("save-failed", [], linkTarget.role);
      }
      await recordLoginAudit(ctx, "google_login_linked", { role: linkTarget.role });
      return loginRedirect("linked", [], linkTarget.role);
    }
  }
  const saved = await upsertLoginIdentity(ctx, {
    googleSub: profile.sub,
    googleEmail: profile.email,
    role: linkTarget.role,
    code: linkTarget.code,
  });
  if (!saved) return loginRedirect("save-failed", [], linkTarget.role);
  await recordLoginAudit(ctx, "google_login_linked", { role: linkTarget.role });
  return loginRedirect("linked", [], linkTarget.role);
}

async function handleLoginCallback(request, ctx, code, state) {
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
  const persist = state?.k === 1;
  const lifetime = sessionLifetimeSeconds(persist);
  let token = "";
  try {
    token = sealSession(createSessionClaims(resolved.access, { ttlSeconds: lifetime, persist }));
  } catch (sealError) {
    return loginRedirect("session-unavailable");
  }
  await recordLoginAudit(ctx, "google_login_succeeded", { role: resolved.access.role });
  // 로그인 목적의 state 는 시작 시점에 누가 누를지 모르므로 owner 로 서명된다.
  // 목적지는 그 state 가 아니라 방금 확정된 계정 역할이 정한다 — 그러지 않으면
  // 구글로 로그인한 광고주가 자기 화면이 아닌 /admin 으로 떨어진다.
  return loginRedirect("success", [sessionCookie(token, process.env, { maxAge: lifetime })], resolved.access.role);
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
    // 검증되지 않은 state 에서는 역할을 읽지 않는다. 목적(purpose)은 어느 쿼리
    // 키로 돌려보낼지만 정하지만 역할은 목적지 자체를 바꾸므로, 서명이 확인된
    // state 가 없으면 기본 목적지(/admin)로 간다.
    return purposeRedirect(purpose, cancelled ? "cancelled" : "invalid", state?.r);
  }
  if (!state) return callbackRedirect("invalid");

  // The signed state alone only proves this server issued it; the cookie proves
  // the browser finishing the flow is the browser that started it.
  if (!nonceMatches(state.nonce, parseCookies(request)[OAUTH_NONCE_COOKIE])) {
    if (state.p === "login" || state.p === "link") {
      await recordLoginAudit(ctx, "google_login_failed", { reason: "nonce-mismatch" });
    }
    return purposeRedirect(state.p, "invalid", state.r);
  }

  if (state.p === "link") return handleLinkCallback(request, ctx, state, code);
  if (state.p === "login") return handleLoginCallback(request, ctx, code, state);
  // 연동 대상 계정은 서명된 (r, owner) 로만 복원한다. 그리고 state 가 살아 있는
  // 10분 사이에 해지·연결 해제된 계정이 연동을 완성하지 못하도록 지금도 활성인지
  // 다시 확인한다 — 콜백에는 세션이 없어 이 확인이 유일한 최신 검사다.
  const accountKey = personalPrincipalKey(state.r, state.owner);
  if (!accountKey) return callbackRedirect("invalid", state.r);
  const principal = await activePersonalPrincipal(ctx, accountKey);
  if (!principal.ok) {
    return callbackRedirect(principal.reason === "lookup-failed" ? "lookup-failed" : "invalid", state.r);
  }
  const exchanged = await exchangeOauthCode(code, process.env);
  if (!exchanged.ok) return callbackRedirect("exchange-failed", state.r);
  const refreshToken = cleanText(exchanged.data.refresh_token);
  const accessToken = cleanText(exchanged.data.access_token);
  if (!refreshToken || !accessToken) return callbackRedirect("no-refresh-token", state.r);
  // 전용 "모먼트 인사이트" 캘린더는 더 이상 만들지 않는다. 대표님은 내 캘린더
  // 아래에 기본 캘린더 하나만 두기를 원하시고, 전용 캘린더를 만들면 그 즉시
  // 사이드바가 둘로 갈라진다. calendar_id 를 null 로 저장해 두면 MI 는 대표님의
  // 기본 캘린더에 쓴다(google-calendar-sync 의 기본 캘린더 폴백).
  // 이미 전용 캘린더를 들고 있는 기존 연동은 동기화 실행이 회수한다.
  let googleEmail = null;
  const profile = await googleFetch(accessToken, "GET", "/calendars/primary", null);
  if (profile.ok && profile.data?.id && String(profile.data.id).includes("@")) googleEmail = String(profile.data.id);
  const { error } = await ctx.supabaseAdmin
    .from("owner_google_integrations")
    .upsert({
      owner_agency_code: accountKey,
      refresh_token: refreshToken,
      calendar_id: null,
      google_email: googleEmail,
      connected_at: new Date().toISOString(),
      sync_status: "ok",
      sync_error: null,
      last_sync_attempt_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_agency_code" });
  if (error) return callbackRedirect("save-failed", state.r);
  await ctx.supabaseAdmin.from("audit_logs").insert({
    actor_id: null,
    client_id: null,
    action: "google_calendar_connected",
    target_table: "owner_google_integrations",
    target_id: null,
    // 전용 캘린더를 만들지 않았으므로 만들었다고 주장하지 않는다.
    metadata: sanitizeAuditMetadata({ dedicatedCalendar: false, target: "primary" }),
  }).then(() => {}, () => {});

  // 연동 해제는 owner_google_integrations 행을 지우고, FK 의 on delete cascade 가
  // owner_google_calendar_sync(캘린더 목록 · 색 · 표시 여부 · 동기화 토큰)까지
  // 함께 지운다. 그래서 재연결 직후에는 카탈로그가 비어 사이드바가 통째로
  // 사라지고(has-gcal-rail 이 false) 일정 칩 색이 전부 빠진다. 다음 동기화가
  // 돌기 전까지 대표님 화면이 그 상태로 남는 것이 이번 회귀다.
  //
  // 그래서 방금 받은 액세스 토큰으로 목록만 즉시 다시 채운다 — calendarList
  // 한 번이라 리다이렉트를 붙잡는 시간이 사실상 없다.
  //
  // 일정 본문까지 당기는 full sync 는 여기서 하지 않는다. 그쪽은 캘린더 수만큼
  // 페이지를 넘기며 기본 예산이 20초라, 리다이렉트를 그만큼 붙잡으면 대표님은
  // 흰 화면을 보게 된다. 화면이 살아나는 데 필요한 것은 목록(이름·색·표시 여부)
  // 뿐이고 일정은 진입 자동 동기화가 곧바로 이어 채운다.
  const catalog = await refreshOwnerCalendarCatalog(ctx, accountKey, accessToken)
    .catch((unexpected) => ({ ok: false, reason: "threw" }));
  // 목록 갱신 실패가 연결 자체를 무르게 하지는 않는다. 연결은 이미 저장됐고
  // 다음 동기화가 같은 일을 다시 한다 — 다만 조용히 지나가지 않도록 남긴다.
  if (!catalog?.ok) {
    await ctx.supabaseAdmin.from("audit_logs").insert({
      actor_id: null,
      client_id: null,
      action: "google_calendar_catalog_refresh_failed",
      target_table: "owner_google_calendar_sync",
      target_id: null,
      metadata: sanitizeAuditMetadata({ stage: "connect", reason: cleanText(catalog?.reason, 60) || "unknown" }),
    }).then(() => {}, () => {});
  }
  return callbackRedirect("connected", state.r);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    const path = new URL(request.url).pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    if (path === OWNER_API_PATH) return handleOwnerApi(request, ctx);
    if (path === OWNER_LOGIN_API_PATH) return handleOwnerLoginApi(request, ctx);
    if (path === PERSONAL_GOOGLE_CALENDAR_PATH) return handlePersonalCalendarApi(request, ctx);
    if (path === PERSONAL_GOOGLE_LOGIN_PATH) return handlePersonalLoginApi(request, ctx);
    if (path === LOGIN_START_PATH && request.method === "GET") {
      if (!await consumeOauthRateLimit(ctx, request, "start")) return loginRedirect("busy");
      return handleLoginStart(request);
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

import { withSupabase } from "@supabase/server";
import crypto from "node:crypto";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { seoulDateKey } from "../calendar-domain.mjs";
import { createSessionClaims, sealSession, sessionCookie } from "../code-session.mjs";
import { readBody } from "../http.mjs";
import { protectedJson, safeEqual } from "../security.mjs";

const OWNER_API_PATH = "/api/owner/google-calendar";
const OWNER_LOGIN_API_PATH = "/api/owner/google-login";
const LOGIN_START_PATH = "/api/google-login/start";
const CALLBACK_PATH = "/api/google-oauth/callback";
const LOGIN_SCOPE = "openid email";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar";
const DEDICATED_CALENDAR_SUMMARY = "모먼트 인사이트";
const STATE_TTL_MS = 10 * 60 * 1000;

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

export function googleOauthConfig(env = process.env) {
  return {
    clientId: cleanText(env.GOOGLE_OAUTH_CLIENT_ID),
    clientSecret: cleanText(env.GOOGLE_OAUTH_CLIENT_SECRET),
    redirectUrl: cleanText(env.MI_GOOGLE_OAUTH_REDIRECT || "https://insight.momentlabs.co.kr/api/google-oauth/callback"),
  };
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

export function buildGoogleAuthUrl(state, env = process.env, scope = GOOGLE_SCOPE) {
  const config = googleOauthConfig(env);
  if (!config.clientId || !state) return "";
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUrl,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export function mapScheduleRowToGoogleEvent(row = {}) {
  const summary = cleanText(row.title, 200) || "모먼트 인사이트 일정";
  const startsAt = cleanText(row.starts_at);
  if (!startsAt) return null;
  const event = {
    summary: row.status === "done" ? `✓ ${summary}` : summary,
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

async function googleFetch(accessToken, method, path, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${GOOGLE_CALENDAR_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return { ok: true, status: 204, data: null };
  let data = null;
  try { data = await response.json(); } catch (error) { data = null; }
  return { ok: response.ok, status: response.status, data };
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

async function refreshAccessToken(refreshToken, env, fetchImpl = fetch) {
  const config = googleOauthConfig(env);
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }).toString(),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) return "";
  return String(data.access_token);
}

export async function loadOwnerGoogleIntegration(ctx, ownerCode) {
  const { data, error } = await ctx.supabaseAdmin
    .from("owner_google_integrations")
    .select("owner_agency_code, refresh_token, calendar_id, google_email, connected_at")
    .eq("owner_agency_code", cleanText(ownerCode).toLowerCase())
    .maybeSingle();
  if (error) return { integration: null, error };
  return { integration: data || null, error: null };
}

function personalOwnerRows(access, rows) {
  if (!access || access.role !== "owner" || access.client || access.team) return [];
  return (Array.isArray(rows) ? rows : []).filter((row) => row
    && !row.client_id && !row.operation_team_id && !row.calendar_id);
}

export async function syncOwnerScheduleRows(ctx, env, access, rows, mode, fetchImpl = fetch) {
  try {
    const targets = personalOwnerRows(access, rows);
    if (!targets.length) return { skipped: true, reason: "scope" };
    const config = googleOauthConfig(env);
    if (!config.clientId || !config.clientSecret) return { skipped: true, reason: "env" };
    const { integration, error } = await loadOwnerGoogleIntegration(ctx, access.ownerAgencyCode || primaryAgencyCode(env));
    if (error || !integration) return { skipped: true, reason: "not-connected" };
    const accessToken = await refreshAccessToken(integration.refresh_token, env, fetchImpl);
    if (!accessToken) return { skipped: false, synced: 0, failed: targets.length, reason: "token" };
    const calendarPath = `/calendars/${encodeURIComponent(integration.calendar_id)}/events`;
    const results = await Promise.all(targets.map(async (row) => {
      try {
        if (mode === "delete") {
          if (!row.google_event_id) return { ok: true, skipped: true };
          const result = await googleFetch(accessToken, "DELETE", `${calendarPath}/${encodeURIComponent(row.google_event_id)}`, null, fetchImpl);
          return { ok: result.ok || result.status === 404 || result.status === 410, row };
        }
        const event = mapScheduleRowToGoogleEvent(row);
        if (!event) return { ok: false, row };
        if (row.google_event_id) {
          const result = await googleFetch(accessToken, "PATCH", `${calendarPath}/${encodeURIComponent(row.google_event_id)}`, event, fetchImpl);
          if (result.ok) return { ok: true, row };
          if (result.status !== 404 && result.status !== 410) return { ok: false, row };
        }
        const created = await googleFetch(accessToken, "POST", calendarPath, event, fetchImpl);
        if (!created.ok || !created.data?.id) return { ok: false, row };
        await ctx.supabaseAdmin
          .from("schedule_items")
          .update({ google_event_id: String(created.data.id) })
          .eq("id", row.id);
        return { ok: true, row };
      } catch (rowError) {
        return { ok: false, row };
      }
    }));
    const failed = results.filter((result) => !result.ok).length;
    if (failed > 0) {
      await ctx.supabaseAdmin.from("audit_logs").insert({
        actor_id: null,
        client_id: null,
        action: "google_calendar_sync_failed",
        target_table: "schedule_items",
        target_id: targets[0]?.id || null,
        metadata: sanitizeAuditMetadata({ mode, failed, total: targets.length }),
      }).then(() => {}, () => {});
    }
    return { skipped: false, synced: results.length - failed, failed };
  } catch (error) {
    return { skipped: false, synced: 0, failed: Array.isArray(rows) ? rows.length : 0, reason: "unexpected" };
  }
}

export function decodeGoogleIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sub = cleanText(payload.sub, 128);
    if (!sub) return null;
    return { sub, email: cleanText(payload.email, 256).toLowerCase() || null };
  } catch (error) {
    return null;
  }
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
    const { integration, error } = await loadOwnerGoogleIntegration(ctx, ownerCode);
    if (error) return json(request, { ok: false, message: "구글 연동 상태를 확인하지 못했습니다.", detail: error.message }, 500);
    return json(request, {
      ok: true,
      configured: Boolean(config.clientId && config.clientSecret),
      connected: Boolean(integration),
      googleEmail: integration?.google_email || null,
      connectedAt: integration?.connected_at || null,
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
    return json(request, { ok: true, url });
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

async function handleOwnerLoginApi(request, ctx) {
  if (!ownerRequest(request)) {
    return json(request, { ok: false, message: "총관리자 전용 기능입니다." }, 403);
  }
  const ownerCode = primaryAgencyCode();
  if (request.method === "GET") {
    const config = googleOauthConfig();
    const { data, error } = await ctx.supabaseAdmin
      .from("login_identities")
      .select("google_email, linked_at")
      .eq("role", "owner")
      .eq("code", ownerCode)
      .maybeSingle();
    if (error) return json(request, { ok: false, message: "구글 로그인 연결 상태를 확인하지 못했습니다.", detail: error.message }, 500);
    return json(request, {
      ok: true,
      configured: Boolean(config.clientId && config.clientSecret),
      linked: Boolean(data),
      googleEmail: data?.google_email || null,
      linkedAt: data?.linked_at || null,
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
    const url = buildGoogleAuthUrl(signOauthState(ownerCode, process.env, Date.now(), "link"), process.env, LOGIN_SCOPE);
    if (!url) return json(request, { ok: false, message: "구글 인증 주소를 만들지 못했습니다." }, 500);
    return json(request, { ok: true, url });
  }
  if (action === "unlink") {
    const { error } = await ctx.supabaseAdmin
      .from("login_identities")
      .delete()
      .eq("role", "owner")
      .eq("code", ownerCode);
    if (error) return json(request, { ok: false, message: "구글 로그인 연결 해제에 실패했습니다.", detail: error.message }, 500);
    return json(request, { ok: true, message: "구글 로그인 연결을 해제했습니다. 기존 코드 로그인은 그대로 사용할 수 있습니다." });
  }
  return json(request, { ok: false, message: "지원하지 않는 요청입니다." }, 400);
}

function handleLoginStart() {
  const config = googleOauthConfig();
  if (!config.clientId || !config.clientSecret) return loginRedirect("not-configured");
  const url = buildGoogleAuthUrl(signOauthState(primaryAgencyCode(), process.env, Date.now(), "login"), process.env, LOGIN_SCOPE);
  if (!url) return loginRedirect("not-configured");
  return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
}

async function handleLinkCallback(request, ctx, state, code) {
  if (!safeEqual(cleanText(state.owner), primaryAgencyCode())) return loginRedirect("invalid");
  const exchanged = await exchangeOauthCode(code, process.env);
  if (!exchanged.ok) return loginRedirect("exchange-failed");
  const profile = decodeGoogleIdToken(exchanged.data.id_token);
  if (!profile) return loginRedirect("no-identity");
  const saved = await upsertLoginIdentity(ctx, {
    googleSub: profile.sub,
    googleEmail: profile.email,
    role: "owner",
    code: state.owner,
  });
  if (!saved) return loginRedirect("save-failed");
  await ctx.supabaseAdmin.from("audit_logs").insert({
    actor_id: null,
    client_id: null,
    action: "google_login_linked",
    target_table: "login_identities",
    target_id: null,
    metadata: sanitizeAuditMetadata({ role: "owner" }),
  }).then(() => {}, () => {});
  return loginRedirect("linked");
}

async function handleLoginCallback(request, ctx, code) {
  const exchanged = await exchangeOauthCode(code, process.env);
  if (!exchanged.ok) return loginRedirect("exchange-failed");
  const profile = decodeGoogleIdToken(exchanged.data.id_token);
  if (!profile) return loginRedirect("no-identity");
  const { identity, error } = await findLoginIdentity(ctx, profile.sub);
  if (error) return loginRedirect("lookup-failed");
  if (!identity) return loginRedirect("unlinked");
  if (identity.role !== "owner" || !safeEqual(cleanText(identity.code), primaryAgencyCode())) {
    return loginRedirect("not-ready");
  }
  let token = "";
  try {
    token = sealSession(createSessionClaims({ role: "owner", agencyCode: primaryAgencyCode() }));
  } catch (sealError) {
    return loginRedirect("session-unavailable");
  }
  await ctx.supabaseAdmin.from("audit_logs").insert({
    actor_id: null,
    client_id: null,
    action: "google_login_succeeded",
    target_table: "login_identities",
    target_id: null,
    metadata: sanitizeAuditMetadata({ role: "owner" }),
  }).then(() => {}, () => {});
  return loginRedirect("success", [sessionCookie(token)]);
}

async function handleOauthCallback(request, ctx) {
  const url = new URL(request.url);
  const code = cleanText(url.searchParams.get("code"));
  const state = verifyOauthState(url.searchParams.get("state"));
  if (!code || !state) return callbackRedirect("invalid");
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
    if (path === LOGIN_START_PATH && request.method === "GET") return handleLoginStart();
    if (path === CALLBACK_PATH && request.method === "GET") return handleOauthCallback(request, ctx);
    return json(request, { ok: false, message: "Not found" }, 404);
  }),
};

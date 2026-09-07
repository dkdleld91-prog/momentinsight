// 오늘 현황(대표 지시 2026-09-07): 공개 페이지 방문·가입 클릭·문의 클릭·로그인 계정을 우리 표(site_events)에 세어
// 총관리자 화면 "오늘 현황" 카드에 보여 준다. 구글 애널리틱스(GA4)는 그대로 두고, 화면에 바로 뜨는 숫자만 여기서 만든다.
//
// 경로: POST /api/site-event  { event: view | signup_click | inquiry_click, path: "/..." }  — 세션·CSRF 없이 열리고,
//       무엇을 보내든 204 로 끝난다(통계는 화면 동작에 영향을 주지 않는다). 로봇 UA·이상한 경로는 조용히 버린다.
// 개인 식별 정보는 저장하지 않는다: visitor = sha256(세션 비밀 + 날짜 + IP + 브라우저) 앞 32자. 로그인은 (역할 + 코드) 해시.
// 집계: siteSummary(ctx) → 오늘·어제 {visitors, views, signupClicks, inquiryClicks, logins, trialSignups}.
import { createHash } from "node:crypto";
import { withSupabase } from "@supabase/server";
import { corsHeaders, protectedJson } from "../security.mjs";

export const SITE_EVENTS = new Set(["view", "signup_click", "inquiry_click", "login"]);
export const SITE_EVENT_BODY_LIMIT = 2000;
const BOT_USER_AGENT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor|uptime|curl|wget|python-requests|go-http-client|httpclient/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export function kstDay(nowMs = Date.now()) {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

export function visitorHash(parts, env = process.env) {
  return createHash("sha256").update([String(env.MI_SESSION_SECRET || ""), ...parts.map((part) => String(part || ""))].join("|")).digest("hex").slice(0, 32);
}

export function loginVisitor(role, code, env = process.env) {
  return visitorHash(["login", String(role || "").toLowerCase(), String(code || "").trim().toLowerCase()], env);
}

export function clientIp(request) {
  const forwarded = String(request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return forwarded || String(request.headers.get("x-real-ip") || "").trim();
}

// 경로는 pathname 만, 영숫자·/·_·-·. 만, 120자 이내. 쿼리·해시·앞뒤 공백은 버린다.
export function normalizeSitePath(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/")) return "";
  const path = raw.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  return /^[a-zA-Z0-9/_\-.]{1,120}$/.test(path) ? path : "";
}

export function isBotUserAgent(userAgent) {
  const value = String(userAgent || "");
  return !value || BOT_USER_AGENT.test(value);
}

export async function recordSiteEvent(ctx, { event, path, visitor, nowMs = Date.now() }) {
  if (!SITE_EVENTS.has(event) || !visitor) return { ok: false, skipped: "invalid" };
  try {
    const result = await ctx.supabaseAdmin.rpc("mi_site_event_record", {
      p_day: kstDay(nowMs),
      p_event: event,
      p_path: normalizeSitePath(path) || "/",
      p_visitor: String(visitor),
    });
    if (result && result.error) return { ok: false, error: String(result.error.message || result.error) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

// 로그인 성공 뒤 호출. 로그인 응답을 늦추지 않도록 짧게만 기다린다(집계는 놓쳐도 로그인은 그대로).
export async function recordLoginEvent(ctx, { role, code, nowMs = Date.now(), waitMs = 1000, env = process.env }) {
  const visitor = loginVisitor(role, code, env);
  if (!String(code || "").trim()) return { ok: false, skipped: "no-code" };
  const work = recordSiteEvent(ctx, { event: "login", path: `/${String(role || "unknown").toLowerCase()}`, visitor, nowMs });
  return Promise.race([work, new Promise((resolve) => setTimeout(() => resolve({ ok: false, skipped: "timeout" }), waitMs))]);
}

function isMissingSchema(error) {
  const text = String(error?.message || error || "");
  return /mi_site_event|site_events|schema cache|does not exist|PGRST202/i.test(text);
}

function emptyDay() {
  return { visitors: 0, views: 0, signupClicks: 0, inquiryClicks: 0, logins: 0, trialSignups: 0 };
}

async function summaryForDay(ctx, day) {
  const result = await ctx.supabaseAdmin.rpc("mi_site_event_summary", { p_day: day });
  if (result.error) throw result.error;
  const data = result.data && typeof result.data === "object" ? result.data : {};
  return {
    visitors: Number(data.visitors || 0),
    views: Number(data.views || 0),
    signupClicks: Number(data.signup_clicks || 0),
    inquiryClicks: Number(data.inquiry_clicks || 0),
    logins: Number(data.logins || 0),
    trialSignups: 0,
  };
}

// 체험 가입 = login_identities(role trial) 중 그 날(KST) 연결된 계정 수.
async function trialSignupsForDay(ctx, day) {
  const start = new Date(`${day}T00:00:00+09:00`).toISOString();
  const end = new Date(new Date(`${day}T00:00:00+09:00`).getTime() + DAY_MS).toISOString();
  const result = await ctx.supabaseAdmin
    .from("login_identities")
    .select("google_sub", { count: "exact", head: true })
    .eq("role", "trial")
    .gte("linked_at", start)
    .lt("linked_at", end);
  if (result.error) return null;
  return Number(result.count || 0);
}

export async function siteSummary(ctx, { nowMs = Date.now(), prune = true } = {}) {
  const today = kstDay(nowMs);
  const yesterday = kstDay(nowMs - DAY_MS);
  try {
    const [todaySummary, yesterdaySummary] = await Promise.all([summaryForDay(ctx, today), summaryForDay(ctx, yesterday)]);
    const [todayTrials, yesterdayTrials] = await Promise.all([trialSignupsForDay(ctx, today), trialSignupsForDay(ctx, yesterday)]);
    todaySummary.trialSignups = todayTrials === null ? null : todayTrials;
    yesterdaySummary.trialSignups = yesterdayTrials === null ? null : yesterdayTrials;
    if (prune) {
      try { await ctx.supabaseAdmin.rpc("mi_site_event_prune", { p_keep_days: 120 }); } catch (error) { /* 정리는 실패해도 요약은 준다 */ }
    }
    return { ok: true, pending: false, day: today, today: todaySummary, yesterday: { ...yesterdaySummary, day: yesterday } };
  } catch (error) {
    if (isMissingSchema(error)) {
      return { ok: true, pending: true, day: today, today: emptyDay(), yesterday: { ...emptyDay(), day: yesterday }, message: "집계 표가 아직 없습니다. 마이그레이션 20260907213000_site_events.sql 을 실행해주세요." };
    }
    return { ok: false, pending: false, day: today, message: "오늘 현황을 불러오지 못했습니다.", detail: String(error?.message || error) };
  }
}

function noContent(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request, { methods: "POST, OPTIONS", headers: "content-type" }) });
}

export async function handleSiteEventRequest(request, ctx, { nowMs = Date.now(), env = process.env } = {}) {
  if (request.method === "OPTIONS") return noContent(request);
  if (request.method !== "POST") return protectedJson(request, { ok: false, message: "Method not allowed" }, 405);
  try {
    const text = await request.text();
    if (!text || text.length > SITE_EVENT_BODY_LIMIT) return noContent(request);
    const body = JSON.parse(text);
    const event = String(body?.event || "");
    const path = normalizeSitePath(body?.path);
    const userAgent = request.headers.get("user-agent") || "";
    if (!SITE_EVENTS.has(event) || event === "login" || !path || isBotUserAgent(userAgent)) return noContent(request);
    const visitor = visitorHash([kstDay(nowMs), clientIp(request), userAgent], env);
    await recordSiteEvent(ctx, { event, path, visitor, nowMs });
  } catch (error) {
    // 통계 실패는 화면에 알리지 않는다.
  }
  return noContent(request);
}

export default {
  fetch: withSupabase({ auth: "none" }, (request, ctx) => handleSiteEventRequest(request, ctx)),
};

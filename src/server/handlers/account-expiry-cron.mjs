// 이용 기간 만료 + 유예(5일)가 지난 광고주 계정을 매일 한 번 정리한다.
// 대표 결정 2026-09-07: "만료 뒤 5일 안에 연장 없으면 해당 계정 데이터 삭제 — 살릴 필요 없음, 서버·저장공간만 무거워짐".
// 순위 추적 표(naver_rank_trackers · naver_place_rank_trackers, 스냅샷은 FK cascade)까지 지운다. 순위 수집 코드·워커는
// 건드리지 않고 행만 지우며, 총관리자 코드는 어떤 경우에도 대상이 아니다. 삭제 전에 감사 로그를 남긴다.
// 호출: Vercel cron(vercel.json) → GET /api/account-expiry-cron (Authorization: Bearer CRON_SECRET).
// 확인용: ?dryRun=1 은 대상만 보여 주고 지우지 않는다. 환경변수 MI_ACCOUNT_EXPIRY_DELETE_DISABLED=true 면 항상 dryRun.
import { withSupabase } from "@supabase/server";
import { cronAuthorized } from "../cron-auth.mjs";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { corsHeaders, protectedJson } from "../security.mjs";
import { primaryAgencyConfiguration } from "../owner-identity.mjs";
import { PLAN_GRACE_DAYS, planStatus } from "../account-plan.mjs";

export const EXPIRY_DELETE_BATCH = 20;
export const RANK_TRACKER_TABLES = ["naver_rank_trackers", "naver_place_rank_trackers"];
const DAY_MS = 24 * 60 * 60 * 1000;

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "authorization, content-type",
  });
}

export function deletionDisabled(env = process.env) {
  return String(env.MI_ACCOUNT_EXPIRY_DELETE_DISABLED || "").trim().toLowerCase() === "true";
}

// 만료 시각 + 유예를 넘긴 광고주만. 총관리자 코드는 제외하고, 최종 판정은 planStatus(delete_due)로 한 번 더 한다.
export async function selectDeleteDueClients(ctx, nowMs = Date.now(), limit = EXPIRY_DELETE_BATCH, env = process.env) {
  const cutoff = new Date(nowMs - PLAN_GRACE_DAYS * DAY_MS).toISOString();
  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, plan_name, plan_expires_at")
    .not("plan_expires_at", "is", null)
    .lt("plan_expires_at", cutoff)
    .order("plan_expires_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  const owner = String(primaryAgencyConfiguration(env).effective || "").toLowerCase();
  return (data || []).filter((row) => {
    const code = String(row.agency_code || "").trim().toLowerCase();
    if (!code || code === owner) return false;
    return planStatus(row, nowMs).state === "delete_due";
  });
}

// 한 계정의 데이터를 지운다. 부분 실패면 계정 행은 남겨 다음 날 다시 시도한다(중간 상태로 접속이 살아나지는 않는다 —
// 게이트가 delete_due 를 읽기 전용으로 막는다).
export async function deleteExpiredClient(ctx, client) {
  const code = String(client?.agency_code || "").trim().toLowerCase();
  const summary = { agencyCode: code, trackers: {}, notes: null, identities: null, quota: null, client: false, errors: [] };
  const fail = (step, error) => summary.errors.push(`${step}: ${String(error?.message || error)}`);
  if (!code || !client?.id) {
    fail("client", "missing agency code or id");
    return summary;
  }

  for (const table of RANK_TRACKER_TABLES) {
    const result = await ctx.supabaseAdmin.from(table).delete().eq("agency_code", code).select("id");
    if (result.error) fail(table, result.error);
    else summary.trackers[table] = (result.data || []).length;
  }

  const notes = await ctx.supabaseAdmin.from("keyword_research_notes").delete().eq("agency_code", code).select("id");
  if (notes.error) fail("keyword_research_notes", notes.error);
  else summary.notes = (notes.data || []).length;

  const identities = await ctx.supabaseAdmin.from("login_identities").delete().eq("role", "client").eq("code", code).select("google_sub");
  if (identities.error) fail("login_identities", identities.error);
  else {
    summary.identities = (identities.data || []).length;
    const subs = (identities.data || []).map((row) => row.google_sub).filter(Boolean);
    if (subs.length) {
      const quota = await ctx.supabaseAdmin.from("trial_keyword_quota").delete().in("google_sub", subs).select("google_sub");
      if (quota.error) fail("trial_keyword_quota", quota.error);
      else summary.quota = (quota.data || []).length;
    } else {
      summary.quota = 0;
    }
  }

  if (summary.errors.length) return summary;

  // 광고주 행을 지우면 brands·reports·kpi 등 client_id FK 는 cascade, 운영팀 연결(client_id)은 set null 로 정리된다.
  const removed = await ctx.supabaseAdmin.from("clients").delete().eq("id", client.id).select("id");
  if (removed.error) fail("clients", removed.error);
  else summary.client = (removed.data || []).length === 1;

  await ctx.supabaseAdmin.from("audit_logs").insert({
    actor_id: null,
    client_id: null,
    action: "client.deleted_after_grace",
    target_table: "clients",
    target_id: client.id,
    metadata: sanitizeAuditMetadata({
      source: "account-expiry-cron",
      agencyCode: code,
      name: client.name || "",
      planName: client.plan_name || "",
      expiresAt: client.plan_expires_at || "",
      graceDays: String(PLAN_GRACE_DAYS),
      trackers: summary.trackers,
      notes: summary.notes,
      identities: summary.identities,
      quota: summary.quota,
      clientDeleted: summary.client,
      errors: summary.errors,
    }),
  });
  return summary;
}

export async function runAccountExpiry(ctx, { nowMs = Date.now(), dryRun = false, env = process.env } = {}) {
  const due = await selectDeleteDueClients(ctx, nowMs, EXPIRY_DELETE_BATCH, env);
  const disabled = deletionDisabled(env);
  const effectiveDryRun = dryRun || disabled;
  const results = [];
  if (!effectiveDryRun) {
    for (const client of due) results.push(await deleteExpiredClient(ctx, client));
  }
  return {
    ok: true,
    dryRun: effectiveDryRun,
    disabled,
    graceDays: PLAN_GRACE_DAYS,
    checkedAt: new Date(nowMs).toISOString(),
    due: due.map((row) => ({ agencyCode: row.agency_code, name: row.name || "", expiresAt: row.plan_expires_at || null })),
    deleted: results.filter((result) => result.client).map((result) => result.agencyCode),
    failed: results.filter((result) => result.errors.length).map((result) => ({ agencyCode: result.agencyCode, errors: result.errors })),
    results,
  };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, { methods: "GET, POST, OPTIONS", headers: "authorization, content-type" }),
      });
    }
    if (!["GET", "POST"].includes(request.method)) {
      return json(request, { ok: false, message: "Method not allowed" }, 405);
    }
    if (!cronAuthorized(request)) {
      return json(request, { ok: false, message: "Unauthorized cron request" }, 401);
    }
    try {
      const url = new URL(request.url);
      const summary = await runAccountExpiry(ctx, { dryRun: url.searchParams.get("dryRun") === "1" });
      return json(request, summary);
    } catch (error) {
      return json(request, {
        ok: false,
        code: "ACCOUNT_EXPIRY_FAILED",
        message: "만료 계정 정리 중 오류가 발생했습니다.",
        detail: String(error?.message || error),
      }, 500);
    }
  }),
};

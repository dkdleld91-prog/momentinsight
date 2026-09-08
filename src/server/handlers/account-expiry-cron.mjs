// 이용 기간 만료 + 유예(일반 5일 · 구글 미연동 자동 만료는 3일)가 지난 광고주 계정을 매일 한 번 정리한다.
// 대표 결정 2026-09-07: "만료 뒤 5일 안에 연장 없으면 해당 계정 데이터 삭제 — 살릴 필요 없음, 서버·저장공간만 무거워짐".
// 대표 결정 2026-09-08: "구글 연동 안 된 사람은 읽기 전용에서 3일 뒤 삭제, 연동한 사람은 기한 뒤부터 30일 카운팅".
// 순위 추적 표(naver_rank_trackers · naver_place_rank_trackers, 스냅샷은 FK cascade)까지 지운다. 순위 수집 코드·워커는
// 건드리지 않고 행만 지우며, 총관리자 코드는 어떤 경우에도 대상이 아니다. 삭제 전에 감사 로그를 남긴다.
// 호출: Vercel cron(vercel.json) → GET /api/account-expiry-cron (Authorization: Bearer CRON_SECRET).
// 확인용: ?dryRun=1 은 대상만 보여 주고 지우지 않는다. 환경변수 MI_ACCOUNT_EXPIRY_DELETE_DISABLED=true 면 항상 dryRun.
import { withSupabase } from "@supabase/server";
import { cronAuthorized } from "../cron-auth.mjs";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { corsHeaders, protectedJson } from "../security.mjs";
import { primaryAgencyConfiguration } from "../owner-identity.mjs";
import {
  GOOGLE_LINKED_PLAN_NOTE,
  GOOGLE_LINK_EXPIRY_NOTE,
  GOOGLE_LINK_GRACE_DAYS,
  GOOGLE_LINK_PLAN_DAYS,
  PLAN_GRACE_DAYS,
  googleLinkDeadlineIso,
  googleLinkPlanExpiryIso,
  normalizePlanName,
  planGraceDays,
  planStatus,
} from "../account-plan.mjs";

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

// 만료 시각 + 유예를 넘긴 광고주만. 유예는 행마다 다르므로(구글 미연동 3일 · 일반 5일) 조회는 짧은 유예 기준으로 넓게 잡고,
// 총관리자 코드는 제외하고, 최종 판정은 planStatus(delete_due, plan_note 로 유예 결정)로 한 번 더 한다.
export async function selectDeleteDueClients(ctx, nowMs = Date.now(), limit = EXPIRY_DELETE_BATCH, env = process.env) {
  const cutoff = new Date(nowMs - Math.min(PLAN_GRACE_DAYS, GOOGLE_LINK_GRACE_DAYS) * DAY_MS).toISOString();
  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, plan_name, plan_expires_at, plan_note")
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
      graceDays: String(planGraceDays(client)),
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

// 구글 연동 기한(GOOGLE_LINK_DEADLINE, 대표 지시 2026-09-08)이 지나면, 구글을 연결하지 않은 활성 광고주 코드 계정에 만료일(=기한)을
// 찍는다. 이후는 기존 흐름: 만료 팝업·읽기 전용 → 유예 3일(plan_note 로 판정) → 위 삭제. 총관리자 코드와 이미 그 전에 만료된 계정은
// 건드리지 않는다. 연결 여부 = login_identities(role client) 에 그 코드가 있는지. dryRun 이면 대상만 보고한다.
export async function expireUnlinkedClients(ctx, { nowMs = Date.now(), dryRun = false, env = process.env } = {}) {
  const deadline = googleLinkDeadlineIso();
  const deadlineMs = Date.parse(String(deadline || ""));
  if (!Number.isFinite(deadlineMs) || nowMs < deadlineMs) return { active: false, deadline, marked: [], failed: [] };
  const clients = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, plan_expires_at, plan_note")
    .eq("status", "active");
  if (clients.error) throw clients.error;
  const identities = await ctx.supabaseAdmin.from("login_identities").select("code").eq("role", "client");
  if (identities.error) throw identities.error;
  const linked = new Set((identities.data || []).map((row) => String(row.code || "").trim().toLowerCase()).filter(Boolean));
  const owner = String(primaryAgencyConfiguration(env).effective || "").toLowerCase();
  const marked = [];
  const failed = [];
  for (const row of clients.data || []) {
    const code = String(row.agency_code || "").trim().toLowerCase();
    if (!code || code === owner || linked.has(code)) continue;
    const currentMs = Date.parse(String(row.plan_expires_at || ""));
    if (Number.isFinite(currentMs) && currentMs <= deadlineMs) continue; // 이미 기한 전에 만료된 계정은 그대로
    if (dryRun) {
      marked.push({ agencyCode: code, name: row.name || "", dryRun: true });
      continue;
    }
    const update = await ctx.supabaseAdmin
      .from("clients")
      .update({ plan_expires_at: deadline, plan_note: GOOGLE_LINK_EXPIRY_NOTE, plan_updated_at: new Date(nowMs).toISOString() })
      .eq("id", row.id)
      .select("id");
    if (update.error) {
      failed.push({ agencyCode: code, error: String(update.error.message || update.error) });
      continue;
    }
    try {
      await ctx.supabaseAdmin.from("audit_logs").insert({
        actor_id: null,
        client_id: row.id,
        action: "client.expired_unlinked",
        target_table: "clients",
        target_id: row.id,
        metadata: sanitizeAuditMetadata({ source: "account-expiry-cron", agencyCode: code, deadline }),
      });
    } catch (error) {
      // 감사 기록 실패는 만료 처리 결과를 바꾸지 않는다
    }
    marked.push({ agencyCode: code, name: row.name || "" });
  }
  return { active: true, deadline, marked, failed };
}

// 연동한 계정(대표 결정 2026-09-08 "구글 연동한 사람은 지금부터 30일이 지난 후부터 30일 카운팅"): 기한이 지나면 구글을 연결한 활성 광고주 중
// 무기한(plan_expires_at null) 계정에 기한 다음 날부터 30일 이용 기간을 찍는다(2026-10-07 기준 10/08 ~ 11/06). 이후는 일반 플랜 흐름
// (D-3 팝업 → 만료 → 유예 5일 → 삭제). 제외: 총관리자 코드, 이미 이용 기간이 있는 계정(총관리자가 정한 기간 유지), 기한 뒤 총관리자가
// 손댄 계정(plan_updated_at ≥ 기한 — 일부러 무기한으로 돌린 경우), 체험 계정(clients 행이 없다). 한 번 찍히면 만료일이 생겨 다시 대상이
// 되지 않는다. dryRun 이면 대상만 보고한다.
export async function startLinkedClientPlans(ctx, { nowMs = Date.now(), dryRun = false, env = process.env } = {}) {
  const deadline = googleLinkDeadlineIso();
  const deadlineMs = Date.parse(String(deadline || ""));
  const expiresAt = googleLinkPlanExpiryIso();
  if (!Number.isFinite(deadlineMs) || nowMs < deadlineMs || !expiresAt) return { active: false, deadline, expiresAt, started: [], failed: [] };
  const clients = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, plan_name, plan_expires_at, plan_updated_at")
    .eq("status", "active");
  if (clients.error) throw clients.error;
  const identities = await ctx.supabaseAdmin.from("login_identities").select("code").eq("role", "client");
  if (identities.error) throw identities.error;
  const linked = new Set((identities.data || []).map((row) => String(row.code || "").trim().toLowerCase()).filter(Boolean));
  const owner = String(primaryAgencyConfiguration(env).effective || "").toLowerCase();
  const started = [];
  const failed = [];
  for (const row of clients.data || []) {
    const code = String(row.agency_code || "").trim().toLowerCase();
    if (!code || code === owner || !linked.has(code)) continue;
    if (Number.isFinite(Date.parse(String(row.plan_expires_at || "")))) continue; // 이미 이용 기간이 있는 계정은 그대로
    const touchedMs = Date.parse(String(row.plan_updated_at || ""));
    if (Number.isFinite(touchedMs) && touchedMs >= deadlineMs) continue; // 기한 뒤 총관리자가 손댄 계정(예: 일부러 무기한)
    if (dryRun) {
      started.push({ agencyCode: code, name: row.name || "", expiresAt, dryRun: true });
      continue;
    }
    const update = await ctx.supabaseAdmin
      .from("clients")
      .update({
        plan_name: normalizePlanName(row.plan_name) || "basic",
        plan_days: GOOGLE_LINK_PLAN_DAYS,
        plan_started_at: deadline,
        plan_expires_at: expiresAt,
        plan_note: GOOGLE_LINKED_PLAN_NOTE,
        plan_updated_at: new Date(nowMs).toISOString(),
      })
      .eq("id", row.id)
      .select("id");
    if (update.error) {
      failed.push({ agencyCode: code, error: String(update.error.message || update.error) });
      continue;
    }
    try {
      await ctx.supabaseAdmin.from("audit_logs").insert({
        actor_id: null,
        client_id: row.id,
        action: "client.plan_started_linked",
        target_table: "clients",
        target_id: row.id,
        metadata: sanitizeAuditMetadata({ source: "account-expiry-cron", agencyCode: code, deadline, expiresAt, planDays: String(GOOGLE_LINK_PLAN_DAYS) }),
      });
    } catch (error) {
      // 감사 기록 실패는 이용 기간 시작 결과를 바꾸지 않는다
    }
    started.push({ agencyCode: code, name: row.name || "", expiresAt });
  }
  return { active: true, deadline, expiresAt, started, failed };
}

// 운영팀 코드도 포함(대표 지시 2026-09-08 "운영팀도 포함"): 운영팀은 플랜(이용 기간) 열이 없어 유예 표시가 없으므로, 기한 + 유예 3일이
// 지난 날(미연동 광고주 삭제와 같은 날) 구글을 연결하지 않은 활성 운영팀 코드를 해제(status revoked)한다. 총관리자가 직접 해제할 때와 달리
// 연결된 광고주는 일시중지하지 않는다(광고주는 광고주 규칙으로 따로 판정). 연결 여부 = login_identities(role team).
export async function revokeUnlinkedTeams(ctx, { nowMs = Date.now(), dryRun = false, env = process.env } = {}) {
  const deadline = googleLinkDeadlineIso();
  const deadlineMs = Date.parse(String(deadline || ""));
  const revokeFromMs = Number.isFinite(deadlineMs) ? deadlineMs + GOOGLE_LINK_GRACE_DAYS * DAY_MS : NaN;
  if (!Number.isFinite(revokeFromMs) || nowMs < revokeFromMs) return { active: false, revokeFrom: Number.isFinite(revokeFromMs) ? new Date(revokeFromMs).toISOString() : null, revoked: [], failed: [] };
  const teams = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, team_name, team_code, status, client_id")
    .eq("status", "active");
  if (teams.error) throw teams.error;
  const identities = await ctx.supabaseAdmin.from("login_identities").select("code").eq("role", "team");
  if (identities.error) throw identities.error;
  const linked = new Set((identities.data || []).map((row) => String(row.code || "").trim().toLowerCase()).filter(Boolean));
  const nowIso = new Date(nowMs).toISOString();
  const revoked = [];
  const failed = [];
  for (const row of teams.data || []) {
    const code = String(row.team_code || "").trim().toLowerCase();
    if (!code || linked.has(code)) continue;
    if (dryRun) {
      revoked.push({ teamCode: code, name: row.team_name || "", dryRun: true });
      continue;
    }
    const update = await ctx.supabaseAdmin
      .from("operation_team_codes")
      .update({ status: "revoked", revoked_at: nowIso, client_id: null })
      .eq("id", row.id)
      .select("id");
    if (update.error) {
      failed.push({ teamCode: code, error: String(update.error.message || update.error) });
      continue;
    }
    try {
      await ctx.supabaseAdmin.from("audit_logs").insert({
        actor_id: null,
        client_id: null,
        action: "operation_team.revoked_unlinked",
        target_table: "operation_team_codes",
        target_id: row.id,
        metadata: sanitizeAuditMetadata({ source: "account-expiry-cron", teamCode: code, deadline }),
      });
    } catch (error) {
      // 감사 기록 실패는 해제 결과를 바꾸지 않는다
    }
    revoked.push({ teamCode: code, name: row.team_name || "" });
  }
  return { active: true, revokeFrom: new Date(revokeFromMs).toISOString(), revoked, failed };
}

export async function runAccountExpiry(ctx, { nowMs = Date.now(), dryRun = false, env = process.env } = {}) {
  const disabled = deletionDisabled(env);
  const effectiveDryRun = dryRun || disabled;
  const unlinked = await expireUnlinkedClients(ctx, { nowMs, dryRun: effectiveDryRun, env });
  const linkedPlans = await startLinkedClientPlans(ctx, { nowMs, dryRun: effectiveDryRun, env });
  const unlinkedTeams = await revokeUnlinkedTeams(ctx, { nowMs, dryRun: effectiveDryRun, env });
  const due = await selectDeleteDueClients(ctx, nowMs, EXPIRY_DELETE_BATCH, env);
  const results = [];
  if (!effectiveDryRun) {
    for (const client of due) results.push(await deleteExpiredClient(ctx, client));
  }
  return {
    ok: true,
    dryRun: effectiveDryRun,
    disabled,
    graceDays: PLAN_GRACE_DAYS,
    googleLinkGraceDays: GOOGLE_LINK_GRACE_DAYS,
    googleLinkPlanDays: GOOGLE_LINK_PLAN_DAYS,
    googleLinkDeadline: unlinked.deadline,
    unlinkedExpired: unlinked.marked,
    unlinkedFailed: unlinked.failed,
    linkedPlanExpiresAt: linkedPlans.expiresAt,
    linkedPlanStarted: linkedPlans.started,
    linkedPlanFailed: linkedPlans.failed,
    unlinkedTeamsRevokeFrom: unlinkedTeams.revokeFrom,
    unlinkedTeamsRevoked: unlinkedTeams.revoked,
    unlinkedTeamsFailed: unlinkedTeams.failed,
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

// 이용 기간 만료 + 유예(일반 5일 · 구글 미연동 자동 만료는 3일)가 지난 광고주 계정을 매일 한 번 정리한다.
// 대표 결정 2026-09-07: "만료 뒤 5일 안에 연장 없으면 해당 계정 데이터 삭제 — 살릴 필요 없음, 서버·저장공간만 무거워짐".
// 대표 결정 2026-09-08: "구글 연동 안 된 사람은 읽기 전용에서 3일 뒤 삭제, 연동한 사람은 기한 뒤부터 30일 카운팅".
// 순위 추적 표(naver_rank_trackers · naver_place_rank_trackers, 스냅샷은 FK cascade)와 그 광고주의 서비스 일정·구글 연결
// ('client:<id>' 키, 점검 2026-11-02 F02), 보고서 파일 실물(Storage, 대표 결정 2026-11-03)까지 지운다. 순위 수집 코드·워커는 건드리지
// 않고 행만 지우며, 총관리자 코드는 어떤 경우에도 대상이 아니다. 삭제(또는 부분 실패·건너뜀) 뒤 감사 로그를 남긴다.
// 호출: Vercel cron(vercel.json) → GET /api/account-expiry-cron (Authorization: Bearer CRON_SECRET).
// 확인용: ?dryRun=1 은 대상만 보여 주고 지우지 않는다. 환경변수 MI_ACCOUNT_EXPIRY_DELETE_DISABLED=true 면 항상 dryRun.
import { withSupabase } from "@supabase/server";
import { cronAuthorized } from "../cron-auth.mjs";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { corsHeaders, protectedJson } from "../security.mjs";
import { PRIMARY_AGENCY_CODE, isReservedOwnerAgencyCode, primaryAgencyConfiguration } from "../owner-identity.mjs";
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
// 감사 로그는 1년 보관 뒤, 체험 계정은 마지막 이용(로그인·키워드 조회) 뒤 1년 동안 쓰지 않으면 지운다
// (대표 결정 2026-11-04, 개인정보처리방침 v1.1 제3조). 체험 정리는 한 번에 최대 EXPIRY_DELETE_BATCH 개.
export const AUDIT_LOG_KEEP_DAYS = 365;
export const TRIAL_INACTIVE_DAYS = 365;
// 보고서 파일 실물(report-center.mjs 업로드 경로: moment-reports/clients/<id>/<sources|reports>/<YYYY-MM>/<파일>).
export const REPORT_BUCKET = "moment-reports";
const STORAGE_LIST_LIMIT = 1000;
const STORAGE_MAX_DEPTH = 4;
const STORAGE_MAX_OBJECTS = 5000;
const STORAGE_REMOVE_BATCH = 100;

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "authorization, content-type",
  });
}

export function deletionDisabled(env = process.env) {
  return String(env.MI_ACCOUNT_EXPIRY_DELETE_DISABLED || "").trim().toLowerCase() === "true";
}

// 총관리자 코드는 어떤 경우에도 만료·삭제 대상이 아니다. 환경변수(MI_PRIMARY_AGENCY_CODE)가 빠져 effective 가 비어도 상수로 막는다
// (clients 표에 총관리자 코드 행이 실제로 있다 — 2026-09-08 백업본 확인).
function protectedOwnerCode(env = process.env) {
  return String(primaryAgencyConfiguration(env).effective || PRIMARY_AGENCY_CODE).toLowerCase();
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
  const owner = protectedOwnerCode(env);
  return (data || []).filter((row) => {
    const code = String(row.agency_code || "").trim().toLowerCase();
    if (!code || code === owner) return false;
    return planStatus(row, nowMs).state === "delete_due";
  });
}

// 광고주 개인 공간 키(personal-identity.mjs 키 스킴): 'client:' || clients.id(uuid). 일정·구글 연결은 외래키가 아니라
// 이 글자 키로 묶여 있어 광고주 행을 지워도 cascade 되지 않는다(점검 2026-11-02 F02). uuid 형식일 때만 키를 만든다 —
// 대표 키(콜론 없는 코드)·운영팀 키('team:')에는 절대 닿지 않는다.
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function clientPrincipalKey(clientId) {
  const id = String(clientId ?? "").trim().toLowerCase();
  return CLIENT_ID_PATTERN.test(id) ? `client:${id}` : "";
}

// 감사 기록 실패는 삭제 결과를 바꾸지 않지만 응답(auditFailed)에 드러낸다(supabase-js 는 오류를 throw 하지 않고 {error}로 준다).
// 광고주 전용 경로 아래 파일을 폴더째 훑는다(Storage list 는 한 단계씩만 돌려준다 — 폴더는 id 가 null).
// 깊이·개수에 상한을 두고 넘으면 오류로 멈춘다(조용히 일부만 지우지 않는다).
async function listClientReportObjects(ctx, prefix) {
  const storage = ctx.supabaseAdmin.storage.from(REPORT_BUCKET);
  const objects = [];
  const folders = [{ path: prefix, depth: 0 }];
  while (folders.length) {
    const folder = folders.shift();
    for (let offset = 0; ; offset += STORAGE_LIST_LIMIT) {
      const { data, error } = await storage.list(folder.path, { limit: STORAGE_LIST_LIMIT, offset });
      if (error) throw error;
      const entries = data || [];
      for (const entry of entries) {
        const name = String(entry?.name || "");
        if (!name || name.includes("/") || name === "." || name === "..") continue;
        const path = `${folder.path}/${name}`;
        if (entry.id == null) {
          if (folder.depth + 1 > STORAGE_MAX_DEPTH) throw new Error(`report folder too deep: ${path}`);
          folders.push({ path, depth: folder.depth + 1 });
        } else {
          objects.push(path);
          if (objects.length > STORAGE_MAX_OBJECTS) throw new Error(`more than ${STORAGE_MAX_OBJECTS} report files`);
        }
      }
      if (entries.length < STORAGE_LIST_LIMIT) break;
    }
  }
  return objects;
}

// 경로가 그 광고주 폴더 안인지: 접두어가 같고, 조각마다 비어 있거나 '.'·'..' 가 아니어야 한다(파일 이름 안의 '..' 는 허용 — report..final.pdf).
function insideClientFolder(path, prefix) {
  if (!path.startsWith(`${prefix}/`)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

// 보고서 파일 실물을 지운다. files 행은 광고주 행을 지울 때 FK cascade 로 사라지지만 Storage 실물은 남아, 화면에서 다시 찾을 수도
// 지울 수도 없게 된다(대표 결정 2026-11-03 "삭제 때 보고서 파일 실물도 지움"). 그 광고주 전용 경로(clients/<uuid>/) 안만 지운다 —
// 다른 광고주·공용 자료(moment-assets)·경로 밖을 가리키는 files 행에는 닿지 않는다. files 행이 가리키는 실물도 같은 조건으로 함께 지운다.
// withFileRows=false: 광고주 행을 지운 뒤라 files 행이 이미 cascade 로 없어 폴더만 훑는다.
async function removeClientReportObjects(ctx, clientId, { withFileRows = true } = {}) {
  const prefix = `clients/${clientId}`;
  let linked = [];
  if (withFileRows) {
    const files = await ctx.supabaseAdmin.from("files").select("storage_bucket, storage_path").eq("client_id", clientId);
    if (files.error) throw files.error;
    linked = (files.data || [])
      .filter((row) => row.storage_bucket === REPORT_BUCKET)
      .map((row) => String(row.storage_path || ""));
  }
  const listed = await listClientReportObjects(ctx, prefix);
  const paths = [...new Set([...listed, ...linked])].filter((path) => insideClientFolder(path, prefix));
  let removed = 0;
  for (let index = 0; index < paths.length; index += STORAGE_REMOVE_BATCH) {
    const { data, error } = await ctx.supabaseAdmin.storage.from(REPORT_BUCKET).remove(paths.slice(index, index + STORAGE_REMOVE_BATCH));
    if (error) {
      // 앞 묶음에서 이미 지운 수도 감사 기록에 남도록 오류에 붙여 넘긴다.
      const failure = new Error(String(error?.message || error));
      failure.removed = removed;
      throw failure;
    }
    removed += (data || []).length;
  }
  return removed;
}

async function auditDeletion(ctx, client, action, summary) {
  const { error } = await ctx.supabaseAdmin.from("audit_logs").insert({
    actor_id: null,
    client_id: null,
    action,
    target_table: "clients",
    target_id: client.id,
    metadata: sanitizeAuditMetadata({
      source: "account-expiry-cron",
      agencyCode: summary.agencyCode,
      name: client.name || "",
      planName: client.plan_name || "",
      expiresAt: client.plan_expires_at || "",
      graceDays: String(planGraceDays(client)),
      skipped: summary.skipped,
      google: summary.google,
      googleSync: summary.googleSync,
      schedules: summary.schedules,
      memberships: summary.memberships,
      storageObjects: summary.storageObjects,
      trackers: summary.trackers,
      notes: summary.notes,
      identities: summary.identities,
      quota: summary.quota,
      clientDeleted: summary.client,
      errors: summary.errors,
    }),
  });
  summary.auditLogged = !error;
}

// 한 계정의 데이터를 지운다. 부분 실패면 계정 행은 남겨 다음 날 다시 시도하고, 지운 만큼을 감사 기록에 남긴다(중간 상태로 접속이
// 살아나지는 않는다 — 게이트가 delete_due 를 읽기 전용으로 막는다).
// 지우기 직전에 계정 행을 다시 읽어 아직 삭제 대상인지 확인하고, 광고주 행 삭제에도 만료 조건을 붙인다 — 대상을 고른 뒤 총관리자가
// 연장한 계정은 지우지 않는다(점검 2026-11-02 N3).
export async function deleteExpiredClient(ctx, client, { nowMs = Date.now(), env = process.env } = {}) {
  const code = String(client?.agency_code || "").trim().toLowerCase();
  const summary = {
    agencyCode: code,
    skipped: "",
    google: null,
    googleSync: null,
    schedules: null,
    memberships: null,
    storageObjects: null,
    trackers: {},
    notes: null,
    identities: null,
    quota: null,
    client: false,
    auditLogged: null,
    errors: [],
  };
  const fail = (step, error) => summary.errors.push(`${step}: ${String(error?.message || error)}`);
  if (!code || !client?.id) {
    fail("client", "missing agency code or id");
    return summary;
  }
  const clientId = String(client.id).trim().toLowerCase();
  const principalKey = clientPrincipalKey(clientId);
  if (!principalKey) {
    fail("client", "id is not a uuid");
    return summary;
  }

  const fresh = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, plan_name, plan_expires_at, plan_note")
    .eq("id", client.id)
    .limit(1);
  if (fresh.error) {
    fail("clients recheck", fresh.error);
    return summary;
  }
  const current = (fresh.data || [])[0];
  if (!current) {
    summary.skipped = "missing";
    return summary;
  }
  const currentCode = String(current.agency_code || "").trim().toLowerCase();
  if (
    currentCode !== code
    || currentCode === protectedOwnerCode(env)
    || isReservedOwnerAgencyCode(currentCode, env)
    || planStatus(current, nowMs).state !== "delete_due"
  ) {
    summary.skipped = "not_due";
    await auditDeletion(ctx, current, "client.delete_skipped_not_due", summary);
    return summary;
  }

  // 구글 연결을 먼저 끊는다(갱신 토큰). 동기화 행은 FK cascade 로도 지워지지만 몇 줄인지 남기려고 따로 지운다.
  // 서비스에 저장된 사본만 지우고, 구글 캘린더에 있는 원본 일정에는 요청하지 않는다.
  const sync = await ctx.supabaseAdmin.from("owner_google_calendar_sync").delete().eq("owner_agency_code", principalKey).select("owner_agency_code");
  if (sync.error) fail("owner_google_calendar_sync", sync.error);
  else summary.googleSync = (sync.data || []).length;

  const google = await ctx.supabaseAdmin.from("owner_google_integrations").delete().eq("owner_agency_code", principalKey).select("owner_agency_code");
  if (google.error) fail("owner_google_integrations", google.error);
  else summary.google = (google.data || []).length;

  const schedules = await ctx.supabaseAdmin
    .from("schedule_items")
    .delete()
    .eq("personal_role", "client")
    .eq("personal_code", clientId)
    .select("id");
  if (schedules.error) fail("schedule_items", schedules.error);
  else summary.schedules = (schedules.data || []).length;

  // 공유 캘린더는 그 광고주의 구성원 줄만 지운다(캘린더·다른 구성원의 일정은 그대로).
  const memberships = await ctx.supabaseAdmin.from("schedule_calendar_memberships").delete().eq("principal_key", principalKey).select("calendar_id");
  if (memberships.error) fail("schedule_calendar_memberships", memberships.error);
  else summary.memberships = (memberships.data || []).length;

  try {
    summary.storageObjects = await removeClientReportObjects(ctx, clientId);
  } catch (error) {
    summary.storageObjects = Number(error?.removed) || 0;
    fail("storage", error);
  }

  for (const table of RANK_TRACKER_TABLES) {
    const result = await ctx.supabaseAdmin.from(table).delete().eq("agency_code", code).select("id");
    if (result.error) fail(table, result.error);
    else summary.trackers[table] = (result.data || []).length;
  }

  const notes = await ctx.supabaseAdmin.from("keyword_research_notes").delete().eq("agency_code", code).select("id");
  if (notes.error) fail("keyword_research_notes", notes.error);
  else summary.notes = (notes.data || []).length;

  // 체험 한도는 로그인 연결의 google_sub 로 찾으므로, 한도를 먼저 지우고 성공했을 때만 로그인 연결을 지운다
  // (반대 순서면 한도 삭제만 실패했을 때 다음 날 재시도가 google_sub 를 잃는다).
  const identities = await ctx.supabaseAdmin.from("login_identities").select("google_sub").eq("role", "client").eq("code", code);
  if (identities.error) fail("login_identities", identities.error);
  else {
    const subs = (identities.data || []).map((row) => row.google_sub).filter(Boolean);
    let quotaOk = true;
    if (subs.length) {
      const quota = await ctx.supabaseAdmin.from("trial_keyword_quota").delete().in("google_sub", subs).select("google_sub");
      if (quota.error) {
        quotaOk = false;
        fail("trial_keyword_quota", quota.error);
      } else summary.quota = (quota.data || []).length;
    } else {
      summary.quota = 0;
    }
    if (quotaOk) {
      const removedIdentities = await ctx.supabaseAdmin.from("login_identities").delete().eq("role", "client").eq("code", code).select("google_sub");
      if (removedIdentities.error) fail("login_identities", removedIdentities.error);
      else {
        summary.identities = (removedIdentities.data || []).length;
        // 읽은 뒤 지우기 전에 다른 구글 계정이 연결됐으면 그 계정의 체험 한도도 지운다(연결이 지워지면 다시 찾을 길이 없다).
        const late = (removedIdentities.data || []).map((row) => row.google_sub).filter((sub) => sub && !subs.includes(sub));
        if (late.length) {
          const lateQuota = await ctx.supabaseAdmin.from("trial_keyword_quota").delete().in("google_sub", late).select("google_sub");
          if (lateQuota.error) fail("trial_keyword_quota", lateQuota.error);
          else summary.quota += (lateQuota.data || []).length;
        }
      }
    }
  }

  if (summary.errors.length) {
    await auditDeletion(ctx, current, "client.delete_partial_failed", summary);
    return summary;
  }

  // 광고주 행을 지우면 brands·reports·kpi 등 client_id FK 는 cascade, 운영팀 연결(client_id)은 set null 로 정리된다.
  // 재확인한 그대로일 때만 지운다: 같은 코드·같은 메모(유예 일수를 정함)·만료 시각 + 유예 ≤ 지금. 그 사이 연장·수정된 계정은 0행으로 남는다.
  const graceCutoff = new Date(nowMs - planGraceDays(current) * DAY_MS).toISOString();
  let finalDelete = ctx.supabaseAdmin
    .from("clients")
    .delete()
    .eq("id", client.id)
    .eq("agency_code", current.agency_code)
    .lte("plan_expires_at", graceCutoff);
  finalDelete = current.plan_note == null ? finalDelete.is("plan_note", null) : finalDelete.eq("plan_note", current.plan_note);
  const removed = await finalDelete.select("id");
  if (removed.error) fail("clients", removed.error);
  else {
    summary.client = (removed.data || []).length === 1;
    if (summary.client) {
      // 처음 훑은 뒤 광고주 행을 지우기 전 사이에 올라온 파일을 한 번 더 지운다(광고주 행이 없어 다음 날 재시도는 없으므로 실패는 failed 로 드러낸다).
      try {
        summary.storageObjects += await removeClientReportObjects(ctx, clientId, { withFileRows: false });
      } catch (error) {
        summary.storageObjects += Number(error?.removed) || 0;
        fail("storage after delete", error);
      }
    }
    if (!summary.client) {
      // 0행: 다른 실행(03:30 Vercel · 03:40 Actions)이 먼저 지웠으면 건너뜀, 행이 남아 있으면 지우는 사이 연장·수정된 것.
      const after = await ctx.supabaseAdmin.from("clients").select("id").eq("id", client.id).limit(1);
      if (!after.error && !(after.data || []).length) {
        summary.skipped = "missing";
        await auditDeletion(ctx, current, "client.deleted_by_other_run", summary);
        return summary;
      }
      fail("clients", "not deleted — account changed during deletion");
    }
  }

  await auditDeletion(ctx, current, summary.client ? "client.deleted_after_grace" : "client.delete_partial_failed", summary);
  return summary;
}

// 구글 연동 기한(GOOGLE_LINK_DEADLINE, 대표 지시 2026-09-08)이 지나면, 구글을 연결하지 않은 활성 광고주 코드 계정에 만료일(=기한)을
// 찍는다. 이후는 기존 흐름: 만료 팝업·읽기 전용 → 유예 3일(plan_note 로 판정) → 위 삭제. 총관리자 코드와 이미 그 전에 만료된 계정은
// 건드리지 않는다. 연결 여부 = login_identities(role client) 에 그 코드가 있는지. dryRun 이면 대상만 보고한다.
// 구글 연동 전환(미연동 만료·연동 계정 30일 시작·미연동 운영팀 해제)은 한 번만 하는 일이다.
// 운영 실행 기록: 2026-10-08 04:22 만료 13·시작 4, 2026-10-11 04:22 삭제 13·운영팀 해제 4.
// 기한 + 유예(3일) + 2일이 지나면 세 단계 모두 멈춘다. 그렇지 않으면 기한 뒤 다시 켠 계정·
// 구글 연결을 해제한 계정·다시 켠 운영팀이 다음 03:30 에 바로 만료·삭제·해제된다(반박 검토 2026-10-16).
const GOOGLE_LINK_TRANSITION_EXTRA_DAYS = 2;

export function googleLinkTransitionClosed(nowMs, deadlineMs) {
  if (!Number.isFinite(deadlineMs)) return true;
  return nowMs >= deadlineMs + (GOOGLE_LINK_GRACE_DAYS + GOOGLE_LINK_TRANSITION_EXTRA_DAYS) * DAY_MS;
}

function createdAtOrAfterDeadline(row, deadlineMs) {
  const createdMs = Date.parse(String(row?.created_at || ""));
  return Number.isFinite(createdMs) && createdMs >= deadlineMs;
}

function touchedAtOrAfterDeadline(row, deadlineMs) {
  const touchedMs = Date.parse(String(row?.plan_updated_at || ""));
  return Number.isFinite(touchedMs) && touchedMs >= deadlineMs;
}

export async function expireUnlinkedClients(ctx, { nowMs = Date.now(), dryRun = false, env = process.env } = {}) {
  const deadline = googleLinkDeadlineIso();
  const deadlineMs = Date.parse(String(deadline || ""));
  if (!Number.isFinite(deadlineMs) || nowMs < deadlineMs) return { active: false, deadline, marked: [], failed: [] };
  if (googleLinkTransitionClosed(nowMs, deadlineMs)) return { active: false, closed: true, deadline, marked: [], failed: [] };
  const clients = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, plan_expires_at, plan_note, plan_updated_at, created_at")
    .eq("status", "active");
  if (clients.error) throw clients.error;
  const identities = await ctx.supabaseAdmin.from("login_identities").select("code").eq("role", "client");
  if (identities.error) throw identities.error;
  const linked = new Set((identities.data || []).map((row) => String(row.code || "").trim().toLowerCase()).filter(Boolean));
  const owner = protectedOwnerCode(env);
  const marked = [];
  const failed = [];
  for (const row of clients.data || []) {
    const code = String(row.agency_code || "").trim().toLowerCase();
    if (!code || code === owner || linked.has(code)) continue;
    const currentMs = Date.parse(String(row.plan_expires_at || ""));
    if (Number.isFinite(currentMs) && currentMs <= deadlineMs) continue; // 이미 기한 전에 만료된 계정은 그대로
    // 구글 연동 전환은 기한 시점에 이미 있던 계정에 한 번만 적용한다(검수 2026-10-03 긴급 ③).
    // 기한 뒤 새로 만든 계정과 기한 뒤 총관리자가 이용 기간을 손댄 계정(연장·무기한)은 건드리지 않는다.
    if (createdAtOrAfterDeadline(row, deadlineMs)) continue;
    if (touchedAtOrAfterDeadline(row, deadlineMs)) continue;
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
  if (googleLinkTransitionClosed(nowMs, deadlineMs)) return { active: false, closed: true, deadline, expiresAt, started: [], failed: [] };
  const clients = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, plan_name, plan_expires_at, plan_updated_at, created_at")
    .eq("status", "active");
  if (clients.error) throw clients.error;
  const identities = await ctx.supabaseAdmin.from("login_identities").select("code").eq("role", "client");
  if (identities.error) throw identities.error;
  const linked = new Set((identities.data || []).map((row) => String(row.code || "").trim().toLowerCase()).filter(Boolean));
  const owner = protectedOwnerCode(env);
  const started = [];
  const failed = [];
  for (const row of clients.data || []) {
    const code = String(row.agency_code || "").trim().toLowerCase();
    if (!code || code === owner || !linked.has(code)) continue;
    if (Number.isFinite(Date.parse(String(row.plan_expires_at || "")))) continue; // 이미 이용 기간이 있는 계정은 그대로
    if (touchedAtOrAfterDeadline(row, deadlineMs)) continue; // 기한 뒤 총관리자가 손댄 계정(예: 일부러 무기한)
    if (createdAtOrAfterDeadline(row, deadlineMs)) continue; // 기한 뒤 만든 계정은 고정 만료일(11/06)을 찍지 않는다
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
  if (googleLinkTransitionClosed(nowMs, deadlineMs)) return { active: false, closed: true, revokeFrom: new Date(revokeFromMs).toISOString(), revoked: [], failed: [] };
  const teams = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, team_name, team_code, status, client_id, created_at")
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
    if (createdAtOrAfterDeadline(row, deadlineMs)) continue; // 기한 뒤 만든 운영팀은 해제하지 않는다
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

// 1년 넘은 감사 로그를 지운다. dryRun 이면 지울 줄 수만 센다(최대 1000까지 표시).
export async function pruneAuditLogs(ctx, { nowMs = Date.now(), dryRun = false } = {}) {
  const cutoff = new Date(nowMs - AUDIT_LOG_KEEP_DAYS * DAY_MS).toISOString();
  const query = ctx.supabaseAdmin.from("audit_logs");
  const result = dryRun
    ? await query.select("id").lt("created_at", cutoff).limit(1000)
    : await query.delete().lt("created_at", cutoff).select("id");
  if (result.error) return { cutoff, pruned: 0, error: String(result.error.message || result.error) };
  return { cutoff, pruned: (result.data || []).length, dryRun };
}

function trialNotesCode(googleSub) {
  return `trial-${String(googleSub || "").toLowerCase().slice(0, 8)}`;
}

// 마지막 이용 뒤 1년 동안 쓰지 않은 체험 계정(login_identities role=trial)을 지운다. 마지막 이용 = 연결·로그인 시각
// (updated_at, 로그인 때마다 갱신)과 키워드 조회 기록(trial_keyword_quota.updated_at) 중 늦은 것. 정식 전환된 계정은
// role 이 client 라 대상이 아니다.
// 순서: 계정을 먼저 조건부로 지운다(role=trial 이고 updated_at 이 기준보다 오래된 경우만) — 그 사이 다시 로그인했거나 정식
// 전환된 계정은 0행이 되어 그 뒤의 한도·노트도 건드리지 않는다. 그다음 체험 한도, 마지막으로 조사 노트. 노트는
// 'trial-<sub 앞 8자>' 코드로 묶여 있어, 같은 앞 8자를 쓰는 다른 계정(정식 전환된 계정 포함, 이번 실행에서 지운 계정 제외)이
// 남아 있으면 지우지 않는다. 계정 표가 PAGE 한도(1000)에 닿으면 전체를 못 본 채 판단하지 않도록 정리하지 않는다.
const TRIAL_IDENTITY_SCAN_LIMIT = 1000;

export async function pruneInactiveTrials(ctx, { nowMs = Date.now(), dryRun = false, limit = EXPIRY_DELETE_BATCH } = {}) {
  const cutoff = new Date(nowMs - TRIAL_INACTIVE_DAYS * DAY_MS).toISOString();
  const cutoffMs = Date.parse(cutoff);
  const deleted = [];
  const failed = [];
  const identities = await ctx.supabaseAdmin
    .from("login_identities")
    .select("google_sub, role, linked_at, updated_at")
    .limit(TRIAL_IDENTITY_SCAN_LIMIT);
  if (identities.error) return { cutoff, deleted, failed: [{ error: String(identities.error.message || identities.error) }] };
  const all = (identities.data || []).filter((row) => row && row.google_sub);
  if (all.length >= TRIAL_IDENTITY_SCAN_LIMIT) {
    return { cutoff, deleted, failed: [{ error: `login_identities: ${TRIAL_IDENTITY_SCAN_LIMIT}줄 이상 — 전체를 확인할 수 없어 체험 정리를 건너뜀` }] };
  }
  const lastSeen = (row) => Math.max(Date.parse(String(row.updated_at || "")) || 0, Date.parse(String(row.linked_at || "")) || 0);
  const candidates = all
    .filter((row) => row.role === "trial" && lastSeen(row) > 0 && lastSeen(row) < cutoffMs)
    .sort((a, b) => lastSeen(a) - lastSeen(b));
  const deletedSubs = new Set();
  let processed = 0;
  for (const row of candidates) {
    if (processed >= limit) break;
    const sub = String(row.google_sub);
    const recent = await ctx.supabaseAdmin.from("trial_keyword_quota").select("google_sub").eq("google_sub", sub).gte("updated_at", cutoff).limit(1);
    if (recent.error) {
      failed.push({ error: `trial_keyword_quota: ${String(recent.error.message || recent.error)}` });
      continue;
    }
    if ((recent.data || []).length) continue; // 1년 안에 키워드 조회를 했다 — 아직 쓰는 계정
    processed += 1;
    if (dryRun) {
      deleted.push({ dryRun: true });
      continue;
    }
    const identity = await ctx.supabaseAdmin
      .from("login_identities")
      .delete()
      .eq("google_sub", sub)
      .eq("role", "trial")
      .lt("updated_at", cutoff)
      .select("google_sub");
    if (identity.error) {
      failed.push({ error: `login_identities: ${String(identity.error.message || identity.error)}` });
      continue;
    }
    if ((identity.data || []).length !== 1) continue; // 그 사이 다시 로그인했거나 정식 전환됨 — 아무것도 지우지 않는다
    deletedSubs.add(sub);
    const summary = { quota: null, notes: null };
    const quota = await ctx.supabaseAdmin.from("trial_keyword_quota").delete().eq("google_sub", sub).select("google_sub");
    if (quota.error) failed.push({ error: `trial_keyword_quota: ${String(quota.error.message || quota.error)}` });
    else summary.quota = (quota.data || []).length;
    const notesCode = trialNotesCode(sub);
    const shared = all.some((other) => {
      const otherSub = String(other.google_sub);
      return otherSub !== sub && !deletedSubs.has(otherSub) && trialNotesCode(otherSub) === notesCode;
    });
    if (shared) {
      summary.notes = "kept-shared-prefix";
    } else {
      const notes = await ctx.supabaseAdmin.from("keyword_research_notes").delete().eq("agency_code", notesCode).select("id");
      if (notes.error) failed.push({ error: `keyword_research_notes: ${String(notes.error.message || notes.error)}` });
      else summary.notes = (notes.data || []).length;
    }
    try {
      await ctx.supabaseAdmin.from("audit_logs").insert({
        actor_id: null,
        client_id: null,
        action: "trial.deleted_inactive",
        target_table: "login_identities",
        target_id: null,
        metadata: sanitizeAuditMetadata({
          source: "account-expiry-cron",
          inactiveDays: String(TRIAL_INACTIVE_DAYS),
          lastSeenAt: new Date(lastSeen(row)).toISOString(),
          quota: summary.quota,
          notes: summary.notes,
        }),
      });
    } catch (error) {
      // 감사 기록 실패는 정리 결과를 바꾸지 않는다
    }
    deleted.push(summary);
  }
  return { cutoff, deleted, failed };
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
    for (const client of due) results.push(await deleteExpiredClient(ctx, client, { nowMs, env }));
  }
  const trials = await pruneInactiveTrials(ctx, { nowMs, dryRun: effectiveDryRun });
  // 감사 로그 정리는 맨 끝에: 오늘 남긴 기록은 1년 기준에 걸리지 않는다.
  const auditLogs = await pruneAuditLogs(ctx, { nowMs, dryRun: effectiveDryRun });
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
    skipped: results.filter((result) => result.skipped).map((result) => ({ agencyCode: result.agencyCode, reason: result.skipped })),
    auditFailed: results.filter((result) => result.auditLogged === false).map((result) => result.agencyCode),
    trialsDeleted: trials.deleted.length,
    trialsFailed: trials.failed,
    auditLogsPruned: auditLogs.pruned,
    auditLogsPruneError: auditLogs.error || null,
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

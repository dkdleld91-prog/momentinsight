import { randomBytes } from "node:crypto";
import { withSupabase } from "@supabase/server";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import {
  PLAN_DEFAULT_DAYS,
  expiryFromDate,
  extendedExpiry,
  isAutomaticPlanNote,
  normalizePlanDays,
  normalizePlanName,
  planStatus,
} from "../account-plan.mjs";
import { corsHeaders, isLocalRequest, protectedJson, safeEqual } from "../security.mjs";
import { siteSummary } from "./site-events.mjs";
import {
  DEFAULT_RANK_KEYWORD_LIMIT,
  isMissingRankKeywordLimitSchema,
  parseRankKeywordLimitInput,
} from "../rank-keyword-limit.mjs";
import {
  pauseAccountRankTrackers,
  resumeAccountRankTrackers,
} from "../rank-tracker-account-suspension.mjs";
import {
  RANK_CHRONIC_ISOLATION_MS,
  RANK_NEVER_FOUND_MIN_CHECKS,
  RANK_PLACE_PARTIAL_MIN_RETRIES,
  RANK_RETRY_EXHAUSTED_AT,
  RANK_STUCK_TRACKER_MS,
} from "../naver-rank-requeue.mjs";

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function adminRateConfiguration(env = process.env) {
  return {
    windowMs: boundedInteger(env.MI_ADMIN_CODE_RATE_WINDOW_MS, 60_000, 10_000, 60 * 60 * 1000),
    limit: boundedInteger(env.MI_ADMIN_CODE_RATE_LIMIT, 40, 5, 200),
  };
}

const ADMIN_RATE = adminRateConfiguration();
const ADMIN_RATE_WINDOW_MS = ADMIN_RATE.windowMs;
const ADMIN_RATE_LIMIT = ADMIN_RATE.limit;
const adminRateBucket = new Map();

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "content-type, x-mi-super-admin-code, x-mi-owner-agency-code, x-mi-team-code",
  });
}

export function normalizeAgencyCode(value) {
  const code = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.~!@#$^&*+=:-]{5,127}$/.test(code) ? code : "";
}

// ─────────────────────────────────────────────────────────────
// 운영 이력(audit_logs) 읽기 전용 조회
//
// /api/admin/audit-logs 는 apikey 로 SUPABASE_SECRET_KEY 를 요구해서 브라우저
// 총관리자 세션으로는 부를 수 없다. 그래서 이미 총관리자 코드로 잠겨 있는 이
// 핸들러에 GET ?view=audit-logs 를 얹는다. 노출 열은 네 개(action,
// target_table, metadata, created_at)뿐이고 actor_id / client_id / target_id
// 같은 식별자는 응답에 담지 않는다.
// ─────────────────────────────────────────────────────────────
const AUDIT_ACTION_LABELS = new Map([
  ["client.created_by_owner", "광고주 생성(총관리자)"],
  ["client.created_by_team", "광고주 생성(운영팀)"],
  ["client.reactivated_by_owner", "광고주 재활성화"],
  ["client.revoked", "광고주 연결 해제"],
  ["operation_team.created", "운영팀 생성"],
  ["operation_team.reactivated", "운영팀 재활성화"],
  ["operation_team.revoked", "운영팀 권한 해제"],
  ["operation_team.client_disconnected", "운영팀 광고주 연결 해제"],
  ["client.rank_keyword_limit_updated", "광고주 키워드 한도 변경"],
  ["team.rank_keyword_limit_updated", "운영팀 키워드 한도 변경"],
  ["client.plan_updated", "광고주 이용 기간 변경"],
  ["client.plan_cleared", "광고주 이용 기간 해제"],
  ["client.created_from_trial", "체험 계정 정식 전환"],
  ["google_calendar_connected", "구글 캘린더 연결"],
  ["google_calendar_sync_failed", "구글 캘린더 동기화 실패"],
  ["google_calendar_catalog_refresh_failed", "구글 캘린더 목록 새로고침 실패"],
  ["google_calendar_dedicated_retired", "전용 구글 캘린더 정리"],
  ["meta_research.item_created", "메타 소재 저장"],
  ["meta_research.item_deleted", "메타 소재 삭제"],
  ["report_center.ai_pptx_created", "AI 보고서 생성"],
  ["work_item_updated", "일정 수정"],
  ["work_item_deleted", "일정 삭제"],
  ["work_item_delete_attempted", "일정 삭제 시도"],
  ["work_item_completed_by_assistant", "실장 비서 일정 완료"],
]);

// admin-api 는 `<table>.created|.updated|.deleted` 를 동적으로 찍는다. 표 이름은
// 그대로 두고 뒷말만 우리말로 바꾼다.
const AUDIT_ACTION_SUFFIX_LABELS = new Map([
  ["created", "생성"],
  ["updated", "수정"],
  ["deleted", "삭제"],
]);

const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
const AUDIT_LOG_MAX_LIMIT = 50;
const AUDIT_LOG_SELECT = "action, target_table, metadata, created_at";

export function auditActionLabel(action) {
  const key = String(action || "").trim();
  if (!key) return null;

  const known = AUDIT_ACTION_LABELS.get(key);
  if (known) return known;

  const separator = key.lastIndexOf(".");
  if (separator > 0 && separator < key.length - 1) {
    const table = key.slice(0, separator);
    const suffix = AUDIT_ACTION_SUFFIX_LABELS.get(key.slice(separator + 1));
    if (table && suffix) return `${table} ${suffix}`;
  }

  // 모르는 동작은 화면에서 원문 그대로 보여준다.
  return null;
}

export function auditLogQueryOptions(url) {
  const params = url instanceof URL ? url.searchParams : new URL(String(url)).searchParams;

  const requestedLimit = Math.trunc(Number(params.get("limit")) || AUDIT_LOG_MAX_LIMIT);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : AUDIT_LOG_MAX_LIMIT, 1), AUDIT_LOG_MAX_LIMIT);

  const rawAction = params.get("action") || "";
  const action = AUDIT_ACTION_PATTERN.test(rawAction) ? rawAction : null;

  const rawBefore = params.get("before") || "";
  const before = rawBefore && !Number.isNaN(Date.parse(rawBefore)) ? rawBefore : null;

  return { action, limit, before };
}

function clientRateKey(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim() || request.headers.get("x-real-ip") || "anonymous";
}

function checkAdminRateLimit(request) {
  if (isLocalRequest(request)) return { allowed: true };
  const now = Date.now();
  const key = clientRateKey(request);
  const fresh = (adminRateBucket.get(key) || []).filter((time) => now - time < ADMIN_RATE_WINDOW_MS);

  if (fresh.length >= ADMIN_RATE_LIMIT) {
    adminRateBucket.set(key, fresh);
    const retryAfter = Math.max(1, Math.ceil((ADMIN_RATE_WINDOW_MS - (now - fresh[0])) / 1000));
    return { allowed: false, retryAfter };
  }

  fresh.push(now);
  adminRateBucket.set(key, fresh);

  if (adminRateBucket.size > 1000) {
    for (const [bucketKey, times] of adminRateBucket.entries()) {
      const activeTimes = times.filter((time) => now - time < ADMIN_RATE_WINDOW_MS);
      if (activeTimes.length) adminRateBucket.set(bucketKey, activeTimes);
      else adminRateBucket.delete(bucketKey);
    }
  }

  return { allowed: true };
}

function primaryAgencyCode() {
  return normalizeAgencyCode(process.env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
}

function requestSuperAdminCode(request, body = {}) {
  return String(
    request.headers.get("x-mi-super-admin-code") ||
      body.superAdminCode ||
      body.super_admin_code ||
      ""
  ).trim();
}

function requestOwnerAgencyCode(request, body = {}) {
  return normalizeAgencyCode(
    request.headers.get("x-mi-owner-agency-code") ||
      body.ownerAgencyCode ||
      body.owner_agency_code ||
      body.rootAgencyCode ||
      body.root_agency_code ||
      ""
  );
}

function requestTeamCode(request, body = {}) {
  return normalizeAgencyCode(
    request.headers.get("x-mi-team-code") ||
      body.teamCode ||
      body.team_code ||
      ""
  );
}

function requestSessionTeamCode(request) {
  return normalizeAgencyCode(request.headers.get("x-mi-team-code") || "");
}

function requestTargetTeamCode(body = {}) {
  return normalizeAgencyCode(body.targetTeamCode || body.target_team_code || "");
}

function configuredSuperAdminCode() {
  return String(process.env.MI_SUPER_ADMIN_CODE || "").trim();
}

function superAdminAuthorized(request, body = {}) {
  const configured = configuredSuperAdminCode();
  return Boolean(configured) && safeEqual(requestSuperAdminCode(request, body), configured);
}

function ownerActionAuthorized(request, body = {}) {
  if (!configuredSuperAdminCode()) {
    return { ok: false, status: 503, message: "총관리자 비밀값이 서버에 설정되지 않았습니다." };
  }
  if (!superAdminAuthorized(request, body)) {
    return { ok: false, status: 401, message: "총관리자 코드가 일치하지 않습니다." };
  }
  if (!ownerAgencyAuthorized(request, body)) {
    return { ok: false, status: 403, message: `메인 계정 코드 ${primaryAgencyCode()}에서만 운영팀 코드를 발급할 수 있습니다.` };
  }
  return { ok: true };
}

function ownerAgencyAuthorized(request, body = {}) {
  return safeEqual(requestOwnerAgencyCode(request, body), primaryAgencyCode());
}

export function teamActionAccess(request, body = {}) {
  const teamCode = requestSessionTeamCode(request);
  if (teamCode) return { ok: true, teamCode, ownerTarget: false };

  const targetTeamCode = requestTargetTeamCode(body);
  if (!targetTeamCode) {
    return { ok: false, status: 400, message: "운영팀 대상을 확인할 수 없습니다." };
  }
  const ownerAuth = ownerActionAuthorized(request, {});
  if (!ownerAuth.ok) return ownerAuth;
  return { ok: true, teamCode: targetTeamCode, ownerTarget: true };
}

function teamActionClientPayload(row, access) {
  const payload = clientPayload(row);
  if (!access.ownerTarget) delete payload.issuedByTeamCode;
  return payload;
}

export function teamActionPayload(row, access) {
  const payload = teamPayload(row);
  if (!access.ownerTarget) {
    delete payload.teamCode;
    if (payload.client) {
      delete payload.client.agencyCode;
      delete payload.client.issuedByTeamCode;
    }
  }
  return payload;
}

function clientPayload(row) {
  return {
    id: row.id,
    name: row.name,
    businessName: row.business_name,
    agencyCode: row.agency_code,
    status: row.status,
    issuedByTeamCode: row.issued_by_team_code,
    disconnectedAt: row.disconnected_at,
    publicSummary: row.public_summary,
    rankKeywordLimit: row.rank_keyword_limit ?? null,
    // 플랜·이용 기간(대표 결정 2026-09-07). 열이 아직 없으면 무기한(state none)으로 계산된다.
    plan: planStatus(row),
    planNote: row.plan_note ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function teamPayload(row) {
  const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
  return {
    id: row.id,
    ownerAgencyCode: row.owner_agency_code,
    teamName: row.team_name,
    teamCode: row.team_code,
    status: row.status,
    clientId: row.client_id,
    client: client ? clientPayload(client) : null,
    rankKeywordLimit: row.rank_keyword_limit ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function isMissingTeamSchema(error) {
  return /operation_team_codes|issued_by_team_code|disconnected_at|rank_keyword_limit|schema cache|does not exist/i.test(error?.message || "");
}

// 열 사다리에서 "그 열이 아직 없다" 를 가린다. 지금까지 폴백하던 경우를 하나도
// 좁히지 않으려고 두 판정을 함께 본다(메시지 문구 + PostgREST 오류 코드).
function isMissingClientSchema(error) {
  return isMissingTeamSchema(error) || isMissingRankKeywordLimitSchema(error);
}

async function recordAuditLog(ctx, payload) {
  const { error } = await ctx.supabaseAdmin
    .from("audit_logs")
    .insert({
      actor_id: null,
      client_id: payload.clientId || null,
      action: payload.action,
      target_table: payload.targetTable,
      target_id: payload.targetId || null,
      metadata: sanitizeAuditMetadata(payload.metadata || {}),
    });

  return !error;
}

async function attachTeamClient(ctx, team) {
  if (!team) return { team: null };

  let client = null;
  if (team.client_id) {
    const result = await ctx.supabaseAdmin
      .from("clients")
      .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
      .eq("id", team.client_id)
      .maybeSingle();
    if (result.error) return { error: result.error };
    client = result.data || null;
  }

  if (!client) {
    const result = await ctx.supabaseAdmin
      .from("clients")
      .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
      .eq("issued_by_team_code", team.team_code)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (result.error) return { error: result.error };
    client = result.data || null;
  }

  return { team: { ...team, clients: client } };
}

// 키워드 한도 기능 이전부터 운영 DB 에 이미 있던 전체 열.
const CLIENT_LEGACY_FULL_SELECT = "id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at";
// 위에 이번 기능의 열 하나를 얹은 것.
const CLIENT_FULL_SELECT = `${CLIENT_LEGACY_FULL_SELECT}, rank_keyword_limit`;
// 플랜·이용 기간 열(2026-09-07 마이그레이션)까지 얹은 것. 없으면 한 단 아래(한도까지)로 내려간다.
const CLIENT_PLAN_SELECT = `${CLIENT_FULL_SELECT}, plan_name, plan_days, plan_started_at, plan_expires_at, plan_note, plan_updated_at`;
// 운영팀 열조차 없던 아주 오래된 DB 를 위한 최소 열(마지막 수단).
const CLIENT_BASE_SELECT = "id, name, business_name, agency_code, status, public_summary, created_at, updated_at";

function isMissingPlanSchema(error) {
  return /plan_name|plan_days|plan_started_at|plan_expires_at|plan_note|plan_updated_at|schema cache|does not exist/i.test(error?.message || "");
}

async function selectClients(ctx) {
  const query = (columns) => ctx.supabaseAdmin
    .from("clients")
    .select(columns)
    .neq("status", "archived")
    .order("created_at", { ascending: true })
    .limit(100);

  let result = await query(CLIENT_PLAN_SELECT);
  if (!result.error) return result;
  if (!isMissingClientSchema(result.error) && !isMissingPlanSchema(result.error)) return result;

  // 플랜 열만 없는 단계(배포가 플랜 마이그레이션보다 먼저): 한도까지는 그대로 읽고 플랜만 무기한으로 본다.
  // 오류 문구가 한도·운영팀 열을 가리키면 이 단은 건너뛴다(기존 사다리의 호출 수를 늘리지 않는다).
  const firstMessage = String(result.error.message || "");
  if (/plan_/i.test(firstMessage) && !/rank_keyword_limit|issued_by_team_code|disconnected_at/i.test(firstMessage)) {
    result = await query(CLIENT_FULL_SELECT);
    if (!result.error) {
      result.planSchemaPending = true;
      return result;
    }
    if (!isMissingClientSchema(result.error)) return result;
  }

  // 가운데 단이 있는 이유: 배포가 마이그레이션보다 먼저 나가면 rank_keyword_limit
  // 하나만 없다. 이때 곧바로 최소 열로 내려가면 운영 DB 에 이미 있는
  // issued_by_team_code / disconnected_at 까지 같이 떨어져, 총관리자 화면이
  // 운영팀 발급 광고주를 '직접 발급' 으로 잘못 표시한다. 한 단 걸쳐서 그 열들을
  // 지키고 한도만 null 로 비운다.
  result = await query(CLIENT_LEGACY_FULL_SELECT);
  if (!result.error) {
    result.schemaPending = true;
    return result;
  }
  if (!isMissingClientSchema(result.error)) return result;

  result = await query(CLIENT_BASE_SELECT);
  if (!result.error) result.schemaPending = true;
  return result;
}

async function selectTeams(ctx) {
  const baseSelect = "id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at";
  const fullSelect = `${baseSelect}, rank_keyword_limit`;
  let result = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select(fullSelect)
    .eq("owner_agency_code", primaryAgencyCode())
    .order("created_at", { ascending: true })
    .limit(100);

  if (result.error && isMissingTeamSchema(result.error)) {
    result = await ctx.supabaseAdmin
      .from("operation_team_codes")
      .select(baseSelect)
      .eq("owner_agency_code", primaryAgencyCode())
      .order("created_at", { ascending: true })
      .limit(100);
    if (!result.error) result.schemaPending = true;
  }

  return result;
}

async function safeCount(query) {
  const { count, error } = await query;
  if (error) return { count: null, error: error.message };
  return { count: Number(count || 0), error: null };
}

// F17: 운영팀 코드(agency_code = 팀코드)로 등록된 추적기 가운데, 그 팀이 광고주와
// 연결됐거나 권한이 해제돼 "아무 화면에도 뜨지 않는" 것들을 센다. 팀이 활성이고
// 미연결이면 그 팀 계정 화면에 그대로 보이므로 여기서 세지 않는다.
// 결과는 safeCount 와 같은 { count, error } 모양이라 총관리자 화면이 그대로 쓴다.
async function loadUnlinkedScopeTrackers(ctx) {
  const teams = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("team_code, team_name, status, client_id")
    .eq("owner_agency_code", primaryAgencyCode())
    .limit(200);
  if (teams.error) return { count: null, error: teams.error.message, codes: [] };

  const hidden = new Map();
  (teams.data || []).forEach((team) => {
    const code = String(team.team_code || "").trim().toLowerCase();
    const hiddenScope = Boolean(team.client_id) || String(team.status || "") !== "active";
    if (code && hiddenScope && !hidden.has(code)) hidden.set(code, team);
  });
  if (!hidden.size) return { count: 0, error: null, codes: [] };

  const codes = [...hidden.keys()];
  const [product, place] = await Promise.all([
    ctx.supabaseAdmin.from("naver_rank_trackers").select("agency_code").in("agency_code", codes).eq("status", "active").limit(1000),
    ctx.supabaseAdmin.from("naver_place_rank_trackers").select("agency_code").in("agency_code", codes).eq("status", "active").limit(1000),
  ]);
  const failure = product.error || place.error;
  if (failure) return { count: null, error: failure.message, codes: [] };

  const counts = new Map();
  [...(product.data || []), ...(place.data || [])].forEach((row) => {
    const code = String(row.agency_code || "").trim().toLowerCase();
    if (hidden.has(code)) counts.set(code, (counts.get(code) || 0) + 1);
  });

  const scopes = [...counts.entries()]
    .map(([agencyCode, trackerCount]) => ({
      agencyCode,
      teamName: hidden.get(agencyCode).team_name || "",
      teamStatus: hidden.get(agencyCode).status || "",
      trackerCount,
    }))
    .sort((left, right) => right.trackerCount - left.trackerCount);

  return {
    count: scopes.reduce((total, scope) => total + scope.trackerCount, 0),
    error: null,
    codes: scopes,
  };
}

async function loadOwnerHealth(ctx) {
  const nowIso = new Date().toISOString();
  // 만성 실패 격리 기준선. 페이로드 전체가 같은 시계를 쓰도록 nowIso 에서 파생한다.
  const chronicCutoffIso = new Date(Date.parse(nowIso) - RANK_CHRONIC_ISOLATION_MS).toISOString();
  // 멈춘 추적기 기준선(36시간). 같은 시계에서 파생한다.
  const stuckCutoffIso = new Date(Date.parse(nowIso) - RANK_STUCK_TRACKER_MS).toISOString();
  const [
    activeClients,
    activeTeams,
    dueTrackers,
    failedTrackers,
    chronicTrackers,
    neverFoundTrackers,
    stuckTrackers,
    placePartialTrackers,
    sourceFiles,
    publicReports,
    unlinkedScopeTrackers,
  ] = await Promise.all([
    safeCount(ctx.supabaseAdmin
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")),
    safeCount(ctx.supabaseAdmin
      .from("operation_team_codes")
      .select("id", { count: "exact", head: true })
      .eq("owner_agency_code", primaryAgencyCode())
      .eq("status", "active")),
    safeCount(ctx.supabaseAdmin
      .from("naver_rank_trackers")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .lte("next_check_at", nowIso)),
    safeCount(ctx.supabaseAdmin
      .from("naver_rank_trackers")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .not("last_error", "is", null)),
    // 만성 실패(격리 대상) 추적기 수: 재시도가 소진된 채 성공 기록(last_checked_at)이
    // 격리 기간 이상 끊긴 활성 추적기. failedTrackers 의 부분집합이며, 잔존 실패 감사
    // 스크립트·수집 상태 화면과 같은 상수·같은 기준선을 쓰므로 세 화면이 대조된다.
    //
    // OR 의 두 갈래는 chronicIsolationCandidate 의 앵커 규칙을 그대로 옮긴 것이다:
    // 성공한 적 있으면 last_checked_at 이 앵커고, 한 번도 성공한 적 없으면(null)
    // created_at 이 앵커다. 여기서 last_checked_at.is.null 만 쓰면 10분 전에 만들어져
    // 8번 실패한 추적기까지 만성으로 세어 순수 판정(false)과 화면(1건)이 갈라진다.
    // 그래서 null 갈래에는 반드시 created_at 컷오프를 묶는다.
    safeCount(ctx.supabaseAdmin
      .from("naver_rank_trackers")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .not("last_error", "is", null)
      .gte("retry_count", RANK_RETRY_EXHAUSTED_AT)
      .or(`last_checked_at.lt.${chronicCutoffIso},and(last_checked_at.is.null,created_at.lt.${chronicCutoffIso})`)),
    // 한 번도 찾지 못한 상품 추적기 수(2026-09-02, C2 결함 E): 확인은 충분히 했는데
    // 발견 0건인 활성 추적기. 잔존 감사 스크립트(neverFoundCount)·헬스 API
    // (trackers.neverFound)와 같은 상수를 쓰므로 세 화면이 대조된다.
    safeCount(ctx.supabaseAdmin
      .from("naver_rank_trackers")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .gte("check_count", RANK_NEVER_FOUND_MIN_CHECKS)
      .eq("found_count", 0)),
    // 멈춘 상품 추적기 수: 오류가 남은 채 성공 도장(last_checked_at, 없으면 created_at)이
    // 36시간 넘게 끊긴 활성 추적기. chronicTrackers 와 달리 retry_count 를 보지 않는다 —
    // 소진 전에 멈춘 행을 잡는 것이 목적이다. 잔존 감사(stuckCount)·헬스 API(trackers.stuck)
    // 와 같은 상수·같은 앵커 규칙(null 갈래에는 created_at 컷오프를 묶는다)을 쓴다.
    safeCount(ctx.supabaseAdmin
      .from("naver_rank_trackers")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .not("last_error", "is", null)
      .or(`last_checked_at.lt.${stuckCutoffIso},and(last_checked_at.is.null,created_at.lt.${stuckCutoffIso})`)),
    // partial 을 반복 중인 플레이스 추적기 수(2026-09-03, F18): partial 결과 경로는
    // last_error 를 null 로 둔 채 retry_count 만 올려서 위 잔존·stuck·만성 집계 어디에도
    // 걸리지 않는다. loadOwnerHealth 에서 플레이스 표를 보는 유일한 카운터다(나머지는
    // 전부 상품 표). 잔존 감사(placePartialCount)·헬스 API(trackers.placePartial)와 같은
    // 서버 상수를 쓰므로 세 화면이 같은 행을 센다.
    safeCount(ctx.supabaseAdmin
      .from("naver_place_rank_trackers")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .is("last_error", null)
      .gte("retry_count", RANK_PLACE_PARTIAL_MIN_RETRIES)),
    safeCount(ctx.supabaseAdmin
      .from("files")
      .select("id", { count: "exact", head: true })
      .is("report_id", null)
      .like("title", "원천 파일%")),
    safeCount(ctx.supabaseAdmin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("visibility", "client_visible")),
    loadUnlinkedScopeTrackers(ctx),
  ]);

  return {
    checkedAt: nowIso,
    activeClients,
    activeTeams,
    dueTrackers,
    failedTrackers,
    chronicTrackers,
    neverFoundTrackers,
    stuckTrackers,
    placePartialTrackers,
    sourceFiles,
    publicReports,
    unlinkedScopeTrackers,
  };
}

async function listClients(request, ctx) {
  const clientsResult = await selectClients(ctx);

  if (clientsResult.error) {
    return json(request, { ok: false, message: "광고주 코드 목록 조회에 실패했습니다.", detail: clientsResult.error.message }, 500);
  }

  const teamsResult = await selectTeams(ctx);

  if (teamsResult.error) {
    if (isMissingTeamSchema(teamsResult.error)) {
      return json(request, {
        ok: true,
        schemaPending: true,
        message: "운영팀 코드 DB 마이그레이션 적용 전입니다. 기존 광고주 코드는 조회됩니다.",
        ownerAgencyCode: primaryAgencyCode(),
        teams: [],
        clients: (clientsResult.data || []).map(clientPayload),
      });
    }
    return json(request, { ok: false, message: "운영팀 코드 목록 조회에 실패했습니다.", detail: teamsResult.error.message }, 500);
  }

  // 구글 연동 이메일(문의 때 계정 찾기)과 무료 체험 계정 목록(대표 지시 2026-09-07).
  const identities = await selectLoginIdentities(ctx);
  const trialUsage = await selectTrialUsageToday(ctx);
  const emailFor = (role, code) => identities.byKey.get(`${role}:${String(code || "").trim().toLowerCase()}`) || null;

  return json(request, {
    ok: true,
    schemaPending: Boolean(clientsResult.schemaPending || teamsResult.schemaPending),
    planSchemaPending: Boolean(clientsResult.planSchemaPending),
    ownerAgencyCode: primaryAgencyCode(),
    health: await loadOwnerHealth(ctx),
    teams: (teamsResult.data || []).map((team) => ({
      ...team,
      clients: (clientsResult.data || []).find((client) => client.id === team.client_id) || null,
    })).map((team) => {
      const payload = teamPayload(team);
      payload.googleEmail = emailFor("team", payload.teamCode);
      if (payload.client) payload.client.googleEmail = emailFor("client", payload.client.agencyCode);
      return payload;
    }),
    clients: (clientsResult.data || []).map((row) => ({ ...clientPayload(row), googleEmail: emailFor("client", row.agency_code) })),
    trials: identities.trials.map((row) => trialPayload(row, trialUsage)),
  });
}

// 구글 로그인 연결 표(login_identities). 표가 없거나 실패하면 이메일 없이, 체험 목록도 비워 둔다.
async function selectLoginIdentities(ctx) {
  const empty = { byKey: new Map(), trials: [] };
  try {
    const result = await ctx.supabaseAdmin
      .from("login_identities")
      .select("google_sub, google_email, role, code, linked_at")
      .limit(1000);
    if (result.error) return empty;
    const byKey = new Map();
    const trials = [];
    for (const row of result.data || []) {
      if (row.role === "trial") {
        trials.push(row);
        continue;
      }
      byKey.set(`${row.role}:${String(row.code || "").trim().toLowerCase()}`, row.google_email || null);
    }
    trials.sort((a, b) => Date.parse(b.linked_at || 0) - Date.parse(a.linked_at || 0));
    return { byKey, trials };
  } catch {
    return empty;
  }
}

function seoulDay(now = Date.now()) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

async function selectTrialUsageToday(ctx) {
  const usage = new Map();
  try {
    const result = await ctx.supabaseAdmin
      .from("trial_keyword_quota")
      .select("google_sub, used")
      .eq("day", seoulDay())
      .limit(1000);
    if (result.error) return usage;
    for (const row of result.data || []) usage.set(String(row.google_sub || ""), Number(row.used || 0));
  } catch {
    /* 표가 없으면 0 으로 둔다 */
  }
  return usage;
}

function trialPayload(row, usage) {
  return {
    googleSub: row.google_sub,
    googleEmail: row.google_email || null,
    linkedAt: row.linked_at || null,
    todayUsed: usage.get(String(row.google_sub || "")) || 0,
  };
}

async function listAuditLogs(request, ctx, url) {
  const { action, limit, before } = auditLogQueryOptions(url);

  let query = ctx.supabaseAdmin
    .from("audit_logs")
    .select(AUDIT_LOG_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (action) query = query.eq("action", action);
  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) {
    return json(request, { ok: false, message: "운영 이력 조회에 실패했습니다.", detail: error.message }, 500);
  }

  const rows = (data || []).map((row) => ({
    action: row.action,
    actionLabel: auditActionLabel(row.action),
    targetTable: row.target_table || null,
    // metadata 는 기록 시점에 sanitizeAuditMetadata 로 걸러진 값이라 그대로 쓴다.
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at,
  }));

  // 화면 필터용 선택지는 이번에 내려간 기록에서만 뽑아 중복을 지운다.
  const options = new Map();
  for (const row of rows) {
    if (!row.action || options.has(row.action)) continue;
    options.set(row.action, { value: row.action, label: row.actionLabel || row.action });
  }
  const actionOptions = [...options.values()].sort((left, right) => left.label.localeCompare(right.label, "ko"));

  return json(request, {
    ok: true,
    view: "audit-logs",
    auditLogs: rows,
    actionOptions,
    // 정확히 limit 만큼 찼을 때만 다음 쪽이 있을 수 있다고 본다.
    nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null,
  });
}

async function createClient(request, ctx, body) {
  const name = String(body.name || body.clientName || body.client_name || "").trim();
  const businessName = String(body.businessName || body.business_name || name).trim();
  const agencyCode = normalizeAgencyCode(body.agencyCode || body.agency_code || body.code);

  if (!name) return json(request, { ok: false, message: "광고주명을 입력해주세요." }, 400);
  if (!agencyCode) return json(request, { ok: false, message: "생성할 광고주 코드를 직접 입력해주세요." }, 400);

  const existing = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .eq("agency_code", agencyCode)
    .maybeSingle();

  if (existing.error) {
    return json(request, { ok: false, message: "중복 코드 확인에 실패했습니다.", detail: existing.error.message }, 500);
  }
  if (existing.data) {
    if (existing.data.status === "active") {
      return json(request, { ok: false, message: "이미 활성화된 대행사 코드입니다.", client: clientPayload(existing.data) }, 409);
    }
    const { data, error } = await ctx.supabaseAdmin
      .from("clients")
      .update({
        name,
        business_name: businessName || name,
        status: "active",
        issued_by_team_code: null,
        disconnected_at: null,
        public_summary: body.publicSummary || body.public_summary || "총관리자가 재활성화한 광고주 코드입니다.",
        internal_note: "MI super admin reactivated client access",
      })
      .eq("id", existing.data.id)
      .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
      .single();
      if (error) {
        return json(request, { ok: false, message: "광고주 코드 재활성화에 실패했습니다.", detail: error.message }, 500);
      }
      // F16: 해지 때 자동 중지한 추적기만 되돌린다. 한도가 가득 차 되돌리지 못한
      // 행은 그 사유를 last_message 로 남기고 나머지는 계속 복구한다(부분 성공).
      const trackerRestore = await resumeAccountRankTrackers(ctx, [data.agency_code]);
      const auditLogged = await recordAuditLog(ctx, {
        action: "client.reactivated_by_owner",
        clientId: data.id,
        targetTable: "clients",
        targetId: data.id,
        metadata: {
          source: "super-admin-api",
          ownerAgencyCode: primaryAgencyCode(),
          agencyCode: data.agency_code,
          resumedTrackers: String(trackerRestore.resumed),
          limitedTrackers: String(trackerRestore.limited),
        },
      });
      return json(request, { ok: true, reactivated: true, client: clientPayload(data), trackerRestore, auditLogged }, 200);
    }

  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .insert({
      name,
      business_name: businessName || name,
      agency_code: agencyCode,
      status: "active",
      public_summary: body.publicSummary || body.public_summary || "총관리자가 발급한 광고주 코드입니다.",
      internal_note: "MI super admin issued client access",
    })
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .single();

    if (error) {
      return json(request, { ok: false, message: "광고주 코드 생성에 실패했습니다.", detail: error.message }, 500);
    }

    const auditLogged = await recordAuditLog(ctx, {
      action: "client.created_by_owner",
      clientId: data.id,
      targetTable: "clients",
      targetId: data.id,
      metadata: { source: "super-admin-api", ownerAgencyCode: primaryAgencyCode(), agencyCode: data.agency_code },
    });
    return json(request, { ok: true, client: clientPayload(data), auditLogged }, 201);
  }

async function createTeam(request, ctx, body) {
  const teamName = String(body.teamName || body.team_name || body.name || "").trim();
  const teamCode = normalizeAgencyCode(body.teamCode || body.team_code || body.code);
  if (!teamName) return json(request, { ok: false, message: "운영팀명을 입력해주세요." }, 400);
  if (!teamCode) return json(request, { ok: false, message: "생성할 운영팀 코드를 직접 입력해주세요." }, 400);
  const code = teamCode;

  const existing = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .eq("team_code", code)
    .eq("owner_agency_code", primaryAgencyCode())
    .maybeSingle();
  if (existing.error) return json(request, { ok: false, message: "운영팀 코드 중복 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (existing.data) {
    if (existing.data.status === "active") {
      return json(request, { ok: false, message: "이미 활성화된 운영팀 코드입니다.", team: teamPayload(existing.data) }, 409);
    }
    const { data, error } = await ctx.supabaseAdmin
      .from("operation_team_codes")
      .update({
        team_name: teamName,
        status: "active",
        client_id: null,
        revoked_at: null,
      })
      .eq("id", existing.data.id)
      .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
      .single();
      if (error) return json(request, { ok: false, message: "운영팀 코드 재활성화에 실패했습니다.", detail: error.message }, 500);
      // F16: 권한 해제 때 팀 코드로 자동 중지한 추적기를 되돌린다. 연결 광고주는
      // 해제 시 끊겼으므로(client_id = null) 여기서는 팀 코드만 복구한다.
      const trackerRestore = await resumeAccountRankTrackers(ctx, [data.team_code]);
      const auditLogged = await recordAuditLog(ctx, {
        action: "operation_team.reactivated",
        targetTable: "operation_team_codes",
        targetId: data.id,
        metadata: {
          source: "super-admin-api",
          ownerAgencyCode: primaryAgencyCode(),
          teamCode: data.team_code,
          teamName: data.team_name,
          resumedTrackers: String(trackerRestore.resumed),
          limitedTrackers: String(trackerRestore.limited),
        },
      });
      return json(request, { ok: true, reactivated: true, team: teamPayload(data), trackerRestore, auditLogged }, 200);
    }

  const { data, error } = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .insert({
      owner_agency_code: primaryAgencyCode(),
      team_name: teamName,
      team_code: code,
      status: "active",
    })
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .single();
    if (error) return json(request, { ok: false, message: "운영팀 코드 생성에 실패했습니다.", detail: error.message }, 500);
    const auditLogged = await recordAuditLog(ctx, {
      action: "operation_team.created",
      targetTable: "operation_team_codes",
      targetId: data.id,
      metadata: { source: "super-admin-api", ownerAgencyCode: primaryAgencyCode(), teamCode: data.team_code, teamName: data.team_name },
    });
    return json(request, { ok: true, team: teamPayload(data), auditLogged }, 201);
  }

async function validateTeam(request, ctx, body) {
  const access = teamActionAccess(request, body);
  if (!access.ok) return json(request, { ok: false, message: access.message }, access.status);
  const teamResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .eq("team_code", access.teamCode)
    .eq("owner_agency_code", primaryAgencyCode())
    .maybeSingle();
  if (teamResult.error) return json(request, { ok: false, message: "운영팀 코드 확인에 실패했습니다.", detail: teamResult.error.message }, 500);
  if (!teamResult.data || teamResult.data.status !== "active") return json(request, { ok: false, message: "활성 운영팀 코드가 아닙니다." }, 403);

  const teamWithClient = await attachTeamClient(ctx, teamResult.data);
  if (teamWithClient.error) return json(request, { ok: false, message: "운영팀 광고주 연결 조회에 실패했습니다.", detail: teamWithClient.error.message }, 500);

  return json(request, {
    ok: true,
    team: teamActionPayload(teamWithClient.team, access),
  });
}

async function createClientForTeam(request, ctx, body) {
  const name = String(body.clientName || body.client_name || body.name || "").trim();
  const businessName = String(body.businessName || body.business_name || name).trim();
  const agencyCode = normalizeAgencyCode(body.agencyCode || body.agency_code || body.code);
  if (!name) return json(request, { ok: false, message: "광고주명을 입력해주세요." }, 400);
  if (!agencyCode) return json(request, { ok: false, message: "생성할 광고주 코드를 직접 입력해주세요." }, 400);

  const access = teamActionAccess(request, body);
  if (!access.ok) return json(request, { ok: false, message: access.message }, access.status);
  const teamResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .eq("team_code", access.teamCode)
    .eq("owner_agency_code", primaryAgencyCode())
    .maybeSingle();
  if (teamResult.error) return json(request, { ok: false, message: "운영팀 코드 확인에 실패했습니다.", detail: teamResult.error.message }, 500);
  if (!teamResult.data || teamResult.data.status !== "active") return json(request, { ok: false, message: "활성 운영팀 코드가 아닙니다." }, 403);
  if (teamResult.data.client_id) return json(request, { ok: false, message: "이 운영팀에는 이미 광고주 1명이 연결되어 있습니다.", team: teamActionPayload(teamResult.data, access) }, 409);

  const teamCode = teamResult.data.team_code;

  const activeClient = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .eq("issued_by_team_code", teamCode)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (activeClient.error) return json(request, { ok: false, message: "운영팀 광고주 연결 상태 확인에 실패했습니다.", detail: activeClient.error.message }, 500);
  if (activeClient.data) return json(request, { ok: false, message: "이 운영팀에는 이미 활성 광고주가 연결되어 있습니다.", client: teamActionClientPayload(activeClient.data, access) }, 409);

  const existing = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .eq("agency_code", agencyCode)
    .maybeSingle();
  if (existing.error) return json(request, { ok: false, message: "광고주 코드 중복 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (existing.data) {
    // A team may create only a brand-new client credential. Reactivating or
    // reassigning an existing row would transfer that client's reports and
    // files across tenants. Only the owner flow may recover existing access.
    return json(request, { ok: false, message: "사용할 수 없는 광고주 코드입니다. 다른 코드를 발급해주세요." }, 409);
  }

  const clientMutation = ctx.supabaseAdmin
    .from("clients")
    .insert({
      name,
      business_name: businessName || name,
      agency_code: agencyCode,
      issued_by_team_code: teamResult.data.team_code,
      status: "active",
      public_summary: body.publicSummary || body.public_summary || "운영팀이 발급한 광고주 코드입니다.",
      internal_note: "Issued by authenticated operation team",
    });

  const { data: client, error: clientError } = await clientMutation
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .single();
  if (clientError) return json(request, { ok: false, message: "광고주 코드 생성에 실패했습니다.", detail: clientError.message }, 500);

  const { data: team, error: teamError } = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .update({ client_id: client.id })
    .eq("id", teamResult.data.id)
    .is("client_id", null)
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .single();
  if (teamError) {
    const cleanup = await ctx.supabaseAdmin
      .from("clients")
      .delete()
      .eq("id", client.id)
      .eq("issued_by_team_code", teamResult.data.team_code);
    return json(request, {
      ok: false,
      message: cleanup.error
        ? "운영팀 연결이 충돌했고 임시 광고주 정리가 필요합니다. 총관리자에게 문의해주세요."
        : "동시에 다른 연결이 처리되어 광고주 생성을 취소했습니다. 상태를 새로고침해주세요.",
      code: cleanup.error ? "TEAM_CLIENT_LINK_CLEANUP_REQUIRED" : "TEAM_CLIENT_LINK_CONFLICT",
    }, cleanup.error ? 500 : 409);
  }

    const auditLogged = await recordAuditLog(ctx, {
      action: "client.created_by_team",
      clientId: client.id,
      targetTable: "clients",
      targetId: client.id,
      metadata: {
        source: "super-admin-api",
        teamCode: teamResult.data.team_code,
        teamId: teamResult.data.id,
        agencyCode: client.agency_code,
      },
    });
    return json(request, {
      ok: true,
      reactivated: false,
      team: teamActionPayload({ ...team, clients: client }, access),
      client: teamActionClientPayload(client, access),
      auditLogged,
    }, 201);
  }

async function disconnectTeamClient(request, ctx, body) {
  const access = teamActionAccess(request, body);
  if (!access.ok) return json(request, { ok: false, message: access.message }, access.status);
  const teamResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .eq("team_code", access.teamCode)
    .eq("owner_agency_code", primaryAgencyCode())
    .maybeSingle();
  if (teamResult.error) return json(request, { ok: false, message: "운영팀 코드 확인에 실패했습니다.", detail: teamResult.error.message }, 500);
  if (!teamResult.data || teamResult.data.status !== "active") return json(request, { ok: false, message: "활성 운영팀 코드가 아닙니다." }, 403);
  if (!teamResult.data.client_id) return json(request, { ok: false, message: "해지할 광고주 연결이 없습니다." }, 404);

  const { data: client, error: clientError } = await ctx.supabaseAdmin
    .from("clients")
    .update({
      status: "paused",
      disconnected_at: new Date().toISOString(),
      public_summary: "운영팀 연결이 해지되어 광고주 접속이 중지되었습니다.",
    })
    .eq("id", teamResult.data.client_id)
    .eq("issued_by_team_code", teamResult.data.team_code)
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .single();
  if (clientError) return json(request, { ok: false, message: "광고주 코드 해지에 실패했습니다.", detail: clientError.message }, 500);

  const { data: team, error: teamError } = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .update({ client_id: null })
    .eq("id", teamResult.data.id)
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .single();
  if (teamError) return json(request, { ok: false, message: "운영팀 연결 해지 저장에 실패했습니다.", detail: teamError.message }, 500);

    // F16: 연결이 끊긴 광고주 코드의 추적기는 아무도 조회·중지할 수 없는데 수집
    // 명단에는 남는다. 그 코드의 활성 추적기를 자동 일시중지한다(팀 코드는 그대로
    // 활성이라 팀 화면에서 계속 보이므로 건드리지 않는다).
    const trackerSuspension = await pauseAccountRankTrackers(ctx, [client.agency_code]);
    const auditLogged = await recordAuditLog(ctx, {
      action: "operation_team.client_disconnected",
      clientId: client.id,
      targetTable: "clients",
      targetId: client.id,
      metadata: {
        source: "super-admin-api",
        teamCode: teamResult.data.team_code,
        teamId: teamResult.data.id,
        agencyCode: client.agency_code,
        pausedTrackers: String(trackerSuspension.paused),
        busyTrackers: String(trackerSuspension.busySkipped),
      },
    });
    return json(request, {
      ok: true,
      message: "운영팀과 광고주 연결을 해지했습니다. 광고주 코드는 더 이상 접속할 수 없습니다.",
      team: teamActionPayload(team, access),
      client: teamActionClientPayload(client, access),
      trackerSuspension,
      auditLogged,
    });
  }

async function revokeTeam(request, ctx, body) {
  const teamCode = requestTeamCode(request, body);
  if (!teamCode) return json(request, { ok: false, message: "권한 해제할 운영팀 코드를 입력해주세요." }, 400);

  const teamResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .eq("team_code", teamCode)
    .eq("owner_agency_code", primaryAgencyCode())
    .maybeSingle();
  if (teamResult.error) return json(request, { ok: false, message: "운영팀 코드 확인에 실패했습니다.", detail: teamResult.error.message }, 500);
  if (!teamResult.data) return json(request, { ok: false, message: "운영팀 코드를 찾을 수 없습니다." }, 404);
  if (teamResult.data.status !== "active") return json(request, { ok: false, message: "이미 해제된 운영팀 코드입니다." }, 409);

  const disconnectedAt = new Date().toISOString();
  let revokedClients = [];
  if (teamResult.data.client_id) {
    const clientResult = await ctx.supabaseAdmin
      .from("clients")
      .update({
        status: "paused",
        disconnected_at: disconnectedAt,
        public_summary: "운영팀 권한이 해제되어 광고주 접속이 중지되었습니다.",
      })
      .eq("id", teamResult.data.client_id)
      .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at");
    if (clientResult.error) return json(request, { ok: false, message: "연결 광고주 권한 해제에 실패했습니다.", detail: clientResult.error.message }, 500);
    revokedClients = clientResult.data || [];
  } else {
    const clientResult = await ctx.supabaseAdmin
      .from("clients")
      .update({
        status: "paused",
        disconnected_at: disconnectedAt,
        public_summary: "운영팀 권한이 해제되어 광고주 접속이 중지되었습니다.",
      })
      .eq("issued_by_team_code", teamResult.data.team_code)
      .eq("status", "active")
      .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at");
    if (clientResult.error) return json(request, { ok: false, message: "운영팀 광고주 권한 해제에 실패했습니다.", detail: clientResult.error.message }, 500);
    revokedClients = clientResult.data || [];
  }

  const { data: team, error: teamError } = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .update({ status: "revoked", revoked_at: disconnectedAt, client_id: null })
    .eq("id", teamResult.data.id)
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .single();
  if (teamError) return json(request, { ok: false, message: "운영팀 권한 해제 저장에 실패했습니다.", detail: teamError.message }, 500);

    // F16: 권한이 해제된 광고주 코드와 팀 코드 양쪽의 활성 추적기를 자동 중지한다.
    // 팀 코드로 등록된 추적기(F17 의 '연결 전 코드')는 권한 해제 뒤 누구의 화면에도
    // 뜨지 않으면서 수집만 계속되므로 여기서 함께 멈춘다.
    const trackerSuspension = await pauseAccountRankTrackers(ctx, [
      ...revokedClients.map((client) => client.agency_code),
      team.team_code,
    ]);
    const auditLogged = await recordAuditLog(ctx, {
      action: "operation_team.revoked",
      targetTable: "operation_team_codes",
      targetId: team.id,
      metadata: {
        source: "super-admin-api",
        teamCode: team.team_code,
        revokedClientIds: revokedClients.map((client) => client.id),
        revokedAgencyCodes: revokedClients.map((client) => client.agency_code),
        pausedTrackers: String(trackerSuspension.paused),
        busyTrackers: String(trackerSuspension.busySkipped),
      },
    });

    return json(request, {
      ok: true,
      message: "운영팀 권한을 해제했습니다. 연결된 광고주 코드는 더 이상 접속할 수 없습니다.",
      team: teamPayload(team),
      clients: revokedClients.map(clientPayload),
      trackerSuspension,
      auditLogged,
    });
  }

// ── 플랜·이용 기간 (대표 결정 2026-09-07) ─────────────────────────
function planSchemaPending(request) {
  return json(request, {
    ok: false,
    code: "PLAN_SCHEMA_PENDING",
    schemaPending: true,
    message: "이용 기간 DB 마이그레이션(20260907170000_account_plans.sql) 적용 전입니다. 적용 뒤 다시 시도해주세요.",
  }, 409);
}

function planExpiryText(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "무기한";
  return new Date(ms).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
}

// 이미 있는 계정을 고르는 조작(이용 기간·한도)은 옛 5자 코드(예: ofyou)도 받는다. 새 코드 발급 규칙(6자 이상,
// normalizeAgencyCode)은 그대로다. 2026-09-07 대표 보고: ofyou 계정에서 "광고주 코드를 입력해주세요" 가 떴다.
export function existingAccountCode(value) {
  const code = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.~!@#$^&*+=:-]{4,127}$/.test(code) ? code : "";
}

async function setPlan(request, ctx, body) {
  const agencyCode = existingAccountCode(body.agencyCode || body.agency_code || body.code);
  if (!agencyCode) return json(request, { ok: false, message: "이용 기간을 지정할 광고주 코드를 입력해주세요." }, 400);
  if (agencyCode === primaryAgencyCode()) {
    return json(request, { ok: false, message: "총관리자 코드는 기간 없이 사용합니다." }, 400);
  }
  const mode = String(body.mode || "extend").trim();
  if (!["extend", "set", "meta"].includes(mode)) return json(request, { ok: false, message: "지원하지 않는 기간 작업입니다." }, 400);

  const existing = await ctx.supabaseAdmin.from("clients").select(CLIENT_PLAN_SELECT).eq("agency_code", agencyCode).maybeSingle();
  if (existing.error) {
    if (isMissingPlanSchema(existing.error)) return planSchemaPending(request);
    return json(request, { ok: false, message: "광고주 조회에 실패했습니다.", detail: existing.error.message }, 500);
  }
  if (!existing.data) return json(request, { ok: false, message: "등록된 광고주 코드를 찾을 수 없습니다." }, 404);

  const nowIso = new Date().toISOString();
  const update = { plan_updated_at: nowIso };
  const planName = normalizePlanName(body.planName ?? body.plan_name);
  if (planName) update.plan_name = planName;
  const rawDays = body.planDays ?? body.plan_days;
  if (rawDays !== undefined && rawDays !== null && String(rawDays).trim() !== "") {
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return json(request, { ok: false, message: "기간은 1~3650일 사이의 정수로 입력해주세요." }, 400);
    }
    update.plan_days = days;
  }
  if (body.planNote !== undefined) update.plan_note = String(body.planNote || "").trim().slice(0, 500) || null;
  if (mode === "set") {
    const iso = expiryFromDate(body.expiresAt ?? body.expires_at);
    if (!iso) return json(request, { ok: false, message: "만료일은 YYYY-MM-DD 형식으로 입력해주세요." }, 400);
    update.plan_expires_at = iso;
  } else if (mode === "extend") {
    const days = update.plan_days ?? normalizePlanDays(existing.data.plan_days, PLAN_DEFAULT_DAYS);
    update.plan_expires_at = extendedExpiry(existing.data, days);
  }
  if (!existing.data.plan_started_at && update.plan_expires_at) update.plan_started_at = nowIso;
  // 총관리자가 기간을 다시 정하면 크론의 자동 메모(구글 미연동 · 자동 만료 등)는 지운다 — 유예 3일 판정·카드 문구가 새 기간에 따라오면 안 된다.
  if (update.plan_note === undefined && update.plan_expires_at && isAutomaticPlanNote(existing.data.plan_note)) update.plan_note = null;

  const updated = await ctx.supabaseAdmin.from("clients").update(update).eq("id", existing.data.id).select(CLIENT_PLAN_SELECT).single();
  if (updated.error) {
    if (isMissingPlanSchema(updated.error)) return planSchemaPending(request);
    return json(request, { ok: false, message: "이용 기간 저장에 실패했습니다.", detail: updated.error.message }, 500);
  }
  const auditLogged = await recordAuditLog(ctx, {
    action: "client.plan_updated",
    clientId: updated.data.id,
    targetTable: "clients",
    targetId: updated.data.id,
    metadata: {
      source: "super-admin-api",
      agencyCode: updated.data.agency_code,
      mode,
      planName: updated.data.plan_name || "",
      planDays: String(updated.data.plan_days ?? ""),
      expiresAt: updated.data.plan_expires_at || "",
    },
  });
  const message = mode === "meta"
    ? "플랜 정보를 저장했습니다."
    : `이용 기간을 ${planExpiryText(updated.data.plan_expires_at)}까지로 저장했습니다.`;
  return json(request, { ok: true, message, client: clientPayload(updated.data), auditLogged });
}

async function clearPlan(request, ctx, body) {
  const agencyCode = existingAccountCode(body.agencyCode || body.agency_code || body.code);
  if (!agencyCode) return json(request, { ok: false, message: "광고주 코드를 입력해주세요." }, 400);
  const updated = await ctx.supabaseAdmin
    .from("clients")
    // 무기한으로 돌리면 크론의 자동 메모도 함께 지운다(총관리자가 직접 쓰는 메모 UI 는 없다).
    .update({ plan_expires_at: null, plan_started_at: null, plan_note: null, plan_updated_at: new Date().toISOString() })
    .eq("agency_code", agencyCode)
    .select(CLIENT_PLAN_SELECT)
    .maybeSingle();
  if (updated.error) {
    if (isMissingPlanSchema(updated.error)) return planSchemaPending(request);
    return json(request, { ok: false, message: "이용 기간 해제에 실패했습니다.", detail: updated.error.message }, 500);
  }
  if (!updated.data) return json(request, { ok: false, message: "등록된 광고주 코드를 찾을 수 없습니다." }, 404);
  const auditLogged = await recordAuditLog(ctx, {
    action: "client.plan_cleared",
    clientId: updated.data.id,
    targetTable: "clients",
    targetId: updated.data.id,
    metadata: { source: "super-admin-api", agencyCode: updated.data.agency_code },
  });
  return json(request, { ok: true, message: "이용 기간을 해제해 무기한으로 두었습니다.", client: clientPayload(updated.data), auditLogged });
}

// 체험 계정용 무작위 코드. 구글 로그인이 그대로 이어지므로 고객이 외울 필요는 없지만, 코드 로그인도
// 가능한 자격이라 추측 불가능해야 한다(12자, 헷갈리는 글자 제외).
function generateAgencyCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(12);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

async function openTrial(request, ctx, body) {
  const googleSub = String(body.googleSub || body.google_sub || "").trim().slice(0, 128);
  const name = String(body.name || body.clientName || "").trim();
  if (!googleSub) return json(request, { ok: false, message: "전환할 체험 계정을 선택해주세요." }, 400);
  if (!name) return json(request, { ok: false, message: "광고주명을 입력해주세요." }, 400);
  // "무기한" 선택(2026-09-07 대표 요청): 만료일 없이 오픈한다. planDays 가 "unlimited" 이거나 unlimited=true.
  const unlimited = body.unlimited === true || String(body.planDays ?? body.plan_days ?? "").trim().toLowerCase() === "unlimited";
  const planDays = unlimited ? null : normalizePlanDays(body.planDays ?? body.plan_days, PLAN_DEFAULT_DAYS);
  const planName = normalizePlanName(body.planName ?? body.plan_name) || "basic";
  let rankKeywordLimit = null;
  if (body.rankKeywordLimit !== undefined && body.rankKeywordLimit !== null && String(body.rankKeywordLimit).trim() !== "") {
    const parsed = parseRankKeywordLimitInput(body.rankKeywordLimit);
    if (!parsed.ok) return json(request, { ok: false, message: parsed.message }, 400);
    rankKeywordLimit = parsed.limit;
  }

  const identity = await ctx.supabaseAdmin
    .from("login_identities")
    .select("google_sub, google_email, role, code")
    .eq("google_sub", googleSub)
    .maybeSingle();
  if (identity.error) return json(request, { ok: false, message: "체험 계정 조회에 실패했습니다.", detail: identity.error.message }, 500);
  if (!identity.data || identity.data.role !== "trial") {
    return json(request, { ok: false, message: "체험 계정을 찾을 수 없습니다. 이미 전환됐거나 삭제된 계정입니다." }, 404);
  }

  let agencyCode = "";
  for (let attempt = 0; attempt < 3 && !agencyCode; attempt += 1) {
    const candidate = normalizeAgencyCode(generateAgencyCode());
    const clash = await ctx.supabaseAdmin.from("clients").select("id").eq("agency_code", candidate).maybeSingle();
    if (clash.error) return json(request, { ok: false, message: "코드 중복 확인에 실패했습니다.", detail: clash.error.message }, 500);
    if (!clash.data) agencyCode = candidate;
  }
  if (!agencyCode) return json(request, { ok: false, message: "코드 생성에 실패했습니다. 다시 시도해주세요." }, 500);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const inserted = await ctx.supabaseAdmin
    .from("clients")
    .insert({
      name,
      business_name: String(body.businessName || body.business_name || name).trim() || name,
      agency_code: agencyCode,
      status: "active",
      public_summary: "무료 체험에서 전환한 광고주입니다.",
      internal_note: "MI super admin opened from trial",
      rank_keyword_limit: rankKeywordLimit,
      plan_name: planName,
      plan_days: planDays,
      plan_started_at: unlimited ? null : nowIso,
      plan_expires_at: unlimited ? null : new Date(nowMs + planDays * 24 * 60 * 60 * 1000).toISOString(),
      plan_note: String(body.planNote || "").trim().slice(0, 500) || null,
      plan_updated_at: nowIso,
    })
    .select(CLIENT_PLAN_SELECT)
    .single();
  if (inserted.error) {
    if (isMissingPlanSchema(inserted.error)) return planSchemaPending(request);
    return json(request, { ok: false, message: "광고주 생성에 실패했습니다.", detail: inserted.error.message }, 500);
  }

  // 구글 연결을 새 광고주 코드로 옮긴다. 이 순간부터 같은 구글 계정 로그인이 정식 광고주 세션이 된다.
  const relinked = await ctx.supabaseAdmin
    .from("login_identities")
    .update({ role: "client", code: agencyCode, updated_at: nowIso })
    .eq("google_sub", googleSub)
    .eq("role", "trial");
  if (relinked.error) {
    await ctx.supabaseAdmin.from("clients").delete().eq("id", inserted.data.id);
    return json(request, { ok: false, message: "구글 연결 이동에 실패해 전환을 되돌렸습니다.", detail: relinked.error.message }, 500);
  }

  const auditLogged = await recordAuditLog(ctx, {
    action: "client.created_from_trial",
    clientId: inserted.data.id,
    targetTable: "clients",
    targetId: inserted.data.id,
    metadata: {
      source: "super-admin-api",
      agencyCode,
      googleEmail: identity.data.google_email || "",
      planName,
      planDays: unlimited ? "unlimited" : String(planDays),
      rankKeywordLimit: rankKeywordLimit === null ? "default" : String(rankKeywordLimit),
    },
  });
  return json(request, {
    ok: true,
    message: `체험 계정을 정식 광고주로 전환했습니다(코드 ${agencyCode}, ${unlimited ? "무기한" : `${planExpiryText(inserted.data.plan_expires_at)}까지`}). 구글 로그인은 그대로 됩니다.`,
    client: { ...clientPayload(inserted.data), googleEmail: identity.data.google_email || null },
    auditLogged,
  });
}

async function setRankKeywordLimit(request, ctx, body) {
  // 옛 5자 광고주 코드에도 한도를 저장할 수 있어야 한다(이용 기간과 같은 결함, 2026-09-07).
  const agencyCode = existingAccountCode(
    body.agencyCode || body.agency_code || body.code || body.teamCode || body.team_code,
  );
  if (!agencyCode) return json(request, { ok: false, message: "한도를 지정할 코드를 입력해주세요." }, 400);
  if (agencyCode === primaryAgencyCode()) {
    return json(request, { ok: false, message: "총관리자 코드는 한도 없이 사용합니다." }, 400);
  }

  const parsed = parseRankKeywordLimitInput(
    body.rankKeywordLimit !== undefined ? body.rankKeywordLimit : body.rank_keyword_limit,
  );
  if (!parsed.ok) return json(request, { ok: false, message: parsed.message }, 400);

  const savedMessage = parsed.limit === null
    ? `키워드 한도를 기본값 ${DEFAULT_RANK_KEYWORD_LIMIT}개로 되돌렸습니다.`
    : `키워드 한도를 ${parsed.limit}개로 저장했습니다.`;
  const schemaPending = () => json(request, {
    ok: false,
    code: "RANK_KEYWORD_LIMIT_SCHEMA_PENDING",
    schemaPending: true,
    message: "키워드 한도 DB 마이그레이션 적용 전입니다. 마이그레이션을 적용한 뒤 다시 시도해주세요.",
  }, 409);

  const clientUpdate = await ctx.supabaseAdmin
    .from("clients")
    .update({ rank_keyword_limit: parsed.limit })
    .eq("agency_code", agencyCode)
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at, rank_keyword_limit")
    .maybeSingle();

  if (clientUpdate.error) {
    if (isMissingRankKeywordLimitSchema(clientUpdate.error)) return schemaPending();
    return json(request, { ok: false, message: "키워드 한도 저장에 실패했습니다.", detail: clientUpdate.error.message }, 500);
  }

  if (clientUpdate.data) {
    const auditLogged = await recordAuditLog(ctx, {
      action: "client.rank_keyword_limit_updated",
      clientId: clientUpdate.data.id,
      targetTable: "clients",
      targetId: clientUpdate.data.id,
      metadata: {
        source: "super-admin-api",
        agencyCode: clientUpdate.data.agency_code,
        rankKeywordLimit: parsed.limit === null ? "default" : String(parsed.limit),
      },
    });
    return json(request, { ok: true, message: savedMessage, client: clientPayload(clientUpdate.data), auditLogged });
  }

  const teamUpdate = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .update({ rank_keyword_limit: parsed.limit })
    .eq("team_code", agencyCode)
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at, rank_keyword_limit")
    .maybeSingle();

  if (teamUpdate.error) {
    if (isMissingRankKeywordLimitSchema(teamUpdate.error)) return schemaPending();
    return json(request, { ok: false, message: "키워드 한도 저장에 실패했습니다.", detail: teamUpdate.error.message }, 500);
  }
  if (!teamUpdate.data) {
    return json(request, { ok: false, message: "등록된 광고주 코드나 운영팀 코드를 찾을 수 없습니다." }, 404);
  }

  const auditLogged = await recordAuditLog(ctx, {
    action: "team.rank_keyword_limit_updated",
    clientId: teamUpdate.data.client_id || null,
    targetTable: "operation_team_codes",
    targetId: teamUpdate.data.id,
    metadata: {
      source: "super-admin-api",
      teamCode: teamUpdate.data.team_code,
      rankKeywordLimit: parsed.limit === null ? "default" : String(parsed.limit),
    },
  });
  return json(request, { ok: true, message: savedMessage, team: teamPayload({ ...teamUpdate.data, clients: null }), auditLogged });
}

async function revokeClient(request, ctx, body) {
  const agencyCode = existingAccountCode(body.agencyCode || body.agency_code || body.code);
  if (!agencyCode) return json(request, { ok: false, message: "권한 해제할 광고주 코드를 입력해주세요." }, 400);

  const clientResult = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .eq("agency_code", agencyCode)
    .maybeSingle();
  if (clientResult.error) return json(request, { ok: false, message: "광고주 코드 확인에 실패했습니다.", detail: clientResult.error.message }, 500);
  if (!clientResult.data) return json(request, { ok: false, message: "광고주 코드를 찾을 수 없습니다." }, 404);
  if (clientResult.data.status !== "active") return json(request, { ok: false, message: "이미 비활성화된 광고주 코드입니다." }, 409);

  const disconnectedAt = new Date().toISOString();
  const { data: client, error: clientError } = await ctx.supabaseAdmin
    .from("clients")
    .update({
      status: "paused",
      disconnected_at: disconnectedAt,
      public_summary: "관리자 권한 해제로 광고주 접속이 중지되었습니다.",
    })
    .eq("id", clientResult.data.id)
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .single();
  if (clientError) return json(request, { ok: false, message: "광고주 권한 해제에 실패했습니다.", detail: clientError.message }, 500);

  let team = null;
  if (clientResult.data.issued_by_team_code) {
    const teamResult = await ctx.supabaseAdmin
      .from("operation_team_codes")
      .update({ client_id: null })
      .eq("team_code", clientResult.data.issued_by_team_code)
      .eq("owner_agency_code", primaryAgencyCode())
      .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
      .maybeSingle();
    if (teamResult.error) return json(request, { ok: false, message: "운영팀 연결 정리에 실패했습니다.", detail: teamResult.error.message }, 500);
    team = teamResult.data ? teamPayload(teamResult.data) : null;
  }

    // F16: 권한이 해제된 광고주 코드의 활성 추적기를 자동 일시중지한다.
    const trackerSuspension = await pauseAccountRankTrackers(ctx, [client.agency_code]);
    const auditLogged = await recordAuditLog(ctx, {
      action: "client.revoked",
      clientId: client.id,
      targetTable: "clients",
      targetId: client.id,
      metadata: {
        source: "super-admin-api",
        agencyCode: client.agency_code,
        issuedByTeamCode: client.issued_by_team_code || null,
        pausedTrackers: String(trackerSuspension.paused),
        busyTrackers: String(trackerSuspension.busySkipped),
      },
    });

    return json(request, {
      ok: true,
      message: "광고주 권한을 해제했습니다. 해당 코드는 더 이상 접속할 수 없습니다.",
      client: clientPayload(client),
      team,
      trackerSuspension,
      auditLogged,
    });
  }

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, {
          methods: "GET, POST, OPTIONS",
          headers: "content-type, x-mi-super-admin-code, x-mi-owner-agency-code, x-mi-team-code",
        }),
      });
    }

    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    const url = new URL(request.url);
    const isOwnerPath = url.pathname === "/api/super-admin/agency-codes" || url.pathname === "/api/super-admin-agency-codes";
    const isTeamPath = url.pathname === "/api/team/agency-codes" || url.pathname === "/api/team-agency-codes";
    if (!isOwnerPath && !isTeamPath) {
      return json(request, { ok: false, message: "Not found" }, 404);
    }

    const rate = checkAdminRateLimit(request);
    if (!rate.allowed) {
      return json(request, {
        ok: false,
        code: "ADMIN_CODE_RATE_LIMITED",
        message: "코드 관리 요청이 많습니다. 잠시 후 다시 시도해주세요.",
        retryAfter: rate.retryAfter,
      }, 429);
    }

    if (request.method === "GET") {
      const ownerAuth = ownerActionAuthorized(request, body);
      if (!ownerAuth.ok) return json(request, { ok: false, message: ownerAuth.message }, ownerAuth.status);
      // 총관리자 확인을 통과한 뒤에만 운영 이력을 연다(운영팀·광고주는 여기까지 못 온다).
      if (url.searchParams.get("view") === "audit-logs") return listAuditLogs(request, ctx, url);
      // 오늘 현황(대표 지시 2026-09-07): 방문·가입 클릭·문의 클릭·체험 가입·로그인 계정, 오늘과 어제.
      if (url.searchParams.get("view") === "site-summary") return json(request, await siteSummary(ctx));
      return listClients(request, ctx);
    }
    if (request.method === "POST") {
      const action = String(body.action || "create-team").trim();
      if (["create-team", "create-client", "revoke-team", "revoke-client", "set-rank-keyword-limit", "set-plan", "clear-plan", "open-trial"].includes(action)) {
        const ownerAuth = ownerActionAuthorized(request, body);
        if (!ownerAuth.ok) return json(request, { ok: false, message: ownerAuth.message }, ownerAuth.status);
        if (action === "create-team") return createTeam(request, ctx, body);
        if (action === "create-client") return createClient(request, ctx, body);
        if (action === "revoke-team") return revokeTeam(request, ctx, body);
        if (action === "set-rank-keyword-limit") return setRankKeywordLimit(request, ctx, body);
        if (action === "set-plan") return setPlan(request, ctx, body);
        if (action === "clear-plan") return clearPlan(request, ctx, body);
        if (action === "open-trial") return openTrial(request, ctx, body);
        return revokeClient(request, ctx, body);
      }
      if (isTeamPath && action === "validate-team") return validateTeam(request, ctx, body);
      if (isTeamPath && action === "create-client-for-team") return createClientForTeam(request, ctx, body);
      if (isTeamPath && action === "disconnect-team-client") return disconnectTeamClient(request, ctx, body);
      return json(request, { ok: false, message: "지원하지 않는 코드 작업입니다." }, 400);
    }
    return json(request, { ok: false, message: "Method not allowed" }, 405);
  }),
};

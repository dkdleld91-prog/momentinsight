import { withSupabase } from "@supabase/server";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { corsHeaders, isLocalRequest, protectedJson, safeEqual } from "../security.mjs";
import {
  DEFAULT_RANK_KEYWORD_LIMIT,
  isMissingRankKeywordLimitSchema,
  parseRankKeywordLimitInput,
} from "../rank-keyword-limit.mjs";

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
// 운영팀 열조차 없던 아주 오래된 DB 를 위한 최소 열(마지막 수단).
const CLIENT_BASE_SELECT = "id, name, business_name, agency_code, status, public_summary, created_at, updated_at";

async function selectClients(ctx) {
  const query = (columns) => ctx.supabaseAdmin
    .from("clients")
    .select(columns)
    .neq("status", "archived")
    .order("created_at", { ascending: true })
    .limit(100);

  let result = await query(CLIENT_FULL_SELECT);
  if (!result.error || !isMissingClientSchema(result.error)) return result;

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

async function loadOwnerHealth(ctx) {
  const nowIso = new Date().toISOString();
  const [
    activeClients,
    activeTeams,
    dueTrackers,
    failedTrackers,
    sourceFiles,
    publicReports,
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
    safeCount(ctx.supabaseAdmin
      .from("files")
      .select("id", { count: "exact", head: true })
      .is("report_id", null)
      .like("title", "원천 파일%")),
    safeCount(ctx.supabaseAdmin
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("visibility", "client_visible")),
  ]);

  return {
    checkedAt: nowIso,
    activeClients,
    activeTeams,
    dueTrackers,
    failedTrackers,
    sourceFiles,
    publicReports,
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

  return json(request, {
    ok: true,
    schemaPending: Boolean(clientsResult.schemaPending || teamsResult.schemaPending),
    ownerAgencyCode: primaryAgencyCode(),
    health: await loadOwnerHealth(ctx),
    teams: (teamsResult.data || []).map((team) => ({
      ...team,
      clients: (clientsResult.data || []).find((client) => client.id === team.client_id) || null,
    })).map(teamPayload),
    clients: (clientsResult.data || []).map(clientPayload),
  });
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
      const auditLogged = await recordAuditLog(ctx, {
        action: "client.reactivated_by_owner",
        clientId: data.id,
        targetTable: "clients",
        targetId: data.id,
        metadata: { source: "super-admin-api", ownerAgencyCode: primaryAgencyCode(), agencyCode: data.agency_code },
      });
      return json(request, { ok: true, reactivated: true, client: clientPayload(data), auditLogged }, 200);
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
      const auditLogged = await recordAuditLog(ctx, {
        action: "operation_team.reactivated",
        targetTable: "operation_team_codes",
        targetId: data.id,
        metadata: { source: "super-admin-api", ownerAgencyCode: primaryAgencyCode(), teamCode: data.team_code, teamName: data.team_name },
      });
      return json(request, { ok: true, reactivated: true, team: teamPayload(data), auditLogged }, 200);
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

    const auditLogged = await recordAuditLog(ctx, {
      action: "operation_team.client_disconnected",
      clientId: client.id,
      targetTable: "clients",
      targetId: client.id,
      metadata: { source: "super-admin-api", teamCode: teamResult.data.team_code, teamId: teamResult.data.id, agencyCode: client.agency_code },
    });
    return json(request, {
      ok: true,
      message: "운영팀과 광고주 연결을 해지했습니다. 광고주 코드는 더 이상 접속할 수 없습니다.",
      team: teamActionPayload(team, access),
      client: teamActionClientPayload(client, access),
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

    const auditLogged = await recordAuditLog(ctx, {
      action: "operation_team.revoked",
      targetTable: "operation_team_codes",
      targetId: team.id,
      metadata: {
        source: "super-admin-api",
        teamCode: team.team_code,
        revokedClientIds: revokedClients.map((client) => client.id),
        revokedAgencyCodes: revokedClients.map((client) => client.agency_code),
      },
    });

    return json(request, {
      ok: true,
      message: "운영팀 권한을 해제했습니다. 연결된 광고주 코드는 더 이상 접속할 수 없습니다.",
      team: teamPayload(team),
      clients: revokedClients.map(clientPayload),
      auditLogged,
    });
  }

async function setRankKeywordLimit(request, ctx, body) {
  const agencyCode = normalizeAgencyCode(
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
  const agencyCode = normalizeAgencyCode(body.agencyCode || body.agency_code || body.code);
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

    const auditLogged = await recordAuditLog(ctx, {
      action: "client.revoked",
      clientId: client.id,
      targetTable: "clients",
      targetId: client.id,
      metadata: { source: "super-admin-api", agencyCode: client.agency_code, issuedByTeamCode: client.issued_by_team_code || null },
    });

    return json(request, {
      ok: true,
      message: "광고주 권한을 해제했습니다. 해당 코드는 더 이상 접속할 수 없습니다.",
      client: clientPayload(client),
      team,
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
      return listClients(request, ctx);
    }
    if (request.method === "POST") {
      const action = String(body.action || "create-team").trim();
      if (["create-team", "create-client", "revoke-team", "revoke-client", "set-rank-keyword-limit"].includes(action)) {
        const ownerAuth = ownerActionAuthorized(request, body);
        if (!ownerAuth.ok) return json(request, { ok: false, message: ownerAuth.message }, ownerAuth.status);
        if (action === "create-team") return createTeam(request, ctx, body);
        if (action === "create-client") return createClient(request, ctx, body);
        if (action === "revoke-team") return revokeTeam(request, ctx, body);
        if (action === "set-rank-keyword-limit") return setRankKeywordLimit(request, ctx, body);
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

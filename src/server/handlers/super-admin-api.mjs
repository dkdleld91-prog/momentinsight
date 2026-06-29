import { withSupabase } from "@supabase/server";
import { corsHeaders, isLocalRequest, protectedJson, safeEqual } from "../security.mjs";

const ADMIN_RATE_WINDOW_MS = Number(process.env.MI_ADMIN_CODE_RATE_WINDOW_MS || 60_000);
const ADMIN_RATE_LIMIT = Number(process.env.MI_ADMIN_CODE_RATE_LIMIT || 40);
const adminRateBucket = new Map();

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "content-type, x-mi-super-admin-code, x-mi-owner-agency-code, x-mi-team-code",
  });
}

function normalizeAgencyCode(value) {
  return String(value || "").trim().toLowerCase();
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function nextAgencyCode(rows) {
  const max = (rows || []).reduce((latest, row) => {
    const match = String(row.agency_code || "").toLowerCase().match(/^mml93-a(\d+)$/);
    if (!match) return latest;
    return Math.max(latest, Number(match[1]) || 0);
  }, 0);
  return `mml93-a${String(Math.max(2, max + 1)).padStart(2, "0")}`;
}

function nextTeamCode(rows) {
  const max = (rows || []).reduce((latest, row) => {
    const match = String(row.team_code || "").toLowerCase().match(/^mml93-t(\d+)$/);
    if (!match) return latest;
    return Math.max(latest, Number(match[1]) || 0);
  }, 0);
  return `mml93-t${String(Math.max(1, max + 1)).padStart(2, "0")}`;
}

function isMissingTeamSchema(error) {
  return /operation_team_codes|issued_by_team_code|disconnected_at|schema cache|does not exist/i.test(error?.message || "");
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
      metadata: payload.metadata || {},
    });

  return !error;
}

async function nextAgencyCodeFromDb(ctx) {
  const list = await ctx.supabaseAdmin
    .from("clients")
    .select("agency_code")
    .neq("status", "archived")
    .limit(100);
  return list.error ? { error: list.error } : { code: nextAgencyCode(list.data || []) };
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
      .ilike("issued_by_team_code", team.team_code)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (result.error) return { error: result.error };
    client = result.data || null;
  }

  return { team: { ...team, clients: client } };
}

async function selectClients(ctx) {
  const fullSelect = "id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at";
  const baseSelect = "id, name, business_name, agency_code, status, public_summary, created_at, updated_at";
  let result = await ctx.supabaseAdmin
    .from("clients")
    .select(fullSelect)
    .neq("status", "archived")
    .order("created_at", { ascending: true })
    .limit(100);

  if (result.error && isMissingTeamSchema(result.error)) {
    result = await ctx.supabaseAdmin
      .from("clients")
      .select(baseSelect)
      .neq("status", "archived")
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

  const teamsResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .eq("owner_agency_code", primaryAgencyCode())
    .order("created_at", { ascending: true })
    .limit(100);

  if (teamsResult.error) {
    if (isMissingTeamSchema(teamsResult.error)) {
      return json(request, {
        ok: true,
        schemaPending: true,
        message: "운영팀 코드 DB 마이그레이션 적용 전입니다. 기존 광고주 코드는 조회됩니다.",
        ownerAgencyCode: primaryAgencyCode(),
        nextTeamCode: "mml93-t01",
        nextAgencyCode: nextAgencyCode(clientsResult.data || []),
        teams: [],
        clients: (clientsResult.data || []).map(clientPayload),
      });
    }
    return json(request, { ok: false, message: "운영팀 코드 목록 조회에 실패했습니다.", detail: teamsResult.error.message }, 500);
  }

  return json(request, {
    ok: true,
    schemaPending: Boolean(clientsResult.schemaPending),
    ownerAgencyCode: primaryAgencyCode(),
    nextTeamCode: nextTeamCode(teamsResult.data || []),
    nextAgencyCode: nextAgencyCode(clientsResult.data || []),
    health: await loadOwnerHealth(ctx),
    teams: (teamsResult.data || []).map((team) => ({
      ...team,
      clients: (clientsResult.data || []).find((client) => client.id === team.client_id) || null,
    })).map(teamPayload),
    clients: (clientsResult.data || []).map(clientPayload),
  });
}

async function createClient(request, ctx, body) {
  const name = String(body.name || body.clientName || body.client_name || "").trim();
  const businessName = String(body.businessName || body.business_name || name).trim();
  const agencyCode = normalizeAgencyCode(body.agencyCode || body.agency_code || body.code);

  if (!name) return json(request, { ok: false, message: "광고주명을 입력해주세요." }, 400);

  let code = agencyCode;
  if (!code) {
    const list = await ctx.supabaseAdmin
    .from("clients")
    .select("agency_code")
    .neq("status", "archived")
    .limit(100);
    if (list.error) {
      return json(request, { ok: false, message: "다음 코드 계산에 실패했습니다.", detail: list.error.message }, 500);
    }
    code = nextAgencyCode(list.data || []);
  }

  const existing = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .ilike("agency_code", code)
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
        internal_note: `MI super admin reactivated client code from ${primaryAgencyCode()}`,
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
      agency_code: code,
      status: "active",
      public_summary: body.publicSummary || body.public_summary || "총관리자가 발급한 광고주 코드입니다.",
      internal_note: `MI super admin issued client code from ${primaryAgencyCode()}`,
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

  let code = teamCode;
  if (!code) {
    const list = await ctx.supabaseAdmin
      .from("operation_team_codes")
      .select("team_code")
      .eq("owner_agency_code", primaryAgencyCode())
      .limit(100);
    if (list.error) return json(request, { ok: false, message: "다음 운영팀 코드 계산에 실패했습니다.", detail: list.error.message }, 500);
    code = nextTeamCode(list.data || []);
  }

  const existing = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .ilike("team_code", code)
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
  const teamCode = requestTeamCode(request, body);
  if (!teamCode) return json(request, { ok: false, message: "운영팀 코드를 입력해주세요." }, 400);

  const teamResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .ilike("team_code", teamCode)
    .eq("owner_agency_code", primaryAgencyCode())
    .maybeSingle();
  if (teamResult.error) return json(request, { ok: false, message: "운영팀 코드 확인에 실패했습니다.", detail: teamResult.error.message }, 500);
  if (!teamResult.data || teamResult.data.status !== "active") return json(request, { ok: false, message: "활성 운영팀 코드가 아닙니다." }, 403);

  const teamWithClient = await attachTeamClient(ctx, teamResult.data);
  if (teamWithClient.error) return json(request, { ok: false, message: "운영팀 광고주 연결 조회에 실패했습니다.", detail: teamWithClient.error.message }, 500);

  const nextCode = await nextAgencyCodeFromDb(ctx);
  if (nextCode.error) return json(request, { ok: false, message: "다음 광고주 코드 계산에 실패했습니다.", detail: nextCode.error.message }, 500);

  return json(request, {
    ok: true,
    team: teamPayload(teamWithClient.team),
    nextAgencyCode: nextCode.code,
  });
}

async function createClientForTeam(request, ctx, body) {
  const teamCode = requestTeamCode(request, body);
  const name = String(body.clientName || body.client_name || body.name || "").trim();
  const businessName = String(body.businessName || body.business_name || name).trim();
  const agencyCode = normalizeAgencyCode(body.agencyCode || body.agency_code || body.code);
  if (!teamCode) return json(request, { ok: false, message: "운영팀 코드를 입력해주세요." }, 400);
  if (!name) return json(request, { ok: false, message: "광고주명을 입력해주세요." }, 400);

  const teamResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .ilike("team_code", teamCode)
    .eq("owner_agency_code", primaryAgencyCode())
    .maybeSingle();
  if (teamResult.error) return json(request, { ok: false, message: "운영팀 코드 확인에 실패했습니다.", detail: teamResult.error.message }, 500);
  if (!teamResult.data || teamResult.data.status !== "active") return json(request, { ok: false, message: "활성 운영팀 코드가 아닙니다." }, 403);
  if (teamResult.data.client_id) return json(request, { ok: false, message: "이 운영팀에는 이미 광고주 1명이 연결되어 있습니다.", team: teamPayload(teamResult.data) }, 409);

  const activeClient = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .ilike("issued_by_team_code", teamCode)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (activeClient.error) return json(request, { ok: false, message: "운영팀 광고주 연결 상태 확인에 실패했습니다.", detail: activeClient.error.message }, 500);
  if (activeClient.data) return json(request, { ok: false, message: "이 운영팀에는 이미 활성 광고주가 연결되어 있습니다.", client: clientPayload(activeClient.data) }, 409);

  let code = agencyCode;
  if (!code) {
    const list = await ctx.supabaseAdmin
      .from("clients")
      .select("agency_code")
      .neq("status", "archived")
      .limit(100);
    if (list.error) return json(request, { ok: false, message: "다음 광고주 코드 계산에 실패했습니다.", detail: list.error.message }, 500);
    code = nextAgencyCode(list.data || []);
  }

  const existing = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .ilike("agency_code", code)
    .maybeSingle();
  if (existing.error) return json(request, { ok: false, message: "광고주 코드 중복 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (existing.data && existing.data.status === "active") {
    return json(request, { ok: false, message: "이미 활성화된 광고주 코드입니다.", client: clientPayload(existing.data) }, 409);
  }

  const clientMutation = existing.data
    ? ctx.supabaseAdmin
      .from("clients")
      .update({
        name,
        business_name: businessName || name,
        issued_by_team_code: teamResult.data.team_code,
        status: "active",
        disconnected_at: null,
        public_summary: body.publicSummary || body.public_summary || "운영팀이 재활성화한 광고주 코드입니다.",
        internal_note: `Reissued by operation team ${teamResult.data.team_code}`,
      })
      .eq("id", existing.data.id)
    : ctx.supabaseAdmin
      .from("clients")
      .insert({
        name,
        business_name: businessName || name,
        agency_code: code,
        issued_by_team_code: teamResult.data.team_code,
        status: "active",
        public_summary: body.publicSummary || body.public_summary || "운영팀이 발급한 광고주 코드입니다.",
        internal_note: `Issued by operation team ${teamResult.data.team_code}`,
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
  if (teamError) return json(request, { ok: false, message: "운영팀 광고주 연결 저장에 실패했습니다.", detail: teamError.message }, 500);

    const auditLogged = await recordAuditLog(ctx, {
      action: existing.data ? "client.reactivated_by_team" : "client.created_by_team",
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
    return json(request, { ok: true, reactivated: Boolean(existing.data), team: teamPayload({ ...team, clients: client }), client: clientPayload(client), auditLogged }, existing.data ? 200 : 201);
  }

async function disconnectTeamClient(request, ctx, body) {
  const teamCode = requestTeamCode(request, body);
  if (!teamCode) return json(request, { ok: false, message: "운영팀 코드를 입력해주세요." }, 400);

  const teamResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .ilike("team_code", teamCode)
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
    return json(request, { ok: true, message: "운영팀과 광고주 연결을 해지했습니다. 광고주 코드는 더 이상 접속할 수 없습니다.", team: teamPayload(team), client: clientPayload(client), auditLogged });
  }

async function revokeTeam(request, ctx, body) {
  const teamCode = requestTeamCode(request, body);
  if (!teamCode) return json(request, { ok: false, message: "권한 해제할 운영팀 코드를 입력해주세요." }, 400);

  const teamResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, created_at, updated_at, revoked_at")
    .ilike("team_code", teamCode)
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
      .ilike("issued_by_team_code", teamResult.data.team_code)
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

async function revokeClient(request, ctx, body) {
  const agencyCode = normalizeAgencyCode(body.agencyCode || body.agency_code || body.code);
  if (!agencyCode) return json(request, { ok: false, message: "권한 해제할 광고주 코드를 입력해주세요." }, 400);

  const clientResult = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at, public_summary, created_at, updated_at")
    .ilike("agency_code", agencyCode)
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
      .ilike("team_code", clientResult.data.issued_by_team_code)
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
      return listClients(request, ctx);
    }
    if (request.method === "POST") {
      const action = String(body.action || "create-team").trim();
      if (["create-team", "create-client", "revoke-team", "revoke-client"].includes(action)) {
        const ownerAuth = ownerActionAuthorized(request, body);
        if (!ownerAuth.ok) return json(request, { ok: false, message: ownerAuth.message }, ownerAuth.status);
        if (action === "create-team") return createTeam(request, ctx, body);
        if (action === "create-client") return createClient(request, ctx, body);
        if (action === "revoke-team") return revokeTeam(request, ctx, body);
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

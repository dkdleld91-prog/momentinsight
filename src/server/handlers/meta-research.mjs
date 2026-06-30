import { withSupabase } from "@supabase/server";
import { parseLimit, readBody } from "../http.mjs";
import { protectedJson, safeEqual } from "../security.mjs";

const META_RESEARCH_SELECT = [
  "id",
  "client_id",
  "brand_id",
  "query",
  "page_name",
  "ad_url",
  "source_url",
  "platform",
  "media_type",
  "angle_type",
  "hook_text",
  "note",
  "created_by_role",
  "team_code",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: [
      "content-type",
      "x-mi-agency-code",
      "x-mi-team-code",
      "x-mi-super-admin-code",
      "x-mi-owner-agency-code",
    ].join(", "),
  });
}

function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function truncateText(value, max = 800) {
  return cleanText(value).slice(0, max);
}

function primaryAgencyCode() {
  return normalizeCode(process.env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
}

function configuredSuperAdminCode() {
  return String(process.env.MI_SUPER_ADMIN_CODE || "").trim();
}

function superAdminAuthorized(request, body = {}) {
  const configured = configuredSuperAdminCode();
  const provided = String(
    request.headers.get("x-mi-super-admin-code") ||
      body.superAdminCode ||
      body.super_admin_code ||
      ""
  ).trim();
  return Boolean(configured) && safeEqual(provided, configured);
}

function ownerAgencyAuthorized(request, body = {}) {
  const provided = normalizeCode(
    request.headers.get("x-mi-owner-agency-code") ||
      body.ownerAgencyCode ||
      body.owner_agency_code ||
      ""
  );
  return safeEqual(provided, primaryAgencyCode());
}

function requestAgencyCode(request, body = {}) {
  return normalizeCode(
    request.headers.get("x-mi-agency-code") ||
      body.agencyCode ||
      body.agency_code ||
      body.code ||
      ""
  );
}

function requestTeamCode(request, body = {}) {
  return normalizeCode(
    request.headers.get("x-mi-team-code") ||
      body.teamCode ||
      body.team_code ||
      ""
  );
}

function clientPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    businessName: row.business_name,
    agencyCode: row.agency_code,
    status: row.status,
    issuedByTeamCode: row.issued_by_team_code,
    disconnectedAt: row.disconnected_at,
  };
}

async function findActiveClientByAgencyCode(ctx, agencyCode) {
  if (!agencyCode) return { client: null };
  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at")
    .ilike("agency_code", agencyCode)
    .eq("status", "active")
    .is("disconnected_at", null)
    .maybeSingle();
  return { client: data || null, error };
}

async function findActiveClientByTeamCode(ctx, teamCode) {
  if (!teamCode) return { client: null, team: null };
  const { data: team, error: teamError } = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, revoked_at")
    .ilike("team_code", teamCode)
    .eq("owner_agency_code", primaryAgencyCode())
    .eq("status", "active")
    .is("revoked_at", null)
    .maybeSingle();
  if (teamError || !team?.client_id) return { client: null, team: team || null, error: teamError };

  const { data: client, error: clientError } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at")
    .eq("id", team.client_id)
    .eq("status", "active")
    .is("disconnected_at", null)
    .maybeSingle();
  return { client: client || null, team, error: clientError };
}

async function resolveAccess(request, ctx, body = {}) {
  if (superAdminAuthorized(request, body) && ownerAgencyAuthorized(request, body)) {
    const clientId = cleanText(body.clientId || body.client_id || new URL(request.url).searchParams.get("client_id"));
    if (!clientId) return { ok: false, status: 400, message: "총관리자 조회는 client_id를 지정해야 합니다." };
    const { data, error } = await ctx.supabaseAdmin
      .from("clients")
      .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at")
      .eq("id", clientId)
      .neq("status", "archived")
      .maybeSingle();
    if (error) return { ok: false, status: 500, message: "총관리자 광고주 조회에 실패했습니다.", detail: error.message };
    if (!data) return { ok: false, status: 404, message: "광고주를 찾을 수 없습니다." };
    return { ok: true, role: "owner", client: data, team: null };
  }

  const teamCode = requestTeamCode(request, body);
  if (teamCode) {
    const { client, team, error } = await findActiveClientByTeamCode(ctx, teamCode);
    if (error) return { ok: false, status: 500, message: "운영팀 연결 광고주 조회에 실패했습니다.", detail: error.message };
    if (!team) return { ok: false, status: 404, message: "활성 운영팀 코드가 아닙니다." };
    if (!client) return { ok: false, status: 409, message: "운영팀에 연결된 활성 광고주가 없습니다." };
    return { ok: true, role: "team", client, team };
  }

  const agencyCode = requestAgencyCode(request, body);
  const { client, error } = await findActiveClientByAgencyCode(ctx, agencyCode);
  if (error) return { ok: false, status: 500, message: "광고주 코드 조회에 실패했습니다.", detail: error.message };
  if (!client) return { ok: false, status: 404, message: "활성 광고주 코드가 아닙니다." };
  return { ok: true, role: "client", client, team: null };
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

function normalizeResearchBody(body = {}) {
  return {
    query: truncateText(body.query || body.searchTerm || body.search_term, 160),
    pageName: truncateText(body.pageName || body.page_name, 160),
    adUrl: truncateText(body.url || body.adUrl || body.ad_url, 1200),
    sourceUrl: truncateText(body.sourceUrl || body.source_url, 1200),
    platform: truncateText(body.platform, 80) || "ALL",
    mediaType: truncateText(body.mediaType || body.media_type, 40) || "ALL",
    angleType: truncateText(body.angle || body.angleType || body.angle_type, 80) || "후킹 카피",
    hookText: truncateText(body.hook || body.hookText || body.hook_text, 500),
    note: truncateText(body.note, 1200),
  };
}

async function handleGet(request, ctx) {
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  const limit = parseLimit(new URL(request.url), 40, 80);
  const { data, error } = await ctx.supabaseAdmin
    .from("meta_ad_research_items")
    .select(META_RESEARCH_SELECT)
    .eq("client_id", access.client.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return json(request, { ok: false, message: "Meta 조사 기록 조회에 실패했습니다.", detail: error.message }, 500);
  return json(request, {
    ok: true,
    access: {
      role: access.role,
      client: clientPayload(access.client),
      teamCode: access.team?.team_code || null,
      teamName: access.team?.team_name || null,
    },
    items: data || [],
  });
}

async function handleSave(request, ctx, access, body) {
  const research = normalizeResearchBody(body);
  if (!research.query) return json(request, { ok: false, message: "검색어가 필요합니다." }, 400);
  if (!research.pageName && !research.adUrl && !research.hookText && !research.note) {
    return json(request, { ok: false, message: "광고 페이지명, URL, 후킹 문구, 메모 중 하나는 입력해주세요." }, 400);
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("meta_ad_research_items")
    .insert({
      client_id: access.client.id,
      query: research.query,
      page_name: research.pageName || null,
      ad_url: research.adUrl || null,
      source_url: research.sourceUrl || null,
      platform: research.platform,
      media_type: research.mediaType,
      angle_type: research.angleType,
      hook_text: research.hookText || null,
      note: research.note || null,
      created_by_role: access.role,
      team_code: access.team?.team_code || null,
      metadata: {
        ui: "meta_ads_tool",
      },
    })
    .select(META_RESEARCH_SELECT)
    .single();

  if (error) return json(request, { ok: false, message: "Meta 조사 기록 저장에 실패했습니다.", detail: error.message }, 500);
  const auditLogged = await recordAuditLog(ctx, {
    action: "meta_research.item_created",
    clientId: access.client.id,
    targetTable: "meta_ad_research_items",
    targetId: data.id,
    metadata: {
      role: access.role,
      teamCode: access.team?.team_code || null,
      query: research.query,
      platform: research.platform,
      mediaType: research.mediaType,
    },
  });
  return json(request, { ok: true, item: data, auditLogged }, 201);
}

async function handleDelete(request, ctx, access, body) {
  const itemId = cleanText(body.id || body.itemId || body.item_id);
  if (!itemId) return json(request, { ok: false, message: "삭제할 조사 기록 ID가 필요합니다." }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from("meta_ad_research_items")
    .delete()
    .eq("id", itemId)
    .eq("client_id", access.client.id)
    .select("id")
    .maybeSingle();
  if (error) return json(request, { ok: false, message: "Meta 조사 기록 삭제에 실패했습니다.", detail: error.message }, 500);
  if (!data) return json(request, { ok: false, message: "삭제할 조사 기록을 찾을 수 없습니다." }, 404);

  const auditLogged = await recordAuditLog(ctx, {
    action: "meta_research.item_deleted",
    clientId: access.client.id,
    targetTable: "meta_ad_research_items",
    targetId: data.id,
    metadata: {
      role: access.role,
      teamCode: access.team?.team_code || null,
    },
  });
  return json(request, { ok: true, deletedId: data.id, auditLogged });
}

async function handlePost(request, ctx) {
  const body = await readBody(request);
  const access = await resolveAccess(request, ctx, body);
  if (!access.ok) return json(request, access, access.status);
  const action = cleanText(body.action, "save");
  if (action === "save" || action === "create") return handleSave(request, ctx, access, body);
  if (action === "delete") return handleDelete(request, ctx, access, body);
  return json(request, { ok: false, message: "지원하지 않는 Meta 조사 작업입니다." }, 400);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "GET") return handleGet(request, ctx);
    if (request.method === "POST") return handlePost(request, ctx);
    return json(request, { ok: false, message: "Method not allowed", allowed: ["GET", "POST"] }, 405);
  }),
};

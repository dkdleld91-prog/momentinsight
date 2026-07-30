import { withSupabase } from "@supabase/server";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { parseLimit, readBody } from "../http.mjs";
import { protectedJson, safeEqual } from "../security.mjs";

const SCHEDULE_TYPES = new Set([
  "ad_setup",
  "content_upload",
  "distribution",
  "review",
  "shooting",
  "promotion",
  "report_due",
  "meeting",
  "creative",
  "keyword",
]);
const SCHEDULE_STATUSES = new Set(["planned", "in_progress", "done", "paused", "needs_check"]);
const PRIORITIES = new Set(["high", "medium", "low"]);
const VISIBLE = "client_visible";
const INTERNAL = "internal";
const MAX_INTERNAL_NOTE = 4000;
const MAX_PUBLIC_COMMENT = 1000;

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, PATCH, DELETE, OPTIONS",
    headers: "content-type, x-mi-agency-code, x-mi-team-code, x-mi-owner-agency-code, x-mi-csrf",
  });
}

function cleanText(value, max = 0) {
  const text = String(value ?? "").trim();
  return max ? text.slice(0, max) : text;
}

function normalizeCode(value) {
  return cleanText(value).toLowerCase();
}

function primaryAgencyCode() {
  return normalizeCode(process.env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] || null : data || null;
}

function validIsoDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function roleCanMutateWorkItems(role) {
  return role === "owner" || role === "team";
}

export function normalizeWorkItemInput(body = {}, options = {}) {
  const title = cleanText(body.title, 120);
  const scheduleType = cleanText(body.scheduleType || body.schedule_type);
  const status = cleanText(body.status || "planned");
  const priority = cleanText(body.priority || "medium");
  const startsAt = validIsoDate(body.startsAt || body.starts_at);
  const rawEndsAt = cleanText(body.endsAt || body.ends_at);
  const endsAt = rawEndsAt ? validIsoDate(rawEndsAt) : "";
  const assigneeName = cleanText(body.assigneeName || body.assignee_name, 60);
  const internalNote = cleanText(body.internalNote || body.internal_note, MAX_INTERNAL_NOTE);
  const publicComment = cleanText(body.publicComment || body.public_comment, MAX_PUBLIC_COMMENT);
  const requestedVisible = body.visibility === VISIBLE
    || body.isClientVisible === true
    || body.is_client_visible === true;
  const publicTitle = cleanText(body.publicTitle || body.public_title || (requestedVisible ? title : ""), 120);

  if (!title) return { ok: false, message: "업무 제목을 입력해주세요." };
  if (!SCHEDULE_TYPES.has(scheduleType)) return { ok: false, message: "업무 유형을 확인해주세요." };
  if (!SCHEDULE_STATUSES.has(status)) return { ok: false, message: "업무 상태를 확인해주세요." };
  if (!PRIORITIES.has(priority)) return { ok: false, message: "우선순위를 확인해주세요." };
  if (!startsAt) return { ok: false, message: "업무 시작 일시를 확인해주세요." };
  if (rawEndsAt && !endsAt) return { ok: false, message: "업무 종료 일시를 확인해주세요." };
  if (endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    return { ok: false, message: "종료 일시는 시작 일시보다 빠를 수 없습니다." };
  }
  if (requestedVisible && !options.canPublish) {
    return { ok: false, status: 409, message: "광고주 연결 후 공개할 수 있습니다. 현재 업무는 내부 비공개로 저장해주세요." };
  }
  if (requestedVisible && !publicTitle) {
    return { ok: false, message: "광고주 공개 제목을 입력해주세요." };
  }

  return {
    ok: true,
    value: {
      title,
      schedule_type: scheduleType,
      status,
      priority,
      starts_at: startsAt,
      ends_at: endsAt || null,
      assignee_name: assigneeName || null,
      internal_note: internalNote || null,
      public_title: requestedVisible ? publicTitle : null,
      public_comment: requestedVisible && publicComment ? publicComment : null,
      visibility: requestedVisible ? VISIBLE : INTERNAL,
      is_all_day: body.isAllDay === true || body.is_all_day === true,
    },
  };
}

export function clientWorkItemPayload(row = {}) {
  return {
    id: row.id,
    title: cleanText(row.public_title || row.title, 120),
    scheduleType: row.schedule_type,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    publicComment: cleanText(row.public_comment, MAX_PUBLIC_COMMENT),
    isAllDay: Boolean(row.is_all_day),
    updatedAt: row.updated_at,
  };
}

function managerWorkItemPayload(row = {}) {
  return {
    id: row.id,
    clientId: row.client_id,
    operationTeamId: row.operation_team_id,
    title: row.title,
    scheduleType: row.schedule_type,
    status: row.status,
    priority: row.priority,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    assigneeName: row.assignee_name,
    internalNote: row.internal_note,
    publicTitle: row.public_title,
    publicComment: row.public_comment,
    visibility: row.visibility,
    isAllDay: Boolean(row.is_all_day),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    client: row.client || null,
    operationTeam: row.operation_team || null,
  };
}

async function activeClientByAgencyCode(ctx, agencyCode) {
  if (!agencyCode) return { client: null };
  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at")
    .eq("agency_code", agencyCode)
    .eq("status", "active")
    .is("disconnected_at", null)
    .maybeSingle();
  return { client: data || null, error };
}

async function activeTeamByCode(ctx, teamCode) {
  if (!teamCode) return { team: null, client: null };
  const { data: team, error: teamError } = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, revoked_at")
    .eq("team_code", teamCode)
    .eq("owner_agency_code", primaryAgencyCode())
    .eq("status", "active")
    .is("revoked_at", null)
    .maybeSingle();
  if (teamError || !team?.client_id) return { team: team || null, client: null, error: teamError };
  const { data: client, error: clientError } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, issued_by_team_code, disconnected_at")
    .eq("id", team.client_id)
    .eq("status", "active")
    .is("disconnected_at", null)
    .maybeSingle();
  return { team, client: client || null, error: clientError };
}

async function teamForClient(ctx, client) {
  if (!client?.issued_by_team_code) return { team: null };
  const { data, error } = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id, owner_agency_code, team_name, team_code, status, client_id, revoked_at")
    .eq("team_code", client.issued_by_team_code)
    .eq("status", "active")
    .is("revoked_at", null)
    .maybeSingle();
  return { team: data || null, error };
}

async function resolveAccess(request, ctx) {
  const role = cleanText(request.headers.get("x-mi-session-role"));
  if (!["owner", "team", "client"].includes(role)) {
    return { ok: false, status: 401, message: "안전한 접속 세션이 필요합니다." };
  }

  if (role === "owner") {
    const ownerCode = normalizeCode(request.headers.get("x-mi-owner-agency-code"));
    if (!safeEqual(ownerCode, primaryAgencyCode())) {
      return { ok: false, status: 403, message: "총관리자 세션을 확인할 수 없습니다." };
    }
    const targetCode = normalizeCode(request.headers.get("x-mi-agency-code"));
    if (!targetCode || safeEqual(targetCode, primaryAgencyCode())) {
      return { ok: true, role, ownerAgencyCode: primaryAgencyCode(), client: null, team: null };
    }
    const { client, error } = await activeClientByAgencyCode(ctx, targetCode);
    if (error) return { ok: false, status: 500, message: "광고주 범위 확인에 실패했습니다.", detail: error.message };
    if (!client) return { ok: false, status: 404, message: "활성 광고주를 찾을 수 없습니다." };
    const teamResult = await teamForClient(ctx, client);
    if (teamResult.error) return { ok: false, status: 500, message: "운영팀 범위 확인에 실패했습니다.", detail: teamResult.error.message };
    return { ok: true, role, ownerAgencyCode: primaryAgencyCode(), client, team: teamResult.team };
  }

  if (role === "team") {
    const teamCode = normalizeCode(request.headers.get("x-mi-team-code"));
    const { team, client, error } = await activeTeamByCode(ctx, teamCode);
    if (error) return { ok: false, status: 500, message: "운영팀 범위 확인에 실패했습니다.", detail: error.message };
    if (!team) return { ok: false, status: 404, message: "활성 운영팀을 찾을 수 없습니다." };
    return { ok: true, role, ownerAgencyCode: team.owner_agency_code, client, team };
  }

  const agencyCode = normalizeCode(request.headers.get("x-mi-agency-code"));
  const { client, error } = await activeClientByAgencyCode(ctx, agencyCode);
  if (error) return { ok: false, status: 500, message: "광고주 범위 확인에 실패했습니다.", detail: error.message };
  if (!client) return { ok: false, status: 404, message: "활성 광고주를 찾을 수 없습니다." };
  return { ok: true, role, ownerAgencyCode: primaryAgencyCode(), client, team: null };
}

function selectFields() {
  return [
    "id",
    "client_id",
    "operation_team_id",
    "title",
    "schedule_type",
    "status",
    "priority",
    "starts_at",
    "ends_at",
    "assignee_name",
    "internal_note",
    "public_title",
    "public_comment",
    "visibility",
    "is_all_day",
    "created_at",
    "updated_at",
    "client:clients(id,name,business_name)",
    "operation_team:operation_team_codes(id,team_name)",
  ].join(",");
}

function applyAccessScope(query, access, { clientVisibleOnly = false } = {}) {
  if (access.role === "client") {
    return query.eq("client_id", access.client.id).eq("visibility", VISIBLE);
  }
  if (access.role === "team") {
    if (access.client) {
      return query.or(`operation_team_id.eq.${access.team.id},and(operation_team_id.is.null,client_id.eq.${access.client.id})`);
    }
    return query.eq("operation_team_id", access.team.id);
  }
  if (access.client) return query.eq("client_id", access.client.id);
  const scoped = query.eq("owner_agency_code", access.ownerAgencyCode);
  return clientVisibleOnly ? scoped.eq("visibility", VISIBLE) : scoped;
}

function applyDateRange(query, request) {
  const url = new URL(request.url);
  const from = validIsoDate(url.searchParams.get("from"));
  const to = validIsoDate(url.searchParams.get("to"));
  if (from) query = query.gte("starts_at", from);
  if (to) query = query.lte("starts_at", to);
  return query;
}

async function recordAudit(ctx, payload) {
  const { error } = await ctx.supabaseAdmin.from("audit_logs").insert({
    actor_id: null,
    client_id: payload.clientId || null,
    action: payload.action,
    target_table: "schedule_items",
    target_id: payload.targetId || null,
    metadata: sanitizeAuditMetadata(payload.metadata || {}),
  });
  return !error;
}

async function scopedWorkItem(ctx, access, id) {
  let query = ctx.supabaseAdmin
    .from("schedule_items")
    .select(selectFields())
    .eq("id", id);
  query = applyAccessScope(query, access);
  const { data, error } = await query.maybeSingle();
  return { row: data || null, error };
}

async function handleGet(request, ctx) {
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  const limit = parseLimit(new URL(request.url), 200, 300);
  let query = ctx.supabaseAdmin
    .from("schedule_items")
    .select(selectFields())
    .order("starts_at", { ascending: true })
    .limit(limit);
  query = applyDateRange(applyAccessScope(query, access), request);
  const { data, error } = await query;
  if (error) return json(request, { ok: false, message: "업무 일정을 불러오지 못했습니다.", detail: error.message }, 500);
  const items = (data || []).map(access.role === "client" ? clientWorkItemPayload : managerWorkItemPayload);
  return json(request, {
    ok: true,
    role: access.role,
    canPublish: roleCanMutateWorkItems(access.role) && Boolean(access.client),
    client: access.client ? { id: access.client.id, name: access.client.name || access.client.business_name } : null,
    items,
  });
}

async function handlePost(request, ctx) {
  const body = await readBody(request);
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  if (!roleCanMutateWorkItems(access.role)) {
    return json(request, { ok: false, message: "광고주는 공개된 일정만 확인할 수 있습니다." }, 403);
  }
  const normalized = normalizeWorkItemInput(body, { canPublish: Boolean(access.client) });
  if (!normalized.ok) return json(request, normalized, normalized.status || 400);
  const row = {
    ...normalized.value,
    client_id: access.client?.id || null,
    operation_team_id: access.team?.id || null,
    owner_agency_code: access.ownerAgencyCode || primaryAgencyCode(),
  };
  const { data, error } = await ctx.supabaseAdmin
    .from("schedule_items")
    .insert(row)
    .select(selectFields())
    .single();
  if (error) return json(request, { ok: false, message: "업무 저장에 실패했습니다.", detail: error.message }, 500);
  const auditLogged = await recordAudit(ctx, {
    action: "work_item_created",
    targetId: data.id,
    clientId: data.client_id,
    metadata: { visibility: data.visibility, status: data.status, scheduleType: data.schedule_type },
  });
  return json(request, { ok: true, message: "업무를 저장했습니다.", item: managerWorkItemPayload(data), auditLogged }, 201);
}

async function handlePatch(request, ctx) {
  const body = await readBody(request);
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  if (!roleCanMutateWorkItems(access.role)) return json(request, { ok: false, message: "수정 권한이 없습니다." }, 403);
  const id = cleanText(body.id);
  if (!id) return json(request, { ok: false, message: "수정할 업무를 확인해주세요." }, 400);
  const existing = await scopedWorkItem(ctx, access, id);
  if (existing.error) return json(request, { ok: false, message: "업무 범위 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (!existing.row) return json(request, { ok: false, message: "수정할 업무를 찾을 수 없습니다." }, 404);
  const normalized = normalizeWorkItemInput(body, { canPublish: Boolean(access.client) });
  if (!normalized.ok) return json(request, normalized, normalized.status || 400);
  const update = {
    ...normalized.value,
    client_id: access.client?.id || existing.row.client_id || null,
    operation_team_id: access.team?.id || existing.row.operation_team_id || null,
  };
  const { data, error } = await ctx.supabaseAdmin
    .from("schedule_items")
    .update(update)
    .eq("id", id)
    .select(selectFields())
    .single();
  if (error) return json(request, { ok: false, message: "업무 수정에 실패했습니다.", detail: error.message }, 500);
  const auditLogged = await recordAudit(ctx, {
    action: "work_item_updated",
    targetId: data.id,
    clientId: data.client_id,
    metadata: {
      previousVisibility: existing.row.visibility,
      visibility: data.visibility,
      previousStatus: existing.row.status,
      status: data.status,
    },
  });
  return json(request, { ok: true, message: "업무를 수정했습니다.", item: managerWorkItemPayload(data), auditLogged });
}

async function handleDelete(request, ctx) {
  const body = await readBody(request);
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  if (!roleCanMutateWorkItems(access.role)) return json(request, { ok: false, message: "삭제 권한이 없습니다." }, 403);
  const id = cleanText(body.id || new URL(request.url).searchParams.get("id"));
  if (!id) return json(request, { ok: false, message: "삭제할 업무를 확인해주세요." }, 400);
  const existing = await scopedWorkItem(ctx, access, id);
  if (existing.error) return json(request, { ok: false, message: "업무 범위 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (!existing.row) return json(request, { ok: false, message: "삭제할 업무를 찾을 수 없습니다." }, 404);
  const { error } = await ctx.supabaseAdmin.from("schedule_items").delete().eq("id", id);
  if (error) return json(request, { ok: false, message: "업무 삭제에 실패했습니다.", detail: error.message }, 500);
  const auditLogged = await recordAudit(ctx, {
    action: "work_item_deleted",
    targetId: id,
    clientId: existing.row.client_id,
    metadata: { visibility: existing.row.visibility, status: existing.row.status },
  });
  return json(request, { ok: true, message: "업무를 삭제했습니다.", auditLogged });
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "GET") return handleGet(request, ctx);
    if (request.method === "POST") return handlePost(request, ctx);
    if (request.method === "PATCH") return handlePatch(request, ctx);
    if (request.method === "DELETE") return handleDelete(request, ctx);
    return json(request, { ok: false, message: "Method not allowed", allowed: ["GET", "POST", "PATCH", "DELETE"] }, 405);
  }),
};

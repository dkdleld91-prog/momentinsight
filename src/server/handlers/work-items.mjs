import { withSupabase } from "@supabase/server";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import {
  buildMonthlyOccurrences,
  calendarInviteDigest,
  createCalendarInviteCode,
  normalizeCalendarColor,
  normalizeCalendarName,
  normalizeInviteCode,
  seoulDateKey,
} from "../calendar-domain.mjs";
import { parseLimit, readBody } from "../http.mjs";
import { protectedJson, safeEqual } from "../security.mjs";
import { consumeRateLimit } from "./code-session-api.mjs";

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
const CALENDAR_ACTIONS = new Set([
  "calendar-create",
  "calendar-invite-create",
  "calendar-invite-accept",
  "calendar-leave",
]);
const WORK_ITEM_WRITE_KEYS = new Set([
  "id", "title", "scheduleType", "schedule_type", "status", "priority",
  "startsAt", "starts_at", "endsAt", "ends_at", "assigneeName", "assignee_name",
  "internalNote", "internal_note", "publicTitle", "public_title", "publicComment", "public_comment",
  "visibility", "isClientVisible", "is_client_visible", "isAllDay", "is_all_day",
  "calendarId", "expectedUpdatedAt", "repeat", "repeatUntil", "requestId",
]);

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

function unexpectedWorkItemInput(body = {}) {
  return Object.keys(body).find((key) => !WORK_ITEM_WRITE_KEYS.has(key)) || "";
}

function normalizedUuid(value) {
  const id = cleanText(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id) ? id : "";
}

export function calendarPrincipal(access = {}) {
  if (access.role === "owner") {
    const agencyCode = normalizeCode(access.ownerAgencyCode);
    return agencyCode ? { key: `owner:${agencyCode}`, displayName: "총관리자" } : null;
  }
  if (access.role === "team") {
    const teamId = cleanText(access.team?.id);
    if (!teamId) return null;
    return {
      key: `team:${teamId.toLowerCase()}`,
      displayName: cleanText(access.team?.team_name, 60) || "운영팀",
    };
  }
  return null;
}

export function calendarRoleCanEdit(role) {
  return role === "owner" || role === "editor";
}

export function normalizeCalendarAction(body = {}) {
  const action = cleanText(body.action);
  if (!CALENDAR_ACTIONS.has(action)) return { ok: false, message: "캘린더 요청을 확인해주세요." };
  const allowed = {
    "calendar-create": new Set(["action", "name", "color"]),
    "calendar-invite-create": new Set(["action", "calendarId", "grantRole"]),
    "calendar-invite-accept": new Set(["action", "code"]),
    "calendar-leave": new Set(["action", "calendarId"]),
  }[action];
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return { ok: false, message: "캘린더 요청에 허용되지 않은 값이 포함되었습니다." };
  }
  if (action === "calendar-create") {
    try {
      return {
        ok: true,
        action,
        value: {
          name: normalizeCalendarName(body.name),
          color: normalizeCalendarColor(body.color || "navy"),
        },
      };
    } catch (error) {
      return { ok: false, message: error.message || "캘린더 이름과 색상을 확인해주세요." };
    }
  }
  if (action === "calendar-invite-create") {
    const calendarId = cleanText(body.calendarId);
    const grantRole = cleanText(body.grantRole || "editor");
    if (!calendarId || !["editor", "viewer"].includes(grantRole)) {
      return { ok: false, message: "공유할 캘린더와 권한을 확인해주세요." };
    }
    return { ok: true, action, value: { calendarId, grantRole } };
  }
  if (action === "calendar-invite-accept") {
    try {
      return { ok: true, action, value: { code: normalizeInviteCode(body.code) } };
    } catch (error) {
      return { ok: false, message: error.message || "공유 코드를 확인해주세요." };
    }
  }
  const calendarId = cleanText(body.calendarId);
  if (!calendarId) return { ok: false, message: "연결 해제할 캘린더를 확인해주세요." };
  return { ok: true, action, value: { calendarId } };
}

function primaryAgencyCode() {
  return normalizeCode(process.env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] || null : data || null;
}

export function validIsoDate(value) {
  if (!value) return "";
  const input = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/u.test(input)
      || !seoulDateKey(input)) return "";
  const seoulInput = /^\d{4}-\d{2}-\d{2}$/u.test(input)
    ? `${input}T00:00:00+09:00`
    : /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/iu.test(input)
      ? `${input}+09:00`
      : input;
  const parsed = new Date(seoulInput);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function workItemsDateRange(request) {
  const url = new URL(request.url);
  const rawFrom = cleanText(url.searchParams.get("from"));
  const rawTo = cleanText(url.searchParams.get("to"));
  const from = validIsoDate(rawFrom);
  const to = validIsoDate(rawTo);
  const toExclusive = to && /^\d{4}-\d{2}-\d{2}$/u.test(rawTo)
    ? new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000).toISOString()
    : to;
  return { from, toExclusive };
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
    title: cleanText(row.public_title, 120),
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
    calendarId: row.calendar_id || null,
    calendar: row.calendar ? {
      id: firstRow(row.calendar)?.id || row.calendar.id,
      name: firstRow(row.calendar)?.name || row.calendar.name,
      color: firstRow(row.calendar)?.color || row.calendar.color,
    } : null,
    seriesId: row.series_id || null,
    occurrenceOn: row.occurrence_on || null,
    repeat: row.recurrence_kind || "none",
    repeatUntil: row.recurrence_until || null,
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

function calendarPayload(row = {}) {
  const calendar = firstRow(row.calendar) || row.calendar || {};
  return {
    id: calendar.id,
    name: calendar.name,
    color: calendar.color,
    role: row.role,
    isOwner: row.role === "owner",
    shared: row.role !== "owner",
    createdAt: calendar.created_at,
    updatedAt: calendar.updated_at,
  };
}

async function calendarMemberships(ctx, access) {
  const principal = calendarPrincipal(access);
  if (!principal) return { principal: null, rows: [], calendars: [], error: null };
  const { data, error } = await ctx.supabaseAdmin
    .from("schedule_calendar_memberships")
    .select("role,revoked_at,calendar:schedule_calendars!inner(id,name,color,owner_principal_key,archived_at,created_at,updated_at)")
    .eq("principal_key", principal.key)
    .is("revoked_at", null);
  const rows = (data || []).filter((row) => {
    const calendar = firstRow(row.calendar) || row.calendar;
    return calendar?.id && !calendar.archived_at;
  });
  return { principal, rows, calendars: rows.map(calendarPayload), error };
}

async function calendarMembership(ctx, access, calendarId) {
  const principal = calendarPrincipal(access);
  if (!principal || !calendarId) return { principal, membership: null, error: null };
  const { data, error } = await ctx.supabaseAdmin
    .from("schedule_calendar_memberships")
    .select("role,revoked_at,calendar:schedule_calendars!inner(id,name,color,owner_principal_key,archived_at,created_at,updated_at)")
    .eq("calendar_id", calendarId)
    .eq("principal_key", principal.key)
    .is("revoked_at", null)
    .maybeSingle();
  const calendar = firstRow(data?.calendar) || data?.calendar;
  return {
    principal,
    membership: data && calendar?.id && !calendar.archived_at ? { ...data, calendar } : null,
    error,
  };
}

function calendarIds(rows = []) {
  return rows.map((row) => (firstRow(row.calendar) || row.calendar)?.id).filter(Boolean);
}

function sameNullable(left, right) {
  return (left || null) === (right || null);
}

function legacyRowInAccess(row, access) {
  if (!row || row.calendar_id) return false;
  if (access.role === "client") return row.client_id === access.client?.id && row.visibility === VISIBLE;
  if (access.role === "team") {
    return row.operation_team_id === access.team?.id
      || (!row.operation_team_id && access.client && row.client_id === access.client.id);
  }
  if (access.client) return row.client_id === access.client.id;
  return normalizeCode(row.owner_agency_code) === normalizeCode(access.ownerAgencyCode);
}

async function rowAccess(ctx, access, row, { mutate = false } = {}) {
  if (!row?.calendar_id) return { allowed: legacyRowInAccess(row, access), membership: null, error: null };
  const result = await calendarMembership(ctx, access, row.calendar_id);
  if (result.error || !result.membership) return { allowed: false, membership: null, error: result.error };
  return {
    allowed: mutate ? calendarRoleCanEdit(result.membership.role) : true,
    membership: result.membership,
    error: null,
  };
}

function exactOriginalScope(query, row) {
  query = query.eq("owner_agency_code", row.owner_agency_code);
  query = row.calendar_id ? query.eq("calendar_id", row.calendar_id) : query.is("calendar_id", null);
  query = row.client_id ? query.eq("client_id", row.client_id) : query.is("client_id", null);
  query = row.operation_team_id ? query.eq("operation_team_id", row.operation_team_id) : query.is("operation_team_id", null);
  return query.eq("updated_at", row.updated_at);
}

function calendarEditForbidden(error) {
  return error?.code === "42501" || /calendar_edit_forbidden/iu.test(error?.message || "");
}

function sharedScheduleRowPayload(row = {}) {
  return {
    title: row.title,
    schedule_type: row.schedule_type,
    status: row.status,
    priority: row.priority,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    assignee_name: row.assignee_name,
    internal_note: row.internal_note,
    is_all_day: row.is_all_day,
    series_id: row.series_id || null,
    occurrence_on: row.occurrence_on || null,
    recurrence_kind: row.recurrence_kind || null,
    recurrence_until: row.recurrence_until || null,
    recurrence_month_day: row.recurrence_month_day || null,
    recurrence_timezone: row.recurrence_timezone || null,
    recurrence_day_policy: row.recurrence_day_policy || null,
  };
}

function sharedScheduleUpdatePayload(row = {}) {
  return {
    title: row.title,
    schedule_type: row.schedule_type,
    status: row.status,
    priority: row.priority,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    assignee_name: row.assignee_name,
    internal_note: row.internal_note,
    is_all_day: row.is_all_day,
    occurrence_on: row.occurrence_on || null,
  };
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
    "calendar_id",
    "series_id",
    "occurrence_on",
    "recurrence_kind",
    "recurrence_until",
    "recurrence_month_day",
    "recurrence_timezone",
    "recurrence_day_policy",
    "created_at",
    "updated_at",
    "calendar:schedule_calendars(id,name,color)",
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
  const { from, toExclusive } = workItemsDateRange(request);
  if (from) query = query.gte("starts_at", from);
  if (toExclusive) query = query.lt("starts_at", toExclusive);
  return query;
}

async function existingSeries(ctx, access, seriesId, calendarId) {
  let query = ctx.supabaseAdmin
    .from("schedule_items")
    .select(selectFields())
    .eq("series_id", seriesId)
    .order("starts_at", { ascending: true });
  query = calendarId
    ? query.eq("calendar_id", calendarId)
    : applyAccessScope(query.is("calendar_id", null), access);
  return query;
}

async function recordAudit(ctx, payload) {
  const { error } = await ctx.supabaseAdmin.from("audit_logs").insert({
    actor_id: null,
    client_id: payload.clientId || null,
    action: payload.action,
    target_table: payload.targetTable || "schedule_items",
    target_id: payload.targetId || null,
    metadata: sanitizeAuditMetadata(payload.metadata || {}),
  });
  return !error;
}

async function scopedWorkItem(ctx, access, id, options = {}) {
  const { data, error } = await ctx.supabaseAdmin
    .from("schedule_items")
    .select(selectFields())
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return { row: null, error };
  const accessResult = await rowAccess(ctx, access, data, options);
  if (accessResult.error) return { row: null, error: accessResult.error };
  return { row: accessResult.allowed ? data : null, error: null, membership: accessResult.membership };
}

async function handleGet(request, ctx) {
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  const limit = parseLimit(new URL(request.url), 200, 300);
  const calendarContext = await calendarMemberships(ctx, access);
  if (calendarContext.error) {
    return json(request, { ok: false, message: "캘린더 목록을 불러오지 못했습니다.", detail: calendarContext.error.message }, 500);
  }
  let legacyQuery = ctx.supabaseAdmin
    .from("schedule_items")
    .select(selectFields())
    .order("starts_at", { ascending: true })
    .limit(limit + 1);
  legacyQuery = applyDateRange(applyAccessScope(legacyQuery.is("calendar_id", null), access), request);
  const sharedIds = calendarIds(calendarContext.rows);
  const sharedQuery = sharedIds.length
    ? applyDateRange(ctx.supabaseAdmin
      .from("schedule_items")
      .select(selectFields())
      .in("calendar_id", sharedIds)
      .order("starts_at", { ascending: true })
      .limit(limit + 1), request)
    : null;
  const [legacyResult, sharedResult] = await Promise.all([
    legacyQuery,
    sharedQuery || Promise.resolve({ data: [], error: null }),
  ]);
  const error = legacyResult.error || sharedResult.error;
  if (error) return json(request, { ok: false, message: "업무 일정을 불러오지 못했습니다.", detail: error.message }, 500);
  const byId = new Map();
  for (const row of [...(legacyResult.data || []), ...(sharedResult.data || [])]) byId.set(row.id, row);
  const rows = [...byId.values()]
    .sort((left, right) => new Date(left.starts_at) - new Date(right.starts_at))
    .slice(0, limit);
  const truncated = (legacyResult.data || []).length > limit
    || (sharedResult.data || []).length > limit
    || byId.size > limit;
  const items = rows.map(access.role === "client" ? clientWorkItemPayload : managerWorkItemPayload);
  return json(request, {
    ok: true,
    role: access.role,
    canPublish: roleCanMutateWorkItems(access.role) && Boolean(access.client),
    client: access.client ? { id: access.client.id, name: access.client.name || access.client.business_name } : null,
    calendars: calendarContext.calendars,
    items,
    truncated,
  });
}

async function handleCalendarAction(request, ctx, access, body) {
  if (!roleCanMutateWorkItems(access.role)) {
    return json(request, { ok: false, message: "캘린더 연결은 총관리자와 운영팀만 사용할 수 있습니다." }, 403);
  }
  const normalized = normalizeCalendarAction(body);
  if (!normalized.ok) return json(request, normalized, 400);
  const principal = calendarPrincipal(access);
  if (!principal) return json(request, { ok: false, message: "캘린더 사용자 범위를 확인할 수 없습니다." }, 403);

  if (normalized.action === "calendar-create") {
    const { data, error } = await ctx.supabaseAdmin.rpc("mi_create_schedule_calendar", {
      p_owner_principal_key: principal.key,
      p_owner_agency_code: access.ownerAgencyCode || primaryAgencyCode(),
      p_operation_team_id: access.role === "team" ? access.team?.id || null : null,
      p_name: normalized.value.name,
      p_color: normalized.value.color,
      p_display_name: principal.displayName,
    });
    if (error) return json(request, { ok: false, message: "캘린더를 만들지 못했습니다.", detail: error.message }, 500);
    const calendar = firstRow(data) || data;
    const auditLogged = await recordAudit(ctx, {
      action: "schedule_calendar_created",
      targetTable: "schedule_calendars",
      targetId: calendar?.id || calendar?.calendar_id || null,
      clientId: access.client?.id || null,
      metadata: { color: normalized.value.color },
    });
    const refreshed = await calendarMemberships(ctx, access);
    const safeCalendar = refreshed.calendars.find((item) => item.id === calendar?.id) || {
      id: calendar?.id || calendar?.calendar_id || null,
      name: normalized.value.name,
      color: normalized.value.color,
      role: "owner",
      isOwner: true,
      shared: false,
      createdAt: calendar?.created_at || null,
      updatedAt: calendar?.updated_at || null,
    };
    return json(request, {
      ok: true,
      message: "새 캘린더를 만들었습니다.",
      calendar: safeCalendar,
      calendars: refreshed.calendars,
      auditLogged,
    }, 201);
  }

  if (normalized.action === "calendar-invite-create") {
    const membership = await calendarMembership(ctx, access, normalized.value.calendarId);
    if (membership.error) return json(request, { ok: false, message: "캘린더 권한 확인에 실패했습니다.", detail: membership.error.message }, 500);
    if (!membership.membership || membership.membership.role !== "owner") {
      return json(request, { ok: false, message: "캘린더 소유자만 공유 코드를 만들 수 있습니다." }, 403);
    }
    const code = createCalendarInviteCode();
    const codeDigest = calendarInviteDigest(code);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await ctx.supabaseAdmin
      .from("schedule_calendar_invites")
      .insert({
        calendar_id: normalized.value.calendarId,
        code_digest: codeDigest,
        code_hint: code.slice(-4),
        grant_role: normalized.value.grantRole,
        expires_at: expiresAt,
        max_uses: 1,
        created_by_principal_key: principal.key,
      })
      .select("id,calendar_id,grant_role,expires_at")
      .single();
    if (error) return json(request, { ok: false, message: "공유 코드를 만들지 못했습니다.", detail: error.message }, 500);
    const auditLogged = await recordAudit(ctx, {
      action: "schedule_calendar_invite_created",
      targetTable: "schedule_calendar_invites",
      targetId: data.id,
      metadata: { calendarId: data.calendar_id, grantRole: data.grant_role, expiresAt: data.expires_at },
    });
    return json(request, {
      ok: true,
      message: "24시간 동안 한 번 사용할 수 있는 공유 코드를 만들었습니다.",
      invite: { code, grantRole: data.grant_role, expiresAt: data.expires_at },
      auditLogged,
    }, 201);
  }

  if (normalized.action === "calendar-invite-accept") {
    const rate = await consumeRateLimit(request, ctx, "calendar_invite", normalized.value.code);
    if (rate.unavailable || !rate.allowed) {
      const headers = rate.retryAfter ? { "retry-after": String(rate.retryAfter) } : {};
      const response = json(request, { ok: false, message: "공유 코드 확인 요청이 많습니다. 잠시 후 다시 시도해주세요." }, 429);
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    }
    const { data, error } = await ctx.supabaseAdmin.rpc("mi_accept_schedule_calendar_invite", {
      p_code_digest: calendarInviteDigest(normalized.value.code),
      p_principal_key: principal.key,
      p_display_name: principal.displayName,
    });
    const result = firstRow(data) || data;
    if (error || !result || !["joined", "already_member"].includes(result.status)) {
      return json(request, { ok: false, message: "유효하지 않거나 만료된 공유 코드입니다." }, 400);
    }
    const auditLogged = await recordAudit(ctx, {
      action: "schedule_calendar_joined",
      targetTable: "schedule_calendar_memberships",
      targetId: result.calendarId || result.calendar_id || null,
      metadata: { status: result.status },
    });
    const refreshed = await calendarMemberships(ctx, access);
    return json(request, {
      ok: true,
      unchanged: result.status === "already_member",
      message: result.status === "already_member" ? "이미 연결된 캘린더입니다." : "공유 캘린더에 연결했습니다.",
      calendars: refreshed.calendars,
      auditLogged,
    });
  }

  const membership = await calendarMembership(ctx, access, normalized.value.calendarId);
  if (membership.error) return json(request, { ok: false, message: "캘린더 권한 확인에 실패했습니다.", detail: membership.error.message }, 500);
  if (!membership.membership) return json(request, { ok: false, message: "연결된 캘린더를 찾을 수 없습니다." }, 404);
  if (membership.membership.role === "owner") {
    return json(request, { ok: false, message: "소유한 캘린더는 연결 해제할 수 없습니다." }, 409);
  }
  const { data, error } = await ctx.supabaseAdmin
    .from("schedule_calendar_memberships")
    .update({ revoked_at: new Date().toISOString() })
    .eq("calendar_id", normalized.value.calendarId)
    .eq("principal_key", principal.key)
    .eq("role", membership.membership.role)
    .is("revoked_at", null)
    .select("calendar_id")
    .maybeSingle();
  if (error) return json(request, { ok: false, message: "캘린더 연결 해제에 실패했습니다.", detail: error.message }, 500);
  if (!data) return json(request, { ok: false, message: "캘린더 연결 상태가 변경되었습니다." }, 409);
  const auditLogged = await recordAudit(ctx, {
    action: "schedule_calendar_left",
    targetTable: "schedule_calendar_memberships",
    targetId: data.calendar_id,
    metadata: { role: membership.membership.role },
  });
  const refreshed = await calendarMemberships(ctx, access);
  return json(request, { ok: true, message: "공유 캘린더 연결을 해제했습니다.", calendars: refreshed.calendars, auditLogged });
}

async function handlePost(request, ctx) {
  const body = await readBody(request);
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  if (CALENDAR_ACTIONS.has(cleanText(body.action))) return handleCalendarAction(request, ctx, access, body);
  if (!roleCanMutateWorkItems(access.role)) {
    return json(request, { ok: false, message: "광고주는 공개된 일정만 확인할 수 있습니다." }, 403);
  }
  const unexpectedKey = unexpectedWorkItemInput(body);
  if (unexpectedKey) return json(request, { ok: false, message: "일정 요청에 허용되지 않은 값이 포함되었습니다." }, 400);
  const requestedCalendarId = normalizedUuid(body.calendarId);
  if (body.calendarId && !requestedCalendarId) return json(request, { ok: false, message: "캘린더를 확인해주세요." }, 400);
  let membership = null;
  if (requestedCalendarId) {
    const result = await calendarMembership(ctx, access, requestedCalendarId);
    if (result.error) return json(request, { ok: false, message: "캘린더 권한 확인에 실패했습니다.", detail: result.error.message }, 500);
    if (!result.membership || !calendarRoleCanEdit(result.membership.role)) {
      return json(request, { ok: false, message: "이 캘린더에 일정을 등록할 권한이 없습니다." }, 403);
    }
    membership = result.membership;
  }
  const normalized = normalizeWorkItemInput(body, { canPublish: !requestedCalendarId && Boolean(access.client) });
  if (!normalized.ok) return json(request, normalized, normalized.status || 400);
  const repeat = cleanText(body.repeat || "none").toLowerCase();
  if (!["none", "monthly"].includes(repeat)) return json(request, { ok: false, message: "반복 설정을 확인해주세요." }, 400);
  const seriesId = repeat === "monthly" ? normalizedUuid(body.requestId) : null;
  if (repeat === "monthly" && !seriesId) {
    return json(request, { ok: false, message: "반복 일정 요청을 안전하게 식별할 수 없습니다." }, 400);
  }
  const baseRow = {
    ...normalized.value,
    client_id: requestedCalendarId ? null : access.client?.id || null,
    operation_team_id: access.team?.id || null,
    owner_agency_code: access.ownerAgencyCode || primaryAgencyCode(),
    calendar_id: requestedCalendarId || null,
  };
  let rows = [baseRow];
  if (repeat === "monthly") {
    const retry = await existingSeries(ctx, access, seriesId, requestedCalendarId);
    if (retry.error) return json(request, { ok: false, message: "반복 일정 중복 여부를 확인하지 못했습니다.", detail: retry.error.message }, 500);
    if ((retry.data || []).length) {
      const items = retry.data.map(managerWorkItemPayload);
      return json(request, { ok: true, unchanged: true, message: "이미 저장된 반복 일정입니다.", item: items[0], items });
    }
    const occurrences = buildMonthlyOccurrences({
      startsAt: normalized.value.starts_at,
      endsAt: normalized.value.ends_at,
      repeatUntil: cleanText(body.repeatUntil),
    });
    if (!occurrences.ok) return json(request, occurrences, occurrences.status || 400);
    const monthDay = Number(occurrences.value[0].occurrenceOn.slice(-2));
    rows = occurrences.value.map((occurrence) => ({
      ...baseRow,
      starts_at: occurrence.startsAt,
      ends_at: occurrence.endsAt,
      series_id: seriesId,
      occurrence_on: occurrence.occurrenceOn,
      recurrence_kind: "monthly",
      recurrence_until: cleanText(body.repeatUntil),
      recurrence_month_day: monthDay,
      recurrence_timezone: "Asia/Seoul",
      recurrence_day_policy: "last_day",
    }));
  }
  const principal = requestedCalendarId ? calendarPrincipal(access) : null;
  const writeResult = requestedCalendarId
    ? await ctx.supabaseAdmin.rpc("mi_insert_shared_schedule_items", {
      p_calendar_id: requestedCalendarId,
      p_principal_key: principal?.key || "",
      p_rows: rows.map(sharedScheduleRowPayload),
    })
    : await ctx.supabaseAdmin
      .from("schedule_items")
      .insert(rows)
      .select(selectFields())
      .order("starts_at", { ascending: true });
  const { data, error } = writeResult;
  if (error) {
    if (calendarEditForbidden(error)) {
      return json(request, { ok: false, message: "이 캘린더의 편집 권한이 변경되었습니다." }, 403);
    }
    if (repeat === "monthly" && error.code === "23505") {
      const retry = await existingSeries(ctx, access, seriesId, requestedCalendarId);
      if (!retry.error && (retry.data || []).length) {
        const items = retry.data.map(managerWorkItemPayload);
        return json(request, { ok: true, unchanged: true, message: "이미 저장된 반복 일정입니다.", item: items[0], items });
      }
    }
    return json(request, { ok: false, message: "업무 저장에 실패했습니다.", detail: error.message }, 500);
  }
  const savedRows = (Array.isArray(data) ? data : [data].filter(Boolean))
    .sort((left, right) => new Date(left.starts_at) - new Date(right.starts_at));
  const first = savedRows[0];
  const auditLogged = await recordAudit(ctx, {
    action: repeat === "monthly" ? "work_item_series_created" : "work_item_created",
    targetId: first?.id || null,
    clientId: first?.client_id || null,
    metadata: {
      visibility: first?.visibility,
      status: first?.status,
      scheduleType: first?.schedule_type,
      calendarId: requestedCalendarId || null,
      recurrence: repeat,
      occurrenceCount: savedRows.length,
      memberRole: membership?.role || null,
    },
  });
  const items = savedRows.map(managerWorkItemPayload);
  return json(request, {
    ok: true,
    message: repeat === "monthly" ? `매월 반복 일정 ${items.length}개를 저장했습니다.` : "업무를 저장했습니다.",
    item: items[0],
    items,
    auditLogged,
  }, 201);
}

export async function assistantCompleteWorkItem(request, ctx, access, body = {}) {
  const allowedKeys = new Set(["action", "id", "expectedUpdatedAt"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return json(request, { ok: false, message: "비서 완료 명령의 입력 범위를 확인해주세요." }, 400);
  }
  const id = cleanText(body.id);
  const expectedUpdatedAt = validIsoDate(body.expectedUpdatedAt);
  if (!id || !expectedUpdatedAt) {
    return json(request, { ok: false, message: "완료할 일정과 최신 상태를 확인해주세요." }, 400);
  }
  const existing = await scopedWorkItem(ctx, access, id, { mutate: true });
  if (existing.error) return json(request, { ok: false, message: "업무 범위 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (!existing.row) return json(request, { ok: false, message: "완료할 일정을 찾을 수 없습니다." }, 404);
  if (validIsoDate(existing.row.updated_at) !== expectedUpdatedAt) {
    return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 말씀해주세요." }, 409);
  }
  if (existing.row.status === "done") {
    const item = access.role === "client" ? clientWorkItemPayload(existing.row) : managerWorkItemPayload(existing.row);
    return json(request, { ok: true, unchanged: true, message: "이미 완료된 일정입니다.", item });
  }
  let data;
  let error;
  if (existing.row.calendar_id) {
    const principal = calendarPrincipal(access);
    const result = await ctx.supabaseAdmin.rpc("mi_update_shared_schedule_item", {
      p_calendar_id: existing.row.calendar_id,
      p_principal_key: principal?.key || "",
      p_item_id: id,
      p_expected_updated_at: existing.row.updated_at,
      p_payload: sharedScheduleUpdatePayload({ ...existing.row, status: "done" }),
    });
    data = firstRow(result.data);
    error = result.error;
  } else {
    let updateQuery = ctx.supabaseAdmin
      .from("schedule_items")
      .update({ status: "done" })
      .eq("id", id);
    updateQuery = exactOriginalScope(updateQuery, existing.row);
    const result = await updateQuery.select(selectFields()).maybeSingle();
    data = result.data;
    error = result.error;
  }
  if (calendarEditForbidden(error)) {
    return json(request, { ok: false, message: "이 캘린더의 편집 권한이 변경되었습니다." }, 403);
  }
  if (error) return json(request, { ok: false, message: "일정 완료 처리에 실패했습니다.", detail: error.message }, 500);
  if (!data) return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 말씀해주세요." }, 409);
  const auditLogged = await recordAudit(ctx, {
    action: "work_item_completed_by_assistant",
    targetId: data.id,
    clientId: data.client_id,
    metadata: { previousStatus: existing.row.status, status: data.status, source: "momentlabs_assistant" },
  });
  const item = access.role === "client" ? clientWorkItemPayload(data) : managerWorkItemPayload(data);
  return json(request, { ok: true, unchanged: false, message: "일정을 완료 처리했습니다.", item, auditLogged });
}

async function handlePatch(request, ctx) {
  const body = await readBody(request);
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  if (!roleCanMutateWorkItems(access.role)) return json(request, { ok: false, message: "수정 권한이 없습니다." }, 403);
  if (cleanText(body.action) === "assistant-complete") {
    return assistantCompleteWorkItem(request, ctx, access, body);
  }
  const unexpectedKey = unexpectedWorkItemInput(body);
  if (unexpectedKey) return json(request, { ok: false, message: "일정 요청에 허용되지 않은 값이 포함되었습니다." }, 400);
  const id = cleanText(body.id);
  const expectedUpdatedAt = validIsoDate(body.expectedUpdatedAt);
  if (!id || !expectedUpdatedAt) return json(request, { ok: false, message: "수정할 업무의 최신 상태를 확인해주세요." }, 400);
  const existing = await scopedWorkItem(ctx, access, id, { mutate: true });
  if (existing.error) return json(request, { ok: false, message: "업무 범위 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (!existing.row) return json(request, { ok: false, message: "수정할 업무를 찾을 수 없습니다." }, 404);
  if (validIsoDate(existing.row.updated_at) !== expectedUpdatedAt) {
    return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 시도해주세요." }, 409);
  }
  const requestedCalendarId = normalizedUuid(body.calendarId);
  if ((body.calendarId && !requestedCalendarId) || !sameNullable(requestedCalendarId, existing.row.calendar_id)) {
    return json(request, { ok: false, message: "등록 후에는 일정의 캘린더를 변경할 수 없습니다." }, 409);
  }
  const normalized = normalizeWorkItemInput(body, { canPublish: !existing.row.calendar_id && Boolean(access.client) });
  if (!normalized.ok) return json(request, normalized, normalized.status || 400);
  const updateValues = { ...normalized.value };
  if (existing.row.series_id) {
    const occurrenceOn = seoulDateKey(normalized.value.starts_at);
    if (!occurrenceOn || occurrenceOn > existing.row.recurrence_until) {
      return json(request, { ok: false, message: "반복 종료일 이후로 일정을 이동할 수 없습니다." }, 409);
    }
    updateValues.occurrence_on = occurrenceOn;
  }
  let data;
  let error;
  if (existing.row.calendar_id) {
    const principal = calendarPrincipal(access);
    const result = await ctx.supabaseAdmin.rpc("mi_update_shared_schedule_item", {
      p_calendar_id: existing.row.calendar_id,
      p_principal_key: principal?.key || "",
      p_item_id: id,
      p_expected_updated_at: existing.row.updated_at,
      p_payload: sharedScheduleUpdatePayload(updateValues),
    });
    data = firstRow(result.data);
    error = result.error;
  } else {
    let updateQuery = ctx.supabaseAdmin
      .from("schedule_items")
      .update(updateValues)
      .eq("id", id);
    updateQuery = exactOriginalScope(updateQuery, existing.row);
    const result = await updateQuery.select(selectFields()).maybeSingle();
    data = result.data;
    error = result.error;
  }
  if (calendarEditForbidden(error)) {
    return json(request, { ok: false, message: "이 캘린더의 편집 권한이 변경되었습니다." }, 403);
  }
  if (error?.code === "23505") {
    return json(request, { ok: false, message: "같은 날짜에 이 반복 일정이 이미 있습니다." }, 409);
  }
  if (error) return json(request, { ok: false, message: "업무 수정에 실패했습니다.", detail: error.message }, 500);
  if (!data) return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 시도해주세요." }, 409);
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
  const allowedKeys = new Set(["id", "expectedUpdatedAt"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return json(request, { ok: false, message: "삭제 요청에 허용되지 않은 값이 포함되었습니다." }, 400);
  }
  const id = cleanText(body.id || new URL(request.url).searchParams.get("id"));
  const expectedUpdatedAt = validIsoDate(body.expectedUpdatedAt);
  if (!id || !expectedUpdatedAt) return json(request, { ok: false, message: "삭제할 업무의 최신 상태를 확인해주세요." }, 400);
  const existing = await scopedWorkItem(ctx, access, id, { mutate: true });
  if (existing.error) return json(request, { ok: false, message: "업무 범위 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (!existing.row) return json(request, { ok: false, message: "삭제할 업무를 찾을 수 없습니다." }, 404);
  if (validIsoDate(existing.row.updated_at) !== expectedUpdatedAt) {
    return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 시도해주세요." }, 409);
  }
  let data;
  let error;
  if (existing.row.calendar_id) {
    const principal = calendarPrincipal(access);
    const result = await ctx.supabaseAdmin.rpc("mi_delete_shared_schedule_item", {
      p_calendar_id: existing.row.calendar_id,
      p_principal_key: principal?.key || "",
      p_item_id: id,
      p_expected_updated_at: existing.row.updated_at,
    });
    data = firstRow(result.data) || (result.data ? { id: result.data } : null);
    error = result.error;
  } else {
    let deleteQuery = ctx.supabaseAdmin.from("schedule_items").delete().eq("id", id);
    deleteQuery = exactOriginalScope(deleteQuery, existing.row);
    const result = await deleteQuery.select("id").maybeSingle();
    data = result.data;
    error = result.error;
  }
  if (calendarEditForbidden(error)) {
    return json(request, { ok: false, message: "이 캘린더의 편집 권한이 변경되었습니다." }, 403);
  }
  if (error) return json(request, { ok: false, message: "업무 삭제에 실패했습니다.", detail: error.message }, 500);
  if (!data) return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 시도해주세요." }, 409);
  const auditLogged = await recordAudit(ctx, {
    action: "work_item_deleted",
    targetId: id,
    clientId: existing.row.client_id,
    metadata: { visibility: existing.row.visibility, status: existing.row.status },
  });
  return json(request, { ok: true, message: "업무를 삭제했습니다.", auditLogged });
}

export async function handleWorkItemsRequest(request, ctx) {
  if (request.method === "GET") return handleGet(request, ctx);
  if (request.method === "POST") return handlePost(request, ctx);
  if (request.method === "PATCH") return handlePatch(request, ctx);
  if (request.method === "DELETE") return handleDelete(request, ctx);
  return json(request, { ok: false, message: "Method not allowed", allowed: ["GET", "POST", "PATCH", "DELETE"] }, 405);
}

export default {
  fetch: withSupabase({ auth: "none" }, handleWorkItemsRequest),
};

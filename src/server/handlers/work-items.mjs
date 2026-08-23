import { withSupabase } from "@supabase/server";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import {
  buildMonthlyOccurrences,
  seoulDateKey,
} from "../calendar-domain.mjs";
import {
  deleteRowFromGoogle,
  recordGoogleDeleteFailure,
  syncOwnerScheduleRows,
} from "./google-calendar-api.mjs";
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
const WORK_ITEM_WRITE_KEYS = new Set([
  "id", "title", "scheduleType", "schedule_type", "status", "priority",
  "startsAt", "starts_at", "endsAt", "ends_at", "assigneeName", "assignee_name",
  "internalNote", "internal_note", "publicTitle", "public_title", "publicComment", "public_comment",
  "visibility", "isClientVisible", "is_client_visible", "isAllDay", "is_all_day",
  "calendarId", "expectedUpdatedAt", "repeat", "repeatUntil", "repeatNoEnd", "requestId",
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

// 대표가 쓴 행만 구글로 나간다. 운영팀원이 만든 일정이 대표 개인 캘린더로
// 흘러드는 것을 막는 경계선이라 role 조건을 여기서 한 번 더 고정한다.
function googlePendingPatch(access) {
  return access?.role === "owner" ? { google_sync_state: "pending" } : {};
}

function normalizedUuid(value) {
  const id = cleanText(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id) ? id : "";
}

function primaryAgencyCode() {
  return normalizeCode(process.env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
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
    calendarId: null,
    calendar: null,
    seriesId: row.series_id || null,
    occurrenceOn: row.occurrence_on || null,
    repeat: row.recurrence_kind || "none",
    repeatNoEnd: Boolean(row.recurrence_no_end),
    repeatUntil: row.recurrence_no_end ? null : (row.recurrence_until || null),
    materializedUntil: row.recurrence_until || null,
    googleSource: row.google_source || "mi",
    googleEventId: row.google_event_id || null,
    googleHtmlLink: row.google_html_link || null,
    googleSyncState: row.google_sync_state || null,
    googleLocation: row.google_location || null,
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

function exactOriginalScope(query, row) {
  query = query.eq("owner_agency_code", row.owner_agency_code);
  query = query.is("calendar_id", null);
  query = row.client_id ? query.eq("client_id", row.client_id) : query.is("client_id", null);
  query = row.operation_team_id ? query.eq("operation_team_id", row.operation_team_id) : query.is("operation_team_id", null);
  return query.eq("updated_at", row.updated_at);
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
    "recurrence_no_end",
    "recurrence_month_day",
    "recurrence_timezone",
    "recurrence_day_policy",
    "google_event_id",
    "owner_agency_code",
    "google_calendar_id",
    "google_etag",
    "google_updated_at",
    "google_source",
    "google_sync_state",
    "google_html_link",
    "google_recurring_event_id",
    "google_location",
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
  const { from, toExclusive } = workItemsDateRange(request);
  if (from) query = query.gte("starts_at", from);
  if (toExclusive) query = query.lt("starts_at", toExclusive);
  return query;
}

async function existingSeries(ctx, access, seriesId) {
  let query = ctx.supabaseAdmin
    .from("schedule_items")
    .select(selectFields())
    .eq("series_id", seriesId)
    .order("starts_at", { ascending: true });
  return applyAccessScope(query.is("calendar_id", null), access);
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

async function scopedWorkItem(ctx, access, id) {
  const { data, error } = await ctx.supabaseAdmin
    .from("schedule_items")
    .select(selectFields())
    .eq("id", id)
    .is("calendar_id", null)
    .maybeSingle();
  if (error || !data) return { row: null, error };
  if (data.calendar_id || !legacyRowInAccess(data, access)) return { row: null, error: null };
  return { row: data, error: null };
}

async function handleGet(request, ctx) {
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  const limit = parseLimit(new URL(request.url), 200, 300);
  let query = ctx.supabaseAdmin
    .from("schedule_items")
    .select(selectFields())
    .order("starts_at", { ascending: true })
    .limit(limit + 1);
  query = applyDateRange(applyAccessScope(query.is("calendar_id", null), access), request);
  const { data, error } = await query;
  if (error) return json(request, { ok: false, message: "업무 일정을 불러오지 못했습니다.", detail: error.message }, 500);
  const rows = (data || []).filter((row) => !row.calendar_id).slice(0, limit);
  const truncated = (data || []).length > limit;
  const items = rows.map(access.role === "client" ? clientWorkItemPayload : managerWorkItemPayload);
  return json(request, {
    ok: true,
    role: access.role,
    canPublish: roleCanMutateWorkItems(access.role) && Boolean(access.client),
    client: access.client ? { id: access.client.id, name: access.client.name || access.client.business_name } : null,
    calendars: [],
    items,
    truncated,
  });
}

async function handlePost(request, ctx) {
  const body = await readBody(request);
  if (cleanText(body.action).startsWith("calendar-")) {
    return json(request, { ok: false, message: "공유 일정표 기능은 사용하지 않습니다." }, 404);
  }
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);
  if (!roleCanMutateWorkItems(access.role)) {
    return json(request, { ok: false, message: "광고주는 공개된 일정만 확인할 수 있습니다." }, 403);
  }
  const unexpectedKey = unexpectedWorkItemInput(body);
  if (unexpectedKey) return json(request, { ok: false, message: "일정 요청에 허용되지 않은 값이 포함되었습니다." }, 400);
  if (cleanText(body.calendarId)) {
    return json(request, { ok: false, message: "공유 일정표에는 일정을 등록할 수 없습니다." }, 404);
  }
  const normalized = normalizeWorkItemInput(body, { canPublish: Boolean(access.client) });
  if (!normalized.ok) return json(request, normalized, normalized.status || 400);
  const repeat = cleanText(body.repeat || "none").toLowerCase();
  if (!["none", "monthly"].includes(repeat)) return json(request, { ok: false, message: "반복 설정을 확인해주세요." }, 400);
  if (Object.hasOwn(body, "repeatNoEnd") && typeof body.repeatNoEnd !== "boolean") {
    return json(request, { ok: false, message: "반복 종료 방식을 확인해주세요." }, 400);
  }
  const repeatNoEnd = repeat === "monthly" && body.repeatNoEnd === true;
  if (repeat !== "monthly" && body.repeatNoEnd === true) {
    return json(request, { ok: false, message: "매월 반복을 켠 뒤 종료 방식을 선택해주세요." }, 400);
  }
  if (repeatNoEnd && cleanText(body.repeatUntil)) {
    return json(request, { ok: false, message: "종료 예정 없음과 반복 종료일을 함께 설정할 수 없습니다." }, 400);
  }
  const seriesId = repeat === "monthly" ? normalizedUuid(body.requestId) : null;
  if (repeat === "monthly" && !seriesId) {
    return json(request, { ok: false, message: "반복 일정 요청을 안전하게 식별할 수 없습니다." }, 400);
  }
  const baseRow = {
    ...normalized.value,
    client_id: access.client?.id || null,
    operation_team_id: access.team?.id || null,
    owner_agency_code: access.ownerAgencyCode || primaryAgencyCode(),
    calendar_id: null,
    // 구글 push 는 저장을 막지 않는다. 저장문 자체에 pending 을 실어 두면
    // push 가 실패해도 다음 동기화가 이 행을 자동으로 재시도한다.
    ...googlePendingPatch(access),
  };
  let rows = [baseRow];
  if (repeat === "monthly") {
    const retry = await existingSeries(ctx, access, seriesId);
    if (retry.error) return json(request, { ok: false, message: "반복 일정 중복 여부를 확인하지 못했습니다.", detail: retry.error.message }, 500);
    if ((retry.data || []).length) {
      const items = retry.data.map(managerWorkItemPayload);
      return json(request, { ok: true, unchanged: true, message: "이미 저장된 반복 일정입니다.", item: items[0], items });
    }
    const occurrences = buildMonthlyOccurrences({
      startsAt: normalized.value.starts_at,
      endsAt: normalized.value.ends_at,
      repeatUntil: cleanText(body.repeatUntil),
      repeatNoEnd,
    });
    if (!occurrences.ok) return json(request, occurrences, occurrences.status || 400);
    const monthDay = Number(occurrences.value[0].occurrenceOn.slice(-2));
    const materializedUntil = occurrences.value.at(-1).occurrenceOn;
    rows = occurrences.value.map((occurrence) => ({
      ...baseRow,
      starts_at: occurrence.startsAt,
      ends_at: occurrence.endsAt,
      series_id: seriesId,
      occurrence_on: occurrence.occurrenceOn,
      recurrence_kind: "monthly",
      recurrence_until: materializedUntil,
      recurrence_no_end: repeatNoEnd,
      recurrence_month_day: monthDay,
      recurrence_timezone: "Asia/Seoul",
      recurrence_day_policy: "last_day",
    }));
  }
  const writeResult = await ctx.supabaseAdmin
    .from("schedule_items")
    .insert(rows)
    .select(selectFields())
    .order("starts_at", { ascending: true });
  const { data, error } = writeResult;
  if (error) {
    if (repeat === "monthly" && error.code === "23505") {
      const retry = await existingSeries(ctx, access, seriesId);
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
      calendarId: null,
      recurrence: repeat,
      repeatNoEnd,
      materializedUntil: first?.recurrence_until || null,
      occurrenceCount: savedRows.length,
      memberRole: null,
    },
  });
  await syncOwnerScheduleRows(ctx, process.env, access, savedRows, "upsert");
  const items = savedRows.map(managerWorkItemPayload);
  return json(request, {
    ok: true,
    message: repeat === "monthly"
      ? repeatNoEnd
        ? `종료일 미정 반복 일정 ${items.length}개를 우선 저장했습니다.`
        : `매월 반복 일정 ${items.length}개를 저장했습니다.`
      : "업무를 저장했습니다.",
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
  const existing = await scopedWorkItem(ctx, access, id);
  if (existing.error) return json(request, { ok: false, message: "업무 범위 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (!existing.row) return json(request, { ok: false, message: "완료할 일정을 찾을 수 없습니다." }, 404);
  if (validIsoDate(existing.row.updated_at) !== expectedUpdatedAt) {
    return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 말씀해주세요." }, 409);
  }
  if (existing.row.status === "done") {
    const item = access.role === "client" ? clientWorkItemPayload(existing.row) : managerWorkItemPayload(existing.row);
    return json(request, { ok: true, unchanged: true, message: "이미 완료된 일정입니다.", item });
  }
  let updateQuery = ctx.supabaseAdmin
    .from("schedule_items")
    .update({ status: "done", ...googlePendingPatch(access) })
    .eq("id", id);
  updateQuery = exactOriginalScope(updateQuery, existing.row);
  const { data, error } = await updateQuery.select(selectFields()).maybeSingle();
  if (error) return json(request, { ok: false, message: "일정 완료 처리에 실패했습니다.", detail: error.message }, 500);
  if (!data) return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 말씀해주세요." }, 409);
  const auditLogged = await recordAudit(ctx, {
    action: "work_item_completed_by_assistant",
    targetId: data.id,
    clientId: data.client_id,
    metadata: { previousStatus: existing.row.status, status: data.status, source: "momentlabs_assistant" },
  });
  await syncOwnerScheduleRows(ctx, process.env, access, [data], "upsert");
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
  const existing = await scopedWorkItem(ctx, access, id);
  if (existing.error) return json(request, { ok: false, message: "업무 범위 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (!existing.row) return json(request, { ok: false, message: "수정할 업무를 찾을 수 없습니다." }, 404);
  if (validIsoDate(existing.row.updated_at) !== expectedUpdatedAt) {
    return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 시도해주세요." }, 409);
  }
  if (cleanText(body.calendarId)) {
    return json(request, { ok: false, message: "공유 일정표는 수정할 수 없습니다." }, 404);
  }
  const normalized = normalizeWorkItemInput(body, { canPublish: Boolean(access.client) });
  if (!normalized.ok) return json(request, normalized, normalized.status || 400);
  const updateValues = { ...normalized.value, ...googlePendingPatch(access) };
  if (existing.row.series_id) {
    const occurrenceOn = seoulDateKey(normalized.value.starts_at);
    if (!occurrenceOn || occurrenceOn > existing.row.recurrence_until) {
      return json(request, { ok: false, message: "반복 종료일 이후로 일정을 이동할 수 없습니다." }, 409);
    }
    updateValues.occurrence_on = occurrenceOn;
  }
  let updateQuery = ctx.supabaseAdmin
    .from("schedule_items")
    .update(updateValues)
    .eq("id", id);
  updateQuery = exactOriginalScope(updateQuery, existing.row);
  const { data, error } = await updateQuery.select(selectFields()).maybeSingle();
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
  await syncOwnerScheduleRows(ctx, process.env, access, [data], "upsert");
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
  const existing = await scopedWorkItem(ctx, access, id);
  if (existing.error) return json(request, { ok: false, message: "업무 범위 확인에 실패했습니다.", detail: existing.error.message }, 500);
  if (!existing.row) return json(request, { ok: false, message: "삭제할 업무를 찾을 수 없습니다." }, 404);
  if (validIsoDate(existing.row.updated_at) !== expectedUpdatedAt) {
    return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 시도해주세요." }, 409);
  }
  // 구글이 정본이므로 구글에서 먼저 지운다. 여기서 실패하면 MI 행을 남기고
  // 실패를 그대로 알린다 — 조용히 로컬만 지우면 두 캘린더가 영구히 어긋난다.
  const googleDelete = await deleteRowFromGoogle(ctx, process.env, access, existing.row);
  if (!googleDelete.ok) {
    await recordGoogleDeleteFailure(ctx, existing.row, googleDelete.reason);
    const message = googleDelete.reason === "needs_reconnect"
      ? "구글 연결이 만료되었습니다. 구글 캘린더를 다시 연결한 뒤 삭제해주세요."
      : "구글 캘린더에서 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.";
    return json(request, { ok: false, code: "google_delete_failed", message }, 502);
  }
  let deleteQuery = ctx.supabaseAdmin.from("schedule_items").delete().eq("id", id);
  deleteQuery = exactOriginalScope(deleteQuery, existing.row);
  const { data, error } = await deleteQuery.select("id").maybeSingle();
  if (error) return json(request, { ok: false, message: "업무 삭제에 실패했습니다.", detail: error.message }, 500);
  if (!data) return json(request, { ok: false, message: "일정이 변경되었습니다. 새로고침 후 다시 시도해주세요." }, 409);
  const auditLogged = await recordAudit(ctx, {
    action: "work_item_deleted",
    targetId: id,
    clientId: existing.row.client_id,
    metadata: {
      visibility: existing.row.visibility,
      status: existing.row.status,
      googleEventDeleted: !googleDelete.skipped,
    },
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

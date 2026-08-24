import { withSupabase } from "@supabase/server";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import {
  OPTIONAL_PERSONAL_COLUMNS,
  optionalColumnEnabled,
  runWithOptionalColumns,
} from "./google-calendar-sync.mjs";
import {
  databaseError,
  json,
  methodNotAllowed,
  notFound,
  parseLimit,
  readBody,
  routeParts
} from "../http.mjs";

const resources = {
  clients: {
    table: "clients",
    select: "id, name, business_name, agency_code, status, public_summary, internal_note, created_at, updated_at",
    order: "created_at",
    hardDeleteBlocked: true
  },
  brands: {
    table: "brands",
    select: "id, client_id, name, category, main_marketplace, status, created_at, updated_at",
    order: "created_at"
  },
  "dashboard-snapshots": {
    table: "dashboard_snapshots",
    select: "id, client_id, brand_id, period, sales, ad_spend, roas, impressions, clicks, orders, reviews, conversion_rate, click_rate, achievement_rate, public_comment, internal_note, created_at, updated_at",
    order: "period"
  },
  "kpi-targets": {
    table: "kpi_targets",
    select: "id, client_id, brand_id, period_month, target_revenue, target_ad_spend, target_roas, target_orders, target_reviews, target_keyword_rank, created_by, created_at, updated_at",
    order: "period_month"
  },
  "kpi-results": {
    table: "kpi_results",
    select: "id, kpi_target_id, client_id, actual_revenue, actual_ad_spend, actual_roas, actual_orders, actual_cpa, actual_cpc, actual_ctr, actual_cvr, actual_reviews, achievement_rate, public_comment, internal_note, created_at, updated_at",
    order: "updated_at"
  },
  "ad-performance": {
    table: "ad_performance",
    select: "id, client_id, brand_id, channel_id, period_start, period_end, ad_spend, revenue, roas, impressions, clicks, ctr, conversions, cvr, orders, cpa, cpc, previous_delta_rate, public_comment, internal_note, created_at, updated_at",
    order: "period_start"
  },
  reports: {
    table: "reports",
    select: "id, client_id, brand_id, report_type, title, report_date, period_start, period_end, channel_id, summary, public_comment, internal_note, visibility, created_by, created_at, updated_at",
    order: "report_date"
  },
  files: {
    table: "files",
    select: "id, client_id, report_id, title, file_type, url, external_url, storage_bucket, storage_path, visibility, uploaded_by, created_at",
    order: "created_at"
  },
  "audit-logs": {
    table: "audit_logs",
    select: "id, actor_id, client_id, action, target_table, target_id, metadata, created_at",
    order: "created_at",
    audit: false,
    readonly: true
  },
  "schedule-items": {
    table: "schedule_items",
    select: "id, client_id, brand_id, title, schedule_type, status, starts_at, ends_at, assignee_id, public_comment, internal_note, visibility, created_at, updated_at",
    order: "starts_at",
    personalOnly: true
  },
  "action-plans": {
    table: "action_plans",
    select: "id, client_id, brand_id, period_week, title, category, priority, status, description, expected_impact, client_request, internal_note, is_client_visible, created_at, updated_at",
    order: "period_week"
  },
  keywords: {
    table: "keywords",
    select: "id, client_id, brand_id, keyword, priority, target_channel, is_active, internal_note, created_at, updated_at",
    order: "created_at"
  },
  "keyword-metrics": {
    table: "keyword_metrics",
    select: "id, keyword_id, client_id, period_date, current_rank, previous_rank, rank_delta, search_volume, impressions, ctr, conversion_contribution, naver_rank, coupang_rank, is_ad_exposed, needs_seo_work, monthly_search_volume, age_click_ratio, weekday_click_ratio, device_click_ratio, insight, internal_note, created_at, updated_at",
    order: "period_date"
  },
  "naver-rank-trackers": {
    table: "naver_rank_trackers",
    select: "id, client_id, brand_id, agency_code, keyword, product_url, product_id, mall_name, product_title, max_rank, status, started_at, ends_at, last_checked_at, next_check_at, current_rank, best_rank, worst_rank, check_count, found_count, last_message, sort_order, created_at, updated_at",
    order: "sort_order",
    ascending: true,
    hardDeleteBlocked: true
  },
  "naver-rank-snapshots": {
    table: "naver_rank_snapshots",
    select: "id, tracker_id, checked_at, rank, page, position, matched, checked_count, total, item, top_items, message, source, created_at",
    order: "checked_at",
    hardDeleteBlocked: true
  }
};

export function resourceHardDeleteBlocked(resource) {
  return Boolean(resources[resource]?.hardDeleteBlocked);
}

function listRoutes() {
  const names = Object.keys(resources);
  return [
    "GET /api/admin/overview?client_id=...",
    "POST /api/admin/storage/signed-upload",
    "GET /api/admin/:resource",
    "POST /api/admin/:resource",
    "PATCH /api/admin/:resource/:id",
    "DELETE /api/admin/:resource/:id",
    ...names.map((name) => `/api/admin/${name}`)
  ];
}

// 관리 API의 schedule_items 표면에는 테넌트 필터가 없어, 여기서 반환되는 행은
// 곧 "모든 계정이 공유하는 업무 운영 목록"이 된다. 대표(owner) 개인 캘린더 행은
// 이 목록에 절대 섞이면 안 된다.
//
// 이제 개인/운영을 가르는 정본 신호는 personal_role 열이다. 계정마다 개인
// 캘린더가 하나씩 생겼으므로 개인 행은 대표님 것만이 아니고, 이 표면에는
// 테넌트 필터가 없어 열 하나가 빠지면 모든 계정의 개인 일정이 그대로 노출된다.
// 그래서 personal_role IS NULL 이 1차 술어이고, 아래 운영 범위 술어는 그 열이
// 아직 없는 배포 창(코드 먼저, 마이그레이션 나중)의 대비책으로 남긴다.
//
// 범위 술어의 판별 기준은 "운영 범위가 붙어 있는가" 하나다.
//   · client_id 또는 operation_team_id 가 있으면 → 업무 운영(공유) 행. 그대로 반환한다.
//   · 둘 다 없으면 → 개인 공간 행. 제외한다.
// 구글에서 가져온 개인 일정은 client_id / operation_team_id / calendar_id 를 항상
// null 로 저장하므로(google-calendar-sync.mjs 의 mapGoogleEventToScheduleRow)
// 이 술어 하나로도 마이그레이션 전 창에서는 전부 걸러진다.
//
// google_event_id · google_calendar_id 의 유무로 거르지 않는 이유:
// 대표가 만든 행은 광고주·운영팀 범위여도 구글로 push 되면서 두 값을 갖게 된다
// (google-calendar-sync.mjs 의 ownerSyncableRows 는 client_id 를 보지 않는다).
// 즉 "구글 식별자가 있으면 개인 행" 이라는 술어는 운영 행까지 숨긴다.
const OPERATIONAL_SCOPE_ONLY = "client_id.not.is.null,operation_team_id.not.is.null";

function scopeToSharedOperationRows(query) {
  const scoped = query.is("calendar_id", null).or(OPERATIONAL_SCOPE_ONLY);
  return optionalColumnEnabled("personal_role") ? scoped.is("personal_role", null) : scoped;
}

function applyFilters(query, url, id, config = {}) {
  if (id) query = query.eq("id", id);
  if (config.personalOnly) query = scopeToSharedOperationRows(query);

  const clientId = url.searchParams.get("client_id");
  const brandId = url.searchParams.get("brand_id");
  const status = url.searchParams.get("status");
  const visibility = url.searchParams.get("visibility");
  const reportType = url.searchParams.get("report_type");
  const agencyCode = url.searchParams.get("agency_code");
  const trackerId = url.searchParams.get("tracker_id");

  if (clientId) query = query.eq("client_id", clientId);
  if (brandId) query = query.eq("brand_id", brandId);
  if (status) query = query.eq("status", status);
  if (visibility) query = query.eq("visibility", visibility);
  if (reportType) query = query.eq("report_type", reportType);
  if (agencyCode) query = query.eq("agency_code", agencyCode);
  if (trackerId) query = query.eq("tracker_id", trackerId);

  return query;
}

function nonPersonalCalendarRequested(body = {}) {
  return ["calendarId", "calendar_id"].some((key) => (
    Object.hasOwn(body, key)
      && body[key] !== null
      && body[key] !== undefined
      && String(body[key]).trim() !== ""
  ));
}

function normalizePersonalScheduleBody(body = {}) {
  delete body.calendarId;
  body.calendar_id = null;
  return body;
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data || null;
}

async function recordAuditLog(ctx, payload) {
  if (!payload?.targetTable || payload.targetTable === "audit_logs") return { logged: false };

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

  return { logged: !error, error };
}

async function handleGet(request, ctx, config, id) {
  const { url } = routeParts(request, "/api/admin");
  const limit = parseLimit(url);

  // personalOnly 자원만 새 열을 술어로 쓴다. 마이그레이션 전 창에서 42703 /
  // PGRST204 가 오면 묶음을 내리고 술어 없이 한 번 재시도한다 — 그때도
  // OPERATIONAL_SCOPE_ONLY 가 그대로 남아 개인 행은 여전히 걸러진다.
  // 나머지 자원은 예전 코드 경로를 글자 그대로 지나간다.
  const runQuery = () => applyFilters(
    ctx.supabaseAdmin.from(config.table).select(config.select),
    url, id, config,
  )
    .order(config.order, { ascending: config.ascending === true })
    .limit(limit);

  const { data, error } = config.personalOnly
    ? await runWithOptionalColumns(runQuery, OPTIONAL_PERSONAL_COLUMNS)
    : await runQuery();
  if (error) {
    return databaseError(error, `${config.table} 테이블 조회에 실패했습니다.`);
  }

  return json({ ok: true, data });
}

async function handlePost(request, ctx, config) {
  if (config.readonly) return methodNotAllowed(["GET"]);

  const body = await readBody(request);
  if (config.personalOnly && nonPersonalCalendarRequested(body)) {
    return json({ ok: false, message: "개인 일정에는 공유 캘린더를 지정할 수 없습니다." }, 400);
  }
  if (config.personalOnly) normalizePersonalScheduleBody(body);
  if (config.table === "naver_rank_trackers") body.max_rank = 300;
  if (config.table === "naver_rank_trackers" && body.sort_order == null) {
    const agencyCode = String(body.agency_code || "mml93-a01").trim().toLowerCase();
    const { data: latest, error: sortError } = await ctx.supabaseAdmin
      .from(config.table)
      .select("sort_order")
      .eq("agency_code", agencyCode)
      .order("sort_order", { ascending: false })
      .limit(1);
    if (sortError) {
      return databaseError(sortError, "순위 추적 정렬값 계산에 실패했습니다.");
    }
    body.agency_code = agencyCode;
    body.sort_order = Number(latest?.[0]?.sort_order || 0) + 100;
  }
  const { data, error } = await ctx.supabaseAdmin
    .from(config.table)
    .insert(body)
    .select(config.select);

  if (error) {
    return databaseError(error, `${config.table} 테이블 저장에 실패했습니다.`);
  }

  const row = firstRow(data);
  const audit = config.audit === false ? { logged: false } : await recordAuditLog(ctx, {
    action: `${config.table}.created`,
    clientId: row?.client_id || body.client_id || null,
    targetTable: config.table,
    targetId: row?.id || null,
    metadata: {
      source: "admin-api",
      resource: config.table,
      report_id: row?.report_id || body.report_id || null,
      visibility: row?.visibility || body.visibility || null,
    },
  });

  return json({ ok: true, data, auditLogged: audit.logged }, 201);
}

async function handlePatch(request, ctx, config, id) {
  if (config.readonly) return methodNotAllowed(["GET"]);
  if (!id) return json({ ok: false, message: "Missing resource id" }, 400);

  const body = await readBody(request);
  if (config.personalOnly && nonPersonalCalendarRequested(body)) {
    return json({ ok: false, message: "개인 일정에는 공유 캘린더를 지정할 수 없습니다." }, 400);
  }
  if (config.personalOnly) normalizePersonalScheduleBody(body);
  if (config.table === "naver_rank_trackers") body.max_rank = 300;
  const runUpdate = () => {
    const updateQuery = ctx.supabaseAdmin
      .from(config.table)
      .update(body)
      .eq("id", id);
    return (config.personalOnly ? scopeToSharedOperationRows(updateQuery) : updateQuery).select(config.select);
  };
  // 열이 아직 없으면 술어를 내리고 한 번 재시도한다. 그 재시도도 범위 술어를
  // 그대로 달고 나가므로 개인 행을 건드릴 수는 없다.
  const { data, error } = config.personalOnly
    ? await runWithOptionalColumns(runUpdate, OPTIONAL_PERSONAL_COLUMNS)
    : await runUpdate();

  if (error) {
    return databaseError(error, `${config.table} 테이블 수정에 실패했습니다.`);
  }

  const row = firstRow(data);
  if (config.personalOnly && !row) {
    return json({ ok: false, message: "수정할 개인 일정을 찾을 수 없습니다." }, 404);
  }
  const audit = config.audit === false ? { logged: false } : await recordAuditLog(ctx, {
    action: `${config.table}.updated`,
    clientId: row?.client_id || body.client_id || null,
    targetTable: config.table,
    targetId: row?.id || id,
    metadata: {
      source: "admin-api",
      resource: config.table,
      changed_fields: Object.keys(body || {}).sort(),
      visibility: row?.visibility || body.visibility || null,
    },
  });

  return json({ ok: true, data, auditLogged: audit.logged });
}

async function handleDelete(_request, ctx, config, id) {
  if (config.readonly) return methodNotAllowed(["GET"]);
  if (!id) return json({ ok: false, message: "Missing resource id" }, 400);
  if (config.hardDeleteBlocked) {
    return json({
      ok: false,
      code: "HARD_DELETE_BLOCKED",
      message: "운영 중인 계정 및 순위 이력은 일반 관리 API에서 영구 삭제할 수 없습니다.",
    }, 409);
  }

  const runDelete = () => {
    const deleteQuery = ctx.supabaseAdmin
      .from(config.table)
      .delete()
      .eq("id", id);
    return (config.personalOnly ? scopeToSharedOperationRows(deleteQuery) : deleteQuery).select(config.select);
  };
  const { data, error } = config.personalOnly
    ? await runWithOptionalColumns(runDelete, OPTIONAL_PERSONAL_COLUMNS)
    : await runDelete();

  if (error) {
    return databaseError(error, `${config.table} 테이블 삭제에 실패했습니다.`);
  }

  const row = firstRow(data);
  if (config.personalOnly && !row) {
    return json({ ok: false, message: "삭제할 개인 일정을 찾을 수 없습니다." }, 404);
  }
  const audit = config.audit === false ? { logged: false } : await recordAuditLog(ctx, {
    action: `${config.table}.deleted`,
    clientId: row?.client_id || null,
    targetTable: config.table,
    targetId: row?.id || id,
    metadata: {
      source: "admin-api",
      resource: config.table,
      title: row?.title || null,
      visibility: row?.visibility || null,
    },
  });

  return json({ ok: true, data, auditLogged: audit.logged });
}

export async function handleAdminApiRequest(request, ctx) {
  const { resource, id } = routeParts(request, "/api/admin");

  if (resource === "overview") {
    return handleOverview(request, ctx);
  }

  if (resource === "storage") {
    return handleStorage(request, ctx, id);
  }

  const config = resources[resource];

  if (!config) return notFound(listRoutes());

  if (request.method === "GET") return handleGet(request, ctx, config, id);
  if (request.method === "POST") return handlePost(request, ctx, config);
  if (request.method === "PATCH") return handlePatch(request, ctx, config, id);
  if (request.method === "DELETE") return handleDelete(request, ctx, config, id);

  return methodNotAllowed(["GET", "POST", "PATCH", "DELETE"]);
}

export default {
  fetch: withSupabase({ auth: "secret" }, handleAdminApiRequest)
};

async function handleOverview(request, ctx) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);

  const { url } = routeParts(request, "/api/admin");
  const clientId = url.searchParams.get("client_id");
  if (!clientId) {
    return json({ ok: false, message: "client_id is required" }, 400);
  }

  const filterBrand = (query) => {
    const brandId = url.searchParams.get("brand_id");
    if (brandId) query = query.eq("brand_id", brandId);
    return query;
  };

  const queries = {
    client: ctx.supabaseAdmin
      .from("clients")
      .select(resources.clients.select)
      .eq("id", clientId)
      .maybeSingle(),
    brands: ctx.supabaseAdmin
      .from("brands")
      .select(resources.brands.select)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false }),
    dashboard: filterBrand(
      ctx.supabaseAdmin
        .from("dashboard_snapshots")
        .select(resources["dashboard-snapshots"].select)
        .eq("client_id", clientId)
    )
      .order("period", { ascending: false })
      .limit(1),
    adPerformance: filterBrand(
      ctx.supabaseAdmin
        .from("ad_performance")
        .select(resources["ad-performance"].select)
        .eq("client_id", clientId)
    )
      .order("period_start", { ascending: false })
      .limit(6),
    reports: filterBrand(
      ctx.supabaseAdmin
        .from("reports")
        .select(resources.reports.select)
        .eq("client_id", clientId)
    )
      .order("report_date", { ascending: false })
      .limit(8),
    // 광고주 범위 개요라 client_id 조건만으로도 개인 행은 이미 걸린다(개인 행의
    // client_id 는 언제나 null 이다). 그래도 열이 살아 있으면 한 겹 더 건다 —
    // 이 표면도 테넌트 필터가 없는 관리 API 이고, 유출은 한 번이면 끝이다.
    // 열이 아직 없는 창에서는 묶음을 내리고 술어 없이 한 번 재시도한다.
    schedule: runWithOptionalColumns(() => {
      const base = filterBrand(
        ctx.supabaseAdmin
          .from("schedule_items")
          .select(resources["schedule-items"].select)
          .eq("client_id", clientId)
          .is("calendar_id", null)
      );
      const scoped = optionalColumnEnabled("personal_role") ? base.is("personal_role", null) : base;
      return scoped
        .order("starts_at", { ascending: true })
        .limit(10);
    }, OPTIONAL_PERSONAL_COLUMNS),
    actionPlans: filterBrand(
      ctx.supabaseAdmin
        .from("action_plans")
        .select(resources["action-plans"].select)
        .eq("client_id", clientId)
    )
      .order("period_week", { ascending: false })
      .limit(8),
    keywords: filterBrand(
      ctx.supabaseAdmin
        .from("keywords")
        .select(resources.keywords.select)
        .eq("client_id", clientId)
    )
      .order("created_at", { ascending: false })
      .limit(10)
  };

  const entries = await Promise.all(
    Object.entries(queries).map(async ([key, query]) => [key, await query])
  );

  const errors = entries
    .map(([key, result]) => result.error ? { key, message: result.error.message, code: result.error.code } : null)
    .filter(Boolean);

  if (errors.length) {
    return json({
      ok: false,
      message: "overview 조회 중 일부 테이블에서 오류가 발생했습니다.",
      errors
    }, 500);
  }

  const data = Object.fromEntries(entries.map(([key, result]) => [key, result.data]));
  return json({ ok: true, data });
}

async function handleStorage(request, ctx, action) {
  if (action !== "signed-upload") return notFound(["POST /api/admin/storage/signed-upload"]);
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const body = await readBody(request);
  const bucket = String(body.bucket || "moment-reports").trim();
  const filePath = String(body.path || body.file_path || "").trim();

  if (!["moment-reports", "moment-assets"].includes(bucket)) {
    return json({ ok: false, message: "Invalid storage bucket" }, 400);
  }

  if (!filePath || filePath.startsWith("/") || filePath.includes("..")) {
    return json({ ok: false, message: "Invalid storage path" }, 400);
  }

  const { data, error } = await ctx.supabaseAdmin
    .storage
    .from(bucket)
    .createSignedUploadUrl(filePath);

  if (error) {
    return databaseError(error, "Storage 업로드 URL 생성에 실패했습니다.");
  }

  return json({
    ok: true,
    bucket,
    path: filePath,
    data
  });
}

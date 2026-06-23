import { withSupabase } from "@supabase/server";
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
    order: "created_at"
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
  "schedule-items": {
    table: "schedule_items",
    select: "id, client_id, brand_id, title, schedule_type, status, starts_at, ends_at, assignee_id, public_comment, internal_note, visibility, created_at, updated_at",
    order: "starts_at"
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
  }
};

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

function applyFilters(query, url, id) {
  if (id) query = query.eq("id", id);

  const clientId = url.searchParams.get("client_id");
  const brandId = url.searchParams.get("brand_id");
  const status = url.searchParams.get("status");
  const visibility = url.searchParams.get("visibility");
  const reportType = url.searchParams.get("report_type");

  if (clientId) query = query.eq("client_id", clientId);
  if (brandId) query = query.eq("brand_id", brandId);
  if (status) query = query.eq("status", status);
  if (visibility) query = query.eq("visibility", visibility);
  if (reportType) query = query.eq("report_type", reportType);

  return query;
}

async function handleGet(request, ctx, config, id) {
  const { url } = routeParts(request, "/api/admin");
  const limit = parseLimit(url);

  let query = ctx.supabaseAdmin
    .from(config.table)
    .select(config.select);

  query = applyFilters(query, url, id)
    .order(config.order, { ascending: false })
    .limit(limit);

  const { data, error } = await query;
  if (error) {
    return databaseError(error, `${config.table} 테이블 조회에 실패했습니다.`);
  }

  return json({ ok: true, data });
}

async function handlePost(request, ctx, config) {
  const body = await readBody(request);
  const { data, error } = await ctx.supabaseAdmin
    .from(config.table)
    .insert(body)
    .select(config.select);

  if (error) {
    return databaseError(error, `${config.table} 테이블 저장에 실패했습니다.`);
  }

  return json({ ok: true, data }, 201);
}

async function handlePatch(request, ctx, config, id) {
  if (!id) return json({ ok: false, message: "Missing resource id" }, 400);

  const body = await readBody(request);
  const { data, error } = await ctx.supabaseAdmin
    .from(config.table)
    .update(body)
    .eq("id", id)
    .select(config.select);

  if (error) {
    return databaseError(error, `${config.table} 테이블 수정에 실패했습니다.`);
  }

  return json({ ok: true, data });
}

async function handleDelete(_request, ctx, config, id) {
  if (!id) return json({ ok: false, message: "Missing resource id" }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from(config.table)
    .delete()
    .eq("id", id)
    .select(config.select);

  if (error) {
    return databaseError(error, `${config.table} 테이블 삭제에 실패했습니다.`);
  }

  return json({ ok: true, data });
}

export default {
  fetch: withSupabase({ auth: "secret" }, async (request, ctx) => {
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
  })
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
    schedule: filterBrand(
      ctx.supabaseAdmin
        .from("schedule_items")
        .select(resources["schedule-items"].select)
        .eq("client_id", clientId)
    )
      .order("starts_at", { ascending: true })
      .limit(10),
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

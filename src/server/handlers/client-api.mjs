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
  me: {
    table: "profiles",
    select: "id, name, email, role, status, created_at, updated_at",
    order: "updated_at",
    self: true
  },
  dashboard: {
    table: "dashboard_snapshots",
    select: "id, client_id, brand_id, period, sales, ad_spend, roas, impressions, clicks, orders, reviews, conversion_rate, click_rate, achievement_rate, public_comment, updated_at",
    order: "period"
  },
  brands: {
    table: "brands",
    select: "id, client_id, name, category, main_marketplace, status, created_at, updated_at",
    order: "created_at"
  },
  "ad-performance": {
    table: "ad_performance",
    select: "id, client_id, brand_id, channel_id, period_start, period_end, ad_spend, revenue, roas, impressions, clicks, ctr, conversions, cvr, orders, cpa, cpc, previous_delta_rate, public_comment, updated_at",
    order: "period_start"
  },
  "kpi-targets": {
    table: "kpi_targets",
    select: "id, client_id, brand_id, period_month, target_revenue, target_ad_spend, target_roas, target_orders, target_reviews, target_keyword_rank, created_at, updated_at",
    order: "period_month"
  },
  "kpi-results": {
    table: "kpi_results",
    select: "id, kpi_target_id, client_id, actual_revenue, actual_ad_spend, actual_roas, actual_orders, actual_cpa, actual_cpc, actual_ctr, actual_cvr, actual_reviews, achievement_rate, public_comment, updated_at",
    order: "updated_at"
  },
  reports: {
    table: "reports",
    select: "id, client_id, brand_id, report_type, title, report_date, period_start, period_end, channel_id, summary, public_comment, visibility, created_at, updated_at",
    order: "report_date",
    visibleOnly: true
  },
  files: {
    table: "files",
    select: "id, client_id, report_id, title, file_type, url, external_url, storage_bucket, storage_path, visibility, created_at",
    order: "created_at",
    visibleOnly: true
  },
  "schedule-items": {
    table: "schedule_items",
    select: "id, client_id, brand_id, title, schedule_type, status, starts_at, ends_at, assignee_id, public_comment, visibility, created_at, updated_at",
    order: "starts_at",
    visibleOnly: true
  },
  "action-plans": {
    table: "action_plans",
    select: "id, client_id, brand_id, period_week, title, category, priority, status, description, expected_impact, client_request, is_client_visible, created_at, updated_at",
    order: "period_week",
    clientVisibleFlag: true
  },
  keywords: {
    table: "keywords",
    select: "id, client_id, brand_id, keyword, priority, target_channel, is_active, created_at, updated_at",
    order: "created_at"
  },
  "keyword-metrics": {
    table: "keyword_metrics",
    select: "id, keyword_id, client_id, period_date, current_rank, previous_rank, rank_delta, search_volume, impressions, ctr, conversion_contribution, naver_rank, coupang_rank, is_ad_exposed, needs_seo_work, monthly_search_volume, age_click_ratio, weekday_click_ratio, device_click_ratio, insight, created_at, updated_at",
    order: "period_date"
  }
};

function listRoutes() {
  return [
    "GET /api/client/overview",
    ...Object.keys(resources).map((name) => `GET /api/client/${name}`),
    "POST /api/client/agency-code/connect"
  ];
}

function applyFilters(query, url, config, userId) {
  if (config.self) query = query.eq("id", userId);

  const clientId = url.searchParams.get("client_id");
  const brandId = url.searchParams.get("brand_id");
  const reportType = url.searchParams.get("report_type");
  const keywordId = url.searchParams.get("keyword_id");

  if (clientId) query = query.eq("client_id", clientId);
  if (brandId) query = query.eq("brand_id", brandId);
  if (reportType) query = query.eq("report_type", reportType);
  if (keywordId) query = query.eq("keyword_id", keywordId);
  if (config.visibleOnly) query = query.eq("visibility", "client_visible");
  if (config.clientVisibleFlag) query = query.eq("is_client_visible", true);

  return query;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    const { url, resource } = routeParts(request, "/api/client");

    if (resource === "agency-code") {
      return handleAgencyCode(request, ctx);
    }

    if (request.method !== "GET") return methodNotAllowed(["GET"]);

    if (resource === "overview") {
      return handleOverview(request, ctx);
    }

    const config = resources[resource];
    if (!config) return notFound(listRoutes());

    const limit = parseLimit(url);
    const userId = ctx.userClaims?.sub || ctx.userClaims?.id || null;

    let query = ctx.supabase
      .from(config.table)
      .select(config.select);

    query = applyFilters(query, url, config, userId)
      .order(config.order, { ascending: false })
      .limit(limit);

    const { data, error } = await query;
    if (error) {
      return databaseError(error, `${config.table} 테이블 조회에 실패했습니다.`);
    }

    return json({
      ok: true,
      user: {
        id: userId,
        email: ctx.userClaims?.email || null
      },
      data
    });
  })
};

async function handleAgencyCode(request, ctx) {
  const { id: action } = routeParts(request, "/api/client");

  if (action !== "connect") return notFound(listRoutes());
  if (request.method !== "POST") return methodNotAllowed(["POST"]);

  const userId = ctx.userClaims?.sub || ctx.userClaims?.id || null;
  if (!userId) return json({ ok: false, message: "Missing user id" }, 401);

  const body = await readBody(request);
  const agencyCode = String(body.agency_code || body.agencyCode || "").trim().toUpperCase();
  if (!agencyCode) {
    return json({ ok: false, message: "agency_code is required" }, 400);
  }

  const { data: client, error: clientError } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, public_summary")
    .eq("agency_code", agencyCode)
    .neq("status", "archived")
    .maybeSingle();

  if (clientError) {
    return databaseError(clientError, "대행사 코드로 광고주를 찾는 중 오류가 발생했습니다.");
  }

  if (!client) {
    return json({ ok: false, message: "유효하지 않은 대행사 코드입니다." }, 404);
  }

  const email = ctx.userClaims?.email || null;
  const name =
    ctx.userClaims?.user_metadata?.name ||
    ctx.userClaims?.user_metadata?.full_name ||
    email ||
    "광고주";

  const { data: existingProfile, error: profileLookupError } = await ctx.supabaseAdmin
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();

  if (profileLookupError) {
    return databaseError(profileLookupError, "광고주 프로필 확인에 실패했습니다.");
  }

  const profileQuery = existingProfile
    ? ctx.supabaseAdmin
      .from("profiles")
      .update({ email, name, status: "active" })
      .eq("id", userId)
    : ctx.supabaseAdmin
      .from("profiles")
      .insert({ id: userId, email, name, role: "client_viewer", status: "active" });

  const { error: profileError } = await profileQuery;

  if (profileError) {
    return databaseError(profileError, "광고주 프로필 저장에 실패했습니다.");
  }

  const { data: membership, error: memberError } = await ctx.supabaseAdmin
    .from("client_members")
    .upsert({
      client_id: client.id,
      user_id: userId,
      role: "client_viewer"
    }, { onConflict: "client_id,user_id" })
    .select("id, client_id, user_id, role, created_at")
    .single();

  if (memberError) {
    return databaseError(memberError, "광고주 연결 저장에 실패했습니다.");
  }

  return json({
    ok: true,
    client,
    membership
  });
}

async function handleOverview(request, ctx) {
  const { url } = routeParts(request, "/api/client");
  const clientId = url.searchParams.get("client_id");
  const brandId = url.searchParams.get("brand_id");

  const filterClient = (query) => {
    if (clientId) query = query.eq("client_id", clientId);
    if (brandId) query = query.eq("brand_id", brandId);
    return query;
  };

  const queries = {
    dashboard: filterClient(
      ctx.supabase
        .from("dashboard_snapshots")
        .select(resources.dashboard.select)
    )
      .order("period", { ascending: false })
      .limit(1),
    brands: clientId
      ? ctx.supabase
        .from("brands")
        .select(resources.brands.select)
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
      : ctx.supabase
        .from("brands")
        .select(resources.brands.select)
        .order("created_at", { ascending: false })
        .limit(10),
    reports: filterClient(
      ctx.supabase
        .from("reports")
        .select(resources.reports.select)
        .eq("visibility", "client_visible")
    )
      .order("report_date", { ascending: false })
      .limit(5),
    schedule: filterClient(
      ctx.supabase
        .from("schedule_items")
        .select(resources["schedule-items"].select)
        .eq("visibility", "client_visible")
    )
      .order("starts_at", { ascending: true })
      .limit(8),
    actionPlans: filterClient(
      ctx.supabase
        .from("action_plans")
        .select(resources["action-plans"].select)
        .eq("is_client_visible", true)
    )
      .order("period_week", { ascending: false })
      .limit(5),
    keywords: filterClient(
      ctx.supabase
        .from("keywords")
        .select(resources.keywords.select)
        .eq("is_active", true)
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

  return json({
    ok: true,
    data
  });
}

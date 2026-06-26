import { withSupabase } from "npm:@supabase/server";

type ResourceConfig = {
  table: string;
  select: string;
  order: string;
  self?: boolean;
  visibleOnly?: boolean;
  clientVisibleFlag?: boolean;
};

const demoClientId = "11111111-1111-4111-8111-111111111111";

const adminResources: Record<string, ResourceConfig> = {
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

const clientResources: Record<string, ResourceConfig> = {
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

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function normalizePath(request: Request) {
  const url = new URL(request.url);
  let path = url.pathname
    .replace(/^\/functions\/v1\/moment-api/, "")
    .replace(/^\/moment-api/, "");
  if (!path) path = "/";

  return { url, path };
}

function routeParts(path: string, prefix: string) {
  const parts = path.replace(prefix, "").split("/").filter(Boolean);
  return {
    resource: parts[0] || "",
    id: parts[1] || null
  };
}

async function readBody(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};

  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function parseLimit(url: URL, fallback = 50, max = 200) {
  const raw = Number(url.searchParams.get("limit") || fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

function dbError(error: { message: string; code?: string }, hint: string) {
  return json({
    ok: false,
    message: error.message,
    code: error.code,
    hint
  }, 500);
}

function formatMoney(value: unknown) {
  const amount = Number(value || 0);
  if (amount >= 10000) return `${Math.round(amount / 10000).toLocaleString("ko-KR")}만원`;
  return `${amount.toLocaleString("ko-KR")}원`;
}

function formatPercent(value: unknown) {
  const number = Number(value || 0);
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

function formatDate(value: unknown) {
  if (!value) return "-";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function buildPublicState(data: any) {
  const client = data.client || {};
  const dashboard = data.dashboard?.[0] || {};
  const schedule = data.schedule?.[0] || {};
  const reports = data.reports || [];
  const actions = data.actionPlans || [];
  const keywords = data.keywords || [];
  const publicComment =
    dashboard.public_comment ||
    actions[0]?.description ||
    client.public_summary ||
    "공개 코멘트를 준비 중입니다.";

  return {
    code: client.agency_code || "MI-DEMO-01",
    client: client.name || "브랜드 A",
    sales: formatMoney(dashboard.sales),
    roas: formatPercent(dashboard.roas),
    adSpend: formatMoney(dashboard.ad_spend),
    orders: `${Number(dashboard.orders || 0).toLocaleString("ko-KR")}건`,
    achievement: formatPercent(dashboard.achievement_rate),
    status: Number(dashboard.achievement_rate || 0) >= 100 ? "목표 초과" : "진행 중",
    nextSchedule: schedule.title ? `${formatDate(schedule.starts_at)} ${schedule.title}` : "일정 준비 중",
    updatedAt: dashboard.updated_at ? dashboard.updated_at.slice(0, 10).replace(/-/g, ".") : "-",
    comment: publicComment,
    reports: reports.map((report: any) => ({
      title: report.title,
      type: report.report_type,
      date: report.report_date,
      summary: report.summary,
      comment: report.public_comment
    })),
    actions: actions.map((action: any) => ({
      title: action.title,
      status: action.status,
      priority: action.priority,
      description: action.description,
      expectedImpact: action.expected_impact,
      clientRequest: action.client_request
    })),
    keywords: keywords.map((keyword: any) => ({
      keyword: keyword.keyword,
      priority: keyword.priority,
      channel: keyword.target_channel
    })),
    schedules: (data.schedule || []).map((item: any) => ({
      date: formatDate(item.starts_at),
      title: item.title,
      detail: item.public_comment || item.schedule_type,
      status: item.status === "planned" ? "예정" : item.status === "in_progress" ? "진행 중" : item.status
    })),
    channelDetails: [
      {
        name: "네이버",
        type: "검색 기반",
        sales: formatMoney(dashboard.sales),
        adSpend: formatMoney(dashboard.ad_spend),
        roas: formatPercent(dashboard.roas),
        orders: `${Number(dashboard.orders || 0).toLocaleString("ko-KR")}건`,
        ctr: formatPercent(dashboard.click_rate),
        cvr: formatPercent(dashboard.conversion_rate),
        cpa: "-",
        cpc: "-",
        summary: publicComment
      },
      {
        name: "쿠팡",
        type: "2차 연동 예정",
        sales: "연동 전",
        adSpend: "연동 전",
        roas: "연동 전",
        orders: "연동 전",
        ctr: "-",
        cvr: "-",
        cpa: "-",
        cpc: "-",
        summary: "현재 테스트는 네이버 검색 기반 공개 데이터 중심으로 진행합니다."
      }
    ]
  };
}

function applyAdminFilters(query: any, url: URL, id: string | null) {
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

function applyClientFilters(query: any, url: URL, config: ResourceConfig, userId: string | null) {
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

async function handleAgencyCodeConnect(request: Request, ctx: any) {
  const { path } = normalizePath(request);
  const { id: action } = routeParts(path, "/api/client");

  if (action !== "connect") {
    return json({
      ok: false,
      message: "Not found",
      routes: ["POST /api/client/agency-code/connect"]
    }, 404);
  }

  if (request.method !== "POST") {
    return json({ ok: false, message: "Method not allowed" }, 405);
  }

  const userId = ctx.userClaims?.sub || ctx.userClaims?.id || null;
  if (!userId) return json({ ok: false, message: "Missing user id" }, 401);

  const body = await readBody(request);
  const agencyCode = String(body.agency_code || body.agencyCode || "").trim().toLowerCase();
  if (!agencyCode) return json({ ok: false, message: "agency_code is required" }, 400);

  const { data: client, error: clientError } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, public_summary")
    .ilike("agency_code", agencyCode)
    .eq("status", "active")
    .maybeSingle();

  if (clientError) {
    return dbError(clientError, "대행사 코드로 광고주를 찾는 중 오류가 발생했습니다.");
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
    return dbError(profileLookupError, "광고주 프로필 확인에 실패했습니다.");
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
  if (profileError) return dbError(profileError, "광고주 프로필 저장에 실패했습니다.");

  const { data: membership, error: memberError } = await ctx.supabaseAdmin
    .from("client_members")
    .upsert({
      client_id: client.id,
      user_id: userId,
      role: "client_viewer"
    }, { onConflict: "client_id,user_id" })
    .select("id, client_id, user_id, role, created_at")
    .single();

  if (memberError) return dbError(memberError, "광고주 연결 저장에 실패했습니다.");

  return json({ ok: true, client, membership });
}

async function handleAdminOverview(request: Request, ctx: any) {
  if (request.method !== "GET") return json({ ok: false, message: "Method not allowed" }, 405);

  const { url } = normalizePath(request);
  const clientId = url.searchParams.get("client_id");
  if (!clientId) return json({ ok: false, message: "client_id is required" }, 400);

  const filterBrand = (query: any) => {
    const brandId = url.searchParams.get("brand_id");
    if (brandId) query = query.eq("brand_id", brandId);
    return query;
  };

  const queries = {
    client: ctx.supabaseAdmin
      .from("clients")
      .select(adminResources.clients.select)
      .eq("id", clientId)
      .maybeSingle(),
    brands: ctx.supabaseAdmin
      .from("brands")
      .select(adminResources.brands.select)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false }),
    dashboard: filterBrand(
      ctx.supabaseAdmin
        .from("dashboard_snapshots")
        .select(adminResources["dashboard-snapshots"].select)
        .eq("client_id", clientId)
    )
      .order("period", { ascending: false })
      .limit(1),
    adPerformance: filterBrand(
      ctx.supabaseAdmin
        .from("ad_performance")
        .select(adminResources["ad-performance"].select)
        .eq("client_id", clientId)
    )
      .order("period_start", { ascending: false })
      .limit(6),
    reports: filterBrand(
      ctx.supabaseAdmin
        .from("reports")
        .select(adminResources.reports.select)
        .eq("client_id", clientId)
    )
      .order("report_date", { ascending: false })
      .limit(8),
    schedule: filterBrand(
      ctx.supabaseAdmin
        .from("schedule_items")
        .select(adminResources["schedule-items"].select)
        .eq("client_id", clientId)
    )
      .order("starts_at", { ascending: true })
      .limit(10),
    actionPlans: filterBrand(
      ctx.supabaseAdmin
        .from("action_plans")
        .select(adminResources["action-plans"].select)
        .eq("client_id", clientId)
    )
      .order("period_week", { ascending: false })
      .limit(8),
    keywords: filterBrand(
      ctx.supabaseAdmin
        .from("keywords")
        .select(adminResources.keywords.select)
        .eq("client_id", clientId)
    )
      .order("created_at", { ascending: false })
      .limit(10)
  };

  const entries = await Promise.all(
    Object.entries(queries).map(async ([key, query]) => [key, await query])
  );
  const errors = entries
    .map(([key, result]: any) => result.error ? { key, message: result.error.message, code: result.error.code } : null)
    .filter(Boolean);

  if (errors.length) {
    return json({ ok: false, message: "overview 조회 중 일부 테이블에서 오류가 발생했습니다.", errors }, 500);
  }

  return json({ ok: true, data: Object.fromEntries(entries.map(([key, result]: any) => [key, result.data])) });
}

async function handleAdminStorage(request: Request, ctx: any) {
  const { path } = normalizePath(request);
  const { id: action } = routeParts(path, "/api/admin");

  if (action !== "signed-upload") {
    return json({
      ok: false,
      message: "Not found",
      routes: ["POST /api/admin/storage/signed-upload"]
    }, 404);
  }

  if (request.method !== "POST") {
    return json({ ok: false, message: "Method not allowed" }, 405);
  }

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

  if (error) return dbError(error, "Storage 업로드 URL 생성에 실패했습니다.");

  return json({ ok: true, bucket, path: filePath, data });
}

async function handleClientOverview(request: Request, ctx: any) {
  if (request.method !== "GET") return json({ ok: false, message: "Method not allowed" }, 405);

  const { url } = normalizePath(request);
  const clientId = url.searchParams.get("client_id");
  const brandId = url.searchParams.get("brand_id");

  const filterClient = (query: any) => {
    if (clientId) query = query.eq("client_id", clientId);
    if (brandId) query = query.eq("brand_id", brandId);
    return query;
  };

  const queries = {
    dashboard: filterClient(
      ctx.supabase
        .from("dashboard_snapshots")
        .select(clientResources.dashboard.select)
    )
      .order("period", { ascending: false })
      .limit(1),
    brands: clientId
      ? ctx.supabase
        .from("brands")
        .select(clientResources.brands.select)
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
      : ctx.supabase
        .from("brands")
        .select(clientResources.brands.select)
        .order("created_at", { ascending: false })
        .limit(10),
    reports: filterClient(
      ctx.supabase
        .from("reports")
        .select(clientResources.reports.select)
        .eq("visibility", "client_visible")
    )
      .order("report_date", { ascending: false })
      .limit(5),
    schedule: filterClient(
      ctx.supabase
        .from("schedule_items")
        .select(clientResources["schedule-items"].select)
        .eq("visibility", "client_visible")
    )
      .order("starts_at", { ascending: true })
      .limit(8),
    actionPlans: filterClient(
      ctx.supabase
        .from("action_plans")
        .select(clientResources["action-plans"].select)
        .eq("is_client_visible", true)
    )
      .order("period_week", { ascending: false })
      .limit(5),
    keywords: filterClient(
      ctx.supabase
        .from("keywords")
        .select(clientResources.keywords.select)
        .eq("is_active", true)
    )
      .order("created_at", { ascending: false })
      .limit(10)
  };

  const entries = await Promise.all(
    Object.entries(queries).map(async ([key, query]) => [key, await query])
  );
  const errors = entries
    .map(([key, result]: any) => result.error ? { key, message: result.error.message, code: result.error.code } : null)
    .filter(Boolean);

  if (errors.length) {
    return json({ ok: false, message: "overview 조회 중 일부 테이블에서 오류가 발생했습니다.", errors }, 500);
  }

  return json({ ok: true, data: Object.fromEntries(entries.map(([key, result]: any) => [key, result.data])) });
}

const health = withSupabase({ auth: "none" }, async (_request, ctx) => {
  return json({
    ok: true,
    service: "moment-insight-edge-api",
    authMode: ctx.authMode,
    time: new Date().toISOString()
  });
});

const demo = withSupabase({ auth: "none" }, async (request, ctx) => {
  const { path } = normalizePath(request);
  const { resource } = routeParts(path, "/api/demo");

  if (request.method !== "GET" || resource !== "overview") {
    return json({ ok: false, message: "Not found", routes: ["GET /api/demo/overview"] }, 404);
  }

  const queries = {
    client: ctx.supabaseAdmin
      .from("clients")
      .select("id, name, agency_code, status, public_summary, created_at, updated_at")
      .eq("id", demoClientId)
      .maybeSingle(),
    dashboard: ctx.supabaseAdmin
      .from("dashboard_snapshots")
      .select("id, client_id, brand_id, period, sales, ad_spend, roas, impressions, clicks, orders, reviews, conversion_rate, click_rate, achievement_rate, public_comment, updated_at")
      .eq("client_id", demoClientId)
      .order("period", { ascending: false })
      .limit(1),
    reports: ctx.supabaseAdmin
      .from("reports")
      .select("id, client_id, brand_id, report_type, title, report_date, summary, public_comment, visibility, updated_at")
      .eq("client_id", demoClientId)
      .eq("visibility", "client_visible")
      .order("report_date", { ascending: false })
      .limit(5),
    schedule: ctx.supabaseAdmin
      .from("schedule_items")
      .select("id, client_id, brand_id, title, schedule_type, status, starts_at, ends_at, public_comment, visibility, updated_at")
      .eq("client_id", demoClientId)
      .eq("visibility", "client_visible")
      .order("starts_at", { ascending: true })
      .limit(8),
    actionPlans: ctx.supabaseAdmin
      .from("action_plans")
      .select("id, client_id, brand_id, period_week, title, category, priority, status, description, expected_impact, client_request, is_client_visible, updated_at")
      .eq("client_id", demoClientId)
      .eq("is_client_visible", true)
      .order("period_week", { ascending: false })
      .limit(5),
    keywords: ctx.supabaseAdmin
      .from("keywords")
      .select("id, client_id, brand_id, keyword, priority, target_channel, is_active, updated_at")
      .eq("client_id", demoClientId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(10)
  };

  const entries = await Promise.all(
    Object.entries(queries).map(async ([key, query]) => [key, await query])
  );
  const errors = entries
    .map(([key, result]: any) => result.error ? { key, message: result.error.message, code: result.error.code } : null)
    .filter(Boolean);

  if (errors.length) {
    return json({ ok: false, message: "데모 공개 데이터 조회 중 오류가 발생했습니다.", errors }, 500);
  }

  const data = Object.fromEntries(entries.map(([key, result]: any) => [key, result.data]));
  if (!data.client) {
    return json({ ok: false, message: "데모 광고주 데이터가 없습니다. npm run seed:demo를 먼저 실행하세요." }, 404);
  }

  return json({ ok: true, data, publicState: buildPublicState(data) });
});

const admin = withSupabase({ auth: "secret" }, async (request, ctx) => {
  const { url, path } = normalizePath(request);
  const { resource, id } = routeParts(path, "/api/admin");

  if (resource === "overview") return handleAdminOverview(request, ctx);
  if (resource === "storage") return handleAdminStorage(request, ctx);

  const config = adminResources[resource];

  if (!config) {
    return json({
      ok: false,
      message: "Not found",
      routes: Object.keys(adminResources).map((name) => `/api/admin/${name}`)
    }, 404);
  }

  if (request.method === "GET") {
    const limit = parseLimit(url);
    let query = ctx.supabaseAdmin.from(config.table).select(config.select);
    query = applyAdminFilters(query, url, id)
      .order(config.order, { ascending: false })
      .limit(limit);

    const { data, error } = await query;
    if (error) return dbError(error, `${config.table} 테이블 조회에 실패했습니다.`);
    return json({ ok: true, data });
  }

  if (request.method === "POST") {
    const body = await readBody(request);
    const { data, error } = await ctx.supabaseAdmin
      .from(config.table)
      .insert(body)
      .select(config.select);

    if (error) return dbError(error, `${config.table} 테이블 저장에 실패했습니다.`);
    return json({ ok: true, data }, 201);
  }

  if (request.method === "PATCH") {
    if (!id) return json({ ok: false, message: "Missing resource id" }, 400);
    const body = await readBody(request);
    const { data, error } = await ctx.supabaseAdmin
      .from(config.table)
      .update(body)
      .eq("id", id)
      .select(config.select);

    if (error) return dbError(error, `${config.table} 테이블 수정에 실패했습니다.`);
    return json({ ok: true, data });
  }

  if (request.method === "DELETE") {
    if (!id) return json({ ok: false, message: "Missing resource id" }, 400);
    const { data, error } = await ctx.supabaseAdmin
      .from(config.table)
      .delete()
      .eq("id", id)
      .select(config.select);

    if (error) return dbError(error, `${config.table} 테이블 삭제에 실패했습니다.`);
    return json({ ok: true, data });
  }

  return json({ ok: false, message: "Method not allowed" }, 405);
});

const client = withSupabase({ auth: "user" }, async (request, ctx) => {
  const { url, path } = normalizePath(request);
  const { resource } = routeParts(path, "/api/client");

  if (resource === "agency-code") return handleAgencyCodeConnect(request, ctx);
  if (resource === "overview") return handleClientOverview(request, ctx);

  if (request.method !== "GET") {
    return json({ ok: false, message: "Method not allowed" }, 405);
  }
  const config = clientResources[resource];

  if (!config) {
    return json({
      ok: false,
      message: "Not found",
      routes: [
        ...Object.keys(clientResources).map((name) => `/api/client/${name}`),
        "POST /api/client/agency-code/connect"
      ]
    }, 404);
  }

  const limit = parseLimit(url);
  const userId = ctx.userClaims?.sub || ctx.userClaims?.id || null;
  let query = ctx.supabase.from(config.table).select(config.select);
  query = applyClientFilters(query, url, config, userId)
    .order(config.order, { ascending: false })
    .limit(limit);

  const { data, error } = await query;
  if (error) return dbError(error, `${config.table} 테이블 조회에 실패했습니다.`);

  return json({
    ok: true,
    user: {
      id: userId,
      email: ctx.userClaims?.email || null
    },
    data
  });
});

export default {
  async fetch(request: Request) {
    const { path } = normalizePath(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    if (path === "/" || path === "/health") return health(request);
    if (path.startsWith("/api/admin/")) return admin(request);
    if (path.startsWith("/api/client/")) return client(request);
    if (path.startsWith("/api/demo/")) return demo(request);

    return json({
      ok: false,
      message: "Not found",
      routes: [
        "GET /health",
        "GET /api/demo/overview",
        "GET /api/client/:resource",
        "GET /api/admin/:resource",
        "POST /api/admin/:resource",
        "PATCH /api/admin/:resource/:id",
        "DELETE /api/admin/:resource/:id"
      ]
    }, 404);
  }
};

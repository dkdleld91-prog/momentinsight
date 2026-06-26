import { withSupabase } from "@supabase/server";
import { databaseError, json, methodNotAllowed, notFound, readBody, routeParts } from "../http.mjs";
import { safeEqual } from "../security.mjs";

const demoClientId = "11111111-1111-4111-8111-111111111111";
const demoBrandId = "22222222-2222-4222-8222-222222222222";

function demoPublicStateEnabled() {
  return process.env.MI_DEMO_PUBLIC_STATE_ENABLED === "true" && Boolean(process.env.MI_DEMO_ADMIN_CODE);
}

function formatMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 10000) return `${Math.round(amount / 10000).toLocaleString("ko-KR")}만원`;
  return `${amount.toLocaleString("ko-KR")}원`;
}

function formatPercent(value) {
  const number = Number(value || 0);
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function parseNumber(value) {
  return Number(String(value || "").replace(/[^0-9.-]/g, "")) || 0;
}

function parseMoney(value) {
  const raw = String(value || "").trim();
  const number = parseNumber(raw);
  if (raw.includes("만원")) return number * 10000;
  return number;
}

function parsePercent(value) {
  return parseNumber(value);
}

function parseCount(value) {
  return Math.round(parseNumber(value));
}

function monthPeriod(value) {
  const date = value ? new Date(String(value).replace(/\./g, "-")) : new Date();
  const base = Number.isNaN(date.getTime()) ? new Date() : date;
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function dateFromShort(value) {
  const text = String(value || "").trim();
  const match = text.match(/(\d{1,2})\/(\d{1,2})/);
  const now = new Date();
  if (!match) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, 1, 0, 0));
  return new Date(Date.UTC(now.getUTCFullYear(), Number(match[1]) - 1, Number(match[2]), 1, 0, 0));
}

function scheduleTitle(value, fallback) {
  const text = String(value || "").trim();
  return text.replace(/^\d{1,2}\/\d{1,2}\s*/, "").trim() || fallback || "공개 일정 확인";
}

function channelCode(name) {
  if (String(name || "").includes("네이버")) return "naver";
  if (String(name || "").includes("쿠팡")) return "coupang";
  if (String(name || "").includes("메타")) return "meta";
  return "etc";
}

function buildChannelDetailsFromPerformance(rows) {
  const latestByCode = new Map();
  (rows || []).forEach((row) => {
    const code = row.channel?.code || row.channel_code || "etc";
    if (!latestByCode.has(code)) latestByCode.set(code, row);
  });
  return Array.from(latestByCode.entries()).map(([code, row]) => ({
    name: row.channel?.name || (code === "naver" ? "네이버" : code === "coupang" ? "쿠팡" : "기타"),
    type: code === "naver" ? "검색광고" : code === "coupang" ? "상품광고" : "광고",
    sales: formatMoney(row.revenue),
    adSpend: formatMoney(row.ad_spend),
    roas: formatPercent(row.roas),
    orders: `${Number(row.orders || 0).toLocaleString("ko-KR")}건`,
    ctr: formatPercent(row.ctr),
    cvr: formatPercent(row.cvr),
    cpa: row.cpa ? `${Number(row.cpa).toLocaleString("ko-KR")}원` : "-",
    cpc: row.cpc ? `${Number(row.cpc).toLocaleString("ko-KR")}원` : "-",
    summary: row.public_comment || "관리자 공개 요약 필요"
  }));
}

function buildPublicState(data) {
  const client = data.client || {};
  const dashboard = data.dashboard?.[0] || {};
  const schedule = data.schedule?.[0] || {};
  const reports = data.reports || [];
  const actions = data.actionPlans || [];
  const keywords = data.keywords || [];
  const channelDetails = buildChannelDetailsFromPerformance(data.adPerformance);
  const publicComment =
    dashboard.public_comment ||
    actions[0]?.description ||
    client.public_summary ||
    "공개 코멘트를 준비 중입니다.";

  return {
    code: client.agency_code || "mml93-a01",
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
    reports: reports.map((report) => ({
      title: report.title,
      type: report.report_type,
      date: report.report_date,
      summary: report.summary,
      comment: report.public_comment
    })),
    actions: actions.map((action) => ({
      title: action.title,
      status: action.status,
      priority: action.priority,
      description: action.description,
      expectedImpact: action.expected_impact,
      clientRequest: action.client_request
    })),
    keywords: keywords.map((keyword) => ({
      keyword: keyword.keyword,
      priority: keyword.priority,
      channel: keyword.target_channel
    })),
    schedules: (data.schedule || []).map((item) => ({
      date: formatDate(item.starts_at),
      title: item.title,
      detail: item.public_comment || item.schedule_type,
      status: item.status === "planned" ? "예정" : item.status === "in_progress" ? "진행 중" : item.status
    })),
    channelDetails: channelDetails.length ? channelDetails : [
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

async function upsertLatestByQuery(ctx, table, queryBuilder, insertBody, updateBody) {
  const { data: existing, error: findError } = await queryBuilder
    .limit(1)
    .maybeSingle();
  if (findError) return { error: findError };

  if (existing?.id) {
    return ctx.supabaseAdmin
      .from(table)
      .update(updateBody)
      .eq("id", existing.id)
      .select()
      .maybeSingle();
  }

  return ctx.supabaseAdmin
    .from(table)
    .insert(insertBody)
    .select()
    .maybeSingle();
}

async function writePublicState(ctx, state) {
  const period = monthPeriod(state.updatedAt);
  const sales = parseMoney(state.sales);
  const adSpend = parseMoney(state.adSpend);
  const orders = parseCount(state.orders);
  const achievement = parsePercent(state.achievement);
  const publicComment = state.comment || "관리자 공개 코멘트 확인 필요";

  const clientResult = await ctx.supabaseAdmin
    .from("clients")
    .update({
      name: state.client || "브랜드 A",
      agency_code: state.code || "mml93-a01",
      public_summary: publicComment
    })
    .eq("id", demoClientId)
    .select("id")
    .maybeSingle();
  if (clientResult.error) return { error: clientResult.error };

  const dashboardResult = await ctx.supabaseAdmin
    .from("dashboard_snapshots")
    .upsert({
      client_id: demoClientId,
      brand_id: demoBrandId,
      period,
      sales,
      ad_spend: adSpend,
      orders,
      achievement_rate: achievement,
      public_comment: publicComment
    }, { onConflict: "client_id,brand_id,period" })
    .select("id")
    .maybeSingle();
  if (dashboardResult.error) return { error: dashboardResult.error };

  const schedule = (state.schedules && state.schedules[0]) || {};
  const scheduleDate = dateFromShort(schedule.date || state.nextSchedule);
  const scheduleResult = await upsertLatestByQuery(
    ctx,
    "schedule_items",
    ctx.supabaseAdmin
      .from("schedule_items")
      .select("id")
      .eq("client_id", demoClientId)
      .eq("brand_id", demoBrandId)
      .order("starts_at", { ascending: false }),
    {
      client_id: demoClientId,
      brand_id: demoBrandId,
      title: schedule.title || scheduleTitle(state.nextSchedule, "공개 일정 확인"),
      schedule_type: "operation",
      status: schedule.status === "진행 중" ? "in_progress" : "planned",
      starts_at: scheduleDate.toISOString(),
      ends_at: new Date(scheduleDate.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      public_comment: schedule.detail || state.nextSchedule || "공개 일정 확인",
      visibility: "client_visible"
    },
    {
      title: schedule.title || scheduleTitle(state.nextSchedule, "공개 일정 확인"),
      status: schedule.status === "진행 중" ? "in_progress" : "planned",
      starts_at: scheduleDate.toISOString(),
      ends_at: new Date(scheduleDate.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      public_comment: schedule.detail || state.nextSchedule || "공개 일정 확인",
      visibility: "client_visible"
    }
  );
  if (scheduleResult.error) return { error: scheduleResult.error };

  const action = (state.actions && state.actions[0]) || {};
  const actionResult = await upsertLatestByQuery(
    ctx,
    "action_plans",
    ctx.supabaseAdmin
      .from("action_plans")
      .select("id")
      .eq("client_id", demoClientId)
      .eq("brand_id", demoBrandId)
      .order("period_week", { ascending: false }),
    {
      client_id: demoClientId,
      brand_id: demoBrandId,
      period_week: new Date().toISOString().slice(0, 10),
      title: action.title || state.primaryAction || "다음 실행 계획 확인",
      category: "operation",
      priority: action.priority || "high",
      status: action.status || "planned",
      description: action.description || state.nextAction || publicComment,
      expected_impact: action.expectedImpact || state.actionImpact || "성과 유지와 개선을 기대합니다.",
      client_request: action.clientRequest || state.clientRequest || "확인 필요 사항 없음",
      is_client_visible: true
    },
    {
      title: action.title || state.primaryAction || "다음 실행 계획 확인",
      priority: action.priority || "high",
      status: action.status || "planned",
      description: action.description || state.nextAction || publicComment,
      expected_impact: action.expectedImpact || state.actionImpact || "성과 유지와 개선을 기대합니다.",
      client_request: action.clientRequest || state.clientRequest || "확인 필요 사항 없음",
      is_client_visible: true
    }
  );
  if (actionResult.error) return { error: actionResult.error };

  const generatedReport = state.generatedReport || (Array.isArray(state.reports) ? state.reports[0] : null);
  if (generatedReport && (generatedReport.title || generatedReport.summary || generatedReport.insight)) {
    const reportDate = String(generatedReport.generatedAt || generatedReport.date || state.updatedAt || new Date().toISOString().slice(0, 10)).replace(/\./g, "-");
    const periodStart = monthPeriod(reportDate);
    const reportType = ["weekly", "monthly", "kpi", "sales", "ads", "keyword", "campaign", "content"].includes(generatedReport.type)
      ? generatedReport.type
      : "monthly";
    const reportResult = await upsertLatestByQuery(
      ctx,
      "reports",
      ctx.supabaseAdmin
        .from("reports")
        .select("id")
        .eq("client_id", demoClientId)
        .eq("brand_id", demoBrandId)
        .eq("report_type", reportType)
        .eq("report_date", reportDate),
      {
        client_id: demoClientId,
        brand_id: demoBrandId,
        report_type: reportType,
        title: generatedReport.title || `${state.client || "광고주"} 월간 성과 보고서`,
        report_date: reportDate,
        period_start: periodStart,
        period_end: reportDate,
        summary: generatedReport.summary || generatedReport.insight || state.comment || "월간 성과 보고서가 생성되었습니다.",
        public_comment: generatedReport.comment || generatedReport.action || "보고서 세부 내용은 광고주 화면에서 확인해주세요.",
        visibility: "client_visible"
      },
      {
        title: generatedReport.title || `${state.client || "광고주"} 월간 성과 보고서`,
        period_start: periodStart,
        period_end: reportDate,
        summary: generatedReport.summary || generatedReport.insight || state.comment || "월간 성과 보고서가 생성되었습니다.",
        public_comment: generatedReport.comment || generatedReport.action || "보고서 세부 내용은 광고주 화면에서 확인해주세요.",
        visibility: "client_visible"
      }
    );
    if (reportResult.error) return { error: reportResult.error };
  }

  if (Array.isArray(state.channelMetrics) && state.channelMetrics.length) {
    const channelCodes = [...new Set(state.channelMetrics.map((item) => channelCode(item.name)))];
    const { data: channels, error: channelError } = await ctx.supabaseAdmin
      .from("channels")
      .select("id, code")
      .in("code", channelCodes);
    if (channelError) return { error: channelError };

    const channelIdByCode = new Map((channels || []).map((item) => [item.code, item.id]));
    const deleteResult = await ctx.supabaseAdmin
      .from("ad_performance")
      .delete()
      .eq("client_id", demoClientId)
      .eq("brand_id", demoBrandId)
      .eq("period_start", period);
    if (deleteResult.error) return { error: deleteResult.error };

    const rows = state.channelMetrics.map((item) => {
      const code = channelCode(item.name);
      return {
        client_id: demoClientId,
        brand_id: demoBrandId,
        channel_id: channelIdByCode.get(code) || channelIdByCode.get("etc") || null,
        period_start: period,
        period_end: new Date().toISOString().slice(0, 10),
        ad_spend: Number(item.spend || 0),
        revenue: Number(item.sales || 0),
        impressions: Math.round(Number(item.impressions || 0)),
        clicks: Math.round(Number(item.clicks || 0)),
        conversions: Math.round(Number(item.conversions || 0)),
        orders: Math.round(Number(item.orders || 0)),
        public_comment: item.summary || "관리자 공개 요약 필요"
      };
    });

    if (rows.length) {
      const adResult = await ctx.supabaseAdmin
        .from("ad_performance")
        .insert(rows)
        .select("id");
      if (adResult.error) return { error: adResult.error };
    }
  }

  return { ok: true };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    const { resource } = routeParts(request, "/api/demo");
    if (resource === "public-state") {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);

      if (!demoPublicStateEnabled()) {
        return json({
          ok: false,
          message: "데모 공개 저장 API는 비공개 상태입니다. 서버 환경변수 MI_DEMO_PUBLIC_STATE_ENABLED와 MI_DEMO_ADMIN_CODE 설정 후 사용할 수 있습니다."
        }, 403);
      }

      const body = await readBody(request);
      const adminCode = request.headers.get("x-demo-admin-code") || body.adminCode;
      if (!safeEqual(adminCode, process.env.MI_DEMO_ADMIN_CODE)) {
        return json({ ok: false, message: "Invalid demo admin code" }, 401);
      }

      const result = await writePublicState(ctx, body.publicState || {});
      if (result.error) {
        return databaseError(result.error, "데모 공개 데이터 저장에 실패했습니다.");
      }

      return json({ ok: true, message: "데모 공개 데이터가 저장되었습니다." });
    }

    if (request.method !== "GET" || resource !== "overview") {
      return notFound(["GET /api/demo/overview", "POST /api/demo/public-state"]);
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
      adPerformance: ctx.supabaseAdmin
        .from("ad_performance")
        .select("id, client_id, brand_id, channel_id, period_start, period_end, ad_spend, revenue, roas, impressions, clicks, ctr, conversions, cvr, orders, cpa, cpc, public_comment, channel:channels(code,name)")
        .eq("client_id", demoClientId)
        .order("period_start", { ascending: false })
        .limit(6),
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
      .map(([key, result]) => result.error ? { key, message: result.error.message, code: result.error.code } : null)
      .filter(Boolean);

    if (errors.length) {
      return json({ ok: false, message: "데모 공개 데이터 조회 중 오류가 발생했습니다.", errors }, 500);
    }

    const data = Object.fromEntries(entries.map(([key, result]) => [key, result.data]));

    if (!data.client) {
      return json({ ok: false, message: "데모 광고주 데이터가 없습니다. npm run seed:demo를 먼저 실행하세요." }, 404);
    }

    return json({
      ok: true,
      data,
      publicState: buildPublicState(data)
    });
  })
};

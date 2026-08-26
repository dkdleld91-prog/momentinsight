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
    select: "id, client_id, brand_id, title:public_title, schedule_type, status, starts_at, ends_at, public_comment, visibility, is_all_day, created_at, updated_at",
    order: "starts_at",
    visibleOnly: true,
    personalOnly: true
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

export function clientScheduleSelectFields() {
  return resources["schedule-items"].select;
}

function listRoutes() {
  return [
    "GET /api/client/overview",
    "GET /api/client/public-state",
    "POST /api/client/public-state",
    ...Object.keys(resources).map((name) => `GET /api/client/${name}`),
    "POST /api/client/agency-code/connect"
  ];
}

// 광고주 화면의 성과·매출 숫자는 이 경로 하나에서만 나온다. 브라우저 저장소는
// 첫 페인트용 캐시일 뿐이고, 값의 출처는 언제나 세션이 가리키는 광고주의 서버
// 행이다. 서버에 행이 없으면 숫자를 만들어내지 않고 null 을 돌려준다.
const PUBLIC_STATE_ROLES = new Set(["client", "team", "owner"]);
const PUBLIC_STATE_WRITE_ROLES = new Set(["team", "owner"]);
const OPERATOR_NAME = "모먼트 인사이트 운영팀";

// session-gate 가 요청에서 자격 헤더를 모두 지운 뒤 세션 클레임으로 다시 심는다.
// 반대로 외부 Supabase 자격 증명이 실린 요청은 그 게이트를 건너뛰므로, 이 경로는
// 그런 요청을 아예 받지 않는다. 그래야 x-mi-agency-code 를 신뢰할 수 있다.
function carriesExternalSupabaseCredential(request) {
  return Boolean(request.headers.get("authorization") || request.headers.get("apikey"));
}

function sessionRole(request) {
  return String(request.headers.get("x-mi-session-role") || "").trim();
}

function sessionAgencyCode(request) {
  return String(request.headers.get("x-mi-agency-code") || "").trim().toLowerCase();
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function moneyText(value) {
  const amount = numberOrNull(value);
  if (amount === null) return null;
  if (Math.abs(amount) >= 10000) return `${Math.round(amount / 10000).toLocaleString("ko-KR")}만원`;
  return `${amount.toLocaleString("ko-KR")}원`;
}

function wonText(value) {
  const amount = numberOrNull(value);
  if (amount === null) return null;
  return `${Math.round(amount).toLocaleString("ko-KR")}원`;
}

function percentText(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  return `${Number.isInteger(number) ? number : Number(number.toFixed(1))}%`;
}

function countText(value, unit = "건") {
  const number = numberOrNull(value);
  if (number === null) return null;
  return `${Math.round(number).toLocaleString("ko-KR")}${unit}`;
}

function shortDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function isoDay(value) {
  const text = String(value ?? "");
  return text ? text.slice(0, 10).replace(/-/g, ".") : null;
}

function scheduleStatusLabel(value) {
  if (value === "planned") return "예정";
  if (value === "in_progress") return "진행 중";
  return cleanText(value);
}

function channelTypeLabel(code) {
  if (code === "naver") return "검색광고";
  if (code === "coupang") return "상품광고";
  return null;
}

function latestChannelRows(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    const code = row?.channel?.code || "etc";
    if (!seen.has(code)) seen.set(code, { code, row });
  }
  return Array.from(seen.values());
}

// KPI 목표는 한 행에 여러 지표가 같이 들어 있어서, 화면에 띄울 지표를 하나만
// 고른다. 순서는 매출 -> 광고비 -> 구매수 이고 값이 들어 있는 첫 지표를 쓴다.
const KPI_METRICS = [
  { metric: "revenue", label: "매출", targetColumn: "target_revenue", actualColumn: "actual_revenue", snapshotColumn: "sales" },
  { metric: "ad_spend", label: "광고비", targetColumn: "target_ad_spend", actualColumn: "actual_ad_spend", snapshotColumn: "ad_spend" },
  { metric: "orders", label: "구매수", targetColumn: "target_orders", actualColumn: "actual_orders", snapshotColumn: "orders" }
];

function progressRateOf(actual, targetValue) {
  return Math.round((actual / targetValue) * 1000) / 10;
}

// 목표는 kpi_targets 에서, 진행률은 kpi_results -> dashboard_snapshots 순서로만
// 가져온다. 실적 행이 없으면 진행률은 null 로 남기고 목표만 돌려준다. 어느
// 경우에도 없는 숫자를 만들어 채우지 않는다(그 순간 화면이 거짓이 된다).
export function computeKpiProgress(target, result, snapshot) {
  if (!target) return null;

  const chosen = KPI_METRICS.find((entry) => {
    const value = numberOrNull(target[entry.targetColumn]);
    return value !== null && value > 0;
  });
  if (!chosen) return null;

  const targetValue = numberOrNull(target[chosen.targetColumn]);
  let actualValue = null;
  let progressRate = null;
  let source = null;

  // 실적 행은 이 목표를 가리킬 때만 인정한다. 다른 달 목표의 실적을 붙이면
  // 진행률이 통째로 다른 기간 숫자가 된다.
  const matched = result && result.kpi_target_id === target.id ? result : null;
  if (matched) {
    const actual = numberOrNull(matched[chosen.actualColumn]);
    const savedRate = numberOrNull(matched.achievement_rate);
    if (savedRate !== null) {
      progressRate = savedRate;
      actualValue = actual;
      source = "kpi_results_rate";
    } else if (actual !== null) {
      actualValue = actual;
      progressRate = progressRateOf(actual, targetValue);
      source = "kpi_results";
    }
  }

  if (source === null) {
    const fallback = snapshot ? numberOrNull(snapshot[chosen.snapshotColumn]) : null;
    if (fallback !== null) {
      actualValue = fallback;
      progressRate = progressRateOf(fallback, targetValue);
      source = "dashboard_snapshot";
    }
  }

  return {
    periodMonth: String(target.period_month ?? "").slice(0, 7) || null,
    metric: chosen.metric,
    metricLabel: chosen.label,
    targetValue,
    actualValue,
    progressRate,
    source
  };
}

// 서버 행이 없는 값은 null 로 남긴다. 화면이 빈 상태 문구를 그리게 하는 것이
// 목적이고, 여기서 대체 숫자를 채우면 그 순간 데이터가 거짓이 된다.
function buildClientPublicState(client, data) {
  const snapshot = (data.dashboard || [])[0] || null;
  const scheduleRows = data.schedule || [];
  const nextSchedule = scheduleRows[0] || null;
  const kpi = computeKpiProgress((data.kpiTarget || [])[0] || null, (data.kpiResult || [])[0] || null, snapshot);
  // 달성률은 KPI 진행률이 있으면 그걸 쓰고, 없으면 예전처럼 스냅샷 값을 쓴다.
  // 둘 다 없으면 null 로 남겨 화면이 빈 상태를 그리게 한다.
  const kpiRate = kpi ? numberOrNull(kpi.progressRate) : null;
  const achievement = kpiRate !== null
    ? kpiRate
    : (snapshot ? numberOrNull(snapshot.achievement_rate) : null);

  return {
    code: String(client.agency_code || "").toUpperCase(),
    client: cleanText(client.name) || cleanText(client.business_name),
    agencyName: OPERATOR_NAME,
    connectionStatus: "연동 완료",
    sales: snapshot ? moneyText(snapshot.sales) : null,
    roas: snapshot ? percentText(snapshot.roas) : null,
    adSpend: snapshot ? moneyText(snapshot.ad_spend) : null,
    orders: snapshot ? countText(snapshot.orders) : null,
    achievement: percentText(achievement),
    status: achievement === null ? null : (achievement >= 100 ? "목표 초과" : "진행 중"),
    kpi,
    nextSchedule: nextSchedule && cleanText(nextSchedule.title)
      ? [shortDate(nextSchedule.starts_at), cleanText(nextSchedule.title)].filter(Boolean).join(" ")
      : null,
    updatedAt: snapshot ? isoDay(snapshot.updated_at) : null,
    comment: snapshot ? cleanText(snapshot.public_comment) : null,
    reports: (data.reports || []).map((report) => ({
      title: cleanText(report.title),
      type: cleanText(report.report_type),
      date: cleanText(report.report_date),
      summary: cleanText(report.summary),
      comment: cleanText(report.public_comment)
    })),
    actions: (data.actionPlans || []).map((action) => ({
      title: cleanText(action.title),
      status: cleanText(action.status),
      priority: cleanText(action.priority),
      description: cleanText(action.description),
      expectedImpact: cleanText(action.expected_impact),
      clientRequest: cleanText(action.client_request)
    })),
    schedules: scheduleRows.map((item) => ({
      date: shortDate(item.starts_at),
      title: cleanText(item.title),
      detail: cleanText(item.public_comment) || cleanText(item.schedule_type),
      status: scheduleStatusLabel(item.status)
    })),
    channelDetails: latestChannelRows(data.adPerformance).map(({ code, row }) => ({
      name: cleanText(row?.channel?.name) || code,
      type: channelTypeLabel(code),
      sales: moneyText(row.revenue),
      adSpend: moneyText(row.ad_spend),
      roas: percentText(row.roas),
      orders: countText(row.orders),
      ctr: percentText(row.ctr),
      cvr: percentText(row.cvr),
      cpa: wonText(row.cpa),
      cpc: wonText(row.cpc),
      summary: cleanText(row.public_comment)
    })),
    keywords: (data.keywords || []).map((keyword) => ({
      keyword: cleanText(keyword.keyword),
      priority: cleanText(keyword.priority),
      channel: cleanText(keyword.target_channel)
    }))
  };
}

async function resolveSessionClient(request, ctx) {
  const agencyCode = sessionAgencyCode(request);
  if (!agencyCode) {
    return {
      ok: false,
      status: 403,
      code: "CLIENT_SCOPE_REQUIRED",
      message: "연결된 광고주가 없는 세션입니다. 광고주를 연결하면 공개 데이터가 표시됩니다."
    };
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, disconnected_at")
    .eq("agency_code", agencyCode)
    .eq("status", "active")
    .is("disconnected_at", null)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 500, code: "CLIENT_LOOKUP_FAILED", message: "광고주 조회에 실패했습니다.", detail: error.message };
  }
  if (!data) {
    return { ok: false, status: 404, code: "CLIENT_NOT_FOUND", message: "활성 광고주를 찾을 수 없습니다." };
  }
  return { ok: true, client: data };
}

export async function readClientPublicState(request, ctx) {
  const access = await resolveSessionClient(request, ctx);
  if (!access.ok) {
    const { ok, status, ...payload } = access;
    return json({ ok: false, ...payload }, status);
  }

  const clientId = access.client.id;
  const queries = {
    dashboard: ctx.supabaseAdmin
      .from("dashboard_snapshots")
      .select(resources.dashboard.select)
      .eq("client_id", clientId)
      .order("period", { ascending: false })
      .limit(1),
    adPerformance: ctx.supabaseAdmin
      .from("ad_performance")
      .select("id, client_id, channel_id, period_start, period_end, ad_spend, revenue, roas, impressions, clicks, ctr, conversions, cvr, orders, cpa, cpc, public_comment, updated_at, channel:channels(code,name)")
      .eq("client_id", clientId)
      .order("period_start", { ascending: false })
      .limit(6),
    reports: ctx.supabaseAdmin
      .from("reports")
      .select(resources.reports.select)
      .eq("client_id", clientId)
      .eq("visibility", "client_visible")
      .order("report_date", { ascending: false })
      .limit(5),
    schedule: ctx.supabaseAdmin
      .from("schedule_items")
      .select(resources["schedule-items"].select)
      .eq("client_id", clientId)
      .eq("visibility", "client_visible")
      .is("calendar_id", null)
      .order("starts_at", { ascending: true })
      .limit(8),
    actionPlans: ctx.supabaseAdmin
      .from("action_plans")
      .select(resources["action-plans"].select)
      .eq("client_id", clientId)
      .eq("is_client_visible", true)
      .order("period_week", { ascending: false })
      .limit(5),
    keywords: ctx.supabaseAdmin
      .from("keywords")
      .select(resources.keywords.select)
      .eq("client_id", clientId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(10),
    // KPI 목표·실적도 세션이 가리키는 광고주 행만 읽는다. 다른 광고주의 목표가
    // 섞이면 진행률이 그대로 남의 숫자가 된다.
    kpiTarget: ctx.supabaseAdmin
      .from("kpi_targets")
      .select("id, client_id, brand_id, period_month, target_revenue, target_ad_spend, target_orders")
      .eq("client_id", clientId)
      .order("period_month", { ascending: false })
      .limit(1),
    kpiResult: ctx.supabaseAdmin
      .from("kpi_results")
      .select("id, kpi_target_id, client_id, actual_revenue, actual_ad_spend, actual_orders, achievement_rate, updated_at")
      .eq("client_id", clientId)
      .order("updated_at", { ascending: false })
      .limit(1)
  };

  const entries = await Promise.all(
    Object.entries(queries).map(async ([key, query]) => [key, await query])
  );
  const errors = entries
    .map(([key, result]) => result.error ? { key, message: result.error.message, code: result.error.code } : null)
    .filter(Boolean);

  if (errors.length) {
    return json({ ok: false, code: "PUBLIC_STATE_READ_FAILED", message: "공개 데이터 조회 중 오류가 발생했습니다.", errors }, 500);
  }

  const data = Object.fromEntries(entries.map(([key, result]) => [key, result.data]));
  const snapshot = (data.dashboard || [])[0] || null;

  return json({
    ok: true,
    access: {
      role: sessionRole(request),
      clientId,
      clientName: cleanText(access.client.name) || cleanText(access.client.business_name),
      agencyCode: access.client.agency_code
    },
    metrics: {
      available: Boolean(snapshot),
      period: snapshot ? cleanText(snapshot.period) : null
    },
    publicState: buildClientPublicState(access.client, data)
  });
}

// "입력 전" 같은 빈 상태 문구가 0 으로 저장되면 그 순간 없는 수치가 공개된다.
// 숫자가 한 자리도 없으면 값이 아니라 미입력으로 보고 그대로 건너뛴다.
function parseNumericInput(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const raw = String(value).trim();
  if (!raw || !/[0-9]/.test(raw)) return undefined;
  const digits = raw.replace(/[^0-9.-]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(digits)) return undefined;
  const number = Number(digits);
  if (!Number.isFinite(number)) return undefined;
  return raw.includes("만원") ? number * 10000 : number;
}

function parseIntegerInput(value) {
  const number = parseNumericInput(value);
  return number === undefined ? undefined : Math.round(number);
}

function monthPeriodFrom(value) {
  const raw = String(value ?? "").trim().replace(/\./g, "-");
  const date = raw ? new Date(raw) : new Date();
  const base = Number.isNaN(date.getTime()) ? new Date() : date;
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function snapshotPatchFrom(input) {
  const patch = {};
  const assign = (column, parsed) => {
    if (parsed !== undefined) patch[column] = parsed;
  };
  assign("sales", parseNumericInput(input.sales));
  assign("ad_spend", parseNumericInput(input.adSpend ?? input.ad_spend));
  assign("orders", parseIntegerInput(input.orders));
  assign("impressions", parseIntegerInput(input.impressions));
  assign("clicks", parseIntegerInput(input.clicks));
  assign("achievement_rate", parseNumericInput(input.achievement ?? input.achievement_rate));
  assign("conversion_rate", parseNumericInput(input.conversionRate ?? input.conversion_rate));
  assign("click_rate", parseNumericInput(input.clickRate ?? input.click_rate));
  const comment = cleanText(input.comment ?? input.public_comment);
  if (comment) patch.public_comment = comment;
  return patch;
}

// 쓰기는 기존 (client_id, period) 행을 찾아 갱신하거나 없을 때만 새로 넣는다.
// dashboard_snapshots 의 유일 제약이 brand_id 를 포함하고 brand_id 는 NULL 을
// 허용해서, upsert 로는 같은 달 행이 계속 늘어나기 때문이다. 삭제는 하지 않는다.
export async function writeClientPublicState(request, ctx, prereadBody) {
  const access = await resolveSessionClient(request, ctx);
  if (!access.ok) {
    const { ok, status, ...payload } = access;
    return json({ ok: false, ...payload }, status);
  }

  // 본문은 호출부에서 한 번만 읽어 넘겨준다. 넘어오지 않으면(예전 호출부) 직접
  // 읽는다. Request 본문은 한 번만 읽을 수 있어서 두 번 읽으면 안 된다.
  let body = prereadBody;
  if (body === undefined) {
    try {
      body = await readBody(request);
    } catch {
      return json({ ok: false, code: "INVALID_BODY", message: "요청 본문을 읽을 수 없습니다." }, 400);
    }
  }
  if (!body || typeof body !== "object") body = {};

  const input = body.publicState || body.state || {};
  const patch = snapshotPatchFrom(input);
  if (!Object.keys(patch).length) {
    return json({ ok: false, code: "PUBLIC_STATE_EMPTY", message: "저장할 공개 수치가 없습니다." }, 400);
  }

  const clientId = access.client.id;
  const period = monthPeriodFrom(input.updatedAt ?? input.period);

  const { data: existing, error: findError } = await ctx.supabaseAdmin
    .from("dashboard_snapshots")
    .select("id")
    .eq("client_id", clientId)
    .eq("period", period)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError) {
    return databaseError(findError, "공개 수치 저장 전 기존 행 확인에 실패했습니다.");
  }

  const write = existing?.id
    ? ctx.supabaseAdmin
      .from("dashboard_snapshots")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("id, period, updated_at")
      .maybeSingle()
    : ctx.supabaseAdmin
      .from("dashboard_snapshots")
      .insert({ client_id: clientId, period, ...patch })
      .select("id, period, updated_at")
      .maybeSingle();

  const { data: saved, error: writeError } = await write;
  if (writeError) {
    return databaseError(writeError, "공개 수치 저장에 실패했습니다.");
  }

  return json({
    ok: true,
    message: "공개 수치가 저장되었습니다. 광고주 화면에 즉시 반영됩니다.",
    saved: {
      clientId,
      period: saved?.period || period,
      updatedAt: saved?.updated_at || null,
      fields: Object.keys(patch)
    }
  });
}

// KPI 목표 저장. 새 /api 경로를 만들지 않고 public-state POST 안에서
// action 으로만 갈라진다. 대상 광고주는 여기서도 세션 코드로만 정한다.
export async function writeClientKpiTarget(request, ctx, body = {}) {
  const access = await resolveSessionClient(request, ctx);
  if (!access.ok) {
    const { ok, status, ...payload } = access;
    return json({ ok: false, ...payload }, status);
  }

  const input = body.kpiTarget || body.kpi_target || {};
  const requestedMetric = String(input.metric ?? "").trim() || "revenue";
  const chosen = KPI_METRICS.find((entry) => entry.metric === requestedMetric);
  if (!chosen) {
    return json({
      ok: false,
      code: "KPI_TARGET_INVALID",
      message: "목표 지표는 매출·광고비·구매수 중에서 선택해주세요."
    }, 400);
  }

  const parsed = parseNumericInput(input.targetValue ?? input.target_value);
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) {
    return json({ ok: false, code: "KPI_TARGET_INVALID", message: "목표값을 숫자로 입력해주세요." }, 400);
  }
  // target_orders 는 정수 칼럼이라 소수점이 들어오면 저장 자체가 실패한다.
  const targetValue = chosen.metric === "orders" ? Math.round(parsed) : parsed;

  const clientId = access.client.id;
  const period = monthPeriodFrom(input.periodMonth ?? input.period_month ?? input.period);

  // kpi_targets 의 유일 제약도 brand_id 를 포함하는데 brand_id 가 NULL 을 허용해서
  // upsert 로는 같은 달 행이 계속 늘어난다. 그래서 기존 행을 찾아 갱신한다.
  const { data: existing, error: findError } = await ctx.supabaseAdmin
    .from("kpi_targets")
    .select("id")
    .eq("client_id", clientId)
    .eq("period_month", period)
    .is("brand_id", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findError) {
    return databaseError(findError, "KPI 목표 저장 전 기존 행 확인에 실패했습니다.");
  }

  const write = existing?.id
    ? ctx.supabaseAdmin
      .from("kpi_targets")
      .update({ [chosen.targetColumn]: targetValue, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("id, period_month, updated_at")
      .maybeSingle()
    : ctx.supabaseAdmin
      .from("kpi_targets")
      .insert({ client_id: clientId, period_month: period, [chosen.targetColumn]: targetValue })
      .select("id, period_month, updated_at")
      .maybeSingle();

  const { error: writeError } = await write;
  if (writeError) {
    return databaseError(writeError, "KPI 목표 저장에 실패했습니다.");
  }

  return json({
    ok: true,
    message: "KPI 목표가 저장되었습니다.",
    saved: {
      clientId,
      periodMonth: period.slice(0, 7),
      metric: chosen.metric,
      targetValue
    }
  });
}

export async function handleClientPublicStateRequest(request, ctx) {
  if (carriesExternalSupabaseCredential(request)) {
    return json({
      ok: false,
      code: "SESSION_REQUIRED",
      message: "공개 데이터는 접속 세션에서만 조회할 수 있습니다."
    }, 401);
  }

  const role = sessionRole(request);
  if (!PUBLIC_STATE_ROLES.has(role)) {
    return json({ ok: false, code: "SESSION_REQUIRED", message: "안전한 접속 세션이 필요합니다." }, 401);
  }

  if (request.method === "GET") return readClientPublicState(request, ctx);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);

  if (!PUBLIC_STATE_WRITE_ROLES.has(role)) {
    return json({
      ok: false,
      code: "PUBLIC_STATE_READ_ONLY",
      message: "광고주 계정은 공개 데이터를 저장할 수 없습니다."
    }, 403);
  }

  // 본문은 여기서 한 번만 읽는다. action 으로만 갈라지고 경로는 그대로 하나다.
  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, code: "INVALID_BODY", message: "요청 본문을 읽을 수 없습니다." }, 400);
  }
  if (!body || typeof body !== "object") body = {};

  if (body.action === "save-kpi-target") return writeClientKpiTarget(request, ctx, body);
  return writeClientPublicState(request, ctx, body);
}

export function clientSelfConnectEnabled(env = process.env) {
  return env.MI_CLIENT_SELF_CONNECT_ENABLED === "true";
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
  if (config.personalOnly) query = query.is("calendar_id", null);

  return query;
}

export async function handleClientApiRequest(request, ctx) {
  const { url, resource } = routeParts(request, "/api/client");

  if (resource === "agency-code") {
    return handleAgencyCode(request, ctx);
  }

  if (resource === "public-state") {
    return handleClientPublicStateRequest(request, ctx);
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
}

// 나머지 /api/client 리소스는 예전처럼 Supabase 사용자 토큰(RLS)으로 읽는다.
// public-state 만은 코드 세션 쿠키로 들어오므로 사용자 토큰이 없다. 그래서
// 이 한 리소스만 서비스 컨텍스트로 열고, 대상 광고주는 session-gate 가 심은
// 세션 헤더에서만 정한다(쿼리 파라미터로는 절대 바꿀 수 없다).
const userScopedFetch = withSupabase({ auth: "user" }, handleClientApiRequest);
const sessionScopedFetch = withSupabase({ auth: "none" }, handleClientPublicStateRequest);

export default {
  fetch(request) {
    const { resource } = routeParts(request, "/api/client");
    if (resource === "public-state") return sessionScopedFetch(request);
    return userScopedFetch(request);
  }
};

export async function handleAgencyCode(request, ctx) {
  const { id: action } = routeParts(request, "/api/client");

  if (action !== "connect") return notFound(listRoutes());
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!clientSelfConnectEnabled()) {
    return json({
      ok: false,
      code: "CLIENT_SELF_CONNECT_DISABLED",
      message: "광고주 셀프 연결 기능이 비활성화되어 있습니다. 운영팀에 연결을 요청해주세요."
    }, 403);
  }

  const userId = ctx.userClaims?.sub || ctx.userClaims?.id || null;
  if (!userId) return json({ ok: false, message: "Missing user id" }, 401);

  const body = await readBody(request);
  const agencyCode = String(body.agency_code || body.agencyCode || "").trim().toLowerCase();
  if (!agencyCode) {
    return json({ ok: false, message: "agency_code is required" }, 400);
  }

  const { data: client, error: clientError } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, agency_code, status, public_summary, disconnected_at")
    .eq("agency_code", agencyCode)
    .eq("status", "active")
    .is("disconnected_at", null)
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
        .is("calendar_id", null)
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

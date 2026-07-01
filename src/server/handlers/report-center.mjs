import { withSupabase } from "@supabase/server";
import pptxgen from "pptxgenjs";
import { parseLimit, readBody } from "../http.mjs";
import { protectedJson, safeEqual } from "../security.mjs";

const REPORT_TYPES = new Set([
  "weekly",
  "monthly",
  "kpi",
  "sales",
  "ads",
  "keyword",
  "campaign",
  "content",
]);

const FILE_TYPES = new Set([
  "pdf",
  "pptx",
  "xlsx",
  "xls",
  "csv",
  "image",
  "link",
  "notion",
  "drive",
  "other",
]);

const REPORT_BUCKET = "moment-reports";
const REPORT_DOWNLOAD_EXPIRES_IN = 60 * 10;
const REPORT_UPLOAD_MAX_BYTES = Number(process.env.MI_REPORT_UPLOAD_MAX_BYTES || 1024 * 1024 * 8);
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

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

function cleanText(value, fallback = "") {
  return String(value || fallback).trim();
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data || null;
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

function sanitizeFilename(value) {
  const fallback = `report-${Date.now()}`;
  return cleanText(value, fallback)
    .replace(/[\\/:*?"<>|#%{}^[\]`]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 160) || fallback;
}

function dateFolder(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function requestedReportBucket(body = {}) {
  const bucket = cleanText(body.bucket || body.storageBucket || body.storage_bucket, REPORT_BUCKET);
  return bucket === REPORT_BUCKET ? bucket : "";
}

function fileTypeFromName(filename, fallback = "other") {
  const ext = cleanText(filename).split(".").pop().toLowerCase();
  if (ext === "pptx") return "pptx";
  if (["xlsx", "xls", "csv", "pdf"].includes(ext)) return ext;
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  return fallback;
}

function limitText(value, max = 110, fallback = "") {
  const text = cleanText(value, fallback).replace(/\s+/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function numericValue(value) {
  return Number(String(value || "").replace(/[^0-9.-]/g, "")) || 0;
}

function displayValue(value, fallback = "-") {
  const text = cleanText(value);
  return text || fallback;
}

function reportRows(value, fallback = []) {
  return Array.isArray(value) ? value.filter(Boolean) : fallback;
}

function normalizeSalesReportInput(access, body) {
  const data = body.reportData || body.report_data || body.data || body;
  const channels = reportRows(data.channels, []).map((item) => ({
    name: limitText(item?.name, 30, "채널"),
    summary: limitText(item?.summary, 90, "성과 요약 필요"),
    sales: displayValue(item?.sales),
    roas: displayValue(item?.roas),
  })).slice(0, 6);
  const schedules = reportRows(data.schedules, []).map((item) => ({
    date: limitText(item?.date, 18, "-"),
    title: limitText(item?.title, 34, "일정"),
    detail: limitText(item?.detail, 74, ""),
    status: limitText(item?.status, 16, "예정"),
  })).slice(0, 5);

  return {
    clientName: limitText(data.clientName || data.client || access.client.name || access.client.business_name, 56, "광고주"),
    reportMonth: limitText(data.reportMonth || data.month || data.updatedAt || new Date().toISOString().slice(0, 7), 24),
    sales: displayValue(data.sales || data.monthlySales || data.totalSales, "0원"),
    adSpend: displayValue(data.adSpend || data.spend || data.cost, "0원"),
    roas: displayValue(data.roas, "-"),
    orders: displayValue(data.orders || data.orderCount, "-"),
    achievement: displayValue(data.achievement || data.goalRate, "-"),
    status: limitText(data.status, 60, "검수 필요"),
    nextSchedule: limitText(data.nextSchedule || data.nextAction, 90, "다음 실행 일정 확인"),
    publicComment: limitText(data.comment || data.publicComment || data.public_comment, 220, "이번 달 성과와 다음 실행 방향을 정리합니다."),
    channels,
    schedules,
    salesValue: numericValue(data.sales || data.monthlySales || data.totalSales),
    spendValue: numericValue(data.adSpend || data.spend || data.cost),
    orderValue: numericValue(data.orders || data.orderCount),
  };
}

function fallbackSalesNarrative(input, reason = "fallback") {
  const channels = input.channels.length
    ? input.channels.map((item) => `${item.name}: ${item.summary}`).slice(0, 3)
    : ["채널별 성과 입력 후 요약이 더 선명해집니다."];
  return {
    source: reason,
    headline: `${input.clientName} ${input.reportMonth} 매출 보고서`,
    executiveSummary: `${input.sales} 매출과 ${input.roas} ROAS를 기준으로 현재 성과를 점검합니다.`,
    keyChanges: [
      `목표 달성률은 ${input.achievement} 기준으로 확인됩니다.`,
      `광고비는 ${input.adSpend}, 구매수는 ${input.orders}로 정리되었습니다.`,
      input.status,
    ],
    channelInsights: channels,
    risks: [
      "원본 데이터와 공개 코멘트 검수 후 광고주 공유가 필요합니다.",
      "성과가 낮은 채널은 소재와 키워드 기준으로 분리 점검합니다.",
    ],
    actionPlan: [
      input.nextSchedule,
      "성과 상위 채널은 예산 유지, 하위 채널은 소재 테스트로 개선합니다.",
      "다음 보고 전 핵심 KPI 변동 폭을 재확인합니다.",
    ],
  };
}

function parseOpenAiJson(payload) {
  if (payload?.output_text) return JSON.parse(payload.output_text);
  const parts = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content?.text) parts.push(content.text);
      if (content?.type === "text" && content?.text) parts.push(content.text);
    }
  }
  if (!parts.length) throw new Error("OpenAI 응답에 보고서 JSON이 없습니다.");
  return JSON.parse(parts.join(""));
}

async function buildAiSalesNarrative(input) {
  const apiKey = cleanText(process.env.OPENAI_API_KEY);
  if (!apiKey) return fallbackSalesNarrative(input, "openai_not_configured");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["headline", "executiveSummary", "keyChanges", "channelInsights", "risks", "actionPlan"],
    properties: {
      headline: { type: "string" },
      executiveSummary: { type: "string" },
      keyChanges: { type: "array", minItems: 3, maxItems: 3, items: { type: "string" } },
      channelInsights: { type: "array", minItems: 3, maxItems: 4, items: { type: "string" } },
      risks: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" } },
      actionPlan: { type: "array", minItems: 3, maxItems: 4, items: { type: "string" } },
    },
  };

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cleanText(process.env.OPENAI_MODEL, "gpt-4.1-mini"),
        input: [
          {
            role: "system",
            content: "너는 마케팅 대행사 월간 매출 보고서를 작성하는 B2B SaaS 분석가다. 광고주에게 공개 가능한 문장만 쓰고 내부 API, 비밀값, 추측성 과장은 언급하지 않는다.",
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "월간 매출 보고서 PPT에 들어갈 요약과 액션 플랜을 한국어로 작성",
              input,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "moment_insight_sales_report",
            strict: true,
            schema,
          },
        },
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ...fallbackSalesNarrative(input, "openai_error"),
        aiError: payload?.error?.message || `OpenAI HTTP ${response.status}`,
      };
    }
    return {
      ...fallbackSalesNarrative(input, "openai"),
      ...parseOpenAiJson(payload),
      source: "openai",
    };
  } catch (error) {
    return {
      ...fallbackSalesNarrative(input, "openai_exception"),
      aiError: error.message,
    };
  }
}

function addPptText(slide, text, x, y, w, h, options = {}) {
  const { max, ...pptOptions } = options;
  slide.addText(limitText(text, max || 240), {
    x, y, w, h,
    margin: 0,
    breakLine: false,
    fit: "shrink",
    fontFace: "Aptos",
    color: pptOptions.color || "071B3A",
    fontSize: pptOptions.fontSize || 16,
    bold: Boolean(pptOptions.bold),
    valign: pptOptions.valign || "mid",
    align: pptOptions.align || "left",
    ...pptOptions,
  });
}

function addMetricCard(slide, label, value, x, y, w, accent = "0B5FFF") {
  slide.addShape("roundRect", {
    x, y, w, h: 0.88,
    rectRadius: 0.08,
    fill: { color: "FFFFFF" },
    line: { color: "DCE5F2", width: 1 },
  });
  slide.addShape("rect", {
    x, y, w: 0.08, h: 0.88,
    fill: { color: accent },
    line: { color: accent, transparency: 100 },
  });
  addPptText(slide, label, x + 0.18, y + 0.14, w - 0.28, 0.18, { fontSize: 8.8, color: "68758A", bold: true, max: 30 });
  addPptText(slide, value, x + 0.18, y + 0.38, w - 0.28, 0.28, { fontSize: 17, color: "071B3A", bold: true, max: 36 });
}

function addBulletList(slide, title, items, x, y, w, h, accent = "0B5FFF") {
  slide.addShape("roundRect", {
    x, y, w, h,
    rectRadius: 0.08,
    fill: { color: "FFFFFF" },
    line: { color: "DCE5F2", width: 1 },
  });
  addPptText(slide, title, x + 0.24, y + 0.18, w - 0.48, 0.28, { fontSize: 14, bold: true, max: 44 });
  items.slice(0, 4).forEach((item, index) => {
    const top = y + 0.62 + index * 0.46;
    slide.addShape("ellipse", {
      x: x + 0.26,
      y: top + 0.08,
      w: 0.1,
      h: 0.1,
      fill: { color: accent },
      line: { color: accent },
    });
    addPptText(slide, item, x + 0.46, top, w - 0.72, 0.34, { fontSize: 10.8, color: "263A56", max: 96 });
  });
}

function buildSalesReportPptx(input, narrative) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Moment Insight";
  pptx.company = "Moment Insight";
  pptx.subject = "Moment Insight Sales Report";
  pptx.title = narrative.headline;
  pptx.lang = "ko-KR";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
    lang: "ko-KR",
  };
  pptx.defineLayout({ name: "MI_WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "MI_WIDE";

  const navy = "071B3A";
  const blue = "0B5FFF";
  const teal = "16A3A3";
  const gray = "68758A";
  const light = "F5F8FC";

  let slide = pptx.addSlide();
  slide.background = { color: light };
  slide.addShape("rect", { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: light }, line: { color: light } });
  slide.addShape("roundRect", { x: 0.65, y: 0.55, w: 12.05, h: 6.35, rectRadius: 0.1, fill: { color: "FFFFFF" }, line: { color: "DCE5F2" } });
  addPptText(slide, "MOMENT INSIGHT", 0.95, 0.9, 2.5, 0.24, { fontSize: 10, bold: true, color: blue });
  addPptText(slide, narrative.headline, 0.95, 1.38, 7.6, 0.74, { fontSize: 30, bold: true, color: navy, max: 52 });
  addPptText(slide, narrative.executiveSummary, 0.98, 2.25, 6.8, 0.72, { fontSize: 14, color: gray, max: 130 });
  addMetricCard(slide, "이번 달 매출", input.sales, 0.95, 3.36, 2.35, blue);
  addMetricCard(slide, "광고비", input.adSpend, 3.55, 3.36, 2.25, teal);
  addMetricCard(slide, "ROAS", input.roas, 6.05, 3.36, 2.0, "8B5CF6");
  addMetricCard(slide, "목표 달성률", input.achievement, 8.3, 3.36, 2.15, "F59E0B");
  addBulletList(slide, "이번 달 핵심 변화", narrative.keyChanges, 0.95, 4.55, 5.45, 1.7, blue);
  addBulletList(slide, "다음 실행 방향", narrative.actionPlan, 6.65, 4.55, 5.35, 1.7, teal);
  addPptText(slide, `${input.clientName} · ${input.reportMonth}`, 9.35, 0.9, 2.65, 0.26, { fontSize: 10, color: gray, align: "right" });

  slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  addPptText(slide, "채널별 성과 요약", 0.72, 0.55, 5, 0.46, { fontSize: 24, bold: true, color: navy });
  addPptText(slide, "매출과 ROAS를 기준으로 채널별 우선순위를 정리합니다.", 0.75, 1.08, 6, 0.28, { fontSize: 11.5, color: gray });
  const channelItems = input.channels.length ? input.channels : [{ name: "채널", summary: "운영팀 입력 후 성과가 표시됩니다.", sales: input.sales, roas: input.roas }];
  channelItems.slice(0, 4).forEach((item, index) => {
    const x = 0.72 + (index % 2) * 6.05;
    const y = 1.72 + Math.floor(index / 2) * 1.7;
    slide.addShape("roundRect", { x, y, w: 5.5, h: 1.26, rectRadius: 0.08, fill: { color: index % 2 === 0 ? "F7FAFF" : "F8FBFA" }, line: { color: "DCE5F2" } });
    addPptText(slide, item.name, x + 0.24, y + 0.18, 1.5, 0.28, { fontSize: 14, bold: true, color: navy, max: 22 });
    addPptText(slide, `${item.sales} · ROAS ${item.roas}`, x + 2.05, y + 0.18, 2.9, 0.26, { fontSize: 11, bold: true, color: blue, max: 40 });
    addPptText(slide, item.summary, x + 0.24, y + 0.58, 4.9, 0.38, { fontSize: 10.3, color: gray, max: 86 });
  });
  addBulletList(slide, "채널 인사이트", narrative.channelInsights, 0.72, 5.22, 5.9, 1.55, blue);
  addBulletList(slide, "관리 포인트", narrative.risks, 6.9, 5.22, 5.72, 1.55, "F59E0B");

  slide = pptx.addSlide();
  slide.background = { color: light };
  addPptText(slide, "실행 계획 및 일정", 0.72, 0.55, 5.4, 0.48, { fontSize: 24, bold: true, color: navy });
  addPptText(slide, input.publicComment, 0.75, 1.08, 7.4, 0.34, { fontSize: 11.5, color: gray, max: 120 });
  addBulletList(slide, "다음 액션", narrative.actionPlan, 0.72, 1.72, 6.1, 2.12, teal);
  slide.addShape("roundRect", { x: 7.2, y: 1.72, w: 5.38, h: 2.12, rectRadius: 0.08, fill: { color: "FFFFFF" }, line: { color: "DCE5F2" } });
  addPptText(slide, "공유 일정", 7.48, 1.94, 2, 0.28, { fontSize: 14, bold: true, color: navy });
  (input.schedules.length ? input.schedules : [{ date: "-", title: input.nextSchedule, detail: "다음 실행 일정", status: "예정" }]).slice(0, 3).forEach((item, index) => {
    const top = 2.38 + index * 0.43;
    addPptText(slide, item.date, 7.48, top, 0.7, 0.22, { fontSize: 9.4, bold: true, color: blue, max: 12 });
    addPptText(slide, `${item.title} · ${item.status}`, 8.28, top, 3.8, 0.22, { fontSize: 9.4, color: "263A56", max: 54 });
  });
  slide.addShape("roundRect", { x: 0.72, y: 4.38, w: 11.86, h: 1.7, rectRadius: 0.1, fill: { color: navy }, line: { color: navy } });
  addPptText(slide, "운영팀 검수 후 광고주에게 공개되는 보고서입니다.", 1.02, 4.72, 8.4, 0.34, { fontSize: 16, color: "FFFFFF", bold: true, max: 84 });
  addPptText(slide, "내부 메모, API 키, 미승인 원본 데이터는 포함하지 않습니다.", 1.02, 5.18, 8.8, 0.28, { fontSize: 11, color: "BFD1EA", max: 90 });
  addPptText(slide, "Moment Insight", 10.2, 5.18, 1.9, 0.24, { fontSize: 10, color: "FFFFFF", align: "right" });

  return pptx;
}

async function writePptxBuffer(pptx) {
  const output = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

function decodeBase64File(value) {
  const text = String(value || "");
  const match = text.match(/^data:([^;,]+)?;base64,(.*)$/);
  const base64 = match ? match[2] : text;
  const contentType = match && match[1] ? match[1] : "";
  const normalized = base64.replace(/\s/g, "");
  if (!normalized) return { ok: false, message: "업로드할 파일 데이터가 없습니다." };
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length) return { ok: false, message: "파일 데이터를 읽을 수 없습니다." };
  if (buffer.length > REPORT_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      message: `보고서 파일은 ${(REPORT_UPLOAD_MAX_BYTES / 1024 / 1024).toFixed(0)}MB 이하만 업로드할 수 있습니다.`,
    };
  }
  return { ok: true, buffer, contentType };
}

async function attachSignedDownloadUrls(ctx, files = []) {
  return Promise.all((files || []).map(async (file) => {
    if (!file?.storage_bucket || !file?.storage_path) return file;
    const { data, error } = await ctx.supabaseAdmin
      .storage
      .from(file.storage_bucket)
      .createSignedUrl(file.storage_path, REPORT_DOWNLOAD_EXPIRES_IN);
    if (error) {
      return {
        ...file,
        signed_url_error: "보고서 파일 다운로드 URL 생성에 실패했습니다.",
      };
    }
    return {
      ...file,
      signed_url: data?.signedUrl || "",
      signed_url_expires_in: REPORT_DOWNLOAD_EXPIRES_IN,
    };
  }));
}

async function validateReportReferences(request, ctx, access, body) {
  const brandId = cleanText(body.brandId || body.brand_id);
  const channelId = cleanText(body.channelId || body.channel_id);

  if (brandId) {
    const { data, error } = await ctx.supabaseAdmin
      .from("brands")
      .select("id")
      .eq("id", brandId)
      .eq("client_id", access.client.id)
      .maybeSingle();

    if (error) return { ok: false, response: json(request, { ok: false, message: "브랜드 소속 확인에 실패했습니다.", detail: error.message }, 500) };
    if (!data) return { ok: false, response: json(request, { ok: false, message: "해당 광고주에 속한 브랜드만 보고서에 연결할 수 있습니다." }, 400) };
  }

  if (channelId) {
    const { data, error } = await ctx.supabaseAdmin
      .from("channels")
      .select("id")
      .eq("id", channelId)
      .eq("is_active", true)
      .maybeSingle();

    if (error) return { ok: false, response: json(request, { ok: false, message: "채널 확인에 실패했습니다.", detail: error.message }, 500) };
    if (!data) return { ok: false, response: json(request, { ok: false, message: "활성 채널만 보고서에 연결할 수 있습니다." }, 400) };
  }

  return { ok: true, brandId: brandId || null, channelId: channelId || null };
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

  if (teamError || !team?.client_id) {
    return { client: null, team: team || null, error: teamError };
  }

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
    if (!clientId) {
      return {
        ok: false,
        status: 400,
        message: "총관리자 조회는 client_id를 지정해야 합니다.",
      };
    }

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

function applyReportFilters(query, request) {
  const url = new URL(request.url);
  const reportType = cleanText(url.searchParams.get("report_type"));
  const from = cleanText(url.searchParams.get("from"));
  const to = cleanText(url.searchParams.get("to"));

  if (reportType) query = query.eq("report_type", reportType);
  if (from) query = query.gte("report_date", from);
  if (to) query = query.lte("report_date", to);
  return query;
}

async function handleGet(request, ctx) {
  const access = await resolveAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);

  const limit = parseLimit(new URL(request.url), 40, 100);
  let reportsQuery = ctx.supabaseAdmin
    .from("reports")
    .select("id, client_id, brand_id, report_type, title, report_date, period_start, period_end, channel_id, summary, public_comment, visibility, created_at, updated_at")
    .eq("client_id", access.client.id)
    .order("report_date", { ascending: false })
    .limit(limit);

  reportsQuery = applyReportFilters(reportsQuery, request);
  if (access.role === "client") reportsQuery = reportsQuery.eq("visibility", "client_visible");

  const { data: reports, error: reportsError } = await reportsQuery;
  if (reportsError) return json(request, { ok: false, message: "보고서 조회에 실패했습니다.", detail: reportsError.message }, 500);

  let filesQuery = ctx.supabaseAdmin
    .from("files")
    .select("id, client_id, report_id, title, file_type, url, external_url, storage_bucket, storage_path, visibility, created_at")
    .eq("client_id", access.client.id)
    .order("created_at", { ascending: false })
    .limit(limit * 3);

  if (access.role === "client") filesQuery = filesQuery.eq("visibility", "client_visible");

  const { data: files, error: filesError } = await filesQuery;
  if (filesError) return json(request, { ok: false, message: "보고서 파일 조회에 실패했습니다.", detail: filesError.message }, 500);
  const signedFiles = await attachSignedDownloadUrls(ctx, files || []);

  return json(request, {
    ok: true,
    access: {
      role: access.role,
      client: clientPayload(access.client),
      teamCode: access.team?.team_code || null,
      teamName: access.team?.team_name || null,
    },
    reports: reports || [],
    files: signedFiles,
  });
}

async function signFileForAccess(ctx, file) {
  if (!file?.storage_bucket || !file?.storage_path) {
    return {
      signedUrl: file?.external_url || file?.url || "",
      expiresIn: null,
    };
  }

  const { data, error } = await ctx.supabaseAdmin
    .storage
    .from(file.storage_bucket)
    .createSignedUrl(file.storage_path, REPORT_DOWNLOAD_EXPIRES_IN);

  if (error) return { error };
  return {
    signedUrl: data?.signedUrl || "",
    expiresIn: REPORT_DOWNLOAD_EXPIRES_IN,
  };
}

async function handleSignedUpload(request, ctx, access, body) {
  if (access.role === "client") {
    return json(request, { ok: false, message: "광고주는 보고서 파일을 업로드할 수 없습니다." }, 403);
  }

  const filename = sanitizeFilename(body.filename || body.fileName || body.title);
  const bucket = requestedReportBucket(body);
  if (!bucket) {
    return json(request, { ok: false, message: `보고서 업로드 버킷은 ${REPORT_BUCKET}만 사용할 수 있습니다.` }, 400);
  }
  const path = `clients/${access.client.id}/reports/${dateFolder()}/${Date.now()}-${filename}`;

  const { data, error } = await ctx.supabaseAdmin
    .storage
    .from(bucket)
    .createSignedUploadUrl(path);

  if (error) return json(request, { ok: false, message: "보고서 업로드 URL 생성에 실패했습니다.", detail: error.message }, 500);

  return json(request, {
    ok: true,
    bucket,
    path,
    signedUrl: data?.signedUrl,
    token: data?.token,
  });
}

async function handleDirectUpload(request, ctx, access, body) {
  if (access.role === "client") {
    return json(request, { ok: false, message: "광고주는 보고서 파일을 업로드할 수 없습니다." }, 403);
  }

  const filename = sanitizeFilename(body.filename || body.fileName || body.title);
  const decoded = decodeBase64File(body.contentBase64 || body.content_base64 || body.dataUrl || body.data_url);
  if (!decoded.ok) return json(request, { ok: false, message: decoded.message }, 400);

  const bucket = requestedReportBucket(body);
  if (!bucket) {
    return json(request, { ok: false, message: `보고서 업로드 버킷은 ${REPORT_BUCKET}만 사용할 수 있습니다.` }, 400);
  }

  const scope = cleanText(body.scope, "sources") === "reports" ? "reports" : "sources";
  const path = `clients/${access.client.id}/${scope}/${dateFolder()}/${Date.now()}-${filename}`;
  const contentType = cleanText(body.contentType || body.content_type || decoded.contentType, "application/octet-stream");

  const upload = await ctx.supabaseAdmin
    .storage
    .from(bucket)
    .upload(path, decoded.buffer, {
      contentType,
      upsert: false,
    });

  if (upload.error) {
    return json(request, { ok: false, message: "보고서 파일 업로드에 실패했습니다.", detail: upload.error.message }, 500);
  }

  const visibility = body.visibility === "client_visible" ? "client_visible" : "internal";
  const fileType = FILE_TYPES.has(cleanText(body.fileType || body.file_type))
    ? cleanText(body.fileType || body.file_type)
    : fileTypeFromName(filename);
  const title = cleanText(body.title, scope === "sources" ? `원천 파일 · ${filename}` : filename);
  const reportId = cleanText(body.reportId || body.report_id) || null;

  const { data: file, error: fileError } = await ctx.supabaseAdmin
    .from("files")
    .insert({
      client_id: access.client.id,
      report_id: reportId,
      title,
      file_type: fileType,
      storage_bucket: bucket,
      storage_path: path,
      visibility,
    })
    .select("id, client_id, report_id, title, file_type, url, external_url, storage_bucket, storage_path, visibility, created_at")
    .single();

  if (fileError) {
    return json(request, { ok: false, message: "보고서 파일 기록에 실패했습니다.", detail: fileError.message }, 500);
  }

  const signed = await signFileForAccess(ctx, file);
  const auditLogged = await recordAuditLog(ctx, {
    action: scope === "sources" ? "report_center.source_file_uploaded" : "report_center.file_uploaded",
    clientId: access.client.id,
    targetTable: "files",
    targetId: file.id,
    metadata: {
      role: access.role,
      teamCode: access.team?.team_code || null,
      scope,
      visibility,
      filename,
      size: decoded.buffer.length,
    },
  });

  return json(request, {
    ok: true,
    file: {
      ...file,
      signed_url: signed.signedUrl || "",
      signed_url_expires_in: signed.expiresIn,
      signed_url_error: signed.error ? "보고서 파일 다운로드 URL 생성에 실패했습니다." : undefined,
    },
    auditLogged,
  }, 201);
}

async function handleSignedDownload(request, ctx, access, body) {
  const fileId = cleanText(body.fileId || body.file_id || new URL(request.url).searchParams.get("file_id"));
  if (!fileId) return json(request, { ok: false, message: "다운로드할 파일 ID가 필요합니다." }, 400);

  let query = ctx.supabaseAdmin
    .from("files")
    .select("id, client_id, report_id, title, file_type, url, external_url, storage_bucket, storage_path, visibility, created_at")
    .eq("id", fileId)
    .eq("client_id", access.client.id);

  if (access.role === "client") query = query.eq("visibility", "client_visible");

  const { data: file, error } = await query.maybeSingle();
  if (error) return json(request, { ok: false, message: "보고서 파일 확인에 실패했습니다.", detail: error.message }, 500);
  if (!file) return json(request, { ok: false, message: "접근 가능한 보고서 파일을 찾을 수 없습니다." }, 404);

  const signed = await signFileForAccess(ctx, file);
  if (signed.error) {
    return json(request, { ok: false, message: "보고서 파일 다운로드 URL 생성에 실패했습니다.", detail: signed.error.message }, 500);
  }

  return json(request, {
    ok: true,
    file: {
      id: file.id,
      title: file.title,
      fileType: file.file_type,
      visibility: file.visibility,
    },
    signedUrl: signed.signedUrl,
    expiresIn: signed.expiresIn,
  });
}

async function handleCreateReport(request, ctx, access, body) {
  if (access.role === "client") {
    return json(request, { ok: false, message: "광고주는 보고서를 등록할 수 없습니다." }, 403);
  }

  const title = cleanText(body.title);
  if (!title) return json(request, { ok: false, message: "보고서 제목을 입력해주세요." }, 400);

  const reportType = cleanText(body.reportType || body.report_type, "weekly");
  if (!REPORT_TYPES.has(reportType)) {
    return json(request, { ok: false, message: "지원하지 않는 보고서 유형입니다." }, 400);
  }

  const visibility = body.visibility === "client_visible" ? "client_visible" : "internal";
  const reportDate = cleanText(body.reportDate || body.report_date, new Date().toISOString().slice(0, 10));
  const references = await validateReportReferences(request, ctx, access, body);
  if (!references.ok) return references.response;

  const reportPayload = {
    client_id: access.client.id,
    brand_id: references.brandId,
    report_type: reportType,
    title,
    report_date: reportDate,
    period_start: body.periodStart || body.period_start || null,
    period_end: body.periodEnd || body.period_end || null,
    channel_id: references.channelId,
    summary: body.summary || null,
    public_comment: body.publicComment || body.public_comment || null,
    internal_note: body.internalNote || body.internal_note || null,
    visibility,
  };

  const existing = await ctx.supabaseAdmin
    .from("reports")
    .select("id")
    .eq("client_id", access.client.id)
    .eq("report_type", reportType)
    .eq("report_date", reportDate)
    .eq("title", title)
    .maybeSingle();

  if (existing.error) return json(request, { ok: false, message: "기존 보고서 확인에 실패했습니다.", detail: existing.error.message }, 500);

  const reportMutation = existing.data
    ? ctx.supabaseAdmin
      .from("reports")
      .update(reportPayload)
      .eq("id", existing.data.id)
    : ctx.supabaseAdmin
      .from("reports")
      .insert(reportPayload);

  const { data, error } = await reportMutation
    .select("id, client_id, brand_id, report_type, title, report_date, period_start, period_end, channel_id, summary, public_comment, internal_note, visibility, created_at, updated_at")
    .single();

  if (error) return json(request, { ok: false, message: "보고서 등록에 실패했습니다.", detail: error.message }, 500);

  let file = null;
  const filePayload = body.file || body.reportFile || null;
  if (filePayload || body.externalUrl || body.external_url || body.storagePath || body.storage_path) {
    const fileType = cleanText(filePayload?.fileType || filePayload?.file_type || body.fileType || body.file_type, "link");
    if (!FILE_TYPES.has(fileType)) {
      return json(request, { ok: false, message: "지원하지 않는 파일 유형입니다." }, 400);
    }
    const storagePath = filePayload?.storagePath || filePayload?.storage_path || body.storagePath || body.storage_path || null;
    const requestedBucket = filePayload?.bucket || filePayload?.storageBucket || filePayload?.storage_bucket || body.bucket || body.storageBucket || body.storage_bucket || REPORT_BUCKET;
    const storageBucket = storagePath ? requestedReportBucket({ bucket: requestedBucket }) : null;
    if (storagePath && !storageBucket) {
      return json(request, { ok: false, message: `보고서 파일 버킷은 ${REPORT_BUCKET}만 사용할 수 있습니다.` }, 400);
    }
    if (storagePath && !String(storagePath).startsWith(`clients/${access.client.id}/`)) {
      return json(request, { ok: false, message: "보고서 파일은 해당 광고주 전용 경로만 연결할 수 있습니다." }, 400);
    }

    const fileInsert = {
      client_id: access.client.id,
      report_id: data.id,
      title: cleanText(filePayload?.title || body.fileTitle || body.file_title, title),
      file_type: fileType,
      external_url: filePayload?.externalUrl || filePayload?.external_url || body.externalUrl || body.external_url || null,
      url: filePayload?.url || body.url || null,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      visibility,
    };

    const { data: fileData, error: fileError } = await ctx.supabaseAdmin
      .from("files")
      .insert(fileInsert)
      .select("id, client_id, report_id, title, file_type, url, external_url, storage_bucket, storage_path, visibility, created_at")
      .single();

    if (fileError) return json(request, { ok: false, message: "보고서 파일 등록에 실패했습니다.", detail: fileError.message, report: data }, 500);
    file = fileData;
  }

  const auditLogged = await recordAuditLog(ctx, {
    action: existing.data ? "report_center.report_updated" : "report_center.report_created",
    clientId: data.client_id,
    targetTable: "reports",
    targetId: data.id,
    metadata: {
      role: access.role,
      teamCode: access.team?.team_code || null,
      reportType,
      visibility,
      fileId: file?.id || null,
      deduped: Boolean(existing.data),
    },
  });

  return json(request, {
    ok: true,
    deduped: Boolean(existing.data),
    report: data,
    file,
    auditLogged,
  }, existing.data ? 200 : 201);
}

async function uploadGeneratedReportFile(ctx, access, body, input, narrative, buffer, filename) {
  const visibility = body.visibility === "internal" ? "internal" : "client_visible";
  const reportDate = cleanText(body.reportDate || body.report_date, new Date().toISOString().slice(0, 10));
  const reportType = cleanText(body.reportType || body.report_type, "sales");
  const title = cleanText(body.title, `AI 매출 보고서 · ${input.reportMonth}`);
  const path = `clients/${access.client.id}/reports/${dateFolder()}/${Date.now()}-${sanitizeFilename(filename)}`;

  const upload = await ctx.supabaseAdmin
    .storage
    .from(REPORT_BUCKET)
    .upload(path, buffer, {
      contentType: PPTX_MIME,
      upsert: false,
    });

  if (upload.error) {
    return {
      ok: false,
      uploadError: upload.error.message,
    };
  }

  const { data: report, error: reportError } = await ctx.supabaseAdmin
    .from("reports")
    .insert({
      client_id: access.client.id,
      report_type: REPORT_TYPES.has(reportType) ? reportType : "sales",
      title,
      report_date: reportDate,
      summary: narrative.executiveSummary || input.publicComment,
      public_comment: input.publicComment,
      internal_note: narrative.aiError ? `AI fallback: ${narrative.aiError}` : null,
      visibility,
    })
    .select("id, client_id, report_type, title, report_date, summary, public_comment, visibility, created_at")
    .single();

  if (reportError) {
    return {
      ok: false,
      uploadError: `보고서 기록 실패: ${reportError.message}`,
      storagePath: path,
    };
  }

  const { data: file, error: fileError } = await ctx.supabaseAdmin
    .from("files")
    .insert({
      client_id: access.client.id,
      report_id: report.id,
      title: filename,
      file_type: "pptx",
      storage_bucket: REPORT_BUCKET,
      storage_path: path,
      visibility,
    })
    .select("id, client_id, report_id, title, file_type, storage_bucket, storage_path, visibility, created_at")
    .single();

  if (fileError) {
    return {
      ok: false,
      uploadError: `보고서 파일 기록 실패: ${fileError.message}`,
      report,
      storagePath: path,
    };
  }

  const signed = await signFileForAccess(ctx, file);
  const auditLogged = await recordAuditLog(ctx, {
    action: "report_center.ai_pptx_created",
    clientId: access.client.id,
    targetTable: "reports",
    targetId: report.id,
    metadata: {
      role: access.role,
      teamCode: access.team?.team_code || null,
      fileId: file.id,
      visibility,
      aiSource: narrative.source || null,
    },
  });

  return {
    ok: true,
    report,
    file: {
      ...file,
      signed_url: signed.signedUrl || "",
      signed_url_expires_in: signed.expiresIn,
      signed_url_error: signed.error ? "보고서 파일 다운로드 URL 생성에 실패했습니다." : undefined,
    },
    auditLogged,
  };
}

async function handleGenerateSalesPptx(request, ctx, access, body) {
  if (access.role === "client") {
    return json(request, { ok: false, message: "광고주는 PPTX 보고서를 생성할 수 없습니다." }, 403);
  }

  const input = normalizeSalesReportInput(access, body);
  const narrative = await buildAiSalesNarrative(input);
  const pptx = buildSalesReportPptx(input, narrative);
  const buffer = await writePptxBuffer(pptx);
  const filename = sanitizeFilename(`moment-insight-sales-${input.clientName}-${input.reportMonth}.pptx`);
  const base64 = buffer.toString("base64");

  let stored = null;
  if (body.saveToReportCenter !== false && body.save_to_report_center !== false) {
    stored = await uploadGeneratedReportFile(ctx, access, body, input, narrative, buffer, filename);
  }

  return json(request, {
    ok: true,
    filename,
    mimeType: PPTX_MIME,
    contentBase64: base64,
    size: buffer.length,
    ai: {
      source: narrative.source,
      error: narrative.aiError || null,
      headline: narrative.headline,
      summary: narrative.executiveSummary,
      actionPlan: narrative.actionPlan,
    },
    stored,
  }, 201);
}

async function handlePost(request, ctx) {
  const body = await readBody(request);
  const access = await resolveAccess(request, ctx, body);
  if (!access.ok) return json(request, access, access.status);

  const action = cleanText(body.action, "create-report");
  if (action === "signed-upload") return handleSignedUpload(request, ctx, access, body);
  if (action === "upload-source-file" || action === "upload-file") return handleDirectUpload(request, ctx, access, body);
  if (action === "signed-download") return handleSignedDownload(request, ctx, access, body);
  if (action === "create-report") return handleCreateReport(request, ctx, access, body);
  if (action === "generate-sales-pptx") return handleGenerateSalesPptx(request, ctx, access, body);

  return json(request, { ok: false, message: "지원하지 않는 보고서 작업입니다." }, 400);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "GET") return handleGet(request, ctx);
    if (request.method === "POST") return handlePost(request, ctx);
    return json(request, { ok: false, message: "Method not allowed", allowed: ["GET", "POST"] }, 405);
  }),
};

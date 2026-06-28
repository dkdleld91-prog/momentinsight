import { withSupabase } from "@supabase/server";
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

  return json(request, {
    ok: true,
    access: {
      role: access.role,
      client: clientPayload(access.client),
      teamCode: access.team?.team_code || null,
      teamName: access.team?.team_name || null,
    },
    reports: reports || [],
    files: files || [],
  });
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

  const visibility = body.visibility === "internal" ? "internal" : "client_visible";
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

async function handlePost(request, ctx) {
  const body = await readBody(request);
  const access = await resolveAccess(request, ctx, body);
  if (!access.ok) return json(request, access, access.status);

  const action = cleanText(body.action, "create-report");
  if (action === "signed-upload") return handleSignedUpload(request, ctx, access, body);
  if (action === "create-report") return handleCreateReport(request, ctx, access, body);

  return json(request, { ok: false, message: "지원하지 않는 보고서 작업입니다." }, 400);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "GET") return handleGet(request, ctx);
    if (request.method === "POST") return handlePost(request, ctx);
    return json(request, { ok: false, message: "Method not allowed", allowed: ["GET", "POST"] }, 405);
  }),
};

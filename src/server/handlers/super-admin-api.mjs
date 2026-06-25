import { withSupabase } from "@supabase/server";
import { corsHeaders, protectedJson, safeEqual } from "../security.mjs";

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "content-type, x-mi-super-admin-code",
  });
}

function normalizeAgencyCode(value) {
  return String(value || "").trim().toLowerCase();
}

function requestSuperAdminCode(request, body = {}) {
  return String(
    request.headers.get("x-mi-super-admin-code") ||
      body.superAdminCode ||
      body.super_admin_code ||
      ""
  ).trim();
}

function superAdminAuthorized(request, body = {}) {
  const configured = process.env.MI_SUPER_ADMIN_CODE || "";
  return Boolean(configured) && safeEqual(requestSuperAdminCode(request, body), configured);
}

function clientPayload(row) {
  return {
    id: row.id,
    name: row.name,
    businessName: row.business_name,
    agencyCode: row.agency_code,
    status: row.status,
    publicSummary: row.public_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nextAgencyCode(rows) {
  const max = (rows || []).reduce((latest, row) => {
    const match = String(row.agency_code || "").toLowerCase().match(/^mml93-a(\d+)$/);
    if (!match) return latest;
    return Math.max(latest, Number(match[1]) || 0);
  }, 0);
  return `mml93-a${String(Math.max(2, max + 1)).padStart(2, "0")}`;
}

async function listClients(request, ctx) {
  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, public_summary, created_at, updated_at")
    .neq("status", "archived")
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    return json(request, { ok: false, message: "광고주 코드 목록 조회에 실패했습니다.", detail: error.message }, 500);
  }

  return json(request, {
    ok: true,
    nextAgencyCode: nextAgencyCode(data || []),
    clients: (data || []).map(clientPayload),
  });
}

async function createClient(request, ctx, body) {
  const name = String(body.name || body.clientName || body.client_name || "").trim();
  const businessName = String(body.businessName || body.business_name || name).trim();
  const agencyCode = normalizeAgencyCode(body.agencyCode || body.agency_code || body.code);

  if (!name) return json(request, { ok: false, message: "광고주명을 입력해주세요." }, 400);

  let code = agencyCode;
  if (!code) {
    const list = await ctx.supabaseAdmin
      .from("clients")
      .select("agency_code")
      .neq("status", "archived")
      .limit(100);
    if (list.error) {
      return json(request, { ok: false, message: "다음 코드 계산에 실패했습니다.", detail: list.error.message }, 500);
    }
    code = nextAgencyCode(list.data || []);
  }

  const existing = await ctx.supabaseAdmin
    .from("clients")
    .select("id, name, business_name, agency_code, status, public_summary, created_at, updated_at")
    .ilike("agency_code", code)
    .maybeSingle();

  if (existing.error) {
    return json(request, { ok: false, message: "중복 코드 확인에 실패했습니다.", detail: existing.error.message }, 500);
  }
  if (existing.data) {
    return json(request, { ok: false, message: "이미 존재하는 대행사 코드입니다.", client: clientPayload(existing.data) }, 409);
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .insert({
      name,
      business_name: businessName || name,
      agency_code: code,
      status: "active",
      public_summary: body.publicSummary || body.public_summary || "총관리자가 발급한 광고주 코드입니다.",
      internal_note: "MI super admin issued client code",
    })
    .select("id, name, business_name, agency_code, status, public_summary, created_at, updated_at")
    .single();

  if (error) {
    return json(request, { ok: false, message: "광고주 코드 생성에 실패했습니다.", detail: error.message }, 500);
  }

  return json(request, { ok: true, client: clientPayload(data) }, 201);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, {
          methods: "GET, POST, OPTIONS",
          headers: "content-type, x-mi-super-admin-code",
        }),
      });
    }

    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (!process.env.MI_SUPER_ADMIN_CODE) {
      return json(request, { ok: false, message: "총관리자 코드 환경변수 MI_SUPER_ADMIN_CODE가 필요합니다." }, 503);
    }
    if (!superAdminAuthorized(request, body)) {
      return json(request, { ok: false, message: "총관리자 코드가 일치하지 않습니다." }, 401);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/api/super-admin/agency-codes") {
      return json(request, { ok: false, message: "Not found" }, 404);
    }

    if (request.method === "GET") return listClients(request, ctx);
    if (request.method === "POST") return createClient(request, ctx, body);
    return json(request, { ok: false, message: "Method not allowed" }, 405);
  }),
};

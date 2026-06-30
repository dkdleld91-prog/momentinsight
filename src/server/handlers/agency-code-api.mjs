import { withSupabase } from "@supabase/server";
import { corsHeaders, protectedJson } from "../security.mjs";

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "POST, OPTIONS",
    headers: "content-type, x-retry-count",
  });
}

function normalizeAgencyCode(value) {
  return String(value || "").trim().toLowerCase();
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function clientPayload(row) {
  return {
    name: row.name,
    businessName: row.business_name,
    agencyName: row.agency_name || row.team_name || "모먼트 인사이트 운영팀",
    status: row.status,
    publicSummary: row.public_summary || "",
  };
}

async function findActiveClient(ctx, code) {
  const baseSelect = "id, name, business_name, agency_code, status, public_summary";
  const fullSelect = `${baseSelect}, issued_by_team_code, disconnected_at`;

  let result = await ctx.supabaseAdmin
    .from("clients")
    .select(fullSelect)
    .ilike("agency_code", code)
    .eq("status", "active")
    .maybeSingle();

  if (result.error && /issued_by_team_code|disconnected_at/i.test(result.error.message || "")) {
    result = await ctx.supabaseAdmin
      .from("clients")
      .select(baseSelect)
      .ilike("agency_code", code)
      .eq("status", "active")
      .maybeSingle();
  }

  return result;
}

async function findTeamName(ctx, teamCode) {
  const code = normalizeAgencyCode(teamCode);
  if (!code) return "";
  const { data, error } = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("team_name")
    .ilike("team_code", code)
    .eq("status", "active")
    .maybeSingle();

  if (error) return "";
  return data?.team_name || "";
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, {
          methods: "POST, OPTIONS",
          headers: "content-type, x-retry-count",
        }),
      });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/api/agency-code/validate" && url.pathname !== "/api/agency-code-validate") {
      return json(request, { ok: false, message: "Not found" }, 404);
    }
    if (request.method !== "POST") {
      return json(request, { ok: false, message: "Method not allowed" }, 405);
    }

    const body = await readJson(request);
    const code = normalizeAgencyCode(body.agencyCode || body.agency_code || body.code);
    if (!code) {
      return json(request, { ok: false, message: "대행사 코드를 입력해주세요." }, 400);
    }

    const { data, error } = await findActiveClient(ctx, code);
    if (error) {
      return json(request, { ok: false, message: "대행사 코드 확인에 실패했습니다.", detail: error.message }, 500);
    }
    if (!data) {
      return json(request, { ok: false, message: "활성화된 대행사 코드가 아닙니다." }, 404);
    }
    if (data.disconnected_at) {
      return json(request, { ok: false, message: "연결이 해지된 광고주 코드입니다." }, 403);
    }

    const agencyName = await findTeamName(ctx, data.issued_by_team_code);
    return json(request, { ok: true, client: clientPayload({ ...data, agency_name: agencyName }) });
  }),
};

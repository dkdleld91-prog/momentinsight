import { withSupabase } from "@supabase/server";

export default {
  fetch: withSupabase({ auth: "secret" }, async (_req, ctx) => {
    const { data, error } = await ctx.supabaseAdmin
      .from("clients")
      .select("id, name, agency_code, status, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return Response.json({
        ok: false,
        message: error.message,
        code: error.code,
        hint: "clients 테이블이 준비되어야 관리자 광고주 목록이 조회됩니다."
      }, { status: 500 });
    }

    return Response.json({
      ok: true,
      data
    });
  })
};


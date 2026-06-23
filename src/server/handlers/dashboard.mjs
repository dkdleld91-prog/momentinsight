import { withSupabase } from "@supabase/server";

export default {
  fetch: withSupabase({ auth: "user" }, async (_req, ctx) => {
    const { data, error } = await ctx.supabase
      .from("dashboard_snapshots")
      .select("id, client_id, brand_id, period, sales, ad_spend, roas, achievement_rate, public_comment, updated_at")
      .order("period", { ascending: false })
      .limit(12);

    if (error) {
      return Response.json({
        ok: false,
        message: error.message,
        code: error.code,
        hint: "dashboard_snapshots 테이블과 RLS 정책이 준비되어야 실제 광고주 데이터가 조회됩니다."
      }, { status: 500 });
    }

    return Response.json({
      ok: true,
      user: {
        id: ctx.userClaims?.id || null,
        email: ctx.userClaims?.email || null
      },
      data
    });
  })
};


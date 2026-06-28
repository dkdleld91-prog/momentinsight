import { withSupabase } from "@supabase/server";
import { corsHeaders, protectedJson, safeEqual } from "../security.mjs";
import { runDueTrackers } from "./naver-rank-trackers.mjs";

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "authorization, content-type",
  });
}

function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET || process.env.MI_RANK_CRON_SECRET || "";
  if (!secret) return false;

  const authorization = request.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  return safeEqual(token, secret);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, {
      methods: "GET, POST, OPTIONS",
      headers: "authorization, content-type",
    }) });
    if (!["GET", "POST"].includes(request.method)) {
      return json(request, { ok: false, message: "Method not allowed" }, 405);
    }
    if (!cronAuthorized(request)) {
      return json(request, { ok: false, message: "Unauthorized cron request" }, 401);
    }

    try {
      const url = new URL(request.url);
      const summary = await runDueTrackers(ctx, {
        agencyCode: url.searchParams.get("agencyCode") || "",
        limit: url.searchParams.get("limit") || process.env.MI_RANK_CRON_BATCH,
      });
      if (summary.checked > 0 && summary.failed > 0) {
        return json(request, {
          ok: false,
          message: "일부 네이버 상품 순위 자동 갱신이 실패했습니다.",
          summary,
        }, 502);
      }
      return json(request, { ok: true, summary });
    } catch (error) {
      return json(request, {
        ok: false,
        message: "네이버 상품 순위 자동 갱신 중 오류가 발생했습니다.",
        detail: process.env.NODE_ENV === "development" ? error?.message : undefined,
      }, 500);
    }
  }),
};

import { withSupabase } from "@supabase/server";
import { cronAuthorized } from "../cron-auth.mjs";
import { corsHeaders, protectedJson } from "../security.mjs";
import { runDueTrackers } from "./naver-rank-trackers.mjs";
import { hasShoppingRankConfig, shoppingRankConfig } from "./naver-shopping-rank.mjs";

const DEFAULT_CRON_BATCH = 1;
const MAX_CRON_BATCH = 5;
export const NAVER_RANK_PROVIDER_NOT_CONFIGURED = "NAVER_RANK_PROVIDER_NOT_CONFIGURED";
export const NAVER_RANK_CRON_ITEM_FAILURE = "NAVER_RANK_CRON_ITEM_FAILURE";

export function productRankCronBatchLimit(url) {
  const requested = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(requested)) return DEFAULT_CRON_BATCH;
  return Math.max(1, Math.min(MAX_CRON_BATCH, Math.trunc(requested)));
}

export function productRankCronProviderConfigured(env = shoppingRankConfig()) {
  return hasShoppingRankConfig(env);
}

function safeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

export function safeProductRankCronSummary(summary = {}) {
  const now = String(summary?.now || "");
  return {
    now: Number.isFinite(Date.parse(now)) ? now : "",
    checked: safeCount(summary?.checked),
    succeeded: safeCount(summary?.succeeded),
    failed: safeCount(summary?.failed),
    remaining: safeCount(summary?.remaining),
    drained: summary?.drained === true,
    configured: summary?.configured === true,
  };
}

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "authorization, content-type",
  });
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
      const drainMode = url.searchParams.get("mode") === "drain";
      const rankProvider = shoppingRankConfig();
      if (!productRankCronProviderConfigured(rankProvider)) {
        return json(request, {
          ok: false,
          code: NAVER_RANK_PROVIDER_NOT_CONFIGURED,
          message: "네이버 상품 순위 수집원이 연결되지 않아 대기열을 시작하지 않았습니다.",
          claimed: 0,
          sourceStatus: {
            shoppingRank: { status: "not_configured" },
          },
        }, 503);
      }
      const summary = await runDueTrackers(ctx, {
        agencyCode: url.searchParams.get("agencyCode") || "",
        limit: productRankCronBatchLimit(url),
        env: rankProvider,
      });
      const safeSummary = safeProductRankCronSummary(summary);
      if (!summary.configured) {
        return json(request, {
          ok: false,
          code: NAVER_RANK_PROVIDER_NOT_CONFIGURED,
          message: "네이버 상품 순위 수집원이 연결되지 않아 대기열을 시작하지 않았습니다.",
          claimed: 0,
          sourceStatus: {
            shoppingRank: { status: "not_configured" },
          },
        }, 503);
      }
      if (summary.checked > 0 && summary.failed > 0) {
        return json(request, {
          ok: false,
          code: NAVER_RANK_CRON_ITEM_FAILURE,
          message: "일부 네이버 상품 순위 자동 갱신이 실패했습니다.",
          summary: safeSummary,
        }, 502);
      }
      if (!summary.drained && !drainMode) {
        return json(request, {
          ok: false,
          message: "네이버 상품 순위 갱신 대기열이 남아 있습니다.",
          summary: safeSummary,
        }, 503);
      }
      return json(request, { ok: true, summary: safeSummary });
    } catch (error) {
      return json(request, {
        ok: false,
        message: "네이버 상품 순위 자동 갱신 중 오류가 발생했습니다.",
        detail: process.env.NODE_ENV === "development" ? error?.message : undefined,
      }, 500);
    }
  }),
};

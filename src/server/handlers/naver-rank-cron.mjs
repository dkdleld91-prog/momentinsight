import { withSupabase } from "@supabase/server";
import { cronAuthorized } from "../cron-auth.mjs";
import { corsHeaders, protectedJson } from "../security.mjs";
import {
  hasShoppingRankConfig,
  hasShoppingRankProviderConfig,
  isHybridLocalWorkerMode,
  isMobileTopFallbackMode,
  shoppingRankConfig,
} from "../naver-shopping/source-status.mjs";
import { latestLocalWorkerSlotAt } from "../naver-shopping/local-worker-schedule.mjs";
import { prewarmShoppingRankProvider } from "../naver-shopping/provider-runtime.mjs";
import { requestShoppingWorkerWake } from "../naver-shopping/worker-wake.mjs";
import { runDueTrackers } from "./naver-rank-trackers.mjs";

const DEFAULT_CRON_BATCH = 1;
const MAX_CRON_BATCH = 5;
const HYBRID_WORKER_GRACE_MINUTES = 60;
export const NAVER_RANK_PROVIDER_NOT_CONFIGURED = "NAVER_RANK_PROVIDER_NOT_CONFIGURED";
export const NAVER_RANK_PROVIDER_WARMING = "NAVER_RANK_PROVIDER_WARMING";
export const NAVER_RANK_PROVIDER_UNAVAILABLE = "NAVER_RANK_PROVIDER_UNAVAILABLE";
export const NAVER_RANK_CRON_ITEM_FAILURE = "NAVER_RANK_CRON_ITEM_FAILURE";

export function productRankCronBatchLimit(url) {
  const requested = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(requested)) return DEFAULT_CRON_BATCH;
  return Math.max(1, Math.min(MAX_CRON_BATCH, Math.trunc(requested)));
}

export function productRankCronProviderConfigured(env = shoppingRankConfig()) {
  return hasShoppingRankConfig(env);
}

export async function productRankCronProviderReadiness(env = shoppingRankConfig(), options = {}) {
  if (!productRankCronProviderConfigured(env)) {
    return {
      ready: false,
      status: "not_configured",
      errorCode: NAVER_RANK_PROVIDER_NOT_CONFIGURED,
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: 503,
    };
  }
  if (isHybridLocalWorkerMode(env)) {
    return {
      ready: false,
      status: "hybrid_local_worker_ready",
      errorCode: "",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: 200,
      fullCoverageReady: false,
      fullCoverageConfigured: true,
    };
  }
  if (isMobileTopFallbackMode(env)) {
    return {
      ready: false,
      status: "mobile_top_fallback_ready",
      errorCode: "",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: 200,
      fullCoverageReady: false,
    };
  }
  if (!hasShoppingRankProviderConfig(env)) {
    return {
      ready: false,
      status: "misconfigured",
      errorCode: NAVER_RANK_PROVIDER_NOT_CONFIGURED,
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: 503,
    };
  }
  const prewarm = options.prewarm || prewarmShoppingRankProvider;
  return prewarm(env, options);
}

export function hybridWorkerGraceActive(date = new Date(), graceMinutes = HYBRID_WORKER_GRACE_MINUTES) {
  const nowMs = date.getTime();
  const slotMs = Date.parse(latestLocalWorkerSlotAt(date));
  const durationMs = Math.max(15, Math.min(180, Number(graceMinutes || HYBRID_WORKER_GRACE_MINUTES))) * 60_000;
  return Number.isFinite(nowMs) && Number.isFinite(slotMs) && nowMs >= slotMs && nowMs < slotMs + durationMs;
}

export function productRankCronExecutionMode(readiness = {}, options = {}) {
  if (readiness.ready === true) {
    return { run: true, mobileTopFallbackOnly: false };
  }
  if (readiness.status === "hybrid_local_worker_ready") {
    // The durable Chrome cycle is the sole rank authority in hybrid mode.
    // A server-side fallback would bypass its cursor and collect the same
    // keyword again before every eligible keyword has completed the cycle.
    return {
      run: false,
      mobileTopFallbackOnly: false,
      deferredToLocalWorker: true,
    };
  }
  if (readiness.status === "mobile_top_fallback_ready") {
    return { run: true, mobileTopFallbackOnly: true };
  }
  return { run: false, mobileTopFallbackOnly: false };
}

export async function hybridWorkerRecentlyActive(ctx, date = new Date()) {
  const slotMs = Date.parse(latestLocalWorkerSlotAt(date));
  if (!ctx?.supabaseAdmin || !Number.isFinite(slotMs)) return false;
  const since = new Date(slotMs - 60_000).toISOString();
  try {
    const { data, error } = await ctx.supabaseAdmin
      .from("naver_shopping_worker_nonces")
      .select("created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    // A missing heartbeat table or transient DB read must never suppress the
    // server fallback. This is the fail-safe path during staged rollout.
    return false;
  }
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
    preserved: safeCount(summary?.preserved),
    failed: safeCount(summary?.failed),
    remaining: safeCount(summary?.remaining),
    drained: summary?.drained === true,
    configured: summary?.configured === true,
    rankSourceReady: summary?.rankSourceReady === true,
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
      const providerReadiness = await productRankCronProviderReadiness(rankProvider);
      const executionMode = productRankCronExecutionMode(providerReadiness);
      if (executionMode.deferredToLocalWorker) {
        const remoteWakeRequested = await requestShoppingWorkerWake(ctx, "rank-cron-cycle");
        if (!remoteWakeRequested) {
          return json(request, {
            ok: false,
            code: "NAVER_RANK_WORKER_WAKE_FAILED",
            message: "중앙 자동 순환 작업기를 깨우지 못해 순서를 보존한 채 대기합니다.",
            claimed: 0,
          }, 503);
        }
        return json(request, {
          ok: true,
          deferred: true,
          remoteWakeRequested: true,
          message: "중앙 Chrome 300위 자동 순환을 깨웠으며 기존 순서를 유지합니다.",
          summary: safeProductRankCronSummary({
            now: new Date().toISOString(),
            checked: 0,
            succeeded: 0,
            preserved: 0,
            failed: 0,
            remaining: 0,
            drained: true,
            configured: true,
            rankSourceReady: true,
          }),
          sourceStatus: {
            shoppingRank: { status: "worker_priority" },
          },
        }, 202);
      }
      if (!executionMode.run) {
        const providerNotConfigured = providerReadiness.status === "not_configured";
        const code = providerNotConfigured
          ? NAVER_RANK_PROVIDER_NOT_CONFIGURED
          : NAVER_RANK_PROVIDER_WARMING;
        return json(request, {
          ok: false,
          code,
          retryable: providerReadiness.retryable === true,
          retryAfter: Number(providerReadiness.retryAfterSeconds || 0),
          message: providerNotConfigured
            ? "네이버 상품 순위 수집원이 연결되지 않아 대기열을 시작하지 않았습니다."
            : "네이버 상품 순위 수집원을 준비하고 있어 대기열을 아직 시작하지 않았습니다.",
          claimed: 0,
          sourceStatus: {
            shoppingRank: { status: providerReadiness.status },
          },
        }, 503);
      }
      const summary = await runDueTrackers(ctx, {
        agencyCode: url.searchParams.get("agencyCode") || "",
        limit: productRankCronBatchLimit(url),
        env: executionMode.mobileTopFallbackOnly
          ? { ...rankProvider, mobileTopFallbackOnly: true }
          : rankProvider,
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
      if (summary.rankSourceReady === false) {
        const sourceErrorCode = String(summary.errorCode || NAVER_RANK_PROVIDER_UNAVAILABLE);
        const sourceStatus = sourceErrorCode === "SHOPPING_RANK_PROVIDER_UNAUTHORIZED"
          ? "unauthorized"
          : (sourceErrorCode === "SHOPPING_RANK_PROVIDER_MISCONFIGURED"
            || sourceErrorCode === "SHOPPING_RANK_SOURCE_NOT_CONFIGURED")
            ? "misconfigured"
            : "unavailable";
        const sourceMessage = sourceStatus === "unauthorized"
          ? "네이버 상품 순위 수집원 인증이 올바르지 않아 남은 대기열을 보존했습니다."
          : sourceStatus === "misconfigured"
            ? "네이버 상품 순위 수집원 설정이 올바르지 않아 남은 대기열을 보존했습니다."
            : "네이버 상품 순위 수집원이 갱신 중 준비 상태를 잃어 남은 대기열을 보존했습니다.";
        return json(request, {
          ok: false,
          code: sourceErrorCode,
          retryable: summary.retryable === true,
          message: sourceMessage,
          summary: safeSummary,
          sourceStatus: {
            shoppingRank: { status: sourceStatus },
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
      return json(request, {
        ok: true,
        summary: safeSummary,
        sourceStatus: {
          shoppingRank: { status: "ready" },
        },
      });
    } catch (error) {
      return json(request, {
        ok: false,
        message: "네이버 상품 순위 자동 갱신 중 오류가 발생했습니다.",
        detail: process.env.NODE_ENV === "development" ? error?.message : undefined,
      }, 500);
    }
  }),
};

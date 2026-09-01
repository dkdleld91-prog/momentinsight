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
export const HYBRID_WORKER_SILENCE_MINUTES = 30;
export const NAVER_RANK_PROVIDER_NOT_CONFIGURED = "NAVER_RANK_PROVIDER_NOT_CONFIGURED";
export const NAVER_RANK_PROVIDER_WARMING = "NAVER_RANK_PROVIDER_WARMING";
export const NAVER_RANK_PROVIDER_UNAVAILABLE = "NAVER_RANK_PROVIDER_UNAVAILABLE";
export const NAVER_RANK_CRON_ITEM_FAILURE = "NAVER_RANK_CRON_ITEM_FAILURE";
export const NAVER_RANK_WORKER_SILENT = "NAVER_RANK_WORKER_SILENT";
export const NAVER_RANK_WORKER_SIGNAL_UNKNOWN = "NAVER_RANK_WORKER_SIGNAL_UNKNOWN";

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

// 워커 신호는 3상태다: active / silent / unknown.
// unknown(supabaseAdmin 부재 · PostgREST error · throw)을 silent 로 뭉치면 권한 문제나
// 스키마 드리프트, 일시적 DB 5xx 를 "중앙 Chrome 이 죽었다"고 단정해 진단이 한 단계
// 어긋난다. 두 상태 모두 크론은 실패로 다루되(fail-closed) 코드와 메시지를 분리한다.
//
// 판정 근거는 "서명(nonce)"이 아니라 "진척"이다. nonce 는 서명 검증 직후, 본문
// JSON.parse 와 모든 action 분기보다 먼저 삽입되므로(naver-shopping-local-worker.mjs 의
// consumeNonce) 서명만 반복하고 아무 일도 하지 못하는 워커도 매분 nonce 를 남긴다.
// 실측(2026-09-01T08:30Z 프로덕션 읽기 전용 조회): 최신 nonce 는 54초 전인데
// naver_rank_snapshots 최신 checked_at 은 15.1시간 전, worker_coordination.primary_seen_at
// 은 14.4시간 전, last_success_at 은 15.1시간 전, 깨우기 요청은 2.5시간째 미소비였다.
// nonce 기준으로는 이 15시간 중단이 그대로 202 ok 로 나간다.
// 그래서 코디네이션 행의 두 진척 표식을 본다.
//   primary_seen_at — primary 워커가 전역 레인을 claim 할 때만 갱신된다
//     (mi_claim_naver_shopping_worker_lane). 일이 없어도 워커가 살아 있으면 갱신된다.
//   last_success_at — 실제 수집 성공 시각.
// 둘 중 최신값이 HYBRID_WORKER_SILENCE_MINUTES 안이면 active 다.
const WORKER_COORDINATION_TABLE = "naver_shopping_worker_coordination";

export function hybridWorkerProgressAt(row) {
  const stamps = [row?.primary_seen_at, row?.last_success_at]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value));
  return stamps.length ? Math.max(...stamps) : 0;
}

export async function hybridWorkerSignal(ctx, date = new Date()) {
  const nowMs = date.getTime();
  if (!ctx?.supabaseAdmin || !Number.isFinite(nowMs)) return "unknown";
  const cutoffMs = nowMs - HYBRID_WORKER_SILENCE_MINUTES * 60_000;
  try {
    const { data, error } = await ctx.supabaseAdmin
      .from(WORKER_COORDINATION_TABLE)
      .select("primary_seen_at, last_success_at")
      .eq("lane_key", "global")
      .limit(1);
    if (error) return "unknown";
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return "unknown";
    const progressMs = hybridWorkerProgressAt(row);
    // 두 표식이 모두 비어 있으면(최초 배치 직후 등) 침묵이라 단정하지 않는다.
    if (progressMs <= 0) return "unknown";
    return progressMs >= cutoffMs ? "active" : "silent";
  } catch {
    // A missing coordination row or transient DB read must never be reported as
    // a dead collector. This is the fail-safe path during staged rollout.
    return "unknown";
  }
}

export async function hybridWorkerRecentlyActive(ctx, date = new Date()) {
  return (await hybridWorkerSignal(ctx, date)) === "active";
}

// 하이브리드 모드의 실패 신호. 유예(HYBRID_WORKER_GRACE_MINUTES) 안에서는 워커가 아직
// 첫 레인을 잡지 않았을 수 있으므로 판정하지 않는다 — 크론 슬롯(:05/:10/:15)이
// 깨우기 직후라서 매 슬롯마다 거짓 실패가 난다. 유예가 끝났는데도 최근 진척이 없으면
// 그 상태를 202 ok 로 감추지 않고 실패로 보고하되, 판독 불가는 침묵과 구분해 보고한다.
export async function hybridWorkerFailure(ctx, date = new Date()) {
  if (hybridWorkerGraceActive(date)) return null;
  const signal = await hybridWorkerSignal(ctx, date);
  if (signal === "active") return null;
  if (signal === "unknown") {
    return {
      code: NAVER_RANK_WORKER_SIGNAL_UNKNOWN,
      status: "worker_signal_unknown",
      message: "중앙 Chrome 자동 순환 작업기의 진척 기록을 읽지 못했습니다. 수집기 상태를 단정할 수 없습니다.",
    };
  }
  return {
    code: NAVER_RANK_WORKER_SILENT,
    status: "worker_silent",
    message: `중앙 Chrome 자동 순환 작업기가 ${HYBRID_WORKER_SILENCE_MINUTES}분 넘게 레인 확보도 수집 성공도 기록하지 않아 순위 수집이 멈췄습니다.`,
  };
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
        const workerFailure = await hybridWorkerFailure(ctx, new Date());
        if (workerFailure) {
          return json(request, {
            ok: false,
            code: workerFailure.code,
            message: workerFailure.message,
            claimed: 0,
            sourceStatus: {
              shoppingRank: { status: workerFailure.status },
            },
          }, 503);
        }
        return json(request, {
          ok: true,
          deferred: true,
          remoteWakeRequested: true,
          // 깨우기 "요청을 기록했다"까지가 확인된 사실이다. 요청이 실제로 소비됐는지는
          // 이 응답 시점에 확인되지 않는다(실측: 미소비 깨우기가 2.5시간 남아 있던 사례).
          // 단정은 바로 위에서 확인한 진척 기록까지만 한다.
          message: `중앙 Chrome 300위 자동 순환에 깨우기를 요청했고 작업기는 최근 ${HYBRID_WORKER_SILENCE_MINUTES}분 이내 진척을 기록했습니다. 기존 순서를 유지합니다.`,
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

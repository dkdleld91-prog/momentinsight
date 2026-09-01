import { withSupabase } from "@supabase/server";
import { cronAuthorized } from "../cron-auth.mjs";
import { corsHeaders, protectedJson } from "../security.mjs";
import { runDuePlaceTrackers } from "./naver-place-rank-trackers.mjs";
import { runChronicIsolationPass, runPlaceRequeuePass } from "../naver-rank-requeue.mjs";

const DEFAULT_CRON_BATCH = 1;

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "authorization, content-type",
  });
}

export function placeRankCronResult(summary, { drainMode = false } = {}) {
  if (!summary?.configured) {
    return {
      status: 503,
      body: {
        ok: false,
        message: "네이버 플레이스 순위 조회 연결이 준비되지 않았습니다.",
        summary,
      },
    };
  }

  const failed = Number(summary.failed || 0);
  const partial = Number(summary.partial || 0);
  if (!drainMode && summary.checked > 0 && failed > 0) {
    return {
      status: 502,
      body: {
        ok: false,
        message: "일부 네이버 플레이스 순위 자동 갱신이 실패했습니다.",
        summary,
      },
    };
  }

  if (!drainMode && partial > 0) {
    return {
      status: 502,
      body: {
        ok: false,
        message: "일부 네이버 플레이스 순위 조회가 전체 범위를 확인하지 못했습니다.",
        summary,
      },
    };
  }

  if (!summary.drained && !drainMode) {
    return {
      status: 503,
      body: {
        ok: false,
        message: "네이버 플레이스 순위 갱신 대기열이 남아 있습니다.",
        summary,
      },
    };
  }

  // Drain callers validate the typed summary and report the final workflow as
  // failed after every healthy tracker behind a bad item has been attempted.
  // HTTP 200 here means the batch command itself completed, not that every
  // tracker produced a complete rank result.
  return {
    status: 200,
    body: {
      ok: true,
      summary,
      degraded: failed > 0 || partial > 0,
    },
  };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, {
          methods: "GET, POST, OPTIONS",
          headers: "authorization, content-type",
        }),
      });
    }

    if (!["GET", "POST"].includes(request.method)) {
      return json(request, { ok: false, message: "Method not allowed" }, 405);
    }

    if (!cronAuthorized(request)) {
      return json(request, { ok: false, message: "Unauthorized cron request" }, 401);
    }

    try {
      const url = new URL(request.url);
      const drainMode = url.searchParams.get("mode") === "drain";
      // 만성 실패 격리는 플레이스·상품 두 레인 모두 여기서 돌린다.
      // 왜 상품 레인까지 플레이스 크론이 맡는가: 현재 하이브리드 운영 모드에서
      // 상품 크론(src/server/handlers/naver-rank-cron.mjs:234-278)은 runDueTrackers 에
      // 닿기 전에 202/503 으로 단락되기 때문에, 추적기 유지보수를 항상 수행하는
      // 서버 크론 경로는 이 플레이스 크론뿐이다(매시 "37 * * * *" + 슬롯 크론).
      // 순서: 격리를 먼저 돌려야 같은 요청 안에서 새로 격리된 플레이스 추적기가
      // runPlaceRequeuePass·runDuePlaceTrackers 이전에 이미 파킹된 상태가 된다.
      // 격리 패스는 자체적으로 예외를 삼키고 실패를 { failed: true } 로 강등하므로
      // 여기서 거부가 올라올 경로는 원래 없다. 그럼에도 allSettled 를 쓰는 이유는
      // 두 레인을 서로 격리하기 위해서다: Promise.all 은 한 레인이 거부하면 나머지
      // 레인의 결과를 즉시 버리므로, 훗날 패스가 동기 단계에서 던지도록 바뀌면
      // 플레이스 실패가 상품 격리를 조용히 취소시킨다. allSettled 는 두 레인이 항상
      // 끝까지 각자 돈다는 것을 구조적으로 보장한다(유지보수 실패가 크론을 죽이지도 않는다).
      await Promise.allSettled([
        runChronicIsolationPass(ctx, "naver_place_rank_trackers"),
        runChronicIsolationPass(ctx, "naver_rank_trackers"),
      ]);
      await runPlaceRequeuePass(ctx);
      const summary = await runDuePlaceTrackers(ctx, {
        agencyCode: url.searchParams.get("agencyCode") || "",
        limit: DEFAULT_CRON_BATCH,
      });
      const result = placeRankCronResult(summary, { drainMode });
      return json(request, result.body, result.status);
    } catch (error) {
      return json(request, {
        ok: false,
        message: "네이버 플레이스 순위 자동 갱신 중 오류가 발생했습니다.",
        detail: process.env.NODE_ENV === "development" ? error?.message : undefined,
      }, 500);
    }
  }),
};

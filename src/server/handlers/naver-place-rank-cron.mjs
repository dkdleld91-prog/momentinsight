import { withSupabase } from "@supabase/server";
import { cronAuthorized } from "../cron-auth.mjs";
import { corsHeaders, protectedJson } from "../security.mjs";
import { runDuePlaceTrackers } from "./naver-place-rank-trackers.mjs";

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

import { withSupabase } from "@supabase/server";
import { corsHeaders, protectedJson } from "../security.mjs";
import { RANK_OVERDUE_THRESHOLD_MS } from "../naver-rank-requeue.mjs";

const CACHE_TTL_MS = 60_000;
// 실패 응답도 짧게 캐시한다. 성공만 캐시하면 Supabase 장애 중 무인증 요청 1건마다
// service-role 쿼리 5건이 그대로 나가 장애를 증폭시킨다(ready.mjs 는 성공·실패를
// 가리지 않고 캐시한다). 복구 감지가 늦어지지 않도록 성공 캐시(60초)보다 짧게 잡는다.
const FAILURE_CACHE_TTL_MS = 15_000;
// 실측 주의: 이 헤더는 최종 응답에 남지 않는다. runtime.mjs 의 runtimeResponse 가
// corsHeaders() 의 비-CORS 항목을 전부 다시 set 하므로 실제로는 cache-control: no-store 로
// 나간다(로컬 dev 서버 curl 로 확인). 따라서 CDN 캐시는 걸리지 않으며,
// 폴링 비용은 아래 CACHE_TTL_MS 인프로세스 캐시가 흡수한다.
// 중앙 보안 정책(모든 API 무캐시)을 이 기능 때문에 바꾸지 않는다.
const CACHE_CONTROL = "public, max-age=60, s-maxage=60, stale-while-revalidate=120";
const CORS_OPTIONS = { methods: "GET, OPTIONS", headers: "content-type" };
const RANK_TABLES = ["naver_rank_trackers", "naver_place_rank_trackers"];
const WORKER_COORDINATION_TABLE = "naver_shopping_worker_coordination";
// 사람이 의도적으로 세울 때만 남는 사유. 그 외 circuit_reason 은 전부 수집기 자신의
// 실패로 자동 설정된다(아래 deliberateWorkerStopFromRow 주석의 실측 근거 참고).
const DELIBERATE_CIRCUIT_REASONS = new Set(["manual_stop", "manual_canary"]);

// ready.mjs 와 같은 모양의 인프로세스 캐시. 10분 주기 워치독 폴링을 CDN 과 함께 흡수한다.
// 엔트리에 status 와 헤더를 함께 담아 캐시 히트 시 원래 응답(200/503)을 그대로 재현한다.
let cached = null;

// 레인별 queueStalled 는 두 조건의 AND 다. 어느 한쪽만으로는 절대 true 가 되지 않는다.
//   (1) 예정 시각을 6시간 넘긴 active 추적기가 그 레인에 1건이라도 있다 ← "일이 밀려 있다"
//   (2) 그 레인의 MAX(last_checked_at) 도 6시간을 넘겼다                 ← "그동안 아무것도 수집되지 않았다"
// (1) 단독은 정상 상태에서도 항상 참이다. 운영 상품 경로(hybrid_local_worker)의
// durable cycle 은 sort_order cursor 순으로 돌기 때문에 next_check_at 은 약속이 아니라
// 정시 슬롯 표식일 뿐이고, 실측 처리량(5.457202 group/hour, wall 38261.363749초에
// group58 = cycle 1회전 약 10.6시간)에서는 정시 enqueue 직후 다수의 추적기가
// 건강한 상태로도 6시간 넘게 대기한다. (2)를 AND 로 걸면 대기열 깊이와 무관해진다:
// 정상 수집 중에는 약 11분마다 last_checked_at 이 갱신되므로 (2)가 거짓이다.
// (2) 단독도 쓸 수 없다 — 대기열을 모두 비운 뒤 다음 09:00 슬롯까지의 정상 유휴
// 구간에서 참이 되기 때문이다. 그 구간에는 (1)이 거짓이다.
// 부수효과로 "지금 수집 중인(lease 중인) 추적기가 지연으로 집계된다"는 문제도
// 사라진다 — 수집이 진행 중이면 (2)가 거짓이다.
//
// 레인(테이블)을 반드시 분리해서 판정한 뒤 OR 로 합친다. 상품(naver_rank_trackers)은
// 대표님 맥의 Chrome 하이브리드 로컬 워커가, 플레이스(naver_place_rank_trackers)는
// 서버 크론(GitHub Actions)이 HTTP 로 수집하는 완전히 독립된 두 계통이라 한쪽의
// 성공이 다른 쪽의 건강을 전혀 보증하지 않는다. 실측: 두 테이블의 MAX(last_checked_at)
// 를 Math.max 로 합치면 상품 수집기가 48시간 죽어 있어도 플레이스가 정상 슬롯을
// 도는 동안 queueStalled=false 가 되어 하루 24시간 중 13시간의 정체가 은폐되고,
// 워치독의 "60분 연속" 조건도 하루 두 번 리셋되어 영원히 채워지지 않았다.
// 응답 표면은 워치독 계약대로 4키를 유지하되, lastSuccessAt/stalledMinutes 는
// 가장 나쁜 레인(타임스탬프가 있는 레인 중 last_checked_at 이 가장 오래된 쪽)에서 낸다.
export function rankCollectionHealthBody(input = {}) {
  const now = Number(input.now || Date.now());
  const lanes = (Array.isArray(input.lanes) ? input.lanes : []).map((lane) => {
    const parsed = new Date(lane?.lastCheckedAt || 0).getTime();
    const lastCheckedAt = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    const laneNoRecentSuccess = lastCheckedAt > 0 && now - lastCheckedAt > RANK_OVERDUE_THRESHOLD_MS;
    return {
      key: lane?.key,
      lastCheckedAt,
      laneStalled: Boolean(lane?.overdue) && laneNoRecentSuccess,
    };
  });

  // 타임스탬프가 없는 레인은 "가장 나쁜 레인" 후보에서 제외한다. 수집 이력이 아직
  // 없는 레인은 0 으로 접히므로 그대로 두면 언제나 최악으로 뽑혀 버린다.
  const timestamped = lanes.filter((lane) => lane.lastCheckedAt > 0);
  const worst = timestamped.length
    ? timestamped.reduce((oldest, lane) => (lane.lastCheckedAt < oldest.lastCheckedAt ? lane : oldest))
    : null;

  return {
    ok: true,
    lastSuccessAt: worst ? new Date(worst.lastCheckedAt).toISOString() : null,
    stalledMinutes: worst ? Math.max(0, Math.floor((now - worst.lastCheckedAt) / 60000)) : 0,
    // 타임스탬프가 있는 레인이 하나도 없으면 laneStalled 도 전부 거짓이므로 자연히 false 다.
    queueStalled: lanes.some((lane) => lane.laneStalled) && !input.deliberateStop,
  };
}

// "대표가 의도한 정지"는 아래 둘뿐이다.
//   (1) cooldown_until > now — 네이버 접속 제한 쿨다운. 자동으로 걸리지만 이 구간에
//       Chrome 을 재기동하면 해롭고, 수집기 자체는 살아 있다.
//   (2) circuit_reason 이 manual_stop 또는 manual_canary — 사람이 세운 경우.
//       manual_stop 은 대표실 '긴급 안전 정지' 버튼(mi_stop_naver_shopping_worker 의
//       p_reason default, supabase/migrations/20260811095137_naver_shopping_worker_control_plane.sql:829),
//       manual_canary 는 1건 검증 프로브(같은 파일 908행)에서만 기록된다.
// circuit_state 만 보고 open/half_open 을 전부 "의도된 정지"로 눌러서는 안 된다.
// 실측(마이그레이션 확인): circuit_reason 6종 중 auto_navigation_probe,
// auto_transient_system_probe, navigating:naver_page_navigation_failed,
// probe_incomplete, probe_interrupted 5종은 수집기 자신의 실패로 자동 설정된다.
// 게다가 Chrome 이 죽으면 open → half_open 으로 나가는 유일한 경로가 "10분 뒤
// primary worker 요청 도착"이라 회로가 영구히 open 에 머문다(sticky). 즉 자동 사유의
// open 을 의도된 정지로 취급하면 워치독은 정확히 사고 상황에서 영원히 침묵한다.
// 따라서 자동 사유의 open/half_open 과 사유 없음은 정체 판정을 그대로 살린다.
export function deliberateWorkerStopFromRow(row, now) {
  if (!row) return false;
  const cooldownAt = Date.parse(row.cooldown_until || "");
  if (Number.isFinite(cooldownAt) && cooldownAt > Number(now)) return true;
  return DELIBERATE_CIRCUIT_REASONS.has(String(row.circuit_reason || "").trim().toLowerCase());
}

// 조회만 담당하는 얇은 래퍼. 판정은 전부 위 순수 함수가 한다(테스트가 실행 검증한다).
// 읽기에 실패하거나 행이 없으면 "의도된 정지 아님"으로 두어 정체 감지 자체는 살려 둔다.
async function deliberateWorkerStop(ctx, now) {
  try {
    let { data, error } = await ctx.supabaseAdmin
      .from(WORKER_COORDINATION_TABLE)
      .select("circuit_state, circuit_reason, cooldown_until")
      .eq("lane_key", "global")
      .maybeSingle();
    if (error && /circuit_state|circuit_reason|schema cache|does not exist/i.test(error.message || "")) {
      ({ data, error } = await ctx.supabaseAdmin
        .from(WORKER_COORDINATION_TABLE)
        .select("cooldown_until")
        .eq("lane_key", "global")
        .maybeSingle());
    }
    if (error || !data) return false;
    return deliberateWorkerStopFromRow(data, now);
  } catch {
    return false;
  }
}

async function latestCheckedAt(ctx, table) {
  const { data, error } = await ctx.supabaseAdmin
    .from(table)
    .select("last_checked_at")
    .not("last_checked_at", "is", null)
    .order("last_checked_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0].last_checked_at : "";
}

async function hasOverdueActive(ctx, table, cutoffIso) {
  // status='active' 부분 인덱스 (status, next_check_at) 를 그대로 탄다.
  const { data, error } = await ctx.supabaseAdmin
    .from(table)
    .select("next_check_at")
    .eq("status", "active")
    .lt("next_check_at", cutoffIso)
    .order("next_check_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  return Boolean(data && data.length);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, CORS_OPTIONS) });
    }
    if (request.method !== "GET") {
      return protectedJson(request, { ok: false, message: "Method not allowed" }, 405, CORS_OPTIONS);
    }

    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return protectedJson(request, cached.body, cached.status, {
        ...CORS_OPTIONS,
        extraHeaders: cached.extraHeaders,
      });
    }

    try {
      const cutoffIso = new Date(now - RANK_OVERDUE_THRESHOLD_MS).toISOString();
      const [productLatest, placeLatest, productOverdue, placeOverdue, deliberateStop] = await Promise.all([
        latestCheckedAt(ctx, RANK_TABLES[0]),
        latestCheckedAt(ctx, RANK_TABLES[1]),
        hasOverdueActive(ctx, RANK_TABLES[0], cutoffIso),
        hasOverdueActive(ctx, RANK_TABLES[1], cutoffIso),
        deliberateWorkerStop(ctx, now),
      ]);
      const body = rankCollectionHealthBody({
        now,
        lanes: [
          { key: "product", lastCheckedAt: productLatest, overdue: productOverdue },
          { key: "place", lastCheckedAt: placeLatest, overdue: placeOverdue },
        ],
        deliberateStop,
      });
      cached = {
        body,
        status: 200,
        extraHeaders: { "cache-control": CACHE_CONTROL },
        expiresAt: now + CACHE_TTL_MS,
      };
      return protectedJson(request, body, 200, {
        ...CORS_OPTIONS,
        extraHeaders: cached.extraHeaders,
      });
    } catch {
      // 조회 실패는 "정체"가 아니다. 워치독이 아무 동작도 하지 않도록 non-2xx 로 알린다.
      const body = {
        ok: false,
        lastSuccessAt: null,
        stalledMinutes: 0,
        queueStalled: false,
      };
      cached = {
        body,
        status: 503,
        extraHeaders: { "cache-control": "no-store", "retry-after": "60" },
        expiresAt: now + FAILURE_CACHE_TTL_MS,
      };
      return protectedJson(request, body, 503, {
        ...CORS_OPTIONS,
        extraHeaders: cached.extraHeaders,
      });
    }
  }),
};

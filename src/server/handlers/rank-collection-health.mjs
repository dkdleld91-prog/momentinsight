import { withSupabase } from "@supabase/server";
import { corsHeaders, protectedJson } from "../security.mjs";
import {
  RANK_NEVER_FOUND_MIN_CHECKS,
  RANK_OVERDUE_THRESHOLD_MS,
  RANK_STUCK_TRACKER_MS,
} from "../naver-rank-requeue.mjs";
import {
  heartbeatAgeMinutes as heartbeatAgeMinutesFromStamps,
  workerOutdatedFromSignals,
} from "../naver-shopping/worker-runtime-expectation.mjs";

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
// 낡은 실행본 관측에 쓰는 두 표. runs 는 진척이 stage='navigating' 에 닿아야 행이
// 생기므로 버전이 어긋난 구간에는 새 행이 없고 최신 행의 runtime_version 이 낡은 값에
// 멈춘다. nonces 는 그 구간에도 매분 한 줄씩 계속 쌓인다.
const WORKER_RUNS_TABLE = "naver_shopping_worker_runs";
const WORKER_NONCE_TABLE = "naver_shopping_worker_nonces";
// 사람이 의도적으로 세울 때만 남는 사유. 그 외 circuit_reason 은 전부 수집기 자신의
// 실패로 자동 설정된다(아래 deliberateWorkerStopFromRow 주석의 실측 근거 참고).
const DELIBERATE_CIRCUIT_REASONS = new Set(["manual_stop", "manual_canary"]);

// ready.mjs 와 같은 모양의 인프로세스 캐시. 10분 주기 워치독 폴링을 CDN 과 함께 흡수한다.
// 엔트리에 status 와 헤더를 함께 담아 캐시 히트 시 원래 응답(200/503)을 그대로 재현한다.
let cached = null;

// lanes 의 두 키. 입력 레인이 비어 있어도 공개 표면에는 이 두 키가 항상 실린다.
const LANE_KEYS = ["product", "place"];
const FAILSAFE_LANE = Object.freeze({ lastSuccessAt: null, stalledMinutes: 0, queueStalled: false });

// trackers 집계 정수의 안전 변환. 조회 실패·null·NaN·음수·무한대는 전부 0 이다 —
// "모른다" 를 0 으로 내는 것은 이 엔드포인트의 fail-safe 규약(관측 실패는 경보가 아니다)이다.
function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

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
// lastSuccessAt/stalledMinutes 는 가장 나쁜 레인(타임스탬프가 있는 레인 중
// last_checked_at 이 가장 오래된 쪽)에서 낸다.
//
// ── 응답 표면은 정확히 8키다 (ok, lastSuccessAt, stalledMinutes, queueStalled,
//    workerOutdated, heartbeatAgeMinutes, lanes, trackers). 이 순서는 200/503 양쪽에서
//    동일하다.
// 앞 4키는 워치독 계약 그대로 이름·순서·의미를 한 글자도 바꾸지 않는다. 5·6번째 키가
// "상태 필드는 늘리지 않는다"는 원칙의 첫 예외인 이유는 앞 4키로는 원리적으로
// 볼 수 없는 사각지대가 실제로 17시간 열려 있었기 때문이다.
// 2026-09-02(C2 결함 C·K4): 7·8번째 키를 붙인다.
//   lanes    — { product:{lastSuccessAt, stalledMinutes, queueStalled}, place:{…} }.
//              앞 4키는 "가장 나쁜 레인"만 말하므로 어느 레인이 죽었는지 이 응답만으로는
//              알 수 없었다. 레인별 값은 위 최악-레인 계산과 같은 재료에서 나오며,
//              불변식 최상위 queueStalled === (lanes.product.queueStalled || lanes.place.queueStalled)
//              을 반드시 지킨다 — 워치독은 본문 전체를 grep 으로 읽으므로 중첩된
//              "queueStalled": true 가 최상위 false 와 공존하면 오탐이 난다. 그래서
//              의도된 정지(deliberateStop)도 레인까지 함께 누른다.
//   trackers — { neverFound:int, stuck:int }. 상품 추적기 집계 두 개.
//              neverFound = active AND check_count >= RANK_NEVER_FOUND_MIN_CHECKS AND found_count = 0
//              stuck      = active AND last_error IS NOT NULL
//                           AND coalesce(last_checked_at, created_at) < now - RANK_STUCK_TRACKER_MS
//              레인 전체는 돌고 있는데(queueStalled=false) 개별 추적기가 며칠째 멈춘 상태는
//              앞 6키로는 원리적으로 보이지 않는다. 두 집계는 관측 전용이라 조회 실패는
//              0 으로 접히고(fail-safe) 절대 503 을 만들지 않는다. 식별자·문구 없이 정수만 낸다.
// 2026-09-01: 윈도우 수집 작업기가 서버 기대 실행본보다 낮은 버전이라 서버가 요청을
// 전부 400 으로 거부했다. 거부는 claim RPC 앞에서 일어나므로 진척 표식은 얼어붙는데,
// 작업기 자신은 1분마다 서명을 계속 보내 살아 있었다. 실측(2026-09-01T08:30Z):
// 최신 nonce 54초 전 / primary_seen_at 14.4시간 전. 앞 4키만으로는 이 상태가
// "정상 유휴"와 구분되지 않는다 — queueStalled 는 대기 중인 일이 없으면 거짓이고,
// stalledMinutes 는 레인 표에서 나오므로 작업기의 거부 사실을 담지 못한다.
//   workerOutdated      — 위 두 신호의 AND 로만 참이 되는 집계 불리언.
//   heartbeatAgeMinutes — 코디네이션 진척이 몇 분째 멈춰 있는지의 정수.
// 두 키 모두 버전 문자열도, 작업기/기기 식별자도 절대 담지 않는다. 이 엔드포인트는
// 무인증 공개 표면이므로 노출은 집계 값까지만 허용된다.
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

  const deliberateStop = Boolean(input.deliberateStop);
  // 레인별 표면. 이력이 없는 레인(lastCheckedAt=0)은 최악-레인 후보에서 빠지는 것과 같은
  // 이유로 안전값이다. queueStalled 는 최상위와 같은 deliberateStop 억제를 받는다(OR 불변식).
  const laneBody = (key) => {
    const found = lanes.find((lane) => lane.key === key);
    if (!found || !(found.lastCheckedAt > 0)) return { ...FAILSAFE_LANE };
    return {
      lastSuccessAt: new Date(found.lastCheckedAt).toISOString(),
      stalledMinutes: Math.max(0, Math.floor((now - found.lastCheckedAt) / 60000)),
      queueStalled: found.laneStalled && !deliberateStop,
    };
  };
  const trackersInput = input.trackers && typeof input.trackers === "object" ? input.trackers : {};

  return {
    ok: true,
    lastSuccessAt: worst ? new Date(worst.lastCheckedAt).toISOString() : null,
    stalledMinutes: worst ? Math.max(0, Math.floor((now - worst.lastCheckedAt) / 60000)) : 0,
    // 타임스탬프가 있는 레인이 하나도 없으면 laneStalled 도 전부 거짓이므로 자연히 false 다.
    queueStalled: lanes.some((lane) => lane.laneStalled) && !deliberateStop,
    // 판정은 전부 순수 모듈이 한다. 여기서는 조회 결과를 그대로 넘기기만 한다.
    workerOutdated: workerOutdatedFromSignals({
      lastRunRuntimeVersion: input.lastRunRuntimeVersion,
      lastSignatureAt: input.lastSignatureAt,
      now,
    }),
    // 주의: input.lastSuccessAt 은 코디네이션 행의 last_success_at 이고, 위 출력 키
    // lastSuccessAt(레인 표의 worst.lastCheckedAt 에서 나온다)과는 완전히 다른 값이다.
    // 이름이 겹칠 뿐 서로 섞이지 않으며, 새 입력이 기존 출력 키를 바꾸지 않는다.
    heartbeatAgeMinutes: heartbeatAgeMinutesFromStamps({
      primarySeenAt: input.primarySeenAt,
      lastSuccessAt: input.lastSuccessAt,
      now,
    }),
    lanes: Object.fromEntries(LANE_KEYS.map((key) => [key, laneBody(key)])),
    trackers: {
      neverFound: nonNegativeInteger(trackersInput.neverFound),
      stuck: nonNegativeInteger(trackersInput.stuck),
    },
  };
}

// 503 본문과 조회 실패 시 쓰는 안전값. 200 과 같은 모양이다.
function failSafeLanes() {
  return Object.fromEntries(LANE_KEYS.map((key) => [key, { ...FAILSAFE_LANE }]));
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
// 같은 행에 heartbeatAgeMinutes 의 두 재료(primary_seen_at, last_success_at)가 있으므로
// 왕복을 늘리지 않고 select 만 넓혀 함께 읽는다. 반환은 불리언이 아니라 객체다.
// 열이 아직 없는 환경으로 내려오면 cooldown_until 만 다시 읽는 축약 경로가 그대로
// 살아 있고, 그 경로에서는 두 표식이 단순히 비어 있다(= heartbeat 신호 없음 → 0).
async function deliberateWorkerStop(ctx, now) {
  const empty = { deliberateStop: false, primarySeenAt: "", lastSuccessAt: "" };
  try {
    let { data, error } = await ctx.supabaseAdmin
      .from(WORKER_COORDINATION_TABLE)
      .select("circuit_state, circuit_reason, cooldown_until, primary_seen_at, last_success_at")
      .eq("lane_key", "global")
      .maybeSingle();
    if (error && /circuit_state|circuit_reason|schema cache|does not exist/i.test(error.message || "")) {
      ({ data, error } = await ctx.supabaseAdmin
        .from(WORKER_COORDINATION_TABLE)
        .select("cooldown_until")
        .eq("lane_key", "global")
        .maybeSingle());
    }
    if (error || !data) return empty;
    return {
      deliberateStop: deliberateWorkerStopFromRow(data, now),
      primarySeenAt: String(data.primary_seen_at || ""),
      lastSuccessAt: String(data.last_success_at || ""),
    };
  } catch {
    return empty;
  }
}

// 아래 두 조회는 관측 전용이다. 어떤 실패도 200 을 503 으로 뒤집어서는 안 된다.
// 표가 없든, PostgREST 가 권한을 거부하든, 클라이언트 체인이 throw 하든 결과는 하나 —
// 빈 문자열, 즉 "신호 없음"이다. 신호가 없으면 workerOutdatedFromSignals 가 false 로
// 물러나므로 판독 실패가 거짓 경보로 번지지 않는다. latestCheckedAt/hasOverdueActive 가
// throw 를 그대로 올려 503 을 내는 것과는 의도적으로 반대 방향이다: 저 둘은 이 응답의
// 본체이고, 이 둘은 곁다리 관측이다.
async function latestWorkerRunVersion(ctx) {
  try {
    const { data, error } = await ctx.supabaseAdmin
      .from(WORKER_RUNS_TABLE)
      .select("runtime_version")
      .order("started_at", { ascending: false })
      .limit(1);
    if (error) return "";
    const row = Array.isArray(data) ? data[0] : data;
    return String(row?.runtime_version || "");
  } catch {
    return "";
  }
}

// 서명(nonce)은 진척이 아니다 — 서명 검증 직후, 본문 파싱과 모든 분기보다 먼저
// 삽입되므로 서버에 400 으로 거부당하는 작업기도 매분 한 줄을 남긴다. 바로 그래서
// "작업기가 아직 켜져 있다"는 사실만큼은 이 표가 유일하게 정직하게 말해 준다.
async function latestWorkerSignatureAt(ctx) {
  try {
    const { data, error } = await ctx.supabaseAdmin
      .from(WORKER_NONCE_TABLE)
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return "";
    const row = Array.isArray(data) ? data[0] : data;
    return String(row?.created_at || "");
  } catch {
    return "";
  }
}

// trackers 집계 두 개가 쓰는 관측 전용 카운트. select head + count=exact 로 행 본문을
// 받지 않고 개수만 받는다. 위 두 관측 조회와 같은 fail-safe 방향이다 — 표·열이 없든,
// 권한이 거부되든, 체인이 throw 하든 결과는 0(신호 없음)이고 절대 503 으로 번지지 않는다.
async function countActiveTrackers(ctx, table, applyFilters) {
  try {
    const base = ctx.supabaseAdmin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("status", "active");
    const { count, error } = await applyFilters(base);
    if (error) return 0;
    return nonNegativeInteger(count);
  } catch {
    return 0;
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
      const stuckCutoffIso = new Date(now - RANK_STUCK_TRACKER_MS).toISOString();
      const [
        productLatest,
        placeLatest,
        productOverdue,
        placeOverdue,
        coordination,
        lastRunRuntimeVersion,
        lastSignatureAt,
        neverFoundTrackers,
        stuckTrackers,
      ] = await Promise.all([
        latestCheckedAt(ctx, RANK_TABLES[0]),
        latestCheckedAt(ctx, RANK_TABLES[1]),
        hasOverdueActive(ctx, RANK_TABLES[0], cutoffIso),
        hasOverdueActive(ctx, RANK_TABLES[1], cutoffIso),
        deliberateWorkerStop(ctx, now),
        latestWorkerRunVersion(ctx),
        latestWorkerSignatureAt(ctx),
        // 두 집계는 상품 표(RANK_TABLES[0])만 본다. 임계값은 서버 상수 그대로다.
        countActiveTrackers(ctx, RANK_TABLES[0], (query) => query
          .gte("check_count", RANK_NEVER_FOUND_MIN_CHECKS)
          .eq("found_count", 0)),
        // OR 의 두 갈래는 만성 격리(chronicIsolationCandidate)의 앵커 규칙과 같다:
        // 성공 이력이 있으면 last_checked_at, 없으면(null) created_at 이 앵커다.
        // retry_count 는 보지 않는다 — 소진 전에 멈춘 행을 잡는 것이 이 집계의 존재 이유다.
        countActiveTrackers(ctx, RANK_TABLES[0], (query) => query
          .not("last_error", "is", null)
          .or(`last_checked_at.lt.${stuckCutoffIso},and(last_checked_at.is.null,created_at.lt.${stuckCutoffIso})`)),
      ]);
      const body = rankCollectionHealthBody({
        now,
        lanes: [
          { key: "product", lastCheckedAt: productLatest, overdue: productOverdue },
          { key: "place", lastCheckedAt: placeLatest, overdue: placeOverdue },
        ],
        deliberateStop: coordination.deliberateStop,
        primarySeenAt: coordination.primarySeenAt,
        // 코디네이션 행의 last_success_at 이다. 위 lanes 에서 나오는 출력 키
        // lastSuccessAt 과 이름만 같을 뿐 heartbeatAgeMinutes 에만 쓰인다.
        lastSuccessAt: coordination.lastSuccessAt,
        lastRunRuntimeVersion,
        lastSignatureAt,
        trackers: { neverFound: neverFoundTrackers, stuck: stuckTrackers },
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
      // 200 과 키 순서까지 동일하게 유지한다. 워치독·verify:live 는 키 집합을 계약으로
      // 읽으므로 상태코드에 따라 표면이 달라지면 안 된다. 관측 키·레인·집계는 안전값으로 낸다.
      const body = {
        ok: false,
        lastSuccessAt: null,
        stalledMinutes: 0,
        queueStalled: false,
        workerOutdated: false,
        heartbeatAgeMinutes: 0,
        lanes: failSafeLanes(),
        trackers: { neverFound: 0, stuck: 0 },
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

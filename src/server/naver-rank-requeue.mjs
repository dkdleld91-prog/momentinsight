// 재시도가 소진되어 멈춘 순위 추적기를 자동으로 다시 대기열에 넣는다.
// DB 마이그레이션 없이 동작한다: 자격 판정은 기존 컬럼만 읽는다.
//
// 적용 대상은 플레이스(naver_place_rank_trackers) 뿐이다. 상품
// (naver_rank_trackers)에는 절대 적용하지 않는다. 측정 근거:
//   1) 운영 상품 경로는 hybrid_local_worker 이고, 그 durable cycle 의 claim
//      질의는 next_check_at 을 아예 읽지 않는다(sort_order/worker_last_cycle_id/
//      worker_quarantined_until/processing_until 기준. 20260831003000 및
//      20260831033617 마이그레이션에 next_check_at 참조 0건). 상품에서
//      next_check_at 을 앞당겨도 수집 순서는 바뀌지 않는다 — 순수 무효 동작이다.
//   2) 상품을 실제로 주차시키는 값은 worker_quarantined_until 이고, 그 길이는
//      retry_count 로 정해진다(20260831014800: retry_count >= 2 이면 24시간,
//      아니면 30분). 여기서 retry_count 를 0 으로 되돌리면 구조적으로 실패하는
//      키워드의 재시도 간격이 24시간에서 30분으로 붕괴해 요청량이 폭증한다.
//   3) 상품에서 next_check_at 을 고쳐 쓰는 것은 문서화된 불변식 위반이다
//      (naver-rank-trackers.mjs "Never claim this tracker or rewrite next_check_at").
// 플레이스는 claim_due_naver_place_rank_tracker 가 next_check_at 순으로 claim 하고
// worker_quarantined_until 같은 별도 주차 장치가 없으므로 이 재큐가 그대로 유효하다.
//
// (a) 하루 상한(RANK_REQUEUE_DAILY_CAP=2)은 문자열이 아니라 산술로 강제된다.
//     같은 추적기의 두 재큐 사이 최소 간격은 requeueMinIntervalMs() 로 유도한다:
//       - 재큐 직후 retry_count=0 이므로 다시 자격(retry_count >= RANK_RETRY_EXHAUSTED_AT)을
//         얻으려면 실패가 8회 필요하고, 그 사이 대기는 사다리 앞 7칸의 합이다
//         (PLACE_RETRY_BACKOFF_MINUTES 5+10+20+40+80+160+320 = 635분).
//       - 8회째 실패가 next_check_at 을 마지막 실패 +360분으로 밀고,
//         거기서 다시 RANK_REQUEUE_MIN_IDLE_MS(6시간)가 지나야 자격이 선다.
//       - 합계 635 + 360 + 360 = 1355분 ≈ 22.58시간. 임의의 24시간 창 안에
//         두 번을 넘길 수 없으므로 상한 2 는 구조적으로 보장된다.
//     과거에는 이 상한을 last_message 문자열 표식("… (날짜 n/2회)")으로 셌다.
//     그 값은 claim/실패/성공 경로가 last_message 를 한 번만 덮어도 0 으로
//     되돌아가는 내구적 카운터가 아님 — 아무것도 강제하지 못해 제거했다.
// (b) last_message 는 광고주 화면(src/pages/client.html 플레이스 카드 메시지)에
//     그대로 렌더되는 사용자 대면 컬럼이다. 날짜·횟수 같은 내부 운영 텔레메트리를
//     절대 넣지 않는다. 다만 admin.html 이 접두사 일치로 배지를 판정하므로
//     RANK_AUTO_REQUEUE_MARKER 접두사는 유지해야 한다.
// (c) last_error 는 일부러 건드리지 않는다 — 원인 진단을 지우지 않고, 화면이
//     "자동 재시도 예정"을 구분할 수 있게 남긴다.

export const RANK_OVERDUE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
// 8 은 기존 상한이 아니다. rankRetryAt/placeRetryAt 의 백오프 표
// [5,10,20,40,80,160,320,360] 가 360분에 포화되는 지점으로 이번에 새로 정한 값이다.
export const RANK_RETRY_EXHAUSTED_AT = 8;
export const RANK_REQUEUE_MIN_IDLE_MS = 6 * 60 * 60 * 1000;
// 문자열로 세는 값이 아니라 requeueMinIntervalMs() 산술이 구조적으로 보장하는 상한이다.
export const RANK_REQUEUE_DAILY_CAP = 2;
export const RANK_REQUEUE_BATCH_LIMIT = 20;
export const RANK_REQUEUE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const RANK_AUTO_REQUEUE_MARKER = "자동 재시도 예약";
// 광고주 화면에 그대로 노출되는 문장. 날짜·횟수 등 내부 카운터를 넣지 않는다.
// admin.html 의 배지 판정이 indexOf(RANK_AUTO_REQUEUE_MARKER) === 0 이므로 접두사는 고정이다.
export const RANK_AUTO_REQUEUE_MESSAGE = `${RANK_AUTO_REQUEUE_MARKER} · 순위 갱신을 곧 다시 시도합니다.`;
// 순환 import 를 피하려고 복제한 상수다. src/server/handlers/naver-place-rank-trackers.mjs 의
// placeRetryAt 안 배열과 반드시 동일해야 하며, 테스트가 원본 소스와 문자열로 대조한다.
// 인덱스는 min(retry_count, 길이-1) 이고 retry_count 는 증가 전 값이다.
export const PLACE_RETRY_BACKOFF_MINUTES = [5, 10, 20, 40, 80, 160, 320, 360];

const BASE_COLUMNS = "id, status, last_error, retry_count, next_check_at, last_message";
const passMemo = new Map();

function backoffMinutesAt(retryCount) {
  const index = Math.min(Math.max(0, retryCount), PLACE_RETRY_BACKOFF_MINUTES.length - 1);
  return PLACE_RETRY_BACKOFF_MINUTES[index];
}

// 같은 추적기가 두 번 재큐되기까지의 최소 간격. 하드코딩 값이 아니라
// PLACE_RETRY_BACKOFF_MINUTES · RANK_RETRY_EXHAUSTED_AT · RANK_REQUEUE_MIN_IDLE_MS
// 에서 유도한다(상수가 바뀌면 값이 따라 움직여야 테스트가 드리프트를 잡는다).
export function requeueMinIntervalMs() {
  // 재큐 직후 retry_count=0 → 자격선(RANK_RETRY_EXHAUSTED_AT)까지 실패 N회가 필요하고,
  // 그 사이 대기는 앞의 N-1칸 합이다(마지막 실패의 대기는 아래에서 따로 더한다).
  let waitMinutes = 0;
  for (let retryCount = 0; retryCount < RANK_RETRY_EXHAUSTED_AT - 1; retryCount += 1) {
    waitMinutes += backoffMinutesAt(retryCount);
  }
  // 자격선을 넘기는 마지막 실패가 next_check_at 을 이만큼 미래로 민다.
  waitMinutes += backoffMinutesAt(RANK_RETRY_EXHAUSTED_AT - 1);
  // 그 next_check_at 이 다시 RANK_REQUEUE_MIN_IDLE_MS 만큼 과거가 되어야 자격이 선다.
  return waitMinutes * 60 * 1000 + RANK_REQUEUE_MIN_IDLE_MS;
}

export function requeueEligible(row, options = {}) {
  const now = Number(options.now || Date.now());
  if (!row || row.status !== "active") return false;
  if (!String(row.last_error || "")) return false;
  if (Number(row.retry_count || 0) < RANK_RETRY_EXHAUSTED_AT) return false;
  const next = new Date(row.next_check_at || 0).getTime();
  if (!Number.isFinite(next) || next <= 0) return false;
  if (now - next < RANK_REQUEUE_MIN_IDLE_MS) return false;
  // lease 가드. 워커가 claim 중인 행을 재큐하면 워커 완료 경로가 낡은 retry_count 로
  // 덮어써 재큐가 조용히 되돌려진다(lost update). 컬럼이 없으면 무시한다.
  if (row.processing_until) {
    const lease = new Date(row.processing_until).getTime();
    if (Number.isFinite(lease) && lease > now) return false;
  }
  // 플레이스에만 있는 컬럼. 없으면 무시한다(컬럼 부재 허용).
  if (row.last_attempt_at) {
    const attempt = new Date(row.last_attempt_at).getTime();
    if (Number.isFinite(attempt) && now - attempt < RANK_REQUEUE_MIN_IDLE_MS) return false;
  }
  return true;
}

async function requeuePass(ctx, table, options = {}) {
  const now = Number(options.now || Date.now());
  const cutoffIso = new Date(now - RANK_REQUEUE_MIN_IDLE_MS).toISOString();
  const nowIso = new Date(now).toISOString();
  const columns = table === "naver_place_rank_trackers"
    ? `${BASE_COLUMNS}, last_attempt_at, processing_until`
    : BASE_COLUMNS;

  const { data, error } = await ctx.supabaseAdmin
    .from(table)
    .select(columns)
    .eq("status", "active")
    .not("last_error", "is", null)
    .gte("retry_count", RANK_RETRY_EXHAUSTED_AT)
    .lt("next_check_at", cutoffIso)
    .or(`processing_until.is.null,processing_until.lte.${nowIso}`)
    .order("next_check_at", { ascending: true })
    .limit(RANK_REQUEUE_BATCH_LIMIT);
  if (error) throw error;

  let requeued = 0;
  let skipped = 0;
  for (const row of data || []) {
    if (!requeueEligible(row, { now })) { skipped += 1; continue; }
    // 조건부 UPDATE: 다른 실행이 먼저 재큐했으면 retry_count 가 이미 0 이라 0행이 갱신된다(멱등).
    // .or(processing_until …) 은 SELECT 이후 워커가 lease 를 잡은 경우를 막는다 — 이 가드가
    // 없으면 워커 완료 경로가 낡은 행으로 retry_count 를 되돌려 재큐가 무효화된다.
    // last_error 는 일부러 보존한다 — 원인 진단을 지우지 않고, 화면이 "자동 재시도 예정"을 구분하게 한다.
    // eslint-disable-next-line no-await-in-loop
    const { data: updated, error: updateError } = await ctx.supabaseAdmin
      .from(table)
      .update({
        next_check_at: nowIso,
        retry_count: 0,
        last_message: RANK_AUTO_REQUEUE_MESSAGE,
      })
      .eq("id", row.id)
      .eq("status", "active")
      .gte("retry_count", RANK_RETRY_EXHAUSTED_AT)
      .or(`processing_until.is.null,processing_until.lte.${nowIso}`)
      .select("id");
    if (updateError) throw updateError;
    if (updated && updated.length) requeued += 1; else skipped += 1;
  }
  return { table, scanned: (data || []).length, requeued, skipped };
}

export async function runRankRequeuePass(ctx, table, options = {}) {
  if (table !== "naver_place_rank_trackers") {
    // 상품 테이블은 위 주석의 세 가지 측정 근거로 영구 제외한다. 잘못 배선되어도
    // 아무 행도 건드리지 않도록 여기서 fail-closed 한다.
    return { table, scanned: 0, requeued: 0, skipped: 0, unsupported: true };
  }
  const now = Number(options.now || Date.now());
  const nextAllowedAt = passMemo.get(table) || 0;
  if (!options.force && nextAllowedAt > now) {
    return { table, scanned: 0, requeued: 0, skipped: 0, throttled: true };
  }
  passMemo.set(table, now + RANK_REQUEUE_MIN_INTERVAL_MS);
  try {
    const result = await requeuePass(ctx, table, { now });
    if (result.requeued) {
      console.log(`mi-rank-requeue table=${result.table} scanned=${result.scanned} requeued=${result.requeued} skipped=${result.skipped}`);
    }
    return result;
  } catch (error) {
    // 재큐 실패가 순위 갱신 크론을 절대 죽이지 않는다.
    console.warn(`mi-rank-requeue-failed table=${table} message=${error?.message || "unknown"}`);
    return { table, scanned: 0, requeued: 0, skipped: 0, failed: true };
  }
}

export function runPlaceRequeuePass(ctx, options = {}) {
  return runRankRequeuePass(ctx, "naver_place_rank_trackers", options);
}

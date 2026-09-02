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
//
// ── 만성 실패 격리(chronic failure isolation) ──────────────────────────────
// 3일 이상 끊김 없이 실패해 온 active 추적기를 빠른 수집 주기에서 잠시 빼내고
// (주차) 자동 재큐 대상에서도 제외한다. 목적은 두 가지다: 구조적으로 못 고치는
// 키워드가 5~360분마다 네이버를 두드리는 것을 멈추는 것, 그리고 광고주 화면에
// "지금 점검 중"이라는 사실을 한 줄로 알리는 것.
// (d) 새 status 값을 만들지 않는다. naver_rank_trackers.status 와
//     naver_place_rank_trackers.status 는 Postgres ENUM
//     public.naver_rank_tracker_status = ('active','paused','completed','failed')
//     를 공유하는데, 저장소 어디에도 ALTER TYPE … ADD VALUE 가 없고 모든
//     마이그레이션이 begin;/commit; 안에서 돈다(같은 트랜잭션에서 추가한 ENUM 값은
//     그 트랜잭션 안에서 쓸 수 없다). 즉 'isolated' 같은 값은 구조적으로 불가능하다.
//     그래서 격리는 마이그레이션 0건으로, 판정 함수 + 기존 컬럼만으로 구현한다.
//     status 는 끝까지 'active' 다 — 격리는 상태 전이가 아니라 "다음 시각 밀기"다.
// (e) 연속 실패의 증거는 last_checked_at 이다. 이 컬럼은 "성공 전용 도장"이다:
//       - 상품 실패 기록기 mi_fail_naver_shopping_worker_claim
//         (supabase/migrations/20260801125959_naver_shopping_local_worker.sql:256-265)
//         은 next_check_at·last_message·last_error·retry_count 만 쓰고
//         last_checked_at 은 건드리지 않는다.
//       - 플레이스 실패 기록기 updateTrackerAfterFailure
//         (src/server/handlers/naver-place-rank-trackers.mjs:916-937) 도 동일하다.
//       - 반대로 성공 경로는 last_checked_at 을 찍고 retry_count 를 0 으로 되돌린다
//         (naver-place-rank-trackers.mjs:851,862).
//     따라서 (retry_count >= RANK_RETRY_EXHAUSTED_AT) AND (last_checked_at 이 N일 이상 과거)
//     는 "중간에 단 한 번도 성공이 끼지 않은, 최소 N일짜리 단일 실패 구간"의 증명이 된다.
//     한 번도 성공한 적 없는 추적기는 last_checked_at 이 null 이므로 created_at 을
//     앵커로 쓴다(생성 이후 줄곧 실패했다는 뜻이라 의미가 같다).
//     한계는 정직하게 적는다: 시도별 오류 이력 테이블이 없다. 그래서 "3일 내내 같은
//     오류 코드였다"까지는 증명할 수 없다. 증명되는 것은 딱 여기까지다 —
//     "끊기지 않은 3일 이상의 실패 구간이 있고, 그 구간의 현재 코드가 last_error 다".
//     격리 판정도 UI 문구도 그 이상을 주장하지 않는다.
// (f) 격리 자격선을 재큐·잔여 감사와 똑같이 RANK_RETRY_EXHAUSTED_AT 로 둔 것은 우연이
//     아니다. 세 화면이 같은 모집단을 보게 하려는 것이다 — 잔여 감사에 잡히는 행은
//     재큐 후보이거나 격리 후보 둘 중 하나이고(둘은 배타적, 아래 (g)), 다른 바를 쓰면
//     "감사에는 보이는데 어느 쪽도 처리하지 않는" 사각지대가 생긴다.
// (g) 격리된 행은 requeueEligible 이 false 로 잘라낸다. 재큐는 retry_count 를 0 으로
//     되돌려 백오프 사다리를 맨 앞(5분)으로 리셋하므로, 격리와 재큐를 동시에 허용하면
//     한쪽이 주차한 행을 다른 쪽이 곧바로 최단 간격으로 끌어와 격리가 무효가 된다.
// (h) 주차 컬럼은 레인마다 다르다. 상품은 worker_quarantined_until 이다 — durable
//     cycle 의 enqueue 술어(20260812060826:66-69)와 claim 술어(20260831014800:1038-1130)가
//     이미 "worker_quarantined_until is null or <= now" 를 존중하므로 JS 에서 미래 시각을
//     쓰는 것만으로 주차가 성립하고 RPC 를 고칠 필요가 없다. 상품의 next_check_at 은
//     durable cycle 소유라 절대 건드리지 않는다.
//     플레이스는 그 컬럼이 아예 없고, claim_due_naver_place_rank_tracker
//     (20260711173414:35-44)가 status='active' AND next_check_at <= now() 로 고르므로
//     next_check_at 을 미래로 미는 것이 곧 주차다.
//     여기에 함정이 하나 있다: runDuePlaceTrackers
//     (naver-place-rank-trackers.mjs:1958-2008)가 같은 술어로 remaining 을 세고 그 값이
//     drained 를, drained 가 naver-place-rank-cron.mjs:52-61 의 503 을 좌우한다. 격리된
//     행을 active + 과거 next_check_at 으로 두거나 루프 안에서 continue 로만 건너뛰면
//     remaining 이 영원히 0 이 되지 않아 크론이 계속 503 을 뱉는다. next_check_at 을
//     미래로 밀면 remaining 에서 자동으로 빠진다 — 주차를 status 변경이나 in-loop
//     continue 가 아니라 next_check_at 으로 해야 하는 이유가 정확히 이것이다.
// (i) 주차는 24시간이고 절대 영구가 아니다. 원인이 고쳐지면 다음 날 시도가 성공하고,
//     성공 경로가 last_checked_at 을 찍고 retry_count 를 0 으로 되돌리는 순간 격리
//     판정이 스스로 거짓이 된다 — 사람이 풀어 줄 필요가 없다.
// (i-2) 재주차는 "만료 이후 실제로 시도했다"는 흔적이 있을 때만 한다(F1/F8). 막 만료된
//     행을 "parkedUntil <= now" 만 보고 다시 24시간 밀면 주차가 사실상 영구가 된다:
//     플레이스는 같은 크론 요청 안에서 이 패스가 claim(runDuePlaceTrackers) 보다 먼저
//     돌아 만료 직후의 claim 이 영영 오지 못하고, 상품은 durable cycle 커서가 만료 후
//     한 시간 안에 닿지 못하면 매일 같은 일이 반복된다. 흔적은 claim 경로가 찍는 도장이다:
//       - 상품: worker_last_cycle_claimed_at (20260812060826:21). durable cycle 의 일반
//         claim(p_probe_tracker_id null) 이 v_now 를 찍고(20260831014800:1268), 계정 우선
//         claim 도 찍는다(20260831033617:850). 만료 시각(worker_quarantined_until) 이후의
//         도장이 있어야 재주차한다. probe claim 은 도장을 보존하므로 흔적으로 세지 않는다
//         — 모르면 재주차하지 않는 쪽(fail-open)이다.
//       - 플레이스: last_attempt_at (20260711173414:58, claim 마다 now(); 수동 갱신·등록
//         경로도 같은 도장을 찍는다). 단 플레이스는 next_check_at 이 주차 컬럼이자 백오프
//         사다리 컬럼이라, 만료 후 시도가 실패하면 updateTrackerAfterFailure
//         (naver-place-rank-trackers.mjs:920-937)가 next_check_at 을 "시도 + 최대 360분"
//         으로 덮어써 주차 시각 자체가 사라진다. 그래서 비교 기준을 만료 시각이 아니라
//         주차 시작 시각(next_check_at - RANK_CHRONIC_PARK_MS)으로 둔다. 순수 주차 행은
//         시도가 주차 시작보다 앞서고(claim 술어가 next_check_at <= now() 라 주차 중
//         claim 이 불가능), 사다리 행은 시도가 항상 그 뒤다(사다리 최댓값 360분 < 24시간).
//         즉 이 판정은 플레이스에서 "만료 이후 시도" 와 정확히 같다.
//     처음 격리(주차 컬럼이 비어 있음)는 흔적과 무관하게 기존대로 주차한다. 도장이 null
//     이거나 파싱되지 않으면 증거가 없는 것이므로 재주차하지 않는다((e) 와 같은 자세).

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

// 만성 실패로 보는 최소 연속 실패 기간. "3일" 하나만 여기서 정하고 ms 는 유도한다
// (곱셈 결과를 따로 하드코딩하면 둘이 조용히 어긋난다).
export const RANK_CHRONIC_ISOLATION_DAYS = 3;
export const RANK_CHRONIC_ISOLATION_MS = RANK_CHRONIC_ISOLATION_DAYS * 24 * 60 * 60 * 1000;
// 격리된 추적기를 한 번에 얼마나 미래로 미는가. 24시간 = 하루 한 번만 재시도한다는 뜻이다.
// 백오프 사다리의 5~360분 대신 이 값을 쓰므로 요청량이 하루 1회로 떨어지고, 그럼에도
// 영구 정지가 아니라서 원인이 고쳐지면 다음 시도에서 스스로 풀린다. 영구 주차는 금지다 —
// 사람이 손대야만 풀리는 상태를 만들지 않는다.
export const RANK_CHRONIC_PARK_MS = 24 * 60 * 60 * 1000;
export const RANK_CHRONIC_ISOLATION_MARKER = "수집 방식 점검 중";
// 광고주 화면(src/pages/client.html)에 그대로 렌더되는 문장이다. RANK_AUTO_REQUEUE_MESSAGE
// 와 같은 방식으로 표식을 접두사로 붙인다(화면이 접두사 일치로 배지를 판정한다).
// 날짜·연속 실패 일수·retry_count 같은 내부 텔레메트리는 절대 넣지 않는다.
export const RANK_CHRONIC_ISOLATION_MESSAGE = `${RANK_CHRONIC_ISOLATION_MARKER} · 순위 수집을 잠시 빠른 주기에서 제외하고 하루 한 번 다시 확인합니다.`;

// "며칠째 멈춘(stuck)" 상품 추적기 기준. 만성 격리(3일·retry_count>=8)보다 짧고 재시도
// 횟수를 보지 않는다 — 상품 레인은 격리 코드가 많아 retry_count 가 8 에 닿지 않은 채
// last_error 만 남기고 며칠씩 멈춘 행이 생기는데, 그 행은 잔존 감사(retry>=8)에도
// queueStalled(레인 전체 무수집)에도 잡히지 않았다(C2 결함 D). 정의:
//   status='active' AND last_error IS NOT NULL
//   AND coalesce(last_checked_at, created_at) < now - RANK_STUCK_TRACKER_MS
// 36시간 = 09:00 정시 슬롯 기준 "어제 슬롯도 오늘 슬롯도 놓쳤다" 를 뜻한다. 헬스 API·
// 잔존 감사·총관리자 카운터가 전부 이 값을 import 하므로 세 화면이 같은 행을 센다.
export const RANK_STUCK_TRACKER_HOURS = 36;
export const RANK_STUCK_TRACKER_MS = RANK_STUCK_TRACKER_HOURS * 60 * 60 * 1000;
// "한 번도 찾지 못한(neverFound)" 상품 추적기의 최소 확인 횟수. 정의:
//   status='active' AND check_count >= RANK_NEVER_FOUND_MIN_CHECKS AND found_count = 0
// naver-rank-trackers.mjs trackerPayload 의 neverFound(checkCount >= 3 && foundCount === 0)
// 와 같은 값이어야 한다(그 파일은 잠금이라 상수를 import 하지 않고 테스트가 소스로 대조한다).
export const RANK_NEVER_FOUND_MIN_CHECKS = 3;

// last_checked_at·created_at 을 함께 읽는다. 둘은 만성 실패 구간의 앵커라 격리 판정에
// 필수이고, requeueEligible 이 격리 후보를 잘라내려면 재큐 SELECT 에도 실려 있어야 한다
// (컬럼이 없으면 앵커가 파싱되지 않아 격리 판정이 항상 false 로 무력화된다).
// 두 컬럼은 상품·플레이스 테이블 모두에 존재한다
// (20260624003000_naver_rank_tracking.sql / 20260707000100_naver_place_rank_tracking.sql).
const BASE_COLUMNS = "id, status, last_error, retry_count, next_check_at, last_message, last_checked_at, created_at";
// 격리 패스가 읽는 최소 컬럼. 여기에 레인별 주차 컬럼과 시도 흔적 컬럼(위 (i-2)) 둘만 더 붙인다.
const CHRONIC_COLUMNS = "id, status, last_error, retry_count, last_checked_at, created_at";
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

// 만성 실패 격리 후보인가. 순수 함수 — DB 도 시계도 건드리지 않는다(now 는 주입).
// 판정 순서는 싼 것부터, 그리고 근거가 강한 것부터다:
//   1) active 가 아니면 애초에 수집 주기 밖이라 격리할 것이 없다.
//   2) last_error 가 비어 있으면 실패 구간이라는 증거 자체가 없다(공백만 있는 문자열도 배제).
//   3) retry_count 는 재큐·잔여 감사와 같은 바를 쓴다(위 (f)).
//   4) 실패 구간이 RANK_CHRONIC_ISOLATION_MS 이상 지속됐는가. 앵커는 성공 전용 도장인
//      last_checked_at, 없으면 created_at(한 번도 성공한 적 없는 추적기) 이다(위 (e)).
// 둘 다 파싱되지 않으면 false 다 — 증거가 없을 때 격리하지 않는다(fail-open).
// 격리는 광고주에게 보이는 조치라 "모르겠으면 건드리지 않는다" 쪽으로 기운다.
export function chronicIsolationCandidate(row, options = {}) {
  const now = Number(options.now || Date.now());
  const isolationMs = Number(options.isolationMs || RANK_CHRONIC_ISOLATION_MS);
  if (!row || row.status !== "active") return false;
  if (!String(row.last_error || "").trim()) return false;
  if (Number(row.retry_count || 0) < RANK_RETRY_EXHAUSTED_AT) return false;
  const checked = new Date(row.last_checked_at || 0).getTime();
  const anchor = Number.isFinite(checked) && checked > 0
    ? checked
    : new Date(row.created_at || 0).getTime();
  if (!Number.isFinite(anchor) || anchor <= 0) return false;
  return now - anchor >= isolationMs;
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
  // 기존 규칙은 하나도 건드리지 않고 마지막 연언지만 더한다: 만성 격리 후보는 재큐하지
  // 않는다. 재큐는 retry_count 를 0 으로 되돌려 백오프를 5분으로 리셋하므로, 격리한 행을
  // 다시 끌어오면 주차가 그 자리에서 무효가 된다(위 (g)). now 를 그대로 넘겨 두 판정이
  // 같은 시계를 쓰게 한다 — 서로 다른 Date.now() 를 쓰면 경계에서 둘 다 참이 될 수 있다.
  if (chronicIsolationCandidate(row, { now })) return false;
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

// 레인별 주차 컬럼(위 (h)). 상품은 durable cycle 이 이미 존중하는
// worker_quarantined_until, 플레이스는 claim 술어가 읽는 next_check_at 이다.
// 상대 레인의 컬럼은 절대 쓰지 않는다 — 상품의 next_check_at 은 durable cycle 소유이고,
// 플레이스 테이블에는 worker_quarantined_until 컬럼이 아예 없다(쓰면 400).
function chronicParkColumn(table) {
  return table === "naver_rank_trackers" ? "worker_quarantined_until" : "next_check_at";
}

// 레인별 시도 흔적 컬럼(위 (i-2)). claim 경로가 찍는 도장으로, 주차 만료 이후 실제 시도가
// 있었는지를 가른다. 상대 레인의 컬럼은 SELECT 에도 싣지 않는다(없는 컬럼은 400).
function chronicAttemptColumn(table) {
  return table === "naver_rank_trackers" ? "worker_last_cycle_claimed_at" : "last_attempt_at";
}

// 만료된 주차 이후에 시도 흔적이 있는가(위 (i-2)). 도장이 없거나 파싱되지 않으면 false —
// 증거가 없으면 재주차하지 않는다. 순수 함수이며 parkedUntil 은 호출자가 파싱해 넘긴다.
function attemptedSincePark(table, row, parkedUntil) {
  const stamp = row[chronicAttemptColumn(table)];
  if (!stamp) return false;
  const attemptedAt = new Date(stamp).getTime();
  if (!Number.isFinite(attemptedAt) || attemptedAt <= 0) return false;
  // 상품은 만료 시각 이후의 claim, 플레이스는 주차 시작 시각 이후의 claim 이다(사유는 (i-2)).
  const threshold = table === "naver_rank_trackers" ? parkedUntil : parkedUntil - RANK_CHRONIC_PARK_MS;
  return attemptedAt >= threshold;
}

async function chronicIsolationPass(ctx, table, options = {}) {
  const now = Number(options.now || Date.now());
  const isolationMs = Number(options.isolationMs || RANK_CHRONIC_ISOLATION_MS);
  const parkColumn = chronicParkColumn(table);
  const attemptColumn = chronicAttemptColumn(table);
  const parkIso = new Date(now + RANK_CHRONIC_PARK_MS).toISOString();

  // DB 로 밀 수 있는 술어는 다 민다(status·last_error·retry_count). 기간 조건은 앵커가
  // last_checked_at 또는 created_at 으로 갈리는 OR 라 JS 에서 판정한다.
  // limit 로 스캔을 묶어 패스 한 번의 비용을 재큐 패스와 같은 수준으로 유지한다.
  // 주차 컬럼 오름차순이라 이미 만료됐거나(=주차 안 된) 행이 먼저 온다 — 배치 한도
  // 안에서 실제로 손댈 수 있는 행이 우선 잡힌다.
  const { data, error } = await ctx.supabaseAdmin
    .from(table)
    .select(`${CHRONIC_COLUMNS}, ${parkColumn}, ${attemptColumn}`)
    .eq("status", "active")
    .not("last_error", "is", null)
    .gte("retry_count", RANK_RETRY_EXHAUSTED_AT)
    .order(parkColumn, { ascending: true, nullsFirst: true })
    .limit(RANK_REQUEUE_BATCH_LIMIT);
  if (error) throw error;

  let isolated = 0;
  let skipped = 0;
  for (const row of data || []) {
    if (!chronicIsolationCandidate(row, { now, isolationMs })) { skipped += 1; continue; }
    // 이미 주차된 행은 건너뛴다 — 멱등성 확보이자 last_message 를 매시간 다시 쓰지 않기 위함.
    // 기준은 "주차가 조금이라도 남아 있으면 건너뛴다"이다. 남은 주차의 일부(예: 90%)만
    // 남았을 때 다시 밀면 영구 주차가 된다: 주차가 만료되기 전에 매번 24시간을 새로
    // 얹으므로 그 행은 영영 due 가 되지 않는다. 상품 레인은 실패 RPC 자체가 24시간
    // 격리를 걸어(retry_count >= 2) 항상 그 상태이므로 이 함정이 특히 잘 걸린다.
    // 반대로 이 기준이면 한 번 주차한 행은 창이 끝날 때까지 손대지 않으므로 반드시
    // 다시 due 가 된다(위 (i)).
    const parkedUntil = new Date(row[parkColumn] || 0).getTime();
    const parked = Number.isFinite(parkedUntil) && parkedUntil > 0;
    if (parked && parkedUntil > now) { skipped += 1; continue; }
    // 주차가 만료됐어도 만료 이후 시도 흔적이 없으면 재주차하지 않는다(F1/F8, 위 (i-2)).
    // 여기서 24시간을 다시 얹으면 플레이스는 같은 요청의 claim 이, 상품은 durable cycle 이
    // 이 행에 영영 닿지 못한다(크론 순서는 격리 → 재큐 → claim 으로 고정이라 순서로는
    // 풀 수 없다). 흔적이 있으면(=시도했는데 또 실패) 기존대로 재주차하고, 처음 격리
    // (주차 컬럼 비어 있음)는 흔적과 무관하게 주차한다.
    if (parked && !attemptedSincePark(table, row, parkedUntil)) { skipped += 1; continue; }

    // 레인별로 건드리는 컬럼을 문자열이 아니라 객체로 못박는다(엉뚱한 레인의 컬럼을
    // 쓰는 사고를 구조적으로 막는다). last_error 는 보존한다 — 원인 진단을 지우지 않는다.
    // retry_count 도 건드리지 않는다 — 0 으로 되돌리면 백오프가 5분으로 붕괴하고,
    // 격리·재큐·잔여 감사가 보던 같은 모집단이 한꺼번에 흐트러진다.
    const patch = table === "naver_rank_trackers"
      ? { worker_quarantined_until: parkIso, last_message: RANK_CHRONIC_ISOLATION_MESSAGE }
      : { next_check_at: parkIso, last_message: RANK_CHRONIC_ISOLATION_MESSAGE };

    // 조건부 UPDATE. SELECT 와 UPDATE 사이에 수집이 성공하면 성공 경로가 retry_count 를
    // 0 으로 되돌리므로 .gte 가 걸려 0행이 갱신된다 — 방금 회복된 추적기를 격리 문구로
    // 덮어쓰는 사고가 구조적으로 불가능하다. status 재확인도 같은 이유다(일시정지/완료로
    // 옮겨간 행을 되살리지 않는다).
    // eslint-disable-next-line no-await-in-loop
    const { data: updated, error: updateError } = await ctx.supabaseAdmin
      .from(table)
      .update(patch)
      .eq("id", row.id)
      .eq("status", "active")
      .gte("retry_count", RANK_RETRY_EXHAUSTED_AT)
      .select("id");
    if (updateError) throw updateError;
    if (updated && updated.length) isolated += 1; else skipped += 1;
  }
  return { table, scanned: (data || []).length, isolated, skipped };
}

// 재큐와 달리 두 레인 모두 지원한다. 재큐가 상품에서 무효/유해한 것과 달리(맨 위 근거)
// 격리는 각 레인이 이미 존중하는 주차 컬럼을 쓰므로 양쪽에서 그대로 성립한다.
export async function runChronicIsolationPass(ctx, table, options = {}) {
  if (table !== "naver_rank_trackers" && table !== "naver_place_rank_trackers") {
    // 잘못 배선되어도 아무 행도 건드리지 않도록 fail-closed 한다.
    return { table, scanned: 0, isolated: 0, skipped: 0, unsupported: true };
  }
  const now = Number(options.now || Date.now());
  // passMemo 는 테이블 이름으로 키를 잡아 이미 재큐 패스가 쓰고 있다. 접두사로 키를
  // 분리하지 않으면 두 패스가 서로를 스로틀해 한쪽이 조용히 굶는다.
  const memoKey = `chronic:${table}`;
  const nextAllowedAt = passMemo.get(memoKey) || 0;
  if (!options.force && nextAllowedAt > now) {
    return { table, scanned: 0, isolated: 0, skipped: 0, throttled: true };
  }
  passMemo.set(memoKey, now + RANK_REQUEUE_MIN_INTERVAL_MS);
  try {
    const result = await chronicIsolationPass(ctx, table, { now, isolationMs: options.isolationMs });
    if (result.isolated) {
      console.log(`mi-rank-chronic table=${result.table} scanned=${result.scanned} isolated=${result.isolated} skipped=${result.skipped}`);
    }
    return result;
  } catch (error) {
    // 격리 실패가 순위 갱신 크론을 절대 죽이지 않는다(재큐 패스와 같은 자세).
    console.warn(`mi-rank-chronic-failed table=${table} message=${error?.message || "unknown"}`);
    return { table, scanned: 0, isolated: 0, skipped: 0, failed: true };
  }
}

// ── 상품 레인 자동 재검증(auto repair) ─────────────────────────────────────
// 상품 추적기는 실패가 거듭되면 worker_quarantined_until 로 주차될 뿐 스스로 재검증되지
// 않았다(C3 결함 F). 운영자가 수동 SQL 로 mi_enqueue_naver_shopping_repair_priority 를
// 부르는 것이 유일한 복구 경로였다. 이 패스는 그 RPC 를 하루 한 번 자동으로 부른다.
// 설계 원칙:
//   (j) 추적기 행을 직접 쓰지 않는다. next_check_at·retry_count·worker_quarantined_until 은
//       durable cycle 소유이므로(맨 위 근거 1~3) 여기서는 오직 "repair 큐에 넣기"만 한다.
//       큐 소비·lease·계정우선 게이트는 기존 RPC 와 워커가 그대로 담당한다.
//   (k) 새 테이블·마이그레이션 없음. "하루 1회" 판정은 requests 표의 requested_at
//       (reason='auto_repair') 으로 한다 — 그 표는 RPC 가 이미 쓰고 service_role 이 select
//       할 수 있다(20260813063518:76-79). 인스턴스 메모리는 서버리스라 신뢰하지 않는다.
//   (l) 모집단은 만성 격리와 배타적이다: retry_count < RANK_RETRY_EXHAUSTED_AT(8) 만 고른다.
//       8 이상은 격리 담당이고, 격리 표식(RANK_CHRONIC_ISOLATION_MARKER 접두사 last_message)
//       이 붙은 행도 제외한다 — 격리가 주차한 행을 재검증이 되살리면 격리가 무효가 된다.
//   (m) 정체 기준은 stuck 과 같은 36시간(RANK_STUCK_TRACKER_MS)·같은 앵커(last_checked_at,
//       없으면 created_at)·같은 방향(lt) 이다. 헬스 API·잔존 감사가 세는 stuck 행 중
//       retry_count 가 8 미만인 것이 정확히 이 패스의 후보다.
//   (n) 최근 24시간 안에 repair 큐에 있었던 추적기(지금 queued · consumed_at 이 24h 안 ·
//       24h 안의 요청에 속함)는 다시 넣지 않는다. 방금 소비된 항목을 또 넣으면 큐가 같은
//       키워드로 돌고, 지금 queued 인 항목을 넣으면 RPC 가 배치 전체를 거절한다.
//   (o) 절대 던지지 않는다. RPC 거절(계정우선 게이트·already_queued·기타)·읽기 실패·네트워크
//       오류는 전부 결과 객체와 로그로만 남긴다. 게이트에 막히면 이번 틱은 건너뛴다.
export const RANK_AUTO_REPAIR_RPC = "mi_enqueue_naver_shopping_repair_priority";
export const RANK_AUTO_REPAIR_REASON = "auto_repair";
// RPC 의 tracker_count 제약(between 1 and 10)과 같다.
export const RANK_AUTO_REPAIR_BATCH_LIMIT = 10;
// 하루 1회 게이트이자 24h 중복 제외 창. 하나만 정하고 둘 다 여기서 쓴다.
export const RANK_AUTO_REPAIR_INTERVAL_MS = 24 * 60 * 60 * 1000;
// 후보 스캔 상한. 24h 중복 제외로 일부가 빠져도 배치 10건을 채울 여유를 둔다.
const RANK_AUTO_REPAIR_SCAN_LIMIT = 40;
const RANK_AUTO_REPAIR_RECENT_REQUEST_LIMIT = 200;
const AUTO_REPAIR_REQUESTS_TABLE = "naver_shopping_repair_priority_requests";
const AUTO_REPAIR_ITEMS_TABLE = "naver_shopping_repair_priority_items";
const AUTO_REPAIR_COLUMNS = "id, status, last_error, retry_count, last_checked_at, created_at, last_message, worker_quarantined_until";

function generatedRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  // Node 19+ 는 항상 위 경로다. 폴백은 v4 형식을 흉내 내되 RPC 가 uuid 로 받으므로 형식만 지킨다.
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

// 자동 재검증 후보인가. 순수 함수 — DB 도 시계도 건드리지 않는다(now 는 주입).
// 판정 순서는 싼 것부터: active → last_error → retry_count → 격리 표식 → 정체 기간.
export function productAutoRepairCandidate(row, options = {}) {
  const now = Number(options.now || Date.now());
  const stuckMs = Number(options.stuckMs || RANK_STUCK_TRACKER_MS);
  if (!row || row.status !== "active") return false;
  if (!String(row.last_error || "").trim()) return false;
  if (Number(row.retry_count || 0) >= RANK_RETRY_EXHAUSTED_AT) return false;
  if (String(row.last_message || "").indexOf(RANK_CHRONIC_ISOLATION_MARKER) === 0) return false;
  const checked = new Date(row.last_checked_at || 0).getTime();
  const anchor = Number.isFinite(checked) && checked > 0
    ? checked
    : new Date(row.created_at || 0).getTime();
  if (!Number.isFinite(anchor) || anchor <= 0) return false;
  // SQL 의 coalesce(last_checked_at, created_at) < now - 36h 와 같은 strict 방향이다.
  return now - anchor > stuckMs;
}

function autoRepairResult(extra = {}) {
  return {
    table: "naver_rank_trackers",
    scanned: 0,
    candidates: 0,
    recentlyQueued: 0,
    selected: 0,
    enqueued: 0,
    accepted: false,
    blockedByAccountPriority: false,
    alreadyQueued: false,
    ranToday: false,
    ...extra,
  };
}

async function productAutoRepairPass(ctx, options = {}) {
  const now = Number(options.now || Date.now());
  const batchLimit = Math.max(1, Math.min(RANK_AUTO_REPAIR_BATCH_LIMIT, Number(options.batchLimit || RANK_AUTO_REPAIR_BATCH_LIMIT)));
  const dayCutoffIso = new Date(now - RANK_AUTO_REPAIR_INTERVAL_MS).toISOString();
  const stuckCutoffIso = new Date(now - RANK_STUCK_TRACKER_MS).toISOString();
  const admin = ctx.supabaseAdmin;

  // 1) 최근 24h 의 repair 요청. 하루 1회 게이트(reason=auto_repair)와 24h 중복 제외(모든
  //    reason)를 한 번의 읽기로 같이 얻는다.
  const { data: recentRequests, error: requestsError } = await admin
    .from(AUTO_REPAIR_REQUESTS_TABLE)
    .select("request_id, reason, requested_at")
    .gte("requested_at", dayCutoffIso)
    .order("requested_at", { ascending: false })
    .limit(RANK_AUTO_REPAIR_RECENT_REQUEST_LIMIT);
  if (requestsError) throw requestsError;
  const dayCutoff = now - RANK_AUTO_REPAIR_INTERVAL_MS;
  const recentAuto = (recentRequests || []).find((request) => {
    if (String(request?.reason || "") !== RANK_AUTO_REPAIR_REASON) return false;
    const at = new Date(request?.requested_at || 0).getTime();
    return Number.isFinite(at) && at >= dayCutoff;
  });
  if (recentAuto) {
    return autoRepairResult({ ranToday: true, lastRequestedAt: recentAuto.requested_at });
  }

  // 2) 후보 SELECT. DB 로 밀 수 있는 술어는 다 밀고(status·last_error·retry_count·36h 컷오프),
  //    격리 표식 같은 문자열 판정은 JS 순수 함수가 다시 거른다. 가장 오래 정체된 행부터.
  const { data: rows, error: rowsError } = await admin
    .from("naver_rank_trackers")
    .select(AUTO_REPAIR_COLUMNS)
    .eq("status", "active")
    .not("last_error", "is", null)
    .lt("retry_count", RANK_RETRY_EXHAUSTED_AT)
    .or(`last_checked_at.lt.${stuckCutoffIso},and(last_checked_at.is.null,created_at.lt.${stuckCutoffIso})`)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(RANK_AUTO_REPAIR_SCAN_LIMIT);
  if (rowsError) throw rowsError;
  const scanned = (rows || []).length;
  const candidates = (rows || []).filter((row) => productAutoRepairCandidate(row, { now }));
  if (!candidates.length) {
    return autoRepairResult({ scanned, candidates: 0 });
  }

  // 3) 24h 중복 제외. 후보 id 로 한정해 세 갈래(queued · consumed_at · 최근 요청 소속)를 DB 로 민다.
  const candidateIds = candidates.map((row) => row.id);
  const recentRequestIds = (recentRequests || [])
    .map((request) => String(request?.request_id || ""))
    .filter(Boolean);
  const orBranches = [`state.eq.queued`, `consumed_at.gte.${dayCutoffIso}`];
  if (recentRequestIds.length) orBranches.push(`request_id.in.(${recentRequestIds.join(",")})`);
  const { data: recentItems, error: itemsError } = await admin
    .from(AUTO_REPAIR_ITEMS_TABLE)
    .select("tracker_id, state, consumed_at, request_id")
    .in("tracker_id", candidateIds)
    .or(orBranches.join(","));
  if (itemsError) throw itemsError;
  // DB 술어와 같은 세 갈래를 JS 에서 다시 판정한다 — 후보 SELECT 와 같은 이중 판정 자세다.
  const recentRequestIdSet = new Set(recentRequestIds);
  const recentlyQueuedIds = new Set((recentItems || [])
    .filter((item) => {
      if (String(item?.state || "") === "queued") return true;
      const consumedAt = new Date(item?.consumed_at || 0).getTime();
      if (Number.isFinite(consumedAt) && consumedAt >= dayCutoff) return true;
      return recentRequestIdSet.has(String(item?.request_id || ""));
    })
    .map((item) => String(item?.tracker_id || "")));
  const eligible = candidates.filter((row) => !recentlyQueuedIds.has(String(row.id)));
  const selectedIds = eligible.slice(0, batchLimit).map((row) => row.id);
  const base = {
    scanned,
    candidates: candidates.length,
    recentlyQueued: candidates.length - eligible.length,
    selected: selectedIds.length,
  };
  if (!selectedIds.length) return autoRepairResult(base);

  // 4) 기존 RPC 호출. 실패·거절은 전부 결과로 접는다(위 (o)).
  const requestId = String(options.requestId || generatedRequestId());
  const { data, error } = await admin.rpc(RANK_AUTO_REPAIR_RPC, {
    p_request_id: requestId,
    p_tracker_ids: selectedIds,
    p_reason: RANK_AUTO_REPAIR_REASON,
  });
  if (error) {
    const message = String(error?.message || error || "unknown");
    if (message.includes("already_queued")) {
      return autoRepairResult({ ...base, requestId, alreadyQueued: true });
    }
    return autoRepairResult({ ...base, requestId, failed: true, error: message });
  }
  const accepted = data?.accepted === true;
  const blockedByAccountPriority = data?.blockedByAccountPriority === true;
  const queuedCount = Number(data?.queuedCount);
  const enqueued = accepted
    ? (Number.isFinite(queuedCount) && queuedCount >= 0 ? queuedCount : selectedIds.length)
    : 0;
  return autoRepairResult({
    ...base,
    requestId,
    accepted,
    blockedByAccountPriority,
    enqueued,
    idempotent: data?.idempotent === true,
  });
}

// 매 크론 틱에서 불러도 안전하다: 인스턴스 스로틀(5분) → DB 하루 1회 게이트 → 후보 →
// 24h 중복 제외 → RPC. 어느 단계에서도 던지지 않는다.
export async function runProductAutoRepairPass(ctx, options = {}) {
  const now = Number(options.now || Date.now());
  const memoKey = "autoRepair:naver_rank_trackers";
  const nextAllowedAt = passMemo.get(memoKey) || 0;
  if (!options.force && nextAllowedAt > now) {
    return autoRepairResult({ throttled: true });
  }
  passMemo.set(memoKey, now + RANK_REQUEUE_MIN_INTERVAL_MS);
  try {
    if (!ctx?.supabaseAdmin) throw new Error("supabaseAdmin unavailable");
    const result = await productAutoRepairPass(ctx, { ...options, now });
    if (result.selected || result.failed) {
      console.log(
        `mi-rank-auto-repair scanned=${result.scanned} candidates=${result.candidates} recentlyQueued=${result.recentlyQueued} selected=${result.selected} accepted=${result.accepted} blocked=${result.blockedByAccountPriority} alreadyQueued=${result.alreadyQueued} enqueued=${result.enqueued}${result.failed ? ` failed=true error=${result.error}` : ""}`,
      );
    }
    return result;
  } catch (error) {
    // 자동 재검증 실패가 순위 갱신 크론을 절대 죽이지 않는다(재큐·격리 패스와 같은 자세).
    const message = error?.message || String(error || "unknown");
    console.warn(`mi-rank-auto-repair-failed message=${message}`);
    return autoRepairResult({ failed: true, error: message });
  }
}

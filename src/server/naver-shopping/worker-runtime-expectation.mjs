// 윈도우 수집 작업기가 "살아 있는데 서버에 거부당하고 있는" 상태만 골라내는 순수 판정기.
// I/O 도 supabase 도 없다. 조회는 호출자가 하고 여기서는 두 신호로 판단만 한다.
//
// ── 왜 이 관측자가 따로 필요한가 (2026-09-01 17시간 중단의 재구성)
// 서버 게이트(src/server/handlers/naver-shopping-local-worker.mjs 의
// workerControlInput)는 runtimeVersion 이 기대값과 다르면 claim RPC 에 닿기 전에
// LOCAL_WORKER_RUNTIME_IDENTITY_INVALID(400) 으로 끊는다. 그래서 버전이 어긋난 순간
// naver_shopping_worker_coordination.primary_seen_at 은 그대로 얼어붙는다.
// 그런데 nonce 소비(consumeNonce)는 그 검사보다 먼저 실행되므로, 거부당하는 워커도
// public.naver_shopping_worker_nonces 에 매분 한 줄씩 계속 남긴다.
// 그리고 naver_shopping_worker_runs 는 진척이 stage='navigating' 에 닿아야 행이 생기므로
// 버전 불일치 구간에는 새 행이 아예 없고, 최신 행의 runtime_version 은 낡은 값에 멈춘다.
//
// 실측(2026-09-01T08:30Z 프로덕션 읽기 전용 조회): 최신 nonce 는 54초 전인데
// primary_seen_at 은 14.4시간 전이었다. "서명은 1분마다 살아 있는데 진척은 반나절째
// 멈춰 있다" — 이 동시 성립이 바로 낡은 작업기의 지문이다. 둘 중 하나만으로는
// 아무것도 단정할 수 없다.
//   서명만 본다  → 워커가 멀쩡히 일하는 정상 상태와 구분되지 않는다.
//   버전만 본다  → 아래에서 설명하는 "꺼진 워커"와 구분되지 않는다.
//
// Chrome 확장의 alarm 주기가 1분이라 nonce 신선도는 "작업기가 아직 켜져 있고 계속
// 시도 중"이라는 약 60초 해상도의 진짜 생존 신호다. 그래서 서명 창을 판정에 쓴다.

// 게이트 상수의 관측자 쪽 사본. 원본(naver-shopping-local-worker.mjs)은 export 하지
// 않는다 — scripts/check-release-baseline.mjs 와 scripts/check-server-contract.mjs 가
// `const EXPECTED_WORKER_RUNTIME_VERSION = "1.1.32";` 문자열을 그대로 검사하기 때문에
// export 키워드를 붙이는 순간 두 릴리스 게이트가 깨진다. 사본이 낡는 위험은
// scripts/rank-collection-stability.test.mjs 의 드리프트 가드가 원본 소스를 정규식으로
// 파싱해 이 값과 대조하는 방식으로 막는다.
export const EXPECTED_WORKER_RUNTIME_VERSION = "1.1.32";

// 서명이 이 창 안에 들어와 있어야 "아직 켜진 채 거부당하는 중"이라고 본다.
// 30분 = HYBRID_WORKER_SILENCE_MINUTES(naver-rank-cron.mjs) 와 같은 길이로 맞춘다.
// 두 관측이 같은 시간 축을 쓰지 않으면 한쪽은 침묵, 다른 쪽은 낡음이라고 동시에
// 보고하는 구간이 생긴다. alarm 주기 1분 대비 30배 여유라 확장 재시작·절전 복귀
// 같은 정상 흔들림은 흡수한다.
export const WORKER_OUTDATED_SIGNING_WINDOW_MS = 1_800_000;

// heartbeatAgeMinutes 를 "낡았다"고 읽기 시작하는 기준선. 헬스 응답의 heartbeatAgeMinutes 를
// 읽는 쪽(워치독 HEARTBEAT_FRESH_MINUTES, 관리자 화면 RANK_HEARTBEAT_STALE_MINUTES)이 같은
// 값을 쓴다 — 서로 다른 신선 기준을 쓰면 한쪽은 생존, 다른 쪽은 침묵이라고 동시에 보고하는
// 구간이 생기기 때문에 축은 이 상수 하나로 고정한다.
// 2026-09-03(F11)~2026-09-27 에는 아래 커밋 정체 판정의 "하트비트 신선" 조건에도 썼지만,
// 그 조건은 2026-09-27 사고로 뺐다(workerCommitStalledFromSignals 주석 참고).
export const WORKER_HEARTBEAT_STALE_MINUTES = 15;

// "커밋이 없다"를 정체로 읽기 시작하는 커밋 나이(분). 이 값 "이상"이면 정체다(분 내림이라
// 마지막 커밋 뒤 정확히 45분 00초부터 참, 44분 59.999초까지는 거짓). 2026-09-27 대표 승인으로
// "90분 초과" → "45분 이상". 실측(tracker_committed = last_success_at 기준 14일 커밋 공백):
// 45분을 넘은 11건은 전부 실제 정지(최소 69.3분)였고, 정상 가동 중 최대 공백은 38.2분이었다.
// 90분일 때는 2026-09-27 의 70분 공백(19:24:28~20:34:48 KST)이 경보 없이 지나갔다.
// 슬롯 직후의 정상 무커밋 구간은 크론 쪽 유예(HYBRID_WORKER_GRACE_MINUTES=60)가 따로 막는다.
export const WORKER_COMMIT_STALL_MINUTES = 45;

const RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

function parsedVersion(value) {
  const normalized = String(value ?? "").trim();
  return RUNTIME_VERSION_PATTERN.test(normalized) ? normalized : "";
}

function parsedInstant(value) {
  const parsed = Date.parse(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// 입력 { lastRunRuntimeVersion, lastSignatureAt, now, expectedRuntimeVersion } → boolean.
// true 는 "작업기가 아직 매분 서명하고 있는데, 마지막으로 서버가 받아 준 실행 기록이
// 기대 버전보다 낮다"는 한 가지 상태만 뜻한다.
//
// 거짓으로 물러나는 세 자리를 특히 조심해서 읽어야 한다.
//  (1) 실행 이력이 없거나 버전 문자열이 파싱되지 않으면 false.
//      새로 만든 배포·비어 있는 표에서 "낡았다"고 단정할 근거가 0이다.
//  (2) 버전이 기대값과 같으면 false. 여기서 끝나는 것이 정상 경로다.
//  (3) 서명이 없거나 창(WORKER_OUTDATED_SIGNING_WINDOW_MS)을 벗어나면 false.
//      ← 이 조건이 이 함수의 존재 이유이자 가장 자주 오해받는 자리다.
//      그냥 꺼 둔 작업기(대표님이 맥/윈도우를 껐다)와, 서버만 먼저 배포되고 작업기가
//      아직 한 번도 뜨지 않은 구간은 "낡은 작업기"가 아니다. 두 경우 모두 최신 실행
//      기록은 낡은 버전에 멈춰 있으므로 버전만 보면 영원히 true 가 되어, 대표님이
//      의도적으로 꺼 둔 밤 시간 내내 "수집기를 업데이트하라"는 거짓 지시가 뜬다.
//      서명이 끊긴 상태는 낡음이 아니라 침묵이고, 침묵은 이미 다른 관측자가 본다.
//      "매분 서명은 하는데 받아들여지지 않는다"일 때만 낡음이다.
// 미래 시각 서명은 신선한 것으로 센다(작업기 시계가 앞선 경우까지 침묵으로 접지 않는다).
export function workerOutdatedFromSignals(input = {}) {
  const expected = parsedVersion(
    input.expectedRuntimeVersion === undefined || input.expectedRuntimeVersion === null
      ? EXPECTED_WORKER_RUNTIME_VERSION
      : input.expectedRuntimeVersion,
  );
  // 기대값 자체를 읽지 못하면 비교 자체가 성립하지 않는다. 단정하지 않는다.
  if (!expected) return false;
  const observed = parsedVersion(input.lastRunRuntimeVersion);
  if (!observed) return false;
  if (observed === expected) return false;

  const signedAt = parsedInstant(input.lastSignatureAt);
  if (signedAt === null) return false;
  const now = Number(input.now ?? Date.now());
  if (!Number.isFinite(now)) return false;
  return now - signedAt <= WORKER_OUTDATED_SIGNING_WINDOW_MS;
}

// 입력 { primarySeenAt, lastSuccessAt, now } → 0 이상의 정수 분.
// 두 표식 중 "더 최신"을 기준으로 잰다. 둘은 같은 계통의 서로 다른 진척 표식이라
// (레인 확보 / 수집 성공) 오래된 쪽을 쓰면 한창 수집 중인 워커가 늙어 보인다.
//
// 아무것도 파싱되지 않을 때 0 을 내는 것이 이 함수의 안전 방향이다. 같은 파일의
// stalledMinutes(src/server/handlers/rank-collection-health.mjs:73)도 "데이터 없음"을
// 0 으로 접는다. 읽을 수 없는 상태를 큰 숫자로 부풀리면 판독 실패가 곧바로 최고 등급
// 경보가 되어, 스키마 드리프트나 권한 문제 한 번에 워치독이 Chrome 을 재기동한다.
// 판독 불가는 사고가 아니다 — 사고는 "읽었는데 낡았다"일 때만 성립한다.
// 미래 시각(작업기 시계 앞섬)은 음수 대신 0 으로 눌러 계약(비음수 정수)을 지킨다.
export function heartbeatAgeMinutes(input = {}) {
  const stamps = [input.primarySeenAt, input.lastSuccessAt]
    .map((value) => parsedInstant(value))
    .filter((value) => value !== null);
  if (!stamps.length) return 0;
  const now = Number(input.now ?? Date.now());
  if (!Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - Math.max(...stamps)) / 60_000));
}

// 입력 { lastSuccessAt, now } → 커밋 나이(비음수 정수 분) 또는 null.
// heartbeatAgeMinutes 와 달리 "판독 불가"를 0 이 아니라 null 로 낸다 — 이 값의 소비자
// (commitStalled, lastCommitAgeMinutes)에게 0 은 "방금 커밋했다"는 정반대 단정이기
// 때문이다. null 은 아래 판정기에서 자연히 "단정하지 않음"으로 접힌다(fail-safe).
// 미래 시각(작업기 시계 앞섬)은 음수 대신 0 으로 눌러 비음수 계약을 지킨다.
export function commitAgeMinutes(input = {}) {
  const committedAt = parsedInstant(input.lastSuccessAt);
  if (committedAt === null) return null;
  const now = Number(input.now ?? Date.now());
  if (!Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - committedAt) / 60_000));
}

// 입력 { lastSuccessAt, now } → boolean. primarySeenAt 을 함께 넘겨도 판정에 쓰지 않는다
// (2026-09-27 이전 호출 모양 호환).
// true 는 "마지막 수집 성공(코디네이션 last_success_at)이 WORKER_COMMIT_STALL_MINUTES 분
// 이상 없다"는 한 가지 상태만 뜻한다. 어느 작업기(주작업기·대기기)가 살아 있는지와 무관하다 —
// 대기기의 성공도 같은 last_success_at 을 갱신하므로, 주작업기를 꺼 두고 대기기가 수집하는
// 동안에는 거짓이다.
// 처음(2026-09-03 F11 게이트 장애: 트래커 격리 코드로 전 키워드 실패, 레인은 매분 claim·
// 커밋 0·2시간)에는 "하트비트(primary_seen_at·last_success_at 중 최신) 15분 안쪽"을 AND 로
// 걸었다. 하트비트가 낡은 경우는 침묵 축이 본다는 전제였지만, 헬스 API 의 ok 에는 침묵 축이
// 없다(heartbeatAgeMinutes 는 숫자로만 싣는다). 그래서 2026-09-27 에는
//   · 데스크탑 주작업기 전원 꺼짐 — 마지막 요청 19:32:38, 복귀 20:21:54,
//   · 맥 대기기는 레인을 잡았지만 수집 창이 없어 매번 곧바로 실패(대기기 claim 은
//     primary_seen_at 을 갱신하지 않는다),
//   · 커밋 70분 공백(19:24:28.823~20:34:48.822 KST)
// 이 겹쳐 헬스가 끝까지 ok:true 였다(queueStalled 는 6시간 축이라 못 본다).
// 거짓으로 물러나는 자리: 커밋 기록이 없거나 파싱되지 않으면(최초 배치 등) 단정하지 않는다.
// 활성 상품 추적기 0건 · 의도된 정지(쿨다운·manual_stop·manual_canary) · 수동복구 대기의
// 억제는 호출자(rank-collection-health.mjs)가 건다. 크론(naver-rank-cron.mjs)은 진척이 active
// 일 때만 이 판정을 부르므로 "진척 없음"은 계속 SILENT 가 먼저 받는다.
export function workerCommitStalledFromSignals(input = {}) {
  const commitAge = commitAgeMinutes({ lastSuccessAt: input.lastSuccessAt, now: input.now });
  return commitAge !== null && commitAge >= WORKER_COMMIT_STALL_MINUTES;
}

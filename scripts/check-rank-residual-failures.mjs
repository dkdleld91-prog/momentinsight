// 재시도가 소진된 채 남아 있는 순위 추적기(잔존 실패)를 하루 1회 세어 0건이 아니면
// 실패로 보고한다.
//
// 왜 별도 감시가 필요한가: 상품 레인의 실패 코드 다수는 격리 코드라 다른 키워드 수집을
// 막지 않는다. 그래서 last_checked_at 이 계속 갱신되고, /api/rank-collection-health 의
// 정체 감지(queueStalled)에는 영원히 걸리지 않는다 — 완전한 관측 사각지대다.
// 또한 상품 테이블은 자동 재큐(src/server/naver-rank-requeue.mjs)에서 구조적으로
// 제외되어 있어(runRankRequeuePass 의 fail-closed 분기) 스스로 풀리지도 않는다.
//
// 판정 기준은 자동 재큐가 쓰는 것과 같은 컬럼·같은 임계값이다:
//   status = 'active' AND last_error IS NOT NULL AND retry_count >= RANK_RETRY_EXHAUSTED_AT
// 임계값은 하드코딩하지 않고 서버 상수를 그대로 가져온다(상수가 바뀌면 같이 움직인다).
//
// 두 번째 숫자(isolatedCount)에 대하여: 위 잔존 조건에 "성공 기록이 끊긴 기간"까지
// 더한 만성 실패 격리 대상 수다.
//   ... AND (last_checked_at IS NULL OR last_checked_at < now - RANK_CHRONIC_ISOLATION_MS)
// last_checked_at 은 성공 시에만 찍히는 도장이라(실패 기록 경로는 건드리지 않는다)
// 연속 실패 기간의 기준점으로 쓸 수 있다. 따라서 isolated 는 residual 의 부분집합이며
// (격리 대상은 언제나 잔존 실패이기도 하다), 대표님 화면의 만성 실패 수치와 대조하기
// 위해서만 함께 보고한다. 합격/불합격 판정은 이전과 동일하게 residual 로만 정한다 —
// isolatedCount 는 종료 코드에 영향을 주지 않는다.
// 기간 상수 역시 하드코딩하지 않고 서버 상수를 그대로 가져와 격리 기준선과 어긋날 수
// 없게 한다.
//
// 세 번째·네 번째 숫자(stuckCount, neverFoundCount — 2026-09-02, C2 결함 D)에 대하여:
// 위 잔존 판정은 retry_count >= 8 만 세므로, 상품 레인에서 격리 코드로 며칠씩 멈춘 채
// retry_count 가 8 에 닿지 않은 추적기는 잡지 못했다(레인 전체는 돌아서 queueStalled
// 도 거짓이다). 상품 추적기(naver_rank_trackers)에 한해 두 집계를 더 센다.
//   stuck      = status='active' AND last_error IS NOT NULL
//                AND coalesce(last_checked_at, created_at) < now - RANK_STUCK_TRACKER_MS
//   neverFound = status='active' AND check_count >= RANK_NEVER_FOUND_MIN_CHECKS AND found_count = 0
// stuckCount > 0 이면 exit 1 이고 보고에 RANK_STUCK_TRACKERS_PRESENT 마커가 실린다
// (잔존 판정·코드·마커는 그대로다 — 두 축은 서로 독립이며 code 는 여전히 잔존만 말한다).
// neverFoundCount 는 보고만 하고 종료 코드에 영향을 주지 않는다. 임계값은 전부 서버
// 상수를 import 하므로 헬스 API(trackers)·총관리자 카운터와 같은 행을 센다.
//
// 다섯 번째 숫자(placePartialCount — 2026-09-03, F18)에 대하여: 플레이스 추적기의 partial
// 결과 경로(naver-place-rank-trackers.mjs updateTrackerAfterPartial)는 last_error 를 null 로
// 둔 채 retry_count 만 +1 한다. 그래서 partial 만 반복하는 추적기는 위 잔존(last_error IS
// NOT NULL)·stuck·격리 어느 집계에도 걸리지 않았다. 플레이스 추적기에 한해 한 집계를 더 센다.
//   placePartial = status='active' AND last_error IS NULL
//                  AND retry_count >= RANK_PLACE_PARTIAL_MIN_RETRIES
// 관측 전용이다: ok·code·stuckCode·마커 문자열·종료 코드에 전혀 손대지 않으므로
// placePartialCount 가 0 이 아니어도 exit 0 이고 보고는 그대로 stdout 으로 나간다.
// 이 질의가 실패하면 기존 Promise.all 규약대로 RANK_RESIDUAL_AUDIT_QUERY_FAILED 로 exit 1 이다
// (집계가 끝나지 않았으므로 어떤 숫자도 단정하지 않는다). 임계값은 서버 상수를 import 하므로
// 총관리자 카운터(placePartialTrackers)·헬스 API 와 같은 행을 센다.
//
// 읽기 전용이다. select 만 하고 limit=0 + Prefer: count=exact 로 개수만 받는다 —
// 추적기 id·키워드·상품번호 같은 계정 데이터를 로그에 남기지 않는다.
import fs from "node:fs";
import path from "node:path";

import {
  RANK_CHRONIC_ISOLATION_DAYS,
  RANK_CHRONIC_ISOLATION_MS,
  RANK_NEVER_FOUND_MIN_CHECKS,
  RANK_PLACE_PARTIAL_MIN_RETRIES,
  RANK_RETRY_EXHAUSTED_AT,
  RANK_STUCK_TRACKER_HOURS,
  RANK_STUCK_TRACKER_MS,
} from "../src/server/naver-rank-requeue.mjs";

const LANES = [
  { key: "product", table: "naver_rank_trackers" },
  { key: "place", table: "naver_place_rank_trackers" },
];
// stuck·neverFound 는 상품 레인에만 정의된다.
const PRODUCT_TABLE = LANES[0].table;
// placePartial 은 플레이스 레인에만 정의된다(partial 결과 경로가 그쪽에만 있다).
const PLACE_TABLE = LANES[1].table;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return acc;
      const index = trimmed.indexOf("=");
      if (index < 1) return acc;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      acc[key] = value;
      return acc;
    }, {});
}

const env = {
  ...loadEnvFile(path.join(process.cwd(), "06_Supabase_연동", ".env.local")),
  ...loadEnvFile(path.join(process.cwd(), ".env.local")),
  ...process.env,
};

const supabaseUrl = String(env.SUPABASE_URL || "").trim();
const serviceKey = String(env.SUPABASE_SECRET_KEY || "").trim();
const checkedAt = new Date().toISOString();
// 두 레인·모든 질의가 같은 시계를 쓰도록 컷오프를 한 번만 계산한다.
const chronicCutoffAt = new Date(Date.parse(checkedAt) - RANK_CHRONIC_ISOLATION_MS).toISOString();
const stuckCutoffAt = new Date(Date.parse(checkedAt) - RANK_STUCK_TRACKER_MS).toISOString();

function fail(code, message) {
  console.error(JSON.stringify({ ok: false, code, message, checkedAt }, null, 2));
  process.exit(1);
}

if (!supabaseUrl || !serviceKey) {
  fail(
    "RANK_RESIDUAL_AUDIT_DATABASE_MISSING",
    "SUPABASE_URL 과 SUPABASE_SECRET_KEY 가 필요합니다. 워크플로 시크릿을 등록하세요.",
  );
}

// active 추적기 개수만 세는 공통 헬퍼. filters 는 PostgREST 질의 파라미터 그대로다
// (예: { or: "(a.is.null,b.lt.…)" }). select=id · limit=0 · count=exact 로 행 본문은 받지 않는다.
async function countActive(table, filters = {}) {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  url.searchParams.set("select", "id");
  url.searchParams.set("limit", "0");
  url.searchParams.set("status", "eq.active");
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      prefer: "count=exact",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`${table}_http_${response.status}`);
  }
  const total = Number(String(response.headers.get("content-range") || "").split("/")[1]);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${table}_count_unavailable`);
  return total;
}

// 잔존 실패 기준선(공통) + 호출자가 얹는 추가 필터.
async function laneCount(table, extraFilters = {}) {
  return countActive(table, {
    last_error: "not.is.null",
    retry_count: `gte.${RANK_RETRY_EXHAUSTED_AT}`,
    ...extraFilters,
  });
}

let lanes;
let stuckCount;
let neverFoundCount;
let placePartialCount;
try {
  [lanes, stuckCount, neverFoundCount, placePartialCount] = await Promise.all([
    Promise.all(LANES.map(async (lane) => {
    const [residualCount, isolatedCount] = await Promise.all([
      laneCount(lane.table),
      // 격리 대상 = 잔존 조건 + 성공 도장(last_checked_at)이 끊긴 기간.
      // OR 의 두 갈래는 chronicIsolationCandidate 의 앵커 규칙을 그대로 옮긴 것이다:
      // 성공 이력이 있으면 last_checked_at 이 앵커, 한 번도 성공한 적 없으면(null)
      // created_at 이 앵커다. last_checked_at.is.null 만 쓰면 방금 만들어져 8번 실패한
      // 신규 추적기까지 만성으로 세어 순수 판정(false)과 감사(1건)가 갈라지므로,
      // null 갈래에는 반드시 created_at 컷오프를 묶는다.
      laneCount(lane.table, {
        or: `(last_checked_at.lt.${chronicCutoffAt},and(last_checked_at.is.null,created_at.lt.${chronicCutoffAt}))`,
      }),
    ]);
      return { lane: lane.key, table: lane.table, residualCount, isolatedCount };
    })),
    // 멈춘 상품 추적기. 잔존 기준선(retry_count>=8)을 일부러 쓰지 않는다 — 소진 전에
    // 멈춘 행을 잡는 것이 이 집계의 존재 이유다. OR 의 두 갈래는 위 격리 질의와 같은
    // 앵커 규칙이다(성공 이력이 있으면 last_checked_at, 없으면 created_at).
    countActive(PRODUCT_TABLE, {
      last_error: "not.is.null",
      or: `(last_checked_at.lt.${stuckCutoffAt},and(last_checked_at.is.null,created_at.lt.${stuckCutoffAt}))`,
    }),
    // 한 번도 찾지 못한 상품 추적기(보고 전용).
    countActive(PRODUCT_TABLE, {
      check_count: `gte.${RANK_NEVER_FOUND_MIN_CHECKS}`,
      found_count: "eq.0",
    }),
    // partial 을 반복 중인 플레이스 추적기(보고 전용). last_error 가 null 이라는 점이
    // 위 세 집계와 정반대라, 잔존 기준선(laneCount)을 쓰지 않고 직접 센다.
    countActive(PLACE_TABLE, {
      last_error: "is.null",
      retry_count: `gte.${RANK_PLACE_PARTIAL_MIN_RETRIES}`,
    }),
  ]);
} catch (error) {
  fail("RANK_RESIDUAL_AUDIT_QUERY_FAILED", String(error?.message || "residual_query_failed"));
}

const residualCount = lanes.reduce((sum, lane) => sum + lane.residualCount, 0);
// 보고만 한다. 잔존 합격/불합격은 residualCount 로만 정한다(isolated 는 그 부분집합).
const isolatedCount = lanes.reduce((sum, lane) => sum + lane.isolatedCount, 0);
const report = {
  // 종료 코드와 같은 뜻이다: 잔존도 0, 멈춘 추적기도 0 일 때만 참.
  ok: residualCount === 0 && stuckCount === 0,
  // code 는 예전 그대로 잔존 축만 말한다(워크플로 grep 계약). 멈춘 추적기 축은 stuckCode 다.
  code: residualCount === 0 ? "RANK_RESIDUAL_NONE" : "RANK_RESIDUAL_FAILURES_PRESENT",
  residualCount,
  isolatedCount,
  stuckCode: stuckCount === 0 ? "RANK_STUCK_NONE" : "RANK_STUCK_TRACKERS_PRESENT",
  stuckCount,
  neverFoundCount,
  // 관측 전용(F18). ok·code·stuckCode·exit 코드에는 쓰지 않는다.
  placePartialCount,
  retryExhaustedAt: RANK_RETRY_EXHAUSTED_AT,
  chronicIsolationDays: RANK_CHRONIC_ISOLATION_DAYS,
  stuckHours: RANK_STUCK_TRACKER_HOURS,
  neverFoundMinChecks: RANK_NEVER_FOUND_MIN_CHECKS,
  placePartialMinRetries: RANK_PLACE_PARTIAL_MIN_RETRIES,
  lanes,
  checkedAt,
};

if (residualCount > 0 || stuckCount > 0) {
  console.error(JSON.stringify(report, null, 2));
  if (residualCount > 0) {
    console.error(`재시도가 소진된 순위 추적기가 ${residualCount}건 남아 있습니다. docs/RUNBOOK.md 증상 ④를 따르세요.`);
  }
  if (stuckCount > 0) {
    console.error(`${RANK_STUCK_TRACKER_HOURS}시간 넘게 멈춘 상품 순위 추적기가 ${stuckCount}건 있습니다(RANK_STUCK_TRACKERS_PRESENT). 대표실 수집 상태 화면의 stuckTrackers 와 대조하세요.`);
  }
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));

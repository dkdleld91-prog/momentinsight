// 만성 실패 격리(chronic failure isolation) 회귀 테스트.
//
// 이 파일이 지키는 불변식:
//   1) chronicIsolationCandidate 는 네 연언지가 모두 성립할 때만 참이다.
//      (active · last_error 존재 · retry_count >= 8 · 실패 구간 >= 3일)
//   2) 증거가 없으면 격리하지 않는다(앵커 둘 다 파싱 실패 → false).
//   3) 격리된 행은 자동 재큐가 다시 끌어오지 않는다.
//   4) 주차 컬럼은 레인마다 다르며 상대 레인의 컬럼은 절대 쓰지 않는다.
//   5) 패스는 멱등이고, 읽기가 실패해도 던지지 않는다.
//   6) 잔존 실패 감사·오너 화면의 SQL 컷오프가 순수 판정과 드리프트하지 않는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RANK_CHRONIC_ISOLATION_DAYS,
  RANK_CHRONIC_ISOLATION_MARKER,
  RANK_CHRONIC_ISOLATION_MESSAGE,
  RANK_CHRONIC_ISOLATION_MS,
  RANK_CHRONIC_PARK_MS,
  RANK_RETRY_EXHAUSTED_AT,
  chronicIsolationCandidate,
  requeueEligible,
  runChronicIsolationPass,
} from "../src/server/naver-rank-requeue.mjs";

// rank-collection-stability.test.mjs:39 과 동일한 규약으로 저장소 원본을 문자열로 읽는다.
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readRepoFile = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-01T00:00:00.000Z");

const ago = (ms) => new Date(NOW - ms).toISOString();
const ahead = (ms) => new Date(NOW + ms).toISOString();

// 네 연언지가 모두 성립하는 기준 행. 각 테스트는 여기서 한 가지만 무너뜨린다.
function chronicRow(overrides = {}) {
  return {
    id: "t1",
    status: "active",
    last_error: "NAVER_SHOPPING_BLOCKED",
    retry_count: RANK_RETRY_EXHAUSTED_AT,
    last_checked_at: ago(5 * DAY),
    created_at: ago(30 * DAY),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// 1. chronicIsolationCandidate 진리표
// ─────────────────────────────────────────────────────────────
test("기준 행(active·오류·재시도 소진·5일 정체)은 격리 후보다", () => {
  assert.equal(chronicIsolationCandidate(chronicRow(), { now: NOW }), true);
});

test("active 가 아니면 이미 주기 밖이므로 격리하지 않는다", () => {
  for (const status of ["paused", "failed", "completed"]) {
    assert.equal(
      chronicIsolationCandidate(chronicRow({ status }), { now: NOW }),
      false,
      `status=${status} 는 격리 후보가 아니어야 한다`,
    );
  }
});

test("last_error 가 비었거나 공백뿐이면 실패 구간의 증거가 없다", () => {
  for (const last_error of [null, undefined, "", "   ", "\n\t "]) {
    assert.equal(
      chronicIsolationCandidate(chronicRow({ last_error }), { now: NOW }),
      false,
      `last_error=${JSON.stringify(last_error)} 는 격리 후보가 아니어야 한다`,
    );
  }
});

test("retry_count 가 소진선(8) 미만이면 격리하지 않는다 — 감사·재큐와 같은 바", () => {
  assert.equal(
    chronicIsolationCandidate(chronicRow({ retry_count: RANK_RETRY_EXHAUSTED_AT - 1 }), { now: NOW }),
    false,
  );
  assert.equal(
    chronicIsolationCandidate(chronicRow({ retry_count: RANK_RETRY_EXHAUSTED_AT }), { now: NOW }),
    true,
  );
});

test("실패 구간이 3일에 미치지 못하면 격리하지 않는다(경계 2일 23시간)", () => {
  assert.equal(
    chronicIsolationCandidate(chronicRow({ last_checked_at: ago(2 * DAY + 23 * HOUR) }), { now: NOW }),
    false,
  );
  // 정확히 임계값이면 참이다(>= 비교).
  assert.equal(
    chronicIsolationCandidate(chronicRow({ last_checked_at: ago(RANK_CHRONIC_ISOLATION_MS) }), { now: NOW }),
    true,
  );
});

test("앵커 두 개가 모두 파싱되지 않으면 격리하지 않는다(무증거 격리 금지)", () => {
  assert.equal(
    chronicIsolationCandidate(
      chronicRow({ last_checked_at: "not-a-date", created_at: "nonsense" }),
      { now: NOW },
    ),
    false,
  );
  assert.equal(
    chronicIsolationCandidate(chronicRow({ last_checked_at: null, created_at: null }), { now: NOW }),
    false,
  );
});

test("row 가 없으면 false 다", () => {
  assert.equal(chronicIsolationCandidate(null, { now: NOW }), false);
  assert.equal(chronicIsolationCandidate(undefined, { now: NOW }), false);
});

// ─────────────────────────────────────────────────────────────
// 2. 앵커 폴백: 한 번도 성공한 적 없는 추적기
// ─────────────────────────────────────────────────────────────
test("한 번도 성공한 적 없고(created_at 5일 전) 8회 실패면 격리 후보다", () => {
  assert.equal(
    chronicIsolationCandidate(
      chronicRow({ last_checked_at: null, created_at: ago(5 * DAY) }),
      { now: NOW },
    ),
    true,
  );
});

test("어제 성공했으면 retry_count 가 12라도 격리하지 않는다(앵커가 최근)", () => {
  assert.equal(
    chronicIsolationCandidate(
      chronicRow({ last_checked_at: ago(1 * DAY), retry_count: 12 }),
      { now: NOW },
    ),
    false,
  );
});

// 오너 화면·감사 SQL 이 last_checked_at.is.null 만 보고 만성으로 세면 이 행에서 갈라진다.
test("10분 전에 만들어져 12회 실패한 신규 추적기는 격리하지 않는다(created_at 앵커)", () => {
  assert.equal(
    chronicIsolationCandidate(
      chronicRow({ last_checked_at: null, created_at: ago(10 * 60 * 1000), retry_count: 12 }),
      { now: NOW },
    ),
    false,
  );
});

// ─────────────────────────────────────────────────────────────
// 3. 자동 재큐가 격리된 행을 되돌리지 못한다
// ─────────────────────────────────────────────────────────────
// 재큐 자격을 이미 갖춘 행(오래된 next_check_at). last_checked_at 만 바꿔 격리 여부를 가른다.
function requeueRow(overrides = {}) {
  return {
    id: "r1",
    status: "active",
    last_error: "NAVER_PLACE_TIMEOUT",
    retry_count: RANK_RETRY_EXHAUSTED_AT,
    next_check_at: ago(2 * DAY),
    last_checked_at: ago(1 * DAY),
    created_at: ago(30 * DAY),
    ...overrides,
  };
}

test("격리 대상이 아니던 행은 지금도 재큐 자격이 있다(기존 동작 불변)", () => {
  const row = requeueRow();
  assert.equal(chronicIsolationCandidate(row, { now: NOW }), false);
  assert.equal(requeueEligible(row, { now: NOW }), true);
});

test("격리된 행은 재큐 자격을 잃는다 — 주차가 그 자리에서 무효화되지 않는다", () => {
  const row = requeueRow({ last_checked_at: ago(5 * DAY) });
  assert.equal(chronicIsolationCandidate(row, { now: NOW }), true);
  assert.equal(requeueEligible(row, { now: NOW }), false);
});

// ─────────────────────────────────────────────────────────────
// 4. runChronicIsolationPass — 스텁 supabase 클라이언트
// ─────────────────────────────────────────────────────────────
function createSupabaseStub({ rows = [], readError = null, updateError = null, updateMatches = true } = {}) {
  const calls = { reads: [], updates: [] };

  const makeChain = (table, mode, patch) => {
    const filters = [];
    const chain = {
      _columns: "",
      select(columns) {
        if (mode === "read") chain._columns = columns;
        return chain;
      },
      eq(column, value) { filters.push({ op: "eq", column, value }); return chain; },
      not(column, operator, value) { filters.push({ op: "not", column, operator, value }); return chain; },
      gte(column, value) { filters.push({ op: "gte", column, value }); return chain; },
      or(expression) { filters.push({ op: "or", expression }); return chain; },
      order() { return chain; },
      limit() { return chain; },
      then(onFulfilled, onRejected) {
        let result;
        if (mode === "read") {
          calls.reads.push({ table, columns: chain._columns, filters });
          result = readError
            ? { data: null, error: readError }
            : { data: rows.map((row) => ({ ...row })), error: null };
        } else {
          calls.updates.push({ table, patch, filters });
          result = updateError
            ? { data: null, error: updateError }
            : { data: updateMatches ? [{ id: patch.id || "updated" }] : [], error: null };
        }
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  return {
    calls,
    ctx: {
      supabaseAdmin: {
        from(table) {
          return {
            select(columns) { return makeChain(table, "read").select(columns); },
            update(patch) { return makeChain(table, "update", patch); },
          };
        },
      },
    },
  };
}

// 패스에는 RANK_REQUEUE_MIN_INTERVAL_MS 스로틀이 있으므로 테스트는 force 로 우회한다.
const passOptions = (extra = {}) => ({ now: NOW, force: true, ...extra });

test("상품 레인은 worker_quarantined_until 로 주차하고 next_check_at 은 건드리지 않는다", async () => {
  const stub = createSupabaseStub({
    rows: [chronicRow({ worker_quarantined_until: null })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());

  assert.equal(result.table, "naver_rank_trackers");
  assert.equal(result.scanned, 1);
  assert.equal(result.isolated, 1);
  assert.equal(stub.calls.updates.length, 1);

  const { patch } = stub.calls.updates[0];
  assert.ok(
    Object.prototype.hasOwnProperty.call(patch, "worker_quarantined_until"),
    "상품 레인은 worker_quarantined_until 로 주차해야 한다",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(patch, "next_check_at"),
    false,
    "상품 레인의 next_check_at 은 durable cycle 소유라 절대 쓰면 안 된다",
  );
  // 주차는 미래여야 하고, 정확히 park 창만큼 밀려야 한다.
  const parkedUntil = Date.parse(patch.worker_quarantined_until);
  assert.ok(parkedUntil > NOW, "주차 시각은 미래여야 한다");
  assert.equal(parkedUntil, NOW + RANK_CHRONIC_PARK_MS);
  assert.equal(patch.last_message, RANK_CHRONIC_ISOLATION_MESSAGE);
  // 원인 진단과 감사 모수는 보존한다.
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "last_error"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "retry_count"), false);
});

test("플레이스 레인은 next_check_at 로 주차하고 worker_quarantined_until 은 쓰지 않는다", async () => {
  const stub = createSupabaseStub({
    rows: [chronicRow({ id: "p1", next_check_at: ago(2 * HOUR) })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_place_rank_trackers", passOptions());

  assert.equal(result.isolated, 1);
  const { patch } = stub.calls.updates[0];
  assert.ok(Object.prototype.hasOwnProperty.call(patch, "next_check_at"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(patch, "worker_quarantined_until"),
    false,
    "플레이스 테이블에는 worker_quarantined_until 컬럼이 없다",
  );
  // next_check_at 을 미래로 미는 것이 drained/503 함정을 피하는 유일한 방법이다.
  assert.ok(Date.parse(patch.next_check_at) > NOW, "주차는 반드시 미래여야 remaining 집계에서 빠진다");
  assert.equal(Date.parse(patch.next_check_at), NOW + RANK_CHRONIC_PARK_MS);
});

test("조건부 UPDATE 는 status·retry_count 를 재확인해 동시 성공을 덮어쓰지 않는다", async () => {
  const stub = createSupabaseStub({ rows: [chronicRow()] });
  await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());

  const { filters } = stub.calls.updates[0];
  const hasStatusGuard = filters.some((f) => f.op === "eq" && f.column === "status" && f.value === "active");
  const hasRetryGuard = filters.some((f) => f.op === "gte" && f.column === "retry_count" && f.value === RANK_RETRY_EXHAUSTED_AT);
  const hasIdGuard = filters.some((f) => f.op === "eq" && f.column === "id");
  assert.ok(hasIdGuard, "UPDATE 는 id 로 한정되어야 한다");
  assert.ok(hasStatusGuard, "UPDATE 는 status='active' 를 재확인해야 한다");
  assert.ok(hasRetryGuard, "UPDATE 는 retry_count 소진선을 재확인해야 한다");
});

test("이미 주차된 행은 다시 쓰지 않는다(멱등) — 영구 주차를 만들지 않는다", async () => {
  // 상품: 주차가 아직 남아 있음
  const productStub = createSupabaseStub({
    rows: [chronicRow({ worker_quarantined_until: ahead(12 * HOUR) })],
  });
  const productResult = await runChronicIsolationPass(productStub.ctx, "naver_rank_trackers", passOptions());
  assert.equal(productResult.isolated, 0);
  assert.equal(productResult.skipped, 1);
  assert.equal(productStub.calls.updates.length, 0, "이미 주차된 행에는 UPDATE 가 나가면 안 된다");

  // 플레이스: next_check_at 이 이미 미래
  const placeStub = createSupabaseStub({
    rows: [chronicRow({ id: "p1", next_check_at: ahead(6 * HOUR) })],
  });
  const placeResult = await runChronicIsolationPass(placeStub.ctx, "naver_place_rank_trackers", passOptions());
  assert.equal(placeResult.isolated, 0);
  assert.equal(placeStub.calls.updates.length, 0);
});

test("주차가 만료된 행은 다시 주차된다 — 하루 1회 재시도가 실제로 일어난다", async () => {
  const stub = createSupabaseStub({
    rows: [chronicRow({ worker_quarantined_until: ago(1 * HOUR) })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());
  assert.equal(result.isolated, 1);
});

test("격리 대상이 아닌 행은 스캔만 되고 주차되지 않는다", async () => {
  const stub = createSupabaseStub({
    // retry_count 는 소진됐지만 어제 성공한 행 — 실패 구간이 짧다.
    rows: [chronicRow({ last_checked_at: ago(1 * DAY), retry_count: 12 })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());
  assert.equal(result.scanned, 1);
  assert.equal(result.isolated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(stub.calls.updates.length, 0);
});

test("읽기가 실패해도 던지지 않고 0건으로 강등한다 — 크론을 죽이지 않는다", async () => {
  const stub = createSupabaseStub({ readError: new Error("connection reset") });
  const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());

  assert.equal(result.isolated, 0);
  assert.equal(result.scanned, 0);
  assert.equal(result.failed, true);
  assert.equal(stub.calls.updates.length, 0);
});

test("쓰기가 실패해도 던지지 않고 0건으로 강등한다", async () => {
  const stub = createSupabaseStub({ rows: [chronicRow()], updateError: new Error("deadlock detected") });
  const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());
  assert.equal(result.failed, true);
  assert.equal(result.isolated, 0);
});

test("조건부 UPDATE 가 0행을 맞히면 격리로 세지 않는다(동시 성공)", async () => {
  const stub = createSupabaseStub({ rows: [chronicRow()], updateMatches: false });
  const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());
  assert.equal(result.isolated, 0);
  assert.equal(result.skipped, 1);
});

test("알 수 없는 테이블은 fail-closed 로 아무 행도 건드리지 않는다", async () => {
  const stub = createSupabaseStub({ rows: [chronicRow()] });
  const result = await runChronicIsolationPass(stub.ctx, "some_other_table", passOptions());
  assert.equal(result.unsupported, true);
  assert.equal(result.isolated, 0);
  assert.equal(stub.calls.reads.length, 0);
  assert.equal(stub.calls.updates.length, 0);
});

test("패스는 status·last_error·retry_count 를 DB 로 밀어 스캔을 싸게 유지한다", async () => {
  const stub = createSupabaseStub({ rows: [] });
  await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());

  const read = stub.calls.reads[0];
  assert.ok(read.filters.some((f) => f.op === "eq" && f.column === "status" && f.value === "active"));
  assert.ok(read.filters.some((f) => f.op === "not" && f.column === "last_error"));
  assert.ok(read.filters.some((f) => f.op === "gte" && f.column === "retry_count" && f.value === RANK_RETRY_EXHAUSTED_AT));
  // 앵커 컬럼이 실려야 JS 판정이 성립한다.
  assert.ok(read.columns.includes("last_checked_at"), "SELECT 에 last_checked_at 이 실려야 한다");
  assert.ok(read.columns.includes("created_at"), "SELECT 에 created_at 이 실려야 한다");
});

// ─────────────────────────────────────────────────────────────
// 5. 소스 드리프트 가드
// ─────────────────────────────────────────────────────────────
const residualAuditSource = readRepoFile("scripts/check-rank-residual-failures.mjs");
const superAdminSource = readRepoFile("src/server/handlers/super-admin-api.mjs");
const requeueSource = readRepoFile("src/server/naver-rank-requeue.mjs");

test("잔존 실패 감사는 격리 상수를 서버 모듈에서 가져온다(하드코딩 금지)", () => {
  assert.ok(
    residualAuditSource.includes("../src/server/naver-rank-requeue.mjs"),
    "감사 스크립트는 격리 상수를 naver-rank-requeue.mjs 에서 import 해야 한다",
  );
  assert.ok(residualAuditSource.includes("RANK_CHRONIC_ISOLATION_MS"));
  assert.ok(residualAuditSource.includes("RANK_CHRONIC_ISOLATION_DAYS"));
  assert.ok(residualAuditSource.includes("RANK_RETRY_EXHAUSTED_AT"));
});

test("감사·오너 화면은 워크플로가 grep 하는 코드 문자열을 그대로 유지한다", () => {
  for (const code of [
    "RANK_RESIDUAL_FAILURES_PRESENT",
    "RANK_RESIDUAL_NONE",
    "RANK_RESIDUAL_AUDIT_DATABASE_MISSING",
    "RANK_RESIDUAL_AUDIT_QUERY_FAILED",
  ]) {
    assert.ok(residualAuditSource.includes(code), `${code} 문자열이 사라지면 워크플로 grep 이 깨진다`);
  }
});

// 이 가드가 잡는 사고: SQL 이 last_checked_at.is.null 만 보고 만성으로 세면,
// 방금 만들어져 8회 실패한 추적기를 화면은 세고 순수 판정은 거른다(대조 불가).
function assertAnchorPaired(source, label) {
  const needle = "last_checked_at.is.null";
  let from = 0;
  let found = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    found += 1;
    const window = source.slice(at, at + 140);
    assert.ok(
      window.includes("created_at"),
      `${label}: created_at 컷오프와 짝지어지지 않은 last_checked_at.is.null 이 있습니다(순수 판정과 드리프트)`,
    );
    from = at + needle.length;
  }
  assert.ok(found > 0, `${label}: 격리 컷오프 표현식을 찾지 못했습니다`);
}

test("오너 화면의 만성 카운트 SQL 은 created_at 앵커와 짝지어져 있다", () => {
  assertAnchorPaired(superAdminSource, "super-admin-api.mjs");
});

test("잔존 실패 감사의 격리 질의는 created_at 앵커와 짝지어져 있다", () => {
  assertAnchorPaired(residualAuditSource, "check-rank-residual-failures.mjs");
});

test("격리 마커·기간 상수가 기대값에서 벗어나지 않는다", () => {
  assert.equal(RANK_CHRONIC_ISOLATION_DAYS, 3);
  assert.equal(RANK_CHRONIC_ISOLATION_MS, 3 * DAY);
  assert.equal(RANK_CHRONIC_PARK_MS, 1 * DAY);
  assert.equal(RANK_CHRONIC_ISOLATION_MARKER, "수집 방식 점검 중");
  // 광고주 화면에 그대로 렌더되므로 마커가 접두사여야 배지 판정이 성립한다.
  assert.equal(RANK_CHRONIC_ISOLATION_MESSAGE.indexOf(RANK_CHRONIC_ISOLATION_MARKER), 0);
  // 날짜·횟수 같은 내부 텔레메트리가 사용자 문구에 섞이면 안 된다.
  assert.equal(/\d/.test(RANK_CHRONIC_ISOLATION_MESSAGE), false, "사용자 문구에 숫자를 넣지 않는다");
});

test("격리 패스는 상품 레인도 지원한다(재큐와 달리 fail-closed 가 아니다)", () => {
  // 재큐는 상품에서 구조적으로 제외되지만, 격리는 두 레인 모두에서 성립한다.
  assert.ok(requeueSource.includes("runChronicIsolationPass"));
  assert.ok(
    requeueSource.includes('table !== "naver_rank_trackers" && table !== "naver_place_rank_trackers"'),
    "격리 패스는 두 레인만 허용하는 fail-closed 가드를 가져야 한다",
  );
});

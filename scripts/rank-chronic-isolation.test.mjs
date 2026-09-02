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
//   7) 주차가 만료돼도 만료 이후 시도 흔적이 없으면 재주차하지 않는다(F1/F8).
//      흔적은 플레이스 last_attempt_at, 상품 worker_last_cycle_claimed_at 이다.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  PLACE_RETRY_BACKOFF_MINUTES,
  RANK_CHRONIC_ISOLATION_DAYS,
  RANK_CHRONIC_ISOLATION_MARKER,
  RANK_CHRONIC_ISOLATION_MESSAGE,
  RANK_CHRONIC_ISOLATION_MS,
  RANK_CHRONIC_PARK_MS,
  RANK_NEVER_FOUND_MIN_CHECKS,
  RANK_RETRY_EXHAUSTED_AT,
  RANK_STUCK_TRACKER_HOURS,
  RANK_STUCK_TRACKER_MS,
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

// 플레이스 첫 격리 기준 행: 사다리 끝(360분)까지 기다렸다가 방금 due 가 된 행.
// last_attempt_at 은 실패 경로가 next_check_at 을 "시도 + 360분"으로 미는 실제 모양을 따른다.
const PLACE_LADDER_MS = PLACE_RETRY_BACKOFF_MINUTES[PLACE_RETRY_BACKOFF_MINUTES.length - 1] * 60 * 1000;
function placeLadderRow(overrides = {}) {
  return chronicRow({
    id: "p1",
    last_attempt_at: ago(2 * HOUR + PLACE_LADDER_MS),
    next_check_at: ago(2 * HOUR),
    last_message: "네이버 플레이스 순위 갱신을 다시 시도할 예정입니다.",
    ...overrides,
  });
}

test("플레이스 레인은 next_check_at 로 주차하고 worker_quarantined_until 은 쓰지 않는다", async () => {
  const stub = createSupabaseStub({
    rows: [placeLadderRow()],
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

// ── F1/F8: 주차 만료 직후의 재주차가 영구 정지를 만든다 ─────────────────────
// 플레이스는 같은 크론 요청 안에서 격리 패스가 claim 보다 먼저 돌고, 상품은 만료 후
// durable cycle 커서가 닿기 전에 이 패스가 먼저 닿는다. 그 순간 "parkedUntil <= now"
// 만 보고 24시간을 다시 얹으면 그 행은 영원히 due 가 되지 못한다. 그래서 만료 이후
// 시도 흔적(claim 도장)이 없는 행은 재주차하지 않고 수집 주기에 넘긴다.
test("[상품] 주차가 만료됐어도 만료 후 claim 흔적이 없으면 재주차하지 않는다(F1/F8)", async () => {
  const stub = createSupabaseStub({
    rows: [chronicRow({
      worker_quarantined_until: ago(1 * HOUR),
      // 마지막 claim 은 주차보다 앞선다 — 만료 뒤에 아무도 시도하지 않았다.
      worker_last_cycle_claimed_at: ago(2 * DAY),
    })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());
  assert.equal(result.isolated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(stub.calls.updates.length, 0, "미시도 행에 UPDATE 가 나가면 durable cycle 이 영영 닿지 못한다");
});

test("[상품] claim 도장이 아예 없으면(null) 흔적 없음으로 보고 재주차하지 않는다", async () => {
  const stub = createSupabaseStub({
    rows: [chronicRow({ worker_quarantined_until: ago(1 * HOUR), worker_last_cycle_claimed_at: null })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());
  assert.equal(result.isolated, 0);
  assert.equal(stub.calls.updates.length, 0);
});

test("[상품] 만료 후 claim 흔적이 있는 행(시도했는데 또 실패)은 기존대로 재주차한다", async () => {
  const stub = createSupabaseStub({
    rows: [chronicRow({
      worker_quarantined_until: ago(1 * HOUR),
      worker_last_cycle_claimed_at: ago(30 * 60 * 1000),
    })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());
  assert.equal(result.isolated, 1);
  assert.equal(stub.calls.updates.length, 1);
  const { patch } = stub.calls.updates[0];
  assert.equal(Date.parse(patch.worker_quarantined_until), NOW + RANK_CHRONIC_PARK_MS);
  assert.equal(patch.last_message, RANK_CHRONIC_ISOLATION_MESSAGE);
});

test("[상품] 흔적 경계: claim 도장이 만료 시각과 같으면 흔적이고, 1ms 앞서면 흔적이 아니다", async () => {
  const expiredAt = ago(1 * HOUR);
  const same = createSupabaseStub({
    rows: [chronicRow({ worker_quarantined_until: expiredAt, worker_last_cycle_claimed_at: expiredAt })],
  });
  assert.equal((await runChronicIsolationPass(same.ctx, "naver_rank_trackers", passOptions())).isolated, 1);

  const before = createSupabaseStub({
    rows: [chronicRow({
      worker_quarantined_until: expiredAt,
      worker_last_cycle_claimed_at: new Date(Date.parse(expiredAt) - 1).toISOString(),
    })],
  });
  assert.equal((await runChronicIsolationPass(before.ctx, "naver_rank_trackers", passOptions())).isolated, 0);
});

test("[상품] 처음 격리(주차 없음)는 claim 흔적과 무관하게 기존대로 주차한다", async () => {
  for (const claimedAt of [null, ago(2 * DAY)]) {
    const stub = createSupabaseStub({
      rows: [chronicRow({ worker_quarantined_until: null, worker_last_cycle_claimed_at: claimedAt })],
    });
    const result = await runChronicIsolationPass(stub.ctx, "naver_rank_trackers", passOptions());
    assert.equal(result.isolated, 1, `첫 격리는 claimed_at=${JSON.stringify(claimedAt)} 이어도 주차해야 한다`);
    assert.equal(Date.parse(stub.calls.updates[0].patch.worker_quarantined_until), NOW + RANK_CHRONIC_PARK_MS);
  }
});

// 플레이스는 next_check_at 이 주차 컬럼이자 사다리 컬럼이다. 만료 후 시도가 실패하면
// 실패 경로가 next_check_at 을 "시도 + 360분"으로 덮어써 주차 시각(P)이 사라지므로,
// "만료 이후 시도" 는 주차 시작 시각(next_check_at - RANK_CHRONIC_PARK_MS) 이후의
// last_attempt_at 으로 판정한다. 플레이스는 주차 중 claim 이 구조적으로 불가능하므로
// (claim 술어 next_check_at <= now) 이 판정은 "만료 이후 시도" 와 같다.
test("[플레이스] 주차가 만료됐어도 만료 후 시도 흔적이 없으면 재주차하지 않는다(F1/F8)", async () => {
  const stub = createSupabaseStub({
    rows: [chronicRow({
      id: "p1",
      // 25시간 전에 주차됐고(P = now - 1h) 그 뒤로 claim 이 없었다 — 같은 크론 요청에서
      // 격리 패스가 claim 보다 먼저 닿는 바로 그 순간이다.
      next_check_at: ago(1 * HOUR),
      last_attempt_at: ago(26 * HOUR),
      last_message: RANK_CHRONIC_ISOLATION_MESSAGE,
    })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_place_rank_trackers", passOptions());
  assert.equal(result.isolated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(stub.calls.updates.length, 0, "미시도 행에 UPDATE 가 나가면 claim 이 영영 오지 못한다");
});

test("[플레이스] last_attempt_at 이 없으면(null) 흔적 없음으로 보고 재주차하지 않는다", async () => {
  const stub = createSupabaseStub({
    rows: [chronicRow({ id: "p1", next_check_at: ago(1 * HOUR), last_attempt_at: null })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_place_rank_trackers", passOptions());
  assert.equal(result.isolated, 0);
  assert.equal(stub.calls.updates.length, 0);
});

test("[플레이스] 만료 후 시도했다가 다시 실패한 행(사다리 next_check_at)은 기존대로 재주차한다", async () => {
  // 주차 만료 → claim(last_attempt_at) → 실패 경로가 next_check_at = 시도 + 360분 → 그 사다리도 만료.
  const stub = createSupabaseStub({
    rows: [placeLadderRow({ last_attempt_at: ago(1 * HOUR + PLACE_LADDER_MS), next_check_at: ago(1 * HOUR) })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_place_rank_trackers", passOptions());
  assert.equal(result.isolated, 1);
  const { patch } = stub.calls.updates[0];
  assert.equal(Date.parse(patch.next_check_at), NOW + RANK_CHRONIC_PARK_MS);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "worker_quarantined_until"), false);
});

test("[플레이스] 시도 도장이 next_check_at 이후여도(수동 갱신 경로) 흔적으로 보고 재주차한다", async () => {
  const stub = createSupabaseStub({
    rows: [chronicRow({ id: "p1", next_check_at: ago(1 * HOUR), last_attempt_at: ago(30 * 60 * 1000) })],
  });
  const result = await runChronicIsolationPass(stub.ctx, "naver_place_rank_trackers", passOptions());
  assert.equal(result.isolated, 1);
});

test("[플레이스] 흔적 경계: 주차 시작 시각(next_check_at - 24h)과 같은 시도는 흔적, 1ms 앞서면 아니다", async () => {
  const parkStartedAt = NOW - 1 * HOUR - RANK_CHRONIC_PARK_MS;
  const same = createSupabaseStub({
    rows: [chronicRow({ id: "p1", next_check_at: ago(1 * HOUR), last_attempt_at: new Date(parkStartedAt).toISOString() })],
  });
  assert.equal((await runChronicIsolationPass(same.ctx, "naver_place_rank_trackers", passOptions())).isolated, 1);

  const before = createSupabaseStub({
    rows: [chronicRow({ id: "p1", next_check_at: ago(1 * HOUR), last_attempt_at: new Date(parkStartedAt - 1).toISOString() })],
  });
  assert.equal((await runChronicIsolationPass(before.ctx, "naver_place_rank_trackers", passOptions())).isolated, 0);
});

test("플레이스 판정의 전제: 백오프 사다리 최댓값이 주차 창(24h)보다 짧다", () => {
  // 사다리 값(시도 + 최대 360분)은 항상 주차 시작 시각 이후이고, 순수 주차(시도 < 주차 시작)는
  // 그렇지 않다 — 이 부등식이 깨지면 두 경우를 last_attempt_at 으로 가를 수 없다.
  assert.ok(PLACE_LADDER_MS < RANK_CHRONIC_PARK_MS);
});

test("흔적이 있어도 주차 창이 아직 남아 있으면 두 레인 모두 건너뛴다(기존 멱등성 유지)", async () => {
  // 남은 주차를 다시 미는 것은 영구 주차다 — 흔적 판정은 만료된 주차에만 적용된다.
  const productStub = createSupabaseStub({
    rows: [chronicRow({ worker_quarantined_until: ahead(1 * HOUR), worker_last_cycle_claimed_at: ago(1 * HOUR) })],
  });
  assert.equal((await runChronicIsolationPass(productStub.ctx, "naver_rank_trackers", passOptions())).isolated, 0);
  const placeStub = createSupabaseStub({
    rows: [chronicRow({ id: "p1", next_check_at: ahead(1 * HOUR), last_attempt_at: ago(1 * HOUR) })],
  });
  assert.equal((await runChronicIsolationPass(placeStub.ctx, "naver_place_rank_trackers", passOptions())).isolated, 0);
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

test("격리 SELECT 는 레인별 주차 컬럼과 시도 흔적 컬럼을 싣고 상대 레인 컬럼은 싣지 않는다", async () => {
  const productStub = createSupabaseStub({ rows: [] });
  await runChronicIsolationPass(productStub.ctx, "naver_rank_trackers", passOptions());
  const productColumns = productStub.calls.reads[0].columns;
  assert.ok(productColumns.includes("worker_quarantined_until"));
  assert.ok(productColumns.includes("worker_last_cycle_claimed_at"), "상품 흔적 컬럼(20260812060826) 이 실려야 한다");
  assert.ok(!productColumns.includes("last_attempt_at"), "상품 표에는 last_attempt_at 이 없다");

  const placeStub = createSupabaseStub({ rows: [] });
  await runChronicIsolationPass(placeStub.ctx, "naver_place_rank_trackers", passOptions());
  const placeColumns = placeStub.calls.reads[0].columns;
  assert.ok(placeColumns.includes("next_check_at"));
  assert.ok(placeColumns.includes("last_attempt_at"), "플레이스 흔적 컬럼(20260711173414) 이 실려야 한다");
  assert.ok(!placeColumns.includes("worker_"), "플레이스 표에는 worker_* 컬럼이 없다(쓰면 400)");
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

// ─────────────────────────────────────────────────────────────
// 6. 멈춘 추적기(stuck)·미발견 추적기(neverFound) — C2 결함 D·E
//
// 잔존 감사는 retry_count >= 8 만 세어 왔다. 상품 레인은 격리 코드가 많아 retry_count
// 가 8 에 닿지 않은 채 며칠씩 last_error 만 남기고 멈춘 추적기가 생기는데, 그 행은
// residual 에도 queueStalled 에도 잡히지 않았다. stuck 의 정의:
//   status='active' AND last_error IS NOT NULL
//   AND coalesce(last_checked_at, created_at) < now - RANK_STUCK_TRACKER_MS(36h)
// neverFound 의 정의: status='active' AND check_count >= 3 AND found_count = 0.
// 두 정의는 상품 추적기(naver_rank_trackers)에만 적용한다.
// ─────────────────────────────────────────────────────────────
const execFileAsync = promisify(execFile);
const trackersHandlerSource = readRepoFile("src/server/handlers/naver-rank-trackers.mjs");
const healthHandlerSource = readRepoFile("src/server/handlers/rank-collection-health.mjs");

test("stuck·neverFound 상수는 naver-rank-requeue.mjs 한 곳에서만 정한다", () => {
  assert.equal(RANK_STUCK_TRACKER_HOURS, 36);
  assert.equal(RANK_STUCK_TRACKER_MS, 36 * HOUR);
  assert.equal(RANK_NEVER_FOUND_MIN_CHECKS, 3);
  // 잠금 파일(naver-rank-trackers.mjs)의 payload 판정은 상수를 import 하지 않는다(파일
  // 잠금이라 손대지 않는다). 대신 소스 문자열로 값이 같은지 대조한다.
  assert.ok(
    trackersHandlerSource.includes(`checkCount >= ${RANK_NEVER_FOUND_MIN_CHECKS} && foundCount === 0`),
    "trackerPayload.neverFound 판정과 RANK_NEVER_FOUND_MIN_CHECKS 가 어긋났다",
  );
  for (const [label, source] of [
    ["check-rank-residual-failures.mjs", residualAuditSource],
    ["super-admin-api.mjs", superAdminSource],
    ["rank-collection-health.mjs", healthHandlerSource],
  ]) {
    assert.ok(source.includes("RANK_STUCK_TRACKER_MS"), `${label} 은 RANK_STUCK_TRACKER_MS 를 import 해야 한다`);
    assert.ok(source.includes("RANK_NEVER_FOUND_MIN_CHECKS"), `${label} 은 RANK_NEVER_FOUND_MIN_CHECKS 를 import 해야 한다`);
    assert.ok(!/36\s*\*\s*60/.test(source), `${label} 은 36시간을 다시 곱하지 않는다`);
    assert.ok(!/check_count["'`]?,\s*["'`]?gte\.?["'`]?,?\s*3\b/.test(source), `${label} 은 최소 확인 횟수 3 을 하드코딩하지 않는다`);
  }
});

test("잔존 감사는 stuck 마커 문자열을 유지한다(워크플로 grep 계약)", () => {
  for (const code of ["RANK_STUCK_TRACKERS_PRESENT", "RANK_STUCK_NONE"]) {
    assert.ok(residualAuditSource.includes(code), `${code} 문자열이 사라지면 워크플로 요약이 깨진다`);
  }
});

test("오너 화면 카운터에 neverFoundTrackers·stuckTrackers 가 chronicTrackers 와 같은 패턴으로 있다", () => {
  const start = superAdminSource.indexOf("async function loadOwnerHealth(");
  const end = superAdminSource.indexOf("async function listClients(", start);
  assert.ok(start >= 0 && end > start);
  const block = superAdminSource.slice(start, end);
  for (const name of ["chronicTrackers", "neverFoundTrackers", "stuckTrackers"]) {
    assert.ok(block.includes(`    ${name},`), `loadOwnerHealth 는 ${name} 을 safeCount 결과로 실어야 한다`);
  }
  assert.ok(block.indexOf("neverFoundTrackers") > block.indexOf("chronicTrackers"));
  assert.ok(block.indexOf("stuckTrackers") > block.indexOf("neverFoundTrackers"));
  // 두 카운터 모두 상품 표만 본다.
  assert.ok(!block.includes("naver_place_rank_trackers"));
});

// ── 감사 스크립트 실행 검증. 가짜 PostgREST(count=exact → content-range) 를 로컬에
//    띄우고 스크립트를 자식 프로세스로 돌려 exit 코드·마커·질의 모양을 함께 고정한다.
function classifyAuditQuery(url) {
  const table = url.pathname.replace("/rest/v1/", "");
  const params = url.searchParams;
  if (params.has("check_count")) return `${table}:neverFound`;
  if (params.has("retry_count") && params.has("or")) return `${table}:isolated`;
  if (params.has("retry_count")) return `${table}:residual`;
  if (params.has("or")) return `${table}:stuck`;
  return `${table}:unknown`;
}

function startAuditRest(counts) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      requests.push(url);
      const total = counts[classifyAuditQuery(url)];
      if (total === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"message":"unexpected_query"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "content-range": `*/${total}` });
      response.end("[]");
    });
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      requests,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

async function runResidualAudit(baseUrl) {
  const env = { ...process.env, SUPABASE_URL: baseUrl, SUPABASE_SECRET_KEY: "sb_secret_residual_audit_test" };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["scripts/check-rank-residual-failures.mjs"],
      { cwd: repositoryRoot, env, timeout: 30_000 },
    );
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
  }
}

function reportFrom(text) {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  assert.ok(from >= 0 && to > from, `보고 JSON 을 찾지 못했다: ${text}`);
  return JSON.parse(text.slice(from, to + 1));
}

const ZERO_COUNTS = {
  "naver_rank_trackers:residual": 0,
  "naver_rank_trackers:isolated": 0,
  "naver_place_rank_trackers:residual": 0,
  "naver_place_rank_trackers:isolated": 0,
  "naver_rank_trackers:neverFound": 0,
  "naver_rank_trackers:stuck": 0,
};

test("잔존 감사(실행): 전부 0 이면 exit 0 이고 stuck·neverFound 를 함께 보고한다", async (t) => {
  const rest = await startAuditRest(ZERO_COUNTS);
  t.after(() => rest.server.close());
  const startedAt = Date.now();
  const run = await runResidualAudit(rest.baseUrl);
  assert.equal(run.status, 0, run.stderr);
  const report = reportFrom(run.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.code, "RANK_RESIDUAL_NONE");
  assert.equal(report.stuckCode, "RANK_STUCK_NONE");
  assert.equal(report.residualCount, 0);
  assert.equal(report.stuckCount, 0);
  assert.equal(report.neverFoundCount, 0);
  assert.equal(report.stuckHours, RANK_STUCK_TRACKER_HOURS);
  assert.equal(report.neverFoundMinChecks, RANK_NEVER_FOUND_MIN_CHECKS);
  assert.equal(report.retryExhaustedAt, RANK_RETRY_EXHAUSTED_AT);

  // 질의 모양. 두 새 집계는 상품 표에만 나간다.
  const kinds = rest.requests.map(classifyAuditQuery);
  assert.equal(kinds.filter((kind) => kind === "naver_rank_trackers:stuck").length, 1);
  assert.equal(kinds.filter((kind) => kind === "naver_rank_trackers:neverFound").length, 1);
  assert.ok(!kinds.includes("naver_place_rank_trackers:stuck"));
  assert.ok(!kinds.includes("naver_place_rank_trackers:neverFound"));
  assert.ok(!kinds.some((kind) => kind.endsWith(":unknown")));

  const stuck = rest.requests.find((url) => classifyAuditQuery(url) === "naver_rank_trackers:stuck");
  assert.equal(stuck.searchParams.get("status"), "eq.active");
  assert.equal(stuck.searchParams.get("last_error"), "not.is.null");
  assert.equal(stuck.searchParams.has("retry_count"), false, "stuck 은 재시도 소진과 무관하다");
  assert.equal(stuck.searchParams.get("limit"), "0");
  const or = stuck.searchParams.get("or");
  assert.ok(or.startsWith("(last_checked_at.lt."), or);
  assert.ok(or.includes("and(last_checked_at.is.null,created_at.lt."), or);
  const cutoffs = [...or.matchAll(/\.lt\.([0-9TZ:.\-]+)/g)].map((match) => Date.parse(match[1]));
  assert.equal(cutoffs.length, 2);
  assert.equal(cutoffs[0], cutoffs[1], "두 갈래는 같은 컷오프를 쓴다");
  assert.ok(Math.abs((startedAt - cutoffs[0]) - RANK_STUCK_TRACKER_MS) < 30_000, `컷오프는 now-36h: ${or}`);

  const neverFound = rest.requests.find((url) => classifyAuditQuery(url) === "naver_rank_trackers:neverFound");
  assert.equal(neverFound.searchParams.get("status"), "eq.active");
  assert.equal(neverFound.searchParams.get("check_count"), `gte.${RANK_NEVER_FOUND_MIN_CHECKS}`);
  assert.equal(neverFound.searchParams.get("found_count"), "eq.0");
  assert.equal(neverFound.searchParams.has("last_error"), false);
  assert.equal(neverFound.searchParams.has("retry_count"), false);
  // 읽기 전용·개수만: 어느 질의도 id 외 열을 요구하지 않는다.
  for (const url of rest.requests) assert.equal(url.searchParams.get("select"), "id");
});

test("잔존 감사(실행): stuck>0 이면 residual 이 0 이어도 exit 1 + RANK_STUCK_TRACKERS_PRESENT", async (t) => {
  const rest = await startAuditRest({ ...ZERO_COUNTS, "naver_rank_trackers:stuck": 2, "naver_rank_trackers:neverFound": 5 });
  t.after(() => rest.server.close());
  const run = await runResidualAudit(rest.baseUrl);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes("RANK_STUCK_TRACKERS_PRESENT"), run.stderr);
  assert.ok(run.stderr.includes("RANK_RESIDUAL_NONE"), "잔존 판정은 그대로 0 이다");
  assert.ok(!run.stderr.includes("RANK_RESIDUAL_FAILURES_PRESENT"), "stuck 을 잔존으로 오진하지 않는다");
  const report = reportFrom(run.stderr);
  assert.equal(report.ok, false);
  assert.equal(report.code, "RANK_RESIDUAL_NONE");
  assert.equal(report.stuckCode, "RANK_STUCK_TRACKERS_PRESENT");
  assert.equal(report.stuckCount, 2);
  assert.equal(report.neverFoundCount, 5);
  assert.equal(report.residualCount, 0);
  assert.equal(run.stdout.trim(), "", "실패 보고는 stderr 로만 낸다(기존 규약)");
});

test("잔존 감사(실행): neverFound 만 있으면 보고만 하고 exit 0 이다", async (t) => {
  const rest = await startAuditRest({ ...ZERO_COUNTS, "naver_rank_trackers:neverFound": 4 });
  t.after(() => rest.server.close());
  const run = await runResidualAudit(rest.baseUrl);
  assert.equal(run.status, 0, run.stderr);
  const report = reportFrom(run.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.neverFoundCount, 4);
  assert.equal(report.stuckCode, "RANK_STUCK_NONE");
  assert.ok(!run.stdout.includes("RANK_STUCK_TRACKERS_PRESENT"));
});

test("잔존 감사(실행): residual>0 판정·마커·exit 코드는 이전과 같다", async (t) => {
  const rest = await startAuditRest({ ...ZERO_COUNTS, "naver_rank_trackers:residual": 1, "naver_rank_trackers:isolated": 1 });
  t.after(() => rest.server.close());
  const run = await runResidualAudit(rest.baseUrl);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes("RANK_RESIDUAL_FAILURES_PRESENT"), run.stderr);
  assert.ok(run.stderr.includes("docs/RUNBOOK.md 증상 ④"));
  const report = reportFrom(run.stderr);
  assert.equal(report.ok, false);
  assert.equal(report.code, "RANK_RESIDUAL_FAILURES_PRESENT");
  assert.equal(report.residualCount, 1);
  assert.equal(report.isolatedCount, 1);
  assert.equal(report.stuckCode, "RANK_STUCK_NONE");
  assert.equal(report.stuckCount, 0);
});

test("잔존 감사(실행): stuck 질의 실패는 RANK_RESIDUAL_AUDIT_QUERY_FAILED 로 exit 1 이다(단정 금지)", async (t) => {
  const counts = { ...ZERO_COUNTS };
  delete counts["naver_rank_trackers:stuck"];
  const rest = await startAuditRest(counts);
  t.after(() => rest.server.close());
  const run = await runResidualAudit(rest.baseUrl);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes("RANK_RESIDUAL_AUDIT_QUERY_FAILED"), run.stderr);
  assert.ok(!run.stderr.includes("RANK_STUCK_TRACKERS_PRESENT"), "집계가 끝나지 않았는데 stuck 을 단정하면 안 된다");
  assert.ok(!run.stderr.includes("RANK_RESIDUAL_NONE"), "집계가 끝나지 않았는데 잔존 0 을 단정하면 안 된다");
});

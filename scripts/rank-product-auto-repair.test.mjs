// 상품 레인 자동 재검증(auto repair) 회귀 테스트 — C3 결함 F.
//
// 이 파일이 지키는 불변식:
//   1) productAutoRepairCandidate 는 다섯 연언지가 모두 성립할 때만 참이다.
//      (active · last_error 존재 · retry_count < 8 · 실패 구간 > 36h · 만성 격리 표식 아님)
//   2) 패스는 하루 1회만 RPC 를 부른다 — 판정은 requests.requested_at(reason='auto_repair') 이다.
//   3) 최근 24h 내 repair 큐에 있었던 추적기(queued · consumed_at · requests.requested_at)는 다시 넣지 않는다.
//   4) 한 번에 최대 10건, reason 은 'auto_repair', 기존 RPC 만 부른다(새 테이블·마이그레이션 없음).
//   5) RPC 거절(계정우선 게이트·already_queued·오류)·읽기 실패·throw 어느 경우에도 패스는 던지지 않는다.
//   6) 플레이스 크론이 만성 격리 호출 옆(Promise.allSettled)에서 이 패스를 부른다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RANK_AUTO_REPAIR_BATCH_LIMIT,
  RANK_AUTO_REPAIR_INTERVAL_MS,
  RANK_AUTO_REPAIR_REASON,
  RANK_AUTO_REPAIR_RPC,
  RANK_CHRONIC_ISOLATION_MESSAGE,
  RANK_RETRY_EXHAUSTED_AT,
  RANK_STUCK_TRACKER_MS,
  productAutoRepairCandidate,
  runProductAutoRepairPass,
} from "../src/server/naver-rank-requeue.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readRepoFile = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-02T00:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

const REQUESTS_TABLE = "naver_shopping_repair_priority_requests";
const ITEMS_TABLE = "naver_shopping_repair_priority_items";
const TRACKERS_TABLE = "naver_rank_trackers";

function uuidAt(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

// 다섯 연언지가 모두 성립하는 기준 행. 각 테스트는 여기서 한 가지만 무너뜨린다.
function candidateRow(overrides = {}) {
  return {
    id: uuidAt(1),
    status: "active",
    last_error: "NAVER_SHOPPING_TIMEOUT",
    retry_count: 3,
    last_checked_at: ago(2 * DAY),
    created_at: ago(30 * DAY),
    last_message: "순위 조회에 실패했습니다.",
    worker_quarantined_until: ago(1 * HOUR),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// 1. productAutoRepairCandidate 진리표
// ─────────────────────────────────────────────────────────────
test("기준 행(active·오류·retry 3·2일 정체·격리 아님)은 자동 재검증 후보다", () => {
  assert.equal(productAutoRepairCandidate(candidateRow(), { now: NOW }), true);
});

test("row 가 없거나 active 가 아니면 후보가 아니다", () => {
  assert.equal(productAutoRepairCandidate(null, { now: NOW }), false);
  for (const status of ["paused", "failed", "completed"]) {
    assert.equal(productAutoRepairCandidate(candidateRow({ status }), { now: NOW }), false, status);
  }
});

test("last_error 가 비었으면 실패 구간의 증거가 없다", () => {
  for (const last_error of [null, undefined, "", "   "]) {
    assert.equal(productAutoRepairCandidate(candidateRow({ last_error }), { now: NOW }), false);
  }
});

test("retry_count 경계: 7 은 후보, 8 이상은 만성 격리 담당이라 제외", () => {
  assert.equal(productAutoRepairCandidate(candidateRow({ retry_count: RANK_RETRY_EXHAUSTED_AT - 1 }), { now: NOW }), true);
  assert.equal(productAutoRepairCandidate(candidateRow({ retry_count: RANK_RETRY_EXHAUSTED_AT }), { now: NOW }), false);
  assert.equal(productAutoRepairCandidate(candidateRow({ retry_count: 20 }), { now: NOW }), false);
  // retry_count 가 없으면 0 으로 본다(8 미만).
  assert.equal(productAutoRepairCandidate(candidateRow({ retry_count: null }), { now: NOW }), true);
});

test("36h 경계: 정확히 36h 는 제외(strict), 36h+1분은 후보 — SQL 의 lt 와 같은 방향", () => {
  assert.equal(productAutoRepairCandidate(candidateRow({ last_checked_at: ago(RANK_STUCK_TRACKER_MS) }), { now: NOW }), false);
  assert.equal(productAutoRepairCandidate(candidateRow({ last_checked_at: ago(RANK_STUCK_TRACKER_MS + MINUTE) }), { now: NOW }), true);
  assert.equal(productAutoRepairCandidate(candidateRow({ last_checked_at: ago(35 * HOUR) }), { now: NOW }), false);
});

test("한 번도 성공한 적 없으면 created_at 이 앵커다(둘 다 없으면 무증거 → 제외)", () => {
  assert.equal(productAutoRepairCandidate(candidateRow({ last_checked_at: null, created_at: ago(2 * DAY) }), { now: NOW }), true);
  assert.equal(productAutoRepairCandidate(candidateRow({ last_checked_at: null, created_at: ago(10 * HOUR) }), { now: NOW }), false);
  assert.equal(productAutoRepairCandidate(candidateRow({ last_checked_at: null, created_at: null }), { now: NOW }), false);
  assert.equal(productAutoRepairCandidate(candidateRow({ last_checked_at: "bad", created_at: "bad" }), { now: NOW }), false);
});

test("만성 격리 표식(수집 방식 점검 중)이 붙은 행은 격리 담당이라 제외", () => {
  assert.equal(
    productAutoRepairCandidate(candidateRow({ last_message: RANK_CHRONIC_ISOLATION_MESSAGE }), { now: NOW }),
    false,
  );
  // 표식이 접두사가 아니면(다른 문구) 후보다.
  assert.equal(productAutoRepairCandidate(candidateRow({ last_message: null }), { now: NOW }), true);
});

test("상수: 배치 10·하루 1회·reason auto_repair·기존 RPC 이름", () => {
  assert.equal(RANK_AUTO_REPAIR_BATCH_LIMIT, 10);
  assert.equal(RANK_AUTO_REPAIR_INTERVAL_MS, DAY);
  assert.equal(RANK_AUTO_REPAIR_REASON, "auto_repair");
  assert.equal(RANK_AUTO_REPAIR_RPC, "mi_enqueue_naver_shopping_repair_priority");
  // RPC 의 reason 제약(^[a-z0-9][a-z0-9:_-]{2,63}$)을 통과해야 한다.
  assert.match(RANK_AUTO_REPAIR_REASON, /^[a-z0-9][a-z0-9:_-]{2,63}$/);
});

// ─────────────────────────────────────────────────────────────
// 2. runProductAutoRepairPass — 스텁 supabase 클라이언트
// ─────────────────────────────────────────────────────────────
function createSupabaseStub({
  trackers = [],
  requests = [],
  items = [],
  readErrors = {},
  rpcResult = { data: { accepted: true, idempotent: false, queuedCount: null }, error: null },
  rpcThrows = null,
} = {}) {
  const calls = { reads: [], rpcs: [] };
  const rowsFor = { [TRACKERS_TABLE]: trackers, [REQUESTS_TABLE]: requests, [ITEMS_TABLE]: items };

  const makeChain = (table) => {
    const filters = [];
    const chain = {
      _columns: "",
      select(columns) { chain._columns = columns; return chain; },
      eq(column, value) { filters.push({ op: "eq", column, value }); return chain; },
      not(column, operator, value) { filters.push({ op: "not", column, operator, value }); return chain; },
      lt(column, value) { filters.push({ op: "lt", column, value }); return chain; },
      gte(column, value) { filters.push({ op: "gte", column, value }); return chain; },
      in(column, values) { filters.push({ op: "in", column, values }); return chain; },
      or(expression) { filters.push({ op: "or", expression }); return chain; },
      order(column, options) { filters.push({ op: "order", column, options }); return chain; },
      limit(value) { filters.push({ op: "limit", value }); return chain; },
      then(onFulfilled, onRejected) {
        calls.reads.push({ table, columns: chain._columns, filters });
        const result = readErrors[table]
          ? { data: null, error: readErrors[table] }
          : { data: (rowsFor[table] || []).map((row) => ({ ...row })), error: null };
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
          return { select(columns) { return makeChain(table).select(columns); } };
        },
        async rpc(name, args) {
          calls.rpcs.push({ name, args });
          if (rpcThrows) throw rpcThrows;
          const data = rpcResult.data && rpcResult.data.queuedCount === null
            ? { ...rpcResult.data, queuedCount: (args.p_tracker_ids || []).length }
            : rpcResult.data;
          return { data, error: rpcResult.error };
        },
      },
    },
  };
}

const readsOf = (stub, table) => stub.calls.reads.filter((read) => read.table === table);
const passOptions = (extra = {}) => ({ now: NOW, force: true, requestId: uuidAt(999), ...extra });

test("후보가 있으면 기존 RPC 를 reason=auto_repair 로 한 번 부르고 accepted 를 기록한다", async () => {
  const stub = createSupabaseStub({ trackers: [candidateRow(), candidateRow({ id: uuidAt(2) })] });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());

  assert.equal(result.table, TRACKERS_TABLE);
  assert.equal(result.scanned, 2);
  assert.equal(result.selected, 2);
  assert.equal(result.accepted, true);
  assert.equal(result.blockedByAccountPriority, false);
  assert.equal(result.alreadyQueued, false);
  assert.equal(result.enqueued, 2);
  assert.equal(result.failed, undefined);
  assert.equal(result.requestId, uuidAt(999));

  assert.equal(stub.calls.rpcs.length, 1);
  const [rpc] = stub.calls.rpcs;
  assert.equal(rpc.name, RANK_AUTO_REPAIR_RPC);
  assert.equal(rpc.args.p_reason, RANK_AUTO_REPAIR_REASON);
  assert.equal(rpc.args.p_request_id, uuidAt(999));
  assert.deepEqual(rpc.args.p_tracker_ids, [uuidAt(1), uuidAt(2)]);
});

test("requestId 를 주지 않으면 v4 UUID 를 스스로 만든다", async () => {
  const stub = createSupabaseStub({ trackers: [candidateRow()] });
  const result = await runProductAutoRepairPass(stub.ctx, { now: NOW, force: true });
  assert.match(result.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stub.calls.rpcs[0].args.p_request_id, result.requestId);
});

test("한 번에 최대 10건만 넘긴다(RPC 의 tracker_count 상한)", async () => {
  const trackers = Array.from({ length: 15 }, (_, index) => candidateRow({ id: uuidAt(index + 1) }));
  const stub = createSupabaseStub({ trackers });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.scanned, 15);
  assert.equal(result.selected, RANK_AUTO_REPAIR_BATCH_LIMIT);
  assert.equal(stub.calls.rpcs[0].args.p_tracker_ids.length, RANK_AUTO_REPAIR_BATCH_LIMIT);
  assert.equal(result.enqueued, RANK_AUTO_REPAIR_BATCH_LIMIT);
});

test("후보 SELECT 는 status·last_error·retry_count<8·36h 컷오프를 DB 로 민다", async () => {
  const stub = createSupabaseStub({ trackers: [] });
  await runProductAutoRepairPass(stub.ctx, passOptions());
  const [read] = readsOf(stub, TRACKERS_TABLE);
  assert.ok(read, "추적기 SELECT 가 나가야 한다");
  assert.ok(read.filters.some((f) => f.op === "eq" && f.column === "status" && f.value === "active"));
  assert.ok(read.filters.some((f) => f.op === "not" && f.column === "last_error" && f.operator === "is" && f.value === null));
  assert.ok(read.filters.some((f) => f.op === "lt" && f.column === "retry_count" && f.value === RANK_RETRY_EXHAUSTED_AT));
  const or = read.filters.find((f) => f.op === "or");
  assert.ok(or, "36h 컷오프 OR 이 있어야 한다");
  assert.ok(or.expression.startsWith("last_checked_at.lt."), or.expression);
  assert.ok(or.expression.includes("and(last_checked_at.is.null,created_at.lt."), or.expression);
  const cutoffs = [...or.expression.matchAll(/\.lt\.([0-9TZ:.\-]+)/g)].map((match) => Date.parse(match[1]));
  assert.equal(cutoffs.length, 2);
  assert.equal(cutoffs[0], NOW - RANK_STUCK_TRACKER_MS);
  assert.equal(cutoffs[1], NOW - RANK_STUCK_TRACKER_MS);
  for (const column of ["last_checked_at", "created_at", "last_message", "retry_count", "last_error", "status"]) {
    assert.ok(read.columns.includes(column), `SELECT 에 ${column} 이 실려야 JS 판정이 성립한다`);
  }
  // 후보가 없으면 RPC 를 부르지 않는다.
  assert.equal(stub.calls.rpcs.length, 0);
});

test("DB 가 돌려준 행도 순수 판정으로 다시 거른다(격리 표식·retry 8·미달 정체)", async () => {
  const stub = createSupabaseStub({
    trackers: [
      candidateRow({ id: uuidAt(1) }),
      candidateRow({ id: uuidAt(2), last_message: RANK_CHRONIC_ISOLATION_MESSAGE }),
      candidateRow({ id: uuidAt(3), retry_count: RANK_RETRY_EXHAUSTED_AT }),
      candidateRow({ id: uuidAt(4), last_checked_at: ago(30 * HOUR) }),
    ],
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.scanned, 4);
  assert.equal(result.selected, 1);
  assert.deepEqual(stub.calls.rpcs[0].args.p_tracker_ids, [uuidAt(1)]);
});

// ── 하루 1회 게이트 ───────────────────────────────────────────
test("최근 24h 안에 auto_repair 요청이 있으면 이번 틱은 건너뛴다(추적기 SELECT·RPC 없음)", async () => {
  const stub = createSupabaseStub({
    trackers: [candidateRow()],
    requests: [{ request_id: uuidAt(50), reason: RANK_AUTO_REPAIR_REASON, requested_at: ago(2 * HOUR) }],
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.ranToday, true);
  assert.equal(result.selected, 0);
  assert.equal(result.enqueued, 0);
  assert.equal(result.lastRequestedAt, ago(2 * HOUR));
  assert.equal(readsOf(stub, TRACKERS_TABLE).length, 0, "이미 오늘 돌았으면 추적기를 읽지 않는다");
  assert.equal(stub.calls.rpcs.length, 0);
});

test("하루 1회 판정은 requests.requested_at 을 24h 컷오프로 읽는다", async () => {
  const stub = createSupabaseStub({ trackers: [candidateRow()] });
  await runProductAutoRepairPass(stub.ctx, passOptions());
  const [read] = readsOf(stub, REQUESTS_TABLE);
  assert.ok(read, "requests SELECT 가 나가야 한다");
  const gte = read.filters.find((f) => f.op === "gte" && f.column === "requested_at");
  assert.ok(gte);
  assert.equal(Date.parse(gte.value), NOW - RANK_AUTO_REPAIR_INTERVAL_MS);
});

test("24h 를 넘긴 auto_repair 요청은 게이트를 막지 않는다(경계: 24h+1분)", async () => {
  // 스텁은 필터를 적용하지 않으므로 DB 컷오프 밖 행은 넘겨주지 않는다 — JS 이중 판정만 확인한다.
  const stub = createSupabaseStub({
    trackers: [candidateRow()],
    requests: [{ request_id: uuidAt(50), reason: RANK_AUTO_REPAIR_REASON, requested_at: ago(DAY + MINUTE) }],
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.ranToday, false);
  assert.equal(stub.calls.rpcs.length, 1);
});

test("다른 reason 의 최근 요청(수동 SQL)은 하루 1회 게이트를 막지 않는다", async () => {
  const stub = createSupabaseStub({
    trackers: [candidateRow()],
    requests: [{ request_id: uuidAt(50), reason: "manual_repair", requested_at: ago(1 * HOUR) }],
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.ranToday, false);
  assert.equal(stub.calls.rpcs.length, 1);
});

// ── 24h 중복 제외 ─────────────────────────────────────────────
test("최근 24h 내 repair 큐에 있었던 추적기는 제외한다(queued·consumed_at·requested_at 세 갈래)", async () => {
  const recentRequest = uuidAt(50);
  const oldRequest = uuidAt(51);
  const stub = createSupabaseStub({
    trackers: [
      candidateRow({ id: uuidAt(1) }), // 큐 이력 없음 → 선택
      candidateRow({ id: uuidAt(2) }), // 지금 queued → 제외
      candidateRow({ id: uuidAt(3) }), // 2h 전 consumed → 제외
      candidateRow({ id: uuidAt(4) }), // 최근 요청에 속함(consumed_at 없음) → 제외
      candidateRow({ id: uuidAt(5) }), // 30h 전 consumed, 오래된 요청 → 선택
    ],
    requests: [{ request_id: recentRequest, reason: "manual_repair", requested_at: ago(1 * HOUR) }],
    items: [
      { tracker_id: uuidAt(2), state: "queued", consumed_at: null, request_id: recentRequest },
      { tracker_id: uuidAt(3), state: "consumed", consumed_at: ago(2 * HOUR), request_id: oldRequest },
      { tracker_id: uuidAt(4), state: "queued", consumed_at: null, request_id: recentRequest },
      { tracker_id: uuidAt(5), state: "consumed", consumed_at: ago(30 * HOUR), request_id: oldRequest },
    ],
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.scanned, 5);
  assert.equal(result.recentlyQueued, 3);
  assert.equal(result.selected, 2);
  assert.deepEqual(stub.calls.rpcs[0].args.p_tracker_ids, [uuidAt(1), uuidAt(5)]);

  // items SELECT 는 후보 id 로 한정하고 세 갈래 OR 을 DB 로 민다.
  const [itemsRead] = readsOf(stub, ITEMS_TABLE);
  assert.ok(itemsRead);
  const inFilter = itemsRead.filters.find((f) => f.op === "in" && f.column === "tracker_id");
  assert.deepEqual(inFilter.values, [uuidAt(1), uuidAt(2), uuidAt(3), uuidAt(4), uuidAt(5)]);
  const or = itemsRead.filters.find((f) => f.op === "or");
  assert.ok(or.expression.includes("state.eq.queued"), or.expression);
  assert.ok(or.expression.includes(`consumed_at.gte.${ago(DAY)}`), or.expression);
  assert.ok(or.expression.includes(`request_id.in.(${recentRequest})`), or.expression);
});

test("후보 전부가 24h 내 큐에 있었으면 RPC 를 부르지 않는다", async () => {
  const stub = createSupabaseStub({
    trackers: [candidateRow({ id: uuidAt(1) })],
    items: [{ tracker_id: uuidAt(1), state: "consumed", consumed_at: ago(3 * HOUR), request_id: uuidAt(51) }],
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.selected, 0);
  assert.equal(result.enqueued, 0);
  assert.equal(stub.calls.rpcs.length, 0);
});

// ── RPC 거절 경로 · throw 없음 ────────────────────────────────
test("계정우선 게이트에 막히면 blockedByAccountPriority 를 기록하고 이번 틱은 건너뛴다", async () => {
  const stub = createSupabaseStub({
    trackers: [candidateRow()],
    rpcResult: { data: { accepted: false, idempotent: false, blockedByAccountPriority: true, queuedCount: 0, wakeRequested: false }, error: null },
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.accepted, false);
  assert.equal(result.blockedByAccountPriority, true);
  assert.equal(result.enqueued, 0);
  assert.equal(result.failed, undefined, "게이트 차단은 실패가 아니라 건너뜀이다");
});

test("RPC 가 already_queued 로 거절하면 alreadyQueued 를 기록하고 던지지 않는다", async () => {
  const stub = createSupabaseStub({
    trackers: [candidateRow()],
    rpcResult: { data: null, error: { message: "naver_shopping_repair_priority_already_queued", code: "P0001" } },
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.accepted, false);
  assert.equal(result.alreadyQueued, true);
  assert.equal(result.enqueued, 0);
  assert.equal(result.failed, undefined);
});

test("그 밖의 RPC 오류는 failed 로 접히고 던지지 않는다", async () => {
  const stub = createSupabaseStub({
    trackers: [candidateRow()],
    rpcResult: { data: null, error: { message: "naver_shopping_repair_priority_tracker_inactive" } },
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.failed, true);
  assert.equal(result.accepted, false);
  assert.equal(result.enqueued, 0);
  assert.ok(String(result.error).includes("tracker_inactive"));
});

test("RPC 호출 자체가 reject 되어도 던지지 않는다", async () => {
  const stub = createSupabaseStub({ trackers: [candidateRow()], rpcThrows: new Error("socket hang up") });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.failed, true);
  assert.equal(result.enqueued, 0);
});

test("읽기 실패(requests·trackers·items 각각)는 failed 로 접히고 RPC 를 부르지 않는다", async () => {
  for (const table of [REQUESTS_TABLE, TRACKERS_TABLE, ITEMS_TABLE]) {
    const stub = createSupabaseStub({
      trackers: [candidateRow()],
      readErrors: { [table]: new Error(`connection reset (${table})`) },
    });
    const result = await runProductAutoRepairPass(stub.ctx, passOptions());
    assert.equal(result.failed, true, table);
    assert.equal(result.enqueued, 0, table);
    assert.equal(stub.calls.rpcs.length, 0, `${table} 읽기가 실패하면 RPC 를 부르면 안 된다`);
  }
});

test("RPC 가 accepted 를 돌려줘도 queuedCount 가 없으면 넘긴 건수를 enqueued 로 쓴다", async () => {
  const stub = createSupabaseStub({
    trackers: [candidateRow(), candidateRow({ id: uuidAt(2) })],
    rpcResult: { data: { accepted: true, idempotent: false }, error: null },
  });
  const result = await runProductAutoRepairPass(stub.ctx, passOptions());
  assert.equal(result.enqueued, 2);
});

test("ctx 가 없어도 던지지 않는다", async () => {
  const result = await runProductAutoRepairPass(null, passOptions());
  assert.equal(result.failed, true);
  assert.equal(result.enqueued, 0);
});

test("같은 인스턴스에서 짧은 간격의 재호출은 스로틀된다(force 없음)", async () => {
  const stub = createSupabaseStub({ trackers: [candidateRow()] });
  const first = await runProductAutoRepairPass(stub.ctx, { now: NOW, force: true });
  assert.equal(first.accepted, true);
  const second = await runProductAutoRepairPass(stub.ctx, { now: NOW + MINUTE });
  assert.equal(second.throttled, true);
  assert.equal(second.enqueued, 0);
  assert.equal(stub.calls.rpcs.length, 1);
});

// ─────────────────────────────────────────────────────────────
// 3. 소스 드리프트 가드 — 플레이스 크론 배선
// ─────────────────────────────────────────────────────────────
test("플레이스 크론은 만성 격리 호출 옆(Promise.allSettled)에서 자동 재검증 패스를 부른다", () => {
  const placeCron = readRepoFile("src/server/handlers/naver-place-rank-cron.mjs");
  // 기존 import 줄은 rank-collection-stability.test.mjs F3 가 문자열로 대조하므로 그대로 둔다.
  assert.ok(placeCron.includes('import { runChronicIsolationPass, runPlaceRequeuePass } from "../naver-rank-requeue.mjs";'));
  assert.ok(placeCron.includes('import { runProductAutoRepairPass } from "../naver-rank-requeue.mjs";'));
  const settledAt = placeCron.indexOf("await Promise.allSettled([");
  const settledEnd = placeCron.indexOf("]);", settledAt);
  assert.ok(settledAt > 0 && settledEnd > settledAt);
  const settledBlock = placeCron.slice(settledAt, settledEnd);
  assert.ok(settledBlock.includes('runChronicIsolationPass(ctx, "naver_rank_trackers")'));
  assert.ok(settledBlock.includes("runProductAutoRepairPass(ctx)"), "자동 재검증은 allSettled 안에서 다른 레인과 격리되어 돌아야 한다");
  // drained/503 판정은 그 뒤 runDuePlaceTrackers 결과만 본다.
  const placeRunAt = placeCron.indexOf("const summary = await runDuePlaceTrackers(");
  assert.ok(placeRunAt > settledEnd);
});

test("자동 재검증은 새 테이블·마이그레이션 없이 기존 RPC 와 기존 표만 쓴다", () => {
  const requeueSource = readRepoFile("src/server/naver-rank-requeue.mjs");
  assert.ok(requeueSource.includes(`"${RANK_AUTO_REPAIR_RPC}"`));
  assert.ok(requeueSource.includes(`"${REQUESTS_TABLE}"`));
  assert.ok(requeueSource.includes(`"${ITEMS_TABLE}"`));
  // 상품 next_check_at·retry_count 를 직접 쓰지 않는다 — 큐에 넣기만 한다.
  const start = requeueSource.indexOf("async function productAutoRepairPass(");
  const end = requeueSource.indexOf("export async function runProductAutoRepairPass(", start);
  assert.ok(start > 0 && end > start);
  const block = requeueSource.slice(start, end);
  assert.ok(!block.includes(".update("), "자동 재검증 패스는 추적기 행을 직접 갱신하지 않는다");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RANK_TRACKER_ACCOUNT_TABLES,
  RANK_TRACKER_AUTO_PAUSE_LIMIT_MESSAGE,
  RANK_TRACKER_AUTO_PAUSE_MARK,
  RANK_TRACKER_AUTO_PAUSE_MESSAGE,
  RANK_TRACKER_AUTO_RESUME_MESSAGE,
  pauseAccountRankTrackers,
  resumeAccountRankTrackers,
} from "./rank-tracker-account-suspension.mjs";

// 실제 행 집합에 필터를 적용하는 스텁. 호출 문자열이 아니라 "어떤 행이 바뀌었는가"로
// 판정해야 유령 추적기 회귀를 잡을 수 있다. 지원하지 않는 표현식은 조용히 통과시키지
// 않고 즉시 실패시킨다 — 술어가 바뀌면 테스트가 먼저 깨져야 한다.
function orPredicate(expression) {
  const terms = String(expression).split(",").map((term) => {
    const trimmed = term.trim();
    const isNull = /^([a-z_]+)\.is\.null$/.exec(trimmed);
    if (isNull) return (row) => row[isNull[1]] === null || row[isNull[1]] === undefined;
    const compare = /^([a-z_]+)\.(lt|gte)\.(.+)$/.exec(trimmed);
    assert.ok(compare, `테스트 스텁이 지원하지 않는 or() 표현식입니다: ${term}`);
    const [, column, operator, value] = compare;
    return (row) => {
      const current = row[column];
      if (current === null || current === undefined) return false;
      return operator === "lt" ? String(current) < value : String(current) >= value;
    };
  });
  return (row) => terms.some((matches) => matches(row));
}

function rowStore(rowsByTable = {}, options = {}) {
  const rows = JSON.parse(JSON.stringify(rowsByTable));
  const errors = options.errors || {};
  const limitErrorIds = new Set(options.limitErrorIds || []);
  const supabaseAdmin = {
    from(table) {
      const filters = [];
      let operation = "select";
      let patch = null;
      let counting = false;
      const failure = errors[table] || null;
      const select = (rowSet) => rowSet.filter((row) => filters.every((matches) => matches(row)));
      const apply = () => {
        const matched = select(rows[table] || []);
        if (operation !== "update") return matched;
        const limited = matched.find((row) => limitErrorIds.has(row.id));
        if (limited) {
          return {
            error: { code: "P0001", message: "키워드 등록 한도 50개를 모두 사용했습니다." },
          };
        }
        matched.forEach((row) => Object.assign(row, patch));
        return matched;
      };
      const builder = {
        select(value, config) {
          if (operation !== "update") operation = "select";
          counting = Boolean(config && config.head);
          return builder;
        },
        update(value) { operation = "update"; patch = value; return builder; },
        eq(column, value) {
          filters.push((row) => String(row[column] ?? "") === String(value));
          return builder;
        },
        in(column, values) {
          filters.push((row) => values.includes(String(row[column] ?? "")));
          return builder;
        },
        gte(column, value) {
          filters.push((row) => row[column] !== null && row[column] !== undefined && String(row[column]) >= String(value));
          return builder;
        },
        like(column, pattern) {
          const prefix = String(pattern).replace(/%$/, "");
          filters.push((row) => String(row[column] ?? "").startsWith(prefix));
          return builder;
        },
        or(expression) { filters.push(orPredicate(expression)); return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle() {
          if (failure) return Promise.resolve({ data: null, error: failure });
          const result = apply();
          if (result && result.error) return Promise.resolve({ data: null, error: result.error });
          return Promise.resolve({ data: result[0] || null, error: null });
        },
        then(resolve, reject) {
          if (failure) return Promise.resolve({ data: null, count: null, error: failure }).then(resolve, reject);
          const result = apply();
          if (result && result.error) return Promise.resolve({ data: null, count: null, error: result.error }).then(resolve, reject);
          const payload = counting
            ? { data: null, count: result.length, error: null }
            : { data: result, count: result.length, error: null };
          return Promise.resolve(payload).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { rows, ctx: { supabaseAdmin } };
}

function productTracker(overrides = {}) {
  return {
    id: overrides.id || "p1",
    agency_code: "mml93-a02",
    status: "active",
    sort_order: 100,
    processing_until: null,
    processing_started_at: null,
    last_message: "추적 등록 후 첫 순위 확인 대기",
    ...overrides,
  };
}

function placeTracker(overrides = {}) {
  return productTracker({ id: "l1", ...overrides });
}

const FUTURE = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 30 * 60 * 1000).toISOString();

test("자동 중지 표식은 다른 곳에서 쓰지 않는 상수로 고정된다", async () => {
  assert.equal(RANK_TRACKER_AUTO_PAUSE_MARK, "[자동중지:계정해지]");
  assert.ok(RANK_TRACKER_AUTO_PAUSE_MESSAGE.startsWith(RANK_TRACKER_AUTO_PAUSE_MARK));
  assert.ok(RANK_TRACKER_AUTO_PAUSE_LIMIT_MESSAGE.startsWith(RANK_TRACKER_AUTO_PAUSE_MARK));
  // 복구 문구에 표식이 남으면 다음 복구가 이미 켜진 행을 다시 센다.
  assert.equal(RANK_TRACKER_AUTO_RESUME_MESSAGE.includes(RANK_TRACKER_AUTO_PAUSE_MARK), false);
  assert.deepEqual([...RANK_TRACKER_ACCOUNT_TABLES], ["naver_rank_trackers", "naver_place_rank_trackers"]);

  // 표식 문자열이 이 모듈 밖에서 등장하면 복구 대상 판정이 오염된다.
  const sources = await Promise.all([
    readFile(new URL("./handlers/naver-rank-trackers.mjs", import.meta.url), "utf8"),
    readFile(new URL("./handlers/naver-place-rank-trackers.mjs", import.meta.url), "utf8"),
    readFile(new URL("./handlers/naver-shopping-local-worker.mjs", import.meta.url), "utf8"),
  ]);
  sources.forEach((source) => assert.equal(source.includes(RANK_TRACKER_AUTO_PAUSE_MARK), false));
});

test("해지하면 두 레인의 활성 추적기가 표식과 함께 일시중지된다", async () => {
  const store = rowStore({
    naver_rank_trackers: [
      productTracker({ id: "p1" }),
      productTracker({ id: "p2", status: "paused", last_message: "광고주가 직접 중지" }),
      productTracker({ id: "p3", agency_code: "mml93-a09" }),
    ],
    naver_place_rank_trackers: [placeTracker({ id: "l1" })],
  });

  const summary = await pauseAccountRankTrackers(store.ctx, ["MML93-A02"]);

  assert.equal(summary.paused, 2);
  assert.equal(summary.busySkipped, 0);
  assert.deepEqual(summary.errors, []);
  const [p1, p2, p3] = store.rows.naver_rank_trackers;
  assert.equal(p1.status, "paused");
  assert.equal(p1.last_message, RANK_TRACKER_AUTO_PAUSE_MESSAGE);
  // 광고주가 직접 중지한 행은 표식을 얻지 않는다(복구 대상이 되면 안 된다).
  assert.equal(p2.last_message, "광고주가 직접 중지");
  // 다른 계정은 손대지 않는다.
  assert.equal(p3.status, "active");
  assert.equal(store.rows.naver_place_rank_trackers[0].status, "paused");
});

test("진행 중 수집(미래 리스)은 건너뛰고 그 수를 돌려준다", async () => {
  const store = rowStore({
    naver_rank_trackers: [
      productTracker({ id: "p1", processing_until: FUTURE }),
      productTracker({ id: "p2", processing_until: PAST }),
    ],
    naver_place_rank_trackers: [],
  });

  const summary = await pauseAccountRankTrackers(store.ctx, ["mml93-a02"]);

  assert.equal(summary.paused, 1);
  assert.equal(summary.busySkipped, 1);
  assert.equal(store.rows.naver_rank_trackers[0].status, "active");
  assert.equal(store.rows.naver_rank_trackers[1].status, "paused");
});

test("코드가 없으면 아무 질의도 하지 않는다", async () => {
  const exploding = { supabaseAdmin: { from() { throw new Error("no query expected"); } } };
  assert.deepEqual(await pauseAccountRankTrackers(exploding, []), {
    paused: 0, busySkipped: 0, lanes: {}, errors: [],
  });
  assert.deepEqual(await resumeAccountRankTrackers(exploding, [""]), {
    resumed: 0, limited: 0, lanes: {}, errors: [],
  });
});

test("재활성화는 표식이 있는 행만 되돌리고 표식을 지운다", async () => {
  const store = rowStore({
    naver_rank_trackers: [
      productTracker({ id: "p1", status: "paused", last_message: RANK_TRACKER_AUTO_PAUSE_MESSAGE, processing_until: PAST }),
      productTracker({ id: "p2", status: "paused", last_message: "광고주가 직접 중지" }),
    ],
    naver_place_rank_trackers: [
      placeTracker({ id: "l1", status: "paused", last_message: RANK_TRACKER_AUTO_PAUSE_MESSAGE }),
    ],
    clients: [{ agency_code: "mml93-a02", rank_keyword_limit: null }],
  });

  const summary = await resumeAccountRankTrackers(store.ctx, ["mml93-a02"]);

  assert.equal(summary.resumed, 2);
  assert.equal(summary.limited, 0);
  assert.deepEqual(summary.errors, []);
  const [p1, p2] = store.rows.naver_rank_trackers;
  assert.equal(p1.status, "active");
  assert.equal(p1.last_message, RANK_TRACKER_AUTO_RESUME_MESSAGE);
  assert.equal(p1.processing_until, null);
  assert.equal(p2.status, "paused");
  assert.equal(store.rows.naver_place_rank_trackers[0].status, "active");
});

test("한도가 가득 차면 되는 만큼만 복구하고 나머지는 사유를 남긴다", async () => {
  const active = Array.from({ length: 2 }, (unused, index) => productTracker({
    id: `a${index}`,
    status: "active",
  }));
  const store = rowStore({
    naver_rank_trackers: [
      ...active,
      productTracker({ id: "p1", status: "paused", last_message: RANK_TRACKER_AUTO_PAUSE_MESSAGE, sort_order: 100 }),
      productTracker({ id: "p2", status: "paused", last_message: RANK_TRACKER_AUTO_PAUSE_MESSAGE, sort_order: 200 }),
    ],
    naver_place_rank_trackers: [],
    clients: [{ agency_code: "mml93-a02", rank_keyword_limit: 3 }],
  });

  const summary = await resumeAccountRankTrackers(store.ctx, ["mml93-a02"]);

  assert.equal(summary.resumed, 1);
  assert.equal(summary.limited, 1);
  const p1 = store.rows.naver_rank_trackers.find((row) => row.id === "p1");
  const p2 = store.rows.naver_rank_trackers.find((row) => row.id === "p2");
  assert.equal(p1.status, "active");
  assert.equal(p2.status, "paused");
  assert.equal(p2.last_message, RANK_TRACKER_AUTO_PAUSE_LIMIT_MESSAGE);
  // 표식이 남아야 다음 재활성화에서 다시 시도된다.
  assert.ok(p2.last_message.startsWith(RANK_TRACKER_AUTO_PAUSE_MARK));
});

test("DB 한도 트리거(P0001)가 막아도 나머지 행은 계속 복구한다", async () => {
  const store = rowStore({
    naver_rank_trackers: [
      productTracker({ id: "p1", status: "paused", last_message: RANK_TRACKER_AUTO_PAUSE_MESSAGE, sort_order: 100 }),
    ],
    naver_place_rank_trackers: [
      placeTracker({ id: "l1", status: "paused", last_message: RANK_TRACKER_AUTO_PAUSE_MESSAGE }),
    ],
    clients: [{ agency_code: "mml93-a02", rank_keyword_limit: 50 }],
  }, { limitErrorIds: ["p1"] });

  const summary = await resumeAccountRankTrackers(store.ctx, ["mml93-a02"]);

  assert.equal(summary.resumed, 1);
  assert.equal(summary.limited, 1);
  assert.equal(store.rows.naver_rank_trackers[0].status, "paused");
  assert.equal(store.rows.naver_place_rank_trackers[0].status, "active");
});

test("한 레인 조회가 실패해도 다른 레인은 처리하고 오류를 보고한다", async () => {
  const store = rowStore({
    naver_rank_trackers: [productTracker({ id: "p1" })],
    naver_place_rank_trackers: [placeTracker({ id: "l1" })],
  }, { errors: { naver_place_rank_trackers: { message: "relation missing" } } });

  const summary = await pauseAccountRankTrackers(store.ctx, ["mml93-a02"]);

  assert.equal(summary.paused, 1);
  assert.equal(summary.errors.length, 2);
  assert.ok(summary.errors.every((message) => message.startsWith("naver_place_rank_trackers: ")));
});

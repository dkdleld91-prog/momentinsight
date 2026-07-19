import assert from "node:assert/strict";
import test from "node:test";

import {
  claimDueTracker,
  requestAccessCode,
  requestAgencyCode,
  runDueTrackers,
  runTrackerCheck,
  trackerPayload,
} from "./naver-rank-trackers.mjs";
import { findShoppingRank } from "./naver-shopping-rank.mjs";

const TRACKERS = "naver_rank_trackers";
const SNAPSHOTS = "naver_rank_snapshots";
const VALID_ENV = {
  openapiClientId: "test-client-id",
  openapiClientSecret: "test-client-secret",
};

test("trusted product-rank headers override conflicting body scope", () => {
  const request = new Request("https://example.com/api/naver-rank-trackers?agencyCode=mml93-a98", {
    headers: {
      "x-mi-agency-code": "mml93-a02",
      "x-mi-rank-access-code": "mml93-a02",
    },
  });
  const body = { agencyCode: "mml93-a99", accessCode: "mml93-a99" };
  assert.equal(requestAgencyCode(request, body), "mml93-a02");
  assert.equal(requestAccessCode(request, body), "mml93-a02");
});

test("a code-session request never falls back to body or query credentials", () => {
  const request = new Request("https://example.com/api/naver-rank-trackers?agencyCode=mml93-a98", {
    headers: { "x-mi-session-role": "team", "x-mi-session-scope": "account-only" },
  });
  const body = { agencyCode: "mml93-a99", accessCode: "mml93-a99" };
  assert.equal(requestAgencyCode(request, body), "");
  assert.equal(requestAccessCode(request, body), "");
});

function trackerRow(values = {}) {
  return {
    id: "tracker-1",
    client_id: "client-1",
    brand_id: null,
    agency_code: "mml93-a01",
    keyword: "테스트 상품",
    product_url: "https://smartstore.naver.com/test/products/1234567890",
    product_id: "1234567890",
    mall_name: "테스트몰",
    product_title: "테스트 상품",
    max_rank: 300,
    status: "active",
    started_at: "2026-07-01T00:00:00.000Z",
    ends_at: null,
    last_checked_at: "2026-07-15T00:00:00.000Z",
    next_check_at: "2026-07-16T00:00:00.000Z",
    current_rank: 27,
    best_rank: 11,
    worst_rank: 42,
    check_count: 9,
    found_count: 8,
    last_message: "마지막 정상 순위는 27위입니다.",
    last_error: null,
    retry_count: 0,
    sort_order: 100,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    ...values,
  };
}

class MockQuery {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.operation = "select";
    this.values = null;
    this.filters = [];
  }

  update(values) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  insert(values) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  select() {
    return this;
  }

  single() {
    return this.execute(true);
  }

  maybeSingle() {
    return this.execute(true, true);
  }

  then(resolve, reject) {
    return this.execute(false).then(resolve, reject);
  }

  async execute(single, allowMissing = false) {
    const rows = this.state.tables[this.table] || [];
    const matches = (row) => this.filters.every((filter) => filter(row));
    let selected = rows.filter(matches);

    if (this.operation === "update") {
      this.state.updates.push({ table: this.table, values: { ...this.values } });
      selected.forEach((row) => Object.assign(row, this.values));
    } else if (this.operation === "insert") {
      const inserted = {
        id: `snapshot-${this.state.nextId++}`,
        created_at: new Date().toISOString(),
        ...this.values,
      };
      rows.push(inserted);
      selected = [inserted];
    }

    if (single) {
      return selected.length === 1
        ? { data: selected[0], error: null }
        : (allowMissing
          ? { data: null, error: null }
          : { data: null, error: { message: "single row not found" } });
    }
    return { data: selected, error: null };
  }
}

function testContext(tracker) {
  const state = {
    nextId: 1,
    updates: [],
    tables: {
      [TRACKERS]: [{ ...tracker }],
      [SNAPSHOTS]: [],
    },
  };
  return {
    state,
    ctx: {
      supabaseAdmin: {
        from(table) {
          return new MockQuery(state, table);
        },
      },
    },
  };
}

function assertPreserved(previous, current) {
  assert.equal(current.current_rank, previous.current_rank);
  assert.equal(current.best_rank, previous.best_rank);
  assert.equal(current.worst_rank, previous.worst_rank);
  assert.equal(current.check_count, previous.check_count);
  assert.equal(current.found_count, previous.found_count);
  assert.equal(current.last_checked_at, previous.last_checked_at);
}

function assertRetryTime(nextCheckAt, startedAt, finishedAt, minutes) {
  const value = Date.parse(nextCheckAt);
  assert.ok(value >= startedAt + minutes * 60 * 1000, `retry must be at least ${minutes} minutes later`);
  assert.ok(value <= finishedAt + minutes * 60 * 1000 + 100, `retry must be about ${minutes} minutes later`);
}

test("missing shopping API config preserves the last good rank and schedules a five-minute retry", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);
  let lookupCalled = false;
  const startedAt = Date.now();

  const result = await runTrackerCheck(ctx, tracker, {
    env: {},
    findShoppingRank: async () => {
      lookupCalled = true;
      return {};
    },
  });
  const finishedAt = Date.now();
  const current = state.tables[TRACKERS][0];

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_api_not_configured");
  assert.equal(lookupCalled, false);
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, current);
  assert.equal(current.last_error, "shopping_api_not_configured");
  assert.equal(current.retry_count, 1);
  assert.match(current.last_message, /마지막 정상 순위는 유지/);
  assertRetryTime(current.next_check_at, startedAt, finishedAt, 5);
  assert.deepEqual(Object.keys(state.updates[0].values).sort(), [
    "last_error",
    "last_message",
    "next_check_at",
    "retry_count",
  ]);
});

test("shopping lookup exceptions preserve history and use exponential retry backoff", async () => {
  const tracker = trackerRow({ retry_count: 2 });
  const { ctx, state } = testContext(tracker);
  const startedAt = Date.now();

  const result = await runTrackerCheck(ctx, tracker, {
    env: VALID_ENV,
    findShoppingRank: async () => {
      throw new Error("naver lookup timeout");
    },
  });
  const finishedAt = Date.now();
  const current = state.tables[TRACKERS][0];

  assert.equal(result.ok, false);
  assert.equal(result.error, "naver lookup timeout");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, current);
  assert.equal(current.last_error, "naver lookup timeout");
  assert.equal(current.retry_count, 3);
  assert.match(current.last_message, /자동 재시도/);
  assertRetryTime(current.next_check_at, startedAt, finishedAt, 20);
});

test("a valid not-found response still records a checked snapshot", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: VALID_ENV,
    findShoppingRank: async () => ({
      matched: false,
      rank: null,
      checkedCount: 300,
      total: 300,
      productExposureItems: [],
      topItems: [],
    }),
  });
  const current = state.tables[TRACKERS][0];

  assert.equal(result.ok, true);
  assert.equal(state.tables[SNAPSHOTS].length, 1);
  assert.equal(state.tables[SNAPSHOTS][0].matched, false);
  assert.equal(state.tables[SNAPSHOTS][0].checked_count, 300);
  assert.equal(current.current_rank, null);
  assert.equal(current.check_count, tracker.check_count + 1);
  assert.notEqual(current.last_checked_at, tracker.last_checked_at);
  assert.equal(current.last_error, null);
  assert.equal(current.retry_count, 0);
});

test("an empty product provider response preserves the last confirmed rank", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: VALID_ENV,
    findShoppingRank: async () => ({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_rank_provider_invalid_response");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, state.tables[TRACKERS][0]);
  assert.equal(state.tables[TRACKERS][0].retry_count, 1);
});

test("a failed create or manual check can serialize a tracker without a snapshot", () => {
  const payload = trackerPayload(trackerRow(), [undefined]);
  assert.deepEqual(payload.snapshots, []);
  assert.equal(payload.currentRank, 27);
});

test("the real shopping lookup rejects an empty 2xx payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(
      findShoppingRank(VALID_ENV, {
        keyword: "테스트 상품",
        targetProductId: "1234567890",
        maxRank: 300,
      }),
      /shopping_rank_provider_invalid_response/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a short shopping page with more advertised results remains incomplete", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ total: 500, items: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const result = await findShoppingRank(VALID_ENV, {
      keyword: "테스트 상품",
      targetProductId: "1234567890",
      maxRank: 300,
    });
    assert.equal(result.matched, false);
    assert.equal(result.complete, false);
    assert.equal(result.stopReason, "api_window_incomplete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an incomplete product miss preserves rank and schedules retry", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: VALID_ENV,
    findShoppingRank: async () => ({
      matched: false,
      checkedCount: 62,
      complete: false,
      partial: true,
      productExposureItems: [],
      topItems: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_rank_lookup_incomplete");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, state.tables[TRACKERS][0]);
  assert.equal(state.tables[TRACKERS][0].retry_count, 1);
});

test("a fully exhausted short product result is a valid not-found check", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: VALID_ENV,
    findShoppingRank: async () => ({
      matched: false,
      checkedCount: 50,
      total: 50,
      complete: true,
      partial: false,
      productExposureItems: [],
      topItems: [],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(state.tables[SNAPSHOTS].length, 1);
  assert.equal(state.tables[TRACKERS][0].current_rank, null);
  assert.equal(state.tables[TRACKERS][0].check_count, tracker.check_count + 1);
});

test("a stale product-rank lease cannot insert a snapshot", async () => {
  const tracker = trackerRow({ processing_started_at: "2026-07-16T00:00:00.000Z" });
  const { ctx, state } = testContext(tracker);

  await assert.rejects(
    runTrackerCheck(ctx, tracker, {
      env: VALID_ENV,
      leaseStartedAt: "2026-07-16T00:05:00.000Z",
      findShoppingRank: async () => ({
        matched: true,
        rank: 9,
        checkedCount: 9,
        productExposureItems: [{ isExactTarget: true, isOrganic: true, rank: 9 }],
      }),
    }),
    /rank_tracker_lease_lost/,
  );

  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.updates.length, 0);
  assert.equal(state.tables[TRACKERS][0].current_rank, tracker.current_rank);
});

test("pausing a product tracker invalidates an in-flight lease before snapshot", async () => {
  const leaseStartedAt = "2026-07-16T00:00:00.000Z";
  const tracker = trackerRow({ processing_started_at: leaseStartedAt });
  const { ctx, state } = testContext(tracker);

  await assert.rejects(
    runTrackerCheck(ctx, tracker, {
      env: VALID_ENV,
      leaseStartedAt,
      findShoppingRank: async () => {
        state.tables[TRACKERS][0].status = "paused";
        state.tables[TRACKERS][0].processing_started_at = null;
        return {
          matched: true,
          rank: 9,
          checkedCount: 9,
          complete: true,
          productExposureItems: [{ isExactTarget: true, isOrganic: true, rank: 9 }],
        };
      },
    }),
    /rank_tracker_lease_lost/,
  );

  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.tables[TRACKERS][0].status, "paused");
  assert.equal(state.tables[TRACKERS][0].current_rank, tracker.current_rank);
});

test("missing product-rank lease columns fail closed", async () => {
  const query = {
    update() { return this; },
    eq() { return this; },
    lte() { return this; },
    or() { return this; },
    select() { return this; },
    async maybeSingle() {
      return {
        data: null,
        error: { message: "Could not find the processing_started_at column in the schema cache" },
      };
    },
  };
  const ctx = { supabaseAdmin: { from: () => query } };

  await assert.rejects(
    claimDueTracker(ctx, trackerRow(), "2026-07-16T00:00:00.000Z"),
    (error) => error?.code === "RANK_TRACKER_LEASE_SCHEMA_MISSING",
  );
});

test("an empty product-rank due queue reports drained", async () => {
  let queryCount = 0;
  const chain = (result) => ({
    select() { return this; },
    eq() { return this; },
    lte() { return this; },
    or() { return this; },
    order() { return this; },
    limit() { return this; },
    in() { return this; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  });
  const ctx = {
    supabaseAdmin: {
      from() {
        queryCount += 1;
        return chain(queryCount === 1
          ? { data: [], error: null }
          : { data: null, error: null, count: 0 });
      },
    },
  };

  const summary = await runDueTrackers(ctx, { limit: 1 });
  assert.equal(summary.checked, 0);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.drained, true);
  assert.equal(queryCount, 2);
});

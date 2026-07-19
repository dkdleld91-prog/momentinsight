import assert from "node:assert/strict";
import test from "node:test";

import {
  claimDueTracker,
  loadSnapshots as loadProductSnapshots,
  requestAccessCode,
  requestAgencyCode,
  runDueTrackers,
  runTrackerCheck,
  trackerPayload,
  verifiedRelatedCatalogIdFromSnapshots,
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

function pagedProductSnapshotContext(rows, options = {}) {
  const state = { ranges: [] };
  return {
    state,
    ctx: {
      supabaseAdmin: {
        from(table) {
          assert.equal(table, SNAPSHOTS);
          const query = {
            trackerIds: [],
            checkedAfter: "",
            checkedBefore: "",
            orders: [],
            rangeStart: 0,
            rangeEnd: 999,
            select() { return query; },
            in(column, values) {
              assert.equal(column, "tracker_id");
              query.trackerIds = values;
              return query;
            },
            gte(column, value) {
              assert.equal(column, "checked_at");
              query.checkedAfter = value;
              return query;
            },
            lte(column, value) {
              assert.equal(column, "checked_at");
              query.checkedBefore = value;
              return query;
            },
            order(column, orderOptions = {}) {
              query.orders.push({ column, ascending: orderOptions.ascending !== false });
              return query;
            },
            range(from, to) {
              query.rangeStart = from;
              query.rangeEnd = to;
              state.ranges.push({ from, to });
              return query;
            },
            then(resolve, reject) {
              let selected = rows
                .filter((row) => query.trackerIds.includes(row.tracker_id))
                .filter((row) => row.checked_at >= query.checkedAfter && row.checked_at <= query.checkedBefore);
              for (const { column, ascending } of [...query.orders].reverse()) {
                selected = [...selected].sort((left, right) => {
                  if (left[column] === right[column]) return 0;
                  const result = left[column] > right[column] ? 1 : -1;
                  return ascending ? result : -result;
                });
              }
              const count = selected.length;
              const start = options.stall ? 0 : query.rangeStart;
              const requestedEnd = options.stall ? query.rangeEnd - query.rangeStart : query.rangeEnd;
              const end = Number.isFinite(options.serverCap)
                ? Math.min(requestedEnd, start + options.serverCap - 1)
                : requestedEnd;
              return Promise.resolve({ data: selected.slice(start, end + 1), error: null, count }).then(resolve, reject);
            },
          };
          return query;
        },
      },
    },
  };
}

class MockQuery {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.operation = "select";
    this.values = null;
    this.filters = [];
    this.orders = [];
    this.rowLimit = Infinity;
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

  gte(column, value) {
    this.filters.push((row) => row[column] >= value);
    return this;
  }

  lte(column, value) {
    this.filters.push((row) => row[column] <= value);
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(value) {
    this.rowLimit = Math.max(0, Number(value || 0));
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

    for (const { column, ascending } of [...this.orders].reverse()) {
      selected = [...selected].sort((left, right) => {
        if (left[column] === right[column]) return 0;
        const comparison = left[column] > right[column] ? 1 : -1;
        return ascending ? comparison : -comparison;
      });
    }
    selected = selected.slice(0, this.rowLimit);

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

function testContext(tracker, snapshots = []) {
  const state = {
    nextId: 1,
    updates: [],
    tables: {
      [TRACKERS]: [{ ...tracker }],
      [SNAPSHOTS]: snapshots.map((snapshot) => ({ ...snapshot })),
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

function shoppingResultItem(index, overrides = {}) {
  const sellerProductId = String(80000000000 + index);
  return {
    productId: String(70000000000 + index),
    link: `https://smartstore.naver.com/other-store/products/${sellerProductId}`,
    title: `일반 상품 ${index}`,
    mallName: "다른판매처",
    brand: "다른브랜드",
    maker: "다른제조사",
    category1: "생활/건강",
    category2: "생활가전",
    productType: "2",
    ...overrides,
  };
}

async function withShoppingResults(items, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "openapi.naver.com");
    const start = Number(url.searchParams.get("start") || 1);
    return new Response(JSON.stringify({
      total: items.length,
      items: items.slice(start - 1, start - 1 + 100),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function verifiedCatalogSnapshot(overrides = {}) {
  return {
    id: "snapshot-verified-catalog",
    tracker_id: "tracker-1",
    checked_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    matched: true,
    rank: 16,
    item: {
      trackingRankSource: "related_catalog",
      relatedCatalogProductId: "57907660073",
      relatedCatalogRank: 16,
      rankPolicy: "organic_only",
      adExcluded: true,
    },
    ...overrides,
  };
}

test("only a prior matched organic snapshot can supply the continuity catalog id", () => {
  const now = Date.now();
  const snapshots = [
    verifiedCatalogSnapshot({
      id: "title-only-newer",
      checked_at: new Date(now).toISOString(),
      item: {
        title: "같은 제목처럼 보이는 다른 원부",
        productId: "99999999999",
        relatedCatalogRank: 1,
        trackingRankSource: "related_catalog",
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
    verifiedCatalogSnapshot({
      id: "ad-contaminated-newer",
      checked_at: new Date(now - 1000).toISOString(),
      item: {
        trackingRankSource: "related_catalog",
        relatedCatalogProductId: "88888888888",
        relatedCatalogRank: 2,
        rankPolicy: "organic_only",
        adExcluded: false,
      },
    }),
    verifiedCatalogSnapshot({ checked_at: new Date(now - 2000).toISOString() }),
  ];

  assert.equal(verifiedRelatedCatalogIdFromSnapshots(snapshots, "12649811979"), "57907660073");
  assert.equal(verifiedRelatedCatalogIdFromSnapshots([
    verifiedCatalogSnapshot({
      item: {
        trackingRankSource: "related_catalog",
        relatedCatalogProductId: "12649811979",
        relatedCatalogRank: 3,
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
  ], "12649811979"), "");
});

test("a tracker reuses the exact prior catalog id when the seller product is outside 300", async () => {
  const tracker = trackerRow({
    keyword: "음파 전동칫솔",
    product_id: "12649811979",
    product_url: "https://smartstore.naver.com/lav/products/12649811979",
  });
  const { ctx, state } = testContext(tracker, [verifiedCatalogSnapshot()]);
  let lookupOptions = null;

  const result = await runTrackerCheck(ctx, tracker, {
    env: VALID_ENV,
    findShoppingRank: async (_env, options) => {
      lookupOptions = options;
      return {
        matched: true,
        rank: 15,
        trackingRankSource: "related_catalog",
        exactProductRank: null,
        relatedCatalogRank: 15,
        checkedCount: 300,
        complete: true,
        partial: false,
        productExposureItems: [{
          rank: 15,
          productId: "57907660073",
          title: "라이브오랄스 오라원 회전법 음파전동칫솔",
          isRelatedCatalog: true,
          isOrganic: true,
          relationBasis: "prior_verified_catalog_id",
        }],
        topItems: [],
      };
    },
  });

  assert.equal(lookupOptions.verifiedRelatedCatalogId, "57907660073");
  assert.equal(result.ok, true);
  assert.equal(state.tables[TRACKERS][0].current_rank, 15);
  assert.equal(state.tables[SNAPSHOTS].length, 2);
  assert.equal(state.tables[SNAPSHOTS][1].rank, 15);
  assert.equal(state.tables[SNAPSHOTS][1].item.relatedCatalogProductId, "57907660073");
  assert.equal(state.tables[SNAPSHOTS][1].item.trackingRankSource, "related_catalog");
});

test("a complete miss clears the current rank only after exact product and verified catalog are both absent", async () => {
  const tracker = trackerRow({ product_id: "12649811979" });
  const { ctx, state } = testContext(tracker, [verifiedCatalogSnapshot()]);

  const result = await runTrackerCheck(ctx, tracker, {
    env: VALID_ENV,
    findShoppingRank: async (_env, options) => {
      assert.equal(options.verifiedRelatedCatalogId, "57907660073");
      return {
        matched: false,
        checkedCount: 300,
        total: 10000,
        complete: true,
        partial: false,
        verifiedRelatedCatalogId: options.verifiedRelatedCatalogId,
        productExposureItems: [],
        topItems: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(state.tables[TRACKERS][0].current_rank, null);
  assert.equal(state.tables[TRACKERS][0].found_count, tracker.found_count);
  assert.equal(state.tables[SNAPSHOTS].length, 2);
  assert.equal(state.tables[SNAPSHOTS][1].matched, false);
});

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

test("product rank history keeps up to 120 snapshots from the most recent 30 days", () => {
  const now = Date.now();
  const recent = Array.from({ length: 121 }, (_, index) => ({
    id: `recent-${index}`,
    tracker_id: "tracker-1",
    checked_at: new Date(now - index * 60 * 60 * 1000).toISOString(),
    rank: index + 1,
    matched: true,
    checked_count: 300,
    total: 300,
    item: {},
    message: "ok",
    source: "test",
    created_at: new Date(now).toISOString(),
  }));
  const older = {
    ...recent[0],
    id: "older-than-30-days",
    checked_at: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const payload = trackerPayload(trackerRow(), [...recent, older]);
  assert.equal(payload.snapshots.length, 120);
  assert.equal(payload.snapshots[0].id, "recent-0");
  assert.equal(payload.snapshots.at(-1).id, "recent-119");
  assert.equal(payload.snapshots.some((snapshot) => snapshot.id === "older-than-30-days"), false);
});

test("product snapshot loading paginates beyond 5000 rows without truncating tracker histories", async () => {
  const now = Date.now();
  const trackerIds = Array.from({ length: 60 }, (_, index) => `tracker-${index}`);
  const rows = trackerIds.flatMap((trackerId, trackerIndex) => {
    const count = trackerIndex === 0 ? 130 : 100;
    const recent = Array.from({ length: count }, (_, snapshotIndex) => ({
      id: `${trackerId}-recent-${snapshotIndex}`,
      tracker_id: trackerId,
      checked_at: new Date(now - snapshotIndex * 60 * 60 * 1000).toISOString(),
    }));
    return [...recent, {
      id: `${trackerId}-old`,
      tracker_id: trackerId,
      checked_at: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
    }];
  });
  const { ctx, state } = pagedProductSnapshotContext(rows, { serverCap: 250 });

  const grouped = await loadProductSnapshots(ctx, trackerIds);
  assert.equal(grouped.get("tracker-0").length, 120);
  trackerIds.slice(1).forEach((trackerId) => assert.equal(grouped.get(trackerId).length, 100));
  assert.equal(Array.from(grouped.values()).reduce((sum, snapshots) => sum + snapshots.length, 0), 6020);
  assert.ok(state.ranges.length > 20);
  assert.equal(Array.from(grouped.values()).flat().some((snapshot) => snapshot.id.endsWith("-old")), false);
});

test("product snapshot pagination fails instead of returning a silently incomplete page", async () => {
  const now = Date.now();
  const rows = [
    ...Array.from({ length: 1000 }, (_, index) => ({
      id: `dominant-${index}`,
      tracker_id: "tracker-dominant",
      checked_at: new Date(now - index * 1000).toISOString(),
    })),
    {
      id: "later-tracker-row",
      tracker_id: "tracker-later",
      checked_at: new Date(now - 2000 * 1000).toISOString(),
    },
  ];
  const { ctx } = pagedProductSnapshotContext(rows, { stall: true });

  await assert.rejects(
    loadProductSnapshots(ctx, ["tracker-dominant", "tracker-later"]),
    /rank_snapshot_pagination_stalled/,
  );
});

test("shopping lookup finds a prior verified catalog by exact id when the seller product is absent", async () => {
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[14] = shoppingResultItem(14, {
    productId: "57907660073",
    link: "https://search.shopping.naver.com/catalog/57907660073",
    title: "라이브오랄스 오라원 회전법 음파전동칫솔 진동 C타입 충전식",
    mallName: "네이버",
    brand: "라이브오랄스",
    maker: "라이브오랄스",
    category2: "구강청정기기",
    productType: "1",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(VALID_ENV, {
      keyword: "음파 전동칫솔",
      targetProductId: "12649811979",
      verifiedRelatedCatalogId: "57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 15);
    assert.equal(result.exactProductRank, null);
    assert.equal(result.relatedCatalogRank, 15);
    assert.equal(result.trackingRankSource, "related_catalog");
    assert.equal(result.matchEvidence, "prior_verified_catalog_id");
    assert.equal(result.relatedCatalogContinuityUsed, true);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.productExposureItems.length, 1);
    assert.equal(result.productExposureItems[0].productId, "57907660073");
    assert.equal(result.productExposureItems[0].relationBasis, "prior_verified_catalog_id");
  });
});

test("shopping lookup compares the exact seller product and verified catalog in one 300-result pass", async () => {
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[23] = shoppingResultItem(23, {
    productId: "57907660073",
    link: "https://search.shopping.naver.com/catalog/57907660073",
    title: "라이브오랄스 오라원 회전법 음파전동칫솔",
    mallName: "네이버",
    brand: "라이브오랄스",
    category2: "구강청정기기",
    productType: "1",
  });
  items[167] = shoppingResultItem(167, {
    productId: "98765432101",
    link: "https://smartstore.naver.com/lav/products/12649811979",
    title: "라이브오랄스 음파 전동칫솔 회전 IPX8 방수",
    mallName: "라이브오랄스",
    brand: "라이브오랄스",
    category2: "구강청정기기",
    productType: "3",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(VALID_ENV, {
      keyword: "전동칫솔",
      targetProductId: "12649811979",
      verifiedRelatedCatalogId: "57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 24);
    assert.equal(result.exactProductRank, 168);
    assert.equal(result.relatedCatalogRank, 24);
    assert.equal(result.trackingRankSource, "related_catalog");
    assert.equal(result.checkedCount, 300);
    assert.deepEqual(result.productExposureItems.map((item) => item.productId), [
      "57907660073",
      "98765432101",
    ]);
  });
});

test("shopping lookup does not claim a complete window when a later provider page is missing", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => shoppingResultItem(index));
  firstPage[9] = shoppingResultItem(9, {
    productId: "98765432101",
    link: "https://smartstore.naver.com/lav/products/12649811979",
    title: "라이브오랄스 음파 전동칫솔",
    mallName: "라이브오랄스",
    productType: "3",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const start = Number(url.searchParams.get("start") || 1);
    return new Response(JSON.stringify({
      total: 500,
      items: start === 1 ? firstPage : [],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await findShoppingRank(VALID_ENV, {
      keyword: "전동칫솔",
      targetProductId: "12649811979",
      verifiedRelatedCatalogId: "57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 10);
    assert.equal(result.checkedCount, 100);
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.equal(result.stopReason, "api_window_incomplete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shopping lookup never substitutes a title-similar catalog for the verified catalog id", async () => {
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[4] = shoppingResultItem(4, {
    productId: "99999999999",
    link: "https://search.shopping.naver.com/catalog/99999999999",
    title: "라이브오랄스 오라원 회전법 음파전동칫솔 진동 C타입 충전식",
    mallName: "네이버",
    brand: "라이브오랄스",
    maker: "라이브오랄스",
    category2: "구강청정기기",
    productType: "1",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(VALID_ENV, {
      keyword: "음파 전동칫솔",
      targetProductId: "12649811979",
      targetMallName: "라이브오랄스",
      targetProductTitle: "라이브오랄스 오라원 회전법 음파전동칫솔 진동 C타입 충전식",
      verifiedRelatedCatalogId: "57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, false);
    assert.equal(result.complete, true);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.verifiedRelatedCatalogId, "57907660073");
    assert.equal(result.relatedCatalogContinuityUsed, false);
  });
});

test("shopping lookup excludes an ad even when it carries the verified catalog id", async () => {
  const items = [
    shoppingResultItem(999, {
      productId: "57907660073",
      link: "https://search.shopping.naver.com/catalog/57907660073",
      productType: "1",
      isAdProduct: true,
    }),
    ...Array.from({ length: 300 }, (_, index) => shoppingResultItem(index)),
  ];

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(VALID_ENV, {
      keyword: "음파 전동칫솔",
      targetProductId: "12649811979",
      verifiedRelatedCatalogId: "57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, false);
    assert.equal(result.complete, true);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.excludedAdCount, 1);
  });
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

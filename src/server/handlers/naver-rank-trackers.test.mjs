import assert from "node:assert/strict";
import test from "node:test";

import {
  claimDueTracker,
  handleRankTrackersRequest,
  loadSnapshots as loadProductSnapshots,
  requestAccessCode,
  requestAgencyCode,
  runDueTrackers,
  runTrackerCheck,
  trackerPayload,
  verifiedRelatedCatalogIdFromSnapshots,
} from "./naver-rank-trackers.mjs";
import {
  hasShoppingRankConfig,
  isShoppingCollectorUnavailable,
  isShoppingRankSourceUnavailable,
  shoppingRankSourceStatus,
} from "../naver-shopping/source-status.mjs";
import {
  buildRankTarget,
  findShoppingRank,
  findShoppingRankFromWindow,
  isAdItem,
  NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
  shoppingProviderPageCache,
  trustedCollectorWindow,
} from "./naver-shopping-rank.mjs";

const TRACKERS = "naver_rank_trackers";
const SNAPSHOTS = "naver_rank_snapshots";
const LEGACY_ENV = {
  openapiClientId: "test-client-id",
  openapiClientSecret: "test-client-secret",
};
const COLLECTOR_ENV = {
  mode: "provider",
  providerUrl: "https://collector.example/rank",
  providerKey: "collector-key",
};

async function withoutShoppingCollector(callback) {
  const previousUrl = process.env.NAVER_SHOPPING_RANK_API_URL;
  const previousKey = process.env.NAVER_SHOPPING_RANK_API_KEY;
  const previousMode = process.env.NAVER_SHOPPING_RANK_MODE;
  delete process.env.NAVER_SHOPPING_RANK_API_URL;
  delete process.env.NAVER_SHOPPING_RANK_API_KEY;
  delete process.env.NAVER_SHOPPING_RANK_MODE;
  try {
    return await callback();
  } finally {
    if (previousUrl === undefined) delete process.env.NAVER_SHOPPING_RANK_API_URL;
    else process.env.NAVER_SHOPPING_RANK_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NAVER_SHOPPING_RANK_API_KEY;
    else process.env.NAVER_SHOPPING_RANK_API_KEY = previousKey;
    if (previousMode === undefined) delete process.env.NAVER_SHOPPING_RANK_MODE;
    else process.env.NAVER_SHOPPING_RANK_MODE = previousMode;
  }
}

async function withShoppingHybrid(callback) {
  const keys = [
    "NAVER_SHOPPING_RANK_MODE",
    "MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED",
    "MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NAVER_SHOPPING_RANK_MODE = "hybrid_local_worker";
  process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED = "true";
  process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET = "test-local-worker-secret-that-is-longer-than-32-bytes";
  try {
    return await callback();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("product-rank readiness accepts only the verified collector pair", () => {
  assert.equal(hasShoppingRankConfig(LEGACY_ENV), false);
  assert.equal(hasShoppingRankConfig({ mode: "provider", providerUrl: COLLECTOR_ENV.providerUrl }), false);
  assert.equal(hasShoppingRankConfig(COLLECTOR_ENV), true);
  assert.deepEqual(shoppingRankSourceStatus(LEGACY_ENV), {
    rankSourceReady: false,
    configured: false,
    mode: "",
    coverage: "none",
    fullCoverageReady: false,
    preserveOnMiss: false,
    localWorkerEnabled: false,
    localWorkerSecretReady: false,
    errorCode: "SHOPPING_RANK_SOURCE_NOT_CONFIGURED",
    retryable: false,
  });
});

test("seller product URLs cannot be poisoned into catalog mode by query parameters", () => {
  const target = buildRankTarget({
    targetProductId: "12149720593",
    targetUrl: "https://smartstore.naver.com/haedenprime/products/12149720593?catalogId=59031763223",
  });
  assert.equal(target.targetMode, "product");
  assert.equal(target.catalogIds.length, 0);
  assert.deepEqual(target.productIds, ["12149720593"]);
});

test("canonical product paths ignore conflicting product query identifiers", () => {
  const target = buildRankTarget({
    targetUrl: "https://smartstore.naver.com/haedenprime/products/12149720593?nvMid=59031763223&productId=77777777777",
  });
  assert.deepEqual(target.productIds, ["12149720593"]);
  assert.equal(target.catalogIds.length, 0);
  assert.equal(target.targetMode, "product");
});

test("non-Naver catalog URLs cannot poison exact catalog matching", () => {
  const target = buildRankTarget({
    targetProductId: "12149720593",
    targetUrl: "https://evil.example/catalog/59031763223",
  });
  assert.equal(target.catalogIds.includes("59031763223"), false);
  assert.equal(target.targetMode, "product");
});

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

test("an account-only team lists an isolated product-rank scope without a client row", async () => {
  const teamCode = "mml93-t01";
  const request = new Request("https://example.com/api/naver-rank-trackers", {
    headers: {
      "x-mi-session-role": "team",
      "x-mi-session-scope": "account-only",
      "x-mi-team-code": teamCode,
      "x-mi-agency-code": teamCode,
      "x-mi-rank-access-code": teamCode,
    },
  });
  const ctx = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, TRACKERS);
        const query = {
          select() { return query; },
          in(column, values) {
            assert.equal(column, "agency_code");
            assert.deepEqual(values, [teamCode]);
            return query;
          },
          order() { return query; },
          limit() { return query; },
          then(resolve, reject) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };
  const response = await withoutShoppingCollector(() => handleRankTrackersRequest(request, ctx));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.scopeAgencyCode, teamCode);
  assert.equal(body.scopeClientId, "");
  assert.equal(body.scopeMode, "team-account");
  assert.equal(body.returnedCount, 0);
  assert.equal(body.complete, true);
  assert.equal(body.rankSourceReady, false);
  assert.equal(body.configured, false);
  assert.equal(body.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(body.retryable, false);
});

function productTeamAccountRequest(method, body, teamCode = "mml93-t01") {
  return new Request("https://example.com/api/naver-rank-trackers", {
    method,
    headers: {
      "content-type": "application/json",
      "x-mi-session-role": "team",
      "x-mi-session-scope": "account-only",
      "x-mi-team-code": teamCode,
      "x-mi-agency-code": teamCode,
      "x-mi-rank-access-code": teamCode,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("an account-only team reaches every product-rank action without advertiser scope", async () => {
  const forbiddenDb = {
    supabaseAdmin: {
      from() {
        throw new Error("action validation must run before database access");
      },
    },
  };
  for (const action of ["create", "check", "stop", "delete", "group", "move", "reorder"]) {
    const response = await handleRankTrackersRequest(productTeamAccountRequest("POST", { action }), forbiddenDb);
    assert.equal(response.status, 400, `${action} must reach its action validation`);
    const body = await response.json();
    assert.equal(body.ok, false, `${action} validation payload`);
    assert.notEqual(body.message, "등록된 대행사 코드를 확인할 수 없습니다.", `${action} must not require an advertiser`);
  }

  const emptyDueContext = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, TRACKERS);
        const query = {
          select() { return query; },
          eq() { return query; },
          lte() { return query; },
          or() { return query; },
          order() { return query; },
          limit() { return query; },
          in() { return query; },
          then(resolve, reject) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };
  const syncResponse = await withoutShoppingCollector(() => handleRankTrackersRequest(productTeamAccountRequest("POST", {
    action: "sync-due",
    limit: 1,
  }), emptyDueContext));
  const syncBody = await syncResponse.json();
  assert.equal(syncResponse.status, 503);
  assert.equal(syncBody.ok, false);
  assert.equal(syncBody.configured, false);
  assert.equal(syncBody.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(syncBody.retryable, false);
  assert.equal(syncBody.summary.checked, 0);
});

test("hybrid page sync leaves due rows queued for the signed Mac worker", async () => {
  const teamCode = "mml93-t01";
  let updateCalled = false;
  const ctx = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, TRACKERS);
        const query = {
          select() { return query; },
          eq() { return query; },
          lte() { return query; },
          or() { return query; },
          in(column, values) {
            assert.equal(column, "agency_code");
            assert.deepEqual(values, [teamCode]);
            return query;
          },
          update() {
            updateCalled = true;
            return query;
          },
          then(resolve, reject) {
            return Promise.resolve({ data: null, error: null, count: 2 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };

  const response = await withShoppingHybrid(() => handleRankTrackersRequest(productTeamAccountRequest("POST", {
    action: "sync-due",
    limit: 2,
  }, teamCode), ctx));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.queuedForLocalWorker, true);
  assert.equal(body.summary.checked, 0);
  assert.equal(body.summary.remaining, 2);
  assert.match(body.message, /중앙 Chrome 300위 갱신 대기 2건/u);
  assert.equal(updateCalled, false);
});

test("manual product refresh does not claim or update a row without the collector", async () => {
  const teamCode = "mml93-t01";
  const tracker = trackerRow({ agency_code: teamCode });
  let updateCalled = false;
  const ctx = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, TRACKERS);
        const query = {
          select() { return query; },
          eq() { return query; },
          in() { return query; },
          update() {
            updateCalled = true;
            return query;
          },
          async maybeSingle() {
            return { data: tracker, error: null };
          },
        };
        return query;
      },
    },
  };

  const response = await withoutShoppingCollector(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", { action: "check", trackerId: tracker.id }, teamCode),
    ctx,
  ));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.rankSourceReady, false);
  assert.equal(body.configured, false);
  assert.equal(body.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(body.retryable, false);
  assert.equal(updateCalled, false);
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
    this.head = false;
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

  in(column, values) {
    const allowed = new Set(values);
    this.filters.push((row) => allowed.has(row[column]));
    return this;
  }

  or(expression) {
    const prefix = "processing_until.is.null,processing_until.lt.";
    if (!String(expression).startsWith(prefix)) throw new Error(`unsupported test OR filter: ${expression}`);
    const threshold = String(expression).slice(prefix.length);
    this.filters.push((row) => row.processing_until == null || row.processing_until < threshold);
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

  select(_columns, options = {}) {
    this.head = options.head === true;
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
    const selectedCount = selected.length;

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

    if (this.head) return { data: null, error: null, count: selectedCount };
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

function collectorWindow(keyword, rawItems, options = {}) {
  const limit = Number(options.limit || 300);
  const excludedAdCount = rawItems.filter((item) => isAdItem(item)).length;
  const items = rawItems
    .filter((item) => !isAdItem(item))
    .slice(0, limit)
    .map((item, index) => ({
      ...item,
      organicRank: index + 1,
      isAd: false,
      isOrganic: true,
    }));
  const sourceExhausted = options.sourceExhausted ?? items.length < limit;
  const complete = options.complete ?? (items.length >= limit || sourceExhausted);
  const marketTotalStatus = options.marketTotalStatus || "verified";
  const marketTotal = marketTotalStatus === "unavailable"
    ? null
    : Number(options.marketTotal ?? rawItems.length);
  return {
    ok: true,
    schemaVersion: NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
    source: "naver_shopping_results_collector",
    rankEvidence: "naver_shopping_organic_list",
    keyword,
    collectionId: options.collectionId || "test-collection-1",
    collectedAt: options.collectedAt || "2026-08-01T00:00:00.000Z",
    complete,
    partial: !complete,
    sourceExhausted,
    marketTotal,
    marketTotalStatus,
    checkedCount: items.length,
    rawCount: Number(options.rawCount ?? rawItems.length),
    excludedAdCount: Number(options.excludedAdCount ?? excludedAdCount),
    items,
  };
}

async function withShoppingResults(items, callback) {
  const originalFetch = globalThis.fetch;
  shoppingProviderPageCache.clear();
  globalThis.fetch = async (input, options = {}) => {
    assert.equal(String(input), COLLECTOR_ENV.providerUrl);
    assert.equal(options.method, "POST");
    assert.equal(options.headers?.authorization, `Bearer ${COLLECTOR_ENV.providerKey}`);
    const body = JSON.parse(options.body || "{}");
    assert.equal(body.schemaVersion, NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA);
    assert.equal(body.sort, "relevance");
    assert.equal(body.rankPolicy, "organic_only");
    assert.ok(Number(body.limit) >= 1 && Number(body.limit) <= 300);
    return new Response(JSON.stringify(collectorWindow(body.keyword, items, { limit: body.limit })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return await callback();
  } finally {
    shoppingProviderPageCache.clear();
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
      relatedCatalogRelationBasis: "keyword_brand_category",
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

test("standalone seller-product evidence invalidates a previously stored catalog id", () => {
  const snapshots = [
    verifiedCatalogSnapshot({
      checked_at: new Date(Date.now() - 1000).toISOString(),
      item: {
        trackingRankSource: "related_catalog",
        relatedCatalogProductId: "59031763223",
        relatedCatalogRank: 3,
        relationBasis: "prior_verified_catalog_id",
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
    verifiedCatalogSnapshot({
      checked_at: new Date(Date.now() - 2000).toISOString(),
      item: {
        trackingRankSource: "exact_product",
        productType: "2",
        relatedCatalogProductId: "59031763223",
        relatedCatalogRank: 21,
        relatedCatalogRelationBasis: "keyword_brand_category",
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
  ];

  assert.equal(verifiedRelatedCatalogIdFromSnapshots(snapshots, "12149720593"), "");
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
    env: COLLECTOR_ENV,
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
    env: COLLECTOR_ENV,
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
  assert.equal(result.error, "shopping_rank_source_not_configured");
  assert.equal(result.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(result.retryable, false);
  assert.equal(result.rankSourceReady, false);
  assert.equal(result.configured, false);
  assert.equal(lookupCalled, false);
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, current);
  assert.equal(current.last_error, "shopping_rank_source_not_configured");
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
    env: COLLECTOR_ENV,
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

test("manual hybrid miss queues the exact tracker for the Mac 300-rank worker", async () => {
  const tracker = trackerRow({ retry_count: 2, last_error: "old_error" });
  const { ctx, state } = testContext(tracker);
  const startedAt = Date.now();

  const result = await runTrackerCheck(ctx, tracker, {
    env: {
      mode: "hybrid_local_worker",
      localWorkerEnabled: true,
      localWorkerSecretReady: true,
    },
    queueLocalWorker: true,
    findShoppingRank: async () => {
      throw new Error("shopping_rank_top_fallback_inconclusive");
    },
  });
  const finishedAt = Date.now();
  const current = state.tables[TRACKERS][0];
  const queuedAt = Date.parse(current.next_check_at);

  assert.equal(result.ok, false);
  assert.equal(result.preserved, true);
  assert.equal(result.queuedForLocalWorker, true);
  assert.equal(result.errorCode, "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, current);
  assert.equal(current.last_error, null);
  assert.equal(current.retry_count, 0);
  assert.ok(queuedAt >= startedAt && queuedAt <= finishedAt);
  assert.match(current.last_message, /중앙 Chrome 300위 갱신을 대기/u);
});

test("collector authentication and configuration failures fail closed without fast retry", async () => {
  for (const [failure, errorCode] of [
    [Object.assign(new Error("provider_unauthorized"), { status: 401 }), "SHOPPING_RANK_PROVIDER_UNAUTHORIZED"],
    [Object.assign(new Error("verified_provider_not_configured"), { status: 503 }), "SHOPPING_RANK_PROVIDER_MISCONFIGURED"],
  ]) {
    const tracker = trackerRow({ retry_count: 2 });
    const { ctx, state } = testContext(tracker);
    const result = await runTrackerCheck(ctx, tracker, {
      env: COLLECTOR_ENV,
      findShoppingRank: async () => { throw failure; },
    });
    const current = state.tables[TRACKERS][0];
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.retryable, false);
    assert.equal(result.rankSourceReady, false);
    assert.equal(state.tables[SNAPSHOTS].length, 0);
    assertPreserved(tracker, current);
  }
});

test("a removed legacy shopping endpoint preserves history and waits for the next regular slot", async () => {
  const tracker = trackerRow({ retry_count: 5 });
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => {
      throw new Error("Invalid search api (존재하지 않는 검색 api 입니다.)");
    },
  });
  const current = state.tables[TRACKERS][0];
  const next = new Date(current.next_check_at);
  const kstHour = (next.getUTCHours() + 9) % 24;

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_rank_source_unavailable");
  assert.equal(isShoppingRankSourceUnavailable("Invalid search api (존재하지 않는 검색 api 입니다.)"), true);
  assert.equal(isShoppingRankSourceUnavailable("provider_not_ready"), false);
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, current);
  assert.equal(current.last_error, "shopping_rank_source_unavailable");
  assert.equal(current.retry_count, 6);
  assert.match(current.last_message, /마지막 정상 순위와 30일 기록은 유지/);
  assert.ok([9, 15].includes(kstHour));
  assert.equal(next.getUTCMinutes(), 0);
});

test("the external shopping collector requires native organic evidence", () => {
  const trusted = trustedCollectorWindow(collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 }), {
    keyword: "테스트 상품",
    maxRank: 1,
  });
  assert.equal(trusted.items.length, 1);
  assert.equal(trusted.rankEvidence, "naver_shopping_organic_list");
  assert.equal(trusted.collectionId, "test-collection-1");

  const unavailableTotal = trustedCollectorWindow(collectorWindow(
    "테스트 상품",
    [shoppingResultItem(0)],
    { limit: 1, marketTotalStatus: "unavailable" },
  ), { keyword: "테스트 상품", maxRank: 1 });
  assert.equal(unavailableTotal.marketTotal, null);
  assert.equal(unavailableTotal.marketTotalStatus, "unavailable");
  assert.equal(unavailableTotal.checkedCount, 1);

  assert.throws(() => trustedCollectorWindow({
    ...collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 }),
    source: "unverified_serp",
    rankEvidence: "provider_array_order",
  }, { keyword: "테스트 상품", maxRank: 1 }), /shopping_rank_provider_untrusted_evidence/);

  const nonSequential = collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 });
  nonSequential.items[0].organicRank = 2;
  assert.throws(
    () => trustedCollectorWindow(nonSequential, { keyword: "테스트 상품", maxRank: 1 }),
    /shopping_rank_provider_untrusted_evidence/,
  );

  const contaminated = collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 });
  contaminated.items[0].isAd = true;
  assert.throws(
    () => trustedCollectorWindow(contaminated, { keyword: "테스트 상품", maxRank: 1 }),
    /shopping_rank_provider_untrusted_evidence/,
  );

  const duplicate = collectorWindow("테스트 상품", [shoppingResultItem(0), shoppingResultItem(1)], { limit: 2 });
  duplicate.items[1].productId = duplicate.items[0].productId;
  assert.throws(
    () => trustedCollectorWindow(duplicate, { keyword: "테스트 상품", maxRank: 2 }),
    /shopping_rank_provider_untrusted_evidence/,
  );

  const falselyPartial = collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 });
  falselyPartial.complete = false;
  falselyPartial.partial = true;
  assert.throws(
    () => trustedCollectorWindow(falselyPartial, { keyword: "테스트 상품", maxRank: 1 }),
    /shopping_rank_provider_untrusted_evidence/,
  );

  const sharedCatalogId = "59031763223";
  const catalogAndSeller = collectorWindow("테스트 상품", [
    shoppingResultItem(0, {
      productId: "91000000001",
      sellerProductId: undefined,
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      link: "",
      productType: "1",
    }),
    shoppingResultItem(1, {
      productId: "91000000002",
      sellerProductId: "12149720593",
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      link: "https://smartstore.naver.com/haedenprime/products/12149720593",
      productType: "3",
    }),
  ], { limit: 2 });
  assert.equal(
    trustedCollectorWindow(catalogAndSeller, { keyword: "테스트 상품", maxRank: 2 }).items.length,
    2,
  );
});

test("a catalog target matches only the real catalog card, never a linked seller", async () => {
  const sharedCatalogId = "59031763223";
  const window = collectorWindow("테스트 상품", [
    shoppingResultItem(0, {
      productId: "91000000001",
      sellerProductId: "12149720593",
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      link: "https://smartstore.naver.com/haedenprime/products/12149720593",
      productType: "3",
    }),
    shoppingResultItem(1, {
      productId: sharedCatalogId,
      sellerProductId: undefined,
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      link: `https://search.shopping.naver.com/catalog/${sharedCatalogId}`,
      productType: "1",
    }),
  ], { limit: 2 });
  const result = await findShoppingRankFromWindow(window, {
    keyword: "테스트 상품",
    targetUrl: `https://search.shopping.naver.com/catalog/${sharedCatalogId}`,
    maxRank: 2,
    skipTargetMetadata: true,
  });
  assert.equal(result.matched, true);
  assert.equal(result.rank, 2);
  assert.equal(result.item?.productType, "1");
});

test("collector typed runtime failure remains explicit when no exact fallback target exists", async () => {
  const originalFetch = globalThis.fetch;
  shoppingProviderPageCache.clear();
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    message: "provider_collection_failed",
    detail: "naver_http_418",
  }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });

  try {
    let captured;
    await assert.rejects(
      findShoppingRank(COLLECTOR_ENV, {
        keyword: "수집차단검증",
        targetProductId: "",
        maxRank: 300,
      }),
      (error) => {
        captured = error;
        return /provider_collection_failed:naver_http_418/.test(error.message);
      },
    );
    assert.equal(captured.status, 502);
    assert.equal(isShoppingRankSourceUnavailable(captured.message), true);
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
});

test("collector queue pressure stays retryable and never opens the source circuit breaker", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const detail of ["provider_queue_full", "provider_queue_deadline_exceeded"]) {
      shoppingProviderPageCache.clear();
      globalThis.fetch = async () => new Response(JSON.stringify({
        ok: false,
        message: "provider_busy",
        detail,
      }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });

      let captured;
      await assert.rejects(
        findShoppingRank(COLLECTOR_ENV, {
          keyword: `수집혼잡검증-${detail}`,
          targetProductId: "",
          maxRank: 300,
        }),
        (error) => {
          captured = error;
          return new RegExp(`provider_busy:${detail}`).test(error.message);
        },
      );
      assert.equal(captured.status, 429);
      assert.equal(captured.code, "provider_busy");
      assert.equal(captured.detail, detail);
      assert.equal(isShoppingRankSourceUnavailable(captured.message), false);

      const tracker = trackerRow({ retry_count: 0, keyword: `추적혼잡-${detail}` });
      const { ctx, state } = testContext(tracker);
      const startedAt = Date.now();
      const result = await runTrackerCheck(ctx, tracker, { env: COLLECTOR_ENV });
      const finishedAt = Date.now();
      const current = state.tables[TRACKERS][0];

      assert.equal(result.ok, false);
      assert.equal(result.errorCode, "SHOPPING_RANK_LOOKUP_FAILED");
      assert.equal(result.retryable, true);
      assert.equal(result.rankSourceReady, true);
      assert.equal(current.last_error, `provider_busy:${detail}`);
      assert.equal(current.retry_count, 1);
      assert.equal(state.tables[SNAPSHOTS].length, 0);
      assertPreserved(tracker, current);
      assertRetryTime(current.next_check_at, startedAt, finishedAt, 5);
    }

    assert.equal(isShoppingCollectorUnavailable({
      status: 502,
      message: "provider_collection_failed",
      detail: "provider_queue_full",
    }), false);
    assert.equal(isShoppingRankSourceUnavailable("provider_collection_failed:provider_queue_full"), false);
    assert.equal(isShoppingCollectorUnavailable({
      status: 502,
      message: "provider_collection_failed",
      detail: "naver_http_418",
    }), true);
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
});

test("the external shopping collector can supply a complete 300-item organic window", async () => {
  shoppingProviderPageCache.clear();
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[24] = shoppingResultItem(24, {
    productId: "57907660073",
    link: "https://search.shopping.naver.com/catalog/57907660073",
    title: "라이브오랄스 음파 전동칫솔 원부",
    productType: "1",
  });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    if (String(input) !== "https://collector.example/rank") {
      return new Response("", { status: 404 });
    }
    const body = JSON.parse(options.body || "{}");
    requests.push(body);
    return new Response(JSON.stringify(collectorWindow(body.keyword, items, { limit: body.limit })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await findShoppingRank({
      mode: "provider",
      providerUrl: "https://collector.example/rank",
      providerKey: "collector-key",
    }, {
      keyword: "음파 전동칫솔",
      targetUrl: "https://search.shopping.naver.com/catalog/57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 25);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.complete, true);
    assert.equal(result.source, "naver_shopping_results_collector");
    assert.equal(result.rankEvidence, "naver_shopping_organic_list");
    assert.equal(result.collectionId, "test-collection-1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].limit, 300);
    assert.equal(requests[0].schemaVersion, NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA);

    const second = await findShoppingRank({
      mode: "provider",
      providerUrl: "https://collector.example/rank",
      providerKey: "collector-key",
    }, {
      keyword: "음파 전동칫솔",
      targetUrl: "https://search.shopping.naver.com/catalog/99999999999",
      maxRank: 300,
    });
    assert.equal(second.matched, false);
    assert.equal(second.checkedCount, 300);
    assert.equal(second.complete, true);
    assert.equal(requests.length, 1);
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
});

test("a valid not-found response still records a checked snapshot", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => ({
      matched: false,
      rank: null,
      checkedCount: 300,
      total: 300,
      complete: true,
      source: "naver_shopping_results_collector",
      rankEvidence: "naver_shopping_organic_list",
      collectionId: "test-complete-miss",
      collectedAt: "2026-08-01T00:00:00.000Z",
      productExposureItems: [],
      topItems: [],
    }),
  });
  const current = state.tables[TRACKERS][0];

  assert.equal(result.ok, true);
  assert.equal(state.tables[SNAPSHOTS].length, 1);
  assert.equal(state.tables[SNAPSHOTS][0].matched, false);
  assert.equal(state.tables[SNAPSHOTS][0].checked_count, 300);
  assert.equal(state.tables[SNAPSHOTS][0].source, "naver_shopping_results_collector");
  assert.equal(state.tables[SNAPSHOTS][0].item.collectionId, "test-complete-miss");
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
    env: COLLECTOR_ENV,
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
    const result = await findShoppingRank(COLLECTOR_ENV, {
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
    const result = await findShoppingRank(COLLECTOR_ENV, {
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

test("shopping lookup ignores a stored catalog when the exact item is an unmatched single product", async () => {
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[2] = shoppingResultItem(2, {
    productId: "59031763223",
    link: "https://search.shopping.naver.com/catalog/59031763223",
    title: "한일의료기 프리볼트 전기 온열 찜질기 원적외선 찜질팩",
    mallName: "네이버",
    brand: "한일의료기",
    maker: "한일의료기",
    category2: "냉온/찜질용품",
    productType: "1",
  });
  items[75] = shoppingResultItem(75, {
    productId: "89694231298",
    link: "https://smartstore.naver.com/haedenprime/products/12149720593",
    title: "일신한일의료기 온열찜질기 허리찜질팩 원적외선 전기 어깨 복부 배 M",
    mallName: "소노팜스토어",
    brand: "한일의료기",
    maker: "한일의료기",
    category2: "냉온/찜질용품",
    productType: "2",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "온열찜질기",
      targetProductId: "12149720593",
      verifiedRelatedCatalogId: "59031763223",
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 76);
    assert.equal(result.exactProductRank, 76);
    assert.equal(result.relatedCatalogRank, null);
    assert.equal(result.trackingRankSource, "exact_product");
    assert.equal(result.verifiedRelatedCatalogId, null);
    assert.equal(result.relatedCatalogContinuityUsed, false);
    assert.deepEqual(result.productExposureItems.map((item) => item.productId), ["89694231298"]);
  });
});

test("shopping lookup never labels another linked seller as the related catalog", async () => {
  const sharedCatalogId = "59031763223";
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[2] = shoppingResultItem(2, {
    productId: "89694230003",
    sellerProductId: "13000000003",
    catalogId: sharedCatalogId,
    linkedCatalogId: sharedCatalogId,
    link: "https://smartstore.naver.com/other-store/products/13000000003",
    title: "같은 원부에 연결된 다른 판매처 상품",
    productType: "3",
  });
  items[75] = shoppingResultItem(75, {
    productId: "89694231298",
    sellerProductId: "12149720593",
    catalogId: sharedCatalogId,
    linkedCatalogId: sharedCatalogId,
    link: "https://smartstore.naver.com/haedenprime/products/12149720593",
    title: "일신한일의료기 온열찜질기",
    productType: "3",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "온열찜질기",
      targetProductId: "12149720593",
      verifiedRelatedCatalogId: sharedCatalogId,
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 76);
    assert.equal(result.exactProductRank, 76);
    assert.equal(result.relatedCatalogRank, null);
    assert.equal(result.trackingRankSource, "exact_product");
    assert.equal(result.productExposureItems.some((item) => item.rank === 3), false);
  });
});

test("shopping lookup prefers the current linked catalog over stale snapshot continuity", async () => {
  const staleCatalogId = "59031763223";
  const currentCatalogId = "59031769999";
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[2] = shoppingResultItem(2, {
    productId: "91000000003",
    sellerProductId: undefined,
    catalogId: staleCatalogId,
    linkedCatalogId: staleCatalogId,
    link: "",
    title: "과거에 잘못 연결된 다른 원부",
    productType: "1",
  });
  items[75] = shoppingResultItem(75, {
    productId: "89694231298",
    sellerProductId: "12149720593",
    catalogId: currentCatalogId,
    linkedCatalogId: currentCatalogId,
    link: "https://smartstore.naver.com/haedenprime/products/12149720593",
    title: "일신한일의료기 온열찜질기",
    productType: "3",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "온열찜질기",
      targetProductId: "12149720593",
      verifiedRelatedCatalogId: staleCatalogId,
      maxRank: 300,
    });
    assert.equal(result.rank, 76);
    assert.equal(result.relatedCatalogRank, null);
    assert.equal(result.trackingRankSource, "exact_product");
    assert.equal(result.targetCatalogId, currentCatalogId);
    assert.equal(result.relatedCatalogContinuityUsed, false);
  });
});

test("shopping lookup still selects a real current catalog above its exact seller product", async () => {
  const sharedCatalogId = "59031763223";
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[2] = shoppingResultItem(2, {
    productId: "91000000003",
    sellerProductId: undefined,
    catalogId: sharedCatalogId,
    linkedCatalogId: sharedCatalogId,
    link: "",
    title: "한일의료기 온열찜질기 원부",
    productType: "1",
  });
  items[75] = shoppingResultItem(75, {
    productId: "89694231298",
    sellerProductId: "12149720593",
    catalogId: sharedCatalogId,
    linkedCatalogId: sharedCatalogId,
    link: "https://smartstore.naver.com/haedenprime/products/12149720593",
    title: "일신한일의료기 온열찜질기",
    productType: "3",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "온열찜질기",
      targetProductId: "12149720593",
      verifiedRelatedCatalogId: "59031760000",
      maxRank: 300,
    });
    assert.equal(result.rank, 3);
    assert.equal(result.exactProductRank, 76);
    assert.equal(result.relatedCatalogRank, 3);
    assert.equal(result.trackingRankSource, "related_catalog");
    assert.equal(result.relatedCatalogIds[0], sharedCatalogId);
  });
});

test("shopping lookup rejects an atomic partial window at the main trust boundary", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => shoppingResultItem(index));
  firstPage[9] = shoppingResultItem(9, {
    productId: "98765432101",
    link: "https://smartstore.naver.com/lav/products/12649811979",
    title: "라이브오랄스 음파 전동칫솔",
    mallName: "라이브오랄스",
    productType: "3",
  });
  const originalFetch = globalThis.fetch;
  shoppingProviderPageCache.clear();
  globalThis.fetch = async (input, options = {}) => {
    assert.equal(String(input), COLLECTOR_ENV.providerUrl);
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body || "{}");
    return new Response(JSON.stringify(collectorWindow(body.keyword, firstPage, {
      limit: body.limit,
      complete: false,
      sourceExhausted: false,
      marketTotal: 500,
    })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      findShoppingRank(COLLECTOR_ENV, {
        keyword: "전동칫솔",
        targetProductId: "12649811979",
        verifiedRelatedCatalogId: "57907660073",
        maxRank: 300,
      }),
      /shopping_rank_provider_untrusted_evidence/,
    );
  } finally {
    shoppingProviderPageCache.clear();
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
    const result = await findShoppingRank(COLLECTOR_ENV, {
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
    const result = await findShoppingRank(COLLECTOR_ENV, {
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

test("the real shopping lookup rejects an empty 2xx payload without trusted collector evidence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(
      findShoppingRank(COLLECTOR_ENV, {
        keyword: "테스트 상품",
        targetProductId: "1234567890",
        maxRank: 300,
      }),
      /shopping_rank_provider_untrusted_evidence/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an explicitly partial atomic shopping window is rejected", async () => {
  const originalFetch = globalThis.fetch;
  shoppingProviderPageCache.clear();
  globalThis.fetch = async (_input, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    return new Response(JSON.stringify(collectorWindow(body.keyword, [], {
      limit: body.limit,
      complete: false,
      sourceExhausted: false,
      marketTotal: 500,
      rawCount: 0,
    })), {
    status: 200,
    headers: { "content-type": "application/json" },
    });
  };
  try {
    await assert.rejects(
      findShoppingRank(COLLECTOR_ENV, {
        keyword: "테스트 상품",
        targetProductId: "1234567890",
        maxRank: 300,
      }),
      /shopping_rank_provider_untrusted_evidence/,
    );
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
});

test("an incomplete product miss preserves rank and schedules retry", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
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

test("an early exact match from an incomplete window never overwrites the last confirmed rank", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => ({
      matched: true,
      rank: 7,
      checkedCount: 100,
      complete: false,
      partial: true,
      source: "naver_shopping_results_collector",
      rankEvidence: "naver_shopping_organic_list",
      collectionId: "partial-match",
      collectedAt: "2026-08-01T00:00:00.000Z",
      productExposureItems: [{ isExactTarget: true, isOrganic: true, isAd: false, rank: 7 }],
      topItems: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_rank_lookup_incomplete");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, state.tables[TRACKERS][0]);
});

test("a fully exhausted short product result is a valid not-found check", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
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
      env: COLLECTOR_ENV,
      leaseStartedAt: "2026-07-16T00:05:00.000Z",
      findShoppingRank: async () => ({
        matched: true,
        rank: 9,
        checkedCount: 9,
        complete: true,
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
      env: COLLECTOR_ENV,
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

test("a missing collector circuit-breaks the due queue without claiming or updating rows", async () => {
  let queryCount = 0;
  let updateCalled = false;
  const ctx = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, TRACKERS);
        queryCount += 1;
        const query = {
          select() { return query; },
          eq() { return query; },
          lte() { return query; },
          or() { return query; },
          in() { return query; },
          update() {
            updateCalled = true;
            return query;
          },
          then(resolve, reject) {
            return Promise.resolve({ data: null, error: null, count: 25 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };

  const summary = await runDueTrackers(ctx, { env: LEGACY_ENV, limit: 25 });

  assert.equal(summary.configured, false);
  assert.equal(summary.rankSourceReady, false);
  assert.equal(summary.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(summary.retryable, false);
  assert.equal(summary.checked, 0);
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.remaining, 25);
  assert.equal(summary.remainingCount, 25);
  assert.equal(summary.drained, false);
  assert.deepEqual(summary.results, []);
  assert.equal(queryCount, 1);
  assert.equal(updateCalled, false);
});

test("a configured but unready collector stops the due queue after the first claimed tracker", async () => {
  const first = trackerRow({ id: "tracker-1" });
  const second = trackerRow({ id: "tracker-2", product_id: "1234567891" });
  const { ctx, state } = testContext(first);
  state.tables[TRACKERS].push(second);
  let checkCalls = 0;

  const summary = await runDueTrackers(ctx, {
    env: COLLECTOR_ENV,
    limit: 2,
    runTrackerCheck: async (_ctx, tracker) => {
      checkCalls += 1;
      tracker.next_check_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      return {
        ok: false,
        tracker,
        message: "수집원 준비 확인이 필요합니다.",
        errorCode: "SHOPPING_RANK_SOURCE_UNAVAILABLE",
        retryable: false,
        configured: true,
        rankSourceReady: false,
      };
    },
  });

  assert.equal(checkCalls, 1);
  assert.equal(summary.configured, true);
  assert.equal(summary.rankSourceReady, false);
  assert.equal(summary.errorCode, "SHOPPING_RANK_SOURCE_UNAVAILABLE");
  assert.equal(summary.retryable, false);
  assert.equal(summary.checked, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.remaining, 1);
  assert.equal(state.tables[TRACKERS][1].processing_started_at, undefined);
});

test("collector authentication and configuration failures stop before claiming the second tracker", async () => {
  for (const errorCode of [
    "SHOPPING_RANK_PROVIDER_UNAUTHORIZED",
    "SHOPPING_RANK_PROVIDER_MISCONFIGURED",
  ]) {
    const first = trackerRow({ id: `tracker-first-${errorCode}` });
    const second = trackerRow({ id: `tracker-second-${errorCode}`, product_id: "1234567891" });
    const { ctx, state } = testContext(first);
    state.tables[TRACKERS].push(second);
    let checkCalls = 0;

    const summary = await runDueTrackers(ctx, {
      env: COLLECTOR_ENV,
      limit: 2,
      runTrackerCheck: async (_ctx, tracker) => {
        checkCalls += 1;
        tracker.next_check_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        return {
          ok: false,
          tracker,
          message: "수집원 설정 확인이 필요합니다.",
          errorCode,
          retryable: false,
          configured: true,
          rankSourceReady: false,
        };
      },
    });

    assert.equal(checkCalls, 1, errorCode);
    assert.equal(summary.checked, 1, errorCode);
    assert.equal(summary.failed, 1, errorCode);
    assert.equal(summary.rankSourceReady, false, errorCode);
    assert.equal(summary.errorCode, errorCode, errorCode);
    assert.equal(summary.retryable, false, errorCode);
    assert.equal(summary.remaining, 1, errorCode);
    assert.equal(state.tables[TRACKERS][1].processing_started_at, undefined, errorCode);
  }
});

test("coverage-limited rows are preserved and the due queue drains without failures", async () => {
  const first = trackerRow({ id: "tracker-preserved-1", retry_count: 3, last_error: "old_error" });
  const second = trackerRow({ id: "tracker-preserved-2", product_id: "1234567891", retry_count: 2 });
  const { ctx, state } = testContext(first);
  state.tables[TRACKERS].push(second);
  let checkCalls = 0;

  const summary = await runDueTrackers(ctx, {
    env: { mode: "mobile_top_fallback", mobileTopFallbackOnly: true },
    limit: 2,
    runTrackerCheck: async (_ctx, tracker) => {
      checkCalls += 1;
      tracker.next_check_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      tracker.last_error = null;
      tracker.retry_count = 0;
      return {
        ok: false,
        tracker,
        message: "현재 검증 범위 밖이어서 기존 순위를 유지합니다.",
        errorCode: "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW",
        retryable: false,
        rankSourceReady: true,
        configured: true,
        preserved: true,
        outcome: "preserved",
      };
    },
  });

  assert.equal(checkCalls, 2);
  assert.equal(summary.checked, 2);
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.preserved, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.rankSourceReady, true);
  assert.equal(summary.drained, true);
  assert.equal(summary.remaining, 0);
  assert.deepEqual(summary.results.map((item) => item.outcome), ["preserved", "preserved"]);
  assert.equal(state.tables[TRACKERS].every((tracker) => tracker.retry_count === 0 && tracker.last_error === null), true);
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

  const summary = await runDueTrackers(ctx, { env: COLLECTOR_ENV, limit: 1 });
  assert.equal(summary.checked, 0);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.drained, true);
  assert.equal(queryCount, 2);
});

test("product due refresh stays global for cron and accepts any advertiser scope", async () => {
  function scopeContext() {
    let queryCount = 0;
    const scopes = [];
    const chain = (result) => ({
      select() { return this; },
      eq() { return this; },
      lte() { return this; },
      or() { return this; },
      order() { return this; },
      limit() { return this; },
      in(column, values) {
        scopes.push({ column, values: [...values] });
        return this;
      },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
    });
    return {
      scopes,
      ctx: {
        supabaseAdmin: {
          from() {
            queryCount += 1;
            return chain(queryCount === 1
              ? { data: [], error: null }
              : { data: null, error: null, count: 0 });
          },
        },
      },
    };
  }

  const siteWide = scopeContext();
  const globalSummary = await runDueTrackers(siteWide.ctx, { env: COLLECTOR_ENV, limit: 1 });
  assert.equal(globalSummary.drained, true);
  assert.deepEqual(siteWide.scopes, []);

  const advertiser = scopeContext();
  const scopedSummary = await runDueTrackers(advertiser.ctx, {
    agencyCode: "agency-b02",
    env: COLLECTOR_ENV,
    limit: 1,
  });
  assert.equal(scopedSummary.drained, true);
  assert.deepEqual(advertiser.scopes, [
    { column: "agency_code", values: ["agency-b02"] },
    { column: "agency_code", values: ["agency-b02"] },
  ]);
});

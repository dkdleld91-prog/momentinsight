import assert from "node:assert/strict";
import test from "node:test";

import {
  collectMobileTopFallbackWindow,
  MOBILE_TOP_FALLBACK_SOURCE,
  MobileTopFallbackError,
  parseMobileSearchBootstrap,
  parseMobilePagedSlotPayload,
  resetMobileTopFallbackStateForTests,
} from "./mobile-top-fallback.mjs";
import {
  findShoppingRank,
  NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
  productIdCandidates,
  sellerProductIdCandidates,
  shoppingProviderPageCache,
} from "../handlers/naver-shopping-rank.mjs";
import { runTrackerCheck } from "../handlers/naver-rank-trackers.mjs";

const KEYWORD = "온열찜질기";

function bootstrapHtml(keyword = KEYWORD) {
  const state = {
    initProps: {
      pagedSlot: [],
      byPassBFFParams: {
        aq: "0",
        rev: "4",
        abt: { test: "A" },
      },
    },
    device: { type: "mobile" },
    query: keyword,
    originQuery: keyword,
    pageId: "test-page/001",
    sessionId: "test-session/001",
    viewType: "GUIDE",
    areaCode: "shp_tli",
    rev: "4",
    bffHost: "ns-portal.shopping.naver.com",
  };
  return `<!doctype html><script>naver.search.ext.newshopping["shopping"]._INITIAL_STATE=${JSON.stringify(state)};</script>`;
}

function slot(sourceType, rank, overrides = {}) {
  const id = String(90000000000 + Number(rank || 1));
  return {
    slotType: "CARD",
    data: {
      cardType: sourceType === "SAS" ? "ORGANIC_CARD" : `${sourceType}_CARD`,
      sourceType,
      rank,
      nvMid: id,
      channelProductId: String(12000000000 + Number(rank || 1)),
      originalMallProductId: String(11000000000 + Number(rank || 1)),
      productName: `검증 상품 ${rank}`,
      productUrl: {
        pcUrl: `https://smartstore.naver.com/example/products/${12000000000 + Number(rank || 1)}`,
      },
      images: [{ imageUrl: `https://shopping-phinf.pstatic.net/${id}.jpg` }],
      mallName: "검증몰",
      salePrice: 10_000 + Number(rank || 0),
      ...overrides,
    },
  };
}

function bffPayload(slots) {
  return {
    data: [{ page: 1, pageSize: 50, slots }],
  };
}

function fallbackFetch(payload, stats = {}) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    stats.calls = Number(stats.calls || 0) + 1;
    if (url.hostname === "m.search.naver.com") {
      stats.bootstrapCalls = Number(stats.bootstrapCalls || 0) + 1;
      assert.equal(url.pathname, "/search.naver");
      assert.equal(url.searchParams.get("where"), "m");
      assert.equal(url.searchParams.get("query"), KEYWORD);
      assert.match(String(init.headers?.["user-agent"] || ""), /Mobile/u);
      return new Response(bootstrapHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    assert.equal(url.hostname, "ns-portal.shopping.naver.com");
    assert.equal(url.pathname, "/api/v2/shopping-paged-slot");
    assert.equal(url.searchParams.get("query"), KEYWORD);
    assert.equal(url.searchParams.get("source"), "shp_tli");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("pageSize"), "50");
    assert.equal(init.headers?.["x-ns-device-type"], "mobile");
    assert.equal(init.headers?.["x-ns-page-id"], "test-page/001");
    assert.equal(init.headers?.referer, `https://m.search.naver.com/search.naver?where=m&query=${encodeURIComponent(KEYWORD)}`);
    stats.bffCalls = Number(stats.bffCalls || 0) + 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
}

test("uses sourceType as the authoritative inventory and preserves official SAS ranks with gaps", () => {
  const parsed = parseMobilePagedSlotPayload(bffPayload([
    slot("AD", 9),
    slot("SUPER_POINT", 1),
    slot("SAS", 1),
    slot("SAS", 3, { cardType: "SUPER_POINT_CARD" }),
  ]), {
    keyword: KEYWORD,
    collectedAt: "2026-08-01T00:00:00.000Z",
    collectionSeed: "fixture",
  });

  assert.equal(parsed.source, MOBILE_TOP_FALLBACK_SOURCE);
  assert.deepEqual(parsed.items.map((item) => item.organicRank), [1, 3]);
  assert.deepEqual(parsed.items.map((item) => item.cardType), ["ORGANIC_CARD", "SUPER_POINT_CARD"]);
  assert.equal(parsed.items.every((item) => item.sourceType === "SAS" && item.isAd === false), true);
  assert.equal(parsed.excludedAdCount, 1);
  assert.equal(parsed.excludedOtherCount, 1);
  assert.equal(parsed.verifiedThroughRank, 1);
  assert.equal(parsed.rawCount, 4);
  assert.equal(parsed.complete, false);
});

test("parses the live bootstrap date literal without evaluating JavaScript", () => {
  const html = bootstrapHtml().replace(
    "};</script>",
    ',"generatedAt":new Date("2026-08-01T00:00:00.000Z")};</script>',
  );
  const context = parseMobileSearchBootstrap(html, KEYWORD);
  assert.equal(context.keyword, KEYWORD);
});

test("flattens array-valued slot data while excluding every non-SAS inventory", () => {
  const parsed = parseMobilePagedSlotPayload(bffPayload([{
    slotType: "CARD",
    data: [slot("AD", 3).data, slot("SAS", 1).data, slot("SAS", 2).data],
  }]), { keyword: KEYWORD });
  assert.deepEqual(parsed.items.map((item) => item.organicRank), [1, 2]);
  assert.equal(parsed.rawCount, 3);
  assert.equal(parsed.excludedAdCount, 1);
  assert.equal(parsed.verifiedThroughRank, 3);
});

test("does not infer coverage through a high slot rank when an intermediate rank is missing", () => {
  const parsed = parseMobilePagedSlotPayload(bffPayload([
    slot("SAS", 1),
    slot("SAS", 2),
    slot("SUPER_POINT", 50),
  ]), { keyword: KEYWORD });

  assert.equal(parsed.verifiedThroughRank, 2);
  assert.deepEqual(parsed.items.map((item) => item.organicRank), [1, 2]);
});

test("fails closed on malformed pages, missing identities, or non-increasing SAS ranks", () => {
  assert.throws(
    () => parseMobilePagedSlotPayload({ data: [{ page: 2, pageSize: 50, slots: [] }] }, { keyword: KEYWORD }),
    (error) => error instanceof MobileTopFallbackError && error.code === "shopping_mobile_top_schema_drift",
  );
  assert.throws(
    () => parseMobilePagedSlotPayload(bffPayload([slot("SAS", 2), slot("SAS", 1)]), { keyword: KEYWORD }),
    (error) => error instanceof MobileTopFallbackError && error.detail === "sas.rank_order.1",
  );
  assert.throws(
    () => parseMobilePagedSlotPayload(bffPayload([slot("SAS", 1, {
      nvMid: "",
      channelProductId: "",
      originalMallProductId: "",
      productUrl: {},
      productClickUrl: {},
    })]), { keyword: KEYWORD }),
    (error) => error instanceof MobileTopFallbackError && error.detail === "sas.identity.1",
  );
});

test("collects the mobile bootstrap and BFF once, then serves the verified window from cache", async () => {
  resetMobileTopFallbackStateForTests();
  const stats = {};
  const fetchImpl = fallbackFetch(bffPayload([slot("SAS", 1), slot("SAS", 2)]), stats);
  const first = await collectMobileTopFallbackWindow(KEYWORD, {
    fetchImpl,
    now: () => Date.parse("2026-08-01T00:00:00.000Z"),
  });
  const second = await collectMobileTopFallbackWindow(KEYWORD, {
    fetchImpl,
    now: () => Date.parse("2026-08-01T00:01:00.000Z"),
  });
  assert.equal(first, second);
  assert.equal(first.checkedCount, 2);
  assert.equal(stats.bootstrapCalls, 1);
  assert.equal(stats.bffCalls, 1);
  resetMobileTopFallbackStateForTests();
});

test("does not hammer a blocked endpoint and enters cooldown without an automatic retry", async () => {
  resetMobileTopFallbackStateForTests();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("blocked", {
      status: 418,
      headers: { "content-type": "text/html" },
    });
  };
  const now = () => Date.parse("2026-08-01T00:00:00.000Z");
  await assert.rejects(
    () => collectMobileTopFallbackWindow(KEYWORD, { fetchImpl, now }),
    (error) => error.code === "shopping_mobile_top_http_418",
  );
  await assert.rejects(
    () => collectMobileTopFallbackWindow(KEYWORD, { fetchImpl, now }),
    (error) => error.code === "shopping_mobile_top_cooldown",
  );
  assert.equal(calls, 1);
  resetMobileTopFallbackStateForTests();
});

test("accepts a found exact product and chooses its higher verified related catalog rank", async () => {
  resetMobileTopFallbackStateForTests();
  const catalogId = "77777777777";
  const targetProductId = "33333333333";
  const payload = bffPayload([
    slot("SAS", 1, {
      cardType: "CATALOG_CARD",
      nvMid: catalogId,
      channelProductId: null,
      originalMallProductId: null,
      catalogMatchingId: null,
      productUrl: { pcUrl: `https://search.shopping.naver.com/catalog/${catalogId}` },
      productName: "검증 원부",
    }),
    slot("SAS", 2),
    slot("SAS", 3, {
      channelProductId: targetProductId,
      originalMallProductId: "22222222222",
      catalogMatchingId: catalogId,
      productUrl: { pcUrl: `https://smartstore.naver.com/example/products/${targetProductId}` },
      productName: "검증 판매처 상품",
    }),
  ]);

  const result = await findShoppingRank({ mobileTopFallbackOnly: true }, {
    keyword: KEYWORD,
    targetProductId,
    maxRank: 300,
    mobileTopFallbackOptions: {
      fetchImpl: fallbackFetch(payload),
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    },
  });

  assert.equal(result.matched, true);
  assert.equal(result.rank, 1);
  assert.equal(result.exactProductRank, 3);
  assert.equal(result.relatedCatalogRank, 1);
  assert.equal(result.trackingRankSource, "related_catalog");
  assert.equal(result.fallbackAccepted, true);
  assert.equal(result.fallbackCoverageComplete, false);
  assert.equal(result.fallbackVerifiedThroughRank, 3);
  assert.equal(result.complete, true);
  resetMobileTopFallbackStateForTests();
});

test("matches either channel or original mall product ID without conflating them", async () => {
  resetMobileTopFallbackStateForTests();
  const channelProductId = "33333333333";
  const originalMallProductId = "22222222222";
  const payload = bffPayload([slot("SAS", 1, {
    channelProductId,
    originalMallProductId,
    productUrl: { pcUrl: `https://smartstore.naver.com/example/products/${channelProductId}` },
  })]);
  const result = await findShoppingRank({ mobileTopFallbackOnly: true }, {
    keyword: KEYWORD,
    targetProductId: originalMallProductId,
    maxRank: 300,
    mobileTopFallbackOptions: {
      fetchImpl: fallbackFetch(payload),
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    },
  });
  assert.equal(result.matched, true);
  assert.equal(result.rank, 1);
  assert.equal(result.matchedProductId, originalMallProductId);
  resetMobileTopFallbackStateForTests();
});

test("keeps a gapped official SAS rank and never compresses rank 3 into rank 2", async () => {
  resetMobileTopFallbackStateForTests();
  const targetProductId = "33333333333";
  const result = await findShoppingRank({ mode: "mobile_top_fallback" }, {
    keyword: KEYWORD,
    targetProductId,
    maxRank: 300,
    mobileTopFallbackOptions: {
      fetchImpl: fallbackFetch(bffPayload([
        slot("SAS", 1),
        slot("SUPER_POINT", 2),
        slot("SAS", 3, { channelProductId: targetProductId }),
      ])),
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    },
  });
  assert.equal(result.matched, true);
  assert.equal(result.rank, 3);
  assert.equal(result.exactProductRank, 3);
  assert.equal(result.fallbackVerifiedThroughRank, 3);
  resetMobileTopFallbackStateForTests();
});

test("accepts Naver's explicit SAS rank through the full 50-slot fallback contract", async () => {
  resetMobileTopFallbackStateForTests();
  const targetProductId = "33333333333";
  const payload = bffPayload(Array.from({ length: 41 }, (_, index) => slot("SAS", index + 1, {
    ...(index === 40 ? { channelProductId: targetProductId } : {}),
  })));
  const result = await findShoppingRank({ mode: "mobile_top_fallback" }, {
    keyword: KEYWORD,
    targetProductId,
    maxRank: 300,
    mobileTopFallbackOptions: {
      fetchImpl: fallbackFetch(payload),
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    },
  });
  assert.equal(result.matched, true);
  assert.equal(result.rank, 41);
  const parsed = parseMobilePagedSlotPayload(payload, { keyword: KEYWORD });
  assert.equal(parsed.checkedCount, 41);
  assert.equal(parsed.verifiedThroughRank, 41);
  assert.equal(parsed.excludedBeyondVerifiedCount, 0);
  assert.equal(parsed.items.some((item) => item.sellerProductId === targetProductId), true);
  resetMobileTopFallbackStateForTests();
});

test("never extracts Naver product identity from an untrusted host", () => {
  const hostile = "https://evil.example/products/12345678?productId=12345678";
  assert.deepEqual(productIdCandidates(hostile), []);
  assert.deepEqual(sellerProductIdCandidates(hostile), []);
  assert.deepEqual(productIdCandidates("https://smartstore.naver.com/example/products/12345678"), ["12345678"]);
});

test("provider outage never silently changes the configured collection mode", async () => {
  resetMobileTopFallbackStateForTests();
  shoppingProviderPageCache.clear();
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let fallbackCalls = 0;
  const targetProductId = "33333333333";
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({
      ok: false,
      message: "provider_collection_failed",
      detail: "naver_http_418",
    }), { status: 503, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(
      () => findShoppingRank({
        mode: "provider",
        providerUrl: "https://collector.example/rank",
        providerKey: "test-secret",
      }, {
        keyword: KEYWORD,
        targetProductId,
        maxRank: 300,
        mobileTopFallbackOptions: {
          fetchImpl: async (...args) => {
            fallbackCalls += 1;
            return fallbackFetch(bffPayload([slot("SAS", 1, { channelProductId: targetProductId })]))(...args);
          },
          now: () => Date.parse("2026-08-01T00:00:00.000Z"),
        },
      }),
      (error) => error?.message === "provider_collection_failed:naver_http_418",
    );
    assert.equal(providerCalls, 1);
    assert.equal(fallbackCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    shoppingProviderPageCache.clear();
    resetMobileTopFallbackStateForTests();
  }
});

test("fails closed on provider authentication errors and never invokes fallback", async () => {
  resetMobileTopFallbackStateForTests();
  shoppingProviderPageCache.clear();
  const originalFetch = globalThis.fetch;
  let fallbackCalls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    message: "provider_unauthorized",
  }), { status: 401, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      () => findShoppingRank({
        mode: "provider",
        providerUrl: "https://collector.example/rank",
        providerKey: "wrong-secret",
      }, {
        keyword: KEYWORD,
        targetProductId: "33333333333",
        maxRank: 300,
        mobileTopFallbackOptions: {
          fetchImpl: async () => {
            fallbackCalls += 1;
            throw new Error("fallback_must_not_run");
          },
        },
      }),
      (error) => error.status === 401 && error.code === "provider_unauthorized",
    );
    assert.equal(fallbackCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    shoppingProviderPageCache.clear();
    resetMobileTopFallbackStateForTests();
  }
});

test("a top-window miss is inconclusive and never becomes a not-found rank result", async () => {
  resetMobileTopFallbackStateForTests();
  await assert.rejects(
    () => findShoppingRank({ mobileTopFallbackOnly: true }, {
      keyword: KEYWORD,
      targetProductId: "99999999999",
      maxRank: 300,
      mobileTopFallbackOptions: {
        fetchImpl: fallbackFetch(bffPayload([slot("SAS", 1), slot("SAS", 2)])),
        now: () => Date.parse("2026-08-01T00:00:00.000Z"),
      },
    }),
    (error) => (
      error.code === "SHOPPING_RANK_TOP_FALLBACK_INCONCLUSIVE"
      && error.message === "shopping_rank_top_fallback_inconclusive"
      && error.retryable === true
    ),
  );
  resetMobileTopFallbackStateForTests();
});

test("a fallback miss preserves the tracker's last rank and inserts no history snapshot", async () => {
  resetMobileTopFallbackStateForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fallbackFetch(bffPayload([slot("SAS", 1), slot("SAS", 2)]));
  const tracker = {
    id: "tracker-fallback-miss",
    client_id: "client-1",
    brand_id: null,
    agency_code: "mml93-a01",
    keyword: KEYWORD,
    product_url: "https://smartstore.naver.com/example/products/99999999999",
    product_id: "99999999999",
    mall_name: "검증몰",
    product_title: "기존 검증 상품",
    max_rank: 300,
    status: "active",
    started_at: "2026-07-01T00:00:00.000Z",
    ends_at: null,
    last_checked_at: "2026-07-31T00:00:00.000Z",
    next_check_at: "2026-08-01T00:00:00.000Z",
    current_rank: 27,
    best_rank: 11,
    worst_rank: 42,
    check_count: 9,
    found_count: 8,
    last_message: "기존 정상 순위",
    last_error: null,
    retry_count: 0,
    sort_order: 0,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
  };
  let snapshotInsertCount = 0;
  let updatedTracker = { ...tracker };
  const ctx = {
    supabaseAdmin: {
      from(table) {
        if (table === "naver_rank_snapshots") {
          const query = {
            select() { return query; },
            eq() { return query; },
            gte() { return query; },
            lte() { return query; },
            order() { return query; },
            limit() { return query; },
            insert() {
              snapshotInsertCount += 1;
              throw new Error("fallback miss must not insert a snapshot");
            },
            then(resolve, reject) {
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
          return query;
        }
        assert.equal(table, "naver_rank_trackers");
        const query = {
          update(values) {
            updatedTracker = { ...updatedTracker, ...values };
            return query;
          },
          eq() { return query; },
          select() { return query; },
          async single() { return { data: updatedTracker, error: null }; },
        };
        return query;
      },
    },
  };

  try {
    const result = await runTrackerCheck(ctx, tracker, {
      env: {
        mode: "mobile_top_fallback",
        mobileTopFallbackOnly: true,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, null);
    assert.equal(result.errorCode, "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW");
    assert.equal(result.retryable, false);
    assert.equal(result.retryAfter, 0);
    assert.equal(result.rankSourceReady, true);
    assert.equal(result.preserved, true);
    assert.equal(result.outcome, "preserved");
    assert.equal(updatedTracker.current_rank, 27);
    assert.equal(updatedTracker.best_rank, 11);
    assert.equal(updatedTracker.worst_rank, 42);
    assert.equal(updatedTracker.check_count, 9);
    assert.equal(updatedTracker.found_count, 8);
    assert.equal(updatedTracker.last_checked_at, "2026-07-31T00:00:00.000Z");
    assert.equal(updatedTracker.last_error, null);
    assert.equal(updatedTracker.retry_count, 0);
    assert.ok([9, 15].includes(new Date(updatedTracker.next_check_at).getUTCHours() + 9));
    assert.equal(snapshotInsertCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetMobileTopFallbackStateForTests();
  }
});

test("the shared tracker check path commits exactly one verified fallback snapshot", async () => {
  resetMobileTopFallbackStateForTests();
  const targetProductId = "33333333333";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fallbackFetch(bffPayload([slot("SAS", 1, { channelProductId: targetProductId })]));
  const tracker = {
    id: "tracker-fallback-found",
    client_id: "client-1",
    brand_id: null,
    agency_code: "mml93-a01",
    keyword: KEYWORD,
    product_url: `https://smartstore.naver.com/example/products/${targetProductId}`,
    product_id: targetProductId,
    mall_name: "검증몰",
    product_title: "기존 검증 상품",
    max_rank: 300,
    status: "active",
    started_at: "2026-07-01T00:00:00.000Z",
    ends_at: null,
    last_checked_at: "2026-07-31T00:00:00.000Z",
    next_check_at: "2026-08-01T00:00:00.000Z",
    current_rank: 27,
    best_rank: 11,
    worst_rank: 42,
    check_count: 9,
    found_count: 8,
    last_message: "기존 정상 순위",
    last_error: null,
    retry_count: 0,
    sort_order: 0,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
  };
  const insertedSnapshots = [];
  let updatedTracker = { ...tracker };
  const ctx = {
    supabaseAdmin: {
      from(table) {
        if (table === "naver_rank_snapshots") {
          const query = {
            select() { return query; },
            eq() { return query; },
            gte() { return query; },
            lte() { return query; },
            order() { return query; },
            limit() { return query; },
            insert(record) {
              insertedSnapshots.push(record);
              return {
                select() {
                  return {
                    async single() {
                      return { data: { id: "snapshot-1", ...record }, error: null };
                    },
                  };
                },
              };
            },
            then(resolve, reject) {
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
          return query;
        }
        assert.equal(table, "naver_rank_trackers");
        const query = {
          update(values) {
            updatedTracker = { ...updatedTracker, ...values };
            return query;
          },
          eq() { return query; },
          select() { return query; },
          async single() { return { data: updatedTracker, error: null }; },
        };
        return query;
      },
    },
  };

  try {
    const result = await runTrackerCheck(ctx, tracker, {
      env: {
        mode: "mobile_top_fallback",
        mobileTopFallbackOnly: true,
      },
    });
    assert.equal(result.ok, true);
    assert.equal(updatedTracker.current_rank, 1);
    assert.equal(updatedTracker.check_count, 10);
    assert.equal(updatedTracker.found_count, 9);
    assert.equal(insertedSnapshots.length, 1);
    assert.equal(insertedSnapshots[0].rank, 1);
    assert.equal(insertedSnapshots[0].matched, true);
  } finally {
    globalThis.fetch = originalFetch;
    resetMobileTopFallbackStateForTests();
  }
});

test("a complete external collector window remains authoritative and never invokes the fallback", async () => {
  resetMobileTopFallbackStateForTests();
  shoppingProviderPageCache.clear();
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  let fallbackCalls = 0;
  const targetProductId = "33333333333";
  globalThis.fetch = async (_input, options = {}) => {
    externalCalls += 1;
    const request = JSON.parse(options.body);
    const items = [1, 2, 3].map((rank) => ({
      organicRank: rank,
      isAd: false,
      isOrganic: true,
      productId: String(90000000000 + rank),
      sellerProductId: rank === 2 ? targetProductId : String(12000000000 + rank),
      title: `외부 수집 상품 ${rank}`,
      link: `https://smartstore.naver.com/example/products/${rank === 2 ? targetProductId : 12000000000 + rank}`,
      productType: 2,
    }));
    return new Response(JSON.stringify({
      ok: true,
      schemaVersion: NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
      source: "naver_shopping_results_collector",
      rankEvidence: "naver_shopping_organic_list",
      keyword: request.keyword,
      collectionId: "external-collection",
      collectedAt: "2026-08-01T00:00:00.000Z",
      complete: true,
      partial: false,
      sourceExhausted: true,
      marketTotal: 3,
      marketTotalStatus: "verified",
      checkedCount: 3,
      rawCount: 3,
      excludedAdCount: 0,
      items,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await findShoppingRank({
      mode: "provider",
      providerUrl: "https://collector.example/rank",
      providerKey: "test-secret",
    }, {
      keyword: KEYWORD,
      targetProductId,
      maxRank: 3,
      mobileTopFallbackOptions: {
        fetchImpl: async () => {
          fallbackCalls += 1;
          throw new Error("fallback_must_not_run");
        },
      },
    });
    assert.equal(result.rank, 2);
    assert.equal(result.source, "naver_shopping_results_collector");
    assert.equal(result.fallbackAccepted, undefined);
    assert.equal(externalCalls, 1);
    assert.equal(fallbackCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    shoppingProviderPageCache.clear();
    resetMobileTopFallbackStateForTests();
  }
});

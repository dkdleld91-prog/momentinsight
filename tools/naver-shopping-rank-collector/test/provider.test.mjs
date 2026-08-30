import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SCHEMA_VERSION,
  STABLE_FULL_WINDOW_PROOF_VERSION,
} from "../src/contract.mjs";
import {
  NAVER_SHOPPING_PROFILE_AUTH_MARKER,
  NAVER_SHOPPING_PROFILE_AUTH_MARKER_SCHEMA,
  NAVER_SHOPPING_PROFILE_OWNER_MARKER,
  NAVER_SHOPPING_PROFILE_OWNER_MARKER_VALUE,
  ProviderError,
  appendNormalizedPage,
  buildStableFullWindowProof,
  buildNaverShoppingFrontendUrl,
  buildNaverShoppingSearchUrl,
  classifyNaverPage,
  createPlaywrightProvider,
  decodeNaverRankDriftDetail,
  defaultNaverShoppingProfileDir,
  defaultCollectPage,
  marketTotalFromTexts,
  parseNaverFrontendPage,
  parseNaverNextDataPage,
  validateNaverShoppingProfileDir,
} from "../src/provider.mjs";

function rankRequest(keyword = "온열찜질기", limit = 3, now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    keyword,
    limit,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: new Date(now + 120_000).toISOString(),
    requestId: `test-${keyword}-${limit}`,
  };
}

function rawProduct(index, overrides = {}) {
  const productId = String(70000000000 + index);
  const sellerProductId = String(80000000000 + index);
  return {
    extractionKey: `row-${index}`,
    payload: JSON.stringify({
      nvMid: productId,
      chnl_prod_no: sellerProductId,
      productName: `검증 상품 ${index}`,
      mallName: "검증몰",
      productType: 2,
      lprice: 10000 + index,
    }),
    links: [`https://smartstore.naver.com/example/products/${sellerProductId}`],
    title: `검증 상품 ${index}`,
    badgeTexts: [],
    ...overrides,
  };
}

function nextDataProduct(rank, overrides = {}) {
  const productId = String(91000000000 + rank);
  const sellerProductId = String(12000000000 + rank);
  return {
    type: "product",
    item: {
      collection: "product",
      rank,
      id: productId,
      parentId: String(81000000000 + rank),
      parentCatalogId: "",
      mallId: "example",
      mallProductId: sellerProductId,
      stdCatalogMatchType: "0",
      productTitle: `NEXT 상품 ${rank}`,
      mallProductUrl: `https://smartstore.naver.com/example/products/${sellerProductId}`,
      imageUrl: `https://shopping-phinf.pstatic.net/${productId}.jpg`,
      mallName: "NEXT 검증몰",
      brand: "NEXT 브랜드",
      maker: "NEXT 제조사",
      category1Name: "생활/건강",
      category2Name: "건강관리용품",
      lowPrice: String(10_000 + rank),
      ...overrides,
    },
  };
}

function nextDataAd(index = 1) {
  return {
    type: "product",
    item: {
      collection: "product",
      rank: index,
      adId: `nad-a001-${index}`,
      id: String(99000000000 + index),
      productTitle: `광고 ${index}`,
    },
  };
}

function nextDataSupersaving(rank) {
  return {
    type: "supersaving",
    item: {
      collection: "product",
      rank,
      id: String(99500000000 + rank),
    },
  };
}

function productionRankDriftEntries({
  expectedRank,
  adSlotCount,
  supersavingSlotCount,
}) {
  const regularAdCount = adSlotCount - supersavingSlotCount;
  const regularAds = Array.from(
    { length: regularAdCount },
    (_, index) => nextDataAd(index + 1),
  );
  const organics = Array.from(
    { length: expectedRank - 1 },
    (_, index) => nextDataProduct(index + 1),
  );
  const supersaving = Array.from(
    { length: supersavingSlotCount },
    () => nextDataSupersaving(15),
  );
  return [...regularAds, ...organics, ...supersaving, nextDataProduct(expectedRank + 1)];
}

function nextDataAuxiliary(index = 1, overrides = {}) {
  return {
    type: "recommendation",
    item: {
      collection: "recommendation",
      moduleIndex: index,
    },
    ...overrides,
  };
}

function nextDataCatalog(rank, overrides = {}) {
  const productId = String(91000000000 + rank);
  return nextDataProduct(rank, {
    id: productId,
    parentId: productId,
    parentCatalogId: String(71000000000 + rank),
    mallId: "naver_model",
    mallProductId: "",
    stdCatalogMatchType: "2",
    mallProductUrl: "",
    productTitle: `NEXT 원부 ${rank}`,
    ...overrides,
  });
}

function nextDataFixture({ pageIndex = 1, total, entries, keyword = "온열찜질기" }) {
  return {
    props: {
      pageProps: {
        searchParam: {
          sort: "rel",
          pagingIndex: pageIndex,
          pagingSize: 40,
          viewType: "list",
          productSet: "total",
          query: keyword,
        },
        compositeList: {
          total,
          list: entries,
        },
      },
    },
  };
}

function frontendFixture({ total, products, adProducts = [], superSavingProducts = [] }) {
  return {
    shoppingResult: {
      total,
      products: products.map((entry) => entry.item),
    },
    searchAdResult: { products: adProducts },
    superSavingProducts,
  };
}

function stableOverlapItems({ driftRank = 0 } = {}) {
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
  for (let pageIndex = 1; pageIndex <= 8; pageIndex += 1) {
    const startRank = ((pageIndex - 1) * 40) + 1;
    const entries = Array.from({ length: 40 }, (_, index) => {
      const rank = startRank + index;
      if (rank === 41) {
        return nextDataProduct(rank, {
          mallProductId: "12000000001",
          mallProductUrl: "https://smartstore.naver.com/example/products/12000000001",
        });
      }
      if (rank === driftRank) {
        return nextDataProduct(rank, {
          mallProductId: "13999999999",
          mallProductUrl: "https://smartstore.naver.com/example/products/13999999999",
        });
      }
      return nextDataProduct(rank);
    });
    const page = parseNaverNextDataPage(nextDataFixture({
      pageIndex,
      total: 10_000,
      entries,
    }), { pageIndex, keyword: "온열찜질기" });
    appendNormalizedPage(state, page, {
      pageIndex,
      limit: 300,
      crossPageMode: STABLE_FULL_WINDOW_PROOF_VERSION,
    });
  }
  return state.items;
}

function fakeBrowserFactory(stats = {}) {
  return async (launchOptions) => {
    stats.launchOptions = launchOptions;
    return {
      isConnected: () => true,
      on() {},
      async newContext() {
        stats.contexts = Number(stats.contexts || 0) + 1;
        return {
          async newPage() {
            stats.pages = Number(stats.pages || 0) + 1;
            return {
              async close() { stats.closedPages = Number(stats.closedPages || 0) + 1; },
            };
          },
          async close() { stats.closedContexts = Number(stats.closedContexts || 0) + 1; },
        };
      },
      async close() { stats.browserClosed = true; },
    };
  };
}

function createProfileFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mi-n-shopping-profile-"));
  const profileDir = path.join(root, "NaverShoppingProfile");
  fs.mkdirSync(profileDir, { mode: options.mode || 0o700 });
  fs.chmodSync(profileDir, options.mode || 0o700);
  if (options.ownerMarker !== false) {
    fs.writeFileSync(
      path.join(profileDir, NAVER_SHOPPING_PROFILE_OWNER_MARKER),
      `${options.ownerMarkerValue || NAVER_SHOPPING_PROFILE_OWNER_MARKER_VALUE}\n`,
      { mode: 0o600 },
    );
  }
  if (options.authMarker !== false) {
    const authMarker = options.authMarkerValue || JSON.stringify({
      schema: NAVER_SHOPPING_PROFILE_AUTH_MARKER_SCHEMA,
      authenticatedAt: "2026-08-02T00:00:00.000Z",
    });
    fs.writeFileSync(
      path.join(profileDir, NAVER_SHOPPING_PROFILE_AUTH_MARKER),
      `${authMarker}\n`,
      { mode: 0o600 },
    );
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, profileDir };
}

function fakePersistentContextFactory(stats = {}) {
  return async (launchOptions) => {
    stats.launchOptions = launchOptions;
    const browser = {
      isConnected: () => stats.disconnected !== true,
      on(event, callback) {
        if (event === "disconnected") stats.onDisconnected = callback;
      },
    };
    const initialPage = {
      async close() { stats.closedInitialPages = Number(stats.closedInitialPages || 0) + 1; },
    };
    return {
      browser: () => browser,
      pages: () => [initialPage],
      async newPage() {
        stats.pages = Number(stats.pages || 0) + 1;
        return {
          async close() { stats.closedPages = Number(stats.closedPages || 0) + 1; },
        };
      },
      async close() { stats.contextClosed = Number(stats.contextClosed || 0) + 1; },
    };
  };
}

function createFixtureProvider({ collectPage, now = () => Date.now(), config = {}, autoVerify = false, browserStats } = {}) {
  return createPlaywrightProvider({
    browserFactory: fakeBrowserFactory(browserStats),
    collectPage,
    now,
    autoVerify,
    config: {
      canaryKeyword: "온열찜질기",
      canaryLimit: 2,
      timeoutMs: 100_000,
      pageTimeoutMs: 10_000,
      queueMax: 8,
      cacheTtlMs: 60_000,
      cacheMax: 20,
      readinessTtlMs: 60_000,
      headless: true,
      userDataDir: "",
      ...config,
    },
  });
}

test("builds only the allowlisted N Shopping relevance-list URL", () => {
  const url = new URL(buildNaverShoppingSearchUrl("온열 찜질기", 3));
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "search.shopping.naver.com");
  assert.equal(url.pathname, "/search/all");
  assert.equal(url.searchParams.get("query"), "온열 찜질기");
  assert.equal(url.searchParams.get("productSet"), "total");
  assert.equal(url.searchParams.get("sort"), "rel");
  assert.equal(url.searchParams.get("pagingIndex"), "3");
  assert.equal(url.searchParams.get("pagingSize"), "40");
});

test("builds the allowlisted same-origin partial-search URL for pages 1..8 only", () => {
  const url = new URL(buildNaverShoppingFrontendUrl("온열 찜질기", 8));
  assert.equal(url.origin, "https://search.shopping.naver.com");
  assert.equal(url.pathname, "/api/search/all");
  assert.equal(url.searchParams.get("pagingIndex"), "8");
  assert.equal(url.searchParams.get("pagingSize"), "40");
  assert.throws(
    () => buildNaverShoppingFrontendUrl("온열 찜질기", 9),
    (error) => error instanceof ProviderError && error.code === "provider_page_out_of_range",
  );
});

test("accepts only shoppingResult.products and ignores separate ad and super-saving inventories", () => {
  const parsed = parseNaverFrontendPage(frontendFixture({
    total: 2,
    products: [nextDataProduct(1), nextDataProduct(2)],
    adProducts: [{ collection: "product", rank: 1, adId: "paid-1" }],
    superSavingProducts: [{ collection: "product", rank: 1, id: "99999999999" }],
  }), { pageIndex: 1, keyword: "온열찜질기" });

  assert.equal(parsed.marketTotal, 2);
  assert.deepEqual(parsed.rows.map((row) => row.sourceRank), [1, 2]);
  assert.deepEqual(parsed.rows.map((row) => row.productId), ["91000000001", "91000000002"]);
  assert.equal(parsed.rows.some((row) => row.isAd), false);
});

test("fails closed when the frontend schema or an absolute organic rank drifts", () => {
  assert.throws(
    () => parseNaverFrontendPage({ shoppingResult: { total: 1 } }, { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError && error.code === "naver_frontend_schema_drift",
  );
  assert.throws(
    () => parseNaverFrontendPage(frontendFixture({
      total: 2,
      products: [nextDataProduct(1), nextDataProduct(3)],
    }), { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError && error.code === "naver_frontend_schema_drift",
  );
});

test("parses __NEXT_DATA__ in document order and excludes explicit adId rows", () => {
  const parsed = parseNaverNextDataPage(nextDataFixture({
    total: 2,
    entries: [
      nextDataAd(1),
      nextDataProduct(1),
      nextDataAd(2),
      nextDataProduct(2),
    ],
  }), { pageIndex: 1, keyword: "온열찜질기" });

  assert.equal(parsed.marketTotal, 2);
  assert.equal(parsed.sourceExhausted, true);
  assert.deepEqual(parsed.rows.map((row) => row.isAd), [true, false, true, false]);
  assert.deepEqual(
    parsed.rows.filter((row) => row.isOrganic).map((row) => row.sourceRank),
    [1, 2],
  );
  assert.equal(parsed.rows[1].productId, "91000000001");
  assert.equal(parsed.rows[1].sellerProductId, "12000000001");
  assert.equal(parsed.rows[1].catalogId, undefined);
  assert.equal(parsed.rows[1].linkedCatalogId, undefined);
  assert.equal(parsed.rows[1].productType, 2);
  assert.equal(parsed.rows[1].title, "NEXT 상품 1");
  assert.equal(parsed.rows[1].link, "https://smartstore.naver.com/example/products/12000000001");
  assert.equal(parsed.rows[1].lprice, 10001);
});

test("ignores non-product composite helpers only when they contain no organic product evidence", () => {
  const parsed = parseNaverNextDataPage(nextDataFixture({
    total: 2,
    entries: [
      nextDataAuxiliary(1),
      nextDataProduct(1),
      nextDataAuxiliary(2, { item: null }),
      nextDataProduct(2),
    ],
  }), { pageIndex: 1, keyword: "온열찜질기" });

  assert.equal(parsed.marketTotal, 2);
  assert.deepEqual(parsed.rows.map((row) => row.sourceRank), [1, 2]);
  assert.deepEqual(parsed.rows.map((row) => row.productId), ["91000000001", "91000000002"]);
});

test("excludes an explicit supersaving composite even when it carries product metadata", () => {
  const parsed = parseNaverNextDataPage(nextDataFixture({
    total: 1,
    entries: [
      {
        type: "supersaving",
        item: {
          collection: "product",
          rank: 1,
          id: "99999999998",
          parentCatalogId: "59776958987",
          mallProductId: "99999999999",
          productTitle: "NEXT 상품 1",
          imageUrl: "https://shopping-phinf.pstatic.net/91000000001.jpg",
        },
      },
      nextDataProduct(1),
    ],
  }), { pageIndex: 1, keyword: "온열찜질기" });

  assert.deepEqual(parsed.rows[0], {
    rowSource: "next_data_composite_v1",
    extractionKey: "next:1:ad:0:type:supersaving",
    isAd: true,
    isOrganic: false,
  });
  assert.equal(parsed.rows[0].catalogId, undefined);
  assert.equal(parsed.rows[0].sellerProductId, undefined);
  assert.equal(parsed.rows[0].title, undefined);
  assert.deepEqual(
    parsed.rows.filter((row) => row.isOrganic).map((row) => row.productId),
    ["91000000001"],
  );

  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
  appendNormalizedPage(state, parsed, { pageIndex: 1, limit: 1 });
  assert.equal(state.excludedAdCount, 1);
  assert.deepEqual(state.items.map((item) => item.productId), ["91000000001"]);
});

test("normalizes only the rank shift accounted for by an explicit ranked ad slot", () => {
  const payload = nextDataFixture({
    total: 1,
    entries: [
      {
        type: "supersaving",
        item: {
          collection: "product",
          rank: 1,
          id: "99999999998",
          mallProductId: "99999999999",
          productTitle: "절대 오류 원문에 포함되면 안 되는 제목",
          imageUrl: "https://shopping-phinf.pstatic.net/private-image.jpg",
        },
      },
      nextDataAuxiliary(1),
      nextDataProduct(2),
    ],
  });

  const parsed = parseNaverNextDataPage(payload, { pageIndex: 1, keyword: "온열찜질기" });
  assert.equal(parsed.rows.filter((row) => row.isAd).length, 1);
  assert.deepEqual(
    parsed.rows.filter((row) => row.isOrganic).map((row) => row.sourceRank),
    [1],
  );
  assert.equal(parsed.rows.find((row) => row.isOrganic).productId, "91000000002");
  assert.deepEqual(parsed.rankStructureSummary, {
    lastOrganicRawRank: 2,
    adSlotCount: 1,
    uniqueRankedAdCount: 1,
    helperSlotCount: 1,
    supersavingSlotCount: 1,
    acceptedRankOffset: 1,
  });
  assert.equal(JSON.stringify(parsed).includes("99999999999"), false);
  assert.equal(JSON.stringify(parsed).includes("private-image"), false);
});

test("fails closed when a product rank shift has no explicit ranked ad explanation", () => {
  const payload = nextDataFixture({
    total: 1,
    entries: [nextDataAuxiliary(1), nextDataProduct(2)],
  });

  assert.throws(
    () => parseNaverNextDataPage(payload, { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError
      && error.code === "naver_next_data_rank_drift"
      && error.detail === "p1:i1:r2:e1:o0:m1:f-:z-:u-:d0:v-:n0:a0:q0:h1:s0"
      && `${error.code}:${error.detail}`.length <= 80,
  );
});

test("reports bounded structural diagnostics for each observed mixed-ad rank drift shape", () => {
  const fixtures = [
    { index: 34, expectedRank: 20, adSlotCount: 15, supersavingSlotCount: 1, first: 33, last: 33, duplicate: 0 },
    { index: 36, expectedRank: 21, adSlotCount: 16, supersavingSlotCount: 1, first: 35, last: 35, duplicate: 1 },
    { index: 38, expectedRank: 23, adSlotCount: 16, supersavingSlotCount: 1, first: 37, last: 37, duplicate: 1 },
    { index: 46, expectedRank: 31, adSlotCount: 16, supersavingSlotCount: 2, first: 44, last: 45, duplicate: 1 },
    { index: 47, expectedRank: 32, adSlotCount: 16, supersavingSlotCount: 2, first: 45, last: 46, duplicate: 1 },
  ];

  for (const fixture of fixtures) {
    const expectedDetail = [
      "p1",
      `i${fixture.index.toString(36)}`,
      `r${(fixture.expectedRank + 1).toString(36)}`,
      `e${fixture.expectedRank.toString(36)}`,
      "o0",
      `m${fixture.expectedRank.toString(36)}`,
      `f${fixture.first.toString(36)}`,
      `z${fixture.last.toString(36)}`,
      "uf",
      `d${fixture.duplicate.toString(36)}`,
      `v${(fixture.expectedRank - 1).toString(36)}`,
      `n${fixture.supersavingSlotCount.toString(36)}`,
      `a${fixture.adSlotCount.toString(36)}`,
      "qf",
      "h0",
      `s${fixture.supersavingSlotCount.toString(36)}`,
    ].join(":");
    assert.throws(
      () => parseNaverNextDataPage(nextDataFixture({
        total: 300,
        entries: productionRankDriftEntries(fixture),
      }), { pageIndex: 1, keyword: "온열찜질기" }),
      (error) => error instanceof ProviderError
        && error.code === "naver_next_data_rank_drift"
        && error.detail === expectedDetail
        && `${error.code}:${error.detail}`.length <= 80,
      expectedDetail,
    );
  }
});

test("rank drift diagnostics never contain product fields and have a fixed bounded grammar", () => {
  const entries = productionRankDriftEntries({
    expectedRank: 20,
    adSlotCount: 15,
    supersavingSlotCount: 1,
  });
  entries.at(-1).item.productTitle = "PRIVATE_TITLE_MUST_NOT_APPEAR";
  entries.at(-1).item.imageUrl = "https://private.invalid/PRIVATE_IMAGE";
  entries.at(-1).item.mallProductId = "987654321012345";
  entries.at(-1).item.parentCatalogId = "876543210123456";

  assert.throws(
    () => parseNaverNextDataPage(nextDataFixture({
      total: 300,
      entries,
      keyword: "PRIVATE_KEYWORD_MUST_NOT_APPEAR",
    }), {
      pageIndex: 1,
      keyword: "PRIVATE_KEYWORD_MUST_NOT_APPEAR",
    }),
    (error) => {
      const persisted = `${error.code}:${error.detail}`;
      return error instanceof ProviderError
        && error.code === "naver_next_data_rank_drift"
        && /^p[1-8]:i(?:-|[0-9a-z]{1,2}):r(?:-|[0-9a-z]{1,2}):e(?:-|[0-9a-z]{1,2}):o(?:-|[0-9a-z]{1,2}):m(?:-|[0-9a-z]{1,2}):f(?:-|[0-9a-z]{1,2}):z(?:-|[0-9a-z]{1,2}):u(?:-|[0-9a-z]{1,2}):d(?:-|[0-9a-z]{1,2}):v(?:-|[0-9a-z]{1,2}):n(?:-|[0-9a-z]{1,2}):a(?:-|[0-9a-z]{1,2}):q(?:-|[0-9a-z]{1,2}):h(?:-|[0-9a-z]{1,2}):s(?:-|[0-9a-z]{1,2})$/u.test(error.detail)
        && persisted.length <= 80
        && !/private|987654321012345|876543210123456/iu.test(persisted);
    },
  );
});

test("rank drift diagnostics replace oversized structural counters instead of exceeding 80 characters", () => {
  const entries = [
    ...Array.from({ length: 100 }, () => nextDataAd(1)),
    ...Array.from({ length: 99 }, (_, index) => nextDataProduct(index + 1)),
    ...Array.from({ length: 100 }, () => nextDataSupersaving(15)),
    nextDataProduct(101),
  ];

  assert.throws(
    () => parseNaverNextDataPage(nextDataFixture({ total: 300, entries }), {
      pageIndex: 1,
      keyword: "온열찜질기",
    }),
    (error) => error instanceof ProviderError
      && error.code === "naver_next_data_rank_drift"
      && decodeNaverRankDriftDetail(error.detail)?.variant === "current-page"
      && `${error.code}:${error.detail}`.length <= 80
      && /^[a-z0-9:-]+$/u.test(error.detail),
  );
});

test("rank drift detail codec round-trips both variants and rejects non-canonical input", () => {
  const current = "p1:iy:rl:ek:o0:mk:fx:zx:uf:d0:vj:n1:af:qf:h0:s1";
  assert.deepEqual(decodeNaverRankDriftDetail(current), {
    variant: "current-page",
    values: {
      p: 1, i: 34, r: 21, e: 20, o: 0, m: 20, f: 33, z: 33,
      u: 15, d: 0, v: 19, n: 1, a: 15, q: 15, h: 0, s: 1,
    },
  });
  const previous = "p2:i0:r16:e15:o0:m15:a0:q0:h0:s0:l15:b1:c1:g1:t0:y1";
  assert.equal(decodeNaverRankDriftDetail(previous)?.variant, "previous-page");
  const worstCase = "p8:i-:rb4:eb4:ob4:mb4:a-:q-:h-:s-:lb4:bb4:c-:g-:t-:y-";
  assert.equal(worstCase.length, 53);
  assert.equal(`naver_next_data_rank_drift:${worstCase}`.length, 80);
  assert.match(`naver_next_data_rank_drift:${worstCase}`, /^[a-z0-9_:-]{3,80}$/u);
  assert.equal(decodeNaverRankDriftDetail(worstCase)?.variant, "previous-page");
  for (const invalid of [
    `${current}:x0`,
    current.toUpperCase(),
    current.replace("iy", "i00"),
    current.replace("iy", "iPRIVATE"),
    "p1:i-:r-:e-",
  ]) assert.equal(decodeNaverRankDriftDetail(invalid), null);
});

test("count mismatch uses the same bounded rank-drift formatter", () => {
  assert.throws(
    () => parseNaverNextDataPage(nextDataFixture({
      total: 1,
      entries: [nextDataProduct(1), nextDataProduct(2)],
    }), { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError
      && error.code === "naver_next_data_rank_drift"
      && error.detail === "p1:i-:r2:e1:o0:m-:f-:z-:u-:d0:v2:n0:a0:q0:h0:s0"
      && decodeNaverRankDriftDetail(error.detail)?.variant === "current-page"
      && `${error.code}:${error.detail}`.length <= 80,
  );
});

test("fails closed when rank drift exceeds the explicit ranked ad budget", () => {
  const payload = nextDataFixture({
    total: 1,
    entries: [
      {
        type: "supersaving",
        item: { collection: "product", rank: 1, id: "99999999998" },
      },
      nextDataProduct(3),
    ],
  });

  assert.throws(
    () => parseNaverNextDataPage(payload, { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError
      && error.code === "naver_next_data_rank_drift"
      && error.detail === "p1:i1:r3:e1:o0:m2:f0:z0:u1:d0:v-:n1:a1:q1:h0:s1",
  );
});

test("requires unique contiguous ad ranks instead of counting arbitrary ad rows", () => {
  const corruptions = [
    {
      label: "unrelated high ad rank",
      entries: [
        { type: "supersaving", item: { collection: "product", rank: 400 } },
        nextDataProduct(2),
      ],
    },
    {
      label: "duplicate ad ranks",
      entries: [
        { type: "supersaving", item: { collection: "product", rank: 1 } },
        { type: "supersaving", item: { collection: "product", rank: 1 } },
        nextDataProduct(3),
      ],
    },
    {
      label: "ad collides with shifted product rank",
      entries: [
        { type: "supersaving", item: { collection: "product", rank: 2 } },
        nextDataProduct(2),
      ],
    },
  ];

  for (const fixture of corruptions) {
    assert.throws(
      () => parseNaverNextDataPage(nextDataFixture({
        total: 1,
        entries: fixture.entries,
      }), { pageIndex: 1, keyword: "온열찜질기" }),
      (error) => error instanceof ProviderError
        && error.code === "naver_next_data_rank_drift",
      fixture.label,
    );
  }
});

test("never exposes identifier-sized malformed ranks in drift diagnostics", () => {
  const payload = nextDataFixture({
    total: 1,
    entries: [nextDataProduct(9_999_999_999)],
  });

  assert.throws(
    () => parseNaverNextDataPage(payload, { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError
      && error.code === "naver_next_data_rank_drift"
      && error.detail === "p1:i0:r-:e1:o0:m-:f-:z-:u-:d0:v-:n0:a0:q0:h0:s0"
      && !error.detail.includes("9999999999"),
  );
});

test("fails closed when a non-product composite row carries organic product evidence", () => {
  const productLike = nextDataAuxiliary(1, {
    item: {
      collection: "product",
      rank: 1,
      mallProductId: "12000000001",
      productTitle: "상품처럼 보이는 비허용 행",
    },
  });
  assert.throws(
    () => parseNaverNextDataPage(nextDataFixture({
      total: 1,
      entries: [productLike],
    }), { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError
      && error.code === "naver_next_data_schema_drift"
      && error.detail === "compositeList.list.0.type.recommendation",
  );
});

test("fails closed for an unknown same-title wrong-seller composite with product evidence", () => {
  const maliciousUnknown = {
    type: "recommendation",
    item: {
      collection: "product",
      rank: 1,
      id: "99999999998",
      parentCatalogId: "59776958987",
      mallProductId: "99999999999",
      productTitle: "NEXT 상품 1",
      imageUrl: "https://shopping-phinf.pstatic.net/91000000001.jpg",
    },
  };

  assert.throws(
    () => parseNaverNextDataPage(nextDataFixture({
      total: 1,
      entries: [maliciousUnknown, nextDataProduct(1)],
    }), { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError
      && error.code === "naver_next_data_schema_drift"
      && error.detail === "compositeList.list.0.type.recommendation",
  );
});

test("fails closed when an unknown composite carries any direct product signal", () => {
  const directProductSignals = [
    ["id", "99999999998"],
    ["productId", "99999999998"],
    ["catalogId", "59776958987"],
    ["linkedCatalogId", "59776958987"],
    ["parentId", "59776958987"],
    ["sellerProductId", "99999999999"],
    ["mallProductUrl", "https://smartstore.naver.com/example/products/99999999999"],
    ["mallProdMblUrl", "https://m.smartstore.naver.com/example/products/99999999999"],
    ["mblProdUrl", "https://m.smartstore.naver.com/example/products/99999999999"],
    ["mallPcUrl", "https://smartstore.naver.com/example/products/99999999999"],
    ["imageUrl", "https://shopping-phinf.pstatic.net/99999999998.jpg"],
  ];

  for (const [field, value] of directProductSignals) {
    assert.throws(
      () => parseNaverNextDataPage(nextDataFixture({
        total: 1,
        entries: [{
          type: "recommendation",
          item: { collection: "recommendation", [field]: value },
        }, nextDataProduct(1)],
      }), { pageIndex: 1, keyword: "온열찜질기" }),
      (error) => error instanceof ProviderError
        && error.code === "naver_next_data_schema_drift"
        && error.detail === "compositeList.list.0.type.recommendation",
      `unknown composite with ${field} must fail closed`,
    );
  }
});

test("fails closed when an unknown composite nests a product container inside item", () => {
  const nestedProductContainers = [
    ["product", { id: "99999999998", mallProductId: "99999999999" }],
    ["products", [{ id: "99999999998", mallProductId: "99999999999" }]],
    ["items", [{ id: "99999999998", mallProductId: "99999999999" }]],
  ];

  for (const [field, value] of nestedProductContainers) {
    assert.throws(
      () => parseNaverNextDataPage(nextDataFixture({
        total: 1,
        entries: [{
          type: "recommendation",
          item: { collection: "recommendation", [field]: value },
        }, nextDataProduct(1)],
      }), { pageIndex: 1, keyword: "온열찜질기" }),
      (error) => error instanceof ProviderError
        && error.code === "naver_next_data_schema_drift"
        && error.detail === "compositeList.list.0.type.recommendation",
      `unknown composite with nested item.${field} must fail closed`,
    );
  }
});

test("does not widen the strict SSR allowlist to ad-like unknown composite names", () => {
  for (const type of ["foo_supersaving", "recommendation_paid", "brand_ad_module"]) {
    assert.throws(
      () => parseNaverNextDataPage(nextDataFixture({
        total: 1,
        entries: [{
          type,
          item: {
            collection: "product",
            rank: 1,
            mallProductId: "99999999999",
            productTitle: "NEXT 상품 1",
          },
        }, nextDataProduct(1)],
      }), { pageIndex: 1, keyword: "온열찜질기" }),
      (error) => error instanceof ProviderError
        && error.code === "naver_next_data_schema_drift"
        && error.detail === `compositeList.list.0.type.${type}`,
    );
  }
});

test("accepts Naver's internal spacing normalization only for the submitted query", () => {
  const parsed = parseNaverNextDataPage(nextDataFixture({
    total: 1,
    keyword: "자외선 차단 마스크",
    entries: [nextDataProduct(1)],
  }), { pageIndex: 1, keyword: "자외선차단마스크" });
  assert.equal(parsed.rows[0].sourceRank, 1);

  assert.throws(
    () => parseNaverNextDataPage(nextDataFixture({
      total: 1,
      keyword: "자외선 차단 크림",
      entries: [nextDataProduct(1)],
    }), { pageIndex: 1, keyword: "자외선차단마스크" }),
    (error) => error instanceof ProviderError && error.code === "naver_next_data_schema_drift",
  );
});

test("maps explicit parentCatalogId and product shape without treating parentId as a catalog", () => {
  const parsed = parseNaverNextDataPage(nextDataFixture({
    total: 2,
    entries: [
      nextDataCatalog(1, {
        lowMallList: [
          { nvMid: "59848607355", mallPid: "l927221885229" },
          { nvMid: "90871849857", mallPid: "13327339525" },
        ],
      }),
      nextDataProduct(2, {
        parentCatalogId: "71000000002",
        stdCatalogMatchType: "2",
      }),
    ],
  }), { pageIndex: 1, keyword: "온열찜질기" });
  const [catalog, matchedSingle] = parsed.rows;

  assert.equal(catalog.productId, "91000000001");
  assert.equal(catalog.catalogId, "91000000001");
  assert.equal(catalog.linkedCatalogId, "71000000001");
  assert.deepEqual(catalog.catalogSellerProductIds, ["13327339525"]);
  assert.equal(catalog.productType, 1);
  assert.equal(catalog.sellerProductId, undefined);

  assert.equal(matchedSingle.productId, "91000000002");
  assert.equal(matchedSingle.sellerProductId, "12000000002");
  assert.equal(matchedSingle.catalogId, "71000000002");
  assert.equal(matchedSingle.linkedCatalogId, "71000000002");
  assert.equal(matchedSingle.productType, 3);
});

test("fails closed when mallProductId conflicts with a direct seller-product link", () => {
  const payload = nextDataFixture({
    total: 1,
    entries: [nextDataProduct(1, { mallProductId: "12000000999" })],
  });
  assert.throws(
    () => parseNaverNextDataPage(payload, { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError && error.code === "naver_next_data_schema_drift",
  );
});

test("keeps an alphanumeric marketplace mallProductId explicitly unavailable instead of coercing it", () => {
  const parsed = parseNaverNextDataPage(nextDataFixture({
    total: 1,
    entries: [nextDataProduct(1, {
      mallId: "auction",
      mallProductId: "B480380324",
      mallProductUrl: "https://link.auction.co.kr/gate/pcs?item-no=B480380324",
    })],
  }), { pageIndex: 1, keyword: "온열찜질기" });

  assert.equal(parsed.rows[0].productId, "91000000001");
  assert.equal(parsed.rows[0].sellerProductId, undefined);
  assert.equal(parsed.rows[0].productType, 2);
});

test("verifies absolute __NEXT_DATA__ ranks across pages before appending one window", () => {
  const firstPage = parseNaverNextDataPage(nextDataFixture({
    pageIndex: 1,
    total: 42,
    entries: [nextDataAd(1), ...Array.from({ length: 40 }, (_, index) => nextDataProduct(index + 1))],
  }), { pageIndex: 1, keyword: "온열찜질기" });
  const secondPage = parseNaverNextDataPage(nextDataFixture({
    pageIndex: 2,
    total: 42,
    entries: [nextDataAd(2), nextDataProduct(41), nextDataProduct(42)],
  }), { pageIndex: 2, keyword: "온열찜질기" });
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };

  appendNormalizedPage(state, firstPage, { pageIndex: 1, limit: 300 });
  appendNormalizedPage(state, secondPage, { pageIndex: 2, limit: 300 });

  assert.equal(state.items.length, 42);
  assert.equal(state.excludedAdCount, 2);
  assert.deepEqual(state.items.map((item) => item.organicRank), Array.from({ length: 42 }, (_, index) => index + 1));
  assert.equal(state.items[40].title, "NEXT 상품 41");
  assert.equal(state.items[41].title, "NEXT 상품 42");
});

test("keeps a catalog card and its linked seller card as two distinct organic results", () => {
  const sharedCatalogId = "71000000001";
  const parsed = parseNaverNextDataPage(nextDataFixture({
    total: 2,
    entries: [
      nextDataCatalog(1, { parentCatalogId: sharedCatalogId }),
      nextDataProduct(2, {
        parentCatalogId: sharedCatalogId,
        stdCatalogMatchType: "2",
      }),
    ],
  }), { pageIndex: 1, keyword: "온열찜질기" });
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };

  appendNormalizedPage(state, parsed, { pageIndex: 1, limit: 2 });

  assert.equal(state.items.length, 2);
  assert.deepEqual(state.items.map((item) => item.organicRank), [1, 2]);
  assert.equal(state.items[0].catalogId, "91000000001");
  assert.equal(state.items[0].linkedCatalogId, sharedCatalogId);
  assert.equal(state.items[1].linkedCatalogId, sharedCatalogId);
});

test("builds an exact contiguous 1..300 organic window from eight strict pages", () => {
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
  for (let pageIndex = 1; pageIndex <= 8; pageIndex += 1) {
    const startRank = ((pageIndex - 1) * 40) + 1;
    const page = parseNaverNextDataPage(nextDataFixture({
      pageIndex,
      total: 10_000,
      entries: [
        nextDataAd(pageIndex),
        ...Array.from({ length: 40 }, (_, index) => nextDataProduct(startRank + index)),
      ],
    }), { pageIndex, keyword: "온열찜질기" });
    appendNormalizedPage(state, page, { pageIndex, limit: 300 });
  }

  assert.equal(state.items.length, 300);
  assert.equal(state.items[0].organicRank, 1);
  assert.equal(state.items[299].organicRank, 300);
  assert.deepEqual(
    state.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
});

test("preserves all 300 absolute rank slots and proves one stable cross-page repetition across two full passes", () => {
  const firstItems = stableOverlapItems();
  const secondItems = stableOverlapItems();
  const proof = buildStableFullWindowProof(firstItems, secondItems, {
    keyword: "온열찜질기",
    captureIds: ["native-pass-0001", "native-pass-0002"],
  });

  assert.equal(firstItems.length, 300);
  assert.deepEqual(firstItems.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1));
  assert.equal(firstItems[0].sellerProductId, firstItems[40].sellerProductId);
  assert.equal(proof.version, STABLE_FULL_WINDOW_PROOF_VERSION);
  assert.equal(proof.passDigests[0], proof.passDigests[1]);
  assert.match(proof.collisionDigest, /^[a-f0-9]{64}$/u);
});

test("stable cross-page proof fails closed for one changed rank slot or a replayed capture id", () => {
  const firstItems = stableOverlapItems();
  const changedItems = stableOverlapItems({ driftRank: 222 });

  assert.throws(
    () => buildStableFullWindowProof(firstItems, changedItems, {
      keyword: "온열찜질기",
      captureIds: ["native-pass-0001", "native-pass-0002"],
    }),
    (error) => error instanceof ProviderError
      && error.code === "provider_stable_window_unproven"
      && error.detail === "digest_mismatch",
  );
  assert.throws(
    () => buildStableFullWindowProof(firstItems, firstItems, {
      keyword: "온열찜질기",
      captureIds: ["native-pass-0001", "native-pass-0001"],
    }),
    (error) => error instanceof ProviderError
      && error.code === "provider_stable_window_unproven"
      && error.detail === "capture_ids",
  );
});

test("stable cross-page preservation requires strict absolute source ranks", () => {
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
  assert.throws(
    () => appendNormalizedPage(state, { rows: [rawProduct(1)] }, {
      pageIndex: 1,
      limit: 300,
      crossPageMode: STABLE_FULL_WINDOW_PROOF_VERSION,
    }),
    (error) => error instanceof ProviderError
      && error.code === "naver_next_data_rank_drift"
      && error.detail === "1:0:absolute_rank_missing",
  );
  assert.equal(state.items.length, 0);
});

test("builds an exact contiguous 1..300 window from eight frontend partial responses", () => {
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
  for (let pageIndex = 1; pageIndex <= 8; pageIndex += 1) {
    const startRank = ((pageIndex - 1) * 40) + 1;
    const page = parseNaverFrontendPage(frontendFixture({
      total: 10_000,
      products: Array.from({ length: 40 }, (_, index) => nextDataProduct(startRank + index)),
      adProducts: [nextDataAd(pageIndex).item],
      superSavingProducts: [{ id: String(99000010000 + pageIndex) }],
    }), { pageIndex, keyword: "온열찜질기" });
    appendNormalizedPage(state, page, { pageIndex, limit: 300 });
  }

  assert.equal(state.items.length, 300);
  assert.deepEqual(
    state.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
});

test("builds an exact 1..300 SSR window while excluding rankless composite helpers", () => {
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
  for (let pageIndex = 1; pageIndex <= 8; pageIndex += 1) {
    const startRank = ((pageIndex - 1) * 40) + 1;
    const page = parseNaverNextDataPage(nextDataFixture({
      pageIndex,
      total: 10_000,
      entries: [
        nextDataAuxiliary(pageIndex),
        ...Array.from({ length: 40 }, (_, index) => nextDataProduct(startRank + index)),
      ],
    }), { pageIndex, keyword: "온열찜질기" });
    appendNormalizedPage(state, page, { pageIndex, limit: 300 });
  }

  assert.equal(state.items.length, 300);
  assert.equal(state.excludedAdCount, 0);
  assert.deepEqual(
    state.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
});

test("fails closed when __NEXT_DATA__ schema, page parameters, or ranks drift", () => {
  const missingList = nextDataFixture({ total: 1, entries: [nextDataProduct(1)] });
  delete missingList.props.pageProps.compositeList.list;
  assert.throws(
    () => parseNaverNextDataPage(missingList, { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError && error.code === "naver_next_data_schema_drift",
  );

  const wrongPage = nextDataFixture({ pageIndex: 2, total: 41, entries: [nextDataProduct(41)] });
  assert.throws(
    () => parseNaverNextDataPage(wrongPage, { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError && error.code === "naver_next_data_schema_drift",
  );

  const rankGap = nextDataFixture({ total: 2, entries: [nextDataProduct(1), nextDataProduct(3)] });
  assert.throws(
    () => parseNaverNextDataPage(rankGap, { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError && error.code === "naver_next_data_rank_drift",
  );

  const incompletePage = nextDataFixture({ total: 100, entries: [nextDataProduct(1)] });
  assert.throws(
    () => parseNaverNextDataPage(incompletePage, { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError && error.code === "naver_next_data_rank_drift",
  );
});

test("rejects malformed __NEXT_DATA__ JSON instead of using a loose DOM fallback", () => {
  assert.throws(
    () => parseNaverNextDataPage("{not-json", { pageIndex: 1, keyword: "온열찜질기" }),
    (error) => error instanceof ProviderError && error.code === "naver_next_data_invalid_json",
  );
});

test("default page collection uses the first-party PART contract with cookies and no CAPTCHA bypass", async () => {
  const fixture = frontendFixture({ total: 1, products: [nextDataProduct(1)] });
  const stats = {};
  const url = buildNaverShoppingSearchUrl("온열찜질기", 1);
  const page = {
    async goto(receivedUrl) {
      stats.gotoUrl = receivedUrl;
      return { status: () => 200 };
    },
    async waitForFunction(callback) {
      stats.waitSource = String(callback);
    },
    async evaluate(callback, argument) {
      if (!argument) {
        stats.snapshotSource = String(callback);
        return {
          nextDataText: "",
          bodyText: "네이버 쇼핑 검색 결과",
          title: "온열찜질기 : 네이버 가격비교",
          url,
        };
      }
      stats.frontendSource = String(callback);
      stats.frontendArgument = argument;
      return {
        status: 200,
        url: `https://search.shopping.naver.com${argument.requestPath}`,
        contentType: "application/json; charset=utf-8",
        bodyText: JSON.stringify(fixture),
      };
    },
  };

  const result = await defaultCollectPage({ page, url, pageIndex: 1, timeoutMs: 1_000 });
  assert.equal(stats.gotoUrl, url);
  assert.match(stats.waitSource, /__NEXT_DATA__/u);
  assert.equal(new URL(stats.frontendArgument.requestPath, url).pathname, "/api/search/all");
  assert.match(stats.frontendSource, /credentials:\s*"include"/u);
  assert.match(stats.frontendSource, /logic:\s*"PART"/u);
  assert.doesNotMatch(stats.frontendSource, /["']x-wtm-ncaptcha-token["']\s*:/u);
  assert.match(stats.frontendSource, /window\.ncaptcha\?\.f/u);
  assert.doesNotMatch(stats.frontendSource, /window\.ncaptcha\?\.f\s*\(/u);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sourceRank, 1);
  assert.equal(result.rows[0].productType, 2);
});

test("falls back to strict SSR only when the partial-search route is unsupported", async () => {
  const fixture = nextDataFixture({ total: 1, entries: [nextDataProduct(1)] });
  const url = buildNaverShoppingSearchUrl("온열찜질기", 1);
  let evaluateCalls = 0;
  const page = {
    async goto() { return { status: () => 200 }; },
    async waitForFunction() {},
    async evaluate(_callback, argument) {
      evaluateCalls += 1;
      if (!argument) {
        return {
          nextDataText: JSON.stringify(fixture),
          bodyText: "네이버 쇼핑 검색 결과",
          title: "온열찜질기 : 네이버 가격비교",
          url,
        };
      }
      return {
        status: 404,
        url: `https://search.shopping.naver.com${argument.requestPath}`,
        contentType: "text/html",
        bodyText: "not found",
      };
    },
  };

  const result = await defaultCollectPage({ page, url, pageIndex: 1, timeoutMs: 1_000 });
  assert.equal(evaluateCalls, 2);
  assert.equal(result.rows[0].sourceRank, 1);
});

test("default page collection preserves a typed 418 before parsing missing __NEXT_DATA__", async () => {
  const url = buildNaverShoppingSearchUrl("온열찜질기", 1);
  const page = {
    async goto() { return { status: () => 418 }; },
    async waitForFunction() {},
    async evaluate() {
      return {
        nextDataText: "",
        bodyText: "",
        title: "",
        url,
      };
    },
  };
  await assert.rejects(
    defaultCollectPage({ page, url, pageIndex: 1, timeoutMs: 1_000 }),
    (error) => error instanceof ProviderError && error.code === "naver_http_418",
  );
});

test("uses Playwright's official Chromium channel while keeping request contexts isolated", async () => {
  const browserStats = {};
  const provider = createFixtureProvider({
    browserStats,
    collectPage: async ({ url }) => {
      const keyword = new URL(url).searchParams.get("query");
      const offset = keyword === "첫번째" ? 100 : 200;
      return { rows: [rawProduct(offset)], marketTotal: 10, sourceExhausted: false };
    },
  });

  await provider.collect(rankRequest("첫번째", 1));
  await provider.collect(rankRequest("두번째", 1));

  assert.deepEqual(browserStats.launchOptions, { headless: true, channel: "chromium" });
  assert.equal(browserStats.contexts, 2, "each request must keep a fresh anonymous context");
  assert.equal(browserStats.closedContexts, 2);
  assert.equal(browserStats.pages, 2);
  await provider.close();
  assert.equal(browserStats.browserClosed, true);
});

test("accepts only a private, owned, dedicated profile with both non-secret markers", (t) => {
  const fakeHome = path.resolve(os.tmpdir(), "mi-example-home");
  assert.equal(
    defaultNaverShoppingProfileDir(fakeHome),
    path.join(fakeHome, "Library", "Application Support", "MomentInsight", "NaverShoppingProfile"),
  );
  assert.throws(
    () => validateNaverShoppingProfileDir("relative/profile"),
    (error) => error instanceof ProviderError && error.code === "provider_profile_path_not_allowed",
  );

  const valid = createProfileFixture(t);
  assert.equal(
    validateNaverShoppingProfileDir(valid.profileDir, { expectedDir: valid.profileDir }),
    valid.profileDir,
  );
  assert.throws(
    () => validateNaverShoppingProfileDir(path.join(valid.root, "Google", "Chrome"), {
      expectedDir: valid.profileDir,
    }),
    (error) => error instanceof ProviderError && error.code === "provider_profile_path_not_allowed",
  );

  const missingOwner = createProfileFixture(t, { ownerMarker: false, authMarker: false });
  assert.throws(
    () => validateNaverShoppingProfileDir(missingOwner.profileDir, {
      expectedDir: missingOwner.profileDir,
    }),
    (error) => error instanceof ProviderError && error.code === "provider_profile_marker_missing",
  );
  const missingAuth = createProfileFixture(t, { authMarker: false });
  assert.throws(
    () => validateNaverShoppingProfileDir(missingAuth.profileDir, {
      expectedDir: missingAuth.profileDir,
    }),
    (error) => error instanceof ProviderError && error.code === "provider_profile_auth_missing",
  );
  const invalidAuth = createProfileFixture(t, { authMarkerValue: "{}" });
  assert.throws(
    () => validateNaverShoppingProfileDir(invalidAuth.profileDir, {
      expectedDir: invalidAuth.profileDir,
    }),
    (error) => error instanceof ProviderError && error.code === "provider_profile_auth_invalid",
  );
  const authWithUnexpectedData = createProfileFixture(t, {
    authMarkerValue: JSON.stringify({
      schema: NAVER_SHOPPING_PROFILE_AUTH_MARKER_SCHEMA,
      authenticatedAt: "2026-08-02T00:00:00.000Z",
      cookie: "must-not-be-stored-here",
    }),
  });
  assert.throws(
    () => validateNaverShoppingProfileDir(authWithUnexpectedData.profileDir, {
      expectedDir: authWithUnexpectedData.profileDir,
    }),
    (error) => error instanceof ProviderError && error.code === "provider_profile_auth_invalid",
  );

  if (process.platform !== "win32") {
    const publicProfile = createProfileFixture(t, { mode: 0o755 });
    assert.throws(
      () => validateNaverShoppingProfileDir(publicProfile.profileDir, {
        expectedDir: publicProfile.profileDir,
      }),
      (error) => error instanceof ProviderError && error.code === "provider_profile_permissions_invalid",
    );

    const symlinkRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mi-n-shopping-symlink-"));
    const target = path.join(symlinkRoot, "target");
    const linkedProfile = path.join(symlinkRoot, "NaverShoppingProfile");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, linkedProfile, "dir");
    t.after(() => fs.rmSync(symlinkRoot, { recursive: true, force: true }));
    assert.throws(
      () => validateNaverShoppingProfileDir(linkedProfile, { expectedDir: linkedProfile }),
      (error) => error instanceof ProviderError && error.code === "provider_profile_symlink_not_allowed",
    );

    const ancestorRoot = fs.mkdtempSync(path.join(
      fs.realpathSync(os.tmpdir()),
      "mi-n-shopping-ancestor-symlink-",
    ));
    const libraryDir = path.join(ancestorRoot, "Library");
    const realApplicationSupport = path.join(ancestorRoot, "real-application-support");
    const realProfile = path.join(realApplicationSupport, "MomentInsight", "NaverShoppingProfile");
    fs.mkdirSync(libraryDir, { mode: 0o700 });
    fs.mkdirSync(realProfile, { recursive: true, mode: 0o700 });
    fs.chmodSync(realProfile, 0o700);
    fs.writeFileSync(
      path.join(realProfile, NAVER_SHOPPING_PROFILE_OWNER_MARKER),
      `${NAVER_SHOPPING_PROFILE_OWNER_MARKER_VALUE}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(realProfile, NAVER_SHOPPING_PROFILE_AUTH_MARKER),
      `${JSON.stringify({
        schema: NAVER_SHOPPING_PROFILE_AUTH_MARKER_SCHEMA,
        authenticatedAt: "2026-08-02T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const linkedApplicationSupport = path.join(libraryDir, "Application Support");
    fs.symlinkSync(realApplicationSupport, linkedApplicationSupport, "dir");
    const ancestorLinkedProfile = path.join(
      linkedApplicationSupport,
      "MomentInsight",
      "NaverShoppingProfile",
    );
    t.after(() => fs.rmSync(ancestorRoot, { recursive: true, force: true }));
    assert.throws(
      () => validateNaverShoppingProfileDir(ancestorLinkedProfile, {
        expectedDir: ancestorLinkedProfile,
      }),
      (error) => error instanceof ProviderError && error.code === "provider_profile_symlink_not_allowed",
    );
  }
});

test("real local-worker policy defaults to the dedicated profile and rejects unsafe overrides before launch", async () => {
  const env = {
    MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
    NAVER_SHOPPING_PROVIDER_SEARCH_HOST: "msearch.shopping.naver.com",
    NAVER_SHOPPING_PROVIDER_HEADLESS: "false",
    NAVER_SHOPPING_PROVIDER_CHANNEL: "chromium",
  };
  const defaulted = createPlaywrightProvider({ autoVerify: false, env });
  assert.equal(defaulted.__testing.config.userDataDir, defaultNaverShoppingProfileDir());
  await defaulted.close();

  const unsafe = createPlaywrightProvider({
    autoVerify: false,
    env: { ...env, NAVER_SHOPPING_PROVIDER_USER_DATA_DIR: "relative/profile" },
  });
  await assert.rejects(
    unsafe.collect(rankRequest("온열찜질기", 1)),
    (error) => error instanceof ProviderError && error.code === "provider_profile_path_not_allowed",
  );
  await unsafe.close();
});

test("reuses one validated persistent context while closing every request page", async (t) => {
  const { profileDir } = createProfileFixture(t);
  const stats = {};
  const provider = createPlaywrightProvider({
    autoVerify: false,
    persistentContextFactory: fakePersistentContextFactory(stats),
    profileValidator: (value) => validateNaverShoppingProfileDir(value, { expectedDir: profileDir }),
    collectPage: async ({ url }) => {
      const keyword = new URL(url).searchParams.get("query");
      return {
        rows: [rawProduct(keyword === "첫번째" ? 301 : 302)],
        marketTotal: 10,
        sourceExhausted: false,
      };
    },
    config: {
      browserChannel: "chromium",
      localWorkerEnabled: true,
      searchHost: "msearch.shopping.naver.com",
      headless: false,
      userDataDir: profileDir,
      canaryKeyword: "온열찜질기",
      timeoutMs: 100_000,
      pageTimeoutMs: 10_000,
    },
  });

  await provider.collect(rankRequest("첫번째", 1));
  await provider.collect(rankRequest("두번째", 1));
  assert.equal(stats.launchOptions.userDataDir, profileDir);
  assert.equal(stats.launchOptions.headless, false);
  assert.equal(stats.launchOptions.channel, "chromium");
  assert.deepEqual(stats.launchOptions.contextOptions, {
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1200 },
    colorScheme: "light",
  });
  assert.equal(stats.closedInitialPages, 1);
  assert.equal(stats.pages, 2);
  assert.equal(stats.closedPages, 2);
  assert.equal(stats.contextClosed || 0, 0);
  await provider.close();
  assert.equal(stats.contextClosed, 1);
});

test("provider source never extracts browser credentials or performs CAPTCHA bypass", () => {
  const source = fs.readFileSync(new URL("../src/provider.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.cookies\s*\(/u);
  assert.doesNotMatch(source, /\.storageState\s*\(/u);
  assert.doesNotMatch(source, /\.fill\s*\([^)]*password/iu);
  assert.doesNotMatch(source, /window\.ncaptcha\?\.f\s*\(/u);
  assert.doesNotMatch(source, /["']x-wtm-ncaptcha-token["']\s*:/u);
});

test("rejects unsupported browser channels before launching a browser", () => {
  assert.throws(
    () => createPlaywrightProvider({
      browserFactory: fakeBrowserFactory(),
      autoVerify: false,
      config: { browserChannel: "chrome" },
    }),
    (error) => error instanceof ProviderError && error.code === "provider_browser_channel_not_allowed",
  );
});

test("accepts market totals only from explicit total-result copy", () => {
  assert.equal(marketTotalFromTexts(["상품 2개 묶음 할인"]), null);
  assert.equal(marketTotalFromTexts(["전체 상품 12,345개"]), 12345);
  assert.equal(marketTotalFromTexts(["1,234건 검색 결과"]), 1234);
});

test("excludes explicit advertisements before assigning contiguous organic ranks", () => {
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
  appendNormalizedPage(state, {
    rows: [
      rawProduct(1, { badgeTexts: ["광고"] }),
      rawProduct(2, { links: ["https://cr.shopping.naver.com/adcr.nhn?x=organic"] }),
      rawProduct(3),
    ],
  }, { pageIndex: 1, limit: 3 });

  assert.equal(state.rawCount, 3);
  assert.equal(state.excludedAdCount, 1);
  assert.deepEqual(state.items.map((item) => item.organicRank), [1, 2]);
  assert.equal(state.items[0].isAd, false, "adcr alone must not classify an organic product as an ad");
});

test("deduplicates repeated extraction but rejects strong duplicate identities with collision scope", () => {
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
  appendNormalizedPage(state, {
    rows: [rawProduct(1), rawProduct(1)],
  }, { pageIndex: 1, limit: 3 });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].organicRank, 1);

  assert.throws(() => appendNormalizedPage(state, {
    rows: [rawProduct(1, { extractionKey: "another-real-card" })],
  }, { pageIndex: 2, limit: 3 }), (error) => (
    error instanceof ProviderError
    && error.code === "provider_duplicate_identity"
    && error.detail === "2:0:page_overlap:1"
  ));
  assert.equal(state.items.length, 1, "a duplicate result must fail instead of compressing later organic ranks");
});

test("keeps distinct seller cards when only their weak provider productId collides", () => {
  const parsed = parseNaverNextDataPage(nextDataFixture({
    total: 2,
    entries: [
      nextDataProduct(1),
      nextDataProduct(2, {
        id: "91000000001",
        mallProductId: "12000000002",
        mallProductUrl: "https://smartstore.naver.com/example/products/12000000002",
        productTitle: "같은 provider productId의 별도 판매자 상품",
      }),
    ],
  }), { pageIndex: 1, keyword: "온열찜질기" });
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };

  appendNormalizedPage(state, parsed, { pageIndex: 1, limit: 2 });

  assert.equal(state.items.length, 2);
  assert.deepEqual(state.items.map((item) => item.organicRank), [1, 2]);
  assert.deepEqual(state.items.map((item) => item.sellerProductId), [
    "12000000001",
    "12000000002",
  ]);
});

test("keeps an authoritative same-page duplicate seller row without compressing organic rank", () => {
  const first = rawProduct(31);
  const duplicateSeller = rawProduct(32, { extractionKey: "duplicate-seller-card" });
  duplicateSeller.payload = JSON.stringify({
    nvMid: String(70000000032),
    chnl_prod_no: String(80000000031),
    productName: "동일 판매자 상품의 중복 행",
    productType: 2,
  });
  const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };

  appendNormalizedPage(state, { rows: [first, duplicateSeller] }, { pageIndex: 1, limit: 2 });
  assert.equal(state.items.length, 2);
  assert.deepEqual(state.items.map((item) => item.organicRank), [1, 2]);
  assert.equal(state.items[0].sellerProductId, state.items[1].sellerProductId);
});

test("classifies 418, 429, block text, CAPTCHA, auth redirect, and invalid navigation with typed errors", () => {
  const cases = [
    [{ status: 418, url: "https://search.shopping.naver.com/search/all" }, "naver_http_418"],
    [{ status: 429, url: "https://search.shopping.naver.com/search/all" }, "naver_http_429"],
    [{ status: 200, url: "https://search.shopping.naver.com/search/all", bodyText: "비정상적인 접근입니다." }, "naver_access_blocked"],
    [{ status: 200, url: "https://search.shopping.naver.com/search/all", bodyText: "CAPTCHA" }, "naver_captcha_detected"],
    [{ status: 200, url: "https://nid.naver.com/nidlogin.login" }, "naver_auth_required"],
    [{ status: 200, url: "https://evil.example/search/all" }, "provider_navigation_not_allowed"],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => classifyNaverPage(input), (error) => error instanceof ProviderError && error.code === code);
  }
});

test("emits a bounded exact 403 code without exposing response HTML or detail", () => {
  const sentinel = "RAW_403_RESPONSE_MUST_NOT_ESCAPE";
  let caught = null;
  try {
    classifyNaverPage({
      status: "403",
      url: "https://search.shopping.naver.com/search/all",
      title: `Forbidden ${sentinel}`,
      bodyText: `<html><body>${sentinel}</body></html>`,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof ProviderError);
  assert.equal(caught.code, "naver_http_403");
  assert.equal(caught.message, "naver_http_403");
  assert.equal(caught.detail, "");
  assert.doesNotMatch(`${caught.stack}\n${JSON.stringify(caught)}`, new RegExp(sentinel));
});

test("keeps the exact 403 reason bounded while provider cooldown prevents immediate replay", async () => {
  const current = Date.parse("2026-08-01T00:00:00.000Z");
  let calls = 0;
  const sentinel = "RAW_403_STATUS_MUST_NOT_ESCAPE";
  const provider = createFixtureProvider({
    now: () => current,
    config: { blockCooldownMs: 2_000 },
    collectPage: async () => {
      calls += 1;
      return classifyNaverPage({
        status: 403,
        url: "https://search.shopping.naver.com/search/all",
        bodyText: `<html>${sentinel}</html>`,
      });
    },
  });

  assert.equal(await provider.verifyReadiness({ force: true }), false);
  const status = await provider.status();
  assert.equal(status.verified, false);
  assert.equal(status.reason, "naver_http_403");
  assert.doesNotMatch(JSON.stringify(status), new RegExp(sentinel));
  await assert.rejects(
    provider.collect(rankRequest("403즉시재시도금지", 1, current)),
    (error) => error instanceof ProviderError
      && error.code === "provider_cooldown_active"
      && error.detail === "naver_http_403",
  );
  assert.equal(calls, 1);
  await provider.close();
});

test("proves source exhaustion only on an empty result page with no product rows", () => {
  const base = {
    status: 200,
    url: "https://search.shopping.naver.com/search/all?query=test",
    bodyText: "조건에 맞는 상품이 없습니다.",
  };
  assert.equal(classifyNaverPage({ ...base, rowCount: 1 }).sourceExhausted, false);
  assert.equal(classifyNaverPage({ ...base, rowCount: 0 }).sourceExhausted, true);
});

test("keeps readiness false until a live collection passes contract verification", async () => {
  let calls = 0;
  const provider = createFixtureProvider({
    collectPage: async () => {
      calls += 1;
      return { rows: [rawProduct(1), rawProduct(2)], marketTotal: 100, sourceExhausted: false };
    },
  });
  assert.equal((await provider.status()).verified, false);
  assert.equal(await provider.verifyReadiness({ force: true }), true);
  assert.equal((await provider.status()).verified, true);
  assert.equal(calls, 1);
  await provider.close();
});

test("keeps readiness false and exposes the typed blocker when Naver returns 418", async () => {
  const provider = createFixtureProvider({
    collectPage: async () => { throw new ProviderError("naver_http_418"); },
  });
  assert.equal(await provider.verifyReadiness({ force: true }), false);
  const status = await provider.status();
  assert.equal(status.verified, false);
  assert.equal(status.reason, "naver_http_418");
  await provider.close();
});

test("verifies rank readiness even when the optional market total is unavailable", async () => {
  const provider = createFixtureProvider({
    collectPage: async () => ({
      rows: [rawProduct(1), rawProduct(2)],
      marketTotal: null,
      sourceExhausted: false,
    }),
  });
  assert.equal(await provider.verifyReadiness({ force: true }), true);
  assert.equal((await provider.status()).verified, true);
  const result = await provider.collect(rankRequest("온열찜질기", 2));
  assert.equal(result.marketTotal, null);
  assert.equal(result.marketTotalStatus, "unavailable");
  await provider.close();
});

test("invalidates a prior readiness proof immediately after a runtime source failure", async () => {
  let failRuntime = false;
  const provider = createFixtureProvider({
    collectPage: async () => {
      if (failRuntime) throw new ProviderError("naver_http_418");
      return { rows: [rawProduct(1), rawProduct(2)], marketTotal: 100, sourceExhausted: false };
    },
  });
  assert.equal(await provider.verifyReadiness({ force: true }), true);
  assert.equal((await provider.status()).verified, true);

  failRuntime = true;
  await assert.rejects(
    provider.collect(rankRequest("다른키워드", 1)),
    (error) => error instanceof ProviderError && error.code === "naver_http_418",
  );
  const status = await provider.status();
  assert.equal(status.verified, false);
  assert.equal(status.reason, "naver_http_418");
  await provider.close();
});

test("does not immediately retry 418 or schema drift while its typed cooldown is active", async () => {
  let current = Date.parse("2026-08-01T00:00:00.000Z");
  let mode = "ok";
  let calls = 0;
  const provider = createFixtureProvider({
    now: () => current,
    config: { blockCooldownMs: 2_000, schemaCooldownMs: 4_000 },
    collectPage: async () => {
      calls += 1;
      if (mode === "blocked") throw new ProviderError("naver_http_418");
      if (mode === "schema") throw new ProviderError("naver_frontend_schema_drift");
      return { rows: [rawProduct(calls)], marketTotal: 100, sourceExhausted: false };
    },
  });

  await provider.collect(rankRequest("준비", 1, current));
  mode = "blocked";
  await assert.rejects(
    provider.collect(rankRequest("차단", 1, current)),
    (error) => error instanceof ProviderError && error.code === "naver_http_418",
  );
  const callsAfterBlock = calls;
  await assert.rejects(
    provider.collect(rankRequest("즉시재시도금지", 1, current)),
    (error) => error instanceof ProviderError
      && error.code === "provider_cooldown_active"
      && error.detail === "naver_http_418",
  );
  assert.equal(calls, callsAfterBlock);

  current += 2_001;
  mode = "schema";
  await assert.rejects(
    provider.collect(rankRequest("스키마", 1, current)),
    (error) => error instanceof ProviderError && error.code === "naver_frontend_schema_drift",
  );
  const callsAfterSchema = calls;
  await assert.rejects(
    provider.collect(rankRequest("스키마즉시재시도금지", 1, current)),
    (error) => error instanceof ProviderError
      && error.code === "provider_cooldown_active"
      && error.detail === "naver_frontend_schema_drift",
  );
  assert.equal(calls, callsAfterSchema);

  current += 4_001;
  mode = "ok";
  const recovered = await provider.collect(rankRequest("회복", 1, current));
  assert.equal(recovered.checkedCount, 1);
  await provider.close();
});

test("rank drift invalidates readiness without cooling down the next keyword", async () => {
  let calls = 0;
  const provider = createFixtureProvider({
    config: { schemaCooldownMs: 60_000 },
    collectPage: async ({ url }) => {
      calls += 1;
      const keyword = new URL(url).searchParams.get("query");
      if (keyword === "순위드리프트") {
        throw new ProviderError("naver_next_data_rank_drift", "p1:i1:r2:e1:a1:h0:s0");
      }
      return { rows: [rawProduct(88000000000 + calls)], marketTotal: 100, sourceExhausted: false };
    },
  });

  await assert.rejects(
    provider.collect(rankRequest("순위드리프트", 1)),
    (error) => error instanceof ProviderError && error.code === "naver_next_data_rank_drift",
  );
  const statusAfterDrift = await provider.status();
  assert.equal(statusAfterDrift.verified, false);
  assert.equal(statusAfterDrift.reason, "naver_next_data_rank_drift");
  assert.equal(statusAfterDrift.cooldownUntil, "");

  const nextKeyword = await provider.collect(rankRequest("다음키워드", 1));
  assert.equal(nextKeyword.checkedCount, 1);
  assert.equal(calls, 2);
  await provider.close();
});

test("discards a market total smaller than the organic window without discarding rank evidence", async () => {
  const provider = createFixtureProvider({
    collectPage: async () => ({
      rows: [rawProduct(1)],
      marketTotal: 0,
      sourceExhausted: false,
    }),
  });
  const result = await provider.collect(rankRequest("오염된전체수", 1));
  assert.equal(result.checkedCount, 1);
  assert.equal(result.marketTotal, null);
  assert.equal(result.marketTotalStatus, "unavailable");
  await provider.close();
});

test("discards a page-to-page market total change while preserving one ordered rank window", async () => {
  const provider = createFixtureProvider({
    collectPage: async ({ pageIndex }) => ({
      rows: pageIndex === 1 ? [rawProduct(1), rawProduct(2)] : [rawProduct(3)],
      marketTotal: pageIndex === 1 ? 100 : 120,
      sourceExhausted: false,
    }),
  });
  const result = await provider.collect(rankRequest("변경된전체수", 3));
  assert.deepEqual(result.items.map((item) => item.organicRank), [1, 2, 3]);
  assert.equal(result.marketTotal, null);
  assert.equal(result.marketTotalStatus, "unavailable");
  await provider.close();
});

test("uses same-keyword single-flight and an immutable TTL cache", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = createFixtureProvider({
    collectPage: async () => {
      calls += 1;
      await gate;
      return { rows: [rawProduct(1), rawProduct(2), rawProduct(3)], marketTotal: 100, sourceExhausted: false };
    },
  });
  const request = rankRequest("온열찜질기", 3);
  const first = provider.collect(request);
  const second = provider.collect({ ...request, requestId: "second" });
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(left.collectionId, right.collectionId);

  left.items[0].title = "변조";
  const cached = await provider.collect({ ...request, requestId: "third" });
  assert.equal(calls, 1);
  assert.equal(cached.items[0].title, "검증 상품 1");
  await provider.close();
});

test("separates same-keyword single-flight and cache entries by exact limit", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = createFixtureProvider({
    collectPage: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return {
        rows: [
          rawProduct(99, { badgeTexts: ["광고"] }),
          rawProduct(1),
          rawProduct(2),
          rawProduct(3),
        ],
        marketTotal: 100,
        sourceExhausted: false,
      };
    },
  });

  const threePending = provider.collect(rankRequest("같은키워드", 3));
  const onePending = provider.collect(rankRequest("같은키워드", 1));
  release();
  const [three, one] = await Promise.all([threePending, onePending]);

  assert.equal(calls, 2, "different limits must run as separate collection jobs");
  assert.equal(three.checkedCount, 3);
  assert.equal(three.rawCount, 4);
  assert.equal(three.excludedAdCount, 1);
  assert.equal(one.checkedCount, 1);
  assert.equal(one.rawCount, 2);
  assert.equal(one.excludedAdCount, 1);
  assert.notEqual(three.collectionId, one.collectionId);

  const [cachedThree, cachedOne] = await Promise.all([
    provider.collect(rankRequest("같은키워드", 3)),
    provider.collect(rankRequest("같은키워드", 1)),
  ]);
  assert.equal(calls, 2, "each exact-limit cache entry must be reused independently");
  assert.equal(cachedThree.rawCount, 4);
  assert.equal(cachedOne.rawCount, 2);
  await provider.close();
});

test("runs different-keyword jobs through a bounded concurrency-one queue", async () => {
  let active = 0;
  let maximumActive = 0;
  const provider = createFixtureProvider({
    collectPage: async ({ url }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      const offset = new URL(url).searchParams.get("query") === "A" ? 100 : 200;
      return { rows: [rawProduct(offset)], marketTotal: 10, sourceExhausted: false };
    },
  });
  await Promise.all([
    provider.collect(rankRequest("A", 1)),
    provider.collect(rankRequest("B", 1)),
  ]);
  assert.equal(maximumActive, 1);
  await provider.close();
});

test("fails with a typed partial error instead of claiming incomplete coverage", async () => {
  const provider = createFixtureProvider({
    collectPage: async ({ pageIndex }) => ({
      rows: [rawProduct(pageIndex)],
      marketTotal: 10_000,
      sourceExhausted: false,
    }),
  });
  await assert.rejects(
    provider.collect(rankRequest("대형키워드", 300)),
    (error) => error instanceof ProviderError && error.code === "provider_partial_window"
  );
  await provider.close();
});

test("rejects queued work whose caller deadline expires before execution", async () => {
  let current = Date.parse("2026-08-01T00:00:00.000Z");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = createFixtureProvider({
    now: () => current,
    collectPage: async ({ url }) => {
      if (new URL(url).searchParams.get("query") === "A") await gate;
      return { rows: [rawProduct(1)], marketTotal: 10, sourceExhausted: false };
    },
  });
  await provider.collect(rankRequest("READY", 1, current));
  assert.equal((await provider.status()).verified, true);
  const first = provider.collect(rankRequest("A", 1, current));
  const second = provider.collect({
    ...rankRequest("B", 1, current),
    deadlineAt: new Date(current + 4_000).toISOString(),
  });
  current += 5_000;
  release();
  await first;
  await assert.rejects(second, (error) => error instanceof ProviderError && error.code === "provider_queue_deadline_exceeded");
  assert.equal((await provider.status()).verified, true, "one queued caller timeout must not invalidate global readiness");
  await provider.close();
});

test("keeps global readiness after rejecting one request from a full local queue", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = createFixtureProvider({
    config: { queueMax: 1 },
    collectPage: async ({ url }) => {
      if (new URL(url).searchParams.get("query") === "A") await gate;
      return { rows: [rawProduct(1)], marketTotal: 10, sourceExhausted: false };
    },
  });
  await provider.collect(rankRequest("READY", 1));
  assert.equal((await provider.status()).verified, true);

  const first = provider.collect(rankRequest("A", 1));
  const queued = provider.collect(rankRequest("B", 1));
  await assert.rejects(
    provider.collect(rankRequest("C", 1)),
    (error) => error instanceof ProviderError && error.code === "provider_queue_full",
  );
  assert.equal((await provider.status()).verified, true);
  release();
  await Promise.all([first, queued]);
  await provider.close();
});

test("keeps prior readiness when a forced canary meets a full local queue", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = createFixtureProvider({
    config: { queueMax: 1 },
    collectPage: async ({ url }) => {
      if (new URL(url).searchParams.get("query") === "A") await gate;
      return { rows: [rawProduct(1), rawProduct(2)], marketTotal: 10, sourceExhausted: false };
    },
  });
  assert.equal(await provider.verifyReadiness({ force: true }), true);
  assert.equal((await provider.status()).verified, true);

  const active = provider.collect(rankRequest("A", 1));
  const queued = provider.collect(rankRequest("B", 1));
  assert.equal(await provider.verifyReadiness({ force: true }), false);
  assert.equal((await provider.status()).verified, true, "local queue pressure must not erase prior readiness proof");

  release();
  await Promise.all([active, queued]);
  await provider.close();
});

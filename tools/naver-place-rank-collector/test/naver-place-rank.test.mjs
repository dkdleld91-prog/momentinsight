import assert from "node:assert/strict";
import test from "node:test";

import { __testing } from "../src/naver-place-rank.mjs";

const {
  buildCollectionStatus,
  buildApifyIdentityInput,
  buildApifySearchInput,
  clampMaxRank,
  collectRowsProgressively,
  lookupNaverPlaceRankViaApify,
  normalizeApifyCandidates,
  normalizeApifyResult,
  resolvePlaceIdentityViaHttp,
} = __testing;

function placeRow(index) {
  const id = String(10000 + index);
  return {
    id,
    text: `Place ${index} visitor reviews ${index}`,
    nameNodes: [`Place ${index}`],
    url: `https://map.naver.com/p/entry/place/${id}`,
    isAd: false,
  };
}

function adRow(index) {
  return {
    id: String(90000 + index),
    text: `Sponsored Place ${index}`,
    nameNodes: [`Sponsored Place ${index}`],
    isAd: true,
  };
}

test("collects exactly 300 unique organic candidates across progressive loads", async () => {
  const organicRows = Array.from({ length: 340 }, (_, index) => placeRow(index));
  let loadedCount = 60;

  const collection = await collectRowsProgressively({
    resultLimit: 300,
    maxScrolls: 20,
    deadlineAt: 60_000,
    now: () => 0,
    readRows: async () => [
      ...organicRows.slice(0, loadedCount),
      organicRows[0],
      adRow(loadedCount),
    ],
    advance: async () => {
      loadedCount = Math.min(organicRows.length, loadedCount + 60);
      return {
        scrollTop: loadedCount * 10,
        scrollHeight: loadedCount * 10 + 500,
        clientHeight: 500,
      };
    },
    wait: async () => {},
  });

  assert.equal(collection.candidates.length, 300);
  assert.equal(collection.complete, true);
  assert.equal(collection.stopReason, "requested_range_checked");
  assert.equal(new Set(collection.candidates.map((candidate) => candidate.id)).size, 300);
  assert.equal(collection.candidates.some((candidate) => candidate.id.startsWith("9")), false);

  assert.deepEqual(buildCollectionStatus(collection, 300), {
    checkedCount: 300,
    total: 300,
    requestedMaxRank: 300,
    complete: true,
    partial: false,
    partialReason: null,
    stopReason: "requested_range_checked",
  });
});

test("returns an exhausted partial reason with the actual organic count", async () => {
  const organicRows = Array.from({ length: 137 }, (_, index) => placeRow(index));

  const collection = await collectRowsProgressively({
    resultLimit: 300,
    maxScrolls: 20,
    deadlineAt: 60_000,
    now: () => 0,
    readRows: async () => [...organicRows, organicRows[12], adRow(1)],
    advance: async () => ({ scrollTop: 1370, scrollHeight: 1870, clientHeight: 500 }),
    wait: async () => {},
    growthPollAttempts: 1,
    exhaustedStableRounds: 3,
  });

  assert.equal(collection.candidates.length, 137);
  assert.equal(collection.complete, false);
  assert.equal(collection.stopReason, "naver_result_list_exhausted");
  assert.deepEqual(buildCollectionStatus(collection, 300), {
    checkedCount: 137,
    total: 137,
    requestedMaxRank: 300,
    complete: false,
    partial: true,
    partialReason: "naver_result_list_exhausted",
    stopReason: "naver_result_list_exhausted",
  });
});

test("returns a deadline partial reason instead of overstating checkedCount", async () => {
  const organicRows = Array.from({ length: 50 }, (_, index) => placeRow(index));
  let elapsed = 0;

  const collection = await collectRowsProgressively({
    resultLimit: 300,
    maxScrolls: 20,
    deadlineAt: 400,
    now: () => elapsed,
    readRows: async () => organicRows,
    advance: async () => ({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 }),
    wait: async (milliseconds) => {
      elapsed += milliseconds;
    },
  });

  const status = buildCollectionStatus(collection, 300);
  assert.equal(status.checkedCount, 50);
  assert.equal(status.complete, false);
  assert.equal(status.partial, true);
  assert.equal(status.partialReason, "collection_deadline_reached");
});

test("clamps provider requests to the supported 300 result ceiling", () => {
  assert.equal(clampMaxRank(1000), 300);
  assert.equal(clampMaxRank(300), 300);
  assert.equal(clampMaxRank(1), 300);
});

test("builds actor-specific Apify inputs", () => {
  assert.deepEqual(buildApifyIdentityInput(
    "abotapi~naver-map-scraper",
    "https://naver.me/test"
  ), {
    mode: "url",
    startUrls: [{ url: "https://naver.me/test" }],
    includeDetails: false,
    includeReviews: false,
    maxItems: 1,
  });
  assert.deepEqual(buildApifySearchInput(
    "oxygenated_quagmire~naver-place-search",
    "강남 맛집",
    300
  ), {
    queries: ["강남 맛집"],
    maxResults: 300,
    includePhotos: false,
    includeReviewSnippets: false,
    proxyConfiguration: { useApifyProxy: true },
  });
  assert.deepEqual(buildApifySearchInput(
    "delicious_zebu~naver-map-search-results-scraper",
    "강남 맛집",
    300
  ), {
    keywords: ["강남 맛집"],
    urls: [],
    scrapePlaceDetails: false,
    maxResultsPerKeyword: 300,
  });
  assert.deepEqual(buildApifySearchInput(
    "solidcode~naver-map-scraper",
    "강남 맛집",
    300
  ), {
    searchTerms: ["강남 맛집"],
    startUrls: [],
    maxResults: 300,
    includeReviews: false,
    includeMenu: false,
  });
  assert.deepEqual(buildApifySearchInput(
    "abotapi~naver-map-scraper",
    "강남 맛집",
    300
  ), {
    mode: "search",
    keywords: ["강남 맛집"],
    sort: "relevance",
    includeDetails: false,
    includeReviews: false,
    maxItems: 300,
  });
});

test("normalizes and deduplicates Apify rows while excluding ads", () => {
  const candidates = normalizeApifyCandidates([
    { placeId: "100", name: "첫 장소", url: "https://map.naver.com/p/entry/place/100" },
    { businessId: "100", title: "첫 장소 중복" },
    { id: "ad-1", name: "광고 장소", isAd: true },
    { business_id: "200", place_name: "둘째 장소" },
  ], 300);

  assert.deepEqual(candidates.map((item) => [item.rank, item.id, item.name]), [
    [1, "100", "첫 장소"],
    [2, "200", "둘째 장소"],
  ]);
});

test("normalizes the capitalized 300-result Actor fields", () => {
  const candidates = normalizeApifyCandidates([
    {
      PlaceId: "9999999999",
      Name: "광고 장소",
      NaverMapUrl: "https://map.naver.com/p/entry/place/9999999999",
      IsAd: true,
    },
    {
      PlaceId: "1565776290",
      Name: "URL 자동식별 식당",
      NaverMapUrl: "https://map.naver.com/p/entry/place/1565776290",
      VisitorReviewCount: 120,
      BlogReviewCount: 34,
    },
  ], 300);

  assert.deepEqual(candidates.map((item) => [item.id, item.name, item.visitorReviewCount, item.blogReviewCount]), [
    ["1565776290", "URL 자동식별 식당", "120", "34"],
  ]);
});

test("resolves a short Naver URL from page metadata without a business name", async () => {
  const result = await resolvePlaceIdentityViaHttp("https://naver.me/FTXD0JDp", async (_url, options) => {
    assert.equal(options.method, "GET");
    return new Response(`<!doctype html><html><head>
      <meta property="og:url" content="https://map.naver.com/p/entry/place/1565776290">
      <meta property="og:title" content="구월동 자동식별 식당 : 네이버">
    </head></html>`, { status: 200 });
  });

  assert.equal(result.placeId, "1565776290");
  assert.equal(result.placeName, "구월동 자동식별 식당");
  assert.equal(result.url, "https://map.naver.com/p/entry/place/1565776290");
});

test("normalizes wrapped and nested Apify result rows", () => {
  const normalized = normalizeApifyResult([{
    query: "강남 맛집",
    data: {
      results: [{
        place: {
          placeId: "321",
          name: "중첩 장소",
          placeUrl: "https://map.naver.com/p/entry/place/321",
        },
      }],
    },
  }], 300);

  assert.equal(normalized.rawItemCount, 1);
  assert.equal(normalized.flattenedItemCount, 1);
  assert.equal(normalized.discardedItemCount, 0);
  assert.deepEqual(normalized.candidates.map((item) => [item.id, item.name]), [["321", "중첩 장소"]]);
});

test("Apify provider marks 300 verified organic rows complete", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      placeId: String(100000 + index),
      name: `장소 ${index + 1}`,
      url: `https://map.naver.com/p/entry/place/${100000 + index}`,
    }));
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "테스트 맛집",
      placeId: "100299",
      maxRank: 300,
    }, async (_url, options) => {
      const requestBody = JSON.parse(options.body);
      assert.deepEqual(requestBody.queries, ["테스트 맛집"]);
      assert.equal(requestBody.maxResults, 300);
      assert.equal(requestBody.includePhotos, false);
      assert.equal(requestBody.includeReviewSnippets, false);
      assert.equal("maxPages" in requestBody, false);
      assert.equal("query" in requestBody, false);
      return new Response(JSON.stringify(rows), { status: 200 });
    });

    assert.equal(result.complete, true);
    assert.equal(result.partial, false);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.rank, 300);
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("resolves a URL-only tracker before matching it inside 300 organic rows", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const targetId = "1565776290";
    let callCount = 0;
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "구월동 맛집",
      placeUrl: "https://naver.me/FTXD0JDp",
      maxRank: 300,
    }, async (_url, options) => {
      callCount += 1;
      if (options.method === "GET") {
        return new Response(`<!doctype html><html><head>
          <meta property="og:url" content="https://map.naver.com/p/entry/place/${targetId}">
          <meta property="og:title" content="구월동 자동식별 식당 : 네이버">
        </head></html>`, { status: 200 });
      }
      const requestBody = JSON.parse(options.body);
      assert.deepEqual(requestBody.queries, ["구월동 맛집"]);
      assert.equal(requestBody.maxResults, 300);
      const rows = Array.from({ length: 300 }, (_, index) => ({
        placeId: index === 236 ? targetId : String(5000000 + index),
        name: index === 236 ? "구월동 자동식별 식당" : `구월동 후보 ${index + 1}`,
        placeUrl: `https://map.naver.com/p/entry/place/${index === 236 ? targetId : 5000000 + index}`,
      }));
      return new Response(JSON.stringify(rows), { status: 200 });
    });

    assert.equal(callCount, 2);
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.rank, 237);
    assert.equal(result.place.id, targetId);
    assert.equal(result.place.name, "구월동 자동식별 식당");
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("skips identity lookup when the URL already contains a place ID", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const targetId = "1565776290";
    let callCount = 0;
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "구월동 맛집",
      placeUrl: `https://map.naver.com/p/entry/place/${targetId}`,
      maxRank: 300,
    }, async (_url, options) => {
      callCount += 1;
      const requestBody = JSON.parse(options.body);
      assert.deepEqual(requestBody.queries, ["구월동 맛집"]);
      assert.equal(requestBody.maxResults, 300);
      const rows = Array.from({ length: 300 }, (_, index) => ({
        placeId: index === 48 ? targetId : String(8000000 + index),
        name: index === 48 ? "URL 자동식별 식당" : `후보 ${index + 1}`,
      }));
      return new Response(JSON.stringify(rows), { status: 200 });
    });

    assert.equal(callCount, 1);
    assert.equal(result.rank, 49);
    assert.equal(result.place.name, "URL 자동식별 식당");
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("Apify provider verifies organic rank 300 after removing ads and duplicates", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const rows = [
      { id: "ad-1", name: "광고 장소", isAd: true },
      { placeId: "700000", name: "중복 장소" },
      { businessId: "700000", title: "중복 장소" },
      ...Array.from({ length: 300 }, (_, index) => ({
        placeId: String(700001 + index),
        name: `오가닉 장소 ${index + 1}`,
        placeUrl: `https://map.naver.com/p/entry/place/${700001 + index}`,
      })),
    ];
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "300위 검증",
      placeId: "700299",
      maxRank: 300,
    }, async (_url, options) => {
      const requestBody = JSON.parse(options.body);
      assert.equal(requestBody.maxResults, 300);
      return new Response(JSON.stringify(rows), { status: 200 });
    });

    assert.equal(result.complete, true);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.rank, 300);
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("URL identity failure does not run keyword search or claim a 300 result", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    let callCount = 0;
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "식별 실패",
      placeUrl: "https://naver.me/unresolved",
      maxRank: 300,
    }, async (_url, options) => {
      callCount += 1;
      if (options.method === "GET") {
        return new Response("<!doctype html><html><head></head></html>", { status: 200 });
      }
      const requestBody = JSON.parse(options.body);
      assert.equal(requestBody.mode, "url");
      return new Response("[]", { status: 200 });
    });

    assert.equal(callCount, 2);
    assert.equal(result.ok, false);
    assert.equal(result.complete, false);
    assert.equal(result.stopReason, "place_identity_unresolved");
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("Apify provider keeps the deepest partial result without claiming 300", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    let callCount = 0;
    const rows = Array.from({ length: 72 }, (_, index) => ({
      placeId: String(200000 + index),
      name: `장소 ${index + 1}`,
    }));
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "테스트 카페",
      placeId: "999999",
      maxRank: 300,
    }, async (url) => {
      callCount += 1;
      if (String(url).includes("delicious_zebu~naver-map-search-results-scraper")) {
        return new Response(JSON.stringify([...rows, ...Array.from({ length: 48 }, (_, index) => ({
          placeId: String(300000 + index),
          name: `추가 장소 ${index + 1}`,
        }))]), { status: 200 });
      }
      return new Response(JSON.stringify(rows.slice(0, String(url).includes("abotapi") ? 50 : 72)), { status: 200 });
    });

    assert.equal(callCount, 3);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.equal(result.checkedCount, 120);
    assert.equal(result.stopReason, "apify_result_list_exhausted");
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("falls back to the deep 300 Actor when the primary Actor returns an empty dataset", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const targetId = "990299";
    let callCount = 0;
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "fallback 맛집",
      placeId: targetId,
      maxRank: 300,
    }, async (url, options) => {
      callCount += 1;
      const requestBody = JSON.parse(options.body);
      if (callCount === 1) {
        assert.match(String(url), /oxygenated_quagmire~naver-place-search/);
        assert.deepEqual(requestBody.queries, ["fallback 맛집"]);
        assert.equal(requestBody.maxResults, 300);
        return new Response("[]", { status: 200 });
      }

      assert.match(String(url), /delicious_zebu~naver-map-search-results-scraper/);
      assert.deepEqual(requestBody, {
        keywords: ["fallback 맛집"],
        urls: [],
        scrapePlaceDetails: false,
        maxResultsPerKeyword: 300,
      });
      const rows = Array.from({ length: 300 }, (_, index) => ({
        PlaceId: String(990000 + index),
        Name: `fallback 장소 ${index + 1}`,
        NaverMapUrl: `https://map.naver.com/p/entry/place/${990000 + index}`,
      }));
      return new Response(JSON.stringify(rows), { status: 200 });
    });

    assert.equal(callCount, 2);
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.equal(result.rank, 300);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.primaryStopReason, "apify_empty_dataset");
    assert.equal(result.source, "apify_naver_maps_deep_search");
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("falls back to the deep Actor when the primary output is unrecognized", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    let callCount = 0;
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "fallback 출력",
      placeId: "888888",
      maxRank: 300,
    }, async (_url, options) => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify([{
          id: "actor-status-1",
          title: "finished",
          error: "unexpected_output",
        }]), { status: 200 });
      }
      const requestBody = JSON.parse(options.body);
      assert.deepEqual(requestBody.keywords, ["fallback 출력"]);
      return new Response(JSON.stringify([{
        placeId: "888888",
        name: "fallback 확인 장소",
        placeUrl: "https://map.naver.com/p/entry/place/888888",
      }]), { status: 200 });
    });

    assert.equal(callCount, 2);
    assert.equal(result.matched, true);
    assert.equal(result.rank, 1);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.primaryStopReason, "apify_output_unrecognized");
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("falls back when the primary Actor returns an HTML gateway response", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    let callCount = 0;
    const rows = Array.from({ length: 300 }, (_, index) => ({
      placeId: String(700000 + index),
      name: `HTML 복구 장소 ${index + 1}`,
      naverUrl: `https://map.naver.com/p/entry/place/${700000 + index}`,
    }));
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "HTML 복구",
      placeId: "700299",
      maxRank: 300,
    }, async (_url, options) => {
      callCount += 1;
      if (callCount === 1) {
        return new Response("<html><h1>Bad gateway</h1></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        });
      }
      const requestBody = JSON.parse(options.body);
      assert.deepEqual(requestBody.keywords, ["HTML 복구"]);
      return new Response(JSON.stringify(rows), { status: 200 });
    });

    assert.equal(callCount, 2);
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.equal(result.rank, 300);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.primaryStopReason, "apify_actor_failed");
    assert.match(result.actorAttempts[0].error, /apify_non_json_response:502:text\/html/);
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("Apify provider reports an empty dataset after all Actors return zero rows", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "빈 검색 결과",
      placeId: "999999",
      maxRank: 300,
    }, async () => new Response("[]", { status: 200 }));

    assert.equal(result.ok, true);
    assert.equal(result.checkedCount, 0);
    assert.equal(result.rawItemCount, 0);
    assert.equal(result.complete, false);
    assert.equal(result.stopReason, "apify_empty_dataset");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.actorAttempts.length, 3);
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("Apify provider rejects an unrecognized non-empty output schema", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "출력 스키마 오류",
      placeId: "999999",
      maxRank: 300,
    }, async () => new Response(JSON.stringify([{
      id: "actor-status-1",
      title: "Actor run failed",
      error: "unexpected_output",
    }]), { status: 200 }));

    assert.equal(result.ok, false);
    assert.equal(result.rawItemCount, 1);
    assert.equal(result.normalizedItemCount, 0);
    assert.equal(result.stopReason, "apify_output_unrecognized");
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.actorAttempts.length, 3);
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("Apify provider reports normalization shortfall after 300 raw rows", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      placeId: index === 299 ? "500000" : String(500000 + index),
      name: `장소 ${index + 1}`,
    }));
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "중복 포함 결과",
      placeId: "999999",
      maxRank: 300,
    }, async () => new Response(JSON.stringify(rows), { status: 200 }));

    assert.equal(result.complete, false);
    assert.equal(result.checkedCount, 299);
    assert.equal(result.discardedItemCount, 1);
    assert.equal(result.stopReason, "apify_normalized_result_shortfall");
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("normalizes the current Naver Map Actor review fields", () => {
  const candidates = normalizeApifyCandidates([{
    placeId: "300",
    name: "현재 Actor 장소",
    placeUrl: "https://map.naver.com/p/entry/place/300",
    visitorReviewCount: 123,
    blogCafeReviewCount: 45,
  }], 300);

  assert.equal(candidates[0].visitorReviewCount, "123");
  assert.equal(candidates[0].blogReviewCount, "45");
});

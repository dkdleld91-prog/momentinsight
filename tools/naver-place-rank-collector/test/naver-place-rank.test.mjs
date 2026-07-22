import assert from "node:assert/strict";
import test from "node:test";

import { __testing, lookupNaverPlaceRank } from "../src/naver-place-rank.mjs";

const {
  aggregateCandidateMetrics,
  buildCollectionStatus,
  buildPlaceListUrl,
  buildApifyIdentityInput,
  buildApifySearchInput,
  clampMaxRank,
  candidateMatchesTarget,
  collectRowsProgressively,
  findMatch,
  lookupNaverPlaceRankViaApify,
  isApifyAccountLimitError,
  normalizeApifyCandidates,
  normalizeApifyResult,
  nextListScrollTop,
  remainingTimeoutMs,
  resolveProviderDeadlineAt,
  resolvePlaceIdentityViaHttp,
  resolveApifyBudgetMs,
  selectorFallbackCollection,
} = __testing;

test("preserves Naver's hospital list route and native display contract", () => {
  const nativeUrl = "https://pcmap.place.naver.com/hospital/list?query=%EC%A2%85%EB%A1%9C3%EA%B0%80%ED%95%9C%EC%9D%98%EC%9B%90&x=126.676525&y=37.463776&clientX=126.676525&clientY=37.463776&display=70&searchText=%EC%A2%85%EB%A1%9C3%EA%B0%80%ED%95%9C%EC%9D%98%EC%9B%90";
  const result = new URL(buildPlaceListUrl("종로3가한의원", 300, "126.676525;37.463776", nativeUrl));

  assert.equal(result.pathname, "/hospital/list");
  assert.equal(result.searchParams.get("display"), "70");
  assert.equal(result.searchParams.get("clientX"), "126.676525");
  assert.equal(result.searchParams.get("searchText"), "종로3가한의원");
});

test("keeps the existing 300-result expansion for native restaurant lists", () => {
  const nativeUrl = "https://pcmap.place.naver.com/restaurant/list?query=%ED%99%8D%EB%8C%80+%EB%A7%9B%EC%A7%91&x=126.676525&y=37.463776&display=70";
  const result = new URL(buildPlaceListUrl("홍대 맛집", 300, "126.676525;37.463776", nativeUrl));

  assert.equal(result.pathname, "/restaurant/list");
  assert.equal(result.searchParams.get("display"), "300");
});

test("rejects a non-Naver URL that only contains a native-list string", () => {
  const result = new URL(buildPlaceListUrl(
    "종로3가한의원",
    300,
    "126.676525;37.463776",
    "https://example.invalid/?next=https://pcmap.place.naver.com/hospital/list"
  ));

  assert.equal(result.hostname, "pcmap.place.naver.com");
  assert.equal(result.pathname, "/place/list");
  assert.equal(result.searchParams.get("display"), "300");
});

test("advances the virtual place list in overlapping steps instead of jumping to the end", () => {
  assert.equal(nextListScrollTop({ scrollTop: 0, scrollHeight: 5000, clientHeight: 1000 }), 720);
  assert.equal(nextListScrollTop({ scrollTop: 720, scrollHeight: 5000, clientHeight: 1000 }), 1440);
  assert.equal(nextListScrollTop({ scrollTop: 3800, scrollHeight: 5000, clientHeight: 1000 }), 4000);
});

test("caps the Apify actor chain so browser fallback fits the caller budget", () => {
  assert.equal(resolveApifyBudgetMs({ apifyBudgetMs: 500_000 }), 135_000);
  assert.equal(resolveApifyBudgetMs({ apifyBudgetMs: 120_000 }), 120_000);
  assert.equal(resolveApifyBudgetMs({ apifyBudgetMs: 1_000 }), 30_000);
});

test("honors the caller deadline while capping direct collector runs", () => {
  const now = 1_000_000;
  assert.equal(resolveProviderDeadlineAt({ providerDeadlineAt: now + 180_000 }, now), now + 180_000);
  assert.equal(resolveProviderDeadlineAt({ providerDeadlineAt: now + 500_000 }, now), now + 225_000);
  assert.equal(resolveProviderDeadlineAt({ providerDeadlineAt: now - 1 }, now), now - 1);
  assert.equal(remainingTimeoutMs(now + 5_000, 30_000, () => now), 5_000);
  assert.equal(remainingTimeoutMs(now + 50_000, 30_000, () => now), 30_000);
  assert.throws(
    () => remainingTimeoutMs(now, 30_000, () => now),
    /naver_map_lookup_deadline_exceeded/
  );
});

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

test("does not spend the full growth poll budget on each mid-list scroll", async () => {
  let elapsed = 0;
  let waits = 0;
  const collection = await collectRowsProgressively({
    resultLimit: 300,
    maxScrolls: 1,
    deadlineAt: 10000,
    now: () => elapsed,
    readRows: async () => [placeRow(0)],
    advance: async () => ({ scrollTop: 500, scrollHeight: 5000, clientHeight: 500 }),
    wait: async (milliseconds) => {
      waits += 1;
      elapsed += milliseconds;
    },
    growthPollAttempts: 6,
    growthPollIntervalMs: 220,
  });

  assert.equal(waits, 2);
  assert.equal(collection.stopReason, "max_scrolls_reached");
});

test("continues progressive scrolling when the selector wait times out but verified list rows exist", async () => {
  const selectorError = new Error("selector timed out");
  let phase = 0;
  let advances = 0;
  const rows = [
    { isPlaceListRow: true, id: "1", text: "첫 번째", nameNodes: ["첫 번째"] },
    { isPlaceListRow: true, id: "2", text: "두 번째", nameNodes: ["두 번째"] },
    { isPlaceListRow: true, id: "3", text: "세 번째", nameNodes: ["세 번째"] },
    { isPlaceListRow: true, id: "4", text: "네 번째", nameNodes: ["네 번째"] },
  ];
  const result = await __testing.collectVerifiedListRowsProgressively({
    resultLimit: 4,
    maxScrolls: 3,
    deadlineAt: 100,
    readRows: async () => phase === 0 ? rows.slice(0, 2) : rows.slice(2),
    advance: async () => {
      advances += 1;
      phase += 1;
      return { scrollTop: 500, scrollHeight: 1_000, clientHeight: 500 };
    },
    wait: async () => {},
    now: () => 0,
    growthPollAttempts: 1,
    growthPollIntervalMs: 0,
    exhaustedStableRounds: 1,
    selectorError,
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ["1", "2", "3", "4"]);
  assert.equal(advances, 1);

  await assert.rejects(() => __testing.collectVerifiedListRowsProgressively({
    resultLimit: 4,
    maxScrolls: 3,
    deadlineAt: 100,
    readRows: async () => [{ isPlaceListRow: false, id: "menu", text: "메뉴", nameNodes: ["메뉴"] }],
    advance: async () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 1 }),
    wait: async () => {},
    now: () => 0,
    selectorError,
  }), selectorError);

  const extractionError = new Error("viewport extraction failed");
  await assert.rejects(() => __testing.collectVerifiedListRowsProgressively({
    resultLimit: 4,
    maxScrolls: 3,
    deadlineAt: 100,
    readRows: async () => {
      throw extractionError;
    },
    advance: async () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 1 }),
    wait: async () => {},
    now: () => 0,
  }), extractionError);

  let expiredReadCalls = 0;
  const expired = await __testing.collectVerifiedListRowsProgressively({
    resultLimit: 4,
    maxScrolls: 3,
    deadlineAt: 100,
    readRows: async () => {
      expiredReadCalls += 1;
      return rows;
    },
    advance: async () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 1 }),
    wait: async () => {},
    now: () => 100,
  });
  assert.equal(expiredReadCalls, 0);
  assert.equal(expired.stopReason, "collection_deadline_reached");
  assert.equal(expired.candidates.length, 0);
});

test("keeps ID-less organic rows in DOM order when the list selector disappears", () => {
  const collection = selectorFallbackCollection([
    { rank: 2, id: "20002", placeIds: ["20002"], name: "둘째 장소", url: "https://map.naver.com/p/entry/place/20002", isAd: false },
    { rank: 1, id: "20001", placeIds: ["20001"], name: "첫째 장소", url: "https://map.naver.com/p/entry/place/20001", isAd: false },
  ], [
    {
      isPlaceListRow: true,
      id: "20002",
      text: "둘째 장소",
      nameNodes: ["둘째 장소"],
      url: "https://map.naver.com/p/entry/place/20002",
      isAd: false,
    },
    {
      isPlaceListRow: true,
      id: "20003",
      text: "셋째 장소",
      nameNodes: ["셋째 장소"],
      url: "https://map.naver.com/p/entry/place/20003",
      isAd: false,
    },
    {
      isPlaceListRow: true,
      id: "29999",
      text: "광고 장소",
      nameNodes: ["광고 장소"],
      url: "https://map.naver.com/p/entry/place/29999",
      isAd: true,
    },
    {
      isPlaceListRow: true,
      text: "식별자가 없는 메뉴 항목",
      nameNodes: ["식별자가 없는 메뉴 항목"],
      url: "",
      isAd: false,
    },
  ], 300);

  assert.ok(collection);
  assert.deepEqual(collection.candidates.map((candidate) => [candidate.rank, candidate.id]), [
    [1, "20002"],
    [2, "20003"],
    [3, ""],
  ]);
  assert.equal(collection.complete, false);
  assert.equal(collection.stopReason, "list_selector_unavailable_fallback");
});

test("does not compress a target rank past an ID-less organic row", () => {
  const collection = selectorFallbackCollection([], [
    {
      isPlaceListRow: true,
      id: "10001",
      text: "첫째 장소",
      nameNodes: ["첫째 장소"],
      url: "https://map.naver.com/p/entry/place/10001",
      isAd: false,
    },
    {
      isPlaceListRow: true,
      text: "둘째 장소",
      nameNodes: ["둘째 장소"],
      url: "",
      isAd: false,
    },
    {
      isPlaceListRow: true,
      id: "10003",
      text: "대상 장소",
      nameNodes: ["대상 장소"],
      url: "https://map.naver.com/p/entry/place/10003",
      isAd: false,
    },
  ], 300);

  assert.ok(collection);
  const matched = findMatch(collection.candidates, { placeId: "10003" });
  assert.equal(matched?.rank, 3);
});

test("does not count body menu rows as organic fallback positions", () => {
  const collection = selectorFallbackCollection([], [
    {
      isPlaceListRow: false,
      text: "지역 선택 메뉴",
      nameNodes: ["지역 선택 메뉴"],
      url: "",
      isAd: false,
    },
    {
      isPlaceListRow: true,
      id: "30001",
      text: "첫째 장소",
      nameNodes: ["첫째 장소"],
      url: "https://map.naver.com/p/entry/place/30001",
      isAd: false,
    },
    {
      isPlaceListRow: true,
      id: "30002",
      text: "대상 장소",
      nameNodes: ["대상 장소"],
      url: "https://map.naver.com/p/entry/place/30002",
      isAd: false,
    },
  ], 300);

  assert.ok(collection);
  const matched = findMatch(collection.candidates, { placeId: "30002" });
  assert.equal(matched?.rank, 2);
});

test("does not count a nested promotional card as an organic fallback position", () => {
  const collection = selectorFallbackCollection([], [
    {
      isPlaceListRow: true,
      id: "31001",
      text: "첫째 장소",
      nameNodes: ["첫째 장소"],
      url: "https://map.naver.com/p/entry/place/31001",
      isAd: false,
    },
    {
      isPlaceListRow: false,
      text: "새로 오픈했어요 추천 장소",
      nameNodes: ["새로 오픈했어요 추천 장소"],
      url: "",
      isAd: false,
    },
    {
      isPlaceListRow: true,
      id: "31002",
      text: "대상 장소",
      nameNodes: ["대상 장소"],
      url: "https://map.naver.com/p/entry/place/31002",
      isAd: false,
    },
  ], 300);

  assert.ok(collection);
  const matched = findMatch(collection.candidates, { placeId: "31002" });
  assert.equal(matched?.rank, 2);
});

test("does not manufacture a successful fallback without identified candidates", () => {
  const collection = selectorFallbackCollection([], [{
    isPlaceListRow: true,
    text: "식별할 수 없는 네이버 지도 메뉴",
    nameNodes: ["식별할 수 없는 네이버 지도 메뉴"],
    url: "",
    isAd: false,
  }], 300);

  assert.equal(collection, null);
});

test("selector fallback ignores preview-only rows even when they reach the requested limit", () => {
  const collection = selectorFallbackCollection([{
    rank: 1,
    id: "40001",
    placeIds: ["40001"],
    name: "비대상 장소",
    url: "https://map.naver.com/p/entry/place/40001",
    isAd: false,
  }], [], 1);

  assert.equal(collection, null);
});

test("never treats an allSearch preview rank as the PC organic rank", () => {
  const collection = selectorFallbackCollection([{
    rank: 7,
    id: "1907427831",
    placeIds: ["1907427831"],
    name: "이화누룽지삼계탕",
    url: "https://map.naver.com/p/entry/place/1907427831",
    isAd: false,
  }], [{
    isPlaceListRow: true,
    id: "1024272705",
    text: "우삼집",
    nameNodes: ["우삼집"],
    url: "https://map.naver.com/p/entry/place/1024272705",
    isAd: false,
  }], 300);

  assert.ok(collection);
  assert.deepEqual(collection.candidates.map((candidate) => [candidate.rank, candidate.id]), [
    [1, "1024272705"],
  ]);
  assert.equal(collection.candidates.some((candidate) => candidate.id === "1907427831"), false);
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

test("requires an exact candidate ID whenever the tracker has a place ID", () => {
  const target = { placeId: "2019299673", placeName: "팽오리농장 부평점" };
  const wrongIdSameName = {
    id: "9999999999",
    name: "팽오리농장 부평점",
    url: "https://map.naver.com/p/entry/place/9999999999",
  };
  const exactIdDifferentName = {
    id: "2019299673",
    name: "표시명이 변경된 장소",
    url: "https://map.naver.com/p/entry/place/2019299673",
  };

  assert.equal(candidateMatchesTarget(wrongIdSameName, target), false);
  assert.equal(candidateMatchesTarget({ name: target.placeName }, target), false);
  assert.equal(candidateMatchesTarget(exactIdDifferentName, target), true);
  assert.equal(findMatch([wrongIdSameName, exactIdDifferentName], target), exactIdDifferentName);
  assert.equal(candidateMatchesTarget(wrongIdSameName, { placeName: target.placeName }), true);
});

test("preserves a sparse provider organic rank instead of renumbering it", () => {
  const candidates = normalizeApifyCandidates([
    { placeId: "ad-row", name: "광고 장소", organicRank: 1, isAd: true },
    { placeId: "2019299673", name: "팽오리농장 부평점", organicRank: 87 },
  ], 300);

  assert.deepEqual(candidates.map((item) => [item.rank, item.sourceRank, item.id]), [
    [87, 87, "2019299673"],
  ]);
});

test("uses explicit organic rank fields when Actor rows arrive out of order", () => {
  const candidates = normalizeApifyCandidates([
    { placeId: "303", name: "세 번째 장소", organicRank: 3 },
    { placeId: "301", name: "첫 번째 장소", organic_rank: 1 },
    { placeId: "302", name: "두 번째 장소", searchRank: 2 },
  ], 300);

  assert.deepEqual(candidates.map((item) => [item.rank, item.sourceRank, item.id]), [
    [1, 1, "301"],
    [2, 2, "302"],
    [3, 3, "303"],
  ]);
});

test("recognizes an Apify account hard limit and stops the shared Actor chain", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    let callCount = 0;
    await assert.rejects(
      lookupNaverPlaceRankViaApify({
        keyword: "부평 맛집",
        placeId: "2019299673",
        maxRank: 300,
      }, async () => {
        callCount += 1;
        return new Response(JSON.stringify({
          error: { message: "Monthly usage hard limit exceeded" },
        }), { status: 402, headers: { "content-type": "application/json" } });
      }),
      /Monthly usage hard limit exceeded/
    );
    assert.equal(callCount, 1);
    assert.equal(isApifyAccountLimitError("Monthly usage hard limit exceeded"), true);
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("uses only the native PC organic result even when an Actor reports another rank", async () => {
  let browserCalls = 0;
  let apifyCalls = 0;
  const result = await lookupNaverPlaceRank({
    keyword: "부평 맛집",
    placeUrl: "https://map.naver.com/p/entry/place/2019299673",
    maxRank: 300,
  }, {
    apifyLookup: async () => {
      apifyCalls += 1;
      return {
        ok: true,
        matched: true,
        rank: 3,
        checkedCount: 3,
        complete: false,
        source: "apify_untrusted_order",
      };
    },
    browserLookup: async () => {
      browserCalls += 1;
      return {
        ok: true,
        matched: true,
        rank: 17,
        checkedCount: 17,
        requestedMaxRank: 300,
        complete: false,
        partial: false,
        stopReason: "target_found",
        source: "naver_map_pc_list_collector",
        rankEvidence: "naver_pc_organic_list",
      };
    },
  });

  assert.equal(browserCalls, 1);
  assert.equal(apifyCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.rank, 17);
  assert.equal(result.source, "naver_map_pc_list_collector");
  assert.equal(result.rankEvidence, "naver_pc_organic_list");
  assert.equal("providerFallbackUsed" in result, false);
});

test("keeps a native partial scan truthful instead of accepting an Actor rank", async () => {
  let apifyCalls = 0;
  const result = await lookupNaverPlaceRank({
    keyword: "부평 맛집",
    placeId: "2019299673",
    maxRank: 300,
  }, {
    apifyLookup: async () => {
      apifyCalls += 1;
      return { ok: true, matched: true, rank: 9, checkedCount: 9, complete: false };
    },
    browserLookup: async () => ({
      ok: true,
      matched: false,
      rank: null,
      checkedCount: 100,
      requestedMaxRank: 300,
      complete: false,
      partial: true,
      stopReason: "naver_result_list_exhausted",
      source: "naver_map_pc_list_collector",
      rankEvidence: "naver_pc_organic_list",
    }),
  });

  assert.equal(apifyCalls, 0);
  assert.equal(result.matched, false);
  assert.equal(result.rank, null);
  assert.equal(result.checkedCount, 100);
  assert.equal(result.partial, true);
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

test("native lookup skips slow detail identity when an exact place ID is already known", () => {
  assert.equal(
    __testing.needsBrowserIdentityResolution(
      "https://map.naver.com/p/entry/place/2019299673",
      "2019299673"
    ),
    false
  );
  assert.equal(
    __testing.needsBrowserIdentityResolution(
      "https://map.naver.com/p/entry/place/2019299673",
      ""
    ),
    false
  );
  assert.equal(
    __testing.needsBrowserIdentityResolution("https://naver.me/FTXD0JDp", ""),
    true
  );
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

test("aggregates every organic candidate metric while keeping topPlaces bounded", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const organicRows = Array.from({ length: 25 }, (_, index) => ({
      placeId: String(800000 + index),
      name: `오가닉 장소 ${index + 1}`,
      organicRank: index + 1,
      visitorReviewCount: 100 + index,
      blogCafeReviewCount: 200 + index,
    }));
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "리뷰 지표 테스트",
      placeId: "999999",
      maxRank: 300,
    }, async () => new Response(JSON.stringify([
      ...organicRows,
      {
        placeId: "999998",
        name: "광고 장소",
        organicRank: 1,
        visitorReviewCount: 9999,
        blogCafeReviewCount: 9999,
        isAd: true,
      },
    ]), { status: 200 }));

    assert.equal(result.matched, false);
    assert.equal(result.checkedCount, 25);
    assert.equal(result.topPlaces.length, 20);
    assert.equal(result.topPlaces.some((candidate) => candidate.name === "광고 장소"), false);
    assert.deepEqual(result.metrics, {
      scope: "organic_search_results",
      blogCount: 5300,
      visitReviewCount: 2800,
      businessCount: 25,
      coverage: {
        blogCount: { knownCount: 25, totalCount: 25 },
        visitReviewCount: { knownCount: 25, totalCount: 25 },
      },
    });
  } finally {
    if (previousToken === undefined) delete process.env.APIFY_NAVER_MAPS_TOKEN;
    else process.env.APIFY_NAVER_MAPS_TOKEN = previousToken;
  }
});

test("marks an aggregate review metric null when any organic candidate is missing it", () => {
  assert.deepEqual(aggregateCandidateMetrics([
    { visitorReviewCount: "1,200", blogReviewCount: "300" },
    { visitorReviewCount: "", blogReviewCount: "40" },
  ]), {
    scope: "organic_search_results",
    blogCount: 340,
    visitReviewCount: null,
    businessCount: 2,
    coverage: {
      blogCount: { knownCount: 2, totalCount: 2 },
      visitReviewCount: { knownCount: 1, totalCount: 2 },
    },
  });
});

test("preserves explicit zero review counts as canonical zero", () => {
  const candidates = normalizeApifyCandidates([{
    placeId: "700000",
    name: "신규 오가닉 장소",
    visitorReviewCount: 0,
    blogCafeReviewCount: 0,
  }], 300);

  assert.equal(candidates[0].visitorReviewCount, "0");
  assert.equal(candidates[0].blogReviewCount, "0");
  assert.deepEqual(aggregateCandidateMetrics(candidates), {
    scope: "organic_search_results",
    blogCount: 0,
    visitReviewCount: 0,
    businessCount: 1,
    coverage: {
      blogCount: { knownCount: 1, totalCount: 1 },
      visitReviewCount: { knownCount: 1, totalCount: 1 },
    },
  });
});

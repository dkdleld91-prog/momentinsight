import assert from "node:assert/strict";
import test from "node:test";

import { __testing } from "../src/naver-place-rank.mjs";

const {
  buildCollectionStatus,
  clampMaxRank,
  collectRowsProgressively,
  lookupNaverPlaceRankViaApify,
  normalizeApifyCandidates,
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
      assert.equal(requestBody.mode, "search");
      assert.deepEqual(requestBody.keywords, ["테스트 맛집"]);
      assert.equal(requestBody.sort, "relevance");
      assert.equal(requestBody.includeDetails, false);
      assert.equal(requestBody.includeReviews, false);
      assert.equal(requestBody.maxItems, 300);
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

test("Apify provider reports a partial result instead of claiming 300", async () => {
  const previousToken = process.env.APIFY_NAVER_MAPS_TOKEN;
  process.env.APIFY_NAVER_MAPS_TOKEN = "test-token";
  try {
    const rows = Array.from({ length: 72 }, (_, index) => ({
      placeId: String(200000 + index),
      name: `장소 ${index + 1}`,
    }));
    const result = await lookupNaverPlaceRankViaApify({
      keyword: "테스트 카페",
      placeId: "999999",
      maxRank: 300,
    }, async () => new Response(JSON.stringify(rows), { status: 200 }));

    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.equal(result.checkedCount, 72);
    assert.equal(result.stopReason, "apify_result_list_exhausted");
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

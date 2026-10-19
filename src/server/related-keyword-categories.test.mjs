import assert from "node:assert/strict";
import test from "node:test";

import {
  CATEGORY_SAMPLE_SCHEMA, CATEGORY_SAMPLE_SOURCE, categoriesFromSample, createCategoryLookup, readBoundedJson,
} from "./related-keyword-categories.mjs";

const NOW = Date.parse("2026-10-14T01:00:00Z");
const env = () => ({ NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: "https://categories.example/sample", NAVER_KEYWORD_CATEGORY_COLLECTOR_TOKEN: "private-category-token" });
const item = (id, category2 = "냉온/찜질용품", category3 = "찜질기") => ({ productId: String(10000 + id), category2, category3 });
const sample = (keyword, items = [item(1)], extra = {}) => ({ schemaVersion: CATEGORY_SAMPLE_SCHEMA, source: CATEGORY_SAMPLE_SOURCE, keyword, complete: true, collectedAt: new Date(NOW).toISOString(), items, ...extra });
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("middle/small categories come only from this keyword's unique product sample", () => {
  const single = categoriesFromSample(sample("온열 찜질기", [item(1), item(2)]), "온열찜질기", NOW);
  assert.equal(single.status, "single");
  assert.equal(single.middle, "냉온/찜질용품");
  assert.equal(single.small, "찜질기");
  assert.equal(single.sampleSize, 2);
  assert.deepEqual(single.paths, [{ middle: "냉온/찜질용품", small: "찜질기", sampleCount: 2 }]);
});

test("mixed categories stay multiple with every observed pair, never majority-forced", () => {
  const mixed = categoriesFromSample(sample("찜질기", [item(1), item(2), item(3, "침구류", "전기매트")]), "찜질기", NOW);
  assert.equal(mixed.status, "multiple");
  assert.equal(mixed.middle, "");
  assert.equal(mixed.paths.length, 2);
  assert.equal(mixed.paths[0].sampleCount, 2);
});

test("partial sample, missing middle/small, empty sample and mixed partial remain distinct", () => {
  assert.equal(categoriesFromSample(sample("가", [item(1)], { complete: false }), "가", NOW).status, "needs_confirmation");
  assert.equal(categoriesFromSample(sample("가", [item(1), item(2, "", "")]), "가", NOW).reason, "incomplete_sample");
  assert.equal(categoriesFromSample(sample("가", [item(1, "", "찜질기")]), "가", NOW).reason, "missing_categories");
  assert.equal(categoriesFromSample(sample("가", []), "가", NOW).reason, "no_results");
  const mixed = categoriesFromSample(sample("가", [item(1), item(2, "침구류", "전기매트")], { complete: false }), "가", NOW);
  assert.equal(mixed.status, "multiple");
  assert.equal(mixed.reason, "incomplete_sample");
});

test("mismatched keyword/source, stale evidence, duplicate/absent product ID fail closed", () => {
  assert.equal(categoriesFromSample(sample("다른키워드"), "찜질기", NOW).reason, "keyword_mismatch");
  assert.equal(categoriesFromSample(sample("가", undefined, { source: "invented" }), "가", NOW).reason, "source_mismatch");
  assert.equal(categoriesFromSample(sample("가", undefined, { collectedAt: "2026-10-01" }), "가", NOW).reason, "stale_source");
  assert.equal(categoriesFromSample(sample("가", [item(1), item(1)]), "가", NOW).reason, "invalid_sample");
  assert.equal(categoriesFromSample(sample("가", [{ category2: "중", category3: "소" }]), "가", NOW).reason, "invalid_sample");
  assert.equal(categoriesFromSample(sample("가", Array.from({ length: 21 }, (_, i) => item(i))), "가", NOW).reason, "invalid_sample");
});

test("unconfigured/unsafe sources never fall back to retired API or protected rank collector", async () => {
  for (const config of [
    {}, { ...env(), NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: "http://categories.example/sample" },
    { ...env(), NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: "https://127.0.0.1/sample" },
    { ...env(), NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: "https://localhost/sample" },
    { ...env(), NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: "https://categories.example/sample?redirect=bad" },
    { ...env(), NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: "https://openapi.naver.com/v1/search/shop.json" },
    { ...env(), NAVER_SHOPPING_RANK_API_URL: env().NAVER_KEYWORD_CATEGORY_COLLECTOR_URL },
  ]) {
    const lookup = createCategoryLookup({ env: config, now: () => NOW, fetchImpl: () => { throw new Error("must not call"); } });
    const [row] = await lookup(["찜질기"]);
    assert.equal(row.category.reason, "source_unavailable");
  }
});

test("canonical rank endpoint aliases and same-host path variants cannot become category sources", async () => {
  let calls = 0;
  for (const url of ["https://rank.example:443/v1", "https://RANK.example/v1/", "https://rank.example/alternate-category", "https://rank.example:8443/v1"]) {
    const lookup = createCategoryLookup({ env: {
      ...env(), NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: url,
      NAVER_SHOPPING_RANK_API_URL: "https://rank.example/v1",
    }, now: () => NOW, fetchImpl: async () => { calls += 1; return response(sample("찜질기")); } });
    assert.equal((await lookup(["찜질기"]))[0].category.reason, "source_unavailable");
  }
  assert.equal(calls, 0);
});

test("DNS trailing-dot aliases cannot bypass protected-host or localhost isolation", async () => {
  let calls = 0;
  for (const [url, rankUrl] of [
    ["https://rank.example./v1", "https://rank.example/v1"],
    ["https://rank.example/v1", "https://RANK.example./v1"],
    ["https://localhost./sample", "https://rank.example/v1"],
    ["https://service.internal./sample", "https://rank.example/v1"],
  ]) {
    const lookup = createCategoryLookup({ env: {
      ...env(), NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: url, NAVER_SHOPPING_RANK_API_URL: rankUrl,
    }, now: () => NOW, fetchImpl: async () => { calls += 1; return response(sample("찜질기")); } });
    assert.equal((await lookup(["찜질기"]))[0].category.reason, "source_unavailable");
  }
  assert.equal(calls, 0);
});

test("cached source evidence expires at collectedAt+24h, not another24h after lookup", async () => {
  let time = NOW;
  let calls = 0;
  const lookup = createCategoryLookup({ env: env(), now: () => time, fetchImpl: async () => {
    calls += 1;
    return response(sample("찜질기", [item(1)], { collectedAt: new Date(NOW - 24 * 60 * 60_000 + 1000).toISOString() }));
  } });
  assert.equal((await lookup(["찜질기"]))[0].category.status, "single");
  time += 2000;
  const result = await lookup(["찜질기"]);
  assert.equal(calls, 2);
  assert.equal(result[0].category.status, "needs_confirmation");
  assert.equal(result[0].category.reason, "stale_source");
});

test("source requests are bounded, credential scoped and do not disclose product/raw/secret fields", async () => {
  const config = env();
  const calls = [];
  const lookup = createCategoryLookup({ env: config, now: () => NOW, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(sample(new URL(url).searchParams.get("keyword"), [item(1)], { private: "do-not-return" }));
  } });
  const result = await lookup(["온열찜질기", "온열 찜질기"]);
  assert.equal(result.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("limit"), "20");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Bearer private-category-token");
  assert.doesNotMatch(JSON.stringify(result), /private-category-token|do-not-return|productId/u);
  await lookup(["온열찜질기"]);
  assert.equal(calls.length, 1);
  config.NAVER_KEYWORD_CATEGORY_COLLECTOR_TOKEN = "rotated-token";
  await lookup(["온열찜질기"]);
  assert.equal(calls.length, 2);
});

test("same-keyword requests dedupe in flight; unique lookup cap30 and global concurrency2 hold", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const lookup = createCategoryLookup({ env: env(), now: () => NOW, fetchImpl: async (url) => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return response(sample(new URL(url).searchParams.get("keyword")));
  } });
  const [a, b] = await Promise.all([lookup(["찜질기"]), lookup(["찜질기"])]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  const many = await lookup(Array.from({ length: 35 }, (_, i) => `키워드${i}`));
  assert.equal(many.length, 30);
  assert.equal(calls, 30); // global minute budget includes the earlier request
  assert.equal(maximum, 2);
  assert.equal(many.filter((row) => row.category.reason === "rate_limited").length, 1);
});

test("blocking response stops remaining fanout and cooldown prevents retry", async () => {
  for (const status of [403, 418, 429]) {
    let calls = 0;
    const lookup = createCategoryLookup({ env: env(), now: () => NOW, fetchImpl: async () => { calls += 1; return response({ secret: "must-not-leak" }, status); } });
    const result = await lookup(Array.from({ length: 30 }, (_, i) => `키${i}`));
    assert.ok(calls <= 2);
    assert.equal(result.length, 30);
    assert.ok(result.every((row) => row.category.status === "needs_confirmation"));
    assert.ok(result.some((row) => row.category.reason === "source_cooldown"));
    await lookup(["새키워드"]);
    assert.ok(calls <= 2);
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak/u);
  }
});

test("expired deadline makes zero calls; provider error/oversized/invalid data remain needs confirmation", async () => {
  let calls = 0;
  const lookup = createCategoryLookup({ env: env(), now: () => NOW, fetchImpl: async () => { calls += 1; throw new Error("private-body-token"); } });
  assert.equal((await lookup(["가"], { deadline: NOW }))[0].category.reason, "deadline_exceeded");
  assert.equal(calls, 0);
  const result = await lookup(["나"]);
  assert.equal(result[0].category.reason, "source_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /private-body-token/u);
  await assert.rejects(readBoundedJson(response({ text: "a".repeat(50) }), 20), /response_too_large/u);
  await assert.rejects(readBoundedJson(new Response("<html>private</html>")), /invalid_response/u);
});

test("short remaining deadline aborts a hung request without retries", async () => {
  let calls = 0;
  let signal;
  // A timeout timer may fire before the wall clock reaches its exact deadline.
  // Keep the clock fixed to make that boundary deterministic rather than flaky.
  const lookup = createCategoryLookup({ env: env(), now: () => NOW, fetchImpl: async (_, options) => {
    calls += 1;
    signal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } });
  const result = await lookup(["가", "나", "다"], { deadline: NOW + 25 });
  assert.ok(calls <= 2);
  assert.equal(signal.aborted, true);
  assert.ok(result.some((row) => row.category.reason === "source_timeout"));
  assert.ok(result.some((row) => row.category.reason === "deadline_exceeded"));
});

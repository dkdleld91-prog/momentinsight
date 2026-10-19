import assert from "node:assert/strict";
import test from "node:test";

import { handleKeywordResearchRequest } from "./keyword-research.mjs";
import { createRelatedKeywordsHandler, relatedRowsFromSearchAd } from "./related-keywords.mjs";
import { unconfirmedCategory } from "../related-keyword-categories.mjs";

const NOW = Date.parse("2026-10-14T01:00:00Z");
const env = () => ({ NAVER_SEARCHAD_API_KEY: "private-api-key", NAVER_SEARCHAD_SECRET_KEY: "private-secret", NAVER_SEARCHAD_CUSTOMER_ID: "123" });
const item = (keyword, extra = {}) => ({ relKeyword: keyword, monthlyPcQcCnt: 100, monthlyMobileQcCnt: 200, monthlyAvePcClkCnt: 1, monthlyAveMobileClkCnt: 2, monthlyAvePcCtr: 1, monthlyAveMobileCtr: 2, compIdx: "보통", ...extra });
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const request = (keyword = "찜질기", options = {}) => new Request(`https://app.example/api/client/keyword-research?mode=related&keyword=${encodeURIComponent(keyword)}`, { headers: { "x-mi-session-role": "owner" }, ...options });

test("related rows exclude normalized seed, dedupe, cap50 and use their own SearchAd values", () => {
  const rows = relatedRowsFromSearchAd({ keywordList: [item("찜 질기"), item("허리찜질기"), item("허리 찜질기"), ...Array.from({ length: 60 }, (_, i) => item(`연관${i}`, { monthlyPcQcCnt: i }))] }, "찜질기");
  assert.equal(rows.length, 50);
  assert.equal(rows[0].keyword, "허리찜질기");
  assert.equal(rows[0].volume, 300);
  assert.equal(rows[1].volume, 200);
  assert.equal(rows[0].ctr, 1.5);
});

test("a short official response is never padded to fifty", () => {
  const keywords = Array.from({ length: 14 }, (_, index) => `실제연관${index}`);
  const rows = relatedRowsFromSearchAd({ keywordList: [item("기준어"), ...keywords.map((keyword) => item(keyword))] }, "기준어");
  assert.deepEqual(rows.map((row) => row.keyword), keywords);
});

test("fifty related rows use one existing SearchAd request and one bounded category batch", async () => {
  let searchCalls = 0;
  let categoryCalls = 0;
  const keywords = Array.from({ length: 50 }, (_, index) => `연관${index}`);
  const handler = createRelatedKeywordsHandler({ env: env(), now: () => NOW,
    fetchImpl: async (url, options) => {
      searchCalls += 1;
      assert.equal(new URL(url).origin, "https://api.searchad.naver.com");
      assert.equal(options.method, "GET");
      return response({ keywordList: [item("기준어"), ...keywords.map((keyword) => item(keyword))] });
    },
    lookupCategories: async (values) => {
      categoryCalls += 1;
      assert.deepEqual(values, keywords);
      return values.map((keyword) => ({ keyword, category: unconfirmedCategory("no_stored_evidence", NOW) }));
    },
  });
  const payload = await (await handler(request("기준어"))).json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.related.map((row) => row.keyword), keywords);
  assert.equal(searchCalls, 1);
  assert.equal(categoryCalls, 1);
});

test("suppressed/missing counts preserve labels and null instead of fabricated numeric5/zero", () => {
  const rows = relatedRowsFromSearchAd({ keywordList: [
    item("가", { monthlyPcQcCnt: "< 10", monthlyMobileQcCnt: "<10" }),
    item("나", { monthlyPcQcCnt: 1000, monthlyMobileQcCnt: "< 10" }),
    item("다", { monthlyPcQcCnt: null, monthlyMobileQcCnt: 100 }),
    item("라", { monthlyPcQcCnt: 0, monthlyMobileQcCnt: 0 }),
  ] }, "seed");
  assert.equal(rows[0].pcVolume, null);
  assert.equal(rows[0].mobileVolume, null);
  assert.equal(rows[0].volume, null);
  assert.equal(rows[0].volumeLabel, "< 20");
  assert.equal(rows[1].volumeLabel, "< 1,010");
  assert.equal(rows[2].volumeLabel, "확인 필요");
  assert.equal(rows[3].volume, 0);
  assert.equal(rows[3].volumeLabel, "0");
  assert.throws(() => relatedRowsFromSearchAd({}, "seed"), /invalid_response/u);
});

test("method/session/input gate makes zero external calls; normal keyword handler still follows its existing gate", async () => {
  let calls = 0;
  const handler = createRelatedKeywordsHandler({ env: env(), fetchImpl: async () => { calls += 1; throw new Error("must-not-call"); } });
  assert.equal((await handler(request("찜질기", { method: "POST" }))).status, 405);
  assert.equal((await handler(request("찜질기", { headers: {} }))).status, 401);
  assert.equal((await handler(request(""))).status, 400);
  assert.equal(calls, 0);
  assert.equal((await handleKeywordResearchRequest(new Request("https://app.example/api/client/keyword-research", { method: "POST" }))).status, 405);
  assert.equal((await handleKeywordResearchRequest(new Request("https://app.example/api/client/keyword-research?mode=related&keyword=x"))).status, 401);
});

test("SearchAd-only fetch then exact per-row categories; existing product/rank APIs never called", async () => {
  const calls = [];
  let categoryKeys;
  const handler = createRelatedKeywordsHandler({ env: env(), now: () => NOW, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response({ keywordList: [item("찜질기"), item("허리찜질기"), item("전기매트")] });
  }, lookupCategories: async (keywords) => {
    categoryKeys = keywords;
    return keywords.map((keyword) => ({ keyword, category: { ...unconfirmedCategory("source_unavailable", NOW), reason: keyword === "전기매트" ? "no_results" : "source_unavailable" } }));
  } });
  const result = await (await handler(request())).json();
  assert.equal(result.ok, true);
  assert.deepEqual(categoryKeys, ["허리찜질기", "전기매트"]);
  assert.equal(result.related[1].category.reason, "no_results");
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, "https://api.searchad.naver.com");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.headers["X-Signature"]);
  assert.doesNotMatch(JSON.stringify(result), /private-api-key|private-secret|X-Signature/u);
});

test("category source failure preserves keyword metrics and confirmation state", async () => {
  const handler = createRelatedKeywordsHandler({ env: env(), now: () => NOW, fetchImpl: async () => response({ keywordList: [item("연관어")] }), lookupCategories: async () => { throw new Error("private-source-error"); } });
  const result = await (await handler(request())).json();
  assert.equal(result.ok, true);
  assert.equal(result.related[0].volume, 300);
  assert.equal(result.related[0].category.status, "needs_confirmation");
  assert.doesNotMatch(JSON.stringify(result), /private-source-error/u);
});

test("category replies cannot attach a different spacing/case keyword's stored category", async () => {
  const handler = createRelatedKeywordsHandler({ env: env(), now: () => NOW,
    fetchImpl: async () => response({ keywordList: [item("허리찜질기"), item("CaseWord")] }),
    lookupCategories: async () => ["허리 찜질기", "caseword"].map((keyword) => ({ keyword, category: { status: "single", middle: "다른분류", small: "다른상품" } })),
  });
  const result = await (await handler(request())).json();
  assert.ok(result.related.every((row) => row.category.status === "needs_confirmation"));
  assert.doesNotMatch(JSON.stringify(result), /다른분류|다른상품/u);
});

test("SearchAd words preserve exact inner spacing and never truncate a different long keyword into a stored one", () => {
  const prefix = "가".repeat(60);
  const rows = relatedRowsFromSearchAd({ keywordList: [item("허리  찜질기"), item(prefix + "다른말"), item("CaseWord")] }, "seed");
  assert.deepEqual(rows.map((row) => row.keyword), ["허리  찜질기", "CaseWord"]);
});

test("SearchAd concurrent same query dedupes, cached rows remain scoped to changed credentials", async () => {
  let calls = 0;
  const config = env();
  const handler = createRelatedKeywordsHandler({ env: config, now: () => NOW, fetchImpl: async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    return response({ keywordList: [item("연관어")] });
  }, lookupCategories: async () => [] });
  await Promise.all([handler(request()), handler(request())]);
  assert.equal(calls, 1);
  await handler(request());
  assert.equal(calls, 1);
  config.NAVER_SEARCHAD_SECRET_KEY = "rotated-secret";
  await handler(request());
  assert.equal(calls, 2);
});

test("unconfigured, invalid, rate-limited provider returns explicit error, no fabricated empty success", async () => {
  const missing = createRelatedKeywordsHandler({ env: {}, now: () => NOW, fetchImpl: async () => { throw new Error("must-not-call"); } });
  const missingResult = await (await missing(request())).json();
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, "source_unavailable");
  let calls = 0;
  const limited = createRelatedKeywordsHandler({ env: env(), now: () => NOW, fetchImpl: async () => { calls += 1; return response({ private: "do-not-return" }, 429); } });
  assert.equal((await limited(request())).status, 429);
  const next = await (await limited(request("새키워드"))).json();
  assert.equal(next.reason, "source_cooldown");
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(next), /do-not-return/u);
  const invalid = createRelatedKeywordsHandler({ env: env(), now: () => NOW, fetchImpl: async () => response({ wrong: "shape" }) });
  assert.equal((await (await invalid(request())).json()).reason, "invalid_response");
});

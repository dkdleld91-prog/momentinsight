import assert from "node:assert/strict";
import test from "node:test";
import { categoriesFromSample, createCategoryLookup } from "./related-keyword-categories.mjs";
import { verifyCommerceCategory } from "../../scripts/verify-related-keyword-commerce.mjs";
import { createCommerceCategorySource } from "./naver-commerce-category-source.mjs";
import { createRelatedKeywordsHandler } from "./handlers/related-keywords.mjs";

const NOW = Date.parse("2026-10-18T01:00:00Z");
const SOURCE = "naver_commerce_catalog_sample";
const sample = (items, extra = {}) => ({ schemaVersion: "mi.keyword-category-sample.v1", source: SOURCE, keyword: "온열찜질기", complete: true, collectedAt: new Date(NOW).toISOString(), items, sampleLimit: 20, hasMore: false, totalElements: items.length, ...extra });
const item = (id = "12345", middle = "냉온/찜질용품", small = "찜질기") => ({ catalogId: id, categoryId: "50000001", category2: middle, category3: small });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const env = () => ({ NAVER_KEYWORD_CATEGORY_SOURCE: "commerce", NAVER_COMMERCE_CLIENT_ID: "fixture-client", NAVER_COMMERCE_CLIENT_SECRET: "$2b$04$......................", NAVER_COMMERCE_TOKEN_TYPE: "SELF" });

test("Commerce sample keeps exact catalog-category evidence separate from products and ranking", () => {
  const result = categoriesFromSample(sample([item()]), "온열찜질기", NOW);
  assert.equal(result.status, "single");
  assert.equal(result.source, SOURCE);
  assert.equal(result.middle, "냉온/찜질용품");
  assert.equal(result.small, "찜질기");
  assert.equal(result.basis, "catalog_search");
  assert.equal(result.hasMore, false);
  assert.doesNotMatch(JSON.stringify(result), /sourceExhausted|marketTotal|rank|productId/u);
});

test("Commerce multiple and incomplete results are distinct; more pages never imply full coverage", () => {
  const mixed = categoriesFromSample(sample([item(), item("23456", "침구류", "전기매트")], { hasMore: true, totalElements: 200 }), "온열찜질기", NOW);
  assert.equal(mixed.status, "multiple");
  assert.equal(mixed.hasMore, true);
  assert.equal(mixed.totalElements, 200);
  const partial = categoriesFromSample(sample([item(), item("23456", "", "")], { complete: false }), "온열찜질기", NOW);
  assert.equal(partial.status, "needs_confirmation");
  assert.equal(partial.reason, "incomplete_sample");
  assert.equal(categoriesFromSample(sample([]), "온열찜질기", NOW).status, "needs_confirmation");
  assert.equal(categoriesFromSample(sample([{ ...item(), categoryId: "" }]), "온열찜질기", NOW).reason, "invalid_sample");
  assert.equal(categoriesFromSample(sample([item(), item()]), "온열찜질기", NOW).reason, "invalid_sample");
});

test("explicit Commerce mode uses only official auth and catalog GET for every exact related word", async () => {
  const calls = [];
  const config = env();
  const lookup = createCategoryLookup({ env: config, now: () => NOW, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.commerce.naver.com");
    if (parsed.pathname === "/external/v1/oauth2/token") return response({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 10800 });
    assert.equal(parsed.pathname, "/external/v1/product-models");
    return response({ page: 1, size: 20, first: true, last: true, totalElements: 1, totalPages: 1, contents: [{ id: 12345, categoryId: "50000001", wholeCategoryName: "생활/건강 > 냉온/찜질용품 > 찜질기" }] });
  } });
  const result = await lookup(["온열찜질기", "허리찜질기"]);
  assert.deepEqual(result.map((row) => row.category.status), ["single", "single"]);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(calls.length, 3);
  const names = calls.filter((call) => call.options.method === "GET").map((call) => new URL(call.url).searchParams.get("name"));
  assert.deepEqual(names.sort(), ["온열찜질기", "허리찜질기"].sort());
  assert.doesNotMatch(JSON.stringify(result), /fixture-access-token|fixture-client|client_secret_sign/u);
});

test("missing Commerce config is finite and never falls back to a rank or retired API", async () => {
  let calls = 0;
  const lookup = createCategoryLookup({ env: { NAVER_KEYWORD_CATEGORY_SOURCE: "commerce" }, fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); } });
  const rows = await lookup(["온열찜질기", "다른 연관어"]);
  assert.equal(calls, 0);
  assert.ok(rows.every((row) => row.category.status === "needs_confirmation"));
});

test("related handler never activates Commerce even when obsolete Commerce credentials remain configured", async () => {
  const calls = [];
  const config = { ...env(), NAVER_SEARCHAD_API_KEY: "fixture-search", NAVER_SEARCHAD_SECRET_KEY: "fixture-secret", NAVER_SEARCHAD_CUSTOMER_ID: "123" };
  const handler = createRelatedKeywordsHandler({ env: config, now: () => NOW, fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, method: options.method });
    if (parsed.origin === "https://api.searchad.naver.com") return response({ keywordList: [{ relKeyword: "허리찜질기", monthlyPcQcCnt: 100, monthlyMobileQcCnt: 200 }] });
    assert.fail("stored-only handler must not call an external category provider");
  } });
  const request = new Request("https://app.example/api/client/keyword-research?mode=related&keyword=온열찜질기", { headers: { "x-mi-session-role": "owner", "x-mi-owner-agency-code": "mml93-a01" } });
  const result = await (await handler(request)).json();
  assert.equal(result.related[0].category.status, "needs_confirmation");
  assert.equal(result.related[0].category.reason, "source_unavailable");
  assert.equal(result.related[0].category.checkedAt, null);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-secret|fixture-search/u);
});

test("separate stored-only handlers retain their own Supabase credentials and transport", async () => {
  const run = async (secret) => {
    let storedReads = 0;
    const handler = createRelatedKeywordsHandler({ env: { ...env(), SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: secret, NAVER_SEARCHAD_API_KEY: "fixture-search", NAVER_SEARCHAD_SECRET_KEY: "fixture-secret", NAVER_SEARCHAD_CUSTOMER_ID: "123" }, now: () => NOW, fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.origin === "https://api.searchad.naver.com") return response({ keywordList: [{ relKeyword: "연관어", monthlyPcQcCnt: 1, monthlyMobileQcCnt: 2 }] });
      assert.equal(parsed.origin, "https://project.supabase.co");
      assert.equal(options.method, "GET");
      assert.equal(options.headers.apikey, secret);
      assert.equal(options.headers.authorization, undefined);
      storedReads += 1;
      return response([]);
    } });
    const result = await (await handler(new Request("https://app.example/api/client/keyword-research?mode=related&keyword=기준어", { headers: { "x-mi-session-role": "owner", "x-mi-owner-agency-code": "mml93-a01" } }))).json();
    assert.equal(storedReads, 1);
    return result.related[0].category.reason;
  };
  assert.deepEqual(await Promise.all([run("sb_secret_one"), run("sb_secret_two")]), ["no_stored_evidence", "no_stored_evidence"]);
});

test("a generic collector cannot impersonate the official Commerce source", async () => {
  let calls = 0;
  const lookup = createCategoryLookup({ env: { NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: "https://category.example/sample", NAVER_KEYWORD_CATEGORY_COLLECTOR_TOKEN: "fixture-only" }, now: () => NOW, fetchImpl: async () => { calls += 1; return response(sample([item()])); } });
  const [row] = await lookup(["온열찜질기"]);
  assert.equal(calls, 1);
  assert.equal(row.category.status, "needs_confirmation");
  assert.equal(row.category.reason, "source_mismatch");
  assert.equal(row.category.basis, undefined);
});

test("a Commerce auth denial stops this batch without trying credentials repeatedly", async () => {
  let calls = 0;
  const lookup = createCategoryLookup({ env: env(), now: () => NOW, fetchImpl: async () => { calls += 1; return response({ private: "never disclose" }, 403); } });
  const rows = await lookup(Array.from({ length: 30 }, (_, index) => `연관어${index}`));
  assert.equal(calls, 1);
  assert.ok(rows.every((row) => row.category.status === "needs_confirmation"));
  assert.doesNotMatch(JSON.stringify(rows), /never disclose/u);
});

test("live verification requires explicit intent and configured credentials, exposes no secret or raw failure", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("private-token-fixture"); };
  assert.equal((await verifyCommerceCategory({ args: [], env: env(), fetchImpl })).report.networkRequests, 0);
  assert.equal((await verifyCommerceCategory({ args: ["--live", "--keyword", "온열찜질기"], env: {}, fetchImpl })).report.networkRequests, 0);
  const failed = await verifyCommerceCategory({ args: ["--live", "--keyword", "온열찜질기"], env: env(), fetchImpl, now: () => NOW });
  assert.equal(failed.exitCode, 1);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(failed.report), /private-token-fixture|fixture-client/u);
});

test("a catalog response after a clock deadline is rejected even before its timer fires", async () => {
  let at = NOW;
  const source = createCommerceCategorySource({ env: env(), now: () => at, signImpl: async () => "fixture-signature", fetchImpl: async (url) => {
    if (url.endsWith("/oauth2/token")) return response({ access_token: "fixture-only", token_type: "Bearer", expires_in: 10800 });
    at += 100;
    return response({ page: 1, size: 20, first: true, last: true, totalElements: 1, totalPages: 1, contents: [{ id: 12345, categoryId: "50000001", wholeCategoryName: "생활/건강 > 냉온/찜질용품 > 찜질기" }] });
  } });
  await assert.rejects(source("온열찜질기", { deadline: NOW + 50 }), /deadline_exceeded/u);
});

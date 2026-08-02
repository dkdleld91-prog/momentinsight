import assert from "node:assert/strict";
import test from "node:test";

import shoppingRankHandler, { shoppingProviderPageCache } from "./naver-shopping-rank.mjs";
import { resetMobileTopFallbackStateForTests } from "../naver-shopping/mobile-top-fallback.mjs";

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("single rank lookup reports an unverified cold provider as retryable warming", async () => {
  const previousUrl = process.env.NAVER_SHOPPING_RANK_API_URL;
  const previousKey = process.env.NAVER_SHOPPING_RANK_API_KEY;
  const previousMode = process.env.NAVER_SHOPPING_RANK_MODE;
  const originalFetch = globalThis.fetch;
  process.env.NAVER_SHOPPING_RANK_API_URL = "https://collector.example/rank";
  process.env.NAVER_SHOPPING_RANK_API_KEY = "collector-secret";
  process.env.NAVER_SHOPPING_RANK_MODE = "provider";
  shoppingProviderPageCache.clear();
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    message: "provider_not_ready",
  }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

  try {
    const response = await shoppingRankHandler.fetch(new Request(
      "http://localhost/api/naver-shopping-rank?keyword=%EC%98%A8%EC%97%B4%EC%B0%9C%EC%A7%88%EA%B8%B0&productId=12149720593",
    ));
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.ok, false);
    assert.equal(payload.errorCode, "SHOPPING_RANK_PROVIDER_WARMING");
    assert.equal(payload.retryable, true);
    assert.equal(payload.retryAfter, 15);
    assert.equal(payload.rankSourceReady, false);
    assert.deepEqual(payload.providerStatus, {
      status: "warming",
      retryable: true,
      retryAfter: 15,
    });
    assert.equal(payload.sourceStatus.shoppingRank.status, "warming");
    assert.doesNotMatch(JSON.stringify(payload), /collector-secret/);
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.NAVER_SHOPPING_RANK_API_URL;
    else process.env.NAVER_SHOPPING_RANK_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NAVER_SHOPPING_RANK_API_KEY;
    else process.env.NAVER_SHOPPING_RANK_API_KEY = previousKey;
    if (previousMode === undefined) delete process.env.NAVER_SHOPPING_RANK_MODE;
    else process.env.NAVER_SHOPPING_RANK_MODE = previousMode;
  }
});

test("single rank lookup keeps a top-window miss non-retryable and preserves source readiness", async () => {
  const previousUrl = process.env.NAVER_SHOPPING_RANK_API_URL;
  const previousKey = process.env.NAVER_SHOPPING_RANK_API_KEY;
  const previousMode = process.env.NAVER_SHOPPING_RANK_MODE;
  const originalFetch = globalThis.fetch;
  delete process.env.NAVER_SHOPPING_RANK_API_URL;
  delete process.env.NAVER_SHOPPING_RANK_API_KEY;
  process.env.NAVER_SHOPPING_RANK_MODE = "mobile_top_fallback";
  resetMobileTopFallbackStateForTests();

  const keyword = "온열찜질기";
  const bootstrap = {
    initProps: { byPassBFFParams: { rev: "4" } },
    device: { type: "mobile" },
    query: keyword,
    originQuery: keyword,
    pageId: "runtime-page",
    sessionId: "runtime-session",
    viewType: "GUIDE",
    areaCode: "shp_tli",
    rev: "4",
    bffHost: "ns-portal.shopping.naver.com",
  };
  const slot = (rank) => ({
    slotType: "CARD",
    data: {
      cardType: "ORGANIC_CARD",
      sourceType: "SAS",
      rank,
      nvMid: String(90000000000 + rank),
      channelProductId: String(12000000000 + rank),
      originalMallProductId: String(11000000000 + rank),
      productName: `검증 상품 ${rank}`,
      productUrl: { pcUrl: `https://smartstore.naver.com/example/products/${12000000000 + rank}` },
      images: [{ imageUrl: `https://shopping-phinf.pstatic.net/${rank}.jpg` }],
      mallName: "검증몰",
      salePrice: 10000 + rank,
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "m.search.naver.com") {
      return new Response(`<!doctype html><script>naver.search.ext.newshopping["shopping"]._INITIAL_STATE=${JSON.stringify(bootstrap)};</script>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify({
      data: [{ page: 1, pageSize: 50, slots: [slot(1), slot(2)] }],
    }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  try {
    const response = await shoppingRankHandler.fetch(new Request(
      `http://localhost/api/naver-shopping-rank?keyword=${encodeURIComponent(keyword)}&productId=99999999999`,
    ));
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.ok, false);
    assert.equal(payload.errorCode, "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW");
    assert.equal(payload.retryable, false);
    assert.equal(payload.retryAfter, 0);
    assert.equal(payload.rankSourceReady, true);
    assert.equal(payload.providerStatus.status, "coverage_limited");
  } finally {
    resetMobileTopFallbackStateForTests();
    globalThis.fetch = originalFetch;
    restoreEnv("NAVER_SHOPPING_RANK_API_URL", previousUrl);
    restoreEnv("NAVER_SHOPPING_RANK_API_KEY", previousKey);
    restoreEnv("NAVER_SHOPPING_RANK_MODE", previousMode);
  }
});

test("single rank lookup exposes provider auth and mode errors as terminal readiness failures", async () => {
  const previousUrl = process.env.NAVER_SHOPPING_RANK_API_URL;
  const previousKey = process.env.NAVER_SHOPPING_RANK_API_KEY;
  const previousMode = process.env.NAVER_SHOPPING_RANK_MODE;
  const originalFetch = globalThis.fetch;

  try {
    process.env.NAVER_SHOPPING_RANK_MODE = "provider";
    process.env.NAVER_SHOPPING_RANK_API_URL = "https://collector.example/rank";
    process.env.NAVER_SHOPPING_RANK_API_KEY = "wrong-secret";
    shoppingProviderPageCache.clear();
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: false,
      message: "provider_unauthorized",
    }), { status: 401, headers: { "content-type": "application/json" } });

    const unauthorized = await shoppingRankHandler.fetch(new Request(
      "http://localhost/api/naver-shopping-rank?keyword=test&productId=12149720593",
    ));
    const unauthorizedPayload = await unauthorized.json();
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedPayload.errorCode, "SHOPPING_RANK_PROVIDER_UNAUTHORIZED");
    assert.equal(unauthorizedPayload.retryable, false);
    assert.equal(unauthorizedPayload.rankSourceReady, false);
    assert.equal(unauthorizedPayload.sourceStatus.shoppingRank.status, "unauthorized");

    process.env.NAVER_SHOPPING_RANK_MODE = "provider_typo";
    const invalid = await shoppingRankHandler.fetch(new Request(
      "http://localhost/api/naver-shopping-rank?keyword=test&productId=12149720593",
    ));
    const invalidPayload = await invalid.json();
    assert.equal(invalid.status, 503);
    assert.equal(invalidPayload.errorCode, "SHOPPING_RANK_MODE_INVALID");
    assert.equal(invalidPayload.retryable, false);
    assert.equal(invalidPayload.rankSourceReady, false);
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
    restoreEnv("NAVER_SHOPPING_RANK_API_URL", previousUrl);
    restoreEnv("NAVER_SHOPPING_RANK_API_KEY", previousKey);
    restoreEnv("NAVER_SHOPPING_RANK_MODE", previousMode);
  }
});

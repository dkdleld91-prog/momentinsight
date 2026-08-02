import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGitHubMacOsSafariRunner,
  collectGitHubSafariWindow,
} from "../src/safari-cloud.mjs";

const env = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_OS: "macOS",
  GITHUB_RUN_ID: "123456789",
  GITHUB_RUN_ATTEMPT: "1",
};

function pagePayload(pageIndex) {
  const start = ((pageIndex - 1) * 40) + 1;
  const count = Math.min(40, 301 - start);
  return {
    shoppingResult: {
      total: 300,
      products: Array.from({ length: count }, (_, index) => {
        const rank = start + index;
        const sellerProductId = String(12_000_000_000 + rank);
        return {
          collection: "product",
          id: String(90_000_000_000 + rank),
          rank,
          mallId: "example",
          mallProductId: sellerProductId,
          stdCatalogMatchType: "0",
          productTitle: `Safari 검증 상품 ${rank}`,
          mallProductUrl: `https://smartstore.naver.com/example/products/${sellerProductId}`,
          mallName: "검증몰",
        };
      }),
    },
  };
}

test("allows only GitHub-hosted macOS for the Safari canary", () => {
  assert.equal(assertGitHubMacOsSafariRunner(env), true);
  assert.throws(() => assertGitHubMacOsSafariRunner({ ...env, RUNNER_OS: "Linux" }), /github_macos_safari_runner_required/u);
  assert.throws(() => assertGitHubMacOsSafariRunner({ ...env, RUNNER_ENVIRONMENT: "self-hosted" }), /github_macos_safari_runner_required/u);
});

test("collects a strict 300-item no-save window through Safari", async () => {
  let closed = 0;
  let currentUrl = "";
  const client = {
    async start() {},
    async navigate(url) { currentUrl = url; },
    async snapshot() {
      return {
        userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
        bodyText: "온열찜질기 검색 결과",
        title: "네이버 쇼핑",
        url: currentUrl,
      };
    },
    async fetchFrontend(path) {
      const url = new URL(path, "https://search.shopping.naver.com");
      const pageIndex = Number(url.searchParams.get("pagingIndex"));
      return {
        status: 200,
        url: url.toString(),
        contentType: "application/json",
        bodyText: JSON.stringify(pagePayload(pageIndex)),
      };
    },
    async close() { closed += 1; },
  };

  const result = await collectGitHubSafariWindow({
    env,
    client,
    keyword: "온열찜질기",
  });
  assert.equal(result.browser, "Safari");
  assert.equal(result.window.checkedCount, 300);
  assert.equal(result.window.items[0].organicRank, 1);
  assert.equal(result.window.items[299].organicRank, 300);
  assert.equal(closed, 0, "an injected client remains owned by its caller");
});

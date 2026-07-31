import assert from "node:assert/strict";
import test from "node:test";

import {
  NAVER_RANK_CRON_ITEM_FAILURE,
  NAVER_RANK_PROVIDER_NOT_CONFIGURED,
  productRankCronBatchLimit,
  productRankCronProviderConfigured,
  safeProductRankCronSummary,
} from "./naver-rank-cron.mjs";

function limit(value) {
  const url = new URL("https://example.com/api/naver-rank-cron");
  if (value !== undefined) url.searchParams.set("limit", value);
  return productRankCronBatchLimit(url);
}

test("product cron keeps a conservative default batch", () => {
  assert.equal(limit(), 1);
  assert.equal(limit("not-a-number"), 1);
});

test("product cron accepts only a bounded sequential batch", () => {
  assert.equal(limit("1"), 1);
  assert.equal(limit("5"), 5);
  assert.equal(limit("3.9"), 3);
  assert.equal(limit("0"), 1);
  assert.equal(limit("-10"), 1);
  assert.equal(limit("100"), 5);
});

test("product cron requires the dedicated external collector pair", () => {
  assert.equal(productRankCronProviderConfigured({}), false);
  assert.equal(productRankCronProviderConfigured({ providerUrl: "https://collector.example" }), false);
  assert.equal(productRankCronProviderConfigured({ providerKey: "collector-key" }), false);
  assert.equal(productRankCronProviderConfigured({ clientId: "legacy-id", clientSecret: "legacy-secret" }), false);
  assert.equal(productRankCronProviderConfigured({
    providerUrl: "https://collector.example",
    providerKey: "collector-key",
  }), true);
  assert.equal(NAVER_RANK_PROVIDER_NOT_CONFIGURED, "NAVER_RANK_PROVIDER_NOT_CONFIGURED");
  assert.equal(NAVER_RANK_CRON_ITEM_FAILURE, "NAVER_RANK_CRON_ITEM_FAILURE");
});

test("product cron exposes only aggregate counts in its summary", () => {
  const summary = safeProductRankCronSummary({
    now: "2026-07-31T01:02:03.000Z",
    checked: 5,
    succeeded: 3,
    failed: 2,
    remaining: 7,
    drained: false,
    configured: true,
    results: [{
      trackerId: "private-tracker-id",
      keyword: "private-keyword",
      productId: "private-product-id",
    }],
  });

  assert.deepEqual(summary, {
    now: "2026-07-31T01:02:03.000Z",
    checked: 5,
    succeeded: 3,
    failed: 2,
    remaining: 7,
    drained: false,
    configured: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /private|trackerId|keyword|productId/);
});

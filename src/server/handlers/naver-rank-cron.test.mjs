import assert from "node:assert/strict";
import test from "node:test";

import { productRankCronBatchLimit } from "./naver-rank-cron.mjs";

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

#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  canonicalUrlKey,
  extractProductId,
  matchTargetItem,
  productIdCandidates,
} from "../src/server/handlers/naver-shopping-rank.mjs";

const smartstoreUrl = "https://smartstore.naver.com/sample-store/products/1234567890?NaPm=ct%3Dabc%7Cci%3D999999999999999999999";
const catalogUrl = "https://search.shopping.naver.com/catalog/9876543210?query=%EB%82%A8%EC%84%B1%20%EC%86%8D%EC%98%B7&cat_id=50000000";

assert.equal(extractProductId(smartstoreUrl), "1234567890");
assert.deepEqual(productIdCandidates(smartstoreUrl), ["1234567890"]);
assert.equal(extractProductId(catalogUrl), "9876543210");
assert.deepEqual(productIdCandidates(catalogUrl), ["9876543210"]);

assert.equal(
  canonicalUrlKey("https://m.smartstore.naver.com/sample-store/products/1234567890?foo=bar"),
  "smartstore.naver.com/sample-store/products/1234567890",
);

const target = {
  productId: "1234567890",
  productIds: ["1234567890"],
  urlKeys: ["smartstore.naver.com/sample-store/products/1234567890"],
  mallName: "",
  productTitle: "",
};

assert.equal(matchTargetItem({
  productId: "2222222222",
  link: "https://smartstore.naver.com/sample-store/products/2222222222?NaPm=ct%3Dabc%7Cci%3D1234567890",
  title: "다른 상품",
  mallName: "sample-store",
}, target).matched, false);

assert.equal(matchTargetItem({
  productId: "2222222222",
  link: "https://smartstore.naver.com/sample-store/products/2222222222",
  title: "정확한 상품 옵션형 다른 상품",
  mallName: "sample-store",
}, {
  ...target,
  hasDirectTarget: true,
  productTitle: "정확한 상품",
  mallName: "sample-store",
}).matched, false);

assert.deepEqual(matchTargetItem({
  productId: "1234567890",
  link: "https://smartstore.naver.com/sample-store/products/1234567890",
  title: "정확한 상품",
  mallName: "sample-store",
}, target), {
  matched: true,
  matchType: "product_id",
  matchedProductId: "1234567890",
});

assert.equal(matchTargetItem({
  productId: "",
  link: "https://m.smartstore.naver.com/sample-store/products/1234567890?NaPm=abc",
  title: "정확한 상품",
  mallName: "sample-store",
}, target).matched, true);

console.log("Naver rank matching checks passed.");

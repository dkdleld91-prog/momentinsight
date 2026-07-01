#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildRankTarget,
  canonicalUrlKey,
  extractProductId,
  findOrganicMatchInItems,
  isAdItem,
  matchTargetItem,
  productIdCandidates,
  rankPagePosition,
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

assert.equal(isAdItem({ productId: "1234567890", title: "광고 상품", isAd: true }), true);
assert.equal(isAdItem({ productId: "1234567890", title: "협찬 상품", sponsored: "Y" }), true);
assert.equal(isAdItem({ productId: "1234567890", title: "일반 상품", mallName: "sample-store" }), false);

assert.deepEqual(rankPagePosition(40), { page: 1, position: 40, pageSize: 40 });
assert.deepEqual(rankPagePosition(41), { page: 2, position: 1, pageSize: 40 });
assert.deepEqual(rankPagePosition(81), { page: 3, position: 1, pageSize: 40 });

const organicTarget = buildRankTarget({ targetProductId: "9999999999" });
const shoppingItem = (productId, overrides = {}) => ({
  productId,
  link: `https://smartstore.naver.com/sample-store/products/${productId}`,
  title: `테스트 상품 ${productId}`,
  mallName: "sample-store",
  ...overrides,
});

const adOnlyMatch = findOrganicMatchInItems([
  shoppingItem("9999999999", { isAd: true }),
], organicTarget, { limit: 100, topItems: [] });
assert.equal(adOnlyMatch.matched, false);
assert.equal(adOnlyMatch.organicCheckedCount, 0);
assert.equal(adOnlyMatch.excludedAdCount, 1);

const mixedMatch = findOrganicMatchInItems([
  shoppingItem("1111111111"),
  shoppingItem("9999999999", { isAd: true }),
  shoppingItem("2222222222"),
  shoppingItem("9999999999"),
], organicTarget, { limit: 100, topItems: [] });
assert.equal(mixedMatch.matched, true);
assert.equal(mixedMatch.rank, 3);
assert.equal(mixedMatch.page, 1);
assert.equal(mixedMatch.position, 3);
assert.equal(mixedMatch.excludedAdCount, 1);

const fortyOrganicAhead = Array.from({ length: 40 }, (_, index) => shoppingItem(String(1000000000 + index)));
const pageTwoMatch = findOrganicMatchInItems([
  ...fortyOrganicAhead,
  shoppingItem("9999999999"),
], organicTarget, { limit: 100, topItems: [] });
assert.equal(pageTwoMatch.matched, true);
assert.equal(pageTwoMatch.rank, 41);
assert.equal(pageTwoMatch.page, 2);
assert.equal(pageTwoMatch.position, 1);

const catalogAheadMatch = findOrganicMatchInItems([
  {
    productId: "59388521435",
    link: "https://search.shopping.naver.com/catalog/59388521435",
    title: "맥스젠 SR13W 화이트",
    mallName: "",
    productType: "1",
    category1: "디지털/가전",
    category2: "생활가전",
    category3: "다리미",
    category4: "스팀다리미",
  },
  {
    productId: "90613774375",
    link: "https://smartstore.naver.com/main/products/13069263283",
    title: "[maxzen] 맥스젠 진공 스팀다리미 SR13W 핸디형",
    mallName: "maxzen",
    productType: "3",
    category1: "디지털/가전",
    category2: "생활가전",
    category3: "다리미",
    category4: "스팀다리미",
  },
], buildRankTarget({
  targetUrl: "https://smartstore.naver.com/maxzen/products/13069263283",
}), { limit: 100, topItems: [] });
assert.equal(catalogAheadMatch.matched, true);
assert.equal(catalogAheadMatch.rank, 2);
assert.equal(catalogAheadMatch.inferredCatalog.rank, 1);
assert.equal(catalogAheadMatch.inferredCatalog.item.productId, "59388521435");

console.log("Naver rank matching checks passed.");

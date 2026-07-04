#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildRankTarget,
  canonicalUrlKey,
  extractProductId,
  findOrganicMatchInItems,
  inferCatalogFromProductMetadata,
  isAdItem,
  matchTargetItem,
  productIdCandidates,
  rankPagePosition,
  rankQueryKeyword,
} from "../src/server/handlers/naver-shopping-rank.mjs";

const smartstoreUrl = "https://smartstore.naver.com/sample-store/products/1234567890?NaPm=ct%3Dabc%7Cci%3D999999999999999999999";
const catalogUrl = "https://search.shopping.naver.com/catalog/9876543210?query=%EB%82%A8%EC%84%B1%20%EC%86%8D%EC%98%B7&cat_id=50000000";
const brandProductUrl = "https://brand.naver.com/jyns/products/6567319094";

assert.equal(extractProductId(smartstoreUrl), "1234567890");
assert.deepEqual(productIdCandidates(smartstoreUrl), ["1234567890"]);
assert.equal(extractProductId(catalogUrl), "9876543210");
assert.deepEqual(productIdCandidates(catalogUrl), ["9876543210"]);
assert.equal(extractProductId(brandProductUrl), "6567319094");
assert.deepEqual(productIdCandidates(brandProductUrl), ["6567319094"]);
assert.equal(rankQueryKeyword("콘트로이친"), "콘드로이친");
assert.equal(rankQueryKeyword("콘드로이친"), "콘드로이친");

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

const brandCatalogAheadMatch = findOrganicMatchInItems([
  {
    productId: "51929469110",
    link: "https://search.shopping.naver.com/catalog/51929469110",
    title: "주영엔에스 관절엔 콘드로이친 1200 900mg x 60정, 1개",
    mallName: "네이버",
    productType: "1",
    category1: "식품",
    category2: "건강식품",
    category3: "영양제",
    category4: "콘드로이친",
  },
  {
    productId: "84111819427",
    link: "https://smartstore.naver.com/main/products/6567319094",
    title: "주영엔에스 관절엔 콘드로이친 1200 60정, 3개",
    mallName: "주영엔에스",
    productType: "3",
    category1: "식품",
    category2: "건강식품",
    category3: "영양제",
    category4: "콘드로이친",
  },
], buildRankTarget({
  targetUrl: brandProductUrl,
}), { limit: 100, topItems: [] });
assert.equal(brandCatalogAheadMatch.matched, true);
assert.equal(brandCatalogAheadMatch.rank, 2);
assert.equal(brandCatalogAheadMatch.inferredCatalog.rank, 1);
assert.equal(brandCatalogAheadMatch.inferredCatalog.item.productId, "51929469110");

const brandCatalogAheadProductIdOnlyMatch = findOrganicMatchInItems([
  {
    productId: "51929469110",
    link: "https://search.shopping.naver.com/catalog/51929469110",
    title: "주영엔에스 관절엔 콘드로이친 1200 900mg x 60정, 1개",
    mallName: "네이버",
    productType: "1",
    category1: "식품",
    category2: "건강식품",
    category3: "영양제",
    category4: "콘드로이친",
  },
  {
    productId: "84111819427",
    link: "https://smartstore.naver.com/main/products/6567319094",
    title: "주영엔에스 관절엔 콘드로이친 1200 60정, 3개",
    mallName: "주영엔에스",
    productType: "3",
    category1: "식품",
    category2: "건강식품",
    category3: "영양제",
    category4: "콘드로이친",
  },
], buildRankTarget({
  targetProductId: "6567319094",
}), { limit: 100, topItems: [] });
assert.equal(brandCatalogAheadProductIdOnlyMatch.matched, true);
assert.equal(brandCatalogAheadProductIdOnlyMatch.rank, 2);
assert.equal(brandCatalogAheadProductIdOnlyMatch.inferredCatalog.rank, 1);
assert.equal(brandCatalogAheadProductIdOnlyMatch.inferredCatalog.item.productId, "51929469110");

const metadataCatalogMatch = inferCatalogFromProductMetadata({
  productId: "8888888888",
  link: "https://smartstore.naver.com/yncstore/products/8888888888",
  title: "maxzen 맥스젠 진공 스팀다리미 SR13W 핸디형",
  mallName: "YNC Store",
  productType: "",
}, [
  {
    rank: 37,
    item: {
      productId: "59388521435",
      link: "https://search.shopping.naver.com/catalog/59388521435",
      title: "맥스젠 SR13W 화이트",
      mallName: "",
      productType: "1",
    },
  },
]);
assert.equal(metadataCatalogMatch.rank, 37);
assert.equal(metadataCatalogMatch.item.productId, "59388521435");
assert.equal(metadataCatalogMatch.titleOverlap.includes("sr13w"), true);

const groupedSellerAliasTarget = buildRankTarget({
  targetUrl: "https://smartstore.naver.com/tncomm/products/13297440230",
});
assert.equal(groupedSellerAliasTarget.targetMode, "catalog");
assert.equal(groupedSellerAliasTarget.catalogId, "59388521435");
assert.deepEqual(groupedSellerAliasTarget.productIds, ["59388521435"]);

const higomSellerAliasTarget = buildRankTarget({
  targetUrl: "https://smartstore.naver.com/higommarket/products/10289183039",
});
assert.equal(higomSellerAliasTarget.targetMode, "catalog");
assert.equal(higomSellerAliasTarget.catalogId, "53551179280");
assert.deepEqual(higomSellerAliasTarget.productIds, ["53551179280"]);

const explicitCatalogTarget = buildRankTarget({
  targetUrl: "https://smartstore.naver.com/any-store/products/1111111111",
  targetCatalogId: "59388521435",
});
assert.equal(explicitCatalogTarget.catalogId, "59388521435");
assert.deepEqual(explicitCatalogTarget.productIds, ["59388521435"]);

console.log("Naver rank matching checks passed.");

#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildRankTarget,
  canonicalUrlKey,
  extractProductId,
  findShoppingRank,
  findOrganicMatchInItems,
  isAdItem,
  matchTargetItem,
  productExposureItemsFromOrganic,
  productIdCandidates,
  sellerProductIdCandidates,
  rankQueryKeyword,
  sellerItemsFromOrganic,
} from "../src/server/handlers/naver-shopping-rank.mjs";
import { PRODUCT_RANK_TRACKER_MAX_RANK } from "../src/server/handlers/naver-rank-trackers.mjs";

const smartstoreUrl = "https://smartstore.naver.com/sample-store/products/1234567890?NaPm=ct%3Dabc%7Cci%3D999999999999999999999";
const catalogUrl = "https://search.shopping.naver.com/catalog/9876543210?query=%EB%82%A8%EC%84%B1%20%EC%86%8D%EC%98%B7&cat_id=50000000";
const brandProductUrl = "https://brand.naver.com/jyns/products/6567319094";

assert.equal(PRODUCT_RANK_TRACKER_MAX_RANK, 300);

assert.equal(extractProductId(smartstoreUrl), "1234567890");
assert.deepEqual(productIdCandidates(smartstoreUrl), ["1234567890"]);
assert.equal(extractProductId(catalogUrl), "9876543210");
assert.deepEqual(productIdCandidates(catalogUrl), ["9876543210"]);
assert.equal(extractProductId(brandProductUrl), "6567319094");
assert.deepEqual(productIdCandidates(brandProductUrl), ["6567319094"]);
assert.deepEqual(sellerProductIdCandidates(brandProductUrl), ["6567319094"]);
assert.deepEqual(sellerProductIdCandidates(catalogUrl), []);
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
  matchEvidence: "seller_link_product_id",
});

assert.equal(matchTargetItem({
  productId: "1234567890",
  link: "https://smartstore.naver.com/another-store/products/9876543210",
  title: "API 상품번호만 우연히 같은 다른 판매자 상품",
  mallName: "another-store",
}, target).matched, false);

assert.deepEqual(matchTargetItem({
  productId: "9876543210",
  link: catalogUrl,
  title: "정확한 원부",
  mallName: "네이버",
  productType: "1",
}, buildRankTarget({ targetCatalogId: "9876543210" })), {
  matched: true,
  matchType: "product_id",
  matchedProductId: "9876543210",
  matchEvidence: "catalog_id",
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
  shoppingItem("3333333333"),
], organicTarget, { limit: 100, topItems: [] });
assert.equal(mixedMatch.matched, true);
assert.equal(mixedMatch.rank, 3);
assert.equal(mixedMatch.page, undefined);
assert.equal(mixedMatch.position, undefined);
assert.equal(mixedMatch.excludedAdCount, 1);
assert.equal(mixedMatch.organicCheckedCount, 4);

const fortyOrganicAhead = Array.from({ length: 40 }, (_, index) => shoppingItem(String(1000000000 + index)));
const fortyFirstApiResultMatch = findOrganicMatchInItems([
  ...fortyOrganicAhead,
  shoppingItem("9999999999"),
], organicTarget, { limit: 100, topItems: [] });
assert.equal(fortyFirstApiResultMatch.matched, true);
assert.equal(fortyFirstApiResultMatch.rank, 41);
assert.equal(fortyFirstApiResultMatch.page, undefined);
assert.equal(fortyFirstApiResultMatch.position, undefined);

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
assert.equal(catalogAheadMatch.inferredCatalog, undefined);

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
assert.equal(brandCatalogAheadMatch.inferredCatalog, undefined);

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
assert.equal(brandCatalogAheadProductIdOnlyMatch.inferredCatalog, undefined);

const groupedSellerAliasTarget = buildRankTarget({
  targetUrl: "https://smartstore.naver.com/tncomm/products/13297440230",
});
assert.equal(groupedSellerAliasTarget.targetMode, "product");
assert.equal(groupedSellerAliasTarget.catalogId, "");
assert.deepEqual(groupedSellerAliasTarget.productIds, ["13297440230"]);

const higomSellerAliasTarget = buildRankTarget({
  targetUrl: "https://smartstore.naver.com/higommarket/products/10289183039",
});
assert.equal(higomSellerAliasTarget.targetMode, "product");
assert.equal(higomSellerAliasTarget.catalogId, "");
assert.deepEqual(higomSellerAliasTarget.productIds, ["10289183039"]);

const exactLavTarget = buildRankTarget({
  targetProductId: "59606749556",
  targetUrl: "https://brand.naver.com/lav/products/5145848584",
});
assert.equal(exactLavTarget.targetMode, "product");
assert.equal(exactLavTarget.catalogId, "");
assert.deepEqual(exactLavTarget.productIds, ["5145848584"]);

const electricToothbrushTarget = buildRankTarget({
  targetUrl: "https://brand.naver.com/lav/products/12649811979",
});
assert.equal(matchTargetItem({
  productId: "12649811979",
  link: "https://smartstore.naver.com/other-store/products/5555555555",
  title: "우연히 API 상품번호만 같은 다른 상품",
  mallName: "다른 판매자",
  productType: "3",
}, electricToothbrushTarget).matched, false);
assert.deepEqual(matchTargetItem({
  productId: "90194322885",
  link: "https://smartstore.naver.com/main/products/12649811979",
  title: "라이브오랄스 음파 전동칫솔 회전 IPX8 방수 C타입 충전식 초극세모 칫솔모 3P",
  mallName: "라이브오랄스",
  productType: "3",
}, electricToothbrushTarget), {
  matched: true,
  matchType: "product_id",
  matchedProductId: "12649811979",
  matchEvidence: "seller_link_product_id",
});

const exactLavMatch = findOrganicMatchInItems([
  {
    productId: "56704991367",
    link: "https://search.shopping.naver.com/catalog/56704991367",
    title: "라이브오랄스 퓨어다이아 셀프 치아미백제 2주분 10g, 1개",
    mallName: "네이버",
    productType: "1",
    lprice: "26460",
    brand: "라이브오랄스",
    category1: "생활/건강",
    category2: "구강위생용품",
    category3: "치아미백제",
  },
  {
    productId: "59606749556",
    link: "https://search.shopping.naver.com/catalog/59606749556",
    title: "라브 라이브오랄스 퓨어다이아 셀프 치아미백제 세트",
    mallName: "네이버",
    productType: "1",
    lprice: "25060",
    brand: "라이브오랄스",
    maker: "라브",
    category1: "생활/건강",
    category2: "구강위생용품",
    category3: "치아미백제",
  },
  {
    productId: "81000000002",
    link: "https://smartstore.naver.com/main/products/5100000000",
    title: "라이브오랄스 퓨어다이아 셀프 치아미백제 2주분",
    mallName: "라이브오랄스",
    productType: "3",
  },
  {
    productId: "90000000001",
    link: "https://smartstore.naver.com/other-seller/products/9999999999",
    title: "라브 라이브오랄스 퓨어다이아 셀프 치아미백제 세트",
    mallName: "다른 판매자",
    productType: "3",
  },
  {
    productId: "82690369440",
    link: "https://smartstore.naver.com/main/products/5145848584",
    title: "본사직영 라이브오랄스 셀프 치아미백제 화이트닝 마우스피스",
    mallName: "라이브오랄스",
    productType: "3",
    lprice: "29400",
    brand: "라이브오랄스",
    category1: "생활/건강",
    category2: "구강위생용품",
    category3: "치아미백제",
    isAd: true,
  },
  {
    productId: "82690369440",
    link: "https://smartstore.naver.com/main/products/5145848584",
    title: "본사직영 라이브오랄스 셀프 치아미백제 화이트닝 마우스피스",
    mallName: "라이브오랄스",
    productType: "3",
    lprice: "29400",
    brand: "라이브오랄스",
    category1: "생활/건강",
    category2: "구강위생용품",
    category3: "치아미백제",
  },
], exactLavTarget, { limit: 100, topItems: [] });
assert.equal(exactLavMatch.matched, true);
assert.equal(exactLavMatch.rank, 5);
assert.equal(exactLavMatch.excludedAdCount, 1);
assert.equal(exactLavMatch.matchedProductId, "5145848584");

const exactLavSellerItems = sellerItemsFromOrganic(exactLavMatch.organicItems, exactLavMatch.item, exactLavTarget);
assert.equal(exactLavSellerItems.length, 2);
assert.equal(exactLavSellerItems[0].rank, 3);
assert.equal(exactLavSellerItems[0].isExactTarget, false);
assert.equal(exactLavSellerItems[0].sellerProductId, "5100000000");
assert.equal(exactLavSellerItems[1].rank, 5);
assert.equal(exactLavSellerItems[1].isExactTarget, true);
assert.equal(exactLavSellerItems[1].sellerProductId, "5145848584");

const exactLavExposureItems = productExposureItemsFromOrganic(
  exactLavMatch.organicItems,
  exactLavMatch.item,
  exactLavTarget,
  "치아미백제",
);
assert.equal(exactLavExposureItems.length, 2);
assert.equal(exactLavExposureItems[0].rank, 1);
assert.equal(exactLavExposureItems[0].page, undefined);
assert.equal(exactLavExposureItems[0].position, undefined);
assert.equal(exactLavExposureItems[0].productId, "56704991367");
assert.equal(exactLavExposureItems[0].isRelatedCatalog, true);
assert.equal(exactLavExposureItems[0].exposureLabel, "관련 원부");
assert.equal(exactLavExposureItems[1].rank, 5);
assert.equal(exactLavExposureItems[1].page, undefined);
assert.equal(exactLavExposureItems[1].position, undefined);
assert.equal(exactLavExposureItems[1].sellerProductId, "5145848584");
assert.equal(exactLavExposureItems[1].isExactTarget, true);
assert.equal(exactLavExposureItems[1].exposureLabel, "상품 ID 일치");
assert.equal(exactLavExposureItems[1].link, "https://brand.naver.com/lav/products/5145848584");
assert.equal(exactLavExposureItems[1].sourceLink, "https://smartstore.naver.com/main/products/5145848584");
assert.equal(exactLavExposureItems.some((item) => item.sellerProductId === "5100000000"), false);

const guardedLavExposureItems = productExposureItemsFromOrganic([
  {
    rank: 1,
    item: {
      productId: "11111111111",
      link: "https://search.shopping.naver.com/catalog/11111111111",
      title: "라이브오랄스 치아미백제 기획 상품",
      mallName: "네이버",
      productType: "1",
      brand: "라이브오랄스",
      category1: "생활/건강",
      category2: "생활용품",
    },
  },
  {
    rank: 2,
    item: {
      productId: "22222222222",
      link: "https://search.shopping.naver.com/catalog/22222222222",
      title: "다른브랜드 치아미백제 2주분",
      mallName: "네이버",
      productType: "1",
      brand: "다른브랜드",
      category1: "생활/건강",
      category2: "구강위생용품",
    },
  },
  { rank: 3, item: exactLavMatch.item },
], exactLavMatch.item, exactLavTarget, "치아미백제");
assert.equal(guardedLavExposureItems.length, 1);
assert.equal(guardedLavExposureItems[0].isExactTarget, true);
assert.equal(guardedLavExposureItems[0].rank, 3);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({
  total: 2,
  start: 1,
  display: 2,
  items: [
    shoppingItem("1111111111"),
    shoppingItem("9999999999"),
  ],
}), { status: 200, headers: { "content-type": "application/json" } });

try {
  const officialApiResult = await findShoppingRank({
    openapiClientId: "test-client",
    openapiClientSecret: "test-secret",
  }, {
    keyword: "테스트",
    targetProductId: "9999999999",
    maxRank: 100,
  });
  assert.equal(officialApiResult.matched, true);
  assert.equal(officialApiResult.rank, 2);
  assert.equal(officialApiResult.rankBasis, "official_api_result_order");
  assert.equal(officialApiResult.webPageVerified, false);
  assert.equal(officialApiResult.page, null);
  assert.equal(officialApiResult.position, null);
  assert.equal(officialApiResult.pageSize, null);
  assert.equal(officialApiResult.productExposureItems[0].page, undefined);
  assert.equal(officialApiResult.productExposureItems[0].position, undefined);
  assert.equal(officialApiResult.productExposureItems[0].exposureLabel, "상품 ID 일치");
} finally {
  globalThis.fetch = originalFetch;
}

const explicitCatalogTarget = buildRankTarget({
  targetUrl: "https://smartstore.naver.com/any-store/products/1111111111",
  targetCatalogId: "59388521435",
});
assert.equal(explicitCatalogTarget.catalogId, "59388521435");
assert.deepEqual(explicitCatalogTarget.productIds, ["59388521435"]);

console.log("Naver rank matching checks passed.");

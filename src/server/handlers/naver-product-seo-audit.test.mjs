import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewBenchmark,
  fetchProductPage,
  fetchProductDetail,
  normalizeProductUrl,
  parseNaverProductDetailJson,
  parseNaverProductSeoHtml,
  ProductAuditSourceError,
} from "./naver-product-seo-audit.mjs";

function page(product = {}) {
  const state = {
    simpleProductForDetailPage: {
      A: {
        id: 12149720593,
        name: "일신한일의료기 온열찜질기",
        category: { wholeCategoryName: "생활/건강>냉온/찜질용품>찜질기" },
        channel: { channelName: "소노팜스토어", channelUid: "2ykVUL73OmNJTy97mNTUu" },
        productNo: 12094096724,
        salePrice: 86100,
        representativeImageUrl: "https://shop-phinf.pstatic.net/example.jpg",
        reviewAmount: { totalReviewCount: 457 },
        detailContents: { editorType: "SEONE" },
        benefitsView: {
          dispDiscountedSalePrice: 68900,
          dispDiscountedRatio: 19,
          sellerImmediateDiscountAmount: 17200,
          textReviewPoint: 100,
          photoVideoReviewPoint: 1000,
        },
        ...product,
      },
    },
  };
  const serialized = JSON.stringify(state);
  return `<html><script>window.__PRELOADED_STATE__=${serialized.slice(0, -1)},"placeholder":undefined}</script></html>`;
}

test("네이버 공개 상품 상태에서 리뷰 할인 리뷰포인트를 자동 판정한다", () => {
  const result = parseNaverProductSeoHtml(page(), "12149720593");
  assert.equal(result.product.title, "일신한일의료기 온열찜질기");
  assert.equal(result.signals.review.value, 457);
  assert.equal(result.signals.discount.state, "applied");
  assert.equal(result.signals.discount.rate, 19);
  assert.equal(result.signals.reviewPoint.state, "applied");
  assert.equal(result.signals.reviewPoint.maxPoint, 1000);
  assert.equal("detailPage" in result.signals, false);
  assert.equal("productNotice" in result.signals, false);
  assert.equal(result.coverage.verifiedCount, 3);
  assert.equal(result.coverage.total, 5);
  assert.equal(result.product.channelUid, "2ykVUL73OmNJTy97mNTUu");
  assert.equal(result.product.channelProductNo, "12094096724");
});

test("내 상품과 실제 확인된 상위 오가닉 상품 리뷰 표본을 비교한다", () => {
  const target = parseNaverProductSeoHtml(page({
    reviewAmount: { totalReviewCount: 120 },
  }), "12149720593");
  const peers = [300, 500, 700].map((count, index) => parseNaverProductSeoHtml(page({
    id: 22000000000 + index,
    reviewAmount: { totalReviewCount: count },
  }), String(22000000000 + index)));
  const benchmark = buildReviewBenchmark(target, peers);
  assert.equal(benchmark.sampleSize, 3);
  assert.equal(benchmark.targetReviewCount, 120);
  assert.equal(benchmark.median, 500);
  assert.equal(benchmark.average, 500);
  assert.equal(benchmark.label, "매우 부족");
});

test("관련 태그 10개와 상품정보제공고시 상세페이지 참조 여부를 자동 판정한다", () => {
  const signals = parseNaverProductDetailJson({
    seoInfo: {
      sellerTags: [
        "허리찜질기", "전기찜질기", "복부찜질기", "등찜질", "찜질매트",
        "돌찜질기", "다용도찜질기", "황토볼", "온찜질기", "1인용전기매트",
      ],
    },
    productInfoProvidedNoticeView: {
      items: [
        { name: "제조자", value: "한일의료기" },
        { name: "품질보증기준", value: "상세페이지 참조" },
      ],
    },
  });
  assert.equal(signals.sellerTags.count, 10);
  assert.equal(signals.productNotice.verified, true);
  assert.equal(signals.productNotice.hasDetailReference, true);
});

test("상품정보제공고시 이름만 있고 실제 필드가 없으면 통과로 추측하지 않는다", () => {
  const signals = parseNaverProductDetailJson({
    productInfoProvidedNoticeEnabled: true,
  });
  assert.equal("productNotice" in signals, false);
});

test("공개 상품 상세 API는 상품정보제공고시 JSON만 제한적으로 읽는다", async () => {
  const target = normalizeProductUrl("https://smartstore.naver.com/haedenprime/products/12149720593");
  const calls = [];
  const detail = await fetchProductDetail(target, {
    channelUid: "2ykVUL73OmNJTy97mNTUu",
    channelProductNo: "12094096724",
  }, async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      productInfoProvidedNoticeView: { items: [{ name: "제조자", value: "한일의료기" }] },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.match(calls[0].url, /\/i\/v2\/channels\/2ykVUL73OmNJTy97mNTUu\/products\/12094096724$/);
  assert.equal(detail.productInfoProvidedNoticeView.items[0].value, "한일의료기");
});

test("상위 리뷰 표본이 두 개 미만이면 비교 결과를 만들지 않는다", () => {
  const target = parseNaverProductSeoHtml(page(), "12149720593");
  const peer = parseNaverProductSeoHtml(page({
    id: 22000000001,
    reviewAmount: { totalReviewCount: 300 },
  }), "22000000001");
  assert.equal(buildReviewBenchmark(target, [peer]), null);
});

test("할인과 리뷰 포인트가 0이면 미적용으로 자동 판정한다", () => {
  const result = parseNaverProductSeoHtml(page({
    benefitsView: {
      dispDiscountedSalePrice: 86100,
      dispDiscountedRatio: 0,
      sellerImmediateDiscountAmount: 0,
      textReviewPoint: 0,
      photoVideoReviewPoint: 0,
    },
  }), "12149720593");
  assert.equal(result.signals.discount.verified, true);
  assert.equal(result.signals.discount.state, "none");
  assert.equal(result.signals.reviewPoint.verified, true);
  assert.equal(result.signals.reviewPoint.state, "none");
});

test("공개 화면에서 확정하지 못한 신호는 응답에 만들지 않는다", () => {
  const result = parseNaverProductSeoHtml(page({
    reviewAmount: {},
    benefitsView: null,
  }), "12149720593");
  assert.deepEqual(result.signals, {});
  assert.equal(result.coverage.verifiedCount, 0);
  assert.equal(result.coverage.total, 5);
});

test("입력 URL 상품 ID와 공개 상품 ID가 다르면 거부한다", () => {
  assert.throws(
    () => parseNaverProductSeoHtml(page(), "999999"),
    /일치하지 않습니다/,
  );
});

test("실제 네이버 상태처럼 문자열 밖 undefined만 안전하게 허용한다", () => {
  const html = page({ name: "undefined 기획 상품" });
  const result = parseNaverProductSeoHtml(html, "12149720593");
  assert.equal(result.product.title, "undefined 기획 상품");
});

test("허용된 네이버 상품 URL만 모바일 공개 화면 주소로 정규화한다", () => {
  const target = normalizeProductUrl("https://smartstore.naver.com/haedenprime/products/12149720593?x=1");
  assert.equal(target.url, "https://m.smartstore.naver.com/haedenprime/products/12149720593");
  assert.throws(
    () => normalizeProductUrl("https://example.com/haedenprime/products/12149720593"),
    /네이버 스마트스토어/,
  );
});

test("반복 리다이렉트는 두 번 뒤 중단한다", async () => {
  const target = normalizeProductUrl("https://smartstore.naver.com/haedenprime/products/12149720593");
  const redirect = async () => new Response(null, {
    status: 302,
    headers: { location: target.url },
  });
  await assert.rejects(
    () => fetchProductPage(target, redirect),
    /이동이 반복/,
  );
});

test("네이버 429 제한은 서버 오류가 아닌 재시도 가능한 공개 소스 제한으로 분류한다", async () => {
  const target = normalizeProductUrl("https://smartstore.naver.com/haedenprime/products/12149720593");
  await assert.rejects(
    () => fetchProductPage(target, async () => new Response("", { status: 429 })),
    (error) => {
      assert.ok(error instanceof ProductAuditSourceError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "NAVER_PUBLIC_PAGE_RATE_LIMITED");
      assert.match(error.message, /일시적 조회 제한/);
      return true;
    },
  );
});

test("네이버 공개 화면 연결 실패도 안전한 부분 확인 상태로 분류한다", async () => {
  const target = normalizeProductUrl("https://smartstore.naver.com/haedenprime/products/12149720593");
  await assert.rejects(
    () => fetchProductPage(target, async () => {
      throw new TypeError("network unavailable");
    }),
    (error) => {
      assert.ok(error instanceof ProductAuditSourceError);
      assert.equal(error.status, 424);
      assert.equal(error.code, "NAVER_PUBLIC_PAGE_NETWORK_ERROR");
      assert.doesNotMatch(error.message, /network unavailable/);
      return true;
    },
  );
});

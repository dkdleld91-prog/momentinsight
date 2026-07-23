import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchProductPage,
  normalizeProductUrl,
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
        channel: { channelName: "소노팜스토어" },
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
  assert.equal(result.signals.detailPage.state, "registered");
  assert.equal(result.signals.productNotice.verified, false);
  assert.equal(result.coverage.verifiedCount, 4);
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

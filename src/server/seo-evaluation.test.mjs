import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync("public/seo-evaluation.js", "utf8");
const context = vm.createContext({ console });
vm.runInContext(source, context, { filename: "public/seo-evaluation.js" });
const seo = context.MomentSeoEvaluation;

function baseInput(overrides = {}) {
  return {
    keyword: "전동칫솔",
    title: "전동칫솔 회전형 방수 충전식 초극세모 3P",
    category: "생활/건강 > 구강용품 > 전동칫솔",
    peerCategories: [
      "생활/건강 > 구강용품 > 전동칫솔",
      "생활/건강 > 구강용품 > 전동칫솔",
      "생활/건강 > 구강용품 > 전동칫솔",
    ],
    reviewCount: 300,
    peerReviewCounts: [280, 320, 350],
    discountState: "applied",
    reviewPointState: "applied",
    rank: 8,
    rankCheckedCount: 300,
    ...overrides,
  };
}

test("검색 수요와 경쟁 데이터는 상품 SEO 점수에 포함하지 않는다", () => {
  const baseline = seo.evaluate(baseInput());
  const marketData = seo.evaluate(baseInput({
    hasVolume: true,
    volumeText: "999,999회",
    shoppingTotal: 9999999,
    competitionLabel: "매우 높음",
  }));
  assert.equal(marketData.score, baseline.score);
  assert.equal(marketData.confidence, baseline.confidence);
  assert.equal(marketData.checks.some((check) => check.key === "market"), false);
});

test("상품명 키워드 포함과 50자 이내를 각각 확인한다", () => {
  const good = seo.evaluate(baseInput({ title: `전동칫솔 ${"가".repeat(45)}` }));
  const bad = seo.evaluate(baseInput({ title: `전동칫솔 ${"가".repeat(46)}` }));
  assert.equal(good.checks.find((check) => check.key === "titleKeyword").score, 15);
  assert.equal(good.checks.find((check) => check.key === "titleLength").score, 10);
  assert.equal(bad.checks.find((check) => check.key === "titleKeyword").score, 15);
  assert.equal(bad.checks.find((check) => check.key === "titleLength").score, 0);
});

test("네이버 상품명 가이드의 반복 홍보 연락처 특수문자를 자동 점검한다", () => {
  const result = seo.evaluate(baseInput({
    title: "전동칫솔 전동칫솔 특가 무료배송 ★★ 010-1234-5678",
  }));
  ["titleRepetition", "titlePromotion", "titleContact", "titleSpecialChars"].forEach((key) => {
    assert.equal(result.checks.find((check) => check.key === key).score, 0);
  });
  assert.match(result.checks.find((check) => check.key === "titlePromotion").detail, /특가/);
});

test("공식 조회 브랜드 또는 제조사 명칭이 있을 때 상품명 포함 여부를 확인한다", () => {
  const included = seo.evaluate(baseInput({
    title: "오랄원 전동칫솔 회전형 방수 충전식",
    brand: "오랄원",
    maker: "오랄랩",
  }));
  const missing = seo.evaluate(baseInput({
    brand: "오랄원",
    maker: "오랄랩",
  }));
  assert.equal(included.checks.find((check) => check.key === "titleIdentity").score, 10);
  assert.equal(missing.checks.find((check) => check.key === "titleIdentity").score, 0);
});

test("상위 비교 상품과 동일한 카테고리일 때 카테고리 점수를 부여한다", () => {
  const same = seo.evaluate(baseInput());
  const different = seo.evaluate(baseInput({
    category: "생활/건강 > 욕실용품 > 칫솔걸이",
  }));
  assert.equal(same.checks.find((check) => check.key === "category").score, 20);
  assert.equal(same.categoryLabel, "동일 상품군");
  assert.ok(different.checks.find((check) => check.key === "category").score < 20);
});

test("리뷰 수가 늘면 리뷰 점수와 종합 점수가 상승한다", () => {
  const low = seo.evaluate(baseInput({ reviewCount: 5 }));
  const high = seo.evaluate(baseInput({ reviewCount: 1000 }));
  assert.ok(high.checks.find((check) => check.key === "review").score > low.checks.find((check) => check.key === "review").score);
  assert.ok(high.score > low.score);
});

test("내 리뷰와 상위 오가닉 상품 리뷰 중앙값을 비교한다", () => {
  const weak = seo.evaluate(baseInput({
    reviewCount: 30,
    peerReviewCounts: [300, 500, 700],
  }));
  const strong = seo.evaluate(baseInput({
    reviewCount: 600,
    peerReviewCounts: [300, 500, 700],
  }));
  const weakBenchmark = weak.checks.find((check) => check.key === "reviewBenchmark");
  const strongBenchmark = strong.checks.find((check) => check.key === "reviewBenchmark");
  assert.equal(weakBenchmark.score, 0);
  assert.equal(strongBenchmark.score, 15);
  assert.equal(strong.reviewBenchmark.median, 500);
  assert.match(strongBenchmark.detail, /상위 오가닉 3개/);
});

test("자동 확인하지 못한 항목은 점검표와 수정 목록에서 제거한다", () => {
  const partial = seo.evaluate(baseInput({
    reviewCount: null,
    peerReviewCounts: [],
    discountState: "",
    reviewPointState: "",
  }));
  assert.deepEqual(Array.from(partial.checks, (check) => check.key), [
    "titleKeyword",
    "titleLength",
    "titleRepetition",
    "titlePromotion",
    "titleContact",
    "titleSpecialChars",
    "category",
  ]);
  assert.equal(partial.checks.some((check) => !check.verified), false);
  assert.equal(partial.actions.some((action) => ["review", "discount", "reviewPoint"].includes(action.key)), false);
  assert.doesNotMatch(partial.grade.label, /제한|미확인/);
});

test("자동 수집한 할인율과 리뷰 포인트만 각각 평가한다", () => {
  const result = seo.evaluate(baseInput({
    discountState: "none",
    reviewPointState: "none",
  }));
  ["discount", "reviewPoint"].forEach((key) => {
    const check = result.checks.find((item) => item.key === key);
    assert.equal(check.verified, true);
    assert.equal(check.score, 0);
  });
  assert.equal(result.checks.some((check) => ["detailPage", "productNotice"].includes(check.key)), false);
});

test("기본 SEO가 양호하지만 상위 300개 밖이면 트래픽·노출 점검으로 진단한다", () => {
  const result = seo.evaluate(baseInput({ rank: null, rankCheckedCount: 300 }));
  assert.equal(result.diagnosis.key, "traffic");
  assert.equal(result.grade.label, "등록 품질 양호 · 트래픽 부족 가능성");
  assert.equal(result.actions[0].key, "traffic");
});

test("등록 품질과 리뷰 비교가 양호해도 40위 밖이면 트래픽 부족 가능성으로 분리한다", () => {
  const result = seo.evaluate(baseInput({ rank: 41 }));
  assert.equal(result.diagnosis.key, "traffic");
  assert.match(result.diagnosis.detail, /트래픽/);
});

test("자동 확인 가능한 점검 항목과 버전을 고정하고 우선 액션은 최대 세 개만 반환한다", () => {
  const result = seo.evaluate(baseInput());
  assert.deepEqual(Array.from(result.checks, (check) => check.key), [
    "titleKeyword",
    "titleLength",
    "titleRepetition",
    "titlePromotion",
    "titleContact",
    "titleSpecialChars",
    "category",
    "review",
    "reviewBenchmark",
    "discount",
    "reviewPoint",
  ]);
  assert.ok(result.actions.length >= 1 && result.actions.length <= 3);
  assert.equal(result.version, "seo_v7_naver_guide_review_benchmark_20260723");
});

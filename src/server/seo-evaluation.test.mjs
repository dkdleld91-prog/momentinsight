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
    title: "전동칫솔 방수 충전식 초극세모",
    category: "생활/건강 > 구강용품 > 전동칫솔",
    peerCategories: [
      "생활/건강 > 구강용품 > 전동칫솔",
      "생활/건강 > 구강용품 > 전동칫솔",
      "생활/건강 > 구강용품 > 전동칫솔",
      "생활/건강 > 구강용품 > 전동칫솔",
      "생활/건강 > 구강용품 > 전동칫솔",
    ],
    peerTitles: [
      "전동칫솔 방수 충전식 초극세모 A",
      "전동칫솔 방수 충전식 초극세모 B",
      "전동칫솔 방수 충전식 초극세모 C",
      "전동칫솔 방수 충전식 초극세모 D",
      "전동칫솔 방수 충전식 초극세모 E",
    ],
    brand: "모먼트",
    maker: "모먼트랩스",
    productInfoVerified: true,
    image: "https://shopping-phinf.pstatic.net/example.jpg",
    productKind: "single",
    productKindLabel: "단일형",
    reviewCount: 1000,
    rank: 5,
    rankCheckedCount: 300,
    ...overrides,
  };
}

test("안정적인 공식 검색 결과와 수기 리뷰만 점검한다", () => {
  const result = seo.evaluate(baseInput());
  assert.deepEqual(Array.from(result.checks, (check) => check.key), [
    "titleFit",
    "topKeywordFit",
    "categoryFit",
    "brandMaker",
    "imageReady",
    "exposureStructure",
    "reviewManual",
    "traffic",
  ]);
  assert.equal(result.checks.find((check) => check.key === "exposureStructure").max, 0);
  assert.equal(result.checks.find((check) => check.key === "reviewManual").source, "직접 입력");
  assert.equal(result.checks.some((check) => [
    "market",
    "registrationCompleteness",
    "reviewCompetitiveness",
    "productNotice",
    "sellerTags",
    "detailImages",
  ].includes(check.key)), false);
});

test("검색 수요·경쟁과 가격·할인·배송·리뷰 포인트는 상품 SEO 점수에 포함하지 않는다", () => {
  const baseline = seo.evaluate(baseInput());
  const unrelated = seo.evaluate(baseInput({
    hasVolume: true,
    volumeText: "999,999회",
    shoppingTotal: 9999999,
    competitionLabel: "매우 높음",
    price: 1,
    discountState: "none",
    reviewPointState: "none",
    deliveryFee: 999999,
  }));
  assert.equal(unrelated.score, baseline.score);
  assert.equal(unrelated.confidence, baseline.confidence);
});

test("상품명은 기준 키워드·50자 이내·중복 및 홍보 문구를 함께 확인한다", () => {
  const good = seo.evaluate(baseInput({ title: `전동칫솔 ${"가".repeat(45)}` }));
  const tooLong = seo.evaluate(baseInput({ title: `전동칫솔 ${"가".repeat(46)}` }));
  assert.equal(good.checks.find((check) => check.key === "titleFit").score, 20);
  assert.equal(tooLong.checks.find((check) => check.key === "titleFit").score, 15);
  const noisy = seo.evaluate(baseInput({ title: "전동칫솔 전동칫솔 최저가 ★★" }));
  assert.ok(noisy.checks.find((check) => check.key === "titleFit").score < 20);
  assert.match(noisy.checks.find((check) => check.key === "titleFit").detail, /반복 단어|홍보 문구/);
});

test("상위 오가닉 상품명에서 반복되는 핵심어를 최대 5개 비교한다", () => {
  const strong = seo.evaluate(baseInput());
  const weak = seo.evaluate(baseInput({ title: "전동칫솔 휴대용" }));
  const strongCheck = strong.checks.find((check) => check.key === "topKeywordFit");
  const weakCheck = weak.checks.find((check) => check.key === "topKeywordFit");
  assert.equal(strongCheck.max, 10);
  assert.equal(strongCheck.score, 10);
  assert.ok(weakCheck.score < strongCheck.score);
  assert.match(strongCheck.detail, /상위 5개 공통어/);
});

test("상위 오가닉 상품의 세부 카테고리와 공식 브랜드·제조사를 확인한다", () => {
  const result = seo.evaluate(baseInput({
    peerCategories: [
      "생활/건강 > 구강용품 > 전동칫솔",
      "생활/건강 > 구강용품 > 칫솔",
      "생활/건강 > 구강용품 > 칫솔",
      "생활/건강 > 구강용품 > 칫솔",
      "생활/건강 > 구강용품 > 칫솔",
    ],
    maker: "",
  }));
  const category = result.checks.find((check) => check.key === "categoryFit");
  const brandMaker = result.checks.find((check) => check.key === "brandMaker");
  assert.equal(category.max, 15);
  assert.equal(category.score, 3);
  assert.match(category.detail, /상위 5개 중 1개/);
  assert.equal(brandMaker.score, 5);
  assert.match(brandMaker.detail, /제조사 미등록/);
});

test("공식 검색 결과의 대표 이미지와 상품 노출 구조를 표시하되 노출 구조는 참고 항목이다", () => {
  const result = seo.evaluate(baseInput({
    image: "",
    productKind: "catalog",
    productKindLabel: "원부형",
  }));
  const image = result.checks.find((check) => check.key === "imageReady");
  const exposure = result.checks.find((check) => check.key === "exposureStructure");
  assert.equal(image.score, 0);
  assert.equal(image.max, 10);
  assert.equal(exposure.score, 0);
  assert.equal(exposure.max, 0);
  assert.match(exposure.detail, /가격비교 원부 기준/);
});

test("리뷰 수량은 자동 추정하지 않고 직접 입력값만 점수에 반영한다", () => {
  const weak = seo.evaluate(baseInput({ reviewCount: 30 }));
  const strong = seo.evaluate(baseInput({ reviewCount: 1000 }));
  const weakReview = weak.checks.find((check) => check.key === "reviewManual");
  const strongReview = strong.checks.find((check) => check.key === "reviewManual");
  assert.equal(weakReview.score, 10);
  assert.equal(strongReview.score, 20);
  assert.match(weakReview.detail, /직접 입력한 리뷰 30개/);
  assert.equal("reviewBenchmark" in strong, false);
});

test("다른 항목이 모두 충족되고 트래픽만 부족하면 5위 이내 95점이다", () => {
  const result = seo.evaluate(baseInput({ rank: 5 }));
  assert.equal(result.score, 95);
  assert.equal(result.checks.find((check) => check.key === "traffic").score, 10);
  assert.equal(result.verifiedMax, 100);
  assert.equal(result.version, "seo_v10_stable_seven_plus_manual_review_20260726");
});

test("다른 항목이 모두 충족되고 트래픽만 부족하면 40위 이내 90점이다", () => {
  const result = seo.evaluate(baseInput({ rank: 40 }));
  assert.equal(result.score, 90);
  assert.equal(result.checks.find((check) => check.key === "traffic").score, 5);
  assert.equal(result.diagnosis.key, "traffic");
});

test("다른 항목이 모두 충족되고 트래픽만 부족하면 41위 이후 85점이다", () => {
  const result = seo.evaluate(baseInput({ rank: 41 }));
  assert.equal(result.score, 85);
  assert.equal(result.checks.find((check) => check.key === "traffic").score, 0);
  assert.equal(result.actions[0].key, "traffic");
});

test("상위 300개에서 찾지 못해도 등록 항목이 모두 양호하면 85점 기준이다", () => {
  const result = seo.evaluate(baseInput({ rank: null, rankCheckedCount: 300 }));
  assert.equal(result.score, 85);
  assert.equal(result.diagnosis.key, "traffic");
  assert.match(result.checks.find((check) => check.key === "traffic").detail, /85점 기준/);
});

test("확인하지 못한 자동 항목은 임의 점수나 미확인 카드로 만들지 않는다", () => {
  const partial = seo.evaluate(baseInput({
    category: "",
    peerCategories: [],
    peerTitles: [],
    productInfoVerified: false,
    productKind: "",
    productKindLabel: "",
  }));
  assert.deepEqual(Array.from(partial.checks, (check) => check.key), [
    "titleFit",
    "reviewManual",
    "traffic",
  ]);
  assert.equal(partial.checks.some((check) => !check.verified), false);
  assert.ok(partial.confidence < 100);
});

test("온열찜질기 11위는 등록 항목이 모두 충족되면 90점이며 트래픽 보완을 먼저 표시한다", () => {
  const result = seo.evaluate(baseInput({
    keyword: "온열찜질기",
    title: "온열찜질기 방수 충전식 초극세모",
    peerTitles: [
      "온열찜질기 방수 충전식 초극세모 A",
      "온열찜질기 방수 충전식 초극세모 B",
      "온열찜질기 방수 충전식 초극세모 C",
      "온열찜질기 방수 충전식 초극세모 D",
      "온열찜질기 방수 충전식 초극세모 E",
    ],
    rank: 11,
  }));
  assert.equal(result.score, 90);
  assert.equal(result.diagnosis.key, "traffic");
  assert.equal(result.actions[0].key, "traffic");
  assert.match(result.checks.find((check) => check.key === "traffic").detail, /11위/);
});

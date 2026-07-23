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
    productId: "12649811979",
    hasVolume: true,
    volumeText: "29,200회",
    shoppingTotal: 180000,
    competitionLabel: "매우 높음",
    trafficCount: 2000,
    orderCount: 40,
    reviewCount: 100,
    ...overrides,
  };
}

test("리뷰 수가 늘면 리뷰 신뢰 점수와 종합 점수가 상승한다", () => {
  const low = seo.evaluate(baseInput({ reviewCount: 5 }));
  const high = seo.evaluate(baseInput({ reviewCount: 1000 }));
  const lowReview = low.checks.find((check) => check.key === "review");
  const highReview = high.checks.find((check) => check.key === "review");
  assert.ok(highReview.score > lowReview.score);
  assert.ok(high.score > low.score);
});

test("리뷰만 입력해도 리뷰 증가분은 점수에 반영하되 데이터 부족을 명확히 표시한다", () => {
  const low = seo.evaluate({ keyword: "전동칫솔", reviewCount: 5 });
  const high = seo.evaluate({ keyword: "전동칫솔", reviewCount: 1000 });
  assert.ok(high.score > low.score);
  assert.equal(high.confidence, 15);
  assert.equal(high.grade.label, "데이터 추가 필요");
});

test("최근 30일 트래픽이 늘면 트래픽 점수가 상승한다", () => {
  const low = seo.evaluate(baseInput({ trafficCount: 20, orderCount: 0 }));
  const high = seo.evaluate(baseInput({ trafficCount: 5000, orderCount: 0 }));
  assert.ok(high.checks.find((check) => check.key === "traffic").score
    > low.checks.find((check) => check.key === "traffic").score);
});

test("같은 유입에서 구매가 늘면 전환 점수가 상승한다", () => {
  const low = seo.evaluate(baseInput({ trafficCount: 1000, orderCount: 2 }));
  const high = seo.evaluate(baseInput({ trafficCount: 1000, orderCount: 40 }));
  assert.ok(high.checks.find((check) => check.key === "conversion").score
    > low.checks.find((check) => check.key === "conversion").score);
});

test("트래픽·구매·리뷰 미입력은 점수를 발명하지 않고 데이터 신뢰도를 낮춘다", () => {
  const partial = seo.evaluate(baseInput({ trafficCount: null, orderCount: null, reviewCount: null }));
  assert.equal(partial.confidence, 55);
  assert.equal(partial.grade.label, "데이터 추가 필요");
  assert.equal(partial.checks.find((check) => check.key === "traffic").verified, false);
  assert.equal(partial.checks.find((check) => check.key === "review").verified, false);
});

test("구매수가 유입수보다 크면 전환 신호를 확인 필요로 처리한다", () => {
  const invalid = seo.evaluate(baseInput({ trafficCount: 10, orderCount: 11 }));
  const conversion = invalid.checks.find((check) => check.key === "conversion");
  assert.equal(conversion.verified, false);
  assert.equal(invalid.conversionRate, null);
});

test("우선 액션은 최대 세 개만 반환한다", () => {
  const result = seo.evaluate({ keyword: "전동칫솔" });
  assert.equal(result.actions.length, 3);
  assert.equal(result.version, "seo_v2_traffic_review_20260723");
});

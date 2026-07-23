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
  assert.equal(high.confidence, 25);
  assert.equal(high.grade.label, "데이터 추가 필요");
});

test("수동 유입수와 구매수는 SEO 점수에 반영하지 않는다", () => {
  const withoutManualSignals = seo.evaluate(baseInput());
  const withManualSignals = seo.evaluate(baseInput({ trafficCount: 999999, orderCount: 999999 }));
  assert.equal(withManualSignals.score, withoutManualSignals.score);
  assert.equal(withManualSignals.confidence, withoutManualSignals.confidence);
  assert.equal(withManualSignals.checks.some((check) => check.key === "traffic"), false);
  assert.equal(withManualSignals.checks.some((check) => check.key === "conversion"), false);
});

test("리뷰 미입력은 점수를 발명하지 않고 데이터 신뢰도를 낮춘다", () => {
  const partial = seo.evaluate(baseInput({ reviewCount: null }));
  assert.equal(partial.confidence, 75);
  assert.equal(partial.grade.label, "데이터 추가 필요");
  assert.equal(partial.checks.find((check) => check.key === "review").verified, false);
});

test("검증 항목은 상품명·카테고리·검색 시장·리뷰 네 가지로 고정한다", () => {
  const result = seo.evaluate(baseInput());
  assert.deepEqual(Array.from(result.checks, (check) => check.key), ["title", "category", "market", "review"]);
  assert.equal(result.confidence, 100);
});

test("우선 액션은 최대 세 개만 반환한다", () => {
  const result = seo.evaluate({ keyword: "전동칫솔" });
  assert.equal(result.actions.length, 3);
  assert.equal(result.version, "seo_v3_verified_review_20260723");
});

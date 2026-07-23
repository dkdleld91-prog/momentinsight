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
    reviewCount: 350,
    peerReviewCounts: [280, 320, 350],
    sellerTags: {
      verified: true,
      values: ["허리찜질기", "전기찜질기", "복부찜질기", "등찜질", "찜질매트", "돌찜질기", "다용도찜질기", "황토볼", "온찜질기", "1인용전기매트"],
    },
    productNotice: {
      verified: true,
      hasDetailReference: false,
    },
    discountState: "applied",
    reviewPointState: "applied",
    rank: 5,
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

test("내 리뷰와 상위 오가닉 상품 리뷰 평균을 비교한다", () => {
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
  assert.equal(strong.reviewBenchmark.average, 500);
  assert.match(strongBenchmark.detail, /상위 오가닉 3개/);
});

test("자동 확인하지 못한 항목은 점검표와 수정 목록에서 제거한다", () => {
  const partial = seo.evaluate(baseInput({
    reviewCount: null,
    peerReviewCounts: [],
    sellerTags: null,
    productNotice: null,
    discountState: "",
    reviewPointState: "",
  }));
  assert.deepEqual(Array.from(partial.checks, (check) => check.key), [
    "titleKeyword",
    "titleLength",
    "traffic",
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
  assert.equal(result.checks.some((check) => check.key === "detailPage"), false);
});

test("상위 300개 밖이면 트래픽·노출 보완으로 진단한다", () => {
  const result = seo.evaluate(baseInput({ rank: null, rankCheckedCount: 300 }));
  assert.equal(result.diagnosis.key, "traffic");
  assert.equal(result.grade.label, "등록 품질 점검 · 트래픽 보완");
  assert.equal(result.actions[0].key, "traffic");
});

test("등록 품질이 양호해도 5위 밖이면 트래픽 보완으로 분리하고 100점을 금지한다", () => {
  const result = seo.evaluate(baseInput({ rank: 11 }));
  assert.equal(result.diagnosis.key, "traffic");
  assert.match(result.diagnosis.detail, /트래픽/);
  assert.ok(result.score < 100);
  assert.equal(result.actions[0].key, "traffic");
});

test("상위 5위이면서 모든 자동 점검을 충족한 경우에만 100점이 가능하다", () => {
  const result = seo.evaluate(baseInput());
  assert.equal(result.score, 100);
  assert.deepEqual(Array.from(result.checks, (check) => check.key), [
    "titleKeyword",
    "titleLength",
    "reviewBenchmark",
    "productNotice",
    "sellerTags",
    "discount",
    "reviewPoint",
    "traffic",
  ]);
  assert.ok(result.actions.length >= 1 && result.actions.length <= 3);
  assert.equal(result.version, "seo_v8_traffic_review_tags_notice_20260723");
});

test("상위 5위여도 자동 점검 근거가 일부 없으면 100점을 표시하지 않는다", () => {
  const result = seo.evaluate(baseInput({
    reviewCount: null,
    peerReviewCounts: [],
    sellerTags: null,
    productNotice: null,
    discountState: "",
    reviewPointState: "",
  }));
  assert.match(result.checks.find((check) => check.key === "traffic").detail, /5위/);
  assert.ok(result.confidence < 100);
  assert.ok(result.score < 100);
});

test("상품정보제공고시의 상세페이지 참조와 태그 부족을 각각 표시한다", () => {
  const result = seo.evaluate(baseInput({
    productNotice: { verified: true, hasDetailReference: true },
    sellerTags: { verified: true, values: ["허리찜질기", "전기찜질기", "복부찜질기"] },
  }));
  assert.equal(result.checks.find((check) => check.key === "productNotice").score, 0);
  assert.equal(result.checks.find((check) => check.key === "sellerTags").score, 3);
  assert.ok(result.actions.some((action) => action.key === "productNotice" || action.key === "sellerTags"));
});

test("온열찜질기 실상품 11위 회귀값은 100점이 아니며 트래픽 보완을 최우선 표시한다", () => {
  const result = seo.evaluate(baseInput({
    keyword: "온열찜질기",
    title: "일신한일의료기 온열찜질기 허리찜질팩 원적외선 전기 어깨 복부 배 M",
    reviewCount: 457,
    peerReviewCounts: [380, 420, 510, 620, 790],
    rank: 11,
  }));
  assert.ok(result.score < 100);
  assert.equal(result.diagnosis.key, "traffic");
  assert.equal(result.actions[0].key, "traffic");
  assert.match(result.checks.find((check) => check.key === "traffic").detail, /11위/);
});

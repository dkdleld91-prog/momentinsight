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
    detailPageState: "complete",
    noticeState: "direct",
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

test("상품명 키워드 포함과 40자 이내를 각각 확인한다", () => {
  const good = seo.evaluate(baseInput());
  const bad = seo.evaluate(baseInput({
    title: "회전형 방수 충전식 초극세모 칫솔모 세트 프리미엄 대용량 구성 교체형 제품",
  }));
  assert.equal(good.checks.find((check) => check.key === "titleKeyword").score, 15);
  assert.equal(good.checks.find((check) => check.key === "titleLength").score, 10);
  assert.equal(bad.checks.find((check) => check.key === "titleKeyword").score, 0);
  assert.equal(bad.checks.find((check) => check.key === "titleLength").score, 0);
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

test("자동 확인 불가 항목은 점수를 발명하지 않는다", () => {
  const partial = seo.evaluate(baseInput({
    detailPageState: "",
    noticeState: "",
    discountState: "",
    reviewPointState: "",
  }));
  assert.equal(partial.confidence, 65);
  assert.equal(partial.grade.label, "자동 확인 범위 제한");
  assert.equal(partial.autoVerifiedCount, 1);
  assert.equal(partial.checks.find((check) => check.key === "detailPage").verified, false);
});

test("자동 수집한 상세페이지·상품정보고시·할인율·리뷰 포인트를 각각 평가한다", () => {
  const result = seo.evaluate(baseInput({
    detailPageState: "incomplete",
    noticeState: "reference",
    discountState: "none",
    reviewPointState: "none",
  }));
  ["detailPage", "productNotice", "discount", "reviewPoint"].forEach((key) => {
    const check = result.checks.find((item) => item.key === key);
    assert.equal(check.verified, true);
    assert.equal(check.score, 0);
  });
});

test("상세 콘텐츠 등록만 확인되면 완성도를 단정하지 않고 일부 근거만 반영한다", () => {
  const result = seo.evaluate(baseInput({ detailPageState: "registered" }));
  const detail = result.checks.find((check) => check.key === "detailPage");
  assert.equal(detail.verified, true);
  assert.equal(detail.score, 6);
  assert.match(detail.detail, /시각적 잘림과 완성도를 확정할 수 없어/);
});

test("기본 SEO가 양호하지만 상위 300개 밖이면 트래픽·노출 점검으로 진단한다", () => {
  const result = seo.evaluate(baseInput({ rank: null, rankCheckedCount: 300 }));
  assert.equal(result.confidence, 100);
  assert.equal(result.diagnosis.key, "traffic");
  assert.equal(result.grade.label, "SEO 기본 양호 · 트래픽 점검");
  assert.equal(result.actions[0].key, "traffic");
});

test("점검 항목과 버전을 고정하고 우선 액션은 최대 세 개만 반환한다", () => {
  const result = seo.evaluate({ keyword: "전동칫솔" });
  assert.deepEqual(Array.from(result.checks, (check) => check.key), [
    "titleKeyword",
    "titleLength",
    "category",
    "review",
    "detailPage",
    "productNotice",
    "discount",
    "reviewPoint",
  ]);
  assert.equal(result.actions.length, 3);
  assert.equal(result.version, "seo_v5_public_auto_audit_20260723");
});

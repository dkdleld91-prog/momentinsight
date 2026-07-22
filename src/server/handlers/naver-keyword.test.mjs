import assert from "node:assert/strict";
import test from "node:test";

import { keywordMarketIndicators, shoppingAgeProfile } from "./naver-keyword.mjs";

function agePayload(data) {
  return { results: [{ data }] };
}

test("연령 비중은 비교 가능한 최신 완료 월만 사용하고 진행 중인 월은 제외한다", () => {
  const profile = shoppingAgeProfile(agePayload([
    { period: "2026-06-01", group: "10", ratio: 5 },
    { period: "2026-06-01", group: "20", ratio: 20 },
    { period: "2026-06-01", group: "30", ratio: 40 },
    { period: "2026-06-01", group: "40", ratio: 20 },
    { period: "2026-06-01", group: "50", ratio: 10 },
    { period: "2026-06-01", group: "60", ratio: 5 },
    { period: "2026-07-01", group: "10", ratio: 1 },
    { period: "2026-07-01", group: "20", ratio: 1 },
    { period: "2026-07-01", group: "30", ratio: 1 },
    { period: "2026-07-01", group: "40", ratio: 1 },
    { period: "2026-07-01", group: "50", ratio: 100 },
    { period: "2026-07-01", group: "60", ratio: 100 },
  ]), "2026-07-21");

  assert.deepEqual(profile, {
    period: "2026-06-01",
    shares: [5, 20, 40, 20, 15],
  });
});

test("응답에서 빠진 0값 연령대는 오류가 아니라 0%로 처리한다", () => {
  const profile = shoppingAgeProfile(agePayload([
    { period: "2026-06-01", group: "20", ratio: 20 },
    { period: "2026-06-01", group: "30", ratio: 30 },
    { period: "2026-06-01", group: "40", ratio: 40 },
    { period: "2026-06-01", group: "50", ratio: 10 },
  ]), "2026-07-21");

  assert.deepEqual(profile, {
    period: "2026-06-01",
    shares: [0, 20, 30, 40, 10],
  });
  assert.equal(profile.shares.reduce((sum, value) => sum + value, 0), 100);
});

test("조회 종료일이 월말이면 해당 월을 완료 월로 사용할 수 있다", () => {
  const profile = shoppingAgeProfile(agePayload([
    { period: "2026-07-01", group: "10", ratio: 10 },
    { period: "2026-07-01", group: "20", ratio: 20 },
    { period: "2026-07-01", group: "30", ratio: 30 },
    { period: "2026-07-01", group: "40", ratio: 20 },
    { period: "2026-07-01", group: "50", ratio: 10 },
    { period: "2026-07-01", group: "60", ratio: 10 },
  ]), "2026-07-31");

  assert.deepEqual(profile, {
    period: "2026-07-01",
    shares: [10, 20, 30, 20, 20],
  });
});

test("완료된 연령 데이터가 없으면 비율을 만들어내지 않는다", () => {
  const profile = shoppingAgeProfile(agePayload([
    { period: "2026-07-01", group: "40", ratio: 100 },
  ]), "2026-07-21");

  assert.equal(profile, null);
});

test("키워드 시장 지표는 검색수요·경쟁강도·판매 기회를 0부터 100 사이로 계산한다", () => {
  const market = keywordMarketIndicators({
    volume: 18_400,
    competition: "보통",
    shoppingTotal: 96_000,
  });

  assert.deepEqual(market.demand, { score: 85, label: "매우 높음" });
  assert.ok(market.competition.score >= 0 && market.competition.score <= 100);
  assert.ok(market.salesOpportunity.score >= 0 && market.salesOpportunity.score <= 100);
  assert.equal(market.basis, "월 검색량·검색광고 경쟁도·쇼핑 상품수 기반 참고 지표");
  assert.equal(market.disclaimer, "판매 기회율은 실제 매출 전환율이 아닙니다.");
});

test("검색량이 범위값이면 판매 기회율을 임의 생성하지 않는다", () => {
  const market = keywordMarketIndicators({
    volume: 0,
    isUnderThreshold: true,
    competition: "높음",
    shoppingTotal: 320_000,
  });

  assert.deepEqual(market.demand, { score: null, label: "확인 필요" });
  assert.deepEqual(market.salesOpportunity, { score: null, label: "확인 필요" });
  assert.deepEqual(market.competition, { score: 84, label: "매우 높음" });
});

test("같은 수요에서는 경쟁이 낮을수록 판매 기회율이 높다", () => {
  const lowCompetition = keywordMarketIndicators({ volume: 10_000, competition: "낮음" });
  const highCompetition = keywordMarketIndicators({ volume: 10_000, competition: "높음" });

  assert.ok(lowCompetition.salesOpportunity.score > highCompetition.salesOpportunity.score);
});

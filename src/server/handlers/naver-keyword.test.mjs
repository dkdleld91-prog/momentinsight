import assert from "node:assert/strict";
import test from "node:test";

import naverKeywordHandler, { keywordMarketIndicators, shoppingAgeProfile } from "./naver-keyword.mjs";

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
  assert.equal(market.basis, "검색수요×상품규모·수요 대비 상품밀도·검색광고 경쟁도 기반 참고 지표");
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
  assert.ok(market.competition.score >= 90);
  assert.equal(market.competition.label, "매우 높음");
});

test("같은 수요에서는 경쟁이 낮을수록 판매 기회율이 높다", () => {
  const lowCompetition = keywordMarketIndicators({ volume: 10_000, competition: "낮음" });
  const highCompetition = keywordMarketIndicators({ volume: 10_000, competition: "높음" });

  assert.ok(lowCompetition.salesOpportunity.score > highCompetition.salesOpportunity.score);
});

test("대형 수요와 절대 상품수가 함께 큰 포화 키워드는 경쟁강도를 매우 높음으로 분류한다", () => {
  const market = keywordMarketIndicators({
    volume: 71_400,
    competition: "보통",
    shoppingTotal: 340_000,
  });

  assert.deepEqual(market.demand, { score: 97, label: "매우 높음" });
  assert.deepEqual(market.competition, { score: 83, label: "매우 높음" });
  assert.ok(market.salesOpportunity.score < 75);
  assert.equal(market.action, "대표 포화 키워드 · 세부 고효율 키워드 병행 검토");
  assert.equal(market.insight, "월 검색량 71,400회, 쇼핑 상품수 340,000개이며 종합 경쟁강도는 매우 높음으로 확인됩니다.");
});

test("검색량이 충분해도 상품 등록이 적은 키워드는 저경쟁 고기회 후보로 분류한다", () => {
  const efficientMarket = keywordMarketIndicators({
    volume: 71_400,
    competition: "보통",
    shoppingTotal: 20_000,
  });
  const saturatedMarket = keywordMarketIndicators({
    volume: 71_400,
    competition: "보통",
    shoppingTotal: 340_000,
  });

  assert.deepEqual(efficientMarket.competition, { score: 32, label: "낮음" });
  assert.deepEqual(efficientMarket.salesOpportunity, { score: 87, label: "매우 높음" });
  assert.equal(efficientMarket.action, "수요 대비 상품 공급이 적은 SEO 우선 후보");
  assert.ok(saturatedMarket.competition.score > efficientMarket.competition.score);
  assert.ok(saturatedMarket.salesOpportunity.score < efficientMarket.salesOpportunity.score);
});

test("검색수요 대비 상품 밀도가 매우 높으면 소형 시장도 포화 경쟁을 반영한다", () => {
  const market = keywordMarketIndicators({
    volume: 1_000,
    competition: "낮음",
    shoppingTotal: 100_000,
  });

  assert.equal(market.competition.label, "매우 높음");
});

test("검색수요와 상품 등록 규모가 함께 커질 때 경쟁강도가 상승한다", () => {
  const niche = keywordMarketIndicators({ volume: 20_000, competition: "보통", shoppingTotal: 5_000 });
  const representative = keywordMarketIndicators({ volume: 200_000, competition: "보통", shoppingTotal: 300_000 });

  assert.equal(niche.competition.label, "낮음");
  assert.equal(representative.competition.label, "매우 높음");
  assert.ok(representative.competition.score > niche.competition.score);
});

test("키워드 핸들러는 Hub DataLab과 legacy 쇼핑 검색을 혼동하지 않는다", async () => {
  const names = [
    "MI_KEYWORD_API_ENABLED",
    "NAVER_SEARCHAD_API_KEY",
    "NAVER_SEARCHAD_SECRET_KEY",
    "NAVER_SEARCHAD_CUSTOMER_ID",
    "NAVER_OPENAPI_CLIENT_ID",
    "NAVER_OPENAPI_CLIENT_SECRET",
    "NAVER_DATALAB_CLIENT_ID",
    "NAVER_DATALAB_CLIENT_SECRET",
    "NAVER_API_HUB_CLIENT_ID",
    "NAVER_API_HUB_CLIENT_SECRET",
    "NAVER_API_HUB_MODE",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    MI_KEYWORD_API_ENABLED: "true",
    NAVER_SEARCHAD_API_KEY: "search-ad-key",
    NAVER_SEARCHAD_SECRET_KEY: "search-ad-secret",
    NAVER_SEARCHAD_CUSTOMER_ID: "123456",
    NAVER_OPENAPI_CLIENT_ID: "legacy-shopping-id",
    NAVER_OPENAPI_CLIENT_SECRET: "legacy-shopping-secret",
    NAVER_API_HUB_CLIENT_ID: "hub-id",
    NAVER_API_HUB_CLIENT_SECRET: "hub-secret",
    NAVER_API_HUB_MODE: "auto",
  });
  delete process.env.NAVER_DATALAB_CLIENT_ID;
  delete process.env.NAVER_DATALAB_CLIENT_SECRET;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, headers: options.headers || {} });
    if (href.startsWith("https://api.searchad.naver.com/keywordstool")) {
      return new Response(JSON.stringify({
        keywordList: [{
          relKeyword: "허브전환검증",
          monthlyPcQcCnt: 1000,
          monthlyMobileQcCnt: 2000,
          compIdx: "중간",
        }],
      }), { status: 200 });
    }
    if (href.startsWith("https://openapi.naver.com/v1/search/shop.json")) {
      return new Response(JSON.stringify({
        total: 100,
        items: [{ category1: "생활/건강", lprice: "10000", mallName: "테스트몰" }],
      }), { status: 200 });
    }
    if (href === "https://naverapihub.apigw.ntruss.com/search-trend/v1/search") {
      return new Response(JSON.stringify({
        results: [{ data: [{ period: "2026-06-01", ratio: 100 }] }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "unexpected test request" } }), { status: 500 });
  };

  try {
    const response = await naverKeywordHandler.fetch(new Request(
      "http://127.0.0.1/api/naver-keyword?keyword=%ED%97%88%EB%B8%8C%EC%A0%84%ED%99%98%EA%B2%80%EC%A6%9D&profile=trend",
    ));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.source.migratedApiProvider, "hub");
    const hubCall = calls.find((call) => call.href.includes("/search-trend/v1/search"));
    const shoppingCall = calls.find((call) => call.href.includes("/v1/search/shop.json"));
    assert.equal(hubCall.headers["X-NCP-APIGW-API-KEY-ID"], "hub-id");
    assert.equal(hubCall.headers["X-NCP-APIGW-API-KEY"], "hub-secret");
    assert.equal(shoppingCall.headers["X-Naver-Client-Id"], "legacy-shopping-id");
    assert.equal(shoppingCall.headers["X-Naver-Client-Secret"], "legacy-shopping-secret");
  } finally {
    globalThis.fetch = originalFetch;
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

test("Hub DataLab의 일시적인 503은 한 번만 재시도하고 정상 데이터를 반환한다", async () => {
  const names = [
    "MI_KEYWORD_API_ENABLED",
    "NAVER_SEARCHAD_API_KEY",
    "NAVER_SEARCHAD_SECRET_KEY",
    "NAVER_SEARCHAD_CUSTOMER_ID",
    "NAVER_OPENAPI_CLIENT_ID",
    "NAVER_OPENAPI_CLIENT_SECRET",
    "NAVER_DATALAB_CLIENT_ID",
    "NAVER_DATALAB_CLIENT_SECRET",
    "NAVER_API_HUB_CLIENT_ID",
    "NAVER_API_HUB_CLIENT_SECRET",
    "NAVER_API_HUB_MODE",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    MI_KEYWORD_API_ENABLED: "true",
    NAVER_SEARCHAD_API_KEY: "search-ad-key",
    NAVER_SEARCHAD_SECRET_KEY: "search-ad-secret",
    NAVER_SEARCHAD_CUSTOMER_ID: "123456",
    NAVER_OPENAPI_CLIENT_ID: "legacy-shopping-id",
    NAVER_OPENAPI_CLIENT_SECRET: "legacy-shopping-secret",
    NAVER_API_HUB_CLIENT_ID: "hub-id",
    NAVER_API_HUB_CLIENT_SECRET: "hub-secret",
    NAVER_API_HUB_MODE: "hub",
  });
  delete process.env.NAVER_DATALAB_CLIENT_ID;
  delete process.env.NAVER_DATALAB_CLIENT_SECRET;
  let hubCalls = 0;

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("https://api.searchad.naver.com/keywordstool")) {
      return new Response(JSON.stringify({
        keywordList: [{
          relKeyword: "허브일시복구검증",
          monthlyPcQcCnt: 1200,
          monthlyMobileQcCnt: 2400,
          compIdx: "중간",
        }],
      }), { status: 200 });
    }
    if (href.startsWith("https://openapi.naver.com/v1/search/shop.json")) {
      return new Response(JSON.stringify({
        total: 120,
        items: [{ category1: "생활/건강", lprice: "12000", mallName: "테스트몰" }],
      }), { status: 200 });
    }
    if (href === "https://naverapihub.apigw.ntruss.com/search-trend/v1/search") {
      hubCalls += 1;
      if (hubCalls === 1) {
        return new Response(JSON.stringify({ error: { message: "temporary gateway failure" } }), {
          status: 503,
        });
      }
      return new Response(JSON.stringify({
        results: [{ data: [{ period: "2026-06-01", ratio: 100 }] }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "unexpected test request" } }), { status: 500 });
  };

  try {
    const response = await naverKeywordHandler.fetch(new Request(
      "http://127.0.0.1/api/naver-keyword?keyword=%ED%97%88%EB%B8%8C%EC%9D%BC%EC%8B%9C%EB%B3%B5%EA%B5%AC%EA%B2%80%EC%A6%9D&profile=trend",
    ));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.source.migratedApiProvider, "hub");
    assert.equal(body.sourceStatus.trend.status, "ok");
    assert.equal(hubCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

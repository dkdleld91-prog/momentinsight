import assert from "node:assert/strict";
import test from "node:test";

import naverKeywordHandler, {
  buildShoppingProfile,
  buildSourceStatus,
  keywordMarketIndicators,
  shoppingAgeProfile,
} from "./naver-keyword.mjs";

function shoppingWindow(keyword, count = 100, marketTotal = count) {
  return {
    ok: true,
    schemaVersion: "mi.naver-shopping-organic-window.v1",
    source: "naver_shopping_results_collector",
    rankEvidence: "naver_shopping_organic_list",
    keyword,
    collectionId: `keyword-${keyword}`,
    collectedAt: "2026-08-01T00:00:00.000Z",
    complete: true,
    partial: false,
    sourceExhausted: count < 100,
    marketTotal,
    marketTotalStatus: marketTotal == null ? "unavailable" : "verified",
    checkedCount: count,
    rawCount: count,
    excludedAdCount: 0,
    items: Array.from({ length: count }, (_, index) => ({
      organicRank: index + 1,
      isAd: false,
      isOrganic: true,
      productId: String(70000000000 + index),
      title: `테스트 상품 ${index}`,
      link: `https://smartstore.naver.com/test/products/${80000000000 + index}`,
      category1: "생활/건강",
      category1Id: "50000008",
      lprice: String(10000 + index),
      mallName: `테스트몰${index}`,
    })),
  };
}

function agePayload(data) {
  return { results: [{ data }] };
}

function latestCompletedMonthForTest(offsetMonths = 0) {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(end).reduce((acc, item) => {
    if (item.type !== "literal") acc[item.type] = Number(item.value);
    return acc;
  }, {});
  const lastDay = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  const latest = new Date(Date.UTC(parts.year, parts.month - 1, 1));
  if (parts.day < lastDay) latest.setUTCMonth(latest.getUTCMonth() - 1);
  latest.setUTCMonth(latest.getUTCMonth() - offsetMonths);
  return latest;
}

function completeAgePayload(monthCount = 6, latestOffsetMonths = 0) {
  const ratios = [5, 10, 20, 25, 20, 20];
  const latest = latestCompletedMonthForTest(latestOffsetMonths);
  return agePayload(Array.from({ length: monthCount }, (_, monthIndex) => (
    SHOPPING_AGE_GROUPS_FOR_TEST.map((group, groupIndex) => ({
      period: new Date(Date.UTC(
        latest.getUTCFullYear(),
        latest.getUTCMonth() - (monthCount - monthIndex - 1),
        1,
      )).toISOString().slice(0, 10),
      group,
      ratio: ratios[groupIndex],
    }))
  )).flat());
}

const SHOPPING_AGE_GROUPS_FOR_TEST = ["10", "20", "30", "40", "50", "60"];
const SHOPPING_MAIN_CATEGORY_IDS_FOR_TEST = Array.from({ length: 10 }, (_, index) => `5000000${index}`);

async function runOfficialCategoryProbeScenario({
  keyword,
  completeCategoryIds = [],
  staleCategoryIds = [],
  failingCategoryId = "",
  shoppingCollectorFailure = false,
}) {
  const names = [
    "MI_KEYWORD_API_ENABLED",
    "NAVER_SEARCHAD_API_KEY",
    "NAVER_SEARCHAD_SECRET_KEY",
    "NAVER_SEARCHAD_CUSTOMER_ID",
    "NAVER_API_HUB_CLIENT_ID",
    "NAVER_API_HUB_CLIENT_SECRET",
    "NAVER_API_HUB_MODE",
    "NAVER_SHOPPING_RANK_API_URL",
    "NAVER_SHOPPING_RANK_API_KEY",
    "NAVER_SHOPPING_RANK_MODE",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    MI_KEYWORD_API_ENABLED: "true",
    NAVER_SEARCHAD_API_KEY: "search-ad-key",
    NAVER_SEARCHAD_SECRET_KEY: "search-ad-secret",
    NAVER_SEARCHAD_CUSTOMER_ID: "123456",
    NAVER_API_HUB_CLIENT_ID: "hub-id",
    NAVER_API_HUB_CLIENT_SECRET: "hub-secret",
    NAVER_API_HUB_MODE: "hub",
  });
  if (shoppingCollectorFailure) {
    process.env.NAVER_SHOPPING_RANK_API_URL = "https://collector.example/unavailable";
    process.env.NAVER_SHOPPING_RANK_API_KEY = "collector-key";
    process.env.NAVER_SHOPPING_RANK_MODE = "provider";
  } else {
    delete process.env.NAVER_SHOPPING_RANK_API_URL;
    delete process.env.NAVER_SHOPPING_RANK_API_KEY;
    delete process.env.NAVER_SHOPPING_RANK_MODE;
  }
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("https://api.searchad.naver.com/keywordstool")) {
      return new Response(JSON.stringify({
        keywordList: [{ relKeyword: keyword, monthlyPcQcCnt: 1000, monthlyMobileQcCnt: 2000, compIdx: "중간" }],
      }), { status: 200 });
    }
    if (href === "https://naverapihub.apigw.ntruss.com/search-trend/v1/search") {
      return new Response(JSON.stringify({
        results: [{ data: [{ period: "2026-06-01", ratio: 100 }] }],
      }), { status: 200 });
    }
    if (href === "https://collector.example/unavailable") {
      return new Response(JSON.stringify({ error: { message: "collector unavailable" } }), { status: 503 });
    }
    if (href.includes("/shopping/v1/category/keyword/")) {
      const endpoint = href.split("/").at(-1);
      const request = JSON.parse(options.body);
      calls.push({ endpoint, category: request.category });
      if (endpoint === "age") {
        if (request.category === failingCategoryId) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
        }
        const payload = completeCategoryIds.includes(request.category)
          ? completeAgePayload()
          : staleCategoryIds.includes(request.category)
            ? completeAgePayload(6, 1)
            : agePayload([]);
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (endpoint === "device") {
        return new Response(JSON.stringify(agePayload([
          { period: "2026-06-01", group: "mo", ratio: 80 },
          { period: "2026-06-01", group: "pc", ratio: 20 },
        ])), { status: 200 });
      }
      if (endpoint === "gender") {
        return new Response(JSON.stringify(agePayload([
          { period: "2026-06-01", group: "f", ratio: 30 },
          { period: "2026-06-01", group: "m", ratio: 70 },
        ])), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ error: { message: "unexpected test request" } }), { status: 500 });
  };

  try {
    const response = await naverKeywordHandler.fetch(new Request(
      `http://127.0.0.1/api/naver-keyword?${new URLSearchParams({ keyword }).toString()}`,
    ));
    return { response, body: await response.json(), calls };
  } finally {
    globalThis.fetch = originalFetch;
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
}

test("쇼핑 표본의 허용된 대분류 ID를 이름 매핑보다 우선하고 비허용 ID는 이름으로 복구한다", () => {
  const directIdWindow = shoppingWindow("대분류ID우선", 2, 2);
  directIdWindow.items.forEach((item) => {
    item.category1 = "생활/건강";
    item.category1Id = "50000000";
  });
  const fallbackWindow = shoppingWindow("대분류이름복구", 2, 2);
  fallbackWindow.items.forEach((item) => {
    item.category1Id = "99999999";
  });

  assert.equal(buildShoppingProfile(directIdWindow).categoryId, "50000000");
  assert.equal(buildShoppingProfile(fallbackWindow).categoryId, "50000008");
});

test("쇼핑 전체 상품수가 없어도 오가닉 표본을 유지하고 상품수만 부분 상태로 표시한다", () => {
  const profile = buildShoppingProfile(shoppingWindow("상품수없는키워드", 100, null));
  const status = buildSourceStatus({
    env: {
      naverApi: {},
      shoppingResults: { mode: "provider", providerUrl: "https://collector.example/rank", providerKey: "collector-key" },
    },
    searchAd: { hasExactMatch: true },
    datalabProfile: null,
    datalabError: null,
    shoppingProfile: profile,
    shoppingError: null,
    includeProfile: false,
  });

  assert.equal(profile.total, null);
  assert.equal(profile.totalStatus, "unavailable");
  assert.equal(profile.sampleCount, 100);
  assert.equal(status.shopping.status, "partial");
  assert.match(status.shopping.label, /상품수 확인 불가/);
});

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

test("쇼핑 표본 카테고리가 없으면 공식 연령 API 10개를 검증해 단일 강한 후보만 사용한다", async () => {
  const { response, body, calls } = await runOfficialCategoryProbeScenario({
    keyword: "공식카테고리단일검증",
    completeCategoryIds: ["50000000"],
  });
  const ageCalls = calls.filter((call) => call.endpoint === "age");

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(ageCalls.map((call) => call.category).sort(), SHOPPING_MAIN_CATEGORY_IDS_FOR_TEST);
  assert.equal(ageCalls.length, 10);
  assert.equal(calls.filter((call) => call.endpoint === "device").length, 1);
  assert.equal(calls.filter((call) => call.endpoint === "gender").length, 1);
  assert.equal(calls.length, 12);
  assert.equal(body.chartData.shoppingCategoryId, "50000000");
  assert.deepEqual(body.chartData.age, [5, 10, 20, 25, 40]);
  assert.equal(body.chartData.profileStatus.age, "ok");
});

test("최신 완료월이 빠진 과거 6개월 후보는 공식 카테고리로 선택하지 않는다", async () => {
  const { response, body, calls } = await runOfficialCategoryProbeScenario({
    keyword: "공식카테고리과거검증",
    staleCategoryIds: ["50000000"],
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(calls.filter((call) => call.endpoint === "age").length, 10);
  assert.equal(calls.some((call) => call.endpoint === "device" || call.endpoint === "gender"), false);
  assert.equal(body.chartData.shoppingCategoryId, "");
  assert.deepEqual(body.chartData.age, []);
  assert.equal(body.chartData.profileStatus.age, "category_required");
});

test("공식 카테고리 후보가 두 개면 선택하지 않고 category_required로 종료한다", async () => {
  const { response, body, calls } = await runOfficialCategoryProbeScenario({
    keyword: "공식카테고리중복검증",
    completeCategoryIds: ["50000000", "50000008"],
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(calls.filter((call) => call.endpoint === "age").length, 10);
  assert.equal(calls.some((call) => call.endpoint === "device" || call.endpoint === "gender"), false);
  assert.equal(body.chartData.shoppingCategoryId, "");
  assert.deepEqual(body.chartData.age, []);
  assert.equal(body.chartData.profileStatus.age, "category_required");
});

test("공식 카테고리 탐색 중 429가 발생하면 남은 분류를 호출하지 않고 안전 종료한다", async () => {
  const keyword = `공식카테고리제한검증-${Date.now()}`;
  const { response, body, calls } = await runOfficialCategoryProbeScenario({
    keyword,
    failingCategoryId: "50000001",
  });
  const second = await runOfficialCategoryProbeScenario({ keyword });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(calls.filter((call) => call.endpoint === "age").length, 2);
  assert.equal(calls.some((call) => call.endpoint === "device" || call.endpoint === "gender"), false);
  assert.equal(body.chartData.shoppingCategoryId, "");
  assert.deepEqual(body.chartData.age, []);
  assert.equal(body.chartData.profileStatus.age, "category_required");
  assert.equal(second.calls.filter((call) => call.endpoint === "age").length, 0);
  assert.equal(second.body.chartData.profileStatus.age, "category_required");
});

test("공식 카테고리 성공 결과는 별도 TTL cache로 재사용해 쇼핑 표본 실패 중에도 반복 탐색하지 않는다", async () => {
  const keyword = `공식카테고리캐시검증-${Date.now()}`;
  const first = await runOfficialCategoryProbeScenario({
    keyword,
    completeCategoryIds: ["50000000"],
    shoppingCollectorFailure: true,
  });
  const second = await runOfficialCategoryProbeScenario({ keyword, shoppingCollectorFailure: true });

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(first.calls.filter((call) => call.endpoint === "age").length, 10);
  assert.equal(second.calls.filter((call) => call.endpoint === "age").length, 0);
  assert.equal(second.calls.filter((call) => call.endpoint === "device").length, 1);
  assert.equal(second.calls.filter((call) => call.endpoint === "gender").length, 1);
  assert.equal(second.body.chartData.shoppingCategoryId, "50000000");
  assert.deepEqual(second.body.chartData.age, [5, 10, 20, 25, 40]);
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

test("키워드 핸들러는 Hub DataLab과 검증 쇼핑 수집기를 함께 사용하고 종료된 쇼핑 API를 호출하지 않는다", async () => {
  const names = [
    "MI_KEYWORD_API_ENABLED",
    "NAVER_SEARCHAD_API_KEY",
    "NAVER_SEARCHAD_SECRET_KEY",
    "NAVER_SEARCHAD_CUSTOMER_ID",
    "NAVER_SHOPPING_RANK_API_URL",
    "NAVER_SHOPPING_RANK_API_KEY",
    "NAVER_SHOPPING_RANK_MODE",
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
    NAVER_SHOPPING_RANK_API_URL: "https://collector.example/naver-shopping",
    NAVER_SHOPPING_RANK_API_KEY: "collector-key",
    NAVER_SHOPPING_RANK_MODE: "provider",
    NAVER_API_HUB_CLIENT_ID: "hub-id",
    NAVER_API_HUB_CLIENT_SECRET: "hub-secret",
    NAVER_API_HUB_MODE: "auto",
  });
  delete process.env.NAVER_DATALAB_CLIENT_ID;
  delete process.env.NAVER_DATALAB_CLIENT_SECRET;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || "GET", headers: options.headers || {}, body: options.body || "" });
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
    if (href === "https://collector.example/naver-shopping") {
      return new Response(JSON.stringify(shoppingWindow("허브전환검증", 100, 100)), { status: 200 });
    }
    if (href === "https://naverapihub.apigw.ntruss.com/search-trend/v1/search") {
      return new Response(JSON.stringify({
        results: [{ data: Array.from({ length: 36 }, (_, index) => {
          const date = new Date(Date.UTC(2023, 6 + index, 1));
          return {
            period: date.toISOString().slice(0, 10),
            ratio: 65 + (index % 12) * 3,
          };
        }) }],
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
    const shoppingCall = calls.find((call) => call.href === "https://collector.example/naver-shopping");
    const legacyShoppingCalls = calls.filter((call) => call.href.includes("/v1/search/shop.json"));
    const hubRequest = JSON.parse(hubCall.body);
    const shoppingRequest = JSON.parse(shoppingCall.body);
    const startParts = hubRequest.startDate.split("-").map(Number);
    const endParts = hubRequest.endDate.split("-").map(Number);
    const requestedMonths = ((endParts[0] - startParts[0]) * 12) + endParts[1] - startParts[1];
    assert.equal(hubCall.headers["X-NCP-APIGW-API-KEY-ID"], "hub-id");
    assert.equal(hubCall.headers["X-NCP-APIGW-API-KEY"], "hub-secret");
    // The interval is inclusive: a 35-month index difference contains 36 monthly buckets.
    assert.ok(requestedMonths >= 35 && requestedMonths <= 37);
    assert.equal(body.chartData.series.length, 36);
    assert.equal(body.chartData.seriesPeriods.length, 36);
    assert.equal(shoppingCall.method, "POST");
    assert.equal(shoppingCall.headers.authorization, "Bearer collector-key");
    assert.equal(shoppingCall.headers["content-type"], "application/json");
    assert.equal(shoppingRequest.keyword, "허브전환검증");
    assert.equal(shoppingRequest.schemaVersion, "mi.naver-shopping-organic-window.v1");
    assert.equal(shoppingRequest.limit, 100);
    assert.equal(shoppingRequest.sort, "relevance");
    assert.equal(shoppingRequest.rankPolicy, "organic_only");
    assert.equal(body.source.shopping, "naver_shopping_results_collector");
    assert.equal(body.sourceStatus.shopping.status, "ok");
    assert.equal(body.chartData.shopping.total, 100);
    assert.equal(legacyShoppingCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

test("쇼핑 표본의 대분류 ID로 연령 API를 호출하고 기존 연령 그래프 데이터를 채운다", async () => {
  const names = [
    "MI_KEYWORD_API_ENABLED",
    "NAVER_SEARCHAD_API_KEY",
    "NAVER_SEARCHAD_SECRET_KEY",
    "NAVER_SEARCHAD_CUSTOMER_ID",
    "NAVER_SHOPPING_RANK_API_URL",
    "NAVER_SHOPPING_RANK_API_KEY",
    "NAVER_SHOPPING_RANK_MODE",
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
    NAVER_SHOPPING_RANK_API_URL: "https://collector.example/naver-shopping-age",
    NAVER_SHOPPING_RANK_API_KEY: "collector-key",
    NAVER_SHOPPING_RANK_MODE: "provider",
    NAVER_API_HUB_CLIENT_ID: "hub-id",
    NAVER_API_HUB_CLIENT_SECRET: "hub-secret",
    NAVER_API_HUB_MODE: "hub",
  });
  delete process.env.NAVER_DATALAB_CLIENT_ID;
  delete process.env.NAVER_DATALAB_CLIENT_SECRET;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, body: options.body || "" });
    if (href.startsWith("https://api.searchad.naver.com/keywordstool")) {
      return new Response(JSON.stringify({
        keywordList: [{
          relKeyword: "연령그래프검증",
          monthlyPcQcCnt: 1000,
          monthlyMobileQcCnt: 2000,
          compIdx: "중간",
        }],
      }), { status: 200 });
    }
    if (href === "https://collector.example/naver-shopping-age") {
      const window = shoppingWindow("연령그래프검증", 100, 100);
      window.items.forEach((item) => {
        item.category1 = "";
        item.category1Id = "50000000";
      });
      return new Response(JSON.stringify(window), { status: 200 });
    }
    if (href === "https://naverapihub.apigw.ntruss.com/search-trend/v1/search") {
      return new Response(JSON.stringify({
        results: [{ data: [
          { period: "2026-05-01", ratio: 80 },
          { period: "2026-06-01", ratio: 100 },
        ] }],
      }), { status: 200 });
    }
    if (href.endsWith("/shopping/v1/category/keyword/device")) {
      return new Response(JSON.stringify({ results: [{ data: [
        { period: "2026-06-01", group: "mo", ratio: 80 },
        { period: "2026-06-01", group: "pc", ratio: 20 },
      ] }] }), { status: 200 });
    }
    if (href.endsWith("/shopping/v1/category/keyword/gender")) {
      return new Response(JSON.stringify({ results: [{ data: [
        { period: "2026-06-01", group: "f", ratio: 30 },
        { period: "2026-06-01", group: "m", ratio: 70 },
      ] }] }), { status: 200 });
    }
    if (href.endsWith("/shopping/v1/category/keyword/age")) {
      return new Response(JSON.stringify({ results: [{ data: [
        { period: "2026-06-01", group: "10", ratio: 5 },
        { period: "2026-06-01", group: "20", ratio: 10 },
        { period: "2026-06-01", group: "30", ratio: 20 },
        { period: "2026-06-01", group: "40", ratio: 25 },
        { period: "2026-06-01", group: "50", ratio: 20 },
        { period: "2026-06-01", group: "60", ratio: 20 },
      ] }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "unexpected test request" } }), { status: 500 });
  };

  try {
    const response = await naverKeywordHandler.fetch(new Request(
      "http://127.0.0.1/api/naver-keyword?keyword=%EC%97%B0%EB%A0%B9%EA%B7%B8%EB%9E%98%ED%94%84%EA%B2%80%EC%A6%9D",
    ));
    const body = await response.json();
    const ageCall = calls.find((call) => call.href.endsWith("/shopping/v1/category/keyword/age"));
    const ageRequest = JSON.parse(ageCall.body);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(calls.filter((call) => call.href.endsWith("/shopping/v1/category/keyword/age")).length, 1);
    assert.equal(ageRequest.category, "50000000");
    assert.equal(ageRequest.keyword, "연령그래프검증");
    assert.equal(body.chartData.shoppingCategoryId, "50000000");
    assert.deepEqual(body.chartData.age, [5, 10, 20, 25, 40]);
    assert.equal(body.chartData.ageBasis, "latest_complete_month_shopping_keyword_share");
    assert.equal(body.chartData.agePeriod, "2026-06-01");
    assert.equal(body.chartData.profileStatus.age, "ok");
    assert.equal(body.chartData.demographicStatus, "shopping_keyword_profile");
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
    "NAVER_SHOPPING_RANK_API_URL",
    "NAVER_SHOPPING_RANK_API_KEY",
    "NAVER_SHOPPING_RANK_MODE",
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
    NAVER_SHOPPING_RANK_API_URL: "https://collector.example/naver-shopping-retry",
    NAVER_SHOPPING_RANK_API_KEY: "collector-key",
    NAVER_SHOPPING_RANK_MODE: "provider",
    NAVER_API_HUB_CLIENT_ID: "hub-id",
    NAVER_API_HUB_CLIENT_SECRET: "hub-secret",
    NAVER_API_HUB_MODE: "hub",
  });
  delete process.env.NAVER_DATALAB_CLIENT_ID;
  delete process.env.NAVER_DATALAB_CLIENT_SECRET;
  let hubCalls = 0;
  let collectorCalls = 0;
  let legacyShoppingCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
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
    if (href.includes("/v1/search/shop.json")) {
      legacyShoppingCalls += 1;
      return new Response(JSON.stringify({ error: { message: "legacy shopping endpoint must not be called" } }), { status: 500 });
    }
    if (href === "https://collector.example/naver-shopping-retry") {
      collectorCalls += 1;
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, "Bearer collector-key");
      assert.equal(options.headers["content-type"], "application/json");
      const shoppingRequest = JSON.parse(options.body);
      assert.equal(shoppingRequest.schemaVersion, "mi.naver-shopping-organic-window.v1");
      assert.equal(shoppingRequest.keyword, "허브일시복구검증");
      assert.equal(shoppingRequest.limit, 100);
      assert.equal(shoppingRequest.sort, "relevance");
      assert.equal(shoppingRequest.rankPolicy, "organic_only");
      assert.ok(Date.parse(shoppingRequest.deadlineAt));
      return new Response(JSON.stringify(shoppingWindow("허브일시복구검증", 100, 120)), { status: 200 });
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
    assert.equal(collectorCalls, 1);
    assert.equal(legacyShoppingCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

test("쇼핑 수집원이 없으면 종료 API로 우회하지 않고 지원 API 결과만 안전하게 반환한다", async () => {
  const names = [
    "MI_KEYWORD_API_ENABLED",
    "NAVER_SEARCHAD_API_KEY",
    "NAVER_SEARCHAD_SECRET_KEY",
    "NAVER_SEARCHAD_CUSTOMER_ID",
    "NAVER_API_HUB_CLIENT_ID",
    "NAVER_API_HUB_CLIENT_SECRET",
    "NAVER_API_HUB_MODE",
    "NAVER_SHOPPING_RANK_API_URL",
    "NAVER_SHOPPING_RANK_API_KEY",
    "NAVER_SHOPPING_RANK_MODE",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    MI_KEYWORD_API_ENABLED: "true",
    NAVER_SEARCHAD_API_KEY: "search-ad-key",
    NAVER_SEARCHAD_SECRET_KEY: "search-ad-secret",
    NAVER_SEARCHAD_CUSTOMER_ID: "123456",
    NAVER_API_HUB_CLIENT_ID: "hub-id",
    NAVER_API_HUB_CLIENT_SECRET: "hub-secret",
    NAVER_API_HUB_MODE: "hub",
  });
  delete process.env.NAVER_SHOPPING_RANK_API_URL;
  delete process.env.NAVER_SHOPPING_RANK_API_KEY;
  delete process.env.NAVER_SHOPPING_RANK_MODE;
  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith("https://api.searchad.naver.com/keywordstool")) {
      return new Response(JSON.stringify({
        keywordList: [{
          relKeyword: "수집원미연결검증",
          monthlyPcQcCnt: 800,
          monthlyMobileQcCnt: 1600,
          compIdx: "중간",
        }],
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
      "http://127.0.0.1/api/naver-keyword?keyword=%EC%88%98%EC%A7%91%EC%9B%90%EB%AF%B8%EC%97%B0%EA%B2%B0%EA%B2%80%EC%A6%9D&profile=trend",
    ));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.source.migratedApiProvider, "hub");
    assert.equal(body.sourceStatus.shopping.status, "not_configured");
    assert.equal(body.chartData.shopping, null);
    assert.ok(calls.every((href) => !href.includes("/v1/search/shop.json")));
    assert.ok(calls.every((href) => !href.includes("collector.example")));
  } finally {
    globalThis.fetch = originalFetch;
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

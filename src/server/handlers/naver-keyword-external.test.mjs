// 네이버 답변(2026-11-13): 데이터랩(검색어 트렌드·쇼핑인사이트)은 직원 내부용만. 광고주·체험 세션은 데이터랩을
// 부르지도 받지도 않는다 — 직원 조회로 채운 저장본이 있어도, 직접 요청(compare 포함)이어도.
import assert from "node:assert/strict";
import test from "node:test";

import naverKeywordHandler, { keywordCacheKeyFor, stripDatalabForExternal } from "./naver-keyword.mjs";

const ENV_NAMES = [
  "MI_KEYWORD_API_ENABLED", "NAVER_SEARCHAD_API_KEY", "NAVER_SEARCHAD_SECRET_KEY", "NAVER_SEARCHAD_CUSTOMER_ID",
  "NAVER_API_HUB_CLIENT_ID", "NAVER_API_HUB_CLIENT_SECRET", "NAVER_API_HUB_MODE",
  "NAVER_SHOPPING_RANK_API_URL", "NAVER_SHOPPING_RANK_API_KEY", "NAVER_SHOPPING_RANK_MODE",
];

const DATALAB_FIELDS = ["series", "seriesLabels", "seriesPeriods", "trendIndex", "month", "monthLabels", "age", "week"];

async function withKeywordServer(run) {
  const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
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
  for (const name of ["NAVER_SHOPPING_RANK_API_URL", "NAVER_SHOPPING_RANK_API_KEY", "NAVER_SHOPPING_RANK_MODE"]) delete process.env[name];
  const counts = { datalab: 0, searchad: 0 };
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("https://api.searchad.naver.com/keywordstool")) {
      counts.searchad += 1;
      const keyword = new URL(href).searchParams.get("hintKeywords") || "키워드";
      return new Response(JSON.stringify({ keywordList: [{ relKeyword: keyword, monthlyPcQcCnt: 1000, monthlyMobileQcCnt: 3000, compIdx: "중간" }] }), { status: 200 });
    }
    if (href.includes("/search-trend/") || href.includes("/shopping/v1/category/keyword/")) {
      counts.datalab += 1;
      const body = options.body ? JSON.parse(options.body) : {};
      const points = Array.from({ length: 36 }, (_, index) => ({ period: `2023-${String((index % 12) + 1).padStart(2, "0")}-01`, ratio: 10 + index }));
      if (href.includes("/shopping/")) return new Response(JSON.stringify({ results: [{ data: [{ period: "2026-06-01", group: "20", ratio: 50 }] }] }), { status: 200 });
      return new Response(JSON.stringify({ results: [{ title: body.keywordGroups?.[0]?.groupName || "k", data: points }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "unexpected test request" } }), { status: 500 });
  };
  const call = async (keyword, headers, profile = "full") => {
    const response = await naverKeywordHandler.fetch(new Request(
      `http://127.0.0.1/api/naver-keyword?${new URLSearchParams({ keyword, profile }).toString()}`,
      { headers },
    ));
    return { status: response.status, body: await response.json() };
  };
  try {
    return await run({ call, counts });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function assertNoDatalab(body, label) {
  const chart = body.chartData || {};
  for (const field of DATALAB_FIELDS) assert.deepEqual(chart[field] || [], [], `${label}: ${field} 비어 있음`);
  assert.equal(chart.gender ?? null, null, `${label}: gender 없음`);
  assert.equal(chart.monthBasis || "", "", `${label}: monthBasis 없음`);
  assert.equal(chart.deviceBasis, "naver_searchad_monthly_query_count", `${label}: 기기 비중은 검색광고 기준`);
  assert.equal(body.sourceStatus?.trend?.status, "staff_only", `${label}: 추이 상태 = staff_only(제공 안 함)`);
  assert.equal(body.source?.trend, "staff_only", `${label}: source.trend`);
  assert.equal("migratedApiProvider" in (body.source || {}), false);
}

test("advertiser and trial sessions never call DataLab and receive no DataLab values (full and compare)", async () => {
  await withKeywordServer(async ({ call, counts }) => {
    const advertiser = await call("외부광고주키워드", { "x-mi-session-role": "client", "x-mi-agency-code": "brand-a" });
    assert.equal(advertiser.status, 200);
    assertNoDatalab(advertiser.body, "광고주");
    assert.ok(advertiser.body.chartData.volume > 0, "검색광고 월 검색수는 그대로");
    const trialCompare = await call("외부체험비교키워드", { "x-mi-session-role": "client", "x-mi-session-scope": "trial" }, "compare");
    assertNoDatalab(trialCompare.body, "체험 compare");
    const noRole = await call("역할없음키워드", {});
    assertNoDatalab(noRole.body, "역할 없음");
    assert.equal(counts.datalab, 0, "외부 세션은 데이터랩을 한 번도 부르지 않는다");
  });
});

test("a staff lookup fills its own cache; an advertiser asking the same keyword gets no DataLab values from it", async () => {
  await withKeywordServer(async ({ call, counts }) => {
    const staff = await call("캐시분리키워드", { "x-mi-session-role": "team", "x-mi-team-code": "t1" });
    assert.equal(staff.status, 200);
    assert.ok(counts.datalab > 0, "직원은 데이터랩을 부른다");
    assert.ok((staff.body.chartData.trendIndex || []).length > 0, "직원 응답에는 데이터랩 값이 있다");
    const before = counts.datalab;
    const advertiser = await call("캐시분리키워드", { "x-mi-session-role": "client", "x-mi-agency-code": "brand-b" });
    assertNoDatalab(advertiser.body, "직원 저장본 뒤 광고주");
    assert.equal(advertiser.body.cache.hit, false, "광고주는 직원 저장본을 쓰지 않는다");
    assert.equal(counts.datalab, before, "광고주 조회는 데이터랩을 부르지 않는다");
    // 외부 응답은 저장된다(데이터랩 칸이 staff_only 라도) — 다시 조회하면 검색광고도 다시 부르지 않는다.
    const searchadBefore = counts.searchad;
    const again = await call("캐시분리키워드", { "x-mi-session-role": "client", "x-mi-agency-code": "brand-c" });
    assert.equal(again.body.cache.hit, true, "외부 저장본 재사용");
    assertNoDatalab(again.body, "외부 저장본");
    assert.equal(counts.searchad, searchadBefore);
  });
});

test("staff and external lookups use different cache keys for the same keyword and profile", () => {
  // 실제 핸들러처럼 설정 묶음(shoppingResults 포함)을 넘긴다. 빈 {} 를 넘기면 빌드 환경(Vercel)의 쇼핑 순위 환경 변수로
  // 설정이 있다고 판단해 env.shoppingResults.mode 를 읽다 실패한다(2026-11-13 Vercel 빌드 실패, 운영 코드는 영향 없음).
  const env = { shoppingResults: {} };
  assert.notEqual(keywordCacheKeyFor(true, "원두", "full", env), keywordCacheKeyFor(false, "원두", "full", env));
  assert.match(keywordCacheKeyFor(false, "원두", "full", env), /^external:/u);
  assert.match(keywordCacheKeyFor(true, "원두", "full", env), /^staff:/u);
});

test("stripDatalabForExternal empties every DataLab-derived field and recomputes the device split from search-ad counts", () => {
  const stripped = stripDatalabForExternal({
    ok: true,
    source: { trend: "naver_datalab_relative_ratio", profile: "search_interest_profile", migratedApiProvider: "hub" },
    sourceStatus: { searchVolume: { status: "ok" }, trend: { status: "ok" }, ratios: { status: "ok" } },
    warnings: ["trend_unavailable", "shopping_unavailable"],
    chartData: {
      volume: 4000,
      series: [1, 2], trendIndex: [3], month: [1], monthLabels: ["1월"], monthBasis: "2016_current_search_ratio",
      age: [10], week: [1], gender: { female: 60, male: 40 }, seriesLabels: ["a"], seriesPeriods: ["2026-01"],
      device: { mobile: 90, pc: 10 }, deviceBasis: "naver_shopping_insight_device",
      naver: { monthlyPcQcCnt: "1000", monthlyMobileQcCnt: "3000" },
    },
  });
  assertNoDatalab(stripped, "정리 함수");
  assert.deepEqual(stripped.chartData.device, { mobile: 75, pc: 25 });
  assert.equal(stripped.chartData.volume, 4000);
  assert.deepEqual(stripped.warnings, ["shopping_unavailable"]);
  assert.match(stripped.userMessage, /제공하지 않습니다/u);
});

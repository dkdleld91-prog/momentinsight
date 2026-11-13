import test from "node:test";
import assert from "node:assert/strict";

import {
  createSearchTrendHandler,
  latestSearchTrendDate,
  normalizeSearchTrendInput,
  normalizeSearchTrendResults,
  searchTrendUpstreamBody,
} from "./search-trend.mjs";
import { safeErrorPayload } from "../error-safety.mjs";

// 2026-11-09 12:00 KST
const NOW = Date.parse("2026-11-09T03:00:00Z");
const config = { mode: "hub", hub: { clientId: "id", clientSecret: "secret" }, legacy: {} };
const validBody = {
  topics: [{ name: "전기장판", keywords: "전기장판, 전기 매트" }, { name: "온열매트", keywords: ["온열매트"] }],
  startDate: "2026-01-01",
  endDate: "2026-11-08",
  timeUnit: "week",
  device: "mo",
  gender: "f",
  ages: ["5", "4"],
};

// 검색어 트렌드는 직원(총관리자·운영팀) 전용(네이버 답변 2026-11-13) — 기본 요청은 운영팀 세션.
function request(body, headers = { "x-mi-session-role": "team", "x-mi-team-code": "abc" }, method = "POST") {
  return new Request("https://x.test/api/client/keyword-research?mode=search-trend", {
    method,
    headers,
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

function upstreamOk(titles = ["전기장판", "온열매트"]) {
  return new Response(JSON.stringify({
    results: titles.map((title, index) => ({ title, keywords: [title], data: [{ period: "2026-01-05", ratio: 100 - index }, { period: "2026-01-12", ratio: "12.345" }] })),
  }), { status: 200 });
}

test("한국 시간 기준 어제까지만 조회할 수 있다", () => {
  assert.equal(latestSearchTrendDate(NOW), "2026-11-08");
  assert.equal(latestSearchTrendDate(Date.parse("2026-11-08T15:30:00Z")), "2026-11-08");
  const late = normalizeSearchTrendInput({ ...validBody, endDate: "2026-11-09" }, NOW);
  assert.equal(late.ok, false);
  assert.match(late.message, /어제까지/);
});

test("주제어·검색어를 서로 채우고 중복과 빈 줄을 정리한다", () => {
  const result = normalizeSearchTrendInput({
    ...validBody,
    topics: [{ name: "", keywords: "캠핑, 캠핑 , Camping, camping" }, { name: "텐트", keywords: "" }, { name: " ", keywords: " , " }],
  }, NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.topics, [{ name: "캠핑", keywords: ["캠핑", "Camping"] }, { name: "텐트", keywords: ["텐트"] }]);
  assert.deepEqual(result.value.ages, ["4", "5"]);
});

test("입력 제한을 어기면 이유와 함께 거절한다", () => {
  const cases = [
    [{ topics: [] }, /1개 이상/],
    [{ topics: Array.from({ length: 6 }, (_, index) => ({ name: `t${index}` })) }, /5개까지/],
    [{ topics: [{ name: "a", keywords: Array.from({ length: 21 }, (_, index) => `k${index}`) }] }, /20개까지/],
    [{ topics: [{ name: "같음" }, { name: "같음" }] }, /두 번/],
    [{ topics: [{ name: "x".repeat(61) }] }, /60자/],
    [{ startDate: "2015-12-31" }, /2016년/],
    [{ startDate: "2026-02-30" }, /기간/],
    [{ startDate: "2026-11-08", endDate: "2026-11-01" }, /앞이어야/],
    [{ timeUnit: "hour" }, /일간/],
    [{ device: "tv" }, /범위/],
    [{ gender: "x" }, /성별/],
    [{ ages: ["12"] }, /연령/],
  ];
  for (const [patch, pattern] of cases) {
    const result = normalizeSearchTrendInput({ ...validBody, ...patch }, NOW);
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.match(result.message, pattern);
  }
});

test("연령을 전부 고르면 전체와 같게 보낸다", () => {
  const all = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];
  const result = normalizeSearchTrendInput({ ...validBody, ages: all }, NOW);
  assert.deepEqual(result.value.ages, []);
  assert.equal("ages" in searchTrendUpstreamBody(result.value), false);
});

test("네이버 공식 형식으로 보낸다", () => {
  const { value } = normalizeSearchTrendInput(validBody, NOW);
  assert.deepEqual(searchTrendUpstreamBody(value), {
    startDate: "2026-01-01",
    endDate: "2026-11-08",
    timeUnit: "week",
    keywordGroups: [{ groupName: "전기장판", keywords: ["전기장판", "전기 매트"] }, { groupName: "온열매트", keywords: ["온열매트"] }],
    device: "mo",
    gender: "f",
    ages: ["4", "5"],
  });
});

test("아주 작은 값도 네이버가 준 그대로 둔다", () => {
  const [result] = normalizeSearchTrendResults({ results: [{ title: "a", data: [{ period: "2026-01-01", ratio: 0.00123 }] }] }, [{ name: "a", keywords: ["a"] }]);
  assert.equal(result.data[0].ratio, 0.00123);
});

test("문자열이 아닌 입력은 예외 없이 거절한다", () => {
  const nasty = { toString: 1 };
  let deep = [];
  for (let index = 0; index < 11000; index += 1) deep = [deep];
  for (const patch of [
    { topics: [{ name: nasty }] }, { topics: [{ name: "a", keywords: [nasty] }] }, { topics: [{ name: "a", keywords: nasty }] },
    { topics: [{ name: deep }] }, { startDate: nasty }, { ages: [nasty] }, { timeUnit: nasty },
  ]) {
    assert.doesNotThrow(() => normalizeSearchTrendInput({ ...validBody, ...patch }, NOW), JSON.stringify(Object.keys(patch)));
  }
  assert.equal(normalizeSearchTrendInput({ ...validBody, topics: [{ name: nasty }] }, NOW).ok, false);
});

test("없는 구간을 0 으로 채우지 않고 잘못된 값은 버린다", () => {
  const topics = [{ name: "a", keywords: ["a"] }, { name: "b", keywords: ["b"] }];
  const results = normalizeSearchTrendResults({
    results: [{ title: "a", data: [
      { period: "2026-01-02", ratio: 5 }, { period: "2026-01-01", ratio: 0 }, { period: "bad", ratio: 1 },
      { period: "2026-01-03", ratio: null }, { period: "2026-01-04", ratio: "x" }, { period: "2026-01-05", ratio: -1 },
    ] }],
  }, topics);
  assert.deepEqual(results[0].data, [{ period: "2026-01-01", ratio: 0 }, { period: "2026-01-02", ratio: 5 }]);
  assert.deepEqual(results[1], { title: "b", keywords: ["b"], data: [] });
});

test("광고주(직원이 아닌) 세션은 네이버를 부르지 않고 운영팀 전용으로 거절한다(2026-11-13 네이버 답변)", async () => {
  let calls = 0;
  const handler = createSearchTrendHandler({ config, now: () => NOW, fetchImpl: async () => { calls += 1; return upstreamOk(); } });
  for (const headers of [{ "x-mi-session-role": "client", "x-mi-agency-code": "brand-a" }, { "x-mi-session-role": "advertiser" }, { "x-mi-session-role": "client", "x-mi-session-scope": "advertiser" }]) {
    const response = await handler(request(validBody, headers));
    assert.equal(response.status, 403, JSON.stringify(headers));
    const body = await response.json();
    assert.equal(body.code, "STAFF_ONLY");
    assert.match(body.message, /회사 내부용/u);
  }
  const owner = await handler(request(validBody, { "x-mi-session-role": "owner" }));
  assert.equal(owner.status, 200, "총관리자는 그대로");
  assert.equal(calls, 1, "광고주 요청은 네이버를 한 번도 부르지 않았다");
});

test("세션이 없거나 체험 계정이면 네이버를 부르지 않는다", async () => {
  let calls = 0;
  const handler = createSearchTrendHandler({ config, now: () => NOW, fetchImpl: async () => { calls += 1; return upstreamOk(); } });
  assert.equal((await handler(request(validBody, {}))).status, 401);
  const trial = await handler(request(validBody, { "x-mi-session-role": "client", "x-mi-session-scope": "trial" }));
  assert.equal(trial.status, 403);
  assert.equal((await trial.json()).code, "TRIAL_LOCKED");
  assert.equal((await handler(request(null, { "x-mi-session-role": "client" }, "GET"))).status, 405);
  assert.equal((await handler(request("{bad"))).status, 400);
  assert.equal((await handler(request("x".repeat(24001)))).status, 413);
  assert.equal(calls, 0);
});

test("연결 설정이 없으면 네이버를 부르지 않고 안내한다", async () => {
  let calls = 0;
  const handler = createSearchTrendHandler({ config: { mode: "not-configured", hub: {}, legacy: {} }, now: () => NOW, fetchImpl: async () => { calls += 1; return upstreamOk(); } });
  const response = await handler(request(validBody));
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
});

test("공식 주소로 한 번만 부르고 같은 조건은 다른 계정에도 다시 쓴다", async () => {
  const calls = [];
  const handler = createSearchTrendHandler({ config, now: () => NOW, fetchImpl: async (url, options) => { calls.push({ url, options }); return upstreamOk(); } });
  const first = await (await handler(request(validBody))).json();
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.results[0].data[1].ratio, 12.345);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/search-trend\/v1\/search$/);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(JSON.parse(calls[0].options.body).keywordGroups.length, 2);
  const second = await (await handler(request(validBody, { "x-mi-session-role": "team", "x-mi-team-code": "t1" }))).json();
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1);
});

test("캐시가 1시간 지나면 다시 부르고 조건이 다르면 따로 부른다", async () => {
  let calls = 0;
  let current = NOW;
  const handler = createSearchTrendHandler({ config, now: () => current, fetchImpl: async () => { calls += 1; return upstreamOk(); } });
  await handler(request(validBody));
  await handler(request({ ...validBody, gender: "m" }));
  assert.equal(calls, 2);
  current = NOW + 61 * 60 * 1000;
  await handler(request(validBody));
  assert.equal(calls, 3);
});

test("실패는 재시도 없이 원문을 숨기고 캐시하지 않는다", async () => {
  for (const [status, reason, expected] of [[400, "source_rejected", 400], [429, "source_limit", 429], [401, "source_unavailable", 502], [500, "source_unavailable", 502]]) {
    let calls = 0;
    const handler = createSearchTrendHandler({ config, now: () => NOW, fetchImpl: async () => { calls += 1; return new Response("{\"errorMessage\":\"secret detail\"}", { status }); } });
    const response = await handler(request(validBody));
    const payload = await response.json();
    assert.equal(response.status, expected);
    assert.equal(payload.reason, reason);
    assert.equal(JSON.stringify(payload).includes("secret detail"), false);
    assert.equal(calls, 1);
    await handler(request(validBody));
    assert.equal(calls, 2, "실패는 캐시하지 않는다");
  }
});

test("5xx 안내 문구가 운영 공통 오류로 가려지지 않는다", async () => {
  const cases = [
    [createSearchTrendHandler({ config, now: () => NOW, fetchImpl: async () => new Response("x", { status: 500 }) }), 502],
    [createSearchTrendHandler({ config, now: () => NOW, fetchImpl: async () => { const error = new Error("x"); error.name = "AbortError"; throw error; } }), 504],
    [createSearchTrendHandler({ config: { mode: "not-configured", hub: {}, legacy: {} }, now: () => NOW }), 503],
  ];
  for (const [handler, status] of cases) {
    const response = await handler(request(validBody));
    assert.equal(response.status, status);
    const text = await response.text();
    assert.equal(safeErrorPayload(new Response(text, { status }), text)?.body?.code === "SERVER_ERROR", false, text);
  }
});

test("시간 초과와 이상한 응답을 구분해 안내한다", async () => {
  const abort = createSearchTrendHandler({ config, now: () => NOW, fetchImpl: async () => { const error = new Error("x"); error.name = "AbortError"; throw error; } });
  assert.equal((await abort(request(validBody))).status, 504);
  const weird = createSearchTrendHandler({ config, now: () => NOW, fetchImpl: async () => new Response("{}", { status: 200 }) });
  assert.equal((await weird(request(validBody))).status, 502);
});

test("계정별로 과다 호출을 막고 다른 계정과 캐시 조회는 막지 않는다", async () => {
  let calls = 0;
  let current = NOW;
  const handler = createSearchTrendHandler({ config, now: () => current, fetchImpl: async () => { calls += 1; return upstreamOk(); } });
  for (let index = 0; index < 20; index += 1) {
    const response = await handler(request({ ...validBody, startDate: `2026-01-${String(index + 1).padStart(2, "0")}` }));
    assert.equal(response.status, 200);
  }
  const blocked = await handler(request({ ...validBody, startDate: "2026-02-01" }));
  assert.equal(blocked.status, 429);
  assert.equal(calls, 20);
  assert.equal((await handler(request({ ...validBody, startDate: "2026-01-01" }))).status, 200, "캐시는 막지 않는다");
  assert.equal((await handler(request({ ...validBody, startDate: "2026-02-01" }, { "x-mi-session-role": "team", "x-mi-team-code": "other" }))).status, 200);
  current = NOW + 61 * 1000;
  assert.equal((await handler(request({ ...validBody, startDate: "2026-02-02" }))).status, 200);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  agencyCodeScope,
  articleTopic,
  buildBrandSection,
  chunk,
  collectArticles,
  computeRankSummary,
  computeRankSwings,
  dedupeKey,
  isWithinWindow,
  latestTwoDayRanks,
  monthlyVolumeOf,
  parseSearchCount,
  passesBrandTitleGate,
  passesCommerceGate,
  resolveScope,
  selectLead,
  sourceHost,
  stripHtml,
  trackerNeverFound,
  weekIsComplete,
  weeklyChangePct,
} from "./home-feed.mjs";

const NOW = Date.parse("2026-09-04T01:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function newsItem(title, { days = 1, description = "셀러 수수료 정산 이야기", link = "https://news.example.com/a" } = {}) {
  return {
    title,
    description,
    originallink: link,
    link,
    pubDate: new Date(NOW - days * DAY).toUTCString(),
  };
}

// ── 문자열 정리 ──────────────────────────────────────────────────
test("stripHtml removes tags and decodes the entities the news API returns", () => {
  assert.equal(stripHtml("<b>쿠팡</b> &quot;정산&quot; &amp; 수수료"), '쿠팡 "정산" & 수수료');
  assert.equal(stripHtml("줄  간격\n정리"), "줄 간격 정리");
  assert.equal(stripHtml(null), "");
});

test("dedupeKey uses the first 22 characters of the whitespace-stripped title", () => {
  const key = dedupeKey("네이버 커머스 정산 개편으로 입점 셀러 부담이 크게 달라진다는 분석");
  assert.equal(key.length, 22);
  assert.equal(key, "네이버커머스정산개편으로입점셀러부담이크게달");
  assert.equal(dedupeKey("네이버 커머스"), "네이버커머스");
  // 공백만 다른 제목은 같은 기사로 본다.
  assert.equal(dedupeKey("쿠팡 수수료 인상"), dedupeKey("쿠팡수수료 인상"));
});

test("articleTopic picks the first matching chip in the fixed order", () => {
  // "정산" 이 "수수료" 보다 목록에서 앞서므로 둘 다 있으면 정산이 이긴다.
  assert.equal(articleTopic("쿠팡 정산 수수료 개편"), "정산");
  assert.equal(articleTopic("네이버 물류 투자"), "물류");
  assert.equal(articleTopic("특별한 소식"), "");
});

test("sourceHost reduces a link to a bare media host", () => {
  assert.equal(sourceHost("https://www.mk.co.kr/news/1"), "mk.co.kr");
  assert.equal(sourceHost("not a url"), "");
});

// ── 기간 ────────────────────────────────────────────────────────
test("isWithinWindow keeps the last 7 days and drops future datelines", () => {
  assert.equal(isWithinWindow(NOW - 6 * DAY, NOW), true);
  assert.equal(isWithinWindow(NOW - 8 * DAY, NOW), false);
  assert.equal(isWithinWindow(NOW + 5 * DAY, NOW), false);
  assert.equal(isWithinWindow(Number.NaN, NOW), false);
});

// ── 브랜드별 제목 게이트 ─────────────────────────────────────────
test("naver titles must name 네이버 or 스마트스토어", () => {
  assert.equal(passesBrandTitleGate("naver", "네이버 커머스 개편"), true);
  assert.equal(passesBrandTitleGate("naver", "스마트스토어 수수료 인하"), true);
  assert.equal(passesBrandTitleGate("naver", "쿠팡 정산 지연"), false);
});

test("coupang titles need 쿠팡 plus seller context and must not be PR", () => {
  assert.equal(passesBrandTitleGate("coupang", "쿠팡 입점 셀러 수수료 조정"), true);
  // 셀러 문맥어가 없으면 버린다.
  assert.equal(passesBrandTitleGate("coupang", "쿠팡 신사옥 이전"), false);
  // PR 배제어가 있으면 셀러 문맥어가 있어도 버린다.
  assert.equal(passesBrandTitleGate("coupang", "쿠팡 판매자 대상 장학 캠페인"), false);
  assert.equal(passesBrandTitleGate("coupang", "쿠팡 로지스틱스 채용 확대 입점"), false);
});

test("commerce gate requires context and rejects entertainment or delivery-brand noise", () => {
  assert.equal(passesCommerceGate("쿠팡 수수료", "입점 셀러 부담"), true);
  assert.equal(passesCommerceGate("쿠팡 드라마 흥행", "셀러"), false);
  assert.equal(passesCommerceGate("쿠팡플레이 중계", "커머스"), false);
  assert.equal(passesCommerceGate("무관한 제목", "무관한 본문"), false);
});

// ── 수집·중복 제거·리드 ─────────────────────────────────────────
test("collectArticles filters, dedupes and records relevance position", () => {
  const groups = [
    [newsItem("네이버 커머스 수수료 개편"), newsItem("드라마 배우 소식", { description: "예능" })],
    [newsItem("네이버 커머스 수수료 개편"), newsItem("스마트스토어 정산 주기 단축")],
  ];
  const articles = collectArticles("naver", groups, NOW);
  assert.equal(articles.length, 2, "중복 제목은 한 번만 남는다");
  assert.equal(articles[0].queryIndex, 0);
  assert.equal(articles[0].itemIndex, 0);
  assert.equal(articles[1].title, "스마트스토어 정산 주기 단축");
  assert.equal(articles[1].topic, "정산");
  assert.equal(articles[0].source, "news.example.com");
});

test("collectArticles drops items outside the 7 day window", () => {
  const groups = [[newsItem("네이버 커머스 수수료 개편", { days: 30 })]];
  assert.deepEqual(collectArticles("naver", groups, NOW), []);
});

test("selectLead prefers the earliest query then the earliest returned item", () => {
  const articles = [
    { queryIndex: 1, itemIndex: 0, publishedMs: NOW },
    { queryIndex: 0, itemIndex: 3, publishedMs: NOW - DAY },
  ];
  assert.equal(selectLead(articles).queryIndex, 0);
  assert.equal(selectLead([]), null);
});

test("selectLead breaks an exact relevance tie with the newer article", () => {
  const older = { queryIndex: 0, itemIndex: 0, publishedMs: NOW - 2 * DAY };
  const newer = { queryIndex: 0, itemIndex: 0, publishedMs: NOW };
  assert.equal(selectLead([older, newer]), newer);
});

test("buildBrandSection returns a lead plus at most three newest others", () => {
  const groups = [[
    newsItem("네이버 커머스 리드 기사", { days: 5 }),
    newsItem("네이버 정산 기사 하나", { days: 1 }),
    newsItem("네이버 물류 기사 둘", { days: 2 }),
    newsItem("네이버 규제 기사 셋", { days: 3 }),
    newsItem("네이버 광고 기사 넷", { days: 4 }),
  ]];
  const section = buildBrandSection("naver", groups, NOW);
  assert.equal(section.count7d, 5);
  assert.equal(section.lead.title, "네이버 커머스 리드 기사");
  assert.equal(section.items.length, 3, "나머지는 최신순 최대 3건");
  assert.deepEqual(section.items.map((item) => item.title), [
    "네이버 정산 기사 하나",
    "네이버 물류 기사 둘",
    "네이버 규제 기사 셋",
  ]);
  // 화면으로 나가는 항목은 내부 정렬 필드를 노출하지 않는다.
  assert.deepEqual(Object.keys(section.lead).sort(), ["link", "publishedAt", "source", "title", "topic"]);
});

test("buildBrandSection reports an empty section rather than inventing rows", () => {
  const section = buildBrandSection("naver", [[]], NOW);
  assert.deepEqual(section, { count7d: 0, lead: null, items: [] });
});

// ── 주간 트렌드 ──────────────────────────────────────────────────
test("weekIsComplete only accepts buckets whose seven days have fully elapsed", () => {
  // 2026-08-24 주는 08-31 에 끝난다 → 09-04 기준 완결.
  assert.equal(weekIsComplete("2026-08-24", NOW), true);
  // 2026-08-31 주는 09-07 에 끝난다 → 아직 미완결.
  assert.equal(weekIsComplete("2026-08-31", NOW), false);
  assert.equal(weekIsComplete("", NOW), false);
});

test("weeklyChangePct ignores the truncated current week", () => {
  const data = [
    { period: "2026-08-17", ratio: 26.82237 },
    { period: "2026-08-24", ratio: 28.42343 },
    { period: "2026-08-31", ratio: 31.83273 }, // 미완결 주 — 비교에서 빠져야 한다
  ];
  // 08-24 대비 08-17 = +6.0%. 미완결 주를 쓰면 +12.0% 가 나온다.
  assert.equal(weeklyChangePct(data, NOW), 6);
});

test("weeklyChangePct returns null when there is no complete comparison", () => {
  assert.equal(weeklyChangePct([{ period: "2026-08-31", ratio: 10 }], NOW), null);
  assert.equal(weeklyChangePct([], NOW), null);
  // 기준 주가 0 이면 증감률을 만들 수 없다.
  assert.equal(weeklyChangePct([
    { period: "2026-08-17", ratio: 0 },
    { period: "2026-08-24", ratio: 5 },
  ], NOW), null);
});

test("chunk splits the keyword list into datalab-sized groups of five", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6], 5), [[1, 2, 3, 4, 5], [6]]);
  assert.deepEqual(chunk([], 5), []);
});

// ── 검색량 파싱 ──────────────────────────────────────────────────
test("parseSearchCount follows the searchad '< 10' convention", () => {
  assert.equal(parseSearchCount("1,240"), 1240);
  assert.equal(parseSearchCount("< 10"), 0);
  assert.equal(parseSearchCount(90), 90);
  assert.equal(parseSearchCount(""), 0);
});

test("monthlyVolumeOf adds the pc and mobile columns", () => {
  assert.equal(monthlyVolumeOf({ monthlyPcQcCnt: "1,000", monthlyMobileQcCnt: "8,700" }), 9700);
  assert.equal(monthlyVolumeOf(null), null);
});

// ── 대행사 코드 범위 ─────────────────────────────────────────────
test("agencyCodeScope folds legacy codes into the primary code", () => {
  const env = { MI_PRIMARY_AGENCY_CODE: "mml93-a01", MI_LEGACY_AGENCY_CODES: "old-a01,older-a01" };
  assert.deepEqual(agencyCodeScope("HADDEN", env), ["hadden"]);
  assert.deepEqual(agencyCodeScope("old-a01", env), ["mml93-a01", "old-a01", "older-a01"]);
  assert.deepEqual(agencyCodeScope("", env), []);
});

// ── 역할·대상 판정 ───────────────────────────────────────────────
function requestWith(headers) {
  return new Request("https://example.com/api/client/home-feed", { headers });
}

test("resolveScope trusts only the session headers the gate stamps", () => {
  const client = resolveScope(requestWith({ "x-mi-session-role": "client", "x-mi-agency-code": "hadden" }));
  assert.deepEqual(client, { ok: true, role: "client", accountCode: "hadden" });

  const team = resolveScope(requestWith({ "x-mi-session-role": "team", "x-mi-team-code": "team-a" }));
  assert.equal(team.accountCode, "team-a", "광고주 미연결 운영팀은 팀 코드로 떨어진다");

  const owner = resolveScope(requestWith({
    "x-mi-session-role": "owner",
    "x-mi-owner-agency-code": "mml93-a01",
    "x-mi-agency-code": "hadden",
  }));
  assert.equal(owner.accountCode, "hadden", "총관리자는 고른 대상 광고주를 그대로 쓴다");
});

test("resolveScope rejects a request with no session role", () => {
  assert.equal(resolveScope(requestWith({})).ok, false);
});

test("resolveScope resolves the owner placeholder only for a verified owner session", () => {
  const verified = resolveScope(requestWith({
    "x-mi-session-role": "owner",
    "x-mi-owner-agency-code": "mml93-a01",
    "x-mi-agency-code": "owner-session",
  }));
  assert.equal(verified.accountCode, "mml93-a01", "자리표시자는 총관리자 내부 계정(primary)으로 본다");

  const unverified = resolveScope(requestWith({
    "x-mi-session-role": "owner",
    "x-mi-agency-code": "owner-session",
  }));
  assert.equal(unverified.accountCode, "owner-session");
});

// ── 순위(읽기 전용) ─────────────────────────────────────────────
const TRACKERS = [
  { id: "t1", agency_code: "hadden", keyword: "전기매트", current_rank: 9, last_checked_at: "2026-09-04T04:10:00Z", check_count: 10, found_count: 8 },
  { id: "t2", agency_code: "hadden", keyword: "드로즈팬티", current_rank: 31, last_checked_at: "2026-09-04T04:10:00Z", check_count: 10, found_count: 9 },
  { id: "t3", agency_code: "hadden", keyword: "온수매트", current_rank: 12, last_checked_at: "2026-09-04T04:10:00Z", check_count: 10, found_count: 10 },
  { id: "t4", agency_code: "hadden", keyword: "차량용 거치대", current_rank: null, last_checked_at: "2026-09-04T04:10:00Z", check_count: 5, found_count: 0 },
];

const SNAPSHOTS = [
  { tracker_id: "t1", checked_at: "2026-09-04T04:10:00Z", rank: 9, matched: true },
  { tracker_id: "t1", checked_at: "2026-09-03T04:10:00Z", rank: 22, matched: true },
  { tracker_id: "t2", checked_at: "2026-09-04T04:10:00Z", rank: 31, matched: true },
  { tracker_id: "t2", checked_at: "2026-09-03T04:10:00Z", rank: 15, matched: true },
  { tracker_id: "t3", checked_at: "2026-09-04T04:10:00Z", rank: 12, matched: true },
  { tracker_id: "t3", checked_at: "2026-09-03T04:10:00Z", rank: 12, matched: true },
];

test("latestTwoDayRanks keeps the newest snapshot per day per tracker", () => {
  const ranks = latestTwoDayRanks([
    { tracker_id: "t1", checked_at: "2026-09-04T04:10:00Z", rank: 9, matched: true },
    { tracker_id: "t1", checked_at: "2026-09-04T01:00:00Z", rank: 40, matched: true },
    { tracker_id: "t1", checked_at: "2026-09-03T04:10:00Z", rank: 22, matched: true },
  ]);
  assert.equal(ranks.get("t1").latest.rank, 9, "같은 날은 가장 늦은 수집만 쓴다");
  assert.equal(ranks.get("t1").previous.rank, 22);
});

test("computeRankSwings reports only moves of ten or more, biggest first", () => {
  const swings = computeRankSwings(TRACKERS, SNAPSHOTS);
  assert.equal(swings.length, 2, "12위 → 12위 무변동은 빠진다");
  assert.deepEqual(swings[0], { accountCode: "hadden", keyword: "드로즈팬티", fromRank: 15, toRank: 31, delta: -16 });
  assert.deepEqual(swings[1], { accountCode: "hadden", keyword: "전기매트", fromRank: 22, toRank: 9, delta: 13 });
});

test("computeRankSwings ignores trackers without two comparable days", () => {
  assert.deepEqual(computeRankSwings(TRACKERS, [SNAPSHOTS[0]]), []);
  assert.deepEqual(computeRankSwings([], SNAPSHOTS), []);
});

test("computeRankSummary counts direction and never-found trackers for the advertiser", () => {
  const summary = computeRankSummary(TRACKERS, SNAPSHOTS);
  assert.equal(summary.trackedCount, 4);
  assert.equal(summary.up, 1, "전기매트 22 → 9");
  assert.equal(summary.down, 1, "드로즈팬티 15 → 31");
  assert.equal(summary.unchanged, 1, "온수매트 12 → 12");
  // 차량용 거치대: check_count 5 회 동안 한 번도 못 찾음 → 기존 neverFound 규약상 원부 확인 필요.
  assert.equal(summary.unmatched, 1);
  assert.equal(summary.lastCollectedAt, "2026-09-04T04:10:00.000Z");
});

test("trackerNeverFound follows the shared neverFound rule", () => {
  assert.equal(trackerNeverFound({ check_count: 3, found_count: 0 }), true);
  assert.equal(trackerNeverFound({ check_count: 2, found_count: 0 }), false);
  assert.equal(trackerNeverFound({ check_count: 9, found_count: 1 }), false);
});

test("rank 0 (not found) is never treated as a rank in swings or summary", () => {
  const trackers = [{ id: "z", keyword: "차량용 맥세이프 거치대", agency_code: "mml93-a01" }];
  const snapshots = [
    { tracker_id: "z", checked_at: "2026-09-03T04:00:00Z", rank: 289, matched: true },
    { tracker_id: "z", checked_at: "2026-09-04T04:00:00Z", rank: 0, matched: false },
  ];
  assert.deepEqual(computeRankSwings(trackers, snapshots), []);
  const summary = computeRankSummary(trackers, snapshots);
  assert.equal(summary.up + summary.down + summary.unchanged, 0);
});

test("computeRankSummary reports unmatched once a tracker has never been found", () => {
  const summary = computeRankSummary([{ id: "x", keyword: "k", check_count: 4, found_count: 0 }], []);
  assert.equal(summary.unmatched, 1);
  assert.equal(summary.lastCollectedAt, null);
});

// C5 — 원부(카탈로그) 안내·레인 배너·총관리자 타일 UI 회귀 테스트.
//
//   (a) 순위 추적기 카드: payload.neverFound === true 면 "원부 확인 필요" 배지 + 원부 URL 안내문
//       (광고주 client.html · 총관리자 admin.html 양쪽). 기존 "점검 필요" 배지는 그대로 병기된다.
//   (b) 등록 폼: URL 입력 placeholder / 도움말이 "상품 URL 또는 원부(카탈로그) URL" 을 명시한다.
//   (c) 정체 배너(총관리자): 헬스 API lanes 로 상품/플레이스 레인을 각각 문장으로 낸다.
//       둘 다 정상이면 레인 문장만으로는 배너가 열리지 않는다. trackers.neverFound/stuck 가
//       0 초과면 한 줄 요약을 덧붙인다(요약 단독으로는 배너를 열지 않는다).
//   (d) 총관리자 카운터 타일: neverFoundTrackers · stuckTrackers 행.
//
// 규약은 scripts/rank-collection-alert-ui.test.mjs 와 같다: 화면 원본에서 함수·상수 블록을
// 그대로 떼어 vm 에서 실행하고, 문구는 실행 결과 HTML 로 확인한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  RANK_NEVER_FOUND_MIN_CHECKS,
  RANK_STUCK_TRACKER_HOURS,
} from "../src/server/naver-rank-requeue.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readRepoFile = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");

const adminSource = readRepoFile("src/pages/admin.html");
const clientSource = readRepoFile("src/pages/client.html");

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-02T00:00:00.000Z");
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const CATALOG_BADGE = "원부 확인 필요";
const CATALOG_NOTE = "검색 결과에 원부(가격비교) 카드로만 노출되는 상품이면 https://search.shopping.naver.com/catalog/원부번호 형태의 원부 URL로 등록하세요";
const URL_FIELD_HINT = "상품 URL 또는 원부(카탈로그) URL";
const PRODUCT_LANE_NOUN = "상품 레인";
const PLACE_LANE_NOUN = "플레이스 레인";

const PAGES = [["admin.html", adminSource], ["client.html", clientSource]];

// ─────────────────────────────────────────────────────────────
// 추출기 (rank-collection-alert-ui.test.mjs 와 동일 규약)
// ─────────────────────────────────────────────────────────────
const PAGE_FUNCTION_CLOSE = "\n      }";

function htmlFunction(source, name, label) {
  // async 함수(refreshRankCollectionHealthSignal)도 같은 들여쓰기 규약이다.
  let from = source.indexOf(`\n      function ${name}(`);
  if (from < 0) from = source.indexOf(`\n      async function ${name}(`);
  assert.ok(from >= 0, `page function not found: ${name} (${label || ""})`);
  const to = source.indexOf(PAGE_FUNCTION_CLOSE + "\n", from);
  assert.ok(to > from, `page function end not found: ${name} (${label || ""})`);
  return source.slice(from + 1, to + PAGE_FUNCTION_CLOSE.length);
}

function stallConstantsBlock() {
  const startMarker = "      var RANK_OVERDUE_THRESHOLD_MS = 21600000;";
  const endMarker = "\n      function rankTrackerOpsSummary(";
  const from = adminSource.indexOf(startMarker);
  assert.ok(from >= 0, "stall constants block not found");
  const to = adminSource.indexOf(endMarker, from);
  assert.ok(to > from, "stall constants block end not found");
  const block = adminSource.slice(from, to);
  assert.ok(block.length > 500, "stall constants block is suspiciously small");
  return block;
}

function clientIsolationConstants() {
  const startMarker = "      var RANK_RETRY_EXHAUSTED_AT = 8;";
  const endMarker = "\n      function rankTrackerChronicIsolated(";
  const from = clientSource.indexOf(startMarker);
  assert.ok(from >= 0, "client isolation constants block not found");
  const to = clientSource.indexOf(endMarker, from);
  assert.ok(to > from, "client isolation constants block end not found");
  return clientSource.slice(from, to);
}

function parseNumberLiteral(source, label, name) {
  const hits = [...source.matchAll(new RegExp(`var ${name} = (\\d+);`, "g"))];
  assert.equal(hits.length, 1, `${label}: var ${name} 선언은 정확히 1개여야 한다`);
  return Number(hits[0][1]);
}

function applyHealth(context, health) {
  if (!health) return;
  const script = Object.keys(health)
    .map((key) => `rankCollectionHealthSignal.${key} = ${JSON.stringify(health[key])};`)
    .join(" ");
  vm.runInContext(script, context);
}

// ─────────────────────────────────────────────────────────────
// 샌드박스
// ─────────────────────────────────────────────────────────────
const CARD_STUBS = `
  function rankTrackerTitle(tracker) { return tracker.title || "상품"; }
  function rankTrackerMallName() { return ""; }
  function rankTrackerAverageRank() { return 0; }
  function rankTrackerActionNote() { return { label: "확인", className: "is-ok" }; }
  function rankTrackerCurrentSourceLabel() { return ""; }
  function renderRankKeywordName(keyword) { return "<span>" + escapeHtml(keyword) + "</span>"; }
  function renderRankKeywordVolume() { return ""; }
  function rankTrackerProductId(tracker) { return tracker.productId || "-"; }
  function renderRankProductTitle() { return ""; }
  function rankText(value) { return value ? String(value) + "위" : "-"; }
  function rankTrackerStatusClass() { return "mi-rank-insight-pill"; }
  function rankTrackerStatus() { return "운영"; }
  function rankTrackerChangeLabel() { return "변동 없음"; }
  function rankGroupDisplayName() { return "기본"; }
  function rankTrackerGroupName() { return ""; }
  function formatRankShortAt() { return "-"; }
  function formatRankRemain() { return "-"; }
  function renderTrackerDailyBoard() { return ""; }
`;

function cardSandbox(source, label) {
  const preamble = source === adminSource
    ? stallConstantsBlock()
    : [clientIsolationConstants(), htmlFunction(source, "rankTrackerChronicIsolated", label)].join("\n\n");
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; };`, context);
  vm.runInContext([
    preamble,
    htmlFunction(source, "escapeHtml", label),
    htmlFunction(source, "rankTrackerRankValue", label),
    htmlFunction(source, "rankTrackerLatestRank", label),
    htmlFunction(source, "rankTrackerPreviousRank", label),
    htmlFunction(source, "rankTrackerTrend", label),
    htmlFunction(source, "rankTrackerNeedsAttention", label),
    htmlFunction(source, "rankTrackerInsight", label),
    htmlFunction(source, "rankTrackerCatalogHint", label),
    htmlFunction(source, "renderRankTrackerCard", label),
    CARD_STUBS,
  ].join("\n\n"), context);
  return context;
}

function cardHtml(source, label, tracker) {
  const context = cardSandbox(source, label);
  context.__tracker = tracker;
  const html = vm.runInContext("renderRankTrackerCard(__tracker, null)", context);
  assert.equal(typeof html, "string");
  assert.ok(html.includes("mi-rank-tracker-card"), `${label}: 카드 렌더 결과가 비어 있다`);
  return html;
}

function catalogHint(source, label, tracker) {
  const context = cardSandbox(source, label);
  context.__tracker = tracker;
  return vm.runInContext("rankTrackerCatalogHint(__tracker)", context);
}

function opsSummarySandbox(health) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; };`, context);
  vm.runInContext([
    stallConstantsBlock(),
    htmlFunction(adminSource, "rankTrackerOpsSummary"),
    htmlFunction(adminSource, "escapeHtml"),
    htmlFunction(adminSource, "formatRankShortAt"),
    htmlFunction(adminSource, "rankTrackerRankValue"),
    htmlFunction(adminSource, "rankTrackerLatestRank"),
    htmlFunction(adminSource, "placeTrackerLatestRank"),
  ].join("\n\n"), context);
  applyHealth(context, health);
  return context;
}

function opsSummaryHtml(trackers, { place = false, workerStatus = null, health = null } = {}) {
  const context = opsSummarySandbox(health);
  context.__trackers = trackers;
  context.__workerStatus = workerStatus;
  const html = vm.runInContext(
    place
      ? "rankTrackerOpsSummary(__trackers, placeTrackerLatestRank, __workerStatus)"
      : "rankTrackerOpsSummary(__trackers, null, __workerStatus)",
    context,
  );
  assert.equal(typeof html, "string");
  assert.ok(html.length > 200);
  return html;
}

function stallSummary(trackers, options = {}) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; };`, context);
  vm.runInContext(stallConstantsBlock(), context);
  applyHealth(context, options.health);
  context.__trackers = trackers;
  context.__workerStatus = options.workerStatus || null;
  return vm.runInContext("rankCollectionStallSummary(__trackers, __workerStatus)", context);
}

function ownerRows(health) {
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    stallConstantsBlock(),
    htmlFunction(adminSource, "escapeHtml"),
    htmlFunction(adminSource, "ownerHealthTrackerRows"),
    // 연결 전 코드(F17) 안내 행. 집계 행 함수가 직접 부르므로 같은 컨텍스트에 올린다.
    htmlFunction(adminSource, "ownerUnlinkedScopeRows"),
  ].join("\n\n"), context);
  context.__health = health;
  // vm 컨텍스트의 Array 는 프로토타입이 다른 realm 이라 deepEqual 이 실패한다. 값만 옮긴다.
  return JSON.parse(JSON.stringify(vm.runInContext("ownerHealthTrackerRows(__health)", context)));
}

// ─────────────────────────────────────────────────────────────
// 픽스처
// ─────────────────────────────────────────────────────────────
function activeTracker(overrides) {
  return Object.assign({
    id: "t-1",
    keyword: "테스트 키워드",
    status: "active",
    nextCheckAt: at(HOUR),
    lastCheckedAt: at(-HOUR),
    lastError: null,
    retryCount: 0,
    lastMessage: "",
    snapshots: [],
    currentRank: null,
  }, overrides || {});
}

// 서버 trackerPayload 가 neverFound 를 참으로 내는 모양(check_count>=3, found_count=0).
function neverFoundTracker(overrides) {
  return activeTracker(Object.assign({
    neverFound: true,
    foundRate: 0,
    lastFoundAt: null,
    checkCount: RANK_NEVER_FOUND_MIN_CHECKS,
    foundCount: 0,
    lastMessage: "300위 이내 미노출",
  }, overrides || {}));
}

function foundTracker(overrides) {
  return activeTracker(Object.assign({
    neverFound: false,
    foundRate: 1,
    lastFoundAt: at(-HOUR),
    currentRank: 12,
    snapshots: [{ rank: 12, checkedAt: at(-HOUR) }, { rank: 15, checkedAt: at(-2 * HOUR) }],
  }, overrides || {}));
}

const HEALTHY_LANE = { lastSuccessAt: at(-10 * 60 * 1000), stalledMinutes: 10, queueStalled: false };
const STALLED_LANE = { lastSuccessAt: at(-700 * 60 * 1000), stalledMinutes: 700, queueStalled: true };

// ─────────────────────────────────────────────────────────────
// (a) 원부 확인 필요 배지·안내문
// ─────────────────────────────────────────────────────────────
test("C5a: 원부 안내 문구·배지가 admin·client 원본에 정확히 존재한다", () => {
  for (const [label, source] of PAGES) {
    assert.ok(source.includes(CATALOG_BADGE), `${label} must include ${CATALOG_BADGE}`);
    assert.ok(source.includes(CATALOG_NOTE), `${label} must include ${CATALOG_NOTE}`);
  }
});

test("C5a: rankTrackerCatalogHint 본문은 admin·client 가 바이트 동일하다", () => {
  const adminBody = htmlFunction(adminSource, "rankTrackerCatalogHint", "admin.html");
  const clientBody = htmlFunction(clientSource, "rankTrackerCatalogHint", "client.html");
  assert.ok(adminBody.length > 120, "추출 실패(빈 본문)로 단언이 무의미해지면 안 된다");
  assert.equal(adminBody, clientBody, "두 화면의 원부 판정이 갈라지면 안 된다");
});

test("C5a: rankTrackerCatalogHint 는 neverFound === true 에서만 배지·안내문을 낸다", () => {
  for (const [label, source] of PAGES) {
    const hint = catalogHint(source, label, neverFoundTracker({}));
    assert.ok(hint, `${label}: neverFound 추적은 안내가 있어야 한다`);
    assert.equal(hint.label, CATALOG_BADGE, label);
    assert.equal(hint.note, CATALOG_NOTE, label);
    assert.equal(hint.className, "is-warn", label);
    // 서버가 확정한 불리언만 믿는다 — 문자열 "true"·1·undefined 는 근거가 아니다.
    for (const value of [false, undefined, null, "true", 1, 0]) {
      assert.equal(
        catalogHint(source, label, activeTracker({ neverFound: value })),
        null,
        `${label}: neverFound=${JSON.stringify(value)} 는 안내가 없어야 한다`,
      );
    }
    assert.equal(catalogHint(source, label, null), null, `${label}: null 추적은 안내가 없어야 한다`);
  }
});

test("C5a: 카드 렌더는 배지와 안내문을 싣고 기존 점검 필요 배지는 그대로 병기한다", () => {
  for (const [label, source] of PAGES) {
    const html = cardHtml(source, label, neverFoundTracker({}));
    assert.ok(html.includes('data-rank-catalog-hint'), `${label}: 안내 요소 표식이 있어야 한다`);
    assert.ok(html.includes(">" + CATALOG_BADGE + "<"), `${label}: 배지가 자기 요소의 전체 텍스트여야 한다`);
    assert.ok(html.includes(CATALOG_NOTE), `${label}: 안내문이 있어야 한다`);
    // URL 은 escapeHtml 을 거쳐도 그대로 읽혀야 한다(슬래시·콜론은 이스케이프 대상이 아니다).
    assert.ok(html.includes("https://search.shopping.naver.com/catalog/"), `${label}: 원부 URL 형태가 보여야 한다`);
    // 기존 로직: 300위 이내 미노출(latest 없음) → "점검 필요" 는 그대로 남는다.
    assert.ok(html.includes(">점검 필요<"), `${label}: 기존 점검 필요 배지가 유지돼야 한다`);
    assert.equal((html.match(new RegExp(CATALOG_BADGE, "g")) || []).length, 1, `${label}: 배지는 한 번만 나온다`);
  }
});

test("C5a: neverFound 가 아니면 카드에 원부 문구가 한 글자도 없다", () => {
  for (const [label, source] of PAGES) {
    for (const tracker of [foundTracker({}), activeTracker({}), neverFoundTracker({ neverFound: false })]) {
      const html = cardHtml(source, label, tracker);
      assert.equal(html.includes(CATALOG_BADGE), false, `${label}: 원부 배지가 붙으면 안 된다`);
      assert.equal(html.includes(CATALOG_NOTE), false, `${label}: 원부 안내문이 붙으면 안 된다`);
      assert.equal(html.includes("data-rank-catalog-hint"), false, `${label}: 안내 요소가 없어야 한다`);
    }
    // 정상 발견 추적은 점검 필요도 아니다(기존 인사이트 로직 보존).
    assert.equal(cardHtml(source, label, foundTracker({})).includes("점검 필요"), false, label);
  }
});

test("C5a: 잠금 함수(initRankTracking·initPlaceRankTracking)는 원부 코드를 품지 않는다", () => {
  for (const [label, source] of PAGES) {
    for (const name of ["initRankTracking", "initPlaceRankTracking"]) {
      const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
      assert.ok(match, `${label}: ${name} 을 찾지 못했다`);
      // 다음 6칸 들여쓰기 함수 선언까지를 근사 블록으로 본다(중첩 함수는 8칸 이상이다).
      const next = source.indexOf("\n      function ", match.index + 1);
      const block = source.slice(match.index, next > 0 ? next : source.length);
      assert.ok(block.length > 1000, `${label} ${name}: 추출 블록이 너무 작다`);
      for (const marker of [CATALOG_BADGE, "rankTrackerCatalogHint", "data-rank-catalog-hint"]) {
        assert.equal(block.includes(marker), false, `${label} ${name} 안에 ${marker} 가 있으면 안 된다`);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────
// (b) 등록 폼 placeholder·도움말
// ─────────────────────────────────────────────────────────────
test("C5b: 추적 등록 URL 입력의 placeholder 와 도움말이 원부 URL 을 명시한다", () => {
  for (const [label, source] of PAGES) {
    const inputs = [...source.matchAll(/<input[^>]*data-rank-url[^>]*>/g)].map((m) => m[0]);
    assert.equal(inputs.length, 1, `${label}: data-rank-url 입력은 정확히 1개여야 한다`);
    const placeholder = /placeholder="([^"]*)"/.exec(inputs[0]);
    assert.ok(placeholder, `${label}: placeholder 가 없다`);
    assert.ok(placeholder[1].includes(URL_FIELD_HINT), `${label}: placeholder 가 원부 URL 을 명시해야 한다 (실제: ${placeholder[1]})`);
    const statuses = [...source.matchAll(/<p[^>]*data-rank-status[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);
    assert.equal(statuses.length, 1, `${label}: data-rank-status 도움말은 정확히 1개여야 한다`);
    assert.ok(statuses[0].includes(URL_FIELD_HINT), `${label}: 도움말이 원부 URL 을 명시해야 한다 (실제: ${statuses[0]})`);
  }
});

// ─────────────────────────────────────────────────────────────
// (c) 레인 배너(총관리자)
// ─────────────────────────────────────────────────────────────
test("C5c: 화면 상수 RANK_STUCK_TRACKER_HOURS · RANK_NEVER_FOUND_MIN_CHECKS 는 서버와 같다", () => {
  assert.equal(parseNumberLiteral(adminSource, "admin.html", "RANK_STUCK_TRACKER_HOURS"), RANK_STUCK_TRACKER_HOURS);
  assert.equal(parseNumberLiteral(adminSource, "admin.html", "RANK_NEVER_FOUND_MIN_CHECKS"), RANK_NEVER_FOUND_MIN_CHECKS);
});

test("C5c: 신호 기본값은 레인 둘 다 정상·추적기 집계 0 이고 배너 조건이 서지 않는다", () => {
  const summary = stallSummary([activeTracker({})]);
  assert.equal(summary.productLaneStalled, false);
  assert.equal(summary.placeLaneStalled, false);
  assert.equal(summary.neverFoundTrackers, 0);
  assert.equal(summary.stuckTrackers, 0);
  assert.equal(summary.total, 0);
  const product = opsSummaryHtml([activeTracker({})]);
  const place = opsSummaryHtml([activeTracker({})], { place: true });
  assert.equal(product.includes("data-rank-stall-banner"), false);
  assert.equal(place.includes("data-rank-stall-banner"), false);
  assert.equal(product.includes(PRODUCT_LANE_NOUN), false, "정상이면 레인 문장이 없다");
  assert.equal(place.includes(PLACE_LANE_NOUN), false, "정상이면 레인 문장이 없다");
});

test("C5c: 레인 정체는 서버 queueStalled 불리언만 믿고 total 을 레인당 1 올린다", () => {
  const productOnly = stallSummary([activeTracker({})], { health: { lanes: { product: STALLED_LANE, place: HEALTHY_LANE } } });
  assert.equal(productOnly.productLaneStalled, true);
  assert.equal(productOnly.placeLaneStalled, false);
  assert.equal(productOnly.total, 1);
  const both = stallSummary([activeTracker({})], { health: { lanes: { product: STALLED_LANE, place: STALLED_LANE } } });
  assert.equal(both.total, 2);
  // "true" 문자열·1 은 근거가 아니다.
  const loose = stallSummary([activeTracker({})], { health: { lanes: { product: { queueStalled: "true" }, place: { queueStalled: 1 } } } });
  assert.equal(loose.productLaneStalled, false);
  assert.equal(loose.placeLaneStalled, false);
  assert.equal(loose.total, 0);
  // lanes 자체가 없거나 깨져도 던지지 않는다.
  for (const lanes of [null, "x", 3, {}, { product: null }]) {
    const summary = stallSummary([activeTracker({})], { health: { lanes } });
    assert.equal(summary.productLaneStalled, false, JSON.stringify(lanes));
    assert.equal(summary.placeLaneStalled, false, JSON.stringify(lanes));
  }
});

test("C5c: 살아 있는 cooldown 에서는 레인 정체 문장을 억제한다(기존 억제 규약과 동일)", () => {
  const summary = stallSummary([activeTracker({})], {
    workerStatus: { state: "cooldown", retryAt: at(HOUR) },
    health: { lanes: { product: STALLED_LANE, place: HEALTHY_LANE } },
  });
  assert.equal(summary.deliberateStop, true);
  assert.equal(summary.productLaneStalled, false);
  assert.equal(summary.total, 0);
});

test("C5c: 추적기 집계는 비음수 정수만 받고 나머지는 0 이다", () => {
  const ok = stallSummary([activeTracker({})], { health: { trackers: { neverFound: 2, stuck: 1 } } });
  assert.equal(ok.neverFoundTrackers, 2);
  assert.equal(ok.stuckTrackers, 1);
  // 집계 단독으로는 배너 조건이 서지 않는다(요약은 덧붙이는 줄이지 경보가 아니다).
  assert.equal(ok.total, 0);
  for (const value of [-1, NaN, null, "3", Infinity, 2.7]) {
    const summary = stallSummary([activeTracker({})], { health: { trackers: { neverFound: value, stuck: value } } });
    const expected = value === 2.7 ? 2 : (value === "3" ? 3 : 0);
    assert.equal(summary.neverFoundTrackers, expected, `neverFound=${String(value)}`);
    assert.equal(summary.stuckTrackers, expected, `stuck=${String(value)}`);
  }
});

test("C5c: 상품 레인 정체는 배너를 열고 두 레인을 각각 문장으로 적는다", () => {
  const health = { lanes: { product: STALLED_LANE, place: HEALTHY_LANE } };
  for (const place of [false, true]) {
    const html = opsSummaryHtml([activeTracker({})], { place, health });
    const lane = place ? "place" : "product";
    assert.ok(html.includes("data-rank-stall-banner"), `${lane}: 레인 정체만으로 배너가 열려야 한다`);
    assert.ok(html.includes("data-rank-lane-line=\"product\""), `${lane}: 상품 레인 문장이 있어야 한다`);
    assert.ok(html.includes("data-rank-lane-line=\"place\""), `${lane}: 플레이스 레인 문장이 있어야 한다`);
    assert.ok(html.includes(PRODUCT_LANE_NOUN + " 큐가 정체 상태입니다"), `${lane}: 상품 레인 정체 문장`);
    assert.ok(html.includes("마지막 성공 700분 전"), `${lane}: 서버 stalledMinutes 를 그대로 적는다`);
    assert.ok(html.includes(PLACE_LANE_NOUN + " 큐는 정상입니다"), `${lane}: 정상 레인도 문장으로 적는다`);
    assert.ok(html.includes("마지막 성공 10분 전"), `${lane}: 정상 레인의 마지막 성공도 적는다`);
    // 기존 머리글(재시도 소진/수집 멈춤)은 성립하지 않으므로 중립 머리글이어야 한다.
    assert.ok(html.includes("수집기 상태를 확인해주세요"));
    assert.equal(html.includes("재시도가 소진된 추적이 있습니다"), false);
  }
});

test("C5c: 플레이스 레인 정체도 같은 규약으로 문장이 갈린다", () => {
  const health = { lanes: { product: HEALTHY_LANE, place: STALLED_LANE } };
  const html = opsSummaryHtml([activeTracker({})], { place: true, health });
  assert.ok(html.includes("data-rank-stall-banner"));
  assert.ok(html.includes(PLACE_LANE_NOUN + " 큐가 정체 상태입니다"));
  assert.ok(html.includes(PRODUCT_LANE_NOUN + " 큐는 정상입니다"));
  // 플레이스는 서버 크론 수집이므로 윈도우 워커·맥 크롬을 언급하면 안 된다.
  assert.equal(html.includes("윈도우 워커"), false);
  assert.equal(html.includes("맥 크롬"), false);
});

test("C5c: 마지막 성공 기록이 없는 레인은 시각을 지어내지 않는다", () => {
  const health = { lanes: { product: { lastSuccessAt: null, stalledMinutes: 0, queueStalled: true }, place: HEALTHY_LANE } };
  const html = opsSummaryHtml([activeTracker({})], { health });
  assert.ok(html.includes(PRODUCT_LANE_NOUN + " 큐가 정체 상태입니다"));
  assert.ok(html.includes("성공 기록 없음"), "lastSuccessAt null 은 '기록 없음'으로 적는다");
  assert.equal(html.includes("마지막 성공 0분 전"), false, "0분 전이라는 거짓 시각을 만들면 안 된다");
});

test("C5c: 추적기 요약 줄은 상품 레인에서만, 다른 신호로 배너가 열렸을 때만 덧붙는다", () => {
  const stalled = { lanes: { product: STALLED_LANE, place: HEALTHY_LANE }, trackers: { neverFound: 2, stuck: 1 } };
  const product = opsSummaryHtml([activeTracker({})], { health: stalled });
  assert.ok(product.includes("data-rank-tracker-summary"), "요약 줄 표식이 있어야 한다");
  assert.ok(product.includes(CATALOG_BADGE + " 2개"), "neverFound 건수를 적는다");
  assert.ok(product.includes(RANK_STUCK_TRACKER_HOURS + "시간 넘게 멈춘 추적기 1개"), "stuck 건수를 적는다");

  // 플레이스 레인은 상품 추적기 집계를 말하지 않는다.
  const place = opsSummaryHtml([activeTracker({})], { place: true, health: stalled });
  assert.ok(place.includes("data-rank-stall-banner"));
  assert.equal(place.includes("data-rank-tracker-summary"), false);
  assert.equal(place.includes(CATALOG_BADGE), false);

  // 집계 단독(레인 둘 다 정상)으로는 배너가 열리지 않는다.
  const alone = opsSummaryHtml([activeTracker({})], { health: { lanes: { product: HEALTHY_LANE, place: HEALTHY_LANE }, trackers: { neverFound: 5, stuck: 3 } } });
  assert.equal(alone.includes("data-rank-stall-banner"), false);
  assert.equal(alone.includes("data-rank-tracker-summary"), false);

  // 0 이면 요약 줄 자체가 없다.
  const zero = opsSummaryHtml([activeTracker({})], { health: { lanes: { product: STALLED_LANE, place: HEALTHY_LANE }, trackers: { neverFound: 0, stuck: 0 } } });
  assert.ok(zero.includes("data-rank-stall-banner"));
  assert.equal(zero.includes("data-rank-tracker-summary"), false);

  // 한쪽만 0 초과면 그쪽만 적는다.
  const onlyStuck = opsSummaryHtml([activeTracker({})], { health: { lanes: { product: STALLED_LANE, place: HEALTHY_LANE }, trackers: { neverFound: 0, stuck: 4 } } });
  assert.ok(onlyStuck.includes(RANK_STUCK_TRACKER_HOURS + "시간 넘게 멈춘 추적기 4개"));
  assert.equal(onlyStuck.includes(CATALOG_BADGE), false);
});

test("C5c: refreshRankCollectionHealthSignal 은 lanes·trackers 를 안전값으로 정규화해 싣는다", () => {
  const block = htmlFunction(adminSource, "refreshRankCollectionHealthSignal");
  assert.ok(block.includes("lanes:"), "next 에 lanes 가 있어야 한다");
  assert.ok(block.includes("trackers:"), "next 에 trackers 가 있어야 한다");
  // 정규화 헬퍼를 실제로 실행해 확인한다.
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    stallConstantsBlock(),
    htmlFunction(adminSource, "rankCollectionHealthLane"),
    htmlFunction(adminSource, "rankCollectionHealthCount"),
  ].join("\n\n"), context);
  const lane = (value) => {
    context.__value = value;
    // 다른 realm 의 객체는 deepEqual(strict) 이 프로토타입 차이로 실패하므로 값만 옮긴다.
    return JSON.parse(JSON.stringify(vm.runInContext("rankCollectionHealthLane(__value)", context)));
  };
  assert.deepEqual(lane(null), { lastSuccessAt: null, stalledMinutes: 0, queueStalled: false });
  assert.deepEqual(lane("x"), { lastSuccessAt: null, stalledMinutes: 0, queueStalled: false });
  assert.deepEqual(lane({ lastSuccessAt: "2026-09-01T00:00:00.000Z", stalledMinutes: 12.9, queueStalled: true }), {
    lastSuccessAt: "2026-09-01T00:00:00.000Z",
    stalledMinutes: 12,
    queueStalled: true,
  });
  assert.deepEqual(lane({ lastSuccessAt: 123, stalledMinutes: -5, queueStalled: "true" }), { lastSuccessAt: null, stalledMinutes: 0, queueStalled: false });
  const count = (value) => {
    context.__value = value;
    return vm.runInContext("rankCollectionHealthCount(__value)", context);
  };
  assert.equal(count(3), 3);
  assert.equal(count("4"), 4);
  assert.equal(count(2.9), 2);
  for (const value of [-1, NaN, null, undefined, Infinity, "x"]) assert.equal(count(value), 0, String(value));
});

// ─────────────────────────────────────────────────────────────
// (d) 총관리자 카운터 타일
// ─────────────────────────────────────────────────────────────
test("C5d: ownerHealthTrackerRows 는 두 집계를 행으로 내고 조회 실패는 단정하지 않는다", () => {
  const rows = ownerRows({ neverFoundTrackers: { count: 2, error: null }, stuckTrackers: { count: 1, error: null } });
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes("<span>" + CATALOG_BADGE + " 추적기</span>"), rows[0]);
  assert.ok(rows[0].includes("<strong>2개</strong>"), rows[0]);
  assert.ok(rows[1].includes("<span>" + RANK_STUCK_TRACKER_HOURS + "시간 넘게 멈춘 추적기</span>"), rows[1]);
  assert.ok(rows[1].includes("<strong>1개</strong>"), rows[1]);
  for (const row of rows) assert.ok(row.startsWith('<div class="mi-row">') && row.endsWith("</div>"), row);

  // 조회 실패({count:null,error}) 는 0 으로 위장하지 않는다.
  const failed = ownerRows({ neverFoundTrackers: { count: null, error: "timeout" }, stuckTrackers: { count: 0, error: null } });
  assert.ok(failed[0].includes("<strong>조회 실패</strong>"), failed[0]);
  assert.equal(failed[0].includes("timeout"), false, "오류 원문은 화면에 싣지 않는다");
  assert.ok(failed[1].includes("<strong>0개</strong>"), failed[1]);

  // health 가 없으면(구 서버) 행을 만들지 않는다.
  for (const value of [null, undefined, "x", {}]) {
    assert.deepEqual(ownerRows(value), [], JSON.stringify(value));
  }
});

// ─────────────────────────────────────────────────────────────
// (e) 연결 전 코드로 등록된 추적기 (F17)
// 운영팀이 광고주 연결 전 팀코드로 등록한 추적기는 어느 화면에도 뜨지 않으면서
// 수집만 계속된다. 총관리자 요약이 건수와 조회 경로를 함께 내야 한다.
// ─────────────────────────────────────────────────────────────
test("C5e: 연결 전 코드 건수와 조회 경로가 총관리자 집계 뒤에 붙는다", () => {
  const rows = ownerRows({
    neverFoundTrackers: { count: 0, error: null },
    stuckTrackers: { count: 0, error: null },
    unlinkedScopeTrackers: {
      count: 3,
      error: null,
      codes: [
        { agencyCode: "MML93-T01", teamName: "운영팀 1", teamStatus: "active", trackerCount: 2 },
        { agencyCode: "mml93-t02", teamName: "운영팀 2", teamStatus: "revoked", trackerCount: 1 },
      ],
    },
  });
  assert.equal(rows.length, 5);
  assert.ok(rows[2].includes("<span>연결 전 코드로 등록된 추적기</span>"), rows[2]);
  assert.ok(rows[2].includes("<strong>3개</strong>"), rows[2]);
  assert.ok(rows[3].includes("mml93-t01 2건"), rows[3]);
  assert.ok(rows[3].includes("mml93-t02 1건"), rows[3]);
  assert.ok(rows[4].includes("대상 코드 칸"), rows[4]);
  for (const row of rows) assert.ok(row.startsWith('<div class="mi-row">') && row.endsWith("</div>"), row);

  // 0건이면 건수 행만 남고 안내 행은 붙지 않는다.
  const empty = ownerRows({
    neverFoundTrackers: { count: 0, error: null },
    stuckTrackers: { count: 0, error: null },
    unlinkedScopeTrackers: { count: 0, error: null, codes: [] },
  });
  assert.equal(empty.length, 3);
  assert.ok(empty[2].includes("<strong>0개</strong>"), empty[2]);

  // 조회 실패는 0 으로 위장하지 않고, 코드가 없으면 안내도 없다.
  const failed = ownerRows({
    neverFoundTrackers: { count: 0, error: null },
    stuckTrackers: { count: 0, error: null },
    unlinkedScopeTrackers: { count: null, error: "relation does not exist", codes: [] },
  });
  assert.equal(failed.length, 3);
  assert.ok(failed[2].includes("<strong>조회 실패</strong>"), failed[2]);
  assert.equal(failed[2].includes("relation"), false, "오류 원문은 화면에 싣지 않는다");
});

test("C5d: renderOwnerCodeList 는 운영팀·광고주 행 뒤에 집계 행을 잇는다", () => {
  const block = htmlFunction(adminSource, "renderOwnerCodeList");
  assert.ok(block.includes("ownerHealthTrackerRows(payload && payload.health)"), "집계 행 호출이 있어야 한다");
  const teamRow = block.indexOf("팀 운영 중");
  const clientRow = block.indexOf("곳 운영 중");
  const healthRow = block.indexOf("ownerHealthTrackerRows(");
  assert.ok(teamRow > 0 && clientRow > teamRow && healthRow > clientRow, "행 순서: 운영팀 → 광고주 → 집계");
});

// ─────────────────────────────────────────────────────────────
// (c) 리뷰 반영 — 폴링 재조회 폭주 방지
// ─────────────────────────────────────────────────────────────
// refreshRankCollectionHealthSignal 을 fetch·document·window 스텁 위에서 실제로 실행한다.
// 서버 lanes.<key>.stalledMinutes 는 수집 사이클 사이에 매 분 1씩 오르므로, 그 값을
// changed 판정에 넣으면 60초 폴링마다 mi:rank-scope-changed 가 발행돼 목록 재조회가
// 무한히 돈다(함수 위 주석이 금지한 상황). 렌더 분기에 쓰이는 값만 대조해야 한다.
async function refreshSandboxRun(payloads) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; };`, context);
  vm.runInContext([
    stallConstantsBlock(),
    htmlFunction(adminSource, "refreshRankCollectionHealthSignal"),
  ].join("\n\n"), context);
  const dispatched = [];
  context.__payloads = payloads.map((payload) => JSON.stringify(payload));
  vm.runInContext(`
    var __calls = 0;
    function CustomEvent(type) { this.type = type; }
    var document = { querySelector: function () { return {}; } };
    var window = { dispatchEvent: function (event) { __dispatched.push(event.type); } };
    var fetch = function () {
      var body = __payloads[__calls];
      __calls += 1;
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(JSON.parse(body)); } });
    };
  `, context);
  context.__dispatched = dispatched;
  for (let i = 0; i < payloads.length; i += 1) {
    await vm.runInContext("refreshRankCollectionHealthSignal()", context);
  }
  return { dispatched, signal: JSON.parse(JSON.stringify(vm.runInContext("rankCollectionHealthSignal", context))) };
}

function healthPayload(overrides) {
  return Object.assign({
    ok: true,
    workerOutdated: false,
    heartbeatAgeMinutes: 0,
    lanes: {
      product: { lastSuccessAt: at(-10 * 60 * 1000), stalledMinutes: 10, queueStalled: false },
      place: { lastSuccessAt: at(-12 * 60 * 1000), stalledMinutes: 12, queueStalled: false },
    },
    trackers: { neverFound: 2, stuck: 0 },
  }, overrides || {});
}

test("C5c(리뷰): stalledMinutes 만 오른 payload 를 거듭 넣어도 재조회 이벤트가 다시 발행되지 않는다", async () => {
  const base = healthPayload();
  const minuteLater = healthPayload({
    lanes: {
      product: { lastSuccessAt: base.lanes.product.lastSuccessAt, stalledMinutes: 11, queueStalled: false },
      place: { lastSuccessAt: base.lanes.place.lastSuccessAt, stalledMinutes: 13, queueStalled: false },
    },
  });
  const twoMinutesLater = healthPayload({
    lanes: {
      product: { lastSuccessAt: base.lanes.product.lastSuccessAt, stalledMinutes: 12, queueStalled: false },
      place: { lastSuccessAt: base.lanes.place.lastSuccessAt, stalledMinutes: 14, queueStalled: false },
    },
  });
  const result = await refreshSandboxRun([base, minuteLater, twoMinutesLater]);
  // 첫 응답은 기본값(ok:false, trackers 0)과 다르므로 1회 발행된다. 그 뒤 분 단위 증가는 무시한다.
  assert.deepEqual(result.dispatched, ["mi:rank-scope-changed"]);
  // 신호 사본 자체는 최신 값으로 갱신된다(발행만 억제한다).
  assert.equal(result.signal.lanes.product.stalledMinutes, 12);
  assert.equal(result.signal.lanes.place.stalledMinutes, 14);
});

test("C5c(리뷰): 레인 queueStalled 가 뒤집히거나 추적기 집계가 바뀌면 재조회 이벤트가 발행된다", async () => {
  const base = healthPayload();
  const productStalled = healthPayload({
    lanes: {
      product: { lastSuccessAt: base.lanes.product.lastSuccessAt, stalledMinutes: 700, queueStalled: true },
      place: base.lanes.place,
    },
  });
  const flipped = await refreshSandboxRun([base, productStalled]);
  assert.deepEqual(flipped.dispatched, ["mi:rank-scope-changed", "mi:rank-scope-changed"]);

  const moreNeverFound = healthPayload({ trackers: { neverFound: 3, stuck: 0 } });
  const counted = await refreshSandboxRun([base, moreNeverFound]);
  assert.deepEqual(counted.dispatched, ["mi:rank-scope-changed", "mi:rank-scope-changed"]);

  // 마지막 성공 기록이 없음 → 생김 은 문장("성공 기록 없음")이 바뀌므로 발행한다.
  const noRecord = healthPayload({
    lanes: { product: { lastSuccessAt: null, stalledMinutes: 0, queueStalled: false }, place: base.lanes.place },
  });
  const recorded = await refreshSandboxRun([noRecord, base]);
  assert.deepEqual(recorded.dispatched, ["mi:rank-scope-changed", "mi:rank-scope-changed"]);

  // 완전히 같은 payload 두 번은 1회다(기존 규약).
  const same = await refreshSandboxRun([base, base]);
  assert.deepEqual(same.dispatched, ["mi:rank-scope-changed"]);
});

test("C5c(리뷰): refresh 의 changed 판정은 stalledMinutes 를 읽지 않는다", () => {
  const block = htmlFunction(adminSource, "refreshRankCollectionHealthSignal");
  const from = block.indexOf("var changed =");
  assert.ok(from >= 0, "changed 판정을 찾지 못했다");
  const to = block.indexOf(";", from);
  const clause = block.slice(from, to);
  assert.equal(clause.includes("stalledMinutes"), false, clause);
  assert.equal(/JSON\.stringify\([^)]*lanes/.test(clause), false, "lanes 전체 JSON 비교는 분 단위 증가까지 비교한다: " + clause);
});

// ─────────────────────────────────────────────────────────────
// (d) 리뷰 반영 — 활성 계정 카드 설명문이 추적기 집계 행과 어긋나지 않는다
// ─────────────────────────────────────────────────────────────
test("C5d(리뷰): 활성 계정 카드 설명문(정적·총관리자 모드)이 추적기 집계를 언급한다", () => {
  const staticDesc = adminSource.match(/<p data-owner-list-desc>([^<]*)<\/p>/);
  assert.ok(staticDesc, "정적 설명문을 찾지 못했다");
  assert.ok(staticDesc[1].includes("추적기 집계"), staticDesc[1]);
  assert.ok(staticDesc[1].includes("운영팀"), staticDesc[1]);

  const block = htmlFunction(adminSource, "setOwnerPanelMode");
  const from = block.indexOf("listDesc.textContent = ownerMode");
  assert.ok(from >= 0, "setOwnerPanelMode 의 설명문 대입을 찾지 못했다");
  const ownerDesc = block.slice(from, block.indexOf(":", from));
  assert.ok(ownerDesc.includes("추적기 집계"), ownerDesc);
  // 운영팀 모드 설명문(집계 행이 없는 화면)은 그대로다.
  assert.ok(block.includes("현재 운영팀에 연결된 광고주 상태입니다."));
});

// 수집 경보 UI 3종 회귀 테스트.
//
//   H1b — 수집기 구버전 경고 줄(윈도우 워커 구버전)
//   H2  — 수집기 하트비트 신호 지연 줄
//   H3  — 만성 실패 격리 배지/타일(수집 방식 점검 중)
//
// 규약은 scripts/rank-collection-stability.test.mjs 와 같다: 화면 원본(admin.html /
// client.html)에서 함수·상수 블록을 그대로 떼어 vm 에서 실행하고, 문구는 grep 이 아니라
// 실행 결과 HTML 로 확인한다. 상수는 서버 모듈(src/server/naver-rank-requeue.mjs)을
// 진실의 근원으로 두고 화면 사본과 대조한다(드리프트 가드).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  RANK_CHRONIC_ISOLATION_DAYS,
  RANK_CHRONIC_ISOLATION_MARKER,
  RANK_CHRONIC_ISOLATION_MS,
  RANK_RETRY_EXHAUSTED_AT,
} from "../src/server/naver-rank-requeue.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readRepoFile = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");

const adminSource = readRepoFile("src/pages/admin.html");
const clientSource = readRepoFile("src/pages/client.html");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

// 기대 문자열은 테스트 안에서 직접 조립한다. 페이지가 닮은꼴 대시(–, −, -)를 쓰면
// 여기서 만든 U+2014 문자열과 불일치해 실패한다.
const EM_DASH = "—";
const WORKER_OUTDATED_LINE = "수집기 업데이트 필요 " + EM_DASH + " 윈도우 워커가 구버전입니다";
const HEARTBEAT_PREFIX = "수집기 신호가";
const ISOLATION_LABEL = "수집 방식 점검 중";
const WORKER_NOUN = "윈도우 워커";

// ─────────────────────────────────────────────────────────────
// 공용 추출기 (rank-collection-stability.test.mjs 와 동일 규약)
// ─────────────────────────────────────────────────────────────
const PAGE_FUNCTION_CLOSE = "\n      }";

function pageFunction(name) {
  const marker = `\n      function ${name}(`;
  const from = adminSource.indexOf(marker);
  assert.ok(from >= 0, `page function not found: ${name}`);
  const to = adminSource.indexOf(PAGE_FUNCTION_CLOSE + "\n", from);
  assert.ok(to > from, `page function end not found: ${name}`);
  return adminSource.slice(from + 1, to + PAGE_FUNCTION_CLOSE.length);
}

// admin/client 어느 페이지에서든 같은 규약(6칸 들여쓰기)으로 함수를 떼어 낸다.
function htmlFunction(source, name, label) {
  const marker = `\n      function ${name}(`;
  const from = source.indexOf(marker);
  assert.ok(from >= 0, `page function not found: ${name} (${label || ""})`);
  const to = source.indexOf(PAGE_FUNCTION_CLOSE + "\n", from);
  assert.ok(to > from, `page function end not found: ${name} (${label || ""})`);
  return source.slice(from + 1, to + PAGE_FUNCTION_CLOSE.length);
}

// 상수 선언은 함수 밖이라 함수 추출기로 잡히지 않는다. 선언 블록을 그대로 떼어 낸다.
// 이 슬라이스 안에 rankTrackerAutoRequeued · rankTrackerChronicIsolated ·
// rankCollectionStallSummary · rankCollectionHealthSignal 이 모두 들어 있다.
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

// client.html 에는 정체 요약이 없다. 격리 판정에 필요한 상수 4개만 떼어 낸다.
function clientIsolationConstants() {
  const startMarker = "      var RANK_RETRY_EXHAUSTED_AT = 8;";
  const endMarker = "\n      function rankTrackerChronicIsolated(";
  const from = clientSource.indexOf(startMarker);
  assert.ok(from >= 0, "client isolation constants block not found");
  const to = clientSource.indexOf(endMarker, from);
  assert.ok(to > from, "client isolation constants block end not found");
  const block = clientSource.slice(from, to);
  // 빈 슬라이스가 조용히 통과하지 못하도록 4개 상수가 실제로 들어 있는지 확인한다.
  for (const name of [
    "RANK_RETRY_EXHAUSTED_AT",
    "RANK_CHRONIC_ISOLATION_DAYS",
    "RANK_CHRONIC_ISOLATION_MS",
    "RANK_CHRONIC_ISOLATION_LABEL",
  ]) {
    assert.ok(block.includes(`var ${name} = `), `client 상수 슬라이스에 ${name} 이 없다`);
  }
  return block;
}

// scripts/check-protected-rank-features.mjs:48-99 의 중괄호 매칭 스캐너 사본.
// 따옴표·이스케이프·// 주석·/* */ 주석을 모두 건너뛴다.
function functionBlock(source, name) {
  const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`함수 잠금 대상을 찾을 수 없습니다: ${name}`);
  const open = source.indexOf("{", match.index);
  if (open < 0) throw new Error(`함수 본문을 찾을 수 없습니다: ${name}`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`함수 끝을 찾을 수 없습니다: ${name}`);
}

function parseNumberLiteral(source, label, name) {
  const hits = [...source.matchAll(new RegExp(`var ${name} = (\\d+);`, "g"))];
  assert.equal(hits.length, 1, `${label}: var ${name} 선언은 정확히 1개여야 한다`);
  return Number(hits[0][1]);
}

function parseStringLiteral(source, label, name) {
  const hits = [...source.matchAll(new RegExp(`var ${name} = "([^"]+)";`, "g"))];
  assert.equal(hits.length, 1, `${label}: var ${name} 선언은 정확히 1개여야 한다`);
  return hits[0][1];
}

// ─────────────────────────────────────────────────────────────
// 샌드박스
// ─────────────────────────────────────────────────────────────
function applyHealth(context, health) {
  if (!health) return;
  const script = Object.keys(health)
    .map((key) => `rankCollectionHealthSignal.${key} = ${JSON.stringify(health[key])};`)
    .join(" ");
  vm.runInContext(script, context);
}

// 정체 계산은 Date.now() 를 읽으므로 샌드박스 안에서 시계를 고정한다.
function stallSandbox(health) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; };`, context);
  vm.runInContext(stallConstantsBlock(), context);
  applyHealth(context, health);
  return context;
}

function stallSummary(trackers, options = {}) {
  const context = stallSandbox(options.health);
  context.__trackers = trackers;
  context.__workerStatus = options.workerStatus || null;
  return vm.runInContext("rankCollectionStallSummary(__trackers, __workerStatus)", context);
}

function opsSummarySandbox(health) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; };`, context);
  vm.runInContext([
    stallConstantsBlock(),
    pageFunction("rankTrackerOpsSummary"),
    pageFunction("escapeHtml"),
    pageFunction("formatRankShortAt"),
    pageFunction("rankTrackerRankValue"),
    pageFunction("rankTrackerLatestRank"),
    pageFunction("placeTrackerLatestRank"),
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
  assert.ok(html.length > 200, "렌더 결과가 비어 있으면 뒤 단언이 무의미해진다");
  return html;
}

// needsAttention 은 전역 플래그로 제어한다(항상 true 인 스텁은 분기를 덮어 버린다).
// admin 은 상수 슬라이스가 격리 판정을 품고 있고, client 는 상수 4개 + 격리 함수를
// 따로 이어 붙여 같은 조건을 만든다.
function insightSandbox(source, label, name, needsAttentionName, trendName, latestName) {
  const preamble = source === adminSource
    ? stallConstantsBlock()
    : [clientIsolationConstants(), htmlFunction(source, "rankTrackerChronicIsolated", label)].join("\n\n");
  const context = {};
  vm.createContext(context);
  context.__needsAttention = true;
  vm.runInContext(`Date.now = function () { return ${NOW}; };`, context);
  vm.runInContext([
    preamble,
    htmlFunction(source, name, label),
    `function ${needsAttentionName}() { return __needsAttention === true; }`,
    `function ${trendName}() { return "dropped"; }`,
    `function ${latestName}() { return 1; }`,
  ].join("\n\n"), context);
  return context;
}

function chronicSandbox(source, label) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; };`, context);
  const body = source === adminSource
    ? stallConstantsBlock()
    : [clientIsolationConstants(), htmlFunction(source, "rankTrackerChronicIsolated", label)].join("\n\n");
  vm.runInContext(body, context);
  return context;
}

const CHRONIC_PAGES = [["admin.html", adminSource], ["client.html", clientSource]];

function chronicIsolated(source, label, tracker, now = NOW) {
  const context = chronicSandbox(source, label);
  context.__tracker = tracker;
  return vm.runInContext(`rankTrackerChronicIsolated(__tracker, ${now})`, context);
}

// ─────────────────────────────────────────────────────────────
// 픽스처
// ─────────────────────────────────────────────────────────────
function activeTracker(overrides) {
  return Object.assign({
    status: "active",
    nextCheckAt: at(HOUR),
    lastCheckedAt: at(-HOUR),
    lastError: null,
    retryCount: 0,
    lastMessage: "",
  }, overrides || {});
}

// 재시도 소진 + 3일 이상 성공 도장 없음 = 만성 격리.
function isolatedTracker(overrides) {
  return activeTracker(Object.assign({
    lastError: "수집 실패",
    retryCount: RANK_RETRY_EXHAUSTED_AT,
    lastCheckedAt: at(-4 * DAY),
  }, overrides || {}));
}

// 소진은 됐지만 최근 수집이 있어 격리는 아닌 추적(격리 타일 0 을 만들 때 쓴다).
function parkedRecentTracker(overrides) {
  return activeTracker(Object.assign({
    lastError: "수집 실패",
    retryCount: RANK_RETRY_EXHAUSTED_AT,
    lastCheckedAt: at(-HOUR),
  }, overrides || {}));
}

// ─────────────────────────────────────────────────────────────
// (1) 소스 문자열 단언
// ─────────────────────────────────────────────────────────────
test("H1b: 구버전 경고 문구가 U+2014 em-dash 로 admin.html 에 정확히 존재한다", () => {
  assert.equal(EM_DASH.codePointAt(0), 0x2014, "기대 문자열의 대시가 U+2014 여야 한다");
  assert.ok(adminSource.includes(WORKER_OUTDATED_LINE), `admin.html must include ${WORKER_OUTDATED_LINE}`);
  // 닮은꼴 대시로 바뀌면 위 단언이 실패한다. 반대 방향(닮은꼴이 들어와 있음)도 함께 막는다.
  for (const [name, dash] of [["en-dash", "–"], ["minus", "−"], ["hyphen", "-"], ["horizontal-bar", "―"]]) {
    const lookalike = "수집기 업데이트 필요 " + dash + " 윈도우 워커가 구버전입니다";
    assert.equal(adminSource.includes(lookalike), false, `${name} 대시 변형이 남아 있으면 안 된다`);
  }
  // 하트비트 문장의 접두사도 원본에 있어야 한다.
  assert.ok(adminSource.includes(HEARTBEAT_PREFIX), `admin.html must include ${HEARTBEAT_PREFIX}`);
});

test("H3: 격리 배지 라벨이 admin.html·client.html 양쪽에 그대로 있다", () => {
  assert.ok(adminSource.includes(ISOLATION_LABEL), `admin.html must include ${ISOLATION_LABEL}`);
  assert.ok(clientSource.includes(ISOLATION_LABEL), `client.html must include ${ISOLATION_LABEL}`);
  // 서버 MARKER 와 화면 LABEL 은 이름만 다르고 값은 같아야 한다.
  assert.equal(ISOLATION_LABEL, RANK_CHRONIC_ISOLATION_MARKER);
});

// ─────────────────────────────────────────────────────────────
// (2) 서버 대비 드리프트 가드
// ─────────────────────────────────────────────────────────────
test("H3: 격리 상수는 admin·client·서버가 완전히 같은 값이다", () => {
  const pages = [["admin.html", adminSource], ["client.html", clientSource]];
  const parsed = pages.map(([label, source]) => ({
    label,
    days: parseNumberLiteral(source, label, "RANK_CHRONIC_ISOLATION_DAYS"),
    ms: parseNumberLiteral(source, label, "RANK_CHRONIC_ISOLATION_MS"),
    marker: parseStringLiteral(source, label, "RANK_CHRONIC_ISOLATION_LABEL"),
  }));

  for (const entry of parsed) {
    assert.equal(entry.days, RANK_CHRONIC_ISOLATION_DAYS, `${entry.label}: DAYS 가 서버와 다르다`);
    assert.equal(entry.ms, RANK_CHRONIC_ISOLATION_MS, `${entry.label}: MS 가 서버와 다르다`);
    assert.equal(entry.marker, RANK_CHRONIC_ISOLATION_MARKER, `${entry.label}: LABEL 이 서버 MARKER 와 다르다`);
    // 짝이 어긋난 상수(예: DAYS=3, MS=2일)가 통과하지 못하게 산술로 다시 묶는다.
    assert.equal(entry.ms, entry.days * 24 * 60 * 60 * 1000, `${entry.label}: MS 는 DAYS 의 밀리초 환산이어야 한다`);
  }
  // admin 과 client 끼리도 같아야 한다.
  assert.equal(parsed[0].days, parsed[1].days);
  assert.equal(parsed[0].ms, parsed[1].ms);
  assert.equal(parsed[0].marker, parsed[1].marker);
  // 서버 모듈 자체의 산술도 함께 고정한다.
  assert.equal(RANK_CHRONIC_ISOLATION_MS, RANK_CHRONIC_ISOLATION_DAYS * 24 * 60 * 60 * 1000);
});

test("H2: admin.html 하트비트 정체 임계값은 정확히 15분이다", () => {
  assert.equal(parseNumberLiteral(adminSource, "admin.html", "RANK_HEARTBEAT_STALE_MINUTES"), 15);
});

test("H3: client.html 의 RANK_RETRY_EXHAUSTED_AT 은 서버 값과 같다", () => {
  assert.equal(parseNumberLiteral(clientSource, "client.html", "RANK_RETRY_EXHAUSTED_AT"), RANK_RETRY_EXHAUSTED_AT);
  // 격리 판정이 두 화면에서 같은 자격선을 쓰는지 admin 도 함께 대조한다.
  assert.equal(parseNumberLiteral(adminSource, "admin.html", "RANK_RETRY_EXHAUSTED_AT"), RANK_RETRY_EXHAUSTED_AT);
});

test("H3: rankTrackerChronicIsolated 본문은 admin·client 가 바이트 동일하다", () => {
  const adminBody = htmlFunction(adminSource, "rankTrackerChronicIsolated", "admin.html");
  const clientBody = htmlFunction(clientSource, "rankTrackerChronicIsolated", "client.html");
  assert.ok(adminBody.length > 300, "추출 실패(빈 본문)로 단언이 무의미해지면 안 된다");
  assert.equal(adminBody, clientBody, "두 화면의 격리 판정이 갈라지면 안 된다");
});

// ─────────────────────────────────────────────────────────────
// (3) 잠금 함수 격리
// ─────────────────────────────────────────────────────────────
test("H1b·H2·H3: 잠금 함수는 새 경보 코드를 한 조각도 품지 않는다", () => {
  const forbidden = [
    WORKER_OUTDATED_LINE,
    HEARTBEAT_PREFIX,
    ISOLATION_LABEL,
    "rankTrackerChronicIsolated",
    "rankCollectionHealthSignal",
    "RANK_HEARTBEAT_STALE_MINUTES",
  ];
  const pages = [["admin.html", adminSource], ["client.html", clientSource]];
  for (const [label, source] of pages) {
    for (const name of ["initRankTracking", "initPlaceRankTracking"]) {
      const block = functionBlock(source, name);
      // 추출기가 조용히 빈 값을 돌려주면 아래 단언이 전부 공허해진다. 크게 잡아 둔다.
      assert.ok(block.length > 1000, `${label} ${name}: 추출 블록이 너무 작다(${block.length}자)`);
      assert.ok(block.startsWith(`function ${name}(`), `${label} ${name}: 추출 시작점이 다르다`);
      for (const marker of forbidden) {
        assert.equal(block.includes(marker), false, `${label} ${name} 안에 ${marker} 가 있으면 안 된다`);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────
// (4) rankCollectionStallSummary 동작
// ─────────────────────────────────────────────────────────────
test("H1b·H2·H3: 기본 신호 + 정상 추적이면 배너 조건이 서지 않는다", () => {
  const summary = stallSummary([activeTracker({})]);
  assert.equal(summary.total, 0);
  assert.equal(summary.isolated, 0);
  assert.equal(summary.workerOutdated, false);
  assert.equal(summary.heartbeatStale, false);
  assert.equal(summary.heartbeatAgeMinutes, 0);
});

test("H2: heartbeatStale 은 15분 초과에서만 참이다(경계 15는 거짓)", () => {
  assert.equal(stallSummary([activeTracker({})], { health: { heartbeatAgeMinutes: 16 } }).heartbeatStale, true);
  assert.equal(stallSummary([activeTracker({})], { health: { heartbeatAgeMinutes: 15 } }).heartbeatStale, false);
  // 0 은 "신호를 읽을 수 없음"이라 어떤 조합에서도 경보하지 않는다(fail-safe).
  const zero = stallSummary(
    [isolatedTracker({}), activeTracker({})],
    { health: { heartbeatAgeMinutes: 0, workerOutdated: true, ok: false } },
  );
  assert.equal(zero.heartbeatStale, false, "0분은 신호 없음이지 신호 지연이 아니다");
  assert.equal(zero.heartbeatAgeMinutes, 0);
});

test("H2: heartbeatStale 는 queueStalled/stalled 와 독립으로 참이 된다", () => {
  // 신호 두절은 큐가 실제로 밀리기 몇 시간 전에 온다. stalled 에 종속시키면 경보가
  // 그 시간만큼 통째로 늦는다. 완전히 건강한 목록에서 신호만 끊긴 상태를 만든다.
  const summary = stallSummary(
    [activeTracker({}), activeTracker({ lastCheckedAt: at(-2 * HOUR) })],
    { health: { heartbeatAgeMinutes: 16 } },
  );
  // 독립성은 "가정"이 아니라 같은 단언 묶음 안에서 증명한다.
  assert.equal(summary.stalled, false, "정체가 아닌데도");
  assert.equal(summary.overdue, 0, "지연도 0인데도");
  assert.equal(summary.parked, 0);
  assert.equal(summary.heartbeatStale, true, "신호 지연만으로 참이어야 한다");
  assert.ok(summary.total >= 1, "신호 지연 하나로도 배너가 켜져야 한다");

  // 소스에서도 대입식이 정체 신호를 참조하지 않는지 확인한다(우연한 통과 차단).
  const lines = adminSource.split("\n").filter((line) => /var heartbeatStale\s*=/.test(line));
  assert.equal(lines.length, 1, "heartbeatStale 대입은 정확히 1곳이어야 한다");
  for (const token of ["stalled", "overdue", "listStale", "queueStalled"]) {
    assert.equal(lines[0].includes(token), false, `heartbeatStale 대입이 ${token} 을 참조하면 안 된다`);
  }
});

test("H2: 살아 있는 cooldown 에서는 신호 지연을 경보하지 않는다", () => {
  const summary = stallSummary([activeTracker({})], {
    workerStatus: { state: "cooldown", retryAt: at(HOUR) },
    health: { heartbeatAgeMinutes: 600 },
  });
  assert.equal(summary.deliberateStop, true);
  assert.equal(summary.heartbeatAgeMinutes, 600);
  assert.equal(summary.heartbeatStale, false, "의도된 정지 중에는 신호 지연이 경보가 아니다");
});

test("H1b: workerOutdated 는 그대로 전달되고 total 을 정확히 1 올린다", () => {
  const off = stallSummary([activeTracker({})], { health: { workerOutdated: false } });
  const on = stallSummary([activeTracker({})], { health: { workerOutdated: true } });
  assert.equal(off.workerOutdated, false);
  assert.equal(on.workerOutdated, true);
  assert.equal(on.total - off.total, 1, "구버전 신호 하나가 배너 조건 1건이어야 한다");
  assert.equal(off.total, 0);
  assert.equal(on.total, 1);
});

test("H3: isolated 는 목록 안의 만성 격리 추적 수를 센다", () => {
  const summary = stallSummary([isolatedTracker({}), isolatedTracker({}), activeTracker({})]);
  assert.equal(summary.isolated, 2);
  assert.ok(summary.total >= 1);
  // 격리가 하나도 없으면 0 이다(최근 수집이 있는 소진 추적은 격리가 아니다).
  assert.equal(stallSummary([parkedRecentTracker({}), activeTracker({})]).isolated, 0);
});

// ─────────────────────────────────────────────────────────────
// (5) rankTrackerChronicIsolated 동작
// ─────────────────────────────────────────────────────────────
test("H3: 격리 판정 — active + lastError + 소진 + 3일 무갱신이 모두 성립할 때만 참", () => {
  for (const [label, source] of CHRONIC_PAGES) {
    const call = (tracker) => chronicIsolated(source, label, tracker);

    assert.equal(call({ status: "active", lastError: "수집 실패", retryCount: 8, lastCheckedAt: at(-4 * DAY) }), true, label);
    // 경계: 2일 23시간은 아직 격리가 아니고, 정확히 3일은 격리다(>= 규약).
    assert.equal(call({ status: "active", lastError: "수집 실패", retryCount: 8, lastCheckedAt: at(-(2 * DAY + 23 * HOUR)) }), false, label);
    assert.equal(call({ status: "active", lastError: "수집 실패", retryCount: 8, lastCheckedAt: at(-3 * DAY) }), true, label);
    // 자격선 미달.
    assert.equal(call({ status: "active", lastError: "수집 실패", retryCount: 7, lastCheckedAt: at(-4 * DAY) }), false, label);
    // 오류 문자열이 비었거나 공백뿐이면 근거가 없다.
    for (const lastError of ["", "   ", null]) {
      assert.equal(call({ status: "active", lastError, retryCount: 8, lastCheckedAt: at(-4 * DAY) }), false, `${label} lastError=${JSON.stringify(lastError)}`);
    }
    // active 가 아니면 격리 대상이 아니다.
    for (const status of ["paused", "failed", "completed"]) {
      assert.equal(call({ status, lastError: "수집 실패", retryCount: 8, lastCheckedAt: at(-4 * DAY) }), false, `${label} status=${status}`);
    }
    // 플레이스 payload 는 원시 retryCount 없이 파생 retryExhausted 만 준다.
    assert.equal(call({ status: "active", lastError: "수집 실패", retryExhausted: true, lastCheckedAt: at(-4 * DAY) }), true, label);
    assert.equal(call({ status: "active", lastError: "수집 실패", retryExhausted: false, lastCheckedAt: at(-4 * DAY) }), false, label);
  }
});

test("H3: 앵커가 없으면 격리로 단정하지 않고 createdAt 으로만 대체한다", () => {
  for (const [label, source] of CHRONIC_PAGES) {
    const call = (tracker) => chronicIsolated(source, label, tracker);
    // 다른 조건이 전부 격리를 가리켜도 시각 증거가 없으면 false 다("없는 증거로 단정 금지").
    for (const missing of [undefined, null, "not-a-date"]) {
      assert.equal(
        call({ status: "active", lastError: "수집 실패", retryCount: 8, lastCheckedAt: missing, createdAt: missing }),
        false,
        `${label} anchor=${JSON.stringify(missing)}`,
      );
    }
    // lastCheckedAt 이 없으면 createdAt 으로 대체한다.
    assert.equal(call({ status: "active", lastError: "수집 실패", retryCount: 8, createdAt: at(-4 * DAY) }), true, label);
    assert.equal(call({ status: "active", lastError: "수집 실패", retryCount: 8, createdAt: at(-2 * DAY) }), false, label);
  }
});

// ─────────────────────────────────────────────────────────────
// (6) 인사이트 배지
// ─────────────────────────────────────────────────────────────
const INSIGHT_CASES = [
  ["admin.html", adminSource, "rankTrackerInsight", "rankTrackerNeedsAttention", "rankTrackerTrend", "rankTrackerLatestRank"],
  ["admin.html", adminSource, "placeTrackerInsight", "placeTrackerNeedsAttention", "placeTrackerTrend", "placeTrackerLatestRank"],
  ["client.html", clientSource, "rankTrackerInsight", "rankTrackerNeedsAttention", "rankTrackerTrend", "rankTrackerLatestRank"],
  ["client.html", clientSource, "placeTrackerInsight", "placeTrackerNeedsAttention", "placeTrackerTrend", "placeTrackerLatestRank"],
];

test("H3: 격리 배지가 4개 인사이트 조합 모두에서 라벨에 실린다", () => {
  for (const [label, source, name, needsAttentionName, trendName, latestName] of INSIGHT_CASES) {
    const where = `${label} ${name}`;
    const context = insightSandbox(source, label, name, needsAttentionName, trendName, latestName);
    context.__isolated = isolatedTracker({});
    context.__healthy = activeTracker({});

    // (1) 격리 + 점검 필요 → 병기한다.
    context.__needsAttention = true;
    const bothLabel = vm.runInContext(`${name}(__isolated).label`, context);
    assert.ok(bothLabel.includes(ISOLATION_LABEL), `${where}: 격리 라벨이 병기돼야 한다 (실제: ${bothLabel})`);
    assert.equal(vm.runInContext(`${name}(__isolated).className`, context), "is-error", where);

    // (2) 정상 추적은 어떤 경우에도 격리 라벨을 달지 않는다.
    assert.equal(
      vm.runInContext(`${name}(__healthy).label`, context).includes(ISOLATION_LABEL),
      false,
      `${where}: 정상 추적에 격리 라벨이 붙으면 안 된다(점검 필요)`,
    );
    context.__needsAttention = false;
    assert.equal(
      vm.runInContext(`${name}(__healthy).label`, context).includes(ISOLATION_LABEL),
      false,
      `${where}: 정상 추적에 격리 라벨이 붙으면 안 된다(정상)`,
    );

    // (3) 점검 필요가 거짓이어도 격리면 경고 토큰이다.
    assert.equal(vm.runInContext(`${name}(__isolated).label`, context), ISOLATION_LABEL, where);
    assert.equal(vm.runInContext(`${name}(__isolated).className`, context), "is-warn", `${where}: 경고 토큰이어야 한다`);
  }
});

// ─────────────────────────────────────────────────────────────
// (7) 배너 렌더
// ─────────────────────────────────────────────────────────────
function isolatedTile(html) {
  const parts = html.split('<div class="mi-rank-auto-metric');
  const hits = parts.slice(1).filter((part) => {
    const end = part.indexOf("</div>");
    return end > 0 && part.slice(0, end).includes(ISOLATION_LABEL);
  });
  assert.equal(hits.length, 1, "격리 타일은 정확히 1개여야 한다");
  const chunk = hits[0];
  const close = chunk.indexOf('">');
  assert.ok(close > 0, "격리 타일 class 종료를 찾지 못했다");
  return { classSuffix: chunk.slice(0, close), body: chunk.slice(0, chunk.indexOf("</div>")) };
}

test("H1b: 구버전 경고 줄은 상품 레인에서만 렌더한다", () => {
  const health = { workerOutdated: true };
  const product = opsSummaryHtml([activeTracker({})], { health });
  assert.ok(product.includes("data-rank-stall-banner"), "구버전 신호만으로도 배너가 켜져야 한다");
  assert.ok(product.includes(WORKER_OUTDATED_LINE), "상품 레인에는 구버전 경고가 있어야 한다");

  const place = opsSummaryHtml([activeTracker({})], { place: true, health });
  assert.equal(place.includes(WORKER_OUTDATED_LINE), false, "플레이스는 서버 크론이라 윈도우 워커를 언급하면 안 된다");
  assert.equal(place.includes(WORKER_NOUN), false);
});

test("H2: 신호 지연 줄은 상품 레인에서만 렌더하고 관측 분을 그대로 적는다", () => {
  const health = { heartbeatAgeMinutes: 42 };
  const product = opsSummaryHtml([activeTracker({})], { health });
  assert.ok(product.includes("data-rank-stall-banner"));
  assert.ok(product.includes("수집기 신호가 42분째"), "관측된 분 수를 그대로 렌더해야 한다");
  assert.ok(product.includes("수집기 신호가 42분째 확인되지 않습니다. 큐가 멈추기 전에 수집기 상태를 확인해주세요."));

  const place = opsSummaryHtml([activeTracker({})], { place: true, health });
  assert.equal(place.includes(HEARTBEAT_PREFIX), false, "플레이스 레인에는 수집기 신호 문장이 없어야 한다");
});

test("H3: 격리 타일은 양쪽 레인에 있고 건수에 따라 is-warn/is-ok 로 갈린다", () => {
  for (const place of [false, true]) {
    const lane = place ? "place" : "product";
    const warn = isolatedTile(opsSummaryHtml([isolatedTracker({})], { place }));
    assert.equal(warn.classSuffix, " is-warn", `${lane}: 격리가 있으면 경고여야 한다`);
    assert.ok(warn.body.includes("1개"), `${lane}: 격리 건수를 렌더해야 한다`);
    assert.ok(warn.body.includes(RANK_CHRONIC_ISOLATION_DAYS + "일 이상 같은 실패"), `${lane}: 기준 안내가 있어야 한다`);

    const ok = isolatedTile(opsSummaryHtml([parkedRecentTracker({})], { place }));
    assert.equal(ok.classSuffix, " is-ok", `${lane}: 격리가 0이면 정상 토큰이어야 한다`);
    assert.ok(ok.body.includes("0개"), `${lane}: 0건을 렌더해야 한다`);
  }
});

test("H1b·H2: 상품 전용 신호만으로는 플레이스 배너를 열지 않는다(근거 없는 경고 금지)", () => {
  // stall.total 은 레인 인자가 없어 workerOutdated·heartbeatStale 까지 센다.
  // 배너 개폐를 total 로 하면 플레이스 레인에서는 두 문구가 레인 게이트에 막혀
  // 설명 줄이 하나도 없는 배너가 열린다. 개폐는 레인을 반영해야 한다.
  for (const health of [{ workerOutdated: true }, { heartbeatAgeMinutes: 42 }]) {
    const summary = stallSummary([activeTracker({})], { health });
    assert.ok(summary.total >= 1, "요약의 total 은 레인과 무관하게 신호를 센다");

    const place = opsSummaryHtml([activeTracker({})], { place: true, health });
    assert.equal(
      place.includes("data-rank-stall-banner"),
      false,
      `플레이스 레인은 ${JSON.stringify(health)} 만으로 배너를 열면 안 된다`,
    );
    // 중립 머리글도 함께 사라져야 한다(빈 배너의 흔적이 남으면 안 된다).
    assert.equal(place.includes("수집기 상태를 확인해주세요"), false);

    const product = opsSummaryHtml([activeTracker({})], { health });
    assert.ok(product.includes("data-rank-stall-banner"), "상품 레인에서는 같은 신호로 배너가 열려야 한다");
  }

  // 레인 무관 신호(만성 격리)는 플레이스에서도 배너를 연다 — 게이트가 과하게 닫히지 않았는지 확인.
  const isolatedPlace = opsSummaryHtml([isolatedTracker({})], { place: true });
  assert.ok(isolatedPlace.includes("data-rank-stall-banner"), "격리는 레인 무관 신호이므로 플레이스에서도 배너를 연다");
  assert.ok(isolatedPlace.includes(ISOLATION_LABEL));
});

test("H1b: 구버전 경고는 기존 정체 안내와 다른 별개 요소다", () => {
  const html = opsSummaryHtml([activeTracker({})], { health: { workerOutdated: true } });
  // '>문구<' 형태여야 다른 문장에 이어 붙지 않았다는 뜻이다.
  assert.ok(html.includes(">" + WORKER_OUTDATED_LINE + "<"), "경고 문구가 자기 요소의 전체 텍스트여야 한다");
  // 기존 정체 안내 문구와 섞이지 않았는지 확인한다(정체가 아니므로 아예 없어야 한다).
  assert.equal(html.includes("수집기(맥 크롬) 실행 상태를 확인해주세요"), false);
  assert.equal(html.includes("재시도가 소진된 추적이 있습니다"), false);
  assert.ok(html.includes("수집기 상태를 확인해주세요"), "새 신호 단독일 때는 중립 머리글을 쓴다");
});

// ─────────────────────────────────────────────────────────────
// (8) 버전 문자열·기기 식별자 금지
// ─────────────────────────────────────────────────────────────
function headElementContaining(html, needle) {
  const found = html.indexOf(needle);
  assert.ok(found >= 0, `문구를 찾지 못했다: ${needle}`);
  const open = html.lastIndexOf('<div class="mi-rank-auto-head">', found);
  assert.ok(open >= 0, `머리글 요소 시작을 찾지 못했다: ${needle}`);
  const close = html.indexOf("</div>", found);
  assert.ok(close > open, `머리글 요소 끝을 찾지 못했다: ${needle}`);
  return html.slice(open, close + "</div>".length);
}

function smallTextContaining(html, needle) {
  const found = html.indexOf(needle);
  assert.ok(found >= 0, `문구를 찾지 못했다: ${needle}`);
  const open = html.lastIndexOf("<small>", found);
  const close = html.indexOf("</small>", found);
  assert.ok(open >= 0 && close > open, `<small> 경계를 찾지 못했다: ${needle}`);
  return html.slice(open + "<small>".length, close);
}

test("H1b·H2·H3: 새 문구에 버전 문자열도 기기 식별자도 없다", () => {
  // 세 신호를 동시에 켠 상품 레인 출력.
  const html = opsSummaryHtml([isolatedTracker({})], {
    health: { workerOutdated: true, heartbeatAgeMinutes: 42 },
  });
  const outdatedEl = headElementContaining(html, WORKER_OUTDATED_LINE);
  const heartbeatEl = headElementContaining(html, HEARTBEAT_PREFIX);
  const tile = isolatedTile(html).body;
  const newMarkup = outdatedEl + heartbeatEl + tile;
  assert.ok(newMarkup.length > 200, "새 마크업 수집에 실패하면 단언이 공허해진다");

  // (1) 시맨틱 버전 문자열 금지.
  assert.equal(/\d+\.\d+\.\d+/.test(newMarkup), false, `새 문구에 버전 문자열이 있으면 안 된다: ${newMarkup}`);

  // (2) '윈도우 워커' 는 렌더 결과에 정확히 한 번만 나온다.
  assert.equal((html.match(new RegExp(WORKER_NOUN, "g")) || []).length, 1);

  // (3) 그 뒤 60자에 식별자가 붙지 않았다.
  //     원문 60자에는 닫는 태그(</small></div>)의 '/' 가 필연적으로 들어오므로,
  //     숫자·@·역슬래시는 원문 그대로 검사하고 '/' 는 태그를 제거한 텍스트에서 본다.
  //     (태그 제거 텍스트는 원문의 부분집합이라 검사가 약해지지 않는다.)
  const from = html.indexOf(WORKER_NOUN) + WORKER_NOUN.length;
  const tail = html.slice(from, from + 60);
  assert.equal(tail.length, 60, "꼬리 60자를 확보하지 못했다");
  assert.equal(/[0-9@\\]/.test(tail), false, `문구 뒤 60자에 식별자가 붙었다: ${tail}`);
  assert.equal(/[0-9@/\\]/.test(tail.replace(/<\/?[^>]*>/g, "")), false, `문구 뒤 60자 텍스트에 식별자가 붙었다: ${tail}`);

  // (4) 더 강한 형태 — 그 <small> 의 전체 텍스트가 문구와 완전히 같다(덧붙임 자체가 없다).
  assert.equal(smallTextContaining(html, WORKER_NOUN), WORKER_OUTDATED_LINE);
});

test("H1b·H2: refreshRankCollectionHealthSignal 은 문서화된 4개 필드만 쓴다", () => {
  const block = functionBlock(adminSource, "refreshRankCollectionHealthSignal");
  assert.ok(block.length > 500, "추출 블록이 너무 작다");

  // 개별 속성 대입은 한 건도 없어야 한다.
  const propertyWrites = [...block.matchAll(/rankCollectionHealthSignal\s*\.\s*([A-Za-z0-9_$]+)\s*=(?!=)/g)].map((m) => m[1]);
  assert.deepEqual(propertyWrites, [], "개별 필드 대입이 있으면 안 된다");
  assert.equal(block.includes("Object.assign(rankCollectionHealthSignal"), false);

  // 통째 대입은 next 하나뿐이다.
  const assignments = [...block.matchAll(/rankCollectionHealthSignal\s*=\s*([A-Za-z0-9_$]+)\s*;/g)].map((m) => m[1]);
  assert.deepEqual(assignments, ["next"], "신호 객체 대입은 next 한 번뿐이어야 한다");

  // next 객체의 키 집합이 문서화된 4개와 정확히 같다.
  const objectStart = block.indexOf("var next = {");
  assert.ok(objectStart >= 0, "next 객체 리터럴을 찾지 못했다");
  const objectEnd = block.indexOf("};", objectStart);
  assert.ok(objectEnd > objectStart, "next 객체 리터럴 끝을 찾지 못했다");
  const objectBody = block.slice(objectStart, objectEnd);
  const keys = [...objectBody.matchAll(/^\s{2,}([A-Za-z0-9_$]+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), ["fetchedAt", "heartbeatAgeMinutes", "ok", "workerOutdated"]);
});

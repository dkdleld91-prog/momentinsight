import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  PLACE_RETRY_BACKOFF_MINUTES,
  RANK_AUTO_REQUEUE_MARKER,
  RANK_AUTO_REQUEUE_MESSAGE,
  RANK_NEVER_FOUND_MIN_CHECKS,
  RANK_OVERDUE_THRESHOLD_MS,
  RANK_PLACE_PARTIAL_MIN_RETRIES,
  RANK_REQUEUE_DAILY_CAP,
  RANK_REQUEUE_MIN_IDLE_MS,
  RANK_RETRY_EXHAUSTED_AT,
  RANK_STUCK_TRACKER_MS,
  requeueEligible,
  requeueMinIntervalMs,
  runPlaceRequeuePass,
  runRankRequeuePass,
} from "../src/server/naver-rank-requeue.mjs";
import rankCollectionHealthHandler, {
  deliberateWorkerStopFromRow,
  rankCollectionHealthBody,
} from "../src/server/handlers/rank-collection-health.mjs";
import {
  RANK_KEYWORD_GROUP_MAX_PAGES,
  RANK_KEYWORD_GROUP_PAGE_SIZE,
  countActiveProductKeywordGroups,
  normalizedRankKeywordKey,
} from "../src/server/rank-capacity.mjs";
import { placeTrackerPayload } from "../src/server/handlers/naver-place-rank-trackers.mjs";
import {
  EXPECTED_WORKER_RUNTIME_VERSION,
  WORKER_HEARTBEAT_STALE_MINUTES,
  WORKER_OUTDATED_SIGNING_WINDOW_MS,
  heartbeatAgeMinutes,
  workerOutdatedFromSignals,
} from "../src/server/naver-shopping/worker-runtime-expectation.mjs";
import {
  NAVER_RANK_WORKER_OUTDATED,
  NAVER_RANK_WORKER_SILENT,
  hybridWorkerFailure,
  hybridWorkerGraceActive,
  hybridWorkerOutdatedFailure,
  hybridWorkerRuntimeSignals,
} from "../src/server/handlers/naver-rank-cron.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readRepoFile = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");

const adminSource = readRepoFile("src/pages/admin.html");
const clientSource = readRepoFile("src/pages/client.html");
const watchdogSource = readRepoFile("scripts/watchdog/mi-rank-watchdog.sh");
const watchdogPlistSource = readRepoFile("scripts/watchdog/co.kr.momentinsight.rank-watchdog.plist.template");
const watchdogInstallSource = readRepoFile("scripts/watchdog/install-mi-rank-watchdog.sh");
const bridgeInstallerSource = readRepoFile("scripts/install-naver-shopping-chrome-bridge.mjs");
const packageManifest = JSON.parse(readRepoFile("package.json"));
const healthHandlerSource = readRepoFile("src/server/handlers/rank-collection-health.mjs");
const rankCapacitySource = readRepoFile("src/server/rank-capacity.mjs");
// 정규화 규약의 원본은 잠금 파일 두 곳이다. 용량 모듈은 그 의미를 복제하므로
// 원본 문자열이 바뀌면(=규약이 움직이면) 아래 드리프트 가드가 먼저 깨진다.
const localWorkerSource = readRepoFile("src/server/handlers/naver-shopping-local-worker.mjs");
const shoppingRankSource = readRepoFile("src/server/handlers/naver-shopping-rank.mjs");
const sessionGateSource = readRepoFile("src/server/session-gate.mjs");
const serverIndexSource = readRepoFile("src/server/index.mjs");

const HOUR = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// 공용 추출기 (stage3-landing-and-target-ui.test.mjs 와 동일 규약)
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

function adminBlock(startMarker, endMarker) {
  const from = adminSource.indexOf(startMarker);
  assert.ok(from >= 0, `block start not found: ${startMarker}`);
  const to = adminSource.indexOf(endMarker, from + startMarker.length);
  assert.ok(to > from, `block end not found: ${endMarker}`);
  return adminSource.slice(from, to);
}

// 상수 선언은 함수 밖이므로 함수 추출기로는 잡히지 않는다. 선언 블록을 그대로 떼어 낸다.
function stallConstantsBlock() {
  const startMarker = "      var RANK_OVERDUE_THRESHOLD_MS = 21600000;";
  const endMarker = "\n      function rankTrackerOpsSummary(";
  const from = adminSource.indexOf(startMarker);
  assert.ok(from >= 0, "stall constants block not found");
  const to = adminSource.indexOf(endMarker, from);
  assert.ok(to > from, "stall constants block end not found");
  return adminSource.slice(from, to);
}

// 정체 계산은 Date.now() 를 읽으므로 샌드박스 안에서 시계를 고정한다.
function stallSandbox() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; };`, context);
  vm.runInContext(stallConstantsBlock(), context);
  return context;
}

// ─────────────────────────────────────────────────────────────
// (A) F1 정체 계산 — admin.html 원본 함수를 그대로 실행
// ─────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function stallSummary(trackers, workerStatus) {
  const context = stallSandbox();
  context.__trackers = trackers;
  context.__workerStatus = workerStatus || null;
  return vm.runInContext("rankCollectionStallSummary(__trackers, __workerStatus)", context);
}

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

// 정체로 단정하려면 지연과 "목록 전체가 24시간 넘게 갱신 없음"이 동시에 성립해야 한다.
function stalledTracker(overrides) {
  return activeTracker(Object.assign({
    nextCheckAt: at(-(6 * HOUR + 60 * 1000)),
    lastCheckedAt: at(-30 * HOUR),
  }, overrides || {}));
}

test("F1: 정상 추적은 지연·소진으로 세지 않는다", () => {
  const summary = stallSummary([activeTracker({})]);
  assert.equal(summary.overdue, 0);
  assert.equal(summary.parked, 0);
  assert.equal(summary.stalled, false);
  assert.equal(summary.total, 0);
});

test("F1: 6시간 경계 미달은 지연이 아니다", () => {
  const summary = stallSummary([activeTracker({ nextCheckAt: at(-(5 * HOUR + 59 * 60 * 1000)) })]);
  assert.equal(summary.overdue, 0);
});

test("F1: 6시간 초과는 지연으로 세지만 그것만으로는 정체가 아니다", () => {
  // 운영 hybrid 경로에서는 정상 상태에서도 next_check_at 초과가 상시 발생한다.
  // 지연 단독으로 배너를 띄우면 배너가 영구히 켜진다 — 그 오탐을 여기서 고정한다.
  const summary = stallSummary([activeTracker({ nextCheckAt: at(-(6 * HOUR + 60 * 1000)) })]);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.stalled, false, "최근 수집이 있으면 정체가 아니다");
  assert.equal(summary.total, 0, "배너를 띄우지 않는다");
});

test("F1: 지연 + 목록 24시간 무갱신이 동시에 성립할 때만 정체다", () => {
  const stalled = stallSummary([stalledTracker({})]);
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.total, 1);
  assert.equal(stalled.staleMinutes, 30 * 60);

  // 23시간 59분은 아직 한 cycle 회전 여유 안이다.
  const withinCycle = stallSummary([stalledTracker({ lastCheckedAt: at(-(23 * HOUR + 59 * 60 * 1000)) })]);
  assert.equal(withinCycle.stalled, false);
  assert.equal(withinCycle.total, 0);

  // 목록 안에 최근 수집이 하나라도 있으면 정체가 아니다(가장 최근 값 기준).
  const mixed = stallSummary([stalledTracker({}), activeTracker({ lastCheckedAt: at(-2 * HOUR) })]);
  assert.equal(mixed.overdue, 1);
  assert.equal(mixed.stalled, false);
});

test("F1: 한 번도 수집된 적 없으면 정체로 단정하지 않는다", () => {
  const summary = stallSummary([stalledTracker({ lastCheckedAt: null })]);
  assert.equal(summary.hasCheckedAt, false);
  assert.equal(summary.stalled, false);
  assert.equal(summary.total, 0);
});

test("F1: 배너를 억제하는 것은 '살아 있는 retryAt 을 동반한 cooldown' 하나뿐이다", () => {
  // 전제 반전(옛 테스트는 stopped·verification 도 억제 대상으로 고정했다).
  // 근거: 서버 loadShoppingWorkerStatus 는 circuit_state === "open" 을 그대로 state
  // "stopped" 로 내려주는데, 회로가 open 이 되는 사유 6종 중 5종
  // (auto_navigation_probe · auto_transient_system_probe ·
  //  navigating:naver_page_navigation_failed · probe_incomplete · probe_interrupted)은
  // 수집기 자신의 실패로 자동 설정된다. 사람이 세우는 것은 manual_stop · manual_canary
  // 둘뿐인데 화면에 오는 workerStatus 에는 circuit_reason 이 없어 구분이 불가능하다.
  // 게다가 open 의 유일한 탈출 경로가 "10분 뒤 primary worker 요청 도착"이라 Chrome 이
  // 죽으면 회로는 영구히 open 에 머문다(sticky). 즉 stopped 를 억제 대상으로 두면
  // 정확히 진짜 사고에서 배너가 꺼진다.
  const tracker = () => stalledTracker({ lastError: "수집 실패", retryCount: 9 });

  const cooldownAlive = stallSummary([tracker()], { state: "cooldown", retryAt: at(2 * HOUR) });
  assert.equal(cooldownAlive.deliberateStop, true, "살아 있는 retryAt 을 동반한 cooldown 만 의도된 정지다");
  assert.equal(cooldownAlive.stalled, false);
  assert.equal(cooldownAlive.total, 0, "이때만 배너를 띄우지 않는다");
  assert.equal(cooldownAlive.workerState, "cooldown");

  // retryAt 이 이미 지났는데 여전히 cooldown 이면 워커가 재개하지 못한 상태다.
  const cooldownStuck = stallSummary([tracker()], { state: "cooldown", retryAt: at(-2 * HOUR) });
  assert.equal(cooldownStuck.deliberateStop, false, "재개 못한 cooldown 은 정상 일시정지가 아니다");
  assert.equal(cooldownStuck.stalled, true);
  assert.equal(cooldownStuck.total, 2, "정체 1 + 소진 1");

  for (const state of ["stopped", "verification"]) {
    const summary = stallSummary([tracker()], { state });
    assert.equal(summary.deliberateStop, false, `${state} 는 의도된 정지가 아니다`);
    assert.equal(summary.stalled, true, `${state} 중에도 정체는 정체다`);
    assert.equal(summary.total, 2, `${state} 중에도 배너를 띄운다`);
    assert.equal(summary.workerState, state);
  }

  const running = stallSummary([tracker()], { state: "running" });
  assert.equal(running.deliberateStop, false);
  assert.equal(running.stalled, true);
  assert.equal(running.workerState, "running");
});

test("F1: paused 추적기는 active 가 아니므로 제외한다", () => {
  const summary = stallSummary([activeTracker({ status: "paused", nextCheckAt: at(-24 * HOUR), lastCheckedAt: at(-30 * HOUR) })]);
  assert.equal(summary.overdue, 0);
  assert.equal(summary.hasCheckedAt, false);
  assert.equal(summary.total, 0);
});

test("F1: nextCheckAt 이 없으면 지연으로 세지 않는다(오탐 금지)", () => {
  assert.equal(stallSummary([activeTracker({ nextCheckAt: null })]).overdue, 0);
  assert.equal(stallSummary([activeTracker({ nextCheckAt: "" })]).overdue, 0);
  assert.equal(stallSummary([activeTracker({ nextCheckAt: "not-a-date" })]).overdue, 0);
});

test("F1: lastError 와 retryCount>=8 이 동시에 성립할 때만 소진이다", () => {
  assert.equal(stallSummary([activeTracker({ lastError: "x", retryCount: 8 })]).parked, 1);
  assert.equal(stallSummary([activeTracker({ lastError: "x", retryCount: 7 })]).parked, 0);
  assert.equal(stallSummary([activeTracker({ lastError: null, retryCount: 9 })]).parked, 0);
});

test("F1: 플레이스 소진은 파생 retryExhausted 로 집계한다", () => {
  // 플레이스 payload 에는 원시 retryCount 가 없다. 소진 집계는 파생 불리언으로만 성립한다.
  assert.equal(stallSummary([activeTracker({ lastError: "x", retryCount: undefined, retryExhausted: true })]).parked, 1);
  assert.equal(stallSummary([activeTracker({ lastError: "x", retryCount: undefined, retryExhausted: false })]).parked, 0);
  assert.equal(stallSummary([activeTracker({ lastError: null, retryCount: undefined, retryExhausted: true })]).parked, 0);
});

test("F1: 자동 재큐 표식은 requeued 로 집계된다", () => {
  const tracker = activeTracker({ lastMessage: RANK_AUTO_REQUEUE_MESSAGE });
  const summary = stallSummary([tracker]);
  assert.equal(summary.requeued, 1);
  assert.equal(summary.total, 0, "재큐만 있으면 배너 조건(total)을 만들지 않는다");
  assert.equal(summary.stalled, false);

  // last_message 는 광고주 화면에 그대로 렌더된다. 날짜·횟수 같은 내부 운영
  // 텔레메트리는 들어가면 안 된다(옛 표식은 "… (2026-09-01 1/2회)" 였다).
  assert.equal(/\d{4}-\d{2}-\d{2}|\d+\/\d+회/.test(RANK_AUTO_REQUEUE_MESSAGE), false);

  const context = stallSandbox();
  context.__tracker = tracker;
  assert.equal(vm.runInContext("rankTrackerAutoRequeued(__tracker)", context), true);
  context.__other = activeTracker({ lastMessage: "재시도 예약" });
  assert.equal(vm.runInContext("rankTrackerAutoRequeued(__other)", context), false);
});

test("F1: 화면 상수는 서버 모듈 값과 일치한다", () => {
  const context = stallSandbox();
  assert.equal(vm.runInContext("RANK_OVERDUE_THRESHOLD_MS", context), RANK_OVERDUE_THRESHOLD_MS);
  assert.equal(vm.runInContext("RANK_RETRY_EXHAUSTED_AT", context), RANK_RETRY_EXHAUSTED_AT);
  assert.equal(vm.runInContext("RANK_AUTO_REQUEUE_MARKER", context), RANK_AUTO_REQUEUE_MARKER);
  // 목록 임계값은 서버(전역 6시간)보다 커야 한다. 이 화면의 목록은 광고주 범위이고
  // durable cycle 1회전(실측 약 10.6시간)만큼은 정상적으로 비어 있을 수 있다.
  const listStale = vm.runInContext("RANK_LIST_STALE_THRESHOLD_MS", context);
  assert.equal(listStale, 86_400_000);
  assert.ok(listStale > RANK_OVERDUE_THRESHOLD_MS);
  assert.deepEqual([...vm.runInContext("RANK_DELIBERATE_STOP_STATES", context)], ["cooldown"]);
});

// needsAttention 은 전역 플래그로 제어한다. 옛 스텁은 항상 true 를 돌려주어
// "재큐 배지가 점검 필요보다 앞선다"는 잘못된 전제를 실행으로 확인할 수 없었다.
function insightSandbox(name, needsAttentionName, trendName, latestName) {
  const context = {};
  vm.createContext(context);
  context.__needsAttention = true;
  vm.runInContext([
    stallConstantsBlock(),
    pageFunction(name),
    `function ${needsAttentionName}() { return __needsAttention === true; }`,
    `function ${trendName}() { return "dropped"; }`,
    `function ${latestName}() { return 1; }`,
  ].join("\n\n"), context);
  return context;
}

test("F1: 자동 재큐 배지는 플레이스에만 있고 점검 필요가 배지보다 앞선다", () => {
  // 전제 반전(옛 테스트는 재큐 배지가 점검 필요를 이긴다고 고정했다).
  // 자동 재큐는 last_error 를 일부러 보존하므로 상품 삭제·URL 무효 같은 영구 실패도
  // 표식을 단다. 재큐를 먼저 반환하면 조치가 필요한 추적이 "자동 재시도 예정"
  // (=조치 불필요)으로 읽힌다.
  const requeued = activeTracker({ lastError: "수집 실패", retryCount: 0, lastMessage: RANK_AUTO_REQUEUE_MESSAGE });
  const clean = activeTracker({ lastError: null, retryCount: 0, lastMessage: "1페이지 3위" });

  const place = insightSandbox(
    "placeTrackerInsight",
    "placeTrackerNeedsAttention",
    "placeTrackerTrend",
    "placeTrackerLatestRank",
  );
  place.__requeued = requeued;
  place.__clean = clean;

  // (1) 점검 필요 + 재큐 표식 → 병기하고 색은 오류다.
  place.__needsAttention = true;
  // vm 경계를 넘은 객체는 프로토타입이 달라 deepEqual 이 실패한다. 필드로 대조한다.
  assert.equal(vm.runInContext("placeTrackerInsight(__requeued).label", place), "점검 필요 · 자동 재시도 예정");
  assert.equal(vm.runInContext("placeTrackerInsight(__requeued).className", place), "is-error");
  // (2) 점검 필요만 → 그대로 점검 필요.
  assert.equal(vm.runInContext("placeTrackerInsight(__clean).label", place), "점검 필요");
  assert.equal(vm.runInContext("placeTrackerInsight(__clean).className", place), "is-error");
  // (3) 재큐 표식만 → 자동 재시도 예정.
  place.__needsAttention = false;
  assert.equal(vm.runInContext("placeTrackerInsight(__requeued).label", place), "자동 재시도 예정");
  assert.equal(vm.runInContext("placeTrackerInsight(__requeued).className", place), "is-warn");

  // 상품에는 배지를 두지 않는다. 자동 재큐가 플레이스 전용이고, 상품 payload 의
  // lastMessage 는 신뢰 snapshot 이 있으면 snapshot 메시지로 대체되어 표식이
  // 화면까지 도달하지 못한다(절대 켜지지 않는 배지를 남기지 않는다).
  const product = insightSandbox(
    "rankTrackerInsight",
    "rankTrackerNeedsAttention",
    "rankTrackerTrend",
    "rankTrackerLatestRank",
  );
  product.__requeued = requeued;
  product.__needsAttention = false;
  assert.equal(vm.runInContext("rankTrackerInsight(__requeued).label", product), "하락 확인");
  product.__needsAttention = true;
  assert.equal(vm.runInContext("rankTrackerInsight(__requeued).label", product), "점검 필요");
  assert.ok(!pageFunction("rankTrackerInsight").includes("rankTrackerAutoRequeued("));
  assert.ok(pageFunction("placeTrackerInsight").includes("rankTrackerAutoRequeued("));
});

test("F1: 상품 payload 의 lastMessage 는 snapshot 메시지로 대체된다(배지 불가 근거)", () => {
  const source = readRepoFile("src/server/handlers/naver-rank-trackers.mjs");
  assert.ok(source.includes("    lastMessage: hasTrustedSnapshot"));
  assert.ok(source.includes("      ? (recentSnapshots[0]?.message || null)"));
  // 플레이스는 행 값을 그대로 내보내므로 표식이 화면까지 도달한다.
  const placeSource = readRepoFile("src/server/handlers/naver-place-rank-trackers.mjs");
  assert.ok(placeSource.includes("    lastMessage: row.last_message,"));
});

// ─────────────────────────────────────────────────────────────
// (B) 배너 마크업 — 소스 단언 + 레인별 문구 실행 검증
// ─────────────────────────────────────────────────────────────
test("F1: 배너 마크업과 문구가 admin.html 에 존재한다", () => {
  for (const marker of [
    "data-rank-stall-banner",
    "mi-rank-stall-banner",
    "수집 멈춤",
    "자동 수집이 멈춰 있습니다",
    "재시도가 소진된 추적이 있습니다",
    "재시도 소진",
    "마지막 수집",
    "자동 재시도 예정",
    "수집기(맥 크롬) 실행 상태를 확인해주세요",
    "플레이스 순위는 서버 크론으로 수집합니다",
    "아래 수집기 운영의 회로 원인을 확인하고 재개해주세요",
    "1건 검증 중인데 수집 기록이 갱신되지 않았습니다",
    "플레이스 자동 재큐",
    "상품은 자동 재큐 대상 아님",
    "해당 없음",
    "기록 없음",
  ]) {
    assert.ok(adminSource.includes(marker), `admin.html must include ${marker}`);
  }
  // 지연 단독을 "수집이 밀리고 있다"로 단정하던 옛 문구는 남아 있으면 안 된다.
  assert.ok(!adminSource.includes("자동 수집이 밀리고 있습니다"));
  assert.ok(!adminSource.includes("자동 재큐 대기"));
  assert.ok(
    adminSource.includes("#mi-admin .mi-rank-stall-banner {"),
    "배너 전용 CSS 블록이 있어야 한다",
  );
});

// 배너 문구는 grep 이 아니라 admin.html 원본 함수를 실제로 실행해 얻는다.
function opsSummarySandbox() {
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
  return context;
}

function opsSummaryHtml(trackers, { place = false, workerStatus = null } = {}) {
  const context = opsSummarySandbox();
  context.__trackers = trackers;
  context.__workerStatus = workerStatus;
  return vm.runInContext(
    place
      ? "rankTrackerOpsSummary(__trackers, placeTrackerLatestRank, __workerStatus)"
      : "rankTrackerOpsSummary(__trackers, null, __workerStatus)",
    context,
  );
}

test("F1: 배너 안내 문구는 레인과 워커 상태로 갈린다(실행 검증)", () => {
  // 플레이스 수집은 맥 Chrome 이 아니라 서버 크론(.github/workflows/naver-place-rank-cron.yml)이다.
  // 레인을 구분하지 않으면 플레이스 정체에서 "맥 크롬을 확인하라"는 잘못된 행동 지시가 나간다.
  const productRunning = opsSummaryHtml([stalledTracker({})]);
  assert.ok(productRunning.includes("data-rank-stall-banner"));
  assert.ok(productRunning.includes("수집기(맥 크롬)"));
  assert.ok(!productRunning.includes("서버 크론"));
  assert.ok(productRunning.includes("해당 없음"));
  assert.ok(productRunning.includes("상품은 자동 재큐 대상 아님"));
  assert.ok(!productRunning.includes("플레이스 자동 재큐"));

  const productStopped = opsSummaryHtml([stalledTracker({})], { workerStatus: { state: "stopped" } });
  assert.ok(productStopped.includes("data-rank-stall-banner"), "stopped 에서도 배너는 켜진다");
  assert.ok(productStopped.includes("회로 원인"));
  assert.ok(!productStopped.includes("수집기(맥 크롬)"), "회로 상태를 Chrome 실행 문제로 단정하지 않는다");

  const productVerifying = opsSummaryHtml([stalledTracker({})], { workerStatus: { state: "verification" } });
  assert.ok(productVerifying.includes("1건 검증 중인데 수집 기록이 갱신되지 않았습니다"));
  assert.ok(!productVerifying.includes("수집기(맥 크롬)"));

  const place = opsSummaryHtml(
    [stalledTracker({}), stalledTracker({ lastMessage: RANK_AUTO_REQUEUE_MESSAGE })],
    { place: true },
  );
  assert.ok(place.includes("data-rank-stall-banner"));
  assert.ok(place.includes("플레이스 순위는 서버 크론으로 수집합니다"));
  assert.ok(!place.includes("수집기(맥 크롬)"));
  assert.ok(place.includes("플레이스 자동 재큐"));
  assert.ok(place.includes("1개"), "플레이스 레인은 재큐 건수를 숫자로 낸다");
  assert.ok(!place.includes("해당 없음"));

  // 정상이면 배너 자체가 없다(양쪽 레인 공통).
  assert.ok(!opsSummaryHtml([activeTracker({})]).includes("data-rank-stall-banner"));
  assert.ok(!opsSummaryHtml([activeTracker({})], { place: true }).includes("data-rank-stall-banner"));
});

test("F1: 배너는 rankTrackerOpsSummary 안에서 조건부로만 렌더한다", () => {
  const block = adminBlock("function rankTrackerOpsSummary(", "function rankDateKey(");
  assert.ok(block.includes("var stall = rankCollectionStallSummary(list, workerStatus);"));
  assert.ok(block.includes("var stallBanner = stall.total ?"), "stall.total 조건부여야 한다");
  assert.ok(block.includes("return stallBanner + '<div class=\"mi-rank-auto-center\">' +"));
  assert.ok(block.includes("data-rank-stall-banner"));
  // 레인은 호출부를 고치지 않고 기존 인자에서 유도한다(호출부가 잠금 함수 안이다).
  assert.ok(block.includes("var isPlaceLane = latestRankResolver === placeTrackerLatestRank;"));
});

test("F1: 정체 판정은 지연과 무갱신의 AND 이며 의도된 정지에서 꺼진다", () => {
  const helper = pageFunction("rankCollectionStallSummary");
  assert.ok(helper.includes("var stalled = !deliberateStop && overdue > 0 && listStale;"));
  assert.ok(helper.includes("now - latestCheckedAt > RANK_LIST_STALE_THRESHOLD_MS"));
  assert.ok(helper.includes("latestCheckedAt > 0"), "수집 기록이 없으면 정체로 단정하지 않는다");
  // 억제는 상태 이름만으로 하지 않는다. 살아 있는 retryAt 을 함께 요구한다.
  assert.ok(helper.includes("Number.isFinite(stopRetryAt) && stopRetryAt > now"));
  assert.ok(helper.includes("workerState: state,"), "문구 분기를 위해 워커 상태를 함께 돌려준다");
});

test("F1: 잠금 함수는 배너를 품지 않는다", () => {
  const lockedBlocks = [
    adminBlock("function initRankTracking(", "function initSeoCheck("),
    adminBlock("function initPlaceRankTracking(", "\n      function csvValue("),
    adminBlock("function bindOwnerAssistant(", "\n      function "),
  ];
  for (const block of lockedBlocks) {
    assert.ok(!block.includes("data-rank-stall-banner"), "잠금 함수 안에 배너가 있으면 안 된다");
    assert.ok(!block.includes("rankCollectionStallSummary"), "잠금 함수 안에 정체 계산이 있으면 안 된다");
  }
});

// ─────────────────────────────────────────────────────────────
// (C) F3 재큐 자격
// ─────────────────────────────────────────────────────────────
function requeueRow(overrides) {
  return Object.assign({
    id: "tracker-1",
    status: "active",
    last_error: "수집 실패",
    retry_count: RANK_RETRY_EXHAUSTED_AT,
    next_check_at: at(-7 * HOUR),
    last_message: "",
  }, overrides || {});
}

test("F3: 소진 + 6시간 경과 + active 인 행만 자격이 있다", () => {
  assert.equal(requeueEligible(requeueRow({}), { now: NOW }), true);
  assert.equal(requeueEligible(requeueRow({ retry_count: 7 }), { now: NOW }), false);
  assert.equal(requeueEligible(requeueRow({ last_error: null }), { now: NOW }), false);
  assert.equal(requeueEligible(requeueRow({ status: "paused" }), { now: NOW }), false);
  assert.equal(requeueEligible(requeueRow({ next_check_at: at(-5 * HOUR) }), { now: NOW }), false);
  assert.equal(requeueEligible(requeueRow({ next_check_at: null }), { now: NOW }), false);
  assert.equal(requeueEligible(null, { now: NOW }), false);
});

test("F3: last_attempt_at 은 있으면 존중하고 없으면 무시한다", () => {
  assert.equal(requeueEligible(requeueRow({ last_attempt_at: at(-HOUR) }), { now: NOW }), false);
  assert.equal(requeueEligible(requeueRow({ last_attempt_at: at(-7 * HOUR) }), { now: NOW }), true);
  const withoutColumn = requeueRow({});
  assert.equal(Object.prototype.hasOwnProperty.call(withoutColumn, "last_attempt_at"), false);
  assert.equal(requeueEligible(withoutColumn, { now: NOW }), true);
});

test("F3: 살아 있는 lease(processing_until) 는 자격을 막는다", () => {
  // 워커가 claim 중인 행을 재큐하면 워커 완료 경로가 낡은 retry_count 로 덮어써
  // 재큐가 조용히 되돌려진다(lost update).
  assert.equal(requeueEligible(requeueRow({}), { now: NOW }), true, "컬럼 없음 → 무시");
  assert.equal(requeueEligible(requeueRow({ processing_until: null }), { now: NOW }), true);
  assert.equal(requeueEligible(requeueRow({ processing_until: at(HOUR) }), { now: NOW }), false, "미래 lease 는 부적격");
  assert.equal(requeueEligible(requeueRow({ processing_until: at(-HOUR) }), { now: NOW }), true, "만료 lease 는 적격");
});

test("F3: 하루 상한은 문자열이 아니라 산술로 강제된다", () => {
  // 옛 구현은 last_message 표식("… (날짜 n/2회)")으로 하루 횟수를 셌다. 그 값은
  // claim/실패/성공 경로가 last_message 를 한 번만 덮어도 사라지는 비내구적 카운터라
  // 아무것도 강제하지 못했다. 지금은 재시도 사다리 산술이 상한을 구조적으로 만든다.
  assert.equal(requeueMinIntervalMs(), 81_300_000, "1355분 = 635 + 360 + 360");
  assert.equal(requeueMinIntervalMs(), (635 + 360) * 60 * 1000 + RANK_REQUEUE_MIN_IDLE_MS);
  assert.ok(
    requeueMinIntervalMs() * RANK_REQUEUE_DAILY_CAP >= 24 * HOUR,
    "상수가 드리프트해 24시간 창에 상한을 넘길 수 있게 되면 실패해야 한다",
  );

  // 사다리 상수는 원본(placeRetryAt)의 복제본이다. 문자열로 대조해 드리프트를 잡는다.
  assert.deepEqual(PLACE_RETRY_BACKOFF_MINUTES, [5, 10, 20, 40, 80, 160, 320, 360]);
  const placeSource = readRepoFile("src/server/handlers/naver-place-rank-trackers.mjs");
  assert.ok(placeSource.includes(
    `const delayMinutes = [${PLACE_RETRY_BACKOFF_MINUTES.join(", ")}]`
    + `[Math.min(retryCount, ${PLACE_RETRY_BACKOFF_MINUTES.length - 1})];`,
  ));
});

test("F3: last_message 에 내부 운영 텔레메트리가 없다", () => {
  // last_message 는 광고주 화면(client.html 플레이스 카드)에 그대로 렌더된다.
  assert.equal(RANK_AUTO_REQUEUE_MESSAGE.indexOf(RANK_AUTO_REQUEUE_MARKER), 0, "배지 접두사 계약");
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(RANK_AUTO_REQUEUE_MESSAGE), false, "날짜 금지");
  assert.equal(/\d+\/\d+회/.test(RANK_AUTO_REQUEUE_MESSAGE), false, "횟수 금지");
  // 기존 '확인 필요' 정규식에 걸리면 정상 재시도 예약이 오류로 집계된다.
  assert.equal(/실패|오류|환경변수|연결|미노출/.test(RANK_AUTO_REQUEUE_MESSAGE), false);
  assert.equal(/실패|오류|환경변수|연결/.test(RANK_AUTO_REQUEUE_MESSAGE), false);
});

// ─────────────────────────────────────────────────────────────
// (D) F3 재큐 패스 — 가짜 supabase 클라이언트
// ─────────────────────────────────────────────────────────────
function createSupabaseStub(rows, options = {}) {
  const state = { rows: rows.map((row) => ({ ...row })), updates: [], selectFilters: [], updateFilters: [] };

  // PostgREST 의 or(...) 를 실제로 평가한다. 이 재큐가 쓰는 형태만 지원한다:
  //   processing_until.is.null,processing_until.lte.<iso>
  const matchesOr = (row, expression) => String(expression).split(",").some((term) => {
    const [column, operator, ...rest] = term.split(".");
    const value = rest.join(".");
    if (operator === "is" && value === "null") return row[column] === null || row[column] === undefined;
    if (operator === "lte") {
      if (row[column] === null || row[column] === undefined) return false;
      return String(row[column]) <= String(value);
    }
    throw new Error(`unsupported or() term: ${term}`);
  });

  const matches = (row, filters) => filters.every(([kind, column, a, b]) => {
    if (kind === "eq") return row[column] === a;
    if (kind === "gte") return Number(row[column] || 0) >= Number(a);
    if (kind === "lt") return String(row[column] || "") < String(a);
    if (kind === "or") return matchesOr(row, column);
    if (kind === "not") return a === "is" && b === null
      ? row[column] !== null && row[column] !== undefined
      : true;
    return true;
  });

  const supabaseAdmin = {
    from(table) {
      const call = { table, mode: "select", filters: [], payload: null };
      const chain = {
        select(columns) {
          if (call.mode === "select") call.columns = columns;
          return chain;
        },
        update(payload) {
          call.mode = "update";
          call.payload = payload;
          return chain;
        },
        eq(column, value) { call.filters.push(["eq", column, value]); return chain; },
        gte(column, value) { call.filters.push(["gte", column, value]); return chain; },
        lt(column, value) { call.filters.push(["lt", column, value]); return chain; },
        or(expression) { call.filters.push(["or", expression]); return chain; },
        not(column, operator, value) { call.filters.push(["not", column, operator, value]); return chain; },
        order() { return chain; },
        limit(count) { call.limit = count; return chain; },
        then(resolve, reject) {
          let result;
          try {
            if (options.throwOn === call.mode) throw new Error("stub failure");
            if (call.mode === "select") {
              state.selectFilters.push(call.filters);
              result = { data: state.rows.filter((row) => matches(row, call.filters)).slice(0, call.limit), error: null };
            } else {
              state.updateFilters.push(call.filters);
              const hits = state.rows.filter((row) => matches(row, call.filters));
              for (const row of hits) Object.assign(row, call.payload);
              state.updates.push({ payload: call.payload, filters: call.filters, hits: hits.length });
              result = { data: hits.map((row) => ({ id: row.id })), error: null };
            }
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    },
  };

  return { ctx: { supabaseAdmin }, state };
}

test("F3: 상품 테이블은 fail-closed 로 제외된다(무효 동작·백오프 붕괴 방지)", async () => {
  const { ctx, state } = createSupabaseStub([requeueRow({ id: "p1" })]);
  const result = await runRankRequeuePass(ctx, "naver_rank_trackers", { force: true, now: NOW });
  assert.equal(result.unsupported, true);
  assert.equal(result.scanned, 0);
  assert.equal(result.requeued, 0);
  assert.equal(state.updates.length, 0, "상품 행은 한 건도 건드리지 않는다");
  assert.equal(state.selectFilters.length, 0, "상품 테이블은 조회조차 하지 않는다");
});

test("F3: 재큐 패스는 1회차에 재큐하고 2회차에는 0건이다(멱등)", async () => {
  const { ctx, state } = createSupabaseStub([requeueRow({ id: "t1" })]);
  const first = await runPlaceRequeuePass(ctx, { force: true, now: NOW });
  assert.equal(first.table, "naver_place_rank_trackers");
  assert.equal(first.scanned, 1);
  assert.equal(first.requeued, 1);

  const payload = state.updates[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ["last_message", "next_check_at", "retry_count"]);
  assert.equal(payload.retry_count, 0);
  assert.equal(payload.last_message, RANK_AUTO_REQUEUE_MESSAGE);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "last_error"), false, "last_error 는 보존한다");

  const updateFilters = JSON.stringify(state.updateFilters[0]);
  assert.ok(updateFilters.includes('["eq","status","active"]'), "UPDATE 에 status=active 조건이 있어야 한다");
  assert.ok(updateFilters.includes(`["gte","retry_count",${RANK_RETRY_EXHAUSTED_AT}]`), "UPDATE 에 retry_count 조건이 있어야 한다");

  // lease 가드는 SELECT·UPDATE 양쪽에 걸려야 한다. SELECT 에만 걸면 조회 이후 워커가
  // claim 한 행을 그대로 덮어써 재큐가 무효화된다.
  const nowIso = new Date(NOW).toISOString();
  const leaseGuard = `["or","processing_until.is.null,processing_until.lte.${nowIso}"]`;
  assert.ok(JSON.stringify(state.selectFilters[0]).includes(leaseGuard), "SELECT 에 lease 가드가 있어야 한다");
  assert.ok(updateFilters.includes(leaseGuard), "UPDATE 에 lease 가드가 있어야 한다");

  const second = await runPlaceRequeuePass(ctx, { force: true, now: NOW });
  assert.equal(second.requeued, 0);
  assert.equal(second.scanned, 0);
});

test("F3: 살아 있는 lease 를 가진 행은 재큐 패스가 건드리지 않는다", async () => {
  const leased = createSupabaseStub([requeueRow({ id: "t2", processing_until: at(HOUR) })]);
  const leasedResult = await runPlaceRequeuePass(leased.ctx, { force: true, now: NOW });
  assert.equal(leasedResult.requeued, 0);
  assert.equal(leased.state.updates.length, 0, "claim 중인 행은 한 건도 건드리지 않는다");

  const expired = createSupabaseStub([requeueRow({ id: "t2e", processing_until: at(-HOUR) })]);
  const expiredResult = await runPlaceRequeuePass(expired.ctx, { force: true, now: NOW });
  assert.equal(expiredResult.scanned, 1);
  assert.equal(expiredResult.requeued, 1);

  const free = createSupabaseStub([requeueRow({ id: "t2n", processing_until: null })]);
  const freeResult = await runPlaceRequeuePass(free.ctx, { force: true, now: NOW });
  assert.equal(freeResult.scanned, 1);
  assert.equal(freeResult.requeued, 1);
});

test("F3: 플레이스 SELECT 는 lease·last_attempt_at 컬럼까지 읽는다", async () => {
  const { ctx } = createSupabaseStub([requeueRow({ id: "t2c" })]);
  await runPlaceRequeuePass(ctx, { force: true, now: NOW });
  const requeueSource = readRepoFile("src/server/naver-rank-requeue.mjs");
  assert.ok(requeueSource.includes("`${BASE_COLUMNS}, last_attempt_at, processing_until`"));
  // last_checked_at·created_at 은 만성 실패 격리(chronicIsolationCandidate)가 연속 실패
  // 기간을 재는 기준점이다. BASE_COLUMNS 에서 빠지면 재큐 SELECT 에 앵커가 실리지 않아
  // requeueEligible 의 격리행 배제가 실운영에서 조용히 무력화된다.
  assert.ok(requeueSource.includes('const BASE_COLUMNS = "id, status, last_error, retry_count, next_check_at, last_message, last_checked_at, created_at";'));
});

test("F3: 조회 실패는 throw 하지 않고 failed 로 돌아온다(크론 보호)", async () => {
  const { ctx } = createSupabaseStub([requeueRow({})], { throwOn: "select" });
  const result = await runPlaceRequeuePass(ctx, { force: true, now: NOW });
  assert.equal(result.failed, true);
  assert.equal(result.requeued, 0);
  assert.equal(result.table, "naver_place_rank_trackers");
});

test("F3: 스로틀은 같은 인스턴스의 반복 스캔을 접는다", async () => {
  // passMemo 는 모듈 수준이라 앞선 force 호출이 이미 기록을 남겼다. 그보다 뒤 시각으로 검사한다.
  const later = NOW + 24 * HOUR;
  const { ctx } = createSupabaseStub([requeueRow({ id: "t3", next_check_at: new Date(later - 7 * HOUR).toISOString() })]);
  const first = await runPlaceRequeuePass(ctx, { now: later });
  assert.notEqual(first.throttled, true);
  assert.equal(first.requeued, 1);
  const second = await runPlaceRequeuePass(ctx, { now: later });
  assert.equal(second.throttled, true);
  assert.equal(second.scanned, 0);
});

test("F3: 플레이스 크론만 재큐 패스를 호출한다(상품 크론은 무수정)", () => {
  const productCron = readRepoFile("src/server/handlers/naver-rank-cron.mjs");
  const placeCron = readRepoFile("src/server/handlers/naver-place-rank-cron.mjs");
  assert.ok(!productCron.includes("naver-rank-requeue.mjs"), "상품 크론은 재큐를 호출하지 않는다");
  assert.ok(!productCron.includes("RequeuePass"));
  // 플레이스 크론은 재큐와 함께 만성 실패 격리 패스도 부른다. 격리는 두 레인 모두를
  // 여기서 돌린다 — 하이브리드 모드의 상품 크론은 runDueTrackers 에 닿기 전에
  // 202/503 으로 단락되므로(naver-rank-cron.mjs 의 deferredToLocalWorker 분기)
  // 추적기 유지보수를 항상 수행하는 서버 크론 경로가 이 파일뿐이다.
  assert.ok(placeCron.includes('import { runChronicIsolationPass, runPlaceRequeuePass } from "../naver-rank-requeue.mjs";'));
  const placeIsolationAt = placeCron.indexOf("runChronicIsolationPass(ctx,");
  const placeRequeueAt = placeCron.indexOf("await runPlaceRequeuePass(ctx);");
  const placeRunAt = placeCron.indexOf("const summary = await runDuePlaceTrackers(");
  // 순서가 뒤집히면 같은 요청 안에서 방금 격리된 추적기를 재큐가 도로 끌어온다.
  assert.ok(placeIsolationAt > 0 && placeRequeueAt > placeIsolationAt);
  assert.ok(placeRequeueAt > 0 && placeRunAt > placeRequeueAt);
});

test("F3: 상품 제외 근거가 코드에 측정값으로 남아 있다", () => {
  const requeueSource = readRepoFile("src/server/naver-rank-requeue.mjs");
  assert.ok(requeueSource.includes("worker_quarantined_until"));
  assert.ok(requeueSource.includes("hybrid_local_worker"));
  assert.ok(requeueSource.includes("Never claim this tracker or rewrite next_check_at"));
  // 근거 1: 최신 cycle claim 마이그레이션에 next_check_at 참조가 0건이다.
  for (const migration of [
    "supabase/migrations/20260831003000_naver_shopping_active_cycle_runtime_recovery.sql",
    "supabase/migrations/20260831033617_naver_shopping_account_one_shot_priority.sql",
  ]) {
    assert.ok(!readRepoFile(migration).includes("next_check_at"), `${migration} 는 next_check_at 을 읽지 않는다`);
  }
  // 근거 2: 상품 격리 길이는 retry_count 로 정해진다 — 0 으로 되돌리면 24시간이 30분이 된다.
  const quarantine = readRepoFile("supabase/migrations/20260831014800_naver_shopping_runtime_1_1_19_stable_rendered_order.sql");
  assert.ok(quarantine.includes("when coalesce(retry_count, 0) >= 2 then interval '24 hours'"));
  // 근거 3: 상품 불변식 주석이 원본에 그대로 있다.
  assert.ok(readRepoFile("src/server/handlers/naver-rank-trackers.mjs")
    .includes("Never claim this tracker or rewrite next_check_at"));
});

test("F3: 하루 상한의 실질 강제는 플레이스 재시도 사다리 산술이다", () => {
  // 문자열 표식은 다음 시도가 덮으면 사라지므로 내구적 카운터가 아니다. 실질 상한:
  // 재큐 직후 retry_count=0 → 다시 8회 실패까지 사다리 앞 7칸 누적,
  // 그 뒤 next_check_at(마지막 실패 +마지막 칸)이 다시 6시간 과거가 되어야 한다.
  const ladder = PLACE_RETRY_BACKOFF_MINUTES;
  const toEighthFailure = ladder.slice(0, RANK_RETRY_EXHAUSTED_AT - 1).reduce((sum, value) => sum + value, 0);
  assert.equal(toEighthFailure, 635);
  const minimumIntervalMinutes = toEighthFailure
    + ladder[RANK_RETRY_EXHAUSTED_AT - 1]
    + RANK_REQUEUE_MIN_IDLE_MS / 60000;
  assert.equal(minimumIntervalMinutes, 1355);
  assert.equal(requeueMinIntervalMs(), minimumIntervalMinutes * 60 * 1000, "모듈 산술과 수기 계산이 같아야 한다");
  assert.ok(minimumIntervalMinutes * RANK_REQUEUE_DAILY_CAP >= 24 * 60, "24시간 창에 상한 초과 불가");
  const requeueSource = readRepoFile("src/server/naver-rank-requeue.mjs");
  assert.ok(requeueSource.includes("내구적 카운터가 아님"), "표식이 내구적이 아니라는 사실을 명시해야 한다");
});

test("F1: 플레이스 payload 는 원시 retryCount 대신 파생 retryExhausted 를 직렬화한다", () => {
  const placeTrackers = readRepoFile("src/server/handlers/naver-place-rank-trackers.mjs");
  assert.ok(placeTrackers.includes("    retryExhausted: Number(row.retry_count || 0) >= RANK_RETRY_EXHAUSTED_AT,"));
  assert.ok(!placeTrackers.includes("    retryCount: Number(row.retry_count || 0),"));

  const base = { id: "t1", status: "active", current_rank: 3, last_error: null, last_message: "1페이지 3위" };
  const payload = placeTrackerPayload({ ...base, retry_count: 1 }, []);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "retryCount"), false);
  assert.equal(payload.retryExhausted, false);
  assert.equal(placeTrackerPayload({ ...base, retry_count: RANK_RETRY_EXHAUSTED_AT - 1 }, []).retryExhausted, false);
  assert.equal(placeTrackerPayload({ ...base, retry_count: RANK_RETRY_EXHAUSTED_AT }, []).retryExhausted, true);
});

test("F1: 플레이스 payload 는 광고주 화면의 '점검 필요'를 켜지 않는다(오탐 0)", () => {
  // retry_count 는 성공하면 0 으로 돌아가는 일시적 사다리 값이다. 원시 값을 payload 에
  // 실으면 admin/client 양쪽의 placeTrackerNeedsAttention 이 retryCount > 0 만으로
  // 현재 3위인 정상 키워드를 붉게 칠한다. 두 화면 모두에서 false 임을 실행으로 고정한다.
  const payload = placeTrackerPayload(
    { id: "t1", status: "active", current_rank: 3, last_error: null, retry_count: 1, last_message: "1페이지 3위" },
    [],
  );
  for (const [label, source] of [["admin.html", adminSource], ["client.html", clientSource]]) {
    const context = {};
    vm.createContext(context);
    vm.runInContext([
      htmlFunction(source, "placeTrackerNeedsAttention", label),
      "function placeTrackerLatestRank() { return 3; }",
    ].join("\n\n"), context);
    context.__tracker = payload;
    assert.equal(vm.runInContext("placeTrackerNeedsAttention(__tracker)", context), false, label);
    // 소진 파생 불리언은 이 함수가 읽지 않는다(광고주 화면 문구는 그대로 둔다).
    context.__exhausted = { ...payload, retryExhausted: true };
    assert.equal(vm.runInContext("placeTrackerNeedsAttention(__exhausted)", context), false, label);
    // 재큐 문장이 광고주 화면에서 "점검 필요"로 뒤집히면 안 된다.
    context.__requeued = { ...payload, lastMessage: RANK_AUTO_REQUEUE_MESSAGE };
    assert.equal(vm.runInContext("placeTrackerNeedsAttention(__requeued)", context), false, label);
  }
});

// ─────────────────────────────────────────────────────────────
// (E) F2 엔드포인트 계약
// ─────────────────────────────────────────────────────────────
const lane = (key, lastCheckedAt, overdue) => ({ key, lastCheckedAt, overdue });

// 2026-09-02(C2 결함 C·K4): 앞 6키는 이름·순서·의미 불변. 뒤 2키(lanes, trackers)는
// "최악 레인만 보고"의 사각지대(한 레인이 죽어도 다른 레인이 정상이면 사람이 어느
// 레인인지 알 수 없다)와 "며칠째 멈춘/한 번도 못 찾은 추적기"를 드러내는 집계다.
const HEALTH_KEYS_IN_ORDER = [
  "ok",
  "lastSuccessAt",
  "stalledMinutes",
  "queueStalled",
  "workerOutdated",
  "heartbeatAgeMinutes",
  "lanes",
  "trackers",
];
const HEALTH_KEYS_SORTED = [...HEALTH_KEYS_IN_ORDER].sort();
const HEALTH_LANE_KEYS_IN_ORDER = ["lastSuccessAt", "stalledMinutes", "queueStalled"];
const HEALTH_FAILSAFE_LANE = Object.freeze({ lastSuccessAt: null, stalledMinutes: 0, queueStalled: false });
const HEALTH_FAILSAFE_LANES = Object.freeze({ product: HEALTH_FAILSAFE_LANE, place: HEALTH_FAILSAFE_LANE });
// 2026-09-03(F7): trackers 는 5키다. 앞 2키(neverFound, stuck)는 이름·의미 불변이고
// 뒤 3키는 전부 관측 전용 정수다 — 상한 판단도 경보도 하지 않는다.
const HEALTH_TRACKER_KEYS_IN_ORDER = [
  "neverFound",
  "stuck",
  "placePartial",
  "activeProduct",
  "activeProductKeywordGroups",
];
const HEALTH_FAILSAFE_TRACKERS = Object.freeze({
  neverFound: 0,
  stuck: 0,
  placePartial: 0,
  activeProduct: 0,
  activeProductKeywordGroups: 0,
});
// 503 본문. 200 과 같은 8키·같은 순서이며 전부 안전값이다.
const HEALTH_FAILSAFE_BODY = Object.freeze({
  ok: false,
  lastSuccessAt: null,
  stalledMinutes: 0,
  queueStalled: false,
  workerOutdated: false,
  heartbeatAgeMinutes: 0,
  lanes: HEALTH_FAILSAFE_LANES,
  trackers: HEALTH_FAILSAFE_TRACKERS,
});

test("F2: 응답 키 집합은 정확히 8개이며 순서까지 고정이다", () => {
  const body = rankCollectionHealthBody({ now: NOW, lanes: [] });
  // 정렬 없이 비교한다 — scripts/verify-live.mjs 는 정렬 키 배열과 개수를 함께 보고,
  // 워치독 셸은 본문을 grep 으로 읽으므로 키가 늘거나 순서가 흔들리면 둘 다 깨진다.
  assert.deepEqual(Object.keys(body), HEALTH_KEYS_IN_ORDER);
  assert.deepEqual(Object.keys(body).sort(), HEALTH_KEYS_SORTED);
  // 앞 4키의 의미는 그대로다: 데이터가 없으면 null·0·false.
  assert.equal(body.ok, true);
  assert.equal(body.lastSuccessAt, null);
  assert.equal(body.stalledMinutes, 0);
  assert.equal(body.queueStalled, false);
  // 뒤 2키도 신호가 없으면 단정하지 않는다.
  assert.equal(body.workerOutdated, false);
  assert.equal(body.heartbeatAgeMinutes, 0);
  // 7·8번째 키도 입력이 없으면 안전값이다.
  assert.deepEqual(body.lanes, HEALTH_FAILSAFE_LANES);
  assert.deepEqual(body.trackers, HEALTH_FAILSAFE_TRACKERS);
  // verify-live 의 계약 배열과 실제 응답이 같은 집합인지 소스로 대조한다.
  const verifyLive = readRepoFile("scripts/verify-live.mjs");
  for (const key of HEALTH_KEYS_SORTED) {
    assert.ok(verifyLive.includes(`"${key}"`), `verify-live 계약에 ${key} 가 있어야 한다`);
  }
  // verify-live 는 개수 정확 대조를 유지한다(8키 초과·미달 모두 FAIL).
  assert.ok(verifyLive.includes("rankKeys.length === RANK_HEALTH_KEYS.length"));
  const arrayStart = verifyLive.indexOf("const RANK_HEALTH_KEYS = [");
  const arrayEnd = verifyLive.indexOf("];", arrayStart);
  const declared = [...verifyLive.slice(arrayStart, arrayEnd).matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(declared, HEALTH_KEYS_SORTED, "verify-live 계약 배열은 정렬된 8키와 정확히 같아야 한다");
});

test("F2: 가장 오래된(worst) 레인이 lastSuccessAt 이다", () => {
  // 전제 반전. 옛 구현은 두 레인의 MAX 를 lastSuccessAt 으로 냈고, 이 입력에서
  // lastSuccessAt=-2시간 / stalledMinutes=120 / queueStalled=false 를 돌려주며
  // 10시간째 죽어 있는 상품 레인을 통째로 은폐했다.
  const body = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", at(-10 * HOUR), true), lane("place", at(-2 * HOUR), false)],
  });
  assert.equal(body.ok, true);
  assert.equal(body.lastSuccessAt, at(-10 * HOUR));
  assert.equal(body.stalledMinutes, 600);
  assert.equal(body.queueStalled, true, "상품 레인이 10시간째 정체다");
});

test("F2: 레인 분리 — 한 레인의 성공이 다른 레인의 정체를 덮지 않는다", () => {
  // 상품(맥 Chrome 하이브리드 워커)과 플레이스(서버 크론)는 완전히 독립된 두 계통이다.
  // MAX 합산이던 옛 구현은 여기서 queueStalled=false 였고, 하루 24시간 중 13시간의
  // 정체를 은폐했다. 워치독의 "60분 연속" 조건도 하루 두 번 리셋되어 영원히
  // 채워지지 않았다.
  const productDead = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", at(-48 * HOUR), true), lane("place", at(-11 * 60 * 1000), false)],
  });
  assert.equal(productDead.queueStalled, true);
  assert.equal(productDead.lastSuccessAt, at(-48 * HOUR));
  assert.equal(productDead.stalledMinutes, 2880);

  // 반대 방향도 같은 계약이다.
  const placeDead = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", at(-11 * 60 * 1000), false), lane("place", at(-48 * HOUR), true)],
  });
  assert.equal(placeDead.queueStalled, true);
  assert.equal(placeDead.lastSuccessAt, at(-48 * HOUR));
  assert.equal(placeDead.stalledMinutes, 2880);

  // 둘 다 건강하면 false 다.
  const healthy = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", at(-11 * 60 * 1000), true), lane("place", at(-11 * 60 * 1000), true)],
  });
  assert.equal(healthy.queueStalled, false);

  // 정체 레인에 대기 중인 일이 없으면(overdue false) 정상 유휴다.
  const idle = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", at(-48 * HOUR), false), lane("place", at(-11 * 60 * 1000), false)],
  });
  assert.equal(idle.queueStalled, false);
  assert.equal(idle.lastSuccessAt, at(-48 * HOUR), "정체 판정과 무관하게 worst 는 그대로 보고한다");
});

test("F2: queueStalled 는 '지연 있음' AND '6시간 무수집' 이다", () => {
  const only = (lastCheckedAt, overdue) => rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", lastCheckedAt, overdue)],
  }).queueStalled;
  // 둘 다 성립할 때만 true.
  assert.equal(only(at(-24 * HOUR), true), true);
  // 지연은 있지만 수집은 돌고 있다 → 정상 백로그. 운영 hybrid 경로의 상시 상태다.
  assert.equal(only(at(-11 * 60 * 1000), true), false);
  // 수집이 오래 없지만 대기 중인 일이 없다 → 정상 유휴(다음 정시 슬롯 대기).
  assert.equal(only(at(-24 * HOUR), false), false);
  // 6시간 경계.
  assert.equal(only(at(-(6 * HOUR - 60 * 1000)), true), false);
  assert.equal(only(at(-(6 * HOUR + 60 * 1000)), true), true);
});

test("F2: deliberateStop 이 참이면 queueStalled 를 눌러 둔다(상태 필드는 늘리지 않는다)", () => {
  const stalled = { now: NOW, lanes: [lane("product", at(-24 * HOUR), true)] };
  assert.equal(rankCollectionHealthBody(stalled).queueStalled, true);
  assert.equal(rankCollectionHealthBody({ ...stalled, deliberateStop: true }).queueStalled, false);
  // 무엇이 deliberateStop 인지는 아래 deliberateWorkerStopFromRow 테스트가 고정한다.
  assert.deepEqual(
    Object.keys(rankCollectionHealthBody({ ...stalled, deliberateStop: true })).sort(),
    HEALTH_KEYS_SORTED,
  );
});

test("F2: 의도된 정지는 쿨다운과 사람이 세운 사유 둘뿐이다(실행 검증)", () => {
  // 전제 반전. 옛 구현은 circuit_state 가 open/half_open 이면 무조건 "의도된 정지"로
  // 눌렀다. 회로가 열리는 사유 6종 중 5종은 수집기 자신의 실패로 자동 설정되고,
  // Chrome 이 죽으면 open 에서 나가는 유일한 경로("10분 뒤 primary worker 요청")가
  // 막혀 회로가 영구히 open 에 머문다(sticky). 즉 정확히 진짜 사고에서 워치독이
  // 영원히 침묵했다.
  for (const row of [
    { circuit_state: "open", circuit_reason: "probe_interrupted" },
    { circuit_state: "open", circuit_reason: "navigating:naver_page_navigation_failed" },
    { circuit_state: "half_open", circuit_reason: "auto_navigation_probe" },
    { circuit_state: "half_open", circuit_reason: "auto_transient_system_probe" },
    { circuit_state: "open", circuit_reason: "probe_incomplete" },
    { circuit_state: "open", circuit_reason: null },
    { circuit_state: "open" },
    {},
  ]) {
    assert.equal(deliberateWorkerStopFromRow(row, NOW), false, JSON.stringify(row));
  }
  assert.equal(deliberateWorkerStopFromRow(null, NOW), false);

  // 사람이 세운 경우만 true.
  assert.equal(deliberateWorkerStopFromRow({ circuit_state: "open", circuit_reason: "manual_stop" }, NOW), true);
  assert.equal(deliberateWorkerStopFromRow({ circuit_reason: "manual_canary" }, NOW), true);
  assert.equal(deliberateWorkerStopFromRow({ circuit_reason: "  MANUAL_STOP  " }, NOW), true);

  // 쿨다운은 자동으로 걸리지만 그 구간의 Chrome 재기동은 해롭다.
  assert.equal(deliberateWorkerStopFromRow({ cooldown_until: at(30 * 60 * 1000) }, NOW), true);
  assert.equal(deliberateWorkerStopFromRow({ cooldown_until: at(-30 * 60 * 1000) }, NOW), false);
  assert.equal(deliberateWorkerStopFromRow({ cooldown_until: "not-a-date" }, NOW), false);
});

test("F2: 회로 사유 목록이 마이그레이션 원본과 일치한다", () => {
  // 사람이 세우는 사유. manual_stop 은 mi_stop_naver_shopping_worker 의 p_reason 기본값,
  // manual_canary 는 같은 파일의 1건 검증 프로브에서만 기록된다.
  const controlPlane = readRepoFile("supabase/migrations/20260811095137_naver_shopping_worker_control_plane.sql");
  assert.ok(controlPlane.includes("  p_reason text default 'manual_stop'"));
  assert.ok(controlPlane.includes("      circuit_reason = 'manual_canary',"));
  // 자동으로 설정되는 사유들. 목록이 바뀌면 이 테스트가 먼저 실패해야 한다.
  const taxonomy = readRepoFile("supabase/migrations/20260821180001_naver_shopping_error_taxonomy_hardening.sql");
  for (const reason of [
    "auto_navigation_probe",
    "auto_transient_system_probe",
    "navigating:naver_page_navigation_failed",
    "probe_incomplete",
    "probe_interrupted",
  ]) {
    assert.ok(taxonomy.includes(`'${reason}'`), `taxonomy migration must set ${reason}`);
    assert.equal(deliberateWorkerStopFromRow({ circuit_reason: reason }, NOW), false, reason);
  }
  assert.ok(healthHandlerSource.includes('const DELIBERATE_CIRCUIT_REASONS = new Set(["manual_stop", "manual_canary"]);'));
});

test("F2: 핸들러가 의도된 정지 상태를 실제로 읽어 전달한다", () => {
  assert.ok(healthHandlerSource.includes('const WORKER_COORDINATION_TABLE = "naver_shopping_worker_coordination";'));
  assert.ok(healthHandlerSource.includes("async function deliberateWorkerStop(ctx, now)"));
  // heartbeatAgeMinutes 의 두 재료를 같은 행에서 함께 읽는다 — 왕복은 늘리지 않는다.
  assert.ok(healthHandlerSource.includes('.select("circuit_state, circuit_reason, cooldown_until, primary_seen_at, last_success_at")'));
  assert.ok(healthHandlerSource.includes("deliberateStop: deliberateWorkerStopFromRow(data, now),"));
  assert.ok(healthHandlerSource.includes("deliberateWorkerStop(ctx, now),"));
  assert.ok(healthHandlerSource.includes("deliberateStop,"));
  // 컬럼이 아직 없는 환경에서는 cooldown_until 만 다시 읽는다.
  assert.ok(healthHandlerSource.includes('/circuit_state|circuit_reason|schema cache|does not exist/i.test(error.message || "")'));
  assert.ok(healthHandlerSource.includes('.select("cooldown_until")'));
  // 읽기 실패는 "의도된 정지 아님"으로 두어 정체 감지를 죽이지 않는다.
  // 반환이 객체가 된 뒤에도 안전 기본값(empty)의 deliberateStop 은 false 그대로다.
  assert.ok(healthHandlerSource.includes("if (error || !data) return empty;"));
  assert.ok(healthHandlerSource.includes('const empty = { deliberateStop: false, primarySeenAt: "", lastSuccessAt: "" };'));
  // circuit_state 만으로 억제하던 옛 규칙은 남아 있으면 안 된다.
  assert.ok(!healthHandlerSource.includes('if (circuitState === "open" || circuitState === "half_open") return true;'));
});

test("F2: 데이터가 없으면 null·0·false 로 응답한다", () => {
  const body = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", "", false), lane("place", null, true)],
  });
  assert.equal(body.lastSuccessAt, null);
  assert.equal(body.stalledMinutes, 0);
  assert.equal(body.queueStalled, false, "수집 이력이 없는 레인은 정체로 단정하지 않는다");
});

test("F2: stalledMinutes 는 분 단위 내림이다", () => {
  const body = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", at(-(119 * 60 * 1000 + 59_000)), false)],
  });
  assert.equal(body.stalledMinutes, 119);
});

// ── 7번째 키 lanes (C2 결함 C·K4) ──
test("F2: lanes 는 레인별 lastSuccessAt·stalledMinutes·queueStalled 를 각각 낸다", () => {
  // 상품 10시간 정체 + 플레이스 30분 전 정상. 최상위 4키는 최악 레인(상품)만 말하고,
  // lanes 는 두 레인을 각각 말한다 — 어느 레인이 죽었는지 이 응답만으로 알 수 있다.
  const body = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", at(-10 * HOUR), true), lane("place", at(-30 * 60 * 1000), true)],
  });
  assert.deepEqual(Object.keys(body.lanes), ["product", "place"]);
  assert.deepEqual(Object.keys(body.lanes.product), HEALTH_LANE_KEYS_IN_ORDER);
  assert.deepEqual(Object.keys(body.lanes.place), HEALTH_LANE_KEYS_IN_ORDER);
  assert.deepEqual(body.lanes.product, { lastSuccessAt: at(-10 * HOUR), stalledMinutes: 600, queueStalled: true });
  assert.deepEqual(body.lanes.place, { lastSuccessAt: at(-30 * 60 * 1000), stalledMinutes: 30, queueStalled: false });
  // 기존 4키의 의미는 그대로다(최악 레인).
  assert.equal(body.lastSuccessAt, at(-10 * HOUR));
  assert.equal(body.stalledMinutes, 600);
  assert.equal(body.queueStalled, true);
  // 반대 방향(플레이스만 죽음)도 대칭이다.
  const placeDead = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", at(-30 * 60 * 1000), true), lane("place", at(-10 * HOUR), true)],
  });
  assert.equal(placeDead.lanes.product.queueStalled, false);
  assert.equal(placeDead.lanes.place.queueStalled, true);
  assert.equal(placeDead.lanes.place.stalledMinutes, 600);
  assert.equal(placeDead.queueStalled, true);
});

test("F2: 최상위 queueStalled 는 레인 queueStalled 의 OR 과 항상 같다(워치독 grep 안전)", () => {
  // 워치독은 본문 전체를 grep -Eq '"queueStalled": true' 로 읽는다. 중첩된 true 가 최상위
  // false 와 공존하면 오탐이 난다. 그래서 "최상위 = OR(레인)" 을 불변식으로 고정한다.
  // 의도된 정지(deliberateStop)도 레인까지 함께 눌러야 불변식이 유지된다.
  const stalledAt = at(-10 * HOUR);
  const freshAt = at(-30 * 60 * 1000);
  const variants = [[stalledAt, true], [freshAt, true], [stalledAt, false], ["", true], [null, false]];
  let checked = 0;
  for (const product of variants) {
    for (const place of variants) {
      for (const deliberateStop of [false, true]) {
        const body = rankCollectionHealthBody({
          now: NOW,
          lanes: [lane("product", ...product), lane("place", ...place)],
          deliberateStop,
        });
        const laneOr = body.lanes.product.queueStalled || body.lanes.place.queueStalled;
        assert.equal(body.queueStalled, laneOr, JSON.stringify({ product, place, deliberateStop }));
        if (deliberateStop) {
          assert.equal(body.lanes.product.queueStalled, false);
          assert.equal(body.lanes.place.queueStalled, false);
        }
        checked += 1;
      }
    }
  }
  assert.equal(checked, variants.length * variants.length * 2);
});

test("F2: 입력 레인이 비어 있거나 이력이 없어도 lanes 두 키는 항상 안전값으로 있다", () => {
  const empty = rankCollectionHealthBody({ now: NOW, lanes: [] });
  assert.deepEqual(empty.lanes, HEALTH_FAILSAFE_LANES);
  const noHistory = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("product", "", true), lane("place", null, true)],
  });
  assert.deepEqual(noHistory.lanes, HEALTH_FAILSAFE_LANES, "수집 이력이 없는 레인은 정체로 단정하지 않는다");
  const missingInput = rankCollectionHealthBody({ now: NOW });
  assert.deepEqual(missingInput.lanes, HEALTH_FAILSAFE_LANES);
  // 한 레인만 들어와도 다른 레인 키는 사라지지 않는다.
  const onlyProduct = rankCollectionHealthBody({ now: NOW, lanes: [lane("product", at(-HOUR), false)] });
  assert.deepEqual(Object.keys(onlyProduct.lanes), ["product", "place"]);
  assert.deepEqual(onlyProduct.lanes.place, HEALTH_FAILSAFE_LANE);
  assert.equal(onlyProduct.lanes.product.stalledMinutes, 60);
});

test("F2: 레인 stalledMinutes 도 분 단위 내림이며 6시간 경계는 초과여야 정체다", () => {
  const body = rankCollectionHealthBody({
    now: NOW,
    lanes: [
      lane("product", at(-(119 * 60 * 1000 + 59_000)), true),
      lane("place", at(-RANK_OVERDUE_THRESHOLD_MS), true),
    ],
  });
  assert.equal(body.lanes.product.stalledMinutes, 119);
  assert.equal(body.lanes.product.queueStalled, false, "6시간 미만 무수집은 정체가 아니다");
  assert.equal(body.lanes.place.stalledMinutes, 360);
  assert.equal(body.lanes.place.queueStalled, false, "정확히 6시간은 초과가 아니다");
  const over = rankCollectionHealthBody({
    now: NOW,
    lanes: [lane("place", at(-(RANK_OVERDUE_THRESHOLD_MS + 1000)), true)],
  });
  assert.equal(over.lanes.place.queueStalled, true);
});

// ── 8번째 키 trackers (C2 결함 C) ──
test("F2: trackers 는 비음수 정수만 받고 그 외는 0 으로 접는다(fail-safe)", () => {
  const base = { now: NOW, lanes: [] };
  const trackersOf = (trackers) => rankCollectionHealthBody({ ...base, trackers }).trackers;
  const full = (patch) => ({ ...HEALTH_FAILSAFE_TRACKERS, ...patch });
  assert.deepEqual(rankCollectionHealthBody(base).trackers, HEALTH_FAILSAFE_TRACKERS);
  // 키 이름뿐 아니라 순서까지 고정한다 — 앞 2키는 워치독이 이미 읽는 자리다.
  assert.deepEqual(Object.keys(rankCollectionHealthBody(base).trackers), HEALTH_TRACKER_KEYS_IN_ORDER);
  assert.deepEqual(trackersOf({ neverFound: 3, stuck: 2 }), full({ neverFound: 3, stuck: 2 }));
  assert.deepEqual(trackersOf({ neverFound: 0, stuck: 0 }), HEALTH_FAILSAFE_TRACKERS);
  assert.deepEqual(trackersOf({ neverFound: NaN, stuck: -1 }), HEALTH_FAILSAFE_TRACKERS);
  assert.deepEqual(trackersOf({ neverFound: null, stuck: undefined }), HEALTH_FAILSAFE_TRACKERS);
  assert.deepEqual(trackersOf({ neverFound: Infinity, stuck: "x" }), HEALTH_FAILSAFE_TRACKERS);
  assert.deepEqual(trackersOf({ neverFound: "4", stuck: 2.7 }), full({ neverFound: 4, stuck: 2 }));
  assert.deepEqual(rankCollectionHealthBody({ ...base, trackers: null }).trackers, HEALTH_FAILSAFE_TRACKERS);

  // 새 3키도 같은 규약을 그대로 받는다.
  assert.deepEqual(
    trackersOf({ placePartial: 4, activeProduct: 71, activeProductKeywordGroups: 58 }),
    full({ placePartial: 4, activeProduct: 71, activeProductKeywordGroups: 58 }),
  );
  assert.deepEqual(
    trackersOf({ placePartial: NaN, activeProduct: -1, activeProductKeywordGroups: Infinity }),
    HEALTH_FAILSAFE_TRACKERS,
  );
  assert.deepEqual(
    trackersOf({ placePartial: "x", activeProduct: null, activeProductKeywordGroups: undefined }),
    HEALTH_FAILSAFE_TRACKERS,
  );
  assert.deepEqual(
    trackersOf({ placePartial: "5", activeProduct: 71.9, activeProductKeywordGroups: "58" }),
    full({ placePartial: 5, activeProduct: 71, activeProductKeywordGroups: 58 }),
  );
  // 5키 전부 정수다(공개 표면에 소수·문자열이 새지 않는다).
  for (const value of Object.values(trackersOf({ placePartial: "5", activeProduct: 71.9, activeProductKeywordGroups: "58" }))) {
    assert.ok(Number.isInteger(value) && value >= 0, String(value));
  }
});

test("F2: 추적기 집계 기준은 서버 상수를 import 한다(하드코딩 금지)", () => {
  assert.ok(healthHandlerSource.includes("RANK_STUCK_TRACKER_MS"), "36시간 기준은 naver-rank-requeue.mjs 상수여야 한다");
  assert.ok(healthHandlerSource.includes("RANK_NEVER_FOUND_MIN_CHECKS"), "최소 확인 횟수도 상수여야 한다");
  assert.ok(!/36\s*\*\s*60/.test(healthHandlerSource), "핸들러 안에서 36시간을 다시 곱하지 않는다");
  // 두 집계는 관측 전용이다 — 조회 실패가 503 으로 번지면 안 되므로 try/catch 로 접는다.
  assert.ok(healthHandlerSource.includes("async function countActiveTrackers("));
  // placePartial 임계값도 서버 상수다. 4 를 핸들러에 다시 적어 두면 잔존 감사·총관리자
  // 카운터와 조용히 어긋난다(세 화면이 같은 행을 세야 한다).
  assert.equal(RANK_PLACE_PARTIAL_MIN_RETRIES, 4);
  assert.ok(healthHandlerSource.includes("RANK_PLACE_PARTIAL_MIN_RETRIES"), "partial 임계값은 상수 import 여야 한다");
  assert.ok(!healthHandlerSource.includes('retry_count", 4'), "임계값을 핸들러에 하드코딩하지 않는다");
  assert.ok(!healthHandlerSource.includes("gte.4"), "질의 문자열에도 4 를 박아 두지 않는다");
});

test("F2: 엔드포인트는 계정 데이터를 노출하지 않는다", () => {
  for (const forbidden of ["agency", "client", "keyword", "place_name", "product_title"]) {
    assert.ok(!healthHandlerSource.includes(forbidden), `health handler must not mention ${forbidden}`);
  }
});

test("F7: 용량 모듈은 행 본문을 남기지 않고 정수만 돌려준다", async () => {
  // 계정 데이터 열을 읽는 코드는 핸들러가 아니라 이 모듈에 둔다. 위 가드(핸들러 소스에
  // 금지어가 없어야 한다)를 지키면서도 열을 읽어야 하므로 파일명·식별자에 소문자 금지어를
  // 쓰지 않는다. 대신 이 모듈에는 로그가 한 줄도 없어야 한다.
  assert.ok(!rankCapacitySource.includes("console."), "용량 모듈은 무엇도 로그하지 않는다");
  assert.ok(!rankCapacitySource.includes("JSON.stringify"), "행 본문을 직렬화하지 않는다");
  // 핸들러가 import 하는 경로·식별자에도 소문자 금지어가 없다.
  assert.ok(healthHandlerSource.includes('from "../rank-capacity.mjs"'));
  assert.ok(healthHandlerSource.includes("countActiveProductKeywordGroups"));

  // 성공 경로도 실패 경로도 반환은 언제나 정수다.
  const ok = await countActiveProductKeywordGroups(capacityClient([[{ keyword: "아이폰 케이스" }]]).client);
  assert.ok(Number.isInteger(ok) && ok >= 0);
  const failed = await countActiveProductKeywordGroups(null);
  assert.equal(failed, 0);
  assert.ok(Number.isInteger(failed));
});

test("F2: 캐시 헤더와 TTL 이 계약대로다", () => {
  assert.ok(healthHandlerSource.includes('"public, max-age=60, s-maxage=60, stale-while-revalidate=120"'));
  assert.ok(healthHandlerSource.includes("const CACHE_TTL_MS = 60_000;"));
  assert.ok(healthHandlerSource.includes('"retry-after": "60"'));
  assert.ok(healthHandlerSource.includes('"cache-control": "no-store"'));
});

test("F2: 실패 응답도 캐시해 장애를 증폭시키지 않는다(실행 검증)", async () => {
  // 성공만 캐시하면 Supabase 장애 중 무인증 요청 1건마다 service-role 쿼리 5건이
  // 그대로 나간다. 캐시 엔트리에 status/헤더를 함께 담아 503 을 그대로 재현한다.
  assert.ok(healthHandlerSource.includes("const FAILURE_CACHE_TTL_MS = 15_000;"));
  assert.ok(healthHandlerSource.includes("expiresAt: now + FAILURE_CACHE_TTL_MS,"));
  assert.ok(healthHandlerSource.includes("return protectedJson(request, cached.body, cached.status, {"));
  assert.ok(healthHandlerSource.includes("extraHeaders: cached.extraHeaders,"));

  // 모듈 수준 cached 는 이 테스트에서만 채워진다(다른 테스트는 순수 함수만 호출한다).
  const envNames = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY"];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  let dbCalls = 0;
  Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SECRET_KEY: "sb_secret_rank_collection_health_test",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_rank_collection_health_test",
  });
  globalThis.fetch = async () => { dbCalls += 1; throw new Error("supabase_unreachable"); };
  try {
    const first = await rankCollectionHealthHandler.fetch(new Request("https://example.com/api/rank-collection-health"));
    assert.equal(first.status, 503);
    assert.equal(first.headers.get("retry-after"), "60");
    // 503 도 200 과 같은 8키·같은 순서다. 관측 키·레인·추적기 집계는 전부 안전값으로 나간다.
    assert.deepEqual(await first.json(), HEALTH_FAILSAFE_BODY);
    assert.ok(dbCalls > 0, "첫 요청은 실제로 DB 를 친다");

    const before = dbCalls;
    const second = await rankCollectionHealthHandler.fetch(new Request("https://example.com/api/rank-collection-health"));
    assert.equal(second.status, 503, "캐시 히트도 같은 상태코드를 재현한다");
    assert.equal(second.headers.get("retry-after"), "60");
    assert.deepEqual(await second.json(), HEALTH_FAILSAFE_BODY);
    assert.equal(dbCalls - before, 0, "두 번째 요청은 DB 를 다시 치지 않는다");
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of envNames) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
  }
});

test("F2: 실측 — 런타임 래퍼가 cache-control 을 no-store 로 되돌린다", () => {
  // 로컬 dev 서버 curl 실측 결과 최종 응답 헤더는 cache-control: no-store 였다.
  // 그 원인이 여기 있다는 사실을 고정해 둔다. CDN 캐시를 전제로 설계하면 안 된다.
  const runtimeSource = readRepoFile("src/server/runtime.mjs");
  assert.ok(runtimeSource.includes("for (const [name, value] of Object.entries(runtimeCors)) {"));
  assert.ok(runtimeSource.includes('if (name === "vary" || name.startsWith("access-control-")) continue;'));
  assert.ok(runtimeSource.includes("headers.set(name, value);"));
  const securitySource = readRepoFile("src/server/security.mjs");
  assert.ok(securitySource.includes('"cache-control": "no-store",'));
  assert.ok(
    healthHandlerSource.includes("실제로는 cache-control: no-store 로"),
    "핸들러에 실측 사실이 주석으로 남아 있어야 한다",
  );
});

test("F2: 라우팅은 세션 프리 경로와 catch-all dispatch 로만 붙는다", () => {
  assert.ok(sessionGateSource.includes('"/api/rank-collection-health",'));
  assert.ok(serverIndexSource.includes('dispatch("rankCollectionHealth", request)'));
  assert.ok(serverIndexSource.includes('rankCollectionHealth: () => import("./handlers/rank-collection-health.mjs"),'));
});

test("F2: api/ 아래에 새 물리 파일을 만들지 않았다(12함수 한도 보호)", () => {
  const apiEntries = fs.readdirSync(path.join(repositoryRoot, "api"));
  assert.ok(!apiEntries.some((entry) => entry.includes("rank-collection-health")));
  assert.ok(apiEntries.includes("[...path].mjs"), "단일 세그먼트 경로는 catch-all 이 받는다");
});

// ─────────────────────────────────────────────────────────────
// (E-2) 낡은 실행본 관측 — 2026-09-01 17시간 중단의 사각지대
// 게이트(naver-shopping-local-worker.mjs)는 runtimeVersion 이 기대값과 다르면 claim RPC
// 앞에서 400 으로 끊는다 → primary_seen_at 이 얼어붙는다. 그런데 nonce 소비는 그 검사보다
// 먼저라 거부당하는 워커도 매분 서명을 남긴다. 실측(2026-09-01T08:30Z): nonce 54초 전 /
// primary_seen_at 14.4시간 전. 이 동시 성립만이 "낡은 실행본"의 지문이다.
// ─────────────────────────────────────────────────────────────
const SIGNING_WINDOW_MINUTES = WORKER_OUTDATED_SIGNING_WINDOW_MS / 60_000;
const OUTDATED_VERSION = "1.1.19"; // 사고 당시 윈도우 워커가 실제로 돌던 실행본

test("F2: 관측자 상수가 게이트·크론과 같은 축을 쓴다", () => {
  assert.equal(WORKER_OUTDATED_SIGNING_WINDOW_MS, 1_800_000);
  assert.equal(SIGNING_WINDOW_MINUTES, 30, "HYBRID_WORKER_SILENCE_MINUTES 와 같은 30분이다");
  assert.equal(WORKER_HEARTBEAT_STALE_MINUTES, 15);
  assert.notEqual(OUTDATED_VERSION, EXPECTED_WORKER_RUNTIME_VERSION, "재현용 버전은 기대값과 달라야 한다");
});

test("F2: workerOutdated 는 '버전 불일치 AND 최근 서명' 일 때만 참이다", () => {
  const judge = (lastRunRuntimeVersion, lastSignatureAt) => workerOutdatedFromSignals({
    lastRunRuntimeVersion,
    lastSignatureAt,
    now: NOW,
    expectedRuntimeVersion: EXPECTED_WORKER_RUNTIME_VERSION,
  });

  // 참이 되는 유일한 자리: 아직 매분 서명하는데 마지막으로 받아들여진 실행 기록이 낡았다.
  assert.equal(judge(OUTDATED_VERSION, at(-54_000)), true, "실측 지문(서명 54초 전)");
  assert.equal(judge(OUTDATED_VERSION, at(-(SIGNING_WINDOW_MINUTES - 1) * 60 * 1000)), true, "창 안쪽 경계");
  assert.equal(judge(OUTDATED_VERSION, at(60 * 1000)), true, "미래 시각 서명은 신선한 것으로 센다");

  // 버전이 같으면 서명이 아무리 신선해도 거짓이다.
  assert.equal(judge(EXPECTED_WORKER_RUNTIME_VERSION, at(-54_000)), false);

  // 꺼 둔 작업기 / 막 배포된 서버. 최신 실행 기록은 낡은 채 멈춰 있지만 서명이 끊겼다.
  // 이 자리를 참으로 두면 대표님이 의도적으로 꺼 둔 밤 내내 거짓 지시가 뜬다.
  assert.equal(judge(OUTDATED_VERSION, at(-(SIGNING_WINDOW_MINUTES + 1) * 60 * 1000)), false, "꺼진 작업기");
  assert.equal(judge(OUTDATED_VERSION, at(-24 * HOUR)), false, "하루째 꺼져 있는 작업기");
  assert.equal(judge(OUTDATED_VERSION, ""), false, "서명 없음");
  assert.equal(judge(OUTDATED_VERSION, null), false);
  assert.equal(judge(OUTDATED_VERSION, "not-a-date"), false);

  // 실행 이력이 없으면 판정 자체가 성립하지 않는다.
  assert.equal(judge("", at(-54_000)), false, "실행 이력 없음");
  assert.equal(judge(null, at(-54_000)), false);
  assert.equal(judge("   ", at(-54_000)), false);
  assert.equal(judge("1.1", at(-54_000)), false, "파싱 불가한 버전");
  assert.equal(judge("latest", at(-54_000)), false);

  // 기대값 자체를 읽지 못하면 비교가 성립하지 않는다.
  assert.equal(workerOutdatedFromSignals({
    lastRunRuntimeVersion: OUTDATED_VERSION,
    lastSignatureAt: at(-54_000),
    now: NOW,
    expectedRuntimeVersion: "garbage",
  }), false);
  // 기대값을 생략하면 관측자 기본값(게이트 사본)을 쓴다.
  assert.equal(workerOutdatedFromSignals({
    lastRunRuntimeVersion: OUTDATED_VERSION,
    lastSignatureAt: at(-54_000),
    now: NOW,
  }), true);
  assert.equal(workerOutdatedFromSignals({}), false, "입력이 비면 절대 단정하지 않는다");
});

test("F2: 2026-09-01 사고 수치 재현 — 서명 54초 / 진척 14.4시간", () => {
  const body = rankCollectionHealthBody({
    now: NOW,
    lanes: [],
    lastRunRuntimeVersion: OUTDATED_VERSION,
    lastSignatureAt: at(-54_000),      // 최신 nonce 54초 전
    primarySeenAt: at(-14.4 * HOUR),   // primary_seen_at 14.4시간 전
  });
  assert.equal(body.workerOutdated, true);
  assert.equal(body.heartbeatAgeMinutes, 864, "14.4시간 = 864분");
  // 앞 4키는 이 신호에 전혀 영향받지 않는다 — 레인 표가 비었으므로 그대로 null·0·false.
  assert.equal(body.ok, true);
  assert.equal(body.lastSuccessAt, null);
  assert.equal(body.stalledMinutes, 0);
  assert.equal(body.queueStalled, false, "대기 중인 일이 없으면 정체가 아니다 — 그래서 사각지대였다");
  // 버전 문자열도 기기 식별자도 응답에 실리지 않는다.
  assert.ok(!JSON.stringify(body).includes(OUTDATED_VERSION));
  assert.ok(!JSON.stringify(body).includes(EXPECTED_WORKER_RUNTIME_VERSION));
});

test("F2: heartbeatAgeMinutes 는 두 표식 중 최신 기준의 비음수 정수다", () => {
  // 둘 중 더 최신을 쓴다. 오래된 쪽을 쓰면 한창 수집 중인 워커가 늙어 보인다.
  assert.equal(heartbeatAgeMinutes({
    primarySeenAt: at(-14.4 * HOUR),
    lastSuccessAt: at(-30 * 60 * 1000),
    now: NOW,
  }), 30);
  assert.equal(heartbeatAgeMinutes({
    primarySeenAt: at(-30 * 60 * 1000),
    lastSuccessAt: at(-14.4 * HOUR),
    now: NOW,
  }), 30);
  // 한쪽만 있어도 그 값으로 잰다.
  assert.equal(heartbeatAgeMinutes({ primarySeenAt: at(-14.4 * HOUR), lastSuccessAt: null, now: NOW }), 864);
  assert.equal(heartbeatAgeMinutes({ primarySeenAt: "", lastSuccessAt: at(-2 * HOUR), now: NOW }), 120);
  // 내림이다.
  assert.equal(heartbeatAgeMinutes({ primarySeenAt: at(-(119 * 60 * 1000 + 59_000)), now: NOW }), 119);
  // 판독 불가는 0 이다 — stalledMinutes 와 같은 안전 방향. 큰 숫자로 부풀리면 스키마
  // 드리프트 한 번에 워치독이 Chrome 을 재기동한다.
  assert.equal(heartbeatAgeMinutes({ now: NOW }), 0);
  assert.equal(heartbeatAgeMinutes({ primarySeenAt: null, lastSuccessAt: "", now: NOW }), 0);
  assert.equal(heartbeatAgeMinutes({ primarySeenAt: "not-a-date", now: NOW }), 0);
  assert.equal(heartbeatAgeMinutes({}), 0);
  // 미래 시각(작업기 시계 앞섬)은 음수 대신 0 으로 누른다.
  const future = heartbeatAgeMinutes({ primarySeenAt: at(90 * 60 * 1000), now: NOW });
  assert.equal(future, 0);
  assert.ok(Number.isInteger(future) && future >= 0);
});

// 핸들러 레벨. 모듈 최상단 cached(성공 60초/실패 15초)는 URL 로 갈리지 않고 시간으로만
// 만료되므로, 위 실패 캐시 테스트와 섞이면 서로의 응답을 재현해 버린다. 쿼리스트링을
// 붙여 ESM 인스턴스를 따로 받아 각자의 cached 를 갖게 한다(핸들러에 테스트 전용
// 초기화 export 를 추가하지 않기 위한 방법이다).
const HEALTH_ENV_NAMES = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY"];
const jsonRows = (rows) => new Response(JSON.stringify(rows), {
  status: 200,
  headers: { "content-type": "application/json" },
});

async function freshRankHealthHandler(tag) {
  const module = await import(`../src/server/handlers/rank-collection-health.mjs?observer=${tag}`);
  return module.default;
}

function stubHealthSupabase(routes) {
  const previousEnv = Object.fromEntries(HEALTH_ENV_NAMES.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:2",
    SUPABASE_SECRET_KEY: "sb_secret_rank_health_observer_test",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_rank_health_observer_test",
  });
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input || "");
    calls.push(url);
    for (const [table, respond] of Object.entries(routes)) {
      if (url.includes(`/rest/v1/${table}`)) return respond();
    }
    return jsonRows([]);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previousFetch;
      for (const name of HEALTH_ENV_NAMES) {
        if (previousEnv[name] === undefined) delete process.env[name];
        else process.env[name] = previousEnv[name];
      }
    },
  };
}

test("F2: 핸들러가 두 관측 키를 실제 조회 결과로 채운다(사고 재현)", async () => {
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  const stub = stubHealthSupabase({
    naver_shopping_worker_runs: () => jsonRows([{ runtime_version: OUTDATED_VERSION }]),
    naver_shopping_worker_nonces: () => jsonRows([{ created_at: iso(-54_000) }]),
    naver_shopping_worker_coordination: () => jsonRows([{
      circuit_state: null,
      circuit_reason: null,
      cooldown_until: null,
      primary_seen_at: iso(-14.4 * HOUR),
      last_success_at: null,
    }]),
  });
  try {
    const handler = await freshRankHealthHandler("incident");
    const response = await handler.fetch(new Request("https://example.com/api/rank-collection-health"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), HEALTH_KEYS_IN_ORDER);
    assert.equal(body.workerOutdated, true);
    assert.equal(body.heartbeatAgeMinutes, 864);
    // 왕복은 실제로 세 표를 모두 친다.
    assert.ok(stub.calls.some((url) => url.includes("naver_shopping_worker_runs")));
    assert.ok(stub.calls.some((url) => url.includes("naver_shopping_worker_nonces")));
    assert.ok(stub.calls.some((url) => url.includes("naver_shopping_worker_coordination")));
    // 코디네이션은 한 번만 읽는다 — select 만 넓혔고 왕복은 늘리지 않았다.
    assert.equal(stub.calls.filter((url) => url.includes("naver_shopping_worker_coordination")).length, 1);
    // 공개 표면에 버전도 기기 식별자도 실리지 않는다.
    assert.ok(!JSON.stringify(body).includes(OUTDATED_VERSION));
  } finally {
    stub.restore();
  }
});

test("F2: 관측 조회가 실패해도 200 을 503 으로 뒤집지 않는다", async () => {
  const stub = stubHealthSupabase({
    naver_shopping_worker_runs: () => {
      // postgrest-js 는 fetch throw 를 3회 재시도하며 1s·2s·4s 를 실제로 기다린다
      // (dist/index.mjs executeWithRetry). AbortError 이름만 예외로 즉시 되던진다.
      // 어느 쪽이든 관측자에 닿는 결과는 같으므로(둘 다 error 로 접힌다) 7초를 태우지 않는다.
      const failure = new Error("worker_runs_read_failed");
      failure.name = "AbortError";
      throw failure;
    },
    naver_shopping_worker_nonces: () => new Response(
      JSON.stringify({ message: 'relation "public.naver_shopping_worker_nonces" does not exist' }),
      { status: 400, headers: { "content-type": "application/json" } },
    ),
  });
  try {
    const handler = await freshRankHealthHandler("degraded");
    const response = await handler.fetch(new Request("https://example.com/api/rank-collection-health"));
    const body = await response.json();
    assert.equal(response.status, 200, "관측 조회 실패는 정체도 장애도 아니다");
    assert.equal(body.ok, true);
    assert.deepEqual(Object.keys(body), HEALTH_KEYS_IN_ORDER);
    assert.equal(body.workerOutdated, false, "신호가 없으면 단정하지 않는다");
    assert.equal(body.heartbeatAgeMinutes, 0);
    assert.ok(stub.calls.some((url) => url.includes("naver_shopping_worker_runs")), "실제로 조회를 시도했다");
  } finally {
    stub.restore();
  }
});

// lanes·trackers 핸들러 실행 검증. 위 stubHealthSupabase 는 표 이름만 보지만 여기서는
// 같은 표(naver_rank_trackers)에 GET 세 종류(last_checked_at·next_check_at·키워드 열)와
// HEAD(count) 세 종류가, 플레이스 표에도 HEAD 한 종류가 나가므로 메서드와 질의
// 파라미터의 값까지 보고 갈라야 한다(2026-09-03 F7 로 HEAD 2건 → 4건).
const countRows = (total) => new Response(null, { status: 200, headers: { "content-range": `*/${total}` } });

// 정규화하면 같은 키가 되는 변형 3개. 실제 운영 데이터에도 띄어쓰기 변형이 섞여 있다.
const KEYWORD_GROUP_VARIANTS = ["아이폰 케이스", "아이폰케이스", "아이폰 케이스 "];
const capacityRows = (values) => values.map((value) => ({ keyword: value }));
// 1페이지는 정확히 페이지 크기만큼 채워 "다음 페이지가 있다"를 만든다.
const KEYWORD_PAGE_ONE = capacityRows([
  ...KEYWORD_GROUP_VARIANTS,
  "   ",
  ...Array.from({ length: 996 }, (_, index) => `상품 키워드 ${index}`),
]);
const KEYWORD_PAGE_TWO = capacityRows([
  "갤럭시 케이스",
  "갤럭시케이스",
  "iPhone Case",
  "IPHONECASE",
  "상품 키워드 0",
  "   ",
]);
// 1페이지 고유 = 아이폰케이스 1 + 상품키워드N 996 = 997 (공백뿐인 값은 세지 않는다).
// 2페이지 신규 = 갤럭시케이스 1 + iphonecase 1 = 2 ("상품 키워드 0" 은 1페이지와 같은 키).
const EXPECTED_KEYWORD_GROUPS = 999;

function stubHealthRest(router) {
  const previousEnv = Object.fromEntries(HEALTH_ENV_NAMES.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:2",
    SUPABASE_SECRET_KEY: "sb_secret_rank_health_lanes_test",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_rank_health_lanes_test",
  });
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const raw = String(input?.url || input || "");
    const method = String(init.method || input?.method || "GET").toUpperCase();
    calls.push({ url: raw, method });
    return (await router(new URL(raw), method)) || jsonRows([]);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previousFetch;
      for (const name of HEALTH_ENV_NAMES) {
        if (previousEnv[name] === undefined) delete process.env[name];
        else process.env[name] = previousEnv[name];
      }
    },
  };
}

test("F2: 핸들러가 lanes·trackers 를 실제 조회 결과로 채운다(상품 죽음·플레이스 정상)", async () => {
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  assert.equal(KEYWORD_PAGE_ONE.length, RANK_KEYWORD_GROUP_PAGE_SIZE, "1페이지는 꽉 차야 2페이지를 부른다");
  assert.ok(KEYWORD_PAGE_TWO.length < RANK_KEYWORD_GROUP_PAGE_SIZE, "2페이지에서 순회가 끝난다");
  const stub = stubHealthRest((url, method) => {
    const product = url.pathname === "/rest/v1/naver_rank_trackers";
    const place = url.pathname === "/rest/v1/naver_place_rank_trackers";
    if (!product && !place) return null;
    if (method === "HEAD") {
      // 네 집계는 표와 필터 조합으로만 갈린다. status=eq.active 는 넷 모두에 붙는다.
      if (url.searchParams.has("check_count")) return countRows(3);
      const lastError = url.searchParams.get("last_error");
      if (lastError === "not.is.null") return countRows(2);
      if (lastError === "is.null") return place ? countRows(4) : countRows(0);
      return product ? countRows(7) : countRows(0);
    }
    const select = url.searchParams.get("select");
    if (select === "last_checked_at") return jsonRows([{ last_checked_at: iso(product ? -10 * HOUR : -30 * 60 * 1000) }]);
    if (select === "next_check_at") return jsonRows([{ next_check_at: iso(-7 * HOUR) }]);
    if (select === "keyword" && product) {
      const offset = url.searchParams.get("offset");
      if (offset === "0") return jsonRows(KEYWORD_PAGE_ONE);
      if (offset === "1000") return jsonRows(KEYWORD_PAGE_TWO);
      return jsonRows([]);
    }
    return null;
  });
  try {
    const handler = await freshRankHealthHandler("lanes");
    const response = await handler.fetch(new Request("https://example.com/api/rank-collection-health"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), HEALTH_KEYS_IN_ORDER);
    // 최상위는 최악(상품)만 말한다. 옛 6키 계약 그대로.
    assert.equal(body.queueStalled, true);
    assert.equal(body.stalledMinutes, 600);
    // lanes 가 어느 레인인지 말한다.
    assert.equal(body.lanes.product.queueStalled, true);
    assert.equal(body.lanes.product.stalledMinutes, 600);
    assert.equal(body.lanes.place.queueStalled, false);
    assert.equal(body.lanes.place.stalledMinutes, 30);
    assert.deepEqual(body.trackers, {
      neverFound: 3,
      stuck: 2,
      placePartial: 4,
      activeProduct: 7,
      activeProductKeywordGroups: EXPECTED_KEYWORD_GROUPS,
    });
    assert.deepEqual(Object.keys(body.trackers), HEALTH_TRACKER_KEYS_IN_ORDER);

    // 네 집계는 HEAD(count=exact) 로 정확히 한 번씩 나간다. 상품 표 3건 + 플레이스 표 1건.
    const heads = stub.calls.filter((call) => call.method === "HEAD").map((call) => new URL(call.url));
    assert.equal(heads.length, 4);
    assert.equal(heads.filter((url) => url.pathname === "/rest/v1/naver_rank_trackers").length, 3);
    assert.equal(heads.filter((url) => url.pathname === "/rest/v1/naver_place_rank_trackers").length, 1);
    assert.ok(heads.every((url) => url.searchParams.get("status") === "eq.active"), "네 집계 모두 active 만 센다");

    const neverFoundQuery = heads.find((url) => url.searchParams.has("check_count"));
    assert.ok(neverFoundQuery, "neverFound 집계 질의가 나가야 한다");
    assert.equal(neverFoundQuery.pathname, "/rest/v1/naver_rank_trackers");
    assert.equal(neverFoundQuery.searchParams.get("status"), "eq.active");
    assert.equal(neverFoundQuery.searchParams.get("check_count"), `gte.${RANK_NEVER_FOUND_MIN_CHECKS}`);
    assert.equal(neverFoundQuery.searchParams.get("found_count"), "eq.0");
    assert.equal(neverFoundQuery.searchParams.has("last_error"), false);
    assert.equal(neverFoundQuery.searchParams.has("retry_count"), false);

    const stuckQuery = heads.find((url) => url.searchParams.get("last_error") === "not.is.null");
    assert.ok(stuckQuery, "stuck 집계 질의가 나가야 한다");
    assert.equal(stuckQuery.pathname, "/rest/v1/naver_rank_trackers");
    assert.equal(stuckQuery.searchParams.get("status"), "eq.active");
    assert.equal(stuckQuery.searchParams.has("retry_count"), false, "재시도 소진 여부와 무관하게 멈춘 추적기를 잡는다");
    const or = stuckQuery.searchParams.get("or") || "";
    assert.ok(or.includes("last_checked_at.lt."), or);
    assert.ok(or.includes("and(last_checked_at.is.null,created_at.lt."), or);
    const cutoffs = [...or.matchAll(/\.lt\.([0-9TZ:.\-]+)/g)].map((match) => Date.parse(match[1]));
    assert.equal(cutoffs.length, 2);
    for (const cutoff of cutoffs) {
      assert.ok(Number.isFinite(cutoff));
      assert.ok(Math.abs((now - cutoff) - RANK_STUCK_TRACKER_MS) < 10_000, `컷오프는 now-36h 여야 한다: ${or}`);
    }

    // placePartial 은 플레이스 표만 본다 — last_error 가 null 인 채 retry_count 만 오른 행이다.
    const placePartialQuery = heads.find((url) => url.searchParams.get("last_error") === "is.null");
    assert.ok(placePartialQuery, "placePartial 집계 질의가 나가야 한다");
    assert.equal(placePartialQuery.pathname, "/rest/v1/naver_place_rank_trackers", "partial 은 플레이스 표의 결함이다");
    assert.equal(placePartialQuery.searchParams.get("status"), "eq.active");
    assert.equal(placePartialQuery.searchParams.get("retry_count"), `gte.${RANK_PLACE_PARTIAL_MIN_RETRIES}`);
    assert.equal(placePartialQuery.searchParams.has("check_count"), false);
    assert.equal(placePartialQuery.searchParams.has("or"), false);

    // activeProduct 는 필터가 status 하나뿐인 상품 표 집계다(용량의 분모).
    const activeProductQuery = heads.find(
      (url) => !url.searchParams.has("check_count") && !url.searchParams.has("last_error"),
    );
    assert.ok(activeProductQuery, "activeProduct 집계 질의가 나가야 한다");
    assert.equal(activeProductQuery.pathname, "/rest/v1/naver_rank_trackers");
    assert.equal(activeProductQuery.searchParams.get("status"), "eq.active");
    assert.equal(activeProductQuery.searchParams.has("retry_count"), false);
    assert.equal(activeProductQuery.searchParams.has("found_count"), false);
    assert.equal(activeProductQuery.searchParams.has("or"), false);

    // 키워드 열은 count distinct 가 없으므로 페이지로 읽는다. 상품 표 · active · 그 열만.
    const keywordGets = stub.calls
      .filter((call) => call.method === "GET")
      .map((call) => new URL(call.url))
      .filter((url) => url.searchParams.get("select") === "keyword");
    assert.equal(keywordGets.length, 2, "가득 찬 1페이지 뒤에만 2페이지를 읽는다");
    assert.ok(keywordGets.every((url) => url.pathname === "/rest/v1/naver_rank_trackers"));
    assert.ok(keywordGets.every((url) => url.searchParams.get("status") === "eq.active"));
    assert.deepEqual(keywordGets.map((url) => url.searchParams.get("offset")), ["0", "1000"]);
    assert.deepEqual(keywordGets.map((url) => url.searchParams.get("limit")), ["1000", "1000"]);

    // 공개 표면에는 집계 정수만 실린다 — 읽은 키워드 문자열은 한 개도 새지 않는다.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("created_at"));
    for (const row of [...KEYWORD_PAGE_ONE, ...KEYWORD_PAGE_TWO]) {
      const value = String(row.keyword).trim();
      if (value) assert.ok(!serialized.includes(value), `공개 표면에 ${value} 가 있으면 안 된다`);
    }
  } finally {
    stub.restore();
  }
});

test("F2: 추적기 집계 조회가 실패해도 0 으로 접히고 200 을 유지한다(fail-safe)", async () => {
  const stub = stubHealthRest((url, method) => {
    if (method === "HEAD") {
      return new Response(
        JSON.stringify({ message: "column naver_rank_trackers.check_count does not exist" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (url.searchParams.get("select") === "keyword") {
      // 열이 없는 환경으로 내려와도 관측 실패는 경보가 아니다.
      return new Response(
        JSON.stringify({ message: "column naver_rank_trackers.keyword does not exist" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return null;
  });
  try {
    const handler = await freshRankHealthHandler("trackers-degraded");
    const response = await handler.fetch(new Request("https://example.com/api/rank-collection-health"));
    const body = await response.json();
    assert.equal(response.status, 200, "집계 조회 실패는 정체도 장애도 아니다");
    assert.equal(body.ok, true);
    assert.deepEqual(Object.keys(body), HEALTH_KEYS_IN_ORDER);
    assert.deepEqual(body.trackers, HEALTH_FAILSAFE_TRACKERS);
    assert.deepEqual(body.lanes, HEALTH_FAILSAFE_LANES);
    assert.ok(stub.calls.some((call) => call.method === "HEAD"), "실제로 집계를 시도했다");
    assert.ok(stub.calls.some((call) => call.url.includes("select=keyword")), "실제로 용량 조회를 시도했다");
  } finally {
    stub.restore();
  }
});

test("F2: 추적기 집계 fetch 가 throw 해도 200 을 유지한다(fail-safe)", async () => {
  const stub = stubHealthRest((url, method) => {
    if (method === "HEAD") {
      const failure = new Error("count_unreachable");
      failure.name = "AbortError";
      throw failure;
    }
    if (url.searchParams.get("select") === "keyword") {
      const failure = new Error("capacity_unreachable");
      failure.name = "AbortError";
      throw failure;
    }
    return null;
  });
  try {
    const handler = await freshRankHealthHandler("trackers-throw");
    const response = await handler.fetch(new Request("https://example.com/api/rank-collection-health"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.trackers, HEALTH_FAILSAFE_TRACKERS);
    assert.ok(stub.calls.some((call) => call.url.includes("select=keyword")));
  } finally {
    stub.restore();
  }
});

// ─────────────────────────────────────────────────────────────
// (E-3) F7 용량 가시화 — src/server/rank-capacity.mjs 단위 검증
// PostgREST 는 count distinct 를 못 하므로 active 행의 키워드 열만 페이지로 읽어
// 프로세스 안에서 정규화 distinct 를 센다. 수치 관측 전용이다(상한 판단·경보 없음).
// ─────────────────────────────────────────────────────────────

// 가짜 supabaseAdmin. 실제 클라이언트와 같은 체인(from → select → eq → range)만 흉내내고
// 호출 인자를 그대로 기록한다. range 는 await 되므로 async 로 둔다.
function capacityClient(pages, options = {}) {
  const calls = [];
  const client = {
    from(table) {
      const call = { table, select: null, filters: [], range: null };
      calls.push(call);
      const builder = {
        select(columns) { call.select = columns; return builder; },
        eq(column, value) { call.filters.push([column, value]); return builder; },
        async range(from, to) {
          call.range = [from, to];
          const index = calls.length - 1;
          if (options.throwAt === index) throw new Error("capacity_unreachable");
          if (options.errorAt === index) return { data: null, error: { message: "capacity_read_failed" } };
          if (options.notArrayAt === index) return { data: { rows: [] }, error: null };
          const page = typeof pages === "function" ? pages(index) : pages[index];
          return { data: page || [], error: null };
        },
      };
      return builder;
    },
  };
  return { calls, client };
}

const filledCapacityPage = (label) => capacityRows(
  Array.from({ length: RANK_KEYWORD_GROUP_PAGE_SIZE }, (_, index) => `${label}-${index}`),
);

test("F7: 페이지 상수는 계약값이다", () => {
  assert.equal(RANK_KEYWORD_GROUP_PAGE_SIZE, 1000);
  assert.equal(RANK_KEYWORD_GROUP_MAX_PAGES, 10);
});

test("F7: 키워드 정규화는 공백 제거 + 소문자화다", () => {
  assert.equal(normalizedRankKeywordKey(" 아이폰  케이스 "), "아이폰케이스");
  assert.equal(normalizedRankKeywordKey("아이폰\t케이스\n"), "아이폰케이스");
  assert.equal(normalizedRankKeywordKey("아이폰케이스"), "아이폰케이스");
  assert.equal(normalizedRankKeywordKey("iPhone Case"), "iphonecase");
  assert.equal(normalizedRankKeywordKey("IPHONECASE"), "iphonecase");
  assert.equal(normalizedRankKeywordKey(null), "");
  assert.equal(normalizedRankKeywordKey(undefined), "");
  assert.equal(normalizedRankKeywordKey(""), "");
  assert.equal(normalizedRankKeywordKey("   "), "");
});

test("F7: 정규화 드리프트 가드 — 잠금 파일 두 곳의 원본이 그대로다", () => {
  // 서버가 실제로 쓰는 정규화는 잠금 파일 안의 비-export 함수라 import 할 수 없다.
  // 복제한 이상, 원본이 움직이면 이 가드가 먼저 깨져야 한다.
  assert.ok(
    localWorkerSource.includes(String.raw`return normalizeText(value).replace(/\s/g, "").toLowerCase();`),
    "naver-shopping-local-worker.mjs 의 정규화가 바뀌면 용량 모듈도 함께 고쳐야 한다",
  );
  assert.ok(
    shoppingRankSource.includes(String.raw`return String(value || "").replace(/\s+/g, " ").trim();`),
    "naver-shopping-rank.mjs 의 normalizeText 가 바뀌면 용량 모듈도 함께 고쳐야 한다",
  );
  // 두 잠금 규약의 합성은 아래 한 줄과 동치다. 용량 모듈은 그 한 줄을 복제한다.
  assert.ok(rankCapacitySource.includes(String.raw`String(value || "").replace(/\s/g, "").toLowerCase()`));
});

test("F7: 활성 상품 키워드 그룹을 페이지로 훑어 정규화 distinct 로 센다", async () => {
  const fake = capacityClient([KEYWORD_PAGE_ONE, KEYWORD_PAGE_TWO]);
  assert.equal(await countActiveProductKeywordGroups(fake.client), EXPECTED_KEYWORD_GROUPS);
  assert.equal(fake.calls.length, 2, "가득 찬 페이지 다음에만 다음 페이지를 읽는다");
  assert.ok(fake.calls.every((call) => call.table === "naver_rank_trackers"));
  assert.ok(fake.calls.every((call) => call.select === "keyword"), "필요한 열 하나만 읽는다");
  assert.deepEqual(fake.calls.map((call) => call.filters), [[["status", "active"]], [["status", "active"]]]);
  assert.deepEqual(fake.calls.map((call) => call.range), [[0, 999], [1000, 1999]]);
});

test("F7: 한 페이지로 끝나면 다음 페이지를 부르지 않는다", async () => {
  const fake = capacityClient([capacityRows(["가방", "가 방", "신발"])]);
  assert.equal(await countActiveProductKeywordGroups(fake.client), 2);
  assert.equal(fake.calls.length, 1);
  const empty = capacityClient([[]]);
  assert.equal(await countActiveProductKeywordGroups(empty.client), 0);
  assert.equal(empty.calls.length, 1);
});

test("F7: 빈 정규화 키는 세지 않는다", async () => {
  const fake = capacityClient([[
    { keyword: "" },
    { keyword: "   " },
    { keyword: "\t\n" },
    { keyword: null },
    { keyword: undefined },
    {},
    { keyword: "가방" },
  ]]);
  assert.equal(await countActiveProductKeywordGroups(fake.client), 1);
});

test("F7: 최대 페이지에서 멈추고 그때까지의 하한값을 낸다", async () => {
  const fake = capacityClient((index) => filledCapacityPage(`p${index}`));
  const total = await countActiveProductKeywordGroups(fake.client);
  assert.equal(fake.calls.length, RANK_KEYWORD_GROUP_MAX_PAGES, "상한을 넘겨 계속 읽지 않는다");
  assert.equal(total, RANK_KEYWORD_GROUP_PAGE_SIZE * RANK_KEYWORD_GROUP_MAX_PAGES);
  assert.deepEqual(
    fake.calls.at(-1).range,
    [RANK_KEYWORD_GROUP_PAGE_SIZE * (RANK_KEYWORD_GROUP_MAX_PAGES - 1), RANK_KEYWORD_GROUP_PAGE_SIZE * RANK_KEYWORD_GROUP_MAX_PAGES - 1],
  );
  // 상한에 닿아도 0 이 아니라 그때까지 센 수를 낸다 — 그 값이 하한이라는 사실을 주석이 말한다.
  assert.ok(rankCapacitySource.includes("하한"), "상한 도달 시 하한값이라는 사실을 주석에 남긴다");
});

test("F7: 어떤 조회 실패도 0 으로 접힌다(fail-safe)", async () => {
  const firstPageError = capacityClient([KEYWORD_PAGE_ONE, KEYWORD_PAGE_TWO], { errorAt: 0 });
  assert.equal(await countActiveProductKeywordGroups(firstPageError.client), 0);
  const secondPageError = capacityClient([KEYWORD_PAGE_ONE, KEYWORD_PAGE_TWO], { errorAt: 1 });
  assert.equal(await countActiveProductKeywordGroups(secondPageError.client), 0, "중간에 깨지면 부분 집계를 내지 않는다");
  const thrown = capacityClient([KEYWORD_PAGE_ONE], { throwAt: 0 });
  assert.equal(await countActiveProductKeywordGroups(thrown.client), 0);
  const notArray = capacityClient([], { notArrayAt: 0 });
  assert.equal(await countActiveProductKeywordGroups(notArray.client), 0);
  assert.equal(await countActiveProductKeywordGroups(undefined), 0, "클라이언트가 없어도 throw 하지 않는다");
  assert.equal(await countActiveProductKeywordGroups({ from() { throw new Error("no_table"); } }), 0);
});

test("F7: 표 이름은 인자로 받고 기본값은 상품 표다", async () => {
  const fake = capacityClient([capacityRows(["가방"])]);
  await countActiveProductKeywordGroups(fake.client);
  assert.equal(fake.calls[0].table, "naver_rank_trackers");
  const explicit = capacityClient([capacityRows(["가방"])]);
  await countActiveProductKeywordGroups(explicit.client, "naver_rank_trackers_shadow");
  assert.equal(explicit.calls[0].table, "naver_rank_trackers_shadow");
});

// 크론 쪽 판정. 유예(60분)는 정확히 이 사고를 감춘 장치였으므로 낡은 실행본 검사는
// 유예보다 먼저, 유예와 무관하게 돌아야 한다.
function runtimeSignalCtx({ runVersion = "", signatureAt = "", coordinationRows = [] } = {}) {
  const tables = [];
  const rowsFor = (rows) => ({
    select() { return this; },
    order() { return this; },
    eq() { return this; },
    async limit() { return { data: rows, error: null }; },
  });
  return {
    tables,
    supabaseAdmin: {
      from(table) {
        tables.push(table);
        if (table === "naver_shopping_worker_runs") {
          return rowsFor(runVersion ? [{ runtime_version: runVersion }] : []);
        }
        if (table === "naver_shopping_worker_nonces") {
          return rowsFor(signatureAt ? [{ created_at: signatureAt }] : []);
        }
        return rowsFor(coordinationRows);
      },
    },
  };
}

test("F2: NAVER_RANK_WORKER_OUTDATED 순수 판정은 날짜 유예와 무관하다", () => {
  assert.equal(NAVER_RANK_WORKER_OUTDATED, "NAVER_RANK_WORKER_OUTDATED");
  const failure = hybridWorkerOutdatedFailure({
    lastRunRuntimeVersion: OUTDATED_VERSION,
    lastSignatureAt: at(-54_000),
    now: NOW,
  });
  assert.deepEqual(failure, {
    code: NAVER_RANK_WORKER_OUTDATED,
    status: "worker_outdated",
    message: "윈도우 수집 작업기가 서버가 요구하는 최신 실행본보다 낮은 버전이라 서버가 요청을 거부하고 있습니다. 수집기를 업데이트해주세요.",
  });
  // 메시지에 버전도 기기 이름도 없다.
  assert.ok(!failure.message.includes(OUTDATED_VERSION));
  assert.ok(!failure.message.includes(EXPECTED_WORKER_RUNTIME_VERSION));

  // 나머지는 전부 null 이다.
  assert.equal(hybridWorkerOutdatedFailure({
    lastRunRuntimeVersion: EXPECTED_WORKER_RUNTIME_VERSION,
    lastSignatureAt: at(-54_000),
    now: NOW,
  }), null);
  assert.equal(hybridWorkerOutdatedFailure({
    lastRunRuntimeVersion: OUTDATED_VERSION,
    lastSignatureAt: at(-2 * HOUR),
    now: NOW,
  }), null, "서명이 끊긴 작업기는 낡음이 아니라 침묵이다");
  assert.equal(hybridWorkerOutdatedFailure({}), null);

  // 순수 함수라는 사실을 소스로도 고정한다 — 유예 함수를 참조하지 않는다.
  const cronSource = readRepoFile("src/server/handlers/naver-rank-cron.mjs");
  const from = cronSource.indexOf("export function hybridWorkerOutdatedFailure(");
  const to = cronSource.indexOf("\n}", from);
  assert.ok(from > 0 && to > from);
  const judgment = cronSource.slice(from, to);
  assert.ok(!judgment.includes("hybridWorkerGraceActive"));
  assert.ok(!judgment.includes("latestLocalWorkerSlotAt"));
});

test("F2: 낡은 실행본은 60분 유예 안에서도 크론 503 으로 나간다", async () => {
  const insideGrace = new Date(NOW); // 09:00 KST 슬롯 직후 = 유예 한복판
  assert.equal(hybridWorkerGraceActive(insideGrace), true, "이 시각은 실제로 유예 안이다");

  // 전제 반전. 유예가 낡은 실행본까지 눌렀기 때문에 2026-09-01 의 17시간이 202 ok 로
  // 빠져나갔다. 이제는 유예 안에서도 낡음이 먼저 잡힌다.
  const outdatedCtx = runtimeSignalCtx({
    runVersion: OUTDATED_VERSION,
    signatureAt: new Date(NOW - 54_000).toISOString(),
  });
  const failure = await hybridWorkerFailure(outdatedCtx, insideGrace);
  assert.equal(failure.code, NAVER_RANK_WORKER_OUTDATED);
  assert.equal(failure.status, "worker_outdated");
  // 낡음이 확정되면 침묵 판정까지 내려가지 않는다 — 코디네이션은 읽히지도 않는다.
  assert.ok(!outdatedCtx.tables.includes("naver_shopping_worker_coordination"));

  // 실행본이 기대와 같으면 유예는 원래대로 침묵을 누른다.
  const currentCtx = runtimeSignalCtx({ runVersion: EXPECTED_WORKER_RUNTIME_VERSION });
  assert.equal(await hybridWorkerFailure(currentCtx, insideGrace), null);
  // 그리고 서명 표까지 내려가지 않는다(정상 구간 왕복 1회).
  assert.ok(!currentCtx.tables.includes("naver_shopping_worker_nonces"));

  // 유예 밖에서는 기존 침묵 판정이 그대로 살아 있다.
  const afterGrace = new Date(NOW + 3 * HOUR);
  assert.equal(hybridWorkerGraceActive(afterGrace), false);
  const silentCtx = runtimeSignalCtx({
    runVersion: EXPECTED_WORKER_RUNTIME_VERSION,
    coordinationRows: [{
      primary_seen_at: new Date(NOW - 20 * HOUR).toISOString(),
      last_success_at: new Date(NOW - 20 * HOUR).toISOString(),
    }],
  });
  assert.equal((await hybridWorkerFailure(silentCtx, afterGrace)).code, NAVER_RANK_WORKER_SILENT);
});

test("F2: 크론 관측 조회는 어떤 실패에서도 판정을 만들지 않는다", async () => {
  // 전제: fail-open 이 되면 매 슬롯 503 이 쏟아지는 거짓 경보가 된다.
  assert.equal(await hybridWorkerRuntimeSignals(null), null);
  assert.equal(await hybridWorkerRuntimeSignals({}), null, "supabaseAdmin 부재");
  assert.equal(await hybridWorkerRuntimeSignals({ supabaseAdmin: {} }), null, "from 부재 → throw → null");
  // PostgREST error.
  assert.equal(await hybridWorkerRuntimeSignals({
    supabaseAdmin: {
      from() {
        return {
          select() { return this; },
          order() { return this; },
          async limit() { return { data: null, error: { message: "permission denied" } }; },
        };
      },
    },
  }), null);
  // .order() 가 없는 옛 체인(스키마·클라이언트 드리프트)도 조용히 null 이다.
  assert.equal(await hybridWorkerRuntimeSignals({
    supabaseAdmin: {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async limit() { return { data: [], error: null }; },
        };
      },
    },
  }), null);
  // 읽기가 성공하면 그대로 돌려준다.
  assert.deepEqual(
    await hybridWorkerRuntimeSignals(runtimeSignalCtx({ runVersion: OUTDATED_VERSION, signatureAt: at(-54_000) })),
    { lastRunRuntimeVersion: OUTDATED_VERSION, lastSignatureAt: at(-54_000) },
  );
});

test("F2: 관측자 기대 실행본이 게이트 원본과 드리프트하지 않는다", () => {
  // 원본은 export 할 수 없다 — 릴리스 게이트 두 곳이 그 선언 문자열 그대로를 검사한다.
  // 그래서 사본을 두고, 사본이 낡는 위험은 이 테스트가 소스 파싱으로 막는다.
  const gateSource = readRepoFile("src/server/handlers/naver-shopping-local-worker.mjs");
  const parsed = gateSource.match(/const EXPECTED_WORKER_RUNTIME_VERSION = "(\d+\.\d+\.\d+)";/);
  assert.ok(parsed, "게이트 원본에서 기대 실행본을 파싱하지 못했다");
  assert.equal(EXPECTED_WORKER_RUNTIME_VERSION, parsed[1]);
  assert.ok(!gateSource.includes("export const EXPECTED_WORKER_RUNTIME_VERSION"), "원본에 export 를 붙이면 릴리스 게이트가 깨진다");
  assert.ok(readRepoFile("scripts/check-release-baseline.mjs")
    .includes(`const EXPECTED_WORKER_RUNTIME_VERSION = "${parsed[1]}";`));
  assert.ok(readRepoFile("scripts/check-server-contract.mjs")
    .includes("EXPECTED_WORKER_RUNTIME_VERSION"));
  // 게이트가 버전 불일치를 claim 앞에서 400 으로 끊는다는 사실이 이 관측의 전제다.
  assert.ok(gateSource.includes("runtimeVersion !== EXPECTED_WORKER_RUNTIME_VERSION"));
  assert.ok(gateSource.includes('throw workerError("LOCAL_WORKER_RUNTIME_IDENTITY_INVALID", 400);'));
});

// ─────────────────────────────────────────────────────────────
// (F) F2 워치독 셸 — 소스 단언
// ─────────────────────────────────────────────────────────────
test("F2: 워치독 상수와 임계값", () => {
  for (const marker of [
    "STALL_REQUIRED_SECONDS=1800",
    "RESTART_COOLDOWN_SECONDS=10800",
    "LOG_MAX_BYTES=1048576",
    "CURL_MAX_SECONDS=15",
    // 런타임 드리프트 동기화(웨이브 3). 동기화 쿨다운은 재기동 쿨다운과 같은 3시간이고,
    // 설치 스크립트가 매달리면 10분 주기 tick 이 겹쳐 쌓이므로 180초에서 잘라낸다.
    "SYNC_COOLDOWN_SECONDS=10800",
    "SYNC_INSTALL_TIMEOUT_SECONDS=180",
    "https://insight.momentlabs.co.kr/api/rank-collection-health",
  ]) {
    assert.ok(watchdogSource.includes(marker), `watchdog must include ${marker}`);
  }
  assert.ok(watchdogPlistSource.includes("<key>StartInterval</key>"));
  assert.ok(watchdogPlistSource.includes("<integer>600</integer>"));
  assert.ok(watchdogPlistSource.includes("co.kr.momentinsight.rank-watchdog"));
});

test("F2: 모든 판정 분기가 고유 로그 코드를 남긴다", () => {
  for (const code of [
    "health_url_invalid",
    "health_unreachable",
    "health_body_unusable",
    "healthy",
    "stall_cleared",
    "stall_started",
    "stall_clock_reset",
    "stall_pending",
    "restart_cooldown_clock_reset",
    "restart_suppressed_cooldown",
    "dry_run restart_would_run",
    "chrome_config_invalid",
    "restart_begin",
    "chrome_quit_failed",
    "chrome_quit_unauthorized",
    "chrome_start_failed",
    "chrome_restarted",
    // ── 런타임 드리프트 동기화(웨이브 3) ────────────────────────
    // 값이 런타임에 정해지는 자리(<N>, <n>, <경로>)는 뺀 최대 리터럴 접두사만 고정한다.
    "sync_disabled",
    "sync_check_failed reason=sync_source_unresolved",
    "sync_check_failed reason=runtime_copy_missing",
    "sync_check_failed reason=hash_unreadable file=",
    "sync_check_failed reason=not_a_git_worktree",
    "sync_check_failed reason=node_missing",
    "sync_check_failed reason=backup_failed",
    "runtime_in_sync files=",
    "drift_detected files=",
    "sync_skipped=repository_dirty",
    "sync_skipped=collection_active",
    "sync_suppressed_cooldown seconds_left=",
    "sync_cooldown_clock_reset previous=",
    "dry_run drift_sync_would_run files=",
    "drift_sync_failed status=",
    "drift_sync_ok files=",
    "sync_chrome_restart_skipped reason=not_running",
    "sync_chrome_restart_suppressed_cooldown seconds_left=",
    "sync_chrome_restart_begin",
  ]) {
    assert.ok(watchdogSource.includes(code), `watchdog must log ${code}`);
  }
});

test("F2: 동기화 경로 상수와 탈출구 환경변수", () => {
  for (const marker of [
    'RUNTIME_COPY_PATH="${SUPPORT_DIRECTORY}/NaverShoppingBridge"',
    'SYNC_CONF_PATH="${SUPPORT_DIRECTORY}/mi-rank-runtime-sync.conf"',
    "MI_RANK_WATCHDOG_SYNC_SOURCE_PATH",
    "MI_RANK_WATCHDOG_SYNC_DISABLED",
  ]) {
    assert.ok(watchdogSource.includes(marker), `watchdog must include ${marker}`);
  }
});

// ── 런타임 파일 목록 이중화 방지 ────────────────────────────────
// 워치독은 설치 스크립트가 실제로 설치하는 파일을 그대로 해싱해야 한다. 두 목록이
// 갈라지면 워치독은 "동기화됨"이라 말하면서 정작 바뀐 파일을 못 보는 최악의 침묵을
// 만든다. 그래서 테스트에 목록을 세 번째로 베껴 쓰지 않고 양쪽 원본에서 파싱해 맞춘다.
function bridgeRuntimeFilePaths() {
  const marker = "const RUNTIME_FILES = Object.freeze([";
  const from = bridgeInstallerSource.indexOf(marker);
  assert.ok(from >= 0, "설치 스크립트에서 RUNTIME_FILES 배열을 찾지 못했다");
  const to = bridgeInstallerSource.indexOf("]);", from);
  assert.ok(to > from, "RUNTIME_FILES 배열의 끝을 찾지 못했다");
  const block = bridgeInstallerSource.slice(from + marker.length, to);
  return [...block.matchAll(/\[\s*"([^"]+)"/gu)].map((match) => match[1]);
}

function watchdogRuntimeSyncFilePaths() {
  const marker = "RUNTIME_SYNC_FILES=(";
  const from = watchdogSource.indexOf(marker);
  assert.ok(from >= 0, "워치독에서 RUNTIME_SYNC_FILES 배열을 찾지 못했다");
  const to = watchdogSource.indexOf("\n)", from);
  assert.ok(to > from, "RUNTIME_SYNC_FILES 배열의 끝을 찾지 못했다");
  const block = watchdogSource.slice(from + marker.length, to);
  return [...block.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

test("F2: 워치독 동기화 목록이 설치 스크립트 런타임 목록과 완전히 같다", () => {
  const bridgeFiles = bridgeRuntimeFilePaths();
  assert.equal(bridgeFiles.length, 14, "설치 런타임 파일은 14개다");
  // 순서까지 같아야 한다. 순서가 갈라지면 사람이 두 목록을 눈으로 대조할 수 없다.
  assert.deepEqual(watchdogRuntimeSyncFilePaths(), bridgeFiles);
});

test("F2: 워치독이 직접 호출하는 설치 스크립트가 npm 스크립트와 같은 파일이다", () => {
  const wired = packageManifest.scripts["install:naver-shopping-chrome-bridge"];
  assert.ok(wired, "package.json 에 install:naver-shopping-chrome-bridge 가 있어야 한다");
  // 워치독은 npm 을 거치지 않고 이 파일을 직접 실행한다. npm 스크립트가 다른 파일을
  // 가리키게 되는 순간 사람이 손으로 돌리는 설치와 워치독의 자가치유가 갈라진다.
  assert.ok(
    wired.includes("scripts/install-naver-shopping-chrome-bridge.mjs"),
    `npm 스크립트가 다른 파일을 가리킨다: ${wired}`,
  );
  assert.ok(fs.existsSync(path.join(repositoryRoot, "scripts/install-naver-shopping-chrome-bridge.mjs")));
});

test("F2: 자가치유는 설치 스크립트를 CLI 로 부르지 않고 옵션을 박아 import 한다", () => {
  // 설치 스크립트는 process.argv[1] 로 "직접 실행" 여부를 판정한다(:296-297). 경로를
  // 위치 인자로 넘기면 argv[1] 이 채워져 installChromeBridge() 가 전체 기본값으로 돌고,
  // 그 순간 워치독이 스스로 읽는 naver-shopping-chrome-scheduler.conf 를 다시 쓰고
  // launchctl 로 에이전트를 띄워 1분 안에 Chrome 과 수집을 시작한다. 드리프트 한 줄을
  // 맞추려다 수집을 건드리는 셈이다. 그래서 경로는 환경변수로만 넘긴다.
  for (const marker of [
    "MI_BRIDGE_INSTALLER",
    "process.env.MI_BRIDGE_INSTALLER",
    "pathToFileURL",
    "--input-type=module",
    "installChromeScheduler: false",
    // 설치 스크립트 :262 는 options.disableOldAutomaticWorker !== false 로 가드한다.
    // 생략하면 동기화 때마다 옛 에이전트에 launchctl bootout/disable 이 나간다.
    "disableOldAutomaticWorker: false",
  ]) {
    assert.ok(watchdogSource.includes(marker), `watchdog must include ${marker}`);
  }
  // 음성 단언은 반드시 주석을 뺀 실행 줄에만 걸어야 한다. "이렇게 부르지 않는다" 라고
  // 적어 둔 설명 주석까지 걸면, 이유를 남긴 코드가 오히려 빨개진다.
  const codeLines = watchdogSource.split("\n").filter((line) => !/^\s*#/u.test(line));
  const watchdogCode = codeLines.join("\n");
  // 금지되는 것은 "node 호출 뒤에 경로가 오는" 순서다. 그게 곧 위치 인자이고 argv[1] 이다.
  // 환경변수 형태(MI_BRIDGE_INSTALLER=... 뒤에 node)는 경로가 앞서므로 걸리지 않는다.
  // 경로 자체를 금지하면 안 된다 — 원본 검증 가드는 이 경로가 있는지 -f 로 봐야 하고,
  // 그게 sync_check_failed reason=sync_source_unresolved 의 판정 근거다.
  assert.ok(
    !/(?:NODE_BIN|\/node\b|(?<![\w/.\-])node\s)[^\n]*install-naver-shopping-chrome-bridge\.mjs/u
      .test(watchdogCode),
    "설치 스크립트를 node 의 위치 인자로 넘기면 argv[1] 이 채워져 전체 기본값으로 실행된다",
  );
  assert.ok(
    !watchdogCode.includes("npm run install:naver-shopping-chrome-bridge"),
    "npm 을 거쳐도 설치기 경로가 argv[1] 에 실린다",
  );
  // 그리고 환경변수 경로가 실제로 존재해야 한다(위 음성 단언만으로는 호출이 사라져도 초록이다).
  const mentions = codeLines.filter((line) => line.includes("install-naver-shopping-chrome-bridge.mjs"));
  assert.ok(mentions.length > 0, "워치독이 설치 스크립트를 전혀 참조하지 않는다");
  assert.ok(
    mentions.some((line) => line.includes("MI_BRIDGE_INSTALLER=")),
    "설치 스크립트 경로를 MI_BRIDGE_INSTALLER 환경변수로 넘기는 줄이 없다",
  );
});

test("F2: 엔드포인트 무응답이면 상태를 쓰지 않고 exit 0 이다", () => {
  const from = watchdogSource.indexOf('log_event "health_unreachable');
  assert.ok(from > 0);
  const to = watchdogSource.indexOf("\nfi", from);
  const branch = watchdogSource.slice(from, to);
  assert.ok(!branch.includes("write_state"), "네트워크 실패는 상태를 건드리지 않는다");
  assert.ok(branch.includes("exit 0"));
});

test("F2: 첫 정체 관측만으로는 재기동하지 않는다", () => {
  const from = watchdogSource.indexOf('log_event "stall_started');
  assert.ok(from > 0);
  const to = watchdogSource.indexOf("\nfi", from);
  const branch = watchdogSource.slice(from, to);
  assert.ok(branch.includes('write_state "${NOW}"'), "첫 관측은 stalled_since 만 기록한다");
  assert.ok(branch.includes("exit 0"));
  assert.ok(!branch.includes("osascript"), "첫 관측 분기에서 Chrome 을 건드리면 안 된다");
});

test("F2: 시계 역행은 재기동 대신 쿨다운 기준점만 재고정한다", () => {
  const from = watchdogSource.indexOf('log_event "restart_cooldown_clock_reset');
  assert.ok(from > 0);
  const to = watchdogSource.indexOf("\nfi", from);
  const branch = watchdogSource.slice(from, to);
  assert.ok(branch.includes('write_state "${STALLED_SINCE}" "${NOW}"'), "정체 시작점은 보존하고 쿨다운만 재고정한다");
  assert.ok(branch.includes("exit 0"));
  assert.ok(!branch.includes("osascript"), "음수 쿨다운에서 Chrome 을 건드리면 안 된다");
  // 쿨다운 분기는 둘로 쪼개져야 한다. 하나로 합치면 음수 경과가 "쿨다운 만료"로 읽힌다.
  assert.ok(watchdogSource.includes("if (( LAST_RESTART_AT > 0 && COOLDOWN_ELAPSED < 0 )); then"));
  assert.ok(watchdogSource.includes("if (( LAST_RESTART_AT > 0 && COOLDOWN_ELAPSED < RESTART_COOLDOWN_SECONDS )); then"));
});

test("F2: 강제 종료 폴백이 없다", () => {
  for (const forbidden of ["pkill", "kill -9", "killall"]) {
    assert.ok(!watchdogSource.includes(forbidden), `watchdog must not use ${forbidden}`);
  }
});

test("F2: 워치독은 관측 키 두 개를 판정에 쓰지 않는다(맥 재기동으로 고칠 수 없다)", () => {
  // 응답이 6개 키로 늘었지만 워치독의 판정 축은 queueStalled 하나뿐이다.
  // workerOutdated 는 윈도우 워커가 낡은 실행본을 돌린다는 뜻이고, 맥에서 Chrome 을
  // 다시 여는 것으로는 절대 고쳐지지 않는다. 고쳐지지도 않을 일에 재기동을 쓰면
  // 3시간 쿨다운만 태워, 정작 진짜 대기열 정체가 왔을 때 손을 못 쓰게 된다.
  // heartbeatAgeMinutes 도 같은 이유로 사람이 보는 관측값일 뿐이다.
  assert.ok(!watchdogSource.includes("workerOutdated"), "워치독이 workerOutdated 를 읽으면 안 된다");
  assert.ok(!watchdogSource.includes("heartbeatAgeMinutes"), "워치독이 heartbeatAgeMinutes 를 읽으면 안 된다");
});

test("F2: 드라이런 진입점이 있다", () => {
  assert.ok(watchdogSource.includes("MI_RANK_WATCHDOG_DRY_RUN"));
  assert.ok(watchdogSource.includes('log_event "dry_run restart_would_run stalled_seconds=${STALLED_SECONDS}"'));
  assert.ok(watchdogSource.includes("dry_run state_write_skipped"));
});

test("F2: launchd PATH 를 가정하지 않고 절대경로 바이너리만 쓴다", () => {
  // launchd 의 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 뿐이다(node·jq·Homebrew 없음).
  // 이름 앞에 경로 구분자가 없는 호출이 하나라도 있으면 실패시킨다.
  const BINARIES = [
    "curl", "osascript", "open", "date", "sleep", "grep", "sed",
    "mktemp", "cat", "mv", "stat", "head", "touch", "chmod", "mkdir", "printf", "tr",
  ];
  for (const binary of BINARIES) {
    const bare = new RegExp(`(?<![\\w/.\\-])${binary}\\s`, "gu");
    const hits = watchdogSource.match(bare) || [];
    assert.deepEqual(hits, [], `${binary} 는 절대경로로만 호출해야 한다`);
  }
  for (const absolute of [
    "/usr/bin/curl", "/usr/bin/osascript", "/usr/bin/open", "/bin/date",
    "/bin/sleep", "/usr/bin/grep", "/usr/bin/sed", "/usr/bin/mktemp", "/bin/cat",
  ]) {
    assert.ok(watchdogSource.includes(absolute), `watchdog must call ${absolute}`);
  }
});

test("F2: 로그·상태 경로와 원자적 상태 쓰기", () => {
  assert.ok(watchdogSource.includes("Library/Logs/MomentInsight"));
  assert.ok(watchdogSource.includes("mi-rank-watchdog.log"));
  assert.ok(watchdogSource.includes("mi-rank-watchdog.state"));
  assert.ok(watchdogSource.includes("naver-shopping-chrome-scheduler.conf"));
  assert.ok(watchdogSource.includes("/usr/bin/mktemp"));
  assert.ok(watchdogSource.includes('/bin/mv -f "${temp}" "${STATE_PATH}"'));
  assert.ok(watchdogSource.includes('/bin/mv -f "${LOG_PATH}" "${LOG_PATH}.1"'));
});

test("F2: launchd 로그와 스크립트 로그를 분리한다(로테이션 fd 유실 방지)", () => {
  assert.ok(watchdogPlistSource.includes("__LOG_DIRECTORY__/mi-rank-watchdog.launchd.log"));
  assert.ok(watchdogPlistSource.includes("__LOG_DIRECTORY__/mi-rank-watchdog.launchd.error.log"));
  assert.ok(
    !watchdogPlistSource.includes("<string>__LOG_DIRECTORY__/mi-rank-watchdog.log</string>"),
    "StandardOutPath 가 스크립트 로그를 잡으면 안 된다",
  );
  assert.ok(!watchdogPlistSource.includes("StartCalendarInterval"));
  assert.ok(!watchdogPlistSource.includes("EnvironmentVariables"));
  const placeholders = new Set(watchdogPlistSource.match(/__[A-Z_]+__/g) || []);
  assert.deepEqual(
    [...placeholders].sort(),
    ["__LOG_DIRECTORY__", "__WATCHDOG_RUNTIME_DIRECTORY__", "__WATCHDOG_SCRIPT_PATH__"],
  );
  // launchd 가 저장소 워킹트리를 직접 실행하면 저장소 편집이 곧 자동 실행이 된다.
  assert.ok(!watchdogPlistSource.includes("__REPOSITORY_PATH__"));
});

test("F2: 설치본은 저장소가 아니라 Application Support 사본을 launchd 에 등록한다", () => {
  // 전제 반전. 옛 계약은 launchd 가 저장소 워킹트리의 스크립트를 그대로 실행하는
  // 것이었고, 그러면 저장소 파일을 고치는 순간 10분 주기 자동 실행이 바뀐다.
  assert.ok(!watchdogInstallSource.includes('REPOSITORY_PATH="${SCRIPT_DIR:h:h}"'));
  assert.ok(watchdogInstallSource.includes('RUNTIME_DIRECTORY="${SUPPORT_DIRECTORY}/rank-watchdog"'));
  assert.ok(watchdogInstallSource.includes('WATCHDOG_SCRIPT_PATH="${RUNTIME_DIRECTORY}/mi-rank-watchdog.sh"'));
  assert.ok(watchdogInstallSource.includes('SUPPORT_DIRECTORY="${HOME}/Library/Application Support/MomentInsight"'));
  // install(1) 은 임시 파일에 쓴 뒤 rename 하므로 재설치가 원자적이다.
  assert.ok(watchdogInstallSource.includes('/usr/bin/install -m 700 "${WATCHDOG_SOURCE_PATH}" "${WATCHDOG_SCRIPT_PATH}"'));
  assert.ok(watchdogInstallSource.includes("PLIST_CONTENT//__WATCHDOG_SCRIPT_PATH__/${WATCHDOG_SCRIPT_PATH}"));
  assert.ok(watchdogInstallSource.includes("rank_watchdog_launch_agent_installed"));
  assert.ok(watchdogInstallSource.includes("rank_watchdog_install_source_missing"));
  assert.ok(watchdogInstallSource.includes("rank_watchdog_scheduler_config_missing"));
  assert.ok(watchdogInstallSource.includes("/usr/bin/plutil -lint"));
  assert.ok(watchdogInstallSource.includes("/usr/bin/install -m 600"));
  assert.ok(watchdogInstallSource.includes("/bin/launchctl bootstrap"));
});

test("F2: 설치기가 동기화 원본 경로를 conf 로 남긴다", () => {
  // launchd 는 저장소를 실행하지 않지만(위 테스트), 워치독은 드리프트를 재기 위해
  // 저장소가 "어디"인지는 알아야 한다. 실행 경로가 아니라 읽기 전용 좌표로만 넘긴다.
  assert.ok(watchdogInstallSource.includes('RUNTIME_SYNC_SOURCE_PATH="${SCRIPT_DIR:h:h}"'));
  assert.ok(watchdogInstallSource.includes('SYNC_CONF_PATH="${SUPPORT_DIRECTORY}/mi-rank-runtime-sync.conf"'));
  assert.ok(watchdogInstallSource.includes("mi-rank-runtime-sync.conf"));
  assert.ok(watchdogInstallSource.includes("rank_watchdog_sync_source_invalid"));
  // conf 도 plist 와 같은 방식(mktemp → install -m 600)으로 원자적으로 쓴다.
  assert.ok(watchdogInstallSource.includes("/usr/bin/mktemp"));
  assert.ok(watchdogInstallSource.includes("/usr/bin/install -m 600"));
  // 위 테스트의 음성 단언을 여기서 다시 못 박는다. 동기화 원본을 넘기게 되었다고 해서
  // launchd 실행 경로가 저장소로 되돌아가면 안 된다. 둘은 서로 다른 변수여야 한다.
  assert.ok(!watchdogInstallSource.includes('REPOSITORY_PATH="${SCRIPT_DIR:h:h}"'));
});

test("F2: plist 주석이 낮춘 임계값(30분)을 말한다", () => {
  // 주석이 옛 60분을 말하면 사람이 로그의 stall_pending 을 오독한다.
  assert.ok(!watchdogPlistSource.includes("60분"), "plist 주석에 옛 60분 임계가 남아 있다");
  assert.ok(watchdogPlistSource.includes("30분"), "plist 주석은 30분 임계를 말해야 한다");
});

test("F2: 기존 n30 스케줄러 파일은 손대지 않는다", () => {
  const scheduler = readRepoFile("scripts/run-naver-shopping-chrome-scheduler.sh");
  assert.ok(!scheduler.includes("mi-rank-watchdog"));
  // 재기동 호출은 스케줄러 원본과 같은 형태여야 한다.
  assert.ok(scheduler.includes('/usr/bin/open -gj "${CHROME_APPLICATION_PATH}" --args \\'));
  assert.ok(watchdogSource.includes('/usr/bin/open -gj "${CHROME_APPLICATION_PATH}" --args \\'));
  assert.ok(scheduler.includes("'^(Default|Profile [1-9][0-9]{0,2})$'"));
  assert.ok(watchdogSource.includes("'^(Default|Profile [1-9][0-9]{0,2})$'"));
});

// ─────────────────────────────────────────────────────────────
// (G) F2 워치독 드라이런 — 판정 로직을 실제로 실행한다
// 반드시 MI_RANK_WATCHDOG_DRY_RUN=1 로만 돌린다(실제 Chrome 을 종료하지 않는다).
// ─────────────────────────────────────────────────────────────
const WATCHDOG_SCRIPT = path.join(repositoryRoot, "scripts/watchdog/mi-rank-watchdog.sh");
const darwinOnly = { skip: process.platform !== "darwin" ? "macOS(zsh) 전용 워치독" : false };

function createWatchdogHome(state) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mi-rank-watchdog-"));
  const supportDirectory = path.join(home, "Library/Application Support/MomentInsight");
  fs.mkdirSync(supportDirectory, { recursive: true });
  if (state) {
    // lastSyncAt 을 주지 않으면 웨이브 2 의 옛 2줄 형식을 그대로 쓴다. 아래 의사결정표
    // 9개 시나리오가 전부 옛 형식으로 도는 덕분에 하위호환이 표 전체로 증명된다.
    const body = "lastSyncAt" in state
      ? `stalled_since=${state.stalledSince}\nlast_restart_at=${state.lastRestartAt}\nlast_sync_at=${state.lastSyncAt}\n`
      : `stalled_since=${state.stalledSince}\nlast_restart_at=${state.lastRestartAt}\n`;
    fs.writeFileSync(path.join(supportDirectory, "mi-rank-watchdog.state"), body);
  }
  return home;
}

// 워치독이 해싱할 14개 파일은 설치 스크립트 원본에서 가져온다(테스트에 목록을 베끼지 않는다).
const RUNTIME_SYNC_RELATIVE_PATHS = bridgeRuntimeFilePaths();
// 워치독의 git status 경로지정(pathspec)에 항상 걸리는 디렉터리. 없으면 zsh 가
// "unknown pathspec" 으로 죽어 시나리오가 엉뚱한 이유로 실패한다.
const SYNC_EXTENSION_MANIFEST = "tools/naver-shopping-chrome-extension/manifest.json";

function writeSeedFile(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// 임시 $HOME 안에 가짜 "저장소 + 설치본" 한 쌍을 만든다. 실제 저장소도 실제 설치본도
// 절대 건드리지 않는다(드라이런이라 설치 스크립트 자체는 어차피 돌지 않는다).
function seedRuntimeSync(home, options = {}) {
  const { drift = false, missingFile = false, gitInit = false, dirty = false, copyMissing = false } = options;
  const source = path.join(home, "sync-source");
  const runtimeCopy = path.join(home, "Library/Application Support/MomentInsight/NaverShoppingBridge");

  writeSeedFile(source, "scripts/install-naver-shopping-chrome-bridge.mjs", "// stub installer\n");
  writeSeedFile(source, SYNC_EXTENSION_MANIFEST, '{"manifest_version":3}\n');
  for (const relative of RUNTIME_SYNC_RELATIVE_PATHS) {
    writeSeedFile(source, relative, `// seed ${relative}\n`);
  }

  const first = RUNTIME_SYNC_RELATIVE_PATHS[0];
  if (!copyMissing) {
    for (const relative of RUNTIME_SYNC_RELATIVE_PATHS) {
      writeSeedFile(runtimeCopy, relative, `// seed ${relative}\n`);
    }
    if (drift) writeSeedFile(runtimeCopy, first, `// drifted ${first}\n`);
    if (missingFile) fs.rmSync(path.join(runtimeCopy, first), { force: true });
  }

  if (gitInit) {
    const gitEnv = { ...process.env, HOME: home };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_GLOBAL"]) delete gitEnv[key];
    const git = (...args) => execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
      { cwd: source, stdio: "pipe", env: gitEnv },
    );
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    // 커밋한 뒤에 손대야 워킹트리가 더러워진다. 14개 목록 밖 파일이라 드리프트 수는 그대로다.
    if (dirty) writeSeedFile(source, SYNC_EXTENSION_MANIFEST, '{"manifest_version":3,"dirty":true}\n');
  }
  return source;
}

// 스텁 서버가 이 프로세스 안에서 돌기 때문에 동기 실행(execFileSync)을 쓰면 안 된다.
// 이벤트 루프가 막혀 커넥션이 수락되지 않고 curl 이 15초 타임아웃(28)으로 죽는다.
const execFileAsync = promisify(execFile);

async function runWatchdog(home, healthUrl, options = {}) {
  let status = 0;
  try {
    await execFileAsync("zsh", [WATCHDOG_SCRIPT], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: home,
        MI_RANK_WATCHDOG_DRY_RUN: "1",
        MI_RANK_WATCHDOG_HEALTH_URL: healthUrl,
        // process.env 를 펼쳐 넣기 때문에 두 키는 "요청하지 않을 때"도 반드시 빈 문자열로
        // 못 박아야 한다. 개발자 셸에 이 변수가 떠 있으면 아래 의사결정표 9개가 조용히 깨진다.
        MI_RANK_WATCHDOG_SYNC_SOURCE_PATH: options.syncSourcePath ?? "",
        MI_RANK_WATCHDOG_SYNC_DISABLED: options.syncDisabled ?? "",
      },
    });
  } catch (error) {
    if (typeof error.code === "number") status = error.code;
    else if (typeof error.status === "number") status = error.status;
    else status = -1;
  }
  const logPath = path.join(home, "Library/Logs/MomentInsight/mi-rank-watchdog.log");
  const raw = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim() : "";
  // 각 줄은 "<ISO8601> <event ...>" 형태다. 타임스탬프를 떼고 이벤트만 남긴다.
  const events = raw ? raw.split("\n").map((line) => line.replace(/^\S+\s/, "")) : [];
  return { status, events, raw };
}

function startHealthServer(getBody) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(getBody());
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("F2: 워치독 드라이런 의사결정표가 실제 실행으로 고정된다", darwinOnly, async (t) => {
  let responseBody = "";
  const server = await startHealthServer(() => responseBody);
  const homes = [];
  t.after(() => {
    server.close();
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  });
  const healthUrl = `http://127.0.0.1:${server.address().port}/api/rank-collection-health`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  // 실제 응답은 키 8개다. 워치독은 /usr/bin/grep -Eq 와 sed 로 본문 텍스트를 그대로
  // 훑으므로, 옛 4개 키의 이름과 순서를 바이트 단위로 고정한 채 나머지 키를 뒤에 붙인다.
  // lanes 안의 중첩 queueStalled 는 최상위와 OR 불변식(최상위 = OR(레인))을 지키므로
  // grep 판정이 흔들리지 않는다 — 여기서도 그 불변식대로 본문을 만든다.
  const body = (queueStalled, stalledMinutes, workerOutdated = false, heartbeatAgeMinutes = 0) => JSON.stringify({
    ok: true,
    lastSuccessAt: new Date().toISOString(),
    stalledMinutes,
    queueStalled,
    workerOutdated,
    heartbeatAgeMinutes,
    lanes: {
      product: { lastSuccessAt: new Date().toISOString(), stalledMinutes, queueStalled },
      place: { lastSuccessAt: new Date().toISOString(), stalledMinutes: 0, queueStalled: false },
    },
    trackers: { neverFound: 0, stuck: 0 },
  });

  const scenarios = [
    { label: "(a) 정상 + 상태 없음", stalled: false, minutes: 3, state: null, expect: "healthy" },
    { label: "(b) 정상 + 정체 기록 있음", stalled: false, minutes: 3, state: { stalledSince: nowSeconds - 5000, lastRestartAt: 0 }, expect: "stall_cleared" },
    { label: "(c) 정체 첫 관측", stalled: true, minutes: 700, state: null, expect: "stall_started" },
    { label: "(d) 정체 15분", stalled: true, minutes: 700, state: { stalledSince: nowSeconds - 900, lastRestartAt: 0 }, expect: "stall_pending" },
    // 임계값을 3600 → 1800 으로 내린 회귀를 고정한다. 2000초는 옛 임계에서 stall_pending
    // 이었고, 지금은 재기동 분기까지 실제로 도달해야 한다. 이 줄이 초록이면 하향이 먹은 것이다.
    { label: "(d2) 정체 2000초 — 30분 임계에서 재기동 진입", stalled: true, minutes: 700, state: { stalledSince: nowSeconds - 2000, lastRestartAt: 0 }, expect: "dry_run restart_would_run" },
    { label: "(e) 정체 4000초 + 재기동 이력 없음", stalled: true, minutes: 700, state: { stalledSince: nowSeconds - 4000, lastRestartAt: 0 }, expect: "dry_run restart_would_run" },
    { label: "(f) 위 + 10분 전 재기동", stalled: true, minutes: 700, state: { stalledSince: nowSeconds - 4000, lastRestartAt: nowSeconds - 600 }, expect: "restart_suppressed_cooldown" },
    { label: "(g) 위 + 시계 역행(미래 재기동 시각)", stalled: true, minutes: 700, state: { stalledSince: nowSeconds - 4000, lastRestartAt: nowSeconds + 600 }, expect: "restart_cooldown_clock_reset" },
    // 맥에서 Chrome 을 다시 열어도 윈도우 워커의 낡은 실행본은 고쳐지지 않는다. 고쳐지지도
    // 않을 일에 재기동을 쓰면 3시간 쿨다운만 태워 진짜 정체 때 손을 못 쓴다. 관측 키가
    // 켜져 있어도 대기열이 정상이면 워치독은 healthy 로 물러나야 한다.
    { label: "(k) 낡은 워커 경보만 켜짐 + 대기열 정상", stalled: false, minutes: 3, state: null, workerOutdated: true, heartbeatAgeMinutes: 864, expect: "healthy" },
  ];

  for (const scenario of scenarios) {
    responseBody = body(scenario.stalled, scenario.minutes, scenario.workerOutdated, scenario.heartbeatAgeMinutes);
    const home = createWatchdogHome(scenario.state);
    homes.push(home);
    // eslint-disable-next-line no-await-in-loop
    const { status, events } = await runWatchdog(home, healthUrl);
    assert.equal(status, 0, `${scenario.label} 은 exit 0 이어야 한다`);
    assert.ok(events.length > 0, `${scenario.label} 은 반드시 한 줄을 남긴다`);
    assert.ok(
      events[0].startsWith(scenario.expect),
      `${scenario.label} → ${scenario.expect} 이어야 하는데 "${events[0]}" 였다`,
    );
    // 드라이런은 절대 상태 파일을 쓰지 않는다.
    for (const event of events.slice(1)) {
      assert.ok(event.startsWith("dry_run state_write_skipped"), `${scenario.label} 부가 로그: ${event}`);
    }
  }
});

test("F2: 워치독은 장애·불량 본문·허용목록 위반에서 안전하게 물러난다", darwinOnly, async (t) => {
  const homes = [];
  t.after(() => {
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  });
  const home = () => {
    const created = createWatchdogHome(null);
    homes.push(created);
    return created;
  };

  // (h) 엔드포인트가 죽어 있다 → 상태를 건드리지 않고 물러난다.
  const closed = await startHealthServer(() => "{}");
  const deadUrl = `http://127.0.0.1:${closed.address().port}/api/rank-collection-health`;
  await new Promise((resolve) => closed.close(resolve));
  const unreachable = await runWatchdog(home(), deadUrl);
  assert.equal(unreachable.status, 0);
  assert.ok(unreachable.events[0].startsWith("health_unreachable"), unreachable.raw);

  // (i) 본문이 ok:true 가 아니다 → 판정하지 않는다.
  const server = await startHealthServer(() => JSON.stringify({ ok: false, queueStalled: true, stalledMinutes: 900 }));
  const url = `http://127.0.0.1:${server.address().port}/api/rank-collection-health`;
  const unusable = await runWatchdog(home(), url);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(unusable.status, 0);
  assert.ok(unusable.events[0].startsWith("health_body_unusable"), unusable.raw);

  // (j) 허용목록 밖 URL → 프로브 자체를 하지 않고 exit 1.
  const invalid = await runWatchdog(home(), "http://example.com/api/rank-collection-health");
  assert.equal(invalid.status, 1);
  assert.ok(invalid.events[0].startsWith("health_url_invalid"), invalid.raw);
});

test("F2: 런타임 드리프트 동기화 패스가 실제 실행으로 고정된다", darwinOnly, async (t) => {
  // 전부 MI_RANK_WATCHDOG_DRY_RUN=1 이다. 설치 스크립트는 절대 돌지 않고 Chrome 도
  // 건드리지 않는다. 판정에 쓰는 저장소·설치본은 전부 임시 $HOME 안의 가짜다.
  const server = await startHealthServer(() => JSON.stringify({
    ok: true,
    lastSuccessAt: new Date().toISOString(),
    stalledMinutes: 3,
    queueStalled: false,
    workerOutdated: false,
    heartbeatAgeMinutes: 0,
  }));
  const homes = [];
  t.after(() => {
    server.close();
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  });
  const healthUrl = `http://127.0.0.1:${server.address().port}/api/rank-collection-health`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const scenarios = [
    { label: "(a) 14개 전부 동일", seed: { gitInit: true }, expect: "runtime_in_sync" },
    { label: "(b) 1개 드리프트 + 깨끗한 워킹트리", seed: { drift: true, gitInit: true }, expect: "dry_run drift_sync_would_run files=1" },
    { label: "(c) 드리프트 + 커밋 안 된 변경", seed: { drift: true, gitInit: true, dirty: true }, expect: "drift_detected", contains: "sync_skipped=repository_dirty" },
    { label: "(d) 드리프트 + git 워킹트리가 아님", seed: { drift: true }, expect: "sync_check_failed reason=not_a_git_worktree" },
    { label: "(e) 설치본에 14개 중 하나가 없다", seed: { missingFile: true, gitInit: true }, expect: "sync_check_failed reason=hash_unreadable" },
    { label: "(f) 설치본 디렉터리 자체가 없다", seed: { copyMissing: true, gitInit: true }, expect: "sync_check_failed reason=runtime_copy_missing" },
    // 원본이 "정해졌는데 쓸 수 없는" 경우에만 소리를 낸다. 아예 정해지지 않은 경우는
    // 아래 의사결정표 9개가 증명하듯 완전 무음이어야 한다(둘을 섞으면 로그가 매 tick 운다).
    { label: "(g) 동기화 원본이 없는 경로", sourceOverride: "no-such-sync-source", expect: "sync_check_failed reason=sync_source_unresolved" },
    { label: "(h) 탈출구 환경변수로 끔", seed: { drift: true, gitInit: true }, syncDisabled: "1", expect: "sync_disabled" },
    { label: "(i) 드리프트 + 1시간 전 동기화", seed: { drift: true, gitInit: true }, state: { stalledSince: 0, lastRestartAt: 0, lastSyncAt: nowSeconds - 3600 }, expect: "drift_detected", contains: "sync_suppressed_cooldown" },
    { label: "(j) 드리프트 + 시계 역행(미래 동기화 시각)", seed: { drift: true, gitInit: true }, state: { stalledSince: 0, lastRestartAt: 0, lastSyncAt: nowSeconds + 600 }, expect: "sync_cooldown_clock_reset" },
    // 옛 2줄 상태 파일이 그대로 읽혀야 한다. stalled_since 가 실제로 읽혔다는 증거로
    // stall_cleared 까지 확인한다(안 읽혔다면 healthy 가 찍힌다).
    { label: "(k) 옛 2줄 상태 파일 하위호환", seed: { gitInit: true }, state: { stalledSince: nowSeconds - 5000, lastRestartAt: 0 }, expect: "runtime_in_sync", verdict: "stall_cleared" },
  ];

  for (const scenario of scenarios) {
    const home = createWatchdogHome(scenario.state ?? null);
    homes.push(home);
    const seeded = scenario.seed ? seedRuntimeSync(home, scenario.seed) : "";
    const syncSourcePath = scenario.sourceOverride ? path.join(home, scenario.sourceOverride) : seeded;
    // eslint-disable-next-line no-await-in-loop
    const { status, events, raw } = await runWatchdog(home, healthUrl, {
      syncSourcePath,
      syncDisabled: scenario.syncDisabled ?? "",
    });
    assert.equal(status, 0, `${scenario.label} 은 exit 0 이어야 한다 :: ${raw}`);
    assert.ok(events.length > 0, `${scenario.label} 은 반드시 한 줄을 남긴다`);
    assert.ok(
      events[0].startsWith(scenario.expect),
      `${scenario.label} → "${scenario.expect}" 로 시작해야 하는데 "${events[0]}" 였다`
        + " (sync_skipped=collection_active 가 나왔다면 이 맥에서 실제 수집이 돌고 있거나"
        + " moment-insight-n-shopping-worker.lock 이 살아 있는 것이다 — 단언을 약화하지 말고 그대로 보고할 것)",
    );
    if (scenario.contains) {
      assert.ok(
        events[0].includes(scenario.contains),
        `${scenario.label} → "${scenario.contains}" 를 포함해야 하는데 "${events[0]}" 였다`,
      );
    }
    if (scenario.verdict) {
      assert.ok(
        events.some((event) => event.startsWith(scenario.verdict)),
        `${scenario.label} 은 ${scenario.verdict} 판정까지 도달해야 한다 :: ${raw}`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────
// (H) 셸 문법 점검
// ─────────────────────────────────────────────────────────────
test("F2: 워치독 셸 두 개가 zsh -n 을 통과한다", darwinOnly, () => {
  for (const relative of [
    "scripts/watchdog/mi-rank-watchdog.sh",
    "scripts/watchdog/install-mi-rank-watchdog.sh",
  ]) {
    execFileSync("zsh", ["-n", relative], { cwd: repositoryRoot, stdio: "pipe" });
    const mode = fs.statSync(path.join(repositoryRoot, relative)).mode & 0o777;
    assert.equal(mode, 0o755, `${relative} must be 0755`);
  }
});

test("F3: 임계값 상수가 SPEC 값과 일치한다", () => {
  assert.equal(RANK_OVERDUE_THRESHOLD_MS, 21_600_000);
  assert.equal(RANK_RETRY_EXHAUSTED_AT, 8);
  assert.equal(RANK_REQUEUE_MIN_IDLE_MS, 21_600_000);
  assert.equal(RANK_REQUEUE_DAILY_CAP, 2);
});

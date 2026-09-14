import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 2026-09-14 서버 안정화: 순위 목록 조회의 브라우저 측 보강이 광고주·관리자 화면에 동일하게 있는지 고정한다.
const pageEntries = ["src/pages/client.html", "src/pages/admin.html"]
  .map((relative) => [relative, fs.readFileSync(path.join(process.cwd(), relative), "utf8")]);
const pages = pageEntries.map((entry) => entry[1]);
const adminSource = pageEntries.find((entry) => entry[0] === "src/pages/admin.html")[1];

function namedFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

function fakeTimerHarness() {
  const entries = [];
  return {
    entries,
    set(callback, delay) {
      const id = entries.length;
      entries.push({ callback, delay, cancelled: false });
      return id;
    },
    clear(id) {
      if (entries[id]) entries[id].cancelled = true;
    },
    fire(id, force) {
      const entry = entries[id];
      if (entry && (force || !entry.cancelled)) entry.callback();
    },
  };
}

function listRecoveryHarness(source, kind, timers, attemptsPerLoad) {
  const product = kind === "product";
  const prefix = product ? "rank" : "place";
  const constantName = product ? "RANK_LIST_RECOVERY_DELAY_MS" : "PLACE_LIST_RECOVERY_DELAY_MS";
  const resetName = product ? "resetRankListRecoveryBudget" : "resetPlaceListRecoveryBudget";
  const scheduleName = product ? "scheduleRankListRecovery" : "schedulePlaceListRecovery";
  const loadName = product ? "loadRankTrackers" : "loadPlaceTrackers";
  const currentName = product ? "rankRequestIsCurrent" : "placeRequestIsCurrent";
  const generationName = product ? "rankRequestGeneration" : "placeRequestGeneration";
  const activeName = product ? "rankActiveScopeKey" : "placeActiveScopeKey";
  const timerName = `${prefix}ListRecoveryTimer`;
  const scopeName = `${prefix}ListRecoveryScopeKey`;
  const recoveryGenerationName = `${prefix}ListRecoveryGeneration`;
  const attemptedName = `${prefix}ListRecoveryAttempted`;
  const resetSource = namedFunctionSource(source, resetName);
  const scheduleSource = namedFunctionSource(source, scheduleName);
  const factory = new Function("setTimeout", "clearTimeout", "attemptsPerLoad", `
    var ${constantName} = 15000;
    var ${timerName} = null;
    var ${scopeName} = "";
    var ${recoveryGenerationName} = -1;
    var ${attemptedName} = false;
    var ${generationName} = 1;
    var ${activeName} = "scope-a";
    var currentScopeKey = "scope-a";
    var loadCalls = [];
    var getAttempts = attemptsPerLoad;
    function sameRankTrackerScope(scope) { return Boolean(scope) && scope.key === currentScopeKey; }
    function ${currentName}(scope, generation) {
      return generation === ${generationName} && sameRankTrackerScope(scope) && ${activeName} === scope.key;
    }
    function ${loadName}() {
      loadCalls.push(Array.from(arguments));
      getAttempts += attemptsPerLoad;
      return Promise.resolve(false);
    }
    ${resetSource}
    ${scheduleSource}
    return {
      reset: ${resetName},
      schedule: ${scheduleName},
      loadCalls: loadCalls,
      getAttempts: function () { return getAttempts; },
      setScope: function (scope, generation) {
        currentScopeKey = scope ? scope.key : "";
        ${generationName} = generation;
        ${activeName} = scope ? scope.key : "";
        ${resetName}(scope, generation);
      }
    };
  `);
  return factory(timers.set.bind(timers), timers.clear.bind(timers), attemptsPerLoad);
}

test("rank tracker list GET waits 30 seconds and retries a failed connection once", () => {
  for (const clientSource of pages) {
  assert.ok(clientSource.includes('(method === "GET" ? 30000 : 20000)'));
  assert.ok(clientSource.includes("if (method !== \"GET\" || requestGeneration !== rankRequestGeneration || !sameRankTrackerScope(requestScope)) throw firstError;"));
  assert.ok(clientSource.includes("setTimeout(resolve, 1500)"));
  // 재시도는 한 번뿐이다: 두 번째 miFetch 는 try 밖에서 그대로 throw 한다.
  const catchIndex = clientSource.indexOf("catch (firstError)");
  const retryBlock = clientSource.slice(catchIndex, clientSource.indexOf("var payload = await response.json()", catchIndex));
  assert.equal((retryBlock.match(/await miFetch\(url, options\)/g) || []).length, 1);
  }
});

test("the connection-failure banner names the reason and promises the automatic reload", () => {
  for (const clientSource of pages) {
  assert.ok(clientSource.includes("function rankConnectionFailureReason(error)"));
  assert.ok(clientSource.includes('"순위 추적 서버 연결 실패(" + rankConnectionFailureReason(error) + ")로 마지막 정상 순위와 이력을 유지합니다. 잠시 후 자동으로 다시 불러옵니다."'));
  assert.ok(clientSource.includes('return "요청 시간 초과 30초·재시도 1회";'));
  assert.ok(clientSource.includes('return "네트워크 오류·재시도 1회";'));
  }
});

test("passive product and place list loads are single-flight per verified scope", () => {
  for (const clientSource of pages) {
    assert.ok(clientSource.includes("var rankListLoadInFlight = null;"));
    assert.ok(clientSource.includes("rankListLoadInFlight.scopeKey === scope.key"));
    assert.ok(clientSource.includes("return rankListLoadInFlight.promise;"));
    assert.ok(clientSource.includes("var placeListLoadInFlight = null;"));
    assert.ok(clientSource.includes("placeListLoadInFlight.scopeKey === scope.key"));
    assert.ok(clientSource.includes("return placeListLoadInFlight.promise;"));

    const productLoad = clientSource.slice(
      clientSource.indexOf("async function loadRankTrackers(silent, forceFresh, skipAutoSyncOnce)"),
      clientSource.indexOf("async function refreshAllRankTrackers", clientSource.indexOf("async function loadRankTrackers(silent, forceFresh, skipAutoSyncOnce)")),
    );
    const placeLoad = clientSource.slice(
      clientSource.indexOf("async function loadPlaceTrackers(silent, forceFresh, skipAutoSyncOnce)"),
      clientSource.indexOf("function syncPlaceKeywordFromMain", clientSource.indexOf("async function loadPlaceTrackers(silent, forceFresh, skipAutoSyncOnce)")),
    );
    assert.ok(productLoad.includes("var generation = rankRequestGeneration;"));
    assert.ok(placeLoad.includes("var generation = placeRequestGeneration;"));
    assert.ok(!productLoad.includes("++rankRequestGeneration"));
    assert.ok(!placeLoad.includes("++placeRequestGeneration"));
  }
});

test("post-mutation reload waits for any passive GET and then performs one fresh GET", () => {
  for (const clientSource of pages) {
    assert.ok(clientSource.includes("pendingLoad.refreshPromise = pendingLoad.promise.then(function ()"));
    assert.ok(clientSource.includes("rankListLoadInFlight.skipAutoSync = true;"));
    assert.ok(clientSource.includes("placeListLoadInFlight.skipAutoSync = true;"));
    assert.equal((clientSource.match(/autoSyncCovered: false/g) || []).length, 2);
    assert.ok(clientSource.includes("if (!loadState.skipAutoSync) {"));
    assert.ok(clientSource.includes("var autoSyncLastAtBefore = rankAutoSyncLastAt;"));
    assert.ok(clientSource.includes("loadState.autoSyncCovered = rankAutoSyncLastAt !== autoSyncLastAtBefore;"));
    assert.ok(clientSource.includes("var autoSyncLastAtBefore = placeAutoSyncLastAt;"));
    assert.ok(clientSource.includes("loadState.autoSyncCovered = placeAutoSyncLastAt !== autoSyncLastAtBefore;"));
    assert.ok(clientSource.includes("return loadRankTrackers(!pendingLoad.refreshAnnounce, false, pendingLoad.autoSyncCovered);"));
    assert.ok(clientSource.includes("return loadPlaceTrackers(!pendingLoad.refreshAnnounce, false, pendingLoad.autoSyncCovered);"));

    const productBefore = clientSource.indexOf("var autoSyncLastAtBefore = rankAutoSyncLastAt;");
    const productSync = clientSource.indexOf("await syncDueRankTrackersIfNeeded", productBefore);
    const productCovered = clientSource.indexOf("loadState.autoSyncCovered = rankAutoSyncLastAt !== autoSyncLastAtBefore;", productSync);
    assert.ok(productBefore >= 0 && productBefore < productSync && productSync < productCovered);

    const placeBefore = clientSource.indexOf("var autoSyncLastAtBefore = placeAutoSyncLastAt;");
    const placeSync = clientSource.indexOf("await syncDuePlaceTrackersIfNeeded", placeBefore);
    const placeCovered = clientSource.indexOf("loadState.autoSyncCovered = placeAutoSyncLastAt !== autoSyncLastAtBefore;", placeSync);
    assert.ok(placeBefore >= 0 && placeBefore < placeSync && placeSync < placeCovered);

    assert.ok(!clientSource.includes("refreshSkipAutoSync"));
    assert.ok((clientSource.match(/loadRankTrackers\(true, true\)/g) || []).length >= 1);
    assert.ok((clientSource.match(/loadPlaceTrackers\(true, true\)/g) || []).length >= 1);
    assert.equal((clientSource.match(/loadRankTrackers\(true\)/g) || []).length, 0);
    assert.equal((clientSource.match(/loadPlaceTrackers\(true\)/g) || []).length, 0);
  }
});

test("a trailing fresh load is cancelled if the verified advertiser scope changed", () => {
  for (const clientSource of pages) {
    assert.ok(clientSource.includes("pendingLoad.generation !== rankRequestGeneration || !sameRankTrackerScope(scope) || rankActiveScopeKey !== scope.key"));
    assert.ok(clientSource.includes("pendingLoad.generation !== placeRequestGeneration || !sameRankTrackerScope(scope) || placeActiveScopeKey !== scope.key"));
  }
});

test("a failed list request gets one delayed read-only recovery and never loops in the same failure streak", async () => {
  for (const clientSource of pages) {
    for (const [kind, attemptsPerLoad, maximumGets] of [["product", 2, 4], ["place", 1, 2]]) {
      const timers = fakeTimerHarness();
      const harness = listRecoveryHarness(clientSource, kind, timers, attemptsPerLoad);
      const scope = { key: "scope-a" };
      harness.reset(scope, 1);

      assert.equal(harness.schedule(scope, 1), true);
      assert.equal(harness.schedule(scope, 1), false);
      assert.equal(timers.entries.length, 1);
      assert.equal(timers.entries[0].delay, 15000);
      timers.fire(0);
      await Promise.resolve();

      assert.deepEqual(harness.loadCalls, [[true, false, true]]);
      assert.equal(harness.getAttempts(), maximumGets);
      assert.equal(harness.schedule(scope, 1), false);
      assert.equal(timers.entries.length, 1);
    }
  }
});

test("scope change cancels and independently invalidates an old delayed recovery", async () => {
  for (const clientSource of pages) {
    for (const kind of ["product", "place"]) {
      const timers = fakeTimerHarness();
      const harness = listRecoveryHarness(clientSource, kind, timers, 1);
      const oldScope = { key: "scope-a" };
      const newScope = { key: "scope-b" };
      harness.reset(oldScope, 1);
      assert.equal(harness.schedule(oldScope, 1), true);

      harness.setScope(newScope, 2);
      assert.equal(timers.entries[0].cancelled, true);
      timers.fire(0, true);
      await Promise.resolve();
      assert.equal(harness.loadCalls.length, 0);
      assert.equal(harness.schedule(oldScope, 1), false);
      assert.equal(harness.schedule(newScope, 2), true);
    }
  }
});

test("successful complete loads reset recovery budget while catches only schedule it", () => {
  for (const clientSource of pages) {
    const productLoad = clientSource.slice(
      clientSource.indexOf("async function loadRankTrackers(silent, forceFresh, skipAutoSyncOnce)"),
      clientSource.indexOf("async function refreshAllRankTrackers", clientSource.indexOf("async function loadRankTrackers(silent, forceFresh, skipAutoSyncOnce)")),
    );
    const placeLoad = clientSource.slice(
      clientSource.indexOf("async function loadPlaceTrackers(silent, forceFresh, skipAutoSyncOnce)"),
      clientSource.indexOf("function syncPlaceKeywordFromMain", clientSource.indexOf("async function loadPlaceTrackers(silent, forceFresh, skipAutoSyncOnce)")),
    );
    assert.ok(productLoad.includes("resetRankListRecoveryBudget(scope, generation);"));
    assert.ok(productLoad.includes("scheduleRankListRecovery(scope, generation);"));
    assert.ok(placeLoad.includes("resetPlaceListRecoveryBudget(scope, generation);"));
    assert.ok(placeLoad.includes("schedulePlaceListRecovery(scope, generation);"));
    assert.ok(clientSource.includes("resetRankListRecoveryBudget(scope, rankRequestGeneration);"));
    assert.ok(clientSource.includes("resetPlaceListRecoveryBudget(scope, placeRequestGeneration);"));
  }
});

test("health polling only rerenders cached cards and never reloads or syncs rank lists", () => {
  const healthStart = adminSource.indexOf("async function refreshRankCollectionHealthSignal()");
  const healthEnd = adminSource.indexOf("function rankDateKey", healthStart);
  const healthBlock = adminSource.slice(healthStart, healthEnd);
  assert.ok(healthStart >= 0 && healthEnd > healthStart);
  assert.ok(healthBlock.includes('window.dispatchEvent(new CustomEvent("mi:rank-health-updated"))'));
  assert.ok(!healthBlock.includes('mi:rank-scope-changed'));
  assert.ok(!healthBlock.includes("previous.heartbeatAgeMinutes !== next.heartbeatAgeMinutes"));
  assert.ok(healthBlock.includes("previousHeartbeatStale !== nextHeartbeatStale"));

  assert.match(adminSource, /window\.addEventListener\("mi:rank-health-updated", function \(\) \{\s*renderRankHistory\(rankHistory, rankTrackers\);\s*\}\);/);
  assert.match(adminSource, /window\.addEventListener\("mi:rank-health-updated", function \(\) \{\s*renderPlaceHistory\(placeHistory, placeTrackers\);\s*\}\);/);
});

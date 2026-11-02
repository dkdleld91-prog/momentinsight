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

// 2026-10-16 로그 저장량 절감: 수집기 건강 신호 폴링은 보이는 탭에서만 60초마다 돈다.
// 화면 원본의 폴링 블록(주석부터 initMetaAdsTool 직전까지)을 그대로 떼어 가짜 타이머·
// 가짜 document/window 위에서 실행한다. 갱신 함수는 호출 횟수만 세는 스텁이다.
const HEALTH_POLLING_START = "      // 수집기 건강 신호 폴링.";
const HEALTH_POLLING_END = "\n      initMetaAdsTool();";
const HEALTH_POLLING_INTERVAL_MS = 60000;

function healthPollingHarness(options) {
  const settings = options || {};
  const start = adminSource.indexOf(HEALTH_POLLING_START);
  const end = adminSource.indexOf(HEALTH_POLLING_END, start);
  assert.ok(start >= 0 && end > start, "health polling block must exist");
  const block = adminSource.slice(start, end);
  // setInterval·setTimeout 을 한 표에서 가상 시계로 돌린다(once 는 setTimeout).
  const timers = new Map();
  const listeners = { document: {}, window: {} };
  let nextId = 1;
  let now = 0;
  let refreshCalls = 0;
  const fakeDocument = {
    hidden: settings.hidden,
    addEventListener(type, callback) { (listeners.document[type] ||= []).push(callback); },
  };
  const fakeWindow = {
    addEventListener(type, callback) { (listeners.window[type] ||= []).push(callback); },
  };
  const addTimer = (callback, delay, once) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { callback, delay, nextAt: now + delay, once });
    return id;
  };
  if (settings.timers !== false) {
    fakeWindow.setInterval = (callback, delay) => addTimer(callback, delay, false);
    fakeWindow.clearInterval = (id) => { timers.delete(id); };
    fakeWindow.setTimeout = (callback, delay) => addTimer(callback, delay, true);
    fakeWindow.clearTimeout = (id) => { timers.delete(id); };
  }
  // 블록의 Date.now() 는 가상 시계를 읽는다. 실제 브라우저처럼 0 이 아닌 시각에서 시작한다
  // (화면 코드의 0 은 "아직 요청하지 않음"이다). 테스트가 보는 now 는 시작 기준 경과 ms 다.
  const clockBase = Date.parse("2026-10-16T09:00:00.000Z");
  const fakeDate = { now: () => clockBase + now };
  const factory = new Function("window", "document", "refreshRankCollectionHealthSignal", "Date", `
    ${block}
    return { timer: function () { return rankCollectionHealthTimer; } };
  `);
  const api = factory(fakeWindow, fakeDocument, () => {
    refreshCalls += 1;
    if (settings.onRefresh) return settings.onRefresh(now);
    return Promise.resolve();
  }, fakeDate);
  return {
    refreshCalls: () => refreshCalls,
    intervals: () => Array.from(timers.values()).filter((entry) => !entry.once),
    timeouts: () => Array.from(timers.values()).filter((entry) => entry.once),
    timer: api.timer,
    now: () => now,
    listenerCount: (target, type) => (listeners[target][type] || []).length,
    // 가상 시계를 ms 만큼 진행하며 그 사이 도래한 타이머를 순서대로 실행한다.
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let dueId = 0;
        let due = null;
        for (const [id, entry] of timers) {
          if (entry.nextAt <= until && (!due || entry.nextAt < due.nextAt)) {
            due = entry;
            dueId = id;
          }
        }
        if (!due) break;
        now = due.nextAt;
        if (due.once) timers.delete(dueId);
        else due.nextAt += due.delay;
        due.callback();
      }
      now = until;
    },
    setHidden(hidden) {
      fakeDocument.hidden = hidden;
      (listeners.document.visibilitychange || []).forEach((callback) => callback({ type: "visibilitychange" }));
    },
    fireWindow(type, event) {
      (listeners.window[type] || []).forEach((callback) => callback(Object.assign({ type }, event || {})));
    },
  };
}

test("health polling keeps the visible-tab behaviour: one refresh on load, then every 60 seconds", () => {
  const harness = healthPollingHarness({ hidden: false });
  assert.equal(harness.refreshCalls(), 1);
  assert.equal(harness.intervals().length, 1);
  // 처음 로드의 pageshow(persisted:false)는 이미 도는 폴링을 겹치지 않는다.
  harness.fireWindow("pageshow", { persisted: false });
  assert.equal(harness.refreshCalls(), 1);
  assert.equal(harness.intervals().length, 1);
  assert.equal(harness.intervals()[0].delay, HEALTH_POLLING_INTERVAL_MS);
  harness.advance(HEALTH_POLLING_INTERVAL_MS - 1);
  assert.equal(harness.refreshCalls(), 1);
  harness.advance(1);
  assert.equal(harness.refreshCalls(), 2);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 3);
  assert.equal(harness.refreshCalls(), 5);
  assert.equal(harness.listenerCount("document", "visibilitychange"), 1);
  assert.equal(harness.listenerCount("window", "pagehide"), 1);
  assert.equal(harness.listenerCount("window", "pageshow"), 1);
});

test("health polling stops while the tab is hidden and makes zero requests", () => {
  const harness = healthPollingHarness({ hidden: false });
  harness.setHidden(true);
  assert.equal(harness.intervals().length, 0);
  assert.equal(harness.timer(), 0);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 30);
  assert.equal(harness.refreshCalls(), 1);
  // 숨은 동안 숨김 신호가 또 와도 아무것도 시작하지 않는다.
  harness.setHidden(true);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 5);
  assert.equal(harness.refreshCalls(), 1);
  assert.equal(harness.intervals().length, 0);
});

test("health polling refreshes once immediately when the tab becomes visible, then every 60 seconds", () => {
  const harness = healthPollingHarness({ hidden: false });
  harness.setHidden(true);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 10);
  assert.equal(harness.refreshCalls(), 1);
  harness.setHidden(false);
  assert.equal(harness.refreshCalls(), 2);
  assert.equal(harness.intervals().length, 1);
  assert.equal(harness.intervals()[0].delay, HEALTH_POLLING_INTERVAL_MS);
  harness.advance(HEALTH_POLLING_INTERVAL_MS - 1);
  assert.equal(harness.refreshCalls(), 2);
  harness.advance(1);
  assert.equal(harness.refreshCalls(), 3);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 2);
  assert.equal(harness.refreshCalls(), 5);
});

test("repeated visible signals never stack a second health polling timer", () => {
  const harness = healthPollingHarness({ hidden: false });
  harness.setHidden(false);
  harness.setHidden(false);
  harness.fireWindow("pageshow", { persisted: true });
  assert.equal(harness.intervals().length, 1);
  assert.equal(harness.refreshCalls(), 1);

  // 60초 넘게 숨었다 돌아오면 즉시 1회다. 보임 신호가 겹쳐도 타이머는 하나다.
  harness.setHidden(true);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 2);
  harness.setHidden(false);
  harness.setHidden(false);
  harness.setHidden(false);
  harness.fireWindow("pageshow", { persisted: true });
  assert.equal(harness.intervals().length, 1);
  assert.equal(harness.timeouts().length, 0);
  assert.equal(harness.refreshCalls(), 2);
  harness.advance(HEALTH_POLLING_INTERVAL_MS);
  assert.equal(harness.refreshCalls(), 3);

  // 60초 안에 숨었다 돌아오면 남은 시간 대기 타이머 하나만 생기고, 보임 신호가 겹쳐도 하나다.
  harness.setHidden(true);
  harness.advance(1000);
  harness.setHidden(false);
  harness.setHidden(false);
  harness.fireWindow("pageshow", { persisted: true });
  assert.equal(harness.intervals().length, 0);
  assert.equal(harness.timeouts().length, 1);
  assert.equal(harness.refreshCalls(), 3);
});

test("a tab opened in the background defers the first health refresh until it is shown", () => {
  const harness = healthPollingHarness({ hidden: true });
  assert.equal(harness.refreshCalls(), 0);
  assert.equal(harness.intervals().length, 0);
  // 처음 로드의 pageshow(persisted:false)는 숨은 탭을 깨우지 않는다.
  harness.fireWindow("pageshow", { persisted: false });
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 10);
  assert.equal(harness.refreshCalls(), 0);
  assert.equal(harness.intervals().length, 0);
  harness.setHidden(false);
  assert.equal(harness.refreshCalls(), 1);
  assert.equal(harness.intervals().length, 1);
  harness.advance(HEALTH_POLLING_INTERVAL_MS);
  assert.equal(harness.refreshCalls(), 2);
});

test("pagehide stops health polling and a bfcache pageshow restarts it", () => {
  const harness = healthPollingHarness({ hidden: false });
  harness.fireWindow("pagehide", { persisted: true });
  assert.equal(harness.intervals().length, 0);
  assert.equal(harness.timer(), 0);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 5);
  assert.equal(harness.refreshCalls(), 1);
  harness.fireWindow("pageshow", { persisted: true });
  assert.equal(harness.refreshCalls(), 2);
  assert.equal(harness.intervals().length, 1);
  harness.advance(HEALTH_POLLING_INTERVAL_MS);
  assert.equal(harness.refreshCalls(), 3);

  // 숨은 채로 bfcache 에서 돌아오면 보일 때까지 기다린다.
  harness.fireWindow("pagehide", { persisted: true });
  harness.setHidden(true);
  harness.fireWindow("pageshow", { persisted: true });
  assert.equal(harness.intervals().length, 0);
  assert.equal(harness.timeouts().length, 0);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 3);
  assert.equal(harness.refreshCalls(), 3);
  harness.setHidden(false);
  assert.equal(harness.refreshCalls(), 4);
  assert.equal(harness.intervals().length, 1);
});

test("health polling falls back to the old always-on loop without the Page Visibility API and tolerates missing timers", () => {
  const legacy = healthPollingHarness({ hidden: undefined });
  assert.equal(legacy.refreshCalls(), 1);
  assert.equal(legacy.intervals().length, 1);
  legacy.advance(HEALTH_POLLING_INTERVAL_MS);
  assert.equal(legacy.refreshCalls(), 2);
  // setInterval 이 없는 환경에서도 블록이 throw 하지 않아 페이지 초기화가 이어진다.
  assert.doesNotThrow(() => healthPollingHarness({ hidden: false, timers: false }));
});

// 2026-10-16 검토 반영: 탭을 잠깐 오갈 때마다 즉시 요청이 나가 분당 요청이 늘던 결함.
// 마지막 요청이 60초 안이면 즉시 갱신 대신 그 요청 60초 뒤에 첫 갱신을 건다.
test("a quick hide/show within 60 seconds skips the immediate refresh and keeps the 60-second spacing", () => {
  const requestedAt = [];
  const harness = healthPollingHarness({ hidden: false, onRefresh: (now) => { requestedAt.push(now); return Promise.resolve(); } });
  assert.deepEqual(requestedAt, [0]);
  harness.advance(10000);
  harness.setHidden(true);
  harness.advance(5000);
  harness.setHidden(false);
  // 15초 전에 요청했으므로 즉시 갱신은 없고, 남은 45초 대기 타이머 하나만 있다.
  assert.deepEqual(requestedAt, [0]);
  assert.equal(harness.intervals().length, 0);
  assert.equal(harness.timeouts().length, 1);
  assert.equal(harness.timeouts()[0].delay, HEALTH_POLLING_INTERVAL_MS - 15000);
  harness.advance(HEALTH_POLLING_INTERVAL_MS - 15000 - 1);
  assert.deepEqual(requestedAt, [0]);
  harness.advance(1);
  // 첫 요청 60초 뒤에 갱신하고, 그 뒤로는 다시 60초 주기다.
  assert.deepEqual(requestedAt, [0, HEALTH_POLLING_INTERVAL_MS]);
  assert.equal(harness.timeouts().length, 0);
  assert.equal(harness.intervals().length, 1);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 2);
  assert.deepEqual(requestedAt, [0, HEALTH_POLLING_INTERVAL_MS, HEALTH_POLLING_INTERVAL_MS * 2, HEALTH_POLLING_INTERVAL_MS * 3]);
});

test("toggling the tab every 5 seconds for 10 minutes sends no more requests than a visible tab", () => {
  const visible = healthPollingHarness({ hidden: false });
  visible.advance(10 * 60000);
  const toggling = healthPollingHarness({ hidden: false });
  for (let elapsed = 0; elapsed < 10 * 60000; elapsed += 5000) {
    toggling.advance(5000);
    toggling.setHidden(!(elapsed / 5000 % 2));
  }
  assert.equal(visible.refreshCalls(), 11);
  assert.ok(toggling.refreshCalls() <= visible.refreshCalls(), `toggling=${toggling.refreshCalls()} visible=${visible.refreshCalls()}`);
  // 오가는 동안에도 요청 간격은 60초보다 짧아지지 않는다.
  const requestedAt = [];
  const spaced = healthPollingHarness({ hidden: false, onRefresh: (now) => { requestedAt.push(now); return Promise.resolve(); } });
  for (let elapsed = 0; elapsed < 10 * 60000; elapsed += 5000) {
    spaced.advance(5000);
    spaced.setHidden(!(elapsed / 5000 % 2));
  }
  for (let index = 1; index < requestedAt.length; index += 1) {
    assert.ok(requestedAt[index] - requestedAt[index - 1] >= HEALTH_POLLING_INTERVAL_MS, JSON.stringify(requestedAt));
  }
});

test("hiding again during the remaining-time wait cancels it, and a slow in-flight request is never doubled by a quick show", () => {
  // 첫 응답이 오지 않는 동안(느린 서버) 숨김·보임이 와도 두 번째 요청을 보내지 않는다 — 늦게 온 옛 응답이
  // 새 응답을 덮는 경로가 생기지 않는다.
  const pending = [];
  const harness = healthPollingHarness({ hidden: false, onRefresh: () => new Promise((resolve) => { pending.push(resolve); }) });
  assert.equal(harness.refreshCalls(), 1);
  harness.advance(3000);
  harness.setHidden(true);
  harness.setHidden(false);
  assert.equal(harness.refreshCalls(), 1);
  assert.equal(harness.timeouts().length, 1);
  // 대기 중에 다시 숨으면 대기 타이머도 지워져 숨은 동안 요청이 0건이다.
  harness.setHidden(true);
  assert.equal(harness.timeouts().length, 0);
  assert.equal(harness.intervals().length, 0);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 5);
  assert.equal(harness.refreshCalls(), 1);
  // 60초가 지난 뒤 보이면 예전처럼 즉시 1회다.
  harness.setHidden(false);
  assert.equal(harness.refreshCalls(), 2);
  assert.equal(harness.intervals().length, 1);
  pending.forEach((resolve) => resolve());
});

test("pagehide during the remaining-time wait also cancels it", () => {
  const harness = healthPollingHarness({ hidden: false });
  harness.setHidden(true);
  harness.setHidden(false);
  assert.equal(harness.timeouts().length, 1);
  harness.fireWindow("pagehide", { persisted: true });
  assert.equal(harness.timeouts().length, 0);
  assert.equal(harness.intervals().length, 0);
  harness.advance(HEALTH_POLLING_INTERVAL_MS * 3);
  assert.equal(harness.refreshCalls(), 1);
  harness.fireWindow("pageshow", { persisted: true });
  assert.equal(harness.refreshCalls(), 2);
  assert.equal(harness.intervals().length, 1);
});

// ── 2026-11-02 점검: N 플레이스 30일 화면 3건(F16 선택 해제 · F15 휴대폰 선택 줄 · F23 등록 시간 제한) ──
const clientPageSource = pageEntries.find((entry) => entry[0] === "src/pages/client.html")[1];
const placePages = [["admin", adminSource], ["client", clientPageSource]];

function balancedBlockFrom(source, start) {
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error("block is incomplete");
}

function asyncFunctionSource(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  return balancedBlockFrom(source, start);
}

function placeRunHandlerSource(source) {
  const listen = source.indexOf('placeRun.addEventListener("click", async function () {');
  assert.ok(listen >= 0, "place register handler must exist");
  return balancedBlockFrom(source, source.indexOf("async function () {", listen));
}

function placeCardClickHandlerSource(source) {
  const listen = source.indexOf('card.addEventListener("click", async function (event) {', source.indexOf('placeRun.addEventListener("click", async function () {'));
  assert.ok(listen >= 0, "place card click handler must exist");
  return balancedBlockFrom(source, source.indexOf("async function (event) {", listen));
}

function productCardClickHandlerSource(source) {
  const marker = source.indexOf('event.target.closest("[data-rank-filter-status]")');
  const listen = source.lastIndexOf('card.addEventListener("click", async function (event) {', marker);
  assert.ok(marker >= 0 && listen >= 0, "N30 card click handler must exist");
  return balancedBlockFrom(source, source.indexOf("async function (event) {", listen));
}

test("공용 선택 줄의 버튼은 N 30일과 플레이스 클릭 처리 모두에 있다(플레이스 '선택 해제' 무반응 재발 방지)", () => {
  for (const [label, source] of placePages) {
    const bulkBar = namedFunctionSource(source, "renderRankBulkBar");
    const controls = [...new Set([...bulkBar.matchAll(/<button\b[^>]*\s(data-rank-[a-z-]+)/g)].map((match) => match[1]))];
    assert.ok(controls.includes("data-rank-select-clear") && controls.length >= 5, `${label}: ${controls}`);
    for (const [kind, handler] of [["N30", productCardClickHandlerSource(source)], ["place", placeCardClickHandlerSource(source)]]) {
      for (const control of controls) {
        assert.ok(handler.includes(`closest("[${control}]")`), `${label} ${kind} click handler misses ${control}`);
      }
    }
  }
});

test("플레이스 '선택 해제'는 선택을 비우고 선택 줄·체크박스를 다시 그린다", () => {
  for (const [label, source] of placePages) {
    const handler = placeCardClickHandlerSource(source);
    assert.ok(handler.includes([
      '          var selectClearButton = event.target.closest("[data-rank-select-clear]");',
      "          if (selectClearButton) {",
      "            setRankSelectedSet(card, new Set());",
      "            renderPlaceHistory(placeHistory, placeTrackers);",
      "            return;",
      "          }",
    ].join("\n")), `${label}: place select-clear branch`);
  }
});

function cssRuleBodies(source, selector) {
  const bodies = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(selector, from);
    if (at < 0) return bodies;
    from = at + selector.length;
    const media = source.lastIndexOf("@media", at);
    let depth = 0;
    for (let index = source.indexOf("{", media); index < at; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
    }
    const open = source.indexOf("{", at);
    bodies.push({
      media: depth > 0 ? source.slice(media, source.indexOf("{", media)).trim() : "",
      body: source.slice(open + 1, source.indexOf("}", open)),
    });
  }
}

test("플레이스 선택 줄도 N 30일과 같은 좁은 화면 규칙을 받는다(901~1360px 감기 · 900px 이하 2칸)", () => {
  const expectations = [
    ["admin", adminSource, "#mi-admin", [
      ["@media (min-width: 901px) and (max-width: 1360px)", ["display: flex;", "flex-wrap: wrap;"]],
      ["@media (max-width: 900px)", ["grid-template-columns: repeat(2, minmax(0, 1fr));"]],
    ]],
    ["client", clientPageSource, "#mi-clean", [
      ["@media (max-width: 900px)", ["grid-template-columns: repeat(2, minmax(0, 1fr));"]],
    ]],
  ];
  for (const [label, source, rootId, rules] of expectations) {
    const placeRules = cssRuleBodies(source, `${rootId} [data-place-rank-card] .mi-rank-bulk-actions.mi-rank-bulk-actions`);
    const productRules = cssRuleBodies(source, `${rootId} [data-rank-card] .mi-rank-bulk-actions.mi-rank-bulk-actions`);
    assert.deepEqual(placeRules.map((rule) => rule.media), rules.map((rule) => rule[0]), `${label}: place bulk rules`);
    for (const [media, declarations] of rules) {
      const placeRule = placeRules.find((rule) => rule.media === media);
      // N 30일 규칙과 같은 선언 묶음(같은 규칙에 선택자만 더했다).
      assert.ok(productRules.some((rule) => rule.media === media && rule.body === placeRule.body), `${label} ${media}: same body as N30`);
      for (const declaration of declarations) assert.ok(placeRule.body.includes(declaration), `${label} ${media}: ${declaration}`);
    }
    // 900px 이하에서는 그룹 입력·이미지 저장이 한 줄 전체를 쓴다.
    const fullRow = cssRuleBodies(source, `${rootId} [data-place-rank-card] .mi-rank-bulk-actions .mi-rank-share-image`);
    assert.ok(fullRow.some((rule) => rule.media === "@media (max-width: 900px)" && rule.body.includes("grid-column: 1 / -1;")), `${label}: share image full row`);
  }
});

function placeRequestHarness(source) {
  const factory = new Function(`
    var calls = [];
    var placeRequestGeneration = 1;
    function verifiedRankTrackerScope() { return { key: "scope-a", role: "team", agencyCode: "a01" }; }
    function sameRankTrackerScope() { return true; }
    function canManageOwnerCodes() { return false; }
    function rankAgencyCode() { return "a01"; }
    function getPlaceRankTrackerApiUrl() { return "/api/naver-place-rank-trackers"; }
    async function miFetch(url, options) {
      calls.push({ method: options.method, timeoutMs: options.timeoutMs });
      return { ok: true, json: async function () { return { ok: true }; } };
    }
    ${asyncFunctionSource(source, "requestPlaceTrackers")}
    return { request: requestPlaceTrackers, calls: calls };
  `);
  return factory();
}

test("플레이스 등록(create)도 check·sync-due 와 같은 270초를 기다리고 나머지는 20초 그대로다", async () => {
  for (const [label, source] of placePages) {
    const harness = placeRequestHarness(source);
    await harness.request("POST", { action: "create", keyword: "k", placeUrl: "123456" });
    await harness.request("POST", { action: "check", id: "p" });
    await harness.request("POST", { action: "sync-due", limit: "1" });
    await harness.request("GET", null);
    await harness.request("PATCH", { action: "update-group", ids: ["p"] });
    assert.deepEqual(harness.calls.map((call) => call.timeoutMs), [270000, 270000, 270000, 20000, 20000], label);
  }
});

function placeRegisterHarness(source, options) {
  const factory = new Function("opts", `
    var placeTrackers = opts.initial.slice();
    var statuses = [];
    var loadCalls = [];
    var placeKeyword = { value: opts.keyword };
    var linkedKeywordInput = null;
    var placeUrl = { value: opts.url };
    var placeRun = { disabled: false };
    var placeStatus = {};
    var placeHistory = {};
    var RANK_DEFAULT_GROUP = "";
    function setStatus(node, message, tone) { statuses.push({ message: message, tone: tone, disabled: placeRun.disabled }); }
    function verifiedRankTrackerScope() { return { key: "scope-a" }; }
    function sameRankTrackerScope(scope) { return Boolean(scope) && opts.scopeStillSame(); }
    function scopedRankTrackerPayload(payload, scope) { return Boolean(payload && payload.ok === true && Array.isArray(payload.trackers) && scope); }
    function renderPlaceHistory() {}
    function upsertPlaceTracker(tracker) { placeTrackers = [tracker].concat(placeTrackers.filter(function (item) { return item.id !== tracker.id; })); }
    var requestCalls = [];
    async function requestPlaceTrackers(method, body, scope) {
      requestCalls.push(method);
      if (method === "GET") return opts.listed ? opts.listed() : { ok: false };
      return opts.request(method, body);
    }
    async function loadPlaceTrackers() {
      loadCalls.push(Array.from(arguments));
      if (opts.reloaded) placeTrackers = opts.reloaded.slice();
      return Boolean(opts.reloaded);
    }
    ${namedFunctionSource(source, "findRegisteredPlaceTracker")}
    var handler = ${placeRunHandlerSource(source)};
    return { run: handler, statuses: statuses, loadCalls: loadCalls, requestCalls: requestCalls, placeRun: placeRun, trackers: function () { return placeTrackers; } };
  `);
  return factory(options);
}

const oldPlace = { id: "pl-1", keyword: "구월동 횟집", placeId: "1200000001", placeUrl: "https://map.naver.com/p/entry/place/1200000001" };
const newPlace = { id: "pl-new", keyword: "부평 갈비", placeId: "1299999999", placeUrl: "https://map.naver.com/p/entry/place/1299999999" };
const timeoutError = () => { throw new Error("API 요청 시간이 초과되었습니다."); };

test("플레이스 등록은 1~3분 안내를 띄우고, 시간 초과여도 검증된 목록에 방금 등록한 장소가 있으면 등록됐다고 알린다", async () => {
  for (const [label, source] of placePages) {
    const harness = placeRegisterHarness(source, {
      initial: [oldPlace], keyword: "부평 갈비", url: "https://map.naver.com/p/entry/place/1299999999",
      request: timeoutError, listed: () => ({ ok: true, trackers: [newPlace, oldPlace] }), scopeStillSame: () => true,
    });
    await harness.run();
    assert.deepEqual(harness.statuses[0], { message: "등록하고 첫 순위를 확인하는 중입니다. 1~3분 걸릴 수 있습니다.", tone: "", disabled: true }, label);
    assert.deepEqual(harness.statuses.at(-1), { message: "등록됐습니다. 첫 순위가 아직 안 보이면 잠시 뒤 새로고침해 주세요.", tone: "is-ok", disabled: true }, label);
    // 목록 불러오기(자동 갱신 포함)를 거치지 않고 목록을 한 번 직접 읽는다.
    assert.deepEqual(harness.loadCalls, [], label);
    assert.deepEqual(harness.requestCalls, ["POST", "GET"], label);
    assert.equal(harness.trackers()[0].id, "pl-new", label);
    assert.equal(harness.placeRun.disabled, false, label);
  }
});

test("플레이스 등록 시간 초과 뒤 목록 읽기가 실패하거나 같은 장소가 등록 전부터 있었으면 등록됐다고 단정하지 않는다", async () => {
  for (const [label, source] of placePages) {
    const listFailed = placeRegisterHarness(source, {
      initial: [oldPlace], keyword: "부평 갈비", url: "https://map.naver.com/p/entry/place/1299999999",
      request: timeoutError, listed: () => ({ ok: false, message: "fail" }), scopeStillSame: () => true,
    });
    await listFailed.run();
    assert.deepEqual(listFailed.statuses.at(-1), { message: "플레이스 순위 서비스 연결을 확인해주세요.", tone: "is-warn", disabled: true }, label);

    const already = placeRegisterHarness(source, {
      initial: [newPlace, oldPlace], keyword: "부평 갈비", url: "https://map.naver.com/p/entry/place/1299999999",
      request: timeoutError, listed: () => ({ ok: true, trackers: [newPlace, oldPlace] }), scopeStillSame: () => true,
    });
    await already.run();
    assert.deepEqual(already.statuses.at(-1), { message: "플레이스 순위 서비스 연결을 확인해주세요.", tone: "is-warn", disabled: true }, label);
  }
});

test("플레이스 등록 시간 초과 뒤 목록에 없거나 광고주 범위가 바뀌었으면 연결 확인 안내 그대로다", async () => {
  for (const [label, source] of placePages) {
    const missing = placeRegisterHarness(source, {
      initial: [oldPlace], keyword: "부평 갈비", url: "https://map.naver.com/p/entry/place/1299999999",
      request: timeoutError, listed: () => ({ ok: true, trackers: [oldPlace] }), scopeStillSame: () => true,
    });
    await missing.run();
    assert.deepEqual(missing.statuses.at(-1), { message: "플레이스 순위 서비스 연결을 확인해주세요.", tone: "is-warn", disabled: true }, label);
    assert.deepEqual(missing.requestCalls, ["POST", "GET"], label);

    const scopeChanged = placeRegisterHarness(source, {
      initial: [oldPlace], keyword: "부평 갈비", url: "https://map.naver.com/p/entry/place/1299999999",
      request: () => { throw new Error("요청 중 광고주 조회 범위가 변경되었습니다."); }, listed: () => ({ ok: true, trackers: [newPlace, oldPlace] }), scopeStillSame: () => false,
    });
    await scopeChanged.run();
    assert.deepEqual(scopeChanged.statuses.at(-1), { message: "플레이스 순위 서비스 연결을 확인해주세요.", tone: "is-warn", disabled: true }, label);
    assert.deepEqual(scopeChanged.requestCalls, ["POST"], label);
    assert.equal(scopeChanged.placeRun.disabled, false, label);
  }
});

test("플레이스 등록 성공 응답은 예전처럼 서버 문구를 보이고 목록을 새로 부른다", async () => {
  for (const [label, source] of placePages) {
    const harness = placeRegisterHarness(source, {
      initial: [oldPlace], keyword: "부평 갈비", url: "1299999999",
      request: async () => ({ ok: true, message: "플레이스 30일 순위 등록 완료", tracker: newPlace }), reloaded: [newPlace, oldPlace], scopeStillSame: () => true,
    });
    await harness.run();
    assert.deepEqual(harness.statuses.at(-1), { message: "플레이스 30일 순위 등록 완료", tone: "is-ok", disabled: true }, label);
    assert.deepEqual(harness.loadCalls, [[true, true]], label);
  }
});

test("방금 등록한 플레이스 찾기는 admin·client 가 같고 키워드·플레이스 번호로만 맞춘다", () => {
  assert.equal(namedFunctionSource(adminSource, "findRegisteredPlaceTracker"), namedFunctionSource(clientPageSource, "findRegisteredPlaceTracker"));
  const find = new Function(`${namedFunctionSource(adminSource, "findRegisteredPlaceTracker")}; return findRegisteredPlaceTracker;`)();
  const known = new Set(["pl-1"]);
  const shortLink = { id: "pl-short", keyword: "부평 갈비", placeId: "1288888888", placeUrl: "https://map.naver.com/p/entry/place/1288888888" };
  // 주소·숫자 ID 에서 번호를 읽으면 번호가 같아야 한다.
  assert.equal(find([oldPlace, newPlace], " 부평 갈비 ", "https://map.naver.com/p/entry/place/1299999999?c=15", known), newPlace);
  assert.equal(find([oldPlace, newPlace], "부평 갈비", "1299999999", known), newPlace);
  assert.equal(find([oldPlace, newPlace], "부평 갈비", "https://m.place.naver.com/restaurant/1299999999/home", known), newPlace);
  assert.equal(find([oldPlace, shortLink], "부평 갈비", "1299999999", known), null);
  assert.equal(find([oldPlace, newPlace], "부평 맛집", "1299999999", known), null);
  // naver.me 짧은 주소는 번호를 알 수 없어 등록 전 목록에 없던 같은 키워드 항목만 인정한다.
  assert.equal(find([oldPlace, shortLink], "부평 갈비", "https://naver.me/AbCdEf", known), shortLink);
  assert.equal(find([oldPlace, shortLink], "부평 갈비", "https://naver.me/AbCdEf", new Set(["pl-1", "pl-short"])), null);
  // 번호가 같아도 등록 전부터 있던 항목이면 방금 등록한 것으로 보지 않는다.
  assert.equal(find([oldPlace, newPlace], "부평 갈비", "1299999999", new Set(["pl-1", "pl-new"])), null);
  assert.equal(find(null, "부평 갈비", "1299999999", known), null);
});

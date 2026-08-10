const NATIVE_HOST = "co.kr.momentinsight.naver_shopping";
const RUN_ALARMS = new Set(["rank-0900", "rank-1500", "rank-catch-up", "rank-remote"]);
const PRICE_COMPARE_SEARCH_PATH = "/search/all";
const PAGE_COUNT = 8;
const PAGE_TIMEOUT_MS = 45_000;
const INITIAL_REQUEST_DELAY_MS = 30_000;
const INITIAL_REQUEST_JITTER_MS = 15_000;
const PAGE_REQUEST_INTERVAL_MS = 45_000;
const PAGE_REQUEST_JITTER_MS = 30_000;
const CHROME_OPERATION_TIMEOUT_MS = 45_000;
const NATIVE_HOST_START_TIMEOUT_MS = 30_000;
const NATIVE_HOST_RUN_TIMEOUT_MS = 20 * 60_000;
const VERIFICATION_COOLDOWN_MS = 60 * 60_000;
const VERIFICATION_BLOCKED_UNTIL_KEY = "momentInsightRankBlockedUntil";
const VERIFICATION_TAB_ID_KEY = "momentInsightRankVerificationTabId";
const MANUAL_RESUME_REQUIRED_KEY = "momentInsightRankManualResumeRequired";
const NETWORK_RETRY_COUNT_KEY = "momentInsightRankNetworkRetryCount";
const NETWORK_RESTRICTION_RETRY_DELAYS_MS = [
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
];
const NAVER_ACCESS_COOLDOWN_CODES = new Set([
  "naver_verification_required",
  "naver_captcha_detected",
]);
const NAVER_MANUAL_RESUME_CODES = new Set([
  "naver_network_restricted",
  "naver_http_418",
  "naver_http_429",
]);
let running = false;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, milliseconds, code) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(code)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function pageRequestDelay() {
  return PAGE_REQUEST_INTERVAL_MS + Math.floor(Math.random() * (PAGE_REQUEST_JITTER_MS + 1));
}

function initialRequestDelay() {
  return INITIAL_REQUEST_DELAY_MS + Math.floor(Math.random() * (INITIAL_REQUEST_JITTER_MS + 1));
}

async function verificationState() {
  const stored = await chrome.storage.local.get([
    VERIFICATION_BLOCKED_UNTIL_KEY,
    VERIFICATION_TAB_ID_KEY,
    MANUAL_RESUME_REQUIRED_KEY,
    NETWORK_RETRY_COUNT_KEY,
  ]);
  return {
    blockedUntil: Number(stored[VERIFICATION_BLOCKED_UNTIL_KEY] || 0),
    tabId: Number(stored[VERIFICATION_TAB_ID_KEY] || 0),
    manualResumeRequired: stored[MANUAL_RESUME_REQUIRED_KEY] === true,
    networkRetryCount: Math.max(0, Number(stored[NETWORK_RETRY_COUNT_KEY] || 0)),
  };
}

function networkRestrictionRetryDelay(attempt) {
  const index = Math.min(
    NETWORK_RESTRICTION_RETRY_DELAYS_MS.length - 1,
    Math.max(0, Number(attempt || 1) - 1),
  );
  return NETWORK_RESTRICTION_RETRY_DELAYS_MS[index];
}

async function scheduleNetworkRestrictionRetry({ tabId = 0 } = {}) {
  const current = await verificationState();
  const resolvedTabId = Number(tabId || current.tabId || 0);
  if (current.manualResumeRequired && current.blockedUntil > Date.now()) {
    if (resolvedTabId && resolvedTabId !== current.tabId) {
      await chrome.storage.local.set({ [VERIFICATION_TAB_ID_KEY]: resolvedTabId });
    }
    return { ...current, tabId: resolvedTabId || current.tabId };
  }
  const networkRetryCount = current.networkRetryCount + 1;
  const blockedUntil = Date.now() + networkRestrictionRetryDelay(networkRetryCount);
  await chrome.storage.local.set({
    [VERIFICATION_BLOCKED_UNTIL_KEY]: blockedUntil,
    [MANUAL_RESUME_REQUIRED_KEY]: true,
    [NETWORK_RETRY_COUNT_KEY]: networkRetryCount,
    ...(resolvedTabId ? { [VERIFICATION_TAB_ID_KEY]: resolvedTabId } : {}),
  });
  return {
    blockedUntil,
    tabId: resolvedTabId,
    manualResumeRequired: true,
    networkRetryCount,
  };
}

async function surfaceVerificationTab(tabId) {
  const current = await verificationState();
  if (current.tabId && current.tabId !== tabId) {
    await chrome.tabs.remove(current.tabId).catch(() => {});
  }
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await chrome.storage.local.set({
    [VERIFICATION_BLOCKED_UNTIL_KEY]: Date.now() + VERIFICATION_COOLDOWN_MS,
    [VERIFICATION_TAB_ID_KEY]: tabId,
  });
  return tabId;
}

async function surfaceNetworkRestrictionTab(tabId) {
  const current = await verificationState();
  if (current.tabId && current.tabId !== tabId) {
    await chrome.tabs.remove(current.tabId).catch(() => {});
  }
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await scheduleNetworkRestrictionRetry({ tabId });
  return tabId;
}

async function clearVerificationState({ closeTab = true, preserveNetworkRetryCount = false } = {}) {
  const current = await verificationState();
  const keys = [
    VERIFICATION_BLOCKED_UNTIL_KEY,
    VERIFICATION_TAB_ID_KEY,
    MANUAL_RESUME_REQUIRED_KEY,
  ];
  if (!preserveNetworkRetryCount) keys.push(NETWORK_RETRY_COUNT_KEY);
  await chrome.storage.local.remove(keys);
  if (closeTab && current.tabId) await chrome.tabs.remove(current.tabId).catch(() => {});
  return current.tabId || null;
}

async function inspectNaverTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!String(tab?.url || "").startsWith("https://search.shopping.naver.com/")) {
      return { status: "unknown" };
    }
    const results = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const bodyText = String(document.body?.innerText || "").slice(0, 20_000);
        return {
          networkRestricted: /쇼핑 서비스 접속이 일시적으로 제한|해당 네트워크의 접속을 일시적으로 제한|네트워크의 접속을 일시적으로 제한/iu.test(bodyText),
          blocked: /보안 확인|자동입력 방지|비정상적인 접근|captcha|로봇이 아닙니다/iu.test(bodyText),
          priceCompareReady: location.pathname === "/search/all"
            && Boolean(document.getElementById("__NEXT_DATA__")?.textContent),
          route: location.pathname === "/search/all" ? "price_compare" : "other",
          url: location.href,
        };
      },
    }), CHROME_OPERATION_TIMEOUT_MS, "naver_inspection_timeout");
    const value = results?.[0]?.result || {};
    if (value.networkRestricted) return { status: "network_restricted", route: value.route || "unknown" };
    if (value.blocked) return { status: "blocked", route: value.route || "unknown" };
    if (value.priceCompareReady && String(value.url || "").startsWith("https://search.shopping.naver.com/search/all")) {
      return { status: "resolved", route: "price_compare" };
    }
    return { status: "unknown", route: value.route || "unknown" };
  } catch {
    return { status: "missing" };
  }
}

async function findResolvedNaverTab() {
  const tabs = await chrome.tabs.query({ url: "https://search.shopping.naver.com/*" });
  for (const tab of tabs) {
    if (!tab?.id) continue;
    // Existing tabs are inspected only; this never navigates or reloads Naver.
    // eslint-disable-next-line no-await-in-loop
    const state = await inspectNaverTab(tab.id);
    if (state.status === "resolved") return tab.id;
  }
  return null;
}

async function prepareVerificationState(trigger, verification) {
  if (verification.tabId) {
    const tabState = await inspectNaverTab(verification.tabId);
    if (tabState.status === "network_restricted") {
      if (trigger === "manual") {
        await chrome.tabs.update(verification.tabId, { active: true }).catch(() => {});
      }
      if (verification.manualResumeRequired && verification.blockedUntil > 0
        && verification.blockedUntil <= Date.now()) {
        await clearVerificationState({ closeTab: true, preserveNetworkRetryCount: true });
        return { code: "", reusableTabId: null, recovered: true };
      }
      const retry = await scheduleNetworkRestrictionRetry({ tabId: verification.tabId });
      await saveNetworkRestrictionStatus(retry);
      return { code: "naver_network_retry_wait", reusableTabId: null };
    }
    if (tabState.status === "resolved") {
      const reusableTabId = await clearVerificationState({
        closeTab: false,
        preserveNetworkRetryCount: true,
      });
      return { code: "", reusableTabId, recovered: true };
    }
    if (tabState.status === "blocked" || tabState.status === "unknown") {
      if (trigger === "manual") {
        await chrome.tabs.update(verification.tabId, { active: true }).catch(() => {});
      }
      await saveStatus("verification", "naver_verification_required");
      return { code: "naver_verification_required", reusableTabId: null };
    }
    await chrome.storage.local.remove(VERIFICATION_TAB_ID_KEY);
  }
  if (verification.manualResumeRequired) {
    if (trigger === "manual") {
      const reusableTabId = await findResolvedNaverTab();
      if (reusableTabId) {
        await clearVerificationState({ closeTab: false, preserveNetworkRetryCount: true });
        return { code: "", reusableTabId, recovered: true };
      }
    }
    if (verification.blockedUntil > 0 && verification.blockedUntil <= Date.now()) {
      await clearVerificationState({ closeTab: true, preserveNetworkRetryCount: true });
      return { code: "", reusableTabId: null, recovered: true };
    }
    const retry = await scheduleNetworkRestrictionRetry();
    await saveNetworkRestrictionStatus(retry);
    return { code: "naver_network_retry_wait", reusableTabId: null };
  }
  if (verification.blockedUntil > Date.now()) {
    await saveStatus("verification", "naver_verification_cooldown");
    return { code: "naver_verification_cooldown", reusableTabId: null };
  }
  if (verification.blockedUntil > 0) {
    await clearVerificationState({ closeTab: true, preserveNetworkRetryCount: true });
    return { code: "", reusableTabId: null, recovered: true };
  }
  return { code: "", reusableTabId: null };
}

function nextKstHour(hour) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  let when = Date.parse(`${values.year}-${values.month}-${values.day}T${String(hour).padStart(2, "0")}:00:00+09:00`);
  if (when <= Date.now()) when += 24 * 60 * 60_000;
  return when;
}

async function configureAlarms() {
  const alarmDefinitions = [
    ["rank-0900", { when: nextKstHour(9), periodInMinutes: 1440 }],
    ["rank-1500", { when: nextKstHour(15), periodInMinutes: 1440 }],
    ["rank-catch-up", { delayInMinutes: 20, periodInMinutes: 20 }],
    ["rank-remote", { delayInMinutes: 1, periodInMinutes: 1 }],
  ];
  await Promise.all(alarmDefinitions.map(async ([name, definition]) => {
    const existing = await chrome.alarms.get(name);
    if (!existing || Number(existing.periodInMinutes || 0) !== Number(definition.periodInMinutes || 0)) {
      await chrome.alarms.create(name, definition);
    }
  }));
}

function searchUrl(keyword, pageIndex) {
  const url = new URL(`https://search.shopping.naver.com${PRICE_COMPARE_SEARCH_PATH}`);
  url.searchParams.set("where", "all");
  url.searchParams.set("frm", "NVSCTAB");
  url.searchParams.set("query", keyword);
  url.searchParams.set("pagingIndex", String(pageIndex));
  url.searchParams.set("pagingSize", "40");
  url.searchParams.set("productSet", "total");
  url.searchParams.set("sort", "rel");
  url.searchParams.set("viewType", "list");
  return url.toString();
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(error, tab) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve(tab);
    }
    const timeout = setTimeout(() => {
      finish(new Error("naver_page_timeout"));
    }, PAGE_TIMEOUT_MS);
    function listener(updatedId, changeInfo, tab) {
      if (updatedId !== tabId || changeInfo.status !== "complete") return;
      finish(null, tab);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish(null, tab);
    }).catch((error) => finish(error));
  });
}

async function readPriceComparePage(tabId, keyword, pageIndex) {
  const results = await withTimeout(chrome.scripting.executeScript({
    target: { tabId },
    func: (expectedKeyword) => {
      const bodyText = String(document.body?.innerText || "").slice(0, 20_000);
      const networkRestricted = /쇼핑 서비스 접속이 일시적으로 제한|해당 네트워크의 접속을 일시적으로 제한|네트워크의 접속을 일시적으로 제한/iu.test(bodyText);
      const blocked = /보안 확인|자동입력 방지|비정상적인 접근|captcha|로봇이 아닙니다/iu.test(bodyText);
      const url = new URL(location.href);
      return {
        networkRestricted,
        blocked,
        nextDataText: document.getElementById("__NEXT_DATA__")?.textContent || "",
        keyword: url.searchParams.get("query") || "",
        path: url.pathname,
        pageIndex: Number(url.searchParams.get("pagingIndex") || 1),
        title: document.title,
        url: url.toString(),
      };
    },
    args: [keyword],
  }), CHROME_OPERATION_TIMEOUT_MS, "naver_page_script_timeout");
  const value = results?.[0]?.result || {};
  if (value.networkRestricted) throw new Error("naver_network_restricted");
  if (value.blocked) throw new Error("naver_verification_required");
  if (value.path !== PRICE_COMPARE_SEARCH_PATH
    || String(value.keyword || "").trim() !== String(keyword || "").trim()
    || Number(value.pageIndex) !== Number(pageIndex)) {
    throw new Error("naver_navigation_invalid");
  }
  if (!value.nextDataText) throw new Error("naver_next_data_missing");
  return value.nextDataText;
}

async function collectPriceComparePages(request, initialTabId = null, options = {}) {
  if (!request || request.limit !== 300 || request.rankPolicy !== "organic_only") {
    throw new Error("native_request_invalid");
  }
  const activateTab = options.activateTab === true;
  const pages = [];
  let tabId = initialTabId;
  try {
    if (activateTab && tabId != null) {
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    }
    await wait(initialRequestDelay());
    for (let pageIndex = 1; pageIndex <= PAGE_COUNT; pageIndex += 1) {
      const url = searchUrl(request.keyword, pageIndex);
      if (tabId == null) {
        const tab = await chrome.tabs.create({ url, active: activateTab });
        tabId = tab.id;
      } else {
        const currentTab = await chrome.tabs.get(tabId);
        const update = {
          ...(currentTab.url !== url || currentTab.status !== "complete" ? { url } : {}),
          ...(activateTab ? { active: true } : {}),
        };
        if (Object.keys(update).length) {
          await chrome.tabs.update(tabId, update);
        }
      }
      await waitForTabComplete(tabId);
      pages.push({
        pageIndex,
        nextDataText: await readPriceComparePage(tabId, request.keyword, pageIndex),
      });
      if (pageIndex < PAGE_COUNT) await wait(pageRequestDelay());
    }
    return { pages, tabId };
  } catch (error) {
    if (String(error?.message || "") === "naver_network_restricted" && tabId != null) {
      tabId = await surfaceNetworkRestrictionTab(tabId);
      error.keepTabOpen = true;
      error.tabId = tabId;
    } else if (String(error?.message || "") === "naver_verification_required" && tabId != null) {
      tabId = await surfaceVerificationTab(tabId);
      error.keepTabOpen = true;
      error.tabId = tabId;
    }
    if (tabId != null && !error.tabId) error.tabId = tabId;
    throw error;
  }
}

async function saveStatus(status, detail = "", metadata = {}) {
  await chrome.storage.local.set({
    momentInsightRankStatus: {
      status,
      detail,
      updatedAt: new Date().toISOString(),
      ...metadata,
    },
  });
}

async function saveNetworkRestrictionStatus(retry) {
  await saveStatus("verification", "naver_network_retry_wait", {
    retryAt: new Date(retry.blockedUntil).toISOString(),
    retryAttempt: retry.networkRetryCount,
  });
}

function nativeDisconnectCode(lastErrorMessage) {
  const message = String(lastErrorMessage || "").trim().toLowerCase();
  if (message.includes("host not found") || message.includes("호스트를 찾을 수 없")) {
    return "native_host_not_found";
  }
  if (message.includes("host is forbidden")
    || message.includes("access to the specified")
    || message.includes("호스트에 대한 액세스")
    || message.includes("호스트가 허용되지")) {
    return "native_host_origin_not_allowed";
  }
  if (message.includes("host has exited") || message.includes("호스트가 종료")) {
    return "native_host_exited";
  }
  if (message.includes("communicating with the native messaging host")
    || message.includes("네이티브 메시징 호스트와 통신")) {
    return "native_host_communication_failed";
  }
  return message ? "native_host_disconnected" : "native_host_closed";
}

async function runWorker(trigger = "manual") {
  if (running) return { ok: false, code: "already_running" };
  running = true;
  let port = null;
  let collectionTabId = null;
  let keepCollectionTabOpen = false;
  try {
    const verification = await verificationState();
    const verificationPreparation = await prepareVerificationState(trigger, verification);
    if (verificationPreparation.code) {
      await saveStatus("verification", verificationPreparation.code);
      return { ok: false, code: verificationPreparation.code };
    }
    const workerTrigger = verificationPreparation.recovered ? "rank-recovery" : trigger;
    await saveStatus("running", workerTrigger);
    port = chrome.runtime.connectNative(NATIVE_HOST);
    collectionTabId = verificationPreparation.reusableTabId;
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      let receivedNativeMessage = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(startTimeout);
        clearTimeout(runTimeout);
        if (error) reject(error);
        else resolve(value);
      }
      const startTimeout = setTimeout(
        () => finish(new Error("native_host_start_timeout")),
        NATIVE_HOST_START_TIMEOUT_MS,
      );
      const runTimeout = setTimeout(
        () => finish(new Error("native_host_timeout")),
        NATIVE_HOST_RUN_TIMEOUT_MS,
      );
      port.onMessage.addListener(async (message) => {
        if (!receivedNativeMessage) {
          receivedNativeMessage = true;
          clearTimeout(startTimeout);
        }
        try {
          if (message?.type === "collect") {
            try {
              const collection = await collectPriceComparePages(message.request, collectionTabId, {
                activateTab: trigger === "manual",
              });
              collectionTabId = collection.tabId;
              port.postMessage({
                type: "collection",
                requestId: message.requestId,
                pages: collection.pages,
              });
            } catch (error) {
              if (error?.tabId) collectionTabId = error.tabId;
              if (error?.keepTabOpen) {
                keepCollectionTabOpen = true;
              }
              port.postMessage({
                type: "collection_error",
                requestId: message.requestId,
                code: String(error?.message || "collection_failed"),
              });
            }
            return;
          }
          if (message?.type === "summary") {
            finish(null, message.summary || {});
          } else if (message?.type === "error") {
            finish(new Error(String(message.code || "native_host_failed")));
          }
        } catch (error) {
          finish(error);
        }
      });
      port.onDisconnect.addListener(() => {
        if (!settled) {
          finish(new Error(nativeDisconnectCode(chrome.runtime.lastError?.message)));
        }
      });
      port.postMessage({ action: "run", trigger: workerTrigger });
    });
    const submitted = Math.max(0, Number(result.submitted || 0));
    if (result.status === "standby"
      || (result.status === "idle" && result.remoteWake === false)) {
      if (result.status === "standby") {
        await saveStatus("standby", "윈도우 작업기가 정상 작동 중이라 대기합니다.");
      }
      return { ok: true, idle: true, summary: result };
    }
    const queuedTotal = Math.max(0, Number(result.queuedTotal || 0));
    const failed = Math.max(0, Number(result.failed || 0) + Number(result.releaseFailed || 0));
    const haltedCode = String(result.haltedCode || "");
    if (NAVER_MANUAL_RESUME_CODES.has(haltedCode)) {
      const retry = await scheduleNetworkRestrictionRetry({ tabId: collectionTabId || 0 });
      await saveNetworkRestrictionStatus(retry);
      return { ok: false, partial: submitted > 0, code: haltedCode, summary: result };
    }
    if (NAVER_ACCESS_COOLDOWN_CODES.has(haltedCode)) {
      await chrome.storage.local.set({
        [VERIFICATION_BLOCKED_UNTIL_KEY]: Date.now() + VERIFICATION_COOLDOWN_MS,
      });
      await saveStatus("verification", haltedCode);
      return { ok: false, partial: submitted > 0, code: haltedCode, summary: result };
    }
    const completedDetail = queuedTotal > 0
      ? `전체 ${queuedTotal}개 등록 · 이번 회차 ${submitted}개 갱신`
      : `갱신 ${submitted}건`;
    await chrome.storage.local.remove(NETWORK_RETRY_COUNT_KEY);
    await saveStatus(failed > 0 ? "partial" : "completed", failed > 0
      ? `${completedDetail} · 재시도 ${failed}건`
      : completedDetail);
    return { ok: failed === 0, partial: failed > 0, summary: result };
  } catch (error) {
    await saveStatus("failed", String(error?.message || "worker_failed"));
    return { ok: false, code: String(error?.message || "worker_failed") };
  } finally {
    running = false;
    if (port) port.disconnect();
    if (collectionTabId != null && !keepCollectionTabOpen) {
      await chrome.tabs.remove(collectionTabId).catch(() => {});
    }
  }
}

chrome.runtime.onInstalled.addListener(() => configureAlarms());
chrome.runtime.onStartup.addListener(() => configureAlarms());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (RUN_ALARMS.has(alarm.name)) runWorker(alarm.name);
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "run-now") {
    if (running) {
      sendResponse({ ok: false, code: "already_running" });
      return false;
    }
    void runWorker("manual");
    sendResponse({ ok: true, started: true });
    return false;
  }
  if (message?.action === "status") {
    chrome.storage.local.get("momentInsightRankStatus").then((stored) => {
      sendResponse(stored.momentInsightRankStatus || { status: "ready", detail: "" });
    });
    return true;
  }
  return false;
});
configureAlarms();

const NATIVE_HOST = "co.kr.momentinsight.naver_shopping";
const RUN_ALARMS = new Set(["rank-0900", "rank-1500", "rank-catch-up"]);
const NPLUS_SEARCH_PATH = "/ns/search";
const COLLECTION_TIMEOUT_MS = 120_000;
const PAGE_REQUEST_INTERVAL_MS = 3_500;
const PAGE_REQUEST_JITTER_MS = 2_500;
const VIRTUAL_SCROLL_STEP_PX = 1_600;
const VIRTUAL_SCROLL_SETTLE_MS = 350;
const MAX_STABLE_LOAD_ROUNDS = 3;
const VERIFICATION_COOLDOWN_MS = 60 * 60_000;
const VERIFICATION_BLOCKED_UNTIL_KEY = "momentInsightRankBlockedUntil";
const VERIFICATION_TAB_ID_KEY = "momentInsightRankVerificationTabId";
const MANUAL_RESUME_REQUIRED_KEY = "momentInsightRankManualResumeRequired";
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

function pageRequestDelay() {
  return PAGE_REQUEST_INTERVAL_MS + Math.floor(Math.random() * (PAGE_REQUEST_JITTER_MS + 1));
}

async function verificationState() {
  const stored = await chrome.storage.local.get([
    VERIFICATION_BLOCKED_UNTIL_KEY,
    VERIFICATION_TAB_ID_KEY,
    MANUAL_RESUME_REQUIRED_KEY,
  ]);
  return {
    blockedUntil: Number(stored[VERIFICATION_BLOCKED_UNTIL_KEY] || 0),
    tabId: Number(stored[VERIFICATION_TAB_ID_KEY] || 0),
    manualResumeRequired: stored[MANUAL_RESUME_REQUIRED_KEY] === true,
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
  await chrome.storage.local.set({
    [VERIFICATION_BLOCKED_UNTIL_KEY]: 0,
    [VERIFICATION_TAB_ID_KEY]: tabId,
    [MANUAL_RESUME_REQUIRED_KEY]: true,
  });
  return tabId;
}

async function clearVerificationState({ closeTab = true } = {}) {
  const current = await verificationState();
  await chrome.storage.local.remove([
    VERIFICATION_BLOCKED_UNTIL_KEY,
    VERIFICATION_TAB_ID_KEY,
    MANUAL_RESUME_REQUIRED_KEY,
  ]);
  if (closeTab && current.tabId) await chrome.tabs.remove(current.tabId).catch(() => {});
  return current.tabId || null;
}

async function inspectNaverTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!String(tab?.url || "").startsWith("https://search.shopping.naver.com/")) {
      return { status: "unknown" };
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const bodyText = String(document.body?.innerText || "").slice(0, 20_000);
        return {
          networkRestricted: /쇼핑 서비스 접속이 일시적으로 제한|해당 네트워크의 접속을 일시적으로 제한|네트워크의 접속을 일시적으로 제한/iu.test(bodyText),
          blocked: /보안 확인|자동입력 방지|비정상적인 접근|captcha|로봇이 아닙니다/iu.test(bodyText),
          nplusReady: location.pathname === "/ns/search"
            && Boolean(document.querySelector('a[class*="basicProductCard_link__"][data-shp-contents-rank]')),
          route: location.pathname === "/ns/search" ? "nplus" : "legacy",
          url: location.href,
        };
      },
    });
    const value = results?.[0]?.result || {};
    if (value.networkRestricted) return { status: "network_restricted", route: value.route || "unknown" };
    if (value.blocked) return { status: "blocked", route: value.route || "unknown" };
    if (value.nplusReady && String(value.url || "").startsWith("https://search.shopping.naver.com/ns/search")) {
      return { status: "resolved", route: "nplus" };
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
    if (tabState.route === "legacy") {
      await clearVerificationState({ closeTab: true });
      return { code: "", reusableTabId: await findResolvedNaverTab() };
    }
    if (tabState.status === "network_restricted") {
      if (trigger === "manual") {
        await chrome.tabs.update(verification.tabId, { active: true }).catch(() => {});
      }
      await chrome.storage.local.set({ [MANUAL_RESUME_REQUIRED_KEY]: true });
      await saveStatus("verification", "naver_network_restricted");
      return { code: "naver_network_restricted", reusableTabId: null };
    }
    if (tabState.status === "resolved") {
      if (verification.manualResumeRequired && trigger !== "manual") {
        await saveStatus("verification", "naver_manual_resume_required");
        return { code: "naver_manual_resume_required", reusableTabId: null };
      }
      const reusableTabId = await clearVerificationState({ closeTab: false });
      return { code: "", reusableTabId };
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
        await clearVerificationState({ closeTab: false });
        return { code: "", reusableTabId };
      }
    }
    await saveStatus("verification", "naver_manual_resume_required");
    return { code: "naver_manual_resume_required", reusableTabId: null };
  }
  if (trigger !== "manual" && verification.blockedUntil > Date.now()) {
    await saveStatus("verification", "naver_verification_cooldown");
    return { code: "naver_verification_cooldown", reusableTabId: null };
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
    ["rank-catch-up", { delayInMinutes: 10, periodInMinutes: 10 }],
  ];
  await Promise.all(alarmDefinitions.map(async ([name, definition]) => {
    const existing = await chrome.alarms.get(name);
    if (!existing || Number(existing.periodInMinutes || 0) !== Number(definition.periodInMinutes || 0)) {
      await chrome.alarms.create(name, definition);
    }
  }));
}

function searchUrl(keyword) {
  const url = new URL(`https://search.shopping.naver.com${NPLUS_SEARCH_PATH}`);
  url.searchParams.set("query", keyword);
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
    }, COLLECTION_TIMEOUT_MS);
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

async function readNplusViewport(tabId, keyword) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expectedKeyword) => {
      const bodyText = String(document.body?.innerText || "").slice(0, 20_000);
      const networkRestricted = /쇼핑 서비스 접속이 일시적으로 제한|해당 네트워크의 접속을 일시적으로 제한|네트워크의 접속을 일시적으로 제한/iu.test(bodyText);
      const blocked = /보안 확인|자동입력 방지|비정상적인 접근|captcha|로봇이 아닙니다/iu.test(bodyText);
      const url = new URL(location.href);
      const rows = [];
      const cards = Array.from(document.querySelectorAll('li[class*="compositeCardContainer_composite_card_container__"]'));
      for (const card of cards) {
        const anchor = card.querySelector('a[class*="basicProductCard_link__"][data-shp-contents-rank]');
        if (!anchor) continue;
        const rawRank = Number(anchor.getAttribute("data-shp-contents-rank"));
        if (!Number.isInteger(rawRank) || rawRank < 1) continue;
        const detailText = anchor.getAttribute("data-shp-contents-dtl") || "[]";
        let detail = {};
        try {
          const pairs = JSON.parse(detailText);
          if (Array.isArray(pairs)) {
            detail = Object.fromEntries(pairs
              .filter((pair) => pair && typeof pair.key === "string")
              .map((pair) => [pair.key, pair.value]));
          }
        } catch {
          detail = {};
        }
        const href = String(anchor.href || "");
        const contentGroup = String(anchor.getAttribute("data-shp-contents-grp") || "").toLowerCase();
        const contentType = String(anchor.getAttribute("data-shp-contents-type") || "");
        const explicitAdvertisement = Boolean(card.querySelector('[class*="advertisementTooltipButton_link__"]'));
        const isAd = contentGroup === "ad"
          || href.startsWith("https://ader.naver.com/")
          || explicitAdvertisement;
        const sellerProductId = String(detail.chnl_prod_no || href.match(/\/products\/([0-9]{5,})/iu)?.[1] || "");
        const productId = String(detail.nv_mid || anchor.getAttribute("data-shp-contents-id") || "");
        const catalogId = String(detail.ctlg_nv_mid || "");
        const title = String(detail.prod_nm
          || card.querySelector('[class*="productCardTitle_product_card_title__"]')?.textContent
          || "").trim();
        const mallName = String(card.querySelector('[class*="mallLink_mall_name__"]')?.textContent || "").trim();
        const image = String(card.querySelector("img[src]")?.src || "");
        const lowPrice = String(detail.price || card.querySelector('[class*="priceTag_price__"]')?.textContent || "").replace(/[^0-9]/gu, "");
        const actionUid = String(anchor.getAttribute("data-shp-action-uid") || "");
        const extractionKey = `nplus:${rawRank}:${actionUid || productId || sellerProductId || contentType}`;
        rows.push({
          extractionKey,
          rawRank,
          isAd,
          title,
          mallName,
          image,
          links: href ? [href] : [],
          payload: {
            productName: title,
            nvMid: productId,
            channelProductNo: sellerProductId,
            catalogId,
            linkedCatalogId: catalogId,
            productType: catalogId ? 3 : 2,
            mallName,
            imageUrl: image,
            lowPrice,
            contentType,
          },
        });
      }
      return {
        networkRestricted,
        blocked,
        rows,
        keyword: url.searchParams.get("query") || "",
        path: url.pathname,
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        title: document.title,
        url: url.toString(),
      };
    },
    args: [keyword],
  });
  const value = results?.[0]?.result || {};
  if (value.networkRestricted) throw new Error("naver_network_restricted");
  if (value.blocked) throw new Error("naver_verification_required");
  if (value.path !== NPLUS_SEARCH_PATH || String(value.keyword || "").trim() !== String(keyword || "").trim()) {
    throw new Error("naver_navigation_invalid");
  }
  if (!Array.isArray(value.rows)) throw new Error("naver_nplus_schema_drift");
  return value;
}

async function scrollNplusTab(tabId, y) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (nextY) => window.scrollTo(0, nextY),
    args: [y],
  });
}

function orderedCollectionRows(rowMap) {
  const rows = [...rowMap.values()].sort((left, right) => left.rawRank - right.rawRank);
  let organicCount = 0;
  const bounded = [];
  for (const row of rows) {
    bounded.push(row);
    if (!row.isAd) organicCount += 1;
    if (organicCount === 300) break;
  }
  return { rows: bounded, organicCount };
}

async function collectNplusRows(request, initialTabId = null) {
  if (!request || request.limit !== 300 || request.rankPolicy !== "organic_only") {
    throw new Error("native_request_invalid");
  }
  const rowMap = new Map();
  let tabId = initialTabId;
  try {
    const url = searchUrl(request.keyword);
    if (tabId == null) {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
    } else {
      const currentTab = await chrome.tabs.get(tabId);
      if (currentTab.url !== url || currentTab.status !== "complete") {
        await chrome.tabs.update(tabId, { url });
      }
    }
    await waitForTabComplete(tabId);
    await scrollNplusTab(tabId, 0);
    let stableLoadRounds = 0;
    let previousScrollHeight = 0;
    const deadlineAt = Math.min(Date.parse(request.deadlineAt || "") || Number.POSITIVE_INFINITY, Date.now() + COLLECTION_TIMEOUT_MS);
    while (Date.now() < deadlineAt) {
      const viewport = await readNplusViewport(tabId, request.keyword);
      for (const row of viewport.rows) rowMap.set(row.extractionKey, row);
      const ordered = orderedCollectionRows(rowMap);
      if (ordered.organicCount === 300) return { rows: ordered.rows, tabId };

      const nearBottom = viewport.scrollY + viewport.viewportHeight >= viewport.scrollHeight - VIRTUAL_SCROLL_STEP_PX;
      const nextY = Math.min(viewport.scrollY + VIRTUAL_SCROLL_STEP_PX, Math.max(0, viewport.scrollHeight - 500));
      await scrollNplusTab(tabId, nextY);
      if (nearBottom) {
        await wait(pageRequestDelay());
        const afterLoad = await readNplusViewport(tabId, request.keyword);
        for (const row of afterLoad.rows) rowMap.set(row.extractionKey, row);
        if (afterLoad.scrollHeight <= previousScrollHeight) stableLoadRounds += 1;
        else stableLoadRounds = 0;
        previousScrollHeight = Math.max(previousScrollHeight, afterLoad.scrollHeight);
        if (stableLoadRounds >= MAX_STABLE_LOAD_ROUNDS) break;
      } else {
        await wait(VIRTUAL_SCROLL_SETTLE_MS);
      }
    }
    const partial = orderedCollectionRows(rowMap);
    throw new Error(`provider_partial_window:${partial.organicCount}/300`);
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
    throw error;
  }
}

async function saveStatus(status, detail = "") {
  await chrome.storage.local.set({
    momentInsightRankStatus: {
      status,
      detail,
      updatedAt: new Date().toISOString(),
    },
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
  const verification = await verificationState();
  const verificationPreparation = await prepareVerificationState(trigger, verification);
  if (verificationPreparation.code) {
    return { ok: false, code: verificationPreparation.code };
  }
  running = true;
  await saveStatus("running", trigger);
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  let collectionTabId = verificationPreparation.reusableTabId;
  let keepCollectionTabOpen = false;
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      }
      const timeout = setTimeout(() => finish(new Error("native_host_timeout")), 20 * 60_000);
      port.onMessage.addListener(async (message) => {
        try {
          if (message?.type === "collect") {
            try {
              const collection = await collectNplusRows(message.request, collectionTabId);
              collectionTabId = collection.tabId;
              port.postMessage({
                type: "collection",
                requestId: message.requestId,
                rows: collection.rows,
              });
            } catch (error) {
              if (error?.keepTabOpen) {
                collectionTabId = error.tabId || collectionTabId;
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
      port.postMessage({ action: "run", trigger });
    });
    const submitted = Math.max(0, Number(result.submitted || 0));
    const queuedTotal = Math.max(0, Number(result.queuedTotal || 0));
    const failed = Math.max(0, Number(result.failed || 0) + Number(result.releaseFailed || 0));
    const haltedCode = String(result.haltedCode || "");
    if (NAVER_MANUAL_RESUME_CODES.has(haltedCode)) {
      await chrome.storage.local.set({
        [VERIFICATION_BLOCKED_UNTIL_KEY]: 0,
        [MANUAL_RESUME_REQUIRED_KEY]: true,
      });
      await saveStatus("verification", haltedCode);
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
    await saveStatus(failed > 0 ? "partial" : "completed", failed > 0
      ? `${completedDetail} · 재시도 ${failed}건`
      : completedDetail);
    return { ok: failed === 0, partial: failed > 0, summary: result };
  } catch (error) {
    await saveStatus("failed", String(error?.message || "worker_failed"));
    return { ok: false, code: String(error?.message || "worker_failed") };
  } finally {
    running = false;
    port.disconnect();
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
    runWorker("manual").then(sendResponse);
    return true;
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

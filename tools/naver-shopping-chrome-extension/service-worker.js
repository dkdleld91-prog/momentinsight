const NATIVE_HOST = "co.kr.momentinsight.naver_shopping";
const RUN_ALARMS = new Set(["rank-0900", "rank-1500", "rank-catch-up"]);
const PAGE_COUNT = 8;
const PAGE_TIMEOUT_MS = 30_000;
const PAGE_REQUEST_INTERVAL_MS = 3_500;
const PAGE_REQUEST_JITTER_MS = 2_500;
const VERIFICATION_COOLDOWN_MS = 60 * 60_000;
const VERIFICATION_BLOCKED_UNTIL_KEY = "momentInsightRankBlockedUntil";
const VERIFICATION_TAB_ID_KEY = "momentInsightRankVerificationTabId";
const NAVER_ACCESS_COOLDOWN_CODES = new Set([
  "naver_verification_required",
  "naver_captcha_detected",
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
  ]);
  return {
    blockedUntil: Number(stored[VERIFICATION_BLOCKED_UNTIL_KEY] || 0),
    tabId: Number(stored[VERIFICATION_TAB_ID_KEY] || 0),
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

async function clearVerificationState() {
  const current = await verificationState();
  await chrome.storage.local.remove([
    VERIFICATION_BLOCKED_UNTIL_KEY,
    VERIFICATION_TAB_ID_KEY,
  ]);
  if (current.tabId) await chrome.tabs.remove(current.tabId).catch(() => {});
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

function searchUrl(keyword, pageIndex) {
  const url = new URL("https://search.shopping.naver.com/search/all");
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

async function readNextData(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const bodyText = String(document.body?.innerText || "").slice(0, 20_000);
      const blocked = /보안 확인|자동입력 방지|비정상적인 접근|captcha|로봇이 아닙니다/iu.test(bodyText);
      return {
        blocked,
        nextDataText: document.getElementById("__NEXT_DATA__")?.textContent || "",
        title: document.title,
        url: location.href,
      };
    },
  });
  const value = results?.[0]?.result || {};
  if (value.blocked) throw new Error("naver_verification_required");
  if (!value.nextDataText) throw new Error("naver_next_data_missing");
  if (!String(value.url || "").startsWith("https://search.shopping.naver.com/")) {
    throw new Error("naver_navigation_invalid");
  }
  return value.nextDataText;
}

async function collectPages(request) {
  if (!request || request.limit !== 300 || request.rankPolicy !== "organic_only") {
    throw new Error("native_request_invalid");
  }
  const pages = [];
  let tabId = null;
  let keepTabOpen = false;
  try {
    for (let pageIndex = 1; pageIndex <= PAGE_COUNT; pageIndex += 1) {
      const url = searchUrl(request.keyword, pageIndex);
      if (tabId == null) {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
      } else {
        await chrome.tabs.update(tabId, { url, active: false });
      }
      await waitForTabComplete(tabId);
      pages.push({ pageIndex, nextDataText: await readNextData(tabId) });
      if (pageIndex < PAGE_COUNT) await wait(pageRequestDelay());
    }
    await clearVerificationState();
    return pages;
  } catch (error) {
    if (String(error?.message || "") === "naver_verification_required" && tabId != null) {
      tabId = await surfaceVerificationTab(tabId);
      keepTabOpen = true;
    }
    throw error;
  } finally {
    if (tabId != null && !keepTabOpen) await chrome.tabs.remove(tabId).catch(() => {});
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
  const automatic = trigger !== "manual";
  const verification = await verificationState();
  if (automatic && verification.blockedUntil > Date.now()) {
    await saveStatus("verification", "naver_verification_cooldown");
    return { ok: false, code: "naver_verification_cooldown" };
  }
  running = true;
  await saveStatus("running", trigger);
  const port = chrome.runtime.connectNative(NATIVE_HOST);
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
              const pages = await collectPages(message.request);
              port.postMessage({ type: "collection", requestId: message.requestId, pages });
            } catch (error) {
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
    const failed = Math.max(0, Number(result.failed || 0) + Number(result.releaseFailed || 0));
    const haltedCode = String(result.haltedCode || "");
    if (NAVER_ACCESS_COOLDOWN_CODES.has(haltedCode)) {
      await chrome.storage.local.set({
        [VERIFICATION_BLOCKED_UNTIL_KEY]: Date.now() + VERIFICATION_COOLDOWN_MS,
      });
      await saveStatus("verification", haltedCode);
      return { ok: false, partial: submitted > 0, code: haltedCode, summary: result };
    }
    await saveStatus(failed > 0 ? "partial" : "completed", failed > 0
      ? `갱신 ${submitted}건 · 재시도 ${failed}건`
      : `갱신 ${submitted}건`);
    return { ok: failed === 0, partial: failed > 0, summary: result };
  } catch (error) {
    await saveStatus("failed", String(error?.message || "worker_failed"));
    return { ok: false, code: String(error?.message || "worker_failed") };
  } finally {
    running = false;
    port.disconnect();
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

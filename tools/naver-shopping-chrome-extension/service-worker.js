const NATIVE_HOST = "co.kr.momentinsight.naver_shopping";
const RUN_ALARMS = new Set(["rank-0900", "rank-1500", "rank-catch-up", "rank-remote"]);
const PAGE_COUNT = 8;
const PAGE_TIMEOUT_MS = 45_000;
const PAGE_SCRIPT_TIMEOUT_MS = 15_000;
const COLLECTION_TIMEOUT_MS = 12 * 60_000;
const CONTROLLER_RESUME_TIMEOUT_MS = 15_000;
const RUNNING_STATUS_STALE_MS = 20 * 60_000;
const PAGE_REQUEST_INTERVAL_MS = 3_500;
const PAGE_REQUEST_JITTER_MS = 2_500;
const BASELINE_CADENCE_MINUTES = 10;
const CANDIDATE_CADENCE_MINUTES = 8;
const CADENCE_MINUTES_KEY = "momentInsightRankCadenceMinutes";
const VERIFICATION_COOLDOWN_MS = 60 * 60_000;
const VERIFICATION_BLOCKED_UNTIL_KEY = "momentInsightRankBlockedUntil";
const VERIFICATION_TAB_ID_KEY = "momentInsightRankVerificationTabId";
const EXTENSION_PAGE_CONTEXT = typeof document !== "undefined";
const CONTROLLER_PAGE_BASE_URL = new URL(chrome.runtime.getURL("popup.html"));
const CONTROLLER_PAGE_LOCATION = EXTENSION_PAGE_CONTEXT ? new URL(globalThis.location.href) : null;
const IS_CONTROLLER_PAGE = EXTENSION_PAGE_CONTEXT
  && CONTROLLER_PAGE_LOCATION.searchParams.get("controller") === "1"
  && Boolean(CONTROLLER_PAGE_LOCATION.searchParams.get("token"));
const CONTROLLER_TOKEN = IS_CONTROLLER_PAGE
  ? String(CONTROLLER_PAGE_LOCATION.searchParams.get("token") || "")
  : "";
const NAVER_ACCESS_COOLDOWN_CODES = new Set([
  "naver_verification_required",
  "naver_captcha_detected",
  "naver_http_418",
  "naver_http_429",
  "naver_network_restricted",
]);
const TYPED_COLLECTION_ERROR_PATTERN = /^(?:naver|provider|native_host)_[a-z0-9_:-]{2,79}$/u;
let running = false;
let controllerPromise = null;
let runtimeIdentityPromise = null;

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function extensionRuntimeIdentity() {
  if (!runtimeIdentityPromise) {
    runtimeIdentityPromise = (async () => {
      const runtimeVersion = String(chrome.runtime.getManifest().version || "");
      const response = await fetch(chrome.runtime.getURL("service-worker.js"), { cache: "no-store" });
      if (!response.ok) throw new Error("extension_runtime_identity_unavailable");
      const serviceWorkerSha256 = bytesToHex(await crypto.subtle.digest(
        "SHA-256",
        await response.arrayBuffer(),
      ));
      return { runtimeVersion, serviceWorkerSha256 };
    })();
  }
  return runtimeIdentityPromise;
}

function typedCollectionError(error, fallbackCode) {
  for (const value of [error?.code, error?.message]) {
    const code = String(value || "").trim().toLowerCase();
    if (TYPED_COLLECTION_ERROR_PATTERN.test(code)) return new Error(code);
  }
  const fallback = String(fallbackCode || "").trim().toLowerCase();
  return new Error(TYPED_COLLECTION_ERROR_PATTERN.test(fallback)
    ? fallback
    : "provider_browser_collection_failed");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, code) {
  return Promise.race([
    promise,
    wait(milliseconds).then(() => { throw new Error(code); }),
  ]);
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

async function safeCadenceMinutes(requested = null) {
  let value = requested;
  if (value == null) {
    const stored = await chrome.storage.local.get(CADENCE_MINUTES_KEY);
    value = stored[CADENCE_MINUTES_KEY];
  }
  const cadence = Number(value);
  return cadence === CANDIDATE_CADENCE_MINUTES ? cadence : BASELINE_CADENCE_MINUTES;
}

async function configureAlarms(requestedCadence = null) {
  const cadenceMinutes = await safeCadenceMinutes(requestedCadence);
  if (requestedCadence != null) {
    await chrome.storage.local.set({ [CADENCE_MINUTES_KEY]: cadenceMinutes });
  }
  const alarmDefinitions = [
    ["rank-0900", { when: nextKstHour(9), periodInMinutes: 1440 }],
    ["rank-1500", { when: nextKstHour(15), periodInMinutes: 1440 }],
    ["rank-catch-up", { delayInMinutes: cadenceMinutes, periodInMinutes: cadenceMinutes }],
    ["rank-remote", { delayInMinutes: 1, periodInMinutes: 1 }],
  ];
  await Promise.all(alarmDefinitions.map(async ([name, definition]) => {
    const existing = await chrome.alarms.get(name);
    if (!existing || Number(existing.periodInMinutes || 0) !== Number(definition.periodInMinutes || 0)) {
      await chrome.alarms.create(name, definition);
    }
  }));
}

async function ensureControllerTab() {
  if (controllerPromise) return controllerPromise;
  controllerPromise = (async () => {
    const tabs = await chrome.tabs.query({});
    let controller = tabs.find((tab) => {
      try {
        const url = new URL(tab.pendingUrl || tab.url || "");
        return url.protocol === CONTROLLER_PAGE_BASE_URL.protocol
          && url.host === CONTROLLER_PAGE_BASE_URL.host
          && url.pathname === CONTROLLER_PAGE_BASE_URL.pathname
          && url.searchParams.get("controller") === "1"
          && Boolean(url.searchParams.get("token"));
      } catch {
        return false;
      }
    }) || null;
    if (!controller) {
      const controllerUrl = new URL(CONTROLLER_PAGE_BASE_URL.toString());
      controllerUrl.searchParams.set("controller", "1");
      controllerUrl.searchParams.set("token", crypto.randomUUID());
      controller = await chrome.tabs.create({
        url: controllerUrl.toString(),
        active: false,
        pinned: true,
      });
    } else if (controller.discarded) {
      await chrome.tabs.reload(controller.id);
      controller = { ...controller, status: "loading" };
    }
    if (controller.status !== "complete") await waitForTabComplete(controller.id);
    await chrome.tabs.update(controller.id, {
      pinned: true,
      autoDiscardable: false,
    });
    return controller;
  })();
  try {
    return await controllerPromise;
  } finally {
    controllerPromise = null;
  }
}

async function automaticVerificationCooldownActive(trigger) {
  if (trigger === "manual") return false;
  const verification = await verificationState();
  return verification.blockedUntil > Date.now();
}

function waitForControllerResumed(tabId) {
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
      finish(new Error("rank_controller_resume_timeout"));
    }, CONTROLLER_RESUME_TIMEOUT_MS);
    function listener(updatedId, changeInfo, tab) {
      if (updatedId !== tabId) return;
      if (changeInfo.frozen === false || tab?.frozen !== true) finish(null, tab);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.frozen !== true) finish(null, tab);
    }).catch((error) => finish(error));
  });
}

async function prepareControllerForDispatch(controller) {
  const platform = await chrome.runtime.getPlatformInfo();
  if (platform.os === "win") {
    await chrome.windows.update(controller.windowId, { state: "normal" });
  }
  const current = await chrome.tabs.get(controller.id);
  const wasFrozen = current.frozen === true;
  let activated = await chrome.tabs.update(controller.id, {
    active: true,
    pinned: true,
    autoDiscardable: false,
  });
  if (!activated) activated = await chrome.tabs.get(controller.id);
  if (wasFrozen || activated?.frozen === true) {
    activated = await waitForControllerResumed(controller.id);
  }
  if (activated.status !== "complete") activated = await waitForTabComplete(controller.id);
  return activated;
}

async function requestControllerRun(trigger) {
  if (await automaticVerificationCooldownActive(trigger)) {
    await saveStatus("verification", "naver_verification_cooldown");
    return { ok: false, started: false, code: "naver_verification_cooldown" };
  }
  let controller = await ensureControllerTab();
  controller = await prepareControllerForDispatch(controller);
  const controllerToken = String(new URL(controller.pendingUrl || controller.url).searchParams.get("token") || "");
  if (!controllerToken) throw new Error("rank_controller_token_missing");
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "controller-run",
        target: controllerToken,
        trigger,
      });
      if (response?.accepted === true) {
        if (response.alreadyRunning === true) {
          return { ok: false, started: false, code: "already_running" };
        }
        return {
          ok: true,
          started: response.started === true,
        };
      }
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw lastError || new Error("rank_controller_unavailable");
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
  const results = await withTimeout(chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const bodyText = String(document.body?.innerText || "").slice(0, 20_000);
      const blocked = /보안 확인|자동입력 방지|비정상적인 접근|captcha|로봇이 아닙니다/iu.test(bodyText);
      const restricted = /쇼핑 서비스 접속이 일시적으로 제한|접속이 일시적으로 제한/iu.test(bodyText);
      return {
        blocked,
        restricted,
        nextDataText: document.getElementById("__NEXT_DATA__")?.textContent || "",
        title: document.title,
        url: location.href,
      };
    },
  }), PAGE_SCRIPT_TIMEOUT_MS, "naver_page_script_timeout");
  const value = results?.[0]?.result || {};
  if (value.restricted) throw new Error("naver_network_restricted");
  if (value.blocked) throw new Error("naver_verification_required");
  if (!value.nextDataText) throw new Error("naver_next_data_missing");
  if (!String(value.url || "").startsWith("https://search.shopping.naver.com/")) {
    throw new Error("naver_navigation_invalid");
  }
  return value.nextDataText;
}

async function saveCollectionProgress(pageIndex) {
  try {
    await saveStatus("running", `page ${pageIndex}/${PAGE_COUNT}`);
  } catch {
    // UI status storage is best-effort after the page was delivered.
  }
}

async function clearCompletedCollectionVerificationState() {
  try {
    await clearVerificationState();
  } catch {
    // UI verification cleanup must not discard a complete streamed window.
  }
}

async function collectPages(request, onPage = null) {
  if (!request || request.limit !== 300 || request.rankPolicy !== "organic_only") {
    throw new Error("native_request_invalid");
  }
  const pages = [];
  const deadline = Date.now() + COLLECTION_TIMEOUT_MS;
  const assertWithinDeadline = () => {
    if (Date.now() >= deadline) throw new Error("provider_deadline_exceeded");
  };
  let tabId = null;
  let keepTabOpen = false;
  let collectionStageCode = "naver_page_navigation_failed";
  try {
    for (let pageIndex = 1; pageIndex <= PAGE_COUNT; pageIndex += 1) {
      assertWithinDeadline();
      collectionStageCode = "naver_page_navigation_failed";
      const url = searchUrl(request.keyword, pageIndex);
      if (tabId == null) {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
      } else {
        await chrome.tabs.update(tabId, { url, active: false });
      }
      await waitForTabComplete(tabId);
      collectionStageCode = "naver_page_script_failed";
      const page = { pageIndex, nextDataText: await readNextData(tabId) };
      if (typeof onPage === "function") {
        collectionStageCode = "native_host_page_delivery_failed";
        await onPage(page);
      }
      else pages.push(page);
      collectionStageCode = "provider_browser_collection_failed";
      await saveCollectionProgress(pageIndex);
      if (pageIndex < PAGE_COUNT) {
        collectionStageCode = "naver_page_navigation_failed";
        await wait(pageRequestDelay());
        assertWithinDeadline();
      }
    }
    collectionStageCode = "provider_browser_collection_failed";
    await clearCompletedCollectionVerificationState();
    return pages;
  } catch (error) {
    const typedError = typedCollectionError(error, collectionStageCode);
    if (["naver_verification_required", "naver_network_restricted"].includes(typedError.message)
      && tabId != null) {
      keepTabOpen = true;
      try {
        tabId = await surfaceVerificationTab(tabId);
      } catch {
        // Preserve the original access code even if Chrome cannot persist the
        // local UI marker. The global worker lane still applies its cooldown.
      }
    }
    throw typedError;
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

async function saveControllerFailure() {
  try {
    await saveStatus("failed", "rank_controller_unavailable");
  } catch {
    // Chrome storage is the final user-visible reporting channel.
  }
}

async function loadVisibleStatus() {
  const stored = await chrome.storage.local.get("momentInsightRankStatus");
  const status = stored.momentInsightRankStatus || { status: "ready", detail: "" };
  const updatedAt = Date.parse(String(status.updatedAt || ""));
  if (status.status === "running"
    && Number.isFinite(updatedAt)
    && updatedAt + RUNNING_STATUS_STALE_MS <= Date.now()) {
    await saveStatus("failed", "native_host_interrupted");
    return {
      status: "failed",
      detail: "native_host_interrupted",
      updatedAt: new Date().toISOString(),
    };
  }
  return status;
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
  try {
    const automatic = trigger !== "manual";
    const verification = await verificationState();
    if (automatic && verification.blockedUntil > Date.now()) {
      await saveStatus("verification", "naver_verification_cooldown");
      return { ok: false, code: "naver_verification_cooldown" };
    }
    await saveStatus("running", trigger);
    port = chrome.runtime.connectNative(NATIVE_HOST);
    const runtimeIdentity = await extensionRuntimeIdentity();
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      }
      const timeout = setTimeout(() => finish(new Error("native_host_timeout")), 30 * 60_000);
      port.onMessage.addListener(async (message) => {
        try {
          if (message?.type === "ready") {
            port.postMessage({ action: "ready_ack" });
            return;
          }
          if (message?.type === "collect") {
            try {
              await collectPages(message.request, async (page) => {
                port.postMessage({ type: "collection_page", requestId: message.requestId, page });
              });
              port.postMessage({ type: "collection_complete", requestId: message.requestId });
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
      port.postMessage({ action: "run", trigger, ...runtimeIdentity });
    });
    const submitted = Math.max(0, Number(result.submitted || 0));
    if (Number.isFinite(Number(result.cadenceMinutes))) {
      await configureAlarms(Number(result.cadenceMinutes)).catch(() => {});
    }
    if (result.status === "already_running") {
      await saveStatus("standby", "기존 작업 종료 대기 중");
      return { ok: false, code: "native_host_already_running", summary: result };
    }
    if (result.status === "disabled") {
      await saveStatus("failed", "local_worker_disabled");
      return { ok: false, code: "local_worker_disabled", summary: result };
    }
    if (result.status === "standby" || (result.status === "idle" && result.remoteWake === false)) {
      await saveStatus("standby", "다음 갱신 요청 대기 중");
      return { ok: true, idle: true, summary: result };
    }
    const queuedTotal = Math.max(0, Number(result.queuedTotal || 0));
    const failed = Math.max(0, Number(result.failed || 0) + Number(result.releaseFailed || 0));
    const haltedCode = String(result.haltedCode || "");
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
    if (port) port.disconnect();
  }
}

if (IS_CONTROLLER_PAGE) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "controller-run" || message?.target !== CONTROLLER_TOKEN) return false;
    const alreadyRunning = running;
    if (!alreadyRunning) void runWorker(String(message.trigger || "manual"));
    sendResponse({
      accepted: true,
      started: !alreadyRunning,
      alreadyRunning,
    });
    return false;
  });
}

if (!EXTENSION_PAGE_CONTEXT) {
  chrome.runtime.onInstalled.addListener(() => {
    void configureAlarms();
    void ensureControllerTab().catch(() => saveControllerFailure());
  });
  chrome.runtime.onStartup.addListener(() => {
    void configureAlarms();
    void ensureControllerTab().catch(() => saveControllerFailure());
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (RUN_ALARMS.has(alarm.name)) {
      void requestControllerRun(alarm.name).catch(() => saveControllerFailure());
    }
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "run-now") {
      requestControllerRun("manual").then(sendResponse).catch((error) => {
        sendResponse({ ok: false, code: String(error?.message || "rank_controller_unavailable") });
      });
      return true;
    }
    if (message?.action === "status") {
      loadVisibleStatus().then(sendResponse).catch(() => {
        sendResponse({ status: "failed", detail: "rank_controller_unavailable" });
      });
      return true;
    }
    return false;
  });
  void configureAlarms();
}

const NATIVE_HOST = "co.kr.momentinsight.naver_shopping";
const COLLECTION_PROTOCOL = "range-v1";
const RUN_ALARMS = new Set(["rank-0900", "rank-1500", "rank-catch-up", "rank-remote"]);
const PAGE_COUNT = 8;
const PAGE_TIMEOUT_MS = 45_000;
const PAGE_SCRIPT_TIMEOUT_MS = 15_000;
const COLLECTION_TIMEOUT_MS = 12 * 60_000;
const WORKER_KEEPALIVE_INTERVAL_MS = 20_000;
const RUNNING_STATUS_STALE_MS = 20 * 60_000;
const PAGE_REQUEST_INTERVAL_MS = 3_500;
const PAGE_REQUEST_JITTER_MS = 2_500;
const BASELINE_CADENCE_MINUTES = 10;
const CANDIDATE_CADENCE_MINUTES = 6;
const CADENCE_MINUTES_KEY = "momentInsightRankCadenceMinutes";
const CADENCE_CONFIRMED_AT_KEY = "momentInsightRankCadenceConfirmedAt";
const CANDIDATE_CADENCE_CONFIRMATION_TTL_MS = 20 * 60_000;
const CANDIDATE_CADENCE_RESET_PENDING_KEY = "momentInsightRankCandidateResetPending";
const CANDIDATE_CADENCE_STABILITY_STARTED_AT_KEY = "momentInsightRankCandidateStabilityStartedAt";
const CANDIDATE_CADENCE_SUCCESS_COUNT_KEY = "momentInsightRankCandidateSuccessCount";
const CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY = "momentInsightRankCandidateProofRuntimeVersion";
const CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY = "momentInsightRankCandidateProofServiceWorkerSha256";
const CANDIDATE_CADENCE_REQUIRED_SUCCESSES = 6;
const CANDIDATE_CADENCE_STABILITY_MS = 24 * 60 * 60_000;
const CANDIDATE_CADENCE_RESET_PENDING_ALARM = "rank-candidate-reset-pending";
const CANDIDATE_CADENCE_RESET_PENDING_ALARM_MINUTES = 365 * 24 * 60;
const INITIALIZATION_SAFE_STATUSES = new Set(["completed", "standby", "ready"]);
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
// 1.1.34 (2026-09-29, Mac standby Profile 5): Chrome kept executing the service
// worker it registered on 09-19 (1.1.32) until 09-29 15:41 although the unpacked
// files and manifest on disk were 1.1.33 and Chrome had been restarted on 09-28.
// getManifest() and the fetched service-worker.js bytes both describe files, so
// only a literal compiled into the running script can tell. bump.py moves it
// with manifest.json; the release baseline pins the pair.
const SERVICE_WORKER_BUILD = "1.1.34";
const SERVICE_WORKER_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SERVICE_WORKER_RELOAD_KEY = "momentInsightServiceWorkerReload";
const SERVICE_WORKER_RELOAD_INTERVAL_MS = 30 * 60_000;
let serviceWorkerReloadInFlight = null;
let nativeRunPortOpen = false;
let candidateCadenceResetPendingMemory = null;
// The Node host flushes its terminal frame and closes input; the Windows
// launcher then releases its mutex immediately after child exit. Keep one
// finite scheduling gap before opening the coalesced follow-up connection.
const PENDING_TRIGGER_HANDOFF_MS = 6_000;
const RUN_TRIGGER_PRIORITY = Object.freeze({
  "rank-remote": 0,
  "rank-0900": 1,
  "rank-1500": 1,
  "rank-catch-up": 2,
  manual: 3,
});
const VERIFICATION_COOLDOWN_MS = 60 * 60_000;
const VERIFICATION_BLOCKED_UNTIL_KEY = "momentInsightRankBlockedUntil";
const VERIFICATION_TAB_ID_KEY = "momentInsightRankVerificationTabId";
// Session-scoped because Chrome window and tab ids die with the browser session.
const COLLECTION_WINDOW_ANCHOR_KEY = "momentInsightRankCollectionWindow";
const COLLECTION_WINDOW_MINIMIZE_ATTEMPTS = 4;
const COLLECTION_WINDOW_MINIMIZE_SETTLE_MS = 150;
const COLLECTION_TAB_PARK_COMMIT_CHECKS = 5;
const LEGACY_CONTROLLER_PAGE_URL = new URL(chrome.runtime.getURL("popup.html"));
const NAVER_ACCESS_COOLDOWN_CODES = new Set([
  "naver_verification_required",
  "naver_captcha_detected",
  "naver_http_403",
  "naver_access_blocked",
  "naver_http_418",
  "naver_http_429",
  "naver_network_restricted",
]);
const TYPED_COLLECTION_ERROR_PATTERN = /^(?:naver|provider|native_host)_[a-z0-9_:-]{2,79}$/u;

function selectPendingTrigger(currentTrigger, candidateTrigger) {
  const current = String(currentTrigger || "").trim();
  const candidate = String(candidateTrigger || "").trim();
  const currentKnown = Object.hasOwn(RUN_TRIGGER_PRIORITY, current);
  const candidateKnown = Object.hasOwn(RUN_TRIGGER_PRIORITY, candidate);
  if (!candidateKnown || candidate === "rank-remote") return currentKnown ? current : null;
  if (!currentKnown) return candidate;
  return RUN_TRIGGER_PRIORITY[candidate] > RUN_TRIGGER_PRIORITY[current] ? candidate : current;
}

let running = false;
let pendingTrigger = null;
let runtimeIdentityPromise = null;
let initializationPromise = Promise.resolve();

function queuePendingTrigger(trigger) {
  const candidate = String(trigger || "").trim();
  const queueable = candidate !== "rank-remote" && Object.hasOwn(RUN_TRIGGER_PRIORITY, candidate);
  pendingTrigger = selectPendingTrigger(pendingTrigger, candidate);
  return {
    queued: queueable && pendingTrigger !== null,
    pendingTrigger,
  };
}

function takePendingTrigger() {
  const trigger = pendingTrigger;
  pendingTrigger = null;
  return trigger;
}

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
      // 1.1.34: the build compiled into this running script. The native host
      // refuses a run whose build is missing or differs from runtimeVersion.
      return { runtimeVersion, serviceWorkerSha256, serviceWorkerBuild: SERVICE_WORKER_BUILD };
    })();
  }
  return runtimeIdentityPromise;
}

// 1.1.33 (2026-09-27 standby incident): Chrome rejected chrome.tabs.create with
// "No current window" and only the stage code reached the server. A short copy
// of the original Chrome text now rides beside the typed code: printable ASCII
// only, cut at the first URL or query marker so no keyword or address rides
// along, at most 120 characters. The same rule is the shared worker contract's
// sanitizeCollectionErrorDetail (without its keyword step, which needs the job).
// It never changes the typed code, the circuit signature or any cooldown.
const COLLECTION_ERROR_DETAIL_MAX_CHARS = 120;
const COLLECTION_ERROR_DETAIL_CUT_MARKERS = ["http", "://", " url", "?"];

function collectionErrorDetail(value) {
  if (typeof value !== "string" || !value) return "";
  const printable = value.slice(0, 1_000).replace(/[^\x20-\x7E]+/gu, " ");
  const cutAt = Math.min(
    printable.length,
    ...COLLECTION_ERROR_DETAIL_CUT_MARKERS
      .map((marker) => printable.indexOf(marker))
      .filter((index) => index >= 0),
  );
  return printable.slice(0, cutAt)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, COLLECTION_ERROR_DETAIL_MAX_CHARS)
    .trim();
}

function typedCollectionError(error, fallbackCode) {
  let code = "";
  for (const value of [error?.code, error?.message]) {
    const candidate = String(value || "").trim().toLowerCase();
    if (TYPED_COLLECTION_ERROR_PATTERN.test(candidate)) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    const fallback = String(fallbackCode || "").trim().toLowerCase();
    code = TYPED_COLLECTION_ERROR_PATTERN.test(fallback)
      ? fallback
      : "provider_browser_collection_failed";
  }
  const typedError = new Error(code);
  // The code is decided exactly as before; the original text only rides beside
  // it, and a self-typed failure (its message is the code) carries none.
  const message = String(error?.message ?? "");
  const errorDetail = collectionErrorDetail(error?.errorDetail)
    || (message.trim().toLowerCase() === code ? "" : collectionErrorDetail(message));
  if (errorDetail) typedError.errorDetail = errorDetail;
  return typedError;
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
    await releaseCollectionTab(current.tabId);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (Number.isInteger(tab?.windowId)) {
    await chrome.windows.update(tab.windowId, { state: "normal", focused: true }).catch(() => {});
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
  if (current.tabId) await releaseCollectionTab(current.tabId);
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
  let stored;
  let resetPendingAlarm;
  let runtimeIdentity;
  try {
    runtimeIdentity = await extensionRuntimeIdentity();
    stored = await chrome.storage.local.get([
      CADENCE_MINUTES_KEY,
      CADENCE_CONFIRMED_AT_KEY,
      CANDIDATE_CADENCE_RESET_PENDING_KEY,
      CANDIDATE_CADENCE_STABILITY_STARTED_AT_KEY,
      CANDIDATE_CADENCE_SUCCESS_COUNT_KEY,
      CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY,
      CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY,
    ]);
    resetPendingAlarm = await chrome.alarms.get(CANDIDATE_CADENCE_RESET_PENDING_ALARM);
  } catch {
    return BASELINE_CADENCE_MINUTES;
  }
  const value = requested == null ? stored[CADENCE_MINUTES_KEY] : requested;
  const confirmedAt = requested == null
    ? Number(stored[CADENCE_CONFIRMED_AT_KEY] || 0)
    : Date.now();
  const stabilityStartedAt = stored[CANDIDATE_CADENCE_STABILITY_STARTED_AT_KEY];
  const successCount = stored[CANDIDATE_CADENCE_SUCCESS_COUNT_KEY];
  const runtimeVersion = String(runtimeIdentity?.runtimeVersion || "");
  const serviceWorkerSha256 = String(runtimeIdentity?.serviceWorkerSha256 || "").toLowerCase();
  const proofIdentityMatches = runtimeVersion.length > 0
    && SHA256_HEX_PATTERN.test(serviceWorkerSha256)
    && stored[CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY] === runtimeVersion
    && stored[CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY] === serviceWorkerSha256;
  const stabilityProven = proofIdentityMatches
    && Number.isSafeInteger(stabilityStartedAt)
    && stabilityStartedAt > 0
    && stabilityStartedAt <= Date.now() - CANDIDATE_CADENCE_STABILITY_MS
    && Number.isSafeInteger(successCount)
    && successCount >= CANDIDATE_CADENCE_REQUIRED_SUCCESSES;
  const resetPending = candidateCadenceResetPendingMemory === true
    || stored[CANDIDATE_CADENCE_RESET_PENDING_KEY] !== false
    || Boolean(resetPendingAlarm)
    || !stabilityProven;
  const cadence = Number(value);
  const candidateRecentlyConfirmed = requested != null
    || (confirmedAt > 0 && confirmedAt + CANDIDATE_CADENCE_CONFIRMATION_TTL_MS > Date.now());
  return cadence === CANDIDATE_CADENCE_MINUTES
      && candidateRecentlyConfirmed
      && !resetPending
    ? cadence
    : BASELINE_CADENCE_MINUTES;
}

function workerSummaryRequiresCadenceReset(result) {
  const status = String(result?.status || "");
  const failed = result?.failed;
  const hasTrackerPartialWindowFailures = Object.hasOwn(
    result || {}, "trackerPartialWindowFailures",
  );
  const hasTrackerFiniteWindowFailures = Object.hasOwn(
    result || {}, "trackerFiniteWindowFailures",
  );
  const trackerPartialWindowFailures = hasTrackerPartialWindowFailures
    ? result.trackerPartialWindowFailures
    : (failed === 0 || hasTrackerFiniteWindowFailures ? 0 : undefined);
  const trackerFiniteWindowFailures = hasTrackerFiniteWindowFailures
    ? result.trackerFiniteWindowFailures
    : (failed === 0 || hasTrackerPartialWindowFailures ? 0 : undefined);
  const releaseFailed = result?.releaseFailed;
  const controlPlaneFailed = Object.hasOwn(result || {}, "controlPlaneFailed")
    ? result.controlPlaneFailed
    : 0;
  const atomicSuccesses = result?.atomicSuccesses;
  const haltedCode = String(result?.haltedCode || "");
  const terminalStatusValid = status === "already_running"
    || status === "standby"
    || status === "idle"
    || status === "completed";
  const countersValid = Number.isSafeInteger(failed)
    && Number.isSafeInteger(trackerPartialWindowFailures)
    && Number.isSafeInteger(trackerFiniteWindowFailures)
    && Number.isSafeInteger(releaseFailed)
    && Number.isSafeInteger(controlPlaneFailed)
    && Number.isSafeInteger(atomicSuccesses)
    && failed >= 0
    && trackerPartialWindowFailures >= 0
    && trackerFiniteWindowFailures >= 0
    && trackerPartialWindowFailures + trackerFiniteWindowFailures <= failed
    && releaseFailed >= 0
    && controlPlaneFailed >= 0
    && atomicSuccesses >= 0;
  const trackerCadenceNeutralOnly = status === "completed"
    && failed > 0
    && trackerPartialWindowFailures + trackerFiniteWindowFailures === failed
    && releaseFailed === 0
    && controlPlaneFailed === 0;
  return !terminalStatusValid
    || !countersValid
    || (status !== "completed" && atomicSuccesses !== 0)
    || (failed > 0 && !trackerCadenceNeutralOnly)
    || releaseFailed > 0
    || controlPlaneFailed > 0
    || Boolean(result?.halted)
    || Boolean(haltedCode);
}

function failClosedCandidateCadenceMemory() {
  candidateCadenceResetPendingMemory = true;
}

async function markCandidateCadenceResetPending(runtimeIdentity = null) {
  failClosedCandidateCadenceMemory();
  let runtimeVersion = "";
  let serviceWorkerSha256 = "";
  try {
    const currentIdentity = runtimeIdentity || await extensionRuntimeIdentity();
    const candidateRuntimeVersion = String(currentIdentity?.runtimeVersion || "");
    const candidateServiceWorkerSha256 = String(
      currentIdentity?.serviceWorkerSha256 || "",
    ).toLowerCase();
    if (
      candidateRuntimeVersion.length > 0
      && SHA256_HEX_PATTERN.test(candidateServiceWorkerSha256)
    ) {
      runtimeVersion = candidateRuntimeVersion;
      serviceWorkerSha256 = candidateServiceWorkerSha256;
    }
  } catch {
    // An unavailable runtime identity invalidates, rather than reuses, proof.
  }
  let alarmCreated = false;
  let storageWritten = false;
  try {
    await chrome.alarms.create(CANDIDATE_CADENCE_RESET_PENDING_ALARM, {
      delayInMinutes: CANDIDATE_CADENCE_RESET_PENDING_ALARM_MINUTES,
      periodInMinutes: CANDIDATE_CADENCE_RESET_PENDING_ALARM_MINUTES,
    });
    alarmCreated = true;
  } catch {
    // The strict storage marker remains the independent durable fallback.
  }
  try {
    await chrome.storage.local.set({
      [CANDIDATE_CADENCE_RESET_PENDING_KEY]: true,
      [CANDIDATE_CADENCE_STABILITY_STARTED_AT_KEY]: 0,
      [CANDIDATE_CADENCE_SUCCESS_COUNT_KEY]: 0,
      [CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY]: runtimeVersion,
      [CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY]: serviceWorkerSha256,
    });
    storageWritten = true;
  } catch {
    // The long-lived Chrome alarm remains across service-worker restarts.
  }
  return alarmCreated && storageWritten;
}

async function updateCandidateCadenceEvidence(result) {
  if (workerSummaryRequiresCadenceReset(result)) {
    await markCandidateCadenceResetPending();
    return false;
  }
  let stored;
  let resetPendingAlarm;
  let runtimeIdentity;
  try {
    runtimeIdentity = await extensionRuntimeIdentity();
    stored = await chrome.storage.local.get([
      CANDIDATE_CADENCE_RESET_PENDING_KEY,
      CANDIDATE_CADENCE_STABILITY_STARTED_AT_KEY,
      CANDIDATE_CADENCE_SUCCESS_COUNT_KEY,
      CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY,
      CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY,
    ]);
    resetPendingAlarm = await chrome.alarms.get(CANDIDATE_CADENCE_RESET_PENDING_ALARM);
  } catch {
    await markCandidateCadenceResetPending();
    return false;
  }

  const now = Date.now();
  const storedPending = stored[CANDIDATE_CADENCE_RESET_PENDING_KEY];
  const storedStartedAt = stored[CANDIDATE_CADENCE_STABILITY_STARTED_AT_KEY];
  const storedSuccessCount = stored[CANDIDATE_CADENCE_SUCCESS_COUNT_KEY];
  const runtimeVersion = String(runtimeIdentity?.runtimeVersion || "");
  const serviceWorkerSha256 = String(runtimeIdentity?.serviceWorkerSha256 || "").toLowerCase();
  const proofIdentityMatches = runtimeVersion.length > 0
    && SHA256_HEX_PATTERN.test(serviceWorkerSha256)
    && stored[CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY] === runtimeVersion
    && stored[CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY] === serviceWorkerSha256;
  const storedEvidenceValid = proofIdentityMatches
    && Number.isSafeInteger(storedStartedAt)
    && storedStartedAt > 0
    && storedStartedAt <= now
    && Number.isSafeInteger(storedSuccessCount)
    && storedSuccessCount >= 0
    && storedSuccessCount <= CANDIDATE_CADENCE_REQUIRED_SUCCESSES;
  const storedProgressValid = storedPending === true && storedEvidenceValid;
  const storedProofComplete = storedEvidenceValid
    && storedStartedAt <= now - CANDIDATE_CADENCE_STABILITY_MS
    && storedSuccessCount >= CANDIDATE_CADENCE_REQUIRED_SUCCESSES;

  if (
    storedPending === false
    && storedProofComplete
    && !resetPendingAlarm
    && candidateCadenceResetPendingMemory !== true
  ) {
    candidateCadenceResetPendingMemory = false;
    return true;
  }

  const atomicSuccesses = result.atomicSuccesses;
  if (atomicSuccesses === 0) {
    if (!storedProgressValid || !storedProofComplete) return false;
  }

  const continuingProgress = storedProgressValid;
  const stabilityStartedAt = continuingProgress ? storedStartedAt : now;
  const successCount = Math.min(
    CANDIDATE_CADENCE_REQUIRED_SUCCESSES,
    (continuingProgress ? storedSuccessCount : 0) + atomicSuccesses,
  );
  const stabilityProven = stabilityStartedAt <= now - CANDIDATE_CADENCE_STABILITY_MS
    && successCount >= CANDIDATE_CADENCE_REQUIRED_SUCCESSES;

  if (!stabilityProven) {
    failClosedCandidateCadenceMemory();
    if (!resetPendingAlarm) {
      try {
        await chrome.alarms.create(CANDIDATE_CADENCE_RESET_PENDING_ALARM, {
          delayInMinutes: CANDIDATE_CADENCE_RESET_PENDING_ALARM_MINUTES,
          periodInMinutes: CANDIDATE_CADENCE_RESET_PENDING_ALARM_MINUTES,
        });
      } catch {
        // Storage evidence remains an independent durable fail-closed marker.
      }
    }
    try {
      await chrome.storage.local.set({
        [CANDIDATE_CADENCE_RESET_PENDING_KEY]: true,
        [CANDIDATE_CADENCE_STABILITY_STARTED_AT_KEY]: stabilityStartedAt,
        [CANDIDATE_CADENCE_SUCCESS_COUNT_KEY]: successCount,
        [CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY]: runtimeVersion,
        [CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY]: serviceWorkerSha256,
      });
    } catch {
      return false;
    }
    return false;
  }

  failClosedCandidateCadenceMemory();
  try {
    await chrome.alarms.clear(CANDIDATE_CADENCE_RESET_PENDING_ALARM);
    await chrome.storage.local.set({
      [CANDIDATE_CADENCE_RESET_PENDING_KEY]: false,
      [CANDIDATE_CADENCE_STABILITY_STARTED_AT_KEY]: stabilityStartedAt,
      [CANDIDATE_CADENCE_SUCCESS_COUNT_KEY]: successCount,
      [CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY]: runtimeVersion,
      [CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY]: serviceWorkerSha256,
    });
    candidateCadenceResetPendingMemory = false;
    return true;
  } catch {
    return false;
  }
}

function cadenceFromWorkerSummary(result) {
  return !workerSummaryRequiresCadenceReset(result)
      && result?.cadenceMinutes === CANDIDATE_CADENCE_MINUTES
    ? CANDIDATE_CADENCE_MINUTES
    : BASELINE_CADENCE_MINUTES;
}

async function configureAlarms(requestedCadence = null) {
  let cadenceMinutes = await safeCadenceMinutes(requestedCadence);
  if (requestedCadence != null) {
    try {
      await chrome.storage.local.set({
        [CADENCE_MINUTES_KEY]: cadenceMinutes,
        [CADENCE_CONFIRMED_AT_KEY]: Date.now(),
      });
    } catch {
      await markCandidateCadenceResetPending();
      cadenceMinutes = BASELINE_CADENCE_MINUTES;
    }
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

function isLegacyControllerTab(tab) {
  try {
    const url = new URL(tab?.pendingUrl || tab?.url || "");
    return url.protocol === LEGACY_CONTROLLER_PAGE_URL.protocol
      && url.host === LEGACY_CONTROLLER_PAGE_URL.host
      && url.pathname === LEGACY_CONTROLLER_PAGE_URL.pathname
      && url.searchParams.get("controller") === "1";
  } catch {
    return false;
  }
}

async function removeLegacyControllerTabs() {
  const tabs = await chrome.tabs.query({});
  const controllerIds = tabs
    .filter(isLegacyControllerTab)
    .map((tab) => tab.id)
    .filter(Number.isInteger);
  await Promise.all(controllerIds.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
}

async function automaticVerificationCooldownActive(trigger) {
  if (trigger === "manual") return false;
  const verification = await verificationState();
  return verification.blockedUntil > Date.now();
}

async function requestWorkerRun(trigger) {
  await initializationPromise;
  // 1.1.34: stale code reloads itself (rate-limited) and never opens the native
  // host; the host would refuse it before any lane claim anyway.
  if (await reloadIfServiceWorkerStale(`run:${String(trigger || "")}`)) {
    return { ok: false, started: false, code: "extension_service_worker_stale" };
  }
  if (await automaticVerificationCooldownActive(trigger)) {
    await saveStatus("verification", "naver_verification_cooldown");
    return { ok: false, started: false, code: "naver_verification_cooldown" };
  }
  if (running) {
    const pending = queuePendingTrigger(trigger);
    if (pending.queued) {
      // The popup treats `started` as an accepted asynchronous request. Keep
      // the coalesced follow-up out of its false "completed" branch.
      return {
        ok: true,
        started: true,
        queued: true,
        pendingTrigger: String(pending.pendingTrigger || ""),
      };
    }
    return { ok: false, started: false, code: "already_running" };
  }
  // connectNative() keeps an MV3 service worker alive while its native port is
  // open. The finite extension-API heartbeat below adds a second bounded guard
  // without creating any visible controller tab.
  void runWorker(trigger);
  return { ok: true, started: true };
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

// A search tab that ended on a host outside the extension's permission (Naver
// login `nid.naver.com`, a security check) cannot be scripted at all; Chrome
// rejects `executeScript` with "Cannot access contents of url". That is a
// human-required access state, not a page script fault, so it maps to the
// existing verification code (cooldown + the tab is surfaced for the person).
// 2026-09-10 outage: a logged-out collector profile was redirected to login for
// 16 hours and every attempt was recorded as `naver_page_script_failed`.
function classifyOffHostTab(tabUrl) {
  const url = String(tabUrl || "");
  if (/^https:\/\/nid\.naver\.com\//u.test(url)) return "naver_verification_required";
  if (/^https:\/\/[a-z0-9.-]*naver\.com\//u.test(url)
    && !url.startsWith("https://search.shopping.naver.com/")) {
    return "naver_verification_required";
  }
  if (url === "" || url.startsWith("chrome-error://")) return "naver_page_navigation_failed";
  return null;
}

async function readNextData(tabId) {
  let results;
  try {
    results = await readNextDataScript(tabId);
  } catch (error) {
    if (!/Cannot access contents of (the page|url)/iu.test(String(error?.message || ""))) throw error;
    const tabUrl = await chrome.tabs.get(tabId).then((tab) => String(tab?.url || "")).catch(() => "");
    const offHostCode = classifyOffHostTab(tabUrl);
    if (offHostCode) throw new Error(offHostCode);
    throw error;
  }
  const value = results?.[0]?.result || {};
  if (value.restricted) throw new Error("naver_network_restricted");
  if (value.blocked) throw new Error("naver_verification_required");
  if (!value.nextDataText) throw new Error("naver_next_data_missing");
  if (!String(value.url || "").startsWith("https://search.shopping.naver.com/")) {
    throw new Error("naver_navigation_invalid");
  }
  return value.nextDataText;
}

async function readNextDataScript(tabId) {
  return withTimeout(chrome.scripting.executeScript({
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

// 1.1.33 (2026-09-27 incident). The scheduler forwards the collection profile
// with --no-startup-window when Chrome is already running, so the profile can
// have no normal window at all; chrome.tabs.create() then rejects "No current
// window" (the Mac standby failed four times in a row and opened the global
// circuit). Closing a profile's last window also unloads that profile together
// with this service worker (Chrome 149 and the owner's branded Chrome,
// measured). So the collector opens its own minimized window only when the
// profile has no normal window, reuses that window's single parked tab while it
// is still the profile's only, minimized surface (adopting such a surface on
// about:blank when a restart lost the record), and parks the last tab of the
// last window on about:blank instead of closing it.
async function normalCollectionWindows() {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
    // An incognito window (when the extension is allowed there) is never this
    // profile's collection surface.
    return Array.isArray(windows) ? windows.filter((window) => window?.incognito !== true) : null;
  } catch {
    return null;
  }
}

// undefined: the session store was read and holds no record (Chrome restart or
// extension reload). null: the store is unreadable or the record is malformed.
async function loadCollectionWindowAnchor() {
  try {
    const stored = await chrome.storage.session.get(COLLECTION_WINDOW_ANCHOR_KEY);
    const anchor = stored?.[COLLECTION_WINDOW_ANCHOR_KEY];
    if (anchor === undefined) return undefined;
    return Number.isInteger(anchor?.windowId) && Number.isInteger(anchor?.tabId) ? anchor : null;
  } catch {
    return null;
  }
}

async function saveCollectionWindowAnchor(windowId, tabId) {
  try {
    await chrome.storage.session.set({ [COLLECTION_WINDOW_ANCHOR_KEY]: { windowId, tabId } });
  } catch {
    // Without the session marker the next run takes the unchanged tab path.
  }
}

// An unfocused window is shown asynchronously after windows.create resolves
// and that show undoes an immediate minimize (macOS, Chrome 149, measured).
async function minimizeCollectionWindow(windowId) {
  for (let attempt = 0; attempt < COLLECTION_WINDOW_MINIMIZE_ATTEMPTS; attempt += 1) {
    await wait(COLLECTION_WINDOW_MINIMIZE_SETTLE_MS);
    try {
      await chrome.windows.update(windowId, { state: "minimized" });
      await wait(COLLECTION_WINDOW_MINIMIZE_SETTLE_MS);
      const window = await chrome.windows.get(windowId);
      if (window?.state === "minimized") return true;
    } catch {
      return false;
    }
  }
  return false;
}

// tabs.update resolves before about:blank commits, and the native host asks
// for the next pass right after collection_complete. A parked tab still on its
// search page with pendingUrl "about:blank" is refused for reuse, and
// tabs.create into the minimized window would restore it on macOS (measured).
async function waitForParkedTabCommit(tabId) {
  try {
    for (let check = 0; check < COLLECTION_TAB_PARK_COMMIT_CHECKS; check += 1) {
      if (check > 0) await wait(COLLECTION_WINDOW_MINIMIZE_SETTLE_MS);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || (tab.url === "about:blank" && tab.pendingUrl == null)) return;
    }
  } catch {
    // The park goes on without the wait; the next run then opens a tab instead.
  }
}

async function reusableCollectionAnchorTab(windows) {
  if (!Array.isArray(windows) || windows.length !== 1) return null;
  const [onlyWindow] = windows;
  // A restored window (verification surfaced it, or a person opened it) is not
  // taken over: collecting there would show pages in front of the person.
  if (onlyWindow?.state !== "minimized") return null;
  const tabs = Array.isArray(onlyWindow.tabs) ? onlyWindow.tabs : [];
  if (tabs.length !== 1) return null;
  // Never take over a tab that someone navigated, or is navigating, elsewhere.
  const tabUrl = String(tabs[0]?.url || "");
  if (tabUrl !== "about:blank" && !tabUrl.startsWith("https://search.shopping.naver.com/")) return null;
  if (tabs[0].pendingUrl != null && String(tabs[0].pendingUrl) !== tabUrl) return null;
  const anchor = await loadCollectionWindowAnchor();
  if (anchor === undefined) return adoptParkedCollectionTab(onlyWindow, tabs[0]);
  return anchor?.windowId === onlyWindow.id && anchor.tabId === tabs[0].id ? anchor.tabId : null;
}

// Chrome restart or an extension reload empties chrome.storage.session while
// the parked window stays (or is restored): the profile's only window,
// minimized, holding one tab on about:blank. tabs.create into it would restore
// it on macOS (measured), so that exact surface is adopted and recorded. A tab
// on any other address, a search page included, is never adopted without the
// record, and neither is a visible window (the checks above).
async function adoptParkedCollectionTab(onlyWindow, onlyTab) {
  if (onlyTab?.url !== "about:blank") return null;
  if (!Number.isInteger(onlyWindow?.id) || !Number.isInteger(onlyTab.id)) return null;
  await saveCollectionWindowAnchor(onlyWindow.id, onlyTab.id);
  return onlyTab.id;
}

async function openCollectionTab(url) {
  const windows = await normalCollectionWindows();
  if (windows === null || windows.length > 0) {
    const anchorTabId = await reusableCollectionAnchorTab(windows);
    if (anchorTabId != null) {
      // tabs.update keeps a minimized window minimized; tabs.create into it
      // restores it on macOS (measured), so the parked anchor tab is reused.
      await chrome.tabs.update(anchorTabId, { url, active: false });
      return anchorTabId;
    }
    const tab = await chrome.tabs.create({ url, active: false });
    return tab.id;
  }
  const window = await chrome.windows.create({ url, focused: false, state: "minimized" });
  const tabId = window?.tabs?.[0]?.id;
  if (!Number.isInteger(window?.id) || !Number.isInteger(tabId)) {
    throw new Error("collection window opened without a tab");
  }
  await saveCollectionWindowAnchor(window.id, tabId);
  await minimizeCollectionWindow(window.id);
  return tabId;
}

// Never throws: it runs in collectPages' finally and in the verification
// cleanup, where an exception would replace the typed code or turn a complete
// collection into an error.
async function releaseCollectionTab(tabId) {
  try {
    const windows = await normalCollectionWindows();
    const onlyWindow = windows?.length === 1 ? windows[0] : null;
    const onlyTabs = Array.isArray(onlyWindow?.tabs) ? onlyWindow.tabs : [];
    if (onlyWindow && onlyTabs.length === 1 && onlyTabs[0]?.id === tabId) {
      await chrome.tabs.update(tabId, { url: "about:blank" }).catch(() => {});
      await waitForParkedTabCommit(tabId);
      await saveCollectionWindowAnchor(onlyWindow.id, tabId);
      if (onlyWindow.state !== "minimized") await minimizeCollectionWindow(onlyWindow.id);
      return;
    }
    await chrome.tabs.remove(tabId).catch(() => {});
  } catch {
    // Leave the tab where it is: closing it blindly could close the profile's
    // last window and unload the profile together with this worker.
  }
}

async function collectPages(request, onPage = null, options = {}) {
  if (!request || request.limit !== 300 || request.rankPolicy !== "organic_only") {
    throw new Error("native_request_invalid");
  }
  const pageStart = Number(options.pageStart ?? 1);
  const pageEnd = Number(options.pageEnd ?? PAGE_COUNT);
  if (!Number.isInteger(pageStart)
    || !Number.isInteger(pageEnd)
    || pageStart < 1
    || pageEnd > PAGE_COUNT
    || pageStart > pageEnd) {
    throw new Error("native_request_invalid");
  }
  const pages = [];
  const requestDeadline = Date.parse(String(request.deadlineAt || ""));
  if (!Number.isFinite(requestDeadline)) throw new Error("native_request_invalid");
  if (requestDeadline <= Date.now()) throw new Error("provider_deadline_exceeded");
  const deadline = Math.min(Date.now() + COLLECTION_TIMEOUT_MS, requestDeadline);
  const assertWithinDeadline = () => {
    if (Date.now() >= deadline) throw new Error("provider_deadline_exceeded");
  };
  let tabId = null;
  let keepTabOpen = false;
  let collectionStageCode = "naver_page_navigation_failed";
  try {
    for (let pageIndex = pageStart; pageIndex <= pageEnd; pageIndex += 1) {
      assertWithinDeadline();
      collectionStageCode = "naver_page_navigation_failed";
      const url = searchUrl(request.keyword, pageIndex);
      if (tabId == null) {
        tabId = await openCollectionTab(url);
      } else {
        await chrome.tabs.update(tabId, { url, active: false });
      }
      await waitForTabComplete(tabId);
      assertWithinDeadline();
      collectionStageCode = "naver_page_script_failed";
      const page = { pageIndex, nextDataText: await readNextData(tabId) };
      assertWithinDeadline();
      if (typeof onPage === "function") {
        collectionStageCode = "native_host_page_delivery_failed";
        await onPage(page);
      }
      else pages.push(page);
      collectionStageCode = "provider_browser_collection_failed";
      await saveCollectionProgress(pageIndex);
      if (pageIndex < pageEnd) {
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
    if (tabId != null && !keepTabOpen) await releaseCollectionTab(tabId);
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

async function saveWorkerFailure() {
  try {
    await markCandidateCadenceResetPending();
    await saveStatus("failed", "rank_worker_unavailable");
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
    await markCandidateCadenceResetPending();
    await saveStatus("failed", "native_host_interrupted");
    return {
      status: "failed",
      detail: "native_host_interrupted",
      updatedAt: new Date().toISOString(),
    };
  }
  return status;
}

// 1.1.34: the manifest on disk, read fresh. Chrome keeps the manifest it loaded
// until the extension is reloaded, so a fast-forward without a real Chrome
// restart (watchdog chrome_quit_incomplete) only shows here. Unreadable is "".
async function serviceWorkerDiskManifestVersion() {
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    if (!response.ok) return "";
    const version = String((await response.json())?.version || "");
    return SERVICE_WORKER_VERSION_PATTERN.test(version) ? version : "";
  } catch {
    return "";
  }
}

// Stale when the loaded manifest or the manifest on disk is readable and differs
// from the build compiled into this script. Unreadable is not proof of staleness
// (the native host still refuses a build that differs from the reported version).
// The reload target is the version on disk, else the loaded one.
async function serviceWorkerBuildState() {
  let loadedVersion = "";
  try {
    loadedVersion = String(chrome.runtime.getManifest().version || "");
  } catch {
    loadedVersion = "";
  }
  if (!SERVICE_WORKER_VERSION_PATTERN.test(loadedVersion)) loadedVersion = "";
  const diskVersion = await serviceWorkerDiskManifestVersion();
  return {
    build: SERVICE_WORKER_BUILD,
    loadedVersion,
    diskVersion,
    targetVersion: diskVersion || loadedVersion,
    stale: (loadedVersion !== "" && loadedVersion !== SERVICE_WORKER_BUILD)
      || (diskVersion !== "" && diskVersion !== SERVICE_WORKER_BUILD),
  };
}

// Reloads a stale worker at most once per SERVICE_WORKER_RELOAD_INTERVAL_MS for
// one target version, never under an open native run (cutting it would strand
// the lane lease, 2026-09-29 drill), and never when the attempt cannot be
// recorded first (an unrecorded reload could loop). chrome.runtime.reload()
// re-reads the unpacked files and re-registers the worker (measured, Chrome for
// Testing 149). Returns true while stale; the run must not start.
async function attemptServiceWorkerReload(reason) {
  const state = await serviceWorkerBuildState();
  if (!state.stale) return false;
  if (nativeRunPortOpen) return true;
  const detail = `service_worker_build_stale:${state.build}:${state.targetVersion}`;
  const now = Date.now();
  let previous = null;
  try {
    const stored = await chrome.storage.local.get(SERVICE_WORKER_RELOAD_KEY);
    previous = stored?.[SERVICE_WORKER_RELOAD_KEY] || null;
  } catch {
    await saveStatus("stale", detail).catch(() => {});
    return true;
  }
  const attemptedAt = Number(previous?.attemptedAt || 0);
  if (previous?.targetVersion === state.targetVersion
    && attemptedAt > 0
    && attemptedAt <= now
    && now - attemptedAt < SERVICE_WORKER_RELOAD_INTERVAL_MS) {
    await saveStatus("stale", detail).catch(() => {});
    return true;
  }
  try {
    await chrome.storage.local.set({
      [SERVICE_WORKER_RELOAD_KEY]: {
        targetVersion: state.targetVersion,
        build: state.build,
        attemptedAt: now,
        reason: String(reason || "").slice(0, 40),
      },
    });
  } catch {
    return true;
  }
  await saveStatus("stale", `${detail}:reloading`).catch(() => {});
  // A run that passed its own guard before the disk moved can open its native
  // port during the awaits above. Never cut it; give the attempt back so the
  // guard after that run may reload without waiting out the interval.
  if (nativeRunPortOpen) {
    try {
      if (previous) await chrome.storage.local.set({ [SERVICE_WORKER_RELOAD_KEY]: previous });
      else await chrome.storage.local.remove(SERVICE_WORKER_RELOAD_KEY);
    } catch {
      // The record stays; the next reload of this target waits out the interval.
    }
    return true;
  }
  chrome.runtime.reload();
  return true;
}

// Startup, onInstalled and onStartup can arrive together; one check serves all.
function reloadIfServiceWorkerStale(reason) {
  if (!serviceWorkerReloadInFlight) {
    serviceWorkerReloadInFlight = attemptServiceWorkerReload(reason)
      .finally(() => { serviceWorkerReloadInFlight = null; });
  }
  return serviceWorkerReloadInFlight;
}

async function initializeWorker() {
  try {
    if (await reloadIfServiceWorkerStale("initialize")) {
      // Keep only the wake-up alarms that retry the reload; touch nothing else.
      await configureAlarms().catch(() => {});
      return;
    }
    const runtimeIdentity = await extensionRuntimeIdentity();
    const runtimeVersion = String(runtimeIdentity?.runtimeVersion || "");
    const serviceWorkerSha256 = String(runtimeIdentity?.serviceWorkerSha256 || "").toLowerCase();
    if (!runtimeVersion || !SHA256_HEX_PATTERN.test(serviceWorkerSha256)) {
      throw new Error("extension_runtime_identity_unavailable");
    }
    const stored = await chrome.storage.local.get([
      "momentInsightRankStatus",
      CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY,
      CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY,
    ]);
    const storedStatus = String(stored.momentInsightRankStatus?.status || "");
    const proofIdentityMatches = stored[CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY] === runtimeVersion
      && stored[CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY] === serviceWorkerSha256;
    if (!INITIALIZATION_SAFE_STATUSES.has(storedStatus) || !proofIdentityMatches) {
      await markCandidateCadenceResetPending(runtimeIdentity);
    }
    if (storedStatus === "running") {
      await saveStatus("failed", "native_host_interrupted");
    } else if (storedStatus === "stale") {
      await saveStatus("ready", "");
    }
    await configureAlarms();
    await removeLegacyControllerTabs().catch(() => saveWorkerFailure());
  } catch (error) {
    await markCandidateCadenceResetPending();
    throw error;
  }
}

function startWorkerInitialization() {
  initializationPromise = initializeWorker();
  void initializationPromise.catch(() => saveWorkerFailure());
  return initializationPromise;
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

function nativeReadyAcknowledgement(message) {
  if (message?.collectionProtocol !== COLLECTION_PROTOCOL) {
    throw new Error("native_host_collection_protocol_mismatch");
  }
  return { action: "ready_ack", collectionProtocol: COLLECTION_PROTOCOL };
}

function startWorkerKeepAlive() {
  const heartbeat = () => {
    void chrome.runtime.getPlatformInfo().catch(() => {});
  };
  heartbeat();
  const timer = setInterval(heartbeat, WORKER_KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function runWorker(trigger = "manual", options = {}) {
  await initializationPromise;
  if (running) return { ok: false, code: "already_running" };
  running = true;
  let port = null;
  let stopKeepAlive = null;
  let hostRefusedServiceWorker = false;
  try {
    // 1.1.34: every run, the queued follow-up below included, checks the running
    // build before opening the native host.
    if (await reloadIfServiceWorkerStale(`run:${String(trigger || "")}`)) {
      return { ok: false, code: "extension_service_worker_stale" };
    }
    const automatic = trigger !== "manual" || options.respectVerificationCooldown === true;
    const verification = await verificationState();
    if (automatic && verification.blockedUntil > Date.now()) {
      await saveStatus("verification", "naver_verification_cooldown");
      return { ok: false, code: "naver_verification_cooldown" };
    }
    await saveStatus("running", trigger);
    if (options.waitForNativeHandoff === true) await wait(PENDING_TRIGGER_HANDOFF_MS);
    nativeRunPortOpen = true;
    port = chrome.runtime.connectNative(NATIVE_HOST);
    stopKeepAlive = startWorkerKeepAlive();
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
            port.postMessage(nativeReadyAcknowledgement(message));
            return;
          }
          if (message?.type === "collect") {
            try {
              await collectPages(message.request, async (page) => {
                port.postMessage({ type: "collection_page", requestId: message.requestId, page });
              }, { pageStart: message.pageStart, pageEnd: message.pageEnd });
              port.postMessage({ type: "collection_complete", requestId: message.requestId });
            } catch (error) {
              port.postMessage({
                type: "collection_error",
                requestId: message.requestId,
                code: String(error?.message || "collection_failed"),
                // 1.1.33: the sanitized Chrome text beside the code (optional).
                ...(typeof error?.errorDetail === "string" && error.errorDetail
                  ? { errorDetail: error.errorDetail }
                  : {}),
              });
            }
            return;
          }
          if (message?.type === "summary") {
            finish(null, message.summary || {});
          } else if (message?.type === "error") {
            finish(new Error(String(message.code || "native_host_failed")));
          } else if (message?.type === "service_worker_stale") {
            // 1.1.34: the host refused this build before any lane claim.
            finish(new Error("native_host_service_worker_stale"));
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
    await updateCandidateCadenceEvidence(result);
    const submitted = Math.max(0, Number(result.submitted || 0));
    await configureAlarms(cadenceFromWorkerSummary(result)).catch(() => {});
    if (result.status === "already_running") {
      await saveStatus("standby", "기존 작업 종료 대기 중");
      return { ok: false, code: "native_host_already_running", summary: result };
    }
    if (result.status === "disabled") {
      await saveStatus("failed", "local_worker_disabled");
      return { ok: false, code: "local_worker_disabled", summary: result };
    }
    if (result.status === "standby" || result.status === "idle") {
      await saveStatus("standby", "다음 갱신 요청 대기 중");
      return { ok: true, idle: true, summary: result };
    }
    if (result.status === "control_plane_failed") {
      await saveStatus("failed", "local_worker_control_plane_failed");
      return {
        ok: false,
        partial: submitted > 0,
        code: "local_worker_control_plane_failed",
        summary: result,
      };
    }
    if (result.status !== "completed") {
      await saveStatus("failed", "local_worker_summary_invalid");
      return { ok: false, code: "local_worker_summary_invalid", summary: result };
    }
    const queuedTotal = Math.max(0, Number(result.queuedTotal || 0));
    const claimed = Math.max(0, Number(result.claimed || 0));
    const failed = Math.max(0, Number(result.failed || 0) + Number(result.releaseFailed || 0));
    const haltedCode = String(result.haltedCode || "");
    if (NAVER_ACCESS_COOLDOWN_CODES.has(haltedCode)) {
      await chrome.storage.local.set({
        [VERIFICATION_BLOCKED_UNTIL_KEY]: Date.now() + VERIFICATION_COOLDOWN_MS,
      });
      await saveStatus("verification", haltedCode);
      return { ok: false, partial: submitted > 0, code: haltedCode, summary: result };
    }
    if (claimed === 0 && submitted === 0 && failed === 0) {
      await saveStatus("standby", queuedTotal > 0
        ? "격리 해제 또는 다음 처리 가능 작업 대기 중"
        : "다음 갱신 요청 대기 중");
      return { ok: true, idle: true, summary: result };
    }
    const completedDetail = queuedTotal > 0
      ? `전체 ${queuedTotal}개 등록 · 이번 회차 ${submitted}개 갱신`
      : `갱신 ${submitted}건`;
    await saveStatus(failed > 0 ? "partial" : "completed", failed > 0
      ? `${completedDetail} · 재시도 ${failed}건`
      : completedDetail);
    return { ok: failed === 0, partial: failed > 0, summary: result };
  } catch (error) {
    await markCandidateCadenceResetPending();
    await configureAlarms(BASELINE_CADENCE_MINUTES).catch(() => {});
    if (String(error?.message || "") === "native_host_service_worker_stale") {
      // Not a collection failure: no server call was made. Reload below.
      hostRefusedServiceWorker = true;
      await saveStatus("stale", "native_host_service_worker_stale");
      return { ok: false, code: "native_host_service_worker_stale" };
    }
    await saveStatus("failed", String(error?.message || "worker_failed"));
    return { ok: false, code: String(error?.message || "worker_failed") };
  } finally {
    if (stopKeepAlive) stopKeepAlive();
    if (port) port.disconnect();
    nativeRunPortOpen = false;
    // 1.1.34: the port is closed, so the guard may reload this stale worker now.
    if (hostRefusedServiceWorker) void reloadIfServiceWorkerStale("native-host");
    const nextTrigger = takePendingTrigger();
    running = false;
    if (nextTrigger) {
      // Reserve the direct worker synchronously, report the queued run as
      // active, then give the previous native host one finite, bounded interval
      // to release its Windows mutex before the next connection.
      void runWorker(nextTrigger, {
        respectVerificationCooldown: true,
        waitForNativeHandoff: true,
      });
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void startWorkerInitialization();
});
chrome.runtime.onStartup.addListener(() => {
  void startWorkerInitialization();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (RUN_ALARMS.has(alarm.name)) {
    void requestWorkerRun(alarm.name).catch(() => saveWorkerFailure());
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "run-now") {
    requestWorkerRun("manual").then(sendResponse).catch((error) => {
      sendResponse({ ok: false, code: String(error?.message || "rank_worker_unavailable") });
    });
    return true;
  }
  if (message?.action === "status") {
    loadVisibleStatus().then(sendResponse).catch(() => {
      sendResponse({ status: "failed", detail: "rank_worker_unavailable" });
    });
    return true;
  }
  return false;
});
void startWorkerInitialization();

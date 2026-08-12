import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { signLocalWorkerRequest } from "../src/server/local-worker-auth.mjs";
import {
  LOCAL_WORKER_ENDPOINT_PATH,
  localWorkerRankRequest,
  validateLocalWorkerJob,
  validateStrictLocalWorkerWindow,
} from "../src/server/naver-shopping/local-worker-contract.mjs";
import {
  createPlaywrightProvider,
  defaultNaverShoppingProfileDir,
  validateNaverShoppingProfileDir,
} from "../tools/naver-shopping-rank-collector/src/provider.mjs";

const DEFAULT_API_ORIGIN = "https://insight.momentlabs.co.kr";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_STALE_MS = 8 * 60 * 60_000;
const LOCK_INITIALIZATION_GRACE_MS = 60_000;
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://insight.momentlabs.co.kr",
  "http://127.0.0.1",
  "http://localhost",
]);
const SAFE_FAILURE_CODES = new Set([
  "naver_http_418",
  "naver_http_429",
  "naver_captcha_detected",
  "naver_auth_required",
  "naver_selector_drift",
  "naver_verification_required",
  "naver_next_data_missing",
  "naver_page_timeout",
  "naver_page_script_timeout",
  "naver_navigation_invalid",
  "naver_home_navigation_failed",
  "naver_normal_search_navigation_failed",
  "naver_price_compare_navigation_failed",
  "naver_page_navigation_failed",
  "naver_navigation_path_mismatch",
  "naver_navigation_url_query_mismatch",
  "naver_navigation_url_page_mismatch",
  "naver_navigation_data_query_mismatch",
  "naver_navigation_data_page_mismatch",
  "naver_page_read_state_unstable",
  "naver_page_script_failed",
  "naver_page_navigation_result_missing",
  "naver_home_search_result_missing",
  "naver_home_search_target_invalid",
  "naver_price_compare_result_missing",
  "naver_price_compare_target_invalid",
  "naver_price_compare_target_missing",
  "naver_pagination_target_missing",
  "naver_network_restricted",
  "provider_deadline_exceeded",
  "provider_partial_window",
  "provider_browser_collection_failed",
  "naver_next_data_invalid_json",
  "naver_next_data_schema_drift",
  "naver_next_data_rank_drift",
  "provider_duplicate_identity",
  "provider_row_invalid",
  "provider_row_title_missing",
  "provider_row_identity_missing",
  "native_host_page_invalid",
  "native_host_limit_invalid",
  "native_host_pages_incomplete",
  "native_host_pages_out_of_order",
  "native_host_rows_invalid",
  "native_host_collection_invalid",
  "local_worker_window_not_300",
  "local_worker_lease_lost",
  "local_worker_collection_conflict",
  "local_worker_submit_incomplete",
  "local_worker_submit_partial",
  "native_host_response_timeout",
]);
const SAFE_DETAIL_FAILURE_CODES = new Set([
  "naver_next_data_schema_drift",
  "naver_next_data_rank_drift",
  "provider_partial_window",
  "provider_row_invalid",
  "provider_row_title_missing",
  "provider_row_identity_missing",
  "native_host_page_invalid",
  "native_host_pages_out_of_order",
]);
const TRACKER_ISOLATED_FAILURE_CODES = new Set([
  "provider_duplicate_identity",
]);
const RUN_HALT_FAILURE_CODES = new Set([
  "naver_http_418",
  "naver_http_429",
  "naver_captcha_detected",
  "naver_auth_required",
  "naver_verification_required",
  "naver_next_data_missing",
  "naver_page_timeout",
  "naver_page_script_timeout",
  "naver_navigation_invalid",
  "naver_home_navigation_failed",
  "naver_normal_search_navigation_failed",
  "naver_price_compare_navigation_failed",
  "naver_page_navigation_failed",
  "naver_navigation_path_mismatch",
  "naver_navigation_url_query_mismatch",
  "naver_navigation_url_page_mismatch",
  "naver_navigation_data_query_mismatch",
  "naver_navigation_data_page_mismatch",
  "naver_page_read_state_unstable",
  "naver_page_navigation_result_missing",
  "naver_home_search_result_missing",
  "naver_home_search_target_invalid",
  "naver_price_compare_result_missing",
  "naver_price_compare_target_invalid",
  "naver_price_compare_target_missing",
  "naver_pagination_target_missing",
  "naver_network_restricted",
]);
const SECURITY_FAILURE_CODES = new Set([
  "naver_http_418",
  "naver_http_429",
  "naver_captcha_detected",
  "naver_auth_required",
  "naver_verification_required",
  "naver_network_restricted",
]);
const EXPECTED_RUNTIME_VERSION = "1.1.1";
const RUNTIME_FINGERPRINT_PATTERN = /^(?!0{64}$)[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{2,63}$/u;
const INTERNAL_FAILURE_CODE_PATTERN = /^(?:local_worker|native_host|provider|naver)_[a-z0-9_:-]{2,79}$/u;

async function runtimeIdentityInput(options, env) {
  let identity = options.runtimeIdentity || {
    version: env.MI_NAVER_SHOPPING_RUNTIME_VERSION,
    fingerprint: env.MI_NAVER_SHOPPING_RUNTIME_FINGERPRINT,
  };
  if (!identity.version && !identity.fingerprint) {
    const [localWorkerSource, contractSource] = await Promise.all([
      fs.readFile(new URL(import.meta.url)),
      fs.readFile(new URL("../src/server/naver-shopping/local-worker-contract.mjs", import.meta.url)),
    ]);
    identity = {
      version: EXPECTED_RUNTIME_VERSION,
      fingerprint: crypto.createHash("sha256").update([
        EXPECTED_RUNTIME_VERSION,
        crypto.createHash("sha256").update(localWorkerSource).digest("hex"),
        crypto.createHash("sha256").update(contractSource).digest("hex"),
        "direct-standby",
      ].join("\n"), "utf8").digest("hex"),
    };
  }
  const version = String(identity?.version || "").trim();
  const fingerprint = String(identity?.fingerprint || "").trim().toLowerCase();
  if (version !== EXPECTED_RUNTIME_VERSION || !RUNTIME_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error("local_worker_runtime_identity_invalid");
  }
  return { version, fingerprint };
}

function failureScope(job, failureCode) {
  const baseCode = String(failureCode || "").split(":", 1)[0];
  if (SECURITY_FAILURE_CODES.has(baseCode)) return "security";
  if (job?.kind !== "lookup"
    && (TRACKER_ISOLATED_FAILURE_CODES.has(baseCode)
      || /^(?:local_worker_tracker_|local_worker_target_)/u.test(baseCode))) return "tracker";
  return "system";
}

function jobProgressIdentity(job) {
  return {
    jobKind: job?.kind === "lookup" ? "lookup" : "tracker",
    trackerId: job?.kind === "lookup" ? null : job?.claims?.[0]?.trackerId || null,
  };
}

function restoreBaselineCadence(summary) {
  if (Object.hasOwn(summary, "cadenceMinutes")) summary.cadenceMinutes = 10;
  delete summary.cadenceEligible;
}

function workerCoordinationIdentity(env) {
  const fallbackDigest = crypto
    .createHash("sha256")
    .update(`${os.platform()}\n${os.hostname()}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  const workerId = String(
    env.MI_NAVER_SHOPPING_WORKER_ID || `local-${os.platform()}-${fallbackDigest}`,
  ).trim().toLowerCase();
  const workerRole = String(env.MI_NAVER_SHOPPING_WORKER_ROLE || "standby").trim().toLowerCase();
  if (!WORKER_ID_PATTERN.test(workerId)) throw new Error("local_worker_id_invalid");
  if (!["primary", "standby"].includes(workerRole)) throw new Error("local_worker_role_invalid");
  return { workerId, workerRole };
}

function enabled(env) {
  return String(env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED || "").trim().toLowerCase() === "true";
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function boundedResponseCount(value, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : 0;
}

function workerEndpoint(env) {
  const explicit = String(env.MI_NAVER_SHOPPING_LOCAL_WORKER_API_URL || "").trim();
  const url = new URL(explicit || LOCAL_WORKER_ENDPOINT_PATH, DEFAULT_API_ORIGIN);
  if (url.pathname !== LOCAL_WORKER_ENDPOINT_PATH || url.search || url.hash) {
    throw new Error("local_worker_api_url_invalid");
  }
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("local_worker_api_https_required");
  }
  const configuredOrigins = String(env.MI_NAVER_SHOPPING_LOCAL_WORKER_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowedOrigins = configuredOrigins.length
    ? new Set(configuredOrigins)
    : DEFAULT_ALLOWED_ORIGINS;
  if (!allowedOrigins.has(url.origin.toLowerCase())) {
    throw new Error("local_worker_api_origin_not_allowed");
  }
  return url;
}

function safeFailureCode(error) {
  const code = String(error?.result?.code || error?.code || error?.message || "")
    .trim()
    .toLowerCase();
  const baseCode = code.split(":", 1)[0];
  if (TRACKER_ISOLATED_FAILURE_CODES.has(baseCode)) return baseCode;
  if (!SAFE_FAILURE_CODES.has(code) && !INTERNAL_FAILURE_CODE_PATTERN.test(code)) {
    return "local_worker_collection_failed";
  }
  if (!SAFE_DETAIL_FAILURE_CODES.has(code)) return code;
  const detail = String(error?.detail || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, Math.max(0, 79 - code.length));
  return detail ? `${code}:${detail}`.slice(0, 80) : code;
}

async function signedWorkerAction(endpoint, secret, payload, options = {}) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.trunc((options.nowMs?.() ?? Date.now()) / 1000));
  const nonce = options.randomUUID?.() || crypto.randomUUID();
  const signature = signLocalWorkerRequest(secret, {
    timestamp,
    nonce,
    method: "POST",
    audience: endpoint.origin,
    path: endpoint.pathname,
    body: rawBody,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
  let response;
  let responseText = "";
  try {
    response = await (options.fetchImpl || globalThis.fetch)(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mi-worker-timestamp": timestamp,
        "x-mi-worker-nonce": nonce,
        "x-mi-worker-signature": signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    responseText = await response.text();
  } finally {
    clearTimeout(timeout);
  }
  let result = {};
  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error("local_worker_api_invalid_json");
  }
  if (!response.ok || result?.ok !== true) {
    const error = new Error(String(result?.code || "local_worker_api_failed"));
    error.status = response.status;
    error.result = result;
    throw error;
  }
  return result;
}

function processAlive(pid, killImpl = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function lockState(lockPath, options = {}) {
  const stat = await fs.stat(lockPath);
  let owner = null;
  try {
    owner = JSON.parse(await fs.readFile(`${lockPath}/owner.json`, "utf8"));
  } catch {
    try {
      owner = { pid: Number(String(await fs.readFile(`${lockPath}/pid`, "utf8")).trim()) };
    } catch {
      owner = null;
    }
  }
  const ageMs = Math.max(0, Number(options.nowMs ?? Date.now()) - Number(stat.mtimeMs || 0));
  const pid = Number(owner?.pid);
  const hasValidOwnerPid = Number.isSafeInteger(pid) && pid > 1;
  const alive = processAlive(pid, options.killImpl);
  const staleMs = boundedInteger(options.staleMs, DEFAULT_LOCK_STALE_MS, 60_000, 24 * 60 * 60_000);
  return {
    owner,
    ageMs,
    stale: (hasValidOwnerPid && !alive)
      || (!hasValidOwnerPid && ageMs >= LOCK_INITIALIZATION_GRACE_MS)
      || ageMs >= staleMs,
  };
}

export async function acquireWorkerLock(lockPath, options = {}) {
  const owner = {
    pid: Number(options.pid || process.pid),
    token: options.token || crypto.randomUUID(),
    createdAt: new Date(Number(options.nowMs ?? Date.now())).toISOString(),
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(`${lockPath}/owner.json`, `${JSON.stringify(owner)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let state;
      try {
        state = await lockState(lockPath, options);
      } catch (stateError) {
        if (stateError?.code === "ENOENT") continue;
        throw stateError;
      }
      if (!state.stale) return null;
      const stalePath = `${lockPath}.stale-${owner.token}-${attempt}`;
      try {
        await fs.rename(lockPath, stalePath);
      } catch (renameError) {
        if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(renameError?.code)) continue;
        throw renameError;
      }
      await fs.rm(stalePath, { recursive: true, force: true });
      continue;
    }
  }

  let installedOwner;
  try {
    installedOwner = JSON.parse(await fs.readFile(`${lockPath}/owner.json`, "utf8"));
  } catch {
    throw new Error("local_worker_lock_acquire_failed");
  }
  if (installedOwner?.token !== owner.token) return null;
  return async () => {
    try {
      const current = JSON.parse(await fs.readFile(`${lockPath}/owner.json`, "utf8"));
      if (current?.token !== owner.token) return;
      const releasedPath = `${lockPath}.released-${owner.token}`;
      await fs.rename(lockPath, releasedPath);
      await fs.rm(releasedPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

export async function runLocalShoppingWorker(options = {}) {
  const env = options.env || process.env;
  const log = options.log || (() => {});
  if (!enabled(env)) {
    log("N shopping local worker disabled");
    return { status: "disabled", claimed: 0, submitted: 0, failed: 0, releaseFailed: 0 };
  }
  const runtimeIdentity = await runtimeIdentityInput(options, env);
  const runId = String(options.runId || crypto.randomUUID()).trim().toLowerCase();
  if (!UUID_PATTERN.test(runId)) throw new Error("local_worker_run_id_invalid");
  const secret = String(env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET || "").trim();
  if (secret.length < 32) throw new Error("local_worker_secret_missing_or_weak");
  const userDataDir = String(
    env.NAVER_SHOPPING_PROVIDER_USER_DATA_DIR || defaultNaverShoppingProfileDir(),
  ).trim();
  if (!options.provider) {
    // Validate the dedicated authenticated profile before the first signed
    // claim so a missing/expired local setup never strands a live DB lease.
    validateNaverShoppingProfileDir(userDataDir);
  }
  const endpoint = workerEndpoint(env);
  const workerIdentity = workerCoordinationIdentity(env);
  const laneToken = String(options.laneToken || crypto.randomUUID()).trim().toLowerCase();
  const lanePayload = {
    workerId: workerIdentity.workerId,
    laneToken,
    runId,
    runtimeVersion: runtimeIdentity.version,
    runtimeFingerprint: runtimeIdentity.fingerprint,
  };
  const maxJobs = options.requireWakeSignal === true
    ? 1
    : boundedInteger(env.MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS, 100, 1, 500);
  const lockPath = String(env.MI_NAVER_SHOPPING_LOCAL_WORKER_LOCK_PATH || `${os.tmpdir()}/moment-insight-n-shopping-worker.lock`);
  const releaseLock = options.skipLock ? async () => {} : await acquireWorkerLock(lockPath, {
    staleMs: boundedInteger(
      env.MI_NAVER_SHOPPING_LOCAL_WORKER_LOCK_STALE_MS,
      DEFAULT_LOCK_STALE_MS,
      60_000,
      24 * 60 * 60_000,
    ),
  });
  if (!releaseLock) {
    return { status: "already_running", claimed: 0, submitted: 0, failed: 0, releaseFailed: 0 };
  }

  const action = (payload) => signedWorkerAction(endpoint, secret, payload, {
    fetchImpl: options.fetchImpl,
    nowMs: options.nowMs,
    randomUUID: options.randomUUID,
    timeoutMs: payload?.action === "submit"
      ? boundedInteger(
        env.MI_NAVER_SHOPPING_LOCAL_WORKER_SUBMIT_TIMEOUT_MS,
        DEFAULT_SUBMIT_TIMEOUT_MS,
        30_000,
        240_000,
      )
      : boundedInteger(
        env.MI_NAVER_SHOPPING_LOCAL_WORKER_API_TIMEOUT_MS,
        DEFAULT_REQUEST_TIMEOUT_MS,
        5_000,
        120_000,
      ),
  });
  let progressJob = null;
  const reportProgress = (stage, page, job = progressJob) => action({
    action: "progress",
    ...lanePayload,
    stage,
    page,
    ...jobProgressIdentity(job),
  });
  options.registerProgressSink?.(async (input = {}) => {
    if (!progressJob) throw new Error("local_worker_progress_job_missing");
    const page = Number(input.page || 0);
    if (input.stage !== "collect" || !Number.isSafeInteger(page) || page < 1 || page > 8) {
      throw new Error("local_worker_progress_invalid");
    }
    await reportProgress("collecting", page);
  });
  const provider = options.provider || createPlaywrightProvider({
    env: {
      ...env,
      NAVER_SHOPPING_PROVIDER_MODE: "playwright",
      NAVER_SHOPPING_PROVIDER_CHANNEL: "chromium",
      // The new msearch frontend is a local-worker-only, visible browser path.
      // A remote/headless collector must stay fail-closed instead of attempting
      // to imitate a user session or bypass Naver's access controls.
      NAVER_SHOPPING_PROVIDER_SEARCH_HOST: env.NAVER_SHOPPING_PROVIDER_SEARCH_HOST
        || "msearch.shopping.naver.com",
      NAVER_SHOPPING_PROVIDER_HEADLESS: env.NAVER_SHOPPING_PROVIDER_HEADLESS || "false",
      NAVER_SHOPPING_PROVIDER_TIMEOUT_MS: env.NAVER_SHOPPING_PROVIDER_TIMEOUT_MS || "225000",
      NAVER_SHOPPING_PROVIDER_USER_DATA_DIR: userDataDir,
    },
    autoVerify: false,
  });
  const summary = {
    status: "completed",
    claimed: 0,
    submitted: 0,
    failed: 0,
    releaseFailed: 0,
  };
  let laneClaimed = false;
  let effectiveMaxJobs = maxJobs;
  let probeTrackerId = null;

  try {
    const lane = await action({
      action: "claim-lane",
      ...lanePayload,
      workerRole: workerIdentity.workerRole,
    });
    if (lane.granted !== true) {
      summary.status = workerIdentity.workerRole === "standby" ? "standby" : "idle";
      summary.collectorLaneReason = String(lane.reason || "unavailable");
      if (options.requireWakeSignal === true) summary.remoteWake = false;
      return summary;
    }
    laneClaimed = true;
    probeTrackerId = String(lane.probeTrackerId || "").trim().toLowerCase() || null;
    if (probeTrackerId && !UUID_PATTERN.test(probeTrackerId)) {
      throw new Error("local_worker_probe_tracker_invalid");
    }
    if (probeTrackerId) effectiveMaxJobs = 1;
    if ([8, 10].includes(Number(lane.cadenceMinutes))) {
      summary.cadenceMinutes = Number(lane.cadenceMinutes);
    }
    if (options.requireWakeSignal === true) {
      const wake = await action({ action: "claim-wake", ...lanePayload });
      if (wake.wake !== true) {
        summary.status = "idle";
        summary.remoteWake = false;
        return summary;
      }
      summary.remoteWake = true;
    }
    if (options.queueAllTrackers === true || summary.remoteWake === true) {
      const queued = await action({ action: "queue-all-active-trackers", ...lanePayload });
      summary.queuedTotal = boundedResponseCount(queued.total, 100_000);
      summary.queued = boundedResponseCount(queued.queued, 100_000);
      summary.alreadyQueued = boundedResponseCount(queued.alreadyQueued, 100_000);
      summary.alreadyProcessing = boundedResponseCount(queued.alreadyProcessing, 100_000);
    }
    for (let index = 0; index < effectiveMaxJobs; index += 1) {
      // The v2 DB scheduler is the sole ordering and fairness authority. The
      // preference hint remains telemetry only; active cycles always go first.
      const trackerReserved = effectiveMaxJobs > 1
        && (index === effectiveMaxJobs - 1 || index % 3 === 2);
      const claim = await action({
        action: "claim",
        schedulerVersion: "v2",
        preferLookup: !trackerReserved,
        probeTrackerId,
        ...lanePayload,
      });
      if (!claim.job) break;
      const job = validateLocalWorkerJob(claim.job, {
        requireActiveLease: true,
        nowMs: options.nowMs?.() ?? Date.now(),
      });
      summary.claimed += job.claims.length;
      progressJob = job;
      const collectionStartedAt = options.nowMs?.() ?? Date.now();
      let resultAccounted = false;
      let controlFailureAttempted = false;
      try {
        await reportProgress("navigating", 0, job);
        const request = localWorkerRankRequest(
          job,
          options.nowMs?.() ?? Date.now(),
          boundedInteger(
            env.NAVER_SHOPPING_PROVIDER_TIMEOUT_MS,
            14 * 60_000,
            30_000,
            14 * 60_000,
          ),
        );
        const rawWindow = await provider.collect(request);
        const strictWindow = validateStrictLocalWorkerWindow(rawWindow, {
          keyword: job.keyword,
          nowMs: options.nowMs?.() ?? Date.now(),
        });
        await reportProgress("submitting", 8, job);
        const submitted = await action({
          action: "submit",
          ...lanePayload,
          job,
          window: strictWindow,
        });
        const committedCount = Number(submitted.committedCount || 0);
        const alreadyCommittedCount = Number(submitted.alreadyCommittedCount || 0);
        const leaseLostCount = Number(submitted.leaseLostCount || 0);
        const collectionConflictCount = Number(submitted.collectionConflictCount || 0);
        const processedCount = Number(submitted.processedCount || 0);
        if (
          !Number.isSafeInteger(committedCount)
          || !Number.isSafeInteger(alreadyCommittedCount)
          || !Number.isSafeInteger(leaseLostCount)
          || !Number.isSafeInteger(collectionConflictCount)
          || !Number.isSafeInteger(processedCount)
          || committedCount < 0
          || alreadyCommittedCount < 0
          || leaseLostCount < 0
          || collectionConflictCount < 0
          || processedCount < 0
          || processedCount !== job.claims.length
          || committedCount + alreadyCommittedCount + leaseLostCount + collectionConflictCount !== job.claims.length
        ) {
          throw new Error("local_worker_submit_incomplete");
        }
        summary.submitted += committedCount + alreadyCommittedCount;
        summary.failed += leaseLostCount + collectionConflictCount;
        resultAccounted = true;
        if (leaseLostCount + collectionConflictCount > 0) {
          restoreBaselineCadence(summary);
          const failureCode = leaseLostCount > 0
            ? "local_worker_lease_lost"
            : "local_worker_collection_conflict";
          controlFailureAttempted = true;
          const failure = await action({
            action: "record-failure",
            ...lanePayload,
            job,
            errorCode: failureCode,
            scope: "system",
          });
          if (failure.laneReleased === true) laneClaimed = false;
          if (String(failure.circuitState || "").toLowerCase() === "open") {
            log(`local_worker_run_halted:${failureCode}`);
          } else {
            log(`local_worker_system_failure_stopped:${failureCode}`);
          }
          break;
        } else {
          const success = await action({
            action: "record-success",
            ...lanePayload,
            job,
            collectionId: strictWindow.collectionId,
            checkedCount: strictWindow.checkedCount,
            excludedAdCount: strictWindow.excludedAdCount,
            durationMs: Math.max(0, Math.trunc((options.nowMs?.() ?? Date.now()) - collectionStartedAt)),
            source: strictWindow.source,
          });
          if (success.candidateEligible === true || success.cadenceEligible === true) {
            summary.cadenceEligible = true;
          }
        }
      } catch (error) {
        const failureCode = safeFailureCode(error);
        if (resultAccounted) {
          restoreBaselineCadence(summary);
          summary.status = "control_plane_failed";
          summary.controlPlaneFailed = Number(summary.controlPlaneFailed || 0) + 1;
          log(`local_worker_post_commit_control_failed:${failureCode}`);
          if (!controlFailureAttempted && laneClaimed) {
            try {
              const failureReport = await action({
                action: "record-failure",
                ...lanePayload,
                job,
                errorCode: "local_worker_post_commit_control_failed",
                scope: "system",
              });
              if (failureReport.laneReleased === true) laneClaimed = false;
            } catch (coordinationError) {
              log(`local_worker_failure_record_failed:${safeFailureCode(coordinationError)}`);
            }
          }
          break;
        }
        const partial = error?.result?.partial || {};
        const partialSubmitted = Math.min(
          job.claims.length,
          boundedResponseCount(partial.committedCount, job.claims.length)
            + boundedResponseCount(partial.alreadyCommittedCount, job.claims.length),
        );
        summary.submitted += partialSubmitted;
        summary.failed += job.claims.length - partialSubmitted;
        restoreBaselineCadence(summary);
        if (partialSubmitted === job.claims.length) {
          summary.status = "control_plane_failed";
          summary.controlPlaneFailed = Number(summary.controlPlaneFailed || 0) + 1;
          log(`local_worker_post_commit_control_failed:${failureCode}`);
          try {
            const failureReport = await action({
              action: "record-failure",
              ...lanePayload,
              job,
              errorCode: "local_worker_post_commit_control_failed",
              scope: "system",
            });
            if (failureReport.laneReleased === true) laneClaimed = false;
          } catch (coordinationError) {
            log(`local_worker_failure_record_failed:${safeFailureCode(coordinationError)}`);
          }
          break;
        }
        const scope = failureScope(job, failureCode);
        try {
          const released = await action({
            action: "fail",
            ...lanePayload,
            job,
            errorCode: failureCode,
          });
          const expectedReleaseMax = job.claims.length - partialSubmitted;
          const releasedCount = Number(released.releasedCount || 0);
          if (!Number.isSafeInteger(releasedCount) || releasedCount !== expectedReleaseMax) {
            summary.releaseFailed += expectedReleaseMax;
            log("local_worker_failure_release_invalid");
          }
        } catch (releaseError) {
          summary.releaseFailed += job.claims.length - partialSubmitted;
          log(`local_worker_failure_release_failed:${safeFailureCode(releaseError)}`);
        }
        let failureReport = null;
        try {
          const failureJobs = scope === "tracker"
            ? job.claims.slice(partialSubmitted).map((claim) => ({ ...job, claims: [claim] }))
            : [job];
          for (const failureJob of failureJobs) {
            // eslint-disable-next-line no-await-in-loop
            failureReport = await action({
              action: "record-failure",
              ...lanePayload,
              job: failureJob,
              errorCode: failureCode,
              scope,
            });
            if (failureReport.laneReleased === true) laneClaimed = false;
          }
        } catch (coordinationError) {
          log(`local_worker_failure_record_failed:${safeFailureCode(coordinationError)}`);
        }
        if (scope === "security") {
          try {
            const blocked = await action({
              action: "block-lane",
              ...lanePayload,
              errorCode: failureCode,
            });
            if (blocked.blocked === true) laneClaimed = false;
          } catch (coordinationError) {
            log(`local_worker_global_cooldown_failed:${safeFailureCode(coordinationError)}`);
          }
        }
        if (scope !== "tracker"
          || RUN_HALT_FAILURE_CODES.has(failureCode)
          || String(failureReport?.circuitState || "").toLowerCase() === "open") {
          if (RUN_HALT_FAILURE_CODES.has(failureCode)
            || String(failureReport?.circuitState || "").toLowerCase() === "open") {
            summary.haltedCode = failureCode;
            log(`local_worker_run_halted:${failureCode}`);
          } else {
            log(`local_worker_system_failure_stopped:${failureCode}`);
          }
          break;
        }
      } finally {
        progressJob = null;
      }
    }
    return summary;
  } finally {
    if (laneClaimed) {
      try {
        const released = await action({ action: "release-lane", ...lanePayload });
        if (released.released !== true) {
          summary.releaseFailed += 1;
          log("local_worker_lane_release_invalid");
        }
      } catch (error) {
        summary.releaseFailed += 1;
        log(`local_worker_lane_release_failed:${safeFailureCode(error)}`);
      }
    }
    await provider.close?.().catch(() => {});
    await releaseLock();
  }
}

const directlyExecuted = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (directlyExecuted) {
  runLocalShoppingWorker({ log: console.log })
    .then((summary) => {
      console.log(JSON.stringify(summary));
      if (summary.failed > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error?.message || "local_worker_failed");
      process.exitCode = 1;
    });
}

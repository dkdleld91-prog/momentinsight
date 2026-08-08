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
  "naver_navigation_invalid",
  "naver_network_restricted",
  "provider_deadline_exceeded",
  "provider_partial_window",
  "provider_browser_collection_failed",
  "local_worker_window_not_300",
  "local_worker_lease_lost",
  "local_worker_collection_conflict",
  "local_worker_submit_incomplete",
  "local_worker_submit_partial",
]);
const RUN_HALT_FAILURE_CODES = new Set([
  "naver_http_418",
  "naver_http_429",
  "naver_captcha_detected",
  "naver_auth_required",
  "naver_verification_required",
  "naver_next_data_missing",
  "naver_page_timeout",
  "naver_navigation_invalid",
  "naver_network_restricted",
]);

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
  const code = String(error?.code || error?.message || "").trim().toLowerCase();
  return SAFE_FAILURE_CODES.has(code) ? code : "local_worker_collection_failed";
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
  const maxJobs = boundedInteger(env.MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS, 100, 1, 500);
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

  try {
    if (options.queueAllTrackers === true) {
      const queued = await action({ action: "queue-all-active-trackers" });
      summary.queuedTotal = boundedResponseCount(queued.total, 100_000);
      summary.queued = boundedResponseCount(queued.queued, 100_000);
      summary.alreadyQueued = boundedResponseCount(queued.alreadyQueued, 100_000);
      summary.alreadyProcessing = boundedResponseCount(queued.alreadyProcessing, 100_000);
    }
    for (let index = 0; index < maxJobs; index += 1) {
      // Give interactive lookups a fast response while reserving every third
      // claim attempt for the existing 30-day tracker queue. The final slot is
      // always tracker-first so a deliberately small run budget cannot starve
      // scheduled history refreshes behind interactive requests.
      const trackerReserved = index === maxJobs - 1 || index % 3 === 2;
      const claim = await action({ action: "claim", preferLookup: !trackerReserved });
      if (!claim.job) break;
      const job = validateLocalWorkerJob(claim.job, {
        requireActiveLease: true,
        nowMs: options.nowMs?.() ?? Date.now(),
      });
      summary.claimed += job.claims.length;
      try {
        const request = localWorkerRankRequest(
          job,
          options.nowMs?.() ?? Date.now(),
          boundedInteger(env.NAVER_SHOPPING_PROVIDER_TIMEOUT_MS, 225_000, 30_000, 225_000),
        );
        const rawWindow = await provider.collect(request);
        const strictWindow = validateStrictLocalWorkerWindow(rawWindow, {
          keyword: job.keyword,
          nowMs: options.nowMs?.() ?? Date.now(),
        });
        const submitted = await action({ action: "submit", job, window: strictWindow });
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
      } catch (error) {
        const failureCode = safeFailureCode(error);
        const partial = error?.result?.partial || {};
        const partialSubmitted = Math.min(
          job.claims.length,
          boundedResponseCount(partial.committedCount, job.claims.length)
            + boundedResponseCount(partial.alreadyCommittedCount, job.claims.length),
        );
        summary.submitted += partialSubmitted;
        summary.failed += job.claims.length - partialSubmitted;
        try {
          const released = await action({
            action: "fail",
            job,
            errorCode: failureCode,
          });
          const expectedReleaseMax = job.claims.length - partialSubmitted;
          const releasedCount = Number(released.releasedCount || 0);
          if (!Number.isSafeInteger(releasedCount) || releasedCount < 0 || releasedCount > expectedReleaseMax) {
            summary.releaseFailed += expectedReleaseMax;
            log("local_worker_failure_release_invalid");
          }
        } catch (releaseError) {
          summary.releaseFailed += job.claims.length - partialSubmitted;
          log(`local_worker_failure_release_failed:${safeFailureCode(releaseError)}`);
        }
        if (RUN_HALT_FAILURE_CODES.has(failureCode)) {
          summary.haltedCode = failureCode;
          log(`local_worker_run_halted:${failureCode}`);
          break;
        }
      }
    }
    return summary;
  } finally {
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

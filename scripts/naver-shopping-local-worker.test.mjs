import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { localWorkerAuthInput, verifyLocalWorkerSignature } from "../src/server/local-worker-auth.mjs";
import {
  acquireWorkerLock,
  runLocalShoppingWorker,
} from "./naver-shopping-local-worker.mjs";

const SECRET = "local-worker-test-secret-with-at-least-32-bytes";
const NOW = Date.parse("2026-08-01T06:00:00.000Z");
const JOB = {
  keyword: "온열찜질기",
  limit: 300,
  claims: [{
    trackerId: "123e4567-e89b-42d3-a456-426614174000",
    leaseStartedAt: "2026-08-01T06:00:00.000Z",
    leaseUntil: "2026-08-01T06:12:00.000Z",
  }],
};

function item(index) {
  return {
    organicRank: index,
    isOrganic: true,
    isAd: false,
    productId: String(1000000000 + index),
    sellerProductId: String(2000000000 + index),
    title: `온열찜질기 ${index}`,
    link: `https://smartstore.naver.com/example/products/${2000000000 + index}`,
    productType: "2",
  };
}

function completeWindow(count = 300) {
  const items = Array.from({ length: count }, (_, index) => item(index + 1));
  return {
    ok: true,
    schemaVersion: "mi.naver-shopping-organic-window.v1",
    keyword: "온열찜질기",
    source: "naver_shopping_results_collector",
    rankEvidence: "naver_shopping_organic_list",
    collectionId: "pw-1785564000000-workerfixture0001",
    collectedAt: "2026-08-01T06:00:00.000Z",
    complete: true,
    partial: false,
    sourceExhausted: count < 300,
    marketTotal: null,
    marketTotalStatus: "unavailable",
    checkedCount: count,
    rawCount: count,
    excludedAdCount: 0,
    items,
  };
}

function workerEnv() {
  return {
    MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
    MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET: SECRET,
    MI_NAVER_SHOPPING_LOCAL_WORKER_API_URL: "https://insight.momentlabs.co.kr/api/naver-shopping-local-worker",
    MI_NAVER_SHOPPING_WORKER_ID: "test-primary-worker",
    MI_NAVER_SHOPPING_WORKER_ROLE: "primary",
  };
}

function authenticatedFetch(responses, calls, coordination = {}) {
  return async (url, options) => {
    const body = String(options.body || "");
    const request = new Request(String(url), {
      method: options.method,
      headers: options.headers,
      body,
    });
    const auth = verifyLocalWorkerSignature(localWorkerAuthInput(request, body), {
      nowSeconds: Math.trunc(NOW / 1000),
      env: workerEnv(),
    });
    assert.equal(auth.ok, true);
    const payload = JSON.parse(body);
    if (["claim-lane", "release-lane", "block-lane"].includes(payload.action)) {
      calls.coordination ||= [];
      calls.coordination.push(payload);
      const coordinationBody = payload.action === "claim-lane"
        ? (coordination.claimLane || { ok: true, granted: true, reason: "granted" })
        : payload.action === "release-lane"
          ? { ok: true, released: true }
          : { ok: true, blocked: true };
      return Response.json(coordinationBody);
    }
    calls.push(payload);
    const responseFixture = responses.shift();
    assert.ok(responseFixture, "unexpected worker API call");
    return Response.json(responseFixture.body, { status: responseFixture.status || 200 });
  };
}

function uuidSequence() {
  let count = 0;
  return () => `worker-nonce-${String(++count).padStart(8, "0")}`;
}

function assertZshSyntax(scriptPath, source) {
  const lint = spawnSync("/bin/zsh", ["-n", fileURLToPath(scriptPath)], { encoding: "utf8" });
  if (lint.error?.code === "ENOENT") {
    assert.match(source, /^#!\/bin\/zsh\r?\n/u);
    assert.doesNotMatch(source, /\r/u);
    return;
  }
  assert.equal(lint.status, 0, lint.stderr);
}

test("stays completely off until the local worker flag is enabled", async () => {
  const summary = await runLocalShoppingWorker({ env: {}, skipLock: true });
  assert.deepEqual(summary, {
    status: "disabled", claimed: 0, submitted: 0, failed: 0, releaseFailed: 0,
  });
});

test("atomically recovers a lock left by a force-killed worker", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mi-worker-lock-test-"));
  const lockPath = path.join(root, "worker.lock");
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL("./naver-shopping-local-worker.mjs", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { acquireWorkerLock } from ${JSON.stringify(moduleUrl)};
     await acquireWorkerLock(${JSON.stringify(lockPath)});
     process.stdout.write("locked\\n");
     setInterval(() => {}, 1000);`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child_lock_timeout")), 5_000);
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));

  const release = await acquireWorkerLock(lockPath);
  assert.equal(typeof release, "function");
  await release();
  await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
});

test("rejects a worker API origin outside the explicit production/local allowlist", async () => {
  await assert.rejects(
    runLocalShoppingWorker({
      env: {
        ...workerEnv(),
        MI_NAVER_SHOPPING_LOCAL_WORKER_API_URL: "https://attacker.invalid/api/naver-shopping-local-worker",
      },
      provider: { async collect() {}, async close() {} },
      skipLock: true,
    }),
    /local_worker_api_origin_not_allowed/,
  );
});

test("rejects an unsafe dedicated profile before making the first signed claim", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    runLocalShoppingWorker({
      env: {
        ...workerEnv(),
        NAVER_SHOPPING_PROVIDER_USER_DATA_DIR: "relative/profile",
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("unexpected_fetch");
      },
      skipLock: true,
    }),
    /provider_profile_path_not_allowed/u,
  );
  assert.equal(fetchCalls, 0);
});

test("launch wrapper keeps catch-up retries bounded and remains valid zsh", async () => {
  const scriptPath = new URL("./run-naver-shopping-local-worker.sh", import.meta.url);
  const source = await fs.readFile(scriptPath, "utf8");
  assert.match(source, /MAX_ATTEMPTS=3/u);
  assert.match(source, /BACKOFF_SECONDS=\$\(\( ATTEMPT \* 300 \)\)/u);
  assert.match(source, /umask 077/u);
  assert.match(source, /NaverShoppingProfile/u);
  assert.match(source, /\.moment-insight-profile-v1/u);
  assert.match(source, /\.moment-insight-authenticated-v1/u);
  assert.match(source, /NAVER_SHOPPING_PROVIDER_USER_DATA_DIR/u);
  assert.match(source, /local_worker_profile_not_initialized/u);
  assert.doesNotMatch(source, /HAD_FAILURE/u);
  assert.doesNotMatch(source, /STATUS=0/u);
  assertZshSyntax(scriptPath, source);
});

test("launch agent polls safely between the two fixed daily slots", async () => {
  const plistPath = new URL("./co.kr.momentinsight.naver-shopping-local-worker.plist.template", import.meta.url);
  const source = await fs.readFile(plistPath, "utf8");
  assert.match(source, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/u);
  assert.match(source, /<key>Hour<\/key>\s*<integer>9<\/integer>/u);
  assert.match(source, /<key>Hour<\/key>\s*<integer>15<\/integer>/u);
  assert.match(source, /<key>MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS<\/key>\s*<string>25<\/string>/u);
  assert.match(source, /<key>NAVER_SHOPPING_PROVIDER_SEARCH_HOST<\/key>\s*<string>msearch\.shopping\.naver\.com<\/string>/u);
  assert.match(source, /<key>NAVER_SHOPPING_PROVIDER_HEADLESS<\/key>\s*<string>false<\/string>/u);
});

test("installer refuses to start launchd before the dedicated profile is authenticated", async () => {
  const installerPath = new URL("./install-naver-shopping-local-worker.sh", import.meta.url);
  const source = await fs.readFile(installerPath, "utf8");
  assert.match(source, /umask 077/u);
  assert.match(source, /NaverShoppingProfile/u);
  assert.match(source, /\.moment-insight-profile-v1/u);
  assert.match(source, /\.moment-insight-authenticated-v1/u);
  assert.match(source, /local_worker_profile_not_initialized/u);
  assert.ok(source.indexOf("local_worker_profile_not_initialized") < source.indexOf("launchctl bootstrap"));
  assertZshSyntax(installerPath, source);
});

test("profile bootstrap uses only the dedicated local browser and never extracts credentials", async () => {
  const bootstrapPath = new URL("./bootstrap-naver-shopping-profile.mjs", import.meta.url);
  const source = await fs.readFile(bootstrapPath, "utf8");
  assert.match(source, /defaultNaverShoppingProfileDir\(\)/u);
  assert.match(source, /launchPersistentContext\(PROFILE_DIRECTORY/u);
  assert.match(source, /msearch\.shopping\.naver\.com/u);
  assert.match(source, /search\.shopping\.naver\.com\/search\/all/u);
  assert.match(source, /productSet=total/u);
  assert.match(source, /sort=rel/u);
  assert.doesNotMatch(source, /search\.shopping\.naver\.com\/ns\/search/u);
  assert.match(source, /headless:\s*false/u);
  assert.match(source, /mkdir\(PROFILE_DIRECTORY, \{ recursive: true, mode: 0o700 \}\)/u);
  assert.match(source, /flag:\s*"wx"/u);
  assert.doesNotMatch(source, /\.cookies\s*\(/u);
  assert.doesNotMatch(source, /\.storageState\s*\(/u);
  assert.doesNotMatch(source, /\.fill\s*\(/u);
  assert.doesNotMatch(source, /password/iu);
  assert.doesNotMatch(source, /window\.ncaptcha\?\.f\s*\(/u);
  assert.doesNotMatch(source, /x-wtm-ncaptcha-token/iu);
  const syntax = spawnSync(process.execPath, ["--check", fileURLToPath(bootstrapPath)], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("claims one canonical keyword, submits one strict 300 window and drains catch-up", async () => {
  const calls = [];
  let collectCount = 0;
  let closed = false;
  const provider = {
    async collect(request) {
      collectCount += 1;
      assert.equal(request.keyword, JOB.keyword);
      assert.equal(request.limit, 300);
      return completeWindow();
    },
    async close() { closed = true; },
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: {
      ok: true,
      committedCount: 1,
      alreadyCommittedCount: 0,
      leaseLostCount: 0,
      collectionConflictCount: 0,
      processedCount: 1,
    } },
    { body: { ok: true, job: null } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed", claimed: 1, submitted: 1, failed: 0, releaseFailed: 0,
  });
  assert.equal(collectCount, 1);
  assert.equal(closed, true);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "claim"]);
  assert.equal(calls[1].window.checkedCount, 300);
  assert.equal(calls[1].window.collectionId, "pw-1785564000000-workerfixture0001");
});

test("one approved manual run queues every active tracker before the bounded drain", async () => {
  const calls = [];
  const provider = {
    async collect() { return completeWindow(); },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, total: 71, queued: 69, alreadyQueued: 0, alreadyProcessing: 2 } },
    { body: { ok: true, job: JOB } },
    { body: {
      ok: true,
      committedCount: 1,
      alreadyCommittedCount: 0,
      leaseLostCount: 0,
      collectionConflictCount: 0,
      processedCount: 1,
    } },
    { body: { ok: true, job: null } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    queueAllTrackers: true,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed",
    claimed: 1,
    submitted: 1,
    failed: 0,
    releaseFailed: 0,
    queuedTotal: 71,
    queued: 69,
    alreadyQueued: 0,
    alreadyProcessing: 2,
  });
  assert.deepEqual(calls.map((call) => call.action), [
    "queue-all-active-trackers",
    "claim",
    "submit",
    "claim",
  ]);
});

test("remote polling exits without opening Naver when no wake is pending", async () => {
  const calls = [];
  let collectCount = 0;
  let closed = false;
  const provider = {
    async collect() { collectCount += 1; },
    async close() { closed = true; },
  };
  const summary = await runLocalShoppingWorker({
    env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "25" },
    fetchImpl: authenticatedFetch([
      { body: { ok: true, wake: false } },
    ], calls),
    provider,
    requireWakeSignal: true,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "idle",
    claimed: 0,
    submitted: 0,
    failed: 0,
    releaseFailed: 0,
    remoteWake: false,
  });
  assert.equal(collectCount, 0);
  assert.equal(closed, true);
  assert.deepEqual(calls.map((call) => call.action), ["claim-wake"]);
});

test("standby leaves the remote wake untouched while the Windows primary is online", async () => {
  const calls = [];
  let collectCount = 0;
  const summary = await runLocalShoppingWorker({
    env: {
      ...workerEnv(),
      MI_NAVER_SHOPPING_WORKER_ID: "test-standby-worker",
      MI_NAVER_SHOPPING_WORKER_ROLE: "standby",
    },
    fetchImpl: authenticatedFetch([], calls, {
      claimLane: { ok: true, granted: false, reason: "primary_online" },
    }),
    provider: {
      async collect() { collectCount += 1; },
      async close() {},
    },
    requireWakeSignal: true,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.equal(summary.status, "standby");
  assert.equal(summary.collectorLaneReason, "primary_online");
  assert.equal(summary.remoteWake, false);
  assert.equal(collectCount, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(calls.coordination.map((call) => call.action), ["claim-lane"]);
});

test("one remote wake runs at most one queued job even with a larger configured budget", async () => {
  const calls = [];
  let collectCount = 0;
  const provider = {
    async collect() { collectCount += 1; return completeWindow(); },
    async close() {},
  };
  const summary = await runLocalShoppingWorker({
    env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "25" },
    fetchImpl: authenticatedFetch([
      { body: { ok: true, wake: true } },
      { body: { ok: true, job: JOB } },
      { body: {
        ok: true,
        committedCount: 1,
        alreadyCommittedCount: 0,
        leaseLostCount: 0,
        collectionConflictCount: 0,
        processedCount: 1,
      } },
    ], calls),
    provider,
    requireWakeSignal: true,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed",
    claimed: 1,
    submitted: 1,
    failed: 0,
    releaseFailed: 0,
    remoteWake: true,
  });
  assert.equal(collectCount, 1);
  assert.deepEqual(calls.map((call) => call.action), ["claim-wake", "claim", "submit"]);
});

test("a two-job safety budget still reserves one claim for 30-day trackers", async () => {
  const calls = [];
  const secondJob = {
    ...JOB,
    claims: [{
      ...JOB.claims[0],
      trackerId: "123e4567-e89b-42d3-a456-426614174001",
    }],
  };
  const provider = {
    async collect() { return completeWindow(); },
    async close() {},
  };
  const completed = {
    ok: true,
    committedCount: 1,
    alreadyCommittedCount: 0,
    leaseLostCount: 0,
    collectionConflictCount: 0,
    processedCount: 1,
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: completed },
    { body: { ok: true, job: secondJob } },
    { body: completed },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "2" },
    fetchImpl,
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.equal(summary.submitted, 2);
  assert.deepEqual(
    calls.filter((call) => call.action === "claim").map((call) => call.preferLookup),
    [true, false],
  );
});

test("never submits a short source-exhausted window and releases the lease as failure", async () => {
  const calls = [];
  const provider = {
    async collect() { return completeWindow(299); },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail", "claim"]);
  assert.equal(calls[1].errorCode, "local_worker_window_not_300");
  assert.equal(calls.some((call) => call.action === "submit"), false);
});

test("stops the batch after Naver requests verification and preserves all unclaimed work", async () => {
  const calls = [];
  const logs = [];
  let collectCount = 0;
  const provider = {
    async collect() {
      collectCount += 1;
      throw new Error("naver_verification_required");
    },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    log: (value) => logs.push(value),
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 0,
    haltedCode: "naver_verification_required",
  });
  assert.equal(collectCount, 1);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail"]);
  assert.equal(calls[1].errorCode, "naver_verification_required");
  assert.match(logs.join("\n"), /local_worker_run_halted:naver_verification_required/u);
});

test("stops the batch on a Naver network restriction and preserves all unclaimed work", async () => {
  const calls = [];
  const logs = [];
  const provider = {
    async collect() { throw new Error("naver_network_restricted"); },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    log: (value) => logs.push(value),
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.equal(summary.haltedCode, "naver_network_restricted");
  assert.equal(summary.submitted, 0);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail"]);
  assert.equal(calls[1].errorCode, "naver_network_restricted");
  assert.match(logs.join("\n"), /local_worker_run_halted:naver_network_restricted/u);
});

test("treats any lease-lost submit result as a failed batch and releases the claim", async () => {
  const calls = [];
  const provider = {
    async collect() { return completeWindow(); },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: {
      ok: true,
      committedCount: 0,
      alreadyCommittedCount: 0,
      leaseLostCount: 1,
      collectionConflictCount: 0,
      processedCount: 1,
    } },
    { body: { ok: true, job: null } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "claim"]);
});

test("treats a server collection conflict as a failed batch and releases the claim", async () => {
  const calls = [];
  const provider = {
    async collect() { return completeWindow(); },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { status: 409, body: { ok: false, code: "LOCAL_WORKER_COLLECTION_CONFLICT" } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "fail", "claim"]);
  assert.equal(calls[2].errorCode, "local_worker_collection_conflict");
});

test("accounts for server-reported partial commits without counting them as failed", async () => {
  const calls = [];
  const twoClaimJob = {
    ...JOB,
    claims: [
      ...JOB.claims,
      {
        trackerId: "123e4567-e89b-42d3-a456-426614174001",
        leaseStartedAt: "2026-08-01T06:00:00.000Z",
        leaseUntil: "2026-08-01T06:12:00.000Z",
      },
    ],
  };
  const provider = {
    async collect() { return completeWindow(); },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: twoClaimJob } },
    {
      status: 503,
      body: {
        ok: false,
        code: "db_unavailable",
        partial: {
          committedCount: 1,
          alreadyCommittedCount: 0,
          leaseLostCount: 0,
          collectionConflictCount: 0,
          processedCount: 1,
        },
      },
    },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed", claimed: 2, submitted: 1, failed: 1, releaseFailed: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "fail", "claim"]);
});

test("makes failure-release transport errors visible in the final summary", async () => {
  const calls = [];
  const logs = [];
  const provider = {
    async collect() { return completeWindow(299); },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { status: 503, body: { ok: false, code: "nonce_store_unavailable" } },
    { body: { ok: true, job: null } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    log: (value) => logs.push(value),
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 1,
  });
  assert.match(logs.join("\n"), /local_worker_failure_release_failed/);
});

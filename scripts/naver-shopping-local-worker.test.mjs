import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { localWorkerAuthInput, verifyLocalWorkerSignature } from "../src/server/local-worker-auth.mjs";
import {
  LOCAL_WORKER_BODY_MAX_BYTES,
  STABLE_FINITE_CANARY_KEYWORD,
  STABLE_FINITE_CANARY_TRACKER_ID,
} from "../src/server/naver-shopping/local-worker-contract.mjs";
import {
  STABLE_FINITE_WINDOW_PROOF_VERSION,
  stableFiniteWindowDigest,
} from "../tools/naver-shopping-rank-collector/src/contract.mjs";
import {
  acquireWorkerLock,
  runLocalShoppingWorker,
} from "./naver-shopping-local-worker.mjs";

const SECRET = "local-worker-test-secret-with-at-least-32-bytes";
const NOW = Date.parse("2026-08-01T06:00:00.000Z");
const RUNTIME_FINGERPRINT = "a".repeat(64);
const JOB = {
  keyword: "온열찜질기",
  limit: 300,
  claims: [{
    trackerId: "123e4567-e89b-42d3-a456-426614174000",
    leaseStartedAt: "2026-08-01T06:00:00.000Z",
    leaseUntil: "2026-08-01T06:12:00.000Z",
  }],
};
const LOOKUP_JOB = {
  kind: "lookup",
  keyword: "온열찜질기",
  limit: 300,
  claims: [{
    lookupJobId: "123e4567-e89b-42d3-a456-426614174010",
    leaseStartedAt: "2026-08-01T06:00:00.000Z",
    leaseUntil: "2026-08-01T06:12:00.000Z",
  }],
};
const FINITE_CANARY_JOB = {
  keyword: STABLE_FINITE_CANARY_KEYWORD,
  limit: 300,
  claims: [{
    trackerId: STABLE_FINITE_CANARY_TRACKER_ID,
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

function stableFiniteWindow() {
  const items = Array.from({ length: 93 }, (_, index) => ({
    ...item(index + 1),
    title: `아이쉘 차량용 거치대 ${index + 1}`,
    productType: 2,
  }));
  const digest = stableFiniteWindowDigest(items, {
    keyword: STABLE_FINITE_CANARY_KEYWORD,
    marketTotal: items.length,
  });
  return {
    ...completeWindow(items.length),
    keyword: STABLE_FINITE_CANARY_KEYWORD,
    collectionId: "pw-1785564000000-stablefinite0001",
    marketTotal: items.length,
    marketTotalStatus: "verified",
    items,
    finiteWindowProof: {
      version: STABLE_FINITE_WINDOW_PROOF_VERSION,
      passCount: 2,
      pageCount: 8,
      pageSize: 40,
      captureIds: ["finite-capture-0001", "finite-capture-0002"],
      passDigests: [digest, digest],
      marketTotal: items.length,
      checkedCount: items.length,
    },
  };
}

function workerEnv() {
  return {
    MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
    MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET: SECRET,
    MI_NAVER_SHOPPING_LOCAL_WORKER_API_URL: "https://insight.momentlabs.co.kr/api/naver-shopping-local-worker",
    MI_NAVER_SHOPPING_WORKER_ID: "windows-desktop-primary",
    MI_NAVER_SHOPPING_WORKER_ROLE: "primary",
    MI_NAVER_SHOPPING_RUNTIME_VERSION: "1.1.17",
    MI_NAVER_SHOPPING_RUNTIME_FINGERPRINT: RUNTIME_FINGERPRINT,
    MI_NAVER_SHOPPING_RUN_TRIGGER: "rank-catch-up",
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
    if ([
      "claim-lane",
      "release-lane",
      "block-lane",
      "progress",
      "record-success",
      "record-failure",
    ].includes(payload.action)) {
      calls.coordination ||= [];
      calls.coordination.push(payload);
      const coordinationFixture = payload.action === "claim-lane"
        ? (coordination.claimLane || { ok: true, granted: true, reason: "granted" })
        : payload.action === "release-lane"
          ? (coordination.releaseLane || { ok: true, released: true })
          : payload.action === "block-lane"
            ? { ok: true, blocked: true }
            : payload.action === "progress"
              ? { ok: true, recorded: true }
              : payload.action === "record-success"
                ? (coordination.recordSuccess
                  || { ok: true, recorded: true, circuitState: "closed", cadenceEligible: false })
                : (coordination.recordFailure
                  || { ok: true, recorded: true, circuitState: "closed", failureStreak: 1 });
      const coordinationBody = coordinationFixture.body || coordinationFixture;
      return Response.json(coordinationBody, { status: coordinationFixture.status || 200 });
    }
    calls.push(payload);
    const responseFixture = responses.shift();
    assert.ok(responseFixture, "unexpected worker API call");
    if (responseFixture.error) throw responseFixture.error;
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
    status: "disabled", claimed: 0, submitted: 0, failed: 0, releaseFailed: 0, atomicSuccesses: 0,
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

test("rejects stale runtime identity before the first signed lane claim", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    runLocalShoppingWorker({
      env: { ...workerEnv(), MI_NAVER_SHOPPING_RUNTIME_VERSION: "1.0.48" },
      fetchImpl: async () => { fetchCalls += 1; },
      provider: { async collect() {}, async close() {} },
      skipLock: true,
    }),
    /local_worker_runtime_identity_invalid/u,
  );
  assert.equal(fetchCalls, 0);
});

test("rejects an unclassified run trigger before the first signed lane claim", async () => {
  await assert.rejects(
    runLocalShoppingWorker({
      env: { ...workerEnv(), MI_NAVER_SHOPPING_RUN_TRIGGER: "unknown-trigger" },
      skipLock: true,
      fetchImpl: async () => {
        throw new Error("run_trigger_must_fail_before_network");
      },
    }),
    /local_worker_run_trigger_invalid/u,
  );
});

test("derives a content fingerprint for the direct Mac standby fallback", async () => {
  const calls = [];
  const env = workerEnv();
  delete env.MI_NAVER_SHOPPING_RUNTIME_VERSION;
  delete env.MI_NAVER_SHOPPING_RUNTIME_FINGERPRINT;
  const summary = await runLocalShoppingWorker({
    env,
    fetchImpl: authenticatedFetch([{ body: { ok: true, job: null } }], calls),
    provider: { async collect() {}, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.equal(summary.status, "completed");
  const lane = calls.coordination.find((call) => call.action === "claim-lane");
  assert.equal(lane.runtimeVersion, "1.1.17");
  assert.equal(lane.runTrigger, "rank-catch-up");
  assert.match(lane.runtimeFingerprint, /^(?!0{64}$)[a-f0-9]{64}$/u);
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

test("worker runner pins the v2 cycle scheduler without a v1 fallback", async () => {
  const source = await fs.readFile(new URL("./naver-shopping-local-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /action: "claim",\s*\n\s*schedulerVersion: "v2"/u);
  assert.doesNotMatch(source, /schedulerVersion: "v1"/u);
});

test("claims one canonical keyword, submits one strict 300 window and drains catch-up", async () => {
  const calls = [];
  let collectCount = 0;
  let closed = false;
  let progressSink = null;
  const provider = {
    async collect(request) {
      collectCount += 1;
      assert.equal(request.keyword, JOB.keyword);
      assert.equal(request.limit, 300);
      await progressSink({ stage: "collect", page: 1 });
      await progressSink({ stage: "collect", page: 8 });
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
    registerProgressSink(sink) { progressSink = sink; },
  });
  assert.deepEqual(summary, {
    status: "completed", claimed: 1, submitted: 1, failed: 0, releaseFailed: 0, atomicSuccesses: 1,
  });
  assert.equal(summary.atomicSuccesses, 1);
  assert.equal(collectCount, 1);
  assert.equal(closed, true);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "claim"]);
  assert.equal(calls[1].window.checkedCount, 300);
  assert.equal(calls[1].window.collectionId, "pw-1785564000000-workerfixture0001");
  assert.equal(calls[0].schedulerVersion, "v2");
  const coordination = calls.coordination;
  assert.equal(coordination[0].runtimeVersion, "1.1.17");
  assert.equal(coordination[0].runTrigger, "rank-catch-up");
  assert.equal(coordination[0].runtimeFingerprint, RUNTIME_FINGERPRINT);
  assert.deepEqual(
    coordination.filter((call) => call.action === "progress").map((call) => [call.stage, call.page]),
    [["navigating", 0], ["collecting", 1], ["collecting", 8], ["submitting", 8]],
  );
  assert.equal(coordination.filter((call) => call.action === "record-success").length, 1);
  assert.equal(coordination.at(-1).action, "release-lane");
});

test("submits one stable finite canary without recording an atomic300 success", async () => {
  const calls = [];
  const finiteModes = [];
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: FINITE_CANARY_JOB } },
    { body: {
      ok: true,
      committedCount: 1,
      alreadyCommittedCount: 0,
      leaseLostCount: 0,
      collectionConflictCount: 0,
      processedCount: 1,
      finiteCommittedCount: 1,
    } },
    { body: { ok: true, job: null } },
  ], calls);
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider: {
      async collect(_request, options) {
        finiteModes.push(options?.allowStableFinite);
        return stableFiniteWindow();
      },
      async close() {},
    },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.equal(summary.submitted, 1);
  assert.equal(summary.atomicSuccesses, 0);
  assert.equal(summary.finiteWindowCommits, 1);
  assert.deepEqual(finiteModes, [true]);
  assert.equal(calls.coordination[0].runTrigger, "rank-catch-up");
  assert.equal(calls.coordination[0].workerId, "windows-desktop-primary");
  assert.equal(calls.coordination[0].runtimeVersion, "1.1.17");
  assert.equal(calls.coordination[0].runtimeFingerprint, RUNTIME_FINGERPRINT);
  assert.equal(calls.coordination.some((call) => call.action === "record-success"), false);
  assert.equal(calls.coordination.at(-1).action, "release-lane");
});

test("keeps stable finite pre-collection disabled outside the exact Windows catch-up identity", async (t) => {
  for (const scenario of [
    { name: "rank-0900", env: { MI_NAVER_SHOPPING_RUN_TRIGGER: "rank-0900" } },
    { name: "rank-1500", env: { MI_NAVER_SHOPPING_RUN_TRIGGER: "rank-1500" } },
    { name: "manual", env: { MI_NAVER_SHOPPING_RUN_TRIGGER: "manual" } },
    { name: "remote", env: { MI_NAVER_SHOPPING_RUN_TRIGGER: "rank-remote" } },
    {
      name: "mac standby",
      env: {
        MI_NAVER_SHOPPING_RUN_TRIGGER: "mac-standby",
        MI_NAVER_SHOPPING_WORKER_ID: "macbook-standby",
      },
    },
    { name: "other worker", env: { MI_NAVER_SHOPPING_WORKER_ID: "other-primary-worker" } },
  ]) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const finiteModes = [];
      const ordinaryCanaryWindow = {
        ...completeWindow(),
        keyword: STABLE_FINITE_CANARY_KEYWORD,
      };
      const summary = await runLocalShoppingWorker({
        env: { ...workerEnv(), ...scenario.env },
        fetchImpl: authenticatedFetch([
          { body: { ok: true, job: FINITE_CANARY_JOB } },
          { body: {
            ok: true,
            committedCount: 1,
            alreadyCommittedCount: 0,
            leaseLostCount: 0,
            collectionConflictCount: 0,
            processedCount: 1,
          } },
          { body: { ok: true, job: null } },
        ], calls),
        provider: {
          async collect(_request, options) {
            finiteModes.push(options?.allowStableFinite);
            return ordinaryCanaryWindow;
          },
          async close() {},
        },
        nowMs: () => NOW,
        randomUUID: uuidSequence(),
        skipLock: true,
      });

      assert.equal(summary.submitted, 1);
      assert.equal(summary.atomicSuccesses, 1);
      assert.deepEqual(finiteModes, [false]);
      assert.equal(calls[1].window.finiteWindowProof, undefined);
    });
  }
});

test("never reaches stable finite collection when registration rejects a wrong runtime fingerprint", async () => {
  const calls = [];
  let collectCalls = 0;
  await assert.rejects(
    runLocalShoppingWorker({
      env: {
        ...workerEnv(),
        MI_NAVER_SHOPPING_RUNTIME_FINGERPRINT: "b".repeat(64),
      },
      fetchImpl: authenticatedFetch([], calls, {
        claimLane: {
          status: 400,
          body: { ok: false, code: "LOCAL_WORKER_RUNTIME_IDENTITY_INVALID" },
        },
      }),
      provider: {
        async collect() {
          collectCalls += 1;
          return stableFiniteWindow();
        },
        async close() {},
      },
      nowMs: () => NOW,
      randomUUID: uuidSequence(),
      skipLock: true,
    }),
    /LOCAL_WORKER_RUNTIME_IDENTITY_INVALID/u,
  );

  assert.equal(collectCalls, 0);
  assert.equal(calls.some((call) => call.action === "claim"), false);
  assert.equal(calls.coordination[0].action, "claim-lane");
  assert.equal(calls.coordination.length, 1);
});

test("keeps stable finite proof and exact-match failures tracker-isolated and cadence-neutral", async (t) => {
  for (const scenario of [
    {
      name: "two-capture proof rejected",
      expectedCode: "provider_stable_finite_window_unproven",
      responses: [
        { body: { ok: true, job: FINITE_CANARY_JOB } },
        { body: { ok: true, releasedCount: 1 } },
        { body: { ok: true, job: null } },
      ],
      provider: {
        async collect() {
          const error = new Error("provider_stable_finite_window_unproven");
          error.code = "provider_stable_finite_window_unproven";
          error.detail = "digest_mismatch";
          throw error;
        },
        async close() {},
      },
    },
    {
      name: "exact finite parent match rejected",
      expectedCode: "local_worker_finite_match_invalid",
      responses: [
        { body: { ok: true, job: FINITE_CANARY_JOB } },
        { status: 422, body: { ok: false, code: "LOCAL_WORKER_FINITE_MATCH_INVALID" } },
        { body: { ok: true, releasedCount: 1 } },
        { body: { ok: true, job: null } },
      ],
      provider: {
        async collect() { return stableFiniteWindow(); },
        async close() {},
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const summary = await runLocalShoppingWorker({
        env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "2" },
        fetchImpl: authenticatedFetch(scenario.responses, calls, {
          claimLane: { ok: true, granted: true, reason: "granted", cadenceMinutes: 6 },
          recordFailure: {
            ok: true,
            recorded: true,
            circuitState: "closed",
            cadenceProofPreserved: true,
          },
        }),
        provider: scenario.provider,
        nowMs: () => NOW,
        randomUUID: uuidSequence(),
        skipLock: true,
      });

      assert.equal(summary.status, "completed");
      assert.equal(summary.failed, 1);
      assert.equal(summary.atomicSuccesses, 0);
      assert.equal(summary.cadenceMinutes, 6);
      const failures = calls.coordination.filter((call) => call.action === "record-failure");
      assert.equal(failures.length, 1);
      assert.equal(failures[0].scope, "tracker");
      assert.equal(failures[0].errorCode, scenario.expectedCode);
      assert.equal(calls.coordination.some((call) => call.action === "record-success"), false);
      assert.equal(calls.coordination.at(-1).action, "release-lane");
    });
  }
});

test("reconciles a lost stable finite submit as already committed without touching cadence success or failure ledgers", async () => {
  const calls = [];
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: FINITE_CANARY_JOB } },
      { error: new TypeError("submit response lost after finite commit") },
      {
        body: {
          ok: true,
          committedCount: 0,
          alreadyCommittedCount: 1,
          leaseLostCount: 0,
          collectionConflictCount: 0,
          uncommittedCount: 0,
          processedCount: 1,
          finiteCommittedCount: 1,
          claimResults: [{
            claimId: STABLE_FINITE_CANARY_TRACKER_ID,
            status: "already_committed",
          }],
        },
      },
      { body: { ok: true, job: null } },
    ], calls, {
      claimLane: { ok: true, granted: true, reason: "granted", cadenceMinutes: 6 },
    }),
    provider: {
      async collect() { return stableFiniteWindow(); },
      async close() {},
    },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.submitted, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.atomicSuccesses, 0);
  assert.equal(summary.finiteWindowCommits, 1);
  assert.equal(summary.cadenceMinutes, 6);
  assert.deepEqual(
    calls.map((call) => call.action),
    ["claim", "submit", "reconcile-submit", "claim"],
  );
  assert.equal(calls.coordination.some((call) => call.action === "record-success"), false);
  assert.equal(calls.coordination.some((call) => call.action === "record-failure"), false);
  assert.equal(calls.coordination.at(-1).action, "release-lane");
});

test("fails closed when a lost finite submit reconciles only to a non-finite snapshot", async () => {
  const calls = [];
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: FINITE_CANARY_JOB } },
      { error: new TypeError("submit response lost before finite proof was confirmed") },
      {
        body: {
          ok: true,
          committedCount: 0,
          alreadyCommittedCount: 1,
          leaseLostCount: 0,
          collectionConflictCount: 0,
          uncommittedCount: 0,
          processedCount: 1,
          finiteCommittedCount: 0,
          claimResults: [{
            claimId: STABLE_FINITE_CANARY_TRACKER_ID,
            status: "already_committed",
          }],
        },
      },
    ], calls, {
      claimLane: { ok: true, granted: true, reason: "granted", cadenceMinutes: 6 },
    }),
    provider: {
      async collect() { return stableFiniteWindow(); },
      async close() {},
    },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.equal(summary.status, "control_plane_failed");
  assert.equal(summary.submitted, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.atomicSuccesses, 0);
  assert.equal(summary.finiteWindowCommits, undefined);
  assert.equal(summary.cadenceMinutes, 10);
  assert.deepEqual(
    calls.map((call) => call.action),
    ["claim", "submit", "reconcile-submit"],
  );
  const failures = calls.coordination.filter((call) => call.action === "record-failure");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, "local_worker_post_commit_control_failed");
  assert.equal(calls.coordination.some((call) => call.action === "record-success"), false);
  assert.equal(calls.coordination.at(-1).action, "release-lane");
});

test("never fails or double-counts an atomically committed job after control-plane reporting fails", async () => {
  const calls = [];
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: JOB } },
      { body: {
        ok: true,
        committedCount: 1,
        alreadyCommittedCount: 0,
        leaseLostCount: 0,
        collectionConflictCount: 0,
        processedCount: 1,
      } },
    ], calls, {
      recordSuccess: { status: 503, body: { ok: false, code: "LOCAL_WORKER_COORDINATION_UNAVAILABLE" } },
    }),
    provider: { async collect() { return completeWindow(); }, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "control_plane_failed",
    claimed: 1,
    submitted: 1,
    failed: 0,
    releaseFailed: 0,
    atomicSuccesses: 0,
    controlPlaneFailed: 1,
  });
  assert.equal(summary.atomicSuccesses, 0);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit"]);
  assert.equal(calls.some((call) => call.action === "fail"), false);
  assert.deepEqual(
    calls.coordination.map((call) => call.action),
    ["claim-lane", "progress", "progress", "record-success", "record-failure", "release-lane"],
  );
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
    atomicSuccesses: 1,
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
    atomicSuccesses: 0,
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

test("surfaces a failed finite lane release instead of reporting silent success", async () => {
  const calls = [];
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: null } },
    ], calls, { releaseLane: { ok: true, released: false } }),
    provider: { async collect() {}, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.equal(summary.releaseFailed, 1);
  assert.deepEqual(calls.map((call) => call.action), ["claim"]);
  assert.equal(calls.coordination.at(-1).action, "release-lane");
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
      { body: { ok: true, total: 65, queued: 65, alreadyQueued: 0, alreadyProcessing: 0 } },
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
    atomicSuccesses: 1,
    remoteWake: true,
    queuedTotal: 65,
    queued: 65,
    alreadyQueued: 0,
    alreadyProcessing: 0,
  });
  assert.equal(collectCount, 1);
  assert.deepEqual(calls.map((call) => call.action), [
    "claim-wake",
    "queue-all-active-trackers",
    "claim",
    "submit",
  ]);
  assert.equal(calls.find((call) => call.action === "claim")?.preferLookup, true);
});

test("an automatic circuit recovery queues trackers first and runs exactly one probe job", async () => {
  const calls = [];
  let collectCount = 0;
  const summary = await runLocalShoppingWorker({
    env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "25" },
    fetchImpl: authenticatedFetch([
      { body: { ok: true, total: 74, queued: 0, alreadyQueued: 74, alreadyProcessing: 0 } },
      { body: { ok: true, job: JOB } },
      { body: {
        ok: true,
        committedCount: 1,
        alreadyCommittedCount: 0,
        leaseLostCount: 0,
        collectionConflictCount: 0,
        processedCount: 1,
      } },
    ], calls, {
      claimLane: {
        ok: true,
        granted: true,
        reason: "granted",
        autoRecovery: true,
        probeTrackerId: null,
        cadenceMinutes: 10,
      },
    }),
    provider: {
      async collect() { collectCount += 1; return completeWindow(); },
      async close() {},
    },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.equal(summary.submitted, 1);
  assert.equal(summary.atomicSuccesses, 1);
  assert.equal(collectCount, 1);
  assert.deepEqual(calls.map((call) => call.action), [
    "queue-all-active-trackers",
    "claim",
    "submit",
  ]);
  assert.equal(calls.filter((call) => call.action === "claim").length, 1);
  assert.equal(calls.find((call) => call.action === "claim")?.autoRecovery, true);
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
  assert.equal(summary.atomicSuccesses, 2);
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
  ], calls, {
    claimLane: { ok: true, granted: true, reason: "granted", cadenceMinutes: 6 },
  });
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.deepEqual(summary, {
    status: "completed",
    claimed: 1,
    submitted: 0,
    failed: 1,
    releaseFailed: 0,
    atomicSuccesses: 0,
    cadenceMinutes: 10,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail", "claim"]);
  assert.equal(calls[1].errorCode, "local_worker_window_not_300");
  assert.equal(calls.some((call) => call.action === "submit"), false);
});

test("isolates a short strict window to its tracker and continues the next keyword", async () => {
  const calls = [];
  const nextJob = {
    ...JOB,
    keyword: "남자팬티",
    claims: [{
      ...JOB.claims[0],
      trackerId: "123e4567-e89b-42d3-a456-426614174001",
    }],
  };
  let collectCount = 0;
  const summary = await runLocalShoppingWorker({
    env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "2" },
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: JOB } },
      { body: { ok: true, releasedCount: 1 } },
      { body: { ok: true, job: nextJob } },
      { body: {
        ok: true,
        committedCount: 1,
        alreadyCommittedCount: 0,
        leaseLostCount: 0,
        collectionConflictCount: 0,
        processedCount: 1,
      } },
    ], calls),
    provider: {
      async collect(request) {
        collectCount += 1;
        return collectCount === 1
          ? completeWindow(299)
          : { ...completeWindow(), keyword: request.keyword };
      },
      async close() {},
    },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.deepEqual(summary, {
    status: "completed", claimed: 2, submitted: 1, failed: 1, releaseFailed: 0, atomicSuccesses: 1,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail", "claim", "submit"]);
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "tracker");
  assert.equal(failure.errorCode, "local_worker_window_not_300");
  assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
});

test("keeps an isolated lookup-window failure out of the global circuit", async () => {
  const calls = [];
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: LOOKUP_JOB } },
      { body: { ok: true, releasedCount: 1 } },
    ], calls),
    provider: {
      async collect() {
        const error = new Error("provider_partial_window");
        error.code = "provider_partial_window";
        error.detail = "92/300";
        throw error;
      },
      async close() {},
    },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.equal(summary.failed, 1);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail"]);
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "lookup");
  assert.equal(failure.errorCode, "provider_partial_window:92_300");
  assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
});

test("keeps a stale lookup claim mismatch out of the 30-day global circuit", async () => {
  const calls = [];
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: LOOKUP_JOB } },
      {
        status: 409,
        body: { ok: false, code: "LOCAL_WORKER_LOOKUP_MISMATCH" },
      },
      { body: { ok: true, releasedCount: 1 } },
    ], calls),
    provider: {
      async collect() { return completeWindow(); },
      async close() {},
    },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.equal(summary.failed, 1);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "fail"]);
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.errorCode, "local_worker_lookup_mismatch");
  assert.equal(failure.scope, "lookup");
  assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
});

test("keeps lookup-only submit failures out of the 30-day global circuit", async (t) => {
  for (const causeCode of [
    "LOCAL_WORKER_COMMIT_INVALID",
    "LOCAL_WORKER_COMMIT_UNAVAILABLE",
    "LOCAL_WORKER_SUBMIT_FAILED",
  ]) {
    await t.test(causeCode, async () => {
      const calls = [];
      await runLocalShoppingWorker({
        env: workerEnv(),
        fetchImpl: authenticatedFetch([
          { body: { ok: true, job: LOOKUP_JOB } },
          {
            status: 409,
            body: {
              ok: false,
              code: "LOCAL_WORKER_SUBMIT_PARTIAL",
              partial: {
                causeCode,
                committedCount: 0,
                alreadyCommittedCount: 0,
                leaseLostCount: 0,
                collectionConflictCount: 0,
                processedCount: 0,
                claimResults: [],
              },
            },
          },
          { body: { ok: true, releasedCount: 1 } },
        ], calls),
        provider: {
          async collect() { return completeWindow(); },
          async close() {},
        },
        nowMs: () => NOW,
        randomUUID: uuidSequence(),
        skipLock: true,
      });

      const failure = calls.coordination.find((call) => call.action === "record-failure");
      assert.equal(failure.errorCode, causeCode.toLowerCase());
      assert.equal(failure.scope, "lookup");
      assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
    });
  }
});

test("keeps two repeated lookup submit-outcome ambiguities fail-closed and off the global circuit", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const calls = [];
    const summary = await runLocalShoppingWorker({
      env: workerEnv(),
      fetchImpl: authenticatedFetch([
        { body: { ok: true, job: LOOKUP_JOB } },
        { error: new TypeError("submit response lost") },
        { error: new TypeError("reconciliation unavailable") },
      ], calls),
      provider: { async collect() { return completeWindow(); }, async close() {} },
      nowMs: () => NOW,
      randomUUID: uuidSequence(),
      skipLock: true,
    });

    assert.equal(summary.status, "control_plane_failed");
    assert.equal(summary.submitted, 0);
    assert.equal(summary.failed, 0);
    assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "reconcile-submit"]);
    assert.equal(calls.some((call) => call.action === "fail"), false);
    const failures = calls.coordination.filter((call) => call.action === "record-failure");
    assert.deepEqual(failures.map((failure) => failure.scope), ["lookup"]);
    assert.deepEqual(failures[0].job.claims, LOOKUP_JOB.claims);
    assert.equal(failures[0].job.claims.some((claim) => "trackerId" in claim), false);
    assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
  }
});

test("does not count two repeated exact lookup reconciliations as N30 successes or system failures", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const calls = [];
    const summary = await runLocalShoppingWorker({
      env: workerEnv(),
      fetchImpl: authenticatedFetch([
        { body: { ok: true, job: LOOKUP_JOB } },
        { error: new TypeError("submit response lost after commit") },
        {
          body: {
            ok: true,
            committedCount: 0,
            alreadyCommittedCount: 1,
            leaseLostCount: 0,
            collectionConflictCount: 0,
            uncommittedCount: 0,
            processedCount: 1,
            claimResults: [{
              claimId: LOOKUP_JOB.claims[0].lookupJobId,
              status: "already_committed",
            }],
          },
        },
      ], calls),
      provider: { async collect() { return completeWindow(); }, async close() {} },
      nowMs: () => NOW,
      randomUUID: uuidSequence(),
      skipLock: true,
    });

    assert.equal(summary.status, "control_plane_failed");
    assert.equal(summary.submitted, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.atomicSuccesses, 0);
    assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "reconcile-submit"]);
    assert.equal(calls.some((call) => call.action === "fail"), false);
    assert.equal(calls.coordination.some((call) => call.action === "record-success"), false);
    const failures = calls.coordination.filter((call) => call.action === "record-failure");
    assert.deepEqual(failures.map((failure) => failure.scope), ["lookup"]);
    assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
  }
});

test("keeps every reconciled non-commit lookup outcome isolated with exact claim order", async (t) => {
  for (const [status, expectsFail] of [
    ["uncommitted", true],
    ["lease_lost", false],
    ["collection_conflict", false],
  ]) {
    await t.test(status, async () => {
      const calls = [];
      const responses = [
        { body: { ok: true, job: LOOKUP_JOB } },
        { error: new TypeError("submit response lost") },
        {
          body: {
            ok: true,
            committedCount: 0,
            alreadyCommittedCount: 0,
            leaseLostCount: status === "lease_lost" ? 1 : 0,
            collectionConflictCount: status === "collection_conflict" ? 1 : 0,
            uncommittedCount: status === "uncommitted" ? 1 : 0,
            processedCount: 1,
            claimResults: [{ claimId: LOOKUP_JOB.claims[0].lookupJobId, status }],
          },
        },
      ];
      if (expectsFail) responses.push({ body: { ok: true, releasedCount: 1 } });
      const summary = await runLocalShoppingWorker({
        env: workerEnv(),
        fetchImpl: authenticatedFetch(responses, calls),
        provider: { async collect() { return completeWindow(); }, async close() {} },
        nowMs: () => NOW,
        randomUUID: uuidSequence(),
        skipLock: true,
      });

      assert.equal(summary.submitted, 0);
      assert.equal(summary.failed, 1);
      assert.deepEqual(
        calls.map((call) => call.action),
        expectsFail
          ? ["claim", "submit", "reconcile-submit", "fail"]
          : ["claim", "submit", "reconcile-submit"],
      );
      if (expectsFail) assert.deepEqual(calls.at(-1).job.claims, LOOKUP_JOB.claims);
      const failures = calls.coordination.filter((call) => call.action === "record-failure");
      assert.deepEqual(failures.map((failure) => failure.scope), ["lookup"]);
      assert.equal(calls.coordination.some((call) => call.action === "record-success"), false);
      assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
    });
  }
});

test("does not count a successful one-off lookup as N30 proof or disturb the following tracker", async () => {
  const calls = [];
  const committed = {
    body: {
      ok: true,
      committedCount: 1,
      alreadyCommittedCount: 0,
      leaseLostCount: 0,
      collectionConflictCount: 0,
      processedCount: 1,
    },
  };
  const summary = await runLocalShoppingWorker({
    env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "2" },
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: LOOKUP_JOB } },
      committed,
      { body: { ok: true, job: JOB } },
      committed,
    ], calls),
    provider: { async collect() { return completeWindow(); }, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.equal(summary.submitted, 2);
  assert.equal(summary.atomicSuccesses, 1);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "claim", "submit"]);
  assert.equal(calls[0].preferLookup, true);
  assert.equal(calls[2].preferLookup, false);
  assert.deepEqual(calls[1].job.claims, LOOKUP_JOB.claims);
  assert.deepEqual(calls[3].job.claims, JOB.claims);
  const successes = calls.coordination.filter((call) => call.action === "record-success");
  assert.equal(successes.length, 1);
  assert.deepEqual(successes[0].job.claims, JOB.claims);
  assert.equal(calls.coordination.some((call) => call.action === "record-failure"), false);
});

test("fails closed when the failure RPC releases fewer claims than requested", async () => {
  const calls = [];
  const logs = [];
  const provider = {
    async collect() { return completeWindow(299); },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 0 } },
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
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 1, atomicSuccesses: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail", "claim"]);
  assert.match(logs.join("\n"), /local_worker_failure_release_invalid/u);
});

test("preserves a bounded native parser failure detail for production diagnosis", async () => {
  const calls = [];
  const provider = {
    async collect() {
      const error = new Error("naver_next_data_schema_drift");
      error.code = "naver_next_data_schema_drift";
      error.detail = "props.pageProps.searchParam.query";
      throw error;
    },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls);
  await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.equal(
    calls[1].errorCode,
    "naver_next_data_schema_drift:props_pageprops_searchparam_query",
  );
});

test("preserves a bounded internal failure code instead of hiding the live cause", async () => {
  const calls = [];
  const provider = {
    async collect() {
      const error = new Error("local_worker_commit_invalid");
      error.code = "local_worker_commit_invalid";
      throw error;
    },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls);
  await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });
  assert.equal(calls[1].errorCode, "local_worker_commit_invalid");
});

test("preserves a native request-id mismatch, skips submit and releases the lane", async () => {
  const calls = [];
  const provider = {
    async collect() {
      const error = new Error("native_host_request_id_mismatch");
      error.code = "native_host_request_id_mismatch";
      throw error;
    },
    async close() {},
  };
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: JOB } },
      { body: { ok: true, releasedCount: 1 } },
    ], calls),
    provider,
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.deepEqual(summary, {
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 0, atomicSuccesses: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail"]);
  assert.equal(calls[1].errorCode, "native_host_request_id_mismatch");
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "system");
  assert.equal(failure.errorCode, "native_host_request_id_mismatch");
  assert.equal(calls.coordination.at(-1).action, "release-lane");
});

test("isolates duplicate provider identity to its tracker group and continues the next worker pass", async () => {
  const calls = [];
  const logs = [];
  const rawDetail = "https://shopping.example/private?keyword=secret-keyword&seller=raw-identity";
  const nextJob = {
    ...JOB,
    keyword: "남자팬티",
    claims: [{
      ...JOB.claims[0],
      trackerId: "123e4567-e89b-42d3-a456-426614174001",
    }],
  };
  let collectCount = 0;
  const provider = {
    async collect(request) {
      collectCount += 1;
      if (collectCount === 1) {
        const error = new Error("provider_duplicate_identity");
        error.code = `provider_duplicate_identity:${rawDetail}`;
        error.detail = rawDetail;
        throw error;
      }
      return { ...completeWindow(), keyword: request.keyword };
    },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: nextJob } },
    { body: {
      ok: true,
      committedCount: 1,
      alreadyCommittedCount: 0,
      leaseLostCount: 0,
      collectionConflictCount: 0,
      processedCount: 1,
    } },
  ], calls);

  const summary = await runLocalShoppingWorker({
    env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "2" },
    fetchImpl,
    provider,
    log: (value) => logs.push(value),
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.deepEqual(summary, {
    status: "completed", claimed: 2, submitted: 1, failed: 1, releaseFailed: 0, atomicSuccesses: 1,
  });
  assert.equal(collectCount, 2);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail", "claim", "submit"]);
  assert.equal(calls[1].errorCode, "provider_duplicate_identity");
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "tracker");
  assert.equal(failure.errorCode, "provider_duplicate_identity");
  assert.deepEqual(failure.job.claims, JOB.claims);
  assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
  assert.equal(calls.coordination.filter((call) => call.action === "record-success").length, 1);
  assert.doesNotMatch(JSON.stringify({
    calls: [...calls],
    coordination: calls.coordination,
    logs,
  }), /secret-keyword|raw-identity|shopping\.example/u);
});

test("preserves only a bounded duplicate diagnostic suffix and keeps tracker failure scope", async () => {
  const calls = [];
  const provider = {
    async collect() {
      const error = new Error("provider_duplicate_identity");
      error.code = "provider_duplicate_identity";
      error.detail = "3:26:page_overlap:2";
      throw error;
    },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls);

  await runLocalShoppingWorker({
    env: workerEnv(), fetchImpl, provider, nowMs: () => NOW,
    randomUUID: uuidSequence(), skipLock: true,
  });

  assert.equal(calls[1].errorCode, "provider_duplicate_identity:3:26:page_overlap:2");
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.errorCode, "provider_duplicate_identity:3:26:page_overlap:2");
  assert.equal(failure.scope, "tracker");
});

test("isolates an unproven stable window to its tracker and preserves only a finite reason", async () => {
  const calls = [];
  const provider = {
    async collect() {
      const error = new Error("provider_stable_window_unproven");
      error.code = "provider_stable_window_unproven";
      error.detail = "digest_mismatch";
      throw error;
    },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls);

  await runLocalShoppingWorker({
    env: workerEnv(), fetchImpl, provider, nowMs: () => NOW,
    randomUUID: uuidSequence(), skipLock: true,
  });

  assert.equal(calls[1].errorCode, "provider_stable_window_unproven:digest_mismatch");
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.errorCode, "provider_stable_window_unproven:digest_mismatch");
  assert.equal(failure.scope, "tracker");
  assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
});

test("isolates a strict partial window to one tracker instead of opening the global circuit", async () => {
  const calls = [];
  const provider = {
    async collect() {
      const error = new Error("provider_partial_window");
      error.code = "provider_partial_window";
      error.detail = "40/300";
      throw error;
    },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls, {
    claimLane: { ok: true, granted: true, reason: "granted", cadenceMinutes: 6 },
    recordFailure: {
      ok: true,
      recorded: true,
      circuitState: "closed",
      cadenceProofPreserved: true,
    },
  });

  const summary = await runLocalShoppingWorker({
    env: workerEnv(), fetchImpl, provider, nowMs: () => NOW,
    randomUUID: uuidSequence(), skipLock: true,
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.trackerPartialWindowFailures, 1);
  assert.equal(summary.cadenceMinutes, 6);
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "tracker");
  assert.equal(failure.errorCode, "provider_partial_window:40_300");
  assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
});

test("does not classify a non-strict partial-window detail as cadence-preserving", async () => {
  const calls = [];
  const provider = {
    async collect() {
      const error = new Error("provider_partial_window");
      error.code = "provider_partial_window";
      error.detail = "300/300";
      throw error;
    },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls, {
    claimLane: { ok: true, granted: true, reason: "granted", cadenceMinutes: 6 },
  });

  const summary = await runLocalShoppingWorker({
    env: workerEnv(), fetchImpl, provider, nowMs: () => NOW,
    randomUUID: uuidSequence(), skipLock: true,
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.trackerPartialWindowFailures ?? 0, 0);
  assert.equal(summary.cadenceMinutes, 10);
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "tracker");
  assert.match(failure.errorCode, /^provider_partial_window:/u);
});

test("requires an explicit database acknowledgement before preserving partial-window cadence", async (t) => {
  for (const [label, recordFailure] of [
    ["missing acknowledgement", {
      ok: true, recorded: true, circuitState: "closed",
    }],
    ["false acknowledgement", {
      ok: true, recorded: true, circuitState: "closed", cadenceProofPreserved: false,
    }],
  ]) {
    await t.test(label, async () => {
      const calls = [];
      const provider = {
        async collect() {
          const error = new Error("provider_partial_window");
          error.code = "provider_partial_window";
          error.detail = "40/300";
          throw error;
        },
        async close() {},
      };
      const fetchImpl = authenticatedFetch([
        { body: { ok: true, job: JOB } },
        { body: { ok: true, releasedCount: 1 } },
        { body: { ok: true, job: null } },
      ], calls, {
        claimLane: { ok: true, granted: true, reason: "granted", cadenceMinutes: 6 },
        recordFailure,
      });

      const summary = await runLocalShoppingWorker({
        env: workerEnv(), fetchImpl, provider, nowMs: () => NOW,
        randomUUID: uuidSequence(), skipLock: true,
      });

      assert.equal(summary.failed, 1);
      assert.equal(summary.trackerPartialWindowFailures ?? 0, 0);
      assert.equal(summary.cadenceMinutes, 10);
    });
  }
});

test("preserves only the exact 1, 99 and 299-of-300 tracker boundaries", async (t) => {
  for (const organicCount of [1, 99, 299]) {
    await t.test(`${organicCount}/300`, async () => {
      const calls = [];
      const provider = {
        async collect() {
          const error = new Error("provider_partial_window");
          error.code = "provider_partial_window";
          error.detail = `${organicCount}/300`;
          throw error;
        },
        async close() {},
      };
      const fetchImpl = authenticatedFetch([
        { body: { ok: true, job: JOB } },
        { body: { ok: true, releasedCount: 1 } },
        { body: { ok: true, job: null } },
      ], calls, {
        claimLane: { ok: true, granted: true, reason: "granted", cadenceMinutes: 6 },
        recordFailure: {
          ok: true,
          recorded: true,
          circuitState: "closed",
          cadenceProofPreserved: true,
        },
      });

      const summary = await runLocalShoppingWorker({
        env: workerEnv(), fetchImpl, provider, nowMs: () => NOW,
        randomUUID: uuidSequence(), skipLock: true,
      });

      assert.equal(summary.failed, 1);
      assert.equal(summary.trackerPartialWindowFailures, 1);
      assert.equal(summary.cadenceMinutes, 6);
      const failure = calls.coordination.find((call) => call.action === "record-failure");
      assert.equal(failure.errorCode, `provider_partial_window:${organicCount}_300`);
    });
  }
});

test("preserves grouped partial cadence only after every failed claim receives DB approval", async () => {
  const calls = [];
  const groupedJob = {
    ...JOB,
    claims: [
      JOB.claims[0],
      {
        ...JOB.claims[0],
        trackerId: "123e4567-e89b-42d3-a456-426614174001",
      },
    ],
  };
  const provider = {
    async collect() {
      const error = new Error("provider_partial_window");
      error.code = "provider_partial_window";
      error.detail = "299/300";
      throw error;
    },
    async close() {},
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: groupedJob } },
    { body: { ok: true, releasedCount: 2 } },
    { body: { ok: true, job: null } },
  ], calls, {
    claimLane: { ok: true, granted: true, reason: "granted", cadenceMinutes: 6 },
    recordFailure: {
      ok: true,
      recorded: true,
      circuitState: "closed",
      cadenceProofPreserved: true,
    },
  });

  const summary = await runLocalShoppingWorker({
    env: workerEnv(), fetchImpl, provider, nowMs: () => NOW,
    randomUUID: uuidSequence(), skipLock: true,
  });

  assert.equal(summary.failed, 2);
  assert.equal(summary.trackerPartialWindowFailures, 2);
  assert.equal(summary.cadenceMinutes, 6);
  assert.equal(
    calls.coordination.filter((call) => call.action === "record-failure").length,
    2,
  );
});

test("maps an upstream submit 413 to one tracker-scoped oversized-payload failure", async () => {
  const calls = [];
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { status: 413, body: { ok: false, message: "request too large" } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls);

  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider: { async collect() { return completeWindow(); }, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.equal(summary.failed, 1);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "fail", "claim"]);
  assert.equal(calls[2].errorCode, "local_worker_submit_body_too_large");
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "tracker");
  assert.equal(failure.errorCode, "local_worker_submit_body_too_large");
  assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
});

test("rejects an oversized submit locally and isolates it before network upload", async () => {
  const calls = [];
  const oversizedWindow = completeWindow();
  oversizedWindow.items[0].padding = "x".repeat(LOCAL_WORKER_BODY_MAX_BYTES);
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: JOB } },
    { body: { ok: true, releasedCount: 1 } },
    { body: { ok: true, job: null } },
  ], calls);

  await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider: { async collect() { return oversizedWindow; }, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail", "claim"]);
  assert.equal(calls[1].errorCode, "local_worker_submit_body_too_large");
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "tracker");
});

test("isolates malformed provider rows to their keyword group and continues the next keyword", async (t) => {
  for (const errorCode of [
    "provider_row_invalid",
    "provider_row_title_missing",
    "provider_row_identity_missing",
  ]) {
    await t.test(errorCode, async () => {
      const calls = [];
      const groupedJob = {
        ...JOB,
        claims: [
          JOB.claims[0],
          {
            ...JOB.claims[0],
            trackerId: "123e4567-e89b-42d3-a456-426614174002",
          },
        ],
      };
      const nextJob = {
        ...JOB,
        keyword: "남자팬티",
        claims: [{
          ...JOB.claims[0],
          trackerId: "123e4567-e89b-42d3-a456-426614174003",
        }],
      };
      let collectCount = 0;
      const provider = {
        async collect(request) {
          collectCount += 1;
          if (collectCount === 1) {
            const error = new Error(errorCode);
            error.code = errorCode;
            error.detail = "3:26";
            throw error;
          }
          return { ...completeWindow(), keyword: request.keyword };
        },
        async close() {},
      };
      const summary = await runLocalShoppingWorker({
        env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "2" },
        fetchImpl: authenticatedFetch([
          { body: { ok: true, job: groupedJob } },
          { body: { ok: true, releasedCount: 2 } },
          { body: { ok: true, job: nextJob } },
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
        nowMs: () => NOW,
        randomUUID: uuidSequence(),
        skipLock: true,
      });

      assert.deepEqual(summary, {
        status: "completed", claimed: 3, submitted: 1, failed: 2, releaseFailed: 0, atomicSuccesses: 1,
      });
      assert.equal(collectCount, 2);
      assert.deepEqual(calls.map((call) => call.action), ["claim", "fail", "claim", "submit"]);
      assert.equal(calls[1].errorCode, `${errorCode}:3:26`);
      const failures = calls.coordination.filter((call) => call.action === "record-failure");
      assert.equal(failures.length, 2);
      assert.deepEqual(
        failures.map((failure) => failure.job.claims[0].trackerId).sort(),
        groupedJob.claims.map((claim) => claim.trackerId).sort(),
      );
      assert.ok(failures.every((failure) => failure.scope === "tracker"));
      assert.ok(failures.every((failure) => failure.errorCode === `${errorCode}:3:26`));
      assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
      assert.equal(calls.coordination.filter((call) => call.action === "record-success").length, 1);
    });
  }
});

test("isolates an exact rank-drift group and continues the next scheduled keyword", async () => {
  const calls = [];
  const firstJob = JOB;
  const nextJob = {
    ...JOB,
    keyword: "남자팬티",
    claims: [{
      ...JOB.claims[0],
      trackerId: "123e4567-e89b-42d3-a456-426614174004",
    }],
  };
  let collectCount = 0;
  const provider = {
    async collect(request) {
      collectCount += 1;
      if (collectCount === 1) {
        const error = new Error("naver_next_data_rank_drift");
        error.code = "naver_next_data_rank_drift";
        error.detail = "p1:i17:r10:e9:a1:h0:s1";
        throw error;
      }
      return { ...completeWindow(), keyword: request.keyword };
    },
    async close() {},
  };

  const summary = await runLocalShoppingWorker({
    env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "2" },
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: firstJob } },
      { body: { ok: true, releasedCount: 1 } },
      { body: { ok: true, job: nextJob } },
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
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.deepEqual(summary, {
    status: "completed", claimed: 2, submitted: 1, failed: 1, releaseFailed: 0, atomicSuccesses: 1,
  });
  assert.equal(collectCount, 2);
  assert.deepEqual(calls.map((call) => call.action), ["claim", "fail", "claim", "submit"]);
  assert.equal(calls[1].errorCode, "naver_next_data_rank_drift:p1:i17:r10:e9:a1:h0:s1");
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "tracker");
  assert.equal(calls.coordination.some((call) => call.action === "block-lane"), false);
  assert.equal(calls.coordination.filter((call) => call.action === "record-success").length, 1);
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
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 0, atomicSuccesses: 0,
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
  const failure = calls.coordination.find((call) => call.action === "record-failure");
  assert.equal(failure.scope, "security");
  assert.equal(calls.coordination.filter((call) => call.action === "block-lane").length, 1);
});

test("treats explicit Naver access denial and HTTP 403 as security blocks", async (t) => {
  for (const errorCode of ["naver_access_blocked", "naver_http_403"]) {
    await t.test(errorCode, async () => {
      const calls = [];
      const rawSecret = "<html>private-access-denied-body</html>";
      const summary = await runLocalShoppingWorker({
        env: workerEnv(),
        fetchImpl: authenticatedFetch([
          { body: { ok: true, job: JOB } },
          { body: { ok: true, releasedCount: 1 } },
        ], calls),
        provider: {
          async collect() {
            const error = new Error(errorCode);
            error.code = errorCode;
            error.detail = rawSecret;
            throw error;
          },
          async close() {},
        },
        nowMs: () => NOW,
        randomUUID: uuidSequence(),
        skipLock: true,
      });

      assert.equal(summary.haltedCode, errorCode);
      assert.deepEqual(calls.map((call) => call.action), ["claim", "fail"]);
      const failure = calls.coordination.find((call) => call.action === "record-failure");
      assert.equal(failure.scope, "security");
      assert.equal(failure.errorCode, errorCode);
      assert.equal(calls.coordination.filter((call) => call.action === "block-lane").length, 1);
      assert.doesNotMatch(JSON.stringify({ calls, coordination: calls.coordination }), /private-access-denied-body/u);
    });
  }
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
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 0, atomicSuccesses: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit"]);
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
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 0, atomicSuccesses: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "fail"]);
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
          claimResults: [{
            claimId: twoClaimJob.claims[0].trackerId,
            status: "committed",
          }],
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
    status: "completed", claimed: 2, submitted: 1, failed: 1, releaseFailed: 0, atomicSuccesses: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "fail"]);
  assert.deepEqual(calls[2].job.claims, [twoClaimJob.claims[1]]);
});

test("uses only bounded submit-partial cause codes for failure signatures and scope", async (t) => {
  const cases = [
    ["LOCAL_WORKER_MATCH_RESULT_INCOMPLETE", "local_worker_match_result_incomplete", "tracker"],
    ["LOCAL_WORKER_COMMIT_INVALID", "local_worker_commit_invalid", "system"],
    ["LOCAL_WORKER_COMMIT_UNAVAILABLE", "local_worker_commit_unavailable", "system"],
    ["LOCAL_WORKER_SUBMIT_FAILED", "local_worker_submit_failed", "system"],
    ["raw_database_secret_sqlstate_XX999", "local_worker_submit_partial", "system"],
  ];
  for (const [causeCode, expectedCode, expectedScope] of cases) {
    await t.test(causeCode, async () => {
      const calls = [];
      const twoClaimJob = {
        ...JOB,
        claims: [
          JOB.claims[0],
          {
            ...JOB.claims[0],
            trackerId: "123e4567-e89b-42d3-a456-426614174001",
          },
        ],
      };
      const responses = [
        { body: { ok: true, job: twoClaimJob } },
        {
          status: 409,
          body: {
            ok: false,
            code: "LOCAL_WORKER_SUBMIT_PARTIAL",
            partial: {
              causeCode,
              committedCount: 1,
              alreadyCommittedCount: 0,
              leaseLostCount: 0,
              collectionConflictCount: 0,
              processedCount: 1,
              claimResults: [{
                claimId: twoClaimJob.claims[0].trackerId,
                status: "committed",
              }],
            },
          },
        },
        { body: { ok: true, releasedCount: 1 } },
      ];
      if (expectedScope === "tracker") responses.push({ body: { ok: true, job: null } });
      await runLocalShoppingWorker({
        env: { ...workerEnv(), MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS: "2" },
        fetchImpl: authenticatedFetch(responses, calls),
        provider: { async collect() { return completeWindow(); }, async close() {} },
        nowMs: () => NOW,
        randomUUID: uuidSequence(),
        skipLock: true,
      });

      const failure = calls.coordination.find((call) => call.action === "record-failure");
      assert.equal(failure.errorCode, expectedCode);
      assert.equal(failure.scope, expectedScope);
      assert.deepEqual(calls.find((call) => call.action === "fail").job.claims, [twoClaimJob.claims[1]]);
      assert.doesNotMatch(JSON.stringify({ calls, coordination: calls.coordination }), /raw_database_secret|xx999/iu);
    });
  }
});

test("uses explicit claim ids instead of a processed prefix after mixed partial outcomes", async () => {
  const calls = [];
  const threeClaimJob = {
    ...JOB,
    claims: [
      JOB.claims[0],
      {
        ...JOB.claims[0],
        trackerId: "123e4567-e89b-42d3-a456-426614174001",
      },
      {
        ...JOB.claims[0],
        trackerId: "123e4567-e89b-42d3-a456-426614174002",
      },
    ],
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: threeClaimJob } },
    {
      status: 409,
      body: {
        ok: false,
        code: "LOCAL_WORKER_SUBMIT_PARTIAL",
        partial: {
          committedCount: 1,
          alreadyCommittedCount: 0,
          leaseLostCount: 1,
          collectionConflictCount: 0,
          processedCount: 2,
          claimResults: [
            { claimId: threeClaimJob.claims[0].trackerId, status: "committed" },
            { claimId: threeClaimJob.claims[2].trackerId, status: "lease_lost" },
          ],
        },
      },
    },
    { body: { ok: true, releasedCount: 1 } },
  ], calls);

  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider: { async collect() { return completeWindow(); }, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.deepEqual(summary, {
    status: "completed", claimed: 3, submitted: 1, failed: 2, releaseFailed: 0, atomicSuccesses: 0,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "fail"]);
  assert.deepEqual(calls[2].job.claims, [threeClaimJob.claims[1]]);
});

test("reconciles a lost grouped-submit response and fails only exact uncommitted claim ids", async () => {
  const calls = [];
  const threeClaimJob = {
    ...JOB,
    claims: [
      JOB.claims[0],
      {
        ...JOB.claims[0],
        trackerId: "123e4567-e89b-42d3-a456-426614174001",
      },
      {
        ...JOB.claims[0],
        trackerId: "123e4567-e89b-42d3-a456-426614174002",
      },
    ],
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: threeClaimJob } },
    { error: new TypeError("socket closed after commit") },
    {
      body: {
        ok: true,
        committedCount: 0,
        alreadyCommittedCount: 2,
        leaseLostCount: 0,
        collectionConflictCount: 0,
        uncommittedCount: 1,
        processedCount: 3,
        claimResults: [
          { claimId: threeClaimJob.claims[0].trackerId, status: "already_committed" },
          { claimId: threeClaimJob.claims[1].trackerId, status: "uncommitted" },
          { claimId: threeClaimJob.claims[2].trackerId, status: "already_committed" },
        ],
      },
    },
    { body: { ok: true, releasedCount: 1 } },
  ], calls);

  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider: { async collect() { return completeWindow(); }, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.deepEqual(summary, {
    status: "completed", claimed: 3, submitted: 2, failed: 1, releaseFailed: 0, atomicSuccesses: 0,
  });
  assert.deepEqual(
    calls.map((call) => call.action),
    ["claim", "submit", "reconcile-submit", "fail"],
  );
  assert.deepEqual(calls[3].job.claims, [threeClaimJob.claims[1]]);
});

test("reconciles a gateway error body because submit may already have committed", async () => {
  const calls = [];
  const twoClaimJob = {
    ...JOB,
    claims: [
      JOB.claims[0],
      {
        ...JOB.claims[0],
        trackerId: "123e4567-e89b-42d3-a456-426614174001",
      },
    ],
  };
  const fetchImpl = authenticatedFetch([
    { body: { ok: true, job: twoClaimJob } },
    { status: 502, body: { ok: false, code: "gateway_response_lost" } },
    {
      body: {
        ok: true,
        committedCount: 0,
        alreadyCommittedCount: 1,
        leaseLostCount: 0,
        collectionConflictCount: 0,
        uncommittedCount: 1,
        processedCount: 2,
        claimResults: [
          { claimId: twoClaimJob.claims[0].trackerId, status: "already_committed" },
          { claimId: twoClaimJob.claims[1].trackerId, status: "uncommitted" },
        ],
      },
    },
    { body: { ok: true, releasedCount: 1 } },
  ], calls);

  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl,
    provider: { async collect() { return completeWindow(); }, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.deepEqual(summary, {
    status: "completed", claimed: 2, submitted: 1, failed: 1, releaseFailed: 0, atomicSuccesses: 0,
  });
  assert.deepEqual(
    calls.map((call) => call.action),
    ["claim", "submit", "reconcile-submit", "fail"],
  );
  assert.deepEqual(calls[3].job.claims, [twoClaimJob.claims[1]]);
});

test("leaves every claim untouched when a lost submit response cannot be reconciled", async () => {
  const calls = [];
  const twoClaimJob = {
    ...JOB,
    claims: [
      JOB.claims[0],
      {
        ...JOB.claims[0],
        trackerId: "123e4567-e89b-42d3-a456-426614174001",
      },
    ],
  };
  const summary = await runLocalShoppingWorker({
    env: workerEnv(),
    fetchImpl: authenticatedFetch([
      { body: { ok: true, job: twoClaimJob } },
      { error: new TypeError("submit response lost") },
      { error: new TypeError("reconciliation unavailable") },
    ], calls),
    provider: { async collect() { return completeWindow(); }, async close() {} },
    nowMs: () => NOW,
    randomUUID: uuidSequence(),
    skipLock: true,
  });

  assert.deepEqual(summary, {
    status: "control_plane_failed",
    claimed: 2,
    submitted: 0,
    failed: 0,
    releaseFailed: 0,
    atomicSuccesses: 0,
    controlPlaneFailed: 1,
  });
  assert.deepEqual(calls.map((call) => call.action), ["claim", "submit", "reconcile-submit"]);
  assert.equal(calls.some((call) => call.action === "fail"), false);
  assert.equal(
    calls.coordination.some((call) => (
      call.action === "record-failure" && call.errorCode === "local_worker_submit_outcome_unknown"
    )),
    true,
  );
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
    status: "completed", claimed: 1, submitted: 0, failed: 1, releaseFailed: 1, atomicSuccesses: 0,
  });
  assert.match(logs.join("\n"), /local_worker_failure_release_failed/);
});

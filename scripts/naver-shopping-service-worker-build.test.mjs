// 1.1.34 (2026-09-29): stale service worker guard.
// Mac standby Profile 5 ran the 1.1.32 service worker registered on 09-19 until
// 09-29 15:41 although the unpacked files and manifest on disk were 1.1.33 and
// Chrome had been restarted on 09-28 (Secure Preferences
// service_worker_registration_info.version stayed "1.1.32"). The runtime identity
// (manifest version + hash of service-worker.js read from disk) said 1.1.33, so
// the stale code was accepted. No release version literal appears here: the
// build is compared with manifest.json at run time (bump.py moves both).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDirectory = path.join(scriptsDirectory, "..", "tools", "naver-shopping-chrome-extension");
const serviceWorker = fs.readFileSync(path.join(extensionDirectory, "service-worker.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDirectory, "manifest.json"), "utf8"));
const nativeHostPath = path.join(scriptsDirectory, "naver-shopping-native-host.mjs");
const nativeHost = fs.readFileSync(nativeHostPath, "utf8");
const popup = fs.readFileSync(path.join(extensionDirectory, "popup.js"), "utf8");
const updater = fs.readFileSync(path.join(scriptsDirectory, "windows", "update-naver-shopping-chrome-extension.ps1"), "utf8");
const EXTENSION_ID = "pflggephankeefaeoaafkmggampnaefm";

function frame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function frames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const end = offset + 4 + buffer.readUInt32LE(offset);
    messages.push(JSON.parse(buffer.subarray(offset + 4, end).toString("utf8")));
    offset = end;
  }
  return messages;
}

function slice(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, startText);
  return source.slice(start, end);
}

// Runs the host with a counting local server as its only allowed API origin and a
// private lock path, so a refusal can be proven to happen before any request.
async function runHost(messages) {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mi-sw-build-lock-"));
  const child = execFile(process.execPath, [nativeHostPath], {
    encoding: "buffer",
    timeout: 20_000,
    env: {
      ...process.env,
      MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
      MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET: "s".repeat(48),
      MI_NAVER_SHOPPING_LOCAL_WORKER_API_URL: `${origin}/api/naver-shopping-local-worker`,
      MI_NAVER_SHOPPING_LOCAL_WORKER_ALLOWED_ORIGINS: origin,
      MI_NAVER_SHOPPING_LOCAL_WORKER_LOCK_PATH: path.join(lockRoot, "worker.lock"),
      MI_NAVER_SHOPPING_WORKER_ID: "test-build-gate",
      MI_NAVER_SHOPPING_WORKER_ROLE: "standby",
    },
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  for (const message of messages) child.stdin.write(frame(message));
  child.stdin.end();
  const status = await exited;
  server.close();
  fs.rmSync(lockRoot, { recursive: true, force: true });
  return {
    status,
    messages: frames(Buffer.concat(stdout)),
    stderr: Buffer.concat(stderr).toString("utf8"),
    requests,
  };
}

const start = (overrides = {}) => ({
  action: "run",
  trigger: "rank-remote",
  runtimeVersion: manifest.version,
  serviceWorkerSha256: "0".repeat(64),
  ...overrides,
});
const readyAck = { action: "ready_ack", collectionProtocol: "range-v1" };
const escapedVersion = manifest.version.replaceAll(".", "\\.");

test("the compiled service worker build is the manifest version", () => {
  assert.match(serviceWorker, new RegExp(`\\nconst SERVICE_WORKER_BUILD = "${escapedVersion}";\\n`, "u"));
  assert.equal((serviceWorker.match(/const SERVICE_WORKER_BUILD = /gu) || []).length, 1);
});

test("native host refuses a worker without a compiled build before ready and before any server call", async () => {
  const result = await runHost([start(), readyAck]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.messages, [{ type: "service_worker_stale" }]);
  assert.match(result.stderr, new RegExp(`^native_host_service_worker_stale build=none expected=${escapedVersion}$`, "mu"));
  assert.equal(result.requests, 0);
});

test("native host refuses a worker whose compiled build differs from its runtime version", async () => {
  const result = await runHost([start({ serviceWorkerBuild: "0.0.1" }), readyAck]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.messages, [{ type: "service_worker_stale" }]);
  assert.match(result.stderr, new RegExp(`^native_host_service_worker_stale build=0\\.0\\.1 expected=${escapedVersion}$`, "mu"));
  assert.equal(result.requests, 0);
});

test("native host treats a malformed build as missing and never prints it", async () => {
  for (const serviceWorkerBuild of ["", "1.1", "v1.1.9", "1.1.9.0", "1.1.9 x=1", 119, null, {}, ["1.1.9"]]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runHost([start({ serviceWorkerBuild }), readyAck]);
    const label = JSON.stringify(serviceWorkerBuild);
    assert.deepEqual(result.messages, [{ type: "service_worker_stale" }], label);
    assert.match(result.stderr, /^native_host_service_worker_stale build=none expected=/mu, label);
    assert.equal(result.requests, 0, label);
  }
});

test("a matching build passes the gate and reaches the server (positive control)", async () => {
  const result = await runHost([start({ serviceWorkerBuild: manifest.version }), readyAck]);
  assert.equal(result.messages[0]?.type, "ready");
  assert.doesNotMatch(result.stderr, /native_host_service_worker_stale/u);
  assert.ok(result.requests > 0, "the counting server must see the signed claim");
});

test("native host checks the build after identity, before ready and before the worker; fingerprint unchanged", () => {
  const gate = nativeHost.indexOf("staleServiceWorkerBuild(start, identity.version)");
  assert.ok(gate > nativeHost.indexOf("const identity = await runtimeIdentity(start)"));
  assert.ok(gate < nativeHost.indexOf('writeMessage({ type: "ready", collectionProtocol: COLLECTION_PROTOCOL })'));
  assert.ok(gate < nativeHost.indexOf("runLocalShoppingWorker({"));
  const fingerprintInputs = slice(nativeHost, "const fingerprint = crypto.createHash", '].join("\\n")');
  assert.doesNotMatch(fingerprintInputs, /serviceWorkerBuild/u);
});

// The guard runs from the service worker's own constant and status sections.
function guardRuntime({
  loadedVersion = manifest.version,
  diskVersion = manifest.version,
  build = manifest.version,
  stored = {},
  failRead = false,
  failWrite = false,
  failGiveBack = false,
  now = Date.parse("2026-09-29T07:00:00.000Z"),
} = {}) {
  // onRecord runs once, right after the reload attempt is written (the await
  // window before chrome.runtime.reload()).
  const state = { reloads: 0, statuses: [], stored, now, fetches: [], onRecord: null };
  class MockDate extends Date {
    static now() { return state.now; }
    constructor(...args) { super(...(args.length ? args : [state.now])); }
  }
  const source = serviceWorker.replace(/const SERVICE_WORKER_BUILD = "[^"]+";/u, `const SERVICE_WORKER_BUILD = ${JSON.stringify(build)};`);
  const helpers = runInNewContext(`
    ${slice(source, "const BASELINE_CADENCE_MINUTES", "// The Node host")}
    ${slice(source, 'async function saveStatus(status, detail = "")', "function nativeDisconnectCode")}
    ({
      serviceWorkerBuildState,
      reloadIfServiceWorkerStale,
      setNativeRunPortOpen(value) { nativeRunPortOpen = value; },
    });
  `, {
    state,
    Date: MockDate,
    async fetch(url, options) {
      state.fetches.push({ url, options: { ...options } });
      if (diskVersion instanceof Error) throw diskVersion;
      return { ok: true, async json() { return { version: diskVersion }; } };
    },
    chrome: {
      runtime: {
        getManifest() {
          if (loadedVersion instanceof Error) throw loadedVersion;
          return { version: loadedVersion };
        },
        getURL(file) { return `chrome-extension://${EXTENSION_ID}/${file}`; },
        reload() { state.reloads += 1; },
      },
      storage: {
        local: {
          async get(keys) {
            if (failRead) throw new Error("storage_read_failed");
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.map((key) => [key, state.stored[key]]));
          },
          async set(values) {
            const reloadRecord = Object.hasOwn(values, "momentInsightServiceWorkerReload");
            if (failWrite && reloadRecord) throw new Error("storage_write_failed");
            // After the attempt is written, a second write of the key is the give-back.
            if (failGiveBack && reloadRecord && !state.onRecord) throw new Error("storage_give_back_failed");
            if (Object.hasOwn(values, "momentInsightRankStatus")) state.statuses.push(values.momentInsightRankStatus);
            Object.assign(state.stored, values);
            if (reloadRecord && state.onRecord) {
              const onRecord = state.onRecord;
              state.onRecord = null;
              onRecord();
            }
          },
          async remove(keys) {
            if (failGiveBack) throw new Error("storage_give_back_failed");
            for (const key of [keys].flat()) delete state.stored[key];
          },
        },
      },
    },
  });
  return { helpers, state };
}

test("service worker guard reads the manifest on disk fresh and stays quiet when current or unreadable", async () => {
  const current = guardRuntime();
  assert.equal(await current.helpers.reloadIfServiceWorkerStale("initialize"), false);
  assert.equal(current.state.reloads, 0);
  assert.deepEqual(current.state.stored, {});
  assert.deepEqual(current.state.fetches, [{
    url: `chrome-extension://${EXTENSION_ID}/manifest.json`,
    options: { cache: "no-store" },
  }]);

  for (const [loadedVersion, diskVersion] of [
    [new Error("no runtime"), new Error("no fetch")],
    ["", ""],
    ["abc", "1.1"],
  ]) {
    const unreadable = guardRuntime({ loadedVersion, diskVersion, build: "1.1.8" });
    assert.equal(await unreadable.helpers.reloadIfServiceWorkerStale("initialize"), false);
    assert.equal(unreadable.state.reloads, 0);
  }
});

test("service worker guard reloads when the loaded or the on-disk manifest differs from the build", async () => {
  for (const [label, loadedVersion, diskVersion, target] of [
    // 09-29 F3: the old code runs under the new manifest (loaded and on disk).
    ["registered worker behind the files", "1.1.9", "1.1.9", "1.1.9"],
    // Chrome never restarted (watchdog chrome_quit_incomplete): only the disk moved.
    ["files moved without a real restart", "1.1.8", "1.1.9", "1.1.9"],
    ["disk unreadable, loaded manifest newer", "1.1.9", new Error("fetch failed"), "1.1.9"],
  ]) {
    const stale = guardRuntime({ loadedVersion, diskVersion, build: "1.1.8" });
    assert.equal(await stale.helpers.reloadIfServiceWorkerStale("initialize"), true, label);
    assert.equal(stale.state.reloads, 1, label);
    assert.deepEqual({ ...stale.state.stored.momentInsightServiceWorkerReload }, {
      targetVersion: target, build: "1.1.8", attemptedAt: stale.state.now, reason: "initialize",
    }, label);
    assert.equal(stale.state.statuses.at(-1).status, "stale", label);
    assert.equal(stale.state.statuses.at(-1).detail, `service_worker_build_stale:1.1.8:${target}:reloading`, label);
  }
});

test("service worker guard reloads at most once per 30 minutes per target version", async () => {
  const record = (attemptedAt, overrides = {}) => ({
    momentInsightServiceWorkerReload: { targetVersion: "1.1.9", build: "1.1.8", attemptedAt, reason: "initialize", ...overrides },
  });
  const now = Date.parse("2026-09-29T07:00:00.000Z");
  for (const [label, stored, expectedReloads] of [
    ["29:59 after", record(now - (30 * 60_000) + 1_000), 0],
    ["30:00 after", record(now - (30 * 60_000)), 1],
    ["same target, other running build", record(now - 1_000, { build: "1.1.7" }), 0],
    ["another target version", record(now - 1_000, { targetVersion: "1.1.10" }), 1],
    ["clock went back", record(now + 60_000), 1],
    ["malformed record", { momentInsightServiceWorkerReload: "x" }, 1],
  ]) {
    const runtime = guardRuntime({ loadedVersion: "1.1.9", diskVersion: "1.1.9", build: "1.1.8", stored, now });
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await runtime.helpers.reloadIfServiceWorkerStale("run:rank-remote"), true, label);
    assert.equal(runtime.state.reloads, expectedReloads, label);
    assert.equal(runtime.state.statuses.at(-1).status, "stale", label);
    if (expectedReloads === 0) {
      assert.equal(runtime.state.statuses.at(-1).detail, "service_worker_build_stale:1.1.8:1.1.9", label);
    }
  }
});

test("service worker guard never reloads under an open native run, unrecorded or concurrently twice", async () => {
  const open = guardRuntime({ loadedVersion: "1.1.9", diskVersion: "1.1.9", build: "1.1.8" });
  open.helpers.setNativeRunPortOpen(true);
  assert.equal(await open.helpers.reloadIfServiceWorkerStale("run:manual"), true);
  assert.equal(open.state.reloads, 0);
  assert.deepEqual(open.state.stored, {});

  const unreadable = guardRuntime({ loadedVersion: "1.1.9", diskVersion: "1.1.9", build: "1.1.8", failRead: true });
  assert.equal(await unreadable.helpers.reloadIfServiceWorkerStale("initialize"), true);
  assert.equal(unreadable.state.reloads, 0);
  assert.equal(unreadable.state.statuses.at(-1).status, "stale");

  const unwritable = guardRuntime({ loadedVersion: "1.1.9", diskVersion: "1.1.9", build: "1.1.8", failWrite: true });
  assert.equal(await unwritable.helpers.reloadIfServiceWorkerStale("initialize"), true);
  assert.equal(unwritable.state.reloads, 0);

  const concurrent = guardRuntime({ loadedVersion: "1.1.9", diskVersion: "1.1.9", build: "1.1.8" });
  const results = await Promise.all([
    concurrent.helpers.reloadIfServiceWorkerStale("initialize"),
    concurrent.helpers.reloadIfServiceWorkerStale("initialize"),
    concurrent.helpers.reloadIfServiceWorkerStale("run:rank-remote"),
  ]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(concurrent.state.reloads, 1);
});

// A run that passed its own guard before the disk moved can open its native port
// while this attempt awaits storage; the reload would cut it and strand the lease.
test("service worker guard re-checks the native run right before reloading and gives the attempt back", async () => {
  const stale = { loadedVersion: "1.1.9", diskVersion: "1.1.9", build: "1.1.8" };
  const fresh = guardRuntime(stale);
  fresh.state.onRecord = () => fresh.helpers.setNativeRunPortOpen(true);
  assert.equal(await fresh.helpers.reloadIfServiceWorkerStale("initialize"), true);
  assert.equal(fresh.state.reloads, 0);
  assert.equal(Object.hasOwn(fresh.state.stored, "momentInsightServiceWorkerReload"), false);
  // The port closed: the guard after that run reloads at once, not 30 minutes later.
  fresh.helpers.setNativeRunPortOpen(false);
  assert.equal(await fresh.helpers.reloadIfServiceWorkerStale("native-host"), true);
  assert.equal(fresh.state.reloads, 1);
  assert.equal(fresh.state.stored.momentInsightServiceWorkerReload.reason, "native-host");

  const earlier = { targetVersion: "1.1.9", build: "1.1.8", attemptedAt: fresh.state.now - (31 * 60_000), reason: "initialize" };
  const withRecord = guardRuntime({ ...stale, stored: { momentInsightServiceWorkerReload: { ...earlier } } });
  withRecord.state.onRecord = () => withRecord.helpers.setNativeRunPortOpen(true);
  assert.equal(await withRecord.helpers.reloadIfServiceWorkerStale("run:rank-remote"), true);
  assert.equal(withRecord.state.reloads, 0);
  assert.deepEqual({ ...withRecord.state.stored.momentInsightServiceWorkerReload }, earlier);

  // Giving back can fail: still no reload; the record only delays the next one.
  for (const stored of [{}, { momentInsightServiceWorkerReload: { ...earlier } }]) {
    const stuck = guardRuntime({ ...stale, stored, failGiveBack: true });
    stuck.state.onRecord = () => stuck.helpers.setNativeRunPortOpen(true);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await stuck.helpers.reloadIfServiceWorkerStale("initialize"), true);
    assert.equal(stuck.state.reloads, 0);
  }
});

test("a stale worker never starts a run and initialization touches nothing but alarms", async () => {
  const request = slice(serviceWorker, "async function requestWorkerRun(trigger)", "function searchUrl");
  const gate = request.indexOf("reloadIfServiceWorkerStale(");
  assert.ok(gate > request.indexOf("await initializationPromise"));
  assert.ok(gate < request.indexOf("automaticVerificationCooldownActive(trigger)"));
  assert.ok(gate < request.indexOf("void runWorker(trigger)"));
  let runs = 0;
  const requestWorkerRun = runInNewContext(`${request}\nrequestWorkerRun;`, {
    initializationPromise: Promise.resolve(),
    reloadIfServiceWorkerStale: async () => true,
    automaticVerificationCooldownActive: async () => false,
    runWorker: async () => { runs += 1; },
    running: false,
  });
  assert.deepEqual({ ...(await requestWorkerRun("rank-remote")) }, {
    ok: false, started: false, code: "extension_service_worker_stale",
  });
  assert.equal(runs, 0);

  const initialize = slice(serviceWorker, "async function initializeWorker()", "function startWorkerInitialization()");
  assert.ok(initialize.indexOf('reloadIfServiceWorkerStale("initialize")') < initialize.indexOf("extensionRuntimeIdentity()"));
  const calls = [];
  const initializeWorker = runInNewContext(`${initialize}\ninitializeWorker;`, {
    reloadIfServiceWorkerStale: async () => true,
    configureAlarms: async () => { calls.push("configureAlarms"); },
    extensionRuntimeIdentity: async () => { calls.push("identity"); return {}; },
    markCandidateCadenceResetPending: async () => { calls.push("reset"); },
    saveStatus: async () => { calls.push("status"); },
    removeLegacyControllerTabs: async () => { calls.push("tabs"); },
    chrome: { storage: { local: { async get() { calls.push("storage"); return {}; } } } },
  });
  await initializeWorker();
  assert.deepEqual(calls, ["configureAlarms"]);
});

test("the reloaded current worker clears the stale status with a baseline cadence reset", async () => {
  const initialize = slice(serviceWorker, "async function initializeWorker()", "function startWorkerInitialization()");
  const calls = [];
  const initializeWorker = runInNewContext(`${initialize}\ninitializeWorker;`, {
    INITIALIZATION_SAFE_STATUSES: new Set(["completed", "standby", "ready"]),
    SHA256_HEX_PATTERN: /^[0-9a-f]{64}$/u,
    CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY: "proofVersion",
    CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY: "proofSha",
    reloadIfServiceWorkerStale: async () => false,
    extensionRuntimeIdentity: async () => ({ runtimeVersion: "1.1.9", serviceWorkerSha256: "a".repeat(64), serviceWorkerBuild: "1.1.9" }),
    markCandidateCadenceResetPending: async () => { calls.push("reset"); },
    saveStatus: async (status, detail) => { calls.push(`status:${status}:${detail}`); },
    configureAlarms: async () => { calls.push("configureAlarms"); },
    removeLegacyControllerTabs: async () => {},
    saveWorkerFailure: async () => {},
    chrome: { storage: { local: { async get() {
      return { momentInsightRankStatus: { status: "stale" }, proofVersion: "1.1.9", proofSha: "a".repeat(64) };
    } } } },
  });
  await initializeWorker();
  assert.deepEqual(calls, ["reset", "status:ready:", "configureAlarms"]);
});

test("the lifecycle, every alarm and the queued follow-up all pass through the guard", () => {
  const lifecycle = serviceWorker.slice(serviceWorker.indexOf("chrome.runtime.onInstalled.addListener"));
  assert.match(lifecycle, /onInstalled\.addListener\(\(\) => \{\s*void startWorkerInitialization\(\);/u);
  assert.match(lifecycle, /onStartup\.addListener\(\(\) => \{\s*void startWorkerInitialization\(\);/u);
  assert.match(lifecycle, /\nvoid startWorkerInitialization\(\);\s*$/u);
  assert.match(lifecycle, /RUN_ALARMS\.has\(alarm\.name\)\) \{\s*void requestWorkerRun\(alarm\.name\)/u);
  assert.match(serviceWorker, /function startWorkerInitialization\(\) \{\s*initializationPromise = initializeWorker\(\);/u);
  // The queued follow-up (standby continuation) calls runWorker directly.
  const worker = slice(serviceWorker, 'async function runWorker(trigger = "manual", options = {})', "chrome.runtime.onInstalled.addListener");
  assert.match(worker, /void runWorker\(nextTrigger, \{/u);
});

// runWorker in a VM: the guard, the native port and the host's stale reply.
function runWorkerRuntime({ stale = false, hostReply = null } = {}) {
  // portOpenAt: nativeRunPortOpen as the guard, connectNative and the run message saw it.
  const state = { connects: 0, disconnects: 0, statuses: [], guardReasons: [], order: [], pending: null, portOpenAt: [] };
  const worker = slice(serviceWorker, 'async function runWorker(trigger = "manual", options = {})', "chrome.runtime.onInstalled.addListener");
  // The stubs below read runtime.portOpen() only while runWorker runs.
  const runtime = runInNewContext(`
    let running = false;
    let nativeRunPortOpen = false;
    ${worker}
    ({ runWorker, portOpen: () => nativeRunPortOpen, isRunning: () => running });
  `, {
    state,
    initializationPromise: Promise.resolve(),
    BASELINE_CADENCE_MINUTES: 10,
    PENDING_TRIGGER_HANDOFF_MS: 6_000,
    NATIVE_HOST: "co.kr.momentinsight.naver_shopping",
    NAVER_ACCESS_COOLDOWN_CODES: new Set(),
    async reloadIfServiceWorkerStale(reason) {
      state.guardReasons.push(reason);
      state.order.push(`guard:${reason}`);
      state.portOpenAt.push(`guard:${reason}:${runtime.portOpen()}`);
      return reason === "native-host" ? true : stale;
    },
    async verificationState() { return { blockedUntil: 0 }; },
    async saveStatus(status, detail) { state.statuses.push({ status, detail }); },
    async wait() {},
    startWorkerKeepAlive() { return () => {}; },
    async extensionRuntimeIdentity() {
      return { runtimeVersion: "1.1.9", serviceWorkerSha256: "0".repeat(64), serviceWorkerBuild: "1.1.8" };
    },
    nativeReadyAcknowledgement() { return { action: "ready_ack" }; },
    nativeDisconnectCode() { return "native_host_exited"; },
    async markCandidateCadenceResetPending() { state.order.push("reset"); },
    async configureAlarms() {},
    async updateCandidateCadenceEvidence() {},
    cadenceFromWorkerSummary() { return 10; },
    takePendingTrigger() { const trigger = state.pending; state.pending = null; return trigger; },
    chrome: {
      runtime: {
        lastError: null,
        connectNative() {
          state.connects += 1;
          state.portOpenAt.push(`connect:${runtime.portOpen()}`);
          const listeners = { message: [], disconnect: [] };
          return {
            onMessage: { addListener(listener) { listeners.message.push(listener); } },
            onDisconnect: { addListener(listener) { listeners.disconnect.push(listener); } },
            postMessage(message) {
              if (message?.action !== "run") return;
              state.portOpenAt.push(`run:${runtime.portOpen()}`);
              // The host writes its terminal frame (if any) and exits; Chrome then disconnects.
              if (hostReply) queueMicrotask(() => listeners.message.forEach((listener) => listener(hostReply)));
              setTimeout(() => listeners.disconnect.forEach((listener) => listener()), 0);
            },
            disconnect() { state.disconnects += 1; state.order.push("disconnect"); },
          };
        },
      },
      storage: { local: { async set() {} } },
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });
  return { runtime, state };
}

test("runWorker checks the guard before the native host, on the queued follow-up too", async () => {
  const direct = runWorkerRuntime({ stale: true });
  assert.deepEqual({ ...(await direct.runtime.runWorker("rank-remote")) }, { ok: false, code: "extension_service_worker_stale" });
  assert.equal(direct.state.connects, 0);
  assert.deepEqual(direct.state.guardReasons, ["run:rank-remote"]);
  assert.equal(direct.runtime.isRunning(), false);

  const followUp = runWorkerRuntime({ stale: true });
  await followUp.runtime.runWorker("rank-catch-up", { respectVerificationCooldown: true, waitForNativeHandoff: true });
  assert.equal(followUp.state.connects, 0);
  assert.deepEqual(followUp.state.statuses, []);
});

test("a host stale reply is not a collection failure and reloads only after the port is closed", async () => {
  const refused = runWorkerRuntime({ hostReply: { type: "service_worker_stale" } });
  const result = await refused.runtime.runWorker("rank-remote");
  assert.deepEqual({ ...result }, { ok: false, code: "native_host_service_worker_stale" });
  assert.equal(refused.state.connects, 1);
  assert.deepEqual(refused.state.statuses.map(({ status }) => status), ["running", "stale"]);
  assert.equal(refused.state.statuses.some(({ status }) => status === "failed"), false);
  assert.ok(refused.state.order.indexOf("disconnect") < refused.state.order.indexOf("guard:native-host"));
  // The post-run guard must see the port closed, or it declines to reload.
  assert.equal(refused.state.portOpenAt.at(-1), "guard:native-host:false");
  assert.equal(refused.runtime.portOpen(), false);

  const failed = runWorkerRuntime({ hostReply: { type: "error", code: "native_host_runtime_identity_invalid" } });
  await failed.runtime.runWorker("rank-remote");
  assert.equal(failed.state.statuses.at(-1).status, "failed");
  assert.equal(failed.state.guardReasons.includes("native-host"), false);
});

// F1 (2026-09-29 drill): a self-reload that cuts an open collection strands the
// lane lease. The guard refuses to reload while this flag is set, so runWorker must
// set it before connectNative and clear it only after closing the port.
test("runWorker marks the native run open from just before connectNative until the port is closed", async () => {
  const run = runWorkerRuntime({ hostReply: { type: "error", code: "native_host_runtime_identity_invalid" } });
  assert.equal(run.runtime.portOpen(), false);
  await run.runtime.runWorker("rank-remote");
  assert.deepEqual(run.state.portOpenAt, ["guard:run:rank-remote:false", "connect:true", "run:true"]);
  assert.equal(run.state.disconnects, 1);
  assert.equal(run.runtime.portOpen(), false);
  assert.equal(run.runtime.isRunning(), false);
});

test("the running identity carries the compiled build", async () => {
  const identitySource = slice(serviceWorker, "async function extensionRuntimeIdentity()", "// 1.1.33 (2026-09-27 standby incident)");
  const identity = await runInNewContext(`
    const SERVICE_WORKER_BUILD = "1.1.9";
    let runtimeIdentityPromise = null;
    function bytesToHex(bytes) { return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
    ${identitySource}
    extensionRuntimeIdentity();
  `, {
    chrome: { runtime: { getManifest: () => ({ version: "1.1.9" }), getURL: (file) => `chrome-extension://x/${file}` } },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    crypto: { subtle: { digest: async () => new Uint8Array(32).buffer } },
  });
  assert.deepEqual({ ...identity }, { runtimeVersion: "1.1.9", serviceWorkerSha256: "0".repeat(64), serviceWorkerBuild: "1.1.9" });
  assert.match(serviceWorker, /port\.postMessage\(\{ action: "run", trigger, \.\.\.runtimeIdentity \}\)/u);
});

test("the popup explains a stale worker instead of 'ready'", () => {
  assert.match(popup, /extension_service_worker_stale:/u);
  assert.match(popup, /native_host_service_worker_stale:/u);
  assert.match(popup, /status\?\.status === "stale"/u);
});

// The Windows updater cannot use ConvertFrom-Json on Secure Preferences
// (PowerShell 5.1). This mirrors its string match with the updater's own
// patterns, the same shape as the check line measured on Windows on 2026-09-29.
function updaterRegisteredVersion(text) {
  const nextExtension = updater.match(/\$nextExtension = \[regex\]::Match\(\$extensionText, '([^']+)'\)/u)?.[1];
  const registration = updater.match(/\$registration = \[regex\]::Match\(\$extensionText, '([^']+)'\)/u)?.[1];
  assert.ok(nextExtension && registration, "updater patterns");
  const key = `"${EXTENSION_ID}":{`;
  const index = text.indexOf(key);
  if (index < 0) return "";
  let extensionText = text.slice(index + key.length);
  const next = new RegExp(nextExtension, "u").exec(extensionText);
  if (next) extensionText = extensionText.slice(0, next.index);
  return new RegExp(registration, "u").exec(extensionText)?.[1] || "";
}

test("Windows updater reads the registered service worker version by string match, not ConvertFrom-Json", () => {
  const reader = slice(updater, "function Get-RegisteredServiceWorkerVersion {", "function Get-UpdateTargetProcesses {");
  assert.doesNotMatch(reader, /ConvertFrom-Json/u);
  assert.match(reader, /\$extensionKey = '"' \+ \$ExpectedExtensionId \+ '":\{'/u);
  assert.match(reader, /foreach \(\$preferenceName in @\("Secure Preferences", "Preferences"\)\)/u);
  const other = "abcdefghijklmnopabcdefghijklmnop";
  const settings = (entries) => JSON.stringify({ extensions: { settings: Object.fromEntries(entries) }, protection: { macs: { extensions: { settings: { [EXTENSION_ID]: "HASH" } } } } });
  const cases = [
    ["measured shape", settings([[EXTENSION_ID, { path: "C:\\x", service_worker_registration_info: { version: "1.1.33" } }], [other, { service_worker_registration_info: { version: "9.9.9" } }]]), "1.1.33"],
    ["F3 shape", settings([[other, { path: "y" }], [EXTENSION_ID, { service_worker_registration_info: { version: "1.1.32" } }]]), "1.1.32"],
    ["only another extension is registered", settings([[EXTENSION_ID, { path: "x" }], [other, { service_worker_registration_info: { version: "9.9.9" } }]]), ""],
    ["another extension before ours", settings([[other, { service_worker_registration_info: { version: "9.9.9" } }], [EXTENSION_ID, { path: "x" }]]), ""],
    ["not installed", settings([[other, { service_worker_registration_info: { version: "9.9.9" } }]]), ""],
    ["injected value", settings([[EXTENSION_ID, { service_worker_registration_info: { version: "1.1.32; calc" } }]]), ""],
    ["broken file", "{not json", ""],
  ];
  for (const [label, text, expected] of cases) {
    assert.equal(updaterRegisteredVersion(text), expected, label);
    if (text.startsWith("{\"")) {
      const parsed = JSON.parse(text).extensions.settings[EXTENSION_ID]?.service_worker_registration_info?.version;
      assert.equal(expected, /^\d+\.\d+\.\d+$/u.test(parsed || "") ? parsed : "", `${label} matches JSON.parse`);
    }
  }
});

test("Windows updater reports success only after Chrome registered the expected worker", () => {
  assert.match(updater, /\$serviceWorkerRegistrationTimeoutMs = 180000/u);
  assert.match(updater, /\$serviceWorkerRegistrationPollMs = 5000/u);
  const restart = updater.indexOf("Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName");
  const restoreCheck = updater.indexOf('if ($null -ne $restoreFailure) { throw "scheduled_task_restore_failed" }');
  const poll = updater.indexOf("$registeredServiceWorkerVersion = Get-RegisteredServiceWorkerVersion");
  const verdict = updater.indexOf("if ($registeredServiceWorkerVersion -ne $ExpectedVersion) {");
  const success = updater.indexOf("Write-Host $successMessage");
  assert.ok(restart >= 0 && restoreCheck > restart && poll > restoreCheck && verdict > poll && success > verdict);
  const loop = slice(updater, "while ($true) {\n    $registeredServiceWorkerVersion", "$serviceWorkerRegistrationWatch.Stop()");
  assert.match(loop, /if \(\$registeredServiceWorkerVersion -eq \$ExpectedVersion\) \{ break \}/u);
  assert.match(loop, /ElapsedMilliseconds -ge \$serviceWorkerRegistrationTimeoutMs\) \{ break \}/u);
  assert.match(loop, /Start-Sleep -Milliseconds \$serviceWorkerRegistrationPollMs/u);
  assert.match(updater, /\$successMessage \+= " extension_sw_registered_version=\$reportedServiceWorkerVersion"/u);
  const staleBranch = slice(updater, "if ($registeredServiceWorkerVersion -ne $ExpectedVersion) {", "Write-Host $successMessage");
  assert.match(staleBranch, /Write-Host "MI_EXTENSION_SW_STALE [^"\n]*extension_sw_registered_version=\$reportedServiceWorkerVersion"/u);
  assert.match(staleBranch, /chrome:\/\/extensions/u);
  assert.match(staleBranch, /\n\s*exit 1\n\}/u);
  assert.doesNotMatch(staleBranch, /MI_EXTENSION_UPDATE_OK|\$successMessage/u);
});

test("Windows updater does not wait for a restart that a disabled task never makes", () => {
  // The updater stops Chrome in every case but restarts it only through a task that
  // was enabled before the update; a disabled task stays disabled.
  const restore = slice(updater, "if ($scheduledTaskWasEnabled) {\n                Enable-ScheduledTask", "catch {\n            $restoreFailure = $_");
  assert.match(restore, /Start-ScheduledTask -TaskPath \$taskPath -TaskName \$taskName/u);
  assert.match(restore, /else \{\s*Disable-ScheduledTask/u);
  const loop = slice(updater, "while ($true) {\n    $registeredServiceWorkerVersion", "$serviceWorkerRegistrationWatch.Stop()");
  const matched = loop.indexOf("if ($registeredServiceWorkerVersion -eq $ExpectedVersion) { break }");
  const disabled = loop.indexOf("if (-not $scheduledTaskWasEnabled) { break }");
  assert.ok(matched >= 0 && disabled > matched, "a matching registration still counts; otherwise stop waiting at once");
  assert.ok(disabled < loop.indexOf("Start-Sleep"));
  const staleBranch = slice(updater, "if ($registeredServiceWorkerVersion -ne $ExpectedVersion) {", "Write-Host $successMessage");
  const unverified = slice(staleBranch, "if (-not $scheduledTaskWasEnabled) {", "Write-Host \"MI_EXTENSION_SW_STALE");
  assert.match(unverified, /Write-Host "MI_EXTENSION_SW_UNVERIFIED reason=scheduled_task_disabled [^"\n]*extension_sw_registered_version=\$reportedServiceWorkerVersion"/u);
  assert.match(unverified, /Enable and start that task/u);
  assert.doesNotMatch(unverified, /press the reload button[^"]*then run the read-only check line/u);
  assert.match(unverified, /\n\s*exit 1\n\s*\}/u);
  assert.doesNotMatch(unverified, /MI_EXTENSION_UPDATE_OK|\$successMessage/u);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { calculateN30RuntimeFingerprint } from "./naver-shopping-runtime-fingerprint.mjs";
import { auditMigrationRuntimeLiterals } from "./migration-runtime-literal-audit.mjs";

// Runtime 1.1.34 (2026-09-29): 죽은 잠금 인계·유한창 경보·실행 중 서비스 워커 버전 확인·자가 새로고침
// The migration only moves the runtime identity pins; every other RPC stays runtime-neutral.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260929205303_naver_shopping_runtime_1_1_34_dead_lease_and_live_service_worker.sql";
const priorMigrationName = "20260928022048_naver_shopping_runtime_1_1_33_collection_window_and_probe.sql";
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const priorMigration = fs.readFileSync(path.join(migrationDirectory, priorMigrationName), "utf8");

const OLD_RUNTIME = Object.freeze({
  version: "1.1.33",
  fingerprint: "b0b47390774e8b935542773eec960779533f4b6e71b73a6dd603c58391a3d36e",
});
const NEW_RUNTIME = Object.freeze({
  version: "1.1.34",
  fingerprint: "5db29dbd1ca354fb50756e073e57c52b2a95f978bea89ba57d7c8c1e41856daf",
});

function functionSql(source, name) {
  return source.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ))?.[0] || "";
}

test("1.1.34 is the newest runtime migration and the live fingerprint matches its pin", () => {
  const runtimeMigrations = fs.readdirSync(migrationDirectory)
    .filter((entry) => /_naver_shopping_runtime_1_1_\d+_/u.test(entry))
    .sort();
  assert.equal(runtimeMigrations.at(-1), migrationName);
  assert.deepEqual(calculateN30RuntimeFingerprint({
    repositoryRoot: root,
    version: NEW_RUNTIME.version,
  }).fingerprint, NEW_RUNTIME.fingerprint);
});

test("migration moves only the runtime identity pins from 1.1.33 to 1.1.34", () => {
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_34_requires_completed_account_priority'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_34_requires_idle_control_plane'/u);
  assert.match(migration, new RegExp(`current_row\\.runtime_version is distinct from '${OLD_RUNTIME.version.replace(/\./gu, "\\.")}'`, "u"));
  assert.match(migration, new RegExp(`current_row\\.runtime_fingerprint is distinct from\\s+'${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /drop constraint if exists naver_shopping_finite_window_targets_runtime_version_check/u);
  assert.match(migration, new RegExp(`set runtime_version = '1\\.1\\.34',\\s+runtime_fingerprint =\\s+'${NEW_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, new RegExp(`where runtime_version = '1\\.1\\.33'\\s+and runtime_fingerprint = '${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /check \(runtime_version = '1\.1\.34'\)/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_34_finite_target_identity_mismatch'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_34_target_mismatch'/u);
  assert.match(migration, /runtime_version = null,\s+runtime_fingerprint = null/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_34_coordination_mismatch'/u);
  assert.equal((migration.match(/create or replace function/gu) || []).length, 1);
  const progress = functionSql(migration, "mi_report_naver_shopping_worker_progress");
  assert.ok(progress, "progress gate must be re-declared with the new identity");
  assert.match(progress, /expected_runtime_version constant text := '1\.1\.34';/u);
  assert.match(progress, new RegExp(`expected_runtime_fingerprint constant text :=\\s+'${NEW_RUNTIME.fingerprint}';`, "u"));
  assert.match(progress, /security invoker/u);
  assert.match(progress, /set search_path = ''/u);
  assert.doesNotMatch(progress, /1\.1\.33|b0b47390/u);
  const priorProgress = functionSql(priorMigration, "mi_report_naver_shopping_worker_progress");
  assert.equal(
    progress.replace(NEW_RUNTIME.version, OLD_RUNTIME.version).replace(NEW_RUNTIME.fingerprint, OLD_RUNTIME.fingerprint),
    priorProgress,
  );
  assert.match(migration, /revoke all on function public\.mi_report_naver_shopping_worker_progress\([\s\S]*?from public, anon, authenticated, service_role;/u);
  assert.match(migration, /grant execute on function public\.mi_report_naver_shopping_worker_progress\([\s\S]*?to service_role;/u);
  assert.doesNotMatch(migration, /1\.1\.21|84334f5a/u);
  assert.match(migration, /^begin;$/mu);
  assert.match(migration, /^commit;$/mu);
});

test("the runtime literal audit still passes with the 1.1.34 progress gate as the only carrier", () => {
  const result = auditMigrationRuntimeLiterals({ migrationDirectory });
  assert.deepEqual(result.violations, []);
});

test("live surfaces are 1.1.34 while the archived 1.1.33 evidence keeps its historical identity", () => {
  assert.match(read("tools/naver-shopping-chrome-extension/manifest.json"), /"version": "1\.1\.34"/u);
  for (const relativePath of [
    "scripts/naver-shopping-local-worker.mjs",
    "src/server/handlers/naver-shopping-local-worker.mjs",
    "src/server/handlers/naver-rank-trackers.mjs",
    "src/server/naver-shopping/worker-runtime-expectation.mjs",
  ]) {
    assert.match(read(relativePath), /"1\.1\.34"/u, relativePath);
    assert.doesNotMatch(read(relativePath), /"1\.1\.33"/u, relativePath);
  }
  for (const relativePath of [
    "scripts/naver-shopping-candidate-performance-audit.mjs",
    "scripts/naver-shopping-account-rank-health-audit.mjs",
  ]) {
    assert.match(read(relativePath), /"1\.1\.34"/u, relativePath);
    assert.match(read(relativePath), new RegExp(NEW_RUNTIME.fingerprint, "u"), relativePath);
    assert.doesNotMatch(read(relativePath), new RegExp(OLD_RUNTIME.fingerprint, "u"), relativePath);
  }
  assert.match(priorMigration, new RegExp(OLD_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(priorMigration, /1\.1\.34/u);
});

test("1.1.34 running service worker build guard is present in the fingerprinted runtime files", () => {
  // 2026-09-29 (F3): the Mac Profile 5 service worker ran the 09-19 registration for ten days
  // while the unpacked files and the reported identity (manifest + service-worker.js read from
  // disk) said the new runtime. The worker now carries its own build literal, moved by bump.py
  // with the manifest. No runtime version literal in the assertions: this block stays valid
  // after archiving. Only this first test name carries the version (bump.py cuts and archives
  // at it); blocks appended below must not start their names with a version.
  const manifest = JSON.parse(read("tools/naver-shopping-chrome-extension/manifest.json"));
  const serviceWorker = read("tools/naver-shopping-chrome-extension/service-worker.js");
  const build = serviceWorker.match(/^const SERVICE_WORKER_BUILD = "(\d+\.\d+\.\d+)";$/mu);
  assert.ok(build, "service-worker.js must declare its compiled build");
  assert.equal(build[1], manifest.version);
  assert.equal(serviceWorker.match(/^const SERVICE_WORKER_BUILD = /gmu).length, 1);
});

test("stale service worker: identity carries the build, the host refuses before ready, the worker reloads itself", () => {
  const serviceWorker = read("tools/naver-shopping-chrome-extension/service-worker.js");
  assert.match(serviceWorker, /return \{ runtimeVersion, serviceWorkerSha256, serviceWorkerBuild: SERVICE_WORKER_BUILD \};/u);
  assert.match(serviceWorker, /const SERVICE_WORKER_RELOAD_INTERVAL_MS = 30 \* 60_000;/u);
  assert.match(serviceWorker, /fetch\(chrome\.runtime\.getURL\("manifest\.json"\), \{ cache: "no-store" \}\)/u);
  assert.match(serviceWorker, /async function initializeWorker\(\) \{\s*try \{\s*if \(await reloadIfServiceWorkerStale\("initialize"\)\)/u);
  assert.match(serviceWorker, /async function requestWorkerRun\(trigger\) \{\s*await initializationPromise;[\s\S]{0,240}reloadIfServiceWorkerStale\(/u);
  assert.match(serviceWorker, /running = true;[\s\S]{0,400}reloadIfServiceWorkerStale\([\s\S]{0,1200}nativeRunPortOpen = true;\s*port = chrome\.runtime\.connectNative\(NATIVE_HOST\)/u);
  assert.match(serviceWorker, /if \(nativeRunPortOpen\) \{[\s\S]{0,400}return true;\s*\}\s*chrome\.runtime\.reload\(\);/u);
  assert.match(serviceWorker, /message\?\.type === "service_worker_stale"/u);
  const nativeHost = read("scripts/naver-shopping-native-host.mjs");
  const gate = nativeHost.indexOf("staleServiceWorkerBuild(start, identity.version)");
  assert.ok(gate > nativeHost.indexOf("const identity = await runtimeIdentity(start)"));
  assert.ok(gate < nativeHost.indexOf('writeMessage({ type: "ready", collectionProtocol: COLLECTION_PROTOCOL })'));
  assert.match(nativeHost, /native_host_service_worker_stale build=\$\{staleBuild\} expected=\$\{identity\.version\}/u);
  assert.match(nativeHost, /await writeTerminalMessage\(\{ type: "service_worker_stale" \}\)/u);
  const updater = read("scripts/windows/update-naver-shopping-chrome-extension.ps1");
  assert.match(updater, /\$serviceWorkerRegistrationTimeoutMs = 180000/u);
  assert.ok(updater.indexOf("MI_EXTENSION_SW_STALE") > 0);
  assert.ok(updater.indexOf("MI_EXTENSION_SW_STALE") < updater.indexOf("Write-Host $successMessage"));
});

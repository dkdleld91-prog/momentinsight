import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { calculateN30RuntimeFingerprint } from "./naver-shopping-runtime-fingerprint.mjs";
import { auditMigrationRuntimeLiterals } from "./migration-runtime-literal-audit.mjs";

// Runtime 1.1.33 (2026-09-28): 수집 창 자동 생성·마지막 창 유지·원문 오류 보존·주작업기 즉시 탐침
// The migration only moves the runtime identity pins; every other RPC stays runtime-neutral.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260928022048_naver_shopping_runtime_1_1_33_collection_window_and_probe.sql";
const priorMigrationName = "20260919020000_naver_shopping_runtime_1_1_32_finite_cross_page_repeats.sql";
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const priorMigration = fs.readFileSync(path.join(migrationDirectory, priorMigrationName), "utf8");

const OLD_RUNTIME = Object.freeze({
  version: "1.1.32",
  fingerprint: "62ad583be7a9d57b8fce77b91f810b324d57cedcbb9a120676deeb9a703681cc",
});
const NEW_RUNTIME = Object.freeze({
  version: "1.1.33",
  fingerprint: "b0b47390774e8b935542773eec960779533f4b6e71b73a6dd603c58391a3d36e",
});

function functionSql(source, name) {
  return source.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ))?.[0] || "";
}

// Archived 2026-09-29 (superseded by runtime 1.1.34).
test("keeps the archived runtime 1.1.33 migration pinned to its historical fingerprint", () => {
  const runtimeMigrations = fs.readdirSync(migrationDirectory)
    .filter((entry) => /_naver_shopping_runtime_1_1_\d+_/u.test(entry))
    .sort();
  assert.ok(runtimeMigrations.includes(migrationName));
  assert.ok(runtimeMigrations.indexOf(migrationName) < runtimeMigrations.length - 1);
  assert.equal(NEW_RUNTIME.fingerprint, "b0b47390774e8b935542773eec960779533f4b6e71b73a6dd603c58391a3d36e");
  assert.equal(typeof calculateN30RuntimeFingerprint, "function");
});

test("migration moves only the runtime identity pins from 1.1.32 to 1.1.33", () => {
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_33_requires_completed_account_priority'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_33_requires_idle_control_plane'/u);
  assert.match(migration, new RegExp(`current_row\\.runtime_version is distinct from '${OLD_RUNTIME.version.replace(/\./gu, "\\.")}'`, "u"));
  assert.match(migration, new RegExp(`current_row\\.runtime_fingerprint is distinct from\\s+'${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /drop constraint if exists naver_shopping_finite_window_targets_runtime_version_check/u);
  assert.match(migration, new RegExp(`set runtime_version = '1\\.1\\.33',\\s+runtime_fingerprint =\\s+'${NEW_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, new RegExp(`where runtime_version = '1\\.1\\.32'\\s+and runtime_fingerprint = '${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /check \(runtime_version = '1\.1\.33'\)/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_33_finite_target_identity_mismatch'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_33_target_mismatch'/u);
  assert.match(migration, /runtime_version = null,\s+runtime_fingerprint = null/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_33_coordination_mismatch'/u);
  assert.equal((migration.match(/create or replace function/gu) || []).length, 1);
  const progress = functionSql(migration, "mi_report_naver_shopping_worker_progress");
  assert.ok(progress, "progress gate must be re-declared with the new identity");
  assert.match(progress, /expected_runtime_version constant text := '1\.1\.33';/u);
  assert.match(progress, new RegExp(`expected_runtime_fingerprint constant text :=\\s+'${NEW_RUNTIME.fingerprint}';`, "u"));
  assert.match(progress, /security invoker/u);
  assert.match(progress, /set search_path = ''/u);
  assert.doesNotMatch(progress, /1\.1\.32|62ad583b/u);
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

test("the runtime literal audit still passes with the 1.1.33 progress gate as the only carrier", () => {
  const result = auditMigrationRuntimeLiterals({ migrationDirectory });
  assert.deepEqual(result.violations, []);
});

test("the archived 1.1.32 evidence keeps its historical identity", () => {
  assert.match(priorMigration, new RegExp(OLD_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(priorMigration, /1\.1\.33/u);
});

test("1.1.33 collector window, Chrome error text and the primary's half-open probe are present in the fingerprinted runtime files", () => {
  // 2026-09-27 70-minute stop: the Mac standby profile had no normal window, so
  // chrome.tabs.create rejected "No current window", only the stage code reached
  // the server, and the returning primary's one-minute poll released each
  // half-open grant. No runtime version literal below: this block stays valid
  // after it is archived by the next runtime.
  const serviceWorker = read("tools/naver-shopping-chrome-extension/service-worker.js");
  assert.match(serviceWorker, /const COLLECTION_WINDOW_ANCHOR_KEY = "momentInsightRankCollectionWindow";/u);
  assert.match(serviceWorker, /const COLLECTION_WINDOW_MINIMIZE_ATTEMPTS = 4;/u);
  assert.match(serviceWorker, /const COLLECTION_TAB_PARK_COMMIT_CHECKS = 5;/u);
  assert.match(serviceWorker, /chrome\.windows\.getAll\(\{ windowTypes: \["normal"\], populate: true \}\)/u);
  assert.match(serviceWorker, /windows\.filter\(\(window\) => window\?\.incognito !== true\)/u);
  assert.match(serviceWorker, /if \(onlyWindow\?\.state !== "minimized"\) return null;/u);
  assert.match(serviceWorker, /if \(tabUrl !== "about:blank" && !tabUrl\.startsWith\("https:\/\/search\.shopping\.naver\.com\/"\)\) return null;/u);
  assert.match(serviceWorker, /if \(tabs\[0\]\.pendingUrl != null && String\(tabs\[0\]\.pendingUrl\) !== tabUrl\) return null;/u);
  assert.match(serviceWorker, /return anchor\?\.windowId === onlyWindow\.id && anchor\.tabId === tabs\[0\]\.id \? anchor\.tabId : null;/u);
  // A restart that emptied the session store: only a lone minimized
  // about:blank tab of the only window is adopted (an unreadable or malformed
  // record is not an empty one).
  assert.match(serviceWorker, /if \(anchor === undefined\) return undefined;/u);
  assert.match(serviceWorker, /if \(anchor === undefined\) return adoptParkedCollectionTab\(onlyWindow, tabs\[0\]\);/u);
  assert.match(serviceWorker, /async function adoptParkedCollectionTab\(onlyWindow, onlyTab\) \{\s*if \(onlyTab\?\.url !== "about:blank"\) return null;/u);
  assert.match(serviceWorker, /await saveCollectionWindowAnchor\(onlyWindow\.id, onlyTab\.id\);\s*return onlyTab\.id;/u);
  assert.match(serviceWorker, /chrome\.windows\.create\(\{ url, focused: false, state: "minimized" \}\)/u);
  assert.match(serviceWorker, /await saveCollectionWindowAnchor\(window\.id, tabId\);\s*await minimizeCollectionWindow\(window\.id\);/u);
  assert.match(serviceWorker, /chrome\.tabs\.create\(\{ url, active: false \}\)/u);
  assert.match(serviceWorker, /async function releaseCollectionTab\(tabId\)/u);
  assert.match(serviceWorker, /const onlyWindow = windows\?\.length === 1 \? windows\[0\] : null;/u);
  assert.match(serviceWorker, /if \(onlyWindow && onlyTabs\.length === 1 && onlyTabs\[0\]\?\.id === tabId\) \{/u);
  assert.match(serviceWorker, /chrome\.tabs\.update\(tabId, \{ url: "about:blank" \}\)/u);
  assert.match(serviceWorker, /chrome\.tabs\.update\(tabId, \{ url: "about:blank" \}\)\.catch\(\(\) => \{\}\);\s*await waitForParkedTabCommit\(tabId\);/u);
  assert.match(serviceWorker, /if \(!tab \|\| \(tab\.url === "about:blank" && tab\.pendingUrl == null\)\) return;/u);
  assert.match(serviceWorker, /if \(tabId != null && !keepTabOpen\) await releaseCollectionTab\(tabId\);/u);
  assert.match(serviceWorker, /if \(current\.tabId\) await releaseCollectionTab\(current\.tabId\);/u);
  assert.match(serviceWorker, /if \(current\.tabId && current\.tabId !== tabId\) \{\s*await releaseCollectionTab\(current\.tabId\);/u);
  assert.match(serviceWorker, /const COLLECTION_ERROR_DETAIL_MAX_CHARS = 120;/u);
  assert.match(serviceWorker, /const COLLECTION_ERROR_DETAIL_CUT_MARKERS = \["http", ":\/\/", " url", "\?"\];/u);
  assert.match(serviceWorker, /typedCollectionError\(error, collectionStageCode\)/u);
  assert.match(serviceWorker, /errorDetail: error\.errorDetail/u);
  const contract = read("src/server/naver-shopping/local-worker-contract.mjs");
  assert.match(contract, /export function sanitizeCollectionErrorDetail\(value, options = \{\}\)/u);
  assert.match(contract, /const COLLECTION_ERROR_DETAIL_KEYWORD_MIN_CHARS = 3;/u);
  assert.match(contract, /if \(tokens\.join\(""\)\.length < COLLECTION_ERROR_DETAIL_KEYWORD_MIN_CHARS\) return null;/u);
  const nativeHost = read("scripts/naver-shopping-native-host.mjs");
  assert.match(nativeHost, /sanitizeCollectionErrorDetail\(response\?\.errorDetail, \{\s*keyword: message\.request\?\.keyword,/u);
  assert.match(nativeHost, /requireWakeSignal: trigger === "rank-remote"/u);
  assert.doesNotMatch(nativeHost, /error\.detail = /u);
  const worker = read("scripts/naver-shopping-local-worker.mjs");
  assert.match(worker, /\.\.\.errorDetailPayload,/u);
  assert.match(worker, /function halfOpenAutoRecoveryProbe\(lane, workerRole\) \{/u);
  assert.match(worker, /return workerRole === "primary"\s*&& lane\?\.granted === true\s*&& lane\.autoRecovery === true/u);
  assert.match(worker, /if \(wake\.wake !== true && !halfOpenProbe\) \{/u);
  assert.match(worker, /if \(probeTrackerId \|\| autoRecovery\) effectiveMaxJobs = 1;/u);
  const handler = read("src/server/handlers/naver-shopping-local-worker.mjs");
  assert.match(handler, /const FAILURE_ERROR_DETAIL_EVIDENCE_VERSION = "collection-error-v1";/u);
  assert.doesNotMatch(handler, /p_error_detail/u);
});

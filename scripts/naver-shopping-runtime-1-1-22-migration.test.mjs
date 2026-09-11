import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { calculateN30RuntimeFingerprint } from "./naver-shopping-runtime-fingerprint.mjs";
import { auditMigrationRuntimeLiterals } from "./migration-runtime-literal-audit.mjs";

// Runtime 1.1.22 (2026-09-11): page-seam repeat skip + login-redirect
// classification. The migration only moves the runtime identity pins
// (finite-window targets, coordination row, progress entry gate); every other
// RPC stays runtime-neutral. This test pins the live surfaces to 1.1.22 and the
// archived 1.1.21 evidence to its historical identity.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260911003000_naver_shopping_runtime_1_1_22_seam_repeat_and_login_redirect.sql";
const priorMigrationName = "20260903090000_naver_shopping_runtime_1_1_21_finite_general_and_seam_tolerance.sql";
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const priorMigration = fs.readFileSync(path.join(migrationDirectory, priorMigrationName), "utf8");

const OLD_RUNTIME = Object.freeze({
  version: "1.1.21",
  fingerprint: "84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0",
});
const NEW_RUNTIME = Object.freeze({
  version: "1.1.22",
  fingerprint: "98f404a50ac89ce34092b0906a0923d197a3ca14024e098e1e4d4e510020509e",
});

function functionSql(source, name) {
  return source.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ))?.[0] || "";
}

test("1.1.22 is the newest runtime migration and the live fingerprint matches its pin", () => {
  const runtimeMigrations = fs.readdirSync(migrationDirectory)
    .filter((entry) => /_naver_shopping_runtime_1_1_\d+_/u.test(entry))
    .sort();
  assert.equal(runtimeMigrations.at(-1), migrationName);
  assert.deepEqual(calculateN30RuntimeFingerprint({
    repositoryRoot: root,
    version: NEW_RUNTIME.version,
  }).fingerprint, NEW_RUNTIME.fingerprint);
});

test("migration moves only the runtime identity pins from 1.1.21 to 1.1.22", () => {
  // Guard: idle control plane on the exact previous identity, no open cohorts.
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_22_requires_completed_account_priority'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_22_requires_idle_control_plane'/u);
  assert.match(migration, new RegExp(`current_row\\.runtime_version is distinct from '${OLD_RUNTIME.version.replace(/\./gu, "\\.")}'`, "u"));
  assert.match(migration, new RegExp(`current_row\\.runtime_fingerprint is distinct from\\s+'${OLD_RUNTIME.fingerprint}'`, "u"));
  // Finite-window targets: rows and CHECK move together.
  assert.match(migration, /drop constraint if exists naver_shopping_finite_window_targets_runtime_version_check/u);
  assert.match(migration, /set runtime_version = '1\.1\.22',\s+runtime_fingerprint =\s+'98f404a50ac89ce34092b0906a0923d197a3ca14024e098e1e4d4e510020509e'/u);
  assert.match(migration, /where runtime_version = '1\.1\.21'\s+and runtime_fingerprint = '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0'/u);
  assert.match(migration, /check \(runtime_version = '1\.1\.22'\)/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_22_finite_target_identity_mismatch'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_22_target_mismatch'/u);
  // Coordination: the prior identity is cleared, never re-labelled as current.
  assert.match(migration, /runtime_version = null,\s+runtime_fingerprint = null/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_22_coordination_mismatch'/u);
  // Exactly one function is re-declared: the allowlisted progress entry gate.
  assert.equal((migration.match(/create or replace function/gu) || []).length, 1);
  const progress = functionSql(migration, "mi_report_naver_shopping_worker_progress");
  assert.ok(progress, "progress gate must be re-declared with the new identity");
  assert.match(progress, /expected_runtime_version constant text := '1\.1\.22';/u);
  assert.match(progress, new RegExp(`expected_runtime_fingerprint constant text :=\\s+'${NEW_RUNTIME.fingerprint}';`, "u"));
  assert.match(progress, /security invoker/u);
  assert.match(progress, /set search_path = ''/u);
  assert.doesNotMatch(progress, /1\.1\.21|84334f5a/u);
  // The progress gate body is the 1.1.21 body with only the identity moved.
  const priorProgress = functionSql(priorMigration, "mi_report_naver_shopping_worker_progress");
  assert.equal(
    progress.replace(NEW_RUNTIME.version, OLD_RUNTIME.version).replace(NEW_RUNTIME.fingerprint, OLD_RUNTIME.fingerprint),
    priorProgress,
  );
  assert.match(migration, /revoke all on function public\.mi_report_naver_shopping_worker_progress\([\s\S]*?from public, anon, authenticated, service_role;/u);
  assert.match(migration, /grant execute on function public\.mi_report_naver_shopping_worker_progress\([\s\S]*?to service_role;/u);
  assert.doesNotMatch(migration, /1\.1\.20|4e0f5fbde16a892e/u);
  assert.match(migration, /^begin;$/mu);
  assert.match(migration, /^commit;$/mu);
});

test("the runtime literal audit still passes with the 1.1.22 progress gate as the only carrier", () => {
  const result = auditMigrationRuntimeLiterals({ migrationDirectory });
  assert.deepEqual(result.violations, []);
});

test("live surfaces are 1.1.22 while the archived 1.1.21 evidence keeps its historical identity", () => {
  assert.match(read("tools/naver-shopping-chrome-extension/manifest.json"), /"version": "1\.1\.22"/u);
  for (const relativePath of [
    "scripts/naver-shopping-local-worker.mjs",
    "src/server/handlers/naver-shopping-local-worker.mjs",
    "src/server/handlers/naver-rank-trackers.mjs",
    "src/server/naver-shopping/worker-runtime-expectation.mjs",
  ]) {
    assert.match(read(relativePath), /"1\.1\.22"/u, relativePath);
    assert.doesNotMatch(read(relativePath), /"1\.1\.21"/u, relativePath);
  }
  for (const relativePath of [
    "scripts/naver-shopping-candidate-performance-audit.mjs",
    "scripts/naver-shopping-account-rank-health-audit.mjs",
  ]) {
    assert.match(read(relativePath), /"1\.1\.22"/u, relativePath);
    assert.match(read(relativePath), new RegExp(NEW_RUNTIME.fingerprint, "u"), relativePath);
    assert.doesNotMatch(read(relativePath), new RegExp(OLD_RUNTIME.fingerprint, "u"), relativePath);
  }
  assert.match(priorMigration, new RegExp(OLD_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(priorMigration, /1\.1\.22/u);
});

test("1.1.22 collector behaviour is present in the fingerprinted runtime files", () => {
  const provider = read("tools/naver-shopping-rank-collector/src/provider.mjs");
  assert.match(provider, /export const MAX_SEAM_REPEAT_SKIPS = 2;/u);
  assert.match(provider, /state\.seamRepeatSkipCount/u);
  const serviceWorker = read("tools/naver-shopping-chrome-extension/service-worker.js");
  assert.match(serviceWorker, /function classifyOffHostTab\(/u);
  assert.match(serviceWorker, /Cannot access contents of \(the page\|url\)/u);
  assert.match(serviceWorker, /https:\\\/\\\/nid\\\.naver\\\.com\\\//u);
});

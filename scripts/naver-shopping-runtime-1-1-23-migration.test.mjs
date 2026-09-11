import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { calculateN30RuntimeFingerprint } from "./naver-shopping-runtime-fingerprint.mjs";
import { auditMigrationRuntimeLiterals } from "./migration-runtime-literal-audit.mjs";

// Runtime 1.1.23 (2026-09-11): rendered-order recovery aligned with Naver's
// live pages (market-total tolerance, twin-listing slots, ad-consumed first
// numbers, bounded seam regression, recorded failure details). The migration
// only moves the runtime identity pins; every other RPC stays runtime-neutral.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260911090000_naver_shopping_runtime_1_1_23_rendered_page_tolerance.sql";
const priorMigrationName = "20260911003000_naver_shopping_runtime_1_1_22_seam_repeat_and_login_redirect.sql";
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const priorMigration = fs.readFileSync(path.join(migrationDirectory, priorMigrationName), "utf8");

const OLD_RUNTIME = Object.freeze({
  version: "1.1.22",
  fingerprint: "98f404a50ac89ce34092b0906a0923d197a3ca14024e098e1e4d4e510020509e",
});
const NEW_RUNTIME = Object.freeze({
  version: "1.1.23",
  fingerprint: "26231beb6eb5cdd127afd3e216e96564d8923ee5195331723c5bc7f7443bc870",
});

function functionSql(source, name) {
  return source.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ))?.[0] || "";
}

// Archived 2026-09-11 (superseded by runtime 1.1.24): the live tree no longer
// carries the 1.1.23 identity, so only the migration text and its historical
// fingerprint are pinned here.
test("keeps the archived runtime 1.1.23 migration pinned to its historical fingerprint", () => {
  const runtimeMigrations = fs.readdirSync(migrationDirectory)
    .filter((entry) => /_naver_shopping_runtime_1_1_\d+_/u.test(entry))
    .sort();
  assert.ok(runtimeMigrations.includes(migrationName));
  assert.equal(runtimeMigrations.indexOf(migrationName), runtimeMigrations.length - 2);
  assert.equal(NEW_RUNTIME.fingerprint, "26231beb6eb5cdd127afd3e216e96564d8923ee5195331723c5bc7f7443bc870");
  assert.equal(typeof calculateN30RuntimeFingerprint, "function");
});

test("migration moves only the runtime identity pins from 1.1.22 to 1.1.23", () => {
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_23_requires_completed_account_priority'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_23_requires_idle_control_plane'/u);
  assert.match(migration, new RegExp(`current_row\\.runtime_version is distinct from '${OLD_RUNTIME.version.replace(/\./gu, "\\.")}'`, "u"));
  assert.match(migration, new RegExp(`current_row\\.runtime_fingerprint is distinct from\\s+'${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /drop constraint if exists naver_shopping_finite_window_targets_runtime_version_check/u);
  assert.match(migration, new RegExp(`set runtime_version = '1\\.1\\.23',\\s+runtime_fingerprint =\\s+'${NEW_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, new RegExp(`where runtime_version = '1\\.1\\.22'\\s+and runtime_fingerprint = '${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /check \(runtime_version = '1\.1\.23'\)/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_23_finite_target_identity_mismatch'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_23_target_mismatch'/u);
  assert.match(migration, /runtime_version = null,\s+runtime_fingerprint = null/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_23_coordination_mismatch'/u);
  assert.equal((migration.match(/create or replace function/gu) || []).length, 1);
  const progress = functionSql(migration, "mi_report_naver_shopping_worker_progress");
  assert.ok(progress, "progress gate must be re-declared with the new identity");
  assert.match(progress, /expected_runtime_version constant text := '1\.1\.23';/u);
  assert.match(progress, new RegExp(`expected_runtime_fingerprint constant text :=\\s+'${NEW_RUNTIME.fingerprint}';`, "u"));
  assert.match(progress, /security invoker/u);
  assert.match(progress, /set search_path = ''/u);
  assert.doesNotMatch(progress, /1\.1\.22|98f404a5/u);
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

test("the runtime literal audit still passes with the 1.1.23 progress gate as the only carrier", () => {
  const result = auditMigrationRuntimeLiterals({ migrationDirectory });
  assert.deepEqual(result.violations, []);
});

test("the archived 1.1.22 evidence keeps its historical identity", () => {
  assert.match(priorMigration, new RegExp(OLD_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(priorMigration, /1\.1\.23/u);
});

test("1.1.23 collector behaviour is still present in the fingerprinted runtime files", () => {
  const provider = read("tools/naver-shopping-rank-collector/src/provider.mjs");
  assert.match(provider, /export const MAX_RENDERED_DUPLICATE_ORGANIC_SLOTS = 2;/u);
  assert.match(provider, /export const MARKET_TOTAL_TOLERANCE_RATIO = 0\.01;/u);
  assert.match(provider, /export function marketTotalsWithinTolerance\(/u);
  assert.match(provider, /`\$\{expectedPage\}:\$\{index\}:duplicate_slot`/u);
  assert.match(provider, /duplicateOrganicSlotCount,\n\s+rawRankDigest:/u);
  const nativeHostCore = read("scripts/naver-shopping-native-host-core.mjs");
  assert.match(nativeHostCore, /: structure\.adSlotCount \+ 1;/u);
  assert.match(nativeHostCore, /boundaryGap >= -MAX_RENDERED_DUPLICATE_ORGANIC_SLOTS/u);
  assert.match(nativeHostCore, /marketTotalsWithinTolerance\(marketTotalAnchor, parsed\.marketTotal\)/u);
  const localWorker = read("scripts/naver-shopping-local-worker.mjs");
  assert.match(localWorker, /page_budget\|market_total\|invalid_window/u);
  assert.match(localWorker, /raw_rank\|duplicate_slot/u);
});

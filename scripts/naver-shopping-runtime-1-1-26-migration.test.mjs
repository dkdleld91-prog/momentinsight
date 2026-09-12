import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { calculateN30RuntimeFingerprint } from "./naver-shopping-runtime-fingerprint.mjs";
import { auditMigrationRuntimeLiterals } from "./migration-runtime-literal-audit.mjs";

// Runtime 1.1.26 (2026-09-12): rendered-order proof identity falls back to the
// canonical product URL when a seller card has no numeric seller id. The migration
// only moves the runtime identity pins; every other RPC stays runtime-neutral.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260912060000_naver_shopping_runtime_1_1_26_rendered_identity_fallback.sql";
const priorMigrationName = "20260911170000_naver_shopping_runtime_1_1_25_rendered_identity.sql";
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const priorMigration = fs.readFileSync(path.join(migrationDirectory, priorMigrationName), "utf8");

const OLD_RUNTIME = Object.freeze({
  version: "1.1.25",
  fingerprint: "424d352b4667427cde8aa272d847cdf29c2c03c5b7760df6e38e5c8c18f2e05e",
});
const NEW_RUNTIME = Object.freeze({
  version: "1.1.26",
  fingerprint: "6033788f59076da8d625a078a5066385347e9d7fa9d679f48189605596857013",
});

function functionSql(source, name) {
  return source.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ))?.[0] || "";
}

// Archived 2026-09-12 (superseded by runtime 1.1.27).
test("keeps the archived runtime 1.1.26 migration pinned to its historical fingerprint", () => {
  const runtimeMigrations = fs.readdirSync(migrationDirectory)
    .filter((entry) => /_naver_shopping_runtime_1_1_\d+_/u.test(entry))
    .sort();
  assert.ok(runtimeMigrations.includes(migrationName));
  assert.ok(runtimeMigrations.indexOf(migrationName) < runtimeMigrations.length - 1);
  assert.equal(NEW_RUNTIME.fingerprint, "6033788f59076da8d625a078a5066385347e9d7fa9d679f48189605596857013");
  assert.equal(typeof calculateN30RuntimeFingerprint, "function");
});

test("migration moves only the runtime identity pins from 1.1.25 to 1.1.26", () => {
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_26_requires_completed_account_priority'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_26_requires_idle_control_plane'/u);
  assert.match(migration, new RegExp(`current_row\\.runtime_version is distinct from '${OLD_RUNTIME.version.replace(/\./gu, "\\.")}'`, "u"));
  assert.match(migration, new RegExp(`current_row\\.runtime_fingerprint is distinct from\\s+'${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /drop constraint if exists naver_shopping_finite_window_targets_runtime_version_check/u);
  assert.match(migration, new RegExp(`set runtime_version = '1\\.1\\.26',\\s+runtime_fingerprint =\\s+'${NEW_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, new RegExp(`where runtime_version = '1\\.1\\.25'\\s+and runtime_fingerprint = '${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /check \(runtime_version = '1\.1\.26'\)/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_26_finite_target_identity_mismatch'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_26_target_mismatch'/u);
  assert.match(migration, /runtime_version = null,\s+runtime_fingerprint = null/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_26_coordination_mismatch'/u);
  assert.equal((migration.match(/create or replace function/gu) || []).length, 1);
  const progress = functionSql(migration, "mi_report_naver_shopping_worker_progress");
  assert.ok(progress, "progress gate must be re-declared with the new identity");
  assert.match(progress, /expected_runtime_version constant text := '1\.1\.26';/u);
  assert.match(progress, new RegExp(`expected_runtime_fingerprint constant text :=\\s+'${NEW_RUNTIME.fingerprint}';`, "u"));
  assert.match(progress, /security invoker/u);
  assert.match(progress, /set search_path = ''/u);
  assert.doesNotMatch(progress, /1\.1\.25|424d352b/u);
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

test("the runtime literal audit still passes with the 1.1.26 progress gate as the only carrier", () => {
  const result = auditMigrationRuntimeLiterals({ migrationDirectory });
  assert.deepEqual(result.violations, []);
});

test("the archived 1.1.25 evidence keeps its historical identity", () => {
  assert.match(priorMigration, new RegExp(OLD_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(priorMigration, /1\.1\.26/u);
});

test("1.1.26 rendered-order proof identity is present in the fingerprinted runtime files", () => {
  const contract = read("tools/naver-shopping-rank-collector/src/contract.mjs");
  assert.match(contract, /const \[signal\] = identitySignals\(item\);\n  if \(signal\) return signal;/u);
  const provider = read("tools/naver-shopping-rank-collector/src/provider.mjs");
  assert.match(provider, /export const SEAM_LEADING_ORGANIC_ROWS = 3;/u);
  assert.match(provider, /export const SEAM_TRAILING_ORGANIC_ROWS = 5;/u);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { calculateN30RuntimeFingerprint } from "./naver-shopping-runtime-fingerprint.mjs";
import { auditMigrationRuntimeLiterals } from "./migration-runtime-literal-audit.mjs";

// Runtime 1.1.32 (2026-09-19): a finite market that repeats products across pages is arbitrated as a
// finite window and its two-capture finite digest proves the repeats (탄소매트 `partial_window:288_300`).
// The migration only moves the runtime identity pins; every other RPC stays runtime-neutral.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260919020000_naver_shopping_runtime_1_1_32_finite_cross_page_repeats.sql";
const priorMigrationName = "20260918030000_naver_shopping_runtime_1_1_31_evidence_v2_third_pass.sql";
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const priorMigration = fs.readFileSync(path.join(migrationDirectory, priorMigrationName), "utf8");

const OLD_RUNTIME = Object.freeze({
  version: "1.1.31",
  fingerprint: "099bf53085a118ee3917c5f5596e72a08efe91faa3247b9091ddb27241149116",
});
const NEW_RUNTIME = Object.freeze({
  version: "1.1.32",
  fingerprint: "62ad583be7a9d57b8fce77b91f810b324d57cedcbb9a120676deeb9a703681cc",
});

function functionSql(source, name) {
  return source.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ))?.[0] || "";
}

test("1.1.32 is the newest runtime migration and the live fingerprint matches its pin", () => {
  const runtimeMigrations = fs.readdirSync(migrationDirectory)
    .filter((entry) => /_naver_shopping_runtime_1_1_\d+_/u.test(entry))
    .sort();
  assert.equal(runtimeMigrations.at(-1), migrationName);
  assert.deepEqual(calculateN30RuntimeFingerprint({
    repositoryRoot: root,
    version: NEW_RUNTIME.version,
  }).fingerprint, NEW_RUNTIME.fingerprint);
});

test("migration moves only the runtime identity pins from 1.1.31 to 1.1.32", () => {
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_32_requires_completed_account_priority'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_32_requires_idle_control_plane'/u);
  assert.match(migration, new RegExp(`current_row\\.runtime_version is distinct from '${OLD_RUNTIME.version.replace(/\./gu, "\\.")}'`, "u"));
  assert.match(migration, new RegExp(`current_row\\.runtime_fingerprint is distinct from\\s+'${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /drop constraint if exists naver_shopping_finite_window_targets_runtime_version_check/u);
  assert.match(migration, new RegExp(`set runtime_version = '1\\.1\\.32',\\s+runtime_fingerprint =\\s+'${NEW_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, new RegExp(`where runtime_version = '1\\.1\\.31'\\s+and runtime_fingerprint = '${OLD_RUNTIME.fingerprint}'`, "u"));
  assert.match(migration, /check \(runtime_version = '1\.1\.32'\)/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_32_finite_target_identity_mismatch'/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_32_target_mismatch'/u);
  assert.match(migration, /runtime_version = null,\s+runtime_fingerprint = null/u);
  assert.match(migration, /raise exception 'naver_shopping_runtime_1_1_32_coordination_mismatch'/u);
  assert.equal((migration.match(/create or replace function/gu) || []).length, 1);
  const progress = functionSql(migration, "mi_report_naver_shopping_worker_progress");
  assert.ok(progress, "progress gate must be re-declared with the new identity");
  assert.match(progress, /expected_runtime_version constant text := '1\.1\.32';/u);
  assert.match(progress, new RegExp(`expected_runtime_fingerprint constant text :=\\s+'${NEW_RUNTIME.fingerprint}';`, "u"));
  assert.match(progress, /security invoker/u);
  assert.match(progress, /set search_path = ''/u);
  assert.doesNotMatch(progress, /1\.1\.31|099bf530/u);
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

test("the runtime literal audit still passes with the 1.1.32 progress gate as the only carrier", () => {
  const result = auditMigrationRuntimeLiterals({ migrationDirectory });
  assert.deepEqual(result.violations, []);
});

test("live surfaces are 1.1.32 while the archived 1.1.31 evidence keeps its historical identity", () => {
  assert.match(read("tools/naver-shopping-chrome-extension/manifest.json"), /"version": "1\.1\.32"/u);
  for (const relativePath of [
    "scripts/naver-shopping-local-worker.mjs",
    "src/server/handlers/naver-shopping-local-worker.mjs",
    "src/server/handlers/naver-rank-trackers.mjs",
    "src/server/naver-shopping/worker-runtime-expectation.mjs",
  ]) {
    assert.match(read(relativePath), /"1\.1\.32"/u, relativePath);
    assert.doesNotMatch(read(relativePath), /"1\.1\.31"/u, relativePath);
  }
  for (const relativePath of [
    "scripts/naver-shopping-candidate-performance-audit.mjs",
    "scripts/naver-shopping-account-rank-health-audit.mjs",
  ]) {
    assert.match(read(relativePath), /"1\.1\.32"/u, relativePath);
    assert.match(read(relativePath), new RegExp(NEW_RUNTIME.fingerprint, "u"), relativePath);
    assert.doesNotMatch(read(relativePath), new RegExp(OLD_RUNTIME.fingerprint, "u"), relativePath);
  }
  assert.match(priorMigration, new RegExp(OLD_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(priorMigration, /1\.1\.32/u);
});

test("1.1.32 finite markets with cross-page repeats are present in the fingerprinted runtime files", () => {
  const nativeHost = read("scripts/naver-shopping-native-host-core.mjs");
  assert.match(nativeHost, /const arbitrateFinite = async \(\) => \{/u);
  assert.match(nativeHost, /if \(finiteArbitration\) return arbitrateFinite\(\);/u);
  assert.match(nativeHost, /if \(!isPartialWindow\(error\) \|\| collectOptions\.allowStableFinite !== true\) throw error;/u);
  assert.match(nativeHost, /return payload\.checkedCount < REQUIRED_LIMIT \? \{ payload, renderedOrder: false, crossPage: true \} : null;/u);
  assert.match(nativeHost, /\? \{ crossPageMode: STABLE_FULL_WINDOW_PROOF_VERSION \}/u);
  const contract = read("tools/naver-shopping-rank-collector/src/contract.mjs");
  assert.match(contract, /const finiteProofOffered = value\.checkedCount < request\.limit && value\.finiteWindowProof !== undefined;/u);
  assert.match(contract, /if \(crossPageDuplicate && finiteProofOffered\) \{/u);
  assert.doesNotMatch(contract, /\|\| marketTotal !== value\.checkedCount\n      \|\| crossPageDuplicate\) \{/u);
  const handler = read("src/server/handlers/naver-shopping-rank.mjs");
  assert.match(handler, /\? \(payload\?\.finiteWindowProof !== undefined\n      \? payload\?\.crossPageProof === undefined\n        && payload\?\.renderedOrderProof === undefined\n        && Boolean\(stableFiniteWindowProof\)/u);
  assert.doesNotMatch(handler, /const stableFiniteWindowProof = !crossPageDuplicate/u);
});

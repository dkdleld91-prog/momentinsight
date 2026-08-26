import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
const stableMigrationName = "20260826035440_naver_shopping_stable_finite_window_v1.sql";
const stableMigration = fs.readFileSync(path.join(migrationDirectory, stableMigrationName), "utf8");
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => /^\d{14}_naver_shopping_runtime_1_1_15(?:_[a-z0-9_]+)?\.sql$/u.test(name));
const migrationName = migrationNames[0] || "";
const migration = migrationName
  ? fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8")
  : "";

const runtimeFiles = [
  "tools/naver-shopping-chrome-extension/service-worker.js",
  "scripts/naver-shopping-native-host.mjs",
  "scripts/naver-shopping-native-host-core.mjs",
  "scripts/naver-shopping-local-worker.mjs",
  "src/server/local-worker-auth.mjs",
  "src/server/naver-shopping/local-worker-contract.mjs",
  "src/server/handlers/naver-shopping-rank.mjs",
  "src/server/security.mjs",
  "src/server/naver-shopping/source-status.mjs",
  "src/server/naver-shopping/provider-runtime.mjs",
  "src/server/naver-shopping/mobile-top-fallback.mjs",
  "tools/naver-shopping-rank-collector/src/provider.mjs",
  "tools/naver-shopping-rank-collector/src/contract.mjs",
];

function runtimeFixture(version) {
  return Object.freeze({
    version,
    fingerprint: crypto.createHash("sha256").update([
      version,
      ...runtimeFiles.map((name) => crypto.createHash("sha256")
        .update(fs.readFileSync(path.join(repositoryRoot, name)))
        .digest("hex")),
    ].join("\n"), "utf8").digest("hex"),
  });
}

const expectedRuntime = runtimeFixture("1.1.15");

function requireMigration() {
  assert.equal(migrationNames.length, 1, "one later runtime 1.1.15 migration is required");
  assert.ok(migrationName > stableMigrationName, "runtime 1.1.15 migration must follow stable-finite v1");
  assert.ok(migration, "runtime 1.1.15 migration must be readable");
}

function requireAll(source, patterns) {
  for (const pattern of patterns) assert.match(source, pattern);
}

function functionBlocks(source, schema, name) {
  const pattern = new RegExp(
    `create or replace function ${schema.replace(".", "\\.")}\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "giu",
  );
  return [...source.matchAll(pattern)].map((match) => match[0]);
}

function latestFunctionBlock(schema, name) {
  return functionBlocks(`${stableMigration}\n${migration}`, schema, name).at(-1) || "";
}

test("adds exactly one later runtime 1.1.15 migration", () => {
  requireMigration();
  assert.match(migration, /^begin;/imu);
  assert.match(migration, /commit;\s*$/iu);
});

test("updates only the exact stable-finite target to the final runtime fixture", () => {
  requireMigration();
  const targetUpdate = migration.match(
    /update\s+public\.naver_shopping_finite_window_targets[\s\S]*?;/iu,
  )?.[0] || "";

  requireAll(migration, [
    /alter table public\.naver_shopping_finite_window_targets[\s\S]*drop constraint if exists naver_shopping_finite_window_targets_runtime_version_check/iu,
    /add constraint naver_shopping_finite_window_targets_runtime_version_check[\s\S]*check\s*\(runtime_version = '1\.1\.15'\)/iu,
  ]);
  requireAll(targetUpdate, [
    /runtime_version\s*=\s*'1\.1\.15'/iu,
    new RegExp(`runtime_fingerprint\\s*=\\s*'${expectedRuntime.fingerprint}'`, "iu"),
    /tracker_id\s*=\s*'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid/iu,
    /seller_product_id\s*=\s*'13327339525'/iu,
    /parent_catalog_id\s*=\s*'59776958987'/iu,
    /normalized_keyword\s*=\s*'아이쉘차량용거치대'/iu,
    /proof_version\s*=\s*'stable-finite-window-v1'/iu,
    /enabled\s*=\s*true/iu,
  ]);
  assert.doesNotMatch(targetUpdate, /1\.1\.14|stable-finite-window-v2/iu);
  assert.doesNotMatch(targetUpdate, /thumbnail|image|similarity|product_title|title/iu);
});

test("applies the runtime bump only while the complete control plane is idle", () => {
  requireMigration();
  requireAll(migration, [
    /set local lock_timeout = '5s'/iu,
    /lock table public\.naver_shopping_worker_coordination in access exclusive mode/iu,
    /from public\.naver_shopping_worker_coordination[\s\S]*where lane_key = 'global'[\s\S]*for update/iu,
    /public\.naver_shopping_rank_lookup_jobs[\s\S]*status = 'processing'[\s\S]*processing_until > clock_timestamp\(\)/iu,
    /public\.naver_rank_trackers[\s\S]*status = 'active'[\s\S]*processing_until > clock_timestamp\(\)/iu,
    /current_row\.circuit_state is distinct from 'closed'/iu,
    /current_row\.circuit_reason is not null/iu,
    /current_row\.cooldown_until is not null/iu,
    /processing_count <> 0/iu,
    /current_row\.lease_worker_id is not null/iu,
    /current_row\.lease_token is not null/iu,
    /current_row\.lease_until is not null/iu,
    /current_row\.run_id is not null/iu,
    /current_row\.current_stage is not null/iu,
    /current_row\.current_page is distinct from 0/iu,
    /current_row\.current_job_kind is not null/iu,
    /current_row\.current_tracker_id is not null/iu,
    /current_row\.current_job_started_at is not null/iu,
    /current_row\.probe_tracker_id is not null/iu,
    /current_row\.probe_started_at is not null/iu,
    /raise exception 'naver_shopping_runtime_1_1_15_requires_idle_control_plane'/iu,
    /target\.runtime_version is distinct from '1\.1\.14'/iu,
    /target\.runtime_fingerprint is distinct from '13e801cf18adaea7352d7c78bbe067f969e3fef5e756528335443d3122b2d405'/iu,
  ]);

  const guardIndex = migration.indexOf("naver_shopping_runtime_1_1_15_requires_idle_control_plane");
  const targetUpdateIndex = migration.search(/update\s+public\.naver_shopping_finite_window_targets/iu);
  const resetIndex = migration.search(/update\s+public\.naver_shopping_worker_coordination/iu);
  assert.ok(guardIndex >= 0 && guardIndex < targetUpdateIndex && guardIndex < resetIndex);
});

test("resets cadence proof to baseline10 while preserving candidate6 and proof v1", () => {
  requireMigration();
  const reset = migration.match(
    /update\s+public\.naver_shopping_worker_coordination[\s\S]*?;/iu,
  )?.[0] || "";
  requireAll(reset, [
    /cadence_mode\s*=\s*'baseline'/iu,
    /cadence_minutes\s*=\s*10/iu,
    /stability_started_at\s*=\s*null/iu,
    /success_streak\s*=\s*0/iu,
    /runtime_version\s*=\s*null/iu,
    /runtime_fingerprint\s*=\s*null/iu,
    /where lane_key\s*=\s*'global'/iu,
  ]);
  assert.doesNotMatch(reset, /last_success_at|last_collection_id|last_checked_count|last_source/iu);
  assert.match(migration, /stable-finite-window-v1/iu);
  assert.doesNotMatch(migration, /cadence_mode = 'candidate' and cadence_minutes = (?:7|8)/iu);
});

test("requires exactly one target row before committing the runtime transition", () => {
  requireMigration();
  requireAll(migration, [
    /get diagnostics target_updated_count = row_count/iu,
    /if target_updated_count <> 1 then[\s\S]*raise exception 'naver_shopping_runtime_1_1_15_target_mismatch'/iu,
  ]);
});

test("pins every runtime-sensitive RPC to 1.1.15 without weakening cadence gates", () => {
  requireMigration();
  for (const name of [
    "mi_report_naver_shopping_worker_progress",
    "mi_get_naver_shopping_worker_operations",
    "mi_set_naver_shopping_worker_cadence",
    "mi_record_naver_shopping_worker_failure",
  ]) {
    const blocks = functionBlocks(migration, "public", name);
    assert.equal(blocks.length, 1, `${name} must be replaced exactly once`);
    assert.match(blocks[0], /1\.1\.15/iu);
    assert.doesNotMatch(blocks[0], /1\.1\.14/iu);
  }

  const failure = latestFunctionBlock("public", "mi_record_naver_shopping_worker_failure");
  assert.doesNotMatch(failure, /current_row\.runtime_version\s*=\s*'1\.1\.13'/iu);

  const cadence = latestFunctionBlock("public", "mi_set_naver_shopping_worker_cadence");
  requireAll(cadence, [
    /for update;\s*v_now := clock_timestamp\(\)/iu,
    /processing_count = 0/iu,
    /current_row\.lease_worker_id is null/iu,
    /current_row\.run_id is null/iu,
    /current_row\.probe_tracker_id is null/iu,
    /current_row\.runtime_version = target\.runtime_version/iu,
    /current_row\.runtime_fingerprint = target\.runtime_fingerprint/iu,
    /set cadence_mode = 'candidate', cadence_minutes = 6/iu,
    /set cadence_mode = 'baseline', cadence_minutes = 10/iu,
  ]);
});

test("preserves forced RLS and service-role-only SECURITY INVOKER RPCs", () => {
  requireMigration();
  requireAll(migration, [
    /alter table public\.naver_shopping_finite_window_targets enable row level security/iu,
    /alter table public\.naver_shopping_finite_window_targets force row level security/iu,
    /revoke all on table public\.naver_shopping_finite_window_targets\s+from public, anon, authenticated, service_role/iu,
    /grant select on table public\.naver_shopping_finite_window_targets\s+to service_role/iu,
  ]);
  assert.doesNotMatch(
    migration,
    /grant\s+(?:insert|update|delete|all)[^;]*naver_shopping_finite_window_targets/iu,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.[^(]+\([^;]+\)\s+to\s+(?:public|anon|authenticated)/iu,
  );

  for (const name of [
    "mi_report_naver_shopping_worker_progress",
    "mi_get_naver_shopping_worker_operations",
    "mi_set_naver_shopping_worker_cadence",
    "mi_commit_naver_shopping_worker_result",
    "mi_commit_naver_shopping_finite_worker_result",
    "mi_record_naver_shopping_worker_failure",
  ]) {
    const block = latestFunctionBlock("public", name);
    assert.ok(block, `${name} must remain defined`);
    assert.match(block, /security invoker/iu);
    assert.match(block, /set search_path = ''/iu);
  }

  requireAll(`${stableMigration}\n${migration}`, [
    /revoke all on function public\.mi_report_naver_shopping_worker_progress\([^)]+\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_report_naver_shopping_worker_progress\([^)]+\)\s+to service_role/iu,
    /revoke all on function public\.mi_get_naver_shopping_worker_operations\(\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_get_naver_shopping_worker_operations\(\)\s+to service_role/iu,
    /revoke all on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s+to service_role/iu,
    /revoke all on function public\.mi_record_naver_shopping_worker_failure\([^)]+\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_record_naver_shopping_worker_failure\([^)]+\)\s+to service_role/iu,
  ]);
});

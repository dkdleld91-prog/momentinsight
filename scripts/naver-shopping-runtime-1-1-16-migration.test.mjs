import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
const exactParentMigrationName = "20260827050000_naver_shopping_exact_parent_relation_guard.sql";
const schemaDriftRecoveryMigrationName = "20260827194500_naver_shopping_next_data_schema_drift_recovery.sql";
const supersavingRecoveryMigrationName = "20260828025000_naver_shopping_supersaving_composite_recovery.sql";
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => /^\d{14}_naver_shopping_runtime_1_1_16(?:_[a-z0-9_]+)?\.sql$/u.test(name));
const migrationName = migrationNames[0] || "";
const migration = migrationName
  ? fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8")
  : "";
const schemaDriftRecoveryMigration = fs.readFileSync(
  path.join(migrationDirectory, schemaDriftRecoveryMigrationName),
  "utf8",
);
const supersavingRecoveryMigration = fs.readFileSync(
  path.join(migrationDirectory, supersavingRecoveryMigrationName),
  "utf8",
);
const updater = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "windows", "update-naver-shopping-chrome-extension.ps1"),
  "utf8",
);
const initialRuntimeFingerprint =
  "570ffc52d411f2ae34e247b77d7fb645d36f4478b624ed56926a6ccc00b6159f";
const schemaRecoveryRuntimeFingerprint =
  "8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1";
const supersavingRecoveryRuntimeFingerprint =
  "9680164f90965609896b72c05b09e67946bc51d1df44c76d0cb5b9e5f0085478";

function requireMigration() {
  assert.equal(migrationNames.length, 1, "one additive runtime 1.1.16 migration is required");
  assert.ok(migrationName > exactParentMigrationName, "runtime 1.1.16 must follow the exact-parent guard");
  assert.ok(migration, "runtime 1.1.16 migration must be readable");
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

test("adds one runtime 1.1.16 migration after the global exact-parent guard", () => {
  requireMigration();
  assert.match(migration, /^begin;/imu);
  assert.match(migration, /commit;\s*$/iu);
});

test("keeps the historical runtime 1.1.16 fingerprint transitions immutable", () => {
  requireMigration();
  assert.match(migration, new RegExp(initialRuntimeFingerprint, "u"));
  assert.match(schemaDriftRecoveryMigration, new RegExp(initialRuntimeFingerprint, "u"));
  assert.match(schemaDriftRecoveryMigration, new RegExp(schemaRecoveryRuntimeFingerprint, "u"));
  assert.match(supersavingRecoveryMigration, new RegExp(schemaRecoveryRuntimeFingerprint, "u"));
  assert.match(supersavingRecoveryMigration, new RegExp(supersavingRecoveryRuntimeFingerprint, "u"));
  assert.match(
    updater,
    /\$ExpectedVersion`n\$serviceWorkerHash`n\$nativeHostHash`n\$nativeHostCoreHash`n\$localWorkerHash`n\$localWorkerAuthHash`n\$localWorkerContractHash`n\$shoppingRankHandlerHash`n\$securityHash`n\$sourceStatusHash`n\$providerRuntimeHash`n\$mobileTopFallbackHash`n\$collectorProviderHash`n\$collectorContractHash/u,
  );
});

test("keeps the first exact idle schema-drift recovery immutable", () => {
  requireAll(schemaDriftRecoveryMigration, [
    /^begin;/imu,
    /commit;\s*$/iu,
    /set local lock_timeout = '5s'/iu,
    /lock table public\.naver_shopping_worker_coordination in access exclusive mode/iu,
    /where lane_key = 'global'[\s\S]*for update/iu,
    /target\.runtime_version is distinct from '1\.1\.16'/iu,
    /570ffc52d411f2ae34e247b77d7fb645d36f4478b624ed56926a6ccc00b6159f/u,
    /prior_row\.circuit_state is distinct from 'open'/iu,
    /prior_row\.circuit_reason is distinct from prior_row\.failure_signature/iu,
    /prior_row\.circuit_reason is distinct from\s*\('collecting:' \|\| coalesce\(prior_row\.last_failure_code, ''\)\)/iu,
    /\^collecting:naver_next_data_schema_drift:compositelist_list_\[0-9\]\+_type\$/u,
    /prior_row\.current_stage is distinct from 'failed'/iu,
    /prior_row\.current_page is distinct from 8/iu,
    /processing_count <> 0/iu,
    /prior_row\.lease_worker_id is not null/iu,
    /prior_row\.lease_token is not null/iu,
    /prior_row\.lease_until is not null/iu,
    /prior_row\.run_id is not null/iu,
    /prior_row\.current_job_kind is not null/iu,
    /prior_row\.current_tracker_id is not null/iu,
    /prior_row\.current_job_started_at is not null/iu,
    /prior_row\.probe_tracker_id is not null/iu,
    /prior_row\.probe_started_at is not null/iu,
    /prior_row\.last_collection_id !~ '\^pw-chrome-'/iu,
    /prior_row\.last_checked_count is distinct from 300/iu,
    /prior_row\.last_source is distinct from 'naver_shopping_results_collector'/iu,
    /prior_row\.last_failure_at <= prior_row\.last_success_at/iu,
    /get diagnostics target_updated_count = row_count/iu,
    /get diagnostics coordination_updated_count = row_count/iu,
    /target_updated_count <> 1/iu,
    /coordination_updated_count <> 1/iu,
    /8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1/u,
    /cadence_mode = 'baseline'/iu,
    /cadence_minutes = 10/iu,
    /stability_started_at = null/iu,
    /success_streak = 0/iu,
    /runtime_version = null/iu,
    /runtime_fingerprint = null/iu,
    /circuit_state = 'closed'/iu,
    /circuit_reason = null/iu,
    /failure_signature = null/iu,
    /failure_streak = 0/iu,
    /current_stage = null/iu,
    /current_page = 0/iu,
    /post_row\.last_collection_id is distinct from prior_row\.last_collection_id/iu,
    /post_row\.last_failure_code is distinct from prior_row\.last_failure_code/iu,
  ]);

  assert.doesNotMatch(schemaDriftRecoveryMigration, /update public\.naver_rank_trackers/iu);
  assert.doesNotMatch(schemaDriftRecoveryMigration, /update public\.naver_shopping_rank_lookup_jobs/iu);
  assert.doesNotMatch(schemaDriftRecoveryMigration, /insert into public\.naver_shopping_worker_events/iu);
  assert.doesNotMatch(schemaDriftRecoveryMigration, /create or replace function public\./iu);
});

test("recovers only the exact idle supersaving circuit and preserves all evidence", () => {
  assert.ok(
    supersavingRecoveryMigrationName > schemaDriftRecoveryMigrationName,
    "supersaving recovery must follow the first schema-drift recovery",
  );
  requireAll(supersavingRecoveryMigration, [
    /^begin;/imu,
    /commit;\s*$/iu,
    /set local lock_timeout = '5s'/iu,
    /lock table public\.naver_shopping_worker_coordination in access exclusive mode/iu,
    /where lane_key = 'global'[\s\S]*for update/iu,
    /prior_target\.runtime_version is distinct from '1\.1\.16'/iu,
    new RegExp(schemaRecoveryRuntimeFingerprint, "u"),
    /prior_row\.circuit_state is distinct from 'open'/iu,
    /prior_row\.circuit_reason is distinct from prior_row\.failure_signature/iu,
    /prior_row\.circuit_reason is distinct from\s*\('collecting:' \|\| coalesce\(prior_row\.last_failure_code, ''\)\)/iu,
    /\^collecting:naver_next_data_schema_drift:compositelist_list_\[0-9\]\+_type_supersaving\$/u,
    /\^naver_next_data_schema_drift:compositelist_list_\[0-9\]\+_type_supersaving\$/u,
    /prior_row\.current_stage is distinct from 'failed'/iu,
    /prior_row\.current_page is distinct from 8/iu,
    /processing_count <> 0/iu,
    /prior_row\.lease_worker_id is not null/iu,
    /prior_row\.lease_token is not null/iu,
    /prior_row\.lease_until is not null/iu,
    /prior_row\.run_id is not null/iu,
    /prior_row\.current_job_kind is not null/iu,
    /prior_row\.current_tracker_id is not null/iu,
    /prior_row\.current_job_started_at is not null/iu,
    /prior_row\.probe_tracker_id is not null/iu,
    /prior_row\.probe_started_at is not null/iu,
    /prior_row\.last_collection_id !~ '\^pw-chrome-'/iu,
    /prior_row\.last_checked_count is distinct from 300/iu,
    /prior_row\.last_excluded_ad_count is null/iu,
    /prior_row\.last_duration_ms is null/iu,
    /prior_row\.last_source is distinct from 'naver_shopping_results_collector'/iu,
    /prior_row\.last_failure_at <= prior_row\.last_success_at/iu,
    /get diagnostics target_updated_count = row_count/iu,
    /get diagnostics coordination_updated_count = row_count/iu,
    /target_updated_count <> 1/iu,
    /coordination_updated_count <> 1/iu,
    new RegExp(supersavingRecoveryRuntimeFingerprint, "u"),
    /cadence_mode = 'baseline'/iu,
    /cadence_minutes = 10/iu,
    /stability_started_at = null/iu,
    /success_streak = 0/iu,
    /runtime_version = null/iu,
    /runtime_fingerprint = null/iu,
    /circuit_state = 'closed'/iu,
    /circuit_reason = null/iu,
    /failure_signature = null/iu,
    /failure_streak = 0/iu,
    /current_stage = null/iu,
    /current_page = 0/iu,
    /post_row\.last_success_at is distinct from prior_row\.last_success_at/iu,
    /post_row\.last_collection_id is distinct from prior_row\.last_collection_id/iu,
    /post_row\.last_failure_at is distinct from prior_row\.last_failure_at/iu,
    /post_row\.last_failure_code is distinct from prior_row\.last_failure_code/iu,
    /to_jsonb\(post_target\) - 'runtime_fingerprint'/iu,
    /to_jsonb\(prior_target\) - 'runtime_fingerprint'/iu,
    /to_jsonb\(post_row\) - array\[/iu,
    /to_jsonb\(prior_row\) - array\[/iu,
    /post_row\.scheduler_cycle_cursor_tracker_id is distinct from prior_row\.scheduler_cycle_cursor_tracker_id/iu,
  ]);

  assert.doesNotMatch(supersavingRecoveryMigration, /update public\.naver_rank_trackers/iu);
  assert.doesNotMatch(supersavingRecoveryMigration, /update public\.naver_shopping_rank_lookup_jobs/iu);
  assert.doesNotMatch(supersavingRecoveryMigration, /insert into public\.naver_shopping_worker_events/iu);
  assert.doesNotMatch(supersavingRecoveryMigration, /create or replace function public\./iu);
});

test("transitions only from exact runtime 1.1.15 while idle and resets cadence proof", () => {
  requireMigration();
  requireAll(migration, [
    /set local lock_timeout = '5s'/iu,
    /lock table public\.naver_shopping_worker_coordination in access exclusive mode/iu,
    /where lane_key = 'global'[\s\S]*for update/iu,
    /target\.runtime_version is distinct from '1\.1\.15'/iu,
    /target\.runtime_fingerprint is distinct from 'c7941930ccabd1206f19cc9ae5cfcd744f12313974c37d5143ed5f795ec9b46c'/iu,
    /current_row\.circuit_state is distinct from 'closed'/iu,
    /current_row\.circuit_reason is not null/iu,
    /current_row\.cooldown_until is not null/iu,
    /processing_count <> 0/iu,
    /current_row\.lease_worker_id is not null/iu,
    /current_row\.run_id is not null/iu,
    /current_row\.current_stage is not null/iu,
    /current_row\.current_job_kind is not null/iu,
    /current_row\.current_tracker_id is not null/iu,
    /current_row\.probe_tracker_id is not null/iu,
    /raise exception 'naver_shopping_runtime_1_1_16_requires_idle_control_plane'/iu,
    /set runtime_version = '1\.1\.16'/iu,
    /check\s*\(runtime_version = '1\.1\.16'\)/iu,
    /cadence_mode\s*=\s*'baseline'/iu,
    /cadence_minutes\s*=\s*10/iu,
    /stability_started_at\s*=\s*null/iu,
    /success_streak\s*=\s*0/iu,
    /runtime_version\s*=\s*null/iu,
    /runtime_fingerprint\s*=\s*null/iu,
  ]);
  const coordinationReset = migration.match(
    /update public\.naver_shopping_worker_coordination[\s\S]*?where lane_key = 'global';/iu,
  )?.[0] || "";
  assert.ok(coordinationReset, "coordination reset statement must exist");
  assert.doesNotMatch(
    coordinationReset,
    /last_success_at\s*=|last_collection_id\s*=|last_checked_count\s*=/iu,
  );
});

test("pins all runtime-sensitive RPCs to 1.1.16 and preserves candidate6 baseline10", () => {
  requireMigration();
  for (const name of [
    "mi_report_naver_shopping_worker_progress",
    "mi_get_naver_shopping_worker_operations",
    "mi_set_naver_shopping_worker_cadence",
    "mi_record_naver_shopping_worker_failure",
  ]) {
    const blocks = functionBlocks(migration, "public", name);
    assert.equal(blocks.length, 1, `${name} must be replaced exactly once`);
    assert.match(blocks[0], /1\.1\.16/iu);
  }
  const cadence = functionBlocks(migration, "public", "mi_set_naver_shopping_worker_cadence")[0];
  requireAll(cadence, [
    /processing_count = 0/iu,
    /current_row\.lease_worker_id is null/iu,
    /current_row\.run_id is null/iu,
    /current_row\.probe_tracker_id is null/iu,
    /current_row\.runtime_version = target\.runtime_version/iu,
    /current_row\.runtime_fingerprint = target\.runtime_fingerprint/iu,
    /set cadence_mode = 'candidate', cadence_minutes = 6/iu,
    /set cadence_mode = 'baseline', cadence_minutes = 10/iu,
    /get diagnostics updated_count = row_count/iu,
    /updated_count <> 1/iu,
    /'reason', 'coordination_missing'/iu,
    /current_row\.cadence_mode is distinct from 'baseline'/iu,
    /current_row\.cadence_minutes is distinct from 10/iu,
    /'reason', 'baseline_postcheck_failed'/iu,
  ]);
  assert.doesNotMatch(cadence, /cadence_minutes = (?:7|8)/iu);
});

test("keeps finite target forced-RLS and runtime RPCs service-role-only SECURITY INVOKER", () => {
  requireMigration();
  requireAll(migration, [
    /alter table public\.naver_shopping_finite_window_targets enable row level security/iu,
    /alter table public\.naver_shopping_finite_window_targets force row level security/iu,
    /revoke all on table public\.naver_shopping_finite_window_targets\s+from public, anon, authenticated, service_role/iu,
    /grant select on table public\.naver_shopping_finite_window_targets\s+to service_role/iu,
  ]);
  assert.doesNotMatch(migration, /security definer/iu);
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.[^(]+\([^;]+\)\s+to\s+(?:public|anon|authenticated)/iu,
  );
  for (const name of [
    "mi_report_naver_shopping_worker_progress",
    "mi_get_naver_shopping_worker_operations",
    "mi_set_naver_shopping_worker_cadence",
    "mi_record_naver_shopping_worker_failure",
  ]) {
    const block = functionBlocks(migration, "public", name)[0];
    assert.match(block, /security invoker/iu);
    assert.match(block, /set search_path = ''/iu);
  }
});

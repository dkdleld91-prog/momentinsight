import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
const exactParentMigrationName = "20260827050000_naver_shopping_exact_parent_relation_guard.sql";
const recoveryMigrationName = "20260827194500_naver_shopping_next_data_schema_drift_recovery.sql";
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => /^\d{14}_naver_shopping_runtime_1_1_16(?:_[a-z0-9_]+)?\.sql$/u.test(name));
const migrationName = migrationNames[0] || "";
const migration = migrationName
  ? fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8")
  : "";
const recoveryMigration = fs.readFileSync(
  path.join(migrationDirectory, recoveryMigrationName),
  "utf8",
);

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

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function runtimeFixture(version) {
  const componentDigests = runtimeFiles.map((name) => crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(repositoryRoot, name)))
    .digest("hex"));
  return Object.freeze({
    version,
    componentDigests,
    fingerprint: crypto.createHash("sha256")
      .update([version, ...componentDigests].join("\n"), "utf8")
      .digest("hex"),
  });
}

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

test("binds runtime 1.1.16 to the canonical Windows byte fingerprint everywhere", () => {
  requireMigration();
  const expectedRuntime = runtimeFixture("1.1.16");
  const manifest = JSON.parse(read("tools/naver-shopping-chrome-extension/manifest.json"));
  const worker = read("scripts/naver-shopping-local-worker.mjs");
  const workerHandler = read("src/server/handlers/naver-shopping-local-worker.mjs");
  const trackerHandler = read("src/server/handlers/naver-rank-trackers.mjs");
  const candidateAudit = read("scripts/naver-shopping-candidate-performance-audit.mjs");
  const parentAudit = read("scripts/naver-shopping-parent-canary-finite-gate-audit.mjs");
  const updater = read("scripts/windows/update-naver-shopping-chrome-extension.ps1");

  assert.equal(manifest.version, expectedRuntime.version);
  assert.match(worker, /const EXPECTED_RUNTIME_VERSION = "1\.1\.16";/u);
  assert.match(workerHandler, /const EXPECTED_WORKER_RUNTIME_VERSION = "1\.1\.16";/u);
  assert.match(trackerHandler, /const SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION = "1\.1\.16";/u);
  assert.match(candidateAudit, /export const N30_TARGET_RUNTIME_VERSION = "1\.1\.16";/u);
  assert.match(candidateAudit, new RegExp(expectedRuntime.fingerprint, "u"));
  assert.match(parentAudit, /export const N30_PARENT_CANARY_RUNTIME_VERSION = "1\.1\.16";/u);
  assert.match(parentAudit, new RegExp(expectedRuntime.fingerprint, "u"));
  assert.match(
    recoveryMigration,
    new RegExp(`runtime_fingerprint\\s*=\\s*'${expectedRuntime.fingerprint}'`, "iu"),
  );
  assert.match(
    updater,
    /\$ExpectedVersion`n\$serviceWorkerHash`n\$nativeHostHash`n\$nativeHostCoreHash`n\$localWorkerHash`n\$localWorkerAuthHash`n\$localWorkerContractHash`n\$shoppingRankHandlerHash`n\$securityHash`n\$sourceStatusHash`n\$providerRuntimeHash`n\$mobileTopFallbackHash`n\$collectorProviderHash`n\$collectorContractHash/u,
  );
});

test("recovers only the exact idle schema-drift circuit and preserves last-good evidence", () => {
  const expectedRuntime = runtimeFixture("1.1.16");
  requireAll(recoveryMigration, [
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
    new RegExp(expectedRuntime.fingerprint, "u"),
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

  assert.doesNotMatch(recoveryMigration, /update public\.naver_rank_trackers/iu);
  assert.doesNotMatch(recoveryMigration, /update public\.naver_shopping_rank_lookup_jobs/iu);
  assert.doesNotMatch(recoveryMigration, /insert into public\.naver_shopping_worker_events/iu);
  assert.doesNotMatch(recoveryMigration, /create or replace function public\./iu);
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

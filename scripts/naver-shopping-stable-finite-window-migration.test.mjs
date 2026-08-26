import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => name.endsWith("_naver_shopping_stable_finite_window_v1.sql"));

assert.equal(migrationNames.length, 1, "stable finite-window migration must be unique");
const migrationName = migrationNames[0];
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
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
const runtimeFingerprint = crypto.createHash("sha256").update([
  "1.1.14",
  ...runtimeFiles.map((name) => crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(repositoryRoot, name)))
    .digest("hex")),
].join("\n"), "utf8").digest("hex");

function requireAll(source, patterns) {
  for (const pattern of patterns) assert.match(source, pattern);
}

function functionBlock(schema, name) {
  const pattern = new RegExp(
    `create or replace function ${schema.replace(".", "\\.")}\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  );
  return migration.match(pattern)?.[0] || "";
}

test("migration preserves exact-300 commit semantics and adds a separate finite terminal", () => {
  requireAll(migration, [
    /'tracker_deferred'/iu,
    /'tracker_committed'/iu,
    /'finite_window_committed'/iu,
    /event_type <> 'tracker_committed'\s+or \(collection_id is not null and checked_count is not distinct from 300\)/iu,
    /event_type <> 'finite_window_committed'[\s\S]*checked_count between 1 and 299/iu,
    /event_type <> 'finite_window_committed'[\s\S]*checked_count is not null[\s\S]*details ->> 'source' is not distinct from 'naver_shopping_results_collector'[\s\S]*details ->> 'finiteWindowProofVersion' is not distinct from 'stable-finite-window-v1'[\s\S]*details -> 'sourceExhausted' is not distinct from 'true'::jsonb[\s\S]*details -> 'marketTotal' is not distinct from pg_catalog\.to_jsonb\(checked_count\)[\s\S]*details -> 'matched' is not distinct from 'true'::jsonb[\s\S]*details ->> 'rank' is not null[\s\S]*details ->> 'relationBasis' is not distinct from 'catalog_seller_product_id'[\s\S]*details -> 'atomicSuccessEligible' is not distinct from 'false'::jsonb/iu,
    /idx_naver_shopping_scheduler_events_finite_terminal_sequence/iu,
    /idx_naver_shopping_scheduler_events_finite_collection_once/iu,
  ]);

  const atomicCommit = functionBlock("public", "mi_commit_naver_shopping_worker_result");
  assert.ok(atomicCommit);
  assert.match(atomicCommit, /p_snapshot ->> 'checked_count'\)::integer is distinct from 300/iu);
  assert.match(atomicCommit, /local_worker_commit_requires_atomic_300/iu);
  assert.doesNotMatch(atomicCommit, /stable-finite-window-v1|finite_window_committed/iu);
});

test("finite target registry is immutable to API roles and service-role read-only", () => {
  requireAll(migration, [
    /create table public\.naver_shopping_finite_window_targets/iu,
    /alter table public\.naver_shopping_finite_window_targets enable row level security/iu,
    /alter table public\.naver_shopping_finite_window_targets force row level security/iu,
    /revoke all on table public\.naver_shopping_finite_window_targets\s+from public, anon, authenticated, service_role/iu,
    /grant select on table public\.naver_shopping_finite_window_targets\s+to service_role/iu,
    /c0ccded2-9bf7-488e-af8d-00898c0a1ff8/iu,
    /13327339525/iu,
    /59776958987/iu,
    /stable-finite-window-v1/iu,
    /runtime_fingerprint text not null/iu,
    /runtime_fingerprint ~ '\^\[a-f0-9\]\{64\}\$'/iu,
  ]);
  const allowlistedFingerprint = migration.match(
    /'1\.1\.14',\s*'([^']+)',\s*true\s*\)/iu,
  )?.[1] || "";
  assert.match(
    allowlistedFingerprint,
    /^(?!0{64}$)[a-f0-9]{64}$/u,
    "replace the runtime fingerprint placeholder with the exact 1.1.14 fingerprint before release",
  );
  assert.equal(
    allowlistedFingerprint,
    runtimeFingerprint,
    "migration allowlist must match the exact Windows 1.1.14 runtime bytes",
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(?:insert|update|delete|all)[^;]*naver_shopping_finite_window_targets/iu,
  );
  assert.doesNotMatch(
    migration,
    /create policy[^;]*naver_shopping_finite_window_targets[^;]*(?:anon|authenticated)/iu,
  );
});

test("authenticated admins cannot forge finite ledger evidence with direct snapshot writes", () => {
  requireAll(migration, [
    /revoke insert, update, delete on table public\.naver_rank_snapshots\s+from public, anon, authenticated/iu,
    /drop policy if exists naver_rank_snapshots_admin_all\s+on public\.naver_rank_snapshots/iu,
    /create policy naver_rank_snapshots_service_role_write\s+on public\.naver_rank_snapshots\s+for all to service_role\s+using \(true\)\s+with check \(true\)/iu,
    /grant select on table public\.naver_rank_snapshots\s+to authenticated, service_role/iu,
    /grant insert, update, delete on table public\.naver_rank_snapshots\s+to service_role/iu,
  ]);
  assert.doesNotMatch(
    migration,
    /grant\s+(?:insert|update|delete|all)[^;]*public\.naver_rank_snapshots[^;]*to\s+(?:public|anon|authenticated)/iu,
  );
  assert.doesNotMatch(
    migration,
    /create policy naver_rank_snapshots_admin_all/iu,
  );

  const audit = functionBlock("mi_internal", "mi_audit_naver_shopping_snapshot_commit");
  assert.ok(audit);
  assert.match(audit, /security definer/iu);
});

test("dedicated finite RPC accepts only a positive exact first-party relationship", () => {
  const finiteCommit = functionBlock("public", "mi_commit_naver_shopping_finite_worker_result");
  assert.ok(finiteCommit);
  requireAll(finiteCommit, [
    /security invoker/iu,
    /-- finite exact relation gate begin/iu,
    /p_tracker_id is distinct from 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid/iu,
    /p_product_id is distinct from '13327339525'/iu,
    /checked_count not between 1 and 299/iu,
    /rank not between 1 and checked_count/iu,
    /market_total is distinct from checked_count/iu,
    /p_snapshot -> 'matched' is distinct from 'true'::jsonb/iu,
    /p_snapshot ->> 'source' is distinct from 'naver_shopping_results_collector'/iu,
    /item ->> 'finiteWindowProofVersion' is distinct from 'stable-finite-window-v1'/iu,
    /item -> 'sourceExhausted' is distinct from 'true'::jsonb/iu,
    /item -> 'atomicSuccessEligible' is distinct from 'false'::jsonb/iu,
    /item ->> 'trackingRankSource' is distinct from 'related_catalog'/iu,
    /item ->> 'relatedCatalogProductId' is distinct from target\.parent_catalog_id/iu,
    /item ->> 'relatedCatalogRelationBasis' is distinct from 'catalog_seller_product_id'/iu,
    /item ->> 'catalogId' is distinct from target\.parent_catalog_id/iu,
    /item -> 'catalogSellerProductIds'/iu,
    /seller_id = target\.seller_product_id/iu,
    /item ->> 'rankPolicy' is distinct from 'organic_only'/iu,
    /item -> 'adExcluded' is distinct from 'true'::jsonb/iu,
    /item ->> 'rankEvidence' is distinct from 'naver_shopping_organic_list'/iu,
    /item ->> 'collectionId' is distinct from p_collection_id/iu,
    /top_item -> 'isOrganic' is distinct from 'true'::jsonb/iu,
    /top_item -> 'isAd' is distinct from 'false'::jsonb/iu,
    /tracker_claim_count <> 1/iu,
    /group_claim_count <> 1/iu,
    /claim\.worker_id is distinct from 'windows-desktop-primary'/iu,
    /run_trigger <> 'rank-catch-up'/iu,
    /runs\.runtime_fingerprint = target\.runtime_fingerprint/iu,
    /current_row\.runtime_fingerprint is distinct from target\.runtime_fingerprint/iu,
    /priority not in \('new', 'resume', 'normal'\)/iu,
    /finite_window_committed/iu,
  ]);

  const idempotentRetryGate = finiteCommit.slice(
    finiteCommit.indexOf("if tracker.processing_started_at is null then"),
    finiteCommit.indexOf("if tracker.processing_started_at is distinct from p_lease_started_at"),
  );
  requireAll(idempotentRetryGate, [
    /snapshot\.checked_count between 1 and 299/iu,
    /snapshot\.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'/iu,
    /snapshot\.item -> 'sourceExhausted' = 'true'::jsonb/iu,
    /snapshot\.item -> 'finiteMarketTotal'\s*=\s*pg_catalog\.to_jsonb\(snapshot\.checked_count\)/iu,
    /snapshot\.item ->> 'trackingRankSource' = 'related_catalog'/iu,
    /snapshot\.item ->> 'catalogId' = target\.parent_catalog_id/iu,
    /snapshot\.item -> 'catalogSellerProductIds'/iu,
    /seller_id\.seller_id = target\.seller_product_id/iu,
    /seller_id\.seller_id !~ '\^\[0-9\]\{5,80\}\$'/iu,
    /snapshot\.item ->> 'rankPolicy' = 'organic_only'/iu,
    /snapshot\.item -> 'adExcluded' = 'true'::jsonb/iu,
    /snapshot\.item ->> 'rankEvidence' = 'naver_shopping_organic_list'/iu,
    /snapshot\.item ->> 'collectionId' = snapshot\.collection_id/iu,
    /snapshot\.item -> 'isOrganic' = 'true'::jsonb/iu,
    /snapshot\.item -> 'isAd' = 'false'::jsonb/iu,
    /pg_catalog\.jsonb_typeof\(snapshot\.top_items\) = 'array'/iu,
    /top_item -> 'isOrganic' is distinct from 'true'::jsonb/iu,
    /top_item -> 'isAd' is distinct from 'false'::jsonb/iu,
    /committed\.event_type = 'finite_window_committed'/iu,
    /committed\.collection_id = snapshot\.collection_id/iu,
    /committed\.occurred_at = snapshot\.checked_at/iu,
    /committed\.details ->> 'finiteWindowProofVersion'\s+is not distinct from 'stable-finite-window-v1'/iu,
    /committed\.details -> 'marketTotal'\s+is not distinct from pg_catalog\.to_jsonb\(snapshot\.total\)/iu,
    /committed\.details -> 'rank'\s+is not distinct from pg_catalog\.to_jsonb\(snapshot\.rank\)/iu,
    /representative_claim\.event_type = 'tracker_claimed'/iu,
    /representative_claim\.event_id < committed\.event_id/iu,
    /grouped\.event_type = 'group_claimed'/iu,
    /grouped\.event_id < representative_claim\.event_id/iu,
    /runs\.run_trigger = 'rank-catch-up'/iu,
    /runs\.runtime_version = target\.runtime_version/iu,
    /runs\.runtime_fingerprint = target\.runtime_fingerprint/iu,
  ]);

  const exactGate = finiteCommit.slice(
    finiteCommit.indexOf("-- finite exact relation gate begin"),
    finiteCommit.indexOf("-- finite exact relation gate end"),
  );
  assert.ok(exactGate.length > 0);
  assert.doesNotMatch(exactGate, /thumbnail|image|similarity|product_title|title/iu);
  assert.doesNotMatch(finiteCommit, /update public\.naver_shopping_worker_coordination/iu);
  assert.doesNotMatch(finiteCommit, /success_streak\s*=|stability_started_at\s*=|last_success_at\s*=/iu);
});

test("cycle evidence keeps finite terminals separate from atomic commits", () => {
  requireAll(migration, [
    /drop index if exists public\.idx_naver_shopping_scheduler_events_terminal_sequence/iu,
    /event_type in \('tracker_committed', 'finite_window_committed', 'job_failed'\)/iu,
  ]);

  const cycleAudit = functionBlock("mi_internal", "mi_audit_naver_shopping_cycle_transition");
  assert.ok(cycleAudit);
  requireAll(cycleAudit, [
    /v_finite_window_committed integer := 0/iu,
    /count\(distinct event\.tracker_id\) filter \(\s*where event\.event_type = 'finite_window_committed'\s*\)::integer/iu,
    /into v_claimed, v_scheduled, v_repair, v_committed,\s*v_finite_window_committed, v_failed/iu,
    /'committedTrackers', v_committed/iu,
    /'finiteWindowCommittedTrackers', v_finite_window_committed/iu,
  ]);
  assert.doesNotMatch(cycleAudit, /'committedTrackers'\s*,\s*v_committed\s*\+/iu);
});

test("exact finite canary failures quarantine locally without erasing cadence proof", () => {
  const failure = functionBlock("public", "mi_record_naver_shopping_worker_failure");
  assert.ok(failure);
  requireAll(failure, [
    /security invoker/iu,
    /provider_partial_window:\(\[1-9\]\|\[1-9\]\[0-9\]\|\[12\]\[0-9\]\{2\}\)_300/iu,
    /provider_stable_finite_window_unproven/iu,
    /local_worker_finite_match_invalid/iu,
    /p_tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid/iu,
    /select exists \([\s\S]*tracker\.id = p_tracker_id[\s\S]*tracker\.status = 'active'[\s\S]*tracker\.product_id = target\.seller_product_id[\s\S]*target\.normalized_keyword[\s\S]*into finite_tracker_exact/iu,
    /when finite_canary_failure\s+and finite_target_available\s+and finite_tracker_exact\s+and current_row\.runtime_version = target\.runtime_version\s+and current_row\.runtime_fingerprint = target\.runtime_fingerprint\s+then v_now \+ interval '30 minutes'/iu,
    /finite_canary_failure\s+and finite_target_available\s+and finite_tracker_exact[\s\S]*current_row\.runtime_version = target\.runtime_version/iu,
    /current_row\.runtime_fingerprint = target\.runtime_fingerprint/iu,
    /current_row\.current_stage = 'collecting'[\s\S]*provider_stable_finite_window_unproven/iu,
    /current_row\.current_stage = 'submitting'[\s\S]*local_worker_finite_match_invalid/iu,
    /current_row\.current_stage = 'failed'[\s\S]*current_row\.last_failure_code = normalized_error/iu,
    /failed_event\.event_type = 'job_failed'/iu,
    /failed_event\.error_code = normalized_error/iu,
    /representative_claim\.tracker_id = p_tracker_id/iu,
    /grouped\.event_id < representative_claim\.event_id/iu,
    /runs\.runtime_version = target\.runtime_version/iu,
    /runs\.runtime_fingerprint = target\.runtime_fingerprint/iu,
    /from public\.naver_shopping_scheduler_events as finite_failed_count[\s\S]*finite_failed_count\.event_type = 'job_failed'[\s\S]*finite_failed_count\.claim_id = representative_claim\.claim_id[\s\S]*\) = 1/iu,
    /when cadence_proof_preserved then current_row\.stability_started_at/iu,
    /when cadence_proof_preserved then current_row\.success_streak/iu,
    /'cadenceProofPreserved', cadence_proof_preserved/iu,
  ]);
  const quarantineUpdate = failure.slice(
    failure.indexOf("update public.naver_rank_trackers"),
    failure.indexOf("get diagnostics tracker_updated_count"),
  );
  assert.ok(quarantineUpdate.length > 0);
  assert.doesNotMatch(quarantineUpdate, /provider_stable_finite_window_unproven/iu);
  assert.doesNotMatch(quarantineUpdate, /local_worker_finite_match_invalid/iu);
  assert.doesNotMatch(failure, /update public\.naver_shopping_worker_runs/iu);
  assert.doesNotMatch(migration, /create or replace function public\.mi_record_naver_shopping_worker_success/iu);
});

test("runtime 1.1.14 progress and cadence gates use the exact allowlisted identity", () => {
  requireAll(migration, [
    /or current_row\.circuit_state is distinct from 'closed'/iu,
    /or current_row\.circuit_reason is not null/iu,
    /or current_row\.cooldown_until is not null/iu,
    /update public\.naver_shopping_worker_coordination\s+set cadence_mode = 'baseline',\s*cadence_minutes = 10,\s*stability_started_at = null,\s*success_streak = 0/iu,
    /drop function if exists public\.mi_report_naver_shopping_worker_progress\(\s*text, uuid, uuid, text, integer, text, uuid, text, text\s*\)/iu,
  ]);

  const progress = functionBlock("public", "mi_report_naver_shopping_worker_progress");
  assert.ok(progress);
  requireAll(progress, [
    /security invoker/iu,
    /target\.runtime_version is distinct from '1\.1\.14'/iu,
    /pg_catalog\.btrim\(coalesce\(p_runtime_version, ''\)\)\s+is distinct from target\.runtime_version/iu,
    /pg_catalog\.lower\(pg_catalog\.btrim\(coalesce\(p_runtime_fingerprint, ''\)\)\)\s+is distinct from target\.runtime_fingerprint/iu,
    /when runtime_version is distinct from target\.runtime_version[\s\S]*then 'baseline'/iu,
    /when runtime_version is distinct from target\.runtime_version[\s\S]*then null/iu,
    /runtime_version = target\.runtime_version/iu,
    /runtime_fingerprint = target\.runtime_fingerprint/iu,
    /recorded_run\.runtime_version = target\.runtime_version/iu,
    /recorded_run\.runtime_fingerprint = target\.runtime_fingerprint/iu,
  ]);

  const operations = functionBlock("public", "mi_get_naver_shopping_worker_operations");
  assert.ok(operations);
  requireAll(operations, [
    /processing_count = 0/iu,
    /current_row\.lease_worker_id is null/iu,
    /current_row\.run_id is null/iu,
    /current_row\.probe_tracker_id is null/iu,
    /current_row\.runtime_version = target\.runtime_version/iu,
    /current_row\.runtime_fingerprint = target\.runtime_fingerprint/iu,
    /'candidate_eligible'/iu,
  ]);

  const cadence = functionBlock("public", "mi_set_naver_shopping_worker_cadence");
  assert.ok(cadence);
  requireAll(cadence, [
    /for update;\s*v_now := clock_timestamp\(\)/iu,
    /processing_count = 0/iu,
    /current_row\.lease_worker_id is null/iu,
    /current_row\.run_id is null/iu,
    /current_row\.probe_tracker_id is null/iu,
    /current_row\.runtime_version = target\.runtime_version/iu,
    /current_row\.runtime_fingerprint = target\.runtime_fingerprint/iu,
    /set cadence_mode = 'candidate', cadence_minutes = 6/iu,
  ]);
});

test("finite ledger trigger is mutually exclusive with atomic tracker_committed", () => {
  const audit = functionBlock("mi_internal", "mi_audit_naver_shopping_snapshot_commit");
  assert.ok(audit);
  requireAll(audit, [
    /'tracker_committed'[\s\S]*snapshot\.checked_count = 300/iu,
    /'finite_window_committed'[\s\S]*snapshot\.checked_count between 1 and 299/iu,
    /snapshot\.matched = true/iu,
    /snapshot\.total = snapshot\.checked_count/iu,
    /snapshot\.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'/iu,
    /snapshot\.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'/iu,
    /snapshot\.item ->> 'relatedCatalogProductId' = target\.parent_catalog_id/iu,
    /snapshot\.item -> 'sourceExhausted' = 'true'::jsonb/iu,
    /snapshot\.item -> 'atomicSuccessEligible' = 'false'::jsonb/iu,
    /runs\.runtime_version = target\.runtime_version/iu,
    /runs\.runtime_fingerprint = target\.runtime_fingerprint/iu,
    /control\.runtime_fingerprint = runs\.runtime_fingerprint/iu,
  ]);
  assert.equal((audit.match(/'tracker_committed'/giu) || []).length, 1);
  assert.equal((audit.match(/'finite_window_committed'/giu) || []).length, 1);
});

test("RPC and internal audit functions remain non-public", () => {
  requireAll(migration, [
    /revoke all on function public\.mi_commit_naver_shopping_worker_result\([^)]+\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_commit_naver_shopping_worker_result\([^)]+\)\s+to service_role/iu,
    /revoke all on function public\.mi_commit_naver_shopping_finite_worker_result\([^)]+\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_commit_naver_shopping_finite_worker_result\([^)]+\)\s+to service_role/iu,
    /revoke all on function public\.mi_record_naver_shopping_worker_failure\([^)]+\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_record_naver_shopping_worker_failure\([^)]+\)\s+to service_role/iu,
    /revoke all on function public\.mi_report_naver_shopping_worker_progress\([^)]+\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_report_naver_shopping_worker_progress\([^)]+\)\s+to service_role/iu,
    /revoke all on function public\.mi_get_naver_shopping_worker_operations\(\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_get_naver_shopping_worker_operations\(\)\s+to service_role/iu,
    /revoke all on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s+from public, anon, authenticated, service_role/iu,
    /grant execute on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s+to service_role/iu,
    /revoke all on function mi_internal\.mi_audit_naver_shopping_snapshot_commit\(\)\s+from public, anon, authenticated, service_role/iu,
  ]);
  assert.doesNotMatch(migration, /grant execute on function mi_internal\.mi_audit/iu);
  assert.doesNotMatch(migration, /create or replace function public\.mi_record_naver_shopping_worker_success/iu);
});

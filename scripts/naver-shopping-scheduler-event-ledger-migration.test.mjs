import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => name.endsWith("_naver_shopping_scheduler_event_ledger.sql"));

assert.equal(migrationNames.length, 1, "scheduler event ledger migration must be unique");
const migrationName = migrationNames[0];
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const shadow = fs.readFileSync(path.join(
  repositoryRoot,
  "scripts",
  "naver-shopping-scheduler-event-ledger-shadow.sql",
), "utf8");

function requireAll(source, patterns) {
  for (const pattern of patterns) assert.match(source, pattern);
}

function eventInsertColumnLists(source) {
  return Array.from(source.matchAll(
    /insert into public\.naver_shopping_scheduler_events\s*\(([^)]*)\)/giu,
  )).map((match) => match[1]);
}

test("ledger migration is ordered after the current runtime migration", () => {
  assert.ok(
    migrationName > "20260814110000_naver_shopping_runtime_1_1_5.sql",
    `${migrationName} must sort after runtime 1.1.5`,
  );
});

test("ledger is read-only to service role and trigger writes are isolated under forced RLS", () => {
  requireAll(migration, [
    /create table if not exists public\.naver_shopping_scheduler_events/iu,
    /alter table public\.naver_shopping_scheduler_events enable row level security;/iu,
    /alter table public\.naver_shopping_scheduler_events force row level security;/iu,
    /revoke all on table public\.naver_shopping_scheduler_events\s+from public, anon, authenticated, service_role;/iu,
    /grant select on table public\.naver_shopping_scheduler_events\s+to service_role;/iu,
    /revoke all on sequence public\.naver_shopping_scheduler_events_event_id_seq\s+from public, anon, authenticated, service_role;/iu,
  ]);
  assert.doesNotMatch(migration, /grant\s+[^;]*\binsert\b[^;]*naver_shopping_scheduler_events/iu);
  assert.doesNotMatch(migration, /grant\s+(?:[^;]*\bupdate\b|[^;]*\bdelete\b)[^;]*naver_shopping_scheduler_events/iu);
  requireAll(migration, [
    /create schema if not exists mi_internal authorization postgres/iu,
    /revoke all on schema mi_internal from public, anon, authenticated, service_role/iu,
  ]);
  assert.equal((migration.match(/security definer/giu) || []).length, 3);
  assert.ok((migration.match(/revoke all on function mi_internal\.mi_audit_/giu) || []).length >= 3);
  assert.doesNotMatch(migration, /grant execute on function (?:public|mi_internal)\.mi_audit_/iu);
  assert.doesNotMatch(migration, /create or replace function public\.mi_audit_/iu);
  assert.ok((migration.match(/set search_path = ''/giu) || []).length >= 4);
});

test("ledger stores only a SHA-256 group fingerprint and never a raw keyword", () => {
  const tableBlock = migration.match(
    /create table if not exists public\.naver_shopping_scheduler_events[\s\S]*?\n\);/iu,
  )?.[0] || "";
  assert.ok(tableBlock);
  assert.doesNotMatch(tableBlock, /\bkeyword\b/iu);
  assert.ok(eventInsertColumnLists(migration).length >= 8);
  eventInsertColumnLists(migration).forEach((columns) => {
    assert.doesNotMatch(columns, /\bkeyword\b/iu);
  });
  assert.doesNotMatch(migration, /['"]keyword['"]\s*,/iu);
  requireAll(migration, [
    /mi_internal\.mi_naver_shopping_scheduler_group_fingerprint/iu,
    /\.digest\([\s\S]*?'sha256'/iu,
    /regexp_replace\([\s\S]*?lower\([\s\S]*?btrim\(p_keyword\)[\s\S]*?'\\s\+'/iu,
    /group_fingerprint is null or group_fingerprint ~ '\^\[a-f0-9\]\{64\}\$'/iu,
  ]);
});

test("cycle start atomically records a full eligible and quarantined roster", () => {
  requireAll(migration, [
    /create or replace function mi_internal\.mi_audit_naver_shopping_cycle_transition\(\)/iu,
    /old\.scheduler_cycle_id is distinct from new\.scheduler_cycle_id/iu,
    /'cycle_started'/iu,
    /'activeCount', v_active/iu,
    /'eligibleCount', v_eligible/iu,
    /'quarantinedCount', v_quarantined/iu,
    /'cycle_rostered'/iu,
    /when tracker\.worker_quarantined_until > v_now then 'quarantined'/iu,
    /idx_naver_shopping_scheduler_events_cycle_roster_once/iu,
    /after update on public\.naver_shopping_worker_coordination\s+for each row execute function mi_internal\.mi_audit_naver_shopping_cycle_transition\(\)/iu,
  ]);
});

test("claim events preserve new-resume order without changing scheduler behavior", () => {
  requireAll(migration, [
    /create or replace function mi_internal\.mi_audit_naver_shopping_tracker_transition\(\)/iu,
    /referencing old table as old_rows new table as new_rows/iu,
    /new_row\.processing_started_at is distinct from old_row\.processing_started_at/iu,
    /current_row\.circuit_state = 'half_open'\s+and current_row\.probe_tracker_id = new_row\.id/iu,
    /elsif current_row\.scheduler_cycle_resume_cursor then\s+v_priority := 'resume'/iu,
    /elsif claimed_group\.contains_new then\s+v_priority := 'new'/iu,
    /'group_claimed'/iu,
    /'tracker_claimed'/iu,
    /'resumeCursorBefore', current_row\.scheduler_cycle_resume_cursor/iu,
    /idx_naver_shopping_scheduler_events_scheduled_group_sequence/iu,
    /idx_naver_shopping_scheduler_events_scheduled_tracker_sequence/iu,
    /idx_naver_shopping_scheduler_events_claim_group_once/iu,
    /idx_naver_shopping_scheduler_events_claim_tracker_once/iu,
    /then 'new_after_start'/iu,
    /else 'late_observed'/iu,
    /on conflict do nothing/iu,
  ]);
  assert.doesNotMatch(migration, /create unique index[^;]*scheduled_(?:group|tracker)/iu);
});

test("terminal evidence is atomic with snapshot commit or lease failure", () => {
  requireAll(migration, [
    /'job_failed'/iu,
    /old_row\.processing_started_at is not null\s+and new_row\.processing_started_at is null/iu,
    /event\.lease_started_at = old_row\.processing_started_at/iu,
    /create or replace function mi_internal\.mi_audit_naver_shopping_snapshot_commit\(\)/iu,
    /'tracker_committed'/iu,
    /snapshot\.source = 'naver_shopping_results_collector'/iu,
    /snapshot\.checked_count = 300/iu,
    /snapshot\.collection_id ~ '\^pw-chrome-'/iu,
    /event\.lease_started_at = tracker\.processing_started_at/iu,
    /after insert on public\.naver_rank_snapshots\s+referencing new table as new_snapshots\s+for each statement/iu,
    /idx_naver_shopping_scheduler_events_terminal_sequence/iu,
    /idx_naver_shopping_scheduler_events_collection_once/iu,
  ]);
  assert.doesNotMatch(migration, /create unique index[^;]*terminal_sequence/iu);
});

test("quarantine set, clear and repair override are durable typed events", () => {
  requireAll(migration, [
    /'quarantine_set'/iu,
    /'quarantine_cleared'/iu,
    /'quarantine_repair_override'/iu,
    /new_row\.worker_quarantined_until\s+is distinct from old_row\.worker_quarantined_until/iu,
    /'previousUntil', old_row\.worker_quarantined_until/iu,
    /event_type <> 'quarantine_set'[\s\S]*?quarantine_until is not null[\s\S]*?error_code is not null/iu,
  ]);
});

test("cycle completion and retention boundaries remain queryable", () => {
  requireAll(migration, [
    /'cycle_completed'/iu,
    /'distinctClaimedTrackers', v_claimed/iu,
    /'scheduledClaimedTrackers', v_scheduled/iu,
    /'repairClaimedTrackers', v_repair/iu,
    /'committedTrackers', v_committed/iu,
    /'failedTrackers', v_failed/iu,
    /retention_until timestamptz not null default \(clock_timestamp\(\) \+ interval '90 days'\)/iu,
    /idx_naver_shopping_scheduler_events_retention/iu,
    /delete from public\.naver_shopping_scheduler_events\s+where retention_until <= v_now;/iu,
    /'fullCycleEvidenceStartsWithNextCycle', true/iu,
  ]);
});

test("engine shadow harness is isolated, role-aware and always rolled back", () => {
  requireAll(shadow, [
    /^begin;/imu,
    /-- @ledger-migration/iu,
    /create schema ledger_test authorization postgres/iu,
    /set local role authenticated/iu,
    /set local role service_role/iu,
    /set local role anon/iu,
    /shadow_service_role_insert_allowed/iu,
    /shadow_anon_select_allowed/iu,
    /roster_state = 'new_after_start'/iu,
    /shadow_repeat_group_/iu,
    /rollback;\s*$/iu,
  ]);
  assert.doesNotMatch(shadow, /(?:update|delete|insert into)\s+public\./iu);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { calculateN30RuntimeFingerprint } from "./naver-shopping-runtime-fingerprint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260903090000_naver_shopping_runtime_1_1_21_finite_general_and_seam_tolerance.sql";
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const priorMigrationName = "20260831052231_naver_shopping_runtime_1_1_20_rendered_boundary_consensus.sql";
const priorMigration = fs.readFileSync(path.join(migrationDirectory, priorMigrationName), "utf8");
const catchUpGateMigrationName = "20260831100525_naver_shopping_account_priority_rank_catch_up_gate.sql";
const deployedFiniteMigration = fs.readFileSync(
  path.join(migrationDirectory, "20260826035440_naver_shopping_stable_finite_window_v1.sql"),
  "utf8",
);
const deployedFiniteCommitMigration = fs.readFileSync(
  path.join(migrationDirectory, "20260828082130_naver_shopping_finite_commit_checked_count_ambiguity.sql"),
  "utf8",
);
const exactParentGuardMigration = fs.readFileSync(
  path.join(migrationDirectory, "20260827050000_naver_shopping_exact_parent_relation_guard.sql"),
  "utf8",
);

const OLD_RUNTIME = Object.freeze({
  version: "1.1.20",
  fingerprint: "4e0f5fbde16a892e44986b2325865f33d61bdf7a5a13d3d7adcd501608aa8e5b",
});
const NEW_RUNTIME = Object.freeze({
  version: "1.1.21",
  fingerprint: "84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0",
});
const ids = Object.freeze({
  tracker: "50000000-0000-4000-8000-000000000001",
  requestOld: "10000000-0000-4000-8000-000000000001",
  requestNew: "10000000-0000-4000-8000-000000000002",
  requestThird: "10000000-0000-4000-8000-000000000003",
  cycle: "20000000-0000-4000-8000-000000000001",
  lane: "30000000-0000-4000-8000-000000000001",
  run: "40000000-0000-4000-8000-000000000001",
  claim: "60000000-0000-4000-8000-000000000001",
});
const LEASE_STARTED_AT = "2026-09-03T09:00:00.000Z";
const CHECKED_AT = "2026-09-03T09:05:00.000Z";
const TRACKER_PRODUCT_ID = "12149720593";

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function functionBlocks(source) {
  return [...source.matchAll(
    /create or replace function (?:public|mi_internal)\.([a-z0-9_]+)\([\s\S]*?\n\$\$;/giu,
  )].map((match) => ({ name: match[1], source: match[0] }));
}

function functionBlock(source, name) {
  return functionBlocks(source).find((block) => block.name === name)?.source || "";
}

async function createDatabase() {
  const database = new PGlite();
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema mi_internal;

    create table public.naver_shopping_worker_coordination (
      lane_key text primary key,
      circuit_state text,
      circuit_reason text,
      circuit_opened_at timestamptz,
      failure_signature text,
      failure_streak integer default 0,
      transient_system_probe_attempts integer default 0,
      probe_tracker_id uuid,
      probe_started_at timestamptz,
      primary_worker_id text,
      primary_seen_at timestamptz,
      lease_worker_id text,
      lease_token uuid,
      lease_until timestamptz,
      cooldown_until timestamptz,
      last_block_code text,
      run_id uuid,
      runtime_version text,
      runtime_fingerprint text,
      current_stage text,
      current_page integer default 0,
      current_job_kind text,
      current_tracker_id uuid,
      current_job_started_at timestamptz,
      last_success_at timestamptz,
      last_failure_at timestamptz,
      last_failure_code text,
      last_collection_id text,
      last_checked_count integer,
      last_excluded_ad_count integer,
      last_duration_ms integer,
      last_source text,
      scheduler_urgent_streak integer default 0,
      scheduler_last_agency_code text,
      scheduler_cycle_id uuid,
      scheduler_cycle_number bigint,
      scheduler_cycle_status text,
      scheduler_cycle_started_at timestamptz,
      scheduler_cycle_completed_at timestamptz,
      scheduler_cycle_cursor_sort_order integer,
      scheduler_cycle_cursor_created_at timestamptz,
      scheduler_cycle_cursor_tracker_id uuid,
      scheduler_cycle_resume_cursor boolean not null default false,
      cadence_mode text,
      cadence_minutes integer,
      stability_started_at timestamptz,
      success_streak integer default 0,
      updated_at timestamptz
    );

    create table public.naver_shopping_finite_window_targets (
      tracker_id uuid primary key,
      seller_product_id text not null,
      parent_catalog_id text not null,
      normalized_keyword text not null,
      proof_version text not null,
      runtime_version text not null,
      runtime_fingerprint text not null,
      enabled boolean not null default true,
      constraint naver_shopping_finite_window_targets_runtime_version_check
        check (runtime_version = '1.1.20')
    );

    create table public.naver_shopping_rank_lookup_jobs (
      id uuid primary key default gen_random_uuid(),
      status text,
      processing_until timestamptz,
      available_at timestamptz,
      expires_at timestamptz,
      attempts integer default 0
    );

    create table public.naver_rank_trackers (
      id uuid primary key,
      agency_code text not null,
      status text not null default 'active',
      product_id text,
      keyword text not null,
      sort_order integer not null,
      created_at timestamptz not null,
      processing_started_at timestamptz,
      processing_until timestamptz,
      next_check_at timestamptz,
      worker_quarantined_until timestamptz,
      retry_count integer default 0,
      current_rank integer,
      best_rank integer,
      worst_rank integer,
      check_count integer default 0,
      found_count integer default 0,
      last_checked_at timestamptz,
      last_message text,
      last_error text,
      worker_last_cycle_id uuid,
      worker_last_cycle_claimed_at timestamptz,
      worker_last_cycle_deferred_at timestamptz
    );

    create table public.naver_rank_snapshots (
      id uuid primary key default gen_random_uuid(),
      tracker_id uuid not null references public.naver_rank_trackers(id) on delete cascade,
      checked_at timestamptz not null default now(),
      rank integer,
      page integer,
      position integer,
      matched boolean not null default false,
      checked_count integer,
      total integer,
      item jsonb not null default '{}'::jsonb,
      top_items jsonb not null default '[]'::jsonb,
      message text,
      source text not null default 'naver_shopping_search_api',
      created_at timestamptz not null default now(),
      collection_id text
    );
    create unique index idx_naver_rank_snapshots_tracker_collection
    on public.naver_rank_snapshots(tracker_id, collection_id)
    where collection_id is not null;

    create table public.naver_shopping_worker_runs (
      run_id uuid primary key,
      worker_id text,
      run_trigger text,
      runtime_version text,
      runtime_fingerprint text,
      started_at timestamptz
    );

    create table public.naver_shopping_scheduler_events (
      event_id bigint generated always as identity primary key,
      event_type text,
      cycle_id uuid,
      cycle_number bigint,
      claim_id uuid,
      run_id uuid,
      worker_id text,
      tracker_id uuid,
      agency_code text,
      roster_state text,
      group_fingerprint text,
      lease_started_at timestamptz,
      lease_until timestamptz,
      priority text,
      details jsonb default '{}'::jsonb,
      collection_id text,
      checked_count integer,
      excluded_ad_count integer,
      duration_ms integer,
      occurred_at timestamptz,
      error_code text,
      quarantine_until timestamptz
    );

    create table public.naver_shopping_repair_priority_items (
      request_id uuid not null,
      position integer not null,
      tracker_id uuid not null,
      state text not null,
      claimed_lease_started_at timestamptz,
      primary key (request_id, position)
    );

    create table public.naver_shopping_account_priority_requests (
      request_id uuid primary key,
      agency_code text not null,
      cohort_count integer not null,
      cohort_hash text not null,
      required_runtime_version text not null,
      required_runtime_fingerprint text not null,
      requested_at timestamptz not null,
      expires_at timestamptz not null,
      requested_cycle_id uuid,
      requested_cycle_number bigint,
      state text not null default 'active',
      completed_at timestamptz,
      expired_at timestamptz,
      succeeded boolean,
      constraint naver_shopping_account_priority_requests_runtime_cohort_key
        unique (agency_code, cohort_hash, required_runtime_version, required_runtime_fingerprint)
    );

    create table public.naver_shopping_account_priority_members (
      request_id uuid not null
        references public.naver_shopping_account_priority_requests(request_id),
      position integer not null,
      tracker_id uuid not null,
      state text not null default 'pending',
      claimed_at timestamptz,
      terminal_at timestamptz,
      terminal_code text,
      primary key (request_id, tracker_id),
      unique (request_id, position)
    );

    create function mi_internal.mi_reconcile_naver_shopping_account_priority(
      p_now timestamptz
    ) returns integer language sql security invoker set search_path = '' as \$\$
      select 0
    \$\$;

    -- The deployed statement trigger exists before the migration replaces its
    -- function body.
    create function mi_internal.mi_audit_naver_shopping_snapshot_commit()
    returns trigger language plpgsql security definer set search_path = '' as \$\$
    begin
      return null;
    end;
    \$\$;
    create trigger trg_mi_audit_naver_shopping_snapshot_commit
    after insert on public.naver_rank_snapshots
    referencing new table as new_snapshots
    for each statement execute function mi_internal.mi_audit_naver_shopping_snapshot_commit();

    insert into public.naver_shopping_worker_coordination (
      lane_key, circuit_state, circuit_reason, failure_signature, failure_streak,
      primary_worker_id, primary_seen_at, runtime_version, runtime_fingerprint,
      current_stage, current_page, cadence_mode, cadence_minutes,
      stability_started_at, success_streak, last_success_at, last_collection_id,
      last_checked_count, last_excluded_ad_count, last_duration_ms, last_source,
      scheduler_cycle_id, scheduler_cycle_number, scheduler_cycle_status,
      scheduler_cycle_started_at, scheduler_cycle_cursor_sort_order,
      scheduler_cycle_cursor_created_at, scheduler_cycle_cursor_tracker_id,
      scheduler_cycle_resume_cursor, updated_at
    ) values (
      'global', 'closed', null, null, 0,
      'windows-desktop-primary', clock_timestamp(),
      '${OLD_RUNTIME.version}', '${OLD_RUNTIME.fingerprint}',
      null, 0, 'baseline', 10, clock_timestamp() - interval '25 hours', 9,
      clock_timestamp() - interval '1 minute', 'pw-chrome-last-good', 300, 45,
      900, 'naver_shopping_results_collector', '${ids.cycle}', 52, 'active',
      clock_timestamp() - interval '1 hour', 9100, '2026-08-01T00:00:00Z',
      '${ids.tracker}', true, clock_timestamp()
    );

    insert into public.naver_shopping_finite_window_targets (
      tracker_id, seller_product_id, parent_catalog_id, normalized_keyword,
      proof_version, runtime_version, runtime_fingerprint, enabled
    ) values (
      'c0ccded2-9bf7-488e-af8d-00898c0a1ff8',
      '13327339525', '59776958987', '아이쉘차량용거치대',
      'stable-finite-window-v1', '${OLD_RUNTIME.version}',
      '${OLD_RUNTIME.fingerprint}', true
    );

    insert into public.naver_rank_trackers (
      id, agency_code, status, product_id, keyword, sort_order, created_at,
      next_check_at
    ) values (
      '${ids.tracker}', 'mml93-a01', 'active', '${TRACKER_PRODUCT_ID}',
      '허리찜질기', 1100, '2026-08-01T00:00:00Z', clock_timestamp()
    );
  `);
  // The deployed exact-parent snapshot guard stays in force for every commit.
  await database.exec(exactParentGuardMigration);
  return database;
}

async function cohort(database) {
  return (await database.query(`
    select count(*)::integer as count,
           md5(
             'mml93-a01:' || string_agg(
               format('%s|%s|%s', sort_order, extract(epoch from created_at), id),
               ',' order by sort_order, created_at, id
             )
           ) as hash
    from public.naver_rank_trackers
    where status = 'active' and lower(btrim(agency_code)) = 'mml93-a01'
  `)).rows[0];
}

async function insertCompletedOldRequest(database, requestId = ids.requestOld) {
  const frozen = await cohort(database);
  await database.query(`
    insert into public.naver_shopping_account_priority_requests (
      request_id, agency_code, cohort_count, cohort_hash,
      required_runtime_version, required_runtime_fingerprint,
      requested_at, expires_at, requested_cycle_id, requested_cycle_number,
      state, completed_at, succeeded
    ) values (
      $1::uuid, 'mml93-a01', $2, $3, $4, $5,
      '2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z',
      $6::uuid, 51, 'completed', '2026-09-02T01:00:00Z', false
    )
  `, [
    requestId,
    frozen.count,
    frozen.hash,
    OLD_RUNTIME.version,
    OLD_RUNTIME.fingerprint,
    ids.cycle,
  ]);
  await database.query(`
    insert into public.naver_shopping_account_priority_members (
      request_id, position, tracker_id, state, claimed_at, terminal_at,
      terminal_code
    ) values (
      $1::uuid, 1, $2::uuid, 'terminal_failure',
      '2026-09-02T00:10:00Z', '2026-09-02T00:20:00Z',
      'provider_stable_rendered_order_unproven'
    )
  `, [requestId, ids.tracker]);
  return frozen;
}

// One migrated lane holding a claimed tracker on the Mac standby worker. The
// keyword group has three members so the finite commit must not depend on a
// single-member group or on the lane's current tracker.
async function prepareFiniteLane(database, { workerId = "macbook-standby", priority = "normal" } = {}) {
  await database.exec(migration);
  await database.query(`
    update public.naver_shopping_worker_coordination
    set runtime_version = $1,
        runtime_fingerprint = $2,
        lease_worker_id = $3,
        lease_token = $4::uuid,
        lease_until = clock_timestamp() + interval '5 minutes',
        run_id = $5::uuid,
        current_stage = 'submitting',
        current_page = 8,
        current_job_kind = 'tracker',
        current_tracker_id = '70000000-0000-4000-8000-000000000009'::uuid,
        current_job_started_at = clock_timestamp()
    where lane_key = 'global'
  `, [NEW_RUNTIME.version, NEW_RUNTIME.fingerprint, workerId, ids.lane, ids.run]);
  await database.query(`
    insert into public.naver_shopping_worker_runs(
      run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint, started_at
    ) values ($1::uuid, $2, 'mac-standby', $3, $4, clock_timestamp())
  `, [ids.run, workerId, NEW_RUNTIME.version, NEW_RUNTIME.fingerprint]);
  await database.query(`
    update public.naver_rank_trackers
    set processing_started_at = $1::timestamptz,
        processing_until = clock_timestamp() + interval '30 minutes'
    where id = $2::uuid
  `, [LEASE_STARTED_AT, ids.tracker]);
  await database.query(`
    insert into public.naver_shopping_scheduler_events(
      occurred_at, event_type, cycle_id, cycle_number, claim_id, run_id,
      worker_id, group_fingerprint, priority, details
    ) values (
      clock_timestamp(), 'group_claimed', $1::uuid, 52, $2::uuid, $3::uuid,
      $4, 'group-fingerprint-1', $5, '{"memberCount": 3}'::jsonb
    )
  `, [ids.cycle, ids.claim, ids.run, workerId, priority]);
  await database.query(`
    insert into public.naver_shopping_scheduler_events(
      occurred_at, event_type, cycle_id, cycle_number, claim_id, run_id,
      worker_id, tracker_id, agency_code, group_fingerprint, priority,
      lease_started_at, lease_until
    ) values (
      clock_timestamp(), 'tracker_claimed', $1::uuid, 52, $2::uuid, $3::uuid,
      $4, $5::uuid, 'mml93-a01', 'group-fingerprint-1', $6,
      $7::timestamptz, clock_timestamp() + interval '30 minutes'
    )
  `, [ids.cycle, ids.claim, ids.run, workerId, ids.tracker, priority, LEASE_STARTED_AT]);
}

function finiteSnapshot(overrides = {}, itemOverrides = {}) {
  const collectionId = overrides.collectionId || "pw-chrome-1757000000000-finitegeneral0001";
  const base = {
    checked_count: 27,
    rank: 5,
    page: 1,
    position: 5,
    matched: true,
    total: 27,
    source: "naver_shopping_results_collector",
    message: "입력 상품의 오가닉 5위를 30일 대표 순위로 기록했습니다.",
    item: {
      productId: TRACKER_PRODUCT_ID,
      sellerProductId: TRACKER_PRODUCT_ID,
      title: "허리찜질기 5",
      isOrganic: true,
      isAd: false,
      rankPolicy: "organic_only",
      adExcluded: true,
      rankEvidence: "naver_shopping_organic_list",
      collectionId,
      finiteWindowProofVersion: "stable-finite-window-v1",
      sourceExhausted: true,
      finiteMarketTotal: 27,
      atomicSuccessEligible: false,
      trackingRankSource: "exact_product",
      ...itemOverrides,
    },
    top_items: [
      { organicRank: 1, isOrganic: true, isAd: false },
      { organicRank: 2, isOrganic: true, isAd: false },
    ],
  };
  const { collectionId: _ignored, ...snapshotOverrides } = overrides;
  return { snapshot: { ...base, ...snapshotOverrides }, collectionId };
}

function notFoundSnapshot(overrides = {}) {
  return finiteSnapshot({
    rank: null,
    page: null,
    position: null,
    matched: false,
    message: "네이버쇼핑 상품 미발견",
    item: {
      title: "허리찜질기",
      rankPolicy: "organic_only",
      adExcluded: true,
      rankEvidence: "naver_shopping_organic_list",
      collectionId: overrides.collectionId || "pw-chrome-1757000000000-finitegeneral0001",
      finiteWindowProofVersion: "stable-finite-window-v1",
      sourceExhausted: true,
      finiteMarketTotal: 27,
      atomicSuccessEligible: false,
      trackingRankSource: "not_found",
    },
    ...overrides,
  });
}

async function commitFinite(database, snapshot, collectionId) {
  return (await database.query(`
    select public.mi_commit_naver_shopping_finite_worker_result(
      $1::uuid, $2::timestamptz, $3, $4::timestamptz,
      $4::timestamptz + interval '6 hours', $5::jsonb, $6, null, null
    ) as result
  `, [ids.tracker, LEASE_STARTED_AT, collectionId, CHECKED_AT, JSON.stringify(snapshot), TRACKER_PRODUCT_ID]))
    .rows[0].result;
}

test("migration is additive, fail-closed, and does not rewrite account evidence", () => {
  assert.ok(migrationName > priorMigrationName);
  assert.ok(migrationName > catchUpGateMigrationName);
  assert.match(migration, /^begin;/mu);
  assert.match(migration, /commit;\s*$/u);
  assert.match(
    migration,
    /lock table public\.naver_shopping_account_priority_requests in share row exclusive mode/iu,
  );
  assert.match(
    migration,
    /lock table public\.naver_shopping_account_priority_members in share row exclusive mode/iu,
  );
  assert.match(migration, /request\.state = 'active'/u);
  assert.match(migration, /member\.state in \('pending', 'claimed'\)/u);
  assert.match(migration, /naver_shopping_runtime_1_1_21_requires_completed_account_priority/u);
  assert.match(migration, /naver_shopping_runtime_1_1_21_requires_idle_control_plane/u);
  assert.match(migration, /current_row\.runtime_version is distinct from '1\.1\.20'/u);
  assert.match(migration, new RegExp(OLD_RUNTIME.fingerprint, "u"));
  assert.match(migration, /set runtime_version = '1\.1\.21'/u);
  assert.match(migration, /check \(runtime_version = '1\.1\.21'\)/u);
  assert.match(migration, new RegExp(NEW_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(migration, /1\.1\.19|631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e/u);
  assert.doesNotMatch(migration, /__N30_RUNTIME/u);
  const prefix = migration.split("create or replace function")[0];
  assert.doesNotMatch(
    prefix,
    /(?:insert into|update|delete from)\s+public\.naver_shopping_account_priority_(?:requests|members)/iu,
  );
  assert.doesNotMatch(prefix, /(?:insert into|update|delete from)\s+public\.naver_rank_trackers/iu);
  assert.doesNotMatch(prefix, /(?:insert into|update|delete from)\s+public\.naver_rank_snapshots/iu);
  assert.doesNotMatch(prefix, /(?:insert into|update|delete from)\s+public\.naver_shopping_scheduler_events/iu);
});

test("replaces the five runtime-sensitive functions plus the finite commit RPC, snapshot audit and parent guard", () => {
  const blocks = functionBlocks(migration);
  assert.deepEqual(blocks.map(({ name }) => name).sort(), [
    "mi_audit_naver_shopping_snapshot_commit",
    "mi_commit_naver_shopping_finite_worker_result",
    "mi_enqueue_naver_shopping_account_priority",
    "mi_get_naver_shopping_worker_operations",
    "mi_guard_naver_shopping_exact_parent_snapshot",
    "mi_record_naver_shopping_worker_failure",
    "mi_report_naver_shopping_worker_progress",
    "mi_set_naver_shopping_worker_cadence",
  ]);
  for (const { name, source } of blocks) {
    assert.match(source, /set search_path = ''/iu, name);
    if (name === "mi_audit_naver_shopping_snapshot_commit") {
      assert.match(source, /security definer/iu);
    } else {
      assert.match(source, /security invoker/iu, name);
    }
  }
  assert.equal(
    (migration.match(/expected_runtime_version constant text := '1\.1\.21'/gu) || []).length,
    4,
  );
  assert.doesNotMatch(migration, /create or replace function (?:public|mi_internal)\.mi_claim/iu);
  assert.doesNotMatch(migration, /create or replace function public\.mi_commit_naver_shopping_worker_result\(/iu);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon|authenticated)/iu);
  assert.doesNotMatch(migration, /grant execute on function mi_internal\./iu);
  assert.equal((migration.match(/to service_role;/giu) || []).length, 7);
  assert.match(
    migration,
    /revoke all on function mi_internal\.mi_audit_naver_shopping_snapshot_commit\(\)\s+from public, anon, authenticated, service_role/iu,
  );
  assert.match(
    migration,
    /revoke all on function mi_internal\.mi_guard_naver_shopping_exact_parent_snapshot\(\)\s+from public, anon, authenticated, service_role/iu,
  );
  assert.doesNotMatch(migration, /create trigger|drop trigger/iu);
});

test("re-declares the exact-parent guard with plain NULLIF/COALESCE and otherwise identical logic", () => {
  const guard = functionBlock(migration, "mi_guard_naver_shopping_exact_parent_snapshot");
  const deployedGuard = functionBlock(exactParentGuardMigration, "mi_guard_naver_shopping_exact_parent_snapshot");
  assert.ok(guard);
  assert.ok(deployedGuard);
  assert.match(deployedGuard, /pg_catalog\.nullif\(/u);
  assert.match(deployedGuard, /pg_catalog\.coalesce\(/u);
  assert.doesNotMatch(guard, /pg_catalog\.(?:nullif|coalesce)\(/u);
  assert.equal(
    guard.replaceAll("nullif(", "pg_catalog.nullif(").replaceAll("coalesce(", "pg_catalog.coalesce("),
    deployedGuard,
  );
  assert.doesNotMatch(guard, /c0ccded2-9bf7-488e-af8d-00898c0a1ff8|13327339525|59776958987/u);
});

test("finite commit RPC drops the canary allowlist while keeping every proof predicate", () => {
  const finiteCommit = functionBlock(migration, "mi_commit_naver_shopping_finite_worker_result");
  assert.ok(finiteCommit);
  assert.doesNotMatch(
    finiteCommit,
    /c0ccded2-9bf7-488e-af8d-00898c0a1ff8|13327339525|59776958987|naver_shopping_finite_window_targets|windows-desktop-primary|rank-catch-up|memberCount/iu,
  );
  assert.match(finiteCommit, /-- finite general gate begin/u);
  assert.match(finiteCommit, /finite_checked_count not between 1 and 299/u);
  assert.match(finiteCommit, /market_total is distinct from finite_checked_count/u);
  assert.match(finiteCommit, /matched_rank not between 1 and finite_checked_count/u);
  assert.match(finiteCommit, /tracking_rank_source not in \('exact_product', 'related_catalog'\)/u);
  assert.match(finiteCommit, /tracking_rank_source is distinct from 'not_found'/u);
  assert.match(finiteCommit, /item ->> 'finiteWindowProofVersion' is distinct from 'stable-finite-window-v1'/u);
  assert.match(finiteCommit, /item -> 'sourceExhausted' is distinct from 'true'::jsonb/u);
  assert.match(finiteCommit, /item -> 'atomicSuccessEligible' is distinct from 'false'::jsonb/u);
  assert.match(finiteCommit, /item ->> 'collectionId' is distinct from p_collection_id/u);
  assert.match(finiteCommit, /jsonb_array_length\(item -> 'catalogSellerProductIds'\) not between 1 and 300/u);
  assert.match(finiteCommit, /seller_id\.seller_id = pg_catalog\.btrim\(tracker\.product_id\)/u);
  assert.match(finiteCommit, /priority not in \('new', 'resume', 'normal', 'repair'\)/u);
  assert.match(finiteCommit, /runs\.runtime_version = current_row\.runtime_version/u);
  assert.match(finiteCommit, /runs\.runtime_fingerprint = current_row\.runtime_fingerprint/u);
  assert.match(finiteCommit, /local_worker_finite_ledger_missing/u);
  assert.doesNotMatch(finiteCommit, /update public\.naver_shopping_worker_coordination/iu);
  assert.doesNotMatch(finiteCommit, /success_streak\s*=|stability_started_at\s*=|cadence_minutes\s*=/iu);
  const generalGate = finiteCommit.slice(
    finiteCommit.indexOf("-- finite general gate begin"),
    finiteCommit.indexOf("-- finite general gate end"),
  );
  assert.ok(generalGate.length > 0);
  assert.doesNotMatch(generalGate, /thumbnail|image|similarity|product_title|title/iu);
  assert.doesNotMatch(finiteCommit, /pg_catalog\.(?:nullif|coalesce)\(/iu);
  assert.doesNotMatch(finiteCommit, /1\.1\.2[01]/u);

  const deployedFiniteCommit = functionBlock(deployedFiniteCommitMigration, "mi_commit_naver_shopping_finite_worker_result");
  assert.match(deployedFiniteCommit, /c0ccded2-9bf7-488e-af8d-00898c0a1ff8/u);
  assert.notEqual(finiteCommit, deployedFiniteCommit);
});

test("finite ledger CHECK and snapshot audit accept not-found terminals and keep the exact300 branch verbatim", () => {
  const check = migration.slice(
    migration.indexOf("add constraint naver_shopping_scheduler_events_finite_window_committed_check"),
    migration.indexOf("create or replace function public.mi_commit_naver_shopping_finite_worker_result"),
  );
  assert.ok(check.length > 0);
  assert.match(check, /checked_count between 1 and 299/u);
  assert.match(check, /details -> 'matched' is not distinct from 'true'::jsonb\s+and details ->> 'rank' is not null/u);
  assert.match(check, /details -> 'matched' is not distinct from 'false'::jsonb\s+and details ->> 'rank' is null/u);
  assert.match(check, /details ->> 'relationBasis' is null\s+or details ->> 'relationBasis' = 'catalog_seller_product_id'/u);
  assert.doesNotMatch(migration, /naver_shopping_scheduler_events_atomic_committed_check/u);
  assert.doesNotMatch(migration, /naver_shopping_scheduler_events_event_type_check/u);

  const audit = functionBlock(migration, "mi_audit_naver_shopping_snapshot_commit");
  const deployedAudit = functionBlock(deployedFiniteMigration, "mi_audit_naver_shopping_snapshot_commit");
  assert.ok(audit);
  assert.ok(deployedAudit);
  const exact300 = (source) => source.slice(
    source.indexOf("  insert into public.naver_shopping_scheduler_events("),
    source.indexOf("and snapshot.collection_id ~ '^pw-chrome-';") + "and snapshot.collection_id ~ '^pw-chrome-';".length,
  );
  assert.equal(exact300(audit), exact300(deployedAudit));
  assert.equal((audit.match(/'tracker_committed'/gu) || []).length, 1);
  assert.equal((audit.match(/'finite_window_committed'/gu) || []).length, 1);
  assert.doesNotMatch(audit, /naver_shopping_finite_window_targets|naver_shopping_worker_runs|naver_shopping_worker_coordination|memberCount|rank-catch-up/u);
  assert.match(audit, /claim\.priority in \('new', 'resume', 'normal', 'repair'\)/u);
  assert.match(audit, /snapshot\.matched = false\s+and snapshot\.rank is null\s+and snapshot\.item ->> 'trackingRankSource' = 'not_found'/u);
  assert.match(audit, /jsonb_array_length\(snapshot\.item -> 'catalogSellerProductIds'\) between 1 and 300/u);
  assert.match(audit, /pg_catalog\.jsonb_strip_nulls\(pg_catalog\.jsonb_build_object\(\s*'matched', snapshot\.matched/u);
});

test("runtime fingerprint and live surfaces are 1.1.21 while archived evidence stays pinned", () => {
  assert.deepEqual(calculateN30RuntimeFingerprint({
    repositoryRoot: root,
    version: NEW_RUNTIME.version,
  }).fingerprint, NEW_RUNTIME.fingerprint);
  assert.match(read("tools/naver-shopping-chrome-extension/manifest.json"), /"version": "1\.1\.21"/u);
  for (const relativePath of [
    "scripts/naver-shopping-local-worker.mjs",
    "src/server/handlers/naver-shopping-local-worker.mjs",
    "src/server/handlers/naver-rank-trackers.mjs",
    "src/server/naver-shopping/worker-runtime-expectation.mjs",
  ]) {
    assert.match(read(relativePath), /1\.1\.21/u, relativePath);
    assert.doesNotMatch(read(relativePath), /1\.1\.20/u, relativePath);
  }
  for (const relativePath of [
    "scripts/naver-shopping-candidate-performance-audit.mjs",
    "scripts/naver-shopping-account-rank-health-audit.mjs",
  ]) {
    assert.match(read(relativePath), /"1\.1\.21"/u, relativePath);
    assert.match(read(relativePath), new RegExp(NEW_RUNTIME.fingerprint, "u"), relativePath);
  }
  assert.match(priorMigration, new RegExp(OLD_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(priorMigration, /1\.1\.21/u);
  const finalAudit = read("scripts/naver-shopping-account-priority-final-audit.mjs");
  assert.match(finalAudit, /1\.1\.19/u);
  assert.doesNotMatch(finalAudit, /1\.1\.2[01]/u);
});

test("PGlite rejects an active request without mutating its frozen evidence", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  const frozen = await cohort(database);
  await database.query(`
    insert into public.naver_shopping_account_priority_requests (
      request_id, agency_code, cohort_count, cohort_hash,
      required_runtime_version, required_runtime_fingerprint,
      requested_at, expires_at, requested_cycle_id, requested_cycle_number,
      state
    ) values (
      $1::uuid, 'mml93-a01', $2, $3, $4, $5,
      clock_timestamp(), clock_timestamp() + interval '24 hours',
      $6::uuid, 52, 'active'
    )
  `, [
    ids.requestOld,
    frozen.count,
    frozen.hash,
    OLD_RUNTIME.version,
    OLD_RUNTIME.fingerprint,
    ids.cycle,
  ]);
  await database.query(`
    insert into public.naver_shopping_account_priority_members(
      request_id, position, tracker_id, state
    ) values ($1::uuid, 1, $2::uuid, 'pending')
  `, [ids.requestOld, ids.tracker]);
  const before = (await database.query(`
    select request.*, member.position, member.tracker_id::text, member.state as member_state
    from public.naver_shopping_account_priority_requests as request
    join public.naver_shopping_account_priority_members as member using (request_id)
  `)).rows;
  await assert.rejects(
    database.exec(migration),
    /naver_shopping_runtime_1_1_21_requires_completed_account_priority/u,
  );
  await database.exec("rollback");
  const after = (await database.query(`
    select request.*, member.position, member.tracker_id::text, member.state as member_state
    from public.naver_shopping_account_priority_requests as request
    join public.naver_shopping_account_priority_members as member using (request_id)
  `)).rows;
  assert.deepEqual(after, before);
  assert.equal((await database.query(`
    select runtime_version from public.naver_shopping_worker_coordination
  `)).rows[0].runtime_version, OLD_RUNTIME.version);
});

test("PGlite rejects wrong identity, processing work, a live lease, or an open circuit", async (t) => {
  const cases = [
    ["wrong identity", "update public.naver_shopping_worker_coordination set runtime_fingerprint = repeat('f', 64)"],
    ["stale 1.1.19 identity", "update public.naver_shopping_worker_coordination set runtime_version = '1.1.19'"],
    ["processing", "insert into public.naver_shopping_rank_lookup_jobs(status, processing_until) values ('processing', clock_timestamp() + interval '5 minutes')"],
    ["live lease", "update public.naver_shopping_worker_coordination set lease_worker_id = 'windows-desktop-primary', lease_token = gen_random_uuid(), lease_until = clock_timestamp() + interval '5 minutes'"],
    ["open circuit", "update public.naver_shopping_worker_coordination set circuit_state = 'open', circuit_reason = 'test'"],
  ];
  for (const [name, mutation] of cases) {
    const database = await createDatabase();
    t.after(() => database.close());
    await database.exec(mutation);
    await assert.rejects(
      database.exec(migration),
      /naver_shopping_runtime_1_1_21_requires_idle_control_plane/u,
      name,
    );
  }
});

test("PGlite migrates only runtime state and preserves completed 1.1.20 evidence", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await insertCompletedOldRequest(database);
  const before = (await database.query(`
    select request.*, member.position, member.tracker_id::text,
           member.state as member_state, member.claimed_at, member.terminal_at,
           member.terminal_code
    from public.naver_shopping_account_priority_requests as request
    join public.naver_shopping_account_priority_members as member using (request_id)
  `)).rows;
  await database.exec(migration);
  const after = (await database.query(`
    select request.*, member.position, member.tracker_id::text,
           member.state as member_state, member.claimed_at, member.terminal_at,
           member.terminal_code
    from public.naver_shopping_account_priority_requests as request
    join public.naver_shopping_account_priority_members as member using (request_id)
  `)).rows;
  assert.deepEqual(after, before);
  assert.deepEqual((await database.query(`
    select runtime_version, runtime_fingerprint
    from public.naver_shopping_finite_window_targets
  `)).rows, [{
    runtime_version: NEW_RUNTIME.version,
    runtime_fingerprint: NEW_RUNTIME.fingerprint,
  }]);
  const coordination = (await database.query(`
    select runtime_version, runtime_fingerprint, cadence_mode, cadence_minutes,
           stability_started_at, success_streak, last_collection_id,
           last_checked_count, scheduler_cycle_id::text, scheduler_cycle_number,
           scheduler_cycle_cursor_sort_order
    from public.naver_shopping_worker_coordination
  `)).rows[0];
  assert.deepEqual(coordination, {
    runtime_version: null,
    runtime_fingerprint: null,
    cadence_mode: "baseline",
    cadence_minutes: 10,
    stability_started_at: null,
    success_streak: 0,
    last_collection_id: "pw-chrome-last-good",
    last_checked_count: 300,
    scheduler_cycle_id: ids.cycle,
    scheduler_cycle_number: 52,
    scheduler_cycle_cursor_sort_order: 9100,
  });
  const constraint = (await database.query(`
    select pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conname = 'naver_shopping_scheduler_events_finite_window_committed_check'
  `)).rows[0].definition;
  assert.match(constraint, /checked_count >= 1/u);
  assert.match(constraint, /checked_count <= 299/u);
});

test("PGlite permits one same-cohort 1.1.21 request while keeping the 1.1.20 row", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  const frozen = await insertCompletedOldRequest(database);
  await database.exec(migration);
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set runtime_version = '${NEW_RUNTIME.version}',
        runtime_fingerprint = '${NEW_RUNTIME.fingerprint}',
        primary_seen_at = clock_timestamp(),
        scheduler_cycle_status = 'active'
    where lane_key = 'global'
  `);

  await assert.rejects(
    database.query(`
      select public.mi_enqueue_naver_shopping_account_priority(
        $1::uuid, 'mml93-a01', $2, $3, $4, $5
      )
    `, [
      ids.requestNew,
      frozen.count,
      frozen.hash,
      OLD_RUNTIME.version,
      OLD_RUNTIME.fingerprint,
    ]),
    /naver_shopping_account_priority_invalid/u,
  );

  const accepted = (await database.query(`
    select public.mi_enqueue_naver_shopping_account_priority(
      $1::uuid, 'mml93-a01', $2, $3, $4, $5
    ) as result
  `, [
    ids.requestNew,
    frozen.count,
    frozen.hash,
    NEW_RUNTIME.version,
    NEW_RUNTIME.fingerprint,
  ])).rows[0].result;
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.idempotent, false);

  await assert.rejects(
    database.query(`
      select public.mi_enqueue_naver_shopping_account_priority(
        $1::uuid, 'mml93-a01', $2, $3, $4, $5
      )
    `, [
      ids.requestThird,
      frozen.count,
      frozen.hash,
      NEW_RUNTIME.version,
      NEW_RUNTIME.fingerprint,
    ]),
    /naver_shopping_account_priority_active_conflict/u,
  );

  assert.deepEqual((await database.query(`
    select required_runtime_version, count(*)::integer as count
    from public.naver_shopping_account_priority_requests
    group by required_runtime_version
    order by required_runtime_version
  `)).rows, [
    { required_runtime_version: OLD_RUNTIME.version, count: 1 },
    { required_runtime_version: NEW_RUNTIME.version, count: 1 },
  ]);
});

test("PGlite progress RPC accepts only the 1.1.21 identity and resets inherited cadence proof", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.exec(migration);
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = 'macbook-standby',
        lease_token = '${ids.lane}',
        lease_until = clock_timestamp() + interval '5 minutes',
        cadence_mode = 'candidate',
        cadence_minutes = 6,
        success_streak = 4,
        stability_started_at = clock_timestamp() - interval '2 days'
    where lane_key = 'global'
  `);
  const progress = (runtime) => database.query(`
    select public.mi_report_naver_shopping_worker_progress(
      'macbook-standby', $1::uuid, $2::uuid, 'navigating', 0, 'tracker', $3::uuid,
      $4, $5, 'mac-standby'
    ) as accepted
  `, [ids.lane, ids.run, ids.tracker, runtime.version, runtime.fingerprint]);
  assert.equal((await progress(OLD_RUNTIME)).rows[0].accepted, false);
  assert.equal((await progress(NEW_RUNTIME)).rows[0].accepted, true);
  assert.deepEqual((await database.query(`
    select runtime_version, runtime_fingerprint, cadence_mode, cadence_minutes,
           success_streak, stability_started_at
    from public.naver_shopping_worker_coordination
  `)).rows, [{
    runtime_version: NEW_RUNTIME.version,
    runtime_fingerprint: NEW_RUNTIME.fingerprint,
    cadence_mode: "baseline",
    cadence_minutes: 10,
    success_streak: 0,
    stability_started_at: null,
  }]);
  assert.deepEqual((await database.query(`
    select worker_id, run_trigger, runtime_version, runtime_fingerprint
    from public.naver_shopping_worker_runs
  `)).rows, [{
    worker_id: "macbook-standby",
    run_trigger: "mac-standby",
    runtime_version: NEW_RUNTIME.version,
    runtime_fingerprint: NEW_RUNTIME.fingerprint,
  }]);
});

test("PGlite quarantines numeric boundary proof failures without opening the circuit", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.exec(migration);
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set runtime_version = '${NEW_RUNTIME.version}',
        runtime_fingerprint = '${NEW_RUNTIME.fingerprint}',
        lease_worker_id = 'windows-desktop-primary',
        lease_token = '${ids.lane}',
        lease_until = clock_timestamp() + interval '5 minutes',
        run_id = '${ids.run}',
        current_stage = 'collecting',
        current_page = 4,
        current_job_kind = 'tracker',
        current_tracker_id = '${ids.tracker}',
        current_job_started_at = clock_timestamp()
    where lane_key = 'global'
  `);
  const code = "provider_stable_rendered_order_unproven:page_boundary:4:g0:l29";
  const result = (await database.query(`
    select public.mi_record_naver_shopping_worker_failure(
      'windows-desktop-primary', $1::uuid, $2::uuid, $3, 'tracker', $4::uuid
    ) as result
  `, [ids.lane, ids.run, code, ids.tracker])).rows[0].result;
  assert.equal(result.recorded, true);
  assert.equal(result.quarantined, true);
  assert.equal(result.circuitState, "closed");
});

test("PGlite commits an ordinary tracker's exact-product finite market on the Mac standby", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await prepareFiniteLane(database);
  const { snapshot, collectionId } = finiteSnapshot();
  const cadenceBefore = (await database.query(`
    select cadence_mode, cadence_minutes, success_streak, last_success_at
    from public.naver_shopping_worker_coordination
  `)).rows;

  const result = await commitFinite(database, snapshot, collectionId);

  assert.equal(result.status, "committed");
  assert.equal(result.finiteWindow, true);
  assert.equal(result.atomicSuccessEligible, false);
  assert.deepEqual((await database.query(`
    select matched, rank, page, position, checked_count, total, source, collection_id
    from public.naver_rank_snapshots
  `)).rows, [{
    matched: true,
    rank: 5,
    page: 1,
    position: 5,
    checked_count: 27,
    total: 27,
    source: "naver_shopping_results_collector",
    collection_id: collectionId,
  }]);
  const ledger = (await database.query(`
    select worker_id, priority, checked_count, collection_id, details
    from public.naver_shopping_scheduler_events
    where event_type = 'finite_window_committed'
  `)).rows;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].worker_id, "macbook-standby");
  assert.equal(ledger[0].priority, "normal");
  assert.equal(ledger[0].checked_count, 27);
  assert.deepEqual(ledger[0].details, {
    matched: true,
    rank: 5,
    source: "naver_shopping_results_collector",
    finiteWindowProofVersion: "stable-finite-window-v1",
    sourceExhausted: true,
    marketTotal: 27,
    atomicSuccessEligible: false,
  });
  assert.equal((await database.query(`
    select count(*)::integer as count from public.naver_shopping_scheduler_events
    where event_type = 'tracker_committed'
  `)).rows[0].count, 0);
  assert.deepEqual((await database.query(`
    select current_rank, best_rank, worst_rank, check_count, found_count,
           retry_count, last_error, processing_started_at, processing_until
    from public.naver_rank_trackers where id = $1::uuid
  `, [ids.tracker])).rows, [{
    current_rank: 5,
    best_rank: 5,
    worst_rank: 5,
    check_count: 1,
    found_count: 1,
    retry_count: 0,
    last_error: null,
    processing_started_at: null,
    processing_until: null,
  }]);
  // Cadence proof and the last atomic success are never touched by a finite commit.
  assert.deepEqual((await database.query(`
    select cadence_mode, cadence_minutes, success_streak, last_success_at
    from public.naver_shopping_worker_coordination
  `)).rows, cadenceBefore);
  assert.equal(cadenceBefore[0].cadence_mode, "baseline");
  assert.equal(cadenceBefore[0].success_streak, 0);
});

test("PGlite commits a not-found finite market with a null rank and a rankless ledger", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await prepareFiniteLane(database, { priority: "repair" });
  const { snapshot, collectionId } = notFoundSnapshot();

  const result = await commitFinite(database, snapshot, collectionId);

  assert.equal(result.status, "committed");
  assert.deepEqual((await database.query(`
    select matched, rank, page, position, checked_count, total
    from public.naver_rank_snapshots
  `)).rows, [{ matched: false, rank: null, page: null, position: null, checked_count: 27, total: 27 }]);
  const ledger = (await database.query(`
    select priority, details from public.naver_shopping_scheduler_events
    where event_type = 'finite_window_committed'
  `)).rows;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].priority, "repair");
  assert.deepEqual(ledger[0].details, {
    matched: false,
    source: "naver_shopping_results_collector",
    finiteWindowProofVersion: "stable-finite-window-v1",
    sourceExhausted: true,
    marketTotal: 27,
    atomicSuccessEligible: false,
  });
  assert.deepEqual((await database.query(`
    select current_rank, best_rank, worst_rank, check_count, found_count
    from public.naver_rank_trackers where id = $1::uuid
  `, [ids.tracker])).rows, [{
    current_rank: null, best_rank: null, worst_rank: null, check_count: 1, found_count: 0,
  }]);

  // A lost response reconciles to the same finite commit.
  const replay = await commitFinite(database, snapshot, collectionId);
  assert.equal(replay.status, "already_committed");
});

test("PGlite: the deployed parent guard raises 42883 on a related catalog until the migration re-declares it", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  const relatedCatalogItem = JSON.stringify({
    trackingRankSource: "related_catalog",
    relatedCatalogProductId: "58888888888",
    catalogId: "58888888888",
    relatedCatalogRelationBasis: "catalog_seller_product_id",
    catalogSellerProductIds: [TRACKER_PRODUCT_ID],
  });
  await assert.rejects(
    database.query(
      "insert into public.naver_rank_snapshots(tracker_id, item) values ($1::uuid, $2::jsonb)",
      [ids.tracker, relatedCatalogItem],
    ),
    (error) => error?.code === "42883" && /pg_catalog\.nullif/u.test(String(error?.message || "")),
  );
  await database.exec(migration);
  await database.query(
    "insert into public.naver_rank_snapshots(tracker_id, item) values ($1::uuid, $2::jsonb)",
    [ids.tracker, relatedCatalogItem],
  );
  await assert.rejects(
    database.query(
      "insert into public.naver_rank_snapshots(tracker_id, item) values ($1::uuid, $2::jsonb)",
      [ids.tracker, JSON.stringify({ ...JSON.parse(relatedCatalogItem), catalogSellerProductIds: ["20099999999"] })],
    ),
    /naver_shopping_exact_parent_relation_invalid/u,
  );
  assert.equal((await database.query("select count(*)::integer as count from public.naver_rank_snapshots")).rows[0].count, 1);
});

test("PGlite commits a directly linked parent catalog listing 300 sellers and rejects 301 or a foreign list", async (t) => {
  const catalogItem = (sellerCount, { includeTracker = true } = {}) => ({
    productId: "58888888888",
    sellerProductId: "",
    catalogId: "58888888888",
    isOrganic: true,
    isAd: false,
    trackingRankSource: "related_catalog",
    relatedCatalogProductId: "58888888888",
    relatedCatalogRelationBasis: "catalog_seller_product_id",
    catalogSellerProductIds: [
      ...Array.from({ length: sellerCount - 1 }, (_, index) => String(20000000000 + index)),
      includeTracker ? TRACKER_PRODUCT_ID : "20099999999",
    ],
  });
  for (const scenario of [
    { name: "300 sellers including the tracker", item: catalogItem(300), expected: "committed" },
    { name: "301 sellers", item: catalogItem(301), expected: /local_worker_finite_exact_relation_invalid/u },
    { name: "300 sellers without the tracker", item: catalogItem(300, { includeTracker: false }), expected: /local_worker_finite_exact_relation_invalid/u },
    { name: "catalog id that differs from the related id", item: { ...catalogItem(3), catalogId: "58888888889" }, expected: /local_worker_finite_exact_relation_invalid/u },
  ]) {
    await t.test(scenario.name, async () => {
      const database = await createDatabase();
      t.after(() => database.close());
      await prepareFiniteLane(database);
      const { snapshot, collectionId } = finiteSnapshot({}, scenario.item);
      if (scenario.expected === "committed") {
        const result = await commitFinite(database, snapshot, collectionId);
        assert.equal(result.status, "committed");
        assert.deepEqual((await database.query(`
          select details ->> 'relationBasis' as relation_basis, details ->> 'rank' as rank
          from public.naver_shopping_scheduler_events
          where event_type = 'finite_window_committed'
        `)).rows, [{ relation_basis: "catalog_seller_product_id", rank: "5" }]);
      } else {
        await assert.rejects(commitFinite(database, snapshot, collectionId), scenario.expected);
        assert.equal((await database.query("select count(*)::integer as count from public.naver_rank_snapshots")).rows[0].count, 0);
      }
    });
  }
});

test("PGlite finite commit keeps every proof predicate fail-closed", async (t) => {
  for (const scenario of [
    { name: "checked_count 300 never enters the finite path", build: () => finiteSnapshot({ checked_count: 300, total: 300 }, { finiteMarketTotal: 300 }) },
    { name: "rank above the market", build: () => finiteSnapshot({ rank: 28 }) },
    { name: "matched without a rank", build: () => finiteSnapshot({ rank: null }) },
    { name: "not found with a rank", build: () => notFoundSnapshot({ rank: 5 }) },
    { name: "not found typed as exact product", build: () => finiteSnapshot({ matched: false, rank: null }) },
    { name: "market total differs from checked_count", build: () => finiteSnapshot({ total: 28 }) },
    { name: "source not exhausted", build: () => finiteSnapshot({}, { sourceExhausted: false }) },
    { name: "missing finite proof version", build: () => finiteSnapshot({}, { finiteWindowProofVersion: "stable-full-window-v1" }) },
    { name: "finite market total mismatch", build: () => finiteSnapshot({}, { finiteMarketTotal: 26 }) },
    { name: "atomic success eligibility claimed", build: () => finiteSnapshot({}, { atomicSuccessEligible: true }) },
    { name: "collection id mismatch inside the item", build: () => finiteSnapshot({}, { collectionId: "pw-chrome-other" }) },
    { name: "matched row that is an ad", build: () => finiteSnapshot({}, { isAd: true }) },
    { name: "non-organic top item", build: () => finiteSnapshot({ top_items: [{ isOrganic: false, isAd: true }] }) },
  ]) {
    await t.test(scenario.name, async () => {
      const database = await createDatabase();
      t.after(() => database.close());
      await prepareFiniteLane(database);
      const { snapshot, collectionId } = scenario.build();
      await assert.rejects(
        commitFinite(database, snapshot, collectionId),
        /local_worker_finite_exact_relation_invalid/u,
      );
      assert.equal((await database.query("select count(*)::integer as count from public.naver_rank_snapshots")).rows[0].count, 0);
    });
  }
});

test("PGlite finite commit still requires the lane, the run identity and a clean single claim", async (t) => {
  for (const scenario of [
    {
      name: "run recorded under a different fingerprint",
      mutate: `update public.naver_shopping_worker_runs set runtime_fingerprint = repeat('e', 64)`,
      expected: /local_worker_finite_control_invalid/u,
    },
    {
      name: "lane held by another worker",
      mutate: `update public.naver_shopping_worker_coordination set lease_worker_id = 'windows-desktop-primary'`,
      expected: /local_worker_finite_control_invalid/u,
    },
    {
      name: "claim already failed",
      mutate: `insert into public.naver_shopping_scheduler_events(event_type, claim_id, run_id, worker_id, tracker_id, occurred_at, error_code)
        values ('job_failed', '${ids.claim}', '${ids.run}', 'macbook-standby', '${ids.tracker}', clock_timestamp(), 'provider_partial_window')`,
      expected: /local_worker_finite_control_invalid/u,
    },
    {
      name: "probe priority claim",
      mutate: `update public.naver_shopping_scheduler_events set priority = 'probe' where event_type = 'tracker_claimed'`,
      expected: /local_worker_finite_claim_invalid/u,
    },
    {
      name: "duplicate tracker claim",
      mutate: `insert into public.naver_shopping_scheduler_events(event_type, claim_id, run_id, worker_id, tracker_id, group_fingerprint, priority, lease_started_at, occurred_at)
        values ('tracker_claimed', '${ids.claim}', '${ids.run}', 'macbook-standby', '${ids.tracker}', 'group-fingerprint-1', 'normal', '${LEASE_STARTED_AT}', clock_timestamp())`,
      expected: /local_worker_finite_group_invalid/u,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const database = await createDatabase();
      t.after(() => database.close());
      await prepareFiniteLane(database);
      await database.exec(scenario.mutate);
      const { snapshot, collectionId } = finiteSnapshot();
      await assert.rejects(commitFinite(database, snapshot, collectionId), scenario.expected);
      assert.equal((await database.query("select count(*)::integer as count from public.naver_rank_snapshots")).rows[0].count, 0);
    });
  }
});

test("PGlite finite ledger CHECK admits a rankless not-found terminal and rejects a rankless match", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.exec(migration);
  const insert = (details) => database.query(`
    insert into public.naver_shopping_scheduler_events(
      event_type, claim_id, run_id, worker_id, tracker_id, group_fingerprint,
      collection_id, checked_count, details, occurred_at
    ) values (
      'finite_window_committed', $1::uuid, $2::uuid, 'macbook-standby', $3::uuid,
      'group-fingerprint-1', 'pw-chrome-check-test', 27, $4::jsonb, clock_timestamp()
    )
  `, [ids.claim, ids.run, ids.tracker, JSON.stringify({
    source: "naver_shopping_results_collector",
    finiteWindowProofVersion: "stable-finite-window-v1",
    sourceExhausted: true,
    marketTotal: 27,
    atomicSuccessEligible: false,
    ...details,
  })]);
  await insert({ matched: false });
  await insert({ matched: true, rank: 5 });
  await insert({ matched: true, rank: 5, relationBasis: "catalog_seller_product_id" });
  for (const details of [
    { matched: true },
    { matched: false, rank: 5 },
    { matched: true, rank: 28 },
    { matched: true, rank: 5, relationBasis: "inferred" },
    { rank: 5 },
  ]) {
    await assert.rejects(insert(details), /finite_window_committed_check/u, JSON.stringify(details));
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260831052231_naver_shopping_runtime_1_1_20_rendered_boundary_consensus.sql";
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const priorMigrationName = "20260831014800_naver_shopping_runtime_1_1_19_stable_rendered_order.sql";
const accountPriorityMigrationName = "20260831033617_naver_shopping_account_one_shot_priority.sql";
const priorMigration = fs.readFileSync(path.join(migrationDirectory, priorMigrationName), "utf8");

const OLD_RUNTIME = Object.freeze({
  version: "1.1.19",
  fingerprint: "631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e",
});
const NEW_RUNTIME = Object.freeze({
  version: "1.1.20",
  fingerprint: "4e0f5fbde16a892e44986b2325865f33d61bdf7a5a13d3d7adcd501608aa8e5b",
});
const ids = Object.freeze({
  tracker: "50000000-0000-4000-8000-000000000001",
  requestOld: "10000000-0000-4000-8000-000000000001",
  requestNew: "10000000-0000-4000-8000-000000000002",
  requestThird: "10000000-0000-4000-8000-000000000003",
  cycle: "20000000-0000-4000-8000-000000000001",
  lane: "30000000-0000-4000-8000-000000000001",
  run: "40000000-0000-4000-8000-000000000001",
});

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function functionBlocks(source) {
  return [...source.matchAll(
    /create or replace function (?:public|mi_internal)\.([a-z0-9_]+)\([\s\S]*?\n\$\$;/giu,
  )].map((match) => ({ name: match[1], source: match[0] }));
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
        check (runtime_version = '1.1.19')
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
      constraint naver_shopping_account_priority_req_agency_code_cohort_hash_key
        unique (agency_code, cohort_hash)
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
      '${ids.tracker}', 'mml93-a01', 'active', '12149720593',
      '허리찜질기', 1100, '2026-08-01T00:00:00Z', clock_timestamp()
    );
  `);
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
      '2026-08-30T00:00:00Z', '2026-08-31T00:00:00Z',
      $6::uuid, 51, 'completed', '2026-08-30T01:00:00Z', false
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
      '2026-08-30T00:10:00Z', '2026-08-30T00:20:00Z',
      'provider_stable_rendered_order_unproven'
    )
  `, [requestId, ids.tracker]);
  return frozen;
}

test("migration is additive, fail-closed, and does not rewrite account evidence", () => {
  assert.ok(migrationName > priorMigrationName);
  assert.ok(migrationName > accountPriorityMigrationName);
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
  assert.match(migration, /requires_completed_account_priority/u);
  assert.match(
    migration,
    /drop constraint if exists\s+naver_shopping_account_priority_req_agency_code_cohort_hash_key/iu,
  );
  assert.match(
    migration,
    /unique \(\s*agency_code,\s*cohort_hash,\s*required_runtime_version,\s*required_runtime_fingerprint\s*\)/iu,
  );
  const prefix = migration.split("create or replace function")[0];
  assert.doesNotMatch(
    prefix,
    /(?:insert into|update|delete from)\s+public\.naver_shopping_account_priority_(?:requests|members)/iu,
  );
  assert.doesNotMatch(prefix, /(?:insert into|update|delete from)\s+public\.naver_rank_trackers/iu);
  assert.doesNotMatch(prefix, /(?:insert into|update|delete from)\s+public\.naver_rank_snapshots/iu);
  assert.doesNotMatch(prefix, /(?:insert into|update|delete from)\s+public\.naver_shopping_scheduler_events/iu);
});

test("replaces only the five runtime-sensitive public functions with locked-down grants", () => {
  const blocks = functionBlocks(migration);
  assert.deepEqual(blocks.map(({ name }) => name).sort(), [
    "mi_enqueue_naver_shopping_account_priority",
    "mi_get_naver_shopping_worker_operations",
    "mi_record_naver_shopping_worker_failure",
    "mi_report_naver_shopping_worker_progress",
    "mi_set_naver_shopping_worker_cadence",
  ]);
  for (const { source } of blocks) {
    assert.match(source, /security invoker/iu);
    assert.match(source, /set search_path = ''/iu);
  }
  assert.doesNotMatch(migration, /create or replace function (?:public|mi_internal)\.mi_claim/iu);
  assert.doesNotMatch(migration, /create or replace function public\.mi_commit_naver_shopping_finite_worker_result/iu);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon|authenticated)/iu);
  assert.equal((migration.match(/to service_role;/giu) || []).length, 6);
});

test("keeps the archived runtime 1.1.20 migration pinned to its historical fingerprint", () => {
  // 1.1.20 is archived evidence: its migration keeps the fingerprint of the
  // runtime that produced it, and never learns about the 1.1.21 successor.
  assert.match(migration, new RegExp(NEW_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(migration, /1\.1\.21/u);
  assert.match(priorMigration, new RegExp(OLD_RUNTIME.fingerprint, "u"));
  assert.doesNotMatch(priorMigration, /1\.1\.20/u);
  const finalAudit = read("scripts/naver-shopping-account-priority-final-audit.mjs");
  assert.match(finalAudit, /1\.1\.19/u);
  assert.match(finalAudit, new RegExp(OLD_RUNTIME.fingerprint, "u"));
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
    /naver_shopping_runtime_1_1_20_requires_completed_account_priority/u,
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
      /naver_shopping_runtime_1_1_20_requires_idle_control_plane/u,
      name,
    );
  }
});

test("PGlite migrates only runtime state and preserves completed 1.1.19 evidence", async (t) => {
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
});

test("PGlite permits one same-cohort 1.1.20 request while keeping the 1.1.19 row", async (t) => {
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
  assert.equal(accepted.wakeRequested, false);

  const idempotent = (await database.query(`
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
  assert.equal(idempotent.idempotent, true);

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

  await database.query(`
    update public.naver_shopping_account_priority_members
    set state = 'terminal_failure', terminal_at = clock_timestamp(),
        terminal_code = 'provider_stable_rendered_order_unproven'
    where request_id = $1::uuid
  `, [ids.requestNew]);
  await database.query(`
    update public.naver_shopping_account_priority_requests
    set state = 'completed', completed_at = clock_timestamp(), succeeded = false
    where request_id = $1::uuid
  `, [ids.requestNew]);
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
    /naver_shopping_account_priority_cohort_already_requested/u,
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
        current_page = 2,
        current_job_kind = 'tracker',
        current_tracker_id = '${ids.tracker}',
        current_job_started_at = clock_timestamp()
    where lane_key = 'global'
  `);
  const code = "provider_stable_rendered_order_unproven:page_boundary:2:g0:l13";
  const result = (await database.query(`
    select public.mi_record_naver_shopping_worker_failure(
      'windows-desktop-primary', $1::uuid, $2::uuid, $3, 'tracker', $4::uuid
    ) as result
  `, [ids.lane, ids.run, code, ids.tracker])).rows[0].result;
  assert.equal(result.recorded, true);
  assert.equal(result.quarantined, true);
  assert.equal(result.circuitState, "closed");
  assert.deepEqual((await database.query(`
    select coordination.circuit_state, coordination.circuit_reason,
           tracker.worker_quarantined_until > clock_timestamp() + interval '29 minutes'
             and tracker.worker_quarantined_until <= clock_timestamp() + interval '31 minutes'
             as bounded
    from public.naver_shopping_worker_coordination as coordination
    cross join public.naver_rank_trackers as tracker
    where coordination.lane_key = 'global' and tracker.id = $1::uuid
  `, [ids.tracker])).rows, [{
    circuit_state: "closed",
    circuit_reason: null,
    bounded: true,
  }]);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function migrationSource(name) {
  return fs.readFileSync(path.join(root, "supabase", "migrations", name), "utf8");
}

const baseMigrationName = "20260831033617_naver_shopping_account_one_shot_priority.sql";
const handoffMigrationName =
  "20260831050000_naver_shopping_account_priority_cycle_handoff.sql";
const triggerGateMigrationName =
  "20260831100525_naver_shopping_account_priority_rank_catch_up_gate.sql";
const runtimeNeutralGateMigrationName =
  "20260903113000_naver_shopping_account_priority_gate_runtime_neutral.sql";
const cohortMigrationName =
  "20260903190000_naver_shopping_account_priority_cohort_eligibility_and_cycle_resume.sql";

const baseMigration = migrationSource(baseMigrationName);
const handoffMigration = migrationSource(handoffMigrationName);
const triggerGateMigration = migrationSource(triggerGateMigrationName);
const runtimeNeutralGateMigration = migrationSource(runtimeNeutralGateMigrationName);
const cohortMigration = migrationSource(cohortMigrationName);

// The installed control plane runtime is irrelevant to this migration on
// purpose; the fixture picks values that match no released runtime so a
// re-introduced literal cannot pass.
const runtimeVersion = "9.9.9";
const runtimeFingerprint = "c".repeat(64);

const ids = Object.freeze({
  request: "10000000-0000-4000-8000-000000000001",
  stalledRequest: "10000000-0000-4000-8000-000000000002",
  cycle: "20000000-0000-4000-8000-000000000001",
  lane: "30000000-0000-4000-8000-000000000001",
  run1: "40000000-0000-4000-8000-000000000001",
  run2: "40000000-0000-4000-8000-000000000002",
  run3: "40000000-0000-4000-8000-000000000003",
  run4: "40000000-0000-4000-8000-000000000004",
  run5: "40000000-0000-4000-8000-000000000005",
  mmlA: "50000000-0000-4000-8000-000000000001",
  mmlB: "50000000-0000-4000-8000-000000000002",
  mmlGone: "50000000-0000-4000-8000-000000000003",
  mmlNew: "50000000-0000-4000-8000-000000000004",
  otherHead: "50000000-0000-4000-8000-000000000005",
  otherCursor: "50000000-0000-4000-8000-000000000006",
  otherTail1: "50000000-0000-4000-8000-000000000007",
  otherTail2: "50000000-0000-4000-8000-000000000008",
});

function stripInstallOnly(sql) {
  return sql
    .replace(/set local lock_timeout = '5s';\s*/giu, "")
    .replace(/lock table [^;]+;\s*/giu, "")
    .replace(/do \$migration_guard\$[\s\S]*?\$migration_guard\$;\s*/giu, "");
}

function executableBaseMigration() {
  return stripInstallOnly(
    baseMigration
      .replaceAll("'1.1.19'", `'${runtimeVersion}'`)
      .replaceAll(
        "631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e",
        runtimeFingerprint,
      ),
  );
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
      primary_worker_id text,
      primary_seen_at timestamptz,
      lease_worker_id text,
      lease_token uuid,
      lease_until timestamptz,
      run_id uuid,
      runtime_version text,
      runtime_fingerprint text,
      circuit_state text not null default 'closed',
      circuit_reason text,
      cooldown_until timestamptz,
      current_stage text,
      current_page integer not null default 0,
      current_job_kind text,
      current_tracker_id uuid,
      current_job_started_at timestamptz,
      probe_tracker_id uuid,
      probe_started_at timestamptz,
      cadence_mode text not null default 'baseline',
      cadence_minutes integer not null default 10,
      scheduler_cycle_id uuid,
      scheduler_cycle_number bigint not null default 0,
      scheduler_cycle_status text not null default 'idle',
      scheduler_cycle_started_at timestamptz,
      scheduler_cycle_completed_at timestamptz,
      scheduler_cycle_cursor_sort_order integer,
      scheduler_cycle_cursor_created_at timestamptz,
      scheduler_cycle_cursor_tracker_id uuid,
      scheduler_cycle_resume_cursor boolean not null default false,
      updated_at timestamptz not null default clock_timestamp()
    );

    create table public.naver_shopping_rank_lookup_jobs (
      id uuid primary key,
      status text,
      processing_until timestamptz
    );

    create table public.naver_shopping_worker_wakes (
      worker_key text primary key,
      requested_at timestamptz not null,
      consumed_at timestamptz,
      source text not null,
      updated_at timestamptz not null default clock_timestamp()
    );

    create table public.test_transport_calls (
      transport text primary key,
      call_count integer not null default 0
    );
    insert into public.test_transport_calls(transport)
    values ('queue'), ('cycle'), ('lookup'), ('wake'), ('legacy_repair');

    -- Trackers listed here never receive a cycle_rostered row, which is how a
    -- tracker registered after the cycle snapshot behaves until it is deferred.
    create table public.test_unrostered_trackers (tracker_id uuid primary key);

    create table public.naver_rank_trackers (
      id uuid primary key,
      agency_code text not null,
      status text not null default 'active',
      keyword text not null,
      sort_order integer not null,
      created_at timestamptz not null,
      last_checked_at timestamptz,
      processing_started_at timestamptz,
      processing_until timestamptz,
      worker_quarantined_until timestamptz,
      worker_last_cycle_id uuid,
      worker_last_cycle_claimed_at timestamptz,
      worker_last_cycle_deferred_at timestamptz,
      last_message text
    );

    create table public.naver_shopping_worker_runs (
      run_id uuid primary key,
      worker_id text not null,
      run_trigger text not null,
      runtime_version text not null,
      runtime_fingerprint text not null,
      started_at timestamptz not null default clock_timestamp()
    );

    create table public.naver_shopping_scheduler_events (
      event_id bigint generated always as identity primary key,
      occurred_at timestamptz not null default date_trunc('milliseconds', clock_timestamp()),
      event_type text not null,
      cycle_id uuid,
      cycle_number bigint,
      claim_id uuid,
      run_id uuid,
      worker_id text,
      tracker_id uuid,
      agency_code text,
      group_fingerprint text,
      priority text,
      roster_state text,
      lease_started_at timestamptz,
      lease_until timestamptz,
      collection_id text,
      checked_count smallint,
      excluded_ad_count integer,
      duration_ms integer,
      error_code text,
      quarantine_until timestamptz,
      details jsonb not null default '{}'::jsonb
    );

    create table public.naver_shopping_repair_priority_requests (
      request_id uuid primary key,
      requested_at timestamptz not null default clock_timestamp()
    );

    create table public.naver_shopping_repair_priority_items (
      request_id uuid not null references public.naver_shopping_repair_priority_requests(request_id),
      position integer not null,
      tracker_id uuid not null,
      state text not null,
      claimed_lease_started_at timestamptz,
      primary key (request_id, position)
    );

    create function public.mi_request_naver_shopping_worker_wake(p_reason text)
    returns boolean language sql security invoker set search_path = '' as $$
      select true
    $$;

    create function public.mi_enqueue_naver_shopping_repair_priority(
      p_request_id uuid, p_tracker_ids uuid[], p_reason text
    ) returns jsonb language sql security invoker set search_path = '' as $$
      select jsonb_build_object('accepted', true, 'legacy', true)
    $$;

    create function public.mi_claim_naver_shopping_repair_priority(
      p_worker_id text, p_lane_token uuid, p_run_id uuid,
      p_lease_seconds integer default 2100
    ) returns jsonb language plpgsql security invoker set search_path = '' as $$
    begin
      update public.test_transport_calls
      set call_count = call_count + 1 where transport = 'legacy_repair';
      return jsonb_build_object(
        'status', 'empty', 'priority', 'repair', 'claims', '[]'::jsonb,
        'legacy', true
      );
    end;
    $$;

    create function public.mi_queue_naver_shopping_cycle()
    returns jsonb language plpgsql security invoker set search_path = '' as $$
    declare
      current_row public.naver_shopping_worker_coordination%rowtype;
      next_cycle_id uuid := gen_random_uuid();
      started boolean := false;
      total_count integer := 0;
    begin
      update public.test_transport_calls
      set call_count = call_count + 1 where transport = 'queue';
      select * into current_row
      from public.naver_shopping_worker_coordination
      where lane_key = 'global'
      for update;
      select count(*)::integer into total_count
      from public.naver_rank_trackers where status = 'active';
      if current_row.scheduler_cycle_status = 'completed' then
        started := true;
        update public.naver_shopping_worker_coordination
        set scheduler_cycle_id = next_cycle_id,
            scheduler_cycle_number = scheduler_cycle_number + 1,
            scheduler_cycle_status = 'active',
            scheduler_cycle_started_at = clock_timestamp(),
            scheduler_cycle_completed_at = null,
            scheduler_cycle_cursor_sort_order = null,
            scheduler_cycle_cursor_created_at = null,
            scheduler_cycle_cursor_tracker_id = null,
            scheduler_cycle_resume_cursor = false,
            updated_at = clock_timestamp()
        where lane_key = 'global'
        returning * into current_row;
        insert into public.naver_shopping_scheduler_events(
          event_type, cycle_id, cycle_number, tracker_id, agency_code, roster_state
        )
        select 'cycle_rostered', next_cycle_id,
               current_row.scheduler_cycle_number,
               tracker.id, tracker.agency_code,
               case when tracker.worker_quarantined_until > clock_timestamp()
                 then 'quarantined' else 'eligible' end
        from public.naver_rank_trackers as tracker
        where tracker.status = 'active'
          and not exists (
            select 1 from public.test_unrostered_trackers as skipped
            where skipped.tracker_id = tracker.id
          );
      end if;
      return jsonb_build_object(
        'status', 'active', 'cycleId', current_row.scheduler_cycle_id,
        'cycleStartedAt', current_row.scheduler_cycle_started_at,
        'started', started, 'total', total_count,
        'remaining', total_count, 'processing', 0
      );
    end;
    $$;

    create function public.mi_claim_naver_shopping_cycle_keyword(
      p_worker_id text, p_lane_token uuid, p_run_id uuid,
      p_lease_seconds integer default 2100, p_probe_tracker_id uuid default null
    ) returns jsonb language plpgsql security invoker set search_path = '' as $$
    begin
      update public.test_transport_calls
      set call_count = call_count + 1 where transport = 'cycle';
      return jsonb_build_object(
        'status', 'no_cycle', 'cycleId', null, 'claims', '[]'::jsonb,
        'deferredCount', 0, 'groupSize', 0
      );
    end;
    $$;

    create function public.mi_claim_naver_shopping_rank_lookup_job(
      p_lease_seconds integer default 2100
    ) returns table (
      id uuid, keyword text, lease_started_at timestamptz, lease_until timestamptz
    ) language plpgsql security invoker set search_path = '' as $$
    begin
      update public.test_transport_calls
      set call_count = call_count + 1 where transport = 'lookup';
      return;
    end;
    $$;

    create function public.mi_claim_naver_shopping_worker_wake()
    returns boolean language plpgsql security invoker set search_path = '' as $$
    begin
      update public.test_transport_calls
      set call_count = call_count + 1 where transport = 'wake';
      return false;
    end;
    $$;

    insert into public.naver_shopping_worker_coordination(
      lane_key, primary_worker_id, primary_seen_at,
      runtime_version, runtime_fingerprint, scheduler_cycle_id,
      scheduler_cycle_number, scheduler_cycle_status, scheduler_cycle_started_at
    ) values (
      'global', 'windows-desktop-primary', clock_timestamp(),
      '${runtimeVersion}', '${runtimeFingerprint}', '${ids.cycle}',
      47, 'active', clock_timestamp() - interval '1 hour'
    );

    insert into public.naver_rank_trackers(
      id, agency_code, keyword, sort_order, created_at, last_checked_at
    ) values
      ('${ids.otherHead}', 'other-a01', '선두 키워드', 1, '2025-01-01', '2026-08-01'),
      ('${ids.otherCursor}', 'other-a01', '커서 키워드', 5, '2025-01-02', '2026-08-01'),
      ('${ids.mmlA}', 'mml93-a01', '엠 키워드 가', 20, '2026-01-01', '2026-08-01'),
      ('${ids.mmlB}', 'mml93-a01', '엠 키워드 나', 30, '2026-01-02', '2026-08-01'),
      ('${ids.mmlGone}', 'mml93-a01', '엠 키워드 다', 40, '2026-01-03', '2026-08-01'),
      ('${ids.mmlNew}', 'mml93-a01', '엠 키워드 라', 50, '2026-01-04', null),
      ('${ids.otherTail1}', 'other-a01', '후미 키워드 가', 100, '2025-02-01', '2026-08-01'),
      ('${ids.otherTail2}', 'other-a01', '후미 키워드 나', 200, '2025-02-02', '2026-08-01');

    -- The newest account tracker joined after the cycle snapshot: no roster row.
    insert into public.test_unrostered_trackers(tracker_id)
    values ('${ids.mmlNew}');

    insert into public.naver_shopping_scheduler_events(
      event_type, cycle_id, cycle_number, tracker_id, agency_code, roster_state
    )
    select
      'cycle_rostered', '${ids.cycle}', 47, tracker.id, tracker.agency_code,
      case when tracker.worker_quarantined_until > clock_timestamp()
        then 'quarantined' else 'eligible' end
    from public.naver_rank_trackers as tracker
    where not exists (
      select 1 from public.test_unrostered_trackers as skipped
      where skipped.tracker_id = tracker.id
    );

    create function public.test_account_claim_event()
    returns trigger language plpgsql security invoker set search_path = '' as $$
    declare
      current_row public.naver_shopping_worker_coordination%rowtype;
      v_claim_id uuid;
    begin
      select * into current_row
      from public.naver_shopping_worker_coordination
      where lane_key = 'global';
      v_claim_id := current_row.run_id;
      if new.processing_started_at is distinct from old.processing_started_at
        and new.worker_last_cycle_claimed_at is distinct from old.worker_last_cycle_claimed_at then
        insert into public.naver_shopping_scheduler_events(
          event_type, cycle_id, cycle_number, claim_id, run_id, worker_id,
          group_fingerprint, priority, lease_started_at, lease_until
        )
        select
          'group_claimed', current_row.scheduler_cycle_id,
          current_row.scheduler_cycle_number, v_claim_id, current_row.run_id,
          current_row.lease_worker_id, repeat('f', 64), 'normal',
          new.processing_started_at, new.processing_until
        where not exists (
          select 1
          from public.naver_shopping_scheduler_events as grouped
          where grouped.event_type = 'group_claimed'
            and grouped.run_id = current_row.run_id
            and grouped.lease_started_at = new.processing_started_at
        );
        insert into public.naver_shopping_scheduler_events(
          event_type, cycle_id, cycle_number, claim_id, run_id, worker_id,
          tracker_id, agency_code, group_fingerprint, priority,
          lease_started_at, lease_until
        ) values (
          'tracker_claimed', current_row.scheduler_cycle_id,
          current_row.scheduler_cycle_number, v_claim_id, current_row.run_id,
          current_row.lease_worker_id, new.id, new.agency_code,
          repeat('f', 64), 'normal', new.processing_started_at,
          new.processing_until
        );
      end if;
      return null;
    end;
    $$;
    create trigger trg_test_account_claim_event
    after update on public.naver_rank_trackers
    for each row execute function public.test_account_claim_event();

    create function public.test_cycle_completed_event()
    returns trigger language plpgsql security invoker set search_path = '' as $$
    begin
      if new.scheduler_cycle_status = 'completed'
        and new.scheduler_cycle_id is not null
        and (
          old.scheduler_cycle_id is distinct from new.scheduler_cycle_id
          or old.scheduler_cycle_status is distinct from 'completed'
        ) then
        insert into public.naver_shopping_scheduler_events(
          event_type, cycle_id, cycle_number
        ) values (
          'cycle_completed', new.scheduler_cycle_id, new.scheduler_cycle_number
        );
      end if;
      return null;
    end;
    $$;
    create trigger trg_test_cycle_completed_event
    after update on public.naver_shopping_worker_coordination
    for each row execute function public.test_cycle_completed_event();

    -- Mirrors the ordinary cohort selector of the installed cycle claim RPC:
    -- strictly after the cursor first, then the bounded wrap.
    create function public.test_next_ordinary_tracker()
    returns uuid language plpgsql security invoker set search_path = '' as $$
    declare
      current_row public.naver_shopping_worker_coordination%rowtype;
      seed public.naver_rank_trackers%rowtype;
      v_now timestamptz := clock_timestamp();
    begin
      select * into current_row
      from public.naver_shopping_worker_coordination
      where lane_key = 'global';

      select * into seed
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
            and roster.roster_state is distinct from 'new_after_start'
        )
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null
          or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
        and (
          current_row.scheduler_cycle_cursor_tracker_id is null
          or (tracker.sort_order, tracker.created_at, tracker.id) >
             (current_row.scheduler_cycle_cursor_sort_order,
              current_row.scheduler_cycle_cursor_created_at,
              current_row.scheduler_cycle_cursor_tracker_id)
        )
      order by tracker.sort_order asc, tracker.created_at asc, tracker.id asc
      limit 1;
      if seed.id is not null then
        return seed.id;
      end if;

      select * into seed
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
            and roster.roster_state is distinct from 'new_after_start'
        )
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null
          or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
      order by tracker.sort_order asc, tracker.created_at asc, tracker.id asc
      limit 1;
      return seed.id;
    end;
    $$;
  `);

  await database.exec(executableBaseMigration());
  await database.exec(stripInstallOnly(handoffMigration));
  await database.exec(stripInstallOnly(triggerGateMigration));
  await database.exec(runtimeNeutralGateMigration);
  return database;
}

async function applyCohortMigration(database) {
  await database.exec(stripInstallOnly(cohortMigration));
}

async function enqueue(database, requestId = ids.request) {
  const cohort = (await database.query(`
    select count(*)::integer as cohort_count,
           md5(
             'mml93-a01:' || string_agg(
               format('%s|%s|%s', sort_order, extract(epoch from created_at), id),
               ',' order by sort_order, created_at, id
             )
           ) as cohort_hash
    from public.naver_rank_trackers
    where status = 'active' and lower(btrim(agency_code)) = 'mml93-a01'
  `)).rows[0];
  return (await database.query(`
    select public.mi_enqueue_naver_shopping_account_priority(
      $1::uuid, 'mml93-a01', $2::integer, $3::text, $4::text, $5::text
    ) as result
  `, [
    requestId,
    cohort.cohort_count,
    cohort.cohort_hash,
    runtimeVersion,
    runtimeFingerprint,
  ])).rows[0].result;
}

async function startRun(database, runId) {
  await database.query(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = 'windows-desktop-primary',
        lease_token = $2::uuid,
        lease_until = clock_timestamp() + interval '10 minutes',
        run_id = $1::uuid,
        current_stage = 'claiming',
        current_page = 0,
        current_job_kind = null,
        current_tracker_id = null
    where lane_key = 'global'
  `, [runId, ids.lane]);
}

async function releaseLane(database) {
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = null, lease_token = null, lease_until = null,
        run_id = null, current_stage = null, current_page = 0,
        current_job_kind = null, current_tracker_id = null
    where lane_key = 'global'
  `);
}

async function claim(database, runId, runTrigger = "rank-catch-up") {
  return (await database.query(`
    select public.mi_claim_naver_shopping_repair_priority(
      'windows-desktop-primary', $1::uuid, $2::uuid, $3::text, 600
    ) as result
  `, [ids.lane, runId, runTrigger])).rows[0].result;
}

async function queue(database, runId, runTrigger = "rank-catch-up") {
  return (await database.query(`
    select public.mi_queue_naver_shopping_cycle(
      'windows-desktop-primary', $1::uuid, $2::uuid, $3::text
    ) as result
  `, [ids.lane, runId, runTrigger])).rows[0].result;
}

async function cycleClaim(database, runId, runTrigger = "rank-catch-up") {
  return (await database.query(`
    select public.mi_claim_naver_shopping_cycle_keyword(
      'windows-desktop-primary', $1::uuid, $2::uuid, $3::text, 600, null
    ) as result
  `, [ids.lane, runId, runTrigger])).rows[0].result;
}

async function recordNavigatingRun(database, runId) {
  await database.query(`
    insert into public.naver_shopping_worker_runs(
      run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint
    ) values ($1::uuid, 'windows-desktop-primary', 'rank-catch-up', $2, $3)
  `, [runId, runtimeVersion, runtimeFingerprint]);
}

async function terminal(database, trackerId, eventType = "tracker_committed") {
  await database.query(`
    insert into public.naver_shopping_scheduler_events(
      event_type, cycle_id, cycle_number, claim_id, run_id, worker_id,
      tracker_id, agency_code, priority, lease_started_at, lease_until
    )
    select
      $2, member.claimed_cycle_id, member.claimed_cycle_number,
      member.claim_id, member.claimed_run_id, member.claimed_worker_id,
      member.tracker_id, 'mml93-a01', 'normal',
      member.claimed_lease_started_at, member.claimed_lease_until
    from public.naver_shopping_account_priority_members as member
    where member.request_id = $1::uuid
      and member.tracker_id = $3::uuid
  `, [ids.request, eventType, trackerId]);
  await database.query(`
    update public.naver_rank_trackers
    set processing_started_at = null, processing_until = null
    where id = $1::uuid
  `, [trackerId]);
}

async function collectMember(database, runId, trackerId) {
  await startRun(database, runId);
  const claimed = await claim(database, runId);
  assert.equal(claimed.status, "claimed", `claim for ${trackerId}`);
  assert.deepEqual(claimed.claims.map((entry) => entry.trackerId), [trackerId]);
  await recordNavigatingRun(database, runId);
  await terminal(database, trackerId);
  await releaseLane(database);
  return claimed;
}

async function members(database, requestId = ids.request) {
  return (await database.query(`
    select member.tracker_id::text as tracker_id, member.state,
           member.release_reason
    from public.naver_shopping_account_priority_members as member
    where member.request_id = $1::uuid
    order by member.position
  `, [requestId])).rows;
}

async function request(database, requestId = ids.request) {
  return (await database.query(`
    select state, completed_at is not null as completed,
           expired_at is not null as expired, succeeded
    from public.naver_shopping_account_priority_requests
    where request_id = $1::uuid
  `, [requestId])).rows[0];
}

async function coordination(database) {
  return (await database.query(`
    select scheduler_cycle_id::text as cycle_id,
           scheduler_cycle_number as cycle_number,
           scheduler_cycle_status as cycle_status,
           scheduler_cycle_cursor_sort_order as cursor_sort_order,
           scheduler_cycle_cursor_tracker_id::text as cursor_tracker_id,
           scheduler_cycle_resume_cursor as resume_cursor
    from public.naver_shopping_worker_coordination
    where lane_key = 'global'
  `)).rows[0];
}

async function resumePoints(database) {
  return (await database.query(`
    select handoff_cycle_id::text as handoff_cycle_id,
           handoff_cycle_number as handoff_cycle_number,
           cursor_sort_order, cursor_tracker_id::text as cursor_tracker_id,
           resume_cursor, resolution,
           restored_cycle_id::text as restored_cycle_id,
           restored_cycle_number as restored_cycle_number
    from public.naver_shopping_account_priority_cycle_resume_points
    order by handoff_cycle_number
  `)).rows;
}

async function transportCalls(database) {
  return Object.fromEntries((await database.query(`
    select transport, call_count from public.test_transport_calls
  `)).rows.map((row) => [row.transport, row.call_count]));
}

async function nextOrdinaryTracker(database) {
  return (await database.query(`
    select public.test_next_ordinary_tracker()::text as tracker_id
  `)).rows[0].tracker_id;
}

test("정적 계약: 새 마이그레이션에 런타임 버전·지문 리터럴이 없다", () => {
  assert.doesNotMatch(cohortMigration, /[0-9]+\.[0-9]+\.[0-9]+/u);
  assert.doesNotMatch(cohortMigration, /[a-f0-9]{64}/u);
  assert.doesNotMatch(cohortMigration, /required_runtime_version\s*=\s*'/u);
  // 런타임 아이덴티티는 "등록되어 있는가"로만 확인한다.
  assert.match(cohortMigration, /current_row\.runtime_version is null/u);
  assert.match(cohortMigration, /current_row\.runtime_fingerprint is null/u);
});

test("정적 계약: 신규 테이블·RPC 는 service_role 전용이고 search_path 가 고정이다", () => {
  assert.match(
    cohortMigration,
    /create table public\.naver_shopping_account_priority_cycle_resume_points/u,
  );
  assert.match(cohortMigration, /force row level security/u);
  assert.match(
    cohortMigration,
    /revoke all on table public\.naver_shopping_account_priority_cycle_resume_points\nfrom public, anon, authenticated, service_role;/u,
  );
  assert.match(
    cohortMigration,
    /create or replace function public\.mi_cancel_naver_shopping_account_priority\(/u,
  );
  assert.match(
    cohortMigration,
    /grant execute on function public\.mi_cancel_naver_shopping_account_priority\(uuid\)\nto service_role;/u,
  );
  assert.doesNotMatch(
    cohortMigration,
    /grant execute on function public\.mi_cancel_naver_shopping_account_priority\(uuid\)\nto (?:public|anon|authenticated)/u,
  );
  for (const block of cohortMigration.matchAll(/language plpgsql\n([\s\S]{0,120})/gu)) {
    assert.match(block[1], /security invoker[\s\S]*?set search_path = ''/u);
  }
});

test("설치 가드는 런타임 값과 무관하게 통과하고 미등록 런타임만 거부한다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.exec(
    cohortMigration.replace(/set local lock_timeout = '5s';\s*/giu, ""),
  );
  assert.equal(
    (await database.query(`
      select count(*)::integer as count
      from pg_catalog.pg_proc
      where proname = 'mi_cancel_naver_shopping_account_priority'
    `)).rows[0].count,
    1,
  );

  const fresh = await createDatabase();
  t.after(() => fresh.close());
  await fresh.exec(`
    update public.naver_shopping_worker_coordination
    set runtime_version = null, runtime_fingerprint = null
    where lane_key = 'global'
  `);
  await assert.rejects(
    () => fresh.exec(cohortMigration.replace(/set local lock_timeout = '5s';\s*/giu, "")),
    /requires_registered_runtime/u,
  );
});

test("① 삭제된·미로스터 멤버가 섞여도 요청이 진행되고 종료된다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  await enqueue(database);

  // 코호트 동결 뒤 추적기 한 건이 삭제된다.
  await database.query(`delete from public.naver_rank_trackers where id = $1::uuid`, [ids.mmlGone]);

  await collectMember(database, ids.run1, ids.mmlA);
  assert.deepEqual(await members(database), [
    { tracker_id: ids.mmlA, state: "claimed", release_reason: null },
    { tracker_id: ids.mmlB, state: "pending", release_reason: null },
    {
      tracker_id: ids.mmlGone,
      state: "expired",
      release_reason: "account_priority_tracker_missing",
    },
    { tracker_id: ids.mmlNew, state: "pending", release_reason: null },
  ]);

  await collectMember(database, ids.run2, ids.mmlB);

  // 남은 pending 은 미로스터 멤버뿐이다. 핸드오프가 막히지 않아야 한다.
  await startRun(database, ids.run3);
  const handoff = await claim(database, ids.run3);
  assert.deepEqual(handoff, {
    status: "waiting",
    priority: "repair",
    claims: [],
    accountPriority: true,
    reason: "account_cycle_handoff",
    cycleId: ids.cycle,
  });
  assert.equal((await coordination(database)).cycle_status, "completed");

  // 다음 자연 사이클이 미로스터 멤버를 로스터하고 수집한다.
  await database.query(`delete from public.test_unrostered_trackers`);
  const queued = await queue(database, ids.run3);
  assert.equal(queued.started, true);
  await releaseLane(database);
  await collectMember(database, ids.run4, ids.mmlNew);

  await startRun(database, ids.run5);
  const afterAll = await claim(database, ids.run5);
  assert.equal(afterAll.status, "empty");
  assert.equal(afterAll.reason, "account_priority_reconciled");
  assert.deepEqual(await request(database), {
    state: "completed",
    completed: true,
    expired: false,
    succeeded: false,
  });
  assert.equal(
    (await claim(database, ids.run5)).legacy,
    true,
    "요청이 끝난 뒤 다음 호출은 일반 레인으로 위임된다",
  );
  assert.deepEqual((await members(database)).map((row) => row.state), [
    "terminal_success",
    "terminal_success",
    "expired",
    "terminal_success",
  ]);
});

test("① 다음 사이클에서도 미로스터인 멤버는 해제되어 요청이 끝난다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  await enqueue(database);
  await database.query(`delete from public.naver_rank_trackers where id = $1::uuid`, [ids.mmlGone]);
  await collectMember(database, ids.run1, ids.mmlA);
  await collectMember(database, ids.run2, ids.mmlB);

  await startRun(database, ids.run3);
  assert.equal((await claim(database, ids.run3)).reason, "account_cycle_handoff");

  // 새 사이클에서도 로스터되지 않는다.
  const queued = await queue(database, ids.run3);
  assert.equal(queued.started, true);
  await releaseLane(database);

  await startRun(database, ids.run4);
  const released = await claim(database, ids.run4);
  assert.equal(released.reason, "account_priority_reconciled");
  assert.equal((await claim(database, ids.run4)).legacy, true);
  assert.deepEqual(await members(database), [
    { tracker_id: ids.mmlA, state: "terminal_success", release_reason: null },
    { tracker_id: ids.mmlB, state: "terminal_success", release_reason: null },
    {
      tracker_id: ids.mmlGone,
      state: "expired",
      release_reason: "account_priority_tracker_missing",
    },
    {
      tracker_id: ids.mmlNew,
      state: "expired",
      release_reason: "account_priority_tracker_unrostered",
    },
  ]);
  assert.equal((await request(database)).state, "completed");
});

test("① status<>active·다른 계정으로 이동한 멤버도 해제된다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  await enqueue(database);
  await database.query(`
    update public.naver_rank_trackers set status = 'paused' where id = $1::uuid
  `, [ids.mmlB]);
  await database.query(`
    update public.naver_rank_trackers set agency_code = 'other-a01' where id = $1::uuid
  `, [ids.mmlGone]);

  await collectMember(database, ids.run1, ids.mmlA);
  assert.deepEqual(await members(database), [
    { tracker_id: ids.mmlA, state: "claimed", release_reason: null },
    {
      tracker_id: ids.mmlB,
      state: "expired",
      release_reason: "account_priority_tracker_inactive",
    },
    {
      tracker_id: ids.mmlGone,
      state: "expired",
      release_reason: "account_priority_tracker_agency_changed",
    },
    { tracker_id: ids.mmlNew, state: "pending", release_reason: null },
  ]);
});

test("② 취소 RPC 가 즉시 해제하고 다음 claim 이 정상 동작한다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  await database.exec(`
    delete from public.test_unrostered_trackers;
    insert into public.naver_shopping_scheduler_events(
      event_type, cycle_id, cycle_number, tracker_id, agency_code, roster_state
    )
    select 'cycle_rostered', '${ids.cycle}', 47, tracker.id, tracker.agency_code, 'eligible'
    from public.naver_rank_trackers as tracker
    where tracker.id = '${ids.mmlNew}';
  `);
  await enqueue(database);

  // 전원이 이번 사이클에서 이미 수집됐고 장기 격리라 아무도 자격을 얻지 못한다.
  await database.query(`
    update public.naver_rank_trackers
    set worker_last_cycle_id = $1::uuid,
        worker_quarantined_until = clock_timestamp() + interval '6 hours'
    where lower(btrim(agency_code)) = 'mml93-a01'
  `, [ids.cycle]);

  await startRun(database, ids.run1);
  const stuck = await claim(database, ids.run1);
  assert.equal(stuck.status, "waiting");
  assert.equal(stuck.reason, "account_members_not_yet_eligible");
  const blockedCycle = await cycleClaim(database, ids.run1);
  assert.equal(blockedCycle.reason, "account_priority_active");
  const callsWhileActive = await transportCalls(database);

  const cancelled = (await database.query(`
    select public.mi_cancel_naver_shopping_account_priority($1::uuid) as result
  `, [ids.request])).rows[0].result;
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.state, "completed");
  assert.equal(cancelled.releasedCount, 4);
  assert.equal(cancelled.claimedCount, 0);
  assert.equal(cancelled.laneReleased, true);

  assert.deepEqual((await members(database)).map((row) => row.release_reason), [
    "account_priority_cancelled",
    "account_priority_cancelled",
    "account_priority_cancelled",
    "account_priority_cancelled",
  ]);
  assert.deepEqual(await request(database), {
    state: "completed",
    completed: true,
    expired: false,
    succeeded: false,
  });

  // 취소 직후 같은 레인에서 일반 수집이 재개된다.
  const resumed = await cycleClaim(database, ids.run1);
  assert.equal(resumed.status, "no_cycle");
  assert.equal(resumed.reason, undefined);
  assert.equal(
    (await transportCalls(database)).cycle,
    callsWhileActive.cycle + 1,
  );
  const legacyRepair = await claim(database, ids.run1);
  assert.equal(legacyRepair.legacy, true);
  assert.equal((await coordination(database)).cycle_status, "active");
});

test("② 이미 완료된 요청 취소는 멱등하고, 없는 요청은 거부된다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  await enqueue(database);
  await database.query(`
    select public.mi_cancel_naver_shopping_account_priority($1::uuid)
  `, [ids.request]);
  const again = (await database.query(`
    select public.mi_cancel_naver_shopping_account_priority($1::uuid) as result
  `, [ids.request])).rows[0].result;
  assert.equal(again.cancelled, false);
  assert.equal(again.reason, "already_completed");
  await assert.rejects(
    () => database.query(`
      select public.mi_cancel_naver_shopping_account_priority($1::uuid)
    `, [ids.stalledRequest]),
    /cancel_unknown_request/u,
  );
});

test("③ 핸드오프 뒤 원래 커서부터 이어서 순회한다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);

  // 이번 사이클은 sort_order 50 까지 진행했고 후미(100·200)는 남아 있다.
  await database.exec(`
    delete from public.test_unrostered_trackers;
    insert into public.naver_shopping_scheduler_events(
      event_type, cycle_id, cycle_number, tracker_id, agency_code, roster_state
    )
    select 'cycle_rostered', '${ids.cycle}', 47, tracker.id, tracker.agency_code, 'eligible'
    from public.naver_rank_trackers as tracker
    where tracker.id = '${ids.mmlNew}';
    update public.naver_shopping_worker_coordination
    set scheduler_cycle_cursor_sort_order = 50,
        scheduler_cycle_cursor_created_at = '2026-01-04',
        scheduler_cycle_cursor_tracker_id = '${ids.mmlNew}',
        scheduler_cycle_resume_cursor = false
    where lane_key = 'global';
    update public.naver_rank_trackers
    set worker_last_cycle_id = '${ids.cycle}',
        worker_last_cycle_claimed_at = clock_timestamp() - interval '5 minutes'
    where sort_order <= 50;
  `);
  await enqueue(database);
  assert.equal(await nextOrdinaryTracker(database), ids.otherTail1);

  await startRun(database, ids.run1);
  const handoff = await claim(database, ids.run1);
  assert.equal(handoff.reason, "account_cycle_handoff");
  assert.deepEqual(await resumePoints(database), [{
    handoff_cycle_id: ids.cycle,
    handoff_cycle_number: 47,
    cursor_sort_order: 50,
    cursor_tracker_id: ids.mmlNew,
    resume_cursor: false,
    resolution: null,
    restored_cycle_id: null,
    restored_cycle_number: null,
  }]);

  const queued = await queue(database, ids.run1);
  assert.equal(queued.started, true);
  const after = await coordination(database);
  assert.equal(Number(after.cycle_number), 48);
  assert.equal(after.cursor_sort_order, 50);
  assert.equal(after.cursor_tracker_id, ids.mmlNew);
  assert.equal(after.resume_cursor, false);
  const points = await resumePoints(database);
  assert.equal(points[0].resolution, "restored");
  assert.equal(points[0].restored_cycle_id, after.cycle_id);
  assert.equal(Number(points[0].restored_cycle_number), 48);

  // 커서를 이어받았으므로 새 사이클의 첫 일반 대상은 건너뛴 후미 계정이다.
  assert.equal(await nextOrdinaryTracker(database), ids.otherTail1);
});

test("③ 커서 복원은 핸드오프 직후 한 사이클에만 적용된다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set scheduler_cycle_cursor_sort_order = 50,
        scheduler_cycle_cursor_created_at = '2026-01-04',
        scheduler_cycle_cursor_tracker_id = '${ids.mmlNew}',
        scheduler_cycle_status = 'completed'
    where lane_key = 'global';
    insert into public.naver_shopping_account_priority_requests(
      request_id, agency_code, cohort_count, cohort_hash,
      required_runtime_version, required_runtime_fingerprint,
      requested_at, expires_at, requested_cycle_id, requested_cycle_number,
      state, completed_at, succeeded
    ) values (
      '${ids.request}', 'mml93-a01', 1, repeat('a', 32),
      '${runtimeVersion}', '${runtimeFingerprint}',
      clock_timestamp() - interval '1 hour',
      clock_timestamp() - interval '1 hour' + interval '24 hours',
      '${ids.cycle}', 47, 'completed', clock_timestamp(), false
    );
    insert into public.naver_shopping_account_priority_cycle_resume_points(
      handoff_cycle_id, handoff_cycle_number, request_id,
      cursor_sort_order, cursor_created_at, cursor_tracker_id, resume_cursor,
      created_at
    ) values (
      '${ids.cycle}', 40, '${ids.request}', 5, '2025-01-02',
      '${ids.otherCursor}', false, clock_timestamp()
    );
  `);
  await startRun(database, ids.run1);
  const queued = await queue(database, ids.run1);
  assert.equal(queued.started, true);
  const after = await coordination(database);
  assert.equal(after.cursor_sort_order, null, "오래된 복원 지점은 건너뛴다");
  assert.equal((await resumePoints(database))[0].resolution, "skipped");
});

test("④ 회귀: 정상 코호트는 전원 처리되고 요청이 성공으로 닫힌다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  await database.exec(`delete from public.test_unrostered_trackers`);
  await database.exec(`
    insert into public.naver_shopping_scheduler_events(
      event_type, cycle_id, cycle_number, tracker_id, agency_code, roster_state
    )
    select 'cycle_rostered', '${ids.cycle}', 47, tracker.id, tracker.agency_code, 'eligible'
    from public.naver_rank_trackers as tracker
    where tracker.id = '${ids.mmlNew}'
  `);
  await enqueue(database);

  await collectMember(database, ids.run1, ids.mmlA);
  await collectMember(database, ids.run2, ids.mmlB);
  await collectMember(database, ids.run3, ids.mmlGone);
  await collectMember(database, ids.run4, ids.mmlNew);

  await startRun(database, ids.run5);
  const delegated = await claim(database, ids.run5);
  assert.equal(delegated.reason, "account_priority_reconciled");
  assert.equal((await claim(database, ids.run5)).legacy, true);
  assert.deepEqual(await request(database), {
    state: "completed",
    completed: true,
    expired: false,
    succeeded: true,
  });
  assert.deepEqual((await members(database)).map((row) => row.state), [
    "terminal_success",
    "terminal_success",
    "terminal_success",
    "terminal_success",
  ]);
  assert.deepEqual(await resumePoints(database), []);
  assert.equal((await coordination(database)).cycle_status, "active");
});

test("④ 회귀: 24h 만료 reconcile 은 그대로 pending 만 만료시킨다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  await database.exec(`
    insert into public.naver_shopping_account_priority_requests(
      request_id, agency_code, cohort_count, cohort_hash,
      required_runtime_version, required_runtime_fingerprint,
      requested_at, expires_at, requested_cycle_id, requested_cycle_number
    ) values (
      '${ids.request}', 'mml93-a01', 2, repeat('a', 32),
      '${runtimeVersion}', '${runtimeFingerprint}',
      clock_timestamp() - interval '25 hours',
      clock_timestamp() - interval '25 hours' + interval '24 hours',
      '${ids.cycle}', 47
    );
    insert into public.naver_shopping_account_priority_members(
      request_id, position, tracker_id
    ) values
      ('${ids.request}', 1, '${ids.mmlA}'),
      ('${ids.request}', 2, '${ids.mmlB}');
  `);
  await startRun(database, ids.run1);
  const result = await claim(database, ids.run1);
  assert.equal(result.reason, "account_priority_expiry_reconciled");
  assert.deepEqual(await request(database), {
    state: "completed",
    completed: true,
    expired: true,
    succeeded: false,
  });
  assert.deepEqual(await members(database), [
    { tracker_id: ids.mmlA, state: "expired", release_reason: null },
    { tracker_id: ids.mmlB, state: "expired", release_reason: null },
  ]);
});

test("정체된 요청은 24h 을 기다리지 않고 여섯 케이던스 뒤 레인을 돌려준다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  // 진행이 멈춘 지 3시간. 만료(24h)까지는 21시간이 남아 있다.
  await database.exec(`
    insert into public.naver_shopping_account_priority_requests(
      request_id, agency_code, cohort_count, cohort_hash,
      required_runtime_version, required_runtime_fingerprint,
      requested_at, expires_at, requested_cycle_id, requested_cycle_number
    ) values (
      '${ids.request}', 'mml93-a01', 2, repeat('a', 32),
      '${runtimeVersion}', '${runtimeFingerprint}',
      clock_timestamp() - interval '3 hours',
      clock_timestamp() - interval '3 hours' + interval '24 hours',
      '${ids.cycle}', 47
    );
    insert into public.naver_shopping_account_priority_members(
      request_id, position, tracker_id
    ) values
      ('${ids.request}', 1, '${ids.mmlA}'),
      ('${ids.request}', 2, '${ids.mmlB}');
    update public.naver_rank_trackers
    set worker_last_cycle_id = '${ids.cycle}',
        worker_quarantined_until = clock_timestamp() + interval '12 hours'
    where lower(btrim(agency_code)) = 'mml93-a01';
  `);
  await startRun(database, ids.run1);
  const result = await claim(database, ids.run1);
  assert.equal(result.reason, "account_priority_reconciled");
  assert.equal(
    (await claim(database, ids.run1)).legacy,
    true,
    "정체 해제 뒤 다음 호출이 일반 레인으로 간다",
  );
  assert.deepEqual(await request(database), {
    state: "completed",
    completed: true,
    expired: false,
    succeeded: false,
  });
  assert.deepEqual((await members(database)).map((row) => row.release_reason), [
    "account_priority_request_stalled",
    "account_priority_request_stalled",
  ]);
  assert.equal((await cycleClaim(database, ids.run1)).status, "no_cycle");
});

test("정체 판정은 진행 중인 클레임을 잘라내지 않는다", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await applyCohortMigration(database);
  // 3시간 전에 시작했지만 클레임 하나가 아직 살아 있는 요청.
  await database.exec(`
    insert into public.naver_shopping_account_priority_requests(
      request_id, agency_code, cohort_count, cohort_hash,
      required_runtime_version, required_runtime_fingerprint,
      requested_at, expires_at, requested_cycle_id, requested_cycle_number
    ) values (
      '${ids.request}', 'mml93-a01', 2, repeat('a', 32),
      '${runtimeVersion}', '${runtimeFingerprint}',
      clock_timestamp() - interval '3 hours',
      clock_timestamp() - interval '3 hours' + interval '24 hours',
      '${ids.cycle}', 47
    );
    insert into public.naver_shopping_account_priority_members(
      request_id, position, tracker_id, state, claimed_at, claimed_cycle_id,
      claimed_cycle_number, claimed_run_id, claimed_worker_id,
      claimed_lease_started_at, claimed_lease_until, claim_event_id, claim_id
    ) values (
      '${ids.request}', 1, '${ids.mmlA}', 'claimed',
      clock_timestamp() - interval '3 hours', '${ids.cycle}', 47,
      '${ids.run1}', 'windows-desktop-primary',
      clock_timestamp() - interval '3 hours',
      clock_timestamp() + interval '20 minutes', 987654, gen_random_uuid()
    );
    insert into public.naver_shopping_account_priority_members(
      request_id, position, tracker_id
    ) values ('${ids.request}', 2, '${ids.mmlB}');
    update public.naver_rank_trackers
    set worker_quarantined_until = clock_timestamp() + interval '12 hours',
        worker_last_cycle_id = '${ids.cycle}'
    where id = '${ids.mmlB}';
  `);
  await startRun(database, ids.run2);
  const next = await claim(database, ids.run2);
  assert.equal(next.accountPriority, true);
  assert.equal(next.reason, "account_members_not_yet_eligible");
  assert.notEqual(next.legacy, true);
  assert.deepEqual(await members(database), [
    { tracker_id: ids.mmlA, state: "claimed", release_reason: null },
    { tracker_id: ids.mmlB, state: "pending", release_reason: null },
  ]);
  assert.equal((await request(database)).state, "active");
});

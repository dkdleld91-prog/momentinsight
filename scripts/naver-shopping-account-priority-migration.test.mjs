import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationName = "20260831033617_naver_shopping_account_one_shot_priority.sql";
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", migrationName),
  "utf8",
);

const ids = Object.freeze({
  request: "10000000-0000-4000-8000-000000000001",
  request2: "10000000-0000-4000-8000-000000000002",
  cycle: "20000000-0000-4000-8000-000000000001",
  nextCycle: "20000000-0000-4000-8000-000000000002",
  lane: "30000000-0000-4000-8000-000000000001",
  run: "40000000-0000-4000-8000-000000000001",
  oldRun: "40000000-0000-4000-8000-000000000002",
  nextRun: "40000000-0000-4000-8000-000000000003",
  mmlA: "50000000-0000-4000-8000-000000000001",
  mmlB: "50000000-0000-4000-8000-000000000002",
  other: "50000000-0000-4000-8000-000000000003",
});

const runtimeVersion = "1.1.19";
const runtimeFingerprint = "631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e";

function executableMigration() {
  return migration
    .replace(/set local lock_timeout = '5s';\s*/iu, "")
    .replace(/lock table public\.naver_shopping_worker_coordination in access exclusive mode;\s*/iu, "")
    .replace(/do \$migration_guard\$[\s\S]*?\$migration_guard\$;\s*/iu, "");
}

async function createDatabase({ legacyQueued = false } = {}) {
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
      scheduler_cycle_cursor_sort_order integer,
      scheduler_cycle_cursor_created_at timestamptz,
      scheduler_cycle_cursor_tracker_id uuid,
      scheduler_cycle_resume_cursor boolean not null default false
    );

    create table public.naver_shopping_rank_lookup_jobs (
      id uuid primary key,
      status text,
      processing_until timestamptz
    );

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
      tracker_id uuid not null references public.naver_rank_trackers(id),
      state text not null,
      claimed_lease_started_at timestamptz,
      primary key (request_id, position)
    );

    create table public.test_wakes (
      wake_id bigint generated always as identity primary key,
      reason text not null
    );

    create function public.mi_request_naver_shopping_worker_wake(p_reason text)
    returns boolean language plpgsql security invoker set search_path = '' as $$
    begin
      insert into public.test_wakes(reason) values (p_reason);
      return true;
    end;
    $$;

    create function public.mi_enqueue_naver_shopping_repair_priority(
      p_request_id uuid, p_tracker_ids uuid[], p_reason text
    ) returns jsonb language sql security invoker set search_path = '' as $$
      select jsonb_build_object('accepted', true, 'legacy', true)
    $$;

    create function public.mi_claim_naver_shopping_repair_priority(
      p_worker_id text, p_lane_token uuid, p_run_id uuid,
      p_lease_seconds integer default 2100
    ) returns jsonb language sql security invoker set search_path = '' as $$
      select jsonb_build_object(
        'status', 'empty', 'priority', 'repair', 'claims', '[]'::jsonb,
        'legacy', true
      )
    $$;

    insert into public.naver_shopping_worker_coordination(
      lane_key, primary_worker_id, primary_seen_at,
      runtime_version, runtime_fingerprint, scheduler_cycle_id,
      scheduler_cycle_number, scheduler_cycle_status,
      scheduler_cycle_started_at, scheduler_cycle_cursor_sort_order,
      scheduler_cycle_cursor_created_at, scheduler_cycle_cursor_tracker_id,
      scheduler_cycle_resume_cursor
    ) values (
      'global', 'windows-desktop-primary', clock_timestamp(),
      '${runtimeVersion}', '${runtimeFingerprint}', '${ids.cycle}',
      47, 'active', clock_timestamp() - interval '1 hour', 777,
      '2026-08-01T00:00:00Z', '${ids.other}', true
    );

    insert into public.naver_rank_trackers(
      id, agency_code, keyword, sort_order, created_at, last_checked_at,
      worker_quarantined_until
    ) values
      ('${ids.mmlA}', 'mml93-a01', '같은 키워드', 20, '2026-01-02', '2026-08-01', null),
      ('${ids.mmlB}', 'mml93-a01', '격리 키워드', 10, '2026-01-01', '2026-08-01', clock_timestamp() + interval '1 hour'),
      ('${ids.other}', 'other-a01', '같은 키워드', 1, '2025-01-01', '2026-08-01', null);

    insert into public.naver_shopping_worker_runs(
      run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint
    ) values
      ('${ids.oldRun}', 'windows-desktop-primary', 'rank-catch-up', '1.1.18', repeat('a', 64));

    insert into public.naver_shopping_scheduler_events(
      event_type, cycle_id, cycle_number, claim_id, run_id, worker_id,
      tracker_id, agency_code, priority, lease_started_at, lease_until,
      error_code
    ) values (
      'job_failed', '${ids.cycle}', 47, gen_random_uuid(), '${ids.oldRun}',
      'windows-desktop-primary', '${ids.mmlA}', 'mml93-a01', 'normal',
      clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour',
      'naver_next_data_rank_drift'
    );

    insert into public.naver_shopping_scheduler_events(
      event_type, cycle_id, cycle_number, tracker_id, agency_code, roster_state
    )
    select
      'cycle_rostered', '${ids.cycle}', 47, tracker.id, tracker.agency_code,
      case when tracker.worker_quarantined_until > clock_timestamp()
        then 'quarantined' else 'eligible' end
    from public.naver_rank_trackers as tracker;
  `);

  if (legacyQueued) {
    await database.exec(`
      insert into public.naver_shopping_repair_priority_requests(request_id)
      values ('90000000-0000-4000-8000-000000000001');
      insert into public.naver_shopping_repair_priority_items(
        request_id, position, tracker_id, state
      ) values (
        '90000000-0000-4000-8000-000000000001', 1, '${ids.mmlA}', 'queued'
      );
    `);
  }

  await database.exec(`
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
  `);

  await database.exec(executableMigration());
  return database;
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
  const result = await database.query(`
    select public.mi_enqueue_naver_shopping_account_priority(
      $1::uuid, 'mml93-a01', $2::integer, $3::text, $4::text, $5::text
    ) as result
  `, [
    requestId,
    cohort.cohort_count,
    cohort.cohort_hash,
    runtimeVersion,
    runtimeFingerprint,
  ]);
  return result.rows[0].result;
}

async function registerClaimingLane(database, runId = ids.run) {
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

async function recordNavigatingRun(database, runId = ids.run, {
  runTrigger = "rank-catch-up",
  startedAt = null,
} = {}) {
  await database.query(`
    insert into public.naver_shopping_worker_runs(
      run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint,
      started_at
    ) values (
      $1::uuid, 'windows-desktop-primary', $4,
      $2, $3, coalesce($5::timestamptz, clock_timestamp())
    )
  `, [runId, runtimeVersion, runtimeFingerprint, runTrigger, startedAt]);
}

async function startRun(database, runId = ids.run) {
  await registerClaimingLane(database, runId);
}

async function claim(database, runId = ids.run) {
  const result = await database.query(`
    select public.mi_claim_naver_shopping_repair_priority(
      'windows-desktop-primary', $1::uuid, $2::uuid, 600
    ) as result
  `, [ids.lane, runId]);
  return result.rows[0].result;
}

async function terminal(
  database,
  trackerId,
  eventType,
  errorCode = null,
  occurredAt = null,
) {
  await database.query(`
    insert into public.naver_shopping_scheduler_events(
      occurred_at, event_type, cycle_id, cycle_number, claim_id, run_id, worker_id,
      tracker_id, agency_code, priority, lease_started_at, lease_until,
      error_code
    )
    select
      coalesce($5::timestamptz, clock_timestamp()),
      $2, member.claimed_cycle_id, member.claimed_cycle_number,
      member.claim_id, member.claimed_run_id, member.claimed_worker_id,
      member.tracker_id, 'mml93-a01', 'normal',
      member.claimed_lease_started_at, member.claimed_lease_until, $3
    from public.naver_shopping_account_priority_members as member
    where member.request_id = $1::uuid
      and member.tracker_id = $4::uuid
  `, [ids.request, eventType, errorCode, trackerId, occurredAt]);
  await database.query(`
    update public.naver_rank_trackers
    set processing_started_at = null, processing_until = null
    where id = $1::uuid
  `, [trackerId]);
}

test("static contract isolates one-shot account evidence and preserves scheduler state", () => {
  assert.match(migration, /create table public\.naver_shopping_account_priority_requests/iu);
  assert.match(migration, /create table public\.naver_shopping_account_priority_members/iu);
  assert.match(migration, /expires_at = requested_at \+ interval '24 hours'/iu);
  assert.match(migration, /force row level security/iu);
  assert.match(migration, /security invoker[\s\S]*?set search_path = ''/iu);
  assert.match(migration, /cursor_sort_order_before is not distinct from cursor_sort_order_after/iu);
  assert.match(migration, /event\.run_id = p_run_id[\s\S]*?event\.lease_started_at = v_now/iu);
  assert.match(migration, /run\.runtime_version = request\.required_runtime_version/iu);
  assert.match(migration, /blockedByAccountPriority/iu);
  assert.match(migration, /account_priority_terminal_missing/iu);
  assert.doesNotMatch(
    migration.match(/create table public\.naver_shopping_account_priority_members[\s\S]*?\);/iu)?.[0] || "",
    /lane_token|keyword|product|title|capture|on delete cascade|references public\.(?:naver_rank_trackers|naver_shopping_worker_runs|naver_shopping_scheduler_events)/iu,
  );
  assert.doesNotMatch(
    migration.match(/create table public\.naver_shopping_account_priority_requests[\s\S]*?\);/iu)?.[0] || "",
    /lane_token|keyword|product|title|capture|on delete cascade/iu,
  );
  assert.equal(
    (migration.match(/mi_request_naver_shopping_worker_wake\(\s*'account_priority_once'/giu) || []).length,
    0,
  );
  assert.doesNotMatch(
    migration.match(/create or replace function mi_internal\.mi_claim_naver_shopping_account_priority[\s\S]*?\n\$\$;/iu)?.[0] || "",
    /scheduler_cycle_cursor_(?:sort_order|created_at|tracker_id|resume_cursor)\s*=/iu,
  );
  const claimFunction = migration.match(
    /create or replace function mi_internal\.mi_claim_naver_shopping_account_priority[\s\S]*?\n\$\$;/iu,
  )?.[0] || "";
  assert.match(claimFunction, /current_row\.current_stage is distinct from 'claiming'/iu);
  assert.match(claimFunction, /event\.worker_id = pg_catalog\.lower\(pg_catalog\.btrim\(p_worker_id\)\)/iu);
  assert.doesNotMatch(claimFunction, /join public\.naver_shopping_worker_runs/iu);
  const reconcileFunction = migration.match(
    /create or replace function mi_internal\.mi_reconcile_naver_shopping_account_priority[\s\S]*?\n\$\$;/iu,
  )?.[0] || "";
  assert.match(reconcileFunction, /join public\.naver_shopping_worker_runs as run/iu);
  assert.match(reconcileFunction, /terminal\.run_id = member\.claimed_run_id/iu);
  assert.match(reconcileFunction, /terminal\.worker_id = member\.claimed_worker_id/iu);
  assert.match(reconcileFunction, /terminal\.lease_started_at = member\.claimed_lease_started_at/iu);
});

test("real worker sequence claims before navigating run exists, then reconciles exact terminal", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.query(`
    update public.naver_rank_trackers set status = 'paused' where id = $1::uuid
  `, [ids.mmlB]);
  await enqueue(database);
  await registerClaimingLane(database);

  assert.equal((await database.query(`
    select count(*)::integer as count
    from public.naver_shopping_worker_runs where run_id = $1::uuid
  `, [ids.run])).rows[0].count, 0);
  const claimed = await claim(database);
  assert.equal(claimed.status, "claimed");
  assert.deepEqual(claimed.claims.map((entry) => entry.trackerId), [ids.mmlA]);
  assert.equal((await database.query(`
    select count(*)::integer as count
    from public.naver_shopping_worker_runs where run_id = $1::uuid
  `, [ids.run])).rows[0].count, 0);

  await recordNavigatingRun(database);
  await terminal(database, ids.mmlA, "tracker_committed");
  const completed = await claim(database);
  assert.equal(completed.legacy, true);
  assert.deepEqual((await database.query(`
    select member.state, request.state as request_state, request.succeeded
    from public.naver_shopping_account_priority_members as member
    join public.naver_shopping_account_priority_requests as request using (request_id)
    where member.request_id = $1::uuid and member.tracker_id = $2::uuid
  `, [ids.request, ids.mmlA])).rows[0], {
    state: "terminal_success",
    request_state: "completed",
    succeeded: true,
  });
});

test("terminal without a navigating run closes as finite integrity failure at lease expiry", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.query(`
    update public.naver_rank_trackers set status = 'paused' where id = $1::uuid
  `, [ids.mmlB]);
  await enqueue(database);
  await registerClaimingLane(database);
  const claimed = await claim(database);
  assert.equal(claimed.status, "claimed");
  await terminal(database, ids.mmlA, "job_failed", "local_worker_coordination_unavailable");
  await database.query(`
    select mi_internal.mi_reconcile_naver_shopping_account_priority(
      member.claimed_lease_until + interval '1 second'
    )
    from public.naver_shopping_account_priority_members as member
    where member.request_id = $1::uuid and member.tracker_id = $2::uuid
  `, [ids.request, ids.mmlA]);
  assert.deepEqual((await database.query(`
    select member.state, member.terminal_code,
           request.state as request_state, request.succeeded
    from public.naver_shopping_account_priority_members as member
    join public.naver_shopping_account_priority_requests as request using (request_id)
    where member.request_id = $1::uuid and member.tracker_id = $2::uuid
  `, [ids.request, ids.mmlA])).rows[0], {
    state: "integrity_failure",
    terminal_code: "account_priority_run_provenance_invalid",
    request_state: "completed",
    succeeded: false,
  });
});

test("post-lease terminal is rejected instead of rescuing the expired claim", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.query(`
    update public.naver_rank_trackers set status = 'paused' where id = $1::uuid
  `, [ids.mmlB]);
  await enqueue(database);
  await registerClaimingLane(database);
  const claimed = await claim(database);
  assert.equal(claimed.status, "claimed");
  await recordNavigatingRun(database);
  const leaseUntil = (await database.query(`
    select claimed_lease_until
    from public.naver_shopping_account_priority_members
    where request_id = $1::uuid and tracker_id = $2::uuid
  `, [ids.request, ids.mmlA])).rows[0].claimed_lease_until;
  const lateTerminalAt = new Date(leaseUntil.getTime() + 1_000);
  await terminal(database, ids.mmlA, "tracker_committed", null, lateTerminalAt);
  await database.query(`
    select mi_internal.mi_reconcile_naver_shopping_account_priority($1::timestamptz)
  `, [new Date(leaseUntil.getTime() + 2_000)]);
  assert.deepEqual((await database.query(`
    select member.state, member.terminal_code,
           request.state as request_state, request.succeeded
    from public.naver_shopping_account_priority_members as member
    join public.naver_shopping_account_priority_requests as request using (request_id)
    where member.request_id = $1::uuid and member.tracker_id = $2::uuid
  `, [ids.request, ids.mmlA])).rows[0], {
    state: "integrity_failure",
    terminal_code: "account_priority_terminal_after_lease",
    request_state: "completed",
    succeeded: false,
  });
});

test("wrong trigger or run timing cannot satisfy navigating provenance", async (t) => {
  const scenarios = [
    {
      name: "wrong trigger",
      beforeClaim: false,
      runOptions: { runTrigger: "rank-remote" },
    },
    {
      name: "run before claim",
      beforeClaim: true,
      runOptions: { startedAt: "2026-01-01T00:00:00Z" },
    },
    {
      name: "run after terminal",
      beforeClaim: false,
      terminalFirst: true,
      runOptions: { startedAt: "2099-01-01T00:00:00Z" },
    },
  ];
  for (const scenario of scenarios) {
    const database = await createDatabase();
    t.after(() => database.close());
    await database.query(`
      update public.naver_rank_trackers set status = 'paused' where id = $1::uuid
    `, [ids.mmlB]);
    await enqueue(database);
    await registerClaimingLane(database);
    if (scenario.beforeClaim) {
      await recordNavigatingRun(database, ids.run, scenario.runOptions);
    }
    const claimed = await claim(database);
    assert.equal(claimed.status, "claimed", scenario.name);
    if (scenario.terminalFirst) {
      await terminal(database, ids.mmlA, "tracker_committed");
      await recordNavigatingRun(database, ids.run, scenario.runOptions);
    } else {
      if (!scenario.beforeClaim) {
        await recordNavigatingRun(database, ids.run, scenario.runOptions);
      }
      await terminal(database, ids.mmlA, "tracker_committed");
    }
    await database.query(`
      select mi_internal.mi_reconcile_naver_shopping_account_priority(
        member.claimed_lease_until + interval '1 second'
      )
      from public.naver_shopping_account_priority_members as member
      where member.request_id = $1::uuid and member.tracker_id = $2::uuid
    `, [ids.request, ids.mmlA]);
    assert.deepEqual((await database.query(`
      select member.state, member.terminal_code,
             request.state as request_state, request.succeeded
      from public.naver_shopping_account_priority_members as member
      join public.naver_shopping_account_priority_requests as request using (request_id)
      where member.request_id = $1::uuid and member.tracker_id = $2::uuid
    `, [ids.request, ids.mmlA])).rows[0], {
      state: "integrity_failure",
      terminal_code: "account_priority_run_provenance_invalid",
      request_state: "completed",
      succeeded: false,
    }, scenario.name);
  }
});

test("exact cohort claim excludes another agency, old runtime evidence, and preserves cursor", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());

  const accepted = await enqueue(database);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.idempotent, false);
  assert.equal(accepted.cohortCount, 2);
  assert.equal(accepted.wakeRequested, false);
  assert.equal((await enqueue(database)).idempotent, true);
  await assert.rejects(
    () => database.query(`
      select public.mi_enqueue_naver_shopping_account_priority(
        $1::uuid, 'mml93-a01', 1, $2::text, $3::text, $4::text
      )
    `, [ids.request, accepted.cohortHash, runtimeVersion, runtimeFingerprint]),
    /naver_shopping_account_priority_request_conflict/iu,
  );
  assert.equal((await database.query("select count(*)::integer as count from public.test_wakes")).rows[0].count, 0);

  await startRun(database);
  const first = await claim(database);
  assert.equal(first.status, "claimed");
  assert.equal(first.accountPriority, true);
  assert.deepEqual(first.claims.map((entry) => entry.trackerId), [ids.mmlA]);
  await recordNavigatingRun(database);

  const evidence = await database.query(`
    select member.state, member.claimed_run_id::text as run_id,
           member.claim_event_id, member.cursor_sort_order_before,
           member.cursor_sort_order_after, member.cursor_tracker_id_before::text,
           member.cursor_tracker_id_after::text,
           event.occurred_at >= request.requested_at as after_request,
           run.runtime_version
    from public.naver_shopping_account_priority_members as member
    join public.naver_shopping_account_priority_requests as request using (request_id)
    join public.naver_shopping_scheduler_events as event
      on event.event_id = member.claim_event_id
    join public.naver_shopping_worker_runs as run
      on run.run_id = member.claimed_run_id
    where member.request_id = $1::uuid and member.tracker_id = $2::uuid
  `, [ids.request, ids.mmlA]);
  assert.deepEqual(evidence.rows[0], {
    state: "claimed",
    run_id: ids.run,
    claim_event_id: evidence.rows[0].claim_event_id,
    cursor_sort_order_before: 777,
    cursor_sort_order_after: 777,
    cursor_tracker_id_before: ids.other,
    cursor_tracker_id_after: ids.other,
    after_request: true,
    runtime_version: runtimeVersion,
  });

  const cohort = await database.query(`
    select tracker.agency_code, count(*)::integer as count
    from public.naver_shopping_account_priority_members as member
    join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
    group by tracker.agency_code
  `);
  assert.deepEqual(cohort.rows, [{ agency_code: "mml93-a01", count: 2 }]);
});

test("same-request same-agency normalized keyword members share one claim group only", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.query(`
    update public.naver_rank_trackers
    set keyword = ' 같 은 키 워 드 ', worker_quarantined_until = null
    where id = $1::uuid
  `, [ids.mmlA]);
  await database.query(`
    update public.naver_rank_trackers
    set keyword = '같은키워드'
    where id = $1::uuid
  `, [ids.mmlB]);
  const clearedQuarantine = await database.query(`
    update public.naver_rank_trackers
    set worker_quarantined_until = null
    where id = $1::uuid
    returning worker_quarantined_until
  `, [ids.mmlB]);
  assert.deepEqual(clearedQuarantine.rows, [{ worker_quarantined_until: null }]);
  await enqueue(database);
  await startRun(database);

  const groupedPrecondition = await database.query(`
    select member.position, tracker.id::text as tracker_id,
           regexp_replace(lower(btrim(tracker.keyword)), '\\s+', '', 'g') as keyword_key,
           tracker.worker_quarantined_until,
           roster.roster_state
    from public.naver_shopping_account_priority_members as member
    join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
    join public.naver_shopping_worker_coordination as coordination
      on coordination.lane_key = 'global'
    join public.naver_shopping_scheduler_events as roster
      on roster.event_type = 'cycle_rostered'
     and roster.cycle_id = coordination.scheduler_cycle_id
     and roster.tracker_id = tracker.id
    where member.request_id = $1::uuid
    order by member.position
  `, [ids.request]);
  assert.deepEqual(groupedPrecondition.rows.map((row) => ({
    position: row.position,
    tracker_id: row.tracker_id,
    keyword_key: row.keyword_key,
  })), [
    { position: 1, tracker_id: ids.mmlB, keyword_key: "같은키워드" },
    { position: 2, tracker_id: ids.mmlA, keyword_key: "같은키워드" },
  ]);
  const eligibleGroup = await database.query(`
    select tracker.id::text as tracker_id
    from public.naver_shopping_account_priority_members as member
    join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
    join public.naver_shopping_worker_coordination as coordination
      on coordination.lane_key = 'global'
    where member.request_id = $1::uuid
      and member.state = 'pending'
      and tracker.status = 'active'
      and lower(btrim(tracker.agency_code)) = 'mml93-a01'
      and regexp_replace(lower(btrim(tracker.keyword)), '\\s+', '', 'g') = '같은키워드'
      and tracker.worker_last_cycle_id is distinct from coordination.scheduler_cycle_id
      and (tracker.worker_quarantined_until is null
        or tracker.worker_quarantined_until <= clock_timestamp())
      and (tracker.processing_until is null or tracker.processing_until <= clock_timestamp())
      and exists (
        select 1 from public.naver_shopping_scheduler_events as roster
        where roster.event_type = 'cycle_rostered'
          and roster.cycle_id = coordination.scheduler_cycle_id
          and roster.tracker_id = tracker.id
          and roster.roster_state is distinct from 'new_after_start'
      )
    order by member.position
  `, [ids.request]);
  assert.deepEqual(
    eligibleGroup.rows.map((row) => row.tracker_id),
    [ids.mmlB, ids.mmlA],
    JSON.stringify(groupedPrecondition.rows),
  );

  const grouped = await claim(database);
  assert.equal(grouped.accountPriority, true);
  await recordNavigatingRun(database);
  const groupedPostcondition = await database.query(`
    select member.position, member.state, tracker.id::text as tracker_id,
           tracker.worker_last_cycle_id::text,
           tracker.processing_started_at,
           tracker.processing_until,
           regexp_replace(lower(btrim(tracker.keyword)), '\\s+', '', 'g') as keyword_key
    from public.naver_shopping_account_priority_members as member
    join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
    where member.request_id = $1::uuid
    order by member.position
  `, [ids.request]);
  assert.deepEqual(
    grouped.claims.map((entry) => entry.trackerId).sort(),
    [ids.mmlA, ids.mmlB].sort(),
    JSON.stringify(groupedPostcondition.rows),
  );
  const claimIds = await database.query(`
    with member_claims as (
      select claimed.claim_id, member.claim_event_id
      from public.naver_shopping_scheduler_events as claimed
      join public.naver_shopping_account_priority_members as member
        on member.claim_event_id = claimed.event_id
      where member.request_id = $1::uuid and member.state = 'claimed'
    ), summary as (
      select count(distinct claim_id)::integer as claim_ids,
             count(*)::integer as claim_events,
             (array_agg(claim_id order by claim_event_id))[1] as claim_id,
             min(claim_event_id) as first_member_event_id
      from member_claims
    )
    select summary.claim_ids, summary.claim_events,
           count(grouped.event_id)::integer as group_events,
           bool_and(grouped.event_id < summary.first_member_event_id)
             as group_before_members
    from summary
    join public.naver_shopping_scheduler_events as grouped
      on grouped.event_type = 'group_claimed'
     and grouped.claim_id = summary.claim_id
    group by summary.claim_ids, summary.claim_events,
             summary.first_member_event_id
  `, [ids.request]);
  assert.deepEqual(claimIds.rows[0], {
    claim_ids: 1,
    claim_events: 2,
    group_events: 1,
    group_before_members: true,
  });
  const other = (await database.query(`
    select processing_started_at, processing_until, worker_last_cycle_id,
           worker_last_cycle_deferred_at, last_message,
           (select count(*)::integer
            from public.naver_shopping_scheduler_events as event
            where event.tracker_id = tracker.id
              and event.event_type = 'tracker_claimed'
              and event.occurred_at >= (
                select requested_at
                from public.naver_shopping_account_priority_requests
                where request_id = $1::uuid
              )) as claim_event_count
    from public.naver_rank_trackers as tracker where tracker.id = $2::uuid
  `, [ids.request, ids.other])).rows[0];
  assert.equal(other.processing_started_at, null);
  assert.equal(other.processing_until, null);
  assert.equal(other.worker_last_cycle_id, null);
  assert.equal(other.worker_last_cycle_deferred_at, null);
  assert.equal(other.last_message, null);
  assert.equal(other.claim_event_count, 0);
});

test("already-processed and new-after-start members wait unchanged for the next natural cycle", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.query(`
    update public.naver_rank_trackers
    set worker_last_cycle_id = $1::uuid,
        worker_last_cycle_claimed_at = clock_timestamp() - interval '2 minutes',
        worker_last_cycle_deferred_at = clock_timestamp() - interval '1 minute'
    where id = $2::uuid
  `, [ids.cycle, ids.mmlA]);
  await database.query(`
    update public.naver_shopping_scheduler_events
    set roster_state = 'new_after_start'
    where event_type = 'cycle_rostered'
      and cycle_id = $1::uuid and tracker_id = $2::uuid
  `, [ids.cycle, ids.mmlB]);
  await enqueue(database);
  await startRun(database);

  const before = (await database.query(`
    select jsonb_build_object(
      'cursorSort', coordination.scheduler_cycle_cursor_sort_order,
      'cursorCreated', coordination.scheduler_cycle_cursor_created_at,
      'cursorTracker', coordination.scheduler_cycle_cursor_tracker_id,
      'cursorResume', coordination.scheduler_cycle_resume_cursor,
      'aCycle', a.worker_last_cycle_id,
      'aClaimed', a.worker_last_cycle_claimed_at,
      'aDeferred', a.worker_last_cycle_deferred_at,
      'bQuarantine', b.worker_quarantined_until,
      'bCycle', b.worker_last_cycle_id
    ) as state
    from public.naver_shopping_worker_coordination as coordination
    join public.naver_rank_trackers as a on a.id = $1::uuid
    join public.naver_rank_trackers as b on b.id = $2::uuid
    where coordination.lane_key = 'global'
  `, [ids.mmlA, ids.mmlB])).rows[0].state;

  const blocked = await claim(database);
  assert.equal(blocked.status, "empty");
  assert.equal(blocked.accountPriority, true);
  assert.deepEqual((await database.query(`
    select state, count(*)::integer as count
    from public.naver_shopping_account_priority_members
    where request_id = $1::uuid group by state
  `, [ids.request])).rows, [{ state: "pending", count: 2 }]);
  assert.equal((await database.query(`
    select count(*)::integer as count
    from public.naver_shopping_scheduler_events
    where event_type = 'tracker_claimed'
      and occurred_at >= (
        select requested_at from public.naver_shopping_account_priority_requests
        where request_id = $1::uuid
      )
  `, [ids.request])).rows[0].count, 0);
  const unchanged = (await database.query(`
    select jsonb_build_object(
      'cursorSort', coordination.scheduler_cycle_cursor_sort_order,
      'cursorCreated', coordination.scheduler_cycle_cursor_created_at,
      'cursorTracker', coordination.scheduler_cycle_cursor_tracker_id,
      'cursorResume', coordination.scheduler_cycle_resume_cursor,
      'aCycle', a.worker_last_cycle_id,
      'aClaimed', a.worker_last_cycle_claimed_at,
      'aDeferred', a.worker_last_cycle_deferred_at,
      'bQuarantine', b.worker_quarantined_until,
      'bCycle', b.worker_last_cycle_id
    ) as state
    from public.naver_shopping_worker_coordination as coordination
    join public.naver_rank_trackers as a on a.id = $1::uuid
    join public.naver_rank_trackers as b on b.id = $2::uuid
    where coordination.lane_key = 'global'
  `, [ids.mmlA, ids.mmlB])).rows[0].state;
  assert.deepEqual(unchanged, before);

  // Simulate only the canonical scheduler-owned next natural cycle. The saved
  // cursor remains untouched; the priority path never creates or resets it.
  await database.query(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = null, lease_token = null, lease_until = null,
        run_id = null, scheduler_cycle_id = $1::uuid,
        scheduler_cycle_number = 48, scheduler_cycle_status = 'active',
        scheduler_cycle_started_at = clock_timestamp()
    where lane_key = 'global'
  `, [ids.nextCycle]);
  await database.query(`
    insert into public.naver_shopping_scheduler_events(
      event_type, cycle_id, cycle_number, tracker_id, agency_code, roster_state
    )
    select 'cycle_rostered', $1::uuid, 48, tracker.id, tracker.agency_code,
           case when tracker.worker_quarantined_until > clock_timestamp()
             then 'quarantined' else 'eligible' end
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
  `, [ids.nextCycle]);
  await startRun(database, ids.nextRun);
  const next = await claim(database, ids.nextRun);
  assert.equal(next.status, "claimed");
  assert.deepEqual(next.claims.map((entry) => entry.trackerId), [ids.mmlA]);
  await recordNavigatingRun(database, ids.nextRun);
  const nextEvidence = (await database.query(`
    select claimed_cycle_id::text as cycle_id,
           cursor_sort_order_before, cursor_sort_order_after,
           cursor_tracker_id_before::text, cursor_tracker_id_after::text
    from public.naver_shopping_account_priority_members
    where request_id = $1::uuid and tracker_id = $2::uuid
  `, [ids.request, ids.mmlA])).rows[0];
  assert.deepEqual(nextEvidence, {
    cycle_id: ids.nextCycle,
    cursor_sort_order_before: 777,
    cursor_sort_order_after: 777,
    cursor_tracker_id_before: ids.other,
    cursor_tracker_id_after: ids.other,
  });
});

test("future quarantine is preserved, becomes naturally eligible, and terminal outcomes are finite", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await enqueue(database);
  await startRun(database);

  const first = await claim(database);
  assert.deepEqual(first.claims.map((entry) => entry.trackerId), [ids.mmlA]);
  await recordNavigatingRun(database);
  const quarantineBefore = (await database.query(`
    select worker_quarantined_until from public.naver_rank_trackers where id = $1::uuid
  `, [ids.mmlB])).rows[0].worker_quarantined_until;
  await terminal(database, ids.mmlA, "job_failed", "naver_next_data_rank_drift");

  const sameRun = await claim(database);
  assert.equal(sameRun.status, "waiting");
  assert.equal(sameRun.reason, "account_run_already_consumed");

  await startRun(database, ids.nextRun);
  const noEligible = await claim(database, ids.nextRun);
  assert.equal(noEligible.status, "empty");
  assert.equal(noEligible.accountPriority, true);
  assert.equal((await database.query(`
    select worker_quarantined_until from public.naver_rank_trackers where id = $1::uuid
  `, [ids.mmlB])).rows[0].worker_quarantined_until.toISOString(), quarantineBefore.toISOString());

  await database.query(`
    update public.naver_rank_trackers
    set worker_quarantined_until = clock_timestamp() - interval '1 second'
    where id = $1::uuid
  `, [ids.mmlB]);
  const second = await claim(database, ids.nextRun);
  assert.deepEqual(second.claims.map((entry) => entry.trackerId), [ids.mmlB]);
  await recordNavigatingRun(database, ids.nextRun);
  await terminal(database, ids.mmlB, "tracker_committed");
  const resumed = await claim(database, ids.nextRun);
  assert.equal(resumed.legacy, true, "completed request falls through to ordinary legacy/normal transport");

  const partition = await database.query(`
    select request.state, request.succeeded,
           count(*) filter (where member.state = 'terminal_success')::integer as success_count,
           count(*) filter (where member.state = 'terminal_failure')::integer as failure_count
    from public.naver_shopping_account_priority_requests as request
    join public.naver_shopping_account_priority_members as member using (request_id)
    where request.request_id = $1::uuid
    group by request.request_id
  `, [ids.request]);
  assert.deepEqual(partition.rows[0], {
    state: "completed",
    succeeded: false,
    success_count: 1,
    failure_count: 1,
  });
});

test("expired pending members and missing terminals close once without orphan recovery", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await enqueue(database);
  await startRun(database);
  const first = await claim(database);
  assert.equal(first.status, "claimed");
  await recordNavigatingRun(database);

  await database.query(`
    select mi_internal.mi_reconcile_naver_shopping_account_priority(
      greatest(request.expires_at, member.claimed_lease_until) + interval '1 second'
    )
    from public.naver_shopping_account_priority_requests as request
    join public.naver_shopping_account_priority_members as member using (request_id)
    where request.request_id = $1::uuid and member.tracker_id = $2::uuid
  `, [ids.request, ids.mmlA]);
  const states = await database.query(`
    select tracker_id::text, state
    from public.naver_shopping_account_priority_members
    where request_id = $1::uuid order by tracker_id
  `, [ids.request]);
  assert.deepEqual(states.rows, [
    { tracker_id: ids.mmlA, state: "terminal_missing" },
    { tracker_id: ids.mmlB, state: "expired" },
  ]);
  const request = (await database.query(`
    select state, succeeded, expired_at is not null as expired
    from public.naver_shopping_account_priority_requests where request_id = $1::uuid
  `, [ids.request])).rows[0];
  assert.deepEqual(request, { state: "completed", succeeded: false, expired: true });

  const recovery = await database.query(`
    select
      public.mi_naver_shopping_cycle_orphan_recovery_eligible($1::uuid, $2::uuid) as orphan,
      public.mi_naver_shopping_cycle_runtime_recovery_eligible(
        $1::uuid, $2::uuid, $3, $4
      ) as runtime
  `, [ids.mmlA, ids.cycle, runtimeVersion, runtimeFingerprint]);
  assert.deepEqual(recovery.rows[0], { orphan: false, runtime: false });

  const immutableBefore = (await database.query(`
    select member.state, member.terminal_at, member.terminal_event_id,
           member.terminal_code, request.completed_at, request.succeeded
    from public.naver_shopping_account_priority_members as member
    join public.naver_shopping_account_priority_requests as request using (request_id)
    where member.request_id = $1::uuid and member.tracker_id = $2::uuid
  `, [ids.request, ids.mmlA])).rows[0];
  await terminal(database, ids.mmlA, "tracker_committed");
  await database.query(`
    select mi_internal.mi_reconcile_naver_shopping_account_priority(
      clock_timestamp() + interval '1 hour'
    )
  `);
  const immutableAfter = (await database.query(`
    select member.state, member.terminal_at, member.terminal_event_id,
           member.terminal_code, request.completed_at, request.succeeded
    from public.naver_shopping_account_priority_members as member
    join public.naver_shopping_account_priority_requests as request using (request_id)
    where member.request_id = $1::uuid and member.tracker_id = $2::uuid
  `, [ids.request, ids.mmlA])).rows[0];
  assert.deepEqual(immutableAfter, immutableBefore);
  const lateClaim = await claim(database);
  assert.equal(lateClaim.legacy, true);
});

test("conflicting exact terminals close once as an immutable integrity failure", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.query(`
    update public.naver_rank_trackers set status = 'paused' where id = $1::uuid
  `, [ids.mmlB]);
  await enqueue(database);
  await startRun(database);
  const first = await claim(database);
  assert.deepEqual(first.claims.map((entry) => entry.trackerId), [ids.mmlA]);
  await recordNavigatingRun(database);
  const claimBefore = (await database.query(`
    select claimed_at, claimed_cycle_id, claimed_run_id, claim_event_id,
           claim_id, cursor_sort_order_before, cursor_sort_order_after
    from public.naver_shopping_account_priority_members
    where request_id = $1::uuid and tracker_id = $2::uuid
  `, [ids.request, ids.mmlA])).rows[0];
  await terminal(database, ids.mmlA, "tracker_committed");
  await terminal(database, ids.mmlA, "job_failed", "naver_next_data_rank_drift");
  const reconciled = await claim(database);
  assert.equal(reconciled.legacy, true);
  const result = (await database.query(`
    select member.state, member.terminal_code,
           member.claimed_at, member.claimed_cycle_id,
           member.claimed_run_id, member.claim_event_id, member.claim_id,
           member.cursor_sort_order_before, member.cursor_sort_order_after,
           request.state as request_state, request.succeeded,
           member.terminal_event_id = (
             select min(event.event_id)
             from public.naver_shopping_scheduler_events as event
             where event.claim_id = member.claim_id
               and event.tracker_id = member.tracker_id
               and event.event_type in (
                 'tracker_committed', 'finite_window_committed', 'job_failed'
               )
           ) as first_terminal
    from public.naver_shopping_account_priority_members as member
    join public.naver_shopping_account_priority_requests as request using (request_id)
    where member.request_id = $1::uuid and member.tracker_id = $2::uuid
  `, [ids.request, ids.mmlA])).rows[0];
  assert.equal(result.state, "integrity_failure");
  assert.equal(result.terminal_code, "account_priority_terminal_conflict");
  assert.equal(result.request_state, "completed");
  assert.equal(result.succeeded, false);
  assert.equal(result.first_terminal, true);
  assert.deepEqual({
    claimed_at: result.claimed_at,
    claimed_cycle_id: result.claimed_cycle_id,
    claimed_run_id: result.claimed_run_id,
    claim_event_id: result.claim_event_id,
    claim_id: result.claim_id,
    cursor_sort_order_before: result.cursor_sort_order_before,
    cursor_sort_order_after: result.cursor_sort_order_after,
  }, claimBefore);
});

test("legacy queue conflicts and active account requests block legacy enqueue without mutation", async (t) => {
  const conflictDb = await createDatabase({ legacyQueued: true });
  t.after(() => conflictDb.close());
  await assert.rejects(
    () => enqueue(conflictDb),
    /naver_shopping_account_priority_legacy_conflict/iu,
  );

  const database = await createDatabase();
  t.after(() => database.close());
  await enqueue(database);
  const blocked = await database.query(`
    select public.mi_enqueue_naver_shopping_repair_priority(
      $1::uuid, array[$2::uuid], 'manual_repair'
    ) as result
  `, [ids.request2, ids.other]);
  assert.deepEqual(blocked.rows[0].result, {
    accepted: false,
    idempotent: false,
    blockedByAccountPriority: true,
    queuedCount: 0,
    wakeRequested: false,
  });
  assert.equal((await database.query(`
    select count(*)::integer as count from public.naver_shopping_repair_priority_requests
  `)).rows[0].count, 0);
});

test("coordination serialization gives a single winner for one eligible member", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.query(`
    update public.naver_rank_trackers set status = 'paused' where id = $1::uuid
  `, [ids.mmlB]);
  await enqueue(database);
  await startRun(database);

  const [left, right] = await Promise.all([claim(database), claim(database)]);
  const statuses = [left.status, right.status].sort();
  assert.deepEqual(statuses, ["claimed", "waiting"]);
  assert.equal((await database.query(`
    select count(*)::integer as count
    from public.naver_shopping_account_priority_members where state = 'claimed'
  `)).rows[0].count, 1);
  assert.equal((await database.query(`
    select count(*)::integer as count
    from public.naver_shopping_scheduler_events where event_type = 'tracker_claimed'
      and occurred_at >= (select requested_at from public.naver_shopping_account_priority_requests)
  `)).rows[0].count, 1);
});

test("one-shot account priority is pinned to the exact Windows primary worker", async (t) => {
  const wrongPrimary = await createDatabase();
  t.after(() => wrongPrimary.close());
  await wrongPrimary.query(`
    update public.naver_shopping_worker_coordination
    set primary_worker_id = 'standby-worker'
    where lane_key = 'global'
  `);
  await assert.rejects(
    () => enqueue(wrongPrimary),
    /naver_shopping_account_priority_requires_idle_control/iu,
  );

  const wrongClaim = await createDatabase();
  t.after(() => wrongClaim.close());
  await enqueue(wrongClaim);
  await startRun(wrongClaim);
  await assert.rejects(
    () => wrongClaim.query(`
      select public.mi_claim_naver_shopping_repair_priority(
        'standby-worker', $1::uuid, $2::uuid, 600
      )
    `, [ids.lane, ids.run]),
    /naver_shopping_account_priority_claim_invalid/iu,
  );
});

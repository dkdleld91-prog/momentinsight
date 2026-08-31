import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import "./naver-shopping-active-cycle-runtime-recovery-migration.test.mjs";

const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
const workerA = Object.freeze({
  id: "scheduler-worker-a",
  token: "10000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
});
const workerB = Object.freeze({
  id: "scheduler-worker-b",
  token: "10000000-0000-4000-8000-000000000002",
  runId: "20000000-0000-4000-8000-000000000002",
});

const trackerIds = Object.freeze({
  oldA: "30000000-0000-4000-8000-000000000001",
  oldB: "30000000-0000-4000-8000-000000000002",
  oldC: "30000000-0000-4000-8000-000000000003",
  new1: "40000000-0000-4000-8000-000000000001",
  new2: "40000000-0000-4000-8000-000000000002",
  new3: "40000000-0000-4000-8000-000000000003",
  new4: "40000000-0000-4000-8000-000000000004",
});

const legacyFailureRunId = "50000000-0000-4000-8000-000000000001";
const missingTerminalRunId = "50000000-0000-4000-8000-000000000002";

function latestPublicFunctionDefinition(name) {
  const pattern = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "giu",
  );
  let latest = null;

  for (const file of readdirSync(migrationDirectory)
    .filter((entry) => /^\d{14}_.+\.sql$/u.test(entry))
    .sort()) {
    const source = readFileSync(new URL(file, migrationDirectory), "utf8");
    for (const match of source.matchAll(pattern)) {
      latest = { file, sql: match[0] };
    }
  }

  assert.ok(latest, `${name} must have a canonical migration definition`);
  return latest;
}

const queueFunction = latestPublicFunctionDefinition("mi_queue_naver_shopping_cycle");
const claimFunction = latestPublicFunctionDefinition("mi_claim_naver_shopping_cycle_keyword");
const recoveryEligibilityFunction = latestPublicFunctionDefinition(
  "mi_naver_shopping_cycle_runtime_recovery_eligible",
);
const orphanRecoveryEligibilityFunction = latestPublicFunctionDefinition(
  "mi_naver_shopping_cycle_orphan_recovery_eligible",
);
const laneClaimFunction = latestPublicFunctionDefinition("mi_claim_naver_shopping_worker_lane");
const progressFunction = latestPublicFunctionDefinition("mi_report_naver_shopping_worker_progress");
const runtimeVersion = progressFunction.sql.match(
  /expected_runtime_version constant text := '([^']+)'/iu,
)?.[1];
const runtimeFingerprint = progressFunction.sql.match(
  /expected_runtime_fingerprint constant text :=\s*'([a-f0-9]{64})'/iu,
)?.[1];

assert.ok(runtimeVersion, "canonical progress RPC must pin a runtime version");
assert.ok(runtimeFingerprint, "canonical progress RPC must pin a runtime fingerprint");

async function createSchedulerDatabase(worker = workerA) {
  const database = new PGlite();
  await database.exec(`
    create table public.naver_shopping_worker_coordination (
      lane_key text primary key,
      lease_worker_id text,
      lease_token uuid,
      lease_until timestamptz,
      run_id uuid,
      circuit_state text not null default 'closed',
      circuit_reason text,
      circuit_opened_at timestamptz,
      failure_signature text,
      failure_streak integer not null default 0,
      transient_system_probe_attempts integer not null default 0,
      probe_tracker_id uuid,
      probe_started_at timestamptz,
      primary_worker_id text,
      primary_seen_at timestamptz,
      cooldown_until timestamptz,
      last_block_code text,
      last_failure_code text,
      runtime_version text,
      runtime_fingerprint text,
      current_stage text,
      current_page integer not null default 0,
      current_job_kind text,
      current_tracker_id uuid,
      current_job_started_at timestamptz,
      cadence_mode text not null default 'baseline',
      cadence_minutes integer not null default 10,
      stability_started_at timestamptz,
      success_streak integer not null default 0,
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

    create table public.naver_rank_trackers (
      id uuid primary key,
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
      started_at timestamptz not null
    );

    create table public.naver_shopping_scheduler_events (
      event_id bigint generated always as identity primary key,
      occurred_at timestamptz not null default clock_timestamp(),
      event_type text not null,
      cycle_id uuid,
      claim_id uuid,
      run_id uuid,
      tracker_id uuid,
      roster_state text,
      priority text,
      lease_until timestamptz
    );

    -- The latest recovery predicates exclude exact one-shot account-priority
    -- claims. This fairness fixture does not enqueue such a request, but the
    -- canonical function bodies must still compile against their dependencies.
    create table public.naver_shopping_account_priority_requests (
      request_id uuid primary key,
      state text not null
    );

    create table public.naver_shopping_account_priority_members (
      request_id uuid not null,
      tracker_id uuid not null,
      claimed_cycle_id uuid
    );

    insert into public.naver_shopping_worker_coordination(lane_key)
    values ('global');
  `);
  await database.exec(queueFunction.sql);
  await database.exec(recoveryEligibilityFunction.sql);
  await database.exec(orphanRecoveryEligibilityFunction.sql);
  await database.exec(claimFunction.sql);
  await database.exec(laneClaimFunction.sql);
  await database.exec(progressFunction.sql);
  await acquireLaneAndStartRun(database, worker);
  return database;
}

async function claimLane(database, worker) {
  const lane = await database.query(`
    select public.mi_claim_naver_shopping_worker_lane(
      $1::text, 'primary'::text, $2::uuid, 600, 180
    ) as result
  `, [worker.id, worker.token]);
  return lane.rows[0].result;
}

async function acquireLaneAndStartRun(database, worker) {
  const lane = await claimLane(database, worker);
  assert.equal(lane.granted, true);

  const progress = await database.query(`
    select public.mi_report_naver_shopping_worker_progress(
      $1::text, $2::uuid, $3::uuid, 'claiming', 0,
      null::text, null::uuid, $4::text, $5::text, 'rank-catch-up'
    ) as result
  `, [worker.id, worker.token, worker.runId, runtimeVersion, runtimeFingerprint]);
  assert.equal(progress.rows[0].result, true);
  return lane;
}

async function insertTracker(database, {
  id,
  keyword,
  sortOrder,
  createdAt = "2020-01-01T00:00:00Z",
  lastCheckedAt = "2026-08-01T00:00:00Z",
  quarantinedUntil = null,
}) {
  await database.query(`
    insert into public.naver_rank_trackers (
      id, status, keyword, sort_order, created_at, last_checked_at, worker_quarantined_until
    ) values ($1::uuid, 'active', $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz)
  `, [id, keyword, sortOrder, createdAt, lastCheckedAt, quarantinedUntil]);
}

async function queueCycle(database) {
  const result = await database.query(
    "select public.mi_queue_naver_shopping_cycle() as result",
  );
  const cycle = result.rows[0].result;
  if (cycle.started === true) {
    await database.query(`
      insert into public.naver_shopping_scheduler_events (
        event_type, cycle_id, tracker_id, roster_state
      )
      select
        'cycle_rostered', $1::uuid, tracker.id,
        case
          when tracker.worker_quarantined_until > clock_timestamp()
            then 'quarantined'
          else 'eligible'
        end
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
    `, [cycle.cycleId]);
  }
  return cycle;
}

async function claimNext(database, worker = workerA) {
  const result = await database.query(`
    select public.mi_claim_naver_shopping_cycle_keyword(
      $1::text, $2::uuid, $3::uuid, 600, null::uuid
    ) as result
  `, [worker.id, worker.token, worker.runId]);
  return result.rows[0].result;
}

async function finishClaim(database, claim) {
  // Terminal commit/failure RPCs have their own contract suites. This fixture
  // clears only the processing lease so the scheduler can advance serially.
  for (const member of claim.claims || []) {
    await database.query(`
      update public.naver_rank_trackers
      set processing_started_at = null,
          processing_until = null
      where id = $1::uuid
    `, [member.trackerId]);
  }
}

async function expectClaim(database, expectedTrackerId, expectedPriority, worker = workerA) {
  const claim = await claimNext(database, worker);
  assert.equal(claim.status, "claimed");
  assert.equal(claim.priority, expectedPriority);
  assert.deepEqual(
    claim.claims.map((member) => member.trackerId),
    [expectedTrackerId],
  );
  await finishClaim(database, claim);
  return claim;
}

test("executes the latest canonical scheduler function bodies", () => {
  assert.match(queueFunction.file, /^\d{14}_.+\.sql$/u);
  assert.match(claimFunction.file, /^\d{14}_.+\.sql$/u);
  assert.match(laneClaimFunction.file, /^\d{14}_.+\.sql$/u);
  assert.match(progressFunction.file, /^\d{14}_.+\.sql$/u);
  assert.match(claimFunction.sql, /for update skip locked/iu);
  assert.match(claimFunction.sql, /scheduler_cycle_resume_cursor/iu);
  assert.match(recoveryEligibilityFunction.sql, /tracker_claimed/iu);
  assert.match(orphanRecoveryEligibilityFunction.sql, /processing_until/iu);
  assert.match(orphanRecoveryEligibilityFunction.sql, /unmatched_claims/iu);
  assert.match(laneClaimFunction.sql, /current_row\.lease_until > v_now/iu);
});

test("cycle-start cohort completes in canonical order before later registrations join next cycle", async (t) => {
  const database = await createSchedulerDatabase();
  t.after(() => database.close());

  await insertTracker(database, {
    id: trackerIds.oldA, keyword: "old-a", sortOrder: 10,
  });
  await insertTracker(database, {
    id: trackerIds.oldB, keyword: "old-b", sortOrder: 20,
  });
  await insertTracker(database, {
    id: trackerIds.oldC, keyword: "old-c", sortOrder: 30,
  });

  const cycle = await queueCycle(database);
  assert.equal(cycle.status, "active");
  assert.equal(cycle.started, true);
  assert.equal(cycle.total, 3);

  // Make the cohort boundary explicit and deterministic: every tracker below
  // is registered after this already-active cycle started.
  await database.query(`
    update public.naver_shopping_worker_coordination
    set scheduler_cycle_started_at = clock_timestamp() - interval '1 minute'
    where lane_key = 'global'
  `);

  const firstCycleClaims = [];
  const takeFirstCycle = async (id, priority) => {
    await expectClaim(database, id, priority);
    firstCycleClaims.push(id);
  };

  const registeredAt = new Date((await database.query(
    "select clock_timestamp() as registered_at",
  )).rows[0].registered_at).toISOString();

  await insertTracker(database, {
    id: trackerIds.new1,
    keyword: "new-1",
    sortOrder: 101,
    createdAt: registeredAt,
    lastCheckedAt: null,
  });
  await takeFirstCycle(trackerIds.oldA, "normal");

  await insertTracker(database, {
    id: trackerIds.new2,
    keyword: "new-2",
    sortOrder: 102,
    createdAt: registeredAt,
    lastCheckedAt: null,
  });
  await takeFirstCycle(trackerIds.oldB, "normal");

  await insertTracker(database, {
    id: trackerIds.new3,
    keyword: "new-3",
    sortOrder: 103,
    createdAt: registeredAt,
    lastCheckedAt: null,
  });
  await takeFirstCycle(trackerIds.oldC, "normal");

  await insertTracker(database, {
    id: trackerIds.new4,
    keyword: "new-4",
    sortOrder: 104,
    createdAt: registeredAt,
    lastCheckedAt: null,
  });
  assert.deepEqual(firstCycleClaims, [
    trackerIds.oldA,
    trackerIds.oldB,
    trackerIds.oldC,
  ]);
  assert.equal(new Set(firstCycleClaims).size, firstCycleClaims.length);

  const completed = await claimNext(database);
  assert.equal(completed.status, "cycle_completed");

  const firstRoster = await database.query(`
    select id::text, worker_last_cycle_id::text as cycle_id
    from public.naver_rank_trackers
    order by id
  `);
  assert.deepEqual(
    firstRoster.rows.filter((row) => row.cycle_id === cycle.cycleId).map((row) => row.id),
    [trackerIds.oldA, trackerIds.oldB, trackerIds.oldC],
  );
  assert.ok(firstRoster.rows
    .filter((row) => row.id.startsWith("40000000-"))
    .every((row) => row.cycle_id === null));

  const nextCycle = await queueCycle(database);
  assert.equal(nextCycle.started, true);
  const secondCycleClaims = [];
  for (const id of [
    trackerIds.oldA,
    trackerIds.oldB,
    trackerIds.oldC,
    trackerIds.new1,
    trackerIds.new2,
    trackerIds.new3,
    trackerIds.new4,
  ]) {
    await expectClaim(database, id, "normal");
    secondCycleClaims.push(id);
  }
  assert.equal(new Set(secondCycleClaims).size, secondCycleClaims.length);
  assert.equal((await claimNext(database)).status, "cycle_completed");
});

test("a paused pre-existing tracker reactivated after cycle start waits for the next cycle", async (t) => {
  const database = await createSchedulerDatabase();
  t.after(() => database.close());

  await insertTracker(database, {
    id: trackerIds.oldA, keyword: "active-at-start", sortOrder: 10,
  });
  await insertTracker(database, {
    id: trackerIds.oldB, keyword: "paused-at-start", sortOrder: 20,
  });
  await database.query(`
    update public.naver_rank_trackers
    set status = 'paused'
    where id = $1::uuid
  `, [trackerIds.oldB]);

  const cycle = await queueCycle(database);
  await database.query(`
    update public.naver_rank_trackers
    set status = 'active'
    where id = $1::uuid
  `, [trackerIds.oldB]);

  await expectClaim(database, trackerIds.oldA, "normal");
  assert.equal((await claimNext(database)).status, "cycle_completed");
  const deferred = await database.query(`
    select worker_last_cycle_id::text as cycle_id
    from public.naver_rank_trackers
    where id = $1::uuid
  `, [trackerIds.oldB]);
  assert.equal(deferred.rows[0].cycle_id, null);

  const nextCycle = await queueCycle(database);
  assert.notEqual(nextCycle.cycleId, cycle.cycleId);
  await expectClaim(database, trackerIds.oldA, "normal");
  await expectClaim(database, trackerIds.oldB, "normal");
  assert.equal((await claimNext(database)).status, "cycle_completed");
});

test("quarantine exclusion becomes eligible after expiry and wraps behind the saved cursor", async (t) => {
  const database = await createSchedulerDatabase();
  t.after(() => database.close());

  await insertTracker(database, {
    id: trackerIds.oldA,
    keyword: "old-a",
    sortOrder: 10,
    quarantinedUntil: "2099-01-01T00:00:00Z",
  });
  await insertTracker(database, {
    id: trackerIds.oldB, keyword: "old-b", sortOrder: 20,
  });
  await insertTracker(database, {
    id: trackerIds.oldC, keyword: "old-c", sortOrder: 30,
  });

  const cycle = await queueCycle(database);
  assert.equal(cycle.total, 2, "a future-quarantined tracker is excluded at cycle start");
  await expectClaim(database, trackerIds.oldB, "normal");
  await expectClaim(database, trackerIds.oldC, "normal");

  const beforeExpiry = await database.query(`
    select worker_last_cycle_id::text as cycle_id
    from public.naver_rank_trackers
    where id = $1::uuid
  `, [trackerIds.oldA]);
  assert.equal(beforeExpiry.rows[0].cycle_id, null);

  await database.query(`
    update public.naver_rank_trackers
    set worker_quarantined_until = clock_timestamp() - interval '1 second'
    where id = $1::uuid
  `, [trackerIds.oldA]);

  const wrapped = await expectClaim(database, trackerIds.oldA, "normal");
  assert.equal(wrapped.cycleId, cycle.cycleId);

  const cursor = await database.query(`
    select scheduler_cycle_cursor_tracker_id::text as tracker_id
    from public.naver_shopping_worker_coordination
    where lane_key = 'global'
  `);
  assert.equal(cursor.rows[0].tracker_id, trackerIds.oldA);
  assert.equal((await claimNext(database)).status, "cycle_completed");
});

test("canonical lane handoff after an expired runtime lease preserves the active cycle and cursor", async (t) => {
  const database = await createSchedulerDatabase();
  t.after(() => database.close());

  await insertTracker(database, {
    id: trackerIds.oldA, keyword: "old-a", sortOrder: 10,
  });
  await insertTracker(database, {
    id: trackerIds.oldB, keyword: "old-b", sortOrder: 20,
  });
  await insertTracker(database, {
    id: trackerIds.oldC, keyword: "old-c", sortOrder: 30,
  });

  const cycle = await queueCycle(database);
  await expectClaim(database, trackerIds.oldA, "normal");

  const beforeRestart = await database.query(`
    select scheduler_cycle_id::text as cycle_id,
           scheduler_cycle_cursor_tracker_id::text as cursor_tracker_id,
           scheduler_cycle_resume_cursor as resume_cursor
    from public.naver_shopping_worker_coordination
    where lane_key = 'global'
  `);
  assert.deepEqual(beforeRestart.rows[0], {
    cycle_id: cycle.cycleId,
    cursor_tracker_id: trackerIds.oldA,
    resume_cursor: false,
  });

  const blockedHandoff = await claimLane(database, workerB);
  assert.equal(blockedHandoff.granted, false);
  assert.equal(blockedHandoff.reason, "busy");

  await database.query(`
    update public.naver_shopping_worker_coordination
    set lease_until = clock_timestamp() - interval '1 second',
        runtime_version = '1.1.17',
        runtime_fingerprint = repeat('0', 64)
    where lane_key = 'global'
  `);
  const handoff = await acquireLaneAndStartRun(database, workerB);
  assert.equal(handoff.reason, "granted");

  const replacementLane = await database.query(`
    select lease_worker_id, lease_token::text as lease_token, run_id::text as run_id,
           runtime_version, runtime_fingerprint
    from public.naver_shopping_worker_coordination
    where lane_key = 'global'
  `);
  assert.deepEqual(replacementLane.rows[0], {
    lease_worker_id: workerB.id,
    lease_token: workerB.token,
    run_id: workerB.runId,
    runtime_version: runtimeVersion,
    runtime_fingerprint: runtimeFingerprint,
  });
  const resumedCycle = await queueCycle(database);
  assert.equal(resumedCycle.cycleId, cycle.cycleId);
  assert.equal(resumedCycle.started, false);

  const afterRestart = await database.query(`
    select scheduler_cycle_id::text as cycle_id,
           scheduler_cycle_cursor_tracker_id::text as cursor_tracker_id,
           scheduler_cycle_resume_cursor as resume_cursor
    from public.naver_shopping_worker_coordination
    where lane_key = 'global'
  `);
  assert.deepEqual(afterRestart.rows[0], beforeRestart.rows[0]);

  await expectClaim(database, trackerIds.oldB, "normal", workerB);
  await expectClaim(database, trackerIds.oldC, "normal", workerB);
  assert.equal((await claimNext(database, workerB)).status, "cycle_completed");

  const claims = await database.query(`
    select id::text
    from public.naver_rank_trackers
    where worker_last_cycle_id = $1::uuid
    order by sort_order
  `, [cycle.cycleId]);
  assert.deepEqual(claims.rows.map((row) => row.id), [
    trackerIds.oldA,
    trackerIds.oldB,
    trackerIds.oldC,
  ]);
});

test("an expired orphan claim gets one same-cycle repair opportunity and cannot loop", async (t) => {
  const database = await createSchedulerDatabase();
  t.after(() => database.close());

  await insertTracker(database, {
    id: trackerIds.oldA, keyword: "orphan-a", sortOrder: 10,
  });
  await insertTracker(database, {
    id: trackerIds.oldB, keyword: "next-b", sortOrder: 20,
  });

  const cycle = await queueCycle(database);
  const firstClaim = await claimNext(database);
  assert.equal(firstClaim.status, "claimed");
  assert.equal(firstClaim.priority, "normal");
  assert.deepEqual(firstClaim.claims.map((member) => member.trackerId), [trackerIds.oldA]);

  const originalClaimId = "60000000-0000-4000-8000-000000000001";
  await database.query(`
    update public.naver_rank_trackers
    set processing_until = clock_timestamp() - interval '1 second'
    where id = $1::uuid
  `, [trackerIds.oldA]);
  await database.query(`
    insert into public.naver_shopping_scheduler_events (
      event_type, cycle_id, claim_id, run_id, tracker_id, priority, lease_until
    ) values (
      'tracker_claimed', $2::uuid, $3::uuid, $4::uuid, $1::uuid,
      'normal', clock_timestamp() - interval '1 second'
    );
  `, [trackerIds.oldA, cycle.cycleId, originalClaimId, workerA.runId]);

  const repairClaim = await claimNext(database);
  assert.equal(repairClaim.status, "claimed");
  assert.equal(repairClaim.priority, "repair");
  assert.deepEqual(repairClaim.claims.map((member) => member.trackerId), [trackerIds.oldA]);

  const repairClaimId = "60000000-0000-4000-8000-000000000002";
  await database.query(`
    update public.naver_rank_trackers
    set processing_until = clock_timestamp() - interval '1 second'
    where id = $1::uuid
  `, [trackerIds.oldA]);
  await database.query(`
    insert into public.naver_shopping_scheduler_events (
      event_type, cycle_id, claim_id, run_id, tracker_id, priority, lease_until
    ) values (
      'tracker_claimed', $2::uuid, $3::uuid, $4::uuid, $1::uuid,
      'repair', clock_timestamp() - interval '1 second'
    );
  `, [trackerIds.oldA, cycle.cycleId, repairClaimId, workerA.runId]);

  await expectClaim(database, trackerIds.oldB, "normal");
  assert.equal((await claimNext(database)).status, "cycle_completed");

  const attempts = await database.query(`
    select count(*)::integer as claim_count
    from public.naver_shopping_scheduler_events
    where cycle_id = $1::uuid
      and tracker_id = $2::uuid
      and event_type = 'tracker_claimed'
  `, [cycle.cycleId, trackerIds.oldA]);
  assert.equal(attempts.rows[0].claim_count, 2);
});

test("an old-runtime failure already marked in the active cycle gets one current-runtime natural retry", async (t) => {
  const database = await createSchedulerDatabase();
  t.after(() => database.close());

  await insertTracker(database, {
    id: trackerIds.oldA, keyword: "old-runtime-failure", sortOrder: 10,
  });
  await insertTracker(database, {
    id: trackerIds.oldB, keyword: "second-old-runtime-failure", sortOrder: 20,
  });
  await insertTracker(database, {
    id: trackerIds.oldC, keyword: "cursor-already-passed", sortOrder: 30,
  });

  const cycle = await queueCycle(database);
  await database.query(`
    update public.naver_rank_trackers
    set worker_last_cycle_id = $1::uuid,
        worker_last_cycle_claimed_at = clock_timestamp() - interval '2 hours'
    where id in ($2::uuid, $3::uuid, $4::uuid)
  `, [cycle.cycleId, trackerIds.oldA, trackerIds.oldB, trackerIds.oldC]);
  await database.query(`
    update public.naver_shopping_worker_coordination
    set scheduler_cycle_cursor_sort_order = 30,
        scheduler_cycle_cursor_created_at = '2020-01-01T00:00:00Z'::timestamptz,
        scheduler_cycle_cursor_tracker_id = $1::uuid
    where lane_key = 'global'
  `, [trackerIds.oldC]);
  await database.query(`
    insert into public.naver_shopping_worker_runs (
      run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint, started_at
    ) values (
      $1::uuid, 'scheduler-worker-a', 'rank-remote', '1.1.17', repeat('1', 64),
      clock_timestamp() - interval '2 hours'
    )
  `, [legacyFailureRunId]);
  await database.query(`
    insert into public.naver_shopping_scheduler_events (
      event_type, cycle_id, run_id, tracker_id, occurred_at
    ) values
      (
        'job_failed', $1::uuid, $2::uuid, $3::uuid,
        clock_timestamp() - interval '119 minutes'
      ),
      (
        'job_failed', $1::uuid, $2::uuid, $4::uuid,
        clock_timestamp() - interval '118 minutes'
      )
  `, [cycle.cycleId, legacyFailureRunId, trackerIds.oldA, trackerIds.oldB]);

  const cursorBeforeRecovery = await database.query(`
    select scheduler_cycle_cursor_tracker_id
    from public.naver_shopping_worker_coordination
    where lane_key = 'global'
  `);

  await expectClaim(database, trackerIds.oldA, "repair");
  const cursorAfterRecovery = await database.query(`
    select scheduler_cycle_cursor_tracker_id
    from public.naver_shopping_worker_coordination
    where lane_key = 'global'
  `);
  assert.equal(
    cursorAfterRecovery.rows[0].scheduler_cycle_cursor_tracker_id,
    cursorBeforeRecovery.rows[0].scheduler_cycle_cursor_tracker_id,
  );

  // The immutable later claim closes A even when navigation never registers a
  // worker-run row or terminal, allowing B to recover next in stable order.
  await database.query(`
    insert into public.naver_shopping_scheduler_events (
      event_type, cycle_id, run_id, tracker_id
    ) values
      ('tracker_claimed', $1::uuid, $2::uuid, $3::uuid)
  `, [cycle.cycleId, workerA.runId, trackerIds.oldA]);
  await expectClaim(database, trackerIds.oldB, "repair");
  await database.query(`
    insert into public.naver_shopping_scheduler_events (
      event_type, cycle_id, run_id, tracker_id
    ) values
      ('tracker_claimed', $1::uuid, $2::uuid, $3::uuid)
  `, [cycle.cycleId, workerA.runId, trackerIds.oldB]);

  // Neither post-failure recovery claim may loop a second time.
  const recoveryState = await database.query(`
    select public.mi_naver_shopping_cycle_runtime_recovery_eligible(
      $1::uuid, $2::uuid, $3::text, $4::text
    ) as eligible
  `, [trackerIds.oldA, cycle.cycleId, runtimeVersion, runtimeFingerprint]);
  assert.equal(recoveryState.rows[0].eligible, false);
  const completed = await claimNext(database);
  assert.equal(completed.status, "cycle_completed");
});

test("a repaired same-keyword row cannot defer an unclaimed ordinary cohort member", async (t) => {
  const database = await createSchedulerDatabase();
  t.after(() => database.close());

  await insertTracker(database, {
    id: trackerIds.oldA, keyword: "shared-keyword", sortOrder: 10,
  });
  await insertTracker(database, {
    id: trackerIds.oldB, keyword: "shared-keyword", sortOrder: 20,
  });

  const cycle = await queueCycle(database);
  await database.query(`
    update public.naver_rank_trackers
    set worker_last_cycle_id = $1::uuid,
        worker_last_cycle_claimed_at = clock_timestamp() - interval '2 hours'
    where id = $2::uuid
  `, [cycle.cycleId, trackerIds.oldA]);
  await database.query(`
    insert into public.naver_shopping_worker_runs (
      run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint, started_at
    ) values (
      $1::uuid, 'scheduler-worker-a', 'rank-remote', '1.1.17', repeat('1', 64),
      clock_timestamp() - interval '2 hours'
    )
  `, [legacyFailureRunId]);
  await database.query(`
    insert into public.naver_shopping_scheduler_events (
      event_type, cycle_id, run_id, tracker_id, occurred_at
    ) values (
      'job_failed', $1::uuid, $2::uuid, $3::uuid,
      clock_timestamp() - interval '119 minutes'
    )
  `, [cycle.cycleId, legacyFailureRunId, trackerIds.oldA]);

  await expectClaim(database, trackerIds.oldA, "repair");

  const repairClaimId = "60000000-0000-4000-8000-000000000003";
  await database.query(`
    insert into public.naver_shopping_scheduler_events (
      event_type, cycle_id, claim_id, run_id, tracker_id
    ) values
      ('tracker_claimed', $1::uuid, $2::uuid, $3::uuid, $4::uuid),
      ('tracker_committed', $1::uuid, $2::uuid, $3::uuid, $4::uuid)
  `, [cycle.cycleId, repairClaimId, workerA.runId, trackerIds.oldA]);

  await expectClaim(database, trackerIds.oldB, "normal");
  assert.equal((await claimNext(database)).status, "cycle_completed");

  const state = await database.query(`
    select id::text, worker_last_cycle_id::text as cycle_id,
           worker_last_cycle_deferred_at
    from public.naver_rank_trackers
    where id in ($1::uuid, $2::uuid)
    order by sort_order
  `, [trackerIds.oldA, trackerIds.oldB]);
  assert.deepEqual(state.rows.map((row) => ({
    id: row.id,
    cycle_id: row.cycle_id,
    deferred: row.worker_last_cycle_deferred_at,
  })), [
    { id: trackerIds.oldA, cycle_id: cycle.cycleId, deferred: null },
    { id: trackerIds.oldB, cycle_id: cycle.cycleId, deferred: null },
  ]);
});

test("a newer terminal without run provenance fails closed instead of replaying an older failure", async (t) => {
  const database = await createSchedulerDatabase();
  t.after(() => database.close());

  await insertTracker(database, {
    id: trackerIds.oldA, keyword: "latest-terminal-missing-provenance", sortOrder: 10,
  });
  const cycle = await queueCycle(database);
  await database.query(`
    update public.naver_rank_trackers
    set worker_last_cycle_id = $1::uuid,
        worker_last_cycle_claimed_at = clock_timestamp() - interval '2 hours'
    where id = $2::uuid
  `, [cycle.cycleId, trackerIds.oldA]);
  await database.query(`
    insert into public.naver_shopping_worker_runs (
      run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint, started_at
    ) values (
      $1::uuid, 'scheduler-worker-a', 'rank-remote', '1.1.17', repeat('1', 64),
      clock_timestamp() - interval '2 hours'
    )
  `, [legacyFailureRunId]);
  await database.query(`
    insert into public.naver_shopping_scheduler_events (
      event_type, cycle_id, run_id, tracker_id, occurred_at
    ) values
      (
        'job_failed', $1::uuid, $2::uuid, $3::uuid,
        clock_timestamp() - interval '119 minutes'
      ),
      (
        'job_failed', $1::uuid, $4::uuid, $3::uuid,
        clock_timestamp() - interval '118 minutes'
      )
  `, [cycle.cycleId, legacyFailureRunId, trackerIds.oldA, missingTerminalRunId]);

  const eligibility = await database.query(`
    select public.mi_naver_shopping_cycle_runtime_recovery_eligible(
      $1::uuid, $2::uuid, $3::text, $4::text
    ) as eligible
  `, [trackerIds.oldA, cycle.cycleId, runtimeVersion, runtimeFingerprint]);
  assert.equal(eligibility.rows[0].eligible, false);

  const completed = await claimNext(database);
  assert.equal(completed.status, "cycle_completed");
});

// PGlite exposes one exclusive database connection. This suite deliberately
// does not fake a multi-session FOR UPDATE SKIP LOCKED winner test or claim to
// cover the separate terminal commit/failure RPC contracts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

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

    insert into public.naver_shopping_worker_coordination(lane_key)
    values ('global');
  `);
  await database.exec(queueFunction.sql);
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
  return result.rows[0].result;
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
  assert.match(laneClaimFunction.sql, /current_row\.lease_until > v_now/iu);
});

test("sustained new registrations alternate with and cannot starve old A/B/C", async (t) => {
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

  const claimed = [];
  const take = async (id, priority) => {
    await expectClaim(database, id, priority);
    claimed.push(id);
  };

  await insertTracker(database, {
    id: trackerIds.new1,
    keyword: "new-1",
    sortOrder: 101,
    createdAt: "2030-01-01T00:00:01Z",
    lastCheckedAt: null,
  });
  await take(trackerIds.new1, "new");

  await insertTracker(database, {
    id: trackerIds.new2,
    keyword: "new-2",
    sortOrder: 102,
    createdAt: "2030-01-01T00:00:02Z",
    lastCheckedAt: null,
  });
  await take(trackerIds.oldA, "resume");

  await insertTracker(database, {
    id: trackerIds.new3,
    keyword: "new-3",
    sortOrder: 103,
    createdAt: "2030-01-01T00:00:03Z",
    lastCheckedAt: null,
  });
  await take(trackerIds.new2, "new");

  await insertTracker(database, {
    id: trackerIds.new4,
    keyword: "new-4",
    sortOrder: 104,
    createdAt: "2030-01-01T00:00:04Z",
    lastCheckedAt: null,
  });
  await take(trackerIds.oldB, "resume");
  await take(trackerIds.new3, "new");
  await take(trackerIds.oldC, "resume");
  await take(trackerIds.new4, "new");

  assert.deepEqual(claimed, [
    trackerIds.new1,
    trackerIds.oldA,
    trackerIds.new2,
    trackerIds.oldB,
    trackerIds.new3,
    trackerIds.oldC,
    trackerIds.new4,
  ]);
  assert.equal(new Set(claimed).size, claimed.length, "same-cycle claims must be unique");

  const completed = await claimNext(database);
  assert.equal(completed.status, "cycle_completed");

  const roster = await database.query(`
    select id::text, worker_last_cycle_id::text as cycle_id
    from public.naver_rank_trackers
    order by id
  `);
  assert.equal(roster.rows.length, claimed.length);
  assert.ok(roster.rows.every((row) => row.cycle_id === cycle.cycleId));
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

// PGlite exposes one exclusive database connection. This suite deliberately
// does not fake a multi-session FOR UPDATE SKIP LOCKED winner test or claim to
// cover the separate terminal commit/failure RPC contracts.

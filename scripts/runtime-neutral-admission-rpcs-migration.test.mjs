// 20260903213000 런타임 중립화 마이그레이션 회귀.
//
// 고정하려는 것: 계정 우선 등록·후보 케이던스 승격·운영 조회 RPC 가 현재
// EXPECTED 런타임(1.1.21)에서도, 아직 존재하지 않는 미래 런타임에서도 똑같이
// 동작한다.  2026-09-03 사고(런타임 리터럴 하드코딩으로 수집 2시간 정지)의
// 재발을 막는 실동작 근거다.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { calculateN30RuntimeFingerprint } from "./naver-shopping-runtime-fingerprint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260903213000_naver_shopping_runtime_neutral_admission_rpcs.sql";
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");

const EXPECTED_RUNTIME = Object.freeze({
  version: "1.1.21",
  fingerprint: "84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0",
});
// 아직 만들어지지 않은 런타임.  리터럴이 되살아나면 이 픽스처가 먼저 깨진다.
const FUTURE_RUNTIME = Object.freeze({
  version: "9.9.9",
  fingerprint: "d".repeat(64),
});

const ids = Object.freeze({
  cycle: "20000000-0000-4000-8000-000000000001",
  trackerA: "50000000-0000-4000-8000-000000000001",
  trackerB: "50000000-0000-4000-8000-000000000002",
  trackerOther: "50000000-0000-4000-8000-000000000003",
  requestOne: "10000000-0000-4000-8000-000000000001",
  requestTwo: "10000000-0000-4000-8000-000000000002",
});

const SCHEMA = `
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
  circuit_opened_at timestamptz,
  failure_signature text,
  failure_streak integer not null default 0,
  transient_system_probe_attempts integer not null default 0,
  cooldown_until timestamptz,
  last_block_code text,
  current_stage text,
  current_page integer not null default 0,
  current_job_kind text,
  current_tracker_id uuid,
  current_job_started_at timestamptz,
  probe_tracker_id uuid,
  probe_started_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_code text,
  last_collection_id text,
  last_checked_count integer,
  last_excluded_ad_count integer,
  last_duration_ms integer,
  last_source text,
  scheduler_urgent_streak integer not null default 0,
  scheduler_last_agency_code text,
  cadence_mode text not null default 'baseline',
  cadence_minutes integer not null default 10,
  stability_started_at timestamptz,
  success_streak integer not null default 0,
  scheduler_cycle_id uuid,
  scheduler_cycle_number bigint not null default 0,
  scheduler_cycle_status text not null default 'idle',
  updated_at timestamptz not null default clock_timestamp()
);

create table public.naver_rank_trackers (
  id uuid primary key,
  agency_code text not null,
  status text not null default 'active',
  keyword text not null,
  product_id text,
  sort_order integer not null,
  created_at timestamptz not null,
  next_check_at timestamptz,
  processing_started_at timestamptz,
  processing_until timestamptz,
  worker_quarantined_until timestamptz
);

create table public.naver_shopping_rank_lookup_jobs (
  id uuid primary key,
  status text not null,
  available_at timestamptz,
  processing_until timestamptz,
  expires_at timestamptz,
  attempts integer not null default 0
);

create table public.naver_shopping_account_priority_requests (
  request_id uuid primary key,
  agency_code text not null
    check (agency_code ~ '^[a-z0-9][a-z0-9:_-]{2,79}$'),
  cohort_count integer not null check (cohort_count between 1 and 1000),
  cohort_hash text not null check (cohort_hash ~ '^[a-f0-9]{32}$'),
  required_runtime_version text not null
    check (required_runtime_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'),
  required_runtime_fingerprint text not null
    check (required_runtime_fingerprint ~ '^[a-f0-9]{64}$'
      and required_runtime_fingerprint <> pg_catalog.repeat('0', 64)),
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  requested_cycle_id uuid,
  requested_cycle_number bigint,
  state text not null default 'active'
    check (state in ('active', 'completed')),
  completed_at timestamptz,
  succeeded boolean,
  check (expires_at = requested_at + interval '24 hours'),
  unique (agency_code, cohort_hash)
);

create table public.naver_shopping_account_priority_members (
  request_id uuid not null
    references public.naver_shopping_account_priority_requests(request_id),
  position integer not null check (position between 1 and 1000),
  tracker_id uuid not null,
  state text not null default 'pending',
  claimed_lease_started_at timestamptz,
  primary key (request_id, position)
);

create table public.naver_shopping_repair_priority_items (
  request_id uuid not null,
  position integer not null,
  tracker_id uuid not null,
  state text not null default 'queued',
  claimed_lease_started_at timestamptz,
  primary key (request_id, position)
);

create table public.test_reconcile_calls (
  id integer primary key,
  call_count integer not null default 0
);
insert into public.test_reconcile_calls(id) values (1);

create function mi_internal.mi_reconcile_naver_shopping_account_priority(
  p_now timestamptz
) returns void
language plpgsql
security invoker
set search_path = ''
as $reconcile$
begin
  update public.test_reconcile_calls set call_count = call_count + 1 where id = 1;
end;
$reconcile$;
`;

// 설치 가드가 요구하는 "기존 RPC 존재"를 만족시키는 자리표시자.  create or replace
// 는 인자 이름이 다르면 실패하므로 실제 시그니처와 이름을 그대로 맞춘다.
const PLACEHOLDERS = `
create function public.mi_enqueue_naver_shopping_account_priority(
  p_request_id uuid,
  p_agency_code text,
  p_expected_cohort_count integer,
  p_expected_cohort_hash text,
  p_expected_runtime_version text,
  p_expected_runtime_fingerprint text
) returns jsonb language sql as $placeholder$ select '{}'::jsonb $placeholder$;

create function public.mi_set_naver_shopping_worker_cadence(
  p_mode text
) returns jsonb language sql as $placeholder$ select '{}'::jsonb $placeholder$;

create function public.mi_get_naver_shopping_worker_operations()
returns jsonb language sql as $placeholder$ select '{}'::jsonb $placeholder$;
`;

function coordinationSeed(runtime) {
  return `
insert into public.naver_shopping_worker_coordination(
  lane_key, primary_worker_id, primary_seen_at,
  runtime_version, runtime_fingerprint,
  circuit_state, cadence_mode, cadence_minutes,
  stability_started_at, success_streak, last_success_at,
  last_collection_id, last_checked_count, last_source,
  scheduler_cycle_id, scheduler_cycle_number, scheduler_cycle_status
) values (
  'global', 'windows-desktop-primary', clock_timestamp(),
  '${runtime.version}', '${runtime.fingerprint}',
  'closed', 'baseline', 10,
  clock_timestamp() - interval '25 hours', 6, clock_timestamp(),
  'pw-chrome-20260903', 300, 'naver_shopping_results_collector',
  '${ids.cycle}'::uuid, 12, 'active'
);
`;
}

const TRACKER_SEED = `
insert into public.naver_rank_trackers(
  id, agency_code, status, keyword, product_id, sort_order, created_at
) values
  ('${ids.trackerA}'::uuid, 'mml93-a01', 'active', '남자팬티', '12491798995', 1,
    timestamptz '2026-09-01T00:00:00Z'),
  ('${ids.trackerB}'::uuid, 'mml93-a01', 'active', '남자속옷', '12491798996', 2,
    timestamptz '2026-09-01T00:01:00Z'),
  ('${ids.trackerOther}'::uuid, 'other-a02', 'active', '여자팬티', '12491798997', 3,
    timestamptz '2026-09-01T00:02:00Z');
`;

async function createDatabase(runtime, { seedCoordination = true, seedPlaceholders = true } = {}) {
  const database = new PGlite();
  await database.exec(SCHEMA);
  if (seedPlaceholders) await database.exec(PLACEHOLDERS);
  if (seedCoordination) await database.exec(coordinationSeed(runtime));
  await database.exec(TRACKER_SEED);
  return database;
}

async function cohort(database, agencyCode = "mml93-a01") {
  return (await database.query(`
    select count(*)::integer as cohort_count,
           md5(
             $1::text || ':' || string_agg(
               format('%s|%s|%s', sort_order, extract(epoch from created_at), id),
               ',' order by sort_order, created_at, id
             )
           ) as cohort_hash
    from public.naver_rank_trackers
    where status = 'active' and lower(btrim(agency_code)) = $1::text
  `, [agencyCode])).rows[0];
}

async function enqueue(database, overrides = {}) {
  const frozen = await cohort(database, overrides.agencyCode || "mml93-a01");
  return (await database.query(`
    select public.mi_enqueue_naver_shopping_account_priority(
      $1::uuid, $2::text, $3::integer, $4::text, $5::text, $6::text
    ) as result
  `, [
    overrides.requestId || ids.requestOne,
    overrides.agencyCode || "mml93-a01",
    overrides.cohortCount ?? frozen.cohort_count,
    overrides.cohortHash ?? frozen.cohort_hash,
    overrides.version,
    overrides.fingerprint,
  ])).rows[0].result;
}

async function operations(database) {
  return (await database.query(
    "select public.mi_get_naver_shopping_worker_operations() as result",
  )).rows[0].result;
}

async function setCadence(database, mode) {
  return (await database.query(
    "select public.mi_set_naver_shopping_worker_cadence($1::text) as result",
    [mode],
  )).rows[0].result;
}

test("정확히 세 RPC 만 재선언하고 런타임 리터럴을 남기지 않는다", () => {
  const blocks = [...migration.matchAll(
    /create or replace function (?:public|mi_internal)\.([a-z0-9_]+)\([\s\S]*?\n\$\$;/giu,
  )];
  assert.deepEqual(blocks.map((block) => block[1]).sort(), [
    "mi_enqueue_naver_shopping_account_priority",
    "mi_get_naver_shopping_worker_operations",
    "mi_set_naver_shopping_worker_cadence",
  ]);
  for (const block of blocks) {
    assert.match(block[0], /security invoker/iu, block[1]);
    assert.match(block[0], /set search_path = ''/iu, block[1]);
    assert.doesNotMatch(block[0], /'\d+\.\d+\.\d+'/u, block[1]);
    assert.doesNotMatch(block[0], /'[0-9a-f]{64}'/iu, block[1]);
    assert.doesNotMatch(block[0], /expected_runtime_(?:version|fingerprint)\s+constant/u, block[1]);
  }
  assert.match(migration, /or v_expected_runtime_version !~ '\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$'/u);
  assert.match(migration, /or v_expected_runtime_fingerprint !~ '\^\[a-f0-9\]\{64\}\$'/u);
  assert.equal(
    (migration.match(/current_row\.runtime_version ~ '\^\[0-9\]\+/gu) || []).length,
    2,
  );
  assert.match(migration, /^begin;$/mu);
  assert.match(migration, /^commit;$/mu);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon|authenticated);/iu);
  assert.equal((migration.match(/to service_role;/gu) || []).length, 3);
});

test("EXPECTED 런타임 지문은 저장소 계산값과 같다", () => {
  const calculated = calculateN30RuntimeFingerprint({
    repositoryRoot: root,
    version: EXPECTED_RUNTIME.version,
  });
  assert.equal(calculated.fingerprint, EXPECTED_RUNTIME.fingerprint);
});

test("설치 가드: 대상 RPC 가 없으면 적용을 거부한다", async (t) => {
  const database = await createDatabase(EXPECTED_RUNTIME, { seedPlaceholders: false });
  t.after(() => database.close());
  await assert.rejects(
    database.exec(migration),
    /naver_shopping_runtime_neutral_admission_requires_existing_rpcs/u,
  );
});

test("설치 가드: coordination 행이 없으면 적용을 거부한다", async (t) => {
  const database = await createDatabase(EXPECTED_RUNTIME, { seedCoordination: false });
  t.after(() => database.close());
  await assert.rejects(
    database.exec(migration),
    /naver_shopping_runtime_neutral_admission_requires_coordination/u,
  );
});

for (const runtime of [EXPECTED_RUNTIME, FUTURE_RUNTIME]) {
  const label = `런타임 ${runtime.version}`;

  test(`${label}: 계정 우선 등록이 코호트를 얼린다`, async (t) => {
    const database = await createDatabase(runtime);
    t.after(() => database.close());
    await database.exec(migration);

    const accepted = await enqueue(database, {
      version: runtime.version,
      fingerprint: runtime.fingerprint,
    });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.idempotent, false);
    assert.equal(accepted.state, "active");
    assert.equal(accepted.cohortCount, 2);

    const stored = (await database.query(`
      select agency_code, cohort_count, required_runtime_version,
             required_runtime_fingerprint, requested_cycle_number, state
      from public.naver_shopping_account_priority_requests
      where request_id = $1::uuid
    `, [ids.requestOne])).rows[0];
    assert.deepEqual(stored, {
      agency_code: "mml93-a01",
      cohort_count: 2,
      required_runtime_version: runtime.version,
      required_runtime_fingerprint: runtime.fingerprint,
      requested_cycle_number: 12,
      state: "active",
    });

    assert.deepEqual((await database.query(`
      select position, tracker_id
      from public.naver_shopping_account_priority_members
      where request_id = $1::uuid
      order by position
    `, [ids.requestOne])).rows, [
      { position: 1, tracker_id: ids.trackerA },
      { position: 2, tracker_id: ids.trackerB },
    ]);

    assert.equal(
      (await database.query("select call_count from public.test_reconcile_calls where id = 1"))
        .rows[0].call_count,
      1,
    );
  });

  test(`${label}: 같은 요청 재호출은 멱등이고 다른 요청은 충돌한다`, async (t) => {
    const database = await createDatabase(runtime);
    t.after(() => database.close());
    await database.exec(migration);
    await enqueue(database, { version: runtime.version, fingerprint: runtime.fingerprint });

    const replay = await enqueue(database, {
      version: runtime.version,
      fingerprint: runtime.fingerprint,
    });
    assert.equal(replay.accepted, true);
    assert.equal(replay.idempotent, true);

    await assert.rejects(
      enqueue(database, {
        requestId: ids.requestTwo,
        version: runtime.version,
        fingerprint: runtime.fingerprint,
      }),
      /naver_shopping_account_priority_active_conflict/u,
    );
  });

  test(`${label}: 후보 케이던스 승격과 운영 조회가 동일하게 판정한다`, async (t) => {
    const database = await createDatabase(runtime);
    t.after(() => database.close());
    await database.exec(migration);

    const before = await operations(database);
    assert.equal(before.candidate_eligible, true);
    assert.equal(before.runtime_version, runtime.version);
    assert.equal(before.cadence_mode, "baseline");

    const promoted = await setCadence(database, "candidate");
    assert.deepEqual(promoted, {
      accepted: true, activated: true, mode: "candidate", minutes: 6,
    });
    assert.deepEqual(
      (await database.query(
        "select cadence_mode, cadence_minutes from public.naver_shopping_worker_coordination where lane_key = 'global'",
      )).rows[0],
      { cadence_mode: "candidate", cadence_minutes: 6 },
    );

    const restored = await setCadence(database, "baseline");
    assert.deepEqual(restored, {
      accepted: true, activated: true, mode: "baseline", minutes: 10,
    });
  });

  test(`${label}: 런타임 아이덴티티가 비면 후보 승격을 막는다`, async (t) => {
    const database = await createDatabase(runtime);
    t.after(() => database.close());
    await database.exec(migration);
    await database.exec(`
      update public.naver_shopping_worker_coordination
      set runtime_version = null, runtime_fingerprint = null
      where lane_key = 'global'
    `);

    assert.equal((await operations(database)).candidate_eligible, false);
    const rejected = await setCadence(database, "candidate");
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, "not_eligible");
  });
}

test("형식이 어긋난 런타임 아이덴티티는 여전히 거부한다", async (t) => {
  const database = await createDatabase(EXPECTED_RUNTIME);
  t.after(() => database.close());
  await database.exec(migration);

  for (const [version, fingerprint] of [
    ["1.1", EXPECTED_RUNTIME.fingerprint],
    ["v1.1.21", EXPECTED_RUNTIME.fingerprint],
    ["", EXPECTED_RUNTIME.fingerprint],
    [EXPECTED_RUNTIME.version, "z".repeat(64)],
    [EXPECTED_RUNTIME.version, "a".repeat(63)],
    [EXPECTED_RUNTIME.version, ""],
  ]) {
    await assert.rejects(
      enqueue(database, { version, fingerprint }),
      /naver_shopping_account_priority_invalid/u,
      `${version} / ${fingerprint.slice(0, 8)}`,
    );
  }
});

test("형식은 맞지만 설치된 런타임이 아니면 idle-control 계약이 막는다", async (t) => {
  const database = await createDatabase(EXPECTED_RUNTIME);
  t.after(() => database.close());
  await database.exec(migration);

  await assert.rejects(
    enqueue(database, {
      version: FUTURE_RUNTIME.version,
      fingerprint: FUTURE_RUNTIME.fingerprint,
    }),
    /naver_shopping_account_priority_requires_idle_control/u,
  );
  await assert.rejects(
    enqueue(database, {
      version: EXPECTED_RUNTIME.version,
      fingerprint: FUTURE_RUNTIME.fingerprint,
    }),
    /naver_shopping_account_priority_requires_idle_control/u,
  );
  assert.equal(
    (await database.query(
      "select count(*)::integer as count from public.naver_shopping_account_priority_requests",
    )).rows[0].count,
    0,
  );
});

test("코호트 선조건과 유휴 제어면 회귀가 유지된다", async (t) => {
  const database = await createDatabase(FUTURE_RUNTIME);
  t.after(() => database.close());
  await database.exec(migration);

  await assert.rejects(
    enqueue(database, {
      version: FUTURE_RUNTIME.version,
      fingerprint: FUTURE_RUNTIME.fingerprint,
      cohortCount: 1,
    }),
    /naver_shopping_account_priority_cohort_precondition_failed/u,
  );
  await assert.rejects(
    enqueue(database, {
      version: FUTURE_RUNTIME.version,
      fingerprint: FUTURE_RUNTIME.fingerprint,
      cohortHash: "f".repeat(32),
    }),
    /naver_shopping_account_priority_cohort_precondition_failed/u,
  );

  await database.exec(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = 'windows-desktop-primary'
    where lane_key = 'global'
  `);
  await assert.rejects(
    enqueue(database, {
      version: FUTURE_RUNTIME.version,
      fingerprint: FUTURE_RUNTIME.fingerprint,
    }),
    /naver_shopping_account_priority_requires_idle_control/u,
  );
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = null, scheduler_cycle_status = 'idle'
    where lane_key = 'global'
  `);
  await assert.rejects(
    enqueue(database, {
      version: FUTURE_RUNTIME.version,
      fingerprint: FUTURE_RUNTIME.fingerprint,
    }),
    /naver_shopping_account_priority_requires_idle_control/u,
  );

  await database.exec(`
    update public.naver_shopping_worker_coordination
    set scheduler_cycle_status = 'active'
    where lane_key = 'global'
  `);
  await database.exec(`
    insert into public.naver_shopping_repair_priority_items(
      request_id, position, tracker_id, state
    ) values ('${ids.requestTwo}'::uuid, 1, '${ids.trackerA}'::uuid, 'queued')
  `);
  await assert.rejects(
    enqueue(database, {
      version: FUTURE_RUNTIME.version,
      fingerprint: FUTURE_RUNTIME.fingerprint,
    }),
    /naver_shopping_account_priority_legacy_conflict/u,
  );

  await database.exec("delete from public.naver_shopping_repair_priority_items");
  const accepted = await enqueue(database, {
    version: FUTURE_RUNTIME.version,
    fingerprint: FUTURE_RUNTIME.fingerprint,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.cohortCount, 2);
});

test("진행 중 작업이 있으면 계정 우선 등록을 막는다", async (t) => {
  const database = await createDatabase(FUTURE_RUNTIME);
  t.after(() => database.close());
  await database.exec(migration);
  await database.exec(`
    update public.naver_rank_trackers
    set processing_until = clock_timestamp() + interval '5 minutes'
    where id = '${ids.trackerA}'::uuid
  `);
  await assert.rejects(
    enqueue(database, {
      version: FUTURE_RUNTIME.version,
      fingerprint: FUTURE_RUNTIME.fingerprint,
    }),
    /naver_shopping_account_priority_requires_idle_control/u,
  );
});

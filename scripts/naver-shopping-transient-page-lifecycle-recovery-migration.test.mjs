// 묶음 2차-5 (F3·F4) 회귀 테스트.
//
// F3: 일시적인 네이버 오류 페이지가 2회 연속이면 회로가 open 되는데, 그 서명이
//     자동 half_open 허용 목록에 없어 사람이 수동 canary 를 돌릴 때까지 전
//     트래커가 멈춘다. 재시도로 풀리는 페이지·읽기 계열 코드를 기존 규약
//     (primary 전용 · 30분 정적 · 최대 2회 프로브)으로 자동 복구시킨다.
// F4: 수집 중 추적기 삭제·중지가 system 스코프 local_worker_lease_lost 로
//     집계돼 연속 2회면 회로가 열리고 자동 복구도 안 된다. 그 두 경우만
//     tracker 스코프로 강등한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");

const PRIOR_MIGRATION_NAME = "20260903113000_naver_shopping_account_priority_gate_runtime_neutral.sql";
const MIGRATION_PATTERN =
  /^\d{14}_naver_shopping_transient_page_half_open_and_tracker_lifecycle_lease\.sql$/u;

const migrationNames = fs.readdirSync(migrationDirectory).filter((name) => MIGRATION_PATTERN.test(name));
const migrationName = migrationNames[0] || "";
const migration = migrationName
  ? fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8")
  : "";

// 재시도로 풀리는 성격이 코드에서 확인된 코드만 자동 복구 대상에 넣는다.
const ADDED_TRANSIENT_CODES = Object.freeze([
  "naver_next_data_missing",
  "naver_page_script_failed",
  "naver_page_read_state_unstable",
  "naver_page_navigation_result_missing",
]);
// 기존 목록은 그대로 유지되어야 한다.
const EXISTING_TRANSIENT_CODES = Object.freeze([
  "native_host_response_timeout",
  "provider_deadline_exceeded",
  "native_host_input_closed",
  "naver_page_timeout",
  "naver_page_script_timeout",
  "local_worker_commit_unavailable",
]);
// 보안 차단·드리프트·성격 미상 catch-all 은 절대 자동 복구하지 않는다.
const NEVER_AUTO_RECOVERED_CODES = Object.freeze([
  "naver_http_403",
  "naver_http_418",
  "naver_http_429",
  "naver_access_blocked",
  "naver_captcha_detected",
  "naver_auth_required",
  "naver_verification_required",
  "naver_network_restricted",
  "naver_selector_drift",
  "naver_next_data_schema_drift",
  "naver_next_data_rank_drift",
  "naver_navigation_invalid",
  "provider_browser_collection_failed",
  "local_worker_lease_lost",
]);

const LANE_TOKEN = "3f2a1c44-5c1b-4e2a-9b6d-1f0a8c7d2e31";
const RUN_ID = "8c1d5b2e-9a3f-4d61-8f52-2b7e0c4a6d19";
const TRACKER_ID = "d41c6a72-3b58-4e0f-9c21-7a5e8d0b4f63";
const PRIMARY = "windows-desktop-primary";

function requireMigration() {
  assert.equal(migrationNames.length, 1, "F3·F4 추가 마이그레이션은 정확히 한 개여야 합니다.");
  assert.ok(migrationName > PRIOR_MIGRATION_NAME, "게이트 런타임 중립화 마이그레이션 뒤에 와야 합니다.");
  assert.ok(migration.length > 0, "마이그레이션을 읽을 수 있어야 합니다.");
}

function functionBlock(name) {
  const match = migration.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ));
  return match?.[0] || "";
}

function withoutComments(source) {
  return source.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
}

async function createFixture(database) {
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role;

    create type public.naver_rank_tracker_status as enum ('active', 'paused', 'completed', 'failed');

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
      cadence_mode text default 'baseline',
      cadence_minutes integer default 10,
      stability_started_at timestamptz,
      success_streak integer default 0,
      scheduler_cycle_id uuid,
      scheduler_cycle_status text,
      updated_at timestamptz default now()
    );

    create table public.naver_rank_trackers (
      id uuid primary key,
      agency_code text not null default 'mml93-a01',
      status public.naver_rank_tracker_status not null default 'active',
      retry_count integer not null default 0,
      worker_quarantined_until timestamptz,
      processing_started_at timestamptz,
      processing_until timestamptz,
      last_message text
    );

    create table public.naver_shopping_worker_runs (
      run_id uuid,
      worker_id text,
      runtime_version text,
      runtime_fingerprint text
    );

    create table public.naver_shopping_scheduler_events (
      event_id bigserial primary key,
      event_type text,
      run_id uuid,
      claim_id uuid,
      group_fingerprint text,
      worker_id text,
      tracker_id uuid,
      error_code text,
      collection_id text,
      priority text,
      lease_started_at timestamptz
    );
  `);
  await database.exec(migration);
}

async function seedLane(database, overrides = {}) {
  const columns = {
    lane_key: "'global'",
    circuit_state: "'closed'",
    circuit_reason: "null",
    circuit_opened_at: "null",
    failure_signature: "null",
    failure_streak: "0",
    transient_system_probe_attempts: "0",
    primary_worker_id: `'${PRIMARY}'`,
    primary_seen_at: "now()",
    cadence_mode: "'baseline'",
    cadence_minutes: "10",
    current_page: "0",
    runtime_version: "'1.1.21'",
    runtime_fingerprint: "'84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0'",
    ...overrides,
  };
  await database.exec("delete from public.naver_shopping_worker_coordination;");
  await database.exec(
    `insert into public.naver_shopping_worker_coordination (${Object.keys(columns).join(", ")}) `
    + `values (${Object.values(columns).join(", ")});`,
  );
}

async function claimAsPrimary(database, role = "primary") {
  const result = await database.query(
    "select public.mi_claim_naver_shopping_worker_lane($1, $2, $3, 2100, 180) as claim",
    [PRIMARY, role, LANE_TOKEN],
  );
  return result.rows[0].claim;
}

async function lane(database) {
  const result = await database.query("select * from public.naver_shopping_worker_coordination where lane_key = 'global'");
  return result.rows[0];
}

async function recordSystemFailure(database, errorCode, trackerId = TRACKER_ID) {
  const result = await database.query(
    "select public.mi_record_naver_shopping_worker_failure($1, $2, $3, $4, 'system', $5) as failure",
    [PRIMARY, LANE_TOKEN, RUN_ID, errorCode, trackerId],
  );
  return result.rows[0].failure;
}

// 실행 중 레인(리스 보유 + collecting 단계)을 만들어 record-failure 전제조건을 맞춘다.
async function holdLease(database) {
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = '${PRIMARY}',
        lease_token = '${LANE_TOKEN}',
        lease_until = now() + interval '30 minutes',
        run_id = '${RUN_ID}',
        current_stage = 'collecting',
        current_page = 3,
        current_job_kind = 'tracker',
        current_tracker_id = '${TRACKER_ID}',
        current_job_started_at = now()
    where lane_key = 'global';
  `);
}

test("F3·F4 마이그레이션은 게이트 중립화 뒤에 추가된 단일 파일이다", () => {
  requireMigration();
  assert.match(migration, /^begin;$/mu);
  assert.match(migration, /^commit;$/mu);
});

test("자동 half_open 허용 목록에 일시성 페이지 계열 코드가 두 자리 모두 추가된다", () => {
  requireMigration();
  const claim = functionBlock("mi_claim_naver_shopping_worker_lane");
  assert.ok(claim.length > 0, "레인 클레임 함수를 재선언해야 합니다.");

  const eligibility = claim.match(/and transient_failure_code in \(([\s\S]*?)\)/u)?.[1] || "";
  const guardedUpdate = claim.match(
    /and split_part\(lower\(trim\(coalesce\(last_failure_code, ''\)\)\), ':', 1\) in \(([\s\S]*?)\)/u,
  )?.[1] || "";
  assert.ok(eligibility.length > 0 && guardedUpdate.length > 0, "허용 목록 두 자리를 모두 찾아야 합니다.");

  for (const code of [...EXISTING_TRANSIENT_CODES, ...ADDED_TRANSIENT_CODES]) {
    assert.ok(eligibility.includes(`'${code}'`), `eligibility IF 에 ${code} 가 필요합니다.`);
    assert.ok(guardedUpdate.includes(`'${code}'`), `guarded UPDATE 에 ${code} 가 필요합니다.`);
  }
  for (const code of NEVER_AUTO_RECOVERED_CODES) {
    assert.ok(!eligibility.includes(`'${code}'`), `${code} 는 자동 복구 대상이 되면 안 됩니다.`);
    assert.ok(!guardedUpdate.includes(`'${code}'`), `${code} 는 자동 복구 대상이 되면 안 됩니다.`);
  }
});

test("기존 쿨다운 규약(primary 전용·30분·최대 2회)이 그대로 유지된다", () => {
  requireMigration();
  const claim = functionBlock("mi_claim_naver_shopping_worker_lane");
  assert.match(claim, /transient_system_probe_attempts < 2/u);
  assert.match(claim, /circuit_opened_at <= v_now - interval '30 minutes'/u);
  assert.match(claim, /circuit_opened_at <= v_now - interval '10 minutes'/u);
  assert.match(claim, /and normalized_worker_role = 'primary'/u);
  assert.match(claim, /transient_system_probe_attempts = least\(2, current_row\.transient_system_probe_attempts \+ 1\)/u);
});

test("재선언한 실패 기록 함수는 런타임 버전·지문 리터럴을 새로 하드코딩하지 않는다", () => {
  requireMigration();
  const failure = functionBlock("mi_record_naver_shopping_worker_failure");
  assert.ok(failure.length > 0, "실패 기록 함수를 재선언해야 합니다.");
  const sql = withoutComments(migration);
  assert.ok(!/1\.1\.2\d/u.test(sql), "SQL 본문에 런타임 버전 리터럴이 남으면 안 됩니다.");
  assert.ok(
    !/[0-9a-f]{64}/u.test(sql),
    "SQL 본문에 런타임 지문 리터럴이 남으면 안 됩니다.",
  );
  assert.ok(!/expected_runtime_(version|fingerprint)/u.test(failure));
  assert.match(failure, /current_row\.runtime_version is not null/u);
  assert.match(failure, /current_row\.runtime_fingerprint is not null/u);
  assert.match(failure, /runs\.runtime_version = current_row\.runtime_version/u);
  assert.match(failure, /runs\.runtime_fingerprint = current_row\.runtime_fingerprint/u);
});

test("service_role 전용 실행 권한이 두 함수 모두 재확인된다", () => {
  requireMigration();
  assert.match(
    migration,
    /revoke all on function public\.mi_claim_naver_shopping_worker_lane\(text, text, uuid, integer, integer\)\s+from public, anon, authenticated, service_role;/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.mi_claim_naver_shopping_worker_lane\(text, text, uuid, integer, integer\)\s+to service_role;/u,
  );
  assert.match(
    migration,
    /revoke all on function public\.mi_record_naver_shopping_worker_failure\(\s*text, uuid, uuid, text, text, uuid\s*\) from public, anon, authenticated, service_role;/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.mi_record_naver_shopping_worker_failure\(\s*text, uuid, uuid, text, text, uuid\s*\) to service_role;/u,
  );
});

test("일시성 페이지 실패 2회로 열린 회로가 30분 뒤 primary 프로브로 자동 복구된다", async () => {
  requireMigration();
  const database = new PGlite();
  try {
    await createFixture(database);
    await seedLane(database);
    await database.query(
      "insert into public.naver_rank_trackers (id, status) values ($1, 'active')",
      [TRACKER_ID],
    );

    // 1회차: 서명만 쌓이고 회로는 닫힌 채 레인을 유지한다.
    await holdLease(database);
    const first = await recordSystemFailure(database, "naver_next_data_missing");
    assert.equal(first.recorded, true);
    assert.equal(first.failureStreak, 1);
    assert.equal(first.laneReleased, false);

    // 2회차: 같은 서명이 반복되면 회로가 열리고 레인이 풀린다.
    await holdLease(database);
    const second = await recordSystemFailure(database, "naver_next_data_missing");
    assert.equal(second.recorded, true);
    assert.equal(second.failureStreak, 2);
    assert.equal(second.circuitState, "open");
    assert.equal(second.laneReleased, true);

    const opened = await lane(database);
    assert.equal(opened.circuit_state, "open");
    assert.equal(opened.circuit_reason, "collecting:naver_next_data_missing");
    assert.equal(opened.failure_signature, "collecting:naver_next_data_missing");
    assert.equal(opened.last_failure_code, "naver_next_data_missing");

    // 30분 정적 이전에는 자동 복구가 없다.
    const tooEarly = await claimAsPrimary(database);
    assert.equal(tooEarly.granted, false);
    assert.equal(tooEarly.reason, "circuit_open");

    await database.exec(`
      update public.naver_shopping_worker_coordination
      set circuit_opened_at = now() - interval '31 minutes',
          primary_seen_at = now()
      where lane_key = 'global';
    `);

    // standby 는 여전히 복구 주체가 아니다.
    const standby = await claimAsPrimary(database, "standby");
    assert.equal(standby.granted, false);
    assert.equal(standby.reason, "circuit_open");

    const recovered = await claimAsPrimary(database);
    assert.equal(recovered.granted, true);
    assert.equal(recovered.circuitState, "half_open");
    assert.equal(recovered.autoRecovery, true);

    const probing = await lane(database);
    assert.equal(probing.circuit_state, "half_open");
    assert.equal(probing.circuit_reason, "auto_transient_system_probe");
    assert.equal(probing.transient_system_probe_attempts, 1);
    assert.equal(probing.failure_streak, 0);
    assert.equal(probing.failure_signature, null);
    assert.equal(probing.cadence_minutes, 10);
  } finally {
    await database.close();
  }
});

test("자동 복구 프로브는 두 번까지만 허용된다", async () => {
  requireMigration();
  const database = new PGlite();
  try {
    await createFixture(database);
    await seedLane(database, {
      circuit_state: "'open'",
      circuit_reason: "'collecting:naver_page_script_failed'",
      failure_signature: "'collecting:naver_page_script_failed'",
      circuit_opened_at: "now() - interval '45 minutes'",
      last_failure_code: "'naver_page_script_failed'",
      failure_streak: "2",
      transient_system_probe_attempts: "2",
    });
    const blocked = await claimAsPrimary(database);
    assert.equal(blocked.granted, false);
    assert.equal(blocked.reason, "circuit_open");
    assert.equal((await lane(database)).circuit_state, "open");
  } finally {
    await database.close();
  }
});

test("보안 차단·드리프트·성격 미상 코드는 자동 복구되지 않는다(fail-closed 회귀)", async () => {
  requireMigration();
  for (const code of NEVER_AUTO_RECOVERED_CODES) {
    const database = new PGlite();
    try {
      await createFixture(database);
      await seedLane(database, {
        circuit_state: "'open'",
        circuit_reason: `'collecting:${code}'`,
        failure_signature: `'collecting:${code}'`,
        circuit_opened_at: "now() - interval '6 hours'",
        last_failure_code: `'${code}'`,
        failure_streak: "2",
        transient_system_probe_attempts: "0",
      });
      const result = await claimAsPrimary(database);
      assert.equal(result.granted, false, `${code} 는 자동 복구되면 안 됩니다.`);
      assert.equal(result.reason, "circuit_open", `${code} 는 회로를 열어 둔 채여야 합니다.`);
      assert.equal((await lane(database)).circuit_state, "open");
    } finally {
      await database.close();
    }
  }
});

test("나머지 일시성 코드는 기존과 동일한 30분 규약으로 계속 복구된다", async () => {
  requireMigration();
  for (const code of [...EXISTING_TRANSIENT_CODES, ...ADDED_TRANSIENT_CODES]) {
    const database = new PGlite();
    try {
      await createFixture(database);
      await seedLane(database, {
        circuit_state: "'open'",
        circuit_reason: `'collecting:${code}'`,
        failure_signature: `'collecting:${code}'`,
        circuit_opened_at: "now() - interval '31 minutes'",
        last_failure_code: `'${code}'`,
        failure_streak: "2",
        transient_system_probe_attempts: "0",
      });
      const result = await claimAsPrimary(database);
      assert.equal(result.granted, true, `${code} 는 자동 복구되어야 합니다.`);
      assert.equal(result.circuitState, "half_open");
      assert.equal(result.autoRecovery, true);
    } finally {
      await database.close();
    }
  }
});

test("수집 중 추적기 삭제는 회로 서명에 쌓이지 않는다", async () => {
  requireMigration();
  const database = new PGlite();
  try {
    await createFixture(database);
    await seedLane(database);
    // 추적기 행이 없다 = 수집 중 삭제됨.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await holdLease(database);
      const failure = await recordSystemFailure(database, "local_worker_lease_lost");
      assert.equal(failure.recorded, true);
      assert.equal(failure.circuitState, "closed");
      assert.equal(failure.laneReleased, false);
      assert.equal(failure.quarantined, false);
      assert.equal(failure.scopeDemoted, "tracker_lifecycle");
      assert.equal(failure.failureStreak, 0);
    }
    const after = await lane(database);
    assert.equal(after.circuit_state, "closed");
    assert.equal(after.failure_signature, null);
    assert.equal(after.failure_streak, 0);
    assert.equal(after.last_failure_code, "local_worker_lease_lost");
    assert.equal(after.cadence_minutes, 10);
    assert.equal(after.success_streak, 0);
  } finally {
    await database.close();
  }
});

test("수집 중 추적기 일시중지도 같은 기준으로 강등된다", async () => {
  requireMigration();
  for (const status of ["paused", "completed", "failed"]) {
    const database = new PGlite();
    try {
      await createFixture(database);
      await seedLane(database);
      await database.query(
        "insert into public.naver_rank_trackers (id, status) values ($1, $2)",
        [TRACKER_ID, status],
      );
      await holdLease(database);
      const first = await recordSystemFailure(database, "local_worker_lease_lost");
      await holdLease(database);
      const second = await recordSystemFailure(database, "local_worker_lease_lost");
      assert.equal(first.scopeDemoted, "tracker_lifecycle", `${status} 는 강등되어야 합니다.`);
      assert.equal(second.scopeDemoted, "tracker_lifecycle");
      assert.equal(second.circuitState, "closed");
      const after = await lane(database);
      assert.equal(after.circuit_state, "closed");
      assert.equal(after.failure_signature, null);
      // 강등해도 추적기를 격리하지는 않는다(사용자가 끈 추적기다).
      const tracker = await database.query(
        "select worker_quarantined_until from public.naver_rank_trackers where id = $1",
        [TRACKER_ID],
      );
      assert.equal(tracker.rows[0].worker_quarantined_until, null);
    } finally {
      await database.close();
    }
  }
});

test("추적기가 그대로 살아 있는 lease 상실은 여전히 시스템 실패로 회로를 연다", async () => {
  requireMigration();
  const database = new PGlite();
  try {
    await createFixture(database);
    await seedLane(database);
    await database.query(
      "insert into public.naver_rank_trackers (id, status) values ($1, 'active')",
      [TRACKER_ID],
    );

    await holdLease(database);
    const first = await recordSystemFailure(database, "local_worker_lease_lost");
    assert.equal(first.failureStreak, 1);
    assert.equal(first.scopeDemoted, undefined);

    await holdLease(database);
    const second = await recordSystemFailure(database, "local_worker_lease_lost");
    assert.equal(second.failureStreak, 2);
    assert.equal(second.circuitState, "open");
    assert.equal(second.laneReleased, true);

    const after = await lane(database);
    assert.equal(after.circuit_state, "open");
    assert.equal(after.circuit_reason, "collecting:local_worker_lease_lost");

    // 리스 만료·소유권 불일치는 자동 복구 대상이 아니다.
    await database.exec(`
      update public.naver_shopping_worker_coordination
      set circuit_opened_at = now() - interval '6 hours', primary_seen_at = now()
      where lane_key = 'global';
    `);
    const blocked = await claimAsPrimary(database);
    assert.equal(blocked.granted, false);
    assert.equal(blocked.reason, "circuit_open");
  } finally {
    await database.close();
  }
});

test("강등은 lease 상실 코드에만 적용되고 다른 시스템 실패는 그대로 집계된다", async () => {
  requireMigration();
  const database = new PGlite();
  try {
    await createFixture(database);
    await seedLane(database);
    // 추적기는 삭제된 상태지만 코드가 lease 상실이 아니면 강등하지 않는다.
    await holdLease(database);
    const failure = await recordSystemFailure(database, "naver_next_data_missing");
    assert.equal(failure.scopeDemoted, undefined);
    assert.equal(failure.failureStreak, 1);
    assert.equal((await lane(database)).failure_signature, "collecting:naver_next_data_missing");
  } finally {
    await database.close();
  }
});

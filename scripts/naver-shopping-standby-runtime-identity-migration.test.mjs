import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

// 2026-09-19: 주작업기가 꺼진 채 런타임 1.1.32 를 올리자 대기기가 70분간 `runtime_identity_invalid` 로 거절됐다
// (런타임 마이그레이션이 코디네이션 정체를 NULL 로 비우고, 그 값은 주작업기 첫 런으로만 채워졌다).
// 정체가 통째로 비어 있고 주작업기가 무신호일 때에 한해 대기기를 허용하는 마이그레이션을 PGlite 로 고정한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrations = path.join(root, "supabase", "migrations");
const priorName = "20260919010000_naver_shopping_standby_navigation_recovery.sql";
const handoffSql = fs.readFileSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "supabase", "migrations", "20260910055050_naver_shopping_bounded_standby_half_open_handoff.sql"), "utf8");
const nextPattern = /^\d{14}_naver_shopping_standby_runtime_identity_registration\.sql$/u;
const nextNames = fs.readdirSync(migrations).filter((name) => nextPattern.test(name));
const nextName = nextNames[0] || "";
const priorSql = fs.readFileSync(path.join(migrations, priorName), "utf8");
const basePriorClaim = fs.readFileSync(path.join(migrations, "20260903160000_naver_shopping_transient_page_half_open_and_tracker_lifecycle_lease.sql"), "utf8").match(
  /create or replace function public\.mi_claim_naver_shopping_worker_lane\([\s\S]*?\n\$\$;/iu,
)?.[0] || "";
const nextSql = nextName ? fs.readFileSync(path.join(migrations, nextName), "utf8") : "";
const priorClaim = priorSql.match(
  /create or replace function public\.mi_claim_naver_shopping_worker_lane\([\s\S]*?\n\$\$;/iu,
)?.[0] || "";

const PRIMARY = "windows-desktop-primary";
const STANDBY = "macbook-standby";
const PRIMARY_TOKEN = "11111111-1111-4111-8111-111111111111";
const STANDBY_TOKEN = "22222222-2222-4222-8222-222222222222";
const OTHER_TOKEN = "33333333-3333-4333-8333-333333333333";
const VERSION = "1.1.21";
const FINGERPRINT = "84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0";
const TRANSIENT = "naver_page_script_failed";

async function fixture({ green = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;

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
      status text not null default 'active',
      processing_until timestamptz
    );

    create table public.naver_shopping_rank_lookup_jobs (
      id uuid primary key,
      status text,
      processing_until timestamptz
    );

    create table public.naver_shopping_worker_runs (
      run_id uuid primary key,
      worker_id text,
      runtime_version text,
      runtime_fingerprint text
    );
  `);
  // 실제 적용 순서대로 쌓는다: 0903 의 lane 함수 → 0910 전체(인계 컬럼 추가 + 7인자 함수) → 이번 마이그레이션.
  await db.exec(basePriorClaim);
  await db.exec(handoffSql);
  await db.exec(priorSql);
  if (green) await db.exec(nextSql);
  return db;
}

async function seed(db, overrides = {}) {
  const values = {
    lane_key: "'global'",
    circuit_state: "'closed'",
    circuit_reason: "null",
    circuit_opened_at: "null",
    failure_signature: "null",
    failure_streak: "0",
    transient_system_probe_attempts: "0",
    primary_worker_id: `'${PRIMARY}'`,
    primary_seen_at: "now()",
    runtime_version: `'${VERSION}'`,
    runtime_fingerprint: `'${FINGERPRINT}'`,
    last_success_at: "now() - interval '1 hour'",
    current_page: "0",
    cadence_mode: "'baseline'",
    cadence_minutes: "10",
    ...overrides,
  };
  await db.exec("delete from public.naver_shopping_worker_coordination;");
  await db.exec("delete from public.naver_shopping_worker_runs;");
  await db.exec(
    `insert into public.naver_shopping_worker_coordination (${Object.keys(values).join(", ")}) values (${Object.values(values).join(", ")});`,
  );
  await db.query(
    "insert into public.naver_shopping_worker_runs (run_id, worker_id, runtime_version, runtime_fingerprint) values ($1, $2, $3, $4)",
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", PRIMARY, VERSION, FINGERPRINT],
  );
}

async function claim(
  db,
  workerId,
  role,
  token,
  runtimeVersion = VERSION,
  runtimeFingerprint = FINGERPRINT,
) {
  const result = await db.query(
    "select public.mi_claim_naver_shopping_worker_lane($1, $2, $3, 2100, 180, $4, $5) as claim",
    [workerId, role, token, runtimeVersion, runtimeFingerprint],
  );
  return result.rows[0].claim;
}

async function lane(db) {
  return (await db.query(
    "select * from public.naver_shopping_worker_coordination where lane_key = 'global'",
  )).rows[0];
}

function opened(attempts = 0, extra = {}) {
  return {
    circuit_state: "'open'",
    circuit_reason: `'collecting:${TRANSIENT}'`,
    circuit_opened_at: "now() - interval '31 minutes'",
    failure_signature: `'collecting:${TRANSIENT}'`,
    failure_streak: "2",
    transient_system_probe_attempts: String(attempts),
    last_failure_code: `'${TRANSIENT}'`,
    ...extra,
  };
}


const UNSET = { runtime_version: "null", runtime_fingerprint: "null", primary_seen_at: "now() - interval '1 hour'" };

test("migration re-declares only the lane claim and changes only the standby identity gate", () => {
  assert.equal(nextNames.length, 1);
  assert.ok(nextName > priorName);
  assert.equal((nextSql.match(/create or replace function/giu) || []).length, 1);
  assert.match(nextSql, /^begin;$/mu);
  assert.match(nextSql, /^commit;$/mu);
  assert.match(nextSql, /security invoker/u);
  assert.match(nextSql, /set search_path = ''/u);
  assert.match(nextSql, /grant execute on function public\.mi_claim_naver_shopping_worker_lane\([\s\S]*?to service_role;/u);
  assert.doesNotMatch(nextSql, /\b1\.1\.\d+\b|[a-f0-9]{64}/u, "no runtime literal may be carried");
  const nextClaim = nextSql.match(/create or replace function public\.mi_claim_naver_shopping_worker_lane\([\s\S]*?\n\$\$;/iu)?.[0] || "";
  const added = nextClaim.slice(nextClaim.indexOf("      -- 2026-09-19: a runtime migration clears"), nextClaim.indexOf("    ) then", nextClaim.indexOf("      -- 2026-09-19: a runtime migration clears")));
  assert.ok(added.includes("current_row.runtime_version is null\n        and current_row.runtime_fingerprint is null"));
  assert.equal(nextClaim.replace(added, ""), priorClaim, "everything outside the new clause is byte-identical to the prior body");
});

test("RED baseline locks the standby out after a runtime migration; GREEN admits it while the primary is stale", async (t) => {
  const db = await fixture({ green: false });
  t.after(() => db.close());
  await seed(db, UNSET);
  const red = await claim(db, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(red.granted, false);
  assert.equal(red.reason, "runtime_identity_invalid");

  await db.exec(nextSql);
  const green = await claim(db, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(green.granted, true);
  assert.equal(green.reason, "granted");
  assert.equal((await lane(db)).lease_worker_id, STANDBY);
});

test("the exception is narrow: primary online, a set-but-different identity, a half-set identity and malformed callers stay refused", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  for (const [label, overrides, args] of [
    ["primary online", { ...UNSET, primary_seen_at: "now()" }, []],
    ["different version set", { runtime_version: "'1.1.20'", runtime_fingerprint: `'${"a".repeat(64)}'`, primary_seen_at: "now() - interval '1 hour'" }, []],
    ["only the fingerprint unset", { runtime_fingerprint: "null", primary_seen_at: "now() - interval '1 hour'" }, []],
    ["only the version unset", { runtime_version: "null", primary_seen_at: "now() - interval '1 hour'" }, []],
    ["malformed caller fingerprint", UNSET, [VERSION, "not-a-fingerprint"]],
  ]) {
    await seed(db, overrides);
    const result = await claim(db, STANDBY, "standby", STANDBY_TOKEN, ...args);
    assert.equal(result.granted, false, label);
    assert.equal(result.reason, "runtime_identity_invalid", label);
    assert.equal((await lane(db)).lease_worker_id, null, label);
  }
});

test("a matching identity and the primary path behave exactly as before", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db, { primary_seen_at: "now() - interval '1 hour'" });
  assert.equal((await claim(db, STANDBY, "standby", STANDBY_TOKEN)).granted, true);
  await seed(db, UNSET);
  const primary = await claim(db, PRIMARY, "primary", PRIMARY_TOKEN);
  assert.equal(primary.granted, true);
  assert.equal((await lane(db)).lease_worker_id, PRIMARY);
});

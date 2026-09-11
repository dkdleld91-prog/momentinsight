import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

// 2026-09-11: the repair/account-priority selector raised
// `naver_shopping_account_priority_claim_invalid` for every worker other than
// the Windows primary, which aborted each standby run at its first job
// selection (macbook-standby rank-catch-up → server_error every 10 minutes
// while the primary was silent). The migration re-declares the pre-handoff
// selector so a valid non-primary lane holder gets `{"intercept": false}`.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const migrationName = "20260911110000_naver_shopping_standby_repair_admission.sql";
const originName = "20260831033617_naver_shopping_account_one_shot_priority.sql";
const migration = fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8");
const origin = fs.readFileSync(path.join(migrationDirectory, originName), "utf8");

function functionSql(source, name) {
  return source.match(new RegExp(
    `create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "u",
  ))?.[0] || "";
}

const ORIGINAL_GUARD = `  if pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, ''))) <>
      'windows-desktop-primary'
    or p_lane_token is null
    or p_run_id is null
    or p_lease_seconds < 60
    or p_lease_seconds > 2100 then
    raise exception 'naver_shopping_account_priority_claim_invalid';
  end if;
`;

test("migration re-declares only the pre-handoff selector, byte-identical apart from the worker guard", () => {
  assert.equal((migration.match(/create or replace function/gu) || []).length, 1);
  const declared = functionSql(migration, "mi_internal\\.mi_claim_naver_shopping_account_priority_pre_handoff");
  assert.ok(declared, "pre_handoff selector must be re-declared");
  const original = functionSql(origin, "mi_internal\\.mi_claim_naver_shopping_account_priority");
  assert.ok(original.includes(ORIGINAL_GUARD), "origin guard must still be the raising guard");
  const newGuardStart = declared.indexOf("  if pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, '')))\n      !~ '^[a-z0-9][a-z0-9:_-]{2,63}$'");
  const newGuardEnd = declared.indexOf("    return pg_catalog.jsonb_build_object('intercept', false);\n  end if;\n");
  assert.ok(newGuardStart > 0 && newGuardEnd > newGuardStart, "new guard must validate the id and return intercept=false for non-primary workers");
  const reconstructed = (
    declared.slice(0, newGuardStart)
    + ORIGINAL_GUARD
    + declared.slice(newGuardEnd + "    return pg_catalog.jsonb_build_object('intercept', false);\n  end if;\n".length)
  ).replace("mi_claim_naver_shopping_account_priority_pre_handoff(", "mi_claim_naver_shopping_account_priority(");
  assert.equal(reconstructed, original, "everything outside the guard must match the 20260831033617 body");
  assert.match(migration, /raise exception 'naver_shopping_standby_repair_admission_requires_pre_handoff'/u);
  assert.match(migration, /proc\.proname = 'mi_claim_naver_shopping_account_priority_pre_handoff'/u);
  assert.match(migration, /revoke all on function mi_internal\.mi_claim_naver_shopping_account_priority_pre_handoff\(\s+text, uuid, uuid, integer\s+\) from public, anon, authenticated, service_role;/u);
  assert.match(migration, /grant execute on function mi_internal\.mi_claim_naver_shopping_account_priority_pre_handoff\(\s+text, uuid, uuid, integer\s+\) to service_role;/u);
  assert.doesNotMatch(migration, /'\d+\.\d+\.\d+'/u);
  assert.doesNotMatch(migration, /'[0-9a-f]{64}'/u);
  assert.match(migration, /^begin;$/mu);
  assert.match(migration, /^commit;$/mu);
});

// The early return sits before any table access, so a schema of empty tables
// (needed only for the %rowtype declarations) is enough to prove it.
const STUB_SCHEMA = `
create role anon;
create role authenticated;
create role service_role;
create schema mi_internal;
create table public.naver_shopping_worker_coordination (lane_key text primary key, primary_worker_id text, lease_worker_id text, lease_token uuid, run_id uuid, lease_until timestamptz, circuit_state text, circuit_reason text, cooldown_until timestamptz, current_stage text, current_page integer, current_job_kind text, current_tracker_id uuid, runtime_version text, runtime_fingerprint text, scheduler_cycle_id uuid, scheduler_cycle_number bigint, scheduler_cycle_status text, updated_at timestamptz);
create table public.naver_shopping_account_priority_requests (request_id uuid primary key, agency_code text, cohort_count integer, cohort_hash text, required_runtime_version text, required_runtime_fingerprint text, requested_at timestamptz, expires_at timestamptz, requested_cycle_id uuid, requested_cycle_number bigint, state text, completed_at timestamptz, succeeded boolean);
create table public.naver_shopping_account_priority_members (request_id uuid, position integer, tracker_id uuid, state text, claimed_lease_started_at timestamptz, primary key (request_id, position));
create table public.naver_rank_trackers (id uuid primary key, agency_code text, status text, keyword text, product_id text, sort_order integer, created_at timestamptz, next_check_at timestamptz, processing_started_at timestamptz, processing_until timestamptz, worker_quarantined_until timestamptz);
create function mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff(
  p_worker_id text, p_lane_token uuid, p_run_id uuid, p_lease_seconds integer default 2100
) returns jsonb language sql as $stub$ select '{"stub":true}'::jsonb $stub$;
`;

async function createDatabase() {
  const database = new PGlite();
  await database.exec(STUB_SCHEMA);
  return database;
}

test("guard refuses to install when the pre-handoff selector does not exist", async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec("create role service_role; create role anon; create role authenticated; create schema mi_internal;");
  await assert.rejects(database.exec(migration), /naver_shopping_standby_repair_admission_requires_pre_handoff/u);
});

test("a valid non-primary lane holder is not intercepted; malformed input and the primary path keep their exceptions", async (t) => {
  const database = await createDatabase();
  t.after(() => database.close());
  await database.exec(migration);
  const lane = "20000000-0000-4000-8000-000000000001";
  const run = "20000000-0000-4000-8000-000000000002";
  const standby = await database.query(
    "select mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff('macbook-standby', $1::uuid, $2::uuid, 2100) as result",
    [lane, run],
  );
  assert.deepEqual(standby.rows[0].result, { intercept: false });
  await assert.rejects(
    database.query("select mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff('x', $1::uuid, $2::uuid, 2100)", [lane, run]),
    /naver_shopping_account_priority_claim_invalid/u,
  );
  await assert.rejects(
    database.query("select mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff('macbook-standby', null, $1::uuid, 2100)", [run]),
    /naver_shopping_account_priority_claim_invalid/u,
  );
  // The primary still walks into the lane re-proof (no coordination row here → lane_lost).
  await assert.rejects(
    database.query("select mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff('windows-desktop-primary', $1::uuid, $2::uuid, 2100)", [lane, run]),
    /naver_shopping_account_priority_lane_lost/u,
  );
});

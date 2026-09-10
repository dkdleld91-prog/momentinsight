import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrations = path.join(root, "supabase", "migrations");
const priorName = "20260903160000_naver_shopping_transient_page_half_open_and_tracker_lifecycle_lease.sql";
const nextPattern = /^\d{14}_naver_shopping_bounded_standby_half_open_handoff\.sql$/u;
const nextNames = fs.readdirSync(migrations).filter((name) => nextPattern.test(name));
const nextName = nextNames[0] || "";
const priorSql = fs.readFileSync(path.join(migrations, priorName), "utf8");
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
  await db.exec(priorClaim);
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

test("migration is new, invoker-only, bounded, and does not replace runtime/HMAC gates", () => {
  assert.equal(nextNames.length, 1);
  assert.ok(nextName > priorName);
  assert.match(nextSql, /security invoker\s+set search_path = ''/iu);
  assert.match(nextSql, /drop function if exists public\.mi_claim_naver_shopping_worker_lane\(\s*text, text, uuid, integer, integer\s*\)/iu);
  assert.match(nextSql, /p_runtime_version text default null,\s*p_runtime_fingerprint text default null/iu);
  assert.match(nextSql, /transient_system_probe_attempts < 2/iu);
  assert.match(nextSql, /transient_standby_handoff_at is null[\s\S]*transient_standby_handoff_success_at is distinct from last_success_at/iu);
  assert.match(nextSql, /revoke all on function public\.mi_claim_naver_shopping_worker_lane\([\s\S]*from public, anon, authenticated, service_role;/iu);
  assert.match(nextSql, /grant execute on function public\.mi_claim_naver_shopping_worker_lane\([\s\S]*to service_role;/iu);
  assert.doesNotMatch(nextSql, /mi_report_naver_shopping_worker_progress|verifyLocalWorkerSignature/iu);
  const executableSql = nextSql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(
    executableSql,
    /(insert into|update|delete from)\s+public\.(naver_rank_trackers|naver_shopping_worker_wakes|naver_shopping_cycles|naver_shopping_cycle_trackers)/iu,
  );
  assert.doesNotMatch(
    executableSql,
    /worker_quarantined_until\s*=|next_check_at\s*=|sort_order\s*=|scheduler_cycle_id\s*=/iu,
  );
  assert.ok(
    nextSql.indexOf("Expired probes must be settled before role admission")
      < nextSql.indexOf("and normalized_worker_role <> 'primary' then"),
    "expired half-open cleanup must run before standby role denial",
  );
  assert.ok(
    nextSql.indexOf("current_row.runtime_fingerprint is distinct from normalized_runtime_fingerprint")
      < nextSql.indexOf("transient_standby_handoff_at = v_now"),
    "current caller identity must be checked before the one-shot handoff is consumed",
  );
});

test("normal primary admission remains successful", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db);
  const result = await claim(db, PRIMARY, "primary", PRIMARY_TOKEN);
  assert.equal(result.granted, true);
  assert.equal(result.circuitState, "closed");
  assert.equal((await lane(db)).lease_worker_id, PRIMARY);
});

test("a different or omitted caller fingerprint cannot consume the one-shot handoff", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db, opened(2, { circuit_opened_at: "now()" }));

  const wrongFingerprint = "b".repeat(64);
  const denied = await claim(
    db,
    STANDBY,
    "standby",
    STANDBY_TOKEN,
    VERSION,
    wrongFingerprint,
  );
  assert.equal(denied.granted, false);
  assert.equal(denied.reason, "runtime_identity_invalid");
  let after = await lane(db);
  assert.equal(after.circuit_state, "open");
  assert.equal(after.lease_worker_id, null);
  assert.equal(after.transient_standby_handoff_at, null);

  const legacy = await db.query(
    "select public.mi_claim_naver_shopping_worker_lane($1, $2, $3, 2100, 180) as claim",
    [STANDBY, "standby", STANDBY_TOKEN],
  );
  assert.equal(legacy.rows[0].claim.granted, false);
  assert.equal(legacy.rows[0].claim.reason, "runtime_identity_invalid");
  after = await lane(db);
  assert.equal(after.lease_worker_id, null);
  assert.equal(after.transient_standby_handoff_at, null);

  const exact = await claim(db, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(exact.granted, true);
  assert.equal(exact.standbyHandoff, true);
  assert.equal((await lane(db)).lease_worker_id, STANDBY);
});

test("primary receives probe 1 and 2 only, then an explicit standby-required state", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db, opened(0));

  const first = await claim(db, PRIMARY, "primary", PRIMARY_TOKEN);
  assert.equal(first.granted, true);
  assert.equal((await lane(db)).transient_system_probe_attempts, 1);

  await db.exec(`
    update public.naver_shopping_worker_coordination
    set circuit_state = 'open', circuit_reason = 'collecting:${TRANSIENT}',
        circuit_opened_at = now() - interval '31 minutes',
        failure_signature = 'collecting:${TRANSIENT}', failure_streak = 2,
        last_failure_code = '${TRANSIENT}', probe_started_at = null,
        lease_worker_id = null, lease_token = null, lease_until = null,
        run_id = null, current_stage = null, current_page = 0,
        current_job_kind = null, current_tracker_id = null,
        current_job_started_at = null;
  `);
  const second = await claim(db, PRIMARY, "primary", OTHER_TOKEN);
  assert.equal(second.granted, true);
  assert.equal((await lane(db)).transient_system_probe_attempts, 2);

  await db.exec(`
    update public.naver_shopping_worker_coordination
    set circuit_state = 'open', circuit_reason = 'collecting:${TRANSIENT}',
        circuit_opened_at = now(), failure_signature = 'collecting:${TRANSIENT}',
        failure_streak = 2, last_failure_code = '${TRANSIENT}',
        probe_started_at = null, lease_worker_id = null, lease_token = null,
        lease_until = null, run_id = null, current_stage = null, current_page = 0,
        current_job_kind = null, current_tracker_id = null,
        current_job_started_at = null;
  `);
  const exhausted = await claim(db, PRIMARY, "primary", PRIMARY_TOKEN);
  assert.equal(exhausted.granted, false);
  assert.equal(exhausted.reason, "standby_handoff_required");
  assert.equal((await lane(db)).transient_system_probe_attempts, 2);
});

test("RED baseline is fail-stuck; GREEN grants one exhausted-probe standby handoff", async (t) => {
  const db = await fixture({ green: false });
  t.after(() => db.close());
  await seed(db, opened(2, { circuit_opened_at: "now()" }));
  const redResult = await db.query(
    "select public.mi_claim_naver_shopping_worker_lane($1, $2, $3, 2100, 180) as claim",
    [STANDBY, "standby", STANDBY_TOKEN],
  );
  const red = redResult.rows[0].claim;
  assert.equal(red.granted, false);
  assert.equal(red.reason, "circuit_open");

  await db.exec(nextSql);
  const green = await claim(db, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(green.granted, true);
  assert.equal(green.standbyHandoff, true);
  const after = await lane(db);
  assert.equal(after.circuit_state, "half_open");
  assert.equal(after.lease_worker_id, STANDBY);
  assert.equal(after.transient_system_probe_attempts, 2);

  const replay = await claim(db, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(replay.granted, true);
  assert.equal(replay.alreadyGranted, true);
  assert.equal(String(replay.leaseUntil), String(green.leaseUntil));

  const duplicate = await claim(db, "other-standby", "standby", OTHER_TOKEN);
  assert.equal(duplicate.granted, false);
  assert.equal(duplicate.reason, "busy");
});

test("an expired standby handoff terminalizes once before role denial, then stays read-only", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db, opened(2, { circuit_opened_at: "now()" }));
  assert.equal((await claim(db, STANDBY, "standby", STANDBY_TOKEN)).granted, true);

  await db.exec(`
    update public.naver_shopping_worker_coordination
    set lease_until = now() - interval '1 minute';
  `);
  const denied = await claim(db, "other-standby", "standby", OTHER_TOKEN);
  assert.equal(denied.granted, false);
  assert.equal(denied.reason, "recovery_manual_required");
  const terminal = await lane(db);
  assert.equal(terminal.circuit_reason, "transient_recovery_manual_required");
  const updatedAt = terminal.updated_at.toISOString();

  const duplicate = await claim(db, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(duplicate.granted, false);
  assert.equal(duplicate.reason, "recovery_manual_required");
  assert.equal((await lane(db)).updated_at.toISOString(), updatedAt);

  const navigationDb = await fixture();
  t.after(() => navigationDb.close());
  await seed(navigationDb, {
    circuit_state: "'half_open'",
    circuit_reason: "'auto_navigation_probe'",
    circuit_opened_at: "null",
    failure_signature: "null",
    failure_streak: "0",
    transient_system_probe_attempts: "0",
    last_failure_code: "'naver_page_navigation_failed'",
    probe_started_at: "now() - interval '2 minutes'",
    lease_worker_id: `'${PRIMARY}'`,
    lease_token: `'${PRIMARY_TOKEN}'`,
    lease_until: "now() - interval '1 minute'",
  });
  const interruptedNavigation = await claim(
    navigationDb,
    STANDBY,
    "standby",
    STANDBY_TOKEN,
  );
  assert.equal(interruptedNavigation.granted, false);
  assert.equal(interruptedNavigation.reason, "circuit_open");
  assert.equal(interruptedNavigation.circuitReason, "probe_interrupted");
  await navigationDb.exec(`
    update public.naver_shopping_worker_coordination
    set circuit_opened_at = now() - interval '11 minutes';
  `);
  const recoveredNavigation = await claim(
    navigationDb,
    PRIMARY,
    "primary",
    OTHER_TOKEN,
  );
  assert.equal(recoveredNavigation.granted, true);
  assert.equal(recoveredNavigation.autoRecovery, true);
  assert.equal((await lane(navigationDb)).circuit_reason, "auto_navigation_probe");

  // A marker from an older standby recovery is not proof that this separate
  // navigation probe belongs to that handoff. Its expiry keeps the existing
  // navigation-only probe_interrupted contract.
  const staleMarkerNavigationDb = await fixture();
  t.after(() => staleMarkerNavigationDb.close());
  await seed(staleMarkerNavigationDb, {
    circuit_state: "'half_open'",
    circuit_reason: "'auto_navigation_probe'",
    circuit_opened_at: "null",
    failure_signature: "null",
    failure_streak: "0",
    transient_system_probe_attempts: "2",
    last_failure_code: "'naver_page_navigation_failed'",
    probe_started_at: "now() - interval '2 minutes'",
    lease_worker_id: `'${PRIMARY}'`,
    lease_token: `'${PRIMARY_TOKEN}'`,
    lease_until: "now() - interval '1 minute'",
  });
  await staleMarkerNavigationDb.exec(`
    update public.naver_shopping_worker_coordination
    set transient_standby_handoff_at = now() - interval '1 day',
        transient_standby_handoff_worker_id = '${STANDBY}',
        transient_standby_handoff_success_at = last_success_at;
  `);
  const staleMarkerNavigation = await claim(
    staleMarkerNavigationDb,
    STANDBY,
    "standby",
    STANDBY_TOKEN,
  );
  assert.equal(staleMarkerNavigation.granted, false);
  assert.equal(staleMarkerNavigation.reason, "circuit_open");
  assert.equal(staleMarkerNavigation.circuitReason, "probe_interrupted");
  assert.equal(
    (await lane(staleMarkerNavigationDb)).circuit_reason,
    "probe_interrupted",
  );
});

test("live lane and active work deny standby; stale primary then permits the same single handoff", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db, opened(2, {
    circuit_opened_at: "now()",
    lease_worker_id: `'${PRIMARY}'`,
    lease_token: `'${PRIMARY_TOKEN}'`,
    lease_until: "now() + interval '10 minutes'",
  }));
  const busy = await claim(db, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(busy.granted, false);
  assert.equal(busy.reason, "busy");
  assert.equal((await lane(db)).transient_standby_handoff_at, null);

  await db.exec(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = null, lease_token = null, lease_until = null;
    insert into public.naver_rank_trackers (id, status, processing_until)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'active', now() + interval '5 minutes');
  `);
  const active = await claim(db, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(active.granted, false);
  assert.equal(active.reason, "recovery_active_work");
  assert.equal((await lane(db)).transient_standby_handoff_at, null);

  await db.exec(`
    delete from public.naver_rank_trackers;
    update public.naver_shopping_worker_coordination
    set primary_seen_at = now() - interval '10 minutes',
        circuit_opened_at = now() - interval '31 minutes',
        transient_system_probe_attempts = 0;
  `);
  const stalePrimary = await claim(db, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(stalePrimary.granted, true);
  assert.equal(stalePrimary.standbyHandoff, true);
  assert.equal((await lane(db)).transient_system_probe_attempts, 0);

  const unprovenDb = await fixture();
  t.after(() => unprovenDb.close());
  await seed(unprovenDb, opened(2, {
    circuit_opened_at: "now()",
  }));
  await unprovenDb.exec("delete from public.naver_shopping_worker_runs;");
  const unproven = await claim(unprovenDb, STANDBY, "standby", STANDBY_TOKEN);
  assert.equal(unproven.granted, false);
  assert.equal(unproven.reason, "recovery_runtime_unproven");
  assert.equal(unproven.manualRequired, true);
  const terminal = await lane(unprovenDb);
  assert.equal(terminal.circuit_reason, "transient_recovery_manual_required");
  assert.equal(terminal.transient_standby_handoff_at, null);
  const terminalUpdatedAt = terminal.updated_at.toISOString();

  await unprovenDb.exec(`
    update public.naver_shopping_worker_coordination
    set runtime_version = '${VERSION}', runtime_fingerprint = '${FINGERPRINT}';
  `);
  const terminalReplay = await claim(unprovenDb, STANDBY, "standby", OTHER_TOKEN);
  assert.equal(terminalReplay.granted, false);
  assert.equal(terminalReplay.reason, "recovery_manual_required");
  assert.equal((await lane(unprovenDb)).transient_standby_handoff_at, null);
  assert.equal((await lane(unprovenDb)).updated_at.toISOString(), terminalUpdatedAt);
});

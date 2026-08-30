import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
const supersavingRecoveryMigration = fs.readFileSync(
  path.join(migrationDirectory, "20260828025000_naver_shopping_supersaving_composite_recovery.sql"),
  "utf8",
);
const finiteCommitMigrationName = "20260828082130_naver_shopping_finite_commit_checked_count_ambiguity.sql";
const finiteCommitMigration = fs.readFileSync(path.join(migrationDirectory, finiteCommitMigrationName), "utf8");
const priorMigrationName = "20260829140000_naver_shopping_runtime_1_1_17_rank_drift_isolation.sql";
const priorMigration = fs.readFileSync(path.join(migrationDirectory, priorMigrationName), "utf8");
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => /^\d{14}_naver_shopping_runtime_1_1_18(?:_[a-z0-9_]+)?\.sql$/u.test(name));
const migrationName = migrationNames[0] || "";
const migration = migrationName
  ? fs.readFileSync(path.join(migrationDirectory, migrationName), "utf8")
  : "";

const runtimeFiles = [
  "tools/naver-shopping-chrome-extension/service-worker.js",
  "scripts/naver-shopping-native-host.mjs",
  "scripts/naver-shopping-native-host-core.mjs",
  "scripts/naver-shopping-local-worker.mjs",
  "src/server/local-worker-auth.mjs",
  "src/server/naver-shopping/local-worker-contract.mjs",
  "src/server/handlers/naver-shopping-rank.mjs",
  "src/server/security.mjs",
  "src/server/naver-shopping/source-status.mjs",
  "src/server/naver-shopping/provider-runtime.mjs",
  "src/server/naver-shopping/mobile-top-fallback.mjs",
  "tools/naver-shopping-rank-collector/src/provider.mjs",
  "tools/naver-shopping-rank-collector/src/contract.mjs",
];

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function runtimeFixture(version) {
  const componentDigests = runtimeFiles.map((name) => crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(repositoryRoot, name)))
    .digest("hex"));
  return Object.freeze({
    version,
    fingerprint: crypto.createHash("sha256")
      .update([version, ...componentDigests].join("\n"), "utf8")
      .digest("hex"),
  });
}

function requireMigration() {
  assert.equal(migrationNames.length, 1, "one additive runtime 1.1.18 migration is required");
  assert.ok(migrationName > priorMigrationName, "runtime 1.1.18 must follow runtime 1.1.17");
  assert.ok(migration, "runtime 1.1.18 migration must be readable");
}

function functionBlocks(source, name) {
  const pattern = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "giu",
  );
  return [...source.matchAll(pattern)].map((match) => match[0]);
}

async function createRuntimeMigrationFixture(database) {
  await database.exec(`
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
      scheduler_cycle_resume_cursor jsonb,
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
        check (runtime_version = '1.1.16')
    );

    create table public.naver_shopping_rank_lookup_jobs (
      id uuid,
      status text,
      processing_until timestamptz,
      available_at timestamptz,
      expires_at timestamptz,
      attempts integer default 0
    );

    create table public.naver_rank_trackers (
      id uuid primary key,
      status text,
      product_id text,
      keyword text,
      processing_started_at timestamptz,
      processing_until timestamptz,
      next_check_at timestamptz,
      worker_quarantined_until timestamptz,
      created_at timestamptz default clock_timestamp(),
      current_rank integer,
      best_rank integer,
      worst_rank integer,
      check_count integer default 0,
      found_count integer default 0,
      last_checked_at timestamptz,
      last_message text,
      last_error text,
      retry_count integer default 0
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
      event_id bigint primary key,
      event_type text,
      claim_id uuid,
      run_id uuid,
      worker_id text,
      tracker_id uuid,
      group_fingerprint text,
      lease_started_at timestamptz,
      priority text,
      details jsonb default '{}'::jsonb,
      collection_id text,
      checked_count integer,
      occurred_at timestamptz,
      error_code text
    );

    create table public.naver_rank_snapshots (
      id uuid primary key default gen_random_uuid(),
      tracker_id uuid not null,
      checked_at timestamptz not null,
      collection_id text,
      rank integer,
      page integer,
      position integer,
      matched boolean,
      checked_count integer,
      total integer,
      item jsonb,
      top_items jsonb,
      message text,
      source text
    );
    create unique index naver_rank_snapshots_tracker_collection_unique
      on public.naver_rank_snapshots (tracker_id, collection_id)
      where collection_id is not null;

    insert into public.naver_shopping_worker_coordination (
      lane_key, circuit_state, primary_worker_id, primary_seen_at,
      runtime_version, runtime_fingerprint, current_stage, current_page,
      circuit_reason, failure_signature, failure_streak,
      last_success_at, last_failure_at, last_failure_code,
      last_collection_id, last_checked_count, last_excluded_ad_count,
      last_duration_ms, last_source,
      cadence_mode, cadence_minutes, success_streak, updated_at
    ) values (
      'global', 'open', 'windows-desktop-primary', clock_timestamp(),
      '1.1.16',
      '8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1',
      'failed', 8,
      'collecting:naver_next_data_schema_drift:compositelist_list_1_type_supersaving',
      'collecting:naver_next_data_schema_drift:compositelist_list_1_type_supersaving', 1,
      '2026-08-28T01:00:00Z', '2026-08-28T02:00:00Z',
      'naver_next_data_schema_drift:compositelist_list_1_type_supersaving',
      'pw-chrome-pglite-last-good', 300, 40, 1000,
      'naver_shopping_results_collector',
      'baseline', 10, 0, clock_timestamp()
    );

    insert into public.naver_shopping_finite_window_targets (
      tracker_id, seller_product_id, parent_catalog_id, normalized_keyword,
      proof_version, runtime_version, runtime_fingerprint, enabled
    ) values (
      'c0ccded2-9bf7-488e-af8d-00898c0a1ff8',
      '13327339525', '59776958987', '아이쉘차량용거치대',
      'stable-finite-window-v1', '1.1.16',
      '8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1',
      true
    );
  `);
}

async function prepareRuntime1117(database) {
  await createRuntimeMigrationFixture(database);
  await database.exec(supersavingRecoveryMigration);
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set runtime_version = '1.1.16',
        runtime_fingerprint = '9680164f90965609896b72c05b09e67946bc51d1df44c76d0cb5b9e5f0085478'
    where lane_key = 'global';
  `);
  await database.exec(finiteCommitMigration);
  await database.exec(priorMigration);
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set runtime_version = '1.1.17',
        runtime_fingerprint = '1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7'
    where lane_key = 'global';
  `);
}

test("adds one runtime 1.1.18 migration behind an exact full-idle guard", () => {
  requireMigration();
  assert.match(migration, /^begin;/imu);
  assert.match(migration, /commit;\s*$/iu);
  assert.match(migration, /lock table public\.naver_shopping_worker_coordination in access exclusive mode/iu);
  assert.match(migration, /lock table public\.naver_shopping_finite_window_targets in share row exclusive mode/iu);
  assert.match(migration, /where lane_key = 'global'[\s\S]*for update/iu);
  assert.match(migration, /current_row\.runtime_version is distinct from '1\.1\.17'/iu);
  assert.match(
    migration,
    /1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7/u,
  );
  assert.match(migration, /target_updated_count <> prior_target_count/iu);
  assert.doesNotMatch(
    migration.split("create or replace function")[0],
    /c0ccded2-9bf7-488e-af8d-00898c0a1ff8/u,
  );
  assert.match(migration, /processing_count <> 0/iu);
  assert.match(migration, /current_row\.cadence_mode is distinct from 'baseline'/iu);
  assert.match(migration, /current_row\.cadence_minutes is distinct from 10/iu);
  for (const field of [
    "lease_worker_id", "lease_token", "lease_until", "run_id", "current_stage",
    "current_job_kind", "current_tracker_id", "current_job_started_at",
    "probe_tracker_id", "probe_started_at",
  ]) {
    assert.match(migration, new RegExp(`current_row\\.${field} is not null`, "iu"));
  }
});

test("binds every trusted surface to one canonical runtime 1.1.18 fingerprint", () => {
  requireMigration();
  const expected = runtimeFixture("1.1.18");
  const manifest = JSON.parse(read("tools/naver-shopping-chrome-extension/manifest.json"));
  assert.equal(manifest.version, expected.version);

  const bindings = [
    ["scripts/naver-shopping-local-worker.mjs", /const EXPECTED_RUNTIME_VERSION = "1\.1\.18";/u],
    ["src/server/handlers/naver-shopping-local-worker.mjs", /const EXPECTED_WORKER_RUNTIME_VERSION = "1\.1\.18";/u],
    ["src/server/handlers/naver-rank-trackers.mjs", /const SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION = "1\.1\.18";/u],
    ["scripts/naver-shopping-candidate-performance-audit.mjs", /export const N30_TARGET_RUNTIME_VERSION = "1\.1\.18";/u],
    ["scripts/naver-shopping-account-rank-health-audit.mjs", /export const N30_ACCOUNT_HEALTH_RUNTIME_VERSION = "1\.1\.18";/u],
  ];
  for (const [file, pattern] of bindings) assert.match(read(file), pattern);
  for (const file of bindings.slice(3).map(([file]) => file)) {
    assert.match(read(file), new RegExp(expected.fingerprint, "u"));
  }
  assert.match(migration, new RegExp(expected.fingerprint, "u"));
});

test("replaces all runtime-sensitive control functions without weakening grants", () => {
  requireMigration();
  const functions = [
    "mi_report_naver_shopping_worker_progress",
    "mi_set_naver_shopping_worker_cadence",
    "mi_get_naver_shopping_worker_operations",
    "mi_record_naver_shopping_worker_failure",
  ];
  for (const name of functions) {
    const blocks = functionBlocks(migration, name);
    assert.equal(blocks.length, 1, `${name} must be replaced exactly once`);
    assert.match(blocks[0], /security invoker/iu);
    assert.match(blocks[0], /set search_path = ''/iu);
    assert.doesNotMatch(blocks[0], /'1\.1\.17'/u);
    assert.match(blocks[0], /'1\.1\.18'/u);
  }
  for (const name of functions.slice(0, 3)) {
    const [block] = functionBlocks(migration, name);
    assert.doesNotMatch(block, /naver_shopping_finite_window_targets|c0ccded2/iu);
    assert.match(block, new RegExp(runtimeFixture("1.1.18").fingerprint, "u"));
  }
  assert.doesNotMatch(migration, /create or replace function public\.mi_commit_naver_shopping_finite_worker_result/iu);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon|authenticated)/iu);
  assert.equal((migration.match(/to service_role;/giu) || []).length, 5);
});

test("preserves baseline10 candidate6 and resets only runtime stability state", () => {
  requireMigration();
  assert.match(migration, /cadence_mode = 'baseline'/iu);
  assert.match(migration, /cadence_minutes = 10/iu);
  assert.match(migration, /cadence_minutes = 6/iu);
  assert.match(migration, /stability_started_at = null/iu);
  assert.match(migration, /success_streak = 0/iu);
  assert.match(migration, /runtime_version = null/iu);
  assert.match(migration, /runtime_fingerprint = null/iu);
  assert.match(
    migration,
    /and runtime_version = '1\.1\.17'[\s\S]*and runtime_fingerprint = '1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7';/iu,
  );
  assert.match(migration, /get diagnostics coordination_updated_count = row_count/iu);
  assert.match(migration, /coordination_updated_count <> 1/iu);
  const transitionPrefix = migration.split("create or replace function")[0];
  assert.doesNotMatch(transitionPrefix, /update public\.naver_rank_trackers/iu);
  assert.doesNotMatch(transitionPrefix, /update public\.naver_shopping_rank_lookup_jobs/iu);
  assert.doesNotMatch(
    transitionPrefix,
    /(?:insert into|update|delete from) public\.naver_rank_snapshots/iu,
  );
  assert.doesNotMatch(
    transitionPrefix,
    /(?:insert into|update|delete from) public\.naver_shopping_scheduler_events/iu,
  );
});

test("PGlite rejects wrong identity, busy processing, live lease, and open circuit", async (t) => {
  const cases = [
    ["wrong_identity", "update public.naver_shopping_worker_coordination set runtime_fingerprint = 'f' || repeat('0', 63) where lane_key = 'global'"],
    ["busy_processing", "insert into public.naver_shopping_rank_lookup_jobs (id, status, processing_until) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'processing', clock_timestamp() + interval '5 minutes')"],
    ["live_lease", "update public.naver_shopping_worker_coordination set lease_worker_id = 'windows-desktop-primary', lease_token = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', lease_until = clock_timestamp() + interval '5 minutes' where lane_key = 'global'"],
    ["open_circuit", "update public.naver_shopping_worker_coordination set circuit_state = 'open', circuit_reason = 'test' where lane_key = 'global'"],
  ];
  for (const [name, mutation] of cases) {
    const database = new PGlite();
    t.after(async () => database.close());
    await prepareRuntime1117(database);
    await database.exec(mutation);
    await assert.rejects(database.exec(migration), /naver_shopping_runtime_1_1_18_requires_idle_control_plane/u, name);
  }
});

test("global runtime control no longer depends on the optional finite canary row", async (t) => {
  requireMigration();
  const database = new PGlite();
  t.after(async () => database.close());
  await prepareRuntime1117(database);
  await database.exec("delete from public.naver_shopping_finite_window_targets");
  await database.exec(migration);

  const runtime = runtimeFixture("1.1.18");
  const targetCount = await database.query(
    "select count(*)::integer as count from public.naver_shopping_finite_window_targets",
  );
  assert.equal(targetCount.rows[0].count, 0);

  const laneToken = "67676767-6767-4767-8767-676767676767";
  const runId = "68686868-6868-4868-8868-686868686868";
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = 'windows-desktop-primary',
        lease_token = '${laneToken}',
        lease_until = clock_timestamp() + interval '5 minutes'
    where lane_key = 'global';
  `);
  const progress = await database.query(`
    select public.mi_report_naver_shopping_worker_progress(
      'windows-desktop-primary', '${laneToken}', '${runId}', 'navigating', 1,
      'tracker', null, '1.1.18', '${runtime.fingerprint}', 'rank-catch-up'
    ) as accepted
  `);
  assert.equal(progress.rows[0].accepted, true);
  const operations = await database.query(
    "select public.mi_get_naver_shopping_worker_operations() as result",
  );
  assert.equal(operations.rows[0].result.runtime_version, "1.1.18");
  assert.equal(operations.rows[0].result.runtime_fingerprint, runtime.fingerprint);
});

test("compiles and invokes runtime RPCs while preserving the corrected finite commit", async (t) => {
  requireMigration();
  const database = new PGlite();
  t.after(async () => database.close());
  await prepareRuntime1117(database);
  const recovered = await database.query(`
    select runtime_version, runtime_fingerprint
    from public.naver_shopping_finite_window_targets
    where tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'
  `);
  assert.deepEqual(recovered.rows, [{
    runtime_version: "1.1.17",
    runtime_fingerprint: "1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7",
  }]);
  await database.exec(migration);

  const runtime = runtimeFixture("1.1.18");
  const target = await database.query(`
    select runtime_version, runtime_fingerprint
    from public.naver_shopping_finite_window_targets
    where tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'
  `);
  assert.deepEqual(target.rows, [{
    runtime_version: "1.1.18",
    runtime_fingerprint: runtime.fingerprint,
  }]);

  const baseline = await database.query(
    "select public.mi_set_naver_shopping_worker_cadence('baseline') as result",
  );
  assert.deepEqual(baseline.rows[0].result, {
    accepted: true,
    activated: true,
    mode: "baseline",
    minutes: 10,
  });

  const operations = await database.query(
    "select public.mi_get_naver_shopping_worker_operations() as result",
  );
  assert.equal(operations.rows[0].result.cadence_mode, "baseline");
  assert.equal(operations.rows[0].result.cadence_minutes, 10);

  const laneToken = "77777777-7777-4777-8777-777777777777";
  const runId = "88888888-8888-4888-8888-888888888888";
  await database.exec(`
    update public.naver_shopping_worker_coordination
    set lease_worker_id = 'windows-desktop-primary',
        lease_token = '${laneToken}',
        lease_until = clock_timestamp() + interval '5 minutes'
    where lane_key = 'global';
  `);
  const progress = await database.query(`
    select public.mi_report_naver_shopping_worker_progress(
      'windows-desktop-primary', '${laneToken}', '${runId}', 'navigating', 1,
      'tracker', 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8',
      '1.1.18', '${runtime.fingerprint}', 'rank-catch-up'
    ) as accepted
  `);
  assert.equal(progress.rows[0].accepted, true);

  const failure = await database.query(`
    select public.mi_record_naver_shopping_worker_failure(
      'windows-desktop-primary', '${laneToken}', '${runId}',
      'provider_schema_changed', 'lookup', null
    ) as result
  `);
  assert.equal(failure.rows[0].result.recorded, true);
  assert.equal(failure.rows[0].result.laneReleased, true);

  const checkedAt = "2026-08-29T05:53:00.829Z";
  const leaseStartedAt = "2026-08-29T05:51:00.000Z";
  const finiteRunId = "99999999-9999-4999-8999-999999999999";
  const claimId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const collectionId = "pw-chrome-pglite-finite-existing";
  const finiteItem = {
    finiteWindowProofVersion: "stable-finite-window-v1",
    sourceExhausted: true,
    finiteMarketTotal: 94,
    atomicSuccessEligible: false,
    trackingRankSource: "related_catalog",
    relatedCatalogProductId: "59776958987",
    relatedCatalogRelationBasis: "catalog_seller_product_id",
    catalogId: "59776958987",
    catalogSellerProductIds: ["13327339525"],
    rankPolicy: "organic_only",
    adExcluded: true,
    rankEvidence: "naver_shopping_organic_list",
    collectionId,
    isOrganic: true,
    isAd: false,
  };
  const finiteSnapshot = {
    checked_count: 94,
    rank: 1,
    total: 94,
    matched: true,
    source: "naver_shopping_results_collector",
    item: finiteItem,
    top_items: [],
  };
  await database.exec(`
    insert into public.naver_rank_trackers (
      id, status, product_id, keyword, processing_started_at, processing_until,
      next_check_at, check_count, found_count, retry_count
    ) values (
      'c0ccded2-9bf7-488e-af8d-00898c0a1ff8', 'active', '13327339525',
      '아이쉘 차량용 거치대', null, null, clock_timestamp(), 0, 0, 0
    );
    insert into public.naver_shopping_worker_runs (
      run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint, started_at
    ) values (
      '${finiteRunId}', 'windows-desktop-primary', 'rank-catch-up',
      '1.1.18', '${runtime.fingerprint}', '${leaseStartedAt}'::timestamptz
    );
    insert into public.naver_shopping_scheduler_events (
      event_id, event_type, claim_id, run_id, worker_id, tracker_id,
      group_fingerprint, lease_started_at, priority, details, occurred_at
    ) values
      (1, 'group_claimed', '${claimId}', '${finiteRunId}', 'windows-desktop-primary', null,
       'pglite-group', '${leaseStartedAt}', 'normal', '{"memberCount":1}', '${leaseStartedAt}'),
      (2, 'tracker_claimed', '${claimId}', '${finiteRunId}', 'windows-desktop-primary',
       'c0ccded2-9bf7-488e-af8d-00898c0a1ff8', 'pglite-group', '${leaseStartedAt}',
       'normal', '{}', '${leaseStartedAt}');
  `);
  await database.query(
    `insert into public.naver_rank_snapshots (
       id, tracker_id, checked_at, collection_id, rank, matched, checked_count,
       total, item, top_items, source
     ) values (
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       'c0ccded2-9bf7-488e-af8d-00898c0a1ff8', $1, $2, 1, true, 94, 94,
       $3::jsonb, '[]'::jsonb, 'naver_shopping_results_collector'
     )`,
    [checkedAt, collectionId, JSON.stringify(finiteItem)],
  );
  await database.query(
    `insert into public.naver_shopping_scheduler_events (
       event_id, event_type, claim_id, run_id, worker_id, tracker_id,
       group_fingerprint, lease_started_at, priority, details, collection_id,
       checked_count, occurred_at
     ) values (
       3, 'finite_window_committed', $1, $2, 'windows-desktop-primary',
       'c0ccded2-9bf7-488e-af8d-00898c0a1ff8', 'pglite-group', $3, 'normal',
       $4::jsonb, $5, 94, $6
     )`,
    [
      claimId,
      finiteRunId,
      leaseStartedAt,
      JSON.stringify({
        source: "naver_shopping_results_collector",
        finiteWindowProofVersion: "stable-finite-window-v1",
        sourceExhausted: true,
        marketTotal: 94,
        matched: true,
        rank: 1,
        relationBasis: "catalog_seller_product_id",
        atomicSuccessEligible: false,
      }),
      collectionId,
      checkedAt,
    ],
  );

  const finiteCommit = await database.query(
    `select public.mi_commit_naver_shopping_finite_worker_result(
       'c0ccded2-9bf7-488e-af8d-00898c0a1ff8', $1, $2, $3,
       '2026-08-29T06:03:00.829Z', $4::jsonb, '13327339525', null, null
     ) as result`,
    [leaseStartedAt, collectionId, checkedAt, JSON.stringify(finiteSnapshot)],
  );
  assert.equal(finiteCommit.rows[0].result.status, "already_committed");
  assert.equal(
    finiteCommit.rows[0].result.snapshotId,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  );
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL(
  '../supabase/migrations/20260812060826_naver_shopping_durable_cycle_probe.sql',
  import.meta.url,
), 'utf8');
const duplicateQuarantineMigration = readFileSync(new URL(
  '../supabase/migrations/20260813144700_naver_shopping_duplicate_quarantine_cap.sql',
  import.meta.url,
), 'utf8');
const autoNavigationHalfOpenMigration = readFileSync(new URL(
  '../supabase/migrations/20260814182150_naver_shopping_auto_navigation_half_open.sql',
  import.meta.url,
), 'utf8');
const autoNavigationTrackerFailureRecoveryMigration = readFileSync(new URL(
  '../supabase/migrations/20260814183217_naver_shopping_auto_navigation_tracker_failure_recovery.sql',
  import.meta.url,
), 'utf8');
const probeIncompleteAutoRecoveryMigration = readFileSync(new URL(
  '../supabase/migrations/20260819022043_naver_shopping_probe_incomplete_auto_recovery.sql',
  import.meta.url,
), 'utf8');
const runtime119Migration = readFileSync(new URL(
  '../supabase/migrations/20260821160000_naver_shopping_runtime_1_1_9.sql',
  import.meta.url,
), 'utf8');
const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);

function findMigrationContaining(marker) {
  for (const file of readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort()) {
    const source = readFileSync(new URL(file, migrationDirectory), 'utf8');
    if (source.includes(marker)) return { file, source };
  }
  return null;
}

const normalizedKeywordOverflowMigration = findMigrationContaining(
  'worker_last_cycle_deferred_at',
);
const runtime110Migration = findMigrationContaining(
  '-- Runtime 1.1.10',
);
const runtime111Migration = findMigrationContaining(
  '-- Runtime 1.1.11',
);
const runtime1112Migration = findMigrationContaining(
  '-- Runtime 1.1.12 keeps',
);
const runtime111ExactCandidateGateMigration = findMigrationContaining(
  '-- Runtime 1.1.11 exact candidate gate',
);
const runtime1112ExactCandidateGateMigration = findMigrationContaining(
  '-- Runtime 1.1.12 exact candidate gate',
);
const atomicSuccessProofHardeningMigration = findMigrationContaining(
  '-- N Shopping atomic success proof hardening',
);
const runtime113Candidate6Migration = findMigrationContaining(
  '-- Runtime 1.1.13 candidate 6-minute cadence',
);

function runtime119FunctionSql(name, nextName = null) {
  const start = runtime119Migration.indexOf(`create or replace function public.${name}`);
  const end = nextName
    ? runtime119Migration.indexOf(`create or replace function public.${nextName}`, start + 1)
    : runtime119Migration.indexOf('revoke all on function', start + 1);
  assert.ok(start >= 0 && end > start, `${name} must exist in runtime 1.1.9`);
  return runtime119Migration.slice(start, end);
}

test('durable cycle RPC contract is fixed and service-role only', () => {
  for (const key of ['cycleId', 'cycleStartedAt', 'started', 'total', 'remaining', 'processing']) {
    assert.match(migration, new RegExp(`'${key}'`));
  }
  assert.match(migration, /create or replace function public\.mi_queue_naver_shopping_cycle\(\)/i);
  assert.match(migration, /create or replace function public\.mi_claim_naver_shopping_cycle_keyword\(\s*p_worker_id text,\s*p_lane_token uuid,\s*p_run_id uuid,\s*p_lease_seconds integer default 2100,\s*p_probe_tracker_id uuid default null/is);
  assert.match(migration, /lease_worker_id is distinct from lower\(trim\(p_worker_id\)\)[\s\S]*lease_token is distinct from p_lane_token[\s\S]*run_id is distinct from p_run_id/i);
  assert.match(migration, /revoke all on function public\.mi_queue_naver_shopping_cycle\(\)[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute[\s\S]*to service_role;/i);
  assert.match(migration, /revoke all on function public\.mi_claim_naver_shopping_cycle_keyword\(text, uuid, uuid, integer, uuid\)[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute[\s\S]*to service_role;/i);
  assert.doesNotMatch(migration, /security definer/i);
});

test('cycle order, one-new-then-resume and normalized keyword group are durable', () => {
  assert.match(migration, /seed := null;/i, 'must not inherit stale PL/pgSQL FOUND state');
  assert.doesNotMatch(migration.slice(migration.indexOf('-- A newly registered keyword')), /if not found/i);
  assert.match(migration, /if not current_row\.scheduler_cycle_resume_cursor[\s\S]*last_checked_at is null[\s\S]*order by tracker\.created_at asc, tracker\.id asc/i);
  assert.match(migration, /scheduler_cycle_resume_cursor = case when v_priority = 'new' then true else false end/i);
  assert.match(migration, /\(tracker\.sort_order, tracker\.created_at, tracker\.id\) >[\s\S]*order by tracker\.sort_order asc, tracker\.created_at asc, tracker\.id asc/i);
  assert.match(migration, /worker_last_cycle_id is distinct from current_row\.scheduler_cycle_id/i);
  assert.match(migration, /regexp_replace\(lower\(trim\(seed\.keyword\)\), '\\s\+', '', 'g'\)/i);
  assert.match(migration, /regexp_replace\(lower\(trim\(tracker\.keyword\)\), '\\s\+', '', 'g'\) = v_keyword_key/i);
  assert.match(migration, /limit 100\s+for update skip locked/i);
  assert.match(migration, /p_probe_tracker_id is not null and tracker\.id = p_probe_tracker_id/i);
  assert.match(migration, /processing_until > v_now[\s\S]*'status', 'waiting'/i);
  assert.match(migration, /worker_quarantined_until is null or tracker\.worker_quarantined_until <= v_now/i);
  assert.doesNotMatch(migration, /next_check_at/i, 'cycle authority must not rewrite due timestamps');
});

test('a normalized keyword over 100 trackers is collected once per cycle with bounded, rotating coverage', () => {
  assert.ok(
    normalizedKeywordOverflowMigration,
    'an additive migration must repair the existing max-100 normalized-keyword boundary',
  );
  const sql = normalizedKeywordOverflowMigration.source;
  assert.match(
    normalizedKeywordOverflowMigration.file,
    /^\d{14}_naver_shopping_cycle_keyword_overflow\.sql$/u,
  );
  assert.match(sql, /add column if not exists worker_last_cycle_deferred_at timestamptz/iu);
  assert.match(
    sql,
    /drop constraint if exists naver_shopping_scheduler_events_deferred_tracker_check/iu,
  );
  assert.match(sql, /create or replace function public\.mi_claim_naver_shopping_cycle_keyword\(/iu);
  assert.match(
    sql,
    /case when tracker\.id = seed\.id then 0 else 1 end asc[\s\S]*tracker\.last_checked_at asc nulls first[\s\S]*limit 100[\s\S]*for update skip locked/iu,
    'the selected seed must stay in the bounded claim and oldest checks must rotate into later cycles',
  );
  assert.match(
    sql,
    /worker_last_cycle_id is distinct from current_row\.scheduler_cycle_id[\s\S]*worker_last_cycle_id = current_row\.scheduler_cycle_id[\s\S]*worker_last_cycle_deferred_at = v_now/iu,
    'every overflow member must be rostered as deferred for the current cycle',
  );
  assert.match(sql, /'deferredCount', v_deferred_count/iu);
  assert.match(sql, /'groupSize', v_claim_count \+ v_deferred_count/iu);

  const deferredStart = sql.indexOf('deferred_group_members as');
  const deferredEnd = sql.indexOf('select count(*)::integer', deferredStart);
  assert.ok(deferredStart >= 0 && deferredEnd > deferredStart);
  const deferredSql = sql.slice(deferredStart, deferredEnd);
  assert.doesNotMatch(
    deferredSql,
    /(?:current_rank|last_checked_at\s*=|next_check_at\s*=|processing_started_at\s*=|processing_until\s*=|worker_last_cycle_claimed_at\s*=|worker_quarantined_until\s*=|last_message\s*=|last_error\s*=|retry_count\s*=)/iu,
    'deferred rows preserve last-good, due order, history, error state, and leases',
  );
  assert.match(
    sql,
    /event_type[\s\S]*'tracker_deferred'[\s\S]*worker_last_cycle_deferred_at\s+is distinct from old_row\.worker_last_cycle_deferred_at/iu,
    'deferred coverage must be explicit ledger evidence, not a fabricated claim or success',
  );
  assert.match(
    sql,
    /'cycle_rostered'[\s\S]*case[\s\S]*new_row\.created_at > current_row\.scheduler_cycle_started_at[\s\S]*then 'new_after_start'[\s\S]*else 'late_observed'[\s\S]*on conflict \(cycle_id, tracker_id\)[\s\S]*where event_type = 'cycle_rostered'[\s\S]*do nothing/iu,
    'a deferred tracker first observed after cycle start must join the immutable cycle roster once',
  );
  assert.match(
    sql,
    /unique index[\s\S]*\(cycle_id, tracker_id\)[\s\S]*where event_type = 'tracker_deferred'/iu,
    'one tracker can be deferred at most once per cycle',
  );
  const claimFunctionStart = sql.indexOf(
    'create or replace function public.mi_claim_naver_shopping_cycle_keyword',
  );
  const claimFunctionEnd = sql.indexOf(
    'revoke all on function public.mi_claim_naver_shopping_cycle_keyword',
    claimFunctionStart,
  );
  assert.ok(claimFunctionStart >= 0 && claimFunctionEnd > claimFunctionStart);
  const claimFunctionSql = sql.slice(claimFunctionStart, claimFunctionEnd);
  assert.doesNotMatch(claimFunctionSql, /security definer/iu);
  assert.match(claimFunctionSql, /security invoker/iu);
  assert.match(
    sql,
    /revoke all on function mi_internal\.mi_audit_naver_shopping_tracker_deferred\(\)[\s\S]*from public, anon, authenticated, service_role;/iu,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function mi_internal\.mi_audit_naver_shopping_tracker_deferred/iu,
  );
  assert.match(
    sql,
    /revoke all on function public\.mi_claim_naver_shopping_cycle_keyword\(text, uuid, uuid, integer, uuid\)[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute[\s\S]*to service_role;/iu,
  );
});

test('bounded normalized-keyword selection never starves overflow members', () => {
  const trackers = Array.from({ length: 151 }, (_, index) => ({
    id: index + 1,
    lastCheckedAt: index < 100 ? index + 1 : null,
  }));
  const selectCycle = (rows, seedId) => [...rows]
    .sort((left, right) => {
      const seedOrder = Number(right.id === seedId) - Number(left.id === seedId);
      if (seedOrder) return seedOrder;
      const leftChecked = left.lastCheckedAt ?? Number.NEGATIVE_INFINITY;
      const rightChecked = right.lastCheckedAt ?? Number.NEGATIVE_INFINITY;
      return leftChecked - rightChecked || left.id - right.id;
    })
    .slice(0, 100);

  const first = selectCycle(trackers, 1);
  assert.equal(first.length, 100);
  assert.ok(first.some((tracker) => tracker.id === 1), 'the durable cursor seed must be included');
  const firstIds = new Set(first.map((tracker) => tracker.id));
  const deferred = trackers.filter((tracker) => !firstIds.has(tracker.id));
  assert.equal(deferred.length, 51);

  const nextSeed = deferred[0].id;
  const nextCycleRows = trackers.map((tracker) => ({
    ...tracker,
    lastCheckedAt: firstIds.has(tracker.id) ? 10_000 + tracker.id : tracker.lastCheckedAt,
  }));
  const second = selectCycle(nextCycleRows, nextSeed);
  const secondIds = new Set(second.map((tracker) => tracker.id));
  assert.ok(deferred.every((tracker) => secondIds.has(tracker.id)));
  assert.ok(secondIds.has(nextSeed));
});

test('duplicate identity is capped at one 30-minute quarantine while other failures keep escalation', () => {
  const functionStart = duplicateQuarantineMigration.indexOf(
    'create or replace function public.mi_record_naver_shopping_worker_failure',
  );
  const functionEnd = duplicateQuarantineMigration.indexOf('revoke all on function', functionStart);
  const functionSql = duplicateQuarantineMigration.slice(functionStart, functionEnd);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  assert.match(
    functionSql,
    /split_part\(normalized_error, ':', 1\) = 'provider_duplicate_identity'[\s\S]*then v_now \+ interval '30 minutes'/i,
  );
  assert.match(
    functionSql,
    /else greatest\([\s\S]*coalesce\(retry_count, 0\) >= 2 then interval '24 hours'[\s\S]*else interval '30 minutes'/i,
  );
  assert.match(functionSql, /security invoker/i);
  assert.doesNotMatch(functionSql, /security definer/i);
});

test('active duplicate quarantine repair changes only its deadline and preserves queue state', () => {
  const repairStart = duplicateQuarantineMigration.indexOf('-- Repair only the currently active');
  const repairSql = duplicateQuarantineMigration.slice(repairStart);
  assert.match(
    repairSql,
    /set worker_quarantined_until = greatest\(v_now, updated_at \+ interval '30 minutes'\)/i,
  );
  assert.match(
    repairSql,
    /lower\(trim\(coalesce\(last_error, ''\)\)\) ~ '\^provider_duplicate_identity\(\?:\:\|\$\)'/i,
  );
  assert.match(
    repairSql,
    /worker_quarantined_until > greatest\(v_now, updated_at \+ interval '30 minutes'\)/i,
  );
  assert.doesNotMatch(
    repairSql,
    /\b(?:sort_order|next_check_at|worker_last_cycle_id|retry_count|current_rank|last_checked_at|scheduler_cycle_cursor)\b/i,
  );
});

test('navigation circuit makes one ordered automatic half-open attempt after ten minutes', () => {
  const claimStart = autoNavigationHalfOpenMigration.indexOf(
    'create or replace function public.mi_claim_naver_shopping_worker_lane',
  );
  const successStart = autoNavigationHalfOpenMigration.indexOf(
    'create or replace function public.mi_record_naver_shopping_worker_success',
  );
  const claimSql = autoNavigationHalfOpenMigration.slice(claimStart, successStart);
  assert.ok(claimStart >= 0 && successStart > claimStart);
  assert.match(
    claimSql,
    /circuit_state = 'open'[\s\S]*normalized_worker_role = 'primary'[\s\S]*circuit_reason = 'navigating:naver_page_navigation_failed'[\s\S]*circuit_opened_at <= v_now - interval '10 minutes'/i,
  );
  assert.match(
    claimSql,
    /set circuit_state = 'half_open',[\s\S]*circuit_reason = 'auto_navigation_probe'[\s\S]*probe_tracker_id = null[\s\S]*failure_streak = 0/i,
  );
  assert.match(claimSql, /'autoRecovery', current_row\.circuit_reason = 'auto_navigation_probe'/i);
  assert.doesNotMatch(
    claimSql,
    /update public\.naver_rank_trackers|next_check_at|worker_quarantined_until|scheduler_cycle_cursor_/i,
    'automatic recovery must not alter tracker order, quarantine, or cursor',
  );
});

test('automatic and manual half-open success proofs stay distinct and atomic', () => {
  const successStart = autoNavigationHalfOpenMigration.indexOf(
    'create or replace function public.mi_record_naver_shopping_worker_success',
  );
  const successEnd = autoNavigationHalfOpenMigration.indexOf(
    'revoke all on function public.mi_claim_naver_shopping_worker_lane',
    successStart,
  );
  const successSql = autoNavigationHalfOpenMigration.slice(successStart, successEnd);
  assert.ok(successStart >= 0 && successEnd > successStart);
  assert.match(
    successSql,
    /circuit_reason is distinct from 'auto_navigation_probe'[\s\S]*probe_tracker_id is distinct from p_tracker_id[\s\S]*'probe_mismatch'/i,
  );
  assert.match(
    successSql,
    /circuit_reason = 'auto_navigation_probe'[\s\S]*probe_tracker_id is not null or p_tracker_id is null[\s\S]*'probe_mismatch'/i,
  );
  assert.match(successSql, /p_checked_count is distinct from 300/i);
  assert.match(successSql, /trim\(coalesce\(p_collection_id, ''\)\) !~ '\^pw-chrome-'/i);
  assert.match(successSql, /set circuit_state = 'closed',[\s\S]*failure_streak = 0/i);
});

test('automatic half-open control functions remain service-role only', () => {
  assert.equal(
    (autoNavigationHalfOpenMigration.match(/security invoker/gi) || []).length,
    2,
  );
  assert.doesNotMatch(autoNavigationHalfOpenMigration, /security definer/i);
  for (const signature of [
    'mi_claim_naver_shopping_worker_lane\\(text, text, uuid, integer, integer\\)',
    'mi_record_naver_shopping_worker_success\\([\\s\\S]*?text, uuid, uuid, uuid, text, integer, integer, integer, text[\\s\\S]*?\\)',
  ]) {
    assert.match(
      autoNavigationHalfOpenMigration,
      new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*?from public, anon, authenticated, service_role;[\\s\\S]*?grant execute[\\s\\S]*?to service_role;`, 'i'),
    );
  }
});

test('tracker-scoped half-open failure closes only the recovered navigation circuit', () => {
  const functionStart = autoNavigationTrackerFailureRecoveryMigration.indexOf(
    'create or replace function public.mi_release_naver_shopping_worker_lane',
  );
  const functionEnd = autoNavigationTrackerFailureRecoveryMigration.indexOf(
    'revoke all on function public.mi_release_naver_shopping_worker_lane',
    functionStart,
  );
  const functionSql = autoNavigationTrackerFailureRecoveryMigration.slice(functionStart, functionEnd);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  assert.match(
    functionSql,
    /circuit_state = 'half_open'[\s\S]*circuit_reason = 'auto_navigation_probe'[\s\S]*current_stage = 'failed'/i,
  );
  for (const code of [
    'local_worker_submit_body_too_large',
    'provider_duplicate_identity',
    'provider_partial_window',
    'provider_row_invalid',
    'provider_row_title_missing',
    'provider_row_identity_missing',
  ]) {
    assert.match(functionSql, new RegExp(`'${code}'`, 'i'));
  }
  assert.match(
    functionSql,
    /when auto_navigation_recovered then 'closed'[\s\S]*when current_row\.circuit_state = 'half_open' then 'open'/i,
  );
  assert.match(
    functionSql,
    /when auto_navigation_recovered then null[\s\S]*when current_row\.circuit_state = 'half_open' then 'probe_incomplete'/i,
  );
  assert.doesNotMatch(
    functionSql,
    /last_success|update public\.naver_rank_trackers|next_check_at|worker_quarantined_until|scheduler_cycle_cursor_|worker_last_cycle_id/i,
    'navigation recovery must not fabricate success or alter tracker order/quarantine',
  );
});

test('one-time false-open repair is exact, control-plane only, and service-role only', () => {
  const repairStart = autoNavigationTrackerFailureRecoveryMigration.indexOf('-- Repair only the exact live state');
  const repairSql = autoNavigationTrackerFailureRecoveryMigration.slice(repairStart);
  assert.match(
    repairSql,
    /circuit_state = 'open'[\s\S]*circuit_reason = 'probe_incomplete'[\s\S]*primary_seen_at > clock_timestamp\(\) - interval '5 minutes'[\s\S]*last_failure_at > clock_timestamp\(\) - interval '1 day'/i,
  );
  assert.match(repairSql, /set circuit_state = 'closed'/i);
  assert.doesNotMatch(
    repairSql,
    /update public\.naver_rank_trackers|next_check_at|worker_quarantined_until|scheduler_cycle_cursor_|worker_last_cycle_id|insert into public\.naver_shopping_worker_wakes/i,
  );
  assert.match(autoNavigationTrackerFailureRecoveryMigration, /security invoker/i);
  assert.doesNotMatch(autoNavigationTrackerFailureRecoveryMigration, /security definer/i);
  assert.match(
    autoNavigationTrackerFailureRecoveryMigration,
    /revoke all on function public\.mi_release_naver_shopping_worker_lane\(text, uuid\)[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute[\s\S]*to service_role;/i,
  );
});

test('navigation probe terminal states retry only the same typed failure after ten quiet minutes', () => {
  assert.match(
    probeIncompleteAutoRecoveryMigration,
    /circuit_state = 'open'[\s\S]*normalized_worker_role = 'primary'[\s\S]*circuit_reason in \([\s\S]*'navigating:naver_page_navigation_failed'[\s\S]*'probe_incomplete'[\s\S]*'probe_interrupted'[\s\S]*\)[\s\S]*last_failure_code[\s\S]*= 'naver_page_navigation_failed'[\s\S]*circuit_opened_at <= v_now - interval '10 minutes'/i,
  );
  assert.match(
    probeIncompleteAutoRecoveryMigration,
    /set circuit_state = 'half_open',[\s\S]*circuit_reason = 'auto_navigation_probe'[\s\S]*cadence_minutes = 10/i,
  );
  assert.match(
    probeIncompleteAutoRecoveryMigration,
    /and \(current_row\.lease_until is null or current_row\.lease_until <= v_now\)/i,
  );
  assert.doesNotMatch(
    probeIncompleteAutoRecoveryMigration,
    /update public\.naver_rank_trackers|next_check_at|worker_quarantined_until|scheduler_cycle_cursor_|worker_last_cycle_id|insert into public\.naver_shopping_worker_wakes/i,
    'bounded recovery must not alter tracker order, quarantine, wake, or durable cursor',
  );
  assert.match(probeIncompleteAutoRecoveryMigration, /security invoker/i);
  assert.doesNotMatch(probeIncompleteAutoRecoveryMigration, /security definer/i);
  assert.match(
    probeIncompleteAutoRecoveryMigration,
    /revoke all on function public\.mi_claim_naver_shopping_worker_lane\(text, text, uuid, integer, integer\)[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute[\s\S]*to service_role;/i,
  );
});

test('runtime 1.1.9 candidate cadence requires zero active lookup and tracker leases', () => {
  const operationsSql = runtime119FunctionSql(
    'mi_get_naver_shopping_worker_operations',
    'mi_set_naver_shopping_worker_cadence',
  );
  const cadenceSql = runtime119FunctionSql('mi_set_naver_shopping_worker_cadence');
  const activeLeaseCountPattern = /select \(\s*\(select count\(\*\) from public\.naver_shopping_rank_lookup_jobs\s*where status = 'processing' and processing_until > v_now\)\s*\+\s*\(select count\(\*\) from public\.naver_rank_trackers\s*where status = 'active' and processing_until > v_now\)\s*\)::integer into processing_count;/iu;

  assert.match(operationsSql, activeLeaseCountPattern);
  assert.match(
    operationsSql,
    /'candidate_eligible',[\s\S]*?current_row\.circuit_state = 'closed'[\s\S]*?and processing_count = 0[\s\S]*?current_row\.runtime_version = '1\.1\.9'/iu,
  );
  assert.match(
    cadenceSql,
    /where lane_key = 'global'\s*for update;[\s\S]*select \([\s\S]*?into processing_count;[\s\S]*eligible :=/iu,
    'the coordination row lock must precede the active-lease snapshot',
  );
  assert.match(cadenceSql, activeLeaseCountPattern);
  assert.match(
    cadenceSql,
    /eligible :=[\s\S]*?current_row\.circuit_state = 'closed'[\s\S]*?and processing_count = 0[\s\S]*?current_row\.runtime_version = '1\.1\.9'/iu,
  );

  const candidateAllowed = (lookupProcessing, trackerProcessing) => (
    lookupProcessing + trackerProcessing === 0
  );
  for (const [lookupProcessing, trackerProcessing, expected] of [
    [0, 0, true],
    [1, 0, false],
    [0, 1, false],
    [1, 1, false],
  ]) {
    assert.equal(candidateAllowed(lookupProcessing, trackerProcessing), expected);
  }
});

test('runtime 1.1.10 resets proof and preserves atomic, lease-free candidate gates', () => {
  assert.ok(runtime110Migration, 'runtime 1.1.10 needs an additive identity migration');
  assert.equal(
    runtime110Migration.file,
    '20260821180000_naver_shopping_runtime_1_1_10.sql',
  );
  const sql = runtime110Migration.source;
  assert.match(sql, /trim\(coalesce\(p_runtime_version, ''\)\) <> '1\.1\.10'/iu);
  assert.match(
    sql,
    /set cadence_mode = 'baseline',\s*cadence_minutes = 10,\s*stability_started_at = null,\s*success_streak = 0/iu,
  );
  assert.match(
    sql,
    /runtime_version is distinct from trim\(p_runtime_version\)[\s\S]*runtime_fingerprint is distinct from lower\(trim\(p_runtime_fingerprint\)\)[\s\S]*then 'baseline'[\s\S]*stability_started_at = case[\s\S]*then null[\s\S]*success_streak = case[\s\S]*then 0/iu,
  );
  assert.match(
    sql,
    /'candidate_eligible',[\s\S]*current_row\.circuit_state = 'closed'[\s\S]*and processing_count = 0[\s\S]*current_row\.runtime_version = '1\.1\.10'[\s\S]*last_checked_count = 300[\s\S]*last_source = 'naver_shopping_results_collector'/iu,
  );
  assert.match(
    sql,
    /eligible :=[\s\S]*current_row\.circuit_state = 'closed'[\s\S]*and processing_count = 0[\s\S]*current_row\.runtime_version = '1\.1\.10'[\s\S]*last_checked_count = 300[\s\S]*last_source = 'naver_shopping_results_collector'/iu,
  );
  assert.match(sql, /security invoker/iu);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.match(
    sql,
    /revoke all on function public\.mi_report_naver_shopping_worker_progress[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute[\s\S]*to service_role;/iu,
  );
});

test('runtime 1.1.11 exactly preserves the 1.1.10 atomic, processing-zero, identity-reset contract', () => {
  assert.ok(runtime111Migration, 'runtime 1.1.11 needs an additive identity migration');
  assert.equal(
    runtime111Migration.file,
    '20260821180002_naver_shopping_runtime_1_1_11.sql',
  );
  const sql = runtime111Migration.source;
  assert.equal(
    sql.replaceAll('1.1.11', '1.1.10'),
    runtime110Migration.source,
    '1.1.11 may change only the exact accepted runtime identity',
  );
  assert.match(sql, /trim\(coalesce\(p_runtime_version, ''\)\) <> '1\.1\.11'/iu);
  assert.match(
    sql,
    /set cadence_mode = 'baseline',\s*cadence_minutes = 10,\s*stability_started_at = null,\s*success_streak = 0/iu,
  );
  assert.match(
    sql,
    /runtime_version is distinct from trim\(p_runtime_version\)[\s\S]*runtime_fingerprint is distinct from lower\(trim\(p_runtime_fingerprint\)\)[\s\S]*then 'baseline'[\s\S]*stability_started_at = case[\s\S]*then null[\s\S]*success_streak = case[\s\S]*then 0/iu,
  );
  assert.match(
    sql,
    /'candidate_eligible',[\s\S]*current_row\.circuit_state = 'closed'[\s\S]*and processing_count = 0[\s\S]*current_row\.runtime_version = '1\.1\.11'[\s\S]*last_collection_id ~ '\^pw-chrome-'[\s\S]*last_checked_count = 300[\s\S]*last_source = 'naver_shopping_results_collector'/iu,
  );
  assert.match(
    sql,
    /eligible :=[\s\S]*current_row\.circuit_state = 'closed'[\s\S]*and processing_count = 0[\s\S]*lease_until is null or current_row\.lease_until <= v_now[\s\S]*cooldown_until is null or current_row\.cooldown_until <= v_now[\s\S]*current_row\.runtime_version = '1\.1\.11'[\s\S]*last_collection_id ~ '\^pw-chrome-'[\s\S]*last_checked_count = 300[\s\S]*last_source = 'naver_shopping_results_collector'/iu,
  );
  assert.equal([...sql.matchAll(/security invoker/giu)].length, 3);
  assert.equal([...sql.matchAll(/set search_path = ''/giu)].length, 3);
  assert.doesNotMatch(sql, /security definer/iu);
  for (const signature of [
    'mi_report_naver_shopping_worker_progress\\(text, uuid, uuid, text, integer, text, uuid, text, text\\)',
    'mi_get_naver_shopping_worker_operations\\(\\)',
    'mi_set_naver_shopping_worker_cadence\\(text\\)',
  ]) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${signature}\\s+from public, anon, authenticated, service_role`, 'iu'),
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${signature}\\s+to service_role`, 'iu'),
    );
  }
});

test('runtime 1.1.12 exactly preserves the 1.1.11 atomic, processing-zero, identity-reset contract', () => {
  assert.ok(runtime1112Migration, 'runtime 1.1.12 needs an additive identity migration');
  assert.equal(
    runtime1112Migration.file,
    '20260824042226_naver_shopping_runtime_1_1_12.sql',
  );
  assert.equal(
    runtime1112Migration.source.replaceAll('1.1.12', '1.1.11'),
    runtime111Migration.source,
    '1.1.12 may change only the exact accepted runtime identity',
  );
});

test('runtime 1.1.11 candidate gate remains the byte-identical prior contract', () => {
  assert.ok(runtime111ExactCandidateGateMigration, 'the prior exact gate must remain present');
  assert.ok(runtime1112ExactCandidateGateMigration, 'the current exact gate must remain present');
  assert.equal(
    runtime1112ExactCandidateGateMigration.source
      .replaceAll('1.1.12', '1.1.11')
      .replaceAll(
        '862b3779b7f4c96db52005a090888d80facb653a598a5141093557cb2eef7e8e',
        '6461e835e840ff873711f38a223ab1a7a06b3e2945822a92cce49e50a295cf00',
      ),
    runtime111ExactCandidateGateMigration.source,
  );
});

test('runtime 1.1.12 candidate cadence is exact-identity and completely idle inside the database lock', () => {
  assert.ok(
    runtime1112ExactCandidateGateMigration,
    'an additive migration must bind candidate cadence to the installed fingerprint and a fully idle lane',
  );
  assert.match(
    runtime1112ExactCandidateGateMigration.file,
    /^\d{14}_naver_shopping_runtime_1_1_12_exact_candidate_gate\.sql$/u,
  );
  const sql = runtime1112ExactCandidateGateMigration.source;
  const expectedFingerprint = '862b3779b7f4c96db52005a090888d80facb653a598a5141093557cb2eef7e8e';
  const functionNames = [...sql.matchAll(/create or replace function public\.(mi_[a-z0-9_]+)\(/giu)]
    .map((match) => match[1]);
  assert.deepEqual(functionNames, [
    'mi_get_naver_shopping_worker_operations',
    'mi_set_naver_shopping_worker_cadence',
  ]);

  for (const marker of ["'candidate_eligible'", 'eligible :=']) {
    const start = sql.indexOf(marker);
    assert.ok(start >= 0, `${marker} candidate predicate must exist`);
    const predicate = sql.slice(start, start + 2600);
    assert.match(predicate, /current_row\.circuit_state = 'closed'/iu);
    assert.match(predicate, /current_row\.circuit_reason is null/iu);
    assert.match(predicate, /processing_count = 0/iu);
    assert.match(predicate, /current_row\.lease_worker_id is null/iu);
    assert.match(predicate, /current_row\.lease_token is null/iu);
    assert.match(predicate, /current_row\.lease_until is null/iu);
    assert.match(predicate, /current_row\.run_id is null/iu);
    assert.match(predicate, /current_row\.current_stage is null/iu);
    assert.match(predicate, /current_row\.current_page = 0/iu);
    assert.match(predicate, /current_row\.current_job_kind is null/iu);
    assert.match(predicate, /current_row\.current_tracker_id is null/iu);
    assert.match(predicate, /current_row\.current_job_started_at is null/iu);
    assert.match(predicate, /current_row\.probe_started_at is null/iu);
    assert.match(predicate, /current_row\.probe_tracker_id is null/iu);
    assert.match(predicate, /current_row\.cooldown_until is null/iu);
    assert.match(predicate, /current_row\.primary_worker_id = 'windows-desktop-primary'/iu);
    assert.match(predicate, /current_row\.primary_seen_at > v_now - interval '3 minutes'/iu);
    assert.match(predicate, /current_row\.cadence_mode = 'baseline'/iu);
    assert.match(predicate, /current_row\.cadence_minutes = 10/iu);
    assert.match(predicate, /current_row\.stability_started_at is not null/iu);
    assert.match(predicate, /current_row\.stability_started_at <= v_now - interval '24 hours'/iu);
    assert.match(predicate, /current_row\.success_streak >= 6/iu);
    assert.match(predicate, /current_row\.last_success_at is not null/iu);
    assert.match(predicate, /current_row\.last_success_at > v_now - interval '15 minutes'/iu);
    assert.match(predicate, /current_row\.runtime_version = '1\.1\.12'/iu);
    assert.match(
      predicate,
      new RegExp(`current_row\\.runtime_fingerprint = '${expectedFingerprint}'`, 'iu'),
    );
    assert.match(predicate, /current_row\.last_collection_id ~ '\^pw-chrome-'/iu);
    assert.match(predicate, /current_row\.last_checked_count = 300/iu);
    assert.match(predicate, /current_row\.last_source = 'naver_shopping_results_collector'/iu);
  }

  assert.match(
    sql,
    /where lane_key = 'global'\s*for update;[\s\S]*select \([\s\S]*into processing_count;[\s\S]*eligible :=/iu,
    'candidate activation must lock coordination before checking processing leases and idle state',
  );
  assert.equal([...sql.matchAll(/security invoker/giu)].length, 2);
  assert.equal([...sql.matchAll(/set search_path = ''/giu)].length, 2);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.doesNotMatch(sql, /stability_started_at\s*=/iu, 'the gate migration must not reset the live 24-hour anchor');
  assert.doesNotMatch(sql, /success_streak\s*=/iu, 'the gate migration must not reset the live atomic-success proof');
  for (const signature of [
    'mi_get_naver_shopping_worker_operations\\(\\)',
    'mi_set_naver_shopping_worker_cadence\\(text\\)',
  ]) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${signature}\\s+from public, anon, authenticated, service_role`, 'iu'),
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${signature}\\s+to service_role`, 'iu'),
    );
  }

  const candidateAllowed = ({
    fingerprint,
    runId = null,
    leaseWorkerId = null,
    cooldownUntil = null,
    primarySeenAt = Date.now(),
    cadenceMode = 'baseline',
  }) => (
    fingerprint === expectedFingerprint
    && runId === null
    && leaseWorkerId === null
    && cooldownUntil === null
    && primarySeenAt > Date.now() - 3 * 60_000
    && cadenceMode === 'baseline'
  );
  assert.equal(candidateAllowed({ fingerprint: expectedFingerprint }), true);
  assert.equal(candidateAllowed({ fingerprint: 'f'.repeat(64) }), false);
  assert.equal(candidateAllowed({ fingerprint: expectedFingerprint, runId: 'stale-run' }), false);
  assert.equal(candidateAllowed({ fingerprint: expectedFingerprint, leaseWorkerId: 'stale-worker' }), false);
  assert.equal(candidateAllowed({ fingerprint: expectedFingerprint, cooldownUntil: 'expired-but-uncleared' }), false);
  assert.equal(candidateAllowed({ fingerprint: expectedFingerprint, primarySeenAt: Date.now() - 3 * 60_000 - 1 }), false);
  assert.equal(candidateAllowed({ fingerprint: expectedFingerprint, cadenceMode: 'candidate' }), false);
});

test('runtime 1.1.13 candidate6 replaces the impossible 8-minute ceiling without weakening safety', () => {
  assert.ok(
    runtime113Candidate6Migration,
    'an additive runtime migration must introduce the minimum cadence that can exceed 8.77 group/hour',
  );
  assert.match(
    runtime113Candidate6Migration.file,
    /^\d{14}_naver_shopping_runtime_1_1_13_candidate_6_minute_cadence\.sql$/u,
  );
  const sql = runtime113Candidate6Migration.source;
  const runtimeFiles = [
    '../tools/naver-shopping-chrome-extension/service-worker.js',
    './naver-shopping-native-host.mjs',
    './naver-shopping-native-host-core.mjs',
    './naver-shopping-local-worker.mjs',
    '../src/server/local-worker-auth.mjs',
    '../src/server/naver-shopping/local-worker-contract.mjs',
    '../src/server/handlers/naver-shopping-rank.mjs',
    '../src/server/security.mjs',
    '../src/server/naver-shopping/source-status.mjs',
    '../src/server/naver-shopping/provider-runtime.mjs',
    '../src/server/naver-shopping/mobile-top-fallback.mjs',
    '../tools/naver-shopping-rank-collector/src/provider.mjs',
    '../tools/naver-shopping-rank-collector/src/contract.mjs',
  ];
  const runtimeHashes = runtimeFiles.map((file) => crypto.createHash('sha256')
    .update(readFileSync(new URL(file, import.meta.url)))
    .digest('hex'));
  const expectedFingerprint = crypto.createHash('sha256')
    .update(['1.1.13', ...runtimeHashes].join('\n'), 'utf8')
    .digest('hex');
  const expectedFunctions = [
    'mi_report_naver_shopping_worker_progress',
    'mi_get_naver_shopping_worker_operations',
    'mi_record_naver_shopping_worker_failure',
    'mi_record_naver_shopping_worker_success',
    'mi_set_naver_shopping_worker_cadence',
  ];
  const functionNames = [...sql.matchAll(/create or replace function public\.(mi_[a-z0-9_]+)\(/giu)]
    .map((match) => match[1]);
  assert.deepEqual(functionNames, expectedFunctions);
  assert.match(sql, /drop constraint if exists naver_shopping_worker_coordination_cadence_check/iu);
  const strongestLockIndex = sql.indexOf(
    'lock table public.naver_shopping_worker_coordination in access exclusive mode;',
  );
  const coordinationRowLockIndex = sql.indexOf(
    "from public.naver_shopping_worker_coordination\n  where lane_key = 'global'\n  for update;",
  );
  assert.match(sql, /set local lock_timeout = '5s';/iu);
  assert.ok(
    strongestLockIndex >= 0 && coordinationRowLockIndex > strongestLockIndex,
    'migration must acquire its strongest coordination table lock before the idle row lock',
  );
  assert.match(sql, /cadence_mode = 'candidate' and cadence_minutes = 6/iu);
  assert.match(sql, /set cadence_mode = 'baseline',\s*cadence_minutes = 10,\s*stability_started_at = null,\s*success_streak = 0/iu);
  assert.match(sql, /runtime_version = '1\.1\.13'/iu);
  assert.match(sql, /set cadence_mode = 'candidate', cadence_minutes = 6/iu);
  assert.match(sql, /'mode', 'candidate', 'minutes', 6/iu);
  assert.equal(
    [...sql.matchAll(new RegExp(`runtime_fingerprint = '${expectedFingerprint}'`, 'gu'))].length,
    3,
  );
  assert.doesNotMatch(sql, /cadence_mode = 'candidate' and cadence_minutes = 8/iu);
  assert.doesNotMatch(sql, /'mode', 'candidate', 'minutes', 8/iu);
  assert.match(sql, /create table if not exists public\.naver_shopping_worker_runs/iu);
  assert.match(sql, /run_id uuid primary key/iu);
  assert.match(sql, /run_trigger text not null/iu);
  assert.match(sql, /insert into public\.naver_shopping_worker_runs/iu);
  assert.match(sql, /if normalized_stage = 'navigating' then[\s\S]+insert into public\.naver_shopping_worker_runs/iu);
  assert.match(sql, /on conflict \(run_id\) do nothing/iu);
  assert.match(sql, /naver_shopping_worker_run_provenance_mismatch/iu);
  assert.match(sql, /grant select, insert on table public\.naver_shopping_worker_runs\s+to service_role/iu);
  assert.doesNotMatch(sql, /grant (?:update|delete|all)[^;]*naver_shopping_worker_runs/iu);
  assert.equal([...sql.matchAll(/security invoker/giu)].length, expectedFunctions.length);
  assert.equal([...sql.matchAll(/set search_path = ''/giu)].length, expectedFunctions.length);
  assert.doesNotMatch(sql, /security definer/iu);
  for (const signature of [
    'mi_report_naver_shopping_worker_progress\\(text, uuid, uuid, text, integer, text, uuid, text, text, text\\)',
    'mi_get_naver_shopping_worker_operations\\(\\)',
    'mi_record_naver_shopping_worker_failure\\(text, uuid, uuid, text, text, uuid\\)',
    'mi_record_naver_shopping_worker_success\\(text, uuid, uuid, uuid, text, integer, integer, integer, text\\)',
    'mi_set_naver_shopping_worker_cadence\\(text\\)',
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${signature}\\s+from public, anon, authenticated, service_role`, 'iu'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${signature}\\s+to service_role`, 'iu'));
  }
});

test('atomic success proof is ledger-backed, complete, organic and retry-idempotent', () => {
  assert.ok(
    atomicSuccessProofHardeningMigration,
    'an additive migration must bind each atomic success to immutable group, commit, and snapshot proof',
  );
  assert.match(
    atomicSuccessProofHardeningMigration.file,
    /^\d{14}_naver_shopping_atomic_success_proof_hardening\.sql$/u,
  );
  const sql = atomicSuccessProofHardeningMigration.source;
  const functionNames = [...sql.matchAll(/create or replace function public\.(mi_[a-z0-9_]+)\(/giu)]
    .map((match) => match[1]);
  assert.deepEqual(functionNames, [
    'mi_record_naver_shopping_worker_success',
    'mi_set_naver_shopping_worker_cadence',
  ]);

  const successStart = sql.indexOf(
    'create or replace function public.mi_record_naver_shopping_worker_success',
  );
  const successEnd = sql.indexOf(
    'create or replace function public.mi_set_naver_shopping_worker_cadence',
    successStart + 1,
  );
  assert.ok(successStart >= 0 && successEnd > successStart);
  const successSql = sql.slice(successStart, successEnd);
  const successDeclaration = successSql.slice(0, successSql.indexOf('begin'));
  assert.match(successDeclaration, /v_now timestamptz;/iu);
  assert.doesNotMatch(successDeclaration, /v_now timestamptz\s*:=\s*clock_timestamp\(\)/iu);
  assert.match(
    successSql,
    /select \* into current_row[\s\S]*where lane_key = 'global'\s*for update;\s*v_now := clock_timestamp\(\);/iu,
    'the global row must be locked before the fresh lease/proof clock is read',
  );
  assert.match(
    successSql,
    /lease_worker_id is distinct from lower\(trim\(coalesce\(p_worker_id, ''\)\)\)[\s\S]*lease_token is distinct from p_lane_token[\s\S]*run_id is distinct from p_run_id[\s\S]*lease_until <= v_now[\s\S]*circuit_state = 'open'/iu,
  );
  assert.match(
    successSql,
    /current_row\.current_job_kind is distinct from 'tracker'[\s\S]*current_row\.current_tracker_id is distinct from p_tracker_id[\s\S]*atomic_current_job_mismatch/iu,
    'a delayed prior-group success must not count after the live run advances to another tracker job',
  );
  assert.match(
    successSql,
    /into representative_commit_count[\s\S]*event_type = 'tracker_committed'[\s\S]*committed\.run_id = p_run_id[\s\S]*committed\.worker_id = current_row\.lease_worker_id[\s\S]*committed\.tracker_id = p_tracker_id[\s\S]*committed\.collection_id = normalized_collection_id[\s\S]*representative_commit_count <> 1/iu,
    'the representative tracker and collection must identify exactly one commit in the live run',
  );
  assert.match(
    successSql,
    /select committed\.claim_id, committed\.group_fingerprint[\s\S]*committed\.tracker_id = p_tracker_id[\s\S]*committed\.collection_id = normalized_collection_id/iu,
    'claim scope must be derived from the exact representative commit',
  );
  assert.match(
    successSql,
    /event_type = 'group_claimed'[\s\S]*event\.claim_id = group_claim_id[\s\S]*event\.run_id = p_run_id[\s\S]*event\.worker_id = current_row\.lease_worker_id[\s\S]*event\.group_fingerprint = expected_group_fingerprint[\s\S]*group_claim_count <> 1/iu,
    'one and only one immutable group must identify the current claim, not the whole worker run',
  );
  assert.match(
    successSql,
    /event_type = 'job_failed'[\s\S]*failed\.claim_id = group_claim_id/iu,
    'a failed claim can never contribute an atomic success',
  );
  assert.match(
    successSql,
    /into tracker_claim_count[\s\S]*event_type = 'tracker_claimed'[\s\S]*claimed\.claim_id = group_claim_id[\s\S]*tracker_claim_count < 1/iu,
  );
  assert.match(
    successSql,
    /event_type = 'tracker_claimed'[\s\S]*claimed\.claim_id = group_claim_id[\s\S]*event_type = 'tracker_committed'[\s\S]*committed\.claim_id = claimed\.claim_id[\s\S]*committed\.run_id = p_run_id[\s\S]*committed\.worker_id = current_row\.lease_worker_id[\s\S]*committed\.tracker_id = claimed\.tracker_id[\s\S]*committed\.collection_id = normalized_collection_id[\s\S]*committed\.checked_count = 300/iu,
  );
  assert.match(
    successSql,
    /naver_rank_snapshots as snapshot[\s\S]*snapshot\.tracker_id = claimed\.tracker_id[\s\S]*snapshot\.collection_id = normalized_collection_id[\s\S]*snapshot\.checked_count = 300[\s\S]*snapshot\.source = 'naver_shopping_results_collector'/iu,
  );
  assert.match(successSql, /snapshot\.matched = false[\s\S]*snapshot\.item -> 'isOrganic' = 'true'::jsonb/iu);
  assert.match(successSql, /snapshot\.item -> 'adExcluded' = 'true'::jsonb/iu);
  assert.match(successSql, /snapshot\.item ->> 'rankPolicy' = 'organic_only'/iu);
  assert.match(successSql, /snapshot\.item ->> 'rankEvidence' = 'naver_shopping_organic_list'/iu);
  assert.match(successSql, /snapshot\.item ->> 'collectionId' = normalized_collection_id/iu);
  assert.match(
    successSql,
    /snapshot\.item -> 'excludedAdCount' = pg_catalog\.to_jsonb\(p_excluded_ad_count\)/iu,
  );
  assert.match(
    successSql,
    /jsonb_array_elements\(\s*case when pg_catalog\.jsonb_typeof\(snapshot\.top_items\) = 'array'[\s\S]*else '\[\]'::jsonb end\s*\)/iu,
    'malformed top-item JSON must reject proof instead of aborting the control RPC',
  );

  const retryStart = successSql.indexOf('if current_row.last_collection_id = normalized_collection_id then');
  const retryEnd = successSql.indexOf('end if;', retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retryBranch = successSql.slice(retryStart, retryEnd);
  assert.match(retryBranch, /'recorded', true/iu);
  assert.match(retryBranch, /'alreadyRecorded', true/iu);
  assert.doesNotMatch(
    retryBranch,
    /\bupdate\b|(?:success_streak|stability_started_at)\s*=/iu,
    'a retry may read eligibility state but must not assign or update it',
  );
  assert.ok(
    retryStart < successSql.indexOf('next_success_streak :='),
    'an ambiguous response retry must return before incrementing the proof streak',
  );

  assert.match(successSql, /current_row\.circuit_reason is distinct from 'auto_navigation_probe'/iu);
  assert.match(successSql, /current_row\.circuit_reason is distinct from 'auto_transient_system_probe'/iu);
  assert.match(successSql, /set worker_quarantined_until = null/iu);
  assert.match(successSql, /security invoker/iu);
  assert.match(successSql, /set search_path = ''/iu);
});

test('candidate cadence refreshes its clock after locking and otherwise preserves the exact gate', () => {
  assert.ok(atomicSuccessProofHardeningMigration);
  const sql = atomicSuccessProofHardeningMigration.source;
  const candidateStart = sql.indexOf(
    'create or replace function public.mi_set_naver_shopping_worker_cadence',
  );
  const candidateEnd = sql.indexOf(
    'revoke all on function public.mi_record_naver_shopping_worker_success',
    candidateStart + 1,
  );
  assert.ok(candidateStart >= 0 && candidateEnd > candidateStart);
  const candidateSql = sql.slice(candidateStart, candidateEnd);
  const declaration = candidateSql.slice(0, candidateSql.indexOf('begin'));
  assert.match(declaration, /v_now timestamptz;/iu);
  assert.doesNotMatch(declaration, /v_now timestamptz\s*:=\s*clock_timestamp\(\)/iu);
  assert.match(
    candidateSql,
    /where lane_key = 'global'\s*for update;\s*v_now := clock_timestamp\(\);\s*select \(/iu,
  );
  assert.doesNotMatch(candidateSql, /stability_started_at\s*=/iu);
  assert.doesNotMatch(candidateSql, /success_streak\s*=/iu);
  assert.match(candidateSql, /security invoker/iu);
  assert.match(candidateSql, /set search_path = ''/iu);
  assert.match(
    sql,
    /revoke all on function public\.mi_record_naver_shopping_worker_success\(text, uuid, uuid, uuid, text, integer, integer, integer, text\)\s*from public, anon, authenticated, service_role;[\s\S]*grant execute on function public\.mi_record_naver_shopping_worker_success\(text, uuid, uuid, uuid, text, integer, integer, integer, text\)\s*to service_role;/iu,
  );
  assert.match(
    sql,
    /revoke all on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s*from public, anon, authenticated, service_role;[\s\S]*grant execute on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s*to service_role;/iu,
  );
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

test('same-run groups each count once and both immediate and delayed retries do not count twice', () => {
  const record = (state, proof) => {
    if (!state.liveRun
      || state.currentJobKind !== 'tracker'
      || state.currentTrackerId !== proof.trackerId
      || !state.validClaimIds.has(proof.claimId)) {
      return { ...state, recorded: false, alreadyRecorded: false };
    }
    if (state.lastCollectionId === proof.collectionId) {
      return { ...state, recorded: true, alreadyRecorded: true };
    }
    return {
      ...state,
      lastCollectionId: proof.collectionId,
      successStreak: state.successStreak + 1,
      stabilityStartedAt: state.stabilityStartedAt || 1,
      recorded: true,
      alreadyRecorded: false,
    };
  };
  const initial = {
    liveRun: true,
    runId: 'same-worker-run',
    currentJobKind: 'tracker',
    currentTrackerId: 'tracker-a',
    validClaimIds: new Set(['claim-a', 'claim-b']),
    lastCollectionId: 'pw-chrome-prior',
    successStreak: 5,
    stabilityStartedAt: 123,
  };
  const groupA = record(initial, {
    claimId: 'claim-a',
    trackerId: 'tracker-a',
    collectionId: 'pw-chrome-group-a',
  });
  const groupB = record({ ...groupA, currentTrackerId: 'tracker-b' }, {
    claimId: 'claim-b',
    trackerId: 'tracker-b',
    collectionId: 'pw-chrome-group-b',
  });
  const immediateRetry = record(groupB, {
    claimId: 'claim-b',
    trackerId: 'tracker-b',
    collectionId: 'pw-chrome-group-b',
  });
  const delayedPriorRetry = record(groupB, {
    claimId: 'claim-a',
    trackerId: 'tracker-a',
    collectionId: 'pw-chrome-group-a',
  });
  assert.equal(groupA.runId, groupB.runId);
  assert.equal(groupA.successStreak, 6);
  assert.equal(groupB.successStreak, 7);
  assert.equal(immediateRetry.successStreak, 7);
  assert.equal(immediateRetry.stabilityStartedAt, 123);
  assert.equal(immediateRetry.alreadyRecorded, true);
  assert.equal(delayedPriorRetry.successStreak, 7);
  assert.equal(delayedPriorRetry.recorded, false);
});

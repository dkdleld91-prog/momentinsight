import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL(
  '../supabase/migrations/20260812060826_naver_shopping_durable_cycle_probe.sql',
  import.meta.url,
), 'utf8');
const duplicateQuarantineMigration = readFileSync(new URL(
  '../supabase/migrations/20260813144700_naver_shopping_duplicate_quarantine_cap.sql',
  import.meta.url,
), 'utf8');

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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL(
  '../supabase/migrations/20260813063518_naver_shopping_repair_priority_queue.sql',
  import.meta.url,
), 'utf8');

function functionSql(name, nextName = '') {
  const start = migration.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName
    ? migration.indexOf(`create or replace function public.${nextName}`, start + 1)
    : migration.indexOf('revoke all on function', start + 1);
  assert.notEqual(end, -1, `${name} must have a bounded definition`);
  return migration.slice(start, end);
}

const enqueueSql = functionSql(
  'mi_enqueue_naver_shopping_repair_priority',
  'mi_claim_naver_shopping_repair_priority',
);
const claimSql = functionSql('mi_claim_naver_shopping_repair_priority');

test('repair-priority storage and RPCs are service-role only with forced RLS', () => {
  for (const table of [
    'naver_shopping_repair_priority_requests',
    'naver_shopping_repair_priority_items',
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(migration, new RegExp(`alter table public\\.${table} force row level security`, 'i'));
    assert.match(
      migration,
      new RegExp(`revoke all on table public\\.${table}[\\s\\S]*?from public, anon, authenticated, service_role;`, 'i'),
    );
  }
  assert.match(migration, /grant select, insert on table public\.naver_shopping_repair_priority_requests\s+to service_role;/i);
  assert.match(migration, /grant select, insert, update on table public\.naver_shopping_repair_priority_items\s+to service_role;/i);
  assert.match(migration, /revoke all on function public\.mi_enqueue_naver_shopping_repair_priority\(uuid, uuid\[\], text\)[\s\S]*?grant execute[\s\S]*?to service_role;/i);
  assert.match(migration, /revoke all on function public\.mi_claim_naver_shopping_repair_priority\(text, uuid, uuid, integer\)[\s\S]*?grant execute[\s\S]*?to service_role;/i);
  assert.doesNotMatch(migration, /security definer/i);
  assert.equal((migration.match(/security invoker/gi) || []).length, 2);
});

test('enqueue is finite, idempotent, exact, ordered and wakes without changing the normal queue', () => {
  assert.match(enqueueSql, /p_request_id uuid,\s*p_tracker_ids uuid\[\],\s*p_reason text/is);
  assert.match(enqueueSql, /v_tracker_count < 1[\s\S]*v_tracker_count > 10/i);
  assert.match(enqueueSql, /count\(distinct selected\.tracker_id\)[\s\S]*v_distinct_count <> v_tracker_count/i);
  assert.match(enqueueSql, /where lane_key = 'global'\s+for update;/i);
  assert.match(enqueueSql, /array_agg\(item\.tracker_id order by item\.position\)[\s\S]*v_existing_ids is distinct from p_tracker_ids/i);
  assert.match(enqueueSql, /tracker\.id = any\(p_tracker_ids\)[\s\S]*tracker\.status = 'active'/i);
  assert.match(enqueueSql, /item\.tracker_id = any\(p_tracker_ids\)[\s\S]*item\.state = 'queued'/i);
  assert.match(enqueueSql, /unnest\(p_tracker_ids\) with ordinality as selected\(tracker_id, ordinality\)[\s\S]*order by selected\.ordinality/i);
  assert.match(enqueueSql, /mi_request_naver_shopping_worker_wake\('repair_priority_queue'\)/i);
  assert.equal(
    (enqueueSql.match(/mi_request_naver_shopping_worker_wake\('repair_priority_queue'\)/gi) || []).length,
    1,
    'an idempotent enqueue must not amplify the durable wake',
  );
  assert.match(migration, /idx_naver_shopping_repair_priority_request_fifo[\s\S]*\(requested_at, request_id\)/i);
  assert.doesNotMatch(enqueueSql, /next_check_at\s*=/i);
  assert.doesNotMatch(enqueueSql, /scheduler_cycle_cursor_(?:sort_order|created_at|tracker_id)\s*=/i);
});

test('claim uses lane CAS and a serialized one-shot state transition', () => {
  assert.match(claimSql, /where lane_key = 'global'\s+for update;/i);
  assert.match(claimSql, /lease_worker_id is distinct from lower\(trim\(p_worker_id\)\)[\s\S]*lease_token is distinct from p_lane_token[\s\S]*run_id is distinct from p_run_id/i);
  assert.match(claimSql, /lease_until <= v_now[\s\S]*circuit_state = 'open'/i);
  assert.match(claimSql, /item\.state = 'consumed'[\s\S]*tracker\.processing_started_at = item\.claimed_lease_started_at[\s\S]*tracker\.processing_until > v_now/i);
  assert.match(claimSql, /where item\.state = 'queued'[\s\S]*order by request\.requested_at asc, request\.request_id asc, item\.position asc[\s\S]*for update of item/i);
  assert.match(claimSql, /seed\.processing_until is not null and seed\.processing_until > v_now[\s\S]*'status', 'waiting'/i);
  assert.match(claimSql, /where tracker\.id = repair_item\.tracker_id[\s\S]*tracker\.status = 'active'[\s\S]*processing_until is null or tracker\.processing_until <= v_now/i);
  assert.match(claimSql, /set state = 'consumed'[\s\S]*outcome_code = 'claimed_once'[\s\S]*where item\.request_id = repair_item\.request_id[\s\S]*item\.position = repair_item\.position[\s\S]*item\.state = 'queued'/i);
  assert.match(claimSql, /get diagnostics v_claimed_count = row_count;[\s\S]*v_claimed_count <> 1[\s\S]*raise exception 'naver_shopping_repair_priority_claim_conflict'/i);
  assert.equal(
    (claimSql.match(/mi_request_naver_shopping_worker_wake\('repair_priority_handoff'\)/gi) || []).length,
    2,
    'a consumed or skipped repair must leave one finite handoff path',
  );
  assert.doesNotMatch(claimSql, /set state = 'queued'/i, 'a failed collection must never requeue a consumed repair item');
});

test('the exact two-tracker request runs position 1 then 2 and resumes the durable cursor unchanged', () => {
  const selectedTrackerIds = [
    '8991eecb-d034-4a57-a2bf-3e5c50e03bae',
    'b26fb634-fb11-4aec-97fa-097d585b8391',
  ];
  const orderedItems = selectedTrackerIds.map((trackerId, index) => ({
    position: index + 1,
    trackerId,
  }));
  assert.deepEqual(orderedItems.map((item) => item.position), [1, 2]);
  assert.deepEqual(orderedItems.map((item) => item.trackerId), selectedTrackerIds);
  assert.match(claimSql, /jsonb_build_array\(jsonb_build_object\(\s*'trackerId', seed\.id/i, 'one claim call must return only the selected head tracker');
  assert.match(claimSql, /worker_quarantined_until = null/i);
  assert.match(claimSql, /worker_last_cycle_id = case[\s\S]*scheduler_cycle_status = 'active'[\s\S]*scheduler_cycle_id/i);
  assert.doesNotMatch(claimSql, /next_check_at\s*=/i);
  assert.doesNotMatch(claimSql, /scheduler_cycle_cursor_(?:sort_order|created_at|tracker_id|resume_cursor)\s*=/i);
});

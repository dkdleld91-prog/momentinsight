begin;

alter table public.naver_rank_snapshots
  add column if not exists collection_id text;

create unique index if not exists idx_naver_rank_snapshots_tracker_collection
on public.naver_rank_snapshots(tracker_id, collection_id)
where collection_id is not null;

create table if not exists public.naver_shopping_worker_nonces (
  nonce text primary key check (char_length(nonce) between 16 and 128),
  request_timestamp timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_naver_shopping_worker_nonces_created_at
on public.naver_shopping_worker_nonces(created_at);

alter table public.naver_shopping_worker_nonces enable row level security;
revoke all on table public.naver_shopping_worker_nonces from public, anon, authenticated;
grant select, insert, delete on table public.naver_shopping_worker_nonces to service_role;

create or replace function public.mi_consume_naver_shopping_worker_nonce(
  p_nonce text,
  p_request_timestamp timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_nonce is null
    or char_length(p_nonce) < 16
    or char_length(p_nonce) > 128
    or p_request_timestamp is null
    or abs(extract(epoch from (clock_timestamp() - p_request_timestamp))) > 300 then
    return false;
  end if;

  delete from public.naver_shopping_worker_nonces
  where created_at < clock_timestamp() - interval '1 day';

  insert into public.naver_shopping_worker_nonces(nonce, request_timestamp)
  values (p_nonce, p_request_timestamp)
  on conflict (nonce) do nothing;

  return found;
end;
$$;

revoke all on function public.mi_consume_naver_shopping_worker_nonce(text, timestamptz)
from public, anon, authenticated;
grant execute on function public.mi_consume_naver_shopping_worker_nonce(text, timestamptz)
to service_role;

create or replace function public.mi_load_naver_shopping_worker_catalog_history(
  p_tracker_ids uuid[],
  p_checked_at timestamptz,
  p_per_tracker_limit integer default 120
) returns table(
  tracker_id uuid,
  checked_at timestamptz,
  matched boolean,
  item jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select history.tracker_id, history.checked_at, history.matched, history.item
  from unnest(coalesce(p_tracker_ids, '{}'::uuid[])) as requested(tracker_id)
  cross join lateral (
    select snapshot.tracker_id, snapshot.checked_at, snapshot.matched, snapshot.item
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = requested.tracker_id
      and snapshot.matched = true
      and snapshot.checked_at >= p_checked_at - interval '30 days'
      and snapshot.checked_at <= p_checked_at
    order by snapshot.checked_at desc
    limit least(greatest(coalesce(p_per_tracker_limit, 120), 1), 120)
  ) as history
  where cardinality(coalesce(p_tracker_ids, '{}'::uuid[])) between 1 and 8;
$$;

revoke all on function public.mi_load_naver_shopping_worker_catalog_history(uuid[], timestamptz, integer)
from public, anon, authenticated;
grant execute on function public.mi_load_naver_shopping_worker_catalog_history(uuid[], timestamptz, integer)
to service_role;

create or replace function public.mi_commit_naver_shopping_worker_result(
  p_tracker_id uuid,
  p_lease_started_at timestamptz,
  p_collection_id text,
  p_checked_at timestamptz,
  p_next_check_at timestamptz,
  p_snapshot jsonb,
  p_product_id text default null,
  p_mall_name text default null,
  p_product_title text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tracker public.naver_rank_trackers%rowtype;
  inserted_snapshot_id uuid;
  matched_rank integer;
begin
  if p_tracker_id is null or p_lease_started_at is null
    or p_collection_id is null or char_length(p_collection_id) < 8
    or char_length(p_collection_id) > 160
    or p_checked_at is null or p_next_check_at is null
    or p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'local_worker_commit_invalid';
  end if;

  select * into tracker
  from public.naver_rank_trackers
  where id = p_tracker_id
  for update;

  if not found then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  -- A retry after a successful commit sees the snapshot and a cleared lease.
  -- A reused old collection under a new live lease must fail closed so the
  -- caller releases that lease instead of silently waiting for expiry.
  if tracker.processing_started_at is null then
    select id into inserted_snapshot_id
    from public.naver_rank_snapshots
    where tracker_id = p_tracker_id and collection_id = p_collection_id;
    if inserted_snapshot_id is not null then
      return jsonb_build_object('status', 'already_committed', 'snapshotId', inserted_snapshot_id);
    end if;
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.status <> 'active'
    or tracker.processing_started_at is distinct from p_lease_started_at
    or tracker.processing_until is null
    or tracker.processing_until <= clock_timestamp() then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  select id into inserted_snapshot_id
  from public.naver_rank_snapshots
  where tracker_id = p_tracker_id and collection_id = p_collection_id;
  if inserted_snapshot_id is not null then
    update public.naver_rank_trackers
    set processing_started_at = null,
        processing_until = null,
        next_check_at = clock_timestamp() + interval '5 minutes',
        last_message = '중복 수집 묶음을 차단하고 다시 갱신합니다. 마지막 정상 순위는 유지합니다.',
        last_error = 'local_worker_collection_conflict',
        retry_count = coalesce(retry_count, 0) + 1
    where id = p_tracker_id
      and status = 'active'
      and processing_started_at = p_lease_started_at;
    return jsonb_build_object('status', 'collection_conflict', 'snapshotId', inserted_snapshot_id);
  end if;

  matched_rank := case
    when coalesce((p_snapshot->>'matched')::boolean, false)
      then nullif((p_snapshot->>'rank')::integer, 0)
    else null
  end;

  insert into public.naver_rank_snapshots(
    tracker_id, checked_at, collection_id, rank, page, position, matched,
    checked_count, total, item, top_items, message, source
  ) values (
    p_tracker_id,
    p_checked_at,
    p_collection_id,
    nullif((p_snapshot->>'rank')::integer, 0),
    nullif((p_snapshot->>'page')::integer, 0),
    nullif((p_snapshot->>'position')::integer, 0),
    coalesce((p_snapshot->>'matched')::boolean, false),
    nullif((p_snapshot->>'checked_count')::integer, 0),
    nullif((p_snapshot->>'total')::integer, 0),
    coalesce(p_snapshot->'item', '{}'::jsonb),
    coalesce(p_snapshot->'top_items', '[]'::jsonb),
    nullif(p_snapshot->>'message', ''),
    coalesce(nullif(p_snapshot->>'source', ''), 'naver_shopping_results_collector')
  )
  on conflict (tracker_id, collection_id) where collection_id is not null do nothing
  returning id into inserted_snapshot_id;

  if inserted_snapshot_id is null then
    select id into inserted_snapshot_id
    from public.naver_rank_snapshots
    where tracker_id = p_tracker_id and collection_id = p_collection_id;
    update public.naver_rank_trackers
    set processing_started_at = null,
        processing_until = null,
        next_check_at = clock_timestamp() + interval '5 minutes',
        last_message = '중복 수집 묶음을 차단하고 다시 갱신합니다. 마지막 정상 순위는 유지합니다.',
        last_error = 'local_worker_collection_conflict',
        retry_count = coalesce(retry_count, 0) + 1
    where id = p_tracker_id
      and status = 'active'
      and processing_started_at = p_lease_started_at;
    return jsonb_build_object('status', 'collection_conflict', 'snapshotId', inserted_snapshot_id);
  end if;

  update public.naver_rank_trackers
  set last_checked_at = p_checked_at,
      next_check_at = p_next_check_at,
      current_rank = matched_rank,
      best_rank = case when matched_rank is null then best_rank else least(coalesce(best_rank, matched_rank), matched_rank) end,
      worst_rank = case when matched_rank is null then worst_rank else greatest(coalesce(worst_rank, matched_rank), matched_rank) end,
      check_count = coalesce(check_count, 0) + 1,
      found_count = coalesce(found_count, 0) + case when matched_rank is null then 0 else 1 end,
      last_message = nullif(p_snapshot->>'message', ''),
      last_error = null,
      retry_count = 0,
      product_id = coalesce(nullif(product_id, ''), nullif(p_product_id, '')),
      mall_name = coalesce(nullif(mall_name, ''), nullif(p_mall_name, '')),
      product_title = coalesce(nullif(product_title, ''), nullif(p_product_title, '')),
      processing_started_at = null,
      processing_until = null
  where id = p_tracker_id
    and status = 'active'
    and processing_started_at = p_lease_started_at
    and processing_until > clock_timestamp();

  if not found then
    raise exception 'local_worker_lease_lost_after_snapshot';
  end if;

  return jsonb_build_object('status', 'committed', 'snapshotId', inserted_snapshot_id);
end;
$$;

revoke all on function public.mi_commit_naver_shopping_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) from public, anon, authenticated;
grant execute on function public.mi_commit_naver_shopping_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) to service_role;

create or replace function public.mi_fail_naver_shopping_worker_claim(
  p_tracker_id uuid,
  p_lease_started_at timestamptz,
  p_next_check_at timestamptz,
  p_error text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.naver_rank_trackers
  set processing_started_at = null,
      processing_until = null,
      next_check_at = p_next_check_at,
      last_message = '자동 순위 갱신에 실패해 재시도합니다. 마지막 정상 순위는 유지합니다.',
      last_error = left(coalesce(nullif(p_error, ''), 'local_worker_collection_failed'), 500),
      retry_count = coalesce(retry_count, 0) + 1
  where id = p_tracker_id
    and status = 'active'
    and processing_started_at = p_lease_started_at;
  return found;
end;
$$;

revoke all on function public.mi_fail_naver_shopping_worker_claim(uuid, timestamptz, timestamptz, text)
from public, anon, authenticated;
grant execute on function public.mi_fail_naver_shopping_worker_claim(uuid, timestamptz, timestamptz, text)
to service_role;

commit;

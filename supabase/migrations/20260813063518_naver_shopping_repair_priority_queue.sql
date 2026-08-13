begin;

-- Finite, operator-selected recovery lane.  This queue is intentionally
-- separate from next_check_at and the durable cycle cursor: a selected row is
-- consumed once when its tracker lease is acquired and is never requeued by a
-- collection failure.
create table if not exists public.naver_shopping_repair_priority_requests (
  request_id uuid primary key,
  reason text not null check (reason ~ '^[a-z0-9][a-z0-9:_-]{2,63}$'),
  tracker_count smallint not null check (tracker_count between 1 and 10),
  requested_at timestamptz not null default clock_timestamp()
);

create table if not exists public.naver_shopping_repair_priority_items (
  request_id uuid not null
    references public.naver_shopping_repair_priority_requests(request_id)
    on delete cascade,
  position smallint not null check (position between 1 and 10),
  tracker_id uuid not null
    references public.naver_rank_trackers(id)
    on delete cascade,
  state text not null default 'queued'
    check (state in ('queued', 'consumed', 'skipped')),
  consumed_at timestamptz,
  outcome_code text,
  claimed_worker_id text,
  claimed_lane_token uuid,
  claimed_run_id uuid,
  claimed_lease_started_at timestamptz,
  claimed_lease_until timestamptz,
  primary key (request_id, position),
  unique (request_id, tracker_id),
  check (
    (state = 'queued'
      and consumed_at is null
      and outcome_code is null
      and claimed_worker_id is null
      and claimed_lane_token is null
      and claimed_run_id is null
      and claimed_lease_started_at is null
      and claimed_lease_until is null)
    or
    (state = 'consumed'
      and consumed_at is not null
      and outcome_code = 'claimed_once'
      and claimed_worker_id is not null
      and claimed_lane_token is not null
      and claimed_run_id is not null
      and claimed_lease_started_at is not null
      and claimed_lease_until is not null)
    or
    (state = 'skipped'
      and consumed_at is not null
      and outcome_code is not null
      and claimed_worker_id is null
      and claimed_lane_token is null
      and claimed_run_id is null
      and claimed_lease_started_at is null
      and claimed_lease_until is null)
  )
);

create unique index if not exists idx_naver_shopping_repair_priority_one_queued_tracker
on public.naver_shopping_repair_priority_items(tracker_id)
where state = 'queued';

create index if not exists idx_naver_shopping_repair_priority_request_fifo
on public.naver_shopping_repair_priority_requests(requested_at, request_id);

create index if not exists idx_naver_shopping_repair_priority_fifo
on public.naver_shopping_repair_priority_items(request_id, position)
where state = 'queued';

alter table public.naver_shopping_repair_priority_requests enable row level security;
alter table public.naver_shopping_repair_priority_requests force row level security;
alter table public.naver_shopping_repair_priority_items enable row level security;
alter table public.naver_shopping_repair_priority_items force row level security;

revoke all on table public.naver_shopping_repair_priority_requests
from public, anon, authenticated, service_role;
revoke all on table public.naver_shopping_repair_priority_items
from public, anon, authenticated, service_role;
grant select, insert on table public.naver_shopping_repair_priority_requests
to service_role;
grant select, insert, update on table public.naver_shopping_repair_priority_items
to service_role;

create or replace function public.mi_enqueue_naver_shopping_repair_priority(
  p_request_id uuid,
  p_tracker_ids uuid[],
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  normalized_reason text := lower(trim(coalesce(p_reason, '')));
  v_tracker_count integer := coalesce(cardinality(p_tracker_ids), 0);
  v_distinct_count integer := 0;
  v_active_count integer := 0;
  v_existing_ids uuid[];
  v_request_exists boolean := false;
  v_queued_count integer := 0;
  v_requested_at timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_items jsonb := '[]'::jsonb;
begin
  if p_request_id is null
    or v_tracker_count < 1
    or v_tracker_count > 10
    or normalized_reason !~ '^[a-z0-9][a-z0-9:_-]{2,63}$' then
    raise exception 'naver_shopping_repair_priority_invalid';
  end if;

  select count(distinct selected.tracker_id)::integer
  into v_distinct_count
  from unnest(p_tracker_ids) as selected(tracker_id)
  where selected.tracker_id is not null;
  if v_distinct_count <> v_tracker_count then
    raise exception 'naver_shopping_repair_priority_duplicate_or_null';
  end if;

  insert into public.naver_shopping_worker_coordination(lane_key)
  values ('global')
  on conflict (lane_key) do nothing;

  -- The same coordination lock used by the durable scheduler serializes
  -- enqueue and claim.  Two concurrent callers cannot consume position 1 and
  -- position 2 out of order.
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  select exists (
    select 1
    from public.naver_shopping_repair_priority_requests as request
    where request.request_id = p_request_id
  ) into v_request_exists;

  select array_agg(item.tracker_id order by item.position)
  into v_existing_ids
  from public.naver_shopping_repair_priority_items as item
  where item.request_id = p_request_id;

  if v_request_exists then
    if v_existing_ids is null or v_existing_ids is distinct from p_tracker_ids then
      raise exception 'naver_shopping_repair_priority_request_conflict';
    end if;
    select count(*)::integer into v_queued_count
    from public.naver_shopping_repair_priority_items as item
    where item.request_id = p_request_id
      and item.state = 'queued';
    return jsonb_build_object(
      'accepted', true,
      'idempotent', true,
      'requestId', p_request_id,
      'queuedCount', v_queued_count
    );
  end if;

  select count(*)::integer into v_active_count
  from public.naver_rank_trackers as tracker
  where tracker.id = any(p_tracker_ids)
    and tracker.status = 'active';
  if v_active_count <> v_tracker_count then
    raise exception 'naver_shopping_repair_priority_tracker_inactive';
  end if;

  if exists (
    select 1
    from public.naver_shopping_repair_priority_items as item
    where item.tracker_id = any(p_tracker_ids)
      and item.state = 'queued'
  ) then
    raise exception 'naver_shopping_repair_priority_already_queued';
  end if;

  insert into public.naver_shopping_repair_priority_requests(
    request_id,
    reason,
    tracker_count,
    requested_at
  ) values (
    p_request_id,
    normalized_reason,
    v_tracker_count,
    v_requested_at
  );

  insert into public.naver_shopping_repair_priority_items(
    request_id,
    position,
    tracker_id
  )
  select p_request_id, selected.ordinality::smallint, selected.tracker_id
  from unnest(p_tracker_ids) with ordinality as selected(tracker_id, ordinality)
  order by selected.ordinality;

  select coalesce(jsonb_agg(jsonb_build_object(
    'position', item.position,
    'trackerId', item.tracker_id
  ) order by item.position), '[]'::jsonb)
  into v_items
  from public.naver_shopping_repair_priority_items as item
  where item.request_id = p_request_id;

  perform public.mi_request_naver_shopping_worker_wake('repair_priority_queue');
  return jsonb_build_object(
    'accepted', true,
    'idempotent', false,
    'requestId', p_request_id,
    'queuedCount', v_tracker_count,
    'items', v_items
  );
end;
$$;

create or replace function public.mi_claim_naver_shopping_repair_priority(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_lease_seconds integer default 2100
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  repair_item public.naver_shopping_repair_priority_items%rowtype;
  seed public.naver_rank_trackers%rowtype;
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_lease_until timestamptz;
  v_claimed_count integer := 0;
  v_active_request_id uuid;
  v_active_position smallint;
begin
  repair_item := null;
  seed := null;
  if lower(trim(coalesce(p_worker_id, ''))) !~ '^[a-z0-9][a-z0-9:_-]{2,63}$'
    or p_lane_token is null
    or p_run_id is null
    or p_lease_seconds < 60
    or p_lease_seconds > 2100 then
    raise exception 'naver_shopping_repair_priority_claim_invalid';
  end if;
  v_lease_until := v_now + make_interval(secs => p_lease_seconds);

  -- This lock is both the lane-token CAS boundary and the FIFO concurrency
  -- boundary.  It is deliberately acquired before reading a queue item.
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found
    or current_row.lease_worker_id is distinct from lower(trim(p_worker_id))
    or current_row.lease_token is distinct from p_lane_token
    or current_row.run_id is distinct from p_run_id
    or current_row.lease_until is null
    or current_row.lease_until <= v_now
    or current_row.circuit_state = 'open' then
    raise exception 'naver_shopping_repair_priority_lane_lost';
  end if;

  -- A batch is strictly serial even if the same valid lane token is submitted
  -- concurrently.  A consumed item is never returned to queued; its tracker
  -- lease ending (success, failure, or expiry) is the only gate for position+1.
  select item.request_id, item.position
  into v_active_request_id, v_active_position
  from public.naver_shopping_repair_priority_items as item
  join public.naver_rank_trackers as tracker on tracker.id = item.tracker_id
  where item.state = 'consumed'
    and item.claimed_lease_started_at is not null
    and tracker.processing_started_at = item.claimed_lease_started_at
    and tracker.processing_until > v_now
  order by item.consumed_at asc, item.request_id asc, item.position asc
  limit 1;
  if v_active_request_id is not null then
    return jsonb_build_object(
      'status', 'waiting',
      'priority', 'repair',
      'requestId', v_active_request_id,
      'position', v_active_position,
      'claims', '[]'::jsonb
    );
  end if;

  select item.* into repair_item
  from public.naver_shopping_repair_priority_items as item
  join public.naver_shopping_repair_priority_requests as request
    on request.request_id = item.request_id
  where item.state = 'queued'
  order by request.requested_at asc, request.request_id asc, item.position asc
  limit 1
  for update of item;

  if repair_item.request_id is null then
    return jsonb_build_object(
      'status', 'empty',
      'priority', 'repair',
      'claims', '[]'::jsonb
    );
  end if;

  select * into seed
  from public.naver_rank_trackers as tracker
  where tracker.id = repair_item.tracker_id
  for update;

  if seed.id is null or seed.status <> 'active' then
    update public.naver_shopping_repair_priority_items as item
    set state = 'skipped',
        consumed_at = v_now,
        outcome_code = 'tracker_inactive'
    where item.request_id = repair_item.request_id
      and item.position = repair_item.position
      and item.state = 'queued';
    perform public.mi_request_naver_shopping_worker_wake('repair_priority_handoff');
    return jsonb_build_object(
      'status', 'waiting',
      'priority', 'repair',
      'skipped', true,
      'requestId', repair_item.request_id,
      'position', repair_item.position,
      'claims', '[]'::jsonb
    );
  end if;

  if seed.processing_until is not null and seed.processing_until > v_now then
    return jsonb_build_object(
      'status', 'waiting',
      'priority', 'repair',
      'requestId', repair_item.request_id,
      'position', repair_item.position,
      'claims', '[]'::jsonb
    );
  end if;

  update public.naver_rank_trackers as tracker
  set processing_started_at = v_now,
      processing_until = v_lease_until,
      worker_quarantined_until = null,
      worker_last_cycle_id = case
        when current_row.scheduler_cycle_status = 'active'
          and current_row.scheduler_cycle_id is not null
          then current_row.scheduler_cycle_id
        else tracker.worker_last_cycle_id
      end,
      worker_last_cycle_claimed_at = case
        when current_row.scheduler_cycle_status = 'active'
          and current_row.scheduler_cycle_id is not null
          then v_now
        else tracker.worker_last_cycle_claimed_at
      end,
      last_message = '오류 보완 후 1회 우선 재검증 중입니다.'
  where tracker.id = repair_item.tracker_id
    and tracker.status = 'active'
    and (tracker.processing_until is null or tracker.processing_until <= v_now);
  get diagnostics v_claimed_count = row_count;

  if v_claimed_count <> 1 then
    return jsonb_build_object(
      'status', 'waiting',
      'priority', 'repair',
      'requestId', repair_item.request_id,
      'position', repair_item.position,
      'claims', '[]'::jsonb
    );
  end if;

  -- CAS consumes the selected position exactly once.  If this update ever
  -- loses its queued state, the exception rolls the tracker lease back too.
  update public.naver_shopping_repair_priority_items as item
  set state = 'consumed',
      consumed_at = v_now,
      outcome_code = 'claimed_once',
      claimed_worker_id = lower(trim(p_worker_id)),
      claimed_lane_token = p_lane_token,
      claimed_run_id = p_run_id,
      claimed_lease_started_at = v_now,
      claimed_lease_until = v_lease_until
  where item.request_id = repair_item.request_id
    and item.position = repair_item.position
    and item.state = 'queued';
  get diagnostics v_claimed_count = row_count;
  if v_claimed_count <> 1 then
    raise exception 'naver_shopping_repair_priority_claim_conflict';
  end if;

  -- The wake that started this claim has already been consumed. Leave exactly
  -- one finite handoff so a max_jobs=1 process returns for position+1 (or the
  -- unchanged durable cycle after the final repair) without a ten-minute gap.
  perform public.mi_request_naver_shopping_worker_wake('repair_priority_handoff');

  return jsonb_build_object(
    'status', 'claimed',
    'cycleId', case
      when current_row.scheduler_cycle_status = 'active'
        then current_row.scheduler_cycle_id
      else null
    end,
    'keyword', seed.keyword,
    'priority', 'repair',
    'requestId', repair_item.request_id,
    'position', repair_item.position,
    'claims', jsonb_build_array(jsonb_build_object(
      'trackerId', seed.id,
      'leaseStartedAt', v_now,
      'leaseUntil', v_lease_until
    ))
  );
end;
$$;

revoke all on function public.mi_enqueue_naver_shopping_repair_priority(uuid, uuid[], text)
from public, anon, authenticated, service_role;
grant execute on function public.mi_enqueue_naver_shopping_repair_priority(uuid, uuid[], text)
to service_role;

revoke all on function public.mi_claim_naver_shopping_repair_priority(text, uuid, uuid, integer)
from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_repair_priority(text, uuid, uuid, integer)
to service_role;

commit;

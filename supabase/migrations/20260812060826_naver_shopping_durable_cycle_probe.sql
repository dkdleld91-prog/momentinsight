begin;

alter table public.naver_shopping_worker_coordination
  add column if not exists scheduler_cycle_id uuid,
  add column if not exists scheduler_cycle_number bigint not null default 0,
  add column if not exists scheduler_cycle_status text not null default 'idle',
  add column if not exists scheduler_cycle_started_at timestamptz,
  add column if not exists scheduler_cycle_completed_at timestamptz,
  add column if not exists scheduler_cycle_cursor_sort_order integer,
  add column if not exists scheduler_cycle_cursor_created_at timestamptz,
  add column if not exists scheduler_cycle_cursor_tracker_id uuid,
  add column if not exists scheduler_cycle_resume_cursor boolean not null default false;

alter table public.naver_shopping_worker_coordination
  drop constraint if exists naver_shopping_worker_coordination_cycle_status_check,
  add constraint naver_shopping_worker_coordination_cycle_status_check
    check (scheduler_cycle_status in ('idle', 'active', 'completed'));

alter table public.naver_rank_trackers
  add column if not exists worker_last_cycle_id uuid,
  add column if not exists worker_last_cycle_claimed_at timestamptz;

create index if not exists idx_naver_rank_trackers_worker_cycle_queue
on public.naver_rank_trackers(
  status,
  worker_last_cycle_id,
  sort_order,
  created_at,
  id,
  worker_quarantined_until,
  processing_until
)
where status = 'active';

create or replace function public.mi_queue_naver_shopping_cycle()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_cycle_id uuid;
  v_started boolean := false;
  v_total integer := 0;
  v_remaining integer := 0;
  v_processing integer := 0;
begin
  insert into public.naver_shopping_worker_coordination(lane_key)
  values ('global')
  on conflict (lane_key) do nothing;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if current_row.scheduler_cycle_status = 'active'
    and current_row.scheduler_cycle_id is not null then
    v_cycle_id := current_row.scheduler_cycle_id;
  else
    select count(*)::integer into v_total
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
      and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now);

    if v_total = 0 then
      update public.naver_shopping_worker_coordination
      set scheduler_cycle_id = null,
          scheduler_cycle_status = 'idle',
          scheduler_cycle_started_at = null,
          scheduler_cycle_completed_at = null,
          scheduler_cycle_cursor_sort_order = null,
          scheduler_cycle_cursor_created_at = null,
          scheduler_cycle_cursor_tracker_id = null,
          scheduler_cycle_resume_cursor = false,
          updated_at = v_now
      where lane_key = 'global';
      return jsonb_build_object(
        'status', 'empty', 'cycleId', null, 'cycleStartedAt', null,
        'started', false, 'total', 0, 'remaining', 0, 'processing', 0
      );
    end if;

    v_cycle_id := gen_random_uuid();
    v_started := true;
    update public.naver_shopping_worker_coordination
    set scheduler_cycle_id = v_cycle_id,
        scheduler_cycle_number = scheduler_cycle_number + 1,
        scheduler_cycle_status = 'active',
        scheduler_cycle_started_at = v_now,
        scheduler_cycle_completed_at = null,
        scheduler_cycle_cursor_sort_order = null,
        scheduler_cycle_cursor_created_at = null,
        scheduler_cycle_cursor_tracker_id = null,
        scheduler_cycle_resume_cursor = false,
        updated_at = v_now
    where lane_key = 'global'
    returning * into current_row;
  end if;

  select count(*)::integer,
         count(*) filter (where tracker.processing_until > v_now)::integer
  into v_remaining, v_processing
  from public.naver_rank_trackers as tracker
  where tracker.status = 'active'
    and tracker.worker_last_cycle_id is distinct from v_cycle_id
    and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now);

  if not v_started then
    select count(*)::integer into v_total
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
      and (tracker.worker_last_cycle_id = v_cycle_id
        or tracker.worker_quarantined_until is null
        or tracker.worker_quarantined_until <= v_now);
  end if;

  return jsonb_build_object(
    'status', 'active',
    'cycleId', v_cycle_id,
    'cycleStartedAt', current_row.scheduler_cycle_started_at,
    'started', v_started,
    'total', greatest(v_total, v_remaining),
    'remaining', v_remaining,
    'processing', v_processing
  );
end;
$$;

create or replace function public.mi_claim_naver_shopping_cycle_keyword(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_lease_seconds integer default 2100,
  p_probe_tracker_id uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  seed public.naver_rank_trackers%rowtype;
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_lease_until timestamptz;
  v_keyword_key text;
  v_priority text;
  v_claims jsonb := '[]'::jsonb;
  v_claim_count integer := 0;
  v_waiting integer := 0;
  v_resume boolean := false;
begin
  seed := null;
  if lower(trim(coalesce(p_worker_id, ''))) !~ '^[a-z0-9][a-z0-9:_-]{2,63}$'
    or p_lane_token is null
    or p_run_id is null
    or p_lease_seconds < 60
    or p_lease_seconds > 2100 then
    raise exception 'naver_shopping_cycle_claim_invalid';
  end if;
  v_lease_until := v_now + make_interval(secs => p_lease_seconds);

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
    raise exception 'naver_shopping_cycle_lane_lost';
  end if;

  if p_probe_tracker_id is not null then
    select * into seed
    from public.naver_rank_trackers as tracker
    where tracker.id = p_probe_tracker_id
      and tracker.status = 'active'
      and (tracker.processing_until is null or tracker.processing_until <= v_now)
    for update skip locked;
    if seed.id is null then
      return jsonb_build_object('status', 'waiting', 'cycleId', null, 'priority', 'probe', 'claims', '[]'::jsonb);
    end if;
    v_priority := 'probe';
  else
    if current_row.scheduler_cycle_status <> 'active'
      or current_row.scheduler_cycle_id is null then
      return jsonb_build_object('status', 'no_cycle', 'cycleId', null, 'claims', '[]'::jsonb);
    end if;

    -- A newly registered keyword gets exactly one priority group, then the
    -- saved normal cursor is resumed before another new group may run.
    if not current_row.scheduler_cycle_resume_cursor then
      select * into seed
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.last_checked_at is null
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
      order by tracker.created_at asc, tracker.id asc
      limit 1
      for update skip locked;
      if seed.id is not null then v_priority := 'new'; end if;
    end if;

    if seed.id is null then
      v_resume := current_row.scheduler_cycle_resume_cursor;
      select * into seed
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.last_checked_at is not null
        and tracker.created_at <= current_row.scheduler_cycle_started_at
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
        and (
          current_row.scheduler_cycle_cursor_tracker_id is null
          or (tracker.sort_order, tracker.created_at, tracker.id) >
             (current_row.scheduler_cycle_cursor_sort_order,
              current_row.scheduler_cycle_cursor_created_at,
              current_row.scheduler_cycle_cursor_tracker_id)
        )
      order by tracker.sort_order asc, tracker.created_at asc, tracker.id asc
      limit 1
      for update skip locked;
      if seed.id is not null then v_priority := case when v_resume then 'resume' else 'normal' end; end if;
    end if;

    if seed.id is null then
      select * into seed
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.last_checked_at is not null
        and tracker.created_at <= current_row.scheduler_cycle_started_at
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
      order by tracker.sort_order asc, tracker.created_at asc, tracker.id asc
      limit 1
      for update skip locked;
      if seed.id is not null then v_priority := case when v_resume then 'resume' else 'normal' end; end if;
    end if;

    if seed.id is null and current_row.scheduler_cycle_resume_cursor then
      update public.naver_shopping_worker_coordination
      set scheduler_cycle_resume_cursor = false, updated_at = v_now
      where lane_key = 'global';
      current_row.scheduler_cycle_resume_cursor := false;
      select * into seed
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.last_checked_at is null
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
      order by tracker.created_at asc, tracker.id asc
      limit 1
      for update skip locked;
      if seed.id is not null then v_priority := 'new'; end if;
    end if;

    if seed.id is null then
      select count(*)::integer into v_waiting
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and tracker.processing_until > v_now;
      if v_waiting > 0 then
        return jsonb_build_object('status', 'waiting', 'cycleId', current_row.scheduler_cycle_id, 'claims', '[]'::jsonb);
      end if;
      update public.naver_shopping_worker_coordination
      set scheduler_cycle_status = 'completed',
          scheduler_cycle_completed_at = v_now,
          scheduler_cycle_resume_cursor = false,
          updated_at = v_now
      where lane_key = 'global';
      return jsonb_build_object('status', 'cycle_completed', 'cycleId', current_row.scheduler_cycle_id, 'claims', '[]'::jsonb);
    end if;
  end if;

  v_keyword_key := regexp_replace(lower(trim(seed.keyword)), '\s+', '', 'g');
  with group_candidates as (
    select tracker.id
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
      and regexp_replace(lower(trim(tracker.keyword)), '\s+', '', 'g') = v_keyword_key
      and (tracker.processing_until is null or tracker.processing_until <= v_now)
      and ((p_probe_tracker_id is not null and tracker.id = p_probe_tracker_id) or (
        p_probe_tracker_id is null and
        tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.last_checked_at is null or tracker.created_at <= current_row.scheduler_cycle_started_at)
      ))
    order by tracker.sort_order asc, tracker.created_at asc, tracker.id asc
    limit 100
    for update skip locked
  ), claimed as (
    update public.naver_rank_trackers as tracker
    set processing_started_at = v_now,
        processing_until = v_lease_until,
        worker_last_cycle_id = case when p_probe_tracker_id is null then current_row.scheduler_cycle_id else tracker.worker_last_cycle_id end,
        worker_last_cycle_claimed_at = case when p_probe_tracker_id is null then v_now else tracker.worker_last_cycle_claimed_at end,
        last_message = '자동 순위 갱신 처리 중입니다.'
    from group_candidates
    where tracker.id = group_candidates.id
    returning tracker.id
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'trackerId', claimed.id,
           'leaseStartedAt', v_now,
           'leaseUntil', v_lease_until
         ) order by claimed.id), '[]'::jsonb)
  into v_claim_count, v_claims
  from claimed;

  if v_claim_count = 0 then
    return jsonb_build_object(
      'status', 'waiting',
      'cycleId', case when p_probe_tracker_id is null then current_row.scheduler_cycle_id else null end,
      'priority', v_priority,
      'claims', '[]'::jsonb
    );
  end if;

  if p_probe_tracker_id is null then
    update public.naver_shopping_worker_coordination
    set scheduler_cycle_cursor_sort_order = case when v_priority in ('normal', 'resume') then seed.sort_order else scheduler_cycle_cursor_sort_order end,
        scheduler_cycle_cursor_created_at = case when v_priority in ('normal', 'resume') then seed.created_at else scheduler_cycle_cursor_created_at end,
        scheduler_cycle_cursor_tracker_id = case when v_priority in ('normal', 'resume') then seed.id else scheduler_cycle_cursor_tracker_id end,
        scheduler_cycle_resume_cursor = case when v_priority = 'new' then true else false end,
        updated_at = v_now
    where lane_key = 'global';
  end if;

  return jsonb_build_object(
    'status', 'claimed',
    'cycleId', case when p_probe_tracker_id is null then current_row.scheduler_cycle_id else null end,
    'keyword', seed.keyword,
    'priority', v_priority,
    'claims', v_claims
  );
end;
$$;

revoke all on function public.mi_queue_naver_shopping_cycle()
from public, anon, authenticated, service_role;
grant execute on function public.mi_queue_naver_shopping_cycle()
to service_role;

revoke all on function public.mi_claim_naver_shopping_cycle_keyword(text, uuid, uuid, integer, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_cycle_keyword(text, uuid, uuid, integer, uuid)
to service_role;

commit;

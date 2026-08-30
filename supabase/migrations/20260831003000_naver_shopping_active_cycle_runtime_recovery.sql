begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;

do $migration_guard$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  coordination_found boolean := false;
  processing_count integer := 0;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  coordination_found := found;

  select (
    (select count(*)
     from public.naver_shopping_rank_lookup_jobs
     where status = 'processing'
       and processing_until > clock_timestamp())
    +
    (select count(*)
     from public.naver_rank_trackers
     where status = 'active'
       and processing_until > clock_timestamp())
  )::integer into processing_count;

  if coordination_found is not true
    or current_row.runtime_version is distinct from '1.1.18'
    or current_row.runtime_fingerprint is distinct from
      '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c'
    or current_row.cadence_mode is distinct from 'baseline'
    or current_row.cadence_minutes is distinct from 10
    or current_row.circuit_state is distinct from 'closed'
    or current_row.circuit_reason is not null
    or current_row.cooldown_until is not null
    or processing_count <> 0
    or current_row.lease_worker_id is not null
    or current_row.lease_token is not null
    or current_row.lease_until is not null
    or current_row.run_id is not null
    or current_row.current_stage is not null
    or current_row.current_page is distinct from 0
    or current_row.current_job_kind is not null
    or current_row.current_tracker_id is not null
    or current_row.current_job_started_at is not null
    or current_row.probe_tracker_id is not null
    or current_row.probe_started_at is not null then
    raise exception 'naver_shopping_active_cycle_runtime_recovery_requires_idle';
  end if;
end
$migration_guard$;

-- A runtime rollout can occur while the durable scheduler cycle is still
-- active. A tracker that already terminally failed under the previous runtime
-- remains stamped with that cycle at claim time, so the ordinary cursor path
-- cannot see it again. Keep the recovery decision ledger-backed and bounded:
-- only the latest old-runtime failure is eligible, and the first later claim
-- permanently closes recovery eligibility even if navigation never starts.
create index if not exists idx_naver_shopping_scheduler_events_cycle_tracker_runtime_recovery
on public.naver_shopping_scheduler_events(cycle_id, tracker_id, event_id desc)
where event_type in (
  'tracker_claimed',
  'tracker_committed',
  'finite_window_committed',
  'job_failed'
);

create or replace function public.mi_naver_shopping_cycle_runtime_recovery_eligible(
  p_tracker_id uuid,
  p_cycle_id uuid,
  p_runtime_version text,
  p_runtime_fingerprint text
) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    p_tracker_id is not null
    and p_cycle_id is not null
    and pg_catalog.btrim(coalesce(p_runtime_version, '')) <> ''
    and pg_catalog.lower(pg_catalog.btrim(coalesce(p_runtime_fingerprint, '')))
      ~ '^[a-f0-9]{64}$'
    and coalesce((
      select
        terminal.event_type = 'job_failed'
        and terminal.runtime_version is not null
        and terminal.runtime_fingerprint ~ '^[a-f0-9]{64}$'
        and (
          terminal.runtime_version is distinct from pg_catalog.btrim(p_runtime_version)
          or terminal.runtime_fingerprint is distinct from
             pg_catalog.lower(pg_catalog.btrim(p_runtime_fingerprint))
        )
        and not exists (
          select 1
          from public.naver_shopping_scheduler_events as later_claim
          where later_claim.cycle_id = p_cycle_id
            and later_claim.tracker_id = p_tracker_id
            and later_claim.event_type = 'tracker_claimed'
            and later_claim.event_id > terminal.event_id
        )
      from (
        select
          event.event_id,
          event.event_type,
          run.runtime_version,
          run.runtime_fingerprint
        from (
          select
            candidate.event_id,
            candidate.event_type,
            candidate.run_id
          from public.naver_shopping_scheduler_events as candidate
          where candidate.cycle_id = p_cycle_id
            and candidate.tracker_id = p_tracker_id
            and candidate.event_type in (
              'tracker_committed',
              'finite_window_committed',
              'job_failed'
            )
          order by candidate.event_id desc
          limit 1
        ) as event
        left join public.naver_shopping_worker_runs as run
          on run.run_id = event.run_id
      ) as terminal
    ), false);
$$;

revoke all on function public.mi_naver_shopping_cycle_runtime_recovery_eligible(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_naver_shopping_cycle_runtime_recovery_eligible(
  uuid, uuid, text, text
) to service_role;

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
  v_deferred_count integer := 0;
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
      return jsonb_build_object(
        'status', 'waiting', 'cycleId', null, 'priority', 'probe',
        'claims', '[]'::jsonb, 'deferredCount', 0, 'groupSize', 0
      );
    end if;
    v_priority := 'probe';
  else
    if current_row.scheduler_cycle_status <> 'active'
      or current_row.scheduler_cycle_id is null then
      return jsonb_build_object(
        'status', 'no_cycle', 'cycleId', null, 'claims', '[]'::jsonb,
        'deferredCount', 0, 'groupSize', 0
      );
    end if;

    -- Runtime handoff recovery runs before the ordinary cursor, but it does not
    -- move or reset that cursor. Quarantine and live processing remain intact.
    select * into seed
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
      and tracker.worker_last_cycle_id = current_row.scheduler_cycle_id
      and public.mi_naver_shopping_cycle_runtime_recovery_eligible(
        tracker.id,
        current_row.scheduler_cycle_id,
        current_row.runtime_version,
        current_row.runtime_fingerprint
      )
      and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
      and (tracker.processing_until is null or tracker.processing_until <= v_now)
    order by tracker.sort_order asc, tracker.created_at asc, tracker.id asc
    limit 1
    for update skip locked;
    if seed.id is not null then v_priority := 'repair'; end if;

    -- A newly registered keyword gets exactly one priority group, then the
    -- saved normal cursor is resumed before another new group may run.
    if seed.id is null and not current_row.scheduler_cycle_resume_cursor then
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
        and tracker.processing_until > v_now;
      if v_waiting > 0 then
        return jsonb_build_object(
          'status', 'waiting', 'cycleId', current_row.scheduler_cycle_id,
          'claims', '[]'::jsonb, 'deferredCount', 0, 'groupSize', 0
        );
      end if;
      update public.naver_shopping_worker_coordination
      set scheduler_cycle_status = 'completed',
          scheduler_cycle_completed_at = v_now,
          scheduler_cycle_resume_cursor = false,
          updated_at = v_now
      where lane_key = 'global';
      return jsonb_build_object(
        'status', 'cycle_completed', 'cycleId', current_row.scheduler_cycle_id,
        'claims', '[]'::jsonb, 'deferredCount', 0, 'groupSize', 0
      );
    end if;
  end if;

  v_keyword_key := regexp_replace(lower(trim(seed.keyword)), '\s+', '', 'g');

  if p_probe_tracker_id is null and v_priority <> 'repair' then
    -- A migration installed during an active legacy max-100 cycle may find a
    -- remainder after this keyword already produced a browser collection.
    -- Roster that remainder as deferred instead of collecting the same group
    -- a second time in the same cycle.
    if exists (
      select 1
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and regexp_replace(lower(trim(tracker.keyword)), '\s+', '', 'g') = v_keyword_key
        and tracker.worker_last_cycle_id = current_row.scheduler_cycle_id
    ) then
      with deferred_group_members as (
        update public.naver_rank_trackers as tracker
        set worker_last_cycle_id = current_row.scheduler_cycle_id,
            worker_last_cycle_deferred_at = v_now
        where tracker.status = 'active'
          and regexp_replace(lower(trim(tracker.keyword)), '\s+', '', 'g') = v_keyword_key
          and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
          and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
          and (tracker.processing_until is null or tracker.processing_until <= v_now)
          and (tracker.last_checked_at is null or tracker.created_at <= current_row.scheduler_cycle_started_at)
        returning tracker.id
      )
      select count(*)::integer into v_deferred_count
      from deferred_group_members;

      return jsonb_build_object(
        'status', 'waiting',
        'cycleId', current_row.scheduler_cycle_id,
        'priority', v_priority,
        'claims', '[]'::jsonb,
        'deferredCount', v_deferred_count,
        'groupSize', v_deferred_count
      );
    end if;
  end if;

  -- Do not start a second collection while a stale/live lease for the same
  -- normalized keyword still exists. The global cycle retries only after the
  -- lease reaches a terminal state or expires.
  if p_probe_tracker_id is null and exists (
    select 1
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
      and tracker.id <> seed.id
      and regexp_replace(lower(trim(tracker.keyword)), '\s+', '', 'g') = v_keyword_key
      and tracker.processing_until > v_now
  ) then
    return jsonb_build_object(
      'status', 'waiting',
      'cycleId', current_row.scheduler_cycle_id,
      'priority', v_priority,
      'claims', '[]'::jsonb,
      'deferredCount', 0,
      'groupSize', 0
    );
  end if;

  with group_candidates as (
    select tracker.id
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
      and regexp_replace(lower(trim(tracker.keyword)), '\s+', '', 'g') = v_keyword_key
      and (tracker.processing_until is null or tracker.processing_until <= v_now)
      and ((p_probe_tracker_id is not null and tracker.id = p_probe_tracker_id) or (
        p_probe_tracker_id is null
        and (
          (
            v_priority = 'repair'
            and tracker.worker_last_cycle_id = current_row.scheduler_cycle_id
            and public.mi_naver_shopping_cycle_runtime_recovery_eligible(
              tracker.id,
              current_row.scheduler_cycle_id,
              current_row.runtime_version,
              current_row.runtime_fingerprint
            )
          )
          or (
            v_priority <> 'repair'
            and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
          )
        )
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.last_checked_at is null or tracker.created_at <= current_row.scheduler_cycle_started_at)
      ))
    order by
      case when tracker.id = seed.id then 0 else 1 end asc,
      tracker.last_checked_at asc nulls first,
      tracker.worker_last_cycle_claimed_at asc nulls first,
      tracker.sort_order asc,
      tracker.created_at asc,
      tracker.id asc
    limit 100
    for update skip locked
  ), claimed as (
    update public.naver_rank_trackers as tracker
    set processing_started_at = v_now,
        processing_until = v_lease_until,
        worker_last_cycle_id = case when p_probe_tracker_id is null then current_row.scheduler_cycle_id else tracker.worker_last_cycle_id end,
        worker_last_cycle_claimed_at = case when p_probe_tracker_id is null then v_now else tracker.worker_last_cycle_claimed_at end,
        worker_last_cycle_deferred_at = case when p_probe_tracker_id is null then null else tracker.worker_last_cycle_deferred_at end,
        last_message = case
          when v_priority = 'repair' then '오류 보완 후 1회 우선 재검증 중입니다.'
          else '자동 순위 갱신 처리 중입니다.'
        end
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
      'claims', '[]'::jsonb,
      'deferredCount', 0,
      'groupSize', 0
    );
  end if;

  if p_probe_tracker_id is null and v_priority <> 'repair' then
    with deferred_group_members as (
      update public.naver_rank_trackers as tracker
      set worker_last_cycle_id = current_row.scheduler_cycle_id,
          worker_last_cycle_deferred_at = v_now
      where tracker.status = 'active'
        and regexp_replace(lower(trim(tracker.keyword)), '\s+', '', 'g') = v_keyword_key
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
        and (tracker.last_checked_at is null or tracker.created_at <= current_row.scheduler_cycle_started_at)
      returning tracker.id
    )
    select count(*)::integer into v_deferred_count
    from deferred_group_members;

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
    'claims', v_claims,
    'deferredCount', v_deferred_count,
    'groupSize', v_claim_count + v_deferred_count
  );
end;
$$;

revoke all on function public.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, integer, uuid
) to service_role;

commit;

begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;
lock table public.naver_shopping_account_priority_requests in share row exclusive mode;
lock table public.naver_shopping_account_priority_members in share row exclusive mode;
lock table public.naver_rank_trackers in share row exclusive mode;
lock table public.naver_shopping_rank_lookup_jobs in share row exclusive mode;

-- The one-shot account request may start while the durable global cycle is
-- already in progress. Once every ready account member has already been
-- stamped with that cycle, the account interceptor used to return `empty`.
-- The HTTP handler then fell through to the ordinary global claim and could
-- process an unrelated account forever without completing the frozen request.
--
-- Install only on the exact idle 1.1.19 control plane. The migration changes
-- no request/member/tracker/cursor/quarantine/lease data; it only replaces the
-- internal claim transport with a bounded natural-cycle handoff wrapper.
do $migration_guard$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  coordination_found boolean := false;
  active_request_count integer := 0;
  pending_member_count integer := 0;
  claimed_member_count integer := 0;
  processing_count integer := 0;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  coordination_found := found;

  select count(*)::integer into active_request_count
  from public.naver_shopping_account_priority_requests as request
  where request.state = 'active'
    and request.required_runtime_version = '1.1.19'
    and request.required_runtime_fingerprint =
      '631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e';

  select
    count(*) filter (where member.state = 'pending')::integer,
    count(*) filter (where member.state = 'claimed')::integer
  into pending_member_count, claimed_member_count
  from public.naver_shopping_account_priority_members as member
  join public.naver_shopping_account_priority_requests as request
    on request.request_id = member.request_id
  where request.state = 'active';

  select (
    (select count(*)
     from public.naver_shopping_rank_lookup_jobs as lookup
     where lookup.status = 'processing'
       and lookup.processing_until > pg_catalog.clock_timestamp())
    +
    (select count(*)
     from public.naver_rank_trackers as tracker
     where tracker.status = 'active'
       and tracker.processing_until > pg_catalog.clock_timestamp())
  )::integer into processing_count;

  if coordination_found is not true
    or current_row.runtime_version is distinct from '1.1.19'
    or current_row.runtime_fingerprint is distinct from
      '631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e'
    or current_row.primary_worker_id is distinct from 'windows-desktop-primary'
    or current_row.cadence_mode is distinct from 'baseline'
    or current_row.cadence_minutes is distinct from 10
    or current_row.circuit_state is distinct from 'closed'
    or current_row.circuit_reason is not null
    or current_row.cooldown_until is not null
    or current_row.scheduler_cycle_status is distinct from 'active'
    or current_row.scheduler_cycle_id is null
    or active_request_count <> 1
    or pending_member_count < 1
    or claimed_member_count <> 0
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
    raise exception 'naver_shopping_account_priority_cycle_handoff_requires_idle_1_1_19';
  end if;
end
$migration_guard$;

alter function mi_internal.mi_claim_naver_shopping_account_priority(
  text, uuid, uuid, integer
) rename to mi_claim_naver_shopping_account_priority_pre_handoff;

-- Preserve the original claim implementation as the sole member selector and
-- claim writer. This wrapper handles only its proven active-request `empty`
-- outcome. It never creates a cycle, requests a wake, rewrites tracker state,
-- or advances the global cursor. When safe, it completes only the exhausted
-- current cycle; the next scheduled rank-catch-up remains the sole owner of
-- starting and rostering the next cycle.
create or replace function mi_internal.mi_claim_naver_shopping_account_priority(
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
  original_result jsonb;
  current_row public.naver_shopping_worker_coordination%rowtype;
  post_row public.naver_shopping_worker_coordination%rowtype;
  active_request public.naver_shopping_account_priority_requests%rowtype;
  v_now timestamptz := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  v_pending_count integer := 0;
  v_active_pending_count integer := 0;
  v_rostered_pending_count integer := 0;
  v_current_eligible_count integer := 0;
  v_safe_blocked_partition_count integer := 0;
  v_rollover_beneficiary_count integer := 0;
  v_claimed_count integer := 0;
  v_processing_count integer := 0;
  v_open_claim_count integer := 0;
  v_cycle_completed_event_count integer := 0;
  v_updated_count integer := 0;
begin
  original_result :=
    mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff(
      p_worker_id, p_lane_token, p_run_id, p_lease_seconds
    );

  if coalesce((original_result ->> 'intercept')::boolean, false) is not true
    or original_result ->> 'status' is distinct from 'empty'
    or coalesce((original_result ->> 'accountPriority')::boolean, false)
      is not true then
    return original_result;
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  select * into active_request
  from public.naver_shopping_account_priority_requests as request
  where request.state = 'active'
  order by request.requested_at asc, request.request_id asc
  limit 1
  for update;

  -- Re-prove the same exact lane/runtime envelope after the delegated selector
  -- returned. A changed or missing envelope is a transaction failure, not a
  -- reason to fall through to unrelated global work.
  if not found
    or active_request.request_id is null
    or pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, ''))) <>
      'windows-desktop-primary'
    or current_row.primary_worker_id is distinct from 'windows-desktop-primary'
    or current_row.lease_worker_id is distinct from
      pg_catalog.lower(pg_catalog.btrim(p_worker_id))
    or current_row.lease_token is distinct from p_lane_token
    or current_row.run_id is distinct from p_run_id
    or current_row.lease_until is null
    or current_row.lease_until <= v_now
    or current_row.current_stage is distinct from 'claiming'
    or current_row.current_page is distinct from 0
    or current_row.current_job_kind is not null
    or current_row.current_tracker_id is not null
    or current_row.circuit_state is distinct from 'closed'
    or current_row.circuit_reason is not null
    or current_row.cooldown_until is not null
    or current_row.runtime_version is distinct from
      active_request.required_runtime_version
    or current_row.runtime_fingerprint is distinct from
      active_request.required_runtime_fingerprint then
    raise exception 'naver_shopping_account_priority_cycle_handoff_lane_lost';
  end if;

  select
    count(*)::integer,
    count(*) filter (
      where tracker.id is not null
        and tracker.status = 'active'
        and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
          active_request.agency_code
    )::integer,
    count(*) filter (
      where tracker.id is not null
        and tracker.status = 'active'
        and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
          active_request.agency_code
        and (
          select count(*)
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
        ) = 1
    )::integer,
    count(*) filter (
      where tracker.id is not null
        and tracker.status = 'active'
        and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
          active_request.agency_code
        and tracker.worker_last_cycle_id is distinct from
          current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null
          or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null
          or tracker.processing_until <= v_now)
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
            and roster.roster_state is distinct from 'new_after_start'
        )
    )::integer,
    count(*) filter (
      where tracker.id is not null
        and tracker.status = 'active'
        and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
          active_request.agency_code
        and (tracker.processing_until is null
          or tracker.processing_until <= v_now)
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
        )
        and (
          tracker.worker_quarantined_until > v_now
          or (
            (tracker.worker_quarantined_until is null
              or tracker.worker_quarantined_until <= v_now)
            and (
              tracker.worker_last_cycle_id = current_row.scheduler_cycle_id
              or exists (
                select 1
                from public.naver_shopping_scheduler_events as rollover_roster
                where rollover_roster.event_type = 'cycle_rostered'
                  and rollover_roster.cycle_id = current_row.scheduler_cycle_id
                  and rollover_roster.tracker_id = tracker.id
                  and rollover_roster.roster_state = 'new_after_start'
              )
            )
          )
        )
    )::integer,
    count(*) filter (
      where tracker.id is not null
        and tracker.status = 'active'
        and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
          active_request.agency_code
        and (tracker.worker_quarantined_until is null
          or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null
          or tracker.processing_until <= v_now)
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
            and (
              tracker.worker_last_cycle_id = current_row.scheduler_cycle_id
              or roster.roster_state = 'new_after_start'
            )
        )
    )::integer
  into v_pending_count, v_active_pending_count, v_rostered_pending_count,
    v_current_eligible_count, v_safe_blocked_partition_count,
    v_rollover_beneficiary_count
  from public.naver_shopping_account_priority_members as member
  left join public.naver_rank_trackers as tracker
    on tracker.id = member.tracker_id
  where member.request_id = active_request.request_id
    and member.state = 'pending';

  select count(*)::integer into v_claimed_count
  from public.naver_shopping_account_priority_members as member
  where member.request_id = active_request.request_id
    and member.state = 'claimed';

  select (
    (select count(*)
     from public.naver_shopping_rank_lookup_jobs as lookup
     where lookup.status = 'processing'
       and lookup.processing_until > v_now)
    +
    (select count(*)
     from public.naver_rank_trackers as tracker
     where tracker.status = 'active'
       and tracker.processing_until > v_now)
  )::integer into v_processing_count;

  select count(*)::integer into v_open_claim_count
  from public.naver_shopping_scheduler_events as claimed
  where claimed.event_type = 'tracker_claimed'
    and claimed.cycle_id = current_row.scheduler_cycle_id
    and not exists (
      select 1
      from public.naver_shopping_scheduler_events as terminal
      where terminal.claim_id = claimed.claim_id
        and terminal.tracker_id = claimed.tracker_id
        and terminal.event_type in (
          'tracker_committed', 'finite_window_committed', 'job_failed'
        )
    );

  if current_row.scheduler_cycle_status = 'active'
    and current_row.scheduler_cycle_id is not null
    and active_request.requested_cycle_id = current_row.scheduler_cycle_id
    and active_request.requested_cycle_number =
      current_row.scheduler_cycle_number
    and v_pending_count > 0
    and v_active_pending_count = v_pending_count
    and v_rostered_pending_count = v_pending_count
    and v_current_eligible_count = 0
    and v_safe_blocked_partition_count = v_pending_count
    and v_rollover_beneficiary_count > 0
    and v_claimed_count = 0
    and v_processing_count = 0
    and v_open_claim_count = 0 then
    update public.naver_shopping_worker_coordination as coordination
    set scheduler_cycle_status = 'completed',
        scheduler_cycle_completed_at = v_now,
        updated_at = v_now
    where coordination.lane_key = 'global'
      and coordination.scheduler_cycle_status = 'active'
      and coordination.scheduler_cycle_id = current_row.scheduler_cycle_id
      and coordination.scheduler_cycle_number = current_row.scheduler_cycle_number
      and coordination.lease_worker_id =
        pg_catalog.lower(pg_catalog.btrim(p_worker_id))
      and coordination.lease_token = p_lane_token
      and coordination.run_id = p_run_id
      and coordination.current_stage = 'claiming'
      and coordination.current_page = 0
      and coordination.current_job_kind is null
      and coordination.current_tracker_id is null;
    get diagnostics v_updated_count = row_count;

    if v_updated_count <> 1 then
      raise exception 'naver_shopping_account_priority_cycle_handoff_conflict';
    end if;

    select * into post_row
    from public.naver_shopping_worker_coordination
    where lane_key = 'global'
    for update;

    select count(*)::integer into v_cycle_completed_event_count
    from public.naver_shopping_scheduler_events as completed
    where completed.event_type = 'cycle_completed'
      and completed.cycle_id = current_row.scheduler_cycle_id
      and completed.cycle_number = current_row.scheduler_cycle_number;

    if post_row.scheduler_cycle_id is distinct from
        current_row.scheduler_cycle_id
      or post_row.scheduler_cycle_number is distinct from
        current_row.scheduler_cycle_number
      or post_row.scheduler_cycle_status is distinct from 'completed'
      or post_row.scheduler_cycle_completed_at is distinct from v_now
      or post_row.scheduler_cycle_cursor_sort_order is distinct from
        current_row.scheduler_cycle_cursor_sort_order
      or post_row.scheduler_cycle_cursor_created_at is distinct from
        current_row.scheduler_cycle_cursor_created_at
      or post_row.scheduler_cycle_cursor_tracker_id is distinct from
        current_row.scheduler_cycle_cursor_tracker_id
      or post_row.scheduler_cycle_resume_cursor is distinct from
        current_row.scheduler_cycle_resume_cursor
      or post_row.lease_worker_id is distinct from current_row.lease_worker_id
      or post_row.lease_token is distinct from current_row.lease_token
      or post_row.run_id is distinct from current_row.run_id
      or v_cycle_completed_event_count <> 1 then
      raise exception 'naver_shopping_account_priority_cycle_handoff_postcheck_failed';
    end if;

    return pg_catalog.jsonb_build_object(
      'intercept', true,
      'status', 'waiting',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true,
      'reason', 'account_cycle_handoff',
      'cycleId', current_row.scheduler_cycle_id
    );
  end if;

  -- The request is allowed to complete its requested cycle at most once.
  -- After that bounded handoff, a future-quarantine-only remainder waits for
  -- natural eligibility (or the immutable request expiry) instead of cycling
  -- repeatedly or falling through to unrelated work.
  return pg_catalog.jsonb_build_object(
    'intercept', true,
    'status', 'waiting',
    'priority', 'repair',
    'claims', '[]'::jsonb,
    'accountPriority', true,
    'reason', 'account_members_not_yet_eligible'
  );
end;
$$;

revoke all on function
  mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff(
    text, uuid, uuid, integer
  ) from public, anon, authenticated, service_role;
grant execute on function
  mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff(
    text, uuid, uuid, integer
  ) to service_role;

revoke all on function mi_internal.mi_claim_naver_shopping_account_priority(
  text, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function mi_internal.mi_claim_naver_shopping_account_priority(
  text, uuid, uuid, integer
) to service_role;

commit;

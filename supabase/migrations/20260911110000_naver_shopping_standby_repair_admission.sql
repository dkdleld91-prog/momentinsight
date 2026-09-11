-- Standby admission for the repair/account-priority selector (2026-09-11).
-- Root cause (production replay 2026-09-11 19:38 KST): every `claim` first calls
-- public.mi_claim_naver_shopping_repair_priority → mi_internal
-- .mi_claim_naver_shopping_account_priority → …_pre_handoff, whose first guard
-- raised `naver_shopping_account_priority_claim_invalid` for any worker other
-- than windows-desktop-primary. The server turned that into a 5xx, the standby
-- run aborted before the cycle claim, and the MacBook never took over
-- (macbook-standby rank-catch-up: server_error at 19:08:45, 19:18:45, 19:28:4x,
-- 19:38:4x while the primary was silent since 18:49).
-- Change: the pre-handoff selector returns `{"intercept": false}` for a valid
-- non-primary lane holder instead of raising. Account cohorts remain
-- primary-only (the later lane/identity re-proof is unchanged); a standby simply
-- proceeds to the cycle claim, which the account-priority trigger gate already
-- holds back while a request is active. Everything else in the function body is
-- byte-identical to the 20260831033617 declaration that 20260831050000 renamed.
-- Runtime-neutral: no version or fingerprint literal; no stop window needed.
begin;

do $migration_guard$
begin
  if not exists (
    select 1
    from pg_catalog.pg_proc as proc
    join pg_catalog.pg_namespace as ns on ns.oid = proc.pronamespace
    where ns.nspname = 'mi_internal'
      and proc.proname = 'mi_claim_naver_shopping_account_priority_pre_handoff'
  ) then
    raise exception 'naver_shopping_standby_repair_admission_requires_pre_handoff';
  end if;
end
$migration_guard$;

create or replace function mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff(
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
  post_row public.naver_shopping_worker_coordination%rowtype;
  active_request public.naver_shopping_account_priority_requests%rowtype;
  selected_member public.naver_shopping_account_priority_members%rowtype;
  seed public.naver_rank_trackers%rowtype;
  v_now timestamptz := date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_lease_until timestamptz;
  v_keyword_key text;
  v_claims jsonb := '[]'::jsonb;
  v_claimed_count integer := 0;
  v_claim_event_count integer := 0;
  v_claim_id_count integer := 0;
  v_group_event_count integer := 0;
  v_group_event_id bigint;
  v_first_claim_event_id bigint;
begin
  if pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, '')))
      !~ '^[a-z0-9][a-z0-9:_-]{2,63}$'
    or p_lane_token is null
    or p_run_id is null
    or p_lease_seconds < 60
    or p_lease_seconds > 2100 then
    raise exception 'naver_shopping_account_priority_claim_invalid';
  end if;
  -- 2026-09-11: a standby lane holder is never an account-priority claimant.
  -- Account cohorts stay frozen to the primary identity below; every other
  -- worker gets no interception and continues to the cycle claim, which the
  -- trigger gate already holds back while a request is active. Raising here
  -- aborted every standby run at its first job selection (production
  -- 2026-09-11 19:08–19:38 KST: macbook-standby `server_error` every 10 min
  -- while the primary was silent), so failover never happened.
  if pg_catalog.lower(pg_catalog.btrim(p_worker_id)) <> 'windows-desktop-primary' then
    return pg_catalog.jsonb_build_object('intercept', false);
  end if;
  v_lease_until := v_now + pg_catalog.make_interval(secs => p_lease_seconds);

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found
    or current_row.primary_worker_id is distinct from 'windows-desktop-primary'
    or current_row.lease_worker_id is distinct from
      pg_catalog.lower(pg_catalog.btrim(p_worker_id))
    or current_row.lease_token is distinct from p_lane_token
    or current_row.run_id is distinct from p_run_id
    or current_row.lease_until is null
    or current_row.lease_until <= v_now
    or current_row.circuit_state is distinct from 'closed'
    or current_row.circuit_reason is not null
    or current_row.cooldown_until is not null
    or current_row.current_stage is distinct from 'claiming'
    or current_row.current_page is distinct from 0
    or current_row.current_job_kind is not null
    or current_row.current_tracker_id is not null then
    raise exception 'naver_shopping_account_priority_lane_lost';
  end if;

  perform mi_internal.mi_reconcile_naver_shopping_account_priority(v_now);

  select * into active_request
  from public.naver_shopping_account_priority_requests as request
  where request.state = 'active'
  order by request.requested_at asc, request.request_id asc
  limit 1
  for update;

  if active_request.request_id is null then
    return pg_catalog.jsonb_build_object('intercept', false);
  end if;

  if current_row.runtime_version is distinct from
      active_request.required_runtime_version
    or current_row.runtime_fingerprint is distinct from
      active_request.required_runtime_fingerprint then
    return pg_catalog.jsonb_build_object(
      'intercept', true,
      'status', 'waiting',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true,
      'reason', 'runtime_identity_waiting'
    );
  end if;

  -- worker_runs records one immutable navigating start per run_id.  Limit an
  -- active account request to one normalized-keyword group per worker run so
  -- every account claim can prove the required
  -- claim -> navigating run -> terminal order independently.  A later natural
  -- worker run receives a new run_id and continues the frozen cohort.
  if exists (
    select 1
    from public.naver_shopping_account_priority_members as member
    where member.request_id = active_request.request_id
      and member.claimed_run_id = p_run_id
  ) then
    return pg_catalog.jsonb_build_object(
      'intercept', true,
      'status', 'waiting',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true,
      'reason', 'account_run_already_consumed'
    );
  end if;

  if exists (
    select 1
    from public.naver_shopping_account_priority_members as member
    join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
    where member.request_id = active_request.request_id
      and member.state = 'claimed'
      and tracker.processing_started_at = member.claimed_lease_started_at
      and tracker.processing_until > v_now
  ) then
    return pg_catalog.jsonb_build_object(
      'intercept', true,
      'status', 'waiting',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true
    );
  end if;

  -- No cycle is created or reset here.  The ordinary queue RPC remains the
  -- sole natural cycle lifecycle owner.
  if current_row.scheduler_cycle_status <> 'active'
    or current_row.scheduler_cycle_id is null then
    return pg_catalog.jsonb_build_object(
      'intercept', true,
      'status', 'empty',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true
    );
  end if;

  select member.* into selected_member
  from public.naver_shopping_account_priority_members as member
  join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
  where member.request_id = active_request.request_id
    and member.state = 'pending'
    and tracker.status = 'active'
    and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
      active_request.agency_code
    and tracker.worker_last_cycle_id is distinct from
      current_row.scheduler_cycle_id
    and (tracker.worker_quarantined_until is null
      or tracker.worker_quarantined_until <= v_now)
    and (tracker.processing_until is null or tracker.processing_until <= v_now)
    and exists (
      select 1
      from public.naver_shopping_scheduler_events as roster
      where roster.event_type = 'cycle_rostered'
        and roster.cycle_id = current_row.scheduler_cycle_id
        and roster.tracker_id = tracker.id
        and roster.roster_state is distinct from 'new_after_start'
    )
  order by member.position asc, member.tracker_id asc
  limit 1;

  if selected_member.tracker_id is null then
    return pg_catalog.jsonb_build_object(
      'intercept', true,
      'status', 'empty',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true
    );
  end if;

  select * into seed
  from public.naver_rank_trackers as tracker
  where tracker.id = selected_member.tracker_id
    and tracker.status = 'active'
    and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
      active_request.agency_code
    and tracker.worker_last_cycle_id is distinct from
      current_row.scheduler_cycle_id
    and (tracker.worker_quarantined_until is null
      or tracker.worker_quarantined_until <= v_now)
    and (tracker.processing_until is null or tracker.processing_until <= v_now)
    and exists (
      select 1
      from public.naver_shopping_scheduler_events as roster
      where roster.event_type = 'cycle_rostered'
        and roster.cycle_id = current_row.scheduler_cycle_id
        and roster.tracker_id = tracker.id
        and roster.roster_state is distinct from 'new_after_start'
    );

  if seed.id is null then
    return pg_catalog.jsonb_build_object(
      'intercept', true,
      'status', 'empty',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true
    );
  end if;

  v_keyword_key := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(seed.keyword)), '\s+', '', 'g'
  );

  with group_candidates as (
    select tracker.id
    from public.naver_shopping_account_priority_members as member
    join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
    where member.request_id = active_request.request_id
      and member.state = 'pending'
      and tracker.status = 'active'
      and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
        active_request.agency_code
      and pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.btrim(tracker.keyword)), '\s+', '', 'g'
      ) = v_keyword_key
      and tracker.worker_last_cycle_id is distinct from
        current_row.scheduler_cycle_id
      and (tracker.worker_quarantined_until is null
        or tracker.worker_quarantined_until <= v_now)
      and (tracker.processing_until is null or tracker.processing_until <= v_now)
      and exists (
        select 1
        from public.naver_shopping_scheduler_events as roster
        where roster.event_type = 'cycle_rostered'
          and roster.cycle_id = current_row.scheduler_cycle_id
          and roster.tracker_id = tracker.id
          and roster.roster_state is distinct from 'new_after_start'
    )
    order by member.position asc, tracker.id asc
    limit 100
  ), claimed as (
    update public.naver_rank_trackers as tracker
    set processing_started_at = v_now,
        processing_until = v_lease_until,
        worker_last_cycle_id = current_row.scheduler_cycle_id,
        worker_last_cycle_claimed_at = v_now,
        worker_last_cycle_deferred_at = null,
        last_message = '자동 순위 갱신 처리 중입니다.'
    from group_candidates as candidate
    where tracker.id = candidate.id
    returning tracker.id
  )
  select count(*)::integer,
         coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'trackerId', claimed.id,
           'leaseStartedAt', v_now,
           'leaseUntil', v_lease_until
         ) order by claimed.id), '[]'::jsonb)
  into v_claimed_count, v_claims
  from claimed;

  if v_claimed_count < 1 or v_claimed_count > 100 then
    return pg_catalog.jsonb_build_object(
      'intercept', true,
      'status', 'empty',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true
    );
  end if;

  -- The AFTER UPDATE statement trigger has now emitted one group claim and
  -- one exact tracker_claimed event for every updated request member. The real
  -- worker writes its navigating run only after this claim RPC returns, so
  -- claim-time provenance is the locked lane plus exact event identity. The
  -- terminal reconciler later requires the exact navigating run row.
  select count(*)::integer, count(distinct event.claim_id)::integer,
         min(event.event_id)
  into v_claim_event_count, v_claim_id_count, v_first_claim_event_id
  from public.naver_shopping_scheduler_events as event
  where event.event_type = 'tracker_claimed'
    and event.cycle_id = current_row.scheduler_cycle_id
    and event.run_id = p_run_id
    and event.worker_id = pg_catalog.lower(pg_catalog.btrim(p_worker_id))
    and event.lease_started_at = v_now
    and event.occurred_at >= active_request.requested_at
    and exists (
      select 1
      from public.naver_shopping_account_priority_members as member
      join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
      where member.request_id = active_request.request_id
        and member.state = 'pending'
        and member.tracker_id = event.tracker_id
        and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
          active_request.agency_code
        and pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(tracker.keyword)), '\s+', '', 'g'
        ) = v_keyword_key
    );

  select count(distinct grouped.event_id)::integer, min(grouped.event_id)
  into v_group_event_count, v_group_event_id
  from public.naver_shopping_scheduler_events as grouped
  join public.naver_shopping_scheduler_events as claimed
    on claimed.claim_id = grouped.claim_id
   and claimed.event_type = 'tracker_claimed'
   and claimed.cycle_id = current_row.scheduler_cycle_id
   and claimed.run_id = p_run_id
   and claimed.worker_id = pg_catalog.lower(pg_catalog.btrim(p_worker_id))
   and claimed.lease_started_at = v_now
  where grouped.event_type = 'group_claimed'
    and grouped.cycle_id = current_row.scheduler_cycle_id
    and grouped.run_id = p_run_id
    and grouped.worker_id = pg_catalog.lower(pg_catalog.btrim(p_worker_id))
    and grouped.lease_started_at = v_now
    and grouped.occurred_at >= active_request.requested_at
    and exists (
      select 1
      from public.naver_shopping_account_priority_members as member
      join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
      where member.request_id = active_request.request_id
        and member.state = 'pending'
        and member.tracker_id = claimed.tracker_id
        and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
          active_request.agency_code
        and pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(tracker.keyword)), '\s+', '', 'g'
        ) = v_keyword_key
    );

  if v_claim_event_count <> v_claimed_count
    or v_claim_id_count <> 1
    or v_group_event_count <> 1
    or v_group_event_id is null
    or v_first_claim_event_id is null
    or v_group_event_id >= v_first_claim_event_id then
    raise exception 'naver_shopping_account_priority_claim_event_missing';
  end if;

  select * into post_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if post_row.scheduler_cycle_cursor_sort_order is distinct from
      current_row.scheduler_cycle_cursor_sort_order
    or post_row.scheduler_cycle_cursor_created_at is distinct from
      current_row.scheduler_cycle_cursor_created_at
    or post_row.scheduler_cycle_cursor_tracker_id is distinct from
      current_row.scheduler_cycle_cursor_tracker_id
    or post_row.scheduler_cycle_resume_cursor is distinct from
      current_row.scheduler_cycle_resume_cursor then
    raise exception 'naver_shopping_account_priority_cursor_changed';
  end if;

  with exact_claims as (
    select event.event_id, event.claim_id, event.tracker_id
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'tracker_claimed'
      and event.cycle_id = current_row.scheduler_cycle_id
      and event.run_id = p_run_id
      and event.worker_id = pg_catalog.lower(pg_catalog.btrim(p_worker_id))
      and event.lease_started_at = v_now
      and event.occurred_at >= active_request.requested_at
  )
  update public.naver_shopping_account_priority_members as member
  set state = 'claimed',
      claimed_at = v_now,
      claimed_cycle_id = current_row.scheduler_cycle_id,
      claimed_cycle_number = current_row.scheduler_cycle_number,
      claimed_run_id = p_run_id,
      claimed_worker_id = pg_catalog.lower(pg_catalog.btrim(p_worker_id)),
      claimed_lease_started_at = v_now,
      claimed_lease_until = v_lease_until,
      claim_event_id = claim_event.event_id,
      claim_id = claim_event.claim_id,
      cursor_sort_order_before = current_row.scheduler_cycle_cursor_sort_order,
      cursor_created_at_before = current_row.scheduler_cycle_cursor_created_at,
      cursor_tracker_id_before = current_row.scheduler_cycle_cursor_tracker_id,
      cursor_resume_before = current_row.scheduler_cycle_resume_cursor,
      cursor_sort_order_after = post_row.scheduler_cycle_cursor_sort_order,
      cursor_created_at_after = post_row.scheduler_cycle_cursor_created_at,
      cursor_tracker_id_after = post_row.scheduler_cycle_cursor_tracker_id,
      cursor_resume_after = post_row.scheduler_cycle_resume_cursor
  from exact_claims as claim_event
  where member.request_id = active_request.request_id
    and member.tracker_id = claim_event.tracker_id
    and member.state = 'pending';
  get diagnostics v_claimed_count = row_count;

  if v_claimed_count <> v_claim_event_count then
    raise exception 'naver_shopping_account_priority_member_claim_conflict';
  end if;

  return pg_catalog.jsonb_build_object(
    'intercept', true,
    'status', 'claimed',
    'cycleId', current_row.scheduler_cycle_id,
    'keyword', seed.keyword,
    'priority', 'repair',
    'requestId', active_request.request_id,
    'position', selected_member.position,
    'accountPriority', true,
    'claims', v_claims
  );
end;
$$;

revoke all on function mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff(
  text, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff(
  text, uuid, uuid, integer
) to service_role;
commit;

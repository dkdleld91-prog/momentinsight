-- 계정 우선(one-shot) 요청 안전장치 — 묶음 2차-6 (F5 / F6)
--
-- F5  자격을 얻을 수 없는 코호트 멤버(삭제됨 / status<>'active' / 다른 계정으로
--     이동 / 새 사이클에서도 미로스터)가 섞이면 전역 레인이 요청 만료(24h)까지
--     정지했다.  reconcile 이 그런 멤버를 진행 중에 해제하고, 핸드오프가 미로스터
--     멤버를 차단 사유로 보지 않으며, 진행이 멈춘 요청은 여섯 번의 기본 케이던스
--     뒤 남은 pending 을 해제한다.  service_role 전용 즉시 취소 RPC 도 추가한다.
--
-- F6  핸드오프가 진행 중 사이클을 조기 완료하면 다음 사이클이 커서 null 로 시작해
--     뒤쪽 sort_order 추적기들이 그 사이클을 통째로 건너뛰었다.  핸드오프 시점의
--     커서를 보존했다가 바로 다음 사이클에 복원해 원래 위치부터 이어서 순회한다.
--
-- 런타임 리터럴 없음: 이 파일은 어떤 런타임 버전·지문 리터럴도 검사하지 않는다.
--   (2026-09-03 런타임 버전 하드코딩으로 수집이 2시간 정지한 사고의 재발 방지)
-- 설치 가드가 유휴 상태를 요구하지 않는 이유: F5 가 고치는 상태가 바로 "레인이
--   묶여 있는" 상태이므로, 사고 중에도 적용 가능해야 한다.  대신 lock_timeout 으로
--   실패를 빠르게 만든다.

begin;

set local lock_timeout = '5s';

do $migration_guard$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  coordination_found boolean := false;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  coordination_found := found;

  if coordination_found is not true
    or current_row.runtime_version is null
    or current_row.runtime_fingerprint is null then
    raise exception
      'naver_shopping_account_priority_cohort_eligibility_requires_registered_runtime';
  end if;

  if pg_catalog.to_regprocedure(
      'mi_internal.mi_claim_naver_shopping_account_priority_pre_handoff(text, uuid, uuid, integer)'
    ) is null
    or pg_catalog.to_regprocedure(
      'mi_internal.mi_queue_naver_shopping_cycle_pre_account_trigger_gate()'
    ) is null
    or pg_catalog.to_regprocedure(
      'mi_internal.mi_naver_shopping_account_priority_trigger_gate(text, uuid, uuid, text, boolean)'
    ) is null then
    raise exception
      'naver_shopping_account_priority_cohort_eligibility_requires_handoff_and_gate';
  end if;
end
$migration_guard$;

-- Why a member left the cohort before its own terminal.  Only an `expired`
-- member may carry one, so the existing member guard trigger keeps every other
-- transition byte-identical.
alter table public.naver_shopping_account_priority_members
  add column release_reason text;

alter table public.naver_shopping_account_priority_members
  add constraint naver_shopping_account_priority_members_release_reason_check
  check (
    release_reason is null
    or (
      state = 'expired'
      and release_reason in (
        'account_priority_tracker_missing',
        'account_priority_tracker_inactive',
        'account_priority_tracker_agency_changed',
        'account_priority_tracker_unrostered',
        'account_priority_request_stalled',
        'account_priority_cancelled'
      )
    )
  );

-- The cursor an account handoff took out of service, plus the exact cycle that
-- gave it back.  One row per handed-off cycle; nothing here is worker input.
create table public.naver_shopping_account_priority_cycle_resume_points (
  handoff_cycle_id uuid primary key,
  handoff_cycle_number bigint not null,
  request_id uuid not null
    references public.naver_shopping_account_priority_requests(request_id),
  cursor_sort_order integer,
  cursor_created_at timestamptz,
  cursor_tracker_id uuid,
  resume_cursor boolean not null,
  created_at timestamptz not null,
  resolved_at timestamptz,
  resolution text check (resolution in ('restored', 'skipped')),
  restored_cycle_id uuid,
  restored_cycle_number bigint,
  check (
    (resolved_at is null
      and resolution is null
      and restored_cycle_id is null
      and restored_cycle_number is null)
    or (resolved_at is not null
      and resolution = 'restored'
      and restored_cycle_id is not null
      and restored_cycle_number is not null)
    or (resolved_at is not null
      and resolution = 'skipped'
      and restored_cycle_id is null
      and restored_cycle_number is null)
  )
);

create index idx_naver_shopping_account_priority_resume_open
on public.naver_shopping_account_priority_cycle_resume_points(
  handoff_cycle_number desc
)
where resolved_at is null;

alter table public.naver_shopping_account_priority_cycle_resume_points
  enable row level security;
alter table public.naver_shopping_account_priority_cycle_resume_points
  force row level security;
revoke all on table public.naver_shopping_account_priority_cycle_resume_points
from public, anon, authenticated, service_role;
grant select, insert, update
on table public.naver_shopping_account_priority_cycle_resume_points
to service_role;


-- Reconcile v2.  Everything the installed reconciler already did is preserved
-- byte for byte; the three release steps below are appended before the 24h
-- expiry step so a released member is closed as `expired` with an explicit
-- reason and the ordinary completion rule can finish the request.
create or replace function mi_internal.mi_reconcile_naver_shopping_account_priority(
  p_now timestamptz
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_now is null then
    raise exception 'naver_shopping_account_priority_reconcile_invalid';
  end if;

  with terminal_summary as (
    select
      member.request_id,
      member.tracker_id,
      count(*)::integer as terminal_count,
      count(distinct terminal.event_type)::integer as terminal_type_count,
      (array_agg(terminal.event_id order by terminal.event_id asc))[1]
        as event_id
    from public.naver_shopping_account_priority_members as member
    join public.naver_shopping_account_priority_requests as request
      on request.request_id = member.request_id
    join public.naver_shopping_worker_runs as run
      on run.run_id = member.claimed_run_id
     and run.worker_id = member.claimed_worker_id
     and run.run_trigger = 'rank-catch-up'
     and run.runtime_version = request.required_runtime_version
     and run.runtime_fingerprint = request.required_runtime_fingerprint
     and run.started_at >= member.claimed_at
    join public.naver_shopping_scheduler_events as terminal
      on terminal.claim_id = member.claim_id
     and terminal.tracker_id = member.tracker_id
     and terminal.cycle_id = member.claimed_cycle_id
     and terminal.run_id = member.claimed_run_id
     and terminal.worker_id = member.claimed_worker_id
     and terminal.lease_started_at = member.claimed_lease_started_at
     and terminal.event_id > member.claim_event_id
     and terminal.occurred_at >= member.claimed_at
     and terminal.occurred_at <= member.claimed_lease_until
     and terminal.occurred_at <= p_now
     and run.started_at <= terminal.occurred_at
     and terminal.event_type in (
       'tracker_committed', 'finite_window_committed', 'job_failed'
     )
    where member.state = 'claimed'
    group by member.request_id, member.tracker_id
  ), first_terminal as (
    select
      summary.request_id,
      summary.tracker_id,
      summary.terminal_count,
      summary.terminal_type_count,
      terminal.event_id,
      terminal.occurred_at,
      terminal.event_type,
      terminal.error_code
    from terminal_summary as summary
    join public.naver_shopping_scheduler_events as terminal
      on terminal.event_id = summary.event_id
  )
  update public.naver_shopping_account_priority_members as member
  set state = case
        when terminal.terminal_count <> 1
          or terminal.terminal_type_count <> 1 then 'integrity_failure'
        when terminal.event_type in (
          'tracker_committed', 'finite_window_committed'
        ) then 'terminal_success'
        else 'terminal_failure'
      end,
      terminal_at = terminal.occurred_at,
      terminal_event_id = terminal.event_id,
      terminal_event_type = terminal.event_type,
      terminal_code = case
        when terminal.terminal_count <> 1
          or terminal.terminal_type_count <> 1
          then 'account_priority_terminal_conflict'
        when terminal.event_type = 'job_failed'
          then coalesce(terminal.error_code, 'local_worker_collection_failed')
        else null
      end
  from first_terminal as terminal
  where member.request_id = terminal.request_id
    and member.tracker_id = terminal.tracker_id
    and member.state = 'claimed';

  -- An exact terminal that cannot prove the canonical
  -- claim -> navigating run -> terminal order is never allowed to rescue an
  -- expired claim.  Wait until the immutable lease boundary, then close it as
  -- an integrity failure so a missing/wrong run cannot keep the request active
  -- forever and a post-lease terminal cannot be accepted as success.
  with exact_terminal_summary as (
    select
      member.request_id,
      member.tracker_id,
      member.claimed_lease_until,
      (array_agg(terminal.event_id order by terminal.event_id asc))[1]
        as event_id
    from public.naver_shopping_account_priority_members as member
    join public.naver_shopping_scheduler_events as terminal
      on terminal.claim_id = member.claim_id
     and terminal.tracker_id = member.tracker_id
     and terminal.cycle_id = member.claimed_cycle_id
     and terminal.run_id = member.claimed_run_id
     and terminal.worker_id = member.claimed_worker_id
     and terminal.lease_started_at = member.claimed_lease_started_at
     and terminal.event_id > member.claim_event_id
     and terminal.occurred_at >= member.claimed_at
     and terminal.occurred_at <= p_now
     and terminal.event_type in (
       'tracker_committed', 'finite_window_committed', 'job_failed'
     )
    where member.state = 'claimed'
      and member.claimed_lease_until <= p_now
    group by member.request_id, member.tracker_id,
      member.claimed_lease_until
  ), first_invalid_terminal as (
    select
      summary.request_id,
      summary.tracker_id,
      summary.claimed_lease_until,
      terminal.event_id,
      terminal.occurred_at,
      terminal.event_type
    from exact_terminal_summary as summary
    join public.naver_shopping_scheduler_events as terminal
      on terminal.event_id = summary.event_id
  )
  update public.naver_shopping_account_priority_members as member
  set state = 'integrity_failure',
      terminal_at = terminal.occurred_at,
      terminal_event_id = terminal.event_id,
      terminal_event_type = terminal.event_type,
      terminal_code = case
        when terminal.occurred_at > terminal.claimed_lease_until
          then 'account_priority_terminal_after_lease'
        else 'account_priority_run_provenance_invalid'
      end
  from first_invalid_terminal as terminal
  where member.request_id = terminal.request_id
    and member.tracker_id = terminal.tracker_id
    and member.state = 'claimed';

  update public.naver_shopping_account_priority_members as member
  set state = 'terminal_missing',
      terminal_at = p_now,
      terminal_code = 'account_priority_terminal_missing'
  where member.state = 'claimed'
    and member.claimed_lease_until <= p_now
    and not exists (
      select 1
      from public.naver_shopping_scheduler_events as terminal
      where terminal.claim_id = member.claim_id
        and terminal.tracker_id = member.tracker_id
        and terminal.cycle_id = member.claimed_cycle_id
        and terminal.run_id = member.claimed_run_id
        and terminal.worker_id = member.claimed_worker_id
        and terminal.lease_started_at = member.claimed_lease_started_at
        and terminal.event_id > member.claim_event_id
        and terminal.occurred_at >= member.claimed_at
        and terminal.occurred_at <= p_now
        and terminal.event_type in (
          'tracker_committed', 'finite_window_committed', 'job_failed'
        )
    );

  -- (F5) A frozen cohort member that no longer has a claimable tracker must
  -- never hold the dedicated global lane until the immutable 24h expiry.
  -- Release exactly the members whose tracker row disappeared, left `active`,
  -- or moved to another account.  Nothing else is touched: the tracker rows,
  -- the cursor, the quarantine and every claimed member stay unchanged.
  update public.naver_shopping_account_priority_members as member
  set state = 'expired',
      release_reason = candidate.release_reason
  from (
    select
      pending.request_id,
      pending.tracker_id,
      case
        when tracker.id is null then 'account_priority_tracker_missing'
        when tracker.status is distinct from 'active'
          then 'account_priority_tracker_inactive'
        else 'account_priority_tracker_agency_changed'
      end as release_reason
    from public.naver_shopping_account_priority_members as pending
    join public.naver_shopping_account_priority_requests as request
      on request.request_id = pending.request_id
    left join public.naver_rank_trackers as tracker
      on tracker.id = pending.tracker_id
    where request.state = 'active'
      and pending.state = 'pending'
      and (
        tracker.id is null
        or tracker.status is distinct from 'active'
        or pg_catalog.lower(pg_catalog.btrim(tracker.agency_code))
          is distinct from request.agency_code
      )
  ) as candidate
  where member.request_id = candidate.request_id
    and member.tracker_id = candidate.tracker_id
    and member.state = 'pending';

  -- (F5) A member that is still absent from the roster of a cycle opened after
  -- the requested one can never be claimed by this request: the account claim
  -- selector requires a `cycle_rostered` row that is not `new_after_start`, and
  -- while the request is active no other transport opens a further cycle.
  -- Release it instead of waiting for the expiry.
  update public.naver_shopping_account_priority_members as member
  set state = 'expired',
      release_reason = 'account_priority_tracker_unrostered'
  from public.naver_shopping_account_priority_requests as request,
    public.naver_shopping_worker_coordination as coordination
  where member.request_id = request.request_id
    and coordination.lane_key = 'global'
    and request.state = 'active'
    and member.state = 'pending'
    and coordination.scheduler_cycle_status = 'active'
    and coordination.scheduler_cycle_id is not null
    and request.requested_cycle_id is distinct from coordination.scheduler_cycle_id
    and not exists (
      select 1
      from public.naver_shopping_scheduler_events as roster
      where roster.event_type = 'cycle_rostered'
        and roster.cycle_id = coordination.scheduler_cycle_id
        and roster.tracker_id = member.tracker_id
        and roster.roster_state is distinct from 'new_after_start'
    );

  -- (F5) Final bound.  The one-shot request owns the whole global lane, so it
  -- may hold it only while it is making progress.  A request that already
  -- reached its own expiry is closed by the step below instead, so the two
  -- rules never overlap.  Six baseline cadences
  -- without a single claim, terminal or release close the remainder; the 24h
  -- expiry stays the immutable outer bound, never the observed one.  A live
  -- claimed member is progress and is never cut off here.
  update public.naver_shopping_account_priority_members as member
  set state = 'expired',
      release_reason = 'account_priority_request_stalled'
  from (
    select request.request_id
    from public.naver_shopping_account_priority_requests as request
    cross join lateral (
      select
        max(progress_member.claimed_at) as last_claimed_at,
        max(progress_member.terminal_at) as last_terminal_at,
        count(*) filter (
          where progress_member.state = 'claimed'
        )::integer as claimed_count
      from public.naver_shopping_account_priority_members as progress_member
      where progress_member.request_id = request.request_id
    ) as progress
    where request.state = 'active'
      and request.expires_at > p_now
      and progress.claimed_count = 0
      and greatest(
        request.requested_at,
        progress.last_claimed_at,
        progress.last_terminal_at
      ) + interval '60 minutes' <= p_now
  ) as stalled
  where member.request_id = stalled.request_id
    and member.state = 'pending';

  update public.naver_shopping_account_priority_members as member
  set state = 'expired'
  from public.naver_shopping_account_priority_requests as request
  where member.request_id = request.request_id
    and request.state = 'active'
    and request.expires_at <= p_now
    and member.state = 'pending';

  update public.naver_shopping_account_priority_requests as request
  set state = 'completed',
      completed_at = p_now,
      expired_at = case
        when request.expires_at <= p_now then p_now
        else null
      end,
      succeeded = (
        select count(*) filter (
          where member.state = 'terminal_success'
        ) = request.cohort_count
        from public.naver_shopping_account_priority_members as member
        where member.request_id = request.request_id
      )
  where request.state = 'active'
    and not exists (
      select 1
      from public.naver_shopping_account_priority_members as member
      where member.request_id = request.request_id
        and member.state in ('pending', 'claimed')
    );
end;
$$;


-- Handoff v2.  Identical to the installed wrapper except that (F5) a pending
-- member with no `cycle_rostered` row for the current cycle is counted as a
-- rollover beneficiary instead of a blocker -- it cannot be claimed in this
-- cycle and the next cycle rosters it -- and that (F6) the abandoned cursor is
-- preserved before the cycle is completed.
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
  v_unrostered_pending_count integer := 0;
  v_current_eligible_count integer := 0;
  v_safe_blocked_partition_count integer := 0;
  v_rollover_beneficiary_count integer := 0;
  v_claimed_count integer := 0;
  v_processing_count integer := 0;
  v_open_claim_count integer := 0;
  v_cycle_completed_event_count integer := 0;
  v_updated_count integer := 0;
  v_resume_point_count integer := 0;
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
    )::integer,
    count(*) filter (
      where tracker.id is not null
        and tracker.status = 'active'
        and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) =
          active_request.agency_code
        and (tracker.processing_until is null
          or tracker.processing_until <= v_now)
        and not exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
        )
    )::integer
  into v_pending_count, v_active_pending_count, v_rostered_pending_count,
    v_current_eligible_count, v_safe_blocked_partition_count,
    v_rollover_beneficiary_count, v_unrostered_pending_count
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
    and v_rostered_pending_count + v_unrostered_pending_count = v_pending_count
    and v_current_eligible_count = 0
    and v_safe_blocked_partition_count + v_unrostered_pending_count
      = v_pending_count
    and v_rollover_beneficiary_count + v_unrostered_pending_count > 0
    and v_claimed_count = 0
    and v_processing_count = 0
    and v_open_claim_count = 0 then
    -- (F6) Preserve the abandoned cursor before completing the cycle.  The
    -- next natural cycle restores it and continues from the same position, so
    -- the later sort_order cohort of every other account is not skipped.
    insert into public.naver_shopping_account_priority_cycle_resume_points(
      handoff_cycle_id,
      handoff_cycle_number,
      request_id,
      cursor_sort_order,
      cursor_created_at,
      cursor_tracker_id,
      resume_cursor,
      created_at
    ) values (
      current_row.scheduler_cycle_id,
      current_row.scheduler_cycle_number,
      active_request.request_id,
      current_row.scheduler_cycle_cursor_sort_order,
      current_row.scheduler_cycle_cursor_created_at,
      current_row.scheduler_cycle_cursor_tracker_id,
      current_row.scheduler_cycle_resume_cursor,
      v_now
    )
    on conflict (handoff_cycle_id) do nothing;

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

    select count(*)::integer into v_resume_point_count
    from public.naver_shopping_account_priority_cycle_resume_points as point
    where point.handoff_cycle_id = current_row.scheduler_cycle_id
      and point.handoff_cycle_number = current_row.scheduler_cycle_number
      and point.request_id = active_request.request_id
      and point.cursor_sort_order is not distinct from
        current_row.scheduler_cycle_cursor_sort_order
      and point.cursor_created_at is not distinct from
        current_row.scheduler_cycle_cursor_created_at
      and point.cursor_tracker_id is not distinct from
        current_row.scheduler_cycle_cursor_tracker_id
      and point.resume_cursor is not distinct from
        current_row.scheduler_cycle_resume_cursor;

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
      or v_cycle_completed_event_count <> 1
      or v_resume_point_count <> 1 then
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

-- (F6) Give the preserved cursor back to the cycle that immediately follows the
-- handed-off one.  Only a brand-new, untouched cursor is replaced, the decision
-- is taken under the already-held coordination row lock, and every open resume
-- point is resolved exactly once so a stale one can never jump a later cycle.
create or replace function
  mi_internal.mi_restore_naver_shopping_account_priority_cycle_cursor()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  resume_point
    public.naver_shopping_account_priority_cycle_resume_points%rowtype;
  v_now timestamptz := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  v_can_restore boolean := false;
  v_updated_count integer := 0;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found
    or current_row.scheduler_cycle_status is distinct from 'active'
    or current_row.scheduler_cycle_id is null then
    return 0;
  end if;

  select * into resume_point
  from public.naver_shopping_account_priority_cycle_resume_points as point
  where point.resolved_at is null
  order by point.handoff_cycle_number desc, point.handoff_cycle_id desc
  limit 1
  for update;

  if not found then
    return 0;
  end if;

  v_can_restore :=
    resume_point.handoff_cycle_id is distinct from current_row.scheduler_cycle_id
    and resume_point.handoff_cycle_number + 1 = current_row.scheduler_cycle_number
    and resume_point.cursor_tracker_id is not null
    and current_row.scheduler_cycle_cursor_sort_order is null
    and current_row.scheduler_cycle_cursor_created_at is null
    and current_row.scheduler_cycle_cursor_tracker_id is null
    and current_row.scheduler_cycle_resume_cursor is false;

  if v_can_restore then
    update public.naver_shopping_worker_coordination as coordination
    set scheduler_cycle_cursor_sort_order = resume_point.cursor_sort_order,
        scheduler_cycle_cursor_created_at = resume_point.cursor_created_at,
        scheduler_cycle_cursor_tracker_id = resume_point.cursor_tracker_id,
        scheduler_cycle_resume_cursor = resume_point.resume_cursor,
        updated_at = v_now
    where coordination.lane_key = 'global'
      and coordination.scheduler_cycle_id = current_row.scheduler_cycle_id
      and coordination.scheduler_cycle_number = current_row.scheduler_cycle_number
      and coordination.scheduler_cycle_status = 'active'
      and coordination.scheduler_cycle_cursor_sort_order is null
      and coordination.scheduler_cycle_cursor_created_at is null
      and coordination.scheduler_cycle_cursor_tracker_id is null
      and coordination.scheduler_cycle_resume_cursor is false;
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 1 then
      raise exception
        'naver_shopping_account_priority_cycle_resume_conflict';
    end if;
  end if;

  update public.naver_shopping_account_priority_cycle_resume_points as point
  set resolved_at = v_now,
      resolution = case
        when v_can_restore
          and point.handoff_cycle_id = resume_point.handoff_cycle_id
          then 'restored'
        else 'skipped'
      end,
      restored_cycle_id = case
        when v_can_restore
          and point.handoff_cycle_id = resume_point.handoff_cycle_id
          then current_row.scheduler_cycle_id
        else null
      end,
      restored_cycle_number = case
        when v_can_restore
          and point.handoff_cycle_id = resume_point.handoff_cycle_id
          then current_row.scheduler_cycle_number
        else null
      end
  where point.resolved_at is null;

  return case when v_can_restore then 1 else 0 end;
end;
$$;


-- Queue wrappers: the trigger gate decision is unchanged; only the
-- post-delegation cursor restore is new.
create or replace function public.mi_queue_naver_shopping_cycle(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_run_trigger text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  gate_result jsonb;
  queue_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      p_worker_id, p_lane_token, p_run_id, p_run_trigger, true
    );
  if coalesce((gate_result ->> 'transportBlocked')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting',
      'reason', 'account_priority_expiry_reconciled',
      'cycleId', null, 'cycleStartedAt', null,
      'started', false, 'total', 0, 'remaining', 0, 'processing', 0
    );
  end if;
  if coalesce((gate_result ->> 'active')::boolean, false)
    and not (
      coalesce((gate_result ->> 'rankCatchUp')::boolean, false)
      and coalesce((gate_result ->> 'accountPrimary')::boolean, false)
    ) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting', 'reason', 'account_priority_active',
      'cycleId', null, 'cycleStartedAt', null,
      'started', false, 'total', 0, 'remaining', 0, 'processing', 0
    );
  end if;
  queue_result :=
    mi_internal.mi_queue_naver_shopping_cycle_pre_account_trigger_gate();

  -- (F6) A cycle opened right after an account handoff continues from the
  -- preserved cursor instead of restarting at the first sort_order.
  if coalesce((queue_result ->> 'started')::boolean, false) then
    perform
      mi_internal.mi_restore_naver_shopping_account_priority_cycle_cursor();
  end if;

  return queue_result;
end;
$$;

create or replace function public.mi_queue_naver_shopping_cycle()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  gate_result jsonb;
  queue_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      null, null, null, null, false
    );
  if coalesce((gate_result ->> 'transportBlocked')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting',
      'reason', 'account_priority_expiry_reconciled',
      'cycleId', null, 'cycleStartedAt', null,
      'started', false, 'total', 0, 'remaining', 0, 'processing', 0
    );
  end if;
  if coalesce((gate_result ->> 'active')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting', 'reason', 'account_priority_active',
      'cycleId', null, 'cycleStartedAt', null,
      'started', false, 'total', 0, 'remaining', 0, 'processing', 0
    );
  end if;
  queue_result :=
    mi_internal.mi_queue_naver_shopping_cycle_pre_account_trigger_gate();

  -- (F6) A cycle opened right after an account handoff continues from the
  -- preserved cursor instead of restarting at the first sort_order.
  if coalesce((queue_result ->> 'started')::boolean, false) then
    perform
      mi_internal.mi_restore_naver_shopping_account_priority_cycle_cursor();
  end if;

  return queue_result;
end;
$$;

-- (F5-b) Immediate operator release.  service_role only.  The lock order is the
-- same coordination -> request order every other account transport uses, the
-- ledger stays append-only, and a live claimed member is never rewritten: its
-- own lease boundary closes it and the request completes right after.
create or replace function public.mi_cancel_naver_shopping_account_priority(
  p_request_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  target_request public.naver_shopping_account_priority_requests%rowtype;
  v_now timestamptz := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  v_released_count integer := 0;
  v_claimed_count integer := 0;
  v_claimed_lease_until timestamptz;
begin
  if p_request_id is null then
    raise exception 'naver_shopping_account_priority_cancel_invalid';
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found then
    raise exception 'naver_shopping_account_priority_coordination_missing';
  end if;

  select * into target_request
  from public.naver_shopping_account_priority_requests as request
  where request.request_id = p_request_id
  for update;

  if not found then
    raise exception 'naver_shopping_account_priority_cancel_unknown_request';
  end if;

  if target_request.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'cancelled', false,
      'requestId', p_request_id,
      'state', target_request.state,
      'releasedCount', 0,
      'claimedCount', 0,
      'claimedLeaseUntil', null,
      'laneReleased', true,
      'reason', 'already_completed'
    );
  end if;

  perform mi_internal.mi_reconcile_naver_shopping_account_priority(v_now);

  select * into target_request
  from public.naver_shopping_account_priority_requests as request
  where request.request_id = p_request_id
  for update;

  if target_request.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'cancelled', false,
      'requestId', p_request_id,
      'state', target_request.state,
      'releasedCount', 0,
      'claimedCount', 0,
      'claimedLeaseUntil', null,
      'laneReleased', true,
      'reason', 'already_completed'
    );
  end if;

  update public.naver_shopping_account_priority_members as member
  set state = 'expired',
      release_reason = 'account_priority_cancelled'
  where member.request_id = p_request_id
    and member.state = 'pending';
  get diagnostics v_released_count = row_count;

  select count(*)::integer, max(member.claimed_lease_until)
  into v_claimed_count, v_claimed_lease_until
  from public.naver_shopping_account_priority_members as member
  where member.request_id = p_request_id
    and member.state = 'claimed';

  perform mi_internal.mi_reconcile_naver_shopping_account_priority(v_now);

  select * into target_request
  from public.naver_shopping_account_priority_requests as request
  where request.request_id = p_request_id;

  return pg_catalog.jsonb_build_object(
    'cancelled', true,
    'requestId', p_request_id,
    'state', target_request.state,
    'releasedCount', v_released_count,
    'claimedCount', v_claimed_count,
    'claimedLeaseUntil', v_claimed_lease_until,
    'laneReleased', target_request.state = 'completed',
    'reason', case
      when target_request.state = 'completed' then 'cancelled'
      else 'cancelled_waiting_live_claim'
    end
  );
end;
$$;


revoke all on function
  mi_internal.mi_restore_naver_shopping_account_priority_cycle_cursor()
from public, anon, authenticated, service_role;
grant execute on function
  mi_internal.mi_restore_naver_shopping_account_priority_cycle_cursor()
to service_role;

revoke all on function public.mi_cancel_naver_shopping_account_priority(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.mi_cancel_naver_shopping_account_priority(uuid)
to service_role;

revoke all on function mi_internal.mi_reconcile_naver_shopping_account_priority(
  timestamptz
) from public, anon, authenticated, service_role;
grant execute on function mi_internal.mi_reconcile_naver_shopping_account_priority(
  timestamptz
) to service_role;

revoke all on function mi_internal.mi_claim_naver_shopping_account_priority(
  text, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function mi_internal.mi_claim_naver_shopping_account_priority(
  text, uuid, uuid, integer
) to service_role;

revoke all on function public.mi_queue_naver_shopping_cycle(
  text, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_queue_naver_shopping_cycle(
  text, uuid, uuid, text
) to service_role;

revoke all on function public.mi_queue_naver_shopping_cycle()
from public, anon, authenticated, service_role;
grant execute on function public.mi_queue_naver_shopping_cycle()
to service_role;

commit;

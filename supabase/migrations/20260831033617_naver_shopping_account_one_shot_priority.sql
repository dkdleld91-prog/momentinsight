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
     from public.naver_shopping_rank_lookup_jobs as job
     where job.status = 'processing'
       and job.processing_until > pg_catalog.clock_timestamp())
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
    raise exception 'naver_shopping_account_priority_requires_idle_1_1_19';
  end if;
end
$migration_guard$;

-- This queue is intentionally unrelated to the legacy operator repair queue.
-- The parent row freezes an exact agency cohort and the member rows persist
-- only opaque operational identifiers and event linkage.  No raw keyword,
-- title, product, capture, lane token or browser payload is stored here.
create table public.naver_shopping_account_priority_requests (
  request_id uuid primary key,
  agency_code text not null
    check (agency_code ~ '^[a-z0-9][a-z0-9:_-]{2,79}$'),
  cohort_count integer not null check (cohort_count between 1 and 1000),
  cohort_hash text not null check (cohort_hash ~ '^[a-f0-9]{32}$'),
  required_runtime_version text not null
    check (required_runtime_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  required_runtime_fingerprint text not null
    check (required_runtime_fingerprint ~ '^[a-f0-9]{64}$'
      and required_runtime_fingerprint <> pg_catalog.repeat('0', 64)),
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  requested_cycle_id uuid,
  requested_cycle_number bigint,
  state text not null default 'active'
    check (state in ('active', 'completed')),
  completed_at timestamptz,
  expired_at timestamptz,
  succeeded boolean,
  check (expires_at = requested_at + interval '24 hours'),
  check (
    (state = 'active'
      and completed_at is null
      and succeeded is null)
    or
    (state = 'completed'
      and completed_at is not null
      and succeeded is not null)
  ),
  unique (agency_code, cohort_hash)
);

create table public.naver_shopping_account_priority_members (
  request_id uuid not null
    references public.naver_shopping_account_priority_requests(request_id),
  position integer not null check (position between 1 and 1000),
  tracker_id uuid not null,
  state text not null default 'pending'
    check (state in (
      'pending',
      'claimed',
      'terminal_success',
      'terminal_failure',
      'integrity_failure',
      'terminal_missing',
      'expired'
    )),
  claimed_at timestamptz,
  claimed_cycle_id uuid,
  claimed_cycle_number bigint,
  claimed_run_id uuid,
  claimed_worker_id text check (
    claimed_worker_id is null
    or claimed_worker_id ~ '^[a-z0-9][a-z0-9:_-]{2,63}$'
  ),
  claimed_lease_started_at timestamptz,
  claimed_lease_until timestamptz,
  claim_event_id bigint,
  claim_id uuid,
  terminal_at timestamptz,
  terminal_event_id bigint,
  terminal_event_type text check (
    terminal_event_type is null
    or terminal_event_type in (
      'tracker_committed', 'finite_window_committed', 'job_failed'
    )
  ),
  terminal_code text check (
    terminal_code is null or terminal_code ~ '^[a-z0-9_:-]{3,80}$'
  ),
  cursor_sort_order_before integer,
  cursor_created_at_before timestamptz,
  cursor_tracker_id_before uuid,
  cursor_resume_before boolean,
  cursor_sort_order_after integer,
  cursor_created_at_after timestamptz,
  cursor_tracker_id_after uuid,
  cursor_resume_after boolean,
  primary key (request_id, tracker_id),
  unique (request_id, position),
  check (
    (state in ('pending', 'expired')
      and claimed_at is null
      and claimed_cycle_id is null
      and claimed_cycle_number is null
      and claimed_run_id is null
      and claimed_worker_id is null
      and claimed_lease_started_at is null
      and claimed_lease_until is null
      and claim_event_id is null
      and claim_id is null)
    or
    (state in (
      'claimed', 'terminal_success', 'terminal_failure', 'integrity_failure',
      'terminal_missing'
    )
      and claimed_at is not null
      and claimed_cycle_id is not null
      and claimed_cycle_number is not null
      and claimed_run_id is not null
      and claimed_worker_id is not null
      and claimed_lease_started_at is not null
      and claimed_lease_until is not null
      and claim_event_id is not null
      and claim_id is not null)
  ),
  check (
    (state in ('pending', 'claimed', 'expired')
      and terminal_at is null
      and terminal_event_id is null
      and terminal_event_type is null
      and terminal_code is null)
    or
    (state = 'terminal_success'
      and terminal_at is not null
      and terminal_event_id is not null
      and terminal_event_type in (
        'tracker_committed', 'finite_window_committed'
      )
      and terminal_code is null)
    or
    (state = 'terminal_failure'
      and terminal_at is not null
      and terminal_event_id is not null
      and terminal_event_type = 'job_failed'
      and terminal_code is not null)
    or
    (state = 'integrity_failure'
      and terminal_at is not null
      and terminal_event_id is not null
      and terminal_event_type in (
        'tracker_committed', 'finite_window_committed', 'job_failed'
      )
      and terminal_code in (
        'account_priority_terminal_conflict',
        'account_priority_run_provenance_invalid',
        'account_priority_terminal_after_lease'
      ))
    or
    (state = 'terminal_missing'
      and terminal_at is not null
      and terminal_event_id is null
      and terminal_event_type is null
      and terminal_code = 'account_priority_terminal_missing')
  ),
  check (
    cursor_sort_order_before is not distinct from cursor_sort_order_after
    and cursor_created_at_before is not distinct from cursor_created_at_after
    and cursor_tracker_id_before is not distinct from cursor_tracker_id_after
    and cursor_resume_before is not distinct from cursor_resume_after
  )
);

create unique index idx_naver_shopping_account_priority_one_active
on public.naver_shopping_account_priority_requests(state)
where state = 'active';

create index idx_naver_shopping_account_priority_pending
on public.naver_shopping_account_priority_members(request_id, state, position);

create unique index idx_naver_shopping_account_priority_claim_event_once
on public.naver_shopping_account_priority_members(claim_event_id)
where claim_event_id is not null;

create unique index idx_naver_shopping_account_priority_terminal_event_once
on public.naver_shopping_account_priority_members(terminal_event_id)
where terminal_event_id is not null;

alter table public.naver_shopping_account_priority_requests enable row level security;
alter table public.naver_shopping_account_priority_requests force row level security;
alter table public.naver_shopping_account_priority_members enable row level security;
alter table public.naver_shopping_account_priority_members force row level security;

revoke all on table public.naver_shopping_account_priority_requests
from public, anon, authenticated, service_role;
revoke all on table public.naver_shopping_account_priority_members
from public, anon, authenticated, service_role;
grant select, insert, update on table public.naver_shopping_account_priority_requests
to service_role;
grant select, insert, update on table public.naver_shopping_account_priority_members
to service_role;

create or replace function mi_internal.mi_guard_naver_shopping_account_priority_request()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'naver_shopping_account_priority_request_immutable';
  end if;
  if old.request_id is distinct from new.request_id
    or old.agency_code is distinct from new.agency_code
    or old.cohort_count is distinct from new.cohort_count
    or old.cohort_hash is distinct from new.cohort_hash
    or old.required_runtime_version is distinct from new.required_runtime_version
    or old.required_runtime_fingerprint is distinct from new.required_runtime_fingerprint
    or old.requested_at is distinct from new.requested_at
    or old.expires_at is distinct from new.expires_at
    or old.requested_cycle_id is distinct from new.requested_cycle_id
    or old.requested_cycle_number is distinct from new.requested_cycle_number
    or old.state <> 'active'
    or new.state <> 'completed'
    or old.completed_at is not null
    or new.completed_at is null
    or old.expired_at is not null
    or (new.expired_at is not null and new.expired_at < old.expires_at)
    or old.succeeded is not null
    or new.succeeded is null then
    raise exception 'naver_shopping_account_priority_request_immutable';
  end if;
  return new;
end;
$$;

create trigger trg_mi_guard_naver_shopping_account_priority_request
before update or delete on public.naver_shopping_account_priority_requests
for each row execute function mi_internal.mi_guard_naver_shopping_account_priority_request();

create or replace function mi_internal.mi_guard_naver_shopping_account_priority_member()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'naver_shopping_account_priority_member_immutable';
  end if;
  if old.request_id is distinct from new.request_id
    or old.position is distinct from new.position
    or old.tracker_id is distinct from new.tracker_id then
    raise exception 'naver_shopping_account_priority_member_immutable';
  end if;

  if old.state = 'pending' and new.state = 'claimed' then
    if new.claimed_at is null
      or new.claimed_cycle_id is null
      or new.claimed_cycle_number is null
      or new.claimed_run_id is null
      or new.claimed_worker_id is null
      or new.claimed_lease_started_at is null
      or new.claimed_lease_until is null
      or new.claim_event_id is null
      or new.claim_id is null
      or new.terminal_at is not null
      or new.terminal_event_id is not null
      or new.terminal_event_type is not null
      or new.terminal_code is not null then
      raise exception 'naver_shopping_account_priority_member_claim_invalid';
    end if;
    return new;
  end if;

  if old.state = 'pending' and new.state = 'expired' then
    if new.claimed_at is not null
      or new.claimed_cycle_id is not null
      or new.claimed_cycle_number is not null
      or new.claimed_run_id is not null
      or new.claimed_worker_id is not null
      or new.claimed_lease_started_at is not null
      or new.claimed_lease_until is not null
      or new.claim_event_id is not null
      or new.claim_id is not null
      or new.terminal_at is not null
      or new.terminal_event_id is not null
      or new.terminal_event_type is not null
      or new.terminal_code is not null
      or new.cursor_sort_order_before is not null
      or new.cursor_created_at_before is not null
      or new.cursor_tracker_id_before is not null
      or new.cursor_resume_before is not null
      or new.cursor_sort_order_after is not null
      or new.cursor_created_at_after is not null
      or new.cursor_tracker_id_after is not null
      or new.cursor_resume_after is not null then
      raise exception 'naver_shopping_account_priority_member_expiry_invalid';
    end if;
    return new;
  end if;

  if old.state = 'claimed'
    and new.state in (
      'terminal_success', 'terminal_failure', 'integrity_failure',
      'terminal_missing'
    ) then
    if old.claimed_at is distinct from new.claimed_at
      or old.claimed_cycle_id is distinct from new.claimed_cycle_id
      or old.claimed_cycle_number is distinct from new.claimed_cycle_number
      or old.claimed_run_id is distinct from new.claimed_run_id
      or old.claimed_worker_id is distinct from new.claimed_worker_id
      or old.claimed_lease_started_at is distinct from new.claimed_lease_started_at
      or old.claimed_lease_until is distinct from new.claimed_lease_until
      or old.claim_event_id is distinct from new.claim_event_id
      or old.claim_id is distinct from new.claim_id
      or old.cursor_sort_order_before is distinct from new.cursor_sort_order_before
      or old.cursor_created_at_before is distinct from new.cursor_created_at_before
      or old.cursor_tracker_id_before is distinct from new.cursor_tracker_id_before
      or old.cursor_resume_before is distinct from new.cursor_resume_before
      or old.cursor_sort_order_after is distinct from new.cursor_sort_order_after
      or old.cursor_created_at_after is distinct from new.cursor_created_at_after
      or old.cursor_tracker_id_after is distinct from new.cursor_tracker_id_after
      or old.cursor_resume_after is distinct from new.cursor_resume_after then
      raise exception 'naver_shopping_account_priority_member_terminal_invalid';
    end if;
    return new;
  end if;

  raise exception 'naver_shopping_account_priority_member_transition_invalid';
end;
$$;

create trigger trg_mi_guard_naver_shopping_account_priority_member
before update or delete on public.naver_shopping_account_priority_members
for each row execute function mi_internal.mi_guard_naver_shopping_account_priority_member();

-- Even an internal-schema direct call to the pre-existing legacy functions is
-- rolled back at the evidence table boundary while an account request is
-- active.  Existing legacy rows remain unchanged.
create or replace function mi_internal.mi_block_legacy_repair_during_account_priority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.naver_shopping_account_priority_requests as request
    where request.state = 'active'
  ) then
    raise exception 'naver_shopping_legacy_repair_blocked_by_account_priority';
  end if;
  return new;
end;
$$;

create trigger trg_mi_block_legacy_repair_request_during_account_priority
before insert or update on public.naver_shopping_repair_priority_requests
for each row execute function mi_internal.mi_block_legacy_repair_during_account_priority();

create trigger trg_mi_block_legacy_repair_item_during_account_priority
before insert or update on public.naver_shopping_repair_priority_items
for each row execute function mi_internal.mi_block_legacy_repair_during_account_priority();

-- Reconcile only immutable first-terminal evidence for the exact claim linked
-- by the account claim transaction.  An expired lease without a terminal is a
-- finite integrity failure, never a retry request.
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

-- Seed the oldest eligible frozen member, then claim its same-request,
-- same-agency normalized-keyword group (bounded to 100 members).  The handler
-- distinguishes this dedicated account transport from one-member legacy repair.
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
  if pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, ''))) <>
      'windows-desktop-primary'
    or p_lane_token is null
    or p_run_id is null
    or p_lease_seconds < 60
    or p_lease_seconds > 2100 then
    raise exception 'naver_shopping_account_priority_claim_invalid';
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

create or replace function public.mi_enqueue_naver_shopping_account_priority(
  p_request_id uuid,
  p_agency_code text,
  p_expected_cohort_count integer,
  p_expected_cohort_hash text,
  p_expected_runtime_version text,
  p_expected_runtime_fingerprint text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  existing_request public.naver_shopping_account_priority_requests%rowtype;
  v_now timestamptz := date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_agency_code text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_agency_code, '')));
  v_expected_cohort_hash text := pg_catalog.lower(pg_catalog.btrim(
    coalesce(p_expected_cohort_hash, '')
  ));
  v_expected_runtime_version text := pg_catalog.btrim(
    coalesce(p_expected_runtime_version, '')
  );
  v_expected_runtime_fingerprint text := pg_catalog.lower(pg_catalog.btrim(
    coalesce(p_expected_runtime_fingerprint, '')
  ));
  v_cohort_count integer := 0;
  v_cohort_hash text;
begin
  if p_request_id is null
    or v_agency_code !~ '^[a-z0-9][a-z0-9:_-]{2,79}$'
    or p_expected_cohort_count is null
    or p_expected_cohort_count < 1
    or p_expected_cohort_count > 1000
    or v_expected_cohort_hash !~ '^[a-f0-9]{32}$'
    or v_expected_runtime_version <> '1.1.19'
    or v_expected_runtime_fingerprint <>
      '631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e' then
    raise exception 'naver_shopping_account_priority_invalid';
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found
    or current_row.runtime_version is distinct from v_expected_runtime_version
    or current_row.runtime_fingerprint is distinct from
      v_expected_runtime_fingerprint
    or current_row.cadence_mode is distinct from 'baseline'
    or current_row.cadence_minutes is distinct from 10
    or current_row.scheduler_cycle_status is distinct from 'active'
    or current_row.scheduler_cycle_id is null
    or current_row.primary_worker_id is distinct from 'windows-desktop-primary'
    or current_row.primary_seen_at is null
    or current_row.primary_seen_at < v_now - interval '180 seconds'
    or current_row.circuit_state is distinct from 'closed'
    or current_row.circuit_reason is not null
    or current_row.cooldown_until is not null
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
    or current_row.probe_started_at is not null
    or exists (
      select 1 from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.processing_until > v_now
    )
    or exists (
      select 1 from public.naver_shopping_rank_lookup_jobs as job
      where job.status = 'processing'
        and job.processing_until > v_now
    ) then
    raise exception 'naver_shopping_account_priority_requires_idle_control';
  end if;

  perform mi_internal.mi_reconcile_naver_shopping_account_priority(v_now);

  select * into existing_request
  from public.naver_shopping_account_priority_requests as request
  where request.request_id = p_request_id;
  if existing_request.request_id is not null then
    if existing_request.agency_code is distinct from v_agency_code
      or existing_request.cohort_count is distinct from p_expected_cohort_count
      or existing_request.cohort_hash is distinct from v_expected_cohort_hash
      or existing_request.required_runtime_version is distinct from
        v_expected_runtime_version
      or existing_request.required_runtime_fingerprint is distinct from
        v_expected_runtime_fingerprint then
      raise exception 'naver_shopping_account_priority_request_conflict';
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', true,
      'idempotent', true,
      'requestId', existing_request.request_id,
      'state', existing_request.state,
      'cohortCount', existing_request.cohort_count,
      'cohortHash', existing_request.cohort_hash,
      'expiresAt', existing_request.expires_at,
      'wakeRequested', false
    );
  end if;

  if exists (
    select 1
    from public.naver_shopping_account_priority_requests as request
    where request.state = 'active'
  ) then
    raise exception 'naver_shopping_account_priority_active_conflict';
  end if;

  if exists (
    select 1
    from public.naver_shopping_repair_priority_items as item
    join public.naver_rank_trackers as tracker on tracker.id = item.tracker_id
    where item.state = 'queued'
       or (
         item.state = 'consumed'
         and item.claimed_lease_started_at is not null
         and tracker.processing_started_at = item.claimed_lease_started_at
         and tracker.processing_until > v_now
       )
  ) then
    raise exception 'naver_shopping_account_priority_legacy_conflict';
  end if;

  select count(*)::integer,
         pg_catalog.md5(
           v_agency_code || ':' ||
           pg_catalog.string_agg(
             pg_catalog.format(
               '%s|%s|%s',
               tracker.sort_order,
               extract(epoch from tracker.created_at),
               tracker.id
             ),
             ',' order by tracker.sort_order, tracker.created_at, tracker.id
           )
         )
  into v_cohort_count, v_cohort_hash
  from public.naver_rank_trackers as tracker
  where tracker.status = 'active'
    and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) = v_agency_code;

  if v_cohort_count < 1 or v_cohort_count > 1000 or v_cohort_hash is null then
    raise exception 'naver_shopping_account_priority_empty_or_oversized';
  end if;

  if v_cohort_count <> p_expected_cohort_count
    or v_cohort_hash is distinct from v_expected_cohort_hash then
    raise exception 'naver_shopping_account_priority_cohort_precondition_failed';
  end if;

  if exists (
    select 1
    from public.naver_shopping_account_priority_requests as request
    where request.agency_code = v_agency_code
      and request.cohort_hash = v_cohort_hash
  ) then
    raise exception 'naver_shopping_account_priority_cohort_already_requested';
  end if;

  insert into public.naver_shopping_account_priority_requests(
    request_id,
    agency_code,
    cohort_count,
    cohort_hash,
    required_runtime_version,
    required_runtime_fingerprint,
    requested_at,
    expires_at,
    requested_cycle_id,
    requested_cycle_number
  ) values (
    p_request_id,
    v_agency_code,
    v_cohort_count,
    v_cohort_hash,
    current_row.runtime_version,
    current_row.runtime_fingerprint,
    v_now,
    v_now + interval '24 hours',
    case when current_row.scheduler_cycle_status = 'active'
      then current_row.scheduler_cycle_id else null end,
    case when current_row.scheduler_cycle_status = 'active'
      then current_row.scheduler_cycle_number else null end
  );

  insert into public.naver_shopping_account_priority_members(
    request_id, position, tracker_id
  )
  select
    p_request_id,
    pg_catalog.row_number() over (
      order by tracker.sort_order, tracker.created_at, tracker.id
    )::integer,
    tracker.id
  from public.naver_rank_trackers as tracker
  where tracker.status = 'active'
    and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) = v_agency_code
  order by tracker.sort_order, tracker.created_at, tracker.id;

  if (select count(*) from public.naver_shopping_account_priority_members
      where request_id = p_request_id) <> v_cohort_count then
    raise exception 'naver_shopping_account_priority_cohort_insert_mismatch';
  end if;

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'idempotent', false,
    'requestId', p_request_id,
    'state', 'active',
    'cohortCount', v_cohort_count,
    'cohortHash', v_cohort_hash,
    'expiresAt', v_now + interval '24 hours',
    'wakeRequested', false
  );
end;
$$;

-- Exclude an active account member and the exact one-shot claimed cycle from
-- both bounded recovery paths.  This prevents an old-runtime terminal or an
-- expired account lease from being silently retried around the parent ledger.
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
    not exists (
      select 1
      from public.naver_shopping_account_priority_members as member
      join public.naver_shopping_account_priority_requests as request
        on request.request_id = member.request_id
      where member.tracker_id = p_tracker_id
        and (
          request.state = 'active'
          or member.claimed_cycle_id = p_cycle_id
        )
    )
    and p_tracker_id is not null
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
          select candidate.event_id, candidate.event_type, candidate.run_id
          from public.naver_shopping_scheduler_events as candidate
          where candidate.cycle_id = p_cycle_id
            and candidate.tracker_id = p_tracker_id
            and candidate.event_type in (
              'tracker_committed', 'finite_window_committed', 'job_failed'
            )
          order by candidate.event_id desc
          limit 1
        ) as event
        left join public.naver_shopping_worker_runs as run
          on run.run_id = event.run_id
      ) as terminal
    ), false);
$$;

create or replace function public.mi_naver_shopping_cycle_orphan_recovery_eligible(
  p_tracker_id uuid,
  p_cycle_id uuid
) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  with latest_claim as (
    select claimed.event_id, claimed.claim_id
    from public.naver_shopping_scheduler_events as claimed
    where claimed.cycle_id = p_cycle_id
      and claimed.tracker_id = p_tracker_id
      and claimed.event_type = 'tracker_claimed'
    order by claimed.event_id desc
    limit 1
  ), unmatched_claims as (
    select claimed.event_id
    from public.naver_shopping_scheduler_events as claimed
    where claimed.cycle_id = p_cycle_id
      and claimed.tracker_id = p_tracker_id
      and claimed.event_type = 'tracker_claimed'
      and claimed.claim_id is not null
      and not exists (
        select 1
        from public.naver_shopping_scheduler_events as terminal
        where terminal.claim_id = claimed.claim_id
          and terminal.tracker_id = claimed.tracker_id
          and terminal.event_type in (
            'tracker_committed', 'finite_window_committed', 'job_failed'
          )
      )
  )
  select
    not exists (
      select 1
      from public.naver_shopping_account_priority_members as member
      join public.naver_shopping_account_priority_requests as request
        on request.request_id = member.request_id
      where member.tracker_id = p_tracker_id
        and (
          request.state = 'active'
          or member.claimed_cycle_id = p_cycle_id
        )
    )
    and p_tracker_id is not null
    and p_cycle_id is not null
    and coalesce((
      select
        latest.claim_id is not null
        and (tracker.processing_until is null
          or tracker.processing_until <= pg_catalog.statement_timestamp())
        and not exists (
          select 1
          from public.naver_shopping_scheduler_events as terminal
          where terminal.claim_id = latest.claim_id
            and terminal.tracker_id = p_tracker_id
            and terminal.event_type in (
              'tracker_committed', 'finite_window_committed', 'job_failed'
            )
        )
        and (select count(*) from unmatched_claims) = 1
      from latest_claim as latest
      join public.naver_rank_trackers as tracker on tracker.id = p_tracker_id
    ), false);
$$;

-- Keep the legacy implementation available only as a non-exposed internal
-- fallback.  The public wrappers below block both legacy enqueue and legacy
-- claim while the one-shot account request is active.
alter function public.mi_enqueue_naver_shopping_repair_priority(uuid, uuid[], text)
  set schema mi_internal;
alter function mi_internal.mi_enqueue_naver_shopping_repair_priority(uuid, uuid[], text)
  rename to mi_enqueue_naver_shopping_repair_priority_legacy;

alter function public.mi_claim_naver_shopping_repair_priority(text, uuid, uuid, integer)
  set schema mi_internal;
alter function mi_internal.mi_claim_naver_shopping_repair_priority(text, uuid, uuid, integer)
  rename to mi_claim_naver_shopping_repair_priority_legacy;

revoke all on schema mi_internal from public, anon, authenticated;
grant usage on schema mi_internal to service_role;
revoke all on function mi_internal.mi_enqueue_naver_shopping_repair_priority_legacy(
  uuid, uuid[], text
) from public, anon, authenticated, service_role;
grant execute on function mi_internal.mi_enqueue_naver_shopping_repair_priority_legacy(
  uuid, uuid[], text
) to service_role;
revoke all on function mi_internal.mi_claim_naver_shopping_repair_priority_legacy(
  text, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function mi_internal.mi_claim_naver_shopping_repair_priority_legacy(
  text, uuid, uuid, integer
) to service_role;

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
  v_now timestamptz := date_trunc('milliseconds', pg_catalog.clock_timestamp());
begin
  perform mi_internal.mi_reconcile_naver_shopping_account_priority(v_now);
  if exists (
    select 1
    from public.naver_shopping_account_priority_requests as request
    where request.state = 'active'
  ) then
    return pg_catalog.jsonb_build_object(
      'accepted', false,
      'idempotent', false,
      'blockedByAccountPriority', true,
      'queuedCount', 0,
      'wakeRequested', false
    );
  end if;
  return mi_internal.mi_enqueue_naver_shopping_repair_priority_legacy(
    p_request_id, p_tracker_ids, p_reason
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
  account_result jsonb;
begin
  account_result := mi_internal.mi_claim_naver_shopping_account_priority(
    p_worker_id, p_lane_token, p_run_id, p_lease_seconds
  );
  if coalesce((account_result ->> 'intercept')::boolean, false) then
    return account_result - 'intercept';
  end if;
  return mi_internal.mi_claim_naver_shopping_repair_priority_legacy(
    p_worker_id, p_lane_token, p_run_id, p_lease_seconds
  );
end;
$$;

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

revoke all on function public.mi_enqueue_naver_shopping_account_priority(
  uuid, text, integer, text, text, text
)
from public, anon, authenticated, service_role;
grant execute on function public.mi_enqueue_naver_shopping_account_priority(
  uuid, text, integer, text, text, text
)
to service_role;

revoke all on function public.mi_enqueue_naver_shopping_repair_priority(
  uuid, uuid[], text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_enqueue_naver_shopping_repair_priority(
  uuid, uuid[], text
) to service_role;

revoke all on function public.mi_claim_naver_shopping_repair_priority(
  text, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_repair_priority(
  text, uuid, uuid, integer
) to service_role;

revoke all on function public.mi_naver_shopping_cycle_runtime_recovery_eligible(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_naver_shopping_cycle_runtime_recovery_eligible(
  uuid, uuid, text, text
) to service_role;

revoke all on function public.mi_naver_shopping_cycle_orphan_recovery_eligible(
  uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_naver_shopping_cycle_orphan_recovery_eligible(
  uuid, uuid
) to service_role;

commit;

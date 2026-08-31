-- Account-priority members are natural scheduled evidence.  A manual,
-- remote, fixed-time or standby worker run must not consume one and leave the
-- immutable member ledger with provenance that the reconciler cannot accept.
--
-- Install after the 1.1.20 runtime transition and before the next one-shot
-- request.  This migration wraps every public queue/claim/lookup/wake
-- transport.  Non-catch-up waits do not enqueue, wake, claim, reorder,
-- unquarantine or advance any cursor; exact catch-up keeps the existing cycle
-- roster lifecycle and may claim only the frozen account member.

begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in share row exclusive mode;
lock table public.naver_shopping_account_priority_requests in share row exclusive mode;
lock table public.naver_shopping_account_priority_members in share row exclusive mode;
lock table public.naver_rank_trackers in share row exclusive mode;
lock table public.naver_shopping_rank_lookup_jobs in share row exclusive mode;
lock table public.naver_shopping_worker_wakes in share row exclusive mode;

do $migration_guard$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  coordination_found boolean := false;
  active_request_count integer := 0;
  unfinished_member_count integer := 0;
  processing_count integer := 0;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  coordination_found := found;

  select count(*)::integer into active_request_count
  from public.naver_shopping_account_priority_requests as request
  where request.state = 'active';

  select count(*)::integer into unfinished_member_count
  from public.naver_shopping_account_priority_members as member
  where member.state in ('pending', 'claimed');

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

  if not exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as relation
      on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'naver_shopping_account_priority_requests'
      and constraint_row.conname =
        'naver_shopping_account_priority_requests_runtime_cohort_key'
      and constraint_row.contype = 'u'
  ) or not exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as relation
      on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'naver_shopping_finite_window_targets'
      and constraint_row.conname =
        'naver_shopping_finite_window_targets_runtime_version_check'
      and constraint_row.contype = 'c'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid)
        ~ 'runtime_version.*1[.]1[.]20'
  ) then
    raise exception
      'naver_shopping_account_priority_trigger_gate_requires_runtime_1_1_20_schema';
  end if;

  if coordination_found is not true
    or active_request_count <> 0
    or unfinished_member_count <> 0
    or processing_count <> 0
    or not (
      (
        current_row.runtime_version is null
        and current_row.runtime_fingerprint is null
      )
      or (
        current_row.runtime_version = '1.1.20'
        and current_row.runtime_fingerprint =
          '4e0f5fbde16a892e44986b2325865f33d61bdf7a5a13d3d7adcd501608aa8e5b'
      )
    )
    or current_row.cadence_mode is distinct from 'baseline'
    or current_row.cadence_minutes is distinct from 10
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
    or current_row.probe_started_at is not null then
    raise exception
      'naver_shopping_account_priority_rank_catch_up_gate_requires_idle';
  end if;
end
$migration_guard$;

-- Keep the pre-gate implementations outside the exposed PostgREST schema.
-- They remain service-role executable because every public wrapper is
-- SECURITY INVOKER.  The privileged helper surface is not a user/Data API
-- surface; public/anon/authenticated remain revoked.
alter function public.mi_queue_naver_shopping_cycle()
  set schema mi_internal;
alter function mi_internal.mi_queue_naver_shopping_cycle()
  rename to mi_queue_naver_shopping_cycle_pre_account_trigger_gate;

alter function public.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, integer, uuid
) set schema mi_internal;
alter function mi_internal.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, integer, uuid
) rename to mi_claim_naver_shopping_cycle_keyword_pre_account_trigger_gate;

alter function public.mi_claim_naver_shopping_rank_lookup_job(integer)
  set schema mi_internal;
alter function mi_internal.mi_claim_naver_shopping_rank_lookup_job(integer)
  rename to mi_claim_naver_shopping_rank_lookup_job_pre_account_trigger_gate;

alter function public.mi_claim_naver_shopping_worker_wake()
  set schema mi_internal;
alter function mi_internal.mi_claim_naver_shopping_worker_wake()
  rename to mi_claim_naver_shopping_worker_wake_pre_account_trigger_gate;

-- All trigger-aware transports take the coordination lock before the active
-- request lock.  The enqueue RPC uses the same leading coordination lock, so
-- an account request cannot appear between this decision and a delegated
-- queue/claim/lookup/wake mutation in the same transaction.
create or replace function mi_internal.mi_naver_shopping_account_priority_trigger_gate(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_run_trigger text,
  p_require_lane boolean
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  active_request public.naver_shopping_account_priority_requests%rowtype;
  v_now timestamptz := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  normalized_worker_id text := pg_catalog.lower(pg_catalog.btrim(
    coalesce(p_worker_id, '')
  ));
  normalized_trigger text := pg_catalog.lower(pg_catalog.btrim(
    coalesce(p_run_trigger, '')
  ));
  v_expiry_reconciled boolean := false;
begin
  if coalesce(p_require_lane, false) then
    if normalized_trigger not in (
      'manual', 'rank-catch-up', 'rank-0900', 'rank-1500', 'rank-remote',
      'mac-standby', 'github-cloud'
    ) then
      raise exception 'naver_shopping_account_priority_run_trigger_invalid';
    end if;
    if normalized_worker_id !~ '^[a-z0-9][a-z0-9:_-]{2,63}$'
      or p_lane_token is null
      or p_run_id is null then
      raise exception 'naver_shopping_account_priority_trigger_gate_invalid';
    end if;
  elsif p_worker_id is not null
    or p_lane_token is not null
    or p_run_id is not null
    or p_run_trigger is not null then
    raise exception 'naver_shopping_account_priority_legacy_gate_invalid';
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found then
    raise exception 'naver_shopping_account_priority_coordination_missing';
  end if;

  select * into active_request
  from public.naver_shopping_account_priority_requests as request
  where request.state = 'active'
  order by request.requested_at asc, request.request_id asc
  limit 1
  for update;

  -- Use a clock sampled after both locks so time spent waiting for the single
  -- winner cannot make an already-expired request appear live.
  v_now := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );

  -- Expiry is ledger-only and must remain possible after the exact primary,
  -- lane or runtime identity has disappeared.  The coordination row and the
  -- active request are already locked in that order.  Reconcile once from the
  -- database clock, then block this transport call even if the request closed;
  -- the next independent natural call may delegate the ordinary transport.
  if active_request.request_id is not null
    and active_request.expires_at <= v_now then
    perform mi_internal.mi_reconcile_naver_shopping_account_priority(v_now);
    v_expiry_reconciled := true;

    select * into active_request
    from public.naver_shopping_account_priority_requests as request
    where request.state = 'active'
    order by request.requested_at asc, request.request_id asc
    limit 1
    for update;
  end if;

  if v_expiry_reconciled then
    return pg_catalog.jsonb_build_object(
      'active', active_request.request_id is not null,
      'expiryReconciled', true,
      'transportBlocked', true,
      'rankCatchUp', normalized_trigger = 'rank-catch-up',
      'accountPrimary',
        normalized_worker_id = 'windows-desktop-primary'
        and current_row.primary_worker_id = 'windows-desktop-primary',
      'circuitState', current_row.circuit_state,
      'circuitReason', current_row.circuit_reason,
      'cooldownUntil', current_row.cooldown_until,
      'controlClosed',
        current_row.circuit_state = 'closed'
        and current_row.circuit_reason is null
        and current_row.cooldown_until is null
    );
  end if;

  if coalesce(p_require_lane, false) and (
    current_row.lease_worker_id is distinct from normalized_worker_id
    or current_row.lease_token is distinct from p_lane_token
    or current_row.run_id is distinct from p_run_id
    or current_row.lease_until is null
    or current_row.lease_until <= v_now
    or current_row.current_stage is distinct from 'claiming'
    or current_row.current_page is distinct from 0
    or current_row.current_job_kind is not null
    or current_row.current_tracker_id is not null
    or current_row.runtime_version is distinct from '1.1.20'
    or current_row.runtime_fingerprint is distinct from
      '4e0f5fbde16a892e44986b2325865f33d61bdf7a5a13d3d7adcd501608aa8e5b'
  ) then
    raise exception 'naver_shopping_account_priority_trigger_gate_lane_lost';
  end if;

  if active_request.request_id is not null and (
    current_row.runtime_version is distinct from
      active_request.required_runtime_version
    or current_row.runtime_fingerprint is distinct from
      active_request.required_runtime_fingerprint
  ) then
    raise exception 'naver_shopping_account_priority_trigger_gate_identity_lost';
  end if;

  return pg_catalog.jsonb_build_object(
    'active', active_request.request_id is not null,
    'expiryReconciled', false,
    'transportBlocked', false,
    'rankCatchUp', normalized_trigger = 'rank-catch-up',
    'accountPrimary',
      normalized_worker_id = 'windows-desktop-primary'
      and current_row.primary_worker_id = 'windows-desktop-primary',
    'circuitState', current_row.circuit_state,
    'circuitReason', current_row.circuit_reason,
    'cooldownUntil', current_row.cooldown_until,
    'controlClosed',
      current_row.circuit_state = 'closed'
      and current_row.circuit_reason is null
      and current_row.cooldown_until is null
  );
end;
$$;

-- The legacy repair enqueue must share the same coordination -> request lock
-- order as every other account-priority transport.  An expiry reconciliation
-- is committed as a bounded no-op; ordinary repair enqueue may resume only on
-- a later independent call.
create or replace function public.mi_enqueue_naver_shopping_repair_priority(
  p_request_id uuid,
  p_tracker_ids uuid[],
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare gate_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      null, null, null, null, false
    );

  if coalesce((gate_result ->> 'transportBlocked')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'accepted', false,
      'idempotent', false,
      'blockedByAccountPriority', true,
      'queuedCount', 0,
      'wakeRequested', false,
      'reason', 'account_priority_expiry_reconciled'
    );
  end if;

  if coalesce((gate_result ->> 'active')::boolean, false) then
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

-- The signed repair request is the sole active-account member claim path.  An
-- automatic half-open run uses a frozen account member as its one bounded
-- probe instead of consuming a tracker from another account.  The temporary
-- closed state is protected by the already-held coordination lock and is
-- restored before this transaction can be observed by another session.
create or replace function public.mi_claim_naver_shopping_repair_priority(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_run_trigger text,
  p_lease_seconds integer,
  p_account_only boolean
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  account_result jsonb;
  gate_result jsonb;
  v_active boolean := false;
  v_half_open_probe boolean := false;
  v_restored_count integer := 0;
begin
  if p_account_only is null then
    raise exception 'naver_shopping_account_priority_account_only_invalid';
  end if;

  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      p_worker_id, p_lane_token, p_run_id, p_run_trigger, true
    );
  v_active := coalesce((gate_result ->> 'active')::boolean, false);

  if coalesce((gate_result ->> 'transportBlocked')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', v_active,
      'reason', 'account_priority_expiry_reconciled'
    );
  end if;

  if p_account_only and not v_active then
    return pg_catalog.jsonb_build_object(
      'status', 'empty',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', false,
      'reason', 'account_priority_inactive'
    );
  end if;

  if v_active
    and not (
      coalesce((gate_result ->> 'rankCatchUp')::boolean, false)
      and coalesce((gate_result ->> 'accountPrimary')::boolean, false)
    ) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true,
      'reason', 'account_rank_catch_up_trigger_required'
    );
  end if;

  v_half_open_probe := p_account_only
    and v_active
    and gate_result ->> 'circuitState' = 'half_open'
    and gate_result ->> 'circuitReason' in (
      'auto_navigation_probe', 'auto_transient_system_probe'
    );

  if v_active
    and coalesce((gate_result ->> 'controlClosed')::boolean, false) is not true
    and v_half_open_probe is not true then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true,
      'reason', 'account_control_not_claimable'
    );
  end if;

  if v_half_open_probe then
    update public.naver_shopping_worker_coordination as coordination
    set circuit_state = 'closed',
        circuit_reason = null,
        cooldown_until = null
    where coordination.lane_key = 'global'
      and coordination.lease_worker_id =
        pg_catalog.lower(pg_catalog.btrim(p_worker_id))
      and coordination.lease_token = p_lane_token
      and coordination.run_id = p_run_id
      and coordination.circuit_state = 'half_open'
      and coordination.circuit_reason = gate_result ->> 'circuitReason'
      and coordination.cooldown_until is not distinct from
        (gate_result ->> 'cooldownUntil')::timestamptz;
    get diagnostics v_restored_count = row_count;
    if v_restored_count <> 1 then
      raise exception 'naver_shopping_account_priority_half_open_probe_conflict';
    end if;
  end if;

  account_result := mi_internal.mi_claim_naver_shopping_account_priority(
    p_worker_id, p_lane_token, p_run_id, p_lease_seconds
  );

  if v_half_open_probe then
    update public.naver_shopping_worker_coordination as coordination
    set circuit_state = 'half_open',
        circuit_reason = gate_result ->> 'circuitReason',
        cooldown_until = (gate_result ->> 'cooldownUntil')::timestamptz
    where coordination.lane_key = 'global'
      and coordination.lease_worker_id =
        pg_catalog.lower(pg_catalog.btrim(p_worker_id))
      and coordination.lease_token = p_lane_token
      and coordination.run_id = p_run_id
      and coordination.circuit_state = 'closed'
      and coordination.circuit_reason is null
      and coordination.cooldown_until is null;
    get diagnostics v_restored_count = row_count;
    if v_restored_count <> 1 then
      raise exception 'naver_shopping_account_priority_half_open_restore_conflict';
    end if;
  end if;

  if coalesce((account_result ->> 'intercept')::boolean, false) then
    return account_result - 'intercept';
  end if;

  -- A reconcile performed by the account-only probe may have completed the
  -- request.  Return empty so the same half-open run can fall through once to
  -- the pre-existing cycle probe.  Never claim a legacy repair in this mode.
  if v_active or p_account_only then
    return pg_catalog.jsonb_build_object(
      'status', 'empty',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', v_active,
      'reason', case
        when v_active then 'account_priority_reconciled'
        else 'account_priority_inactive'
      end
    );
  end if;

  return mi_internal.mi_claim_naver_shopping_repair_priority_legacy(
    p_worker_id, p_lane_token, p_run_id, p_lease_seconds
  );
end;
$$;

-- Preserve the five-argument trigger-aware signature for existing exact
-- workers.  The six-argument overload is used only by bounded auto-recovery.
create or replace function public.mi_claim_naver_shopping_repair_priority(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_run_trigger text,
  p_lease_seconds integer default 2100
) returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.mi_claim_naver_shopping_repair_priority(
    p_worker_id, p_lane_token, p_run_id, p_run_trigger,
    p_lease_seconds, false
  )
$$;

-- Older four-argument callers cannot prove a trigger.  Preserve legacy repair
-- only when no account request is active; otherwise fail closed as waiting.
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
  gate_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      null, null, null, null, false
    );

  if coalesce((gate_result ->> 'transportBlocked')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority',
        coalesce((gate_result ->> 'active')::boolean, false),
      'reason', 'account_priority_expiry_reconciled'
    );
  end if;

  if coalesce((gate_result ->> 'active')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting',
      'priority', 'repair',
      'claims', '[]'::jsonb,
      'accountPriority', true,
      'reason', 'account_rank_catch_up_trigger_required'
    );
  end if;

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

-- Non-catch-up queue requests are blocked while account priority is active.
-- Exact rank-catch-up may delegate the existing queue implementation because
-- the bounded handoff needs the next natural cycle. Ordinary/probe cycle,
-- interactive lookup and wake consumption remain blocked for every trigger.
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
declare gate_result jsonb;
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
  return mi_internal.mi_queue_naver_shopping_cycle_pre_account_trigger_gate();
end;
$$;

create or replace function public.mi_queue_naver_shopping_cycle()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare gate_result jsonb;
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
  return mi_internal.mi_queue_naver_shopping_cycle_pre_account_trigger_gate();
end;
$$;

create or replace function public.mi_claim_naver_shopping_cycle_keyword(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_run_trigger text,
  p_lease_seconds integer,
  p_probe_tracker_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare gate_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      p_worker_id, p_lane_token, p_run_id, p_run_trigger, true
    );
  if coalesce((gate_result ->> 'transportBlocked')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting',
      'reason', 'account_priority_expiry_reconciled',
      'cycleId', null, 'claims', '[]'::jsonb,
      'deferredCount', 0, 'groupSize', 0
    );
  end if;
  if coalesce((gate_result ->> 'active')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting', 'reason', 'account_priority_active',
      'cycleId', null, 'claims', '[]'::jsonb,
      'deferredCount', 0, 'groupSize', 0
    );
  end if;
  return mi_internal.mi_claim_naver_shopping_cycle_keyword_pre_account_trigger_gate(
    p_worker_id, p_lane_token, p_run_id, p_lease_seconds, p_probe_tracker_id
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
declare gate_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      null, null, null, null, false
    );
  if coalesce((gate_result ->> 'transportBlocked')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting',
      'reason', 'account_priority_expiry_reconciled',
      'cycleId', null, 'claims', '[]'::jsonb,
      'deferredCount', 0, 'groupSize', 0
    );
  end if;
  if coalesce((gate_result ->> 'active')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'status', 'waiting', 'reason', 'account_priority_active',
      'cycleId', null, 'claims', '[]'::jsonb,
      'deferredCount', 0, 'groupSize', 0
    );
  end if;
  return mi_internal.mi_claim_naver_shopping_cycle_keyword_pre_account_trigger_gate(
    p_worker_id, p_lane_token, p_run_id, p_lease_seconds, p_probe_tracker_id
  );
end;
$$;

create or replace function public.mi_claim_naver_shopping_rank_lookup_job(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_run_trigger text,
  p_lease_seconds integer
) returns table (
  id uuid,
  keyword text,
  lease_started_at timestamptz,
  lease_until timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare gate_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      p_worker_id, p_lane_token, p_run_id, p_run_trigger, true
    );
  if coalesce((gate_result ->> 'transportBlocked')::boolean, false)
    or coalesce((gate_result ->> 'active')::boolean, false) then
    return;
  end if;
  return query
  select *
  from mi_internal.mi_claim_naver_shopping_rank_lookup_job_pre_account_trigger_gate(
    p_lease_seconds
  );
end;
$$;

create or replace function public.mi_claim_naver_shopping_rank_lookup_job(
  p_lease_seconds integer default 2100
) returns table (
  id uuid,
  keyword text,
  lease_started_at timestamptz,
  lease_until timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare gate_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      null, null, null, null, false
    );
  if coalesce((gate_result ->> 'transportBlocked')::boolean, false)
    or coalesce((gate_result ->> 'active')::boolean, false) then
    return;
  end if;
  return query
  select *
  from mi_internal.mi_claim_naver_shopping_rank_lookup_job_pre_account_trigger_gate(
    p_lease_seconds
  );
end;
$$;

create or replace function public.mi_claim_naver_shopping_worker_wake(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_run_trigger text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare gate_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      p_worker_id, p_lane_token, p_run_id, p_run_trigger, true
    );
  if coalesce((gate_result ->> 'transportBlocked')::boolean, false)
    or coalesce((gate_result ->> 'active')::boolean, false) then
    return false;
  end if;
  return mi_internal.mi_claim_naver_shopping_worker_wake_pre_account_trigger_gate();
end;
$$;

create or replace function public.mi_claim_naver_shopping_worker_wake()
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare gate_result jsonb;
begin
  gate_result :=
    mi_internal.mi_naver_shopping_account_priority_trigger_gate(
      null, null, null, null, false
    );
  if coalesce((gate_result ->> 'transportBlocked')::boolean, false)
    or coalesce((gate_result ->> 'active')::boolean, false) then
    return false;
  end if;
  return mi_internal.mi_claim_naver_shopping_worker_wake_pre_account_trigger_gate();
end;
$$;

revoke all on function public.mi_enqueue_naver_shopping_repair_priority(
  uuid, uuid[], text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_enqueue_naver_shopping_repair_priority(
  uuid, uuid[], text
) to service_role;

revoke all on function public.mi_claim_naver_shopping_repair_priority(
  text, uuid, uuid, text, integer, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_repair_priority(
  text, uuid, uuid, text, integer, boolean
) to service_role;

revoke all on function public.mi_claim_naver_shopping_repair_priority(
  text, uuid, uuid, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_repair_priority(
  text, uuid, uuid, text, integer
) to service_role;

revoke all on function public.mi_claim_naver_shopping_repair_priority(
  text, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_repair_priority(
  text, uuid, uuid, integer
) to service_role;

revoke all on function mi_internal.mi_naver_shopping_account_priority_trigger_gate(
  text, uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function mi_internal.mi_naver_shopping_account_priority_trigger_gate(
  text, uuid, uuid, text, boolean
) to service_role;

revoke all on function
  mi_internal.mi_queue_naver_shopping_cycle_pre_account_trigger_gate()
from public, anon, authenticated, service_role;
grant execute on function
  mi_internal.mi_queue_naver_shopping_cycle_pre_account_trigger_gate()
to service_role;

revoke all on function
  mi_internal.mi_claim_naver_shopping_cycle_keyword_pre_account_trigger_gate(
    text, uuid, uuid, integer, uuid
  ) from public, anon, authenticated, service_role;
grant execute on function
  mi_internal.mi_claim_naver_shopping_cycle_keyword_pre_account_trigger_gate(
    text, uuid, uuid, integer, uuid
  ) to service_role;

revoke all on function
  mi_internal.mi_claim_naver_shopping_rank_lookup_job_pre_account_trigger_gate(integer)
from public, anon, authenticated, service_role;
grant execute on function
  mi_internal.mi_claim_naver_shopping_rank_lookup_job_pre_account_trigger_gate(integer)
to service_role;

revoke all on function
  mi_internal.mi_claim_naver_shopping_worker_wake_pre_account_trigger_gate()
from public, anon, authenticated, service_role;
grant execute on function
  mi_internal.mi_claim_naver_shopping_worker_wake_pre_account_trigger_gate()
to service_role;

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

revoke all on function public.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, text, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, text, integer, uuid
) to service_role;
revoke all on function public.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, integer, uuid
) to service_role;

revoke all on function public.mi_claim_naver_shopping_rank_lookup_job(
  text, uuid, uuid, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_rank_lookup_job(
  text, uuid, uuid, text, integer
) to service_role;
revoke all on function public.mi_claim_naver_shopping_rank_lookup_job(integer)
from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_rank_lookup_job(integer)
to service_role;

revoke all on function public.mi_claim_naver_shopping_worker_wake(
  text, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_worker_wake(
  text, uuid, uuid, text
) to service_role;
revoke all on function public.mi_claim_naver_shopping_worker_wake()
from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_worker_wake()
to service_role;

commit;

begin;

-- A native-host response timeout or an exhausted local provider deadline can
-- leave an otherwise healthy primary worker behind a permanently open global
-- circuit. These two typed failures are local/runtime timeouts, not evidence
-- that Naver's security or network boundary may be retried. Allow at most two
-- ordered probes, each after a 30-minute quiet period. The ordinary scheduler
-- remains the sole owner of tracker choice, durable cursor and queue order.
alter table public.naver_shopping_worker_coordination
  add column if not exists transient_system_probe_attempts integer not null default 0;

alter table public.naver_shopping_worker_coordination
  drop constraint if exists naver_shopping_worker_coordination_transient_probe_attempts_check;

alter table public.naver_shopping_worker_coordination
  add constraint naver_shopping_worker_coordination_transient_probe_attempts_check
    check (transient_system_probe_attempts between 0 and 2);

alter table public.naver_shopping_worker_coordination enable row level security;
alter table public.naver_shopping_worker_coordination force row level security;
revoke all on table public.naver_shopping_worker_coordination
from public, anon, authenticated, service_role;
grant select, insert, update on table public.naver_shopping_worker_coordination
to service_role;

create index if not exists idx_naver_shopping_scheduler_events_tracker_claim_run
on public.naver_shopping_scheduler_events(run_id, lease_started_at)
where event_type = 'tracker_claimed'
  and run_id is not null;

create or replace function public.mi_claim_naver_shopping_worker_lane(
  p_worker_id text,
  p_worker_role text,
  p_lease_token uuid,
  p_lease_seconds integer default 2100,
  p_primary_stale_seconds integer default 180
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_worker_id text := lower(trim(coalesce(p_worker_id, '')));
  normalized_worker_role text := lower(trim(coalesce(p_worker_role, '')));
  lease_seconds integer := greatest(60, least(2100, coalesce(p_lease_seconds, 2100)));
  primary_stale_seconds integer := greatest(60, least(900, coalesce(p_primary_stale_seconds, 180)));
  current_row public.naver_shopping_worker_coordination%rowtype;
  transient_failure_code text;
  v_now timestamptz := clock_timestamp();
begin
  if normalized_worker_id !~ '^[a-z0-9][a-z0-9:_-]{2,63}$' then
    raise exception 'naver_shopping_worker_id_invalid';
  end if;
  if normalized_worker_role not in ('primary', 'standby') then
    raise exception 'naver_shopping_worker_role_invalid';
  end if;
  if p_lease_token is null then
    raise exception 'naver_shopping_worker_lane_token_invalid';
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if normalized_worker_role = 'primary' then
    update public.naver_shopping_worker_coordination
    set primary_worker_id = normalized_worker_id,
        primary_seen_at = v_now,
        updated_at = v_now
    where lane_key = 'global'
    returning * into current_row;
  end if;

  if current_row.cooldown_until is not null and current_row.cooldown_until > v_now then
    return jsonb_build_object(
      'granted', false,
      'reason', 'cooldown',
      'cooldownUntil', current_row.cooldown_until,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  -- Preserve the existing navigation-only recovery contract.
  if current_row.circuit_state = 'open'
    and normalized_worker_role = 'primary'
    and current_row.circuit_reason in (
      'navigating:naver_page_navigation_failed',
      'probe_incomplete',
      'probe_interrupted'
    )
    and split_part(lower(trim(coalesce(current_row.last_failure_code, ''))), ':', 1)
      = 'naver_page_navigation_failed'
    and current_row.circuit_opened_at is not null
    and current_row.circuit_opened_at <= v_now - interval '10 minutes'
    and (current_row.lease_until is null or current_row.lease_until <= v_now) then
    update public.naver_shopping_worker_coordination
    set circuit_state = 'half_open',
        circuit_reason = 'auto_navigation_probe',
        circuit_opened_at = null,
        probe_tracker_id = null,
        probe_started_at = null,
        failure_signature = null,
        failure_streak = 0,
        lease_worker_id = null,
        lease_token = null,
        lease_until = null,
        run_id = null,
        current_stage = null,
        current_page = 0,
        current_job_kind = null,
        current_tracker_id = null,
        current_job_started_at = null,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        updated_at = v_now
    where lane_key = 'global'
      and circuit_state = 'open'
      and circuit_reason in (
        'navigating:naver_page_navigation_failed',
        'probe_incomplete',
        'probe_interrupted'
      )
      and split_part(lower(trim(coalesce(last_failure_code, ''))), ':', 1)
        = 'naver_page_navigation_failed'
      and circuit_opened_at <= v_now - interval '10 minutes'
      and (lease_until is null or lease_until <= v_now)
    returning * into current_row;
  end if;

  transient_failure_code := split_part(
    lower(trim(coalesce(current_row.last_failure_code, ''))),
    ':',
    1
  );
  if current_row.circuit_state = 'open'
    and normalized_worker_role = 'primary'
    and transient_failure_code in (
      'native_host_response_timeout',
      'provider_deadline_exceeded'
    )
    and (
      current_row.circuit_reason is not distinct from current_row.failure_signature
      or (
        current_row.circuit_reason in ('probe_incomplete', 'probe_interrupted')
        and current_row.failure_signature is null
        and current_row.transient_system_probe_attempts > 0
      )
    )
    and current_row.transient_system_probe_attempts < 2
    and current_row.circuit_opened_at is not null
    and current_row.circuit_opened_at <= v_now - interval '30 minutes'
    and (current_row.lease_until is null or current_row.lease_until <= v_now) then
    update public.naver_shopping_worker_coordination
    set circuit_state = 'half_open',
        circuit_reason = 'auto_transient_system_probe',
        circuit_opened_at = null,
        probe_tracker_id = null,
        probe_started_at = null,
        failure_signature = null,
        failure_streak = 0,
        transient_system_probe_attempts = least(2, current_row.transient_system_probe_attempts + 1),
        lease_worker_id = null,
        lease_token = null,
        lease_until = null,
        run_id = null,
        current_stage = null,
        current_page = 0,
        current_job_kind = null,
        current_tracker_id = null,
        current_job_started_at = null,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        updated_at = v_now
    where lane_key = 'global'
      and circuit_state = 'open'
      and split_part(lower(trim(coalesce(last_failure_code, ''))), ':', 1) in (
        'native_host_response_timeout',
        'provider_deadline_exceeded'
      )
      and (
        circuit_reason is not distinct from failure_signature
        or (
          circuit_reason in ('probe_incomplete', 'probe_interrupted')
          and failure_signature is null
          and transient_system_probe_attempts > 0
        )
      )
      and transient_system_probe_attempts < 2
      and circuit_opened_at <= v_now - interval '30 minutes'
      and (lease_until is null or lease_until <= v_now)
    returning * into current_row;
  end if;

  if current_row.circuit_state = 'open' then
    return jsonb_build_object(
      'granted', false,
      'reason', 'circuit_open',
      'circuitState', 'open',
      'circuitReason', current_row.circuit_reason,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  if current_row.circuit_state = 'half_open'
    and current_row.circuit_reason in (
      'auto_navigation_probe',
      'auto_transient_system_probe'
    )
    and normalized_worker_role <> 'primary' then
    return jsonb_build_object(
      'granted', false,
      'reason', 'primary_required',
      'circuitState', 'half_open',
      'circuitReason', current_row.circuit_reason,
      'cadenceMinutes', 10
    );
  end if;

  if normalized_worker_role = 'standby'
    and current_row.primary_seen_at is not null
    and current_row.primary_seen_at > v_now - make_interval(secs => primary_stale_seconds) then
    return jsonb_build_object(
      'granted', false,
      'reason', 'primary_online',
      'primarySeenAt', current_row.primary_seen_at,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  if current_row.lease_until is not null
    and current_row.lease_until > v_now
    and (current_row.lease_worker_id is distinct from normalized_worker_id
      or current_row.lease_token is distinct from p_lease_token) then
    return jsonb_build_object(
      'granted', false,
      'reason', 'busy',
      'leaseUntil', current_row.lease_until,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  if current_row.circuit_state = 'half_open'
    and current_row.probe_started_at is not null
    and (current_row.lease_until is null or current_row.lease_until <= v_now) then
    update public.naver_shopping_worker_coordination
    set circuit_state = 'open',
        circuit_reason = 'probe_interrupted',
        circuit_opened_at = v_now,
        probe_started_at = null,
        lease_worker_id = null,
        lease_token = null,
        lease_until = null,
        current_stage = null,
        current_page = 0,
        current_job_kind = null,
        current_tracker_id = null,
        current_job_started_at = null,
        run_id = null,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        updated_at = v_now
    where lane_key = 'global';
    return jsonb_build_object(
      'granted', false,
      'reason', 'circuit_open',
      'circuitState', 'open',
      'circuitReason', 'probe_interrupted',
      'cadenceMinutes', 10
    );
  end if;

  update public.naver_shopping_worker_coordination
  set lease_worker_id = normalized_worker_id,
      lease_token = p_lease_token,
      lease_until = v_now + make_interval(secs => lease_seconds),
      cooldown_until = null,
      last_block_code = null,
      run_id = null,
      current_stage = 'claiming',
      current_page = 0,
      current_job_kind = null,
      current_tracker_id = null,
      current_job_started_at = v_now,
      probe_started_at = case when circuit_state = 'half_open' then v_now else probe_started_at end,
      updated_at = v_now
  where lane_key = 'global'
  returning * into current_row;

  return jsonb_build_object(
    'granted', true,
    'reason', 'granted',
    'leaseUntil', current_row.lease_until,
    'circuitState', current_row.circuit_state,
    'probeTrackerId', current_row.probe_tracker_id,
    'autoRecovery', current_row.circuit_reason in (
      'auto_navigation_probe',
      'auto_transient_system_probe'
    ),
    'cadenceMinutes', current_row.cadence_minutes
  );
end;
$$;

create or replace function public.mi_record_naver_shopping_worker_success(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_tracker_id uuid,
  p_collection_id text,
  p_checked_count integer,
  p_excluded_ad_count integer,
  p_duration_ms integer,
  p_source text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  v_now timestamptz := clock_timestamp();
  next_success_streak integer;
  next_stability_started_at timestamptz;
begin
  if p_run_id is null
    or trim(coalesce(p_collection_id, '')) !~ '^pw-chrome-'
    or p_checked_count is distinct from 300
    or coalesce(p_excluded_ad_count, -1) < 0
    or coalesce(p_duration_ms, -1) not between 0 and 3600000
    or lower(trim(coalesce(p_source, ''))) <> 'naver_shopping_results_collector' then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_proof_invalid');
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lane_token
    and run_id = p_run_id
    and lease_until > v_now
    and circuit_state <> 'open'
  for update;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'lease_lost');
  end if;
  if current_row.circuit_state = 'half_open'
    and current_row.circuit_reason is distinct from 'auto_navigation_probe'
    and current_row.circuit_reason is distinct from 'auto_transient_system_probe'
    and current_row.probe_tracker_id is distinct from p_tracker_id then
    return jsonb_build_object('recorded', false, 'reason', 'probe_mismatch');
  end if;
  if current_row.circuit_state = 'half_open'
    and current_row.circuit_reason in ('auto_navigation_probe', 'auto_transient_system_probe')
    and (current_row.probe_tracker_id is not null or p_tracker_id is null) then
    return jsonb_build_object('recorded', false, 'reason', 'probe_mismatch');
  end if;

  next_success_streak := case
    when current_row.circuit_state = 'half_open' then 1
    else least(100000, current_row.success_streak + 1)
  end;
  next_stability_started_at := case
    when current_row.circuit_state = 'half_open' or current_row.stability_started_at is null then v_now
    else current_row.stability_started_at
  end;

  update public.naver_shopping_worker_coordination
  set circuit_state = 'closed',
      circuit_reason = null,
      circuit_opened_at = null,
      failure_signature = null,
      failure_streak = 0,
      transient_system_probe_attempts = 0,
      probe_tracker_id = null,
      probe_started_at = null,
      current_stage = 'completed',
      current_page = 8,
      last_success_at = v_now,
      last_collection_id = trim(p_collection_id),
      last_checked_count = p_checked_count,
      last_excluded_ad_count = p_excluded_ad_count,
      last_duration_ms = p_duration_ms,
      last_source = lower(trim(p_source)),
      stability_started_at = next_stability_started_at,
      success_streak = next_success_streak,
      updated_at = v_now
  where lane_key = 'global';

  if p_tracker_id is not null then
    update public.naver_rank_trackers
    set worker_quarantined_until = null
    where id = p_tracker_id;
  end if;

  return jsonb_build_object(
    'recorded', true,
    'circuitState', 'closed',
    'cadenceMinutes', current_row.cadence_minutes,
    'candidateEligible', next_stability_started_at <= v_now - interval '24 hours'
      and next_success_streak >= 6
  );
end;
$$;

create or replace function public.mi_release_naver_shopping_worker_lane(
  p_worker_id text,
  p_lease_token uuid
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  v_now timestamptz := clock_timestamp();
  auto_navigation_recovered boolean := false;
  transient_system_recovered boolean := false;
  auto_recovery_no_work boolean := false;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lease_token
  for update;
  if not found then return false; end if;

  auto_recovery_no_work := current_row.circuit_state = 'half_open'
    and current_row.circuit_reason in (
      'auto_navigation_probe',
      'auto_transient_system_probe'
    )
    and current_row.current_stage = 'claiming'
    and current_row.current_page = 0
    and current_row.current_job_kind is null
    and current_row.current_tracker_id is null
    and current_row.run_id is not null
    and current_row.probe_started_at is not null
    and not exists (
      select 1
      from public.naver_shopping_scheduler_events as event
      where event.event_type = 'tracker_claimed'
        and event.run_id = current_row.run_id
        and event.lease_started_at >= current_row.probe_started_at
    );
  auto_navigation_recovered := current_row.circuit_state = 'half_open'
    and current_row.circuit_reason = 'auto_navigation_probe'
    and current_row.current_stage = 'failed'
    and split_part(lower(trim(coalesce(current_row.last_failure_code, ''))), ':', 1) in (
      'local_worker_submit_body_too_large',
      'provider_duplicate_identity',
      'provider_stable_window_unproven',
      'provider_partial_window',
      'provider_row_invalid',
      'provider_row_title_missing',
      'provider_row_identity_missing'
    );
  transient_system_recovered := current_row.circuit_state = 'half_open'
    and current_row.circuit_reason = 'auto_transient_system_probe'
    and current_row.current_stage = 'failed'
    and split_part(lower(trim(coalesce(current_row.last_failure_code, ''))), ':', 1) in (
      'local_worker_submit_body_too_large',
      'provider_duplicate_identity',
      'provider_stable_window_unproven',
      'provider_partial_window',
      'provider_row_invalid',
      'provider_row_title_missing',
      'provider_row_identity_missing'
    );

  update public.naver_shopping_worker_coordination
  set lease_worker_id = null,
      lease_token = null,
      lease_until = null,
      run_id = null,
      current_stage = null,
      current_page = 0,
      current_job_kind = null,
      current_tracker_id = null,
      current_job_started_at = null,
      circuit_state = case
        when auto_recovery_no_work then 'half_open'
        when auto_navigation_recovered then 'closed'
        when transient_system_recovered then 'closed'
        when current_row.circuit_state = 'half_open' then 'open'
        else current_row.circuit_state
      end,
      circuit_reason = case
        when auto_recovery_no_work then current_row.circuit_reason
        when auto_navigation_recovered then null
        when transient_system_recovered then null
        when current_row.circuit_state = 'half_open' then 'probe_incomplete'
        else current_row.circuit_reason
      end,
      circuit_opened_at = case
        when auto_recovery_no_work then null
        when auto_navigation_recovered then null
        when transient_system_recovered then null
        when current_row.circuit_state = 'half_open' then v_now
        else current_row.circuit_opened_at
      end,
      failure_signature = case
        when auto_recovery_no_work then current_row.failure_signature
        when auto_navigation_recovered then null
        when transient_system_recovered then null
        else current_row.failure_signature
      end,
      failure_streak = case
        when auto_recovery_no_work then current_row.failure_streak
        when auto_navigation_recovered then 0
        when transient_system_recovered then 0
        else current_row.failure_streak
      end,
      transient_system_probe_attempts = case
        when auto_recovery_no_work then current_row.transient_system_probe_attempts
        when auto_navigation_recovered then 0
        when transient_system_recovered then 0
        else current_row.transient_system_probe_attempts
      end,
      probe_tracker_id = case
        when auto_recovery_no_work then current_row.probe_tracker_id
        when auto_navigation_recovered then null
        when transient_system_recovered then null
        else current_row.probe_tracker_id
      end,
      probe_started_at = case
        when auto_recovery_no_work then null
        when current_row.circuit_state = 'half_open' then null
        else current_row.probe_started_at
      end,
      cadence_mode = case
        when current_row.circuit_state = 'half_open' then 'baseline'
        else current_row.cadence_mode
      end,
      cadence_minutes = case
        when current_row.circuit_state = 'half_open' then 10
        else current_row.cadence_minutes
      end,
      stability_started_at = case
        when current_row.circuit_state = 'half_open' then null
        else current_row.stability_started_at
      end,
      success_streak = case
        when current_row.circuit_state = 'half_open' then 0
        else current_row.success_streak
      end,
      updated_at = v_now
  where lane_key = 'global';
  return true;
end;
$$;

revoke all on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer)
from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer)
to service_role;

revoke all on function public.mi_record_naver_shopping_worker_success(text, uuid, uuid, uuid, text, integer, integer, integer, text)
from public, anon, authenticated, service_role;
grant execute on function public.mi_record_naver_shopping_worker_success(text, uuid, uuid, uuid, text, integer, integer, integer, text)
to service_role;

revoke all on function public.mi_release_naver_shopping_worker_lane(text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.mi_release_naver_shopping_worker_lane(text, uuid)
to service_role;

commit;

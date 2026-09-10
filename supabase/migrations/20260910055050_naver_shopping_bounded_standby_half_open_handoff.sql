-- A transient-system circuit currently becomes fail-stuck after the primary
-- consumes both bounded probes: the open-circuit return runs before standby
-- admission, while automatic half-open explicitly rejects standby workers.
-- Keep the existing two primary probes and all fail-closed error allowlists,
-- but permit one row-locked standby handoff when the probes are exhausted or
-- the primary is stale. A failed/interrupted handoff becomes an explicit
-- manual-required terminal instead of creating another automatic retry loop.

begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;

alter table public.naver_shopping_worker_coordination
  add column if not exists transient_standby_handoff_at timestamptz,
  add column if not exists transient_standby_handoff_worker_id text,
  add column if not exists transient_standby_handoff_success_at timestamptz;

drop function if exists public.mi_claim_naver_shopping_worker_lane(
  text, text, uuid, integer, integer
);

create or replace function public.mi_claim_naver_shopping_worker_lane(
  p_worker_id text,
  p_worker_role text,
  p_lease_token uuid,
  p_lease_seconds integer default 2100,
  p_primary_stale_seconds integer default 180,
  p_runtime_version text default null,
  p_runtime_fingerprint text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_worker_id text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_worker_id, ''))
  );
  normalized_worker_role text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_worker_role, ''))
  );
  normalized_runtime_version text := pg_catalog.btrim(coalesce(p_runtime_version, ''));
  normalized_runtime_fingerprint text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_runtime_fingerprint, ''))
  );
  lease_seconds integer := greatest(
    60,
    least(2100, coalesce(p_lease_seconds, 2100))
  );
  primary_stale_seconds integer := greatest(
    60,
    least(900, coalesce(p_primary_stale_seconds, 180))
  );
  current_row public.naver_shopping_worker_coordination%rowtype;
  transient_failure_code text;
  transient_recovery_open boolean := false;
  standby_handoff_used boolean := false;
  standby_handoff_due boolean := false;
  expired_standby_handoff boolean := false;
  runtime_proven boolean := false;
  processing_count integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
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

  -- Runtime identity belongs to the caller, not merely to an older successful
  -- run stored in coordination. Reject it before heartbeat, replay, lease, or
  -- one-shot handoff state can change. The two trailing defaults keep a rolling
  -- deployment fail-closed: an old five-argument caller is denied, never
  -- admitted without current identity.
  if normalized_runtime_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    or normalized_runtime_fingerprint !~ '^[0-9a-f]{64}$'
    or (
      normalized_worker_role = 'standby'
      and (
        current_row.runtime_version is distinct from normalized_runtime_version
        or current_row.runtime_fingerprint is distinct from normalized_runtime_fingerprint
      )
    ) then
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', 'runtime_identity_invalid',
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  -- This is a true terminal for automatic admission. Only the existing manual
  -- control path may move the circuit again; worker polls stay read-only even
  -- if runtime evidence or heartbeat state changes later.
  if current_row.circuit_state = 'open'
    and current_row.circuit_reason = 'transient_recovery_manual_required' then
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', 'recovery_manual_required',
      'manualRequired', true,
      'circuitState', 'open',
      'circuitReason', 'transient_recovery_manual_required',
      'cadenceMinutes', 10
    );
  end if;

  if normalized_worker_role = 'primary' then
    update public.naver_shopping_worker_coordination
    set primary_worker_id = normalized_worker_id,
        primary_seen_at = v_now,
        updated_at = v_now
    where lane_key = 'global'
    returning * into current_row;
  end if;

  if current_row.cooldown_until is not null and current_row.cooldown_until > v_now then
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', 'cooldown',
      'cooldownUntil', current_row.cooldown_until,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  -- An exact replay of the one accepted handoff observes the existing lease
  -- without renewing it. This recovers a lost HTTP response without consuming
  -- a second handoff or creating a repeated setter.
  if current_row.circuit_state = 'half_open'
    and current_row.circuit_reason = 'auto_transient_system_probe'
    and normalized_worker_role = 'standby'
    and current_row.transient_standby_handoff_at is not null
    and current_row.transient_standby_handoff_success_at
      is not distinct from current_row.last_success_at
    and current_row.transient_standby_handoff_worker_id = normalized_worker_id
    and current_row.lease_worker_id = normalized_worker_id
    and current_row.lease_token = p_lease_token
    and current_row.lease_until > v_now then
    return pg_catalog.jsonb_build_object(
      'granted', true,
      'reason', 'already_granted',
      'alreadyGranted', true,
      'leaseUntil', current_row.lease_until,
      'circuitState', 'half_open',
      'probeTrackerId', current_row.probe_tracker_id,
      'autoRecovery', true,
      'standbyHandoff', true,
      'cadenceMinutes', 10
    );
  end if;

  -- No recovery transition may run over a live lease owned by another
  -- invocation. The row lock serializes the later no-lease-to-handoff update.
  if current_row.lease_until is not null
    and current_row.lease_until > v_now
    and (
      current_row.lease_worker_id is distinct from normalized_worker_id
      or current_row.lease_token is distinct from p_lease_token
    ) then
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', 'busy',
      'leaseUntil', current_row.lease_until,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  transient_failure_code := pg_catalog.split_part(
    pg_catalog.lower(pg_catalog.btrim(coalesce(current_row.last_failure_code, ''))),
    ':',
    1
  );
  transient_recovery_open := current_row.circuit_state = 'open'
    and transient_failure_code in (
      'native_host_response_timeout',
      'provider_deadline_exceeded',
      'native_host_input_closed',
      'naver_page_timeout',
      'naver_page_script_timeout',
      'local_worker_commit_unavailable',
      'naver_next_data_missing',
      'naver_page_script_failed',
      'naver_page_read_state_unstable',
      'naver_page_navigation_result_missing'
    )
    and (
      current_row.circuit_reason is not distinct from current_row.failure_signature
      or (
        current_row.circuit_reason in ('probe_incomplete', 'probe_interrupted')
        and current_row.failure_signature is null
        and current_row.transient_system_probe_attempts > 0
      )
      or (
        current_row.circuit_reason in (
          'transient_standby_handoff_ready',
          'transient_recovery_manual_required'
        )
        and current_row.transient_system_probe_attempts between 0 and 2
      )
    );
  standby_handoff_used := current_row.transient_standby_handoff_at is not null
    and current_row.transient_standby_handoff_success_at
      is not distinct from current_row.last_success_at;

  -- Once the single standby handoff for this last-known-good boundary has
  -- failed, no caller can reopen the automatic loop. Persist the terminal
  -- reason only once; later polls are read-only denials.
  if transient_recovery_open and standby_handoff_used then
    if current_row.circuit_reason is distinct from 'transient_recovery_manual_required' then
      update public.naver_shopping_worker_coordination
      set circuit_reason = 'transient_recovery_manual_required',
          circuit_opened_at = coalesce(current_row.circuit_opened_at, v_now),
          probe_tracker_id = null,
          probe_started_at = null,
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
        and circuit_reason is distinct from 'transient_recovery_manual_required'
      returning * into current_row;
    end if;
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', 'recovery_manual_required',
      'manualRequired', true,
      'circuitState', 'open',
      'circuitReason', 'transient_recovery_manual_required',
      'cadenceMinutes', 10
    );
  end if;

  -- Preserve the navigation-only recovery contract unchanged.
  if current_row.circuit_state = 'open'
    and normalized_worker_role = 'primary'
    and current_row.circuit_reason in (
      'navigating:naver_page_navigation_failed',
      'probe_incomplete',
      'probe_interrupted'
    )
    and pg_catalog.split_part(
      pg_catalog.lower(pg_catalog.btrim(coalesce(current_row.last_failure_code, ''))),
      ':',
      1
    ) = 'naver_page_navigation_failed'
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
      and pg_catalog.split_part(
        pg_catalog.lower(pg_catalog.btrim(coalesce(last_failure_code, ''))),
        ':',
        1
      ) = 'naver_page_navigation_failed'
      and circuit_opened_at <= v_now - interval '10 minutes'
      and (lease_until is null or lease_until <= v_now)
    returning * into current_row;
  end if;

  -- Keep the primary probe budget and quiet period exactly bounded at two.
  if transient_recovery_open
    and normalized_worker_role = 'primary'
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
        transient_system_probe_attempts = least(
          2,
          current_row.transient_system_probe_attempts + 1
        ),
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
      and transient_system_probe_attempts < 2
      and circuit_opened_at <= v_now - interval '30 minutes'
      and (lease_until is null or lease_until <= v_now)
    returning * into current_row;
  end if;

  -- A standby is useful only after the primary has exhausted its budget, or
  -- when the primary heartbeat itself is stale. The stale-primary shortcut
  -- retains the 30-minute transient quiet period; exhaustion can hand off
  -- immediately to a different host once the failed primary released the lane.
  standby_handoff_due := transient_recovery_open
    and normalized_worker_role = 'standby'
    and (
      current_row.transient_system_probe_attempts >= 2
      or current_row.primary_seen_at is null
      or current_row.primary_seen_at <= v_now - pg_catalog.make_interval(secs => primary_stale_seconds)
    )
    and (
      current_row.transient_system_probe_attempts >= 2
      or (
        current_row.circuit_opened_at is not null
        and current_row.circuit_opened_at <= v_now - interval '30 minutes'
      )
    );

  if standby_handoff_due then
    select (
      (select pg_catalog.count(*)
       from public.naver_shopping_rank_lookup_jobs as lookup_job
       where lookup_job.status = 'processing'
         and lookup_job.processing_until > v_now)
      +
      (select pg_catalog.count(*)
       from public.naver_rank_trackers as tracker
       where tracker.status = 'active'
         and tracker.processing_until > v_now)
    )::integer
    into processing_count;

    runtime_proven := current_row.runtime_version is not null
      and pg_catalog.btrim(current_row.runtime_version) <> ''
      and current_row.runtime_fingerprint ~ '^[0-9a-f]{64}$'
      and exists (
        select 1
        from public.naver_shopping_worker_runs as proven_run
        where proven_run.runtime_version = current_row.runtime_version
          and proven_run.runtime_fingerprint = current_row.runtime_fingerprint
      );

    if processing_count <> 0 then
      return pg_catalog.jsonb_build_object(
        'granted', false,
        'reason', 'recovery_active_work',
        'circuitState', 'open',
        'circuitReason', current_row.circuit_reason,
        'cadenceMinutes', 10
      );
    end if;

    if runtime_proven is not true then
      if current_row.circuit_reason is distinct from 'transient_recovery_manual_required' then
        update public.naver_shopping_worker_coordination
        set circuit_reason = 'transient_recovery_manual_required',
            circuit_opened_at = coalesce(current_row.circuit_opened_at, v_now),
            cadence_mode = 'baseline',
            cadence_minutes = 10,
            stability_started_at = null,
            success_streak = 0,
            updated_at = v_now
        where lane_key = 'global'
          and circuit_state = 'open'
          and circuit_reason is distinct from 'transient_recovery_manual_required'
        returning * into current_row;
      end if;
      return pg_catalog.jsonb_build_object(
        'granted', false,
        'reason', 'recovery_runtime_unproven',
        'manualRequired', true,
        'circuitState', 'open',
        'circuitReason', 'transient_recovery_manual_required',
        'cadenceMinutes', 10
      );
    end if;

    update public.naver_shopping_worker_coordination
    set circuit_state = 'half_open',
        circuit_reason = 'auto_transient_system_probe',
        circuit_opened_at = null,
        probe_tracker_id = null,
        probe_started_at = v_now,
        failure_signature = null,
        failure_streak = 0,
        lease_worker_id = normalized_worker_id,
        lease_token = p_lease_token,
        lease_until = v_now + pg_catalog.make_interval(secs => lease_seconds),
        cooldown_until = null,
        last_block_code = null,
        run_id = null,
        current_stage = 'claiming',
        current_page = 0,
        current_job_kind = null,
        current_tracker_id = null,
        current_job_started_at = v_now,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        transient_standby_handoff_at = v_now,
        transient_standby_handoff_worker_id = normalized_worker_id,
        transient_standby_handoff_success_at = current_row.last_success_at,
        updated_at = v_now
    where lane_key = 'global'
      and circuit_state = 'open'
      and (lease_until is null or lease_until <= v_now)
      and (
        transient_standby_handoff_at is null
        or transient_standby_handoff_success_at is distinct from last_success_at
      )
    returning * into current_row;

    if not found then
      return pg_catalog.jsonb_build_object(
        'granted', false,
        'reason', 'recovery_conflict',
        'circuitState', 'open',
        'cadenceMinutes', 10
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'granted', true,
      'reason', 'granted',
      'leaseUntil', current_row.lease_until,
      'circuitState', 'half_open',
      'probeTrackerId', current_row.probe_tracker_id,
      'autoRecovery', true,
      'standbyHandoff', true,
      'cadenceMinutes', 10
    );
  end if;

  if current_row.circuit_state = 'open' then
    if transient_recovery_open
      and current_row.transient_system_probe_attempts >= 2 then
      if current_row.circuit_reason is distinct from 'transient_standby_handoff_ready' then
        update public.naver_shopping_worker_coordination
        set circuit_reason = 'transient_standby_handoff_ready',
            updated_at = v_now
        where lane_key = 'global'
          and circuit_state = 'open'
          and circuit_reason is distinct from 'transient_standby_handoff_ready'
        returning * into current_row;
      end if;
      return pg_catalog.jsonb_build_object(
        'granted', false,
        'reason', 'standby_handoff_required',
        'standbyHandoffEligible', true,
        'circuitState', 'open',
        'circuitReason', 'transient_standby_handoff_ready',
        'cadenceMinutes', 10
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', 'circuit_open',
      'circuitState', 'open',
      'circuitReason', current_row.circuit_reason,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  -- Expired probes must be settled before role admission. Otherwise a standby
  -- handoff with an expired lease returns primary_required forever and never
  -- reaches its one terminal transition. Navigation and ordinary primary
  -- probes still become probe_interrupted and remain primary-only afterward.
  if current_row.circuit_state = 'half_open'
    and current_row.probe_started_at is not null
    and (current_row.lease_until is null or current_row.lease_until <= v_now) then
    -- A historical handoff marker may legitimately survive a later successful
    -- recovery. Do not let that stale marker reclassify a separate navigation
    -- probe: the expiring probe must still be the exact standby transient lease.
    expired_standby_handoff := current_row.circuit_reason = 'auto_transient_system_probe'
      and current_row.transient_standby_handoff_at is not null
      and current_row.transient_standby_handoff_success_at
        is not distinct from current_row.last_success_at
      and current_row.transient_standby_handoff_worker_id is not null
      and current_row.lease_worker_id = current_row.transient_standby_handoff_worker_id
      and current_row.probe_started_at >= current_row.transient_standby_handoff_at;
    update public.naver_shopping_worker_coordination
    set circuit_state = 'open',
        circuit_reason = case
          when expired_standby_handoff
          then 'transient_recovery_manual_required'
          else 'probe_interrupted'
        end,
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
    where lane_key = 'global'
    returning * into current_row;
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', case
        when current_row.circuit_reason = 'transient_recovery_manual_required'
        then 'recovery_manual_required'
        else 'circuit_open'
      end,
      'manualRequired', current_row.circuit_reason = 'transient_recovery_manual_required',
      'circuitState', 'open',
      'circuitReason', current_row.circuit_reason,
      'cadenceMinutes', 10
    );
  end if;

  if current_row.circuit_state = 'half_open'
    and current_row.circuit_reason in (
      'auto_navigation_probe',
      'auto_transient_system_probe'
    )
    and normalized_worker_role <> 'primary' then
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', 'primary_required',
      'circuitState', 'half_open',
      'circuitReason', current_row.circuit_reason,
      'cadenceMinutes', 10
    );
  end if;

  if normalized_worker_role = 'standby'
    and current_row.primary_seen_at is not null
    and current_row.primary_seen_at > v_now - pg_catalog.make_interval(secs => primary_stale_seconds) then
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', 'primary_online',
      'primarySeenAt', current_row.primary_seen_at,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  update public.naver_shopping_worker_coordination
  set lease_worker_id = normalized_worker_id,
      lease_token = p_lease_token,
      lease_until = v_now + pg_catalog.make_interval(secs => lease_seconds),
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

  return pg_catalog.jsonb_build_object(
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

revoke all on function public.mi_claim_naver_shopping_worker_lane(
  text, text, uuid, integer, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_worker_lane(
  text, text, uuid, integer, integer, text, text
) to service_role;

commit;

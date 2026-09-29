-- ROLLBACK for supabase/migrations/20260929120000_naver_shopping_dead_lease_takeover.sql
-- (owner runs it in the Supabase SQL editor only if the takeover must be undone; run it
-- BEFORE docs/sql/20260927120000_naver_shopping_standby_failure_isolation.rollback.sql, never
-- after). Drops the heartbeat trigger and its function and restores the claim body of
-- 20260927120000 verbatim with the same grants. The seven new columns stay (the restored
-- body never reads them) and are cleared. After this the applied check
-- (docs/sql/20260929120000_naver_shopping_dead_lease_takeover.verify-applied.sql) shows
-- applied = false for the two functions and the trigger.
begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;

drop trigger if exists trg_mi_stamp_naver_shopping_worker_lease_heartbeat
on public.naver_shopping_worker_coordination;
drop function if exists mi_internal.mi_stamp_naver_shopping_worker_lease_heartbeat();

update public.naver_shopping_worker_coordination
set lease_heartbeat_at = null,
    lease_collection_started_at = null,
    lease_reaped_at = null,
    lease_reaped_worker_id = null,
    lease_reaped_run_id = null,
    lease_reaped_stage = null,
    lease_reaped_by_worker_id = null
where lane_key = 'global';

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
-- mi:standby-failure-isolation 2026-09-27
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
  primary_after_standby_failure boolean := false;
  early_probe_code text;
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
      -- 2026-09-19: a runtime migration clears the coordination identity and only the
      -- primary's first run used to fill it again, so a runtime release while the primary was
      -- down locked the standby out (`runtime_identity_invalid`, 70 minutes on 09-19). While
      -- the identity is unset AND the primary is stale, the standby may take the lane; the
      -- progress gate then pins the identity to the exact expected runtime, as it does for
      -- the primary. A set-but-different identity is still refused.
      and not (
        current_row.runtime_version is null
        and current_row.runtime_fingerprint is null
        and (
          current_row.primary_seen_at is null
          or current_row.primary_seen_at <= v_now - pg_catalog.make_interval(secs => primary_stale_seconds)
        )
      )
    ) then
    return pg_catalog.jsonb_build_object(
      'granted', false,
      'reason', 'runtime_identity_invalid',
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  -- 2026-09-27 (standby failure isolation): the registered primary is not held behind a
  -- circuit episode that only a different worker's failures produced. circuit_opened_by_worker
  -- names the worker whose failure opened the circuit from closed, or the registered primary
  -- when the primary's failure started that signature streak; it survives open -> half_open,
  -- it becomes the registered primary as soon as a half-open probe the primary held fails, is
  -- released incomplete or expires, and a standby's manual canary that ends so clears it
  -- (failure, release and the expiry below). On
  -- 09-27 the standby's own failures and probes kept the circuit open while the primary was
  -- off; a standby handoff that fails even ends in the manual terminal below. The calling
  -- primary takes one half-open probe at once only when all of these hold:
  --   * the episode is standby-originated: the column names a worker other than the caller
  --     (NULL: the circuit opened before this migration -> no early probe);
  --   * the primary has used none of its own automatic probes in the episode: no transient
  --     probe counted (transient_system_probe_attempts = 0; only a success or the owner's
  --     conditional close resets it) and no failed probe of its own (the column would name it).
  --     So once the primary has failed its own probes the 09-10 contract applies exactly:
  --     quiet periods, the two-probe budget, the single standby handoff and the manual terminal;
  --   * no live lease and no security cooldown (the replies below stay exactly as before);
  --   * the reason is one that only the automatic paths write, and the code the episode
  --     stopped on (early_probe_code) is a transient recovery code or a standby-device code:
  --     the failure function's own signature (circuit_reason = failure_signature,
  --     '<stage>:<code>') carries that code; after probe_incomplete, probe_interrupted or
  --     transient_recovery_manual_required it is the last recorded failure code (the probe's
  --     own failure, or the code that opened the circuit when the probe recorded none). So a
  --     Naver block recorded on a probe whose mi_block_naver_shopping_worker_lane call never
  --     landed (scripts/naver-shopping-local-worker.mjs only logs that failure and still
  --     releases the lane; a dead worker lets the lease expire) and a tracker code keep today's
  --     state. A deliberate stop (mi_stop_naver_shopping_worker writes any reason,
  --     'manual_stop' by default, and never the signature), 'probe_security_block'
  --     (mi_block_naver_shopping_worker_lane; unchanged), a Naver-page signature without an
  --     automatic exit today and any hand-set reason never qualify, even when an opener
  --     survives from an earlier circuit (the atomic success, the stop and a manual close are
  --     not re-declared here and leave the column as it was).
  -- Nested so that a claim on a closed circuit never reads the new column.
  if normalized_worker_role = 'primary' and current_row.circuit_state = 'open' then
    early_probe_code := case
      when current_row.circuit_reason in (
        'probe_incomplete',
        'probe_interrupted',
        'transient_recovery_manual_required'
      )
      then pg_catalog.split_part(
        pg_catalog.lower(pg_catalog.btrim(coalesce(current_row.last_failure_code, ''))),
        ':',
        1
      )
      when current_row.circuit_reason = current_row.failure_signature
      then pg_catalog.split_part(current_row.circuit_reason, ':', 2)
    end;
    primary_after_standby_failure := coalesce(
      current_row.circuit_opened_by_worker is not null
      and current_row.circuit_opened_by_worker <> normalized_worker_id
      and current_row.transient_system_probe_attempts = 0
      and (current_row.lease_until is null or current_row.lease_until <= v_now)
      and (current_row.cooldown_until is null or current_row.cooldown_until <= v_now)
      and early_probe_code in (
        'native_host_response_timeout',
        'provider_deadline_exceeded',
        'native_host_input_closed',
        'naver_page_timeout',
        'naver_page_script_timeout',
        'local_worker_commit_unavailable',
        'naver_next_data_missing',
        'naver_page_script_failed',
        'naver_page_read_state_unstable',
        'naver_page_navigation_result_missing',
        'naver_page_navigation_failed',
        'provider_browser_collection_failed',
        'provider_browser_launch_failed',
        'provider_browser_dependency_missing',
        'native_host_input_failed',
        'native_host_request_id_mismatch',
        'native_host_page_delivery_failed',
        'native_host_collection_failed'
      ),
      false
    );
  end if;

  -- This is a true terminal for automatic admission. Only the existing manual
  -- control path may move the circuit again; worker polls stay read-only even
  -- if runtime evidence or heartbeat state changes later. 2026-09-27: except for
  -- the primary's early probe on a standby-originated episode (see above).
  if current_row.circuit_state = 'open'
    and current_row.circuit_reason = 'transient_recovery_manual_required'
    and not primary_after_standby_failure then
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

  -- 2026-09-27: a standby benched by its own device failures
  -- (mi_record_naver_shopping_worker_failure) is refused before any lease or recovery
  -- transition, so it can neither collect nor take a navigation probe or the transient
  -- handoff until the bench ends. The primary path never reads the bench.
  if normalized_worker_role = 'standby' then
    if current_row.standby_benched_until is not null
      and current_row.standby_benched_until > v_now
      and current_row.standby_failure_worker_id is not distinct from normalized_worker_id then
      return pg_catalog.jsonb_build_object(
        'granted', false,
        'reason', 'standby_benched',
        'benchedUntil', current_row.standby_benched_until,
        'circuitState', current_row.circuit_state,
        'cadenceMinutes', current_row.cadence_minutes
      );
    end if;
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
  -- reason only once; later polls are read-only denials. 2026-09-27: a handoff that
  -- the standby failed in a standby-originated episode does not hold the returning
  -- primary (probe below); after the primary's own probes it does, as before.
  if transient_recovery_open and standby_handoff_used and not primary_after_standby_failure then
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

  -- 2026-09-27: the primary's immediate probe (primary_after_standby_failure above). It
  -- reuses the existing half-open probe kinds, so release, success, the account-priority
  -- gate and the worker treat it exactly like today's probes (autoRecovery): a navigation
  -- failure gets auto_navigation_probe (no budget); any other code gets
  -- auto_transient_system_probe and consumes one of the primary's two transient probes
  -- (never more than two). No quiet period. The opener is kept; when this probe fails, is
  -- released incomplete or expires, the primary becomes the opener and the normal rules
  -- apply for the rest of the episode: the primary's first failed probe ends the early path,
  -- no loop.
  if primary_after_standby_failure then
    update public.naver_shopping_worker_coordination
    set circuit_state = 'half_open',
        circuit_reason = case
          when transient_failure_code = 'naver_page_navigation_failed'
          then 'auto_navigation_probe'
          else 'auto_transient_system_probe'
        end,
        circuit_opened_at = null,
        probe_tracker_id = null,
        probe_started_at = null,
        failure_signature = null,
        failure_streak = 0,
        transient_system_probe_attempts = case
          when transient_failure_code = 'naver_page_navigation_failed'
          then transient_system_probe_attempts
          else least(2, transient_system_probe_attempts + 1)
        end,
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
      and circuit_opened_by_worker is not distinct from current_row.circuit_opened_by_worker
      and (lease_until is null or lease_until <= v_now)
    returning * into current_row;
  end if;

  -- Navigation-only recovery. Until 2026-09-19 only the primary could run this probe:
  -- when the primary died (2026-09-18 13:34 KST) and the standby's first two jobs failed
  -- at navigation right after waking, the circuit opened and the standby was refused
  -- `circuit_open` for eleven hours. A standby may now run the same bounded probe, but
  -- only while the primary has been silent for the stale window; quiet period, lease
  -- and failure-code conditions are unchanged.
  if current_row.circuit_state = 'open'
    and (
      normalized_worker_role = 'primary'
      or (
        normalized_worker_role = 'standby'
        and (
          current_row.primary_seen_at is null
          or current_row.primary_seen_at <= v_now - pg_catalog.make_interval(secs => primary_stale_seconds)
        )
      )
    )
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
        -- 2026-09-27: an expired probe the registered primary held makes the primary the opener;
        -- a standby's expired manual canary clears it, its expired automatic probe keeps it.
        circuit_opened_by_worker = case
          when current_row.lease_worker_id = current_row.primary_worker_id
          then current_row.lease_worker_id
          when coalesce(current_row.circuit_reason, '') not in (
            'auto_navigation_probe',
            'auto_transient_system_probe'
          )
          then null
          else current_row.circuit_opened_by_worker
        end,
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
    and normalized_worker_role <> 'primary'
    -- 2026-09-19: the navigation probe may be run by the standby while the primary is
    -- stale; the transient-system probe keeps its primary-only contract.
    and not (
      current_row.circuit_reason = 'auto_navigation_probe'
      and (
        current_row.primary_seen_at is null
        or current_row.primary_seen_at <= v_now - pg_catalog.make_interval(secs => primary_stale_seconds)
      )
    ) then
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

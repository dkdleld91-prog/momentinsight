-- 2026-09-29: dead-lease takeover (owner-approved drill-3 follow-up A, 2026-09-29).
-- Incident (drill 3, KST): windows-desktop-primary claimed a rank-catch-up group at 16:04:32
-- (3 trackers, lease_until 16:39:32 = +35 minutes, current_stage collecting). The drill
-- killed Chrome and the native host at ~16:04:3x; the dying worker recorded job_failed
-- native_host_input_closed x3 at 16:04:39 (the `fail` action released the three tracker
-- claims) and died before record-failure / release-lane, so the lane lease stayed until
-- 16:39:32. The Mac standby was refused `busy`, and the restored primary (back ~16:19:30,
-- polling every minute) was refused `busy` too; the primary claimed at 16:44:32 and
-- committed a finite window at 16:45:49. A worker dying mid-collection stalled ALL
-- collection for up to 35 minutes.
-- Now a lease whose holder has stopped refreshing it is treated exactly like an expired
-- lease, earlier:
--   * lease_heartbeat_at is stamped by a BEFORE UPDATE trigger whenever the lease holder
--     writes the row: the grant (new lease token), mi_touch (lease_until), every progress
--     report (run_id / current_stage / current_page / current_job_kind / current_tracker_id,
--     mi_report_naver_shopping_worker_progress stays untouched -- it is the runtime pin that
--     scripts bump.py re-declares from the previous runtime migration), atomic success
--     (last_success_at) and failure (last_failure_at). The primary's one-minute claim poll
--     (primary_seen_at / updated_at only), scheduler cursor and circuit bookkeeping never
--     move it. lease_collection_started_at is stamped when the holder reports `navigating`
--     (a job's collection starts; the server's per-job `claiming` report in between makes
--     every job of a run start again). Both are cleared with the lease and cannot be written
--     by hand while the trigger is enabled.
--   * mi_claim_naver_shopping_worker_lane: right after the runtime identity check and before
--     any other lease-dependent rule, a lease held by a different (worker, token) is expired
--     in place (lease_until := now, the rest of the lease kept so every existing expiry rule
--     applies unchanged) when BOTH
--       - the holder has written nothing for 6 minutes (lease_heartbeat_at), and
--       - no collection started under the lease within 16 minutes
--         (lease_collection_started_at is null or older than 16 minutes).
--     The claim then continues on the expired lease exactly as today at lease_until:
--     the same worker's new run (a) is granted at once; a standby (b) is still refused
--     `primary_online` while the primary heartbeat is fresh (180 s) and is otherwise granted;
--     an expired half-open probe settles to probe_interrupted /
--     transient_recovery_manual_required with the 09-27 opener rules; tracker leases are not
--     touched (c): the dead run's claimed trackers keep processing_until and come back through
--     the existing orphan recovery after it passes, so a tracker is never claimed twice.
--     A caller refused `runtime_identity_invalid` never takes a lease over.
--   * lease_reaped_at / _worker_id / _run_id / _stage / _by_worker_id record the last takeover.
-- Why 6 and 16 minutes (measured 2026-09-29, read-only):
--   * 1-second samples of the coordination row during a live primary collection
--     (17:54:25-17:55:20 KST): grant, navigating +0.4 s, pages 1..7 every 4.5-8.0 s,
--     submitting +6 s, success +1 s. Longest holder silence observed: 8.0 s.
--   * scheduler ledger 2026-09-15..29: 2003 committed groups, group_claimed -> last commit
--     p50 45.1 s, p95 88.6 s, p99 93.4 s, max 130.6 s (the whole job, all pages and submit).
--   * 6 minutes: while collecting, one page is at most 45 s tab load + 15 s script + 6 s delay
--     + 30 s progress HTTP. After `submitting` the longest holder silence at the default
--     timeouts is submit (120 s) + reconcile-submit + fail + record-failure (30 s each) =
--     210 s. With the timeout variables at their maximums (240 s / 120 s) that chain can
--     reach 600 s; it makes no Naver request, so a takeover there is harmless (the holder's
--     commits stay guarded by its tracker leases, its record-success / failure return
--     lease_lost).
--   * 16 minutes: a live but stuck worker can be silent far longer (5 standby jobs on 09-18
--     failed 787-1032 s after their claim, provider_deadline_exceeded), so silence alone is
--     not proof that no Naver page is still being loaded. The worker sets the request
--     deadline right after its `navigating` report returns: <= the DB `navigating` time + the
--     progress HTTP timeout (30 s default; MI_NAVER_SHOPPING_LOCAL_WORKER_API_TIMEOUT_MS,
--     which no installer, wrapper or config sets) + 14 minutes
--     (local-worker-contract.mjs LOCAL_WORKER_REQUEST_TIMEOUT_MS). The extension checks the
--     deadline before every navigation and after every page load (service-worker.js
--     collectPages) and the native host before every exchange, and a navigation started just
--     before it ends within 45 s tab load + 15 s script: 15.5 minutes < 16.
--     scripts/naver-shopping-dead-lease-takeover-migration.test.mjs reads these constants and
--     fails when their sum reaches the bound.
--   * so an awake worker with a monotonic wall clock starts no Naver navigation once 16
--     minutes have passed: two workers do not collect at the same time and the Naver request
--     volume does not change. Exceptions (the 35-minute expiry had the same residue, only
--     later): a holder that slept (a laptop) finishes at most the one page that was loading
--     when it slept, then its deadline check stops it; a holder whose wall clock was set back
--     is stopped by its next page report (lease_lost), but the extension does not wait for
--     that report, so it can open the next page(s) of the current pass until the native host
--     exits. Either way every later lease-bound call of the old holder returns lease_lost.
--   * a holder that is alive after the takeover loses the lane on its next lease-bound call
--     (progress / touch / success / failure return lease_lost; release and block match no
--     token once the lane is granted again); its commits stay guarded by its own tracker leases.
-- Drill 3 replayed: navigating 16:04:32.66 -> takeover possible from 16:20:32.66; the
-- restored primary's 16:21 poll takes the lane over (and releases it without a wake) and the
-- 16:24:32 rank-catch-up collects, instead of 16:44:32.
-- Runtime neutral: no runtime literal, unchanged RPC signatures, no change to the progress
-- gate; the running runtime needs nothing. A lease that is live when this migration is
-- applied has no heartbeat and keeps its plain lease_until expiry. Apply any time the lane is
-- idle, before or after the runtime release. A takeover alone does not satisfy a runtime
-- migration's idle guard: expiry (in place or at lease_until) keeps the lease columns; only a
-- later grant that is released clears them.
-- Applied check: docs/sql/20260929120000_naver_shopping_dead_lease_takeover.verify-applied.sql;
-- rollback: docs/sql/20260929120000_naver_shopping_dead_lease_takeover.rollback.sql (run it
-- before the 20260927120000 rollback, never after).
begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;

alter table public.naver_shopping_worker_coordination
  add column if not exists lease_heartbeat_at timestamptz,
  add column if not exists lease_collection_started_at timestamptz,
  add column if not exists lease_reaped_at timestamptz,
  add column if not exists lease_reaped_worker_id text,
  add column if not exists lease_reaped_run_id uuid,
  add column if not exists lease_reaped_stage text,
  add column if not exists lease_reaped_by_worker_id text;

-- The holder heartbeat. Only a write that changes a holder-owned column of a live lease
-- moves it; everything else keeps the previous value, so neither another worker's poll nor
-- a hand-written value can make a dead lease look alive (or a live one dead).
create or replace function mi_internal.mi_stamp_naver_shopping_worker_lease_heartbeat()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
-- mi:dead-lease-takeover 2026-09-29
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if new.lease_worker_id is null or new.lease_token is null or new.lease_until is null then
    new.lease_heartbeat_at := null;
    new.lease_collection_started_at := null;
    return new;
  end if;

  -- A new grant (normal claim or the standby handoff) starts a new lease.
  if new.lease_worker_id is distinct from old.lease_worker_id
    or new.lease_token is distinct from old.lease_token then
    new.lease_heartbeat_at := v_now;
    new.lease_collection_started_at := case
      when new.current_stage = 'navigating' then v_now
    end;
    return new;
  end if;

  -- A lease granted before this migration has no heartbeat and never gets one, so it can
  -- never be taken over early (its collection start is unknown): it keeps the plain
  -- lease_until expiry.
  if old.lease_heartbeat_at is null then
    new.lease_heartbeat_at := null;
    new.lease_collection_started_at := null;
    return new;
  end if;

  -- The same lease: only the holder writes these columns while its lease is live
  -- (touch, progress, atomic success, failure). An expiry (lease_until moved to the past)
  -- is not a heartbeat.
  if new.lease_until > v_now
    and (
      new.lease_until,
      new.run_id,
      new.current_stage,
      new.current_page,
      new.current_job_kind,
      new.current_tracker_id,
      new.last_success_at,
      new.last_failure_at
    ) is distinct from (
      old.lease_until,
      old.run_id,
      old.current_stage,
      old.current_page,
      old.current_job_kind,
      old.current_tracker_id,
      old.last_success_at,
      old.last_failure_at
    ) then
    new.lease_heartbeat_at := v_now;
  else
    new.lease_heartbeat_at := old.lease_heartbeat_at;
  end if;

  if new.lease_until > v_now
    and new.current_stage = 'navigating'
    and (
      old.current_stage is distinct from 'navigating'
      or new.run_id is distinct from old.run_id
      or new.current_tracker_id is distinct from old.current_tracker_id
    ) then
    new.lease_collection_started_at := v_now;
  else
    new.lease_collection_started_at := old.lease_collection_started_at;
  end if;
  return new;
end;
$$;

revoke all on function mi_internal.mi_stamp_naver_shopping_worker_lease_heartbeat()
from public, anon, authenticated, service_role;

drop trigger if exists trg_mi_stamp_naver_shopping_worker_lease_heartbeat
on public.naver_shopping_worker_coordination;
create trigger trg_mi_stamp_naver_shopping_worker_lease_heartbeat
before update on public.naver_shopping_worker_coordination
for each row execute function mi_internal.mi_stamp_naver_shopping_worker_lease_heartbeat();

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
-- mi:dead-lease-takeover 2026-09-29
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

  -- 2026-09-29 (dead-lease takeover): drill 3 left a primary lease that nobody refreshed
  -- for 35 minutes (16:04:39 -> 16:39:32 KST) while the standby and the restored primary were
  -- refused `busy`. A lease held by another (worker, token) is expired in place when its holder
  -- has written nothing for 6 minutes AND no collection started under it within 16 minutes
  -- (the request deadline ends at most 14.5 minutes after `navigating`, the last page load 1
  -- minute later; derivation in the migration 20260929120000 header). Only lease_until moves
  -- (to now): every rule below then treats it exactly as the lease expiry it already handles --
  -- the primary's early probe, busy, the standby's primary_online and bench refusals, the
  -- expired half-open probe settlement and its opener rules. It sits after the runtime
  -- identity check, so a caller refused `runtime_identity_invalid` never expires a lease.
  -- Tracker leases are not touched. Nested behind the grant time so that a claim over a lease
  -- younger than 6 minutes never reads the heartbeat columns (no fixture or hot-path change).
  if current_row.lease_until is not null
    and current_row.lease_until > v_now
    and (
      current_row.lease_worker_id is distinct from normalized_worker_id
      or current_row.lease_token is distinct from p_lease_token
    )
    and coalesce(current_row.current_job_started_at, '-infinity'::timestamptz)
      <= v_now - interval '6 minutes' then
    if current_row.lease_heartbeat_at is not null
      and current_row.lease_heartbeat_at <= v_now - interval '6 minutes'
      and (
        current_row.lease_collection_started_at is null
        or current_row.lease_collection_started_at <= v_now - interval '16 minutes'
      ) then
      update public.naver_shopping_worker_coordination
      set lease_until = v_now,
          lease_reaped_at = v_now,
          lease_reaped_worker_id = current_row.lease_worker_id,
          lease_reaped_run_id = current_row.run_id,
          lease_reaped_stage = current_row.current_stage,
          lease_reaped_by_worker_id = normalized_worker_id,
          updated_at = v_now
      where lane_key = 'global'
        and lease_worker_id is not distinct from current_row.lease_worker_id
        and lease_token is not distinct from current_row.lease_token
        and lease_until > v_now
      returning * into current_row;
    end if;
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

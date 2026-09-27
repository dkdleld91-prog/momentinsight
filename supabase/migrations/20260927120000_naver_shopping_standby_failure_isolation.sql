-- 2026-09-27: standby failure isolation (owner-approved change (2), 2026-09-27).
-- Incident (KST): windows-desktop-primary was shut down at 19:33:32 and booted again at
-- 20:20:48. macbook-standby took the lane, but its collection profile had no normal Chrome
-- window, so chrome.tabs.create rejected in ~3 ms ("No current window") and every job failed
-- as `naver_page_navigation_failed` (job_failed 19:42:33 and 19:52:06 -> global circuit
-- opened; its navigation probes failed again at 20:03:00 and 20:19:58 and reopened it). The
-- returning primary waited for circuit_opened_at + 10 minutes: probe 20:34:03, commit 20:34:48.
-- Runtime neutral (no runtime literal, unchanged RPC signatures, safe for running workers):
--   * circuit_opened_by_worker records the worker whose failure opened the circuit from closed
--     (the start of a circuit episode). It is kept through open -> half_open and becomes the
--     registered primary as soon as a half-open probe the primary held fails, is released
--     incomplete or expires; a standby's failed probe keeps it. A probe that recovers the
--     circuit in release clears it;
--   * a standby-device failure (codes below) reported by a worker that is not the registered
--     primary no longer advances the global failure signature and never opens a closed
--     circuit; it benches that standby instead (2 in one episode = 30 minutes, 3 or more =
--     60 minutes; claim refusal `standby_benched`). An atomic success after the standby's
--     last failure makes the next failure a new episode; a primary success does not lift an
--     active bench (the bench has no effect while the primary is alive);
--   * a half-open probe that fails still reopens the circuit exactly as before (fail-closed);
--   * only in a standby-originated episode -- the column names a worker other than the calling
--     primary and the primary has used none of its own automatic probes in it
--     (transient_system_probe_attempts = 0, no failed probe of its own) -- the returning
--     primary takes one half-open probe at once, including over the manual terminal
--     `transient_recovery_manual_required` reached through a failed standby handoff and a
--     standby handoff released `probe_incomplete` without a failure signature. It needs no
--     live lease, no security cooldown and a reason only the automatic paths write
--     (probe_incomplete, probe_interrupted, transient_recovery_manual_required, or the failure
--     function's own signature) whose code is a transient recovery or standby-device code; for
--     the three probe outcomes that code is the last recorded failure code, so a Naver block
--     whose block call never landed (released or expired) or a tracker code keeps the old
--     manual state. Its own failed, incomplete or expired probe makes it the opener, so the
--     09-10 contract (quiet periods, transient two-probe budget, single standby handoff,
--     manual terminal) applies from then on. A deliberate stop (mi_stop_naver_shopping_worker,
--     any reason), 'probe_security_block' and a live security cooldown never qualify, whatever
--     the column holds;
--   * security-scope Naver blocking codes keep the global cooldown path unchanged, and a
--     circuit episode the primary opened or joined keeps the existing behaviour unchanged.
-- The three re-declared function bodies carry the marker `mi:standby-failure-isolation`
-- (applied check: docs/sql/20260927120000_naver_shopping_standby_failure_isolation.verify-applied.sql;
-- rollback: docs/sql/20260927120000_naver_shopping_standby_failure_isolation.rollback.sql).
--
-- Standby-device codes = raised on the standby host itself (browser, extension, native host or
-- the device's own deadline), not a Naver response classification. Sources at commit d870bd8:
--   naver_page_navigation_failed        tools/naver-shopping-chrome-extension/service-worker.js
--                                       671-682 (chrome.tabs.create / tabs.update rejected; the tab
--                                       vanished while loading: tabs.get 569-571), 589 (tab left on
--                                       '' or chrome-error://), 696-697 (page-delay wait)
--   provider_deadline_exceeded          service-worker.js 664 and 667 (local collection deadline);
--                                       scripts/naver-shopping-native-host-core.mjs 75-81, 747;
--                                       tools/naver-shopping-rank-collector/src/provider.mjs 1868, 2078
--   provider_browser_collection_failed  service-worker.js 106-115, 693, 701 (untyped extension error)
--   provider_browser_launch_failed      provider.mjs 1794, 1812 (Playwright launch, direct standby path)
--   provider_browser_dependency_missing provider.mjs 1789, 1803 (Playwright not installed)
--   native_host_response_timeout        scripts/naver-shopping-native-host.mjs 197-199;
--                                       native-host-core.mjs 81 (extension did not answer the host)
--   native_host_input_closed            naver-shopping-native-host.mjs 194 (Chrome closed the pipe)
--   native_host_input_failed            naver-shopping-native-host.mjs 195
--   native_host_request_id_mismatch     native-host-core.mjs 52
--   native_host_page_delivery_failed    service-worker.js 689 (page hand-off to the host failed)
--   native_host_collection_failed       naver-shopping-native-host.mjs 247-248 (untyped extension error)
-- Global exactly as today (the evidence is a Naver page): naver_page_timeout,
-- naver_page_script_*, naver_next_data_*, naver_navigation_* mismatches, home / normal /
-- price_compare codes, native_host_page_invalid / rows_invalid / pages_*, provider_* proof
-- codes and local_worker_* codes. Naver blocking (scope 'security': naver_verification_required,
-- naver_network_restricted, naver_http_418 / 429 / 403, naver_captcha_detected,
-- naver_auth_required, naver_access_blocked) never reaches the isolation branch or the early
-- probe: the failure security branch plus the mi_block_naver_shopping_worker_lane global
-- cooldown (30 / 60 minutes, half_open -> open 'probe_security_block') are unchanged.
begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;

alter table public.naver_shopping_worker_coordination
  add column if not exists circuit_opened_by_worker text,
  add column if not exists standby_failure_worker_id text,
  add column if not exists standby_failure_streak integer not null default 0,
  add column if not exists standby_last_failure_at timestamptz,
  add column if not exists standby_last_failure_code text,
  add column if not exists standby_benched_until timestamptz;

alter table public.naver_shopping_worker_coordination
  drop constraint if exists naver_shopping_worker_coordination_standby_failure_streak_check;

alter table public.naver_shopping_worker_coordination
  add constraint naver_shopping_worker_coordination_standby_failure_streak_check
    check (standby_failure_streak between 0 and 1000);

create or replace function public.mi_record_naver_shopping_worker_failure(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_error_code text,
  p_scope text,
  p_tracker_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
-- mi:standby-failure-isolation 2026-09-27
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  normalized_error text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_error_code, '')));
  normalized_scope text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_scope, '')));
  next_signature text;
  next_streak integer;
  tracker_updated_count integer := 0;
  should_open boolean := false;
  partial_window_failure boolean := normalized_scope = 'tracker'
    and normalized_error ~ '^provider_partial_window:([1-9]|[1-9][0-9]|[12][0-9]{2})_300$';
  finite_failure boolean := normalized_scope = 'tracker'
    and normalized_error in (
      'provider_stable_finite_window_unproven',
      'local_worker_finite_match_invalid'
    );
  cadence_proof_preserved boolean := false;
  v_now timestamptz := clock_timestamp();
  -- 2026-09-27 standby failure isolation.
  failing_worker_id text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, '')));
  standby_host_local_failure boolean := false;
  standby_episode_continues boolean := false;
  next_standby_streak integer := 0;
  next_standby_benched_until timestamptz;
begin
  if p_run_id is null
    or normalized_error !~ '^[a-z0-9_:-]{3,80}$'
    or normalized_scope not in ('system', 'tracker', 'security', 'lookup')
    or (normalized_scope = 'tracker' and p_tracker_id is null)
    or (normalized_scope = 'lookup' and p_tracker_id is not null) then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'failure_invalid');
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
    and lease_worker_id = pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, '')))
    and lease_token = p_lane_token
    and run_id = p_run_id
    and lease_until > v_now
    and circuit_state <> 'open'
    and (normalized_scope <> 'lookup' or circuit_state = 'closed')
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'lease_lost');
  end if;

  -- F4: 수집 중 추적기 삭제·중지는 시스템 결함이 아니다.
  -- mi_commit_naver_shopping_* 은 (1) 추적기 행이 사라졌을 때와 (2) status 가
  -- 'active' 가 아닐 때 claim status 'lease_lost' 를 돌려주고, 워커는 그것을
  -- system 스코프 local_worker_lease_lost 로 올린다. 그대로 두면 사용자의 삭제·
  -- 중지 2건만으로 failure_streak 가 2 가 되어 회로가 open 되고, 그 서명은 자동
  -- half_open 목록에도 없어 사람이 수동 canary 를 돌릴 때까지 전 트래커가 멈춘다.
  -- 여기서는 그 두 경우만 tracker 스코프로 강등해 회로 서명에 쌓이지 않게 한다.
  -- 리스 만료·소유권 불일치(추적기가 그대로 active 인 경우)는 진짜 시스템 신호이
  -- 므로 강등하지 않고 기존 fail-closed 경로를 그대로 탄다. 자동 일시중지
  -- (rank-tracker-account-suspension.mjs) 가 리스 보유 행을 건너뛰는 것과 같은
  -- 기준(status='active' + 진행 중 여부)을 DB 쪽에서 마주 본다.
  if normalized_scope = 'system'
    and pg_catalog.split_part(normalized_error, ':', 1) = 'local_worker_lease_lost'
    and p_tracker_id is not null
    and not exists (
      select 1
      from public.naver_rank_trackers as lifecycle_tracker
      where lifecycle_tracker.id = p_tracker_id
        and lifecycle_tracker.status = 'active'
    ) then
    update public.naver_shopping_worker_coordination
    set last_failure_at = v_now,
        last_failure_code = normalized_error,
        current_stage = 'failed',
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        updated_at = v_now
    where lane_key = 'global';
    return pg_catalog.jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', false,
      'quarantined', false,
      'scopeDemoted', 'tracker_lifecycle'
    );
  end if;

  if normalized_scope = 'tracker' then
    update public.naver_rank_trackers
    set worker_quarantined_until = case
      when finite_failure
        and current_row.runtime_version is not null
        and current_row.runtime_fingerprint is not null
      then v_now + interval '30 minutes'
      when pg_catalog.split_part(normalized_error, ':', 1) in (
        'provider_duplicate_identity',
        'provider_stable_window_unproven',
        'provider_stable_rendered_order_unproven',
        'provider_rendered_order_candidate_invalid'
      ) then v_now + interval '30 minutes'
      else greatest(
        coalesce(worker_quarantined_until, v_now),
        v_now + case
          when coalesce(retry_count, 0) >= 2 then interval '24 hours'
          else interval '30 minutes'
        end
      )
    end
    where id = p_tracker_id;
    get diagnostics tracker_updated_count = row_count;

    cadence_proof_preserved := tracker_updated_count = 1
      and current_row.circuit_state = 'closed'
      and current_row.circuit_reason is null
      and current_row.cooldown_until is null
      and current_row.probe_tracker_id is null
      and current_row.probe_started_at is null
      and current_row.current_job_kind = 'tracker'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, '')))
        = 'windows-desktop-primary'
      and current_row.primary_worker_id = 'windows-desktop-primary'
      and current_row.primary_seen_at > v_now - interval '3 minutes'
      and (
        (current_row.cadence_mode = 'baseline' and current_row.cadence_minutes = 10)
        or (current_row.cadence_mode = 'candidate' and current_row.cadence_minutes = 6)
      )
      and current_row.stability_started_at is not null
      and current_row.success_streak >= 1
      and current_row.last_collection_id ~ '^pw-chrome-'
      and current_row.last_checked_count = 300
      and current_row.last_source = 'naver_shopping_results_collector'
      and current_row.runtime_version is not null
      and current_row.runtime_fingerprint is not null
      and (
        (
          partial_window_failure
          and current_row.current_page = 8
          and (
            current_row.current_stage = 'collecting'
            or (
              current_row.current_stage = 'failed'
              and current_row.last_failure_code = normalized_error
              and current_row.last_failure_at is not null
              and current_row.last_failure_at >= current_row.current_job_started_at
            )
          )
          and exists (
            select 1
            from public.naver_shopping_scheduler_events as failed_event
            join public.naver_shopping_scheduler_events as representative_claim
              on representative_claim.event_type = 'tracker_claimed'
             and representative_claim.run_id = failed_event.run_id
             and representative_claim.claim_id = failed_event.claim_id
             and representative_claim.group_fingerprint = failed_event.group_fingerprint
            join public.naver_shopping_worker_runs as runs
              on runs.run_id = failed_event.run_id
             and runs.worker_id = failed_event.worker_id
             and runs.runtime_version = current_row.runtime_version
             and runs.runtime_fingerprint = current_row.runtime_fingerprint
            where failed_event.event_type = 'job_failed'
              and failed_event.run_id = p_run_id
              and failed_event.worker_id = current_row.lease_worker_id
              and failed_event.tracker_id = p_tracker_id
              and failed_event.error_code = normalized_error
              and representative_claim.tracker_id = current_row.current_tracker_id
              and representative_claim.worker_id = current_row.lease_worker_id
          )
        )
        or (
          finite_failure
          and current_row.current_page between 1 and 8
          and (
            (
              current_row.current_stage = 'collecting'
              and normalized_error = 'provider_stable_finite_window_unproven'
            )
            or (
              current_row.current_stage = 'submitting'
              and normalized_error = 'local_worker_finite_match_invalid'
            )
            or (
              current_row.current_stage = 'failed'
              and current_row.last_failure_code = normalized_error
              and current_row.last_failure_at is not null
              and current_row.last_failure_at >= current_row.current_job_started_at
            )
          )
          and exists (
            select 1
            from public.naver_shopping_scheduler_events as failed_event
            join public.naver_shopping_scheduler_events as representative_claim
              on representative_claim.event_type = 'tracker_claimed'
             and representative_claim.run_id = failed_event.run_id
             and representative_claim.claim_id = failed_event.claim_id
             and representative_claim.group_fingerprint = failed_event.group_fingerprint
             and representative_claim.tracker_id = p_tracker_id
             and representative_claim.worker_id = failed_event.worker_id
             and representative_claim.event_id < failed_event.event_id
             and representative_claim.priority in ('new', 'resume', 'normal', 'repair')
            join public.naver_shopping_worker_runs as runs
              on runs.run_id = failed_event.run_id
             and runs.worker_id = failed_event.worker_id
             and runs.runtime_version = current_row.runtime_version
             and runs.runtime_fingerprint = current_row.runtime_fingerprint
            where failed_event.event_type = 'job_failed'
              and failed_event.run_id = p_run_id
              and failed_event.worker_id = current_row.lease_worker_id
              and failed_event.tracker_id = p_tracker_id
              and failed_event.error_code = normalized_error
              and (
                select count(*)
                from public.naver_shopping_scheduler_events as claimed
                where claimed.event_type = 'tracker_claimed'
                  and claimed.claim_id = representative_claim.claim_id
                  and claimed.tracker_id = p_tracker_id
              ) = 1
              and not exists (
                select 1
                from public.naver_shopping_scheduler_events as terminal
                where terminal.claim_id = representative_claim.claim_id
                  and terminal.tracker_id = p_tracker_id
                  and terminal.event_type in (
                    'tracker_committed',
                    'finite_window_committed'
                  )
              )
              and (
                select count(*)
                from public.naver_shopping_scheduler_events as finite_failed_count
                where finite_failed_count.event_type = 'job_failed'
                  and finite_failed_count.claim_id = representative_claim.claim_id
                  and finite_failed_count.run_id = p_run_id
                  and finite_failed_count.worker_id = current_row.lease_worker_id
                  and finite_failed_count.tracker_id = p_tracker_id
                  and finite_failed_count.error_code = normalized_error
              ) = 1
          )
        )
      );

    update public.naver_shopping_worker_coordination
    set last_failure_at = v_now,
        last_failure_code = normalized_error,
        current_stage = 'failed',
        cadence_mode = case
          when cadence_proof_preserved then current_row.cadence_mode
          else 'baseline'
        end,
        cadence_minutes = case
          when cadence_proof_preserved then current_row.cadence_minutes
          else 10
        end,
        stability_started_at = case
          when cadence_proof_preserved then current_row.stability_started_at
          else null
        end,
        success_streak = case
          when cadence_proof_preserved then current_row.success_streak
          else 0
        end,
        updated_at = v_now
    where lane_key = 'global';
    return pg_catalog.jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', false,
      'quarantined', true,
      'cadenceProofPreserved', cadence_proof_preserved
    );
  end if;

  if normalized_scope = 'security' then
    update public.naver_shopping_worker_coordination
    set last_failure_at = v_now,
        last_failure_code = normalized_error,
        current_stage = 'failed',
        stability_started_at = null,
        success_streak = 0,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        updated_at = v_now
    where lane_key = 'global';
    return pg_catalog.jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', false
    );
  end if;

  -- 2026-09-27 (KST 19:33-20:34): the primary was powered off; macbook-standby's collection
  -- profile had no normal Chrome window, so every chrome.tabs.create rejected in ~3 ms as
  -- naver_page_navigation_failed. Two standby-only failures opened the global circuit and
  -- the returning primary waited behind it. A standby-device failure (browser, extension,
  -- native host or the device's own deadline; code list and sources in the header of
  -- migration 20260927120000) reported by a worker that is not the registered primary is
  -- evidence about that standby host only: it never advances the global failure signature
  -- and never opens a closed circuit. It counts toward a standby-only bench instead (2 in
  -- one episode = 30 minutes, 3 or more = 60 minutes). Naver blocking codes are scope
  -- 'security' and keep the global cooldown (mi_block_naver_shopping_worker_lane) exactly
  -- as before; every other system code and every primary failure keeps the existing global
  -- circuit path unchanged.
  standby_host_local_failure := current_row.primary_worker_id is not null
    and failing_worker_id <> current_row.primary_worker_id
    and normalized_scope in ('system', 'lookup')
    and pg_catalog.split_part(normalized_error, ':', 1) in (
      'naver_page_navigation_failed',
      'provider_deadline_exceeded',
      'provider_browser_collection_failed',
      'provider_browser_launch_failed',
      'provider_browser_dependency_missing',
      'native_host_response_timeout',
      'native_host_input_closed',
      'native_host_input_failed',
      'native_host_request_id_mismatch',
      'native_host_page_delivery_failed',
      'native_host_collection_failed'
    );
  if standby_host_local_failure then
    -- One episode = consecutive standby-device failures by the same worker, less than 3
    -- hours apart, with no atomic success recorded after the previous one. A success does
    -- not lift an active bench; it only makes the next failure a new episode (streak 1).
    standby_episode_continues := current_row.standby_failure_worker_id is not distinct from failing_worker_id
      and current_row.standby_last_failure_at is not null
      and current_row.standby_last_failure_at > v_now - interval '3 hours'
      and (
        current_row.last_success_at is null
        or current_row.last_success_at <= current_row.standby_last_failure_at
      );
    next_standby_streak := case
      when standby_episode_continues
      then least(1000, current_row.standby_failure_streak + 1)
      else 1
    end;
    next_standby_benched_until := case
      when next_standby_streak >= 3 then v_now + interval '60 minutes'
      when next_standby_streak = 2 then v_now + interval '30 minutes'
      else null
    end;
  end if;

  if normalized_scope = 'lookup' then
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
        last_failure_at = v_now,
        last_failure_code = normalized_error,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        standby_failure_worker_id = case
          when standby_host_local_failure then failing_worker_id
          else standby_failure_worker_id
        end,
        standby_failure_streak = case
          when standby_host_local_failure then next_standby_streak
          else standby_failure_streak
        end,
        standby_last_failure_at = case
          when standby_host_local_failure then v_now
          else standby_last_failure_at
        end,
        standby_last_failure_code = case
          when standby_host_local_failure then normalized_error
          else standby_last_failure_code
        end,
        standby_benched_until = case
          when standby_host_local_failure then next_standby_benched_until
          else standby_benched_until
        end,
        updated_at = v_now
    where lane_key = 'global';
    return pg_catalog.jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', true,
      'quarantined', false
    );
  end if;

  -- Closed circuit + standby-device failure: give the lane back (as the lookup path does)
  -- without touching failure_signature / failure_streak / circuit_*. A half-open probe that
  -- fails still reopens the circuit below exactly as before (fail-closed).
  if standby_host_local_failure and current_row.circuit_state = 'closed' then
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
        last_failure_at = v_now,
        last_failure_code = normalized_error,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        standby_failure_worker_id = failing_worker_id,
        standby_failure_streak = next_standby_streak,
        standby_last_failure_at = v_now,
        standby_last_failure_code = normalized_error,
        standby_benched_until = next_standby_benched_until,
        updated_at = v_now
    where lane_key = 'global';
    return pg_catalog.jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', true,
      'standbyIsolated', true,
      'standbyFailureStreak', next_standby_streak,
      'standbyBenchedUntil', next_standby_benched_until
    );
  end if;

  next_signature := coalesce(nullif(current_row.current_stage, ''), 'unknown')
    || ':' || normalized_error;
  next_streak := case
    when current_row.failure_signature = next_signature
      then least(100000, current_row.failure_streak + 1)
    else 1
  end;
  should_open := current_row.circuit_state = 'half_open' or next_streak >= 2;

  update public.naver_shopping_worker_coordination
  set failure_signature = next_signature,
      failure_streak = next_streak,
      last_failure_at = v_now,
      last_failure_code = normalized_error,
      current_stage = 'failed',
      circuit_state = case when should_open then 'open' else circuit_state end,
      circuit_reason = case when should_open then next_signature else circuit_reason end,
      circuit_opened_at = case when should_open then v_now else circuit_opened_at end,
      -- 2026-09-27: a closed -> open failure stamps the worker that started this circuit
      -- episode. A failed half-open probe hands it to the registered primary only when the
      -- primary held the probe; a standby's failed probe keeps it (claim reads it).
      circuit_opened_by_worker = case
        when not should_open then circuit_opened_by_worker
        when current_row.circuit_state = 'closed' then failing_worker_id
        when failing_worker_id = current_row.primary_worker_id then failing_worker_id
        else circuit_opened_by_worker
      end,
      probe_started_at = case when should_open then null else probe_started_at end,
      lease_worker_id = case when should_open then null else lease_worker_id end,
      lease_token = case when should_open then null else lease_token end,
      lease_until = case when should_open then null else lease_until end,
      run_id = case when should_open then null else run_id end,
      current_job_kind = case when should_open then null else current_job_kind end,
      current_tracker_id = case when should_open then null else current_tracker_id end,
      current_job_started_at = case when should_open then null else current_job_started_at end,
      cadence_mode = 'baseline',
      cadence_minutes = 10,
      stability_started_at = null,
      success_streak = 0,
      standby_failure_worker_id = case
        when standby_host_local_failure then failing_worker_id
        else standby_failure_worker_id
      end,
      standby_failure_streak = case
        when standby_host_local_failure then next_standby_streak
        else standby_failure_streak
      end,
      standby_last_failure_at = case
        when standby_host_local_failure then v_now
        else standby_last_failure_at
      end,
      standby_last_failure_code = case
        when standby_host_local_failure then normalized_error
        else standby_last_failure_code
      end,
      standby_benched_until = case
        when standby_host_local_failure then next_standby_benched_until
        else standby_benched_until
      end,
      updated_at = v_now
  where lane_key = 'global';

  return pg_catalog.jsonb_build_object(
    'recorded', true,
    'circuitState', case when should_open then 'open' else current_row.circuit_state end,
    'failureStreak', next_streak,
    'laneReleased', should_open
  );
end;
$$;

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
  -- names the worker whose failure opened the circuit from closed; it survives open ->
  -- half_open, and it becomes the registered primary as soon as a half-open probe the primary
  -- held fails, is released incomplete or expires (failure, release and the expiry below). On
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
        -- 2026-09-27: an expired probe the registered primary held makes the primary the opener.
        circuit_opened_by_worker = case
          when current_row.lease_worker_id = current_row.primary_worker_id
          then current_row.lease_worker_id
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

create or replace function public.mi_release_naver_shopping_worker_lane(
  p_worker_id text,
  p_lease_token uuid
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
-- mi:standby-failure-isolation 2026-09-27
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
      'local_worker_window_not_300',
      'local_worker_match_result_incomplete',
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
      'local_worker_window_not_300',
      'local_worker_match_result_incomplete',
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
      -- 2026-09-27: a probe the registered primary released incomplete makes the primary the
      -- opener; a probe that recovers the circuit closes the episode and clears it.
      circuit_opened_by_worker = case
        when auto_recovery_no_work then current_row.circuit_opened_by_worker
        when auto_navigation_recovered then null
        when transient_system_recovered then null
        when current_row.circuit_state = 'half_open'
          and current_row.lease_worker_id = current_row.primary_worker_id
        then current_row.lease_worker_id
        else current_row.circuit_opened_by_worker
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

revoke all on function public.mi_claim_naver_shopping_worker_lane(
  text, text, uuid, integer, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_worker_lane(
  text, text, uuid, integer, integer, text, text
) to service_role;

revoke all on function public.mi_record_naver_shopping_worker_failure(
  text, uuid, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_record_naver_shopping_worker_failure(
  text, uuid, uuid, text, text, uuid
) to service_role;

revoke all on function public.mi_release_naver_shopping_worker_lane(text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.mi_release_naver_shopping_worker_lane(text, uuid)
to service_role;

commit;

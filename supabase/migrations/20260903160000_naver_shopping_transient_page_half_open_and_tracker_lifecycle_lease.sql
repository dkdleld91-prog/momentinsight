-- 묶음 2차-5 (F3·F4): 일시 장애가 영구 정지로 승격되는 회로 문제.
--
-- F3 자동 복구 허용 코드 확장 — 20260821180001 의 transient-system half_open
-- 목록은 6개 코드만 담고 있어, 일시적인 네이버 오류 페이지가 2회 연속이면
-- 회로가 open 된 채 자동 복구 대상에서 빠져 사람이 수동 canary 를 돌릴 때까지
-- 전 트래커가 멈춘다. 재시도로 풀리는 성격이 확인된 페이지·읽기 계열 4개를
-- 같은 규약(primary 전용 · 30분 정적 · 최대 2회 프로브 · 쿨다운 불변)으로
-- 추가한다. 보안 차단(naver_http_403/418/429, captcha, auth, access_blocked,
-- verification, network_restricted)과 드리프트(naver_selector_drift,
-- naver_next_data_schema_drift, naver_next_data_rank_drift)는 재시도로 풀리지
-- 않으므로 그대로 제외한다.
--   naver_next_data_missing            service-worker.js:594 — 보안·차단 검사를
--     모두 통과한 뒤 __NEXT_DATA__ 만 비어 있는 렌더 누락. 재적재로 풀린다.
--   naver_page_script_failed           service-worker.js:654 — executeScript 단계
--     실패(탭 소실·크래시·이동 중). 이미 허용된 naver_page_script_timeout 의 형제.
--   naver_page_read_state_unstable     마지막 읽기 상태 "유실"(docs/WORK_STATUS.md).
--   naver_page_navigation_result_missing 이동 결과 "유실"(같은 문서). 이미 자동
--     복구되는 naver_page_navigation_failed 의 형제이며 거절이 아니라 유실이다.
--
-- F4 추적기 생애주기 lease 상실 강등 — 수집 중 삭제·중지가 system 스코프
-- local_worker_lease_lost 로 집계돼 연속 2회면 회로가 열리고 자동 복구도 안 된다.
-- 서버 삭제 경로(잠금된 naver-rank-trackers.mjs)를 건드리지 않고 DB 기록 함수에서
-- 그 두 경우만 tracker 스코프로 강등한다.
--
-- 런타임 결합 제거 — 재선언하는 mi_record_naver_shopping_worker_failure 에서
-- 1.1.21 버전·지문 리터럴을 없애고 20260903113000 과 같은 방식(레인이 등록한
-- 값이 null 이 아닌가 / coordination 현재값과 같은가)으로 바꾼다. 계정우선 코호트
-- 정합성은 mi_enqueue_* 의 required_runtime_* 동등 검사가 그대로 지킨다.
--
-- 되돌리기: 20260821180001 의 mi_claim_naver_shopping_worker_lane 과
-- 20260903090000 의 mi_record_naver_shopping_worker_failure 원본 블록을 다시 실행.

begin;

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

revoke all on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer)
from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer)
to service_role;

revoke all on function public.mi_record_naver_shopping_worker_failure(
  text, uuid, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_record_naver_shopping_worker_failure(
  text, uuid, uuid, text, text, uuid
) to service_role;

commit;

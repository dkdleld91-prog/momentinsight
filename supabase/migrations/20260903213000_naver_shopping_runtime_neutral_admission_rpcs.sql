-- 런타임 리터럴 중립화 — 수집 제어면 RPC 3종 (2026-09-03)
--
-- 배경: 20260831100525 의 account-priority 트리거 게이트가 런타임 '1.1.20' 과
--   그 지문을 리터럴로 검사해, 1.1.21 인상 직후 모든 수집 클레임이 P0001 로
--   거부되며 약 2시간 수집이 멈췄다(20260903113000 으로 게이트만 중립화).
--   같은 계열 리터럴이 아래 세 RPC 에 남아 있어 다음 런타임 인상 때
--   "계정 우선 등록 불가 / 후보 케이던스 승격 영구 불가" 로 재발한다.
--
-- 이 마이그레이션이 하는 일(계약 유지, 로직 변경 없음):
--   1) public.mi_enqueue_naver_shopping_account_priority
--      호출자가 넘긴 런타임 버전·지문에 대한 '1.1.21' / 고정 지문 동등 검사를
--      형식 검사(semver / 64자리 소문자 hex)로 교체한다.  "현재 런타임이어야
--      한다"는 계약은 바로 뒤의 coordination 현재값 동등 검사
--      (current_row.runtime_version is distinct from v_expected_runtime_version)
--      가 그대로 지키므로 강도가 떨어지지 않는다.
--   2) public.mi_set_naver_shopping_worker_cadence
--   3) public.mi_get_naver_shopping_worker_operations
--      후보 케이던스 승격 자격의 runtime 동등 검사를 coordination 현재값의
--      형식 검사로 교체한다.  coordination.runtime_version/fingerprint 를 쓰는
--      함수는 mi_report_naver_shopping_worker_progress 하나뿐이고, 그 함수가
--      현재 EXPECTED 런타임만 기록하므로 이 두 곳의 리터럴은 중복이었다.
--      런타임이 바뀌면 progress 가 cadence_mode/stability_started_at/
--      success_streak 를 초기화하므로 24시간 안정 재적립 요건도 그대로다.
--
-- 의도적으로 바꾸지 않는 것:
--   public.mi_report_naver_shopping_worker_progress 는 "어떤 런타임을 승인할
--   것인가"를 정의하는 입구 게이트라 버전 고정이 설계 그 자체다.  런타임 인상
--   마이그레이션이 매번 이 함수를 재선언해 값을 올린다.
--
-- 설치 가드가 유휴 상태를 요구하지 않는 이유: 함수 재선언뿐이라 진행 중인
--   수집을 멈출 필요가 없고, 사고 중에도 적용 가능해야 한다.  lock_timeout 으로
--   실패를 빠르게 만든다.

begin;

set local lock_timeout = '5s';

do $migration_guard$
begin
  if pg_catalog.to_regprocedure(
      'public.mi_enqueue_naver_shopping_account_priority(uuid, text, integer, text, text, text)'
    ) is null
    or pg_catalog.to_regprocedure(
      'public.mi_set_naver_shopping_worker_cadence(text)'
    ) is null
    or pg_catalog.to_regprocedure(
      'public.mi_get_naver_shopping_worker_operations()'
    ) is null then
    raise exception
      'naver_shopping_runtime_neutral_admission_requires_existing_rpcs';
  end if;

  if not exists (
    select 1
    from public.naver_shopping_worker_coordination
    where lane_key = 'global'
  ) then
    raise exception
      'naver_shopping_runtime_neutral_admission_requires_coordination';
  end if;
end;
$migration_guard$;

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
    or v_expected_runtime_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    or v_expected_runtime_fingerprint !~ '^[a-f0-9]{64}$' then
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
      and request.required_runtime_version = v_expected_runtime_version
      and request.required_runtime_fingerprint =
        v_expected_runtime_fingerprint
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

create or replace function public.mi_set_naver_shopping_worker_cadence(
  p_mode text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_mode text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_mode, '')));
  current_row public.naver_shopping_worker_coordination%rowtype;
  processing_count integer := 0;
  updated_count integer := 0;
  eligible boolean := false;
  v_now timestamptz;
begin
  if normalized_mode not in ('baseline', 'candidate') then
    return pg_catalog.jsonb_build_object('accepted', false, 'reason', 'mode_invalid');
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  v_now := clock_timestamp();

  select (
    (select count(*) from public.naver_shopping_rank_lookup_jobs
      where status = 'processing' and processing_until > v_now)
    +
    (select count(*) from public.naver_rank_trackers
      where status = 'active' and processing_until > v_now)
  )::integer into processing_count;

  if normalized_mode = 'baseline' then
    update public.naver_shopping_worker_coordination
    set cadence_mode = 'baseline', cadence_minutes = 10, updated_at = v_now
    where lane_key = 'global';
    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      return pg_catalog.jsonb_build_object(
        'accepted', false,
        'activated', false,
        'reason', 'coordination_missing',
        'mode', null,
        'minutes', null
      );
    end if;
    select * into current_row
    from public.naver_shopping_worker_coordination
    where lane_key = 'global';
    if current_row.cadence_mode is distinct from 'baseline'
      or current_row.cadence_minutes is distinct from 10 then
      return pg_catalog.jsonb_build_object(
        'accepted', false,
        'activated', false,
        'reason', 'baseline_postcheck_failed',
        'mode', current_row.cadence_mode,
        'minutes', current_row.cadence_minutes
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', true,
      'activated', true,
      'mode', 'baseline',
      'minutes', 10
    );
  end if;

  eligible := coalesce((
    current_row.circuit_state = 'closed'
    and current_row.circuit_reason is null
    and processing_count = 0
    and current_row.lease_worker_id is null
    and current_row.lease_token is null
    and current_row.lease_until is null
    and current_row.run_id is null
    and current_row.current_stage is null
    and current_row.current_page = 0
    and current_row.current_job_kind is null
    and current_row.current_tracker_id is null
    and current_row.current_job_started_at is null
    and current_row.probe_started_at is null
    and current_row.probe_tracker_id is null
    and current_row.cooldown_until is null
    and current_row.primary_worker_id = 'windows-desktop-primary'
    and current_row.primary_seen_at > v_now - interval '3 minutes'
    and current_row.cadence_mode = 'baseline'
    and current_row.cadence_minutes = 10
    and current_row.stability_started_at is not null
    and current_row.stability_started_at <= v_now - interval '24 hours'
    and current_row.success_streak >= 6
    and current_row.last_success_at is not null
    and current_row.last_success_at > v_now - interval '15 minutes'
    and current_row.runtime_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    and current_row.runtime_fingerprint ~ '^[a-f0-9]{64}$'
    and current_row.last_collection_id ~ '^pw-chrome-'
    and current_row.last_checked_count = 300
    and current_row.last_source = 'naver_shopping_results_collector'
  ), false);
  if eligible is not true then
    return pg_catalog.jsonb_build_object(
      'accepted', false,
      'activated', false,
      'reason', 'not_eligible',
      'mode', current_row.cadence_mode,
      'minutes', current_row.cadence_minutes
    );
  end if;

  update public.naver_shopping_worker_coordination
  set cadence_mode = 'candidate', cadence_minutes = 6, updated_at = v_now
  where lane_key = 'global';
  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'activated', true,
    'mode', 'candidate',
    'minutes', 6
  );
end;
$$;

create or replace function public.mi_get_naver_shopping_worker_operations()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  lookup_pending_count integer := 0;
  tracker_pending_count integer := 0;
  processing_count integer := 0;
  lookup_oldest_at timestamptz;
  tracker_oldest_at timestamptz;
  canary_tracker_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global';

  select count(*)::integer, min(available_at)
  into lookup_pending_count, lookup_oldest_at
  from public.naver_shopping_rank_lookup_jobs
  where expires_at > v_now
    and attempts < 3
    and (
      (status = 'pending' and available_at <= v_now)
      or (status = 'processing' and processing_until <= v_now)
    );

  select count(*)::integer, min(next_check_at)
  into tracker_pending_count, tracker_oldest_at
  from public.naver_rank_trackers
  where status = 'active'
    and next_check_at <= v_now
    and (processing_until is null or processing_until <= v_now)
    and (worker_quarantined_until is null or worker_quarantined_until <= v_now);

  select (
    (select count(*) from public.naver_shopping_rank_lookup_jobs
      where status = 'processing' and processing_until > v_now)
    +
    (select count(*) from public.naver_rank_trackers
      where status = 'active' and processing_until > v_now)
  )::integer into processing_count;

  select id into canary_tracker_id
  from public.naver_rank_trackers
  where status = 'active'
    and pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(keyword)), '\s+', '', 'g'
    ) = '남자팬티'
    and product_id = '12491798995'
  order by created_at asc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'circuit_state', current_row.circuit_state,
    'circuit_reason', current_row.circuit_reason,
    'circuit_opened_at', current_row.circuit_opened_at,
    'failure_signature', current_row.failure_signature,
    'failure_streak', current_row.failure_streak,
    'transient_system_probe_attempts', current_row.transient_system_probe_attempts,
    'probe_tracker_id', current_row.probe_tracker_id,
    'probe_started_at', current_row.probe_started_at,
    'primary_worker_id', current_row.primary_worker_id,
    'primary_seen_at', current_row.primary_seen_at,
    'lease_worker_id', current_row.lease_worker_id,
    'lease_until', current_row.lease_until,
    'cooldown_until', current_row.cooldown_until,
    'last_block_code', current_row.last_block_code,
    'run_id', current_row.run_id,
    'runtime_version', current_row.runtime_version,
    'runtime_fingerprint', current_row.runtime_fingerprint,
    'current_stage', current_row.current_stage,
    'current_page', current_row.current_page,
    'current_job_kind', current_row.current_job_kind,
    'current_tracker_id', current_row.current_tracker_id,
    'current_job_started_at', current_row.current_job_started_at,
    'last_success_at', current_row.last_success_at,
    'last_failure_at', current_row.last_failure_at,
    'last_failure_code', current_row.last_failure_code,
    'last_collection_id', current_row.last_collection_id,
    'last_checked_count', current_row.last_checked_count,
    'last_excluded_ad_count', current_row.last_excluded_ad_count,
    'last_duration_ms', current_row.last_duration_ms,
    'last_source', current_row.last_source,
    'scheduler_urgent_streak', current_row.scheduler_urgent_streak,
    'scheduler_last_agency_code', current_row.scheduler_last_agency_code,
    'cadence_mode', current_row.cadence_mode,
    'cadence_minutes', current_row.cadence_minutes,
    'stability_started_at', current_row.stability_started_at,
    'success_streak', current_row.success_streak,
    'candidate_eligible', coalesce((
      current_row.circuit_state = 'closed'
      and current_row.circuit_reason is null
      and processing_count = 0
      and current_row.lease_worker_id is null
      and current_row.lease_token is null
      and current_row.lease_until is null
      and current_row.run_id is null
      and current_row.current_stage is null
      and current_row.current_page = 0
      and current_row.current_job_kind is null
      and current_row.current_tracker_id is null
      and current_row.current_job_started_at is null
      and current_row.probe_started_at is null
      and current_row.probe_tracker_id is null
      and current_row.cooldown_until is null
      and current_row.primary_worker_id = 'windows-desktop-primary'
      and current_row.primary_seen_at > v_now - interval '3 minutes'
      and current_row.cadence_mode = 'baseline'
      and current_row.cadence_minutes = 10
      and current_row.stability_started_at is not null
      and current_row.stability_started_at <= v_now - interval '24 hours'
      and current_row.success_streak >= 6
      and current_row.last_success_at is not null
      and current_row.last_success_at > v_now - interval '15 minutes'
      and current_row.runtime_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
      and current_row.runtime_fingerprint ~ '^[a-f0-9]{64}$'
      and current_row.last_collection_id ~ '^pw-chrome-'
      and current_row.last_checked_count = 300
      and current_row.last_source = 'naver_shopping_results_collector'
    ), false),
    'canary_tracker_id', canary_tracker_id,
    'pending_count', lookup_pending_count + tracker_pending_count,
    'lookup_pending_count', lookup_pending_count,
    'tracker_pending_count', tracker_pending_count,
    'processing_count', processing_count,
    'oldest_pending_at', case
      when lookup_oldest_at is null then tracker_oldest_at
      when tracker_oldest_at is null then lookup_oldest_at
      else least(lookup_oldest_at, tracker_oldest_at)
    end
  );
end;
$$;

revoke all on function public.mi_enqueue_naver_shopping_account_priority(
  uuid, text, integer, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_enqueue_naver_shopping_account_priority(
  uuid, text, integer, text, text, text
) to service_role;

revoke all on function public.mi_set_naver_shopping_worker_cadence(text)
from public, anon, authenticated, service_role;
grant execute on function public.mi_set_naver_shopping_worker_cadence(text)
to service_role;

revoke all on function public.mi_get_naver_shopping_worker_operations()
from public, anon, authenticated, service_role;
grant execute on function public.mi_get_naver_shopping_worker_operations()
to service_role;

commit;

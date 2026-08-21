begin;

-- Runtime 1.1.10 keeps the stable full-window and atomic submission gates while
-- pinning the changed service-worker and local-worker runtime bytes.
-- Keep progress and cadence fail-closed so an older runtime cannot claim readiness.
update public.naver_shopping_worker_coordination
set cadence_mode = 'baseline',
    cadence_minutes = 10,
    stability_started_at = null,
    success_streak = 0,
    updated_at = clock_timestamp()
where lane_key = 'global';

create or replace function public.mi_report_naver_shopping_worker_progress(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_stage text,
  p_page integer,
  p_job_kind text,
  p_tracker_id uuid,
  p_runtime_version text,
  p_runtime_fingerprint text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_count integer := 0;
  normalized_stage text := lower(trim(coalesce(p_stage, '')));
  normalized_kind text := nullif(lower(trim(coalesce(p_job_kind, ''))), '');
  v_now timestamptz := clock_timestamp();
begin
  if p_run_id is null
    or normalized_stage not in ('claiming', 'navigating', 'collecting', 'submitting', 'completed', 'failed')
    or coalesce(p_page, -1) not between 0 and 8
    or (normalized_kind is not null and normalized_kind not in ('lookup', 'tracker'))
    or trim(coalesce(p_runtime_version, '')) <> '1.1.10'
    or lower(trim(coalesce(p_runtime_fingerprint, ''))) !~ '^[a-f0-9]{64}$'
    or lower(trim(coalesce(p_runtime_fingerprint, ''))) = repeat('0', 64) then
    return false;
  end if;

  update public.naver_shopping_worker_coordination
  set cadence_mode = case
        when runtime_version is distinct from trim(p_runtime_version)
          or runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))
        then 'baseline'
        else cadence_mode
      end,
      cadence_minutes = case
        when runtime_version is distinct from trim(p_runtime_version)
          or runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))
        then 10
        else cadence_minutes
      end,
      stability_started_at = case
        when runtime_version is distinct from trim(p_runtime_version)
          or runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))
        then null
        else stability_started_at
      end,
      success_streak = case
        when runtime_version is distinct from trim(p_runtime_version)
          or runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))
        then 0
        else success_streak
      end,
      run_id = p_run_id,
      runtime_version = trim(p_runtime_version),
      runtime_fingerprint = lower(trim(p_runtime_fingerprint)),
      current_stage = normalized_stage,
      current_page = p_page,
      current_job_kind = normalized_kind,
      current_tracker_id = p_tracker_id,
      current_job_started_at = coalesce(current_job_started_at, v_now),
      updated_at = v_now
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lane_token
    and lease_until > v_now
    and circuit_state <> 'open'
    and (run_id is null or run_id = p_run_id);
  get diagnostics updated_count = row_count;
  return updated_count = 1;
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
    and ((status = 'pending' and available_at <= v_now)
      or (status = 'processing' and processing_until <= v_now));

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
    and regexp_replace(lower(trim(keyword)), '\s+', '', 'g') = '남자팬티'
    and product_id = '12491798995'
  order by created_at asc
  limit 1;

  return jsonb_build_object(
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
    'candidate_eligible', coalesce((current_row.circuit_state = 'closed'
      and processing_count = 0
      and current_row.stability_started_at is not null
      and current_row.stability_started_at <= v_now - interval '24 hours'
      and current_row.success_streak >= 6
      and current_row.runtime_version = '1.1.10'
      and current_row.runtime_fingerprint ~ '^[a-f0-9]{64}$'
      and current_row.runtime_fingerprint <> repeat('0', 64)
      and current_row.last_collection_id ~ '^pw-chrome-'
      and current_row.last_checked_count = 300
      and current_row.last_source = 'naver_shopping_results_collector'), false),
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

create or replace function public.mi_set_naver_shopping_worker_cadence(
  p_mode text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_mode text := lower(trim(coalesce(p_mode, '')));
  current_row public.naver_shopping_worker_coordination%rowtype;
  processing_count integer := 0;
  eligible boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if normalized_mode not in ('baseline', 'candidate') then
    return jsonb_build_object('accepted', false, 'reason', 'mode_invalid');
  end if;
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

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
    return jsonb_build_object('accepted', true, 'activated', true, 'mode', 'baseline', 'minutes', 10);
  end if;

  eligible := coalesce((current_row.circuit_state = 'closed'
    and processing_count = 0
    and (current_row.lease_until is null or current_row.lease_until <= v_now)
    and (current_row.cooldown_until is null or current_row.cooldown_until <= v_now)
    and current_row.stability_started_at is not null
    and current_row.stability_started_at <= v_now - interval '24 hours'
    and current_row.success_streak >= 6
    and current_row.runtime_version = '1.1.10'
    and current_row.runtime_fingerprint ~ '^[a-f0-9]{64}$'
    and current_row.runtime_fingerprint <> repeat('0', 64)
    and current_row.last_collection_id ~ '^pw-chrome-'
    and current_row.last_checked_count = 300
    and current_row.last_source = 'naver_shopping_results_collector'), false);
  if eligible is not true then
    return jsonb_build_object(
      'accepted', false,
      'activated', false,
      'reason', 'not_eligible',
      'mode', current_row.cadence_mode,
      'minutes', current_row.cadence_minutes
    );
  end if;
  update public.naver_shopping_worker_coordination
  set cadence_mode = 'candidate', cadence_minutes = 8, updated_at = v_now
  where lane_key = 'global';
  return jsonb_build_object('accepted', true, 'activated', true, 'mode', 'candidate', 'minutes', 8);
end;
$$;

revoke all on function public.mi_report_naver_shopping_worker_progress(text, uuid, uuid, text, integer, text, uuid, text, text)
from public, anon, authenticated, service_role;
revoke all on function public.mi_get_naver_shopping_worker_operations()
from public, anon, authenticated, service_role;
revoke all on function public.mi_set_naver_shopping_worker_cadence(text)
from public, anon, authenticated, service_role;

grant execute on function public.mi_report_naver_shopping_worker_progress(text, uuid, uuid, text, integer, text, uuid, text, text) to service_role;
grant execute on function public.mi_get_naver_shopping_worker_operations() to service_role;
grant execute on function public.mi_set_naver_shopping_worker_cadence(text) to service_role;
commit;

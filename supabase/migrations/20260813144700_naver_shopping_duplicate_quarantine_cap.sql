begin;

-- A moving search boundary is a transient keyword-level collection failure.
-- Retrying it after one bounded 30-minute pause is sufficient; the generic
-- retry counter must not expand this specific failure to a 24-hour quarantine.
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
  normalized_error text := lower(trim(coalesce(p_error_code, '')));
  normalized_scope text := lower(trim(coalesce(p_scope, '')));
  next_signature text;
  next_streak integer;
  should_open boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_run_id is null
    or normalized_error !~ '^[a-z0-9_:-]{3,80}$'
    or normalized_scope not in ('system', 'tracker', 'security')
    or (normalized_scope = 'tracker' and p_tracker_id is null) then
    return jsonb_build_object('recorded', false, 'reason', 'failure_invalid');
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

  if normalized_scope = 'tracker' then
    update public.naver_rank_trackers
    set worker_quarantined_until = case
      when split_part(normalized_error, ':', 1) = 'provider_duplicate_identity'
        then v_now + interval '30 minutes'
      else greatest(
        coalesce(worker_quarantined_until, v_now),
        v_now + case
          when coalesce(retry_count, 0) >= 2 then interval '24 hours'
          else interval '30 minutes'
        end
      )
    end
    where id = p_tracker_id;
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
    return jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', false,
      'quarantined', true
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
    return jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', false
    );
  end if;

  next_signature := coalesce(nullif(current_row.current_stage, ''), 'unknown') || ':' || normalized_error;
  next_streak := case
    when current_row.failure_signature = next_signature then least(100000, current_row.failure_streak + 1)
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

  return jsonb_build_object(
    'recorded', true,
    'circuitState', case when should_open then 'open' else current_row.circuit_state end,
    'failureStreak', next_streak,
    'laneReleased', should_open
  );
end;
$$;

revoke all on function public.mi_record_naver_shopping_worker_failure(text, uuid, uuid, text, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.mi_record_naver_shopping_worker_failure(text, uuid, uuid, text, text, uuid)
to service_role;

-- Repair only the currently active duplicate-identity pause. The trigger may
-- advance updated_at for this row, but rank/history, retry count, queue order,
-- durable-cycle ownership and cursor fields remain untouched.
do $$
declare
  v_now timestamptz := clock_timestamp();
begin
  update public.naver_rank_trackers
  set worker_quarantined_until = greatest(v_now, updated_at + interval '30 minutes')
  where status = 'active'
    and worker_quarantined_until > v_now
    and lower(trim(coalesce(last_error, ''))) ~ '^provider_duplicate_identity(?::|$)'
    and worker_quarantined_until > greatest(v_now, updated_at + interval '30 minutes');
end;
$$;

commit;

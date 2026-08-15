begin;

-- A two-pass stability proof mismatch is transient and keyword-scoped. Keep
-- the durable cursor unchanged and retry that tracker after exactly 30 minutes
-- instead of escalating it to a 24-hour pause or the global circuit.
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
      when split_part(normalized_error, ':', 1) in (
        'provider_duplicate_identity',
        'provider_stable_window_unproven'
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

-- If the navigation half-open reached a complete two-pass validation decision,
-- navigation itself recovered. Preserve the tracker retry while closing only
-- the navigation circuit so the durable cursor can continue.
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
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lease_token
  for update;
  if not found then return false; end if;

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
        when auto_navigation_recovered then 'closed'
        when current_row.circuit_state = 'half_open' then 'open'
        else current_row.circuit_state
      end,
      circuit_reason = case
        when auto_navigation_recovered then null
        when current_row.circuit_state = 'half_open' then 'probe_incomplete'
        else current_row.circuit_reason
      end,
      circuit_opened_at = case
        when auto_navigation_recovered then null
        when current_row.circuit_state = 'half_open' then v_now
        else current_row.circuit_opened_at
      end,
      failure_signature = case
        when auto_navigation_recovered then null
        else current_row.failure_signature
      end,
      failure_streak = case
        when auto_navigation_recovered then 0
        else current_row.failure_streak
      end,
      probe_tracker_id = case
        when auto_navigation_recovered then null
        else current_row.probe_tracker_id
      end,
      probe_started_at = case
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

revoke all on function public.mi_release_naver_shopping_worker_lane(text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.mi_release_naver_shopping_worker_lane(text, uuid)
to service_role;

commit;

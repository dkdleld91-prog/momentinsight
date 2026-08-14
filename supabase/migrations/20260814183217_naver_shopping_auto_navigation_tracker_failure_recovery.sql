begin;

-- A tracker-scoped failure after an automatic navigation half-open proves that
-- Chrome navigation itself recovered. Keep the tracker failure/quarantine, but
-- close only the navigation circuit so the next durable-cycle item can run.
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

-- Repair only the exact live state produced before this release: navigation
-- already reached a tracker-scoped provider decision, so retaining an open
-- navigation circuit would be false. No tracker, cursor, quarantine, or wake is
-- changed.
update public.naver_shopping_worker_coordination
set circuit_state = 'closed',
    circuit_reason = null,
    circuit_opened_at = null,
    failure_signature = null,
    failure_streak = 0,
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
    updated_at = clock_timestamp()
where lane_key = 'global'
  and circuit_state = 'open'
  and circuit_reason = 'probe_incomplete'
  and split_part(lower(trim(coalesce(last_failure_code, ''))), ':', 1) in (
    'local_worker_submit_body_too_large',
    'provider_duplicate_identity',
    'provider_partial_window',
    'provider_row_invalid',
    'provider_row_title_missing',
    'provider_row_identity_missing'
  )
  and primary_seen_at > clock_timestamp() - interval '5 minutes'
  and last_failure_at > clock_timestamp() - interval '1 day';

commit;

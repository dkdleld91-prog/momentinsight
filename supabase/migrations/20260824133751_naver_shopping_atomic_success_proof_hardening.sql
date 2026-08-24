-- N Shopping atomic success proof hardening.
-- A cadence success must be backed by the immutable group/claim/commit ledger
-- and by the matching organic, ad-excluded 300-item snapshots. Candidate
-- freshness is evaluated only after the shared coordination row is locked.

begin;

create or replace function public.mi_record_naver_shopping_worker_success(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_tracker_id uuid,
  p_collection_id text,
  p_checked_count integer,
  p_excluded_ad_count integer,
  p_duration_ms integer,
  p_source text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  normalized_collection_id text := trim(coalesce(p_collection_id, ''));
  v_now timestamptz;
  next_success_streak integer;
  next_stability_started_at timestamptz;
  representative_commit_count integer := 0;
  group_claim_count integer := 0;
  tracker_claim_count integer := 0;
  committed_count integer := 0;
  invalid_proof_count integer := 0;
  group_claim_id uuid;
  expected_group_fingerprint text;
begin
  if p_run_id is null
    or p_tracker_id is null
    or normalized_collection_id !~ '^pw-chrome-'
    or p_checked_count is distinct from 300
    or coalesce(p_excluded_ad_count, -1) < 0
    or coalesce(p_duration_ms, -1) not between 0 and 3600000
    or lower(trim(coalesce(p_source, ''))) <> 'naver_shopping_results_collector' then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_proof_invalid');
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  v_now := clock_timestamp();

  if not found
    or current_row.lease_worker_id is distinct from lower(trim(coalesce(p_worker_id, '')))
    or current_row.lease_token is distinct from p_lane_token
    or current_row.run_id is distinct from p_run_id
    or current_row.lease_until is null
    or current_row.lease_until <= v_now
    or current_row.circuit_state = 'open' then
    return jsonb_build_object('recorded', false, 'reason', 'lease_lost');
  end if;

  if current_row.current_job_kind is distinct from 'tracker'
    or current_row.current_tracker_id is distinct from p_tracker_id then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_current_job_mismatch');
  end if;

  if current_row.circuit_state = 'half_open'
    and current_row.circuit_reason is distinct from 'auto_navigation_probe'
    and current_row.circuit_reason is distinct from 'auto_transient_system_probe'
    and current_row.probe_tracker_id is distinct from p_tracker_id then
    return jsonb_build_object('recorded', false, 'reason', 'probe_mismatch');
  end if;
  if current_row.circuit_state = 'half_open'
    and current_row.circuit_reason in ('auto_navigation_probe', 'auto_transient_system_probe')
    and (current_row.probe_tracker_id is not null or p_tracker_id is null) then
    return jsonb_build_object('recorded', false, 'reason', 'probe_mismatch');
  end if;

  select count(*)::integer
  into representative_commit_count
  from public.naver_shopping_scheduler_events as committed
  where committed.event_type = 'tracker_committed'
    and committed.run_id = p_run_id
    and committed.worker_id = current_row.lease_worker_id
    and committed.tracker_id = p_tracker_id
    and committed.collection_id = normalized_collection_id
    and committed.checked_count = 300
    and committed.details ->> 'source' = 'naver_shopping_results_collector';
  if representative_commit_count <> 1 then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_representative_commit_invalid');
  end if;

  select committed.claim_id, committed.group_fingerprint
  into group_claim_id, expected_group_fingerprint
  from public.naver_shopping_scheduler_events as committed
  where committed.event_type = 'tracker_committed'
    and committed.run_id = p_run_id
    and committed.worker_id = current_row.lease_worker_id
    and committed.tracker_id = p_tracker_id
    and committed.collection_id = normalized_collection_id
    and committed.checked_count = 300
    and committed.details ->> 'source' = 'naver_shopping_results_collector'
  limit 1;

  select count(*)::integer
  into group_claim_count
  from public.naver_shopping_scheduler_events as event
  where event.event_type = 'group_claimed'
    and event.claim_id = group_claim_id
    and event.run_id = p_run_id
    and event.worker_id = current_row.lease_worker_id
    and event.group_fingerprint = expected_group_fingerprint;
  if group_claim_count <> 1 then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_group_proof_invalid');
  end if;

  if exists (
    select 1
    from public.naver_shopping_scheduler_events as failed
    where failed.event_type = 'job_failed'
      and failed.claim_id = group_claim_id
  ) then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_run_failed');
  end if;

  select count(*)::integer
  into tracker_claim_count
  from public.naver_shopping_scheduler_events as claimed
  where claimed.event_type = 'tracker_claimed'
    and claimed.claim_id = group_claim_id;
  if tracker_claim_count < 1 then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_tracker_proof_missing');
  end if;

  if not exists (
    select 1
    from public.naver_shopping_scheduler_events as claimed
    where claimed.event_type = 'tracker_claimed'
      and claimed.claim_id = group_claim_id
      and claimed.run_id = p_run_id
      and claimed.worker_id = current_row.lease_worker_id
      and claimed.tracker_id = p_tracker_id
      and claimed.group_fingerprint = expected_group_fingerprint
  ) then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_tracker_proof_mismatch');
  end if;

  select count(*)::integer
  into committed_count
  from public.naver_shopping_scheduler_events as committed
  where committed.event_type = 'tracker_committed'
    and committed.claim_id = group_claim_id
    and committed.run_id = p_run_id
    and committed.worker_id = current_row.lease_worker_id
    and committed.group_fingerprint = expected_group_fingerprint
    and committed.collection_id = normalized_collection_id
    and committed.checked_count = 300;
  if committed_count <> tracker_claim_count then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_commit_proof_incomplete');
  end if;

  if exists (
    select 1
    from public.naver_shopping_scheduler_events as committed
    where committed.event_type = 'tracker_committed'
      and committed.claim_id = group_claim_id
      and (
        committed.run_id is distinct from p_run_id
        or committed.worker_id is distinct from current_row.lease_worker_id
        or committed.group_fingerprint is distinct from expected_group_fingerprint
        or committed.collection_id is distinct from normalized_collection_id
        or committed.checked_count is distinct from 300
        or committed.details ->> 'source' is distinct from 'naver_shopping_results_collector'
      )
  ) then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_commit_proof_mismatch');
  end if;

  select count(*)::integer
  into invalid_proof_count
  from public.naver_shopping_scheduler_events as claimed
  where claimed.event_type = 'tracker_claimed'
    and claimed.claim_id = group_claim_id
    and (
      claimed.run_id is distinct from p_run_id
      or claimed.worker_id is distinct from current_row.lease_worker_id
      or claimed.group_fingerprint is distinct from expected_group_fingerprint
      or not exists (
        select 1
        from public.naver_shopping_scheduler_events as committed
        where committed.event_type = 'tracker_committed'
          and committed.claim_id = claimed.claim_id
          and committed.run_id = p_run_id
          and committed.worker_id = current_row.lease_worker_id
          and committed.tracker_id = claimed.tracker_id
          and committed.group_fingerprint = claimed.group_fingerprint
          and committed.collection_id = normalized_collection_id
          and committed.checked_count = 300
          and committed.details ->> 'source' = 'naver_shopping_results_collector'
      )
      or not exists (
        select 1
        from public.naver_rank_snapshots as snapshot
        where snapshot.tracker_id = claimed.tracker_id
          and snapshot.collection_id = normalized_collection_id
          and snapshot.checked_count = 300
          and snapshot.source = 'naver_shopping_results_collector'
          and pg_catalog.jsonb_typeof(snapshot.item) = 'object'
          and (snapshot.matched = false or snapshot.item -> 'isOrganic' = 'true'::jsonb)
          and snapshot.item -> 'adExcluded' = 'true'::jsonb
          and snapshot.item ->> 'rankPolicy' = 'organic_only'
          and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
          and snapshot.item ->> 'collectionId' = normalized_collection_id
          and snapshot.item -> 'excludedAdCount' = pg_catalog.to_jsonb(p_excluded_ad_count)
          and pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
                then snapshot.top_items else '[]'::jsonb end
            ) as top_item
            where top_item -> 'isOrganic' is distinct from 'true'::jsonb
              or top_item -> 'isAd' is distinct from 'false'::jsonb
          )
      )
    );
  if invalid_proof_count <> 0 then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_snapshot_proof_invalid');
  end if;

  -- A lost HTTP response can replay the signed success action while the same
  -- lane/run is live. Revalidate proof, then return without changing the streak.
  if current_row.last_collection_id = normalized_collection_id then
    return jsonb_build_object(
      'recorded', true,
      'alreadyRecorded', true,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes,
      'candidateEligible', current_row.stability_started_at is not null
        and current_row.stability_started_at <= v_now - interval '24 hours'
        and current_row.success_streak >= 6
    );
  end if;

  next_success_streak := case
    when current_row.circuit_state = 'half_open' then 1
    else least(100000, current_row.success_streak + 1)
  end;
  next_stability_started_at := case
    when current_row.circuit_state = 'half_open' or current_row.stability_started_at is null then v_now
    else current_row.stability_started_at
  end;

  update public.naver_shopping_worker_coordination
  set circuit_state = 'closed',
      circuit_reason = null,
      circuit_opened_at = null,
      failure_signature = null,
      failure_streak = 0,
      transient_system_probe_attempts = 0,
      probe_tracker_id = null,
      probe_started_at = null,
      current_stage = 'completed',
      current_page = 8,
      last_success_at = v_now,
      last_collection_id = normalized_collection_id,
      last_checked_count = p_checked_count,
      last_excluded_ad_count = p_excluded_ad_count,
      last_duration_ms = p_duration_ms,
      last_source = lower(trim(p_source)),
      stability_started_at = next_stability_started_at,
      success_streak = next_success_streak,
      updated_at = v_now
  where lane_key = 'global';

  update public.naver_rank_trackers
  set worker_quarantined_until = null
  where id = p_tracker_id;

  return jsonb_build_object(
    'recorded', true,
    'alreadyRecorded', false,
    'circuitState', 'closed',
    'cadenceMinutes', current_row.cadence_minutes,
    'candidateEligible', next_stability_started_at <= v_now - interval '24 hours'
      and next_success_streak >= 6
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
  v_now timestamptz;
begin
  if normalized_mode not in ('baseline', 'candidate') then
    return jsonb_build_object('accepted', false, 'reason', 'mode_invalid');
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
    return jsonb_build_object('accepted', true, 'activated', true, 'mode', 'baseline', 'minutes', 10);
  end if;

  eligible := coalesce((current_row.circuit_state = 'closed'
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
    and current_row.runtime_version = '1.1.12'
    and current_row.runtime_fingerprint = '862b3779b7f4c96db52005a090888d80facb653a598a5141093557cb2eef7e8e'
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

revoke all on function public.mi_record_naver_shopping_worker_success(text, uuid, uuid, uuid, text, integer, integer, integer, text)
from public, anon, authenticated, service_role;
revoke all on function public.mi_set_naver_shopping_worker_cadence(text)
from public, anon, authenticated, service_role;

grant execute on function public.mi_record_naver_shopping_worker_success(text, uuid, uuid, uuid, text, integer, integer, integer, text)
to service_role;
grant execute on function public.mi_set_naver_shopping_worker_cadence(text)
to service_role;

commit;

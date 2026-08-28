-- Exact runtime 1.1.16 fingerprint revision for the explicit Naver
-- `supersaving` composite. The parser now excludes only that exact inventory
-- type as non-organic while every unknown product-bearing composite remains
-- fail closed. This migration can run only from the observed idle circuit and
-- preserves the last-good atomic300, failure ledger, cycle cursor and queue.

begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;

do $supersaving_recovery$
declare
  prior_row public.naver_shopping_worker_coordination%rowtype;
  post_row public.naver_shopping_worker_coordination%rowtype;
  prior_target public.naver_shopping_finite_window_targets%rowtype;
  post_target public.naver_shopping_finite_window_targets%rowtype;
  processing_count integer := 0;
  target_updated_count integer := 0;
  coordination_updated_count integer := 0;
begin
  select * into prior_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found then
    raise exception 'naver_shopping_supersaving_recovery_coordination_missing';
  end if;

  select * into prior_target
  from public.naver_shopping_finite_window_targets
  where tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    and seller_product_id = '13327339525'
    and parent_catalog_id = '59776958987'
    and normalized_keyword = '아이쉘차량용거치대'
    and proof_version = 'stable-finite-window-v1'
    and enabled = true;

  if not found then
    raise exception 'naver_shopping_supersaving_recovery_target_missing';
  end if;

  select (
    (select count(*)
     from public.naver_shopping_rank_lookup_jobs
     where status = 'processing'
       and processing_until > clock_timestamp())
    +
    (select count(*)
     from public.naver_rank_trackers
     where status = 'active'
       and processing_until > clock_timestamp())
  )::integer into processing_count;

  if prior_target.runtime_version is distinct from '1.1.16'
    or prior_target.runtime_fingerprint is distinct from
      '8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1'
    or prior_row.runtime_version is distinct from prior_target.runtime_version
    or prior_row.runtime_fingerprint is distinct from prior_target.runtime_fingerprint
    or prior_row.cadence_mode is distinct from 'baseline'
    or prior_row.cadence_minutes is distinct from 10
    or prior_row.circuit_state is distinct from 'open'
    or prior_row.circuit_reason is null
    or prior_row.circuit_reason is distinct from prior_row.failure_signature
    or prior_row.circuit_reason is distinct from
      ('collecting:' || coalesce(prior_row.last_failure_code, ''))
    or prior_row.circuit_reason !~
      '^collecting:naver_next_data_schema_drift:compositelist_list_[0-9]+_type_supersaving$'
    or prior_row.cooldown_until is not null
    or processing_count <> 0
    or prior_row.lease_worker_id is not null
    or prior_row.lease_token is not null
    or prior_row.lease_until is not null
    or prior_row.run_id is not null
    or prior_row.current_stage is distinct from 'failed'
    or prior_row.current_page is distinct from 8
    or prior_row.current_job_kind is not null
    or prior_row.current_tracker_id is not null
    or prior_row.current_job_started_at is not null
    or prior_row.probe_tracker_id is not null
    or prior_row.probe_started_at is not null
    or prior_row.last_success_at is null
    or prior_row.last_collection_id is null
    or prior_row.last_collection_id !~ '^pw-chrome-'
    or prior_row.last_checked_count is distinct from 300
    or prior_row.last_excluded_ad_count is null
    or prior_row.last_excluded_ad_count < 0
    or prior_row.last_duration_ms is null
    or prior_row.last_duration_ms < 0
    or prior_row.last_source is distinct from 'naver_shopping_results_collector'
    or prior_row.last_failure_at is null
    or prior_row.last_failure_at <= prior_row.last_success_at
    or prior_row.last_failure_code !~
      '^naver_next_data_schema_drift:compositelist_list_[0-9]+_type_supersaving$' then
    raise exception 'naver_shopping_supersaving_recovery_precondition_failed';
  end if;

  update public.naver_shopping_finite_window_targets
  set runtime_fingerprint =
    '9680164f90965609896b72c05b09e67946bc51d1df44c76d0cb5b9e5f0085478'
  where tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    and seller_product_id = '13327339525'
    and parent_catalog_id = '59776958987'
    and normalized_keyword = '아이쉘차량용거치대'
    and proof_version = 'stable-finite-window-v1'
    and enabled = true
    and runtime_version = '1.1.16'
    and runtime_fingerprint =
      '8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1';
  get diagnostics target_updated_count = row_count;

  if target_updated_count <> 1 then
    raise exception 'naver_shopping_supersaving_recovery_target_update_failed';
  end if;

  update public.naver_shopping_worker_coordination
  set cadence_mode = 'baseline',
      cadence_minutes = 10,
      stability_started_at = null,
      success_streak = 0,
      runtime_version = null,
      runtime_fingerprint = null,
      circuit_state = 'closed',
      circuit_reason = null,
      circuit_opened_at = null,
      failure_signature = null,
      failure_streak = 0,
      current_stage = null,
      current_page = 0,
      updated_at = clock_timestamp()
  where lane_key = 'global'
    and runtime_version = '1.1.16'
    and runtime_fingerprint =
      '8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1'
    and cadence_mode = 'baseline'
    and cadence_minutes = 10
    and circuit_state = 'open'
    and circuit_reason ~
      '^collecting:naver_next_data_schema_drift:compositelist_list_[0-9]+_type_supersaving$'
    and last_failure_code ~
      '^naver_next_data_schema_drift:compositelist_list_[0-9]+_type_supersaving$'
    and current_stage = 'failed'
    and current_page = 8;
  get diagnostics coordination_updated_count = row_count;

  if coordination_updated_count <> 1 then
    raise exception 'naver_shopping_supersaving_recovery_coordination_update_failed';
  end if;

  select * into post_target
  from public.naver_shopping_finite_window_targets
  where tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    and seller_product_id = '13327339525'
    and parent_catalog_id = '59776958987'
    and normalized_keyword = '아이쉘차량용거치대'
    and proof_version = 'stable-finite-window-v1'
    and enabled = true;

  select * into post_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global';

  if post_target.runtime_version is distinct from '1.1.16'
    or post_target.runtime_fingerprint is distinct from
      '9680164f90965609896b72c05b09e67946bc51d1df44c76d0cb5b9e5f0085478'
    or (to_jsonb(post_target) - 'runtime_fingerprint') is distinct from
      (to_jsonb(prior_target) - 'runtime_fingerprint')
    or post_row.cadence_mode is distinct from 'baseline'
    or post_row.cadence_minutes is distinct from 10
    or post_row.stability_started_at is not null
    or post_row.success_streak is distinct from 0
    or post_row.runtime_version is not null
    or post_row.runtime_fingerprint is not null
    or post_row.circuit_state is distinct from 'closed'
    or post_row.circuit_reason is not null
    or post_row.circuit_opened_at is not null
    or post_row.failure_signature is not null
    or post_row.failure_streak is distinct from 0
    or post_row.current_stage is not null
    or post_row.current_page is distinct from 0
    or (to_jsonb(post_row) - array[
      'cadence_mode',
      'cadence_minutes',
      'stability_started_at',
      'success_streak',
      'runtime_version',
      'runtime_fingerprint',
      'circuit_state',
      'circuit_reason',
      'circuit_opened_at',
      'failure_signature',
      'failure_streak',
      'current_stage',
      'current_page',
      'updated_at'
    ]) is distinct from (to_jsonb(prior_row) - array[
      'cadence_mode',
      'cadence_minutes',
      'stability_started_at',
      'success_streak',
      'runtime_version',
      'runtime_fingerprint',
      'circuit_state',
      'circuit_reason',
      'circuit_opened_at',
      'failure_signature',
      'failure_streak',
      'current_stage',
      'current_page',
      'updated_at'
    ])
    or post_row.primary_worker_id is distinct from prior_row.primary_worker_id
    or post_row.primary_seen_at is distinct from prior_row.primary_seen_at
    or post_row.cooldown_until is distinct from prior_row.cooldown_until
    or post_row.last_block_code is distinct from prior_row.last_block_code
    or post_row.scheduler_cycle_id is distinct from prior_row.scheduler_cycle_id
    or post_row.scheduler_cycle_number is distinct from prior_row.scheduler_cycle_number
    or post_row.scheduler_cycle_status is distinct from prior_row.scheduler_cycle_status
    or post_row.scheduler_cycle_started_at is distinct from prior_row.scheduler_cycle_started_at
    or post_row.scheduler_cycle_completed_at is distinct from prior_row.scheduler_cycle_completed_at
    or post_row.scheduler_cycle_cursor_sort_order is distinct from prior_row.scheduler_cycle_cursor_sort_order
    or post_row.scheduler_cycle_cursor_created_at is distinct from prior_row.scheduler_cycle_cursor_created_at
    or post_row.scheduler_cycle_cursor_tracker_id is distinct from prior_row.scheduler_cycle_cursor_tracker_id
    or post_row.scheduler_cycle_resume_cursor is distinct from prior_row.scheduler_cycle_resume_cursor
    or post_row.last_success_at is distinct from prior_row.last_success_at
    or post_row.last_collection_id is distinct from prior_row.last_collection_id
    or post_row.last_checked_count is distinct from prior_row.last_checked_count
    or post_row.last_excluded_ad_count is distinct from prior_row.last_excluded_ad_count
    or post_row.last_duration_ms is distinct from prior_row.last_duration_ms
    or post_row.last_source is distinct from prior_row.last_source
    or post_row.last_failure_at is distinct from prior_row.last_failure_at
    or post_row.last_failure_code is distinct from prior_row.last_failure_code then
    raise exception 'naver_shopping_supersaving_recovery_postcheck_failed';
  end if;
end
$supersaving_recovery$;

commit;

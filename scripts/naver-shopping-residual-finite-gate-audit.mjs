import { pathToFileURL } from "node:url";

const TARGET_WORKER_ID = "windows-desktop-primary";
const TARGET_RUNTIME_VERSION = "1.1.13";
const TARGET_RUNTIME_FINGERPRINT =
  "cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6";

export const N30_RESIDUAL_GATE_TARGETS = Object.freeze([
  Object.freeze({
    trackerId: "1114f3af-c30c-4975-9b79-ecec9cfbf031",
    gateAt: "2026-08-25T18:29:09.508685Z",
    snapshotCount: 58,
    lastCheckedAt: "2026-07-31T00:19:49.58Z",
    currentRank: null,
    bestRank: null,
    worstRank: null,
    checkCount: 58,
    foundCount: 0,
  }),
  Object.freeze({
    trackerId: "12f5330a-e8ac-4d82-9317-5d092f5142d8",
    gateAt: "2026-08-26T02:10:35.927243Z",
    snapshotCount: 71,
    lastCheckedAt: "2026-08-09T07:38:00.984Z",
    currentRank: 1,
    bestRank: 1,
    worstRank: 1,
    checkCount: 71,
    foundCount: 71,
  }),
]);

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlIntegerOrNull(value) {
  return value === null ? "null::int" : `${Number(value)}::int`;
}

function targetSql(target) {
  return `(
      ${sqlText(target.trackerId)}::uuid,
      ${sqlText(target.gateAt)}::timestamptz,
      ${target.snapshotCount}::int,
      ${sqlText(target.lastCheckedAt)}::timestamptz,
      ${sqlIntegerOrNull(target.currentRank)},
      ${sqlIntegerOrNull(target.bestRank)},
      ${sqlIntegerOrNull(target.worstRank)},
      ${target.checkCount}::int,
      ${target.foundCount}::int
    )`;
}

export function buildN30ResidualFiniteGateAuditSql() {
  const targets = N30_RESIDUAL_GATE_TARGETS.map(targetSql).join(",\n    ");

  return `begin transaction isolation level repeatable read read only;
set local role service_role;
with fixed as (
  select statement_timestamp() as observed_at,
         public.mi_get_naver_shopping_worker_operations() as ops,
         (
           coordination.lease_worker_id is null
           and coordination.lease_token is null
           and coordination.lease_until is null
           and coordination.run_id is null
           and coordination.current_stage is null
           and coordination.current_page = 0
           and coordination.current_job_kind is null
           and coordination.current_tracker_id is null
           and coordination.current_job_started_at is null
           and coordination.probe_started_at is null
           and coordination.probe_tracker_id is null
         ) as coordination_lane_idle,
         (
           coordination.circuit_state = 'closed'
           and coordination.circuit_reason is null
           and coordination.cooldown_until is null
         ) as coordination_control_safe,
         coordination.run_id as coordination_run_id,
         coordination.lease_until as coordination_lease_until
  from public.naver_shopping_worker_coordination as coordination
  where coordination.lane_key = 'global'
),
targets(
  tracker_id, gate_at, baseline_snapshot_count, baseline_last_checked_at,
  baseline_current_rank, baseline_best_rank, baseline_worst_rank,
  baseline_check_count, baseline_found_count
) as (
  values
    ${targets}
),
evidence as (
  select
    target.*, fixed.observed_at, fixed.ops,
    fixed.coordination_lane_idle, fixed.coordination_control_safe,
    fixed.coordination_run_id, fixed.coordination_lease_until,
    tracker.status::text as tracker_status,
    tracker.processing_until, tracker.worker_quarantined_until,
    tracker.last_checked_at, tracker.current_rank, tracker.best_rank,
    tracker.worst_rank, tracker.check_count, tracker.found_count,
    claim.event_id as claim_event_id, claim.occurred_at as claim_at,
    claim.claim_id, claim.run_id, claim.cycle_id, claim.group_fingerprint,
    claim.worker_id, claim.priority,
    group_claim.event_id as group_event_id,
    group_claim.occurred_at as group_at,
    group_claim.cycle_id as group_cycle_id,
    group_claim.worker_id as group_worker_id,
    group_claim.group_fingerprint as group_claim_fingerprint,
    group_claim.priority as group_priority,
    group_stats.group_count,
    exact_run.worker_id as provenance_worker_id,
    exact_run.run_trigger,
    exact_run.runtime_version,
    exact_run.runtime_fingerprint,
    exact_run.started_at as provenance_started_at,
    terminal.event_id as terminal_event_id, terminal.occurred_at as terminal_at,
    terminal.event_type as terminal_type, terminal.error_code as terminal_error_code,
    terminal.cycle_id as terminal_cycle_id,
    terminal.worker_id as terminal_worker_id,
    terminal.group_fingerprint as terminal_group_fingerprint,
    terminal.priority as terminal_priority,
    terminal.collection_id as terminal_collection_id,
    terminal.checked_count as terminal_checked_count,
    terminal.details ->> 'source' as terminal_source,
    terminal_stats.all_terminal_count, terminal_stats.exact_terminal_count,
    snapshot_stats.claim_window_snapshot_count,
    snapshot_stats.total_snapshot_count,
    snapshot_stats.valid_success_snapshot_count,
    quarantine_stats.all_quarantine_count,
    quarantine_stats.matching_quarantine_count,
    quarantine_stats.quarantine_event_id,
    quarantine_stats.quarantine_until as terminal_quarantine_until
  from targets as target
  cross join fixed
  join public.naver_rank_trackers as tracker on tracker.id = target.tracker_id
  left join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'tracker_claimed'
      and event.tracker_id = target.tracker_id
      and event.occurred_at >= target.gate_at
      and event.occurred_at <= fixed.observed_at
    order by event.occurred_at, event.event_id
    limit 1
  ) as claim on true
  left join public.naver_shopping_worker_runs as exact_run
    on exact_run.run_id = claim.run_id
  left join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'group_claimed'
      and event.claim_id = claim.claim_id
      and event.run_id = claim.run_id
    order by event.occurred_at, event.event_id
    limit 1
  ) as group_claim on true
  left join lateral (
    select count(*)::int as group_count
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'group_claimed'
      and event.run_id = claim.run_id
  ) as group_stats on true
  left join lateral (
    select
      count(*) filter (
        where event.event_type in ('tracker_committed','job_failed')
      )::int as all_terminal_count,
      count(*) filter (
        where event.event_type in ('tracker_committed','job_failed')
          and event.run_id = claim.run_id
      )::int as exact_terminal_count
    from public.naver_shopping_scheduler_events as event
    where event.claim_id = claim.claim_id
      and event.tracker_id = target.tracker_id
      and event.occurred_at <= fixed.observed_at
  ) as terminal_stats on true
  left join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type in ('tracker_committed','job_failed')
      and event.claim_id = claim.claim_id
      and event.run_id = claim.run_id
      and event.tracker_id = target.tracker_id
      and event.occurred_at >= claim.occurred_at
      and event.event_id > claim.event_id
      and event.occurred_at <= fixed.observed_at
    order by event.occurred_at, event.event_id
    limit 1
  ) as terminal on true
  left join lateral (
    select
      count(*) filter (
        where snapshot.checked_at between claim.occurred_at and terminal.occurred_at
      )::int as claim_window_snapshot_count,
      count(*)::int as total_snapshot_count,
      count(*) filter (
        where terminal.event_type = 'tracker_committed'
          and snapshot.collection_id = terminal.collection_id
          and snapshot.checked_at between claim.occurred_at and terminal.occurred_at
          and snapshot.checked_count = 300
          and snapshot.source = 'naver_shopping_results_collector'
          and pg_catalog.jsonb_typeof(snapshot.item) = 'object'
          and (snapshot.matched = false or snapshot.item -> 'isOrganic' = 'true'::jsonb)
          and snapshot.item -> 'adExcluded' = 'true'::jsonb
          and snapshot.item ->> 'rankPolicy' = 'organic_only'
          and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
          and snapshot.item ->> 'collectionId' = terminal.collection_id
          and case
            when pg_catalog.jsonb_typeof(snapshot.item -> 'excludedAdCount') = 'number'
              and (snapshot.item ->> 'excludedAdCount') ~ '^[0-9]+$'
            then (snapshot.item ->> 'excludedAdCount')::numeric >= 0
            else false
          end
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
      )::int as valid_success_snapshot_count
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = target.tracker_id
  ) as snapshot_stats on true
  left join lateral (
    select count(*)::int as all_quarantine_count,
           count(*) filter (
             where event.run_id is not distinct from terminal.run_id
               and event.error_code is not distinct from terminal.error_code
               and event.cycle_id is not distinct from terminal.cycle_id
               and event.worker_id is not distinct from terminal.worker_id
               and event.group_fingerprint is not distinct from terminal.group_fingerprint
               and event.priority is not distinct from terminal.priority
               and event.occurred_at >= terminal.occurred_at
               and event.event_id > terminal.event_id
           )::int as matching_quarantine_count,
           max(event.event_id) filter (
             where event.run_id is not distinct from terminal.run_id
               and event.error_code is not distinct from terminal.error_code
               and event.cycle_id is not distinct from terminal.cycle_id
               and event.worker_id is not distinct from terminal.worker_id
               and event.group_fingerprint is not distinct from terminal.group_fingerprint
               and event.priority is not distinct from terminal.priority
               and event.occurred_at >= terminal.occurred_at
               and event.event_id > terminal.event_id
           ) as quarantine_event_id,
           max(event.quarantine_until) filter (
             where event.run_id is not distinct from terminal.run_id
               and event.error_code is not distinct from terminal.error_code
               and event.cycle_id is not distinct from terminal.cycle_id
               and event.worker_id is not distinct from terminal.worker_id
               and event.group_fingerprint is not distinct from terminal.group_fingerprint
               and event.priority is not distinct from terminal.priority
               and event.occurred_at >= terminal.occurred_at
               and event.event_id > terminal.event_id
           ) as quarantine_until
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'quarantine_set'
      and event.claim_id = claim.claim_id
      and event.tracker_id = target.tracker_id
      and event.occurred_at <= fixed.observed_at
  ) as quarantine_stats on true
),
states as (
  select evidence.*,
    coalesce((
      coordination_lane_idle
      and coalesce((ops->>'processing_count')::int, -1) = 0
    ), false) as lane_idle,
    coalesce((
      coordination_control_safe
      and ops->>'circuit_state' = 'closed'
      and coalesce(ops->'circuit_reason','null'::jsonb) = 'null'::jsonb
      and coalesce(ops->'cooldown_until','null'::jsonb) = 'null'::jsonb
      and ops->>'cadence_mode' = 'baseline'
      and (ops->>'cadence_minutes')::int = 10
      and ops->>'primary_worker_id' = ${sqlText(TARGET_WORKER_ID)}
      and (ops->>'primary_seen_at')::timestamptz > observed_at - interval '3 minutes'
      and ops->>'runtime_version' = ${sqlText(TARGET_RUNTIME_VERSION)}
      and ops->>'runtime_fingerprint' = ${sqlText(TARGET_RUNTIME_FINGERPRINT)}
    ), false) as control_integrity,
    coalesce((
      processing_until > observed_at
      and coordination_run_id is not distinct from run_id
      and coordination_lease_until > observed_at
    ), false) as claim_inflight
  from evidence
),
classified as (
  select states.*,
    case
      when observed_at < gate_at then 'gate_not_reached'
      when not control_integrity then 'integrity_failure'
      when claim_id is null
        and (
          tracker_status is distinct from 'active'
          or processing_until is not null
          or (worker_quarantined_until is not null
            and worker_quarantined_until > observed_at)
        )
        then 'integrity_failure'
      when claim_id is null then 'awaiting_first_claim'
      when run_id is null
        or cycle_id is null
        or group_fingerprint is null
        or worker_id is distinct from ${sqlText(TARGET_WORKER_ID)}
        or priority not in ('new','resume','normal')
        or group_count <> 1
        or group_event_id is null
        or group_event_id >= claim_event_id
        or group_at < gate_at
        or group_at > claim_at
        or group_cycle_id is distinct from cycle_id
        or group_worker_id is distinct from worker_id
        or group_claim_fingerprint is distinct from group_fingerprint
        or group_priority is distinct from priority
        or provenance_worker_id is distinct from ${sqlText(TARGET_WORKER_ID)}
        or run_trigger is distinct from 'rank-catch-up'
        or runtime_version is distinct from ${sqlText(TARGET_RUNTIME_VERSION)}
        or runtime_fingerprint is distinct from ${sqlText(TARGET_RUNTIME_FINGERPRINT)}
        or group_at < provenance_started_at - interval '5 seconds'
        then 'integrity_failure'
      when coalesce(all_terminal_count,0) = 0 and claim_inflight
        then 'awaiting_terminal'
      when coalesce(all_terminal_count,0) = 0 then 'integrity_failure'
      when all_terminal_count <> 1 or exact_terminal_count <> 1 then 'integrity_failure'
      when terminal_event_id <= claim_event_id
        or terminal_at < claim_at
        or terminal_cycle_id is distinct from cycle_id
        or terminal_worker_id is distinct from worker_id
        or terminal_group_fingerprint is distinct from group_fingerprint
        or terminal_priority is distinct from priority
        then 'integrity_failure'
      when terminal_type = 'tracker_committed'
        and terminal_checked_count = 300
        and terminal_source = 'naver_shopping_results_collector'
        and terminal_collection_id ~ '^pw-chrome-'
        and claim_window_snapshot_count = 1
        and valid_success_snapshot_count = 1
        and total_snapshot_count = baseline_snapshot_count + 1
        and all_quarantine_count = 0
        and tracker_status = 'active'
        and worker_quarantined_until is null
        and processing_until is null
        and lane_idle
        then 'success'
      when terminal_type = 'job_failed'
        and terminal_error_code ~ '^provider_partial_window:([1-9]|[1-9][0-9]|[12][0-9]{2})_300$'
        and claim_window_snapshot_count = 0
        and all_quarantine_count = 1
        and matching_quarantine_count = 1
        and quarantine_event_id > terminal_event_id
        and terminal_quarantine_until > terminal_at
        and worker_quarantined_until is not distinct from terminal_quarantine_until
        and total_snapshot_count = baseline_snapshot_count
        and last_checked_at is not distinct from baseline_last_checked_at
        and current_rank is not distinct from baseline_current_rank
        and best_rank is not distinct from baseline_best_rank
        and worst_rank is not distinct from baseline_worst_rank
        and check_count = baseline_check_count
        and found_count = baseline_found_count
        and tracker_status = 'active'
        and processing_until is null
        and lane_idle
        then 'typed_failure'
      when not lane_idle then 'awaiting_post_idle'
      else 'integrity_failure'
    end as finite_state
  from states
)
select jsonb_build_object(
  'marker','n30_residual_finite_gate_audit_v2',
  'observedAt', min(observed_at),
  'targetCount', count(*),
  'results', jsonb_agg(jsonb_build_object(
    'trackerId', tracker_id,
    'gateAt', gate_at,
    'finiteState', finite_state,
    'claimEventId', claim_event_id,
    'claimAt', claim_at,
    'claimId', claim_id,
    'runId', run_id,
    'workerIdExact', worker_id = ${sqlText(TARGET_WORKER_ID)},
    'groupEventId', group_event_id,
    'groupAt', group_at,
    'groupCount', group_count,
    'runTrigger', run_trigger,
    'runtimeVersion', runtime_version,
    'runtimeFingerprintExact', runtime_fingerprint = ${sqlText(TARGET_RUNTIME_FINGERPRINT)},
    'terminalEventId', terminal_event_id,
    'terminalAt', terminal_at,
    'terminalType', terminal_type,
    'terminalErrorCode', terminal_error_code,
    'terminalCount', exact_terminal_count,
    'claimWindowSnapshotCount', claim_window_snapshot_count,
    'validSuccessSnapshotCount', valid_success_snapshot_count,
    'totalSnapshotCount', total_snapshot_count,
    'allQuarantineCount', all_quarantine_count,
    'matchingQuarantineCount', matching_quarantine_count,
    'quarantineEventId', quarantine_event_id,
    'terminalQuarantineUntil', terminal_quarantine_until,
    'lastGoodPreserved', (
      total_snapshot_count = baseline_snapshot_count
      and last_checked_at is not distinct from baseline_last_checked_at
      and current_rank is not distinct from baseline_current_rank
      and best_rank is not distinct from baseline_best_rank
      and worst_rank is not distinct from baseline_worst_rank
      and check_count = baseline_check_count
      and found_count = baseline_found_count
    ),
    'trackerProcessingUntil', processing_until,
    'laneIdle', lane_idle,
    'controlIntegrity', control_integrity,
    'claimInflight', claim_inflight,
    'fullIdle', lane_idle and control_integrity,
    'cadenceMode', ops->>'cadence_mode',
    'cadenceMinutes', (ops->>'cadence_minutes')::int,
    'candidateEligible', (ops->>'candidate_eligible')::boolean
  ) order by gate_at)
) as result
from classified;
commit;`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${buildN30ResidualFiniteGateAuditSql()}\n`);
}

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;

export const N30_ACCOUNT_HEALTH_AGENCY_CODE = "mml93-a01";
export const N30_ACCOUNT_HEALTH_WORKER_ID = "windows-desktop-primary";
export const N30_ACCOUNT_HEALTH_RUNTIME_VERSION = "1.1.17";
export const N30_ACCOUNT_HEALTH_RUNTIME_FINGERPRINT =
  "1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7";

function requireObservedAt(value) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("observedAt must be an ISO-8601 UTC timestamp");
  }
  return value;
}

function requireCount(source, field) {
  const value = source?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireBoolean(source, field) {
  const value = source?.[field];
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function classifyN30AccountRankHealth(input) {
  const activeTrackerCount = requireCount(input, "activeTrackerCount");
  const eligibleTrackerCount = requireCount(input, "eligibleTrackerCount");
  const claimedTrackerCount = requireCount(input, "claimedTrackerCount");
  const terminalTrackerCount = requireCount(input, "terminalTrackerCount");
  const validSuccessTrackerCount = requireCount(input, "validSuccessTrackerCount");
  const foundTrackerCount = requireCount(input, "foundTrackerCount");
  const failureTrackerCount = requireCount(input, "failureTrackerCount");
  const integrityFailureTrackerCount = requireCount(input, "integrityFailureTrackerCount");
  const openTrackerCount = requireCount(input, "openTrackerCount");
  const unclaimedOpenTrackerCount = requireCount(input, "unclaimedOpenTrackerCount");
  const claimedOpenTrackerCount = requireCount(input, "claimedOpenTrackerCount");
  const preterminalIntegrityFailureTrackerCount = requireCount(
    input,
    "preterminalIntegrityFailureTrackerCount",
  );
  const terminalIntegrityFailureTrackerCount = requireCount(
    input,
    "terminalIntegrityFailureTrackerCount",
  );
  const neverCheckedTrackerCount = requireCount(input, "neverCheckedTrackerCount");
  const stale24hTrackerCount = requireCount(input, "stale24hTrackerCount");
  const eventAgencyMismatchCount = requireCount(input, "eventAgencyMismatchCount");
  if (typeof input?.controlPlaneOk !== "boolean") {
    throw new TypeError("controlPlaneOk must be a boolean");
  }

  if (failureTrackerCount + terminalIntegrityFailureTrackerCount + validSuccessTrackerCount
    !== terminalTrackerCount) {
    throw new RangeError("terminal partition must exactly equal terminalTrackerCount");
  }
  if (unclaimedOpenTrackerCount + claimedOpenTrackerCount
    + preterminalIntegrityFailureTrackerCount + terminalTrackerCount
    !== eligibleTrackerCount) {
    throw new RangeError("eligible partition must exactly equal eligibleTrackerCount");
  }
  if (openTrackerCount !== unclaimedOpenTrackerCount + claimedOpenTrackerCount) {
    throw new RangeError("openTrackerCount must equal its open partitions");
  }
  if (integrityFailureTrackerCount
    !== preterminalIntegrityFailureTrackerCount + terminalIntegrityFailureTrackerCount) {
    throw new RangeError("integrityFailureTrackerCount must equal its integrity partitions");
  }
  const invalid = eligibleTrackerCount > activeTrackerCount
    || claimedTrackerCount > eligibleTrackerCount
    || validSuccessTrackerCount > terminalTrackerCount
    || foundTrackerCount > validSuccessTrackerCount
    || claimedOpenTrackerCount + preterminalIntegrityFailureTrackerCount
      + terminalTrackerCount < claimedTrackerCount
    || neverCheckedTrackerCount > activeTrackerCount
    || stale24hTrackerCount > activeTrackerCount
    || eventAgencyMismatchCount > claimedTrackerCount;
  if (invalid) throw new RangeError("account rank-health counts are internally inconsistent");
  if (eventAgencyMismatchCount > 0) {
    throw new RangeError("eventAgencyMismatchCount must be zero");
  }

  const coverageRatio = ratio(terminalTrackerCount, eligibleTrackerCount);
  const terminalSuccessRatio = ratio(validSuccessTrackerCount, terminalTrackerCount);
  const effectiveSuccessRatio = ratio(validSuccessTrackerCount, eligibleTrackerCount);
  const foundRatio = ratio(foundTrackerCount, eligibleTrackerCount);
  const accountHealthy = activeTrackerCount > 0
    && eligibleTrackerCount === activeTrackerCount
    && claimedTrackerCount === eligibleTrackerCount
    && terminalTrackerCount === eligibleTrackerCount
    && validSuccessTrackerCount === eligibleTrackerCount
    && failureTrackerCount === 0
    && integrityFailureTrackerCount === 0
    && openTrackerCount === 0
    && neverCheckedTrackerCount === 0
    && stale24hTrackerCount === 0
    && input.controlPlaneOk;

  return {
    coverageRatio,
    terminalSuccessRatio,
    effectiveSuccessRatio,
    foundRatio,
    accountHealthy,
  };
}

// Pure fail-closed mirror used by regression fixtures. The Production verdict is
// still computed by the SQL below; this prevents future test changes from
// silently treating duplicate/wrong-order evidence as a success.
export function classifyN30AccountTrackerEvidence(input) {
  const claimCount = requireCount(input, "claimCount");
  const terminalCount = requireCount(input, "terminalCount");
  const groupEventCount = requireCount(input, "groupEventCount");
  const groupClaimCount = requireCount(input, "groupClaimCount");
  const groupDistinctTrackerCount = requireCount(input, "groupDistinctTrackerCount");
  const groupMemberCount = requireCount(input, "groupMemberCount");
  const preclaimTerminalCount = requireCount(input, "preclaimTerminalCount");
  const wrongRunTerminalCount = requireCount(input, "wrongRunTerminalCount");
  const otherClaimTerminalCount = requireCount(input, "otherClaimTerminalCount");
  const orphanTerminalCount = requireCount(input, "orphanTerminalCount");
  const claimWindowSnapshotCount = requireCount(input, "claimWindowSnapshotCount");
  const rosterIntegrityOk = requireBoolean(input, "rosterIntegrityOk");
  const claimIdentityOk = requireBoolean(input, "claimIdentityOk");
  const eventOrderingOk = requireBoolean(input, "eventOrderingOk");
  const leaseWindowOk = requireBoolean(input, "leaseWindowOk");
  const runIdentityOk = requireBoolean(input, "runIdentityOk");
  const terminalIdentityOk = requireBoolean(input, "terminalIdentityOk");
  const currentMaterializationOk = requireBoolean(input, "currentMaterializationOk");
  const terminalSnapshotKind = input?.terminalSnapshotKind;
  const terminalType = input?.terminalType;
  if (!["none", "atomic", "finite", "invalid"].includes(terminalSnapshotKind)) {
    throw new TypeError("terminalSnapshotKind must be none, atomic, finite, or invalid");
  }
  if (![null, "tracker_committed", "finite_window_committed", "job_failed"].includes(terminalType)) {
    throw new TypeError("terminalType is invalid");
  }

  if (claimCount === 0 && terminalCount === 0) {
    const unexpectedTerminalEvidence = preclaimTerminalCount > 0
      || wrongRunTerminalCount > 0
      || otherClaimTerminalCount > 0
      || orphanTerminalCount > 0
      || claimWindowSnapshotCount > 0
      || terminalSnapshotKind !== "none"
      || terminalType !== null
      || input?.errorCodePresent === true;
    if (unexpectedTerminalEvidence) return "terminal_integrity_failure";
    const unclaimedStructureOk = groupEventCount === 0
      && groupClaimCount === 0
      && groupDistinctTrackerCount === 0
      && groupMemberCount === 0
      && rosterIntegrityOk
      && claimIdentityOk
      && eventOrderingOk
      && leaseWindowOk
      && runIdentityOk;
    return unclaimedStructureOk ? "unclaimed_open" : "preterminal_integrity_failure";
  }
  const structuralIntegrity = claimCount === 1
    && groupEventCount === 1
    && groupClaimCount > 0
    && groupClaimCount === groupDistinctTrackerCount
    && groupMemberCount === groupDistinctTrackerCount
    && preclaimTerminalCount === 0
    && wrongRunTerminalCount === 0
    && otherClaimTerminalCount === 0
    && orphanTerminalCount === 0
    && rosterIntegrityOk
    && claimIdentityOk
    && eventOrderingOk
    && leaseWindowOk
    && runIdentityOk;
  if (terminalCount === 0) {
    return structuralIntegrity ? "claimed_open" : "preterminal_integrity_failure";
  }
  if (!structuralIntegrity) return "terminal_integrity_failure";
  if (terminalCount !== 1 || !terminalIdentityOk || !currentMaterializationOk) {
    return "terminal_integrity_failure";
  }
  if (
    terminalType === "tracker_committed"
    && terminalSnapshotKind === "atomic"
    && claimWindowSnapshotCount === 1
  ) return "success";
  if (
    terminalType === "finite_window_committed"
    && terminalSnapshotKind === "finite"
    && claimWindowSnapshotCount === 1
  ) return "success";
  if (
    terminalType === "job_failed"
    && terminalSnapshotKind === "none"
    && claimWindowSnapshotCount === 0
    && input?.errorCodePresent === true
  ) return "failure";
  return "terminal_integrity_failure";
}

function organicCollectorProof(alias) {
  return `${alias}.source = 'naver_shopping_results_collector'
      and ${alias}.collection_id ~ '^pw-chrome-'
      and ${alias}.item ->> 'collectionId' = ${alias}.collection_id
      and ${alias}.item ->> 'source' = 'naver_shopping_results_collector'
      and ${alias}.item -> 'adExcluded' = 'true'::jsonb
      and ${alias}.item ->> 'rankPolicy' = 'organic_only'
      and ${alias}.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
      and case
        when pg_catalog.jsonb_typeof(${alias}.item -> 'excludedAdCount') = 'number'
          and (${alias}.item ->> 'excludedAdCount') ~ '^[0-9]+$'
        then (${alias}.item ->> 'excludedAdCount')::numeric >= 0
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(${alias}.top_items) = 'array' then (
          pg_catalog.jsonb_array_length(${alias}.top_items) between 1 and 100
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(${alias}.top_items) as top(item)
            where top.item -> 'isOrganic' is distinct from 'true'::jsonb
               or top.item -> 'isAd' is distinct from 'false'::jsonb
          )
        )
        else false
      end`;
}

function relatedCatalogProof(alias, productExpression) {
  return `${alias}.item ->> 'trackingRankSource' = 'related_catalog'
      and ${alias}.item ->> 'sourceLabel' = '원부'
      and ${alias}.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'
      and ${alias}.item ->> 'relatedCatalogProductId' ~ '^[0-9]{5,80}$'
      and ${alias}.item ->> 'catalogId' ~ '^[0-9]{5,80}$'
      and ${alias}.item ->> 'relatedCatalogProductId' = ${alias}.item ->> 'catalogId'
      and ${alias}.item ->> 'catalogId' <> ${productExpression}
      and case
        when pg_catalog.jsonb_typeof(${alias}.item -> 'catalogSellerProductIds') = 'array' then (
          pg_catalog.jsonb_array_length(${alias}.item -> 'catalogSellerProductIds') between 1 and 100
          and exists (
            select 1
            from pg_catalog.jsonb_array_elements_text(
              ${alias}.item -> 'catalogSellerProductIds'
            ) as seller_id(seller_id)
            where seller_id.seller_id = ${productExpression}
          )
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements_text(
              ${alias}.item -> 'catalogSellerProductIds'
            ) as seller_id(seller_id)
            where seller_id.seller_id !~ '^[0-9]{5,80}$'
          )
        )
        else false
      end`;
}

function atomicSnapshotProof(alias, productExpression) {
  return `${organicCollectorProof(alias)}
      and ${alias}.checked_count = 300
      and (
        (${alias}.matched is false and ${alias}.rank is null)
        or (
          ${alias}.matched is true
          and ${alias}.rank between 1 and 300
          and ${alias}.item -> 'isOrganic' = 'true'::jsonb
          and ${alias}.item -> 'isAd' = 'false'::jsonb
          and (
            (
              ${alias}.item ->> 'trackingRankSource' = 'exact_product'
              and ${alias}.item ->> 'productId' = ${productExpression}
            )
            or (${relatedCatalogProof(alias, productExpression)})
          )
        )
      )`;
}

function finiteSnapshotProof(alias, productExpression) {
  return `${organicCollectorProof(alias)}
      and ${alias}.checked_count between 1 and 299
      and ${alias}.matched is true
      and ${alias}.rank between 1 and ${alias}.checked_count
      and ${alias}.total = ${alias}.checked_count
      and ${alias}.item -> 'isOrganic' = 'true'::jsonb
      and ${alias}.item -> 'isAd' = 'false'::jsonb
      and ${alias}.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'
      and ${alias}.item -> 'sourceExhausted' = 'true'::jsonb
      and ${alias}.item -> 'finiteMarketTotal' = pg_catalog.to_jsonb(${alias}.checked_count)
      and ${alias}.item -> 'atomicSuccessEligible' = 'false'::jsonb
      and ${relatedCatalogProof(alias, productExpression)}`;
}

export function buildN30AccountRankHealthAuditSql({ observedAt } = {}) {
  const fixedObservedAt = requireObservedAt(observedAt);

  return `begin transaction isolation level repeatable read read only;
set local role service_role;
with
params as (
  select
    '${N30_ACCOUNT_HEALTH_AGENCY_CODE}'::text as agency_code,
    '${fixedObservedAt}'::timestamptz as observed_at,
    '${N30_ACCOUNT_HEALTH_WORKER_ID}'::text as worker_id,
    '${N30_ACCOUNT_HEALTH_RUNTIME_VERSION}'::text as runtime_version,
    '${N30_ACCOUNT_HEALTH_RUNTIME_FINGERPRINT}'::text as runtime_fingerprint
),
account_trackers as (
  select
    tracker.id as tracker_id,
    tracker.product_id,
    tracker.status,
    tracker.current_rank,
    tracker.last_checked_at,
    tracker.next_check_at,
    tracker.worker_quarantined_until,
    tracker.retry_count
  from public.naver_rank_trackers as tracker
  cross join params
  where tracker.agency_code = params.agency_code
),
active_trackers as (
  select tracker.*
  from account_trackers as tracker
  where tracker.status = 'active'
),
latest_completed_cycle as (
  select
    event.event_id as completed_event_id,
    event.cycle_id,
    event.cycle_number,
    event.occurred_at as completed_at
  from params
  left join lateral (
    select completed.*
    from public.naver_shopping_scheduler_events as completed
    where completed.event_type = 'cycle_completed'
      and completed.cycle_id is not null
      and completed.cycle_number is not null
      and completed.occurred_at <= params.observed_at
    order by completed.event_id desc
    limit 1
  ) as event on true
),
cycle_chain as (
  select
    cycle.*,
    count(*) filter (where event.event_type = 'cycle_started')::integer as cycle_start_count,
    count(*) filter (where event.event_type = 'cycle_completed')::integer
      as cycle_completed_count,
    min(event.event_id) filter (where event.event_type = 'cycle_started')
      as cycle_started_event_id,
    min(event.occurred_at) filter (where event.event_type = 'cycle_started')
      as cycle_started_at,
    min(event.cycle_number) filter (where event.event_type = 'cycle_started')
      as cycle_started_number,
    coalesce((
      count(*) filter (where event.event_type = 'cycle_started') = 1
      and count(*) filter (where event.event_type = 'cycle_completed') = 1
      and min(event.cycle_number) filter (where event.event_type = 'cycle_started')
        is not distinct from cycle.cycle_number
      and min(event.event_id) filter (where event.event_type = 'cycle_started')
        < cycle.completed_event_id
      and min(event.occurred_at) filter (where event.event_type = 'cycle_started')
        <= cycle.completed_at
    ), false) as cycle_integrity_ok
  from latest_completed_cycle as cycle
  cross join params
  left join public.naver_shopping_scheduler_events as event
    on event.cycle_id = cycle.cycle_id
   and event.event_type in ('cycle_started', 'cycle_completed')
   and event.occurred_at <= params.observed_at
  group by
    cycle.completed_event_id,
    cycle.cycle_id,
    cycle.cycle_number,
    cycle.completed_at
),
cycle_roster_events as (
  select
    tracker.*,
    cycle.cycle_start_count,
    cycle.cycle_completed_count,
    cycle.cycle_started_event_id,
    cycle.cycle_started_at,
    cycle.cycle_started_number,
    cycle.cycle_integrity_ok,
    cycle.completed_event_id,
    cycle.completed_at,
    cycle.cycle_id as selected_cycle_id,
    cycle.cycle_number as selected_cycle_number,
    event.event_id as roster_event_id,
    event.occurred_at as roster_at,
    event.agency_code as roster_agency_code,
    event.cycle_id as roster_cycle_id,
    event.cycle_number as roster_cycle_number,
    event.group_fingerprint as roster_group_fingerprint,
    event.roster_state,
    count(*) over (partition by tracker.tracker_id)::integer as roster_count,
    row_number() over (
      partition by tracker.tracker_id order by event.event_id
    )::integer as roster_sequence
  from active_trackers as tracker
  cross join params
  cross join cycle_chain as cycle
  join public.naver_shopping_scheduler_events as event
    on event.event_type = 'cycle_rostered'
   and event.tracker_id = tracker.tracker_id
   and event.cycle_id = cycle.cycle_id
   and event.occurred_at <= params.observed_at
),
eligible_trackers as (
  select
    roster.*,
    coalesce((
      roster.cycle_integrity_ok
      and roster.cycle_start_count = 1
      and roster.cycle_completed_count = 1
      and roster.cycle_started_number is not distinct from roster.selected_cycle_number
      and roster.cycle_started_event_id < roster.roster_event_id
      and roster.cycle_started_at <= roster.roster_at
      and roster.roster_event_id < roster.completed_event_id
      and roster.roster_at <= roster.completed_at
      and roster.roster_count = 1
      and roster.roster_agency_code = params.agency_code
      and roster.roster_cycle_id is not distinct from roster.selected_cycle_id
      and roster.roster_cycle_number is not distinct from roster.selected_cycle_number
      and roster.roster_group_fingerprint is not null
      and roster.roster_state = 'eligible'
    ), false) as roster_integrity
  from cycle_roster_events as roster
  cross join params
  where roster.roster_sequence = 1
    and roster.roster_state = 'eligible'
),
eligible_cycle_terminal_counts as (
  select
    tracker.tracker_id,
    count(event.event_id)::integer as cycle_terminal_event_count
  from eligible_trackers as tracker
  cross join params
  cross join cycle_chain as cycle
  left join public.naver_shopping_scheduler_events as event
    on event.tracker_id = tracker.tracker_id
   and event.cycle_id is not distinct from cycle.cycle_id
   and event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
   and event.occurred_at <= params.observed_at
  group by tracker.tracker_id
),
latest_valid_snapshot as (
  select
    tracker.tracker_id,
    snapshot.snapshot_id,
    snapshot.checked_at,
    snapshot.rank,
    snapshot.matched
  from active_trackers as tracker
  cross join params
  left join lateral (
    select
      snapshot.id as snapshot_id,
      snapshot.checked_at,
      snapshot.rank,
      snapshot.matched
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = tracker.tracker_id
      and snapshot.checked_at <= params.observed_at
      and (
        (${atomicSnapshotProof("snapshot", "tracker.product_id")})
        or (${finiteSnapshotProof("snapshot", "tracker.product_id")})
      )
    order by snapshot.checked_at desc, snapshot.id desc
    limit 1
  ) as snapshot on true
),
cycle_claim_events as (
  select
    tracker.*,
    event.event_id as claim_event_id,
    event.occurred_at as claim_at,
    event.claim_id,
    event.run_id,
    event.worker_id as claim_worker_id,
    event.agency_code as claim_agency_code,
    event.cycle_id as claim_cycle_id,
    event.cycle_number as claim_cycle_number,
    event.group_fingerprint as claim_group_fingerprint,
    event.priority as claim_priority,
    event.lease_started_at as claim_lease_started_at,
    event.lease_until as claim_lease_until,
    count(*) over (partition by tracker.tracker_id)::integer as claim_count,
    row_number() over (
      partition by tracker.tracker_id order by event.event_id
    )::integer as claim_sequence
  from eligible_trackers as tracker
  cross join params
  cross join cycle_chain as cycle
  join public.naver_shopping_scheduler_events as event
    on event.event_type = 'tracker_claimed'
   and event.tracker_id = tracker.tracker_id
   and event.cycle_id = cycle.cycle_id
   and event.occurred_at <= params.observed_at
),
selected_claims as (
  select claim.*
  from cycle_claim_events as claim
  where claim.claim_sequence = 1
),
claim_context as (
  select
    claim.*,
    run.worker_id as run_worker_id,
    run.run_trigger,
    run.runtime_version,
    run.runtime_fingerprint,
    run.started_at as run_started_at,
    grouped.event_id as group_event_id,
    grouped.occurred_at as group_at,
    grouped.run_id as group_run_id,
    grouped.worker_id as group_worker_id,
    grouped.cycle_id as group_cycle_id,
    grouped.cycle_number as group_cycle_number,
    grouped.group_fingerprint,
    grouped.priority as group_priority,
    grouped.lease_started_at as group_lease_started_at,
    grouped.lease_until as group_lease_until,
    grouped.details as group_details
  from selected_claims as claim
  left join public.naver_shopping_worker_runs as run on run.run_id = claim.run_id
  left join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    cross join params
    where event.event_type = 'group_claimed'
      and event.claim_id = claim.claim_id
      and event.occurred_at <= params.observed_at
    order by event.event_id
    limit 1
  ) as grouped on true
),
first_terminal as (
  select
    claim.*,
    terminal.event_id as terminal_event_id,
    terminal.occurred_at as terminal_at,
    terminal.event_type as terminal_type,
    terminal.run_id as terminal_run_id,
    terminal.tracker_id as terminal_tracker_id,
    terminal.worker_id as terminal_worker_id,
    terminal.agency_code as terminal_agency_code,
    terminal.cycle_id as terminal_cycle_id,
    terminal.cycle_number as terminal_cycle_number,
    terminal.group_fingerprint as terminal_group_fingerprint,
    terminal.priority as terminal_priority,
    terminal.lease_started_at as terminal_lease_started_at,
    terminal.lease_until as terminal_lease_until,
    terminal.collection_id,
    terminal.checked_count,
    terminal.error_code,
    terminal.details as terminal_details
  from claim_context as claim
  left join lateral (
    select terminal.*
    from public.naver_shopping_scheduler_events as terminal
    cross join params
    where terminal.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and terminal.claim_id = claim.claim_id
      and terminal.tracker_id = claim.tracker_id
      and terminal.occurred_at <= params.observed_at
    order by terminal.event_id
    limit 1
  ) as terminal on true
),
terminal_evidence as (
  select
    terminal.*,
    group_stats.group_event_count,
    group_claim_stats.group_claim_count,
    group_claim_stats.group_distinct_tracker_count,
    group_claim_stats.group_distinct_run_count,
    group_claim_stats.group_claim_identity_or_order_violation_count,
    group_claim_stats.group_claim_roster_violation_count,
    terminal_stats.terminal_count,
    terminal_stats.preclaim_terminal_count,
    terminal_stats.wrong_run_terminal_count,
    terminal_stats.terminal_distinct_run_count,
    cycle_terminal_stats.cycle_terminal_count,
    cycle_terminal_stats.other_claim_terminal_count,
    orphan_stats.orphan_terminal_count,
    snapshot_evidence.claim_window_snapshot_count,
    snapshot_evidence.terminal_snapshot_count,
    snapshot_evidence.atomic_terminal_snapshot_count,
    snapshot_evidence.finite_terminal_snapshot_count,
    snapshot_evidence.terminal_snapshot_found_count,
    snapshot_evidence.terminal_snapshot_rank
  from first_terminal as terminal
  cross join params
  cross join cycle_chain as cycle
  left join lateral (
    select count(*)::integer as group_event_count
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'group_claimed'
      and event.claim_id = terminal.claim_id
      and event.occurred_at <= params.observed_at
  ) as group_stats on true
  left join lateral (
    select
      count(*)::integer as group_claim_count,
      count(distinct event.tracker_id)::integer as group_distinct_tracker_count,
      count(distinct coalesce(event.run_id::text, '<null>'))::integer
        as group_distinct_run_count,
      count(*) filter (
        where event.tracker_id is null
           or event.run_id is distinct from terminal.run_id
           or event.worker_id is distinct from terminal.claim_worker_id
           or event.cycle_id is distinct from terminal.claim_cycle_id
           or event.cycle_number is distinct from terminal.claim_cycle_number
           or event.group_fingerprint is distinct from terminal.claim_group_fingerprint
           or event.priority is distinct from terminal.claim_priority
           or event.lease_started_at is null
           or event.lease_until is null
           or event.lease_started_at is distinct from terminal.claim_lease_started_at
           or event.lease_until is distinct from terminal.claim_lease_until
           or event.event_id <= terminal.group_event_id
           or event.occurred_at < terminal.group_at
           or event.event_id >= cycle.completed_event_id
           or event.occurred_at > cycle.completed_at
      )::integer as group_claim_identity_or_order_violation_count,
      count(*) filter (
        where (
          select count(*)
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id is not distinct from event.cycle_id
            and roster.cycle_number is not distinct from event.cycle_number
            and roster.tracker_id is not distinct from event.tracker_id
            and roster.agency_code is not distinct from event.agency_code
            and roster.group_fingerprint is not distinct from event.group_fingerprint
            and roster.roster_state = 'eligible'
            and roster.event_id > cycle.cycle_started_event_id
            and roster.event_id < terminal.group_event_id
            and roster.occurred_at >= cycle.cycle_started_at
            and roster.occurred_at <= terminal.group_at
            and roster.occurred_at <= params.observed_at
        ) <> 1
      )::integer as group_claim_roster_violation_count
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'tracker_claimed'
      and event.claim_id = terminal.claim_id
      and event.occurred_at <= params.observed_at
  ) as group_claim_stats on true
  left join lateral (
    select
      count(*)::integer as terminal_count,
      count(*) filter (
        where event.event_id <= terminal.claim_event_id
           or event.occurred_at < terminal.claim_at
      )::integer as preclaim_terminal_count,
      count(*) filter (
        where event.run_id is distinct from terminal.run_id
      )::integer as wrong_run_terminal_count,
      count(distinct coalesce(event.run_id::text, '<null>'))::integer
        as terminal_distinct_run_count
    from public.naver_shopping_scheduler_events as event
    where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and event.claim_id = terminal.claim_id
      and event.tracker_id = terminal.tracker_id
      and event.occurred_at <= params.observed_at
  ) as terminal_stats on true
  left join lateral (
    select
      count(*)::integer as cycle_terminal_count,
      count(*) filter (
        where event.claim_id is distinct from terminal.claim_id
      )::integer as other_claim_terminal_count
    from public.naver_shopping_scheduler_events as event
    where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and event.cycle_id is not distinct from terminal.claim_cycle_id
      and event.tracker_id = terminal.tracker_id
      and event.occurred_at <= params.observed_at
  ) as cycle_terminal_stats on true
  left join lateral (
    select count(*)::integer as orphan_terminal_count
    from public.naver_shopping_scheduler_events as event
    where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and event.claim_id = terminal.claim_id
      and event.occurred_at <= params.observed_at
      and not exists (
        select 1
        from public.naver_shopping_scheduler_events as claimed
        where claimed.event_type = 'tracker_claimed'
          and claimed.claim_id = event.claim_id
          and claimed.tracker_id = event.tracker_id
          and claimed.occurred_at <= params.observed_at
      )
  ) as orphan_stats on true
  left join lateral (
    select
      count(*) filter (
        where terminal.terminal_at is not null
          and snapshot.checked_at >= terminal.claim_at
          and snapshot.checked_at <= terminal.terminal_at
      )::integer as claim_window_snapshot_count,
      count(*) filter (
        where terminal.terminal_at is not null
          and snapshot.checked_at = terminal.terminal_at
          and snapshot.collection_id = terminal.collection_id
          and snapshot.item ->> 'collectionId' = terminal.collection_id
      )::integer as terminal_snapshot_count,
      count(*) filter (
        where terminal.terminal_at is not null
          and snapshot.checked_at = terminal.terminal_at
          and snapshot.collection_id = terminal.collection_id
          and snapshot.checked_count = terminal.checked_count
          and (${atomicSnapshotProof("snapshot", "terminal.product_id")})
      )::integer as atomic_terminal_snapshot_count,
      count(*) filter (
        where terminal.terminal_at is not null
          and snapshot.checked_at = terminal.terminal_at
          and snapshot.collection_id = terminal.collection_id
          and snapshot.checked_count = terminal.checked_count
          and (${finiteSnapshotProof("snapshot", "terminal.product_id")})
      )::integer as finite_terminal_snapshot_count,
      count(*) filter (
        where terminal.terminal_at is not null
          and snapshot.checked_at = terminal.terminal_at
          and snapshot.collection_id = terminal.collection_id
          and snapshot.matched is true
      )::integer as terminal_snapshot_found_count,
      min(snapshot.rank) filter (
        where terminal.terminal_at is not null
          and snapshot.checked_at = terminal.terminal_at
          and snapshot.collection_id = terminal.collection_id
      )::integer as terminal_snapshot_rank
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = terminal.tracker_id
      and snapshot.checked_at <= params.observed_at
  ) as snapshot_evidence on true
),
tracker_invariants as (
  select
    terminal.*,
    latest.snapshot_id as current_snapshot_id,
    latest.checked_at as current_snapshot_checked_at,
    latest.rank as current_snapshot_rank,
    latest.matched as current_snapshot_matched,
    tracker.current_rank,
    tracker.last_checked_at,
    tracker.next_check_at,
    tracker.worker_quarantined_until,
    (
      case
        when latest.snapshot_id is null then (
          tracker.current_rank is null and tracker.last_checked_at is null
        )
        else (
          tracker.current_rank is not distinct from latest.rank
          and tracker.last_checked_at is not distinct from latest.checked_at
        )
      end
    ) as current_materialization_valid,
    coalesce((
      terminal.cycle_integrity_ok
      and terminal.cycle_start_count = 1
      and terminal.cycle_completed_count = 1
      and terminal.cycle_started_number is not distinct from terminal.claim_cycle_number
      and terminal.cycle_started_event_id < terminal.roster_event_id
      and terminal.cycle_started_at <= terminal.roster_at
      and terminal.roster_count = 1
      and terminal.roster_event_id < terminal.group_event_id
      and terminal.roster_at <= terminal.group_at
      and terminal.roster_agency_code = params.agency_code
      and terminal.roster_cycle_id is not distinct from terminal.claim_cycle_id
      and terminal.roster_cycle_number is not distinct from terminal.claim_cycle_number
      and terminal.roster_group_fingerprint is not distinct from terminal.claim_group_fingerprint
      and terminal.roster_state = 'eligible'
      and terminal.claim_count = 1
      and terminal.claim_id is not null
      and terminal.run_id is not null
      and terminal.claim_worker_id = params.worker_id
      and terminal.claim_agency_code = params.agency_code
      and terminal.claim_cycle_id is not distinct from cycle.cycle_id
      and terminal.claim_cycle_number is not distinct from cycle.cycle_number
      and terminal.claim_group_fingerprint is not null
      and terminal.claim_priority in ('new', 'resume', 'normal')
      and terminal.group_event_count = 1
      and terminal.group_event_id < terminal.claim_event_id
      and terminal.group_at <= terminal.claim_at
      and terminal.group_run_id is not distinct from terminal.run_id
      and terminal.group_worker_id is not distinct from terminal.claim_worker_id
      and terminal.group_cycle_id is not distinct from terminal.claim_cycle_id
      and terminal.group_cycle_number is not distinct from terminal.claim_cycle_number
      and terminal.group_fingerprint is not distinct from terminal.claim_group_fingerprint
      and terminal.group_priority is not distinct from terminal.claim_priority
      and terminal.group_claim_count > 0
      and terminal.group_claim_count = terminal.group_distinct_tracker_count
      and terminal.group_distinct_run_count = 1
      and terminal.group_claim_identity_or_order_violation_count = 0
      and terminal.group_claim_roster_violation_count = 0
      and terminal.group_details -> 'memberCount'
        is not distinct from pg_catalog.to_jsonb(terminal.group_distinct_tracker_count)
      and terminal.run_trigger = 'rank-catch-up'
      and terminal.run_worker_id = params.worker_id
      and terminal.runtime_version = params.runtime_version
      and terminal.runtime_fingerprint = params.runtime_fingerprint
      and terminal.run_started_at is not null
      and terminal.claim_at <= terminal.run_started_at
      and terminal.claim_lease_started_at is not null
      and terminal.claim_lease_until is not null
      and terminal.group_lease_started_at is not null
      and terminal.group_lease_until is not null
      and terminal.claim_lease_started_at < terminal.claim_lease_until
      and terminal.group_lease_started_at is not distinct from terminal.claim_lease_started_at
      and terminal.group_lease_until is not distinct from terminal.claim_lease_until
      and terminal.claim_lease_started_at <= terminal.group_at
      and terminal.claim_at < terminal.claim_lease_until
    ), false) as claim_integrity,
    coalesce((
      terminal.terminal_count = 1
      and terminal.cycle_terminal_count = 1
      and terminal.other_claim_terminal_count = 0
      and terminal.orphan_terminal_count = 0
      and terminal.preclaim_terminal_count = 0
      and terminal.wrong_run_terminal_count = 0
      and terminal.terminal_distinct_run_count = 1
      and terminal.terminal_event_id > terminal.claim_event_id
      and terminal.terminal_at >= terminal.run_started_at
      and terminal.terminal_event_id < cycle.completed_event_id
      and terminal.terminal_at <= cycle.completed_at
      and terminal.terminal_run_id is not distinct from terminal.run_id
      and terminal.terminal_tracker_id is not distinct from terminal.tracker_id
      and terminal.terminal_worker_id is not distinct from terminal.claim_worker_id
      and terminal.terminal_agency_code is not distinct from terminal.claim_agency_code
      and terminal.terminal_cycle_id is not distinct from terminal.claim_cycle_id
      and terminal.terminal_cycle_number is not distinct from terminal.claim_cycle_number
      and terminal.terminal_group_fingerprint is not distinct from terminal.claim_group_fingerprint
      and terminal.terminal_priority is not distinct from terminal.claim_priority
      and terminal.terminal_lease_started_at is not null
      and terminal.terminal_lease_until is not null
      and terminal.terminal_lease_started_at is not distinct from terminal.claim_lease_started_at
      and terminal.terminal_lease_until is not distinct from terminal.claim_lease_until
      and terminal.terminal_lease_started_at < terminal.terminal_lease_until
      and terminal.terminal_lease_started_at <= terminal.terminal_at
      and terminal.terminal_at < terminal.terminal_lease_until
    ), false) as terminal_integrity
  from terminal_evidence as terminal
  cross join params
  cross join cycle_chain as cycle
  join active_trackers as tracker on tracker.tracker_id = terminal.tracker_id
  left join latest_valid_snapshot as latest on latest.tracker_id = terminal.tracker_id
),
tracker_facts as (
  select
    tracker.tracker_id,
    (eligible.tracker_id is not null) as eligible,
    latest.snapshot_id,
    latest.checked_at as valid_checked_at,
    terminal.claim_event_id,
    terminal.terminal_event_id,
    terminal.terminal_type,
    terminal.error_code,
    coalesce(cycle_terminals.cycle_terminal_event_count, 0)
      as cycle_terminal_event_count,
    (
      terminal.terminal_event_id is not null
      or coalesce(cycle_terminals.cycle_terminal_event_count, 0) > 0
    ) as terminal_evidence_present,
    coalesce(eligible.roster_integrity, false) as roster_integrity,
    coalesce(terminal.claim_integrity, false) as claim_integrity,
    coalesce((
      terminal.claim_integrity
      and terminal.terminal_integrity
      and terminal.current_materialization_valid
      and terminal.terminal_type = 'tracker_committed'
      and terminal.checked_count = 300
      and terminal.collection_id ~ '^pw-chrome-'
      and terminal.claim_window_snapshot_count = 1
      and terminal.terminal_snapshot_count = 1
      and terminal.atomic_terminal_snapshot_count = 1
      and terminal.finite_terminal_snapshot_count = 0
    ), false) as valid_atomic_success,
    coalesce((
      terminal.claim_integrity
      and terminal.terminal_integrity
      and terminal.current_materialization_valid
      and terminal.terminal_type = 'finite_window_committed'
      and terminal.checked_count between 1 and 299
      and terminal.collection_id ~ '^pw-chrome-'
      and terminal.claim_window_snapshot_count = 1
      and terminal.terminal_snapshot_count = 1
      and terminal.atomic_terminal_snapshot_count = 0
      and terminal.finite_terminal_snapshot_count = 1
      and terminal.terminal_details ->> 'source' = 'naver_shopping_results_collector'
      and terminal.terminal_details ->> 'relationBasis' = 'catalog_seller_product_id'
      and terminal.terminal_details ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'
      and terminal.terminal_details -> 'sourceExhausted' = 'true'::jsonb
      and terminal.terminal_details -> 'marketTotal' = pg_catalog.to_jsonb(terminal.checked_count)
      and terminal.terminal_details -> 'matched' = 'true'::jsonb
      and terminal.terminal_details -> 'rank' = pg_catalog.to_jsonb(terminal.terminal_snapshot_rank)
      and terminal.terminal_details -> 'atomicSuccessEligible' = 'false'::jsonb
    ), false) as valid_finite_success,
    coalesce(terminal.terminal_snapshot_found_count, 0) = 1 as found,
    coalesce((
      terminal.claim_integrity
      and terminal.terminal_integrity
      and terminal.current_materialization_valid
      and terminal.terminal_type = 'job_failed'
      and nullif(pg_catalog.btrim(terminal.error_code), '') is not null
      and terminal.claim_window_snapshot_count = 0
      and terminal.terminal_snapshot_count = 0
    ), false) as failed,
    coalesce(
      terminal.claim_event_id is not null
      and (
        terminal.claim_agency_code is distinct from params.agency_code
        or (
          terminal.terminal_event_id is not null
          and terminal.terminal_agency_code is distinct from params.agency_code
        )
      ),
      false
    ) as event_agency_mismatch
  from active_trackers as tracker
  cross join params
  left join eligible_trackers as eligible on eligible.tracker_id = tracker.tracker_id
  left join latest_valid_snapshot as latest on latest.tracker_id = tracker.tracker_id
  left join tracker_invariants as terminal on terminal.tracker_id = tracker.tracker_id
  left join eligible_cycle_terminal_counts as cycle_terminals
    on cycle_terminals.tracker_id = tracker.tracker_id
),
classified_tracker_facts as (
  select
    tracker.*,
    (
      tracker.eligible
      and tracker.claim_event_id is null
      and not tracker.terminal_evidence_present
      and tracker.roster_integrity
    ) as unclaimed_open,
    (
      tracker.eligible
      and tracker.claim_event_id is not null
      and not tracker.terminal_evidence_present
      and tracker.claim_integrity
    ) as claimed_open,
    (
      tracker.eligible
      and not tracker.terminal_evidence_present
      and (
        (tracker.claim_event_id is null and not tracker.roster_integrity)
        or (tracker.claim_event_id is not null and not tracker.claim_integrity)
      )
    ) as preterminal_integrity_failure,
    (
      tracker.eligible
      and tracker.terminal_evidence_present
      and not coalesce(tracker.failed, false)
      and not coalesce(tracker.valid_atomic_success, false)
      and not coalesce(tracker.valid_finite_success, false)
    ) as terminal_integrity_failure
  from tracker_facts as tracker
),
summary as (
  select
    count(*)::integer as active_tracker_count,
    count(*) filter (where eligible)::integer as eligible_tracker_count,
    count(*) filter (where claim_event_id is not null)::integer as claimed_tracker_count,
    count(*) filter (where terminal_evidence_present)::integer as terminal_tracker_count,
    count(*) filter (
      where coalesce(valid_atomic_success, false)
         or coalesce(valid_finite_success, false)
    )::integer as valid_success_tracker_count,
    count(*) filter (
      where (
        coalesce(valid_atomic_success, false)
        or coalesce(valid_finite_success, false)
      ) and found
    )::integer as found_tracker_count,
    count(*) filter (where failed)::integer as failure_tracker_count,
    count(*) filter (
      where preterminal_integrity_failure or terminal_integrity_failure
    )::integer as integrity_failure_tracker_count,
    count(*) filter (
      where unclaimed_open or claimed_open
    )::integer as open_tracker_count,
    count(*) filter (where unclaimed_open)::integer as unclaimed_open_tracker_count,
    count(*) filter (where claimed_open)::integer as claimed_open_tracker_count,
    count(*) filter (where preterminal_integrity_failure)::integer
      as preterminal_integrity_failure_tracker_count,
    count(*) filter (where terminal_integrity_failure)::integer
      as terminal_integrity_failure_tracker_count,
    count(*) filter (where snapshot_id is null)::integer as never_checked_tracker_count,
    count(*) filter (
      where snapshot_id is null
         or valid_checked_at <= params.observed_at - interval '24 hours'
    )::integer as stale_24h_tracker_count,
    count(*) filter (where event_agency_mismatch)::integer as event_agency_mismatch_count
  from classified_tracker_facts
  cross join params
),
ratios as (
  select
    case when eligible_tracker_count = 0 then 0
      else terminal_tracker_count::numeric / eligible_tracker_count end as coverage_ratio,
    case when terminal_tracker_count = 0 then 0
      else valid_success_tracker_count::numeric / terminal_tracker_count end as terminal_success_ratio,
    case when eligible_tracker_count = 0 then 0
      else valid_success_tracker_count::numeric / eligible_tracker_count end as effective_success_ratio,
    case when eligible_tracker_count = 0 then 0
      else found_tracker_count::numeric / eligible_tracker_count end as found_ratio
  from summary
),
processing as (
  select (
    (select count(*)
      from public.naver_shopping_rank_lookup_jobs as lookup
      where lookup.status = 'processing'
        and lookup.processing_until > params.observed_at)
    +
    (select count(*)
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.processing_until > params.observed_at)
  )::integer as processing_count
  from params
),
control_plane_source as (
  select
    coordination.*,
    (coordination.lease_token is null) as lease_token_is_null
  from public.naver_shopping_worker_coordination as coordination
  where coordination.lane_key = 'global'
),
control_plane as (
  select
    count(*)::integer as control_row_count,
    coalesce(bool_and(
      control.primary_worker_id = params.worker_id
      and control.primary_seen_at > params.observed_at - interval '3 minutes'
      and control.primary_seen_at <= params.observed_at
      and control.circuit_state = 'closed'
      and control.circuit_reason is null
      and control.cooldown_until is null
      and control.runtime_version = params.runtime_version
      and control.runtime_fingerprint = params.runtime_fingerprint
      and control.updated_at <= params.observed_at
      and processing.processing_count = 0
      and control.lease_worker_id is null
      and control.lease_token_is_null
      and control.lease_until is null
      and control.run_id is null
      and control.current_stage is null
      and control.current_page = 0
      and control.current_job_kind is null
      and control.current_tracker_id is null
      and control.current_job_started_at is null
      and control.probe_tracker_id is null
      and control.probe_started_at is null
    ), false) as control_plane_ok,
    coalesce(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'primaryWorkerId', control.primary_worker_id,
        'primarySeenAt', control.primary_seen_at,
        'circuitState', control.circuit_state,
        'circuitReason', control.circuit_reason,
        'cooldownUntil', control.cooldown_until,
        'runtimeVersion', control.runtime_version,
        'runtimeFingerprint', control.runtime_fingerprint,
        'updatedAt', control.updated_at,
        'processingCount', processing.processing_count,
        'leaseWorkerId', control.lease_worker_id,
        'leaseUntil', control.lease_until,
        'runId', control.run_id,
        'currentStage', control.current_stage,
        'currentPage', control.current_page,
        'currentJobKind', control.current_job_kind,
        'currentTrackerId', control.current_tracker_id,
        'currentJobStartedAt', control.current_job_started_at,
        'probeTrackerId', control.probe_tracker_id,
        'probeStartedAt', control.probe_started_at,
        'leaseTokenIsNull', control.lease_token_is_null
      )) -> 0,
      '{}'::jsonb
    ) as details
  from control_plane_source as control
  cross join params
  cross join processing
)
select pg_catalog.jsonb_build_object(
  'marker', 'n30_account_rank_health_audit_v2',
  'observedAt', params.observed_at,
  'agencyCode', params.agency_code,
  'cycleIntegrityOk', cycle.cycle_integrity_ok,
  'activeTrackerCount', summary.active_tracker_count,
  'eligibleTrackerCount', summary.eligible_tracker_count,
  'claimedTrackerCount', summary.claimed_tracker_count,
  'terminalTrackerCount', summary.terminal_tracker_count,
  'validSuccessTrackerCount', summary.valid_success_tracker_count,
  'foundTrackerCount', summary.found_tracker_count,
  'failureTrackerCount', summary.failure_tracker_count,
  'integrityFailureTrackerCount', summary.integrity_failure_tracker_count,
  'openTrackerCount', summary.open_tracker_count,
  'unclaimedOpenTrackerCount', summary.unclaimed_open_tracker_count,
  'claimedOpenTrackerCount', summary.claimed_open_tracker_count,
  'preterminalIntegrityFailureTrackerCount',
    summary.preterminal_integrity_failure_tracker_count,
  'terminalIntegrityFailureTrackerCount', summary.terminal_integrity_failure_tracker_count,
  'neverCheckedTrackerCount', summary.never_checked_tracker_count,
  'stale24hTrackerCount', summary.stale_24h_tracker_count,
  'eventAgencyMismatchCount', summary.event_agency_mismatch_count,
  'coverageRatio', ratios.coverage_ratio,
  'terminalSuccessRatio', ratios.terminal_success_ratio,
  'effectiveSuccessRatio', ratios.effective_success_ratio,
  'foundRatio', ratios.found_ratio,
  'controlPlaneOk', control_plane.control_row_count = 1 and control_plane.control_plane_ok,
  'controlPlane', control_plane.details
) as audit
from params
cross join cycle_chain as cycle
cross join summary
cross join ratios
cross join processing
cross join control_plane;
commit;`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const observedAt = process.argv[2];
  process.stdout.write(`${buildN30AccountRankHealthAuditSql({ observedAt })}\n`);
}

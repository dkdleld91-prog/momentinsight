const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{2,63}$/;
const RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export const N30_TARGET_WORKER_ID = "windows-desktop-primary";
export const N30_TARGET_RUNTIME_VERSION = "1.1.18";
export const N30_TARGET_RUNTIME_FINGERPRINT =
  "65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c";

function requireUtcTimestamp(value, fieldName) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${fieldName} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function requirePattern(value, pattern, fieldName) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${fieldName} is invalid`);
  }
  return value;
}

export function buildN30CandidatePerformanceAuditSql(options = {}) {
  const activationAt = requireUtcTimestamp(options.activationAt, "activationAt");
  const observedAt = requireUtcTimestamp(options.observedAt, "observedAt");
  if (Date.parse(observedAt) <= Date.parse(activationAt)) {
    throw new RangeError("observedAt must be after activationAt");
  }

  const cadenceSeconds = Number(options.cadenceSeconds);
  if (!Number.isInteger(cadenceSeconds) || ![360, 600].includes(cadenceSeconds)) {
    throw new RangeError("cadenceSeconds must be 360 or 600");
  }

  const workerId = requirePattern(options.workerId, WORKER_ID_PATTERN, "workerId");
  const runtimeVersion = requirePattern(
    options.runtimeVersion,
    RUNTIME_VERSION_PATTERN,
    "runtimeVersion",
  );
  const runtimeFingerprint = requirePattern(
    options.runtimeFingerprint,
    FINGERPRINT_PATTERN,
    "runtimeFingerprint",
  );
  if (runtimeFingerprint === "0".repeat(64)) {
    throw new TypeError("runtimeFingerprint is invalid");
  }
  if (workerId !== N30_TARGET_WORKER_ID) {
    throw new RangeError("workerId must equal the pinned target");
  }
  if (runtimeVersion !== N30_TARGET_RUNTIME_VERSION) {
    throw new RangeError("runtimeVersion must equal the pinned target");
  }
  if (runtimeFingerprint !== N30_TARGET_RUNTIME_FINGERPRINT) {
    throw new RangeError("runtimeFingerprint must equal the pinned target");
  }

  return `begin read only;
set local transaction isolation level repeatable read;
with
params as (
  select
    '${activationAt}'::timestamptz as activation_at,
    '${observedAt}'::timestamptz as observed_at,
    ${cadenceSeconds}::integer as cadence_seconds,
    120::integer as grid_tolerance_seconds,
    7200::integer as minimum_wall_seconds,
    18::integer as minimum_post_bootstrap_groups,
    8.77::numeric as minimum_group_per_hour,
    '${workerId}'::text as worker_id,
    '${runtimeVersion}'::text as runtime_version,
    '${runtimeFingerprint}'::text as runtime_fingerprint
),
group_events as (
  select e.*
  from public.naver_shopping_scheduler_events e, params p
  where e.event_type = 'group_claimed'
    and e.occurred_at > p.activation_at
    and e.occurred_at <= p.observed_at
),
provenance_audit as (
  select
    count(*)::integer as group_event_count,
    count(*) filter (
      where r.run_id is null
         or e.worker_id is distinct from p.worker_id
         or r.worker_id is distinct from p.worker_id
         or r.runtime_version is distinct from p.runtime_version
         or r.runtime_fingerprint is distinct from p.runtime_fingerprint
    )::integer as missing_or_identity_mismatch,
    count(*) filter (where r.run_trigger = 'rank-catch-up')::integer as catch_up_count,
    count(*) filter (where r.run_trigger = 'rank-remote')::integer as remote_count,
    count(*) filter (where r.run_trigger in ('rank-0900', 'rank-1500'))::integer as clock_count,
    count(*) filter (where r.run_trigger in ('manual', 'mac-standby', 'github-cloud'))::integer as other_excluded_count
  from group_events e
  cross join params p
  left join public.naver_shopping_worker_runs r on r.run_id = e.run_id
),
exact_runs as (
  select r.*
  from public.naver_shopping_worker_runs r, params p
  where r.started_at > p.activation_at
    and r.started_at <= p.observed_at
    and r.worker_id = p.worker_id
    and r.runtime_version = p.runtime_version
    and r.runtime_fingerprint = p.runtime_fingerprint
),
run_group as (
  select
    r.run_id,
    r.run_trigger,
    r.started_at,
    g.event_id as group_event_id,
    g.claim_id,
    g.cycle_id,
    g.cycle_number,
    g.group_fingerprint,
    g.priority,
    g.claim_at,
    g.details as group_details,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events ge, params p
      where ge.run_id = r.run_id
        and ge.event_type = 'group_claimed'
        and ge.occurred_at > p.activation_at
        and ge.occurred_at <= p.observed_at
    ) as group_count
  from exact_runs r
  left join lateral (
    select
      ge.event_id,
      ge.claim_id,
      ge.cycle_id,
      ge.cycle_number,
      ge.group_fingerprint,
      ge.priority,
      ge.occurred_at as claim_at,
      ge.details
    from public.naver_shopping_scheduler_events ge, params p
    where ge.run_id = r.run_id
      and ge.event_type = 'group_claimed'
      and ge.occurred_at > p.activation_at
      and ge.occurred_at <= p.observed_at
    order by ge.event_id
    limit 1
  ) g on true
),
claim_facts as (
  select
    rg.*,
    before_cursor.tracker_id as cursor_before_tracker_id,
    before_cursor.sort_order as cursor_before_sort_order,
    before_cursor.created_at as cursor_before_created_at,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events tc, params p
      where tc.event_type = 'tracker_claimed'
        and tc.claim_id = rg.claim_id
        and tc.run_id = rg.run_id
        and tc.occurred_at <= p.observed_at
    ) as tracker_claim_count,
    (
      select count(distinct tc.tracker_id)::integer
      from public.naver_shopping_scheduler_events tc, params p
      where tc.event_type = 'tracker_claimed'
        and tc.claim_id = rg.claim_id
        and tc.run_id = rg.run_id
        and tc.occurred_at <= p.observed_at
    ) as distinct_tracker_claim_count,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events tc, params p
      where tc.event_type = 'tracker_claimed'
        and tc.claim_id = rg.claim_id
        and tc.run_id = rg.run_id
        and tc.occurred_at <= p.observed_at
        and (
          tc.worker_id is distinct from p.worker_id
          or tc.group_fingerprint is distinct from rg.group_fingerprint
          or rg.claim_at is null
          or tc.occurred_at < rg.claim_at
        )
    ) as tracker_claim_identity_or_order_violation_count,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events cm, params p
      where cm.event_type = 'tracker_committed'
        and cm.claim_id = rg.claim_id
        and cm.run_id = rg.run_id
        and cm.occurred_at <= p.observed_at
    ) as commit_count,
    (
      select count(distinct cm.tracker_id)::integer
      from public.naver_shopping_scheduler_events cm, params p
      where cm.event_type = 'tracker_committed'
        and cm.claim_id = rg.claim_id
        and cm.run_id = rg.run_id
        and cm.occurred_at <= p.observed_at
    ) as distinct_commit_tracker_count,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events fw, params p
      where fw.event_type = 'finite_window_committed'
        and fw.claim_id = rg.claim_id
        and fw.run_id = rg.run_id
        and fw.occurred_at <= p.observed_at
    ) as finite_commit_count,
    (
      select count(distinct fw.tracker_id)::integer
      from public.naver_shopping_scheduler_events fw, params p
      where fw.event_type = 'finite_window_committed'
        and fw.claim_id = rg.claim_id
        and fw.run_id = rg.run_id
        and fw.occurred_at <= p.observed_at
    ) as distinct_finite_commit_tracker_count,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events fw, params p
      where fw.event_type = 'finite_window_committed'
        and fw.claim_id = rg.claim_id
        and fw.run_id = rg.run_id
        and fw.occurred_at <= p.observed_at
        and (
          rg.run_trigger is distinct from 'rank-catch-up'
          or fw.worker_id is distinct from p.worker_id
          or fw.group_fingerprint is distinct from rg.group_fingerprint
          or fw.cycle_id is distinct from rg.cycle_id
          or fw.priority is distinct from rg.priority
          or fw.priority is null
          or fw.priority not in ('new', 'resume', 'normal')
          or fw.occurred_at < rg.claim_at
          or fw.collection_id is null
          or fw.collection_id !~ '^pw-chrome-'
          or fw.checked_count is null
          or fw.checked_count not between 1 and 299
          or rg.group_details -> 'memberCount' is distinct from pg_catalog.to_jsonb(1)
          or fw.details ->> 'source' is distinct from 'naver_shopping_results_collector'
          or fw.details ->> 'finiteWindowProofVersion' is distinct from 'stable-finite-window-v1'
          or fw.details -> 'sourceExhausted' is distinct from 'true'::jsonb
          or fw.details -> 'marketTotal' is distinct from pg_catalog.to_jsonb(fw.checked_count)
          or fw.details -> 'matched' is distinct from 'true'::jsonb
          or fw.details ->> 'relationBasis' is distinct from 'catalog_seller_product_id'
          or fw.details -> 'atomicSuccessEligible' is distinct from 'false'::jsonb
          or (
            select count(*)
            from public.naver_shopping_scheduler_events tc
            where tc.event_type = 'tracker_claimed'
              and tc.claim_id = fw.claim_id
              and tc.run_id = fw.run_id
              and tc.group_fingerprint = fw.group_fingerprint
              and tc.tracker_id = fw.tracker_id
              and tc.worker_id = p.worker_id
              and tc.cycle_id is not distinct from fw.cycle_id
              and tc.priority is not distinct from fw.priority
              and tc.lease_started_at = fw.lease_started_at
              and tc.event_id > rg.group_event_id
              and tc.event_id < fw.event_id
              and tc.occurred_at >= rg.claim_at
              and tc.occurred_at <= fw.occurred_at
          ) <> 1
          or (
            select count(*)
            from public.naver_shopping_scheduler_events tc
            where tc.event_type = 'tracker_claimed'
              and tc.claim_id = fw.claim_id
              and tc.run_id = fw.run_id
              and tc.occurred_at <= fw.occurred_at
          ) <> 1
          or (
            select count(*)
            from public.naver_rank_snapshots s
            join public.naver_shopping_finite_window_targets target
              on target.tracker_id = s.tracker_id
             and target.enabled = true
             and target.proof_version = 'stable-finite-window-v1'
             and target.runtime_version = p.runtime_version
             and target.runtime_fingerprint = p.runtime_fingerprint
            join public.naver_rank_trackers tracker
              on tracker.id = s.tracker_id
             and tracker.status = 'active'
             and tracker.product_id = target.seller_product_id
             and pg_catalog.regexp_replace(
               pg_catalog.lower(pg_catalog.btrim(tracker.keyword)), '\\s+', '', 'g'
             ) = target.normalized_keyword
            where s.tracker_id = fw.tracker_id
              and s.collection_id = fw.collection_id
              and s.checked_at = fw.occurred_at
              and s.checked_count = fw.checked_count
              and s.checked_count between 1 and 299
              and s.source = 'naver_shopping_results_collector'
              and s.matched = true
              and s.rank between 1 and s.checked_count
              and s.total = s.checked_count
              and fw.details -> 'rank' = pg_catalog.to_jsonb(s.rank)
              and pg_catalog.jsonb_typeof(s.item) = 'object'
              and s.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'
              and s.item -> 'sourceExhausted' = 'true'::jsonb
              and s.item -> 'finiteMarketTotal' = pg_catalog.to_jsonb(s.checked_count)
              and s.item -> 'atomicSuccessEligible' = 'false'::jsonb
              and s.item ->> 'trackingRankSource' = 'related_catalog'
              and s.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'
              and s.item ->> 'relatedCatalogProductId' = target.parent_catalog_id
              and s.item ->> 'catalogId' = target.parent_catalog_id
              and pg_catalog.jsonb_typeof(s.item -> 'catalogSellerProductIds') = 'array'
              and pg_catalog.jsonb_array_length(s.item -> 'catalogSellerProductIds') between 1 and 100
              and exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(
                  s.item -> 'catalogSellerProductIds'
                ) seller_id(seller_id)
                where seller_id.seller_id = target.seller_product_id
              )
              and not exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(
                  s.item -> 'catalogSellerProductIds'
                ) seller_id(seller_id)
                where seller_id.seller_id !~ '^[0-9]{5,80}$'
              )
              and s.item ->> 'rankPolicy' = 'organic_only'
              and s.item -> 'adExcluded' = 'true'::jsonb
              and s.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
              and s.item ->> 'collectionId' = fw.collection_id
              and s.item -> 'isOrganic' = 'true'::jsonb
              and s.item -> 'isAd' = 'false'::jsonb
              and pg_catalog.jsonb_typeof(s.top_items) = 'array'
              and not exists (
                select 1
                from pg_catalog.jsonb_array_elements(s.top_items) top_item
                where top_item -> 'isOrganic' is distinct from 'true'::jsonb
                   or top_item -> 'isAd' is distinct from 'false'::jsonb
              )
          ) <> 1
        )
    ) as finite_invalid_terminal_count,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events cm, params p
      where cm.event_type = 'tracker_committed'
        and cm.claim_id = rg.claim_id
        and cm.run_id = rg.run_id
        and cm.occurred_at <= p.observed_at
        and (
          cm.worker_id is distinct from p.worker_id
          or cm.group_fingerprint is distinct from rg.group_fingerprint
          or not exists (
            select 1
            from public.naver_shopping_scheduler_events tc
            where tc.event_type = 'tracker_claimed'
              and tc.claim_id = cm.claim_id
              and tc.run_id = cm.run_id
              and tc.group_fingerprint = cm.group_fingerprint
              and tc.tracker_id = cm.tracker_id
              and tc.worker_id = p.worker_id
              and tc.occurred_at >= rg.claim_at
              and tc.occurred_at <= cm.occurred_at
          )
        )
    ) as commit_membership_mismatch_count,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events cm, params p
      where cm.event_type = 'tracker_committed'
        and cm.claim_id = rg.claim_id
        and cm.run_id = rg.run_id
        and cm.occurred_at <= p.observed_at
        and (
          cm.occurred_at < rg.claim_at
          or not exists (
            select 1
            from public.naver_shopping_scheduler_events tc
            where tc.event_type = 'tracker_claimed'
              and tc.claim_id = cm.claim_id
              and tc.run_id = cm.run_id
              and tc.group_fingerprint = cm.group_fingerprint
              and tc.tracker_id = cm.tracker_id
              and tc.worker_id = p.worker_id
              and tc.occurred_at >= rg.claim_at
              and tc.occurred_at <= cm.occurred_at
          )
          or not exists (
            select 1
            from public.naver_rank_snapshots s
            where s.tracker_id = cm.tracker_id
              and s.collection_id = cm.collection_id
              and s.checked_at >= rg.claim_at
              and s.checked_at <= cm.occurred_at
          )
        )
    ) as event_order_violation_count,
    (
      select count(distinct cm.collection_id)::integer
      from public.naver_shopping_scheduler_events cm, params p
      where cm.event_type = 'tracker_committed'
        and cm.claim_id = rg.claim_id
        and cm.run_id = rg.run_id
        and cm.occurred_at <= p.observed_at
    ) as collection_count,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events fl, params p
      where fl.event_type = 'job_failed'
        and fl.claim_id = rg.claim_id
        and fl.run_id = rg.run_id
        and fl.occurred_at <= p.observed_at
    ) as failure_count,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events nf, params p
      where nf.event_type = 'job_failed'
        and nf.claim_id = rg.claim_id
        and nf.run_id = rg.run_id
        and nf.occurred_at <= p.observed_at
        and nf.error_code in (
          'provider_stable_finite_window_unproven',
          'local_worker_finite_match_invalid'
        )
        and rg.run_trigger = 'rank-catch-up'
        and nf.worker_id = p.worker_id
        and nf.group_fingerprint = rg.group_fingerprint
        and nf.cycle_id is not distinct from rg.cycle_id
        and nf.priority is not distinct from rg.priority
        and nf.priority in ('new', 'resume', 'normal')
        and rg.group_details -> 'memberCount' = pg_catalog.to_jsonb(1)
        and nf.event_id > rg.group_event_id
        and nf.occurred_at >= rg.claim_at
        and exists (
          select 1
          from public.naver_shopping_finite_window_targets target
          join public.naver_rank_trackers tracker
            on tracker.id = target.tracker_id
           and tracker.status = 'active'
           and tracker.product_id = target.seller_product_id
           and pg_catalog.regexp_replace(
             pg_catalog.lower(pg_catalog.btrim(tracker.keyword)), '\\s+', '', 'g'
           ) = target.normalized_keyword
          where target.tracker_id = nf.tracker_id
            and target.enabled = true
            and target.proof_version = 'stable-finite-window-v1'
            and target.runtime_version = p.runtime_version
            and target.runtime_fingerprint = p.runtime_fingerprint
        )
        and (
          select count(*)
          from public.naver_shopping_scheduler_events tc
          where tc.event_type = 'tracker_claimed'
            and tc.claim_id = nf.claim_id
            and tc.run_id = nf.run_id
            and tc.group_fingerprint = nf.group_fingerprint
            and tc.tracker_id = nf.tracker_id
            and tc.worker_id = nf.worker_id
            and tc.priority is not distinct from nf.priority
            and tc.lease_started_at = nf.lease_started_at
            and tc.event_id > rg.group_event_id
            and tc.event_id < nf.event_id
            and tc.occurred_at >= rg.claim_at
            and tc.occurred_at <= nf.occurred_at
        ) = 1
        and (
          select count(*)
          from public.naver_shopping_scheduler_events tc
          where tc.event_type = 'tracker_claimed'
            and tc.claim_id = nf.claim_id
            and tc.run_id = nf.run_id
            and tc.occurred_at <= nf.occurred_at
        ) = 1
        and (
          select count(*)
          from public.naver_shopping_scheduler_events duplicate_failure
          where duplicate_failure.event_type = 'job_failed'
            and duplicate_failure.claim_id = nf.claim_id
            and duplicate_failure.run_id = nf.run_id
            and duplicate_failure.occurred_at <= p.observed_at
        ) = 1
        and not exists (
          select 1
          from public.naver_shopping_scheduler_events competing_terminal
          where competing_terminal.claim_id = nf.claim_id
            and competing_terminal.run_id = nf.run_id
            and competing_terminal.tracker_id = nf.tracker_id
            and competing_terminal.event_type in (
              'tracker_committed', 'finite_window_committed'
            )
            and competing_terminal.occurred_at <= p.observed_at
        )
        and (
          select count(*)
          from public.naver_shopping_scheduler_events q
          where q.event_type = 'quarantine_set'
            and q.claim_id = nf.claim_id
            and q.run_id = nf.run_id
            and q.worker_id = nf.worker_id
            and q.tracker_id = nf.tracker_id
            and q.cycle_id is not distinct from nf.cycle_id
            and q.group_fingerprint = nf.group_fingerprint
            and q.priority is not distinct from nf.priority
            and q.error_code = nf.error_code
            and q.event_id > nf.event_id
            and q.occurred_at >= nf.occurred_at
            and q.occurred_at <= p.observed_at
            and q.quarantine_until >= nf.occurred_at + interval '30 minutes'
            and q.quarantine_until <= q.occurred_at + interval '30 minutes'
        ) = 1
        and (
          select count(*)
          from public.naver_shopping_scheduler_events q
          where q.event_type = 'quarantine_set'
            and q.claim_id = nf.claim_id
            and q.run_id = nf.run_id
            and q.tracker_id = nf.tracker_id
            and q.occurred_at <= p.observed_at
        ) = 1
    ) as finite_neutral_failure_count,
    (
      select count(*)::integer
      from public.naver_shopping_scheduler_events cm, params p
      where cm.event_type = 'tracker_committed'
        and cm.claim_id = rg.claim_id
        and cm.run_id = rg.run_id
        and cm.occurred_at <= p.observed_at
        and (
          cm.worker_id is distinct from p.worker_id
          or cm.group_fingerprint is distinct from rg.group_fingerprint
          or not exists (
            select 1
            from public.naver_shopping_scheduler_events tc
            where tc.event_type = 'tracker_claimed'
              and tc.claim_id = cm.claim_id
              and tc.run_id = cm.run_id
              and tc.group_fingerprint = cm.group_fingerprint
              and tc.tracker_id = cm.tracker_id
              and tc.worker_id = p.worker_id
              and tc.occurred_at >= rg.claim_at
              and tc.occurred_at <= cm.occurred_at
          )
          or cm.checked_count is distinct from 300
          or cm.details ->> 'source' is distinct from 'naver_shopping_results_collector'
          or cm.collection_id is null
          or cm.collection_id !~ '^pw-chrome-'
          or (
            select count(*)
            from public.naver_rank_snapshots s
            where s.tracker_id = cm.tracker_id
              and s.collection_id = cm.collection_id
              and s.checked_at >= (
                select min(tc.occurred_at)
                from public.naver_shopping_scheduler_events tc
                where tc.event_type = 'tracker_claimed'
                  and tc.claim_id = cm.claim_id
                  and tc.run_id = cm.run_id
                  and tc.group_fingerprint = cm.group_fingerprint
                  and tc.tracker_id = cm.tracker_id
                  and tc.worker_id = p.worker_id
                  and tc.occurred_at >= rg.claim_at
                  and tc.occurred_at <= cm.occurred_at
              )
              and s.checked_at <= cm.occurred_at
              and s.checked_count = 300
              and s.source = 'naver_shopping_results_collector'
              and pg_catalog.jsonb_typeof(s.item) = 'object'
              and (s.matched = false or s.item -> 'isOrganic' = 'true'::jsonb)
              and s.item -> 'adExcluded' = 'true'::jsonb
              and s.item ->> 'rankPolicy' = 'organic_only'
              and s.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
              and s.item ->> 'collectionId' = cm.collection_id
              and case
                when pg_catalog.jsonb_typeof(s.item -> 'excludedAdCount') = 'number'
                  and (s.item ->> 'excludedAdCount') ~ '^[0-9]+$'
                then (s.item ->> 'excludedAdCount')::numeric >= 0
                else false
              end
              and pg_catalog.jsonb_typeof(s.top_items) = 'array'
              and not exists (
                select 1
                from pg_catalog.jsonb_array_elements(
                  case
                    when pg_catalog.jsonb_typeof(s.top_items) = 'array'
                    then s.top_items
                    else '[]'::jsonb
                  end
                ) ti
                where ti -> 'isOrganic' is distinct from 'true'::jsonb
                   or ti -> 'isAd' is distinct from 'false'::jsonb
              )
          ) <> 1
        )
    ) as atomic_invalid_commit_count,
    (
      select max(te.occurred_at)
      from public.naver_shopping_scheduler_events te, params p
      where te.claim_id = rg.claim_id
        and te.run_id = rg.run_id
        and te.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
        and te.occurred_at <= p.observed_at
    ) as terminal_at
  from run_group rg
  left join lateral (
    select
      t.id as tracker_id,
      case
        when (rg.group_details ->> 'cursorSortOrderBefore') ~ '^-?[0-9]+$'
        then (rg.group_details ->> 'cursorSortOrderBefore')::numeric
        else null
      end as sort_order,
      t.created_at
    from public.naver_rank_trackers t
    where t.id = case
      when rg.group_details ->> 'cursorTrackerBefore'
        ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      then (rg.group_details ->> 'cursorTrackerBefore')::uuid
      else null
    end
  ) before_cursor on true
),
catchup_ordered as (
  select
    cf.*,
    row_number() over (order by cf.claim_at, cf.claim_id) as sequence_no,
    lag(cf.claim_at) over (order by cf.claim_at, cf.claim_id) as previous_claim_at,
    (
      group_count = 1
      and tracker_claim_count >= 1
      and tracker_claim_count = distinct_tracker_claim_count
      and tracker_claim_identity_or_order_violation_count = 0
      and commit_count = tracker_claim_count
      and commit_count = distinct_commit_tracker_count
      and finite_commit_count = 0
      and commit_membership_mismatch_count = 0
      and event_order_violation_count = 0
      and collection_count = 1
      and failure_count = 0
      and atomic_invalid_commit_count = 0
      and terminal_at is not null
      and terminal_at <= p.observed_at
    ) as fully_terminal_atomic
  from claim_facts cf
  cross join params p
  where cf.run_trigger = 'rank-catch-up'
),
catchup_classified as (
  select
    co.*,
    count(*) filter (where co.fully_terminal_atomic)
      over (order by co.claim_at, co.claim_id) as atomic_sequence_no,
    round(
      extract(epoch from (
        co.claim_at - min(co.claim_at) filter (where co.fully_terminal_atomic) over ()
      ))::numeric / p.cadence_seconds
    )::integer as slot_number,
    case when previous_atomic.claim_at is null then null else
      round(extract(epoch from (co.claim_at - previous_atomic.claim_at)))::integer
    end as gap_seconds
  from catchup_ordered co
  cross join params p
  left join lateral (
    select previous.claim_at
    from catchup_ordered previous
    where previous.fully_terminal_atomic
      and row(previous.claim_at, previous.claim_id)
        < row(co.claim_at, co.claim_id)
    order by previous.claim_at desc, previous.claim_id desc
    limit 1
  ) previous_atomic on true
),
performance as (
  select
    count(*)::integer as catch_up_run_count,
    count(*) filter (where fully_terminal_atomic)::integer as valid_atomic_groups,
    count(*) filter (
      where fully_terminal_atomic and atomic_sequence_no > 1
    )::integer as post_bootstrap_groups,
    count(*) filter (where group_count <> 1)::integer as groups_per_run_violation,
    count(*) filter (where tracker_claim_count < 1)::integer as missing_tracker_claim_count,
    count(*) filter (
      where tracker_claim_count <> distinct_tracker_claim_count
         or commit_count <> distinct_commit_tracker_count
    )::integer as tracker_or_commit_duplicate_count,
    coalesce(sum(tracker_claim_identity_or_order_violation_count), 0)::integer
      as tracker_claim_identity_or_order_violation_count,
    coalesce(sum(commit_membership_mismatch_count), 0)::integer
      as commit_membership_mismatch_count,
    coalesce(sum(event_order_violation_count), 0)::integer
      as event_order_violation_count,
    count(*) filter (
      where failure_count - finite_neutral_failure_count > 0
    )::integer as failed_claim_count,
    count(*) filter (
      where terminal_at is null
         or tracker_claim_count < 1
         or (
           finite_commit_count = 0
           and finite_neutral_failure_count = 0
           and commit_count + failure_count <> tracker_claim_count
         )
    )::integer as open_or_incomplete_count,
    coalesce(sum(atomic_invalid_commit_count), 0)::integer as atomic_invalid_commit_count,
    count(*) filter (
      where fully_terminal_atomic
        and gap_seconds is not null
        and abs(
          gap_seconds
          - greatest(round(gap_seconds::numeric / p.cadence_seconds)::integer, 1)
            * p.cadence_seconds
        ) > p.grid_tolerance_seconds
    )::integer as grid_violation_count,
    min(claim_at) filter (where fully_terminal_atomic) as first_valid_claim_at,
    max(terminal_at) filter (where fully_terminal_atomic) as latest_valid_terminal_at
  from catchup_classified
  cross join params p
),
slot_audit as (
  select coalesce(sum(slot_count - 1), 0)::integer as slot_collision_count
  from (
    select slot_number, count(*)::integer as slot_count
    from catchup_classified
    where fully_terminal_atomic
    group by slot_number
    having count(*) > 1
  ) collisions
),
window_cycles as (
  select distinct cycle_id
  from group_events
  where cycle_id is not null
),
duplicate_audit as (
  select
    (
      select count(*)::integer
      from (
        select e.cycle_id, e.group_fingerprint
        from public.naver_shopping_scheduler_events e
        join window_cycles wc on wc.cycle_id = e.cycle_id
        cross join params p
        where e.event_type = 'group_claimed'
          and e.occurred_at <= p.observed_at
        group by e.cycle_id, e.group_fingerprint
        having count(*) > 1
      ) duplicate_groups
    ) as cycle_group_duplicate_count,
    (
      select count(*)::integer
      from (
        select e.cycle_id, e.tracker_id
        from public.naver_shopping_scheduler_events e
        join window_cycles wc on wc.cycle_id = e.cycle_id
        cross join params p
        where e.event_type = 'tracker_claimed'
          and e.occurred_at <= p.observed_at
        group by e.cycle_id, e.tracker_id
        having count(*) > 1
      ) duplicate_trackers
    ) as cycle_tracker_duplicate_count
),
overlap_audit as (
  select count(*)::integer as overlap_pairs
  from claim_facts a
  join claim_facts b on a.claim_id < b.claim_id
  cross join params p
  where a.claim_at is not null
    and b.claim_at is not null
    and a.claim_at < coalesce(b.terminal_at, p.observed_at)
    and b.claim_at < coalesce(a.terminal_at, p.observed_at)
),
cursor_audit as (
  select
    (
      select count(*)::integer
      from claim_facts cf
      where cf.priority in ('normal', 'resume')
        and (
          ((cf.group_details ->> 'cursorTrackerBefore' is null)
            <> (cf.group_details ->> 'cursorSortOrderBefore' is null))
          or (
            cf.group_details ->> 'cursorTrackerBefore' is null
            and cf.group_details ->> 'cursorSortOrderBefore' is null
            and cf.cycle_id is not null
            and exists (
              select 1
              from public.naver_shopping_scheduler_events prior
              where prior.event_type = 'group_claimed'
                and prior.cycle_id = cf.cycle_id
                and prior.priority in ('normal', 'resume')
                and prior.event_id < cf.group_event_id
            )
          )
          or (
            cf.group_details ->> 'cursorTrackerBefore' is not null
            and cf.group_details ->> 'cursorTrackerBefore'
              !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
          )
          or (
            cf.group_details ->> 'cursorSortOrderBefore' is not null
            and cf.group_details ->> 'cursorSortOrderBefore' !~ '^-?[0-9]+$'
          )
          or (
            cf.group_details ->> 'cursorTrackerBefore' is not null
            and cf.cursor_before_tracker_id is null
          )
        )
    ) as cursor_evidence_invalid_count,
    (
      select count(*)::integer
      from claim_facts cf
      cross join params p
      where cf.priority in ('normal', 'resume')
        and cf.cursor_before_tracker_id is not null
        and exists (
          select 1
          from public.naver_shopping_scheduler_events tc
          join public.naver_rank_trackers t on t.id = tc.tracker_id
          where tc.event_type = 'tracker_claimed'
            and tc.claim_id = cf.claim_id
            and tc.run_id = cf.run_id
            and tc.occurred_at <= p.observed_at
            and (
              case
                when (tc.details ->> 'sortOrder') ~ '^-?[0-9]+$'
                then (tc.details ->> 'sortOrder')::numeric
                else null
              end is null
              or cf.cursor_before_sort_order is null
              or row(
                case
                  when (tc.details ->> 'sortOrder') ~ '^-?[0-9]+$'
                  then (tc.details ->> 'sortOrder')::numeric
                  else null
                end,
                t.created_at,
                t.id
              ) <= row(
                cf.cursor_before_sort_order,
                cf.cursor_before_created_at,
                cf.cursor_before_tracker_id
              )
            )
        )
    ) as cursor_nonforward_or_fallback_count
),
global_integrity as (
  select
    count(*) filter (
      where cycle_id is null or cycle_number is null
    )::integer as all_cycle_identity_missing_count,
    count(*) filter (where group_count <> 1)::integer
      as all_groups_per_run_violation,
    count(*) filter (where tracker_claim_count < 1)::integer
      as all_missing_tracker_claim_count,
    count(*) filter (
      where tracker_claim_count <> distinct_tracker_claim_count
         or commit_count <> distinct_commit_tracker_count
         or finite_commit_count <> distinct_finite_commit_tracker_count
    )::integer as all_tracker_or_commit_duplicate_count,
    coalesce(sum(tracker_claim_identity_or_order_violation_count), 0)::integer
      as all_tracker_claim_identity_or_order_violation_count,
    coalesce(sum(commit_membership_mismatch_count), 0)::integer
      as all_commit_membership_mismatch_count,
    count(*) filter (
      where commit_count > 0
        and collection_count <> 1
    )::integer
      as all_collection_count_violation,
    count(*) filter (
      where failure_count - finite_neutral_failure_count > 0
    )::integer
      as all_failure_count,
    count(*) filter (
      where terminal_at is null
         or tracker_claim_count < 1
         or commit_count + finite_commit_count + failure_count <> tracker_claim_count
    )::integer as all_open_or_incomplete_count,
    coalesce(sum(event_order_violation_count), 0)::integer
      as all_event_order_violation_count,
    coalesce(sum(atomic_invalid_commit_count), 0)::integer
      as all_atomic_invalid_commit_count,
    coalesce(sum(finite_invalid_terminal_count), 0)::integer
      as all_finite_invalid_terminal_count,
    coalesce(sum(finite_neutral_failure_count), 0)::integer
      as all_finite_neutral_failure_count
  from claim_facts
),
control_plane as (
  select
    c.updated_at,
    c.cadence_mode,
    c.cadence_minutes,
    c.runtime_version,
    c.runtime_fingerprint,
    c.primary_worker_id,
    c.primary_seen_at,
    c.circuit_state,
    c.circuit_reason,
    c.cooldown_until,
    c.lease_worker_id,
    (c.lease_token is null) as lease_token_is_null,
    c.lease_until,
    c.run_id,
    c.current_stage,
    c.current_page,
    c.current_job_kind,
    c.current_tracker_id,
    c.current_job_started_at,
    c.probe_tracker_id,
    c.probe_started_at,
    c.last_success_at,
    c.last_checked_count,
    c.last_source,
    (
      (select count(*) from public.naver_shopping_rank_lookup_jobs j, params p
       where j.status = 'processing' and j.processing_until > p.observed_at)
      +
      (select count(*) from public.naver_rank_trackers t, params p
       where t.status = 'active' and t.processing_until > p.observed_at)
    )::integer as processing_count
  from public.naver_shopping_worker_coordination c
  where c.lane_key = 'global'
),
verdict as (
  select
    extract(epoch from (p.observed_at - p.activation_at))::numeric as wall_seconds,
    case when extract(epoch from (p.observed_at - p.activation_at)) > 0 then
      perf.post_bootstrap_groups * 3600.0
      / extract(epoch from (p.observed_at - p.activation_at))
    else null end::numeric as fixed_wall_group_per_hour,
    (
      p.cadence_seconds = 360
      and extract(epoch from (p.observed_at - p.activation_at)) >= p.minimum_wall_seconds
      and perf.post_bootstrap_groups >= p.minimum_post_bootstrap_groups
      and perf.post_bootstrap_groups * 3600.0
        / nullif(extract(epoch from (p.observed_at - p.activation_at)), 0)
          > p.minimum_group_per_hour
      and pa.missing_or_identity_mismatch = 0
      and perf.groups_per_run_violation = 0
      and perf.missing_tracker_claim_count = 0
      and perf.tracker_or_commit_duplicate_count = 0
      and perf.failed_claim_count = 0
      and perf.open_or_incomplete_count = 0
      and perf.atomic_invalid_commit_count = 0
      and perf.grid_violation_count = 0
      and sa.slot_collision_count = 0
      and da.cycle_group_duplicate_count = 0
      and da.cycle_tracker_duplicate_count = 0
      and oa.overlap_pairs = 0
      and ca.cursor_evidence_invalid_count = 0
      and ca.cursor_nonforward_or_fallback_count = 0
      and gi.all_cycle_identity_missing_count = 0
      and gi.all_groups_per_run_violation = 0
      and gi.all_missing_tracker_claim_count = 0
      and gi.all_tracker_or_commit_duplicate_count = 0
      and gi.all_tracker_claim_identity_or_order_violation_count = 0
      and gi.all_commit_membership_mismatch_count = 0
      and gi.all_collection_count_violation = 0
      and gi.all_failure_count = 0
      and gi.all_open_or_incomplete_count = 0
      and gi.all_event_order_violation_count = 0
      and gi.all_atomic_invalid_commit_count = 0
      and gi.all_finite_invalid_terminal_count = 0
      and cp.cadence_mode = 'candidate'
      and cp.cadence_minutes = 6
      and cp.runtime_version = p.runtime_version
      and cp.runtime_fingerprint = p.runtime_fingerprint
      and cp.primary_worker_id = p.worker_id
      and cp.updated_at <= p.observed_at
      and cp.primary_seen_at between p.observed_at - interval '2 minutes' and p.observed_at
      and cp.circuit_state = 'closed'
      and cp.circuit_reason is null
      and cp.cooldown_until is null
      and cp.processing_count = 0
      and cp.lease_worker_id is null
      and cp.lease_token_is_null
      and cp.lease_until is null
      and cp.run_id is null
      and cp.current_stage is null
      and cp.current_page = 0
      and cp.current_job_kind is null
      and cp.current_tracker_id is null
      and cp.current_job_started_at is null
      and cp.probe_tracker_id is null
      and cp.probe_started_at is null
      and cp.last_success_at between p.observed_at - interval '15 minutes' and p.observed_at
      and cp.last_checked_count = 300
      and cp.last_source = 'naver_shopping_results_collector'
    ) as candidate_success
  from params p
  cross join provenance_audit pa
  cross join performance perf
  cross join slot_audit sa
  cross join duplicate_audit da
  cross join overlap_audit oa
  cross join cursor_audit ca
  cross join global_integrity gi
  cross join control_plane cp
)
select jsonb_build_object(
  'marker', 'n30_candidate_performance_audit_v1',
  'activationAt', p.activation_at,
  'observedAt', p.observed_at,
  'cadenceSeconds', p.cadence_seconds,
  'gridToleranceSeconds', p.grid_tolerance_seconds,
  'wallSeconds', round(v.wall_seconds, 6),
  'fixedWallGroupPerHour', round(v.fixed_wall_group_per_hour, 6),
  'candidateSuccess', v.candidate_success,
  'provenance', to_jsonb(pa),
  'performance', to_jsonb(perf),
  'slotAudit', to_jsonb(sa),
  'duplicateAudit', to_jsonb(da),
  'overlapAudit', to_jsonb(oa),
  'cursorAudit', to_jsonb(ca),
  'globalIntegrity', to_jsonb(gi),
  'controlPlane', to_jsonb(cp)
) as evidence
from params p
cross join provenance_audit pa
cross join performance perf
cross join slot_audit sa
cross join duplicate_audit da
cross join overlap_audit oa
cross join cursor_audit ca
cross join global_integrity gi
cross join control_plane cp
cross join verdict v;
commit;`;
}

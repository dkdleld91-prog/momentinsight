import { withSupabase } from "@supabase/server";

import { localWorkerAuthInput, verifyLocalWorkerSignature } from "../local-worker-auth.mjs";
import {
  LOCAL_WORKER_BODY_MAX_BYTES,
  LOCAL_WORKER_ORGANIC_LIMIT,
  validateLocalWorkerJob,
  validateStrictLocalWorkerWindow,
} from "../naver-shopping/local-worker-contract.mjs";
import { claimShoppingWorkerWake } from "../naver-shopping/worker-wake.mjs";
import { protectedJson } from "../security.mjs";
import {
  findShoppingRankFromWindow,
  normalizeText,
  shoppingRankMessage,
} from "./naver-shopping-rank.mjs";
import {
  buildProductRankSnapshotRecord,
  claimDueTracker,
  nextRankCheckAt,
  representativeTrackingRankMessage,
  selectRepresentativeTrackingRank,
  verifiedRelatedCatalogIdFromSnapshots,
} from "./naver-rank-trackers.mjs";

// Keep one signed submit comfortably below the worker HTTP timeout and the
// 35-minute collection lease. Eight trackers also keeps the bulk continuity query
// below Supabase's common 1,000-row response ceiling (8 x 120 snapshots).
const CLAIM_BATCH_MAX = 8;
const WORKER_COLLECTION_LEASE_SECONDS = 35 * 60;
const SNAPSHOT_HISTORY_PER_TRACKER = 120;
const SAFE_FAILURE_PATTERN = /^[a-z0-9_:-]{3,80}$/u;
const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{2,63}$/u;
const WORKER_LANE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXPECTED_WORKER_RUNTIME_VERSION = "1.1.0";
const WORKER_RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const WORKER_RUNTIME_FINGERPRINT_PATTERN = /^(?!0{64}$)[0-9a-f]{64}$/u;
const WORKER_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_PROGRESS_STAGES = new Set([
  "claiming",
  "navigating",
  "collecting",
  "submitting",
  "completed",
  "failed",
]);
const WORKER_JOB_KINDS = new Set(["", "lookup", "tracker"]);
const WORKER_FAIR_CANDIDATE_MAX = 256;

const WORKER_TRACKER_SELECT = [
  "id",
  "agency_code",
  "keyword",
  "product_url",
  "product_id",
  "mall_name",
  "product_title",
  "max_rank",
  "status",
  "next_check_at",
  "last_checked_at",
  "created_at",
  "current_rank",
  "best_rank",
  "worst_rank",
  "check_count",
  "found_count",
  "retry_count",
  "processing_started_at",
  "processing_until",
  "worker_quarantined_until",
].join(", ");

const WORKER_LOOKUP_SELECT = [
  "id",
  "keyword",
  "product_url",
  "product_id",
  "target_catalog_id",
  "mall_name",
  "product_title",
  "max_rank",
  "status",
  "processing_started_at",
  "processing_until",
].join(", ");

async function queueAllActiveTrackers(ctx) {
  const queuedAt = new Date().toISOString();
  const totalResult = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");
  if (totalResult.error) throw totalResult.error;

  const queuedResult = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      next_check_at: queuedAt,
      last_message: "전체 순위 갱신 대기 중입니다.",
    })
    .eq("status", "active")
    .gt("next_check_at", queuedAt)
    .or(`processing_until.is.null,processing_until.lt.${queuedAt}`)
    .select("id", { count: "exact" });
  if (queuedResult.error) throw queuedResult.error;

  const waitingResult = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .lte("next_check_at", queuedAt)
    .or(`processing_until.is.null,processing_until.lt.${queuedAt}`);
  if (waitingResult.error) throw waitingResult.error;

  const total = Math.max(0, Number(totalResult.count || 0));
  const queued = Math.max(0, Number(
    queuedResult.count ?? (Array.isArray(queuedResult.data) ? queuedResult.data.length : 0),
  ));
  const waiting = Math.max(0, Number(waitingResult.count || 0));
  return {
    total,
    queued,
    alreadyQueued: Math.max(0, waiting - queued),
    alreadyProcessing: Math.max(0, total - waiting),
    queuedAt,
  };
}

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "POST, OPTIONS",
    headers: "content-type, x-mi-worker-timestamp, x-mi-worker-nonce, x-mi-worker-signature",
  });
}

function workerError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function normalizedKeywordKey(value) {
  return normalizeText(value);
}

function workerLaneInput(body, options = {}) {
  const workerId = String(body?.workerId || "").trim().toLowerCase();
  const workerRole = String(body?.workerRole || "").trim().toLowerCase();
  const laneToken = String(body?.laneToken || "").trim().toLowerCase();
  if (!WORKER_ID_PATTERN.test(workerId) || !WORKER_LANE_TOKEN_PATTERN.test(laneToken)) {
    throw workerError("LOCAL_WORKER_LANE_INVALID", 400);
  }
  if (options.requireRole === true && !["primary", "standby"].includes(workerRole)) {
    throw workerError("LOCAL_WORKER_ROLE_INVALID", 400);
  }
  return {
    workerId,
    ...(options.requireRole === true ? { workerRole } : {}),
    laneToken,
  };
}

function optionalUuid(value, code) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (!WORKER_RUN_ID_PATTERN.test(normalized)) throw workerError(code, 400);
  return normalized;
}

function workerControlInput(body) {
  const lane = workerLaneInput(body);
  const runId = optionalUuid(body?.runId, "LOCAL_WORKER_RUN_ID_INVALID");
  if (!runId) throw workerError("LOCAL_WORKER_RUN_ID_INVALID", 400);
  const runtimeVersion = String(body?.runtimeVersion || "").trim();
  const runtimeFingerprint = String(body?.runtimeFingerprint || "").trim().toLowerCase();
  if (!WORKER_RUNTIME_VERSION_PATTERN.test(runtimeVersion)
    || runtimeVersion !== EXPECTED_WORKER_RUNTIME_VERSION
    || !WORKER_RUNTIME_FINGERPRINT_PATTERN.test(runtimeFingerprint)) {
    throw workerError("LOCAL_WORKER_RUNTIME_IDENTITY_INVALID", 400);
  }
  return { ...lane, runId, runtimeVersion, runtimeFingerprint };
}

function trackerIdFromJob(job) {
  if (job?.kind === "lookup") return null;
  return optionalUuid(job?.claims?.[0]?.trackerId, "LOCAL_WORKER_TRACKER_ID_INVALID");
}

async function reportWorkerProgress(ctx, body) {
  const control = workerControlInput(body);
  const stage = String(body?.stage || "").trim().toLowerCase();
  const page = Number(body?.page ?? 0);
  const jobKind = String(body?.jobKind || "").trim().toLowerCase();
  const trackerId = optionalUuid(body?.trackerId, "LOCAL_WORKER_TRACKER_ID_INVALID");
  if (!WORKER_PROGRESS_STAGES.has(stage)
    || !Number.isSafeInteger(page)
    || page < 0
    || page > 8
    || !WORKER_JOB_KINDS.has(jobKind)) {
    throw workerError("LOCAL_WORKER_PROGRESS_INVALID", 400);
  }
  const { data, error } = await ctx.supabaseAdmin.rpc(
    "mi_report_naver_shopping_worker_progress",
    {
      p_worker_id: control.workerId,
      p_lane_token: control.laneToken,
      p_run_id: control.runId,
      p_stage: stage,
      p_page: page,
      p_job_kind: jobKind || null,
      p_tracker_id: trackerId,
      p_runtime_version: control.runtimeVersion,
      p_runtime_fingerprint: control.runtimeFingerprint,
    },
  );
  if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  if (data !== true) throw workerError("LOCAL_WORKER_LANE_LOST", 409);
  return true;
}

async function recordWorkerSuccess(ctx, body) {
  const control = workerControlInput(body);
  const job = validateLocalWorkerJob(body?.job);
  const trackerId = trackerIdFromJob(job);
  const checkedCount = Number(body?.checkedCount);
  const excludedAdCount = Number(body?.excludedAdCount ?? 0);
  const durationMs = Number(body?.durationMs);
  const collectionId = String(body?.collectionId || "").trim();
  const source = String(body?.source || "").trim().toLowerCase();
  if (checkedCount !== LOCAL_WORKER_ORGANIC_LIMIT
    || !Number.isSafeInteger(excludedAdCount)
    || excludedAdCount < 0
    || !Number.isSafeInteger(durationMs)
    || durationMs < 0
    || durationMs > 60 * 60_000
    || !/^pw-chrome-/u.test(collectionId)
    || source !== "naver_shopping_results_collector") {
    throw workerError("LOCAL_WORKER_SUCCESS_PROOF_INVALID", 400);
  }
  const { data, error } = await ctx.supabaseAdmin.rpc(
    "mi_record_naver_shopping_worker_success",
    {
      p_worker_id: control.workerId,
      p_lane_token: control.laneToken,
      p_run_id: control.runId,
      p_tracker_id: trackerId,
      p_collection_id: collectionId,
      p_checked_count: checkedCount,
      p_excluded_ad_count: excludedAdCount,
      p_duration_ms: durationMs,
      p_source: source,
    },
  );
  if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  if (!data || typeof data !== "object" || Array.isArray(data) || data.recorded !== true) {
    throw workerError("LOCAL_WORKER_SUCCESS_NOT_RECORDED", 409);
  }
  return data;
}

async function recordWorkerFailure(ctx, body) {
  const control = workerControlInput(body);
  const job = validateLocalWorkerJob(body?.job);
  const trackerId = trackerIdFromJob(job);
  const errorCode = String(body?.errorCode || "").trim().toLowerCase();
  const scope = String(body?.scope || "").trim().toLowerCase();
  if (!SAFE_FAILURE_PATTERN.test(errorCode)
    || !["system", "tracker", "security"].includes(scope)
    || (scope === "tracker" && !trackerId)) {
    throw workerError("LOCAL_WORKER_FAILURE_REPORT_INVALID", 400);
  }
  const { data, error } = await ctx.supabaseAdmin.rpc(
    "mi_record_naver_shopping_worker_failure",
    {
      p_worker_id: control.workerId,
      p_lane_token: control.laneToken,
      p_run_id: control.runId,
      p_error_code: errorCode,
      p_scope: scope,
      p_tracker_id: trackerId,
    },
  );
  if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  if (!data || typeof data !== "object" || Array.isArray(data) || data.recorded !== true) {
    throw workerError("LOCAL_WORKER_FAILURE_NOT_RECORDED", 409);
  }
  return data;
}

async function claimWorkerLane(ctx, body) {
  const lane = workerLaneInput(body, { requireRole: true });
  workerControlInput(body);
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_claim_naver_shopping_worker_lane", {
    p_worker_id: lane.workerId,
    p_worker_role: lane.workerRole,
    p_lease_token: lane.laneToken,
    p_lease_seconds: WORKER_COLLECTION_LEASE_SECONDS,
    p_primary_stale_seconds: 180,
  });
  if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.granted !== "boolean") {
    throw workerError("LOCAL_WORKER_COORDINATION_INVALID", 503);
  }
  if (data.granted === true) {
    try {
      await reportWorkerProgress(ctx, {
        ...body,
        stage: "claiming",
        page: 0,
        jobKind: "",
        trackerId: null,
      });
    } catch (progressError) {
      try {
        await releaseWorkerLane(ctx, body);
      } catch {
        throw workerError("LOCAL_WORKER_RUNTIME_REGISTRATION_FAILED", 503);
      }
      throw progressError;
    }
  }
  return data;
}

async function touchWorkerLane(ctx, body) {
  const lane = workerLaneInput(body);
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_touch_naver_shopping_worker_lane", {
    p_worker_id: lane.workerId,
    p_lease_token: lane.laneToken,
    p_lease_seconds: WORKER_COLLECTION_LEASE_SECONDS,
  });
  if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  if (data !== true) throw workerError("LOCAL_WORKER_LANE_LOST", 409);
}

async function releaseWorkerLane(ctx, body) {
  const lane = workerLaneInput(body);
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_release_naver_shopping_worker_lane", {
    p_worker_id: lane.workerId,
    p_lease_token: lane.laneToken,
  });
  if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  return data === true;
}

async function blockWorkerLane(ctx, body) {
  const lane = workerLaneInput(body);
  const errorCode = String(body?.errorCode || "").trim().toLowerCase();
  if (!SAFE_FAILURE_PATTERN.test(errorCode)) {
    throw workerError("LOCAL_WORKER_FAILURE_CODE_INVALID", 400);
  }
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_block_naver_shopping_worker_lane", {
    p_worker_id: lane.workerId,
    p_lease_token: lane.laneToken,
    p_error_code: errorCode,
  });
  if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  return data === true;
}

async function consumeNonce(ctx, auth) {
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_consume_naver_shopping_worker_nonce", {
    p_nonce: auth.nonce,
    p_request_timestamp: new Date(auth.timestampSeconds * 1000).toISOString(),
  });
  if (error) throw workerError("LOCAL_WORKER_NONCE_STORE_UNAVAILABLE", 503);
  if (data !== true) throw workerError("LOCAL_WORKER_REPLAY_REJECTED", 409);
}

async function claimOneLookupJob(ctx) {
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_claim_naver_shopping_rank_lookup_job", {
    p_lease_seconds: WORKER_COLLECTION_LEASE_SECONDS,
  });
  if (error) {
    if (/schema cache|does not exist|mi_claim_naver_shopping_rank_lookup_job/iu.test(error.message || "")) return null;
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    kind: "lookup",
    keyword: normalizeText(row.keyword),
    limit: LOCAL_WORKER_ORGANIC_LIMIT,
    claims: [{
      lookupJobId: String(row.id || "").trim().toLowerCase(),
      leaseStartedAt: row.lease_started_at,
      leaseUntil: row.lease_until,
    }],
  };
}

async function hasAvailableLookupJob(ctx, nowIso) {
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_shopping_rank_lookup_jobs")
    .select("id")
    .gt("expires_at", nowIso)
    .lt("attempts", 3)
    .or(`and(status.eq.pending,available_at.lte.${nowIso}),and(status.eq.processing,processing_until.lt.${nowIso})`)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

async function loadFairTrackerCandidates(ctx, nowIso, options = {}) {
  const buildQuery = (mode) => {
    let query = ctx.supabaseAdmin
      .from("naver_rank_trackers")
      .select(WORKER_TRACKER_SELECT)
      .eq("status", "active")
      .lte("next_check_at", nowIso)
      .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
      .or(`worker_quarantined_until.is.null,worker_quarantined_until.lt.${nowIso}`);
    if (options.probeTrackerId) query = query.eq("id", options.probeTrackerId);
    query = mode === "new"
      ? query.is("last_checked_at", null).order("created_at", { ascending: true })
      : query.not("last_checked_at", "is", null).order("next_check_at", { ascending: true });
    return query.limit(options.probeTrackerId ? 1 : WORKER_FAIR_CANDIDATE_MAX);
  };
  const [newResult, dueResult] = await Promise.all([buildQuery("new"), buildQuery("due")]);
  if (newResult.error) throw newResult.error;
  if (dueResult.error) throw dueResult.error;
  return {
    newCandidates: Array.isArray(newResult.data) ? newResult.data : [],
    dueCandidates: Array.isArray(dueResult.data) ? dueResult.data : [],
  };
}

async function chooseFairWorkerTurn(ctx, input) {
  const dueAgencies = [...new Set(input.dueCandidates
    .map((tracker) => String(tracker?.agency_code || "").trim().toLowerCase())
    .filter(Boolean))];
  const oldestDueAt = input.dueCandidates[0]?.next_check_at || null;
  const { data, error } = await ctx.supabaseAdmin.rpc(
    "mi_choose_naver_shopping_worker_turn",
    {
      p_has_lookup: input.hasLookup,
      p_has_new: input.newCandidates.length > 0,
      p_has_due: input.dueCandidates.length > 0,
      p_due_agencies: dueAgencies,
      p_oldest_due_at: oldestDueAt,
    },
  );
  if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  const workClass = String(data?.workClass || data?.work_class || "none").trim().toLowerCase();
  const agencyCode = String(data?.agencyCode || data?.agency_code || "").trim().toLowerCase();
  if (!["none", "lookup", "new", "due"].includes(workClass)) {
    throw workerError("LOCAL_WORKER_SCHEDULER_INVALID", 503);
  }
  return { workClass, agencyCode };
}

async function claimKeywordFromCandidates(ctx, candidates, nowIso, options = {}) {
  const agencyCode = String(options.agencyCode || "").trim().toLowerCase();
  const eligible = agencyCode
    ? candidates.filter((tracker) => String(tracker?.agency_code || "").trim().toLowerCase() === agencyCode)
    : candidates;
  const attemptedKeywordKeys = new Set();
  for (const seed of eligible) {
    const keyword = normalizeText(seed.keyword);
    const keywordKey = normalizedKeywordKey(keyword);
    if (!keywordKey || attemptedKeywordKeys.has(keywordKey)) continue;
    attemptedKeywordKeys.add(keywordKey);

    const claims = [];
    try {
      for (const tracker of eligible) {
        if (normalizedKeywordKey(tracker.keyword) !== keywordKey) continue;
        // eslint-disable-next-line no-await-in-loop
        const claimed = await claimDueTracker(ctx, tracker, nowIso);
        if (!claimed.claimed) continue;
        claims.push({
          trackerId: tracker.id,
          leaseStartedAt: claimed.leaseStartedAt,
          leaseUntil: claimed.leaseUntil,
        });
      }
    } catch (error) {
      if (claims.length) {
        try {
          await failClaims(ctx, {
            keyword,
            limit: LOCAL_WORKER_ORGANIC_LIMIT,
            claims,
          }, "local_worker_claim_failed");
        } catch {
          throw workerError("LOCAL_WORKER_CLAIM_ROLLBACK_FAILED", 503);
        }
      }
      throw error;
    }
    if (claims.length) return { keyword, limit: LOCAL_WORKER_ORGANIC_LIMIT, claims };
  }
  return null;
}

async function claimFairJob(ctx, body) {
  const nowIso = new Date().toISOString();
  const probeTrackerId = optionalUuid(body?.probeTrackerId, "LOCAL_WORKER_PROBE_TRACKER_INVALID");
  const candidates = await loadFairTrackerCandidates(ctx, nowIso, { probeTrackerId });
  if (probeTrackerId) {
    return claimKeywordFromCandidates(
      ctx,
      [...candidates.newCandidates, ...candidates.dueCandidates],
      nowIso,
    );
  }
  const hasLookup = await hasAvailableLookupJob(ctx, nowIso);
  const turn = await chooseFairWorkerTurn(ctx, { ...candidates, hasLookup });
  if (turn.workClass === "none") return null;
  const claimers = {
    lookup: () => claimOneLookupJob(ctx),
    new: () => claimKeywordFromCandidates(ctx, candidates.newCandidates, nowIso),
    due: () => claimKeywordFromCandidates(ctx, candidates.dueCandidates, nowIso, {
      agencyCode: turn.agencyCode,
    }),
  };
  const order = [turn.workClass, "due", "new", "lookup"]
    .filter((value, index, values) => value !== "none" && values.indexOf(value) === index);
  for (const workClass of order) {
    // eslint-disable-next-line no-await-in-loop
    const job = await claimers[workClass]();
    if (job) return job;
  }
  return null;
}

async function claimOneKeywordJob(ctx) {
  const nowIso = new Date().toISOString();
  const dueQuery = (uninitializedOnly) => {
    let query = ctx.supabaseAdmin
      .from("naver_rank_trackers")
      .select(WORKER_TRACKER_SELECT)
      .eq("status", "active")
      .lte("next_check_at", nowIso)
      .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
      .or(`worker_quarantined_until.is.null,worker_quarantined_until.lt.${nowIso}`);
    query = uninitializedOnly
      ? query.is("last_checked_at", null).order("created_at", { ascending: true })
      : query.not("last_checked_at", "is", null).order("next_check_at", { ascending: true });
    return query.limit(CLAIM_BATCH_MAX);
  };

  // A newly registered keyword has no verified result yet. Give that group one
  // first collection before returning to the existing oldest-due sequence.
  const initialResult = await dueQuery(true);
  if (initialResult.error) throw initialResult.error;
  let due = Array.isArray(initialResult.data)
    ? initialResult.data.slice(0, CLAIM_BATCH_MAX)
    : [];
  if (!due.length) {
    const existingResult = await dueQuery(false);
    if (existingResult.error) throw existingResult.error;
    due = Array.isArray(existingResult.data)
      ? existingResult.data.slice(0, CLAIM_BATCH_MAX)
      : [];
  }
  if (!due.length) return null;

  const attemptedKeywordKeys = new Set();
  for (const seed of due) {
    const keyword = normalizeText(seed.keyword);
    const keywordKey = normalizedKeywordKey(keyword);
    if (!keywordKey || attemptedKeywordKeys.has(keywordKey)) continue;
    attemptedKeywordKeys.add(keywordKey);

    const claims = [];
    try {
      for (const tracker of due) {
        if (normalizedKeywordKey(tracker.keyword) !== keywordKey) continue;
        // Existing conditional lease update is the concurrency authority.
        // eslint-disable-next-line no-await-in-loop
        const claimed = await claimDueTracker(ctx, tracker, nowIso);
        if (!claimed.claimed) continue;
        claims.push({
          trackerId: tracker.id,
          leaseStartedAt: claimed.leaseStartedAt,
          leaseUntil: claimed.leaseUntil,
        });
      }
    } catch (error) {
      // A query failure after earlier conditional updates must not strand those
      // leases. The lease-token RPC leaves all verified rank/history fields
      // untouched and releases only claims acquired by this request.
      if (claims.length) {
        try {
          await failClaims(ctx, {
            keyword,
            limit: LOCAL_WORKER_ORGANIC_LIMIT,
            claims,
          }, "local_worker_claim_failed");
        } catch {
          throw workerError("LOCAL_WORKER_CLAIM_ROLLBACK_FAILED", 503);
        }
      }
      throw error;
    }
    if (claims.length) return { keyword, limit: LOCAL_WORKER_ORGANIC_LIMIT, claims };
  }
  return null;
}

async function loadClaimTrackers(ctx, job) {
  const ids = job.claims.map((claim) => claim.trackerId);
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(WORKER_TRACKER_SELECT)
    .in("id", ids);
  if (error) throw error;
  const byId = new Map((data || []).map((row) => [String(row.id).toLowerCase(), row]));
  return job.claims.map((claim) => {
    const tracker = byId.get(claim.trackerId);
    if (!tracker || normalizedKeywordKey(tracker.keyword) !== normalizedKeywordKey(job.keyword)) {
      throw workerError("LOCAL_WORKER_TRACKER_MISMATCH", 409);
    }
    return { claim, tracker };
  });
}

async function loadVerifiedCatalogs(ctx, claimTrackers, checkedAt) {
  const trackerIds = claimTrackers.map(({ tracker }) => tracker.id);
  const { data, error } = await ctx.supabaseAdmin.rpc(
    "mi_load_naver_shopping_worker_catalog_history",
    {
      p_tracker_ids: trackerIds,
      p_checked_at: checkedAt,
      p_per_tracker_limit: SNAPSHOT_HISTORY_PER_TRACKER,
    },
  );
  if (error) throw error;
  const byTrackerId = new Map(trackerIds.map((trackerId) => [String(trackerId).toLowerCase(), []]));
  for (const row of data || []) {
    const rows = byTrackerId.get(String(row?.tracker_id || "").toLowerCase());
    if (rows && rows.length < SNAPSHOT_HISTORY_PER_TRACKER) rows.push(row);
  }
  return new Map(claimTrackers.map(({ tracker }) => [
    String(tracker.id).toLowerCase(),
    verifiedRelatedCatalogIdFromSnapshots(
      byTrackerId.get(String(tracker.id).toLowerCase()) || [],
      tracker.product_id,
    ),
  ]));
}

async function submitWindow(ctx, rawJob, rawWindow) {
  const job = validateLocalWorkerJob(rawJob, {
    requireActiveLease: true,
    nowMs: Date.now(),
  });
  const window = validateStrictLocalWorkerWindow(rawWindow, { keyword: job.keyword });
  if (job.kind === "lookup") return submitLookupWindow(ctx, job, window);
  const claimTrackers = await loadClaimTrackers(ctx, job);
  const verifiedCatalogs = await loadVerifiedCatalogs(ctx, claimTrackers, window.collectedAt);
  let committedCount = 0;
  let alreadyCommittedCount = 0;
  let leaseLostCount = 0;
  let collectionConflictCount = 0;
  let processedCount = 0;

  try {
    for (const { claim, tracker } of claimTrackers) {
      const checkedAt = window.collectedAt;
      const verifiedRelatedCatalogId = verifiedCatalogs.get(String(tracker.id).toLowerCase()) || "";
      // The worker already supplied a fresh trusted 300-item window and the DB
      // row contains the canonical target. Never perform public product/store
      // fetches during submit: they are both unnecessary and 429/timeout prone.
      // eslint-disable-next-line no-await-in-loop
      const lookup = await findShoppingRankFromWindow(window, {
        keyword: tracker.keyword,
        targetProductId: tracker.product_id,
        targetUrl: tracker.product_url,
        targetMallName: tracker.mall_name,
        targetProductTitle: tracker.product_title,
        verifiedRelatedCatalogId,
        maxRank: LOCAL_WORKER_ORGANIC_LIMIT,
        skipTargetMetadata: true,
      });
      const result = selectRepresentativeTrackingRank(lookup);
      if (result.complete !== true || Number(result.checkedCount) !== LOCAL_WORKER_ORGANIC_LIMIT) {
        throw workerError("LOCAL_WORKER_MATCH_RESULT_INCOMPLETE", 422);
      }
      const message = representativeTrackingRankMessage(result);
      const snapshot = buildProductRankSnapshotRecord(tracker, checkedAt, result, message);
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await ctx.supabaseAdmin.rpc("mi_commit_naver_shopping_worker_result", {
        p_tracker_id: tracker.id,
        p_lease_started_at: claim.leaseStartedAt,
        p_collection_id: window.collectionId,
        p_checked_at: checkedAt,
        p_next_check_at: nextRankCheckAt(new Date(checkedAt)),
        p_snapshot: snapshot,
        p_product_id: result?.targetProductId || result?.item?.productId || tracker.product_id || null,
        p_mall_name: result?.exactItem?.mallName || result?.item?.mallName || tracker.mall_name || null,
        p_product_title: result?.exactItem?.title || result?.item?.title || tracker.product_title || null,
      });
      if (error) throw error;
      processedCount += 1;
      if (data?.status === "committed") committedCount += 1;
      else if (data?.status === "already_committed") alreadyCommittedCount += 1;
      else if (data?.status === "lease_lost") leaseLostCount += 1;
      else if (data?.status === "collection_conflict") collectionConflictCount += 1;
      else throw workerError("LOCAL_WORKER_COMMIT_INVALID", 503);
    }
  } catch (error) {
    const wrapped = workerError(
      String(error?.code || error?.message || "LOCAL_WORKER_SUBMIT_FAILED"),
      Number(error?.status || 500),
    );
    wrapped.localWorkerPartial = {
      committedCount,
      alreadyCommittedCount,
      leaseLostCount,
      collectionConflictCount,
      processedCount,
    };
    throw wrapped;
  }

  return {
    committedCount,
    alreadyCommittedCount,
    leaseLostCount,
    collectionConflictCount,
    processedCount,
  };
}

async function submitLookupWindow(ctx, job, window) {
  const claim = job.claims[0];
  const { data: lookup, error: lookupError } = await ctx.supabaseAdmin
    .from("naver_shopping_rank_lookup_jobs")
    .select(WORKER_LOOKUP_SELECT)
    .eq("id", claim.lookupJobId)
    .eq("status", "processing")
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!lookup
    || normalizedKeywordKey(lookup.keyword) !== normalizedKeywordKey(job.keyword)
    || new Date(lookup.processing_started_at).toISOString() !== claim.leaseStartedAt) {
    throw workerError("LOCAL_WORKER_LOOKUP_MISMATCH", 409);
  }

  const result = await findShoppingRankFromWindow(window, {
    keyword: lookup.keyword,
    targetProductId: lookup.product_id,
    targetUrl: lookup.product_url,
    targetMallName: lookup.mall_name,
    targetProductTitle: lookup.product_title,
    targetCatalogId: lookup.target_catalog_id,
    maxRank: LOCAL_WORKER_ORGANIC_LIMIT,
    skipTargetMetadata: true,
  });
  if (result.complete !== true || Number(result.checkedCount) !== LOCAL_WORKER_ORGANIC_LIMIT) {
    throw workerError("LOCAL_WORKER_MATCH_RESULT_INCOMPLETE", 422);
  }
  const message = shoppingRankMessage(result);
  const responsePayload = {
    source: result.source || "naver_shopping_results_collector",
    rankEvidence: result.rankEvidence || "",
    checkedAt: window.collectedAt,
    query: {
      keyword: lookup.keyword,
      targetUrl: lookup.product_url || "",
      productId: lookup.product_id || "",
      targetMallName: lookup.mall_name || "",
      targetProductTitle: lookup.product_title || "",
      maxRank: LOCAL_WORKER_ORGANIC_LIMIT,
    },
    result,
    message,
  };
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_complete_naver_shopping_rank_lookup_job", {
    p_job_id: claim.lookupJobId,
    p_lease_started_at: claim.leaseStartedAt,
    p_collection_id: window.collectionId,
    p_checked_at: window.collectedAt,
    p_result: responsePayload,
    p_message: message,
  });
  if (error) throw error;
  if (!["committed", "already_committed", "lease_lost", "collection_conflict"].includes(data)) {
    throw workerError("LOCAL_WORKER_COMMIT_INVALID", 503);
  }
  return {
    committedCount: data === "committed" ? 1 : 0,
    alreadyCommittedCount: data === "already_committed" ? 1 : 0,
    leaseLostCount: data === "lease_lost" ? 1 : 0,
    collectionConflictCount: data === "collection_conflict" ? 1 : 0,
    processedCount: 1,
  };
}

async function failClaims(ctx, rawJob, rawErrorCode) {
  const job = validateLocalWorkerJob(rawJob);
  const errorCode = String(rawErrorCode || "local_worker_collection_failed").trim().toLowerCase();
  if (!SAFE_FAILURE_PATTERN.test(errorCode)) throw workerError("LOCAL_WORKER_FAILURE_CODE_INVALID", 400);
  if (job.kind === "lookup") {
    const claim = job.claims[0];
    const { data, error } = await ctx.supabaseAdmin.rpc("mi_fail_naver_shopping_rank_lookup_job", {
      p_job_id: claim.lookupJobId,
      p_lease_started_at: claim.leaseStartedAt,
      p_error: errorCode,
    });
    if (error) throw error;
    return { releasedCount: data === true ? 1 : 0 };
  }
  let releasedCount = 0;
  for (const claim of job.claims) {
    // A failure clears only the matching lease and never changes current_rank
    // or inserts history, preserving the last verified rank.
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await ctx.supabaseAdmin.rpc("mi_fail_naver_shopping_worker_claim", {
      p_tracker_id: claim.trackerId,
      p_lease_started_at: claim.leaseStartedAt,
      p_next_check_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      p_error: errorCode,
    });
    if (error) throw error;
    if (data === true) releasedCount += 1;
  }
  return { releasedCount };
}

export async function handleLocalWorkerRequest(request, ctx) {
  if (request.method !== "POST") return json(request, { ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > LOCAL_WORKER_BODY_MAX_BYTES) {
    return json(request, { ok: false, code: "LOCAL_WORKER_BODY_TOO_LARGE" }, 413);
  }
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > LOCAL_WORKER_BODY_MAX_BYTES) {
    return json(request, { ok: false, code: "LOCAL_WORKER_BODY_TOO_LARGE" }, 413);
  }
  const auth = verifyLocalWorkerSignature(localWorkerAuthInput(request, rawBody));
  if (!auth.ok) return json(request, { ok: false, code: auth.code }, auth.status);

  try {
    await consumeNonce(ctx, auth);
    let rawText;
    try {
      rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    } catch {
      throw workerError("LOCAL_WORKER_JSON_INVALID", 400);
    }
    let body;
    try {
      body = JSON.parse(rawText);
    } catch {
      throw workerError("LOCAL_WORKER_JSON_INVALID", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw workerError("LOCAL_WORKER_JSON_INVALID", 400);
    }
    if (body.action === "claim-lane") {
      return json(request, { ok: true, ...(await claimWorkerLane(ctx, body)) });
    }
    if (body.action === "release-lane") {
      return json(request, { ok: true, released: await releaseWorkerLane(ctx, body) });
    }
    if (body.action === "block-lane") {
      return json(request, { ok: true, blocked: await blockWorkerLane(ctx, body) });
    }
    if (body.action === "progress") {
      return json(request, { ok: true, recorded: await reportWorkerProgress(ctx, body) });
    }
    if (body.action === "record-success") {
      return json(request, { ok: true, ...(await recordWorkerSuccess(ctx, body)) });
    }
    if (body.action === "record-failure") {
      return json(request, { ok: true, ...(await recordWorkerFailure(ctx, body)) });
    }
    if (body.action === "claim-wake") {
      workerControlInput(body);
      await touchWorkerLane(ctx, body);
      return json(request, { ok: true, wake: await claimShoppingWorkerWake(ctx) });
    }
    if (body.action === "claim") {
      workerControlInput(body);
      await touchWorkerLane(ctx, body);
      const job = body.schedulerVersion === "v1"
        ? await claimFairJob(ctx, body)
        : body.preferLookup !== false
          ? ((await claimOneLookupJob(ctx)) || (await claimOneKeywordJob(ctx)))
          : ((await claimOneKeywordJob(ctx)) || (await claimOneLookupJob(ctx)));
      return json(request, { ok: true, job });
    }
    if (body.action === "queue-all-active-trackers") {
      workerControlInput(body);
      await touchWorkerLane(ctx, body);
      return json(request, { ok: true, ...(await queueAllActiveTrackers(ctx)) });
    }
    if (body.action === "submit") {
      workerControlInput(body);
      return json(request, { ok: true, ...(await submitWindow(ctx, body.job, body.window)) });
    }
    if (body.action === "fail") {
      workerControlInput(body);
      return json(request, { ok: true, ...(await failClaims(ctx, body.job, body.errorCode)) });
    }
    throw workerError("LOCAL_WORKER_ACTION_INVALID", 400);
  } catch (error) {
    if (error?.localWorkerPartial) {
      return json(request, {
        ok: false,
        code: "LOCAL_WORKER_SUBMIT_PARTIAL",
        partial: error.localWorkerPartial,
      }, 409);
    }
    const code = String(error?.code || error?.message || "LOCAL_WORKER_REQUEST_FAILED");
    const status = Number(error?.status || 500);
    return json(request, { ok: false, code }, status >= 400 && status <= 599 ? status : 500);
  }
}

export default {
  fetch: withSupabase({ auth: "none" }, handleLocalWorkerRequest),
};

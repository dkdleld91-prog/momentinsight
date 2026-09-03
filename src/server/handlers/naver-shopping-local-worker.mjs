import { withSupabase } from "@supabase/server";

import { localWorkerAuthInput, verifyLocalWorkerSignature } from "../local-worker-auth.mjs";
import {
  LOCAL_WORKER_BODY_MAX_BYTES,
  LOCAL_WORKER_ORGANIC_LIMIT,
  localWorkerCollectionKey,
  validateLocalWorkerJob,
  validateStrictLocalWorkerWindow,
} from "../naver-shopping/local-worker-contract.mjs";
import { claimShoppingWorkerWake } from "../naver-shopping/worker-wake.mjs";
import { protectedJson } from "../security.mjs";
import {
  buildRankTarget,
  findShoppingRankFromWindow,
  normalizeText,
  shoppingRankMessage,
} from "./naver-shopping-rank.mjs";
import {
  buildProductRankSnapshotRecord,
  nextRankCheckAt,
  representativeTrackingRankMessage,
  selectRepresentativeTrackingRank,
  verifiedRelatedCatalogIdFromSnapshots,
} from "./naver-rank-trackers.mjs";

// Keep each continuity-history RPC below Supabase's common 1,000-row response
// ceiling (8 trackers x 120 snapshots). One keyword job may still contain up to
// the shared contract's 100 trackers and is loaded in bounded chunks below.
const CATALOG_HISTORY_BATCH_MAX = 8;
const WORKER_COLLECTION_LEASE_SECONDS = 35 * 60;
const SNAPSHOT_HISTORY_PER_TRACKER = 120;
const SAFE_FAILURE_PATTERN = /^[a-z0-9_:-]{3,80}$/u;
const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{2,63}$/u;
const WORKER_LANE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXPECTED_WORKER_RUNTIME_VERSION = "1.1.21";
const WORKER_RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const WORKER_RUNTIME_FINGERPRINT_PATTERN = /^(?!0{64}$)[0-9a-f]{64}$/u;
const WORKER_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ERROR_CODE_PATTERN = /^LOCAL_WORKER_[A-Z0-9_]+$/u;
const WORKER_PROGRESS_STAGES = new Set([
  "claiming",
  "navigating",
  "collecting",
  "submitting",
  "completed",
  "failed",
]);
const WORKER_JOB_KINDS = new Set(["", "lookup", "tracker"]);
const WORKER_RUN_TRIGGERS = new Set([
  "manual",
  "rank-catch-up",
  "rank-0900",
  "rank-1500",
  "rank-remote",
  "mac-standby",
  "github-cloud",
]);
// This bounded enum is the only submit failure detail allowed across the
// worker trust boundary. Never copy database codes, messages, details or stacks.
const SUBMIT_PARTIAL_CAUSE_CODES = new Set([
  "LOCAL_WORKER_MATCH_RESULT_INCOMPLETE",
  "LOCAL_WORKER_COMMIT_INVALID",
  "LOCAL_WORKER_COMMIT_UNAVAILABLE",
]);
const SUBMIT_PARTIAL_FALLBACK_CAUSE_CODE = "LOCAL_WORKER_SUBMIT_FAILED";
const SUBMIT_PARTIAL_TRUST_MARKER = Symbol("local-worker-submit-partial");
const SUBMIT_DIRECT_ERROR_CODES = new Set([
  "LOCAL_WORKER_FINITE_MATCH_INVALID",
  "LOCAL_WORKER_TRACKER_MISMATCH",
  "LOCAL_WORKER_LOOKUP_MISMATCH",
]);

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

function cycleValue(source, camelName, snakeName) {
  return source?.[camelName] ?? source?.[snakeName];
}

function cycleCount(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000) {
    throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  }
  return parsed;
}

function cycleTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  return new Date(parsed).toISOString();
}

function cycleUuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (!WORKER_RUN_ID_PATTERN.test(normalized)) {
    throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  }
  return normalized;
}

async function queueAllActiveTrackers(ctx, body) {
  const control = workerControlInput(body);
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_queue_naver_shopping_cycle", {
    p_worker_id: control.workerId,
    p_lane_token: control.laneToken,
    p_run_id: control.runId,
    p_run_trigger: control.runTrigger,
  });
  if (error) throw workerError("LOCAL_WORKER_CYCLE_UNAVAILABLE", 503);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  }

  const status = String(data.status || "").trim().toLowerCase();
  if (!["active", "empty", "waiting"].includes(status)) {
    throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  }
  if (status === "waiting") {
    const reason = String(data.reason || "").trim().toLowerCase();
    if (!["account_priority_active", "account_priority_expiry_reconciled"].includes(reason)) {
      throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
    }
    return {
      total: 0,
      queued: 0,
      alreadyQueued: 0,
      alreadyProcessing: 0,
      cycleId: null,
      cycleStartedAt: null,
      waiting: true,
      reason,
    };
  }
  const cycleId = cycleUuid(cycleValue(data, "cycleId", "cycle_id"));
  const cycleStartedAtValue = cycleValue(data, "cycleStartedAt", "cycle_started_at");
  const cycleStartedAt = cycleStartedAtValue == null ? null : cycleTimestamp(cycleStartedAtValue);
  const started = cycleValue(data, "started", "started") === true;
  const total = cycleCount(cycleValue(data, "total", "total"));
  const remaining = cycleCount(cycleValue(data, "remaining", "remaining"));
  const processing = cycleCount(cycleValue(data, "processing", "processing"));
  if (remaining > total || processing > total
    || (status === "active" && (!cycleId || !cycleStartedAt || total < 1))
    || (status === "empty" && (cycleId || cycleStartedAt || started || total !== 0
      || remaining !== 0 || processing !== 0))) {
    throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  }
  return {
    total,
    queued: started ? remaining : 0,
    alreadyQueued: started ? 0 : remaining,
    alreadyProcessing: processing,
    cycleId,
    cycleStartedAt,
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

function submitPartialCauseCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return SUBMIT_PARTIAL_CAUSE_CODES.has(code)
    ? code
    : SUBMIT_PARTIAL_FALLBACK_CAUSE_CODE;
}

function submitPartialError(error, counts) {
  const wrapped = workerError("LOCAL_WORKER_SUBMIT_PARTIAL", 409);
  wrapped[SUBMIT_PARTIAL_TRUST_MARKER] = true;
  wrapped.localWorkerPartial = {
    causeCode: submitPartialCauseCode(error),
    ...counts,
    claimResults: [...counts.claimResults],
  };
  return wrapped;
}

function normalizedKeywordKey(value) {
  return normalizeText(value).replace(/\s/g, "").toLowerCase();
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
  const runTrigger = String(body?.runTrigger || "").trim().toLowerCase();
  if (!WORKER_RUNTIME_VERSION_PATTERN.test(runtimeVersion)
    || runtimeVersion !== EXPECTED_WORKER_RUNTIME_VERSION
    || !WORKER_RUNTIME_FINGERPRINT_PATTERN.test(runtimeFingerprint)) {
    throw workerError("LOCAL_WORKER_RUNTIME_IDENTITY_INVALID", 400);
  }
  if (!WORKER_RUN_TRIGGERS.has(runTrigger)) {
    throw workerError("LOCAL_WORKER_RUN_TRIGGER_INVALID", 400);
  }
  return { ...lane, runId, runtimeVersion, runtimeFingerprint, runTrigger };
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
      p_run_trigger: control.runTrigger,
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
    || !["system", "tracker", "lookup", "security"].includes(scope)
    || (scope === "tracker" && !trackerId)
    || (scope === "lookup" && job.kind !== "lookup")) {
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

async function claimOneLookupJob(ctx, body) {
  const control = workerControlInput(body);
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_claim_naver_shopping_rank_lookup_job", {
    p_worker_id: control.workerId,
    p_lane_token: control.laneToken,
    p_run_id: control.runId,
    p_run_trigger: control.runTrigger,
    p_lease_seconds: WORKER_COLLECTION_LEASE_SECONDS,
  });
  if (error) {
    if (/schema cache|does not exist|mi_claim_naver_shopping_rank_lookup_job/iu.test(error.message || "")) return null;
    throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
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

async function claimRepairPriority(ctx, body, options = {}) {
  const control = workerControlInput(body);
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_claim_naver_shopping_repair_priority", {
    p_worker_id: control.workerId,
    p_lane_token: control.laneToken,
    p_run_id: control.runId,
    p_run_trigger: control.runTrigger,
    p_lease_seconds: WORKER_COLLECTION_LEASE_SECONDS,
    p_account_only: options.accountOnly === true,
  });
  if (error) throw workerError("LOCAL_WORKER_REPAIR_UNAVAILABLE", 503);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw workerError("LOCAL_WORKER_REPAIR_INVALID", 503);
  }

  const status = String(data.status || "").trim().toLowerCase();
  const priority = String(data.priority || "").trim().toLowerCase();
  const accountPriority = data.accountPriority === true;
  const rawClaims = Array.isArray(data.claims) ? data.claims : [];
  if (["empty", "waiting"].includes(status)) {
    if (priority !== "repair" || rawClaims.length !== 0) {
      throw workerError("LOCAL_WORKER_REPAIR_INVALID", 503);
    }
    return { status, job: null };
  }
  if (status !== "claimed"
    || priority !== "repair"
    || (accountPriority && control.runTrigger !== "rank-catch-up")
    || (accountPriority
      ? rawClaims.length < 1 || rawClaims.length > 100
      : rawClaims.length !== 1)) {
    throw workerError("LOCAL_WORKER_REPAIR_INVALID", 503);
  }

  const requestId = String(cycleValue(data, "requestId", "request_id") || "").trim().toLowerCase();
  const position = Number(cycleValue(data, "position", "position"));
  if (!WORKER_RUN_ID_PATTERN.test(requestId)
    || !Number.isSafeInteger(position)
    || position < 1
    || position > (accountPriority ? 1_000 : 10)) {
    throw workerError("LOCAL_WORKER_REPAIR_INVALID", 503);
  }

  // Only the bounded lease envelope crosses into the worker job. Canonical
  // tracker fields are loaded from naver_rank_trackers after the claim; any
  // extra/raw tracker payload returned by the RPC is deliberately discarded.
  const job = {
    keyword: normalizeText(data.keyword),
    limit: LOCAL_WORKER_ORGANIC_LIMIT,
    claims: rawClaims.map((claim) => ({
      trackerId: cycleValue(claim, "trackerId", "tracker_id"),
      leaseStartedAt: cycleValue(claim, "leaseStartedAt", "lease_started_at"),
      leaseUntil: cycleValue(claim, "leaseUntil", "lease_until"),
    })),
  };
  try {
    return {
      status,
      job: validateLocalWorkerJob(job, { requireActiveLease: true, nowMs: Date.now() }),
    };
  } catch {
    throw workerError("LOCAL_WORKER_REPAIR_INVALID", 503);
  }
}

async function claimCycleKeyword(ctx, body) {
  const control = workerControlInput(body);
  const probeTrackerId = optionalUuid(body?.probeTrackerId, "LOCAL_WORKER_PROBE_TRACKER_INVALID");
  const { data, error } = await ctx.supabaseAdmin.rpc("mi_claim_naver_shopping_cycle_keyword", {
    p_worker_id: control.workerId,
    p_lane_token: control.laneToken,
    p_run_id: control.runId,
    p_run_trigger: control.runTrigger,
    p_probe_tracker_id: probeTrackerId,
    p_lease_seconds: WORKER_COLLECTION_LEASE_SECONDS,
  });
  if (error) throw workerError("LOCAL_WORKER_CYCLE_UNAVAILABLE", 503);
  if (data == null) throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  if (typeof data !== "object" || Array.isArray(data)) {
    throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  }

  const status = String(data.status || "").trim().toLowerCase();
  if (["waiting", "cycle_completed", "no_cycle"].includes(status)) {
    return { status, job: null };
  }
  if (status !== "claimed") throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  const rawClaims = Array.isArray(data.claims) ? data.claims : [];
  const cycleId = cycleUuid(cycleValue(data, "cycleId", "cycle_id"));
  const priority = String(data.priority || "").trim().toLowerCase();
  if ((!cycleId && priority !== "probe")
    || !["new", "resume", "normal", "probe", "repair"].includes(priority)
    || rawClaims.length < 1 || rawClaims.length > 100) {
    throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  }
  const job = {
    keyword: normalizeText(data.keyword),
    limit: LOCAL_WORKER_ORGANIC_LIMIT,
    claims: rawClaims.map((claim) => ({
      trackerId: cycleValue(claim, "trackerId", "tracker_id"),
      leaseStartedAt: cycleValue(claim, "leaseStartedAt", "lease_started_at"),
      leaseUntil: cycleValue(claim, "leaseUntil", "lease_until"),
    })),
  };
  try {
    return {
      status,
      job: validateLocalWorkerJob(job, { requireActiveLease: true, nowMs: Date.now() }),
    };
  } catch {
    throw workerError("LOCAL_WORKER_CYCLE_INVALID", 503);
  }
}

async function loadClaimTrackers(ctx, job) {
  const ids = job.claims.map((claim) => claim.trackerId);
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(WORKER_TRACKER_SELECT)
    .in("id", ids);
  if (error) throw workerError("LOCAL_WORKER_COMMIT_UNAVAILABLE", 503);
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
  const historyRows = [];
  for (let offset = 0; offset < trackerIds.length; offset += CATALOG_HISTORY_BATCH_MAX) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await ctx.supabaseAdmin.rpc(
      "mi_load_naver_shopping_worker_catalog_history",
      {
        p_tracker_ids: trackerIds.slice(offset, offset + CATALOG_HISTORY_BATCH_MAX),
        p_checked_at: checkedAt,
        p_per_tracker_limit: SNAPSHOT_HISTORY_PER_TRACKER,
      },
    );
    if (error) throw workerError("LOCAL_WORKER_COMMIT_UNAVAILABLE", 503);
    historyRows.push(...(data || []));
  }
  const byTrackerId = new Map(trackerIds.map((trackerId) => [String(trackerId).toLowerCase(), []]));
  for (const row of historyRows) {
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
  // Every tracker job may submit a proven stable finite market; a one-off
  // lookup still requires the strict 300-window.
  const window = validateStrictLocalWorkerWindow(rawWindow, {
    keyword: job.keyword,
    allowStableFinite: job.kind !== "lookup",
  });
  const finiteWindow = window.finiteWindowProof?.version === "stable-finite-window-v1";
  const counts = {
    committedCount: 0,
    alreadyCommittedCount: 0,
    leaseLostCount: 0,
    collectionConflictCount: 0,
    processedCount: 0,
    claimResults: [],
  };

  try {
    if (job.kind === "lookup") return await submitLookupWindow(ctx, job, window);
    const claimTrackers = await loadClaimTrackers(ctx, job);
    const verifiedCatalogs = await loadVerifiedCatalogs(ctx, claimTrackers, window.collectedAt);
    for (const { claim, tracker } of claimTrackers) {
      const checkedAt = window.collectedAt;
      const verifiedRelatedCatalogId = verifiedCatalogs.get(String(tracker.id).toLowerCase()) || "";
      const directTarget = buildRankTarget({
        targetProductId: tracker.product_id,
        targetUrl: tracker.product_url,
      });
      if (directTarget.hasDirectTarget !== true || directTarget.productIds.length < 1) {
        throw workerError("LOCAL_WORKER_MATCH_RESULT_INCOMPLETE", 422);
      }
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
      const result = selectRepresentativeTrackingRank(lookup, tracker.product_id);
      if (result.complete !== true || Number(result.checkedCount) !== window.checkedCount) {
        throw workerError("LOCAL_WORKER_MATCH_RESULT_INCOMPLETE", 422);
      }
      const relatedCatalogId = String(result.relatedCatalogProductId || "").trim();
      const selectedCatalogId = String(result?.item?.catalogId || result?.item?.productId || "").trim();
      const exactDirectCatalogRelationship = result.trackingRankSource === "related_catalog"
        && result.relatedCatalogRelationBasis === "catalog_seller_product_id"
        && relatedCatalogId
        && relatedCatalogId !== String(tracker.product_id || "").trim()
        && selectedCatalogId === relatedCatalogId
        && Array.isArray(result?.item?.catalogSellerProductIds)
        && result.item.catalogSellerProductIds.map(String).includes(String(tracker.product_id || "").trim());
      if (result.trackingRankSource === "related_catalog" && !exactDirectCatalogRelationship) {
        throw workerError("LOCAL_WORKER_MATCH_RESULT_INCOMPLETE", 422);
      }
      // A proven finite market commits whatever it truthfully shows: the exact
      // seller product, a directly linked parent catalog, or "not found" with
      // no rank. The proof (two identical direct-ID captures, verified market
      // total, exhausted source) is the safety boundary, not the outcome.
      if (finiteWindow && !isValidFiniteMatchResult(result, window.checkedCount)) {
        throw workerError("LOCAL_WORKER_FINITE_MATCH_INVALID", 422);
      }
      const message = representativeTrackingRankMessage(result);
      const snapshot = buildProductRankSnapshotRecord(tracker, checkedAt, result, message);
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await ctx.supabaseAdmin.rpc(finiteWindow
        ? "mi_commit_naver_shopping_finite_worker_result"
        : "mi_commit_naver_shopping_worker_result", {
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
      if (error) throw workerError("LOCAL_WORKER_COMMIT_UNAVAILABLE", 503);
      const status = String(data?.status || "").trim().toLowerCase();
      if (!["committed", "already_committed", "lease_lost", "collection_conflict"].includes(status)) {
        throw workerError("LOCAL_WORKER_COMMIT_INVALID", 503);
      }
      counts.processedCount += 1;
      counts.claimResults.push({ claimId: claim.trackerId, status });
      if (status === "committed") counts.committedCount += 1;
      else if (status === "already_committed") counts.alreadyCommittedCount += 1;
      else if (status === "lease_lost") counts.leaseLostCount += 1;
      else counts.collectionConflictCount += 1;
    }
  } catch (error) {
    if (SUBMIT_DIRECT_ERROR_CODES.has(error?.code)) throw error;
    throw submitPartialError(error, counts);
  }

  return finiteWindow
    ? {
      ...counts,
      finiteCommittedCount: counts.committedCount + counts.alreadyCommittedCount,
    }
    : counts;
}

function sameLeaseTimestamp(left, right) {
  const leftMs = Date.parse(String(left || ""));
  const rightMs = Date.parse(String(right || ""));
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function reconciledSubmitCounts(claimResults) {
  const count = (status) => claimResults.filter((result) => result.status === status).length;
  return {
    committedCount: count("committed"),
    alreadyCommittedCount: count("already_committed"),
    leaseLostCount: count("lease_lost"),
    collectionConflictCount: count("collection_conflict"),
    uncommittedCount: count("uncommitted"),
    processedCount: claimResults.length,
    claimResults,
  };
}

const FINITE_TRACKING_RANK_SOURCES = new Set(["exact_product", "related_catalog", "not_found"]);

function isValidFiniteMatchResult(result, checkedCount) {
  const source = result?.trackingRankSource;
  if (result?.sourceExhausted !== true
    || result?.finiteWindowProofVersion !== "stable-finite-window-v1"
    || !FINITE_TRACKING_RANK_SOURCES.has(source)) return false;
  if (result.matched === true) {
    const rank = Number(result.rank);
    return source !== "not_found"
      && Number.isSafeInteger(rank)
      && rank >= 1
      && rank <= checkedCount;
  }
  return result.matched === false && result.rank == null && source === "not_found";
}

function isExactFiniteSnapshot(row) {
  const checkedCount = row?.checked_count;
  const rank = row?.rank;
  const total = row?.total;
  const item = row?.item;
  const source = item?.trackingRankSource;
  const sellerProductIds = item?.catalogSellerProductIds;
  const baseShape = Number.isSafeInteger(checkedCount)
    && checkedCount >= 1
    && checkedCount < LOCAL_WORKER_ORGANIC_LIMIT
    && /^pw-chrome-/u.test(String(row?.collection_id || ""))
    && row?.source === "naver_shopping_results_collector"
    && total === checkedCount
    && Array.isArray(row?.top_items)
    && row.top_items.every((topItem) => topItem?.isOrganic === true && topItem?.isAd === false)
    && item
    && typeof item === "object"
    && !Array.isArray(item)
    && item.finiteWindowProofVersion === "stable-finite-window-v1"
    && item.sourceExhausted === true
    && Number.isSafeInteger(item.finiteMarketTotal)
    && item.finiteMarketTotal === checkedCount
    && item.atomicSuccessEligible === false
    && item.rankPolicy === "organic_only"
    && item.adExcluded === true
    && item.rankEvidence === "naver_shopping_organic_list"
    && item.collectionId === row.collection_id
    && FINITE_TRACKING_RANK_SOURCES.has(source);
  if (!baseShape) return false;
  if (row.matched !== true) {
    return row.matched === false && rank == null && source === "not_found";
  }
  const matchedShape = source !== "not_found"
    && Number.isSafeInteger(rank)
    && rank >= 1
    && rank <= checkedCount
    && item.isOrganic === true
    && item.isAd === false;
  if (!matchedShape) return false;
  if (source !== "related_catalog") return true;
  const relatedCatalogId = String(item.relatedCatalogProductId || "");
  return relatedCatalogId !== ""
    && item.relatedCatalogRelationBasis === "catalog_seller_product_id"
    && String(item.catalogId || "") === relatedCatalogId
    && Array.isArray(sellerProductIds)
    && sellerProductIds.length >= 1
    && sellerProductIds.length <= 300
    && sellerProductIds.every((sellerId) => /^[0-9]{5,80}$/u.test(String(sellerId || "")));
}

function isExactTrackerClaimLedger(row, context) {
  return row?.event_type === "tracker_claimed"
    && WORKER_RUN_ID_PATTERN.test(String(row?.claim_id || ""))
    && String(row?.run_id || "").toLowerCase() === context.runId
    && String(row?.worker_id || "").toLowerCase() === context.workerId
    && String(row?.tracker_id || "").toLowerCase() === context.claim.trackerId
    && sameLeaseTimestamp(row?.lease_started_at, context.claim.leaseStartedAt);
}

function isExactFiniteCommitLedger(row, context) {
  const checkedCount = row?.checked_count;
  const rank = row?.details?.rank;
  return row?.event_type === "finite_window_committed"
    && String(row?.claim_id || "").toLowerCase()
      === String(context.claimLedger.claim_id || "").toLowerCase()
    && String(row?.run_id || "").toLowerCase() === context.runId
    && String(row?.worker_id || "").toLowerCase() === context.workerId
    && String(row?.tracker_id || "").toLowerCase() === context.claim.trackerId
    && row?.collection_id === context.collectionId
    && sameLeaseTimestamp(row?.lease_started_at, context.claim.leaseStartedAt)
    && Number.isSafeInteger(checkedCount)
    && checkedCount === context.snapshot.checked_count
    && row?.details?.source === "naver_shopping_results_collector"
    && row?.details?.finiteWindowProofVersion === "stable-finite-window-v1"
    && row?.details?.sourceExhausted === true
    && Number.isSafeInteger(row?.details?.marketTotal)
    && row.details.marketTotal === checkedCount
    && row?.details?.matched === context.snapshot.matched
    && (context.snapshot.matched === true
      ? (Number.isSafeInteger(rank)
        && rank === context.snapshot.rank
        && rank >= 1
        && rank <= checkedCount)
      : (rank == null && context.snapshot.rank == null))
    && (context.snapshot.item?.trackingRankSource === "related_catalog"
      ? row?.details?.relationBasis === "catalog_seller_product_id"
      : row?.details?.relationBasis == null)
    && row?.details?.atomicSuccessEligible === false;
}

async function reconcileSubmit(ctx, rawJob, rawCollectionId, control = {}) {
  const job = validateLocalWorkerJob(rawJob);
  const collectionId = String(rawCollectionId || "").trim();
  const claimId = (claim) => (job.kind === "lookup" ? claim.lookupJobId : claim.trackerId);
  // Reuse the shared collection-key validator without persisting or deriving a
  // new key. Reconciliation is read-only and identifies prior terminal writes.
  try {
    for (const claim of job.claims) localWorkerCollectionKey(claimId(claim), collectionId);
  } catch {
    throw workerError("LOCAL_WORKER_COLLECTION_ID_INVALID", 400);
  }

  if (job.kind === "lookup") {
    const claim = job.claims[0];
    const { data, error } = await ctx.supabaseAdmin
      .from("naver_shopping_rank_lookup_jobs")
      .select("id, status, collection_id, processing_started_at")
      .in("id", [claim.lookupJobId]);
    if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
    const row = (data || []).find((entry) => String(entry?.id || "").toLowerCase() === claim.lookupJobId);
    const status = row?.status === "completed" && row?.collection_id === collectionId
      ? "already_committed"
      : row?.status === "processing" && sameLeaseTimestamp(row?.processing_started_at, claim.leaseStartedAt)
        ? "uncommitted"
        : "lease_lost";
    return reconciledSubmitCounts([{ claimId: claim.lookupJobId, status }]);
  }

  const trackerIds = job.claims.map((claim) => claim.trackerId);
  const { data: snapshots, error: snapshotError } = await ctx.supabaseAdmin
    .from("naver_rank_snapshots")
    .select("tracker_id, collection_id, checked_count, total, rank, matched, source, item, top_items")
    .in("tracker_id", trackerIds)
    .eq("collection_id", collectionId);
  if (snapshotError) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  const committedIds = new Set((snapshots || []).map((row) => String(row?.tracker_id || "").toLowerCase()));
  const exactFiniteSnapshots = new Map((snapshots || [])
    .filter(isExactFiniteSnapshot)
    .map((row) => [String(row?.tracker_id || "").toLowerCase(), row]));
  // Only a finite-looking snapshot needs its scheduler ledger to confirm the
  // finite terminal; atomic 300 snapshots reconcile from the snapshot alone.
  const finiteLooking = (snapshots || []).some((row) => (
    row?.item?.finiteWindowProofVersion === "stable-finite-window-v1"
  ));
  let schedulerLedgers = [];
  if (finiteLooking) {
    const { data, error } = await ctx.supabaseAdmin
      .from("naver_shopping_scheduler_events")
      .select("event_type, claim_id, run_id, worker_id, tracker_id, lease_started_at, collection_id, checked_count, details")
      .in("event_type", ["tracker_claimed", "finite_window_committed"])
      .in("tracker_id", trackerIds)
      .eq("run_id", control.runId);
    if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
    schedulerLedgers = data || [];
  }

  const { data: trackers, error: trackerError } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id, processing_started_at")
    .in("id", trackerIds);
  if (trackerError) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
  const trackersById = new Map((trackers || []).map((row) => [String(row?.id || "").toLowerCase(), row]));
  const claimResults = job.claims.map((claim) => {
    if (committedIds.has(claim.trackerId)) {
      return { claimId: claim.trackerId, status: "already_committed" };
    }
    const tracker = trackersById.get(claim.trackerId);
    return {
      claimId: claim.trackerId,
      status: tracker && sameLeaseTimestamp(tracker.processing_started_at, claim.leaseStartedAt)
        ? "uncommitted"
        : "lease_lost",
    };
  });
  const counts = reconciledSubmitCounts(claimResults);
  if (!finiteLooking) return counts;
  const finiteCommittedCount = claimResults.filter((result) => {
    if (result.status !== "already_committed") return false;
    const snapshot = exactFiniteSnapshots.get(result.claimId);
    if (!snapshot) return false;
    const claim = job.claims.find((candidate) => candidate.trackerId === result.claimId);
    if (!claim) return false;
    const ledgerContext = {
      runId: String(control.runId || "").toLowerCase(),
      workerId: String(control.workerId || "").toLowerCase(),
      claim,
      collectionId,
      snapshot,
    };
    const claimLedgers = schedulerLedgers.filter((ledger) => (
      isExactTrackerClaimLedger(ledger, ledgerContext)
    ));
    if (claimLedgers.length !== 1) return false;
    return schedulerLedgers.filter((ledger) => isExactFiniteCommitLedger(ledger, {
      ...ledgerContext,
      claimLedger: claimLedgers[0],
    })).length === 1;
  }).length;
  return { ...counts, finiteCommittedCount };
}

async function submitLookupWindow(ctx, job, window) {
  const claim = job.claims[0];
  const { data: lookup, error: lookupError } = await ctx.supabaseAdmin
    .from("naver_shopping_rank_lookup_jobs")
    .select(WORKER_LOOKUP_SELECT)
    .eq("id", claim.lookupJobId)
    .eq("status", "processing")
    .maybeSingle();
  if (lookupError) throw workerError("LOCAL_WORKER_COMMIT_UNAVAILABLE", 503);
  if (!lookup
    || normalizedKeywordKey(lookup.keyword) !== normalizedKeywordKey(job.keyword)
    || new Date(lookup.processing_started_at).toISOString() !== claim.leaseStartedAt) {
    throw workerError("LOCAL_WORKER_LOOKUP_MISMATCH", 409);
  }

  const directTarget = buildRankTarget({
    targetProductId: lookup.product_id,
    targetUrl: lookup.product_url,
    targetCatalogId: lookup.target_catalog_id,
  });
  if (directTarget.hasDirectTarget !== true || directTarget.productIds.length < 1) {
    throw workerError("LOCAL_WORKER_MATCH_RESULT_INCOMPLETE", 422);
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
  if (error) throw workerError("LOCAL_WORKER_COMMIT_UNAVAILABLE", 503);
  if (!["committed", "already_committed", "lease_lost", "collection_conflict"].includes(data)) {
    throw workerError("LOCAL_WORKER_COMMIT_INVALID", 503);
  }
  return {
    committedCount: data === "committed" ? 1 : 0,
    alreadyCommittedCount: data === "already_committed" ? 1 : 0,
    leaseLostCount: data === "lease_lost" ? 1 : 0,
    collectionConflictCount: data === "collection_conflict" ? 1 : 0,
    processedCount: 1,
    claimResults: [{
      claimId: claim.lookupJobId,
      status: data,
    }],
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
    if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
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
    if (error) throw workerError("LOCAL_WORKER_COORDINATION_UNAVAILABLE", 503);
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
      const control = workerControlInput(body);
      await touchWorkerLane(ctx, body);
      return json(request, { ok: true, wake: await claimShoppingWorkerWake(ctx, control) });
    }
    if (body.action === "claim") {
      workerControlInput(body);
      await touchWorkerLane(ctx, body);
      if (body.schedulerVersion !== "v2") {
        throw workerError("LOCAL_WORKER_SCHEDULER_VERSION_STALE", 409);
      }
      // A bounded runner may drain more than one job under the same signed
      // lane/run. Re-register the exact idle claim envelope before every DB
      // selector call so a completed prior job cannot strand the next turn.
      await reportWorkerProgress(ctx, {
        ...body,
        stage: "claiming",
        page: 0,
        jobKind: "",
        trackerId: null,
      });
      let job;
      if (body.schedulerVersion === "v2") {
        const probeTrackerId = optionalUuid(body?.probeTrackerId, "LOCAL_WORKER_PROBE_TRACKER_INVALID");
        if (body.autoRecovery != null && typeof body.autoRecovery !== "boolean") {
          throw workerError("LOCAL_WORKER_RECOVERY_FLAG_INVALID", 400);
        }
        const autoRecovery = body.autoRecovery === true;
        if (autoRecovery) {
          // During an active account request, the frozen account member is the
          // only allowed half-open probe.  If no account request remains after
          // reconciliation, fall through once to the existing cycle probe.
          const accountProbe = await claimRepairPriority(ctx, body, { accountOnly: true });
          job = accountProbe.job;
          if (accountProbe.status === "empty") {
            job = (await claimCycleKeyword(ctx, body)).job;
          }
        } else if (probeTrackerId) {
          // An explicit canary remains direct when no account request is
          // active. The DB cycle gate returns waiting without mutation while
          // account priority is active.
          job = (await claimCycleKeyword(ctx, body)).job;
        } else {
          const repairTurn = await claimRepairPriority(ctx, body);
          job = repairTurn.job;
          if (repairTurn.status === "empty") {
            const cycleTurn = await claimCycleKeyword(ctx, body);
            job = cycleTurn.job;
            if (!job && ["cycle_completed", "no_cycle"].includes(cycleTurn.status)) {
              job = await claimOneLookupJob(ctx, body);
            }
          }
        }
      }
      return json(request, { ok: true, job });
    }
    if (body.action === "queue-all-active-trackers") {
      workerControlInput(body);
      await touchWorkerLane(ctx, body);
      return json(request, { ok: true, ...(await queueAllActiveTrackers(ctx, body)) });
    }
    if (body.action === "submit") {
      workerControlInput(body);
      return json(request, { ok: true, ...(await submitWindow(ctx, body.job, body.window)) });
    }
    if (body.action === "reconcile-submit") {
      const control = workerControlInput(body);
      return json(request, {
        ok: true,
        ...(await reconcileSubmit(ctx, body.job, body.collectionId, control)),
      });
    }
    if (body.action === "fail") {
      workerControlInput(body);
      return json(request, { ok: true, ...(await failClaims(ctx, body.job, body.errorCode)) });
    }
    throw workerError("LOCAL_WORKER_ACTION_INVALID", 400);
  } catch (error) {
    if (error?.[SUBMIT_PARTIAL_TRUST_MARKER] === true && error?.localWorkerPartial) {
      return json(request, {
        ok: false,
        code: "LOCAL_WORKER_SUBMIT_PARTIAL",
        partial: error.localWorkerPartial,
      }, 409);
    }
    const code = typeof error?.code === "string" ? error.code : "";
    if (!WORKER_ERROR_CODE_PATTERN.test(code)) {
      return json(request, { ok: false, code: "LOCAL_WORKER_REQUEST_FAILED" }, 500);
    }
    const status = Number(error?.status || 500);
    return json(request, { ok: false, code }, status >= 400 && status <= 599 ? status : 500);
  }
}

export default {
  fetch: withSupabase({ auth: "none" }, handleLocalWorkerRequest),
};

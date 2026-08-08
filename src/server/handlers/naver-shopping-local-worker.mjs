import { withSupabase } from "@supabase/server";

import { localWorkerAuthInput, verifyLocalWorkerSignature } from "../local-worker-auth.mjs";
import {
  LOCAL_WORKER_BODY_MAX_BYTES,
  LOCAL_WORKER_ORGANIC_LIMIT,
  validateLocalWorkerJob,
  validateStrictLocalWorkerWindow,
} from "../naver-shopping/local-worker-contract.mjs";
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
// 12-minute tracker lease. Eight trackers also keeps the bulk continuity query
// below Supabase's common 1,000-row response ceiling (8 x 120 snapshots).
const CLAIM_BATCH_MAX = 8;
const SNAPSHOT_HISTORY_PER_TRACKER = 120;
const SAFE_FAILURE_PATTERN = /^[a-z0-9_:-]{3,80}$/u;

const WORKER_TRACKER_SELECT = [
  "id",
  "keyword",
  "product_url",
  "product_id",
  "mall_name",
  "product_title",
  "max_rank",
  "status",
  "next_check_at",
  "current_rank",
  "best_rank",
  "worst_rank",
  "check_count",
  "found_count",
  "retry_count",
  "processing_started_at",
  "processing_until",
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
    p_lease_seconds: 720,
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

async function claimOneKeywordJob(ctx) {
  const nowIso = new Date().toISOString();
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(WORKER_TRACKER_SELECT)
    .eq("status", "active")
    .lte("next_check_at", nowIso)
    .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
    .order("next_check_at", { ascending: true })
    .limit(CLAIM_BATCH_MAX);
  if (error) throw error;
  const due = Array.isArray(data) ? data.slice(0, CLAIM_BATCH_MAX) : [];
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
    if (body.action === "claim") {
      const preferLookup = body.preferLookup !== false;
      const job = preferLookup
        ? ((await claimOneLookupJob(ctx)) || (await claimOneKeywordJob(ctx)))
        : ((await claimOneKeywordJob(ctx)) || (await claimOneLookupJob(ctx)));
      return json(request, { ok: true, job });
    }
    if (body.action === "queue-all-active-trackers") {
      return json(request, { ok: true, ...(await queueAllActiveTrackers(ctx)) });
    }
    if (body.action === "submit") {
      return json(request, { ok: true, ...(await submitWindow(ctx, body.job, body.window)) });
    }
    if (body.action === "fail") {
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

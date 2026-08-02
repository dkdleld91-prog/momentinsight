import crypto from "node:crypto";

import {
  NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
  normalizeText,
  trustedCollectorWindow,
} from "../handlers/naver-shopping-rank.mjs";

export const LOCAL_WORKER_ORGANIC_LIMIT = 300;
export const LOCAL_WORKER_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const LOCAL_WORKER_ENDPOINT_PATH = "/api/naver-shopping-local-worker";
const DEFAULT_MAX_WINDOW_AGE_MS = 15 * 60_000;
const DEFAULT_FUTURE_TOLERANCE_MS = 60_000;
const COLLECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function contractError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function finiteTime(value, code) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw contractError(code);
  return parsed;
}

function boundedDuration(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function validateLocalWorkerJob(payload = {}, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw contractError("local_worker_job_invalid");
  }
  const keyword = normalizeText(payload.keyword);
  const limit = Number(payload.limit);
  const claims = Array.isArray(payload.claims) ? payload.claims : [];
  if (!keyword || limit !== LOCAL_WORKER_ORGANIC_LIMIT || claims.length < 1 || claims.length > 100) {
    throw contractError("local_worker_job_invalid");
  }

  const seen = new Set();
  const normalizedClaims = claims.map((claim) => {
    const trackerId = String(claim?.trackerId || "").trim().toLowerCase();
    const leaseStartedAt = new Date(finiteTime(claim?.leaseStartedAt, "local_worker_lease_invalid")).toISOString();
    const leaseUntil = new Date(finiteTime(claim?.leaseUntil, "local_worker_lease_invalid")).toISOString();
    const leaseExpired = options.requireActiveLease === true
      && Date.parse(leaseUntil) <= Number(options.nowMs ?? Date.now());
    if (!UUID_PATTERN.test(trackerId)
      || Date.parse(leaseUntil) <= Date.parse(leaseStartedAt)
      || leaseExpired
      || seen.has(trackerId)) {
      throw contractError("local_worker_lease_invalid");
    }
    seen.add(trackerId);
    return { trackerId, leaseStartedAt, leaseUntil };
  });

  return {
    keyword,
    limit,
    claims: normalizedClaims,
  };
}

export function validateStrictLocalWorkerWindow(payload, options = {}) {
  const keyword = normalizeText(options.keyword);
  if (!keyword) throw contractError("local_worker_keyword_missing");
  const trusted = trustedCollectorWindow(payload, {
    keyword,
    maxRank: LOCAL_WORKER_ORGANIC_LIMIT,
  });
  if (
    trusted.schemaVersion !== NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA
    || trusted.checkedCount !== LOCAL_WORKER_ORGANIC_LIMIT
    || trusted.items.length !== LOCAL_WORKER_ORGANIC_LIMIT
    || trusted.complete !== true
    || trusted.partial !== false
  ) {
    throw contractError("local_worker_window_not_300");
  }
  if (!COLLECTION_ID_PATTERN.test(trusted.collectionId)) {
    throw contractError("local_worker_collection_id_invalid");
  }

  const nowMs = Number(options.nowMs ?? Date.now());
  const maxAgeMs = boundedDuration(options.maxAgeMs, DEFAULT_MAX_WINDOW_AGE_MS, 60_000, 60 * 60_000);
  const futureToleranceMs = boundedDuration(
    options.futureToleranceMs,
    DEFAULT_FUTURE_TOLERANCE_MS,
    0,
    5 * 60_000,
  );
  const collectedAtMs = finiteTime(trusted.collectedAt, "local_worker_collected_at_invalid");
  if (collectedAtMs < nowMs - maxAgeMs || collectedAtMs > nowMs + futureToleranceMs) {
    throw contractError("local_worker_window_stale");
  }
  return trusted;
}

export function localWorkerCollectionKey(trackerId, collectionId) {
  const normalizedTrackerId = String(trackerId || "").trim().toLowerCase();
  const normalizedCollectionId = String(collectionId || "").trim();
  if (!UUID_PATTERN.test(normalizedTrackerId) || !COLLECTION_ID_PATTERN.test(normalizedCollectionId)) {
    throw contractError("local_worker_collection_key_invalid");
  }
  return crypto
    .createHash("sha256")
    .update(`${normalizedTrackerId}\n${normalizedCollectionId}`, "utf8")
    .digest("hex");
}

export function localWorkerRankRequest(job, nowMs = Date.now(), timeoutMs = 225_000) {
  const normalized = validateLocalWorkerJob(job, { requireActiveLease: true, nowMs });
  const boundedTimeout = Math.max(30_000, Math.min(225_000, Number(timeoutMs || 225_000)));
  return {
    schemaVersion: NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
    keyword: normalized.keyword,
    limit: LOCAL_WORKER_ORGANIC_LIMIT,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: new Date(Number(nowMs) + boundedTimeout).toISOString(),
  };
}

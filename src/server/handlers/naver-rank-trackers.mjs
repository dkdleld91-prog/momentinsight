import crypto from "node:crypto";
import { withSupabase } from "@supabase/server";
import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { corsHeaders, isLocalRequest, protectedJson, safeEqual } from "../security.mjs";
import {
  hasShoppingRankConfig,
  isHybridLocalWorkerMode,
  isShoppingRankSourceUnavailable,
  SHOPPING_RANK_SOURCE_NOT_CONFIGURED,
  shoppingCollectorFailureStatus,
  shoppingRankConfig,
  shoppingRankSourceStatus,
} from "../naver-shopping/source-status.mjs";
import { requestShoppingWorkerWake } from "../naver-shopping/worker-wake.mjs";
import {
  DEFAULT_RANK_KEYWORD_LIMIT,
  RANK_KEYWORD_LIMIT_CODE,
  isRankKeywordLimitDbError,
  rankKeywordLimitMessage,
  resolveRankKeywordLimit,
} from "../rank-keyword-limit.mjs";
import {
  RANK_PRODUCT_URL_REJECTION_CODE,
  rankProductUrlRejection,
} from "../rank-target-url.mjs";
import {
  forgetGroupMarkColumnMissing,
  forgetOptionCheckedColumnMissing,
  forgetOptionColumnMissing,
  groupCandidateSummaries,
  groupMarkColumnRecentlyMissing,
  groupOptionSnapshotFields,
  groupOptionSuggestionCounts,
  isGroupMarkColumnMissingError,
  isOptionCheckedColumnMissingError,
  isOptionColumnMissingError,
  normalizeStoredOptionProductIds,
  OPTION_PRODUCT_IDS_MAX,
  OPTION_SAME_PRODUCT_TRACKERS_MAX,
  optionCheckedColumnRecentlyMissing,
  optionColumnRecentlyMissing,
  parseOptionProductInput,
  planOptionGroupUpdate,
  rememberGroupMarkColumnMissing,
  rememberOptionCheckedColumnMissing,
  rememberOptionColumnMissing,
  siblingOptionSuggestions,
  trackerGroupProductState,
  trackerOptionEligibility,
  withoutAdminGroupTails,
} from "../naver-rank-option-group.mjs";
import {
  buildRankTarget,
  classifyNaverProductType,
  extractProductId,
  findShoppingRank,
  isAdItem,
  normalizeText,
  shoppingRankMessage,
} from "./naver-shopping-rank.mjs";

const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const KEYWORD_VOLUME_CACHE_TTL_MS = Number(process.env.MI_RANK_KEYWORD_VOLUME_CACHE_TTL_MS || 1000 * 60 * 30);
const KEYWORD_VOLUME_CACHE_MAX = Number(process.env.MI_RANK_KEYWORD_VOLUME_CACHE_MAX || 1000);
// 검색광고 키워드도구는 계정 단위 속도제한(429)이 있어 동시성을 3~4 로 묶고,
// 429/5xx 는 짧은 지수 백오프로 한 번만 재시도한다. 전체 소요가 예산을 넘기면
// 남은 키워드는 "조회 중"(pending) 으로 돌려보내 화면이 흐림 대신 대기로 표시한다.
const KEYWORD_VOLUME_LOOKUP_LIMIT_MIN = 100;
const KEYWORD_VOLUME_LOOKUP_LIMIT = Math.max(
  KEYWORD_VOLUME_LOOKUP_LIMIT_MIN,
  Number(process.env.MI_RANK_KEYWORD_VOLUME_LOOKUP_LIMIT) || 500,
);
const KEYWORD_VOLUME_CONCURRENCY_MAX = 4;
const KEYWORD_VOLUME_CONCURRENCY = Number(process.env.MI_RANK_KEYWORD_VOLUME_CONCURRENCY) || 3;
const KEYWORD_VOLUME_TIME_BUDGET_MS = Number(process.env.MI_RANK_KEYWORD_VOLUME_TIME_BUDGET_MS) || 8000;
const KEYWORD_VOLUME_RETRY_DELAY_MS = Number(process.env.MI_RANK_KEYWORD_VOLUME_RETRY_DELAY_MS) || 400;
const KEYWORD_VOLUME_MAX_RETRIES = 1;
const KEYWORD_VOLUME_PENDING = Object.freeze({ value: null, label: "조회 중", status: "pending" });
const KEYWORD_VOLUME_ERROR = Object.freeze({ value: null, label: "조회 필요", status: "error" });
const MIN_RANK_TRACKER_LEASE_MS = 1000 * 60 * 35;
const configuredRankTrackerLeaseMs = Number(process.env.MI_RANK_TRACKER_LEASE_MS || MIN_RANK_TRACKER_LEASE_MS);
const RANK_TRACKER_LEASE_MS = Number.isFinite(configuredRankTrackerLeaseMs)
  ? Math.max(MIN_RANK_TRACKER_LEASE_MS, configuredRankTrackerLeaseMs)
  : MIN_RANK_TRACKER_LEASE_MS;
const PRODUCT_RANK_HISTORY_DAYS = 30;
const PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS = 120;
const SNAPSHOT_QUERY_PAGE_SIZE = 1000;
// Keyset pagination normally finishes after a handful of pages. Keep an
// explicit ceiling so a malformed/continuously backfilled result set can never
// hold one server request forever.
const SNAPSHOT_QUERY_MAX_PAGES = 64;
const SNAPSHOT_TRACKER_BATCH_SIZE = 50;
const SNAPSHOT_QUERY_CONCURRENCY = 4;
const TRACKER_LIST_MAX = 500;
// 목록 한 번에 검색량 조회가 쓸 수 있는 시간. 기본 예산(8초)은 검색량 전용 조회용이다.
const TRACKER_LIST_KEYWORD_VOLUME_BUDGET_MS = Number(process.env.MI_RANK_LIST_KEYWORD_VOLUME_BUDGET_MS) || 2500;
const TRACKER_LIST_SLOW_LOG_MS = Number(process.env.MI_RANK_LIST_SLOW_LOG_MS) || 2000;
const TRACKER_LIST_QUERY_LIMIT = TRACKER_LIST_MAX + 1;
const DEFAULT_RANK_GROUP = "기본 그룹";
const SHOPPING_WORKER_BLOCK_CODES = new Set([
  "naver_network_restricted",
  "naver_http_418",
  "naver_http_429",
  "naver_captcha_detected",
  "naver_auth_required",
  "naver_verification_required",
]);
const SHOPPING_WORKER_CIRCUIT_STATES = new Set(["closed", "open", "half_open"]);
const SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION = "1.1.34";
const SHOPPING_WORKER_TOTAL_PAGES = 8;
const SHOPPING_WORKER_CONTROL_ACTIONS = new Set([
  "worker-stop",
  "worker-canary",
  "worker-cadence",
]);
const keywordVolumeCache = new Map();

const TRACKER_SELECT = [
  "id",
  "client_id",
  "brand_id",
  "agency_code",
  "keyword",
  "product_url",
  "product_id",
  "mall_name",
  "product_title",
  "max_rank",
  "status",
  "started_at",
  "ends_at",
  "last_checked_at",
  "next_check_at",
  "current_rank",
  "best_rank",
  "worst_rank",
  "check_count",
  "found_count",
  "last_message",
  "last_error",
  "retry_count",
  "sort_order",
  "created_at",
  "updated_at",
].join(", ");

// The list response never serializes top_items. Keep the larger write-return
// projection below so collector/storage behavior is unchanged while the hot
// read path avoids transferring the largest JSON column.
const SNAPSHOT_LIST_SELECT = [
  "id",
  "tracker_id",
  "checked_at",
  "rank",
  "page",
  "position",
  "matched",
  "checked_count",
  "total",
  "item",
  "message",
  "source",
  "created_at",
].join(", ");
const SNAPSHOT_SELECT = `${SNAPSHOT_LIST_SELECT}, top_items`;

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "authorization, content-type, x-demo-admin-code, x-mi-agency-code, x-mi-rank-access-code",
  });
}

function normalizeAgencyCode(value) {
  return normalizeText(value || "").toLowerCase();
}

function normalizeRankGroupName(value) {
  const normalized = normalizeText(value || "").replace(/\s+/g, " ").slice(0, 40);
  return normalized || DEFAULT_RANK_GROUP;
}

function normalizeKeywordCompare(value) {
  return normalizeText(value || "").replace(/\s/g, "").toLowerCase();
}

function normalizeSearchAdKeyword(value) {
  return normalizeText(value || "").replace(/\s/g, "");
}

function normalizeWorkerText(value, maxLength = 160) {
  return normalizeText(value || "").slice(0, maxLength);
}

function normalizeWorkerIso(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeWorkerInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function normalizeWorkerRpcObject(value) {
  const source = Array.isArray(value) ? value[0] : value;
  if (!source || typeof source !== "object") return {};
  if (source.operations && typeof source.operations === "object") return source.operations;
  return source;
}

function workerValue(source, ...keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return null;
}

function isMissingRankLeaseColumns(error) {
  return /processing_started_at|processing_until|schema cache|does not exist/i.test(error?.message || "");
}

function isMissingRankGroupColumn(error) {
  return /group_name|schema cache|does not exist/i.test(error?.message || "");
}

function searchAdConfig() {
  return {
    searchAdApiKey: process.env.NAVER_SEARCHAD_API_KEY || "",
    searchAdSecretKey: process.env.NAVER_SEARCHAD_SECRET_KEY || "",
    searchAdCustomerId: process.env.NAVER_SEARCHAD_CUSTOMER_ID || "",
  };
}

function hasSearchAdConfig(env) {
  return Boolean(env.searchAdApiKey && env.searchAdSecretKey && env.searchAdCustomerId);
}

function parseSearchCount(value) {
  if (typeof value === "number") return { value, upperBound: value, isUnderThreshold: false };
  const text = String(value || "").trim();
  if (!text) return { value: 0, upperBound: 0, isUnderThreshold: false };
  if (text.includes("<")) {
    const upperBound = Number(text.replace(/[^\d.]/g, "")) || 10;
    return { value: 0, upperBound, isUnderThreshold: true };
  }
  const parsed = Number(text.replace(/,/g, "")) || 0;
  return { value: parsed, upperBound: parsed, isUnderThreshold: false };
}

function searchVolumeMetric(pcRaw, mobileRaw) {
  const pc = parseSearchCount(pcRaw);
  const mobile = parseSearchCount(mobileRaw);
  const isUnderThreshold = pc.isUnderThreshold || mobile.isUnderThreshold;
  const value = isUnderThreshold ? 0 : pc.value + mobile.value;
  const upperBound = pc.upperBound + mobile.upperBound;
  return {
    value,
    upperBound,
    isUnderThreshold,
    label: isUnderThreshold
      ? Number(upperBound || 0).toLocaleString("ko-KR") + " 미만"
      : Number(value || 0).toLocaleString("ko-KR"),
  };
}

function keywordVolumeCacheKey(keyword) {
  return normalizeKeywordCompare(keyword);
}

function getKeywordVolumeCache(keyword) {
  const key = keywordVolumeCacheKey(keyword);
  const hit = key ? keywordVolumeCache.get(key) : null;
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    keywordVolumeCache.delete(key);
    return null;
  }
  return hit.value;
}

function setKeywordVolumeCache(keyword, value) {
  const key = keywordVolumeCacheKey(keyword);
  if (!key) return;
  keywordVolumeCache.set(key, { value, expiresAt: Date.now() + KEYWORD_VOLUME_CACHE_TTL_MS });
  while (keywordVolumeCache.size > KEYWORD_VOLUME_CACHE_MAX) {
    const oldestKey = keywordVolumeCache.keys().next().value;
    keywordVolumeCache.delete(oldestKey);
  }
}

function naverSearchAdHeaders(env, method, path) {
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", env.searchAdSecretKey)
    .update(timestamp + "." + method + "." + path)
    .digest("base64");

  return {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp": timestamp,
    "X-API-KEY": env.searchAdApiKey,
    "X-Customer": String(env.searchAdCustomerId),
    "X-Signature": signature,
  };
}

export function clearKeywordVolumeCache() {
  keywordVolumeCache.clear();
}

function isRetryableSearchAdStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestSearchAdKeywordVolume(env, keyword) {
  const path = "/keywordstool";
  const params = new URLSearchParams({ hintKeywords: normalizeSearchAdKeyword(keyword), showDetail: "1" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.MI_RANK_KEYWORD_VOLUME_TIMEOUT_MS || 3500));

  try {
    const response = await fetch(SEARCHAD_BASE_URL + path + "?" + params.toString(), {
      method: "GET",
      headers: naverSearchAdHeaders(env, "GET", path),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const error = new Error(payload?.errorMessage || payload?.message || "HTTP " + response.status);
      error.status = response.status;
      error.retryable = isRetryableSearchAdStatus(response.status);
      throw error;
    }

    const list = Array.isArray(payload?.keywordList) ? payload.keywordList : [];
    const exact = list.find((item) => normalizeKeywordCompare(item.relKeyword) === normalizeKeywordCompare(keyword));
    const metric = exact ? searchVolumeMetric(exact.monthlyPcQcCnt, exact.monthlyMobileQcCnt) : null;
    return metric
      ? { value: metric.value, label: metric.label, status: metric.isUnderThreshold ? "range" : "ok" }
      : { value: null, label: "조회 필요", status: "not_found" };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSearchAdKeywordVolume(env, keyword, options = {}) {
  const cached = getKeywordVolumeCache(keyword);
  if (cached) return cached;

  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? KEYWORD_VOLUME_RETRY_DELAY_MS) || 0);
  const maxRetries = KEYWORD_VOLUME_MAX_RETRIES;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const value = await requestSearchAdKeywordVolume(env, keyword);
      setKeywordVolumeCache(keyword, value);
      return value;
    } catch (error) {
      if (attempt >= maxRetries || error?.retryable !== true) throw error;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
}

function keywordVolumeLookupOptions(options = {}) {
  const concurrency = Math.max(1, Math.min(
    KEYWORD_VOLUME_CONCURRENCY_MAX,
    Math.floor(Number(options.concurrency ?? KEYWORD_VOLUME_CONCURRENCY) || KEYWORD_VOLUME_CONCURRENCY),
  ));
  const budgetMs = Math.max(0, Number(options.budgetMs ?? KEYWORD_VOLUME_TIME_BUDGET_MS) || KEYWORD_VOLUME_TIME_BUDGET_MS);
  const lookupLimit = Math.max(
    KEYWORD_VOLUME_LOOKUP_LIMIT_MIN,
    Math.floor(Number(options.lookupLimit ?? KEYWORD_VOLUME_LOOKUP_LIMIT) || KEYWORD_VOLUME_LOOKUP_LIMIT),
  );
  return { concurrency, budgetMs, lookupLimit, retryDelayMs: options.retryDelayMs };
}

export async function loadKeywordVolumes(keywords, options = {}) {
  const env = searchAdConfig();
  const result = new Map();
  const uniqueKeywords = [...new Set((keywords || []).map((keyword) => normalizeText(keyword)).filter(Boolean))];
  if (!hasSearchAdConfig(env)) return result;

  const { concurrency, budgetMs, lookupLimit, retryDelayMs } = keywordVolumeLookupOptions(options);
  const queue = [];
  const seen = new Set();
  for (const keyword of uniqueKeywords.slice(0, lookupLimit)) {
    const key = normalizeKeywordCompare(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cached = getKeywordVolumeCache(keyword);
    if (cached) result.set(key, cached);
    else queue.push({ key, keyword });
  }
  if (!queue.length) return result;

  const deadline = Date.now() + budgetMs;
  let settled = false;
  let cursor = 0;
  const worker = async () => {
    while (!settled && cursor < queue.length && Date.now() < deadline) {
      const { key, keyword } = queue[cursor];
      cursor += 1;
      let value;
      try {
        value = await fetchSearchAdKeywordVolume(env, keyword, { retryDelayMs });
      } catch {
        value = KEYWORD_VOLUME_ERROR;
      }
      // 예산이 끝난 뒤 도착한 값은 캐시에만 남기고(다음 조회 즉시 히트) 이번 응답은 건드리지 않는다.
      if (!settled) result.set(key, value);
    }
  };

  let budgetTimer = null;
  const budget = new Promise((resolve) => {
    budgetTimer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
  });
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())),
      budget,
    ]);
  } finally {
    settled = true;
    clearTimeout(budgetTimer);
  }

  for (const { key } of queue) {
    if (!result.has(key)) result.set(key, KEYWORD_VOLUME_PENDING);
  }
  return result;
}

function primaryAgencyCode() {
  return normalizeAgencyCode(process.env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
}

function legacyAgencyCodes() {
  return String(process.env.MI_LEGACY_AGENCY_CODES || "")
    .split(",")
    .map((value) => normalizeAgencyCode(value))
    .filter(Boolean);
}

function canonicalAgencyCode(value) {
  const code = normalizeAgencyCode(value);
  if (!code) return "";
  if (legacyAgencyCodes().includes(code)) return primaryAgencyCode();
  return code;
}

function agencyCodeScope(agencyCode) {
  const code = canonicalAgencyCode(agencyCode);
  const scope = [code];
  if (code === primaryAgencyCode()) scope.push(...legacyAgencyCodes());
  return [...new Set(scope.filter(Boolean))];
}

function isPrimaryAgencyCode(agencyCode) {
  return safeEqual(canonicalAgencyCode(agencyCode), primaryAgencyCode());
}

// 총관리자 화면은 "총관리자 내부" 범위를 owner-session 같은 자리표시자 문자열로
// 보낸다. 세션 게이트가 직접 심어 주는 총관리자 표식이 확인될 때에만 그 자리표시자를
// 대표 대행사 코드로 되돌린다. 다른 역할의 세션이 같은 문자열을 보내도 이 경로는
// 열리지 않는다.
const OWNER_SCOPE_PLACEHOLDER_CODES = new Set(["owner-session", "session"]);

function ownerSessionRequest(request) {
  return String(request.headers.get("x-mi-session-role") || "").trim().toLowerCase() === "owner"
    && safeEqual(normalizeAgencyCode(request.headers.get("x-mi-owner-agency-code") || ""), primaryAgencyCode());
}

function isOwnerScopePlaceholder(value) {
  const code = normalizeAgencyCode(value);
  return !code || OWNER_SCOPE_PLACEHOLDER_CODES.has(code);
}

export function requestAgencyCode(request, body = {}) {
  const url = new URL(request.url);
  const trustedSession = Boolean(request.headers.get("x-mi-session-role"));
  const trustedAgencyCode = request.headers.get("x-mi-agency-code") || "";
  const agencyCode = canonicalAgencyCode(
    trustedAgencyCode ||
      (trustedSession ? "" : (
      body.agencyCode ||
      body.agency_code ||
      url.searchParams.get("agencyCode") ||
      url.searchParams.get("agency_code")
      ))
  );
  if (ownerSessionRequest(request) && isOwnerScopePlaceholder(agencyCode)) return primaryAgencyCode();
  return agencyCode;
}

export function requestAccessCode(request, body = {}) {
  const trustedSession = Boolean(request.headers.get("x-mi-session-role"));
  return normalizeAgencyCode(
    request.headers.get("x-mi-rank-access-code") ||
      (trustedSession ? "" : (
      body.accessCode ||
      body.access_code ||
      body.agencyAccessCode ||
      body.agency_access_code
      ))
  );
}

function requestAdminCode(request, body = {}) {
  const trustedSession = Boolean(request.headers.get("x-mi-session-role"));
  return String(
    request.headers.get("x-demo-admin-code") ||
      (trustedSession ? "" : (
      body.adminCode ||
      body.admin_code ||
      ""
      ))
  ).trim();
}

function adminCodeAuthorized(request, body = {}) {
  const configured = process.env.MI_RANK_ADMIN_CODE || process.env.MI_DEMO_ADMIN_CODE || "";
  return Boolean(configured) && safeEqual(requestAdminCode(request, body), configured);
}

function rankAccessCodes() {
  return String(process.env.MI_RANK_ACCESS_CODES || process.env.MI_RANK_ACCESS_CODE || "")
    .split(",")
    .map((value) => normalizeAgencyCode(value))
    .filter(Boolean);
}

function rankAccessAuthorized(request, body = {}, agencyCode = "") {
  const accessCode = canonicalAgencyCode(requestAccessCode(request, body));
  const scopedAgencyCode = canonicalAgencyCode(agencyCode);
  return Boolean(accessCode && scopedAgencyCode && safeEqual(accessCode, scopedAgencyCode));
}

function trustedTeamAccountRankScope(request, agencyCode) {
  const role = String(request.headers.get("x-mi-session-role") || "");
  const sessionScope = String(request.headers.get("x-mi-session-scope") || "");
  const teamCode = canonicalAgencyCode(request.headers.get("x-mi-team-code") || "");
  return role === "team" &&
    sessionScope === "account-only" &&
    Boolean(teamCode) &&
    safeEqual(teamCode, canonicalAgencyCode(agencyCode));
}

export const PRODUCT_RANK_TRACKER_MAX_RANK = 300;

function clampMaxRank() {
  return PRODUCT_RANK_TRACKER_MAX_RANK;
}

function hasDirectCatalogSellerEvidence(item, trackerProductId = "", options = {}) {
  const exactProductId = normalizeText(trackerProductId);
  const selectedCatalogId = normalizeText(item?.catalogId) || normalizeText(item?.productId);
  const relatedCatalogId = normalizeText(item?.relatedCatalogProductId)
    || (options.allowImplicitRelatedId === true && item?.isRelatedCatalog ? selectedCatalogId : "");
  const catalogSellerProductIds = Array.isArray(item?.catalogSellerProductIds)
    ? item.catalogSellerProductIds.map((value) => normalizeText(value)).filter(Boolean)
    : [];
  return Boolean(
    exactProductId
    && relatedCatalogId
    && relatedCatalogId !== exactProductId
    && selectedCatalogId === relatedCatalogId
    && normalizeText(item?.relatedCatalogRelationBasis || item?.relationBasis)
      === "catalog_seller_product_id"
    && catalogSellerProductIds.includes(exactProductId)
  );
}

function trustedProductRankSnapshot(snapshot, trackerProductId = "") {
  const item = snapshot?.item;
  if (!item || item.trackingRankSource !== "related_catalog") return true;
  return hasDirectCatalogSellerEvidence(item, trackerProductId);
}

// N30 그룹상품: 화면에 보일 옵션 번호 목록. 칸을 못 읽은 행(null·키 없음)은 '모름'이라 빈 목록으로 보인다.
// 옵션으로 잡힌 지난 기록은 목록과 상관없이 숨기지 않는다(명세 §7.3·§15-4, 반박 검토 2026-10-23).
function payloadOptionProductIds(row, eligibility) {
  if (!Array.isArray(row?.option_product_ids) || !eligibility.eligible) return [];
  return normalizeStoredOptionProductIds(row.option_product_ids, eligibility.primaryProductIds);
}

// N30 옵션 확인일(2026-10-31 B6). 칸을 읽었으면 문자열(ISO) 또는 null(기록 없음), 못 읽었으면 undefined(모름)다.
function optionCheckedAtKnown(value) {
  return value === null || typeof value === "string";
}

function optionCheckedAtIso(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function displayProductRankItem(item, trackerProductId = "") {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item || null;
  const exactTrackerProductId = normalizeText(trackerProductId);
  const selectedCatalogId = normalizeText(item.catalogId) || normalizeText(item.productId);
  if (exactTrackerProductId
    && selectedCatalogId === exactTrackerProductId
    && item.isExactTarget === true
    && item.exposureType === "exact_catalog") {
    return {
      ...item,
      trackingRankSource: "related_catalog",
      trackingRankSourceLabel: "원부 기준",
    };
  }
  return item;
}

export function trackerPayload(row, snapshots = [], keywordVolume = null, extras = {}) {
  const historyCutoff = Date.now() - PRODUCT_RANK_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const optionEligibility = trackerOptionEligibility(row);
  const optionProductIds = payloadOptionProductIds(row, optionEligibility);
  const groupState = trackerGroupProductState(row);
  const rawRecentSnapshots = (snapshots || [])
    .filter((snapshot) => {
      const checkedAt = new Date(snapshot?.checked_at || snapshot?.checkedAt || 0).getTime();
      return Number.isFinite(checkedAt) && checkedAt >= historyCutoff;
    });
  const recentSnapshots = rawRecentSnapshots
    .filter((snapshot) => trustedProductRankSnapshot(snapshot, row.product_id))
    .slice(0, PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS);
  const latestRawSnapshotRejected = Boolean(
    rawRecentSnapshots[0]
    && !trustedProductRankSnapshot(rawRecentSnapshots[0], row.product_id)
  );
  // 창에 보였지만 순위에 못 쓴 번호(2026-10-30 추가)만 있는 대표 결과 행은 광고주 응답에서 matchBasis 도 예전처럼 비운다.
  const latestTrackingItem = optionSkipPayloadItem(
    displayProductRankItem(recentSnapshots[0]?.item, row.product_id),
    extras?.optionSkipVisible === true,
  ) || {};
  const latestOptionGroup = latestTrackingItem.optionGroup && typeof latestTrackingItem.optionGroup === "object"
    ? latestTrackingItem.optionGroup
    : {};
  const latestGroupOption = latestTrackingItem.matchBasis === "group_option";
  const trustedRanks = recentSnapshots.map((snapshot) => positiveRank(snapshot?.rank)).filter(Boolean);
  const hasTrustedSnapshot = recentSnapshots.length > 0;
  const checkCount = nonNegativeCount(row.check_count);
  const foundCount = nonNegativeCount(row.found_count);
  // 관리자 전용 꼬리 2종은 광고주 응답 lastMessage 에서 뺀다(2026-10-30, DB 문장은 그대로·키 순서 그대로).
  return optionTraceLastMessage({
    id: row.id,
    keyword: row.keyword,
    groupName: normalizeRankGroupName(row.group_name),
    keywordVolume: keywordVolume?.value ?? null,
    keywordVolumeLabel: keywordVolume?.label || "조회 필요",
    keywordVolumeStatus: keywordVolume?.status || "pending",
    productUrl: row.product_url,
    productId: row.product_id,
    mallName: row.mall_name,
    productTitle: row.product_title,
    maxRank: PRODUCT_RANK_TRACKER_MAX_RANK,
    status: row.status,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    lastCheckedAt: hasTrustedSnapshot
      ? (recentSnapshots[0]?.checked_at || recentSnapshots[0]?.checkedAt || null)
      : (latestRawSnapshotRejected ? null : row.last_checked_at),
    nextCheckAt: row.next_check_at,
    currentRank: hasTrustedSnapshot
      ? positiveRank(recentSnapshots[0]?.rank)
      : (latestRawSnapshotRejected ? null : row.current_rank),
    currentRankSource: latestTrackingItem.trackingRankSource || "",
    currentRankSourceLabel: latestTrackingItem.trackingRankSourceLabel || "",
    exactProductRank: latestTrackingItem.exactProductRank || null,
    relatedCatalogRank: latestTrackingItem.relatedCatalogRank || null,
    bestRank: trustedRanks.length ? Math.min(...trustedRanks) : null,
    worstRank: trustedRanks.length ? Math.max(...trustedRanks) : null,
    checkCount: row.check_count,
    foundCount: row.found_count,
    lastMessage: hasTrustedSnapshot
      ? (recentSnapshots[0]?.message || null)
      : (latestRawSnapshotRejected ? null : row.last_message),
    lastError: row.last_error || null,
    retryCount: Number(row.retry_count || 0),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snapshots: recentSnapshots.map((snapshot, index) => snapshotPayload(snapshot, row.product_id, {
      compactItem: index > 0,
      optionSkipVisible: extras?.optionSkipVisible === true,
    })),
    neverFound: checkCount >= 3 && foundCount === 0,
    foundRate: checkCount > 0 ? Math.round((foundCount / checkCount) * 100) / 100 : null,
    lastFoundAt: lastFoundAtFromSnapshots(snapshots),
    // N30 그룹상품(2026-10-23). 옵션 목록을 모르면(칸 없음) 빈 목록이다.
    optionProductIds,
    optionProductCount: optionProductIds.length,
    optionEditable: optionEligibility.eligible === true,
    currentMatchBasis: normalizeText(latestTrackingItem.matchBasis),
    currentMatchedOptionProductId: latestGroupOption
      ? (normalizeText(latestTrackingItem.matchedOptionProductId) || null)
      : null,
    currentMatchedOptionTitle: latestGroupOption
      ? (normalizeText(latestOptionGroup.matchedOptionTitle) || null)
      : null,
    currentOptionMallCheck: latestGroupOption ? (normalizeText(latestOptionGroup.mallCheck) || null) : null,
    currentOptionTitleCheck: latestGroupOption ? (normalizeText(latestOptionGroup.titleCheck) || null) : null,
    groupOptionSuggestionCount: Number(extras?.groupOptionSuggestionCount || 0),
    // N30 그룹상품 후보(2026-10-27 A안). groupMarkReady:false = 표시 칸을 읽지 못함(대표 SQL 전) — 화면은 표시 버튼을 숨긴다.
    // groupProduct = 표시했거나 옵션 번호가 있는 상품 기준 추적. 후보 목록은 관리자 세션 목록 응답에만 실린다.
    groupMarkReady: groupState.markReady,
    groupProductMarked: groupState.marked,
    groupProduct: groupState.groupProduct,
    // N30 옵션 확인일(2026-10-31 B6). optionCheckReady:false = 확인일 칸을 읽지 못함(대표 SQL 전) — 화면은 확인일 표시를 숨긴다.
    // 관리자 카드에서만 쓴다. 광고주 응답에는 확인일을 싣지 않는다(키·순서는 그대로 null·false — 관리자 전용 꼬리와 같은 기준).
    optionCheckedAt: extras?.optionSkipVisible === true ? optionCheckedAtIso(row.option_checked_at) : null,
    optionCheckReady: extras?.optionSkipVisible === true ? optionCheckedAtKnown(row.option_checked_at) : false,
    ...(Array.isArray(extras?.groupCandidates) ? { groupCandidates: extras.groupCandidates } : {}),
  }, extras?.optionSkipVisible === true);
}

function nonNegativeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

// 이미 로드된 스냅샷만 본다(추가 조회 없음). matched 스냅샷 가운데 가장 최신 checked_at.
function lastFoundAtFromSnapshots(snapshots = []) {
  let latest = null;
  let latestTime = -Infinity;
  for (const snapshot of snapshots || []) {
    if (!snapshot || snapshot.matched !== true) continue;
    const checkedAt = snapshot.checked_at || snapshot.checkedAt || null;
    const time = new Date(checkedAt || 0).getTime();
    if (!checkedAt || !Number.isFinite(time) || time <= latestTime) continue;
    latestTime = time;
    latest = checkedAt;
  }
  return latest;
}

// 2026-09-25: 목록 응답이 3.1 MB 까지 커졌다. 화면이 옛 기록에서 읽는 상품 정보는 원부/상품 기준 표시와
// 제목·몰·링크뿐이라, 가장 최신 기록만 전체 상품 정보를 싣고 나머지는 이 여섯 칸만 싣는다.
// 2026-10-23: 날짜 칸에 '옵션'을 표시하려고 그룹상품 판정 두 칸을 더한다(옵션 없는 행에는 없는 키).
const SNAPSHOT_COMPACT_ITEM_KEYS = [
  "trackingRankSource",
  "trackingRankSourceLabel",
  "title",
  "productId",
  "mallName",
  "link",
  "matchBasis",
  "matchedOptionProductId",
];

function compactSnapshotItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item || null;
  const compact = {};
  for (const key of SNAPSHOT_COMPACT_ITEM_KEYS) {
    if (item[key] !== undefined) compact[key] = item[key];
  }
  return compact;
}

// 그룹상품 후보(item.groupCandidates)는 화면 기록에 싣지 않는다 — 관리자 목록은 모아 둔 trackers[].groupCandidates 로만
// 받고, 광고주 화면 응답에는 후보가 전혀 없다. 후보가 없는 행은 같은 객체 그대로다.
function withoutGroupCandidates(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) || !Object.hasOwn(item, "groupCandidates")) return item;
  const { groupCandidates, ...rest } = item;
  return rest;
}

// 옵션 판정 건너뜀(2026-10-30) 표시는 관리자 진단용이다. 오류 이름·문구(item.optionGroup.errorName·errorMessage)는 어느
// 화면 응답에도 싣지 않고, 이유 코드(skipped)·옵션 개수는 옵션 편집 권한과 같은 경계(관리자·운영팀 세션)에만 싣는다.
// 광고주 응답에서는 건너뜀 표시 optionGroup 을 통째로 빼 변경 전과 같은 item 이다. 그 키가 없는 행은 같은 객체 그대로다.
// 창에 보였지만 순위에 못 쓴 번호(optionGroup.droppedVisibleCount·droppedVisible, 2026-10-30 추가)도 같은 경계다. 광고주
// 응답에서는 두 키를 빼고, 대표가 이긴 행에 남는 것이 옵션 개수뿐이면(변경 전에는 대표 결과 그대로였던 행) matchBasis·
// optionGroup 을 통째로 빼 변경 전과 같은 item 이다.
function optionSkipPayloadItem(item, visible = false) {
  const group = item && typeof item === "object" && !Array.isArray(item) ? item.optionGroup : null;
  if (!group || typeof group !== "object" || Array.isArray(group)) return item;
  if (!visible && !item.matchBasis && Object.hasOwn(group, "skipped")) {
    const { optionGroup, ...rest } = item;
    return rest;
  }
  if (!visible && (Object.hasOwn(group, "droppedVisibleCount") || Object.hasOwn(group, "droppedVisible"))) {
    const { droppedVisibleCount, droppedVisible, ...optionGroup } = group;
    if (item.matchBasis === "primary" && Object.keys(optionGroup).every((key) => key === "checkedOptionCount")) {
      const { matchBasis, optionGroup: dropped, ...rest } = item;
      return rest;
    }
    return { ...item, optionGroup };
  }
  if (!Object.hasOwn(group, "errorName") && !Object.hasOwn(group, "errorMessage")) return item;
  const { errorName, errorMessage, ...optionGroup } = group;
  return { ...item, optionGroup };
}

function optionTraceMessage(message, visible = false) {
  return visible ? message : withoutAdminGroupTails(message);
}

function optionTraceLastMessage(payload, visible = false) {
  if (visible) return payload;
  const lastMessage = withoutAdminGroupTails(payload.lastMessage);
  return lastMessage === payload.lastMessage ? payload : { ...payload, lastMessage };
}

function optionSkipExtras(request, access) {
  return { optionSkipVisible: !optionEditForbidden(request, access) };
}

function snapshotPayload(row, trackerProductId = "", options = {}) {
  const item = optionSkipPayloadItem(
    withoutGroupCandidates(displayProductRankItem(row.item, trackerProductId)),
    options.optionSkipVisible === true,
  );
  return {
    id: row.id,
    trackerId: row.tracker_id,
    checkedAt: row.checked_at,
    rank: row.rank,
    page: row.page,
    position: row.position,
    matched: row.matched,
    checkedCount: row.checked_count,
    total: row.total,
    item: options.compactItem === true ? compactSnapshotItem(item) : item,
    message: optionTraceMessage(row.message, options.optionSkipVisible === true),
    source: row.source,
    createdAt: row.created_at,
  };
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function kstSlotToUtc(kstBase, hour) {
  return new Date(Date.UTC(
    kstBase.getUTCFullYear(),
    kstBase.getUTCMonth(),
    kstBase.getUTCDate(),
    hour - 9,
    0,
    0,
    0
  ));
}

export function nextRankCheckAt(date = new Date()) {
  const kstBase = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const after = new Date(date.getTime() + 60 * 1000);
  const slots = [
    kstSlotToUtc(kstBase, 9),
    kstSlotToUtc(kstBase, 15),
    kstSlotToUtc(new Date(kstBase.getTime() + 24 * 60 * 60 * 1000), 9),
  ];
  return slots.find((slot) => slot > after).toISOString();
}

async function findClientId(ctx, agencyCode) {
  if (!agencyCode) return null;
  for (const code of agencyCodeScope(agencyCode)) {
    let result = await ctx.supabaseAdmin
      .from("clients")
      .select("id, status, disconnected_at")
      .eq("agency_code", code)
      .eq("status", "active")
      .maybeSingle();

    if (result.error && /disconnected_at|schema cache/i.test(result.error.message || "")) {
      result = await ctx.supabaseAdmin
        .from("clients")
        .select("id, status")
        .eq("agency_code", code)
        .eq("status", "active")
        .maybeSingle();
    }

    if (!result.error && result.data?.id && result.data.status === "active" && !result.data.disconnected_at) {
      return result.data.id;
    }
  }
  return null;
}

// 총관리자가 소유한 운영팀 코드인지 확인한다. 상태(active/revoked)는 보지 않는다 —
// 권한이 해제된 팀의 코드로 등록돼 아무도 못 보는 추적기야말로 열어야 할 대상이다.
async function isOwnerOperationTeamCode(ctx, agencyCode) {
  const code = canonicalAgencyCode(agencyCode);
  if (!code) return false;
  const { data, error } = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("id")
    .eq("team_code", code)
    .eq("owner_agency_code", primaryAgencyCode())
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data && data.id);
}

async function requireRankAccess(request, ctx, body = {}, options = {}) {
  const agencyCode = requestAgencyCode(request, body);
  if (!agencyCode) {
    return {
      ok: false,
      response: json(request, { ok: false, message: "대행사 코드가 필요합니다." }, 401),
    };
  }

  const adminAuthorized = adminCodeAuthorized(request, body);
  if (adminAuthorized && isPrimaryAgencyCode(agencyCode)) {
    return { ok: true, agencyCode, clientId: null, admin: true, owner: true };
  }

  if (trustedTeamAccountRankScope(request, agencyCode)) {
    if (!rankAccessAuthorized(request, body, agencyCode)) {
      return {
        ok: false,
        response: json(request, { ok: false, message: "운영팀 순위 추적 권한을 확인할 수 없습니다." }, 401),
      };
    }
    return { ok: true, agencyCode, clientId: null, admin: false, teamAccount: true };
  }

  const clientId = await findClientId(ctx, agencyCode);
  if (!clientId) {
    // F17: 운영팀이 광고주 연결 전에 팀코드로 등록한 추적기는 연결 후 그 팀 화면에서
    // 사라지고 총관리자도 못 보는데 수집은 계속된다. 총관리자 코드를 가진 요청에
    // 한해 그 팀코드 범위를 열어 조회·중지할 수 있게 한다(광고주 코드가 아니므로
    // clientId 는 없고, 아래 광고주 접속 코드 경로는 그대로 닫혀 있다).
    if (adminAuthorized && await isOwnerOperationTeamCode(ctx, agencyCode)) {
      return { ok: true, agencyCode, clientId: null, admin: true, teamCodeScope: true };
    }
    return {
      ok: false,
      response: json(request, { ok: false, message: "등록된 대행사 코드를 확인할 수 없습니다." }, 403),
    };
  }

  if (adminAuthorized) {
    return { ok: true, agencyCode, clientId, admin: true };
  }

  const accessCode = canonicalAgencyCode(requestAccessCode(request, body));
  const accessAllowed = rankAccessAuthorized(request, body, agencyCode) ||
    (isLocalRequest(request) && safeEqual(accessCode, agencyCode));
  if (!accessAllowed) {
    return {
      ok: false,
      response: json(request, {
        ok: false,
        message: options.read ? "순위 추적 조회 권한을 확인할 수 없습니다." : "순위 추적 변경 권한을 확인할 수 없습니다.",
      }, 401),
    };
  }

  return { ok: true, agencyCode, clientId, admin: false };
}

async function loadSnapshotBatch(ctx, trackerIds, perTrackerLimit, checkedAfter, checkedBefore) {
  const grouped = new Map();
  const seenSnapshotIds = new Set();
  const remainingTrackerIds = new Set(trackerIds);
  let cursor = null;

  for (let page = 0; page < SNAPSHOT_QUERY_MAX_PAGES; page += 1) {
    let query = ctx.supabaseAdmin
      .from("naver_rank_snapshots")
      .select(SNAPSHOT_LIST_SELECT)
      .in("tracker_id", Array.from(remainingTrackerIds))
      .gte("checked_at", checkedAfter)
      .lte("checked_at", checkedBefore)
      .order("checked_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SNAPSHOT_QUERY_PAGE_SIZE);

    if (cursor) {
      query = query.or(
        `checked_at.lt.${cursor.checkedAt},and(checked_at.eq.${cursor.checkedAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;

    if (error) throw error;
    const rows = data || [];
    if (rows.length === 0) return grouped;

    let previousKey = cursor;
    for (const row of rows) {
      if (!row?.id || !row?.tracker_id) throw new Error("rank_snapshot_identity_missing");
      const rowKey = snapshotPaginationKey(row, "rank_snapshot");
      if (previousKey && previousKey.checkedAt === rowKey.checkedAt && previousKey.id === rowKey.id) {
        throw new Error("rank_snapshot_pagination_stalled");
      }
      if (previousKey && !snapshotKeyIsAfter(previousKey, rowKey)) {
        throw new Error("rank_snapshot_pagination_order_invalid");
      }
      if (seenSnapshotIds.has(row.id)) throw new Error("rank_snapshot_pagination_duplicate");
      seenSnapshotIds.add(row.id);
      previousKey = rowKey;
      const trackerSnapshots = grouped.get(row.tracker_id) || [];
      if (trackerSnapshots.length < perTrackerLimit) {
        trackerSnapshots.push(row);
        grouped.set(row.tracker_id, trackerSnapshots);
        if (trackerSnapshots.length >= perTrackerLimit) remainingTrackerIds.delete(row.tracker_id);
      }
    }

    if (remainingTrackerIds.size === 0) return grouped;
    const nextCursor = snapshotPaginationKey(rows.at(-1), "rank_snapshot");
    if (cursor && cursor.checkedAt === nextCursor.checkedAt && cursor.id === nextCursor.id) {
      throw new Error("rank_snapshot_pagination_stalled");
    }
    cursor = nextCursor;
  }

  throw new Error("rank_snapshot_pagination_limit_exceeded");
}

function snapshotPaginationKey(row, errorPrefix) {
  const checkedAt = String(row?.checked_at || "");
  const id = String(row?.id || "");
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs) || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
    throw new Error(`${errorPrefix}_pagination_cursor_invalid`);
  }
  return { checkedAt, checkedAtMicros: timestampMicros(checkedAt, checkedAtMs), id };
}

function timestampMicros(value, parsedMs) {
  const fraction = String(value).match(/\.(\d+)(?=Z$|[+-]\d{2}:?\d{2}$)/u)?.[1] || "";
  const subMillisecondMicros = Number(`${fraction}000000`.slice(3, 6) || 0);
  return BigInt(Math.trunc(parsedMs)) * 1000n + BigInt(subMillisecondMicros);
}

// Rows are ordered checked_at DESC, id DESC. A next row must therefore have a
// strictly smaller tuple than the previous row/cursor.
function snapshotKeyIsAfter(previous, next) {
  if (next.checkedAtMicros < previous.checkedAtMicros) return true;
  if (next.checkedAtMicros > previous.checkedAtMicros) return false;
  return next.id < previous.id;
}

export async function loadSnapshots(ctx, trackerIds, requestedLimit = PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS) {
  const ids = Array.from(new Set((trackerIds || []).filter(Boolean)));
  if (!ids.length) return new Map();
  const numericLimit = Number(requestedLimit);
  const perTrackerLimit = Math.max(1, Math.min(
    PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS,
    Number.isFinite(numericLimit) ? Math.floor(numericLimit) : PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS,
  ));
  const snapshotWindowEnd = Date.now();
  const checkedBefore = new Date(snapshotWindowEnd).toISOString();
  const checkedAfter = new Date(snapshotWindowEnd - PRODUCT_RANK_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const batches = [];
  for (let index = 0; index < ids.length; index += SNAPSHOT_TRACKER_BATCH_SIZE) {
    batches.push(ids.slice(index, index + SNAPSHOT_TRACKER_BATCH_SIZE));
  }

  const batchResults = new Array(batches.length);
  let nextBatchIndex = 0;
  const workers = Array.from({ length: Math.min(SNAPSHOT_QUERY_CONCURRENCY, batches.length) }, async () => {
    while (nextBatchIndex < batches.length) {
      const batchIndex = nextBatchIndex;
      nextBatchIndex += 1;
      batchResults[batchIndex] = await loadSnapshotBatch(
        ctx,
        batches[batchIndex],
        perTrackerLimit,
        checkedAfter,
        checkedBefore,
      );
    }
  });
  await Promise.all(workers);

  const grouped = new Map();
  batchResults.forEach((batch) => {
    batch.forEach((rows, trackerId) => grouped.set(trackerId, rows));
  });
  return grouped;
}

// 그룹 이름과 N30 그룹상품 번호(option_product_ids)를 한 번에 읽는다. 옵션 칸이 아직 없으면
// (대표 SQL 전·되돌리기 SQL 뒤·칸 없음 10분 기억 중) 옛 조회로 한 번 더 읽고 옵션은 null(=모름)이다.
// 빈 목록([])으로 바꾸지 않는다 — '모름'과 '비어 있음'을 섞지 않기 위해서다(반박 검토 2026-10-23).
// 옵션 칸 검사를 그룹 칸 검사보다 먼저 한다 — isMissingRankGroupColumn 은 "does not exist" 를 넓게
// 잡아 그룹 이름까지 잃는다.
async function loadTrackerGroups(ctx, trackerIds) {
  const ids = Array.from(new Set((trackerIds || []).filter(Boolean)));
  if (!ids.length) return new Map();

  const query = (columns) => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(columns)
    .in("id", ids);
  const skipOptions = optionColumnRecentlyMissing();
  let optionColumnReady = !skipOptions;
  // 그룹상품 표시 칸(2026-10-27)은 옵션 칸이 있을 때만 함께 읽는다. 표시 칸 검사를 옵션·그룹 칸 검사보다 먼저 한다 —
  // isMissingRankGroupColumn 은 "does not exist" 를 넓게 잡아 그룹 이름까지 잃는다.
  let markColumnReady = optionColumnReady && !groupMarkColumnRecentlyMissing();
  // 옵션 확인일 칸(2026-10-31 B6)은 표시 칸을 읽을 때 함께 읽는다. 확인일 칸 검사를 표시·옵션·그룹 칸 검사보다 먼저 하고,
  // 칸이 없으면 그 칸만 빼고 다시 읽는다(표시 칸은 그대로 읽는다).
  let checkedColumnReady = markColumnReady && !optionCheckedColumnRecentlyMissing();
  const markColumns = () => (checkedColumnReady
    ? "id, group_name, option_product_ids, group_product_marked, option_checked_at"
    : "id, group_name, option_product_ids, group_product_marked");
  let columns = "id, group_name";
  if (optionColumnReady) columns = markColumnReady ? markColumns() : "id, group_name, option_product_ids";
  let { data, error } = await query(columns);
  if (error && checkedColumnReady && isOptionCheckedColumnMissingError(error)) {
    rememberOptionCheckedColumnMissing("rank-tracker-groups");
    checkedColumnReady = false;
    ({ data, error } = await query(markColumns()));
  }
  if (error && markColumnReady && isGroupMarkColumnMissingError(error)) {
    rememberGroupMarkColumnMissing("rank-tracker-groups");
    markColumnReady = false;
    checkedColumnReady = false;
    ({ data, error } = await query("id, group_name, option_product_ids"));
  }
  if (error && optionColumnReady && isOptionColumnMissingError(error)) {
    rememberOptionColumnMissing("rank-tracker-groups");
    optionColumnReady = false;
    markColumnReady = false;
    checkedColumnReady = false;
    ({ data, error } = await query("id, group_name"));
  }

  if (error) {
    if (isMissingRankGroupColumn(error)) return new Map();
    throw error;
  }

  const groups = new Map();
  (data || []).forEach((row) => {
    groups.set(row.id, {
      groupName: normalizeRankGroupName(row.group_name),
      optionProductIds: optionColumnReady && Array.isArray(row.option_product_ids)
        ? row.option_product_ids.map((id) => String(id))
        : null,
      groupProductMarked: markColumnReady && typeof row.group_product_marked === "boolean"
        ? row.group_product_marked
        : null,
      // 확인일: 칸을 읽었으면 문자열 또는 null(기록 없음), 못 읽었으면 undefined(모름).
      optionCheckedAt: checkedColumnReady
        ? (typeof row.option_checked_at === "string" ? row.option_checked_at : null)
        : undefined,
    });
  });
  return groups;
}

async function attachTrackerGroups(ctx, rows) {
  const sourceRows = rows || [];
  if (!sourceRows.length) return sourceRows;
  const groups = await loadTrackerGroups(ctx, sourceRows.map((row) => row.id));
  return sourceRows.map((row) => {
    const details = groups.get(row.id);
    return {
      ...row,
      group_name: details?.groupName || normalizeRankGroupName(row.group_name),
      // 칸을 못 읽었으면 null(모름) 그대로. 이 행은 화면 응답용이고 DB 에 다시 쓰지 않는다.
      option_product_ids: Array.isArray(row.option_product_ids)
        ? row.option_product_ids
        : (Array.isArray(details?.optionProductIds) ? details.optionProductIds : null),
      // 그룹상품 표시: 못 읽었으면 null(모름 — 화면은 표시 버튼을 숨긴다).
      group_product_marked: typeof row.group_product_marked === "boolean"
        ? row.group_product_marked
        : (typeof details?.groupProductMarked === "boolean" ? details.groupProductMarked : null),
      // 옵션 확인일: 못 읽었으면 undefined(모름 — 화면은 확인일 표시를 숨긴다). null 은 '기록 없음'이라 모름과 섞지 않는다.
      option_checked_at: optionCheckedAtKnown(row.option_checked_at)
        ? row.option_checked_at
        : (optionCheckedAtKnown(details?.optionCheckedAt) ? details.optionCheckedAt : undefined),
    };
  });
}

async function attachTrackerGroup(ctx, row) {
  if (!row) return row;
  const rows = await attachTrackerGroups(ctx, [row]);
  return rows[0] || row;
}

async function updateTrackerGroupName(ctx, trackerId, agencyCode, groupName) {
  const normalizedGroupName = normalizeRankGroupName(groupName);
  const { error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({ group_name: normalizedGroupName })
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode));

  if (error) {
    if (isMissingRankGroupColumn(error)) return { ok: false, missingColumn: true };
    throw error;
  }
  return { ok: true, groupName: normalizedGroupName };
}

export async function loadShoppingWorkerStatus(ctx, now = Date.now()) {
  try {
    let { data, error } = await ctx.supabaseAdmin
      .from("naver_shopping_worker_coordination")
      .select("lane_key, circuit_state, primary_seen_at, lease_until, cooldown_until, last_block_code, updated_at")
      .eq("lane_key", "global")
      .maybeSingle();
    if (error && /circuit_state|schema cache|does not exist/i.test(error.message || "")) {
      ({ data, error } = await ctx.supabaseAdmin
        .from("naver_shopping_worker_coordination")
        .select("lane_key, primary_seen_at, lease_until, cooldown_until, last_block_code, updated_at")
        .eq("lane_key", "global")
        .maybeSingle());
    }
    if (error || !data) return { state: "unknown" };

    const currentTime = Number(now) || Date.now();
    const cooldownTime = Date.parse(data.cooldown_until || "");
    const leaseTime = Date.parse(data.lease_until || "");
    const primarySeenTime = Date.parse(data.primary_seen_at || "");
    const circuitState = SHOPPING_WORKER_CIRCUIT_STATES.has(normalizeText(data.circuit_state).toLowerCase())
      ? normalizeText(data.circuit_state).toLowerCase()
      : "closed";
    const blockCode = SHOPPING_WORKER_BLOCK_CODES.has(normalizeText(data.last_block_code).toLowerCase())
      ? normalizeText(data.last_block_code).toLowerCase()
      : "";

    if (circuitState === "open") {
      return { state: "stopped", preservesLastGood: true };
    }
    if (Number.isFinite(cooldownTime) && cooldownTime > currentTime) {
      return {
        state: "cooldown",
        retryAt: new Date(cooldownTime).toISOString(),
        blockCode,
        preservesLastGood: true,
      };
    }
    if (circuitState === "half_open") {
      return { state: "verification", preservesLastGood: true };
    }
    if (Number.isFinite(leaseTime) && leaseTime > currentTime) {
      return { state: "running", preservesLastGood: true };
    }
    if (Number.isFinite(primarySeenTime) && primarySeenTime > currentTime - 5 * 60_000) {
      return { state: "ready", preservesLastGood: true };
    }
    return { state: "standby", preservesLastGood: true };
  } catch {
    return { state: "unknown" };
  }
}

export async function loadShoppingWorkerOperations(ctx, now = Date.now()) {
  const currentTime = Number(now) || Date.now();
  try {
    const { data, error } = await ctx.supabaseAdmin.rpc("mi_get_naver_shopping_worker_operations");
    if (error) throw error;
    const source = normalizeWorkerRpcObject(data);
    const circuitStateValue = normalizeWorkerText(workerValue(source, "circuit_state", "circuitState"), 20).toLowerCase();
    const circuitState = SHOPPING_WORKER_CIRCUIT_STATES.has(circuitStateValue) ? circuitStateValue : "closed";
    const primarySeenAt = normalizeWorkerIso(workerValue(source, "primary_seen_at", "primarySeenAt"));
    const leaseUntil = normalizeWorkerIso(workerValue(source, "lease_until", "leaseUntil"));
    const cooldownUntil = normalizeWorkerIso(workerValue(source, "cooldown_until", "cooldownUntil"));
    const oldestPendingAt = normalizeWorkerIso(workerValue(source, "oldest_pending_at", "oldestPendingAt"));
    const jobStartedAt = normalizeWorkerIso(workerValue(source, "current_job_started_at", "currentJobStartedAt"));
    const stabilityStartedAt = normalizeWorkerIso(workerValue(source, "stability_started_at", "stabilityStartedAt"));
    const primarySeenTime = Date.parse(primarySeenAt || "");
    const leaseTime = Date.parse(leaseUntil || "");
    const cooldownTime = Date.parse(cooldownUntil || "");
    const oldestPendingTime = Date.parse(oldestPendingAt || "");
    const jobStartedTime = Date.parse(jobStartedAt || "");
    const stabilityStartedTime = Date.parse(stabilityStartedAt || "");
    const runtimeVersion = normalizeWorkerText(workerValue(source, "runtime_version", "runtimeVersion"), 40);
    const runtimeFingerprint = normalizeWorkerText(workerValue(source, "runtime_fingerprint", "runtimeFingerprint"), 160);
    const lastCheckedCount = normalizeWorkerInteger(workerValue(source, "last_checked_count", "lastCheckedCount"));
    const lastSource = normalizeWorkerText(workerValue(source, "last_source", "lastSource"), 100);
    const successStreak = normalizeWorkerInteger(workerValue(source, "success_streak", "successStreak"));
    const stableForMs = Number.isFinite(stabilityStartedTime) ? Math.max(0, currentTime - stabilityStartedTime) : 0;
    const rawCandidateEligible = workerValue(source, "candidate_eligible", "candidateEligible");
    const databaseCandidateEligible = rawCandidateEligible === true;
    const runtimeReleaseReady = runtimeVersion === SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION
      && /^[a-f0-9]{64}$/u.test(runtimeFingerprint)
      && runtimeFingerprint !== "0".repeat(64);
    const candidateEligible = databaseCandidateEligible && runtimeReleaseReady && lastCheckedCount === 300
      && lastSource === "naver_shopping_results_collector";
    const canaryTrackerId = normalizeWorkerText(workerValue(source, "canary_tracker_id", "canaryTrackerId"), 64);
    const activeLease = Number.isFinite(leaseTime) && leaseTime > currentTime;
    const activeCooldown = Number.isFinite(cooldownTime) && cooldownTime > currentTime;
    const cadenceModeValue = normalizeWorkerText(workerValue(source, "cadence_mode", "cadenceMode"), 20).toLowerCase();
    const cadenceMode = cadenceModeValue === "candidate" ? "candidate" : "baseline";
    const failureStreak = normalizeWorkerInteger(workerValue(source, "failure_streak", "failureStreak"));
    const alerts = [];

    if (circuitState === "open") {
      alerts.push({ code: "circuit_open", severity: "error", message: "자동 수집 회로가 정지되어 마지막 정상 순위를 보존 중입니다." });
    }
    if (!primarySeenAt) {
      alerts.push({ code: "primary_heartbeat_missing", severity: "warning", message: "Windows 주 작업기의 실행 신호가 아직 없습니다." });
    } else if (Number.isFinite(primarySeenTime) && primarySeenTime < currentTime - 5 * 60_000) {
      alerts.push({ code: "primary_heartbeat_stale", severity: "warning", message: "Windows 주 작업기의 최근 신호가 5분을 넘었습니다." });
    }
    if (normalizeWorkerText(workerValue(source, "lease_worker_id", "leaseWorkerId"), 120)
      && Number.isFinite(leaseTime) && leaseTime <= currentTime) {
      alerts.push({ code: "lease_expired", severity: "warning", message: "만료된 작업 레인이 남아 있어 다음 실행에서 회수해야 합니다." });
    }
    if (Number.isFinite(oldestPendingTime) && oldestPendingTime < currentTime - 15 * 60_000) {
      alerts.push({ code: "queue_delayed", severity: "warning", message: "가장 오래된 대기 작업이 15분을 넘었습니다." });
    }
    if (failureStreak >= 2) {
      alerts.push({ code: "repeated_failure", severity: "error", message: "동일 유형 실패가 2회 연속 확인되었습니다." });
    }
    if (runtimeVersion && runtimeVersion !== SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION) {
      alerts.push({ code: "runtime_mismatch", severity: "error", message: "실행 버전이 현재 배포 버전과 일치하지 않습니다." });
    }
    if (Number.isFinite(jobStartedTime) && jobStartedTime < currentTime - 15 * 60_000 && activeLease) {
      alerts.push({ code: "job_runtime_exceeded", severity: "warning", message: "현재 작업 시간이 15분을 넘었습니다." });
    }

    return {
      available: true,
      circuit: {
        state: circuitState,
        reason: normalizeWorkerText(workerValue(source, "circuit_reason", "circuitReason"), 160),
        openedAt: normalizeWorkerIso(workerValue(source, "circuit_opened_at", "circuitOpenedAt")),
        failureSignature: normalizeWorkerText(workerValue(source, "failure_signature", "failureSignature"), 120),
        failureStreak,
        probeTrackerId: normalizeWorkerText(workerValue(source, "probe_tracker_id", "probeTrackerId"), 64),
        probeStartedAt: normalizeWorkerIso(workerValue(source, "probe_started_at", "probeStartedAt")),
      },
      lane: {
        primaryWorkerId: normalizeWorkerText(workerValue(source, "primary_worker_id", "primaryWorkerId"), 120),
        primarySeenAt,
        leaseWorkerId: normalizeWorkerText(workerValue(source, "lease_worker_id", "leaseWorkerId"), 120),
        leaseUntil,
        cooldownUntil,
        lastBlockCode: normalizeWorkerText(workerValue(source, "last_block_code", "lastBlockCode"), 80),
      },
      queue: {
        pendingCount: normalizeWorkerInteger(workerValue(source, "pending_count", "pendingCount")),
        lookupPendingCount: normalizeWorkerInteger(workerValue(source, "lookup_pending_count", "lookupPendingCount")),
        trackerPendingCount: normalizeWorkerInteger(workerValue(source, "tracker_pending_count", "trackerPendingCount")),
        processingCount: normalizeWorkerInteger(workerValue(source, "processing_count", "processingCount")),
        oldestPendingAt,
      },
      progress: {
        stage: normalizeWorkerText(workerValue(source, "current_stage", "currentStage"), 80),
        page: Math.min(SHOPPING_WORKER_TOTAL_PAGES, normalizeWorkerInteger(workerValue(source, "current_page", "currentPage"))),
        totalPages: SHOPPING_WORKER_TOTAL_PAGES,
        jobKind: normalizeWorkerText(workerValue(source, "current_job_kind", "currentJobKind"), 40),
        trackerId: normalizeWorkerText(workerValue(source, "current_tracker_id", "currentTrackerId"), 64),
        jobStartedAt,
      },
      runtime: {
        version: runtimeVersion,
        expectedVersion: SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION,
        versionMatches: Boolean(runtimeVersion && runtimeVersion === SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION),
        fingerprint: runtimeFingerprint,
        runId: normalizeWorkerText(workerValue(source, "run_id", "runId"), 80),
      },
      lastSuccess: {
        at: normalizeWorkerIso(workerValue(source, "last_success_at", "lastSuccessAt")),
        collectionId: normalizeWorkerText(workerValue(source, "last_collection_id", "lastCollectionId"), 100),
        checkedCount: lastCheckedCount,
        excludedAdCount: normalizeWorkerInteger(workerValue(source, "last_excluded_ad_count", "lastExcludedAdCount")),
        durationMs: normalizeWorkerInteger(workerValue(source, "last_duration_ms", "lastDurationMs")),
        source: lastSource,
      },
      lastFailure: {
        at: normalizeWorkerIso(workerValue(source, "last_failure_at", "lastFailureAt")),
        code: normalizeWorkerText(workerValue(source, "last_failure_code", "lastFailureCode"), 100),
      },
      scheduler: {
        urgentStreak: normalizeWorkerInteger(workerValue(source, "scheduler_urgent_streak", "schedulerUrgentStreak")),
        lastAgencyCode: normalizeWorkerText(workerValue(source, "scheduler_last_agency_code", "schedulerLastAgencyCode"), 80),
      },
      cadence: {
        mode: cadenceMode,
        minutes: Math.max(1, normalizeWorkerInteger(workerValue(source, "cadence_minutes", "cadenceMinutes"), 10)),
        stabilityStartedAt,
        stableHours: Math.floor(stableForMs / 3_600_000),
        successStreak,
        candidateEligible,
      },
      controls: {
        canStop: circuitState !== "open" || normalizeWorkerText(workerValue(source, "circuit_reason", "circuitReason")) !== "manual_stop",
        canRunCanary: circuitState !== "half_open" && !activeLease && !activeCooldown && Boolean(canaryTrackerId),
        // Candidate activation is intentionally reserved for the audited
        // serializable transition generator. The owner API only exposes the
        // baseline rollback path and must never become a second dispatcher.
        canActivateCandidate: false,
        canReturnBaseline: cadenceMode !== "baseline",
        canaryTrackerId,
      },
      alerts,
    };
  } catch {
    return {
      available: false,
      alerts: [{ code: "operations_unavailable", severity: "warning", message: "운영 제어 상태를 불러오지 못했습니다." }],
      controls: {
        canStop: false,
        canRunCanary: false,
        canActivateCandidate: false,
        canReturnBaseline: false,
        canaryTrackerId: "",
      },
    };
  }
}

// 목록 상세(그룹·스냅샷·검색량·워커 상태·운영 정보)는 서로 독립이라 동시에 읽는다.
// 2026-09-13 이전에는 다섯 단계를 차례로 기다려(검색량 예산 8초 포함) 느린 날 목록이 브라우저
// 제한을 넘겼다. 검색량은 목록 응답을 붙잡지 않도록 짧은 예산만 쓰고, 예산 뒤 도착한 값은
// 캐시에 남아 다음 조회에서 즉시 나온다(loadKeywordVolumes 참조).
export async function loadTrackerListDetails(ctx, queriedRows, options = {}) {
  const ids = queriedRows.map((row) => row.id);
  const [rows, snapshots, keywordVolumes, workerStatus, workerOperations] = await Promise.all([
    rankTrackerListRead("groups", () => attachTrackerGroups(ctx, queriedRows)),
    rankTrackerListRead("snapshots", () => loadSnapshots(ctx, ids)),
    rankTrackerListRead("keyword-volumes", () => loadKeywordVolumes(queriedRows.map((row) => row.keyword), {
      budgetMs: options.keywordVolumeBudgetMs ?? TRACKER_LIST_KEYWORD_VOLUME_BUDGET_MS,
    })),
    rankTrackerListRead("worker-status", () => loadShoppingWorkerStatus(ctx)),
    options.owner === true
      ? rankTrackerListRead("worker-operations", () => loadShoppingWorkerOperations(ctx))
      : Promise.resolve(null),
  ]);
  return { rows, snapshots, keywordVolumes, workerStatus, workerOperations };
}

async function rankTrackerListRead(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === "object" && !error.rankTrackerReadStage) {
      try {
        Object.defineProperty(error, "rankTrackerReadStage", {
          value: stage,
          configurable: true,
        });
      } catch {
        // Frozen third-party errors still propagate through the same safe path.
      }
    }
    throw error;
  }
}

// 2026-09-25: 목록은 검색량을 짧게만 기다려 남은 키워드가 "조회 중"으로 남았다. 화면은 목록을 그린 뒤
// 이 가벼운 조회(추적 id·키워드만 읽음)로 검색량만 다시 받아 그 자리의 표시를 바꾼다.
export function keywordVolumeViewPayload(rows, keywordVolumes) {
  const volumes = {};
  for (const row of rows || []) {
    if (!row?.id) continue;
    const volume = keywordVolumes.get(normalizeKeywordCompare(row.keyword));
    volumes[row.id] = {
      keywordVolume: volume?.value ?? null,
      keywordVolumeLabel: volume?.label || KEYWORD_VOLUME_PENDING.label,
      keywordVolumeStatus: volume?.status || KEYWORD_VOLUME_PENDING.status,
    };
  }
  return volumes;
}

async function listKeywordVolumes(request, ctx, access) {
  const agencyCode = access.agencyCode;
  const { data, error } = await rankTrackerListRead("trackers", () => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id, keyword")
    .in("agency_code", agencyCodeScope(agencyCode))
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(TRACKER_LIST_MAX));
  if (error) throw rankTrackerReadError(error, "trackers");
  const rows = data || [];
  const keywordVolumes = await rankTrackerListRead("keyword-volumes", () => loadKeywordVolumes(
    rows.map((row) => row.keyword),
    { budgetMs: KEYWORD_VOLUME_TIME_BUDGET_MS },
  ));
  return json(request, {
    ok: true,
    scopeKey: normalizeAgencyCode(agencyCode),
    volumes: keywordVolumeViewPayload(rows, keywordVolumes),
  });
}

async function listTrackers(request, ctx) {
  const listStartedAt = Date.now();
  const access = await rankTrackerListRead("access", () => requireRankAccess(request, ctx, {}, { read: true }));
  const accessMs = Date.now() - listStartedAt;
  if (!access.ok) return access.response;
  if (new URL(request.url).searchParams.get("view") === "keyword-volumes") {
    return listKeywordVolumes(request, ctx, access);
  }
  const agencyCode = access.agencyCode;

  const trackersQueryStartedAt = Date.now();
  const { data, error, count } = await rankTrackerListRead("trackers", () => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT, { count: "exact" })
    .in("agency_code", agencyCodeScope(agencyCode))
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(TRACKER_LIST_QUERY_LIMIT));

  const trackersQueryMs = Date.now() - trackersQueryStartedAt;
  if (error) throw rankTrackerReadError(error, "trackers");
  if (!Number.isSafeInteger(count) || count < 0) {
    throw rankTrackerReadError(new Error("rank_tracker_count_unavailable"), "trackers");
  }

  const queriedRows = data || [];
  const hasMore = count > TRACKER_LIST_MAX || queriedRows.length > TRACKER_LIST_MAX;
  const detailStartedAt = Date.now();
  const { rows, snapshots, keywordVolumes, workerStatus, workerOperations } = await rankTrackerListRead("details", () => loadTrackerListDetails(
    ctx,
    queriedRows.slice(0, TRACKER_LIST_MAX),
    { owner: access.owner === true },
  ));
  const rankSource = shoppingRankSourceStatus(shoppingRankConfig());
  // N30 그룹상품: 같은 그룹 다른 추적에만 있는 번호 개수(카드 '가져오기' 알림). 읽은 행만 쓴다.
  const groupOptionSuggestions = groupOptionSuggestionCounts(rows);
  // N30 그룹상품 후보(2026-10-27 A안): 관리자 세션(총관리자·운영팀·관리자 코드)만. 이미 읽은 행·30일 기록만 쓴다(추가 조회 0).
  const groupCandidates = optionEditForbidden(request, access) ? null : groupCandidateSummaries(rows, snapshots);
  const totalMs = Date.now() - listStartedAt;
  if (totalMs >= TRACKER_LIST_SLOW_LOG_MS) {
    // 2026-09-13: 목록 요청이 브라우저 제한(30초)에 걸리는 원인을 Vercel 로그에서 단계별로 읽기 위한 한 줄.
    console.warn(JSON.stringify({
      level: "warn",
      event: "naver_rank_trackers_list_slow",
      requestId: rankTrackersRequestId(request),
      scope: normalizeAgencyCode(agencyCode),
      trackers: rows.length,
      accessMs: accessMs,
      trackersMs: trackersQueryMs,
      detailsMs: Date.now() - detailStartedAt,
      totalMs,
    }));
  }
  return json(request, {
    ok: true,
    ...rankSource,
    scopeKey: normalizeAgencyCode(agencyCode),
    scopeAgencyCode: normalizeAgencyCode(agencyCode),
    scopeClientId: String(access.clientId || ""),
    scopeMode: access.teamAccount ? "team-account" : (access.owner ? "owner" : "advertiser"),
    returnedCount: rows.length,
    totalCount: count,
    hasMore,
    complete: !hasMore && rows.length === count,
    workerStatus,
    ...(access.owner ? { workerOperations } : {}),
    trackers: rows.map((row) => trackerPayload(
      row,
      snapshots.get(row.id) || [],
      keywordVolumes.get(normalizeKeywordCompare(row.keyword)),
      {
        groupOptionSuggestionCount: groupOptionSuggestions.get(row.id) || 0,
        ...optionSkipExtras(request, access),
        // 그룹상품 추적에만 싣는다(그 밖 추적은 예전 응답 그대로).
        ...(groupCandidates?.has(row.id) ? { groupCandidates: groupCandidates.get(row.id) } : {}),
      },
    )),
  });
}

export function buildProductRankSnapshotRecord(tracker, checkedAt, result, message) {
  const source = normalizeText(result?.source) || "naver_shopping_results_collector";
  const crossPageProofVersion = normalizeText(result?.crossPageProofVersion);
  const finiteWindowProofVersion = normalizeText(result?.finiteWindowProofVersion);
  const renderedOrderProofVersion = normalizeText(result?.renderedOrderProofVersion);
  const safeResultItem = isOrganicTrackingItem(result?.item) ? result.item : {};
  const item = {
    ...safeResultItem,
    rankPolicy: "organic_only",
    adExcluded: true,
    source,
    rankEvidence: normalizeText(result?.rankEvidence) || "naver_shopping_organic_list",
    collectionId: normalizeText(result?.collectionId) || null,
    collectedAt: normalizeText(result?.collectedAt) || null,
    excludedAdCount: Number(result?.excludedAdCount || 0),
    ...(crossPageProofVersion === "stable-full-window-v1" ? { crossPageProofVersion } : {}),
    ...(renderedOrderProofVersion === "stable-rendered-order-v1" ? {
      renderedOrderProofVersion,
    } : {}),
    ...(finiteWindowProofVersion === "stable-finite-window-v1" ? {
      finiteWindowProofVersion,
      sourceExhausted: result?.sourceExhausted === true,
      finiteMarketTotal: Number(result?.total || 0),
      atomicSuccessEligible: false,
    } : {}),
    ...(result?.trackingRankSource ? {
      trackingRankSource: result.trackingRankSource,
      trackingRankSourceLabel: result.trackingRankSourceLabel,
      exactProductRank: result.exactProductRank || null,
      relatedCatalogRank: result.relatedCatalogRank || null,
      relatedCatalogProductId: result.relatedCatalogProductId || null,
      relatedCatalogTitle: result.relatedCatalogTitle || null,
      relatedCatalogRelationBasis: result.relatedCatalogRelationBasis || null,
      exactProductType: result.exactProductType || null,
      exactProductKind: result.exactProductKind || null,
      rankSelectionBasis: result.rankSelectionBasis,
    } : {}),
    // N30 그룹상품(2026-10-23): 옵션 판정을 한 행에만 붙는다. 없으면 빈 객체 — 지금과 같은 행.
    ...groupOptionSnapshotFields(result),
  };
  return {
    tracker_id: tracker.id,
    checked_at: checkedAt,
    collection_id: normalizeText(result?.collectionId) || null,
    rank: result?.rank || null,
    page: result?.page || null,
    position: result?.position || null,
    matched: Boolean(result?.matched),
    checked_count: result?.checkedCount || null,
    total: result?.total || null,
    item,
    top_items: sanitizeOrganicTrackingItems(result?.topItems),
    message,
    source,
  };
}

async function insertSnapshot(ctx, tracker, checkedAt, result, message) {
  const record = buildProductRankSnapshotRecord(tracker, checkedAt, result, message);
  // collection_id is introduced by the local-worker migration. Keep the
  // existing provider path compatible until that migration has been applied.
  const { collection_id: _collectionId, ...legacyRecord } = record;
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_snapshots")
    .insert(legacyRecord)
    .select(SNAPSHOT_SELECT)
    .single();

  if (error) throw error;
  return data;
}

async function assertRankLeaseOwnership(ctx, trackerId, leaseStartedAt = "") {
  if (!leaseStartedAt) return;

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id")
    .eq("id", trackerId)
    .eq("status", "active")
    .eq("processing_started_at", leaseStartedAt)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const leaseError = new Error("rank_tracker_lease_lost");
    leaseError.code = "RANK_TRACKER_LEASE_LOST";
    throw leaseError;
  }
}

function compactErrorMessage(value) {
  return normalizeText(value || "").slice(0, 500);
}

function rankRetryAt(tracker, date = new Date()) {
  const retryCount = Math.max(0, Number(tracker.retry_count || 0));
  const delayMinutes = [5, 10, 20, 40, 80, 160, 320, 360][Math.min(retryCount, 7)];
  return new Date(date.getTime() + delayMinutes * 60 * 1000).toISOString();
}

function canonicalTrackerProductId(tracker, result) {
  return normalizeText(
    extractProductId(tracker.product_url) ||
    tracker.product_id ||
    result?.targetProductId ||
    result?.item?.productId ||
    "",
  ) || null;
}

function positiveRank(value) {
  const rank = Number(value);
  return Number.isInteger(rank) && rank > 0 ? rank : null;
}

function isOrganicTrackingItem(item) {
  return Boolean(
    item
    && typeof item === "object"
    && item.isAd !== true
    && item.isOrganic !== false
    && !isAdItem(item)
  );
}

function hasDirectLegacyExactEvidence(result, targetProductId = "") {
  const exactTargetProductId = normalizeText(targetProductId);
  const matchedProductId = normalizeText(result?.matchedProductId);
  const relationBasis = normalizeText(result?.matchEvidence || result?.relationBasis);
  return /^[0-9]{5,}$/.test(exactTargetProductId)
    && matchedProductId === exactTargetProductId
    && ["seller_link_product_id", "catalog_id"].includes(relationBasis);
}

function sanitizeOrganicTrackingItems(items) {
  return (Array.isArray(items) ? items : []).filter(isOrganicTrackingItem);
}

export function selectRepresentativeTrackingRank(result = {}, trackerProductId = "") {
  const exactTargetProductId = normalizeText(trackerProductId) || normalizeText(result?.targetProductId);
  const exposureItems = Array.isArray(result?.productExposureItems) ? result.productExposureItems : [];
  const organicExposureItems = sanitizeOrganicTrackingItems(exposureItems);
  const exactExposure = organicExposureItems
    .filter((item) => item?.isExactTarget)
    .map((item) => ({ ...item, rank: positiveRank(item?.rank) }))
    .filter((item) => item.rank)
    .sort((a, b) => a.rank - b.rank)[0] || null;
  const relatedCatalog = organicExposureItems
    .filter((item) => item?.isRelatedCatalog && hasDirectCatalogSellerEvidence(
      item,
      exactTargetProductId,
      { allowImplicitRelatedId: true },
    ))
    .map((item) => ({ ...item, rank: positiveRank(item?.rank) }))
    .filter((item) => item.rank)
    .sort((a, b) => a.rank - b.rank)[0] || null;
  const exactExposureRejectedAsAd = exposureItems.some((item) => item?.isExactTarget && !isOrganicTrackingItem(item));
  const relatedExposurePresent = exposureItems.some((item) => item?.isRelatedCatalog);
  const explicitExactItem = result?.exactItem;
  const safeExactItem = isOrganicTrackingItem(explicitExactItem) ? explicitExactItem : exactExposure;
  const legacyExactAllowed = !explicitExactItem
    && !exactExposureRejectedAsAd
    && (!result?.item || isOrganicTrackingItem(result.item))
    && hasDirectLegacyExactEvidence(result, exactTargetProductId);
  const exactProductRank = exactExposure?.rank
    || (safeExactItem ? positiveRank(safeExactItem.rank) || positiveRank(result?.exactProductRank) : null)
    || (legacyExactAllowed
      ? positiveRank(result?.exactProductRank)
        || (result?.matched && result?.trackingRankSource !== "related_catalog" ? positiveRank(result.rank) : null)
      : null);
  const directResultCatalog = hasDirectCatalogSellerEvidence(
    result?.item,
    exactTargetProductId,
    { allowImplicitRelatedId: true },
  );
  const relatedCatalogRank = relatedCatalog?.rank
    || (!relatedExposurePresent && directResultCatalog ? positiveRank(result?.relatedCatalogRank) : null);
  const useRelatedCatalog = Boolean(relatedCatalogRank && (!exactProductRank || relatedCatalogRank < exactProductRank));
  const selectedRank = useRelatedCatalog ? relatedCatalogRank : exactProductRank;
  const trackingRankSource = selectedRank
    ? (useRelatedCatalog ? "related_catalog" : "exact_product")
    : "not_found";
  const safeResultItem = isOrganicTrackingItem(result?.item) ? result.item : null;
  const representativeItem = useRelatedCatalog
    ? relatedCatalog
    : (safeExactItem || safeResultItem || null);
  const excludedInSelection = exposureItems.length - organicExposureItems.length;
  const exactProductTypeInfo = classifyNaverProductType(safeExactItem?.productType);

  return {
    ...result,
    matched: Boolean(selectedRank),
    rank: selectedRank,
    page: selectedRank ? Math.ceil(selectedRank / 40) : null,
    position: selectedRank ? ((selectedRank - 1) % 40) + 1 : null,
    pageSize: 40,
    trackingRankSource,
    trackingRankSourceLabel: trackingRankSource === "related_catalog"
      ? "관련 원부 기준"
      : (trackingRankSource === "exact_product" ? "상품 ID 기준" : "미발견"),
    rankSelectionBasis: "best_of_exact_product_and_related_catalog",
    rankPolicy: "organic_only",
    adExcluded: true,
    excludedAdCount: Math.max(Number(result?.excludedAdCount || 0), excludedInSelection),
    exactProductRank,
    relatedCatalogRank,
    relatedCatalogProductId: normalizeText(relatedCatalog?.catalogId)
      || normalizeText(relatedCatalog?.productId)
      || null,
    relatedCatalogTitle: relatedCatalog?.title || null,
    relatedCatalogRelationBasis: relatedCatalog?.relationBasis || null,
    exactProductType: exactProductTypeInfo.productType || null,
    exactProductKind: exactProductTypeInfo.kind || null,
    item: safeResultItem || safeExactItem || relatedCatalog || null,
    exactItem: safeExactItem || null,
    representativeItem,
    productExposureItems: organicExposureItems,
    topItems: sanitizeOrganicTrackingItems(result?.topItems),
  };
}

export function representativeTrackingRankMessage(result = {}) {
  if (result.trackingRankSource === "related_catalog" && result.rank) {
    const exactLabel = result.exactProductRank ? `입력 상품 ${result.exactProductRank}위보다 ` : "";
    return `관련 원부 ${result.rank}위가 ${exactLabel}높아 30일 대표 순위로 기록했습니다.`;
  }
  if (result.trackingRankSource === "exact_product" && result.rank) {
    const relatedLabel = result.relatedCatalogRank
      ? ` 관련 원부는 ${result.relatedCatalogRank}위입니다.`
      : "";
    return `입력 상품의 오가닉 ${result.rank}위를 30일 대표 순위로 기록했습니다.${relatedLabel}`;
  }
  return shoppingRankMessage(result);
}

export function verifiedRelatedCatalogIdFromSnapshots(snapshots = [], trackerProductId = "") {
  const exactProductId = normalizeText(trackerProductId);
  const orderedSnapshots = [...(Array.isArray(snapshots) ? snapshots : [])]
    .sort((left, right) => (
      (Date.parse(String(right?.checked_at || "")) || 0)
      - (Date.parse(String(left?.checked_at || "")) || 0)
    ));

  const explicitlyUnmatchedCatalogIds = new Set();
  for (const snapshot of orderedSnapshots) {
    const item = snapshot?.item;
    const relatedCatalogId = normalizeText(item?.relatedCatalogProductId);
    const exactType = classifyNaverProductType(
      item?.exactProductType
      || (item?.trackingRankSource === "exact_product" ? item?.productType : ""),
    );
    if (relatedCatalogId && exactType.kind === "single") {
      explicitlyUnmatchedCatalogIds.add(relatedCatalogId);
    }
  }

  for (const snapshot of orderedSnapshots) {
    const item = snapshot?.item;
    const relatedCatalogId = normalizeText(item?.relatedCatalogProductId);
    if (snapshot?.matched !== true
      || !item
      || item.rankPolicy !== "organic_only"
      || item.adExcluded !== true
      || item.trackingRankSource !== "related_catalog"
      || !hasDirectCatalogSellerEvidence(item, exactProductId)
      || explicitlyUnmatchedCatalogIds.has(relatedCatalogId)
      || !positiveRank(item.relatedCatalogRank)
      || !/^[0-9]{5,}$/.test(relatedCatalogId)
      || relatedCatalogId === exactProductId) continue;
    return relatedCatalogId;
  }
  return "";
}

async function loadVerifiedRelatedCatalogId(ctx, tracker, checkedAt) {
  const checkedAfter = new Date(
    new Date(checkedAt).getTime() - PRODUCT_RANK_HISTORY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_snapshots")
    .select("id, tracker_id, checked_at, matched, item")
    .eq("tracker_id", tracker.id)
    .eq("matched", true)
    .gte("checked_at", checkedAfter)
    .lte("checked_at", checkedAt)
    .order("checked_at", { ascending: false })
    .limit(PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS);

  if (error) throw error;
  return verifiedRelatedCatalogIdFromSnapshots(data || [], tracker.product_id);
}

function assertCompleteProductTrackingResult(result = {}) {
  const checkedCount = Math.max(0, Number(result.checkedCount || 0));
  if (result.complete === true) return;
  if (result.partial === true || result.complete === false || checkedCount > 0) {
    throw new Error("shopping_rank_lookup_incomplete");
  }
  throw new Error("shopping_rank_provider_invalid_response");
}

async function updateTrackerAfterCheck(ctx, tracker, checkedAt, result, message, errorMessage = "", leaseStartedAt = "") {
  const matchedRank = result?.matched && result.rank ? Number(result.rank) : null;
  const nextCheckAt = nextRankCheckAt(new Date(checkedAt));
  const bestRank = matchedRank
    ? Math.min(Number(tracker.best_rank || matchedRank), matchedRank)
    : tracker.best_rank;
  const worstRank = matchedRank
    ? Math.max(Number(tracker.worst_rank || matchedRank), matchedRank)
    : tracker.worst_rank;
  const lastError = compactErrorMessage(errorMessage);

  const updateRecord = {
      status: tracker.status || "active",
      last_checked_at: checkedAt,
      next_check_at: nextCheckAt,
      current_rank: matchedRank,
      best_rank: bestRank || null,
      worst_rank: worstRank || null,
      check_count: Number(tracker.check_count || 0) + 1,
      found_count: Number(tracker.found_count || 0) + (matchedRank ? 1 : 0),
      last_message: message,
      last_error: lastError || null,
      retry_count: lastError ? Number(tracker.retry_count || 0) + 1 : 0,
      product_id: canonicalTrackerProductId(tracker, result),
      mall_name: tracker.mall_name || result?.exactItem?.mallName || result?.item?.mallName || null,
      product_title: tracker.product_title || result?.exactItem?.title || result?.item?.title || null,
      ...(leaseStartedAt ? { processing_started_at: null, processing_until: null } : {}),
    };
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update(updateRecord)
    .eq("id", tracker.id);

  if (leaseStartedAt) query = query.eq("status", "active").eq("processing_started_at", leaseStartedAt);
  const { data, error } = await query.select(TRACKER_SELECT).single();

  if (error) throw error;
  return data;
}

async function updateTrackerAfterFailure(
  ctx,
  tracker,
  attemptedAt,
  message,
  errorMessage,
  leaseStartedAt = "",
  retryAt = "",
) {
  const retryCount = Math.max(0, Number(tracker.retry_count || 0)) + 1;
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      next_check_at: retryAt || rankRetryAt(tracker, new Date(attemptedAt)),
      last_message: message,
      last_error: compactErrorMessage(errorMessage || "lookup_failed"),
      retry_count: retryCount,
      ...(leaseStartedAt ? { processing_started_at: null, processing_until: null } : {}),
    })
    .eq("id", tracker.id);

  if (leaseStartedAt) query = query.eq("status", "active").eq("processing_started_at", leaseStartedAt);
  const { data, error } = await query.select(TRACKER_SELECT).single();

  if (error) throw error;
  return data;
}

async function updateTrackerAfterPreservation(
  ctx,
  tracker,
  message,
  leaseStartedAt = "",
  nextCheckAt = "",
) {
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      next_check_at: nextCheckAt || nextRankCheckAt(new Date()),
      last_message: message,
      last_error: null,
      retry_count: 0,
      ...(leaseStartedAt ? { processing_started_at: null, processing_until: null } : {}),
    })
    .eq("id", tracker.id);

  if (leaseStartedAt) query = query.eq("status", "active").eq("processing_started_at", leaseStartedAt);
  const { data, error } = await query.select(TRACKER_SELECT).single();

  if (error) throw error;
  return data;
}

export async function runTrackerCheck(ctx, tracker, options = {}) {
  const checkedAt = new Date().toISOString();
  const env = options.env ?? shoppingRankConfig();
  const findShoppingRankImpl = options.findShoppingRank || findShoppingRank;

  if (!hasShoppingRankConfig(env)) {
    const message = "N 쇼핑 순위 수집원 연결을 확인한 뒤 자동 재시도합니다. 마지막 정상 순위는 유지합니다.";
    const updated = await updateTrackerAfterFailure(
      ctx,
      tracker,
      checkedAt,
      message,
      "shopping_rank_source_not_configured",
      options.leaseStartedAt || ""
    );
    return {
      ok: false,
      tracker: updated,
      message,
      error: "shopping_rank_source_not_configured",
      errorCode: SHOPPING_RANK_SOURCE_NOT_CONFIGURED,
      retryable: false,
      rankSourceReady: false,
      configured: false,
    };
  }

  try {
    const directTarget = buildRankTarget({
      targetProductId: tracker.product_id,
      targetUrl: tracker.product_url,
    });
    if (directTarget.hasDirectTarget !== true || directTarget.identityConflict === true) {
      const identityError = new Error("shopping_rank_target_identity_invalid");
      identityError.code = "SHOPPING_RANK_TARGET_IDENTITY_INVALID";
      throw identityError;
    }
    if (Array.isArray(tracker.option_product_ids) && tracker.option_product_ids.length) {
      // N30 그룹상품 옵션은 로컬 워커 submit 경로에서만 본다. 이 서버 즉시 경로는 대표 번호만 본다
      // (운영 hybrid 모드에서는 이 경로가 30일 기록을 만들지 않는다). 모드가 바뀌면 드러나게 남긴다.
      console.warn(JSON.stringify({
        level: "warn",
        event: "naver_rank_option_server_path_primary_only",
        optionCount: tracker.option_product_ids.length,
      }));
    }
    const verifiedRelatedCatalogId = await loadVerifiedRelatedCatalogId(ctx, tracker, checkedAt);
    const lookupResult = await findShoppingRankImpl(env, {
      keyword: tracker.keyword,
      targetProductId: tracker.product_id,
      targetUrl: tracker.product_url,
      targetMallName: tracker.mall_name,
      targetProductTitle: tracker.product_title,
      verifiedRelatedCatalogId,
      maxRank: PRODUCT_RANK_TRACKER_MAX_RANK,
    });
    const result = selectRepresentativeTrackingRank(lookupResult, tracker.product_id);
    assertCompleteProductTrackingResult(result);
    const message = representativeTrackingRankMessage(result);
    await assertRankLeaseOwnership(ctx, tracker.id, options.leaseStartedAt || "");
    const snapshot = await insertSnapshot(ctx, tracker, checkedAt, result, message);
    const updated = await updateTrackerAfterCheck(
      ctx,
      tracker,
      checkedAt,
      result,
      message,
      "",
      options.leaseStartedAt || ""
    );
    return { ok: true, tracker: updated, snapshot, result, message };
  } catch (error) {
    if (error?.code === "RANK_TRACKER_LEASE_LOST") throw error;
    const errorMessage = error?.message || "lookup_failed";
    const sourceFailure = shoppingCollectorFailureStatus(error);
    const sourceUnavailable = isShoppingRankSourceUnavailable(error);
    const coverageLimited = sourceFailure.status === "coverage_limited";
    const sourceTerminal = sourceUnavailable
      || sourceFailure.status === "unauthorized"
      || sourceFailure.status === "misconfigured";
    const queueLocalWorker = coverageLimited && options.queueLocalWorker === true;
    const message = sourceUnavailable
      ? "네이버 공식 쇼핑 검색 종료로 검증 수집원을 전환 중입니다. 마지막 정상 순위와 30일 기록은 유지합니다."
      : coverageLimited
        ? (queueLocalWorker
          ? "상위 즉시조회 범위 밖입니다. 기존 정상 순위를 유지하고 중앙 Chrome 300위 갱신을 대기합니다."
          : "현재 검증 가능한 상위 순위 범위 밖입니다. 기존 정상 순위와 30일 기록을 유지하고 다음 주기에 다시 확인합니다.")
      : sourceFailure.status === "unauthorized"
        ? "네이버 상품 순위 수집원 인증을 확인해야 합니다. 마지막 정상 순위와 30일 기록은 유지합니다."
        : sourceFailure.status === "misconfigured"
          ? "네이버 상품 순위 수집원 설정을 확인해야 합니다. 마지막 정상 순위와 30일 기록은 유지합니다."
      : "네이버 상품 순위 갱신에 실패해 자동 재시도합니다. 마지막 정상 순위는 유지합니다.";
    const errorCode = sourceUnavailable
      ? "SHOPPING_RANK_SOURCE_UNAVAILABLE"
      : coverageLimited
        ? "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW"
      : sourceFailure.status === "unauthorized"
        ? "SHOPPING_RANK_PROVIDER_UNAUTHORIZED"
        : sourceFailure.status === "misconfigured"
          ? "SHOPPING_RANK_PROVIDER_MISCONFIGURED"
          : "SHOPPING_RANK_LOOKUP_FAILED";
    const exponentialRetryAt = rankRetryAt(tracker, new Date(checkedAt));
    const providerRetryAt = Number(sourceFailure.retryAfterSeconds || 0) > 0
      ? new Date(Date.parse(checkedAt) + (Number(sourceFailure.retryAfterSeconds) * 1000)).toISOString()
      : "";
    const retryAt = sourceTerminal || coverageLimited
      ? nextRankCheckAt(new Date(checkedAt))
      : (providerRetryAt && Date.parse(providerRetryAt) > Date.parse(exponentialRetryAt)
        ? providerRetryAt
        : exponentialRetryAt);
    const updated = coverageLimited
      ? await updateTrackerAfterPreservation(
        ctx,
        tracker,
        message,
        options.leaseStartedAt || "",
        queueLocalWorker ? checkedAt : retryAt,
      )
      : await updateTrackerAfterFailure(
        ctx,
        tracker,
        checkedAt,
        message,
        sourceTerminal ? errorCode.toLowerCase() : errorMessage,
        options.leaseStartedAt || "",
        retryAt,
      );
    return {
      ok: false,
      tracker: updated,
      message,
      error: coverageLimited ? null : (sourceTerminal ? errorCode.toLowerCase() : errorMessage),
      errorCode,
      retryable: !sourceTerminal && !coverageLimited,
      retryAfter: sourceTerminal || coverageLimited ? 0 : Number(sourceFailure.retryAfterSeconds || 0),
      rankSourceReady: !sourceTerminal,
      configured: true,
      preserved: coverageLimited,
      queuedForLocalWorker: queueLocalWorker,
      outcome: coverageLimited ? "preserved" : "failed",
    };
  }
}

async function loadTrackerRegistrationMatches(ctx, agencyCode, keyword, productUrl, productId, mallName) {
  const requestedTarget = buildRankTarget({
    targetProductId: productId,
    targetUrl: productUrl,
  });
  const baseQuery = () => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .in("agency_code", agencyCodeScope(agencyCode))
    .in("status", ["active", "paused"]);
  const queries = [baseQuery().eq("keyword", keyword).limit(100)];
  if (productId) queries.push(baseQuery().eq("product_id", productId).limit(100));
  if (productUrl) queries.push(baseQuery().eq("product_url", productUrl).limit(100));
  if (!productId && !productUrl && mallName) queries.push(baseQuery().eq("mall_name", mallName).limit(100));

  const results = await Promise.all(queries);
  const error = results.find((result) => result.error)?.error;
  if (error) throw error;
  const normalizedKeyword = normalizeKeywordCompare(keyword);
  const matches = new Map();
  results.flatMap((result) => result.data || []).forEach((row) => {
    const rowTarget = buildRankTarget({
      targetProductId: row.product_id,
      targetUrl: row.product_url,
    });
    const sameTarget = requestedTarget.hasDirectTarget === true
      && requestedTarget.identityConflict !== true
      && rowTarget.hasDirectTarget === true
      && rowTarget.identityConflict !== true
      && rowTarget.targetMode === requestedTarget.targetMode
      && rowTarget.productIds.some((id) => requestedTarget.productIds.includes(id));
    if (sameTarget && normalizeKeywordCompare(row.keyword) === normalizedKeyword) matches.set(row.id, row);
  });
  return [...matches.values()];
}

async function reactivatePausedTracker(ctx, agencyCode, tracker) {
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      status: "active",
      processing_started_at: null,
      processing_until: null,
    })
    .eq("id", tracker.id)
    .in("agency_code", agencyCodeScope(agencyCode))
    .eq("status", "paused")
    .eq("keyword", tracker.keyword);

  if (tracker.product_id) query = query.eq("product_id", tracker.product_id);
  else if (tracker.product_url) query = query.eq("product_url", tracker.product_url);
  else query = query.eq("mall_name", tracker.mall_name);

  return query.select(TRACKER_SELECT).maybeSingle();
}

async function createTracker(request, ctx, body, access = {}) {
  const agencyCode = requestAgencyCode(request, body);
  const keyword = normalizeText(body.keyword);
  const productUrl = normalizeText(body.targetUrl || body.productUrl || body.product_url);
  const directTarget = buildRankTarget({
    targetProductId: body.productId || body.product_id,
    targetUrl: productUrl,
  });
  const productId = directTarget.productId;
  const mallName = normalizeText(body.mallName || body.mall_name);
  const productTitle = normalizeText(body.productTitle || body.product_title);
  const groupName = normalizeRankGroupName(body.groupName || body.group_name || body.group);

  if (!keyword) return json(request, { ok: false, message: "키워드를 입력해주세요." }, 400);
  if (directTarget.hasDirectTarget !== true || directTarget.identityConflict === true || !productId) {
    return json(request, { ok: false, message: "네이버 상품 URL 또는 숫자 상품ID를 입력해주세요." }, 400);
  }
  // F13: 신뢰 호스트의 카테고리·검색·기획전 URL 은 8자리 숫자 폴백에 걸려 식별자가
  // 잡히므로 위 게이트를 통과한다. 등록되면 영원히 못 찾는 product 모드 추적기가 돼
  // 한도와 수집 용량만 먹으므로 여기서 형태를 확인해 되돌린다.
  const productUrlRejection = rankProductUrlRejection(productUrl);
  if (productUrlRejection) {
    return json(request, {
      ok: false,
      code: RANK_PRODUCT_URL_REJECTION_CODE,
      message: productUrlRejection,
    }, 400);
  }

  const registrationMatches = await loadTrackerRegistrationMatches(
    ctx,
    agencyCode,
    keyword,
    productUrl,
    productId,
    mallName,
  );
  const existingData = registrationMatches.find((row) => row.status === "active");
  if (existingData) {
    const existingTracker = await attachTrackerGroup(ctx, existingData);
    const snapshots = await loadSnapshots(ctx, [existingTracker.id], PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS);
    const keywordVolumes = await loadKeywordVolumes([existingTracker.keyword]);
    return json(request, {
      ok: true,
      message: "이미 추적 중인 상품입니다. 최근 30일 기록을 이어서 표시합니다.",
      tracker: trackerPayload(
        existingTracker,
        snapshots.get(existingTracker.id) || [],
        keywordVolumes.get(normalizeKeywordCompare(existingTracker.keyword)),
        optionSkipExtras(request, access),
      ),
    });
  }

  const now = new Date();
  const rankConfig = shoppingRankConfig();
  const hybridCycleQueue = isHybridLocalWorkerMode(rankConfig) && hasShoppingRankConfig(rankConfig);
  const pausedData = registrationMatches.find((row) => row.status === "paused");
  if (pausedData) {
    let { data: reactivatedData, error: reactivationError } = await reactivatePausedTracker(ctx, agencyCode, pausedData);
    if (isRankKeywordLimitDbError(reactivationError)) {
      // DB 최후 방어선(trg_naver_rank_tracker_limit)이 막은 경우다. 일시중지 추적을
      // 다시 켜는 것도 활성 1건이 늘어나므로 등록 실패와 같은 안내를 보여준다.
      const reachedLimit = (await resolveRankKeywordLimit(ctx, agencyCode)).limit;
      return json(request, {
        ok: false,
        code: RANK_KEYWORD_LIMIT_CODE,
        message: rankKeywordLimitMessage(reachedLimit, "product"),
        limit: reachedLimit,
      }, 403);
    }
    if (reactivationError && reactivationError.code !== "23505") throw reactivationError;
    const reactivatedByRequest = Boolean(reactivatedData);

    if (!reactivatedData) {
      const racedMatches = await loadTrackerRegistrationMatches(
        ctx,
        agencyCode,
        keyword,
        productUrl,
        productId,
        mallName,
      );
      reactivatedData = racedMatches.find((row) => row.status === "active") || null;
      if (!reactivatedData) {
        return json(request, {
          ok: false,
          message: "추적 상태가 변경되어 재등록하지 않았습니다. 다시 시도해주세요.",
        }, 409);
      }
    }

    const reactivatedTracker = await attachTrackerGroup(ctx, reactivatedData);
    const snapshots = await loadSnapshots(ctx, [reactivatedTracker.id], PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS);
    const keywordVolumes = await loadKeywordVolumes([reactivatedTracker.keyword]);
    const remoteWakeRequested = hybridCycleQueue && reactivatedByRequest
      ? await requestShoppingWorkerWake(ctx, "tracker-create")
      : false;
    return json(request, {
      ok: true,
      queuedForLocalWorker: hybridCycleQueue,
      remoteWakeRequested,
      message: "기존 추적을 다시 시작했습니다. 기존 순서와 격리 시각을 유지하며 차례가 되면 갱신합니다.",
      tracker: trackerPayload(
        reactivatedTracker,
        snapshots.get(reactivatedTracker.id) || [],
        keywordVolumes.get(normalizeKeywordCompare(reactivatedTracker.keyword)),
        optionSkipExtras(request, access),
      ),
    });
  }

  const initialLeaseStartedAt = hybridCycleQueue ? "" : now.toISOString();
  const clientId = await findClientId(ctx, agencyCode);
  const activeCountResult = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id", { count: "exact", head: true })
    .in("agency_code", agencyCodeScope(agencyCode))
    .eq("status", "active");
  if (activeCountResult.error) throw activeCountResult.error;
  const unlimitedOwner = Boolean(access.admin && isPrimaryAgencyCode(agencyCode));
  // 총관리자가 계정별로 지정한 한도를 읽는다. 컬럼이 없는 DB(마이그레이션 적용 전)
  // 에서는 기본값 50 으로 떨어져 오늘과 같은 동작을 유지한다.
  const keywordLimit = unlimitedOwner
    ? DEFAULT_RANK_KEYWORD_LIMIT
    : (await resolveRankKeywordLimit(ctx, agencyCode)).limit;
  if (!unlimitedOwner && Number(activeCountResult.count || 0) >= keywordLimit) {
    return json(request, {
      ok: false,
      code: RANK_KEYWORD_LIMIT_CODE,
      message: rankKeywordLimitMessage(keywordLimit, "product"),
      limit: keywordLimit,
      count: activeCountResult.count || 0,
    }, 403);
  }
  const sortOrderResult = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("sort_order")
    .in("agency_code", agencyCodeScope(agencyCode))
    .order("sort_order", { ascending: false })
    .limit(1);
  if (sortOrderResult.error) throw sortOrderResult.error;
  const nextSortOrder = Number(sortOrderResult.data?.[0]?.sort_order || 0) + 100;

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .insert({
      client_id: clientId,
      agency_code: agencyCode,
      keyword,
      product_url: productUrl || null,
      product_id: productId || null,
      mall_name: mallName || null,
      product_title: productTitle || null,
      max_rank: clampMaxRank(),
      status: "active",
      started_at: now.toISOString(),
      ends_at: addDays(now, 3650),
      next_check_at: now.toISOString(),
      last_checked_at: null,
      processing_started_at: initialLeaseStartedAt || null,
      processing_until: initialLeaseStartedAt
        ? new Date(now.getTime() + RANK_TRACKER_LEASE_MS).toISOString()
        : null,
      last_message: "추적 등록 후 첫 순위 확인 대기",
      sort_order: nextSortOrder,
    })
    .select(TRACKER_SELECT)
    .single();

  if (isRankKeywordLimitDbError(error)) {
    return json(request, {
      ok: false,
      code: RANK_KEYWORD_LIMIT_CODE,
      message: rankKeywordLimitMessage(keywordLimit, "product"),
      limit: keywordLimit,
      count: Number(activeCountResult.count || 0),
    }, 403);
  }
  if (error) throw error;

  await updateTrackerGroupName(ctx, data.id, agencyCode, groupName);
  if (hybridCycleQueue) {
    // A new tracker enters the scheduler as an unverified, due row. The DB
    // scheduler gives last_checked_at=null rows the first slot; this request
    // must not pre-claim a lease or race that deterministic cycle selection.
    const remoteWakeRequested = await requestShoppingWorkerWake(ctx, "tracker-create");
    const queuedTracker = await attachTrackerGroup(ctx, { ...data, group_name: groupName });
    const snapshots = await loadSnapshots(ctx, [queuedTracker.id], PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS);
    const keywordVolumes = await loadKeywordVolumes([queuedTracker.keyword]);
    return json(request, {
      ok: true,
      queuedForLocalWorker: true,
      remoteWakeRequested,
      message: "추적 등록 후 첫 순위 확인 대기",
      tracker: trackerPayload(
        queuedTracker,
        snapshots.get(queuedTracker.id) || [],
        keywordVolumes.get(normalizeKeywordCompare(queuedTracker.keyword)),
        optionSkipExtras(request, access),
      ),
    }, 201);
  }
  const checked = await runTrackerCheck(ctx, { ...data, group_name: groupName }, {
    leaseStartedAt: initialLeaseStartedAt,
    queueLocalWorker: false,
  });
  const remoteWakeRequested = checked.queuedForLocalWorker === true
    ? await requestShoppingWorkerWake(ctx, "tracker-create")
    : false;
  const checkedTracker = await attachTrackerGroup(ctx, { ...checked.tracker, group_name: groupName });
  const snapshots = await loadSnapshots(ctx, [checked.tracker.id], PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS);
  const keywordVolumes = await loadKeywordVolumes([checked.tracker.keyword]);
  return json(request, {
    ok: checked.ok || checked.preserved === true,
    queuedForLocalWorker: checked.queuedForLocalWorker === true,
    remoteWakeRequested,
    message: checked.message,
    tracker: trackerPayload(
      checkedTracker,
      snapshots.get(checked.tracker.id) || [],
      keywordVolumes.get(normalizeKeywordCompare(checked.tracker.keyword)),
      optionSkipExtras(request, access),
    ),
  }, 201);
}

async function claimTrackerForManualCheck(ctx, tracker, agencyCode) {
  const leaseStartedAt = new Date().toISOString();
  const leaseUntil = new Date(Date.parse(leaseStartedAt) + RANK_TRACKER_LEASE_MS).toISOString();
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      processing_started_at: leaseStartedAt,
      processing_until: leaseUntil,
      last_message: "수동 순위 갱신 처리 중입니다.",
    })
    .eq("id", tracker.id)
    .in("agency_code", agencyCodeScope(agencyCode))
    .eq("status", "active")
    .or(`processing_until.is.null,processing_until.lt.${leaseStartedAt}`)
    .select(TRACKER_SELECT)
    .maybeSingle();

  if (error) {
    if (isMissingRankLeaseColumns(error)) {
      const schemaError = new Error("rank_tracker_lease_schema_missing");
      schemaError.code = "RANK_TRACKER_LEASE_SCHEMA_MISSING";
      throw schemaError;
    }
    throw error;
  }
  return data ? { tracker: data, leaseStartedAt } : null;
}

async function checkOne(request, ctx, body, access = {}) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode))
    .maybeSingle();

  if (error) throw error;
  if (!data) return json(request, { ok: false, message: "추적 항목을 찾을 수 없습니다." }, 404);

  const rankConfig = shoppingRankConfig();
  const rankSource = shoppingRankSourceStatus(rankConfig);
  if (!rankSource.configured) {
    return json(request, {
      ok: false,
      ...rankSource,
      message: "네이버 쇼핑 순위 수집원이 준비되지 않아 기존 순위와 30일 기록을 유지합니다.",
    }, 503);
  }

  if (isHybridLocalWorkerMode(rankConfig)) {
    // Manual refresh is only a wake signal for the durable 24-hour queue.
    // Never claim this tracker or rewrite next_check_at: doing so would move a
    // recently completed keyword ahead of older work and break cycle order.
    const remoteWakeRequested = await requestShoppingWorkerWake(ctx, "tracker-check");
    const tracker = await attachTrackerGroup(ctx, data);
    const snapshots = await loadSnapshots(ctx, [tracker.id], PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS);
    const keywordVolumes = await loadKeywordVolumes([tracker.keyword]);
    return json(request, {
      ok: true,
      ...rankSource,
      rankSourceReady: rankSource.rankSourceReady === true,
      errorCode: "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW",
      retryable: false,
      retryAfter: 0,
      preserved: true,
      queuedForLocalWorker: true,
      remoteWakeRequested,
      message: "중앙 Chrome 자동 순환을 깨웠습니다. 기존 순서와 격리 시각을 유지하며 차례가 되면 300위까지 갱신합니다.",
      tracker: trackerPayload(
        tracker,
        snapshots.get(tracker.id) || [],
        keywordVolumes.get(normalizeKeywordCompare(tracker.keyword)),
        optionSkipExtras(request, access),
      ),
    });
  }

  const claim = await claimTrackerForManualCheck(ctx, data, agencyCode);
  if (!claim) {
    return json(request, { ok: false, message: "이미 순위 갱신이 진행 중입니다. 잠시 후 다시 시도해주세요." }, 409);
  }
  const tracker = await attachTrackerGroup(ctx, claim.tracker);
  const checked = await runTrackerCheck(ctx, tracker, {
    env: rankConfig,
    leaseStartedAt: claim.leaseStartedAt,
    queueLocalWorker: isHybridLocalWorkerMode(rankConfig),
  });
  const remoteWakeRequested = checked.queuedForLocalWorker === true
    ? await requestShoppingWorkerWake(ctx, "tracker-check")
    : false;
  const checkedTracker = await attachTrackerGroup(ctx, checked.tracker);
  const snapshots = await loadSnapshots(ctx, [checked.tracker.id], PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS);
  const keywordVolumes = await loadKeywordVolumes([checked.tracker.keyword]);
  return json(request, {
    ok: checked.ok || checked.preserved === true,
    ...rankSource,
    rankSourceReady: rankSource.rankSourceReady === true && checked.rankSourceReady !== false,
    ...(!checked.ok ? {
      errorCode: checked.errorCode || "SHOPPING_RANK_LOOKUP_FAILED",
      retryable: checked.retryable !== false,
      retryAfter: Number(checked.retryAfter || 0),
      preserved: checked.preserved === true,
      queuedForLocalWorker: checked.queuedForLocalWorker === true,
      remoteWakeRequested,
    } : {}),
    message: checked.message,
    tracker: trackerPayload(
      checkedTracker,
      snapshots.get(checked.tracker.id) || [],
      keywordVolumes.get(normalizeKeywordCompare(checked.tracker.keyword)),
      optionSkipExtras(request, access),
    ),
  });
}

async function stopTracker(request, ctx, body, access = {}) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      status: "paused",
      processing_started_at: null,
      processing_until: null,
      last_message: "사용자 요청으로 추적을 중지했습니다.",
    })
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode))
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;
  const tracker = await attachTrackerGroup(ctx, data);
  return json(request, { ok: true, tracker: trackerPayload(tracker, [], null, optionSkipExtras(request, access)), message: "추적을 중지했습니다." });
}

async function deleteTracker(request, ctx, body) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .delete()
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode))
    .select("id");

  if (error) throw error;
  if (!data?.length) return json(request, { ok: false, message: "삭제할 추적 항목을 찾을 수 없습니다." }, 404);
  return json(request, { ok: true, deletedId: trackerId, message: "추적 항목을 삭제했습니다." });
}

async function updateTrackerGroup(request, ctx, body, access = {}) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  const groupName = normalizeRankGroupName(body.groupName || body.group_name || body.group);
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const updated = await updateTrackerGroupName(ctx, trackerId, agencyCode, groupName);
  if (!updated.ok && updated.missingColumn) {
    return json(request, {
      ok: false,
      message: "그룹 저장 컬럼이 아직 적용되지 않았습니다. DB 마이그레이션 적용 후 다시 시도해주세요.",
    }, 409);
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode))
    .maybeSingle();

  if (error) throw error;
  if (!data) return json(request, { ok: false, message: "그룹을 변경할 추적 항목을 찾을 수 없습니다." }, 404);

  const tracker = await attachTrackerGroup(ctx, { ...data, group_name: groupName });
  return json(request, {
    ok: true,
    message: "추적 항목 그룹을 변경했습니다.",
    tracker: trackerPayload(tracker, [], null, optionSkipExtras(request, access)),
  });
}

async function moveTracker(request, ctx, body) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  const direction = normalizeText(body.direction || "up");
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id, sort_order, created_at")
    .in("agency_code", agencyCodeScope(agencyCode))
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw error;

  const rows = data || [];
  const index = rows.findIndex((row) => row.id === trackerId);
  if (index < 0) return json(request, { ok: false, message: "이동할 추적 항목을 찾을 수 없습니다." }, 404);

  const targetIndex = direction === "down" ? index + 1 : index - 1;
  if (targetIndex < 0 || targetIndex >= rows.length) {
    return json(request, { ok: true, message: "더 이상 이동할 위치가 없습니다." });
  }

  const current = rows[index];
  const target = rows[targetIndex];
  const updates = [
    ctx.supabaseAdmin
      .from("naver_rank_trackers")
      .update({ sort_order: target.sort_order })
      .eq("id", current.id)
      .in("agency_code", agencyCodeScope(agencyCode)),
    ctx.supabaseAdmin
      .from("naver_rank_trackers")
      .update({ sort_order: current.sort_order })
      .eq("id", target.id)
      .in("agency_code", agencyCodeScope(agencyCode)),
  ];
  const results = await Promise.all(updates);
  const updateError = results.find((item) => item.error)?.error;
  if (updateError) throw updateError;

  return json(request, { ok: true, message: "추적 항목 위치를 변경했습니다." });
}

async function reorderTrackers(request, ctx, body) {
  const agencyCode = requestAgencyCode(request, body);
  const rawTrackerItems = Array.isArray(body.trackers) ? body.trackers : [];
  const rawIds = Array.isArray(body.orderedIds)
    ? body.orderedIds
    : (rawTrackerItems.length ? rawTrackerItems.map((item) => item?.id || item?.trackerId) : body.trackerIds);
  const orderedIds = Array.from(new Set((Array.isArray(rawIds) ? rawIds : [])
    .map((id) => normalizeText(id))
    .filter(Boolean)));
  const groupById = new Map(rawTrackerItems
    .map((item) => [normalizeText(item?.id || item?.trackerId), normalizeRankGroupName(item?.groupName || item?.group_name || item?.group)])
    .filter(([id]) => Boolean(id)));

  if (orderedIds.length < 2) {
    return json(request, { ok: false, message: "정렬할 추적 항목이 부족합니다." }, 400);
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id")
    .in("agency_code", agencyCodeScope(agencyCode))
    .in("id", orderedIds);

  if (error) throw error;

  const ownedIds = new Set((data || []).map((row) => row.id));
  if (ownedIds.size !== orderedIds.length) {
    return json(request, { ok: false, message: "정렬할 추적 항목을 확인할 수 없습니다." }, 404);
  }

  const results = await Promise.all(orderedIds.map((id, index) => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({ sort_order: (index + 1) * 100 })
    .eq("id", id)
    .in("agency_code", agencyCodeScope(agencyCode))));
  const updateError = results.find((item) => item.error)?.error;
  if (updateError) throw updateError;

  if (groupById.size) {
    const groupResults = await Promise.all(orderedIds.map((id) => updateTrackerGroupName(ctx, id, agencyCode, groupById.get(id))));
    const groupColumnMissing = groupResults.some((item) => item && item.missingColumn);
    if (groupColumnMissing) {
      return json(request, {
        ok: true,
        message: "추적 항목 순서는 저장했습니다. 그룹 저장은 DB 마이그레이션 적용 후 반영됩니다.",
      });
    }
  }

  return json(request, { ok: true, message: "추적 항목 순서를 저장했습니다." });
}

async function syncDueTrackers(request, ctx, body, access) {
  const rankConfig = shoppingRankConfig();
  const rankSource = shoppingRankSourceStatus(rankConfig);
  if (rankSource.configured && isHybridLocalWorkerMode(rankConfig)) {
    const remaining = await countDueTrackers(ctx, new Date().toISOString(), access.agencyCode);
    const remoteWakeRequested = remaining > 0
      ? await requestShoppingWorkerWake(ctx, "tracker-sync-due")
      : false;
    return json(request, {
      ok: true,
      ...rankSource,
      queuedForLocalWorker: remaining > 0,
      remoteWakeRequested,
      message: remaining
        ? `중앙 Chrome 300위 갱신 대기 ${remaining}건입니다.`
        : "갱신 대기 항목이 없습니다.",
      summary: {
        checked: 0,
        succeeded: 0,
        preserved: 0,
        failed: 0,
        remaining,
        remainingCount: remaining,
        drained: remaining === 0,
        configured: true,
        rankSourceReady: true,
        queuedForLocalWorker: remaining > 0,
        results: [],
      },
    });
  }
  const summary = await runDueTrackers(ctx, {
    agencyCode: access.agencyCode,
    limit: body.limit || process.env.MI_RANK_CRON_BATCH || 1,
  });
  const sourceNotConfigured = summary.configured !== true;
  const sourceUnavailable = summary.rankSourceReady === false;
  const ok = !sourceUnavailable && summary.failed === 0;
  return json(request, {
    ok,
    rankSourceReady: summary.rankSourceReady === true,
    configured: summary.configured === true,
    ...(sourceUnavailable ? {
      errorCode: sourceNotConfigured
        ? SHOPPING_RANK_SOURCE_NOT_CONFIGURED
        : (summary.errorCode || "SHOPPING_RANK_SOURCE_UNAVAILABLE"),
      retryable: false,
    } : (!ok ? {
      errorCode: "SHOPPING_RANK_LOOKUP_FAILED",
      retryable: true,
    } : {})),
    message: ok
      ? (summary.checked ? "밀린 자동 순위 갱신을 처리했습니다." : "갱신 대기 항목이 없습니다.")
      : (sourceUnavailable
        ? "네이버 쇼핑 순위 수집원이 연결되지 않아 자동 갱신을 시작하지 않았습니다."
        : "일부 순위 추적 항목의 자동 갱신이 실패했습니다."),
    summary,
  }, ok ? 200 : (sourceUnavailable ? 503 : 502));
}

async function queueRefreshAllTrackers(request, ctx, access) {
  const rankConfig = shoppingRankConfig();
  const rankSource = shoppingRankSourceStatus(rankConfig);
  if (!rankSource.configured || !isHybridLocalWorkerMode(rankConfig)) {
    return json(request, {
      ok: false,
      ...rankSource,
      message: "중앙 자동 갱신 연결을 확인해주세요.",
    }, 503);
  }

  const scope = agencyCodeScope(access.agencyCode);
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id, processing_until, worker_quarantined_until")
    .eq("status", "active")
    .in("agency_code", scope);
  if (error) throw error;

  // Active trackers already belong to the durable cycle. A refresh request
  // wakes the worker once, but must not rewrite scheduling, quarantine, or
  // processing leases. This keeps both tenant order and the global cursor
  // unchanged even when advertisers click repeatedly.
  const trackers = Array.isArray(data) ? data : [];
  const nowMs = Date.now();
  const total = trackers.length;
  const queued = 0;
  const alreadyProcessing = trackers.filter((tracker) => (
    Number.isFinite(Date.parse(tracker?.processing_until || ""))
      && Date.parse(tracker.processing_until) > nowMs
  )).length;
  const alreadyQueued = Math.max(0, total - alreadyProcessing);
  const remoteWakeRequested = total > 0
    ? await requestShoppingWorkerWake(ctx, "tracker-refresh-all")
    : false;
  return json(request, {
    ok: true,
    ...rankSource,
    queuedForLocalWorker: total > 0,
    remoteWakeRequested,
    message: total
      ? `현재 계정의 운영 중 순위 ${total}개를 중앙 자동 갱신에 등록했습니다.`
      : "갱신할 운영 중 순위 추적 항목이 없습니다.",
    summary: {
      total,
      queued,
      alreadyQueued,
      alreadyProcessing,
    },
  });
}

export async function claimDueTracker(ctx, tracker, nowIso) {
  const leaseUntil = new Date(Date.parse(nowIso) + RANK_TRACKER_LEASE_MS).toISOString();
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      processing_started_at: nowIso,
      processing_until: leaseUntil,
      last_message: "자동 순위 갱신 처리 중입니다.",
    })
    .eq("id", tracker.id)
    .eq("status", "active")
    .lte("next_check_at", nowIso)
    .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
    .select("id")
    .maybeSingle();

  if (error) {
    if (isMissingRankLeaseColumns(error)) {
      const schemaError = new Error("rank_tracker_lease_schema_missing");
      schemaError.code = "RANK_TRACKER_LEASE_SCHEMA_MISSING";
      throw schemaError;
    }
    throw error;
  }

  return {
    claimed: Boolean(data),
    leaseSupported: true,
    leaseStartedAt: nowIso,
    leaseUntil,
  };
}

async function clearDueTrackerClaim(ctx, trackerId, leaseStartedAt) {
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      processing_started_at: null,
      processing_until: null,
    })
    .eq("id", trackerId);
  if (leaseStartedAt) query = query.eq("processing_started_at", leaseStartedAt);
  const { error } = await query;

  if (error && !isMissingRankLeaseColumns(error)) {
    return { ok: false, message: error.message };
  }
  return { ok: true };
}

async function recordDueTrackerFailure(ctx, tracker, message, leaseStartedAt) {
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      processing_started_at: null,
      processing_until: null,
      last_message: "자동 순위 갱신 실패",
      last_error: compactErrorMessage(message || "rank_tracker_check_failed"),
      retry_count: Number(tracker.retry_count || 0) + 1,
      next_check_at: rankRetryAt(tracker),
    })
    .eq("id", tracker.id);
  if (leaseStartedAt) query = query.eq("processing_started_at", leaseStartedAt);
  const { error } = await query;

  if (error && !isMissingRankLeaseColumns(error)) {
    return { ok: false, message: error.message };
  }
  return { ok: true };
}

export async function runDueTrackers(ctx, options = {}) {
  const now = new Date().toISOString();
  const env = options.env ?? shoppingRankConfig();
  const configured = hasShoppingRankConfig(env);
  const limit = Math.max(1, Math.min(100, Number(options.limit || process.env.MI_RANK_CRON_BATCH || 1)));
  if (!configured) {
    const remaining = await countDueTrackers(ctx, now, options.agencyCode);
    return {
      now,
      checked: 0,
      succeeded: 0,
      failed: 0,
      remaining,
      remainingCount: remaining,
      drained: remaining === 0,
      configured: false,
      rankSourceReady: false,
      errorCode: SHOPPING_RANK_SOURCE_NOT_CONFIGURED,
      retryable: false,
      results: [],
    };
  }
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .eq("status", "active")
    .lte("next_check_at", now)
    .or(`processing_until.is.null,processing_until.lt.${now}`)
    .order("next_check_at", { ascending: true })
    .limit(limit);

  if (options.agencyCode) query = query.in("agency_code", agencyCodeScope(options.agencyCode));

  const { data, error } = await query;
  if (error) throw error;

  const results = [];
  const runTrackerCheckImpl = options.runTrackerCheck || runTrackerCheck;
  let sourceFailureCode = "";
  for (const tracker of data || []) {
    // Claim rows before checking so overlapping cron calls do not refresh the same tracker.
    // Missing lease columns fail closed; readiness also verifies this schema contract.
    // Sequential checks keep Naver API quota usage predictable.
    // eslint-disable-next-line no-await-in-loop
    const claim = await claimDueTracker(ctx, tracker, now);
    if (!claim.claimed) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await runTrackerCheckImpl(ctx, tracker, {
        env,
        leaseStartedAt: claim.leaseSupported ? now : "",
      });
      if (claim.leaseSupported) {
        // eslint-disable-next-line no-await-in-loop
        const clearResult = await clearDueTrackerClaim(ctx, tracker.id, now);
        if (!clearResult.ok) result.leaseClearError = clearResult.message;
      }
      results.push(result);
      if (result?.rankSourceReady === false) {
        sourceFailureCode = String(result?.errorCode || "SHOPPING_RANK_SOURCE_UNAVAILABLE");
        break;
      }
    } catch (error) {
      if (claim.leaseSupported) {
        // eslint-disable-next-line no-await-in-loop
        await recordDueTrackerFailure(ctx, tracker, error?.message || "rank_tracker_check_failed", now);
      }
      results.push({
        ok: false,
        tracker,
        message: "네이버 상품 순위 자동 갱신 처리 중 오류가 발생했습니다.",
        error: error?.message || "rank_tracker_check_failed",
      });
    }
  }

  const remaining = await countDueTrackers(ctx, now, options.agencyCode);
  const preserved = results.filter((item) => item?.preserved === true).length;
  const failed = results.filter((item) => !item?.ok && item?.preserved !== true).length;

  return {
    now,
    checked: results.length,
    succeeded: results.filter((item) => item.ok).length,
    preserved,
    failed,
    remaining,
    remainingCount: remaining,
    drained: remaining === 0,
    configured,
    rankSourceReady: configured && !sourceFailureCode,
    ...(sourceFailureCode ? {
      errorCode: sourceFailureCode,
      retryable: false,
    } : {}),
    results: results.map((item) => ({
      ok: item.ok,
      trackerId: item.tracker?.id,
      keyword: item.tracker?.keyword,
      rank: item.tracker?.current_rank,
      message: item.message,
      errorCode: item.errorCode,
      preserved: item.preserved === true,
      outcome: item.preserved === true ? "preserved" : (item.ok ? "updated" : "failed"),
      retryable: item.retryable,
    })),
  };
}

async function countDueTrackers(ctx, now, agencyCode = "") {
  let remainingQuery = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .lte("next_check_at", now)
    .or(`processing_until.is.null,processing_until.lt.${now}`);
  if (agencyCode) remainingQuery = remainingQuery.in("agency_code", agencyCodeScope(agencyCode));
  const remainingResult = await remainingQuery;
  if (remainingResult.error) throw remainingResult.error;
  return Math.max(0, Number(remainingResult.count || 0));
}

function shoppingWorkerControlAccepted(action, result, mode = "") {
  if (result?.accepted !== true) return false;
  if (action === "worker-canary") return result?.activated === true;
  if (action === "worker-cadence") {
    if (result?.activated !== true) return false;
    if (mode === "candidate") return result?.mode === "candidate" && result?.minutes === 6;
    if (mode === "baseline") return result?.mode === "baseline" && result?.minutes === 10;
    return false;
  }
  return true;
}

function shoppingWorkerControlMessage(action, result, mode = "") {
  const reason = normalizeWorkerText(result?.reason, 100).toLowerCase();
  const rejected = !shoppingWorkerControlAccepted(action, result, mode);
  if (rejected && reason === "not_eligible") return "24시간 안정 운영, 현재 실행 버전·해시, 오가닉 300개 연속 성공 6회가 모두 확인된 뒤 후보 간격을 적용할 수 있습니다.";
  if (rejected && reason === "probe_active") return "이미 1건 안전 검증이 진행 중이며 추가 검증은 시작하지 않았습니다.";
  if (rejected && reason === "busy") return "현재 작업 레인이 사용 중이어서 1건 검증을 시작하지 않았습니다.";
  if (rejected && reason === "cooldown") return "접속 제한 안전 대기 중이어서 1건 검증을 시작하지 않았습니다.";
  if (rejected && reason === "canary_mismatch") return "고정 테스트 항목이 일치하지 않아 실행하지 않았습니다.";
  if (rejected) return "운영 안전 조건을 충족하지 않아 요청을 적용하지 않았습니다.";
  if (action === "worker-stop") return "자동 순위 수집을 안전하게 정지하고 마지막 정상 순위를 보존합니다.";
  if (action === "worker-canary") return "테스트 1건 검증을 요청했습니다. 오가닉 300개 검증 성공 때만 자동 수집을 재개합니다.";
  if (action === "worker-cadence" && mode === "baseline") return "기본 10분 안전 간격으로 복귀했습니다.";
  if (action === "worker-cadence") return "검증된 후보 간격을 적용했습니다.";
  return "운영 제어 요청을 처리했습니다.";
}

export async function controlShoppingWorker(request, ctx, body, access) {
  if (!access?.owner || !isPrimaryAgencyCode(access.agencyCode)) {
    return json(request, { ok: false, message: "순위 수집 운영 제어는 총관리자만 사용할 수 있습니다." }, 403);
  }

  const action = normalizeWorkerText(body?.action, 40).toLowerCase();
  let rpcName = "";
  let args = {};
  let cadenceMode = "";

  if (action === "worker-stop") {
    rpcName = "mi_stop_naver_shopping_worker";
    args = { p_reason: "manual_stop" };
  } else if (action === "worker-canary") {
    const trackerId = normalizeWorkerText(body?.trackerId || body?.tracker_id, 64).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(trackerId)) {
      return json(request, { ok: false, message: "고정 검증 추적 항목을 확인할 수 없습니다." }, 400);
    }
    rpcName = "mi_request_naver_shopping_worker_probe";
    args = { p_tracker_id: trackerId };
  } else if (action === "worker-cadence") {
    cadenceMode = normalizeWorkerText(body?.mode, 20).toLowerCase();
    if (!new Set(["baseline", "candidate"]).has(cadenceMode)) {
      return json(request, { ok: false, message: "지원하지 않는 수집 간격입니다." }, 400);
    }
    if (cadenceMode === "candidate") {
      return json(request, {
        ok: false,
        action,
        message: "후보 6분 간격은 원부 검증과 연속 안정성 증거를 고정하는 검증 전용 전환 절차에서만 적용할 수 있습니다.",
        result: {
          state: "",
          mode: "",
          minutes: null,
          reason: "canonical_transition_required",
          activated: false,
        },
      }, 409);
    }
    rpcName = "mi_set_naver_shopping_worker_cadence";
    args = { p_mode: cadenceMode };
  } else {
    return json(request, { ok: false, message: "지원하지 않는 운영 제어입니다." }, 400);
  }

  const { data, error } = await ctx.supabaseAdmin.rpc(rpcName, args);
  if (error) throw error;
  const result = normalizeWorkerRpcObject(data);
  const accepted = shoppingWorkerControlAccepted(action, result, cadenceMode);
  const rejected = !accepted;
  const remoteWakeRequested = action === "worker-canary" && !rejected
    ? await requestShoppingWorkerWake(ctx, "control-plane-canary")
    : false;
  return json(request, {
    ok: !rejected,
    action,
    message: shoppingWorkerControlMessage(action, result, cadenceMode),
    ...(action === "worker-canary" ? { remoteWakeRequested } : {}),
    result: {
      state: normalizeWorkerText(workerValue(result, "state", "circuit_state", "circuitState"), 30),
      mode: normalizeWorkerText(workerValue(result, "mode", "cadence_mode", "cadenceMode"), 20),
      minutes: normalizeWorkerInteger(workerValue(result, "minutes", "cadence_minutes", "cadenceMinutes")),
      reason: normalizeWorkerText(result.reason, 100),
      activated: accepted,
    },
  }, rejected ? 409 : 200);
}

// ───────────────────── N30 그룹상품 번호 편집 (2026-10-23, 관리자 화면 전용) ─────────────────────
// 읽기·미리 보기·저장 모두 네이버 요청 0, 수집 순서(next_check_at·임대)와 깨우기에 손대지 않는다.
// 저장은 option_product_ids 한 칸만 바꾼다(전체 확인 저장이면 확인일 option_checked_at 도 같은 문장으로, 2026-10-31).
// 오류는 모두 4xx(5xx 는 공용 문구 봉인 대상).
const OPTION_TRACKER_COLUMNS = "id, agency_code, keyword, status, product_url, product_id, mall_name, product_title";
const OPTION_EDIT_MODES = new Set(["read", "preview", "save"]);
const OPTION_TRACKER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// 관리자 기록 보이기(optionSkipExtras·groupCandidates)와 group-mark 권한. 2026-11-01 광고주 사용 뒤에도 이름·동작 그대로다 —
// 광고주에게는 관리자 진단·후보를 계속 숨기고 group-mark 는 403 이다. 번호 편집 권한은 아래 optionEditAllowed 가 가른다.
function optionEditForbidden(request, access) {
  const role = String(request.headers.get("x-mi-session-role") || "").trim().toLowerCase();
  // 광고주와 연결된 운영팀 세션은 requireRankAccess 에서 admin:false 로 나와 광고주와 구분되지
  // 않는다. 세션 게이트가 덮어쓰는 역할 머리글로 가른다. 세션 없는 요청은 관리자 코드만 허용.
  if (role) return !["owner", "team"].includes(role);
  return access?.admin !== true;
}

// ── 광고주 사용(2026-11-01, 명세 advertiser-impl-spec §2) ──
// 역할은 세션 게이트가 덮어쓰는 머리글에서만 정한다(본문 값은 보지 않는다).
function optionSessionRole(headers) {
  return String(headers?.get?.("x-mi-session-role") || "").trim().toLowerCase();
}

// 그룹상품 번호 편집(action "options") 권한: 총관리자·운영팀 세션, 광고주 범위(대행사 코드·광고주 id)가 확인된 광고주
// 세션, 세션 없는 관리자 코드. 체험 세션은 순위 경로가 닫혀 있지만 여기서도 한 번 더 막는다.
function optionEditAllowed(access, headers) {
  const role = optionSessionRole(headers);
  if (role === "owner" || role === "team") return true;
  if (role === "client") {
    const sessionScope = String(headers.get("x-mi-session-scope") || "").trim().toLowerCase();
    return sessionScope !== "trial" && Boolean(normalizeAgencyCode(access?.agencyCode)) && Boolean(access?.clientId);
  }
  if (role) return false;
  return access?.admin === true;
}

// 'owner' | 'team' | 'client' | 'admin-code'(세션 없음). 그 밖이면 빈 문자열.
function optionActorRole(access, headers) {
  const role = optionSessionRole(headers);
  if (role === "owner" || role === "team" || role === "client") return role;
  if (role) return "";
  return access?.admin === true ? "admin-code" : "";
}

// 광고주 응답 문구: 내부 문구('대표 SQL'·'관리자 화면에서만')는 일반 문구로 바꾼다.
const OPTION_CLIENT_ERROR_MESSAGES = Object.freeze({
  RANK_OPTION_FORBIDDEN: "이 계정에서는 그룹상품 번호를 바꿀 수 없습니다.",
  RANK_OPTION_NOT_READY: "지금은 그룹상품 번호를 저장할 수 없습니다. 잠시 뒤 다시 시도해 주세요.",
  RANK_GROUP_MARK_FORBIDDEN: "이 계정에서는 그룹상품 표시를 바꿀 수 없습니다.",
});
const OPTION_INTERNAL_MESSAGE_PATTERN = /대표 SQL|관리자 화면/u;

function clientOptionErrorMessage(code, message) {
  if (Object.hasOwn(OPTION_CLIENT_ERROR_MESSAGES, code)) return OPTION_CLIENT_ERROR_MESSAGES[code];
  return OPTION_INTERNAL_MESSAGE_PATTERN.test(String(message || "")) ? "지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요." : message;
}

// 광고주 응답(read·preview): 확인일·확인일 칸 준비 여부를 비우고, 가져오기 후보(다른 대표 번호 추적에서 모은 번호)를 뺀다.
// 키 순서는 관리자 응답과 같다(빈 값만 다르다).
function clientOptionCommon(common) {
  const { siblingOptionProductIds, ...sameProduct } = common.sameProduct;
  return {
    ...common,
    tracker: { ...common.tracker, optionCheckedAt: null },
    sameProduct: {
      ...sameProduct,
      trackers: sameProduct.trackers.map((entry) => ({ ...entry, optionCheckedAt: null })),
    },
    checkedAtReady: false,
  };
}

// 버튼에서 넘어온 상품번호(sourcePageId, 검증 안 된 주장). 없으면 빈 문자열, 모양이 틀리면 ok:false.
// 글자로만 받는다(options-locate 와 같은 규칙) — JSON 숫자는 2^53 을 넘으면 자릿수가 깨진 채 정규식을 통과한다.
const OPTION_PAGE_ID_PATTERN = /^[0-9]{5,20}$/u;

function optionPageIdValue(value) {
  if (value === undefined || value === null || value === "") return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, value: "" };
  const text = String(value).trim();
  return OPTION_PAGE_ID_PATTERN.test(text) ? { ok: true, value: text } : { ok: false, value: "" };
}

// 다른 상품 목록 차단(모든 역할, 명세 §2.3). 실수 방지 장치이지 위조 방지가 아니다.
// L = 입력 번호(대표 번호 제외), K_t = 바뀌는 추적 t 의 지금 저장값, S = 버튼에서 넘어온 상품번호.
// blocked_t = L≠∅ ∧ 대표 번호 없음 ∧ K_t≠∅ ∧ L∩K_t=∅, 버튼 목록에 대표 번호가 없고 저장값이 모두 비었으면 button_primary_missing.
const OPTION_OTHER_PRIMARY_HITS_MAX = 5;

function optionHitPreferred(left, right) {
  const rank = (row) => (String(row?.status || "") === "active" ? 0 : 1);
  if (rank(left) !== rank(right)) return rank(left) < rank(right);
  const keywordOrder = normalizeText(left?.keyword).localeCompare(normalizeText(right?.keyword), "ko");
  if (keywordOrder !== 0) return keywordOrder < 0;
  return String(left?.id || "") < String(right?.id || "");
}

// 같은 범위에서 입력 번호를 대표 번호로 쓰는 추적(대표 번호마다 1개, 최대 5개, 입력 순서). 이미 읽은 후보 행만 쓴다(추가 조회 0).
function optionOtherPrimaryHits(rows, listed, primaryProductId) {
  const order = new Map(listed.map((id, index) => [id, index]));
  const byProduct = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const productId = normalizeText(row?.product_id);
    if (!order.has(productId) || productId === primaryProductId) continue;
    if (!["active", "paused"].includes(String(row?.status || ""))) continue;
    if (!trackerOptionEligibility(row).eligible) continue;
    const current = byProduct.get(productId);
    if (current && !optionHitPreferred(row, current)) continue;
    byProduct.set(productId, row);
  }
  return [...byProduct.entries()]
    .sort((left, right) => order.get(left[0]) - order.get(right[0]))
    .slice(0, OPTION_OTHER_PRIMARY_HITS_MAX)
    .map(([productId, row]) => ({ productId, keyword: normalizeText(row.keyword), trackerId: row.id }));
}

function optionListGuard({ parsed, targets, sourcePageId, primaryProductId, relatedRows }) {
  const listed = Array.isArray(parsed?.optionProductIds) ? parsed.optionProductIds : [];
  const listedSet = new Set(listed);
  const open = listed.length > 0 && parsed?.primaryRemoved !== true;
  const blockedTrackers = open
    ? targets
      .filter((target) => target.before.length > 0 && !target.before.some((id) => listedSet.has(id)))
      .map((target) => ({ trackerId: target.id, keyword: target.keyword }))
    : [];
  const storedEmpty = targets.every((target) => target.before.length === 0);
  const buttonPrimaryMissing = open && Boolean(sourcePageId) && storedEmpty;
  const blocked = blockedTrackers.length > 0 || buttonPrimaryMissing;
  let reason = null;
  if (blockedTrackers.length) reason = "foreign_list";
  else if (buttonPrimaryMissing) reason = "button_primary_missing";
  return {
    blocked,
    reason,
    blockedTrackers,
    needsPrimaryConfirm: !blocked && open && !sourcePageId && storedEmpty,
    otherPrimaryHits: optionOtherPrimaryHits(relatedRows, listed, primaryProductId),
  };
}

function optionGuardMessage(guard, primaryProductId) {
  if (guard.reason === "button_primary_missing") {
    return `버튼에서 넘어온 목록에 이 상품(대표 ${primaryProductId})이 없어 저장하지 않았습니다. 이 상품 페이지에서 다시 눌러 주세요.`;
  }
  return `이 목록에는 이 상품(대표 ${primaryProductId})도, 지금 저장된 번호도 하나도 없습니다. 다른 상품의 목록으로 보여 저장하지 않았습니다.`;
}

// 광고주 저장 빈도(명세 §2.2): 광고주 범위당 10분에 저장 결과 기록 20줄. 읽기·미리 보기는 세지 않는다. 결과 기록 기반 근사다
// (51개 넘는 추적을 한 번에 저장하면 나눠 쓴 줄이 따로 세어진다). 운영팀·총관리자가 같은 광고주에 남긴 줄은 세지 않는다.
const OPTION_CLIENT_SAVE_LIMIT = 20;
const OPTION_CLIENT_SAVE_WINDOW_MS = 10 * 60_000;

async function optionClientRecentSaveCount(ctx, clientId, nowMs = Date.now()) {
  try {
    const { count, error } = await ctx.supabaseAdmin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("action", "naver_rank_options_save_result")
      .eq("client_id", clientId)
      .eq("metadata->>actorRole", "client")
      .gt("created_at", new Date(nowMs - OPTION_CLIENT_SAVE_WINDOW_MS).toISOString());
    if (error || !Number.isFinite(count)) return { ok: false, error: error || new Error("option_rate_count_missing") };
    return { ok: true, count };
  } catch (error) {
    return { ok: false, error };
  }
}

// 옵션 확인일 칸(option_checked_at, 2026-10-31 B6)은 옵션 칸과 함께 읽는다. 표시 칸 선례(readGroupMarkTrackerRows)처럼
// 10분 기억과 상관없이 읽어 보고(관리자가 누를 때만이라 드물다), 칸이 없으면 그 칸만 빼고 다시 읽는다. 확인일 칸 검사를
// 옵션 칸 검사보다 먼저 한다. checkedAtReady:false 면 확인일을 모르고 저장 때도 쓰지 않는다.
async function readOptionTrackerRows(build, { withCheckedAt = true } = {}) {
  let checkedAtReady = withCheckedAt === true;
  let withOptions = await build(`${OPTION_TRACKER_COLUMNS}, option_product_ids${checkedAtReady ? ", option_checked_at" : ""}`);
  if (withOptions.error && checkedAtReady && isOptionCheckedColumnMissingError(withOptions.error)) {
    rememberOptionCheckedColumnMissing("rank-tracker-options");
    checkedAtReady = false;
    withOptions = await build(`${OPTION_TRACKER_COLUMNS}, option_product_ids`);
  }
  if (!withOptions.error) {
    if (checkedAtReady) forgetOptionCheckedColumnMissing();
    return { data: withOptions.data, columnReady: true, checkedAtReady };
  }
  if (!isOptionColumnMissingError(withOptions.error)) throw withOptions.error;
  rememberOptionColumnMissing("rank-tracker-options");
  const legacy = await build(OPTION_TRACKER_COLUMNS);
  if (legacy.error) throw legacy.error;
  return { data: legacy.data, columnReady: false, checkedAtReady: false };
}

// 함께 바꿀 대상은 같은 대표 번호(product_id) 추적만 읽는다(명세 §8.3-4). 같은 그룹의 다른 옵션을 대표로
// 쓴 추적과 이 대표 번호를 옵션으로 가진 추적은 '가져오기' 후보 번호만 만든다(쓰지 않음).
async function loadOptionGroupCandidates(ctx, scope, primaryProductId, optionIds, columnReady, checkedAtReady = false) {
  const limit = OPTION_SAME_PRODUCT_TRACKERS_MAX + 2;
  const scoped = (columns) => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(columns)
    .in("agency_code", scope)
    .in("status", ["active", "paused"]);
  const sameProduct = await readOptionTrackerRows((columns) => scoped(columns)
    .eq("product_id", primaryProductId)
    .limit(limit), { withCheckedAt: checkedAtReady });
  const suggestionRows = [];
  if (columnReady && sameProduct.columnReady) {
    const readSuggestionRows = async (build) => {
      const { data, error } = await build(scoped(`${OPTION_TRACKER_COLUMNS}, option_product_ids`)).limit(limit);
      if (error && !isOptionColumnMissingError(error)) throw error;
      if (!error) suggestionRows.push(...(data || []));
    };
    if (optionIds.length) await readSuggestionRows((query) => query.in("product_id", optionIds));
    await readSuggestionRows((query) => query.contains("option_product_ids", [primaryProductId]));
  }
  return {
    sameProduct: sameProduct.data || [],
    suggestionRows,
    columnReady: sameProduct.columnReady,
    checkedAtReady: sameProduct.checkedAtReady,
  };
}

// 광고주 세션 응답(2026-11-01)은 내부 문구('대표 SQL'·'관리자 화면에서만')를 일반 문구로 바꾼다. 코드·상태·나머지 칸은 그대로다.
function optionEditError(request, status, code, message, extra = {}) {
  const visibleMessage = optionSessionRole(request.headers) === "client" ? clientOptionErrorMessage(code, message) : message;
  return json(request, { ok: false, code, message: visibleMessage, ...extra }, status);
}

// ── 동시 변경 보호·되돌림 기록 (대표 요청 2026-10-31, 옵션 번호 정식 기능 B3·B4) ──
// 미리 보기(또는 읽기) 응답이 추적별 저장값을 DB 에 있는 그대로(정규화 전, 순서 그대로) 싣고, 저장 요청이 그 값을 그대로
// 돌려보낸다. 서버는 지금 값과 맞춰 본 뒤 그 값을 쓰기 조건(option_product_ids = 그 값)에도 묶는다.
const OPTION_STORED_ID_LITERAL_PATTERN = /^[0-9]+$/u;
const OPTION_AUDIT_TRACKER_IDS_PER_ROW = 50;
const OPTION_CHECKED_NOT_READY_MESSAGE = "확인일 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요.";

// 저장된 옵션 번호 그대로. 칸을 못 읽었으면 null(모름).
function storedOptionProductIds(row) {
  return Array.isArray(row?.option_product_ids) ? row.option_product_ids.map((id) => String(id)) : null;
}

function optionStoredIdsById(tracker, sameProductRows = []) {
  const stored = new Map();
  for (const row of sameProductRows) {
    if (row?.id) stored.set(String(row.id), storedOptionProductIds(row));
  }
  stored.set(String(tracker.id), storedOptionProductIds(tracker));
  return stored;
}

// 화면이 돌려보낸 expectedOptionProductIds({ 추적 id: 문자열 배열 }). 모양이 틀린 칸은 없는 것으로 본다.
function expectedOptionProductIdsMap(value) {
  const expected = new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) return expected;
  for (const [id, ids] of Object.entries(value)) {
    if (!Array.isArray(ids) || !ids.every((entry) => typeof entry === "string")) continue;
    expected.set(String(id).trim().toLowerCase(), ids.slice());
  }
  return expected;
}

function sameOptionIdList(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((id, index) => id === right[index]);
}

// PostgREST eq 비교용 text[] 리터럴. DB 제약상 번호는 숫자뿐이라 따옴표가 필요 없다 — 숫자가 아닌 값이 하나라도 있으면
// 만들지 않는다(null). 빈 목록은 '{}'.
function optionIdsArrayLiteral(ids) {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && OPTION_STORED_ID_LITERAL_PATTERN.test(id))) return null;
  return `{${ids.join(",")}}`;
}

// '확인만 기록'(B6): 저장된 번호(정리한 목록)와 이번 목록이 순서와 상관없이 같은지. 둘 다 정리된(중복 없는) 목록이다.
function sameOptionIdSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const leftSet = new Set(left.map(String));
  const rightSet = new Set(right.map(String));
  return leftSet.size === rightSet.size && [...leftSet].every((id) => rightSet.has(id));
}

// 묶음 쓰기 오류가 '확실한 DB 거절'인지(H1). PostgREST 가 DB 오류 코드(SQLSTATE 5자리)나 PGRST 코드를 실어 돌려준
// 오류는 그 문장이 되돌려진 것이라 아무 줄도 쓰이지 않았다. 코드가 없거나(게이트웨이 5xx 의 JSON 아닌 본문·연결 끊김 —
// postgrest-js 는 fetch 실패를 code '' 로 준다) 코드 모양이 DB 코드가 아니거나(ECONNRESET·AbortError 20 등), DB 와의
// 연결이 끊긴 코드(08xxx·PGRST001 — 확정 중에 끊겼을 수 있다), 문장 완료 여부를 모른다는 40003
// (statement_completion_unknown), 관리자 개입·서버 종료 57P 계열(57P01·57P02·57P03 — 확정 중에 서버가 내려갔을 수
// 있다)이면 DB 가 이미 썼는지 알 수 없다. 같은 57 계열이라도 57014(문장 취소)는 되돌려진 것이라 확실한 거절이다.
// 던져진 예외는 부르는 쪽이 따로 '모름'으로 본다. 코드 없이 문구로만 오는 칸 없음 오류(오래된 클라이언트)는 지금처럼
// 확실한 거절로 본다.
const OPTION_WRITE_DB_ERROR_CODE_PATTERN = /^(?:(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}|PGRST[0-9A-Z]{3})$/u;

function isDefiniteOptionWriteRejection(error) {
  if (!error || typeof error !== "object") return false;
  if (isOptionColumnMissingError(error) || isOptionCheckedColumnMissingError(error)) return true;
  const code = String(error.code ?? "").trim().toUpperCase();
  if (!OPTION_WRITE_DB_ERROR_CODE_PATTERN.test(code)) return false;
  if (code.startsWith("08") || code.startsWith("57P")) return false;
  return code !== "40003" && code !== "PGRST001";
}

// 대표 번호·바꿀 목록·미리 보기 때 저장값이 모두 같은 추적끼리 한 번에 쓴다.
// 저장값(DB 그대로)까지 묶음 열쇠에 넣으므로, 같은 대표 번호·같은 목록으로 저장해도 추적마다 저장값이 다르면 UPDATE 가
// 여러 번으로 나뉜다. 한 문장으로 다 되거나 다 안 되는 단위는 묶음 하나이고(묶음 사이는 원자적이지 않다), 일부 묶음만
// 저장된 결과는 RANK_OPTION_PARTIAL(쓰기 오류)·RANK_OPTION_CHANGED(조건 불일치로 줄 수 모자람) 응답과 결과 기록
// (naver_rank_options_save_result 의 updatedTrackerIds)에 남는다. 쓰기 오류가 확실한 거절이 아니면(H1) 그 묶음은
// 저장됐는지 모르는 추적(uncertainTrackerIds)으로 응답과 결과 기록에 따로 남긴다.
// 광고주 저장(2026-11-01)은 목록이 실제로 바뀌는 추적만 확인일을 비우므로 listChanged 도 묶음 열쇠에 넣는다(관리자 저장은 늘 false).
function optionTargetGroups(targets, storedById = new Map(), listChangedOf = () => false) {
  const groups = [];
  const byKey = new Map();
  for (const target of targets) {
    const expected = storedById.get(String(target.id)) || [];
    const listChanged = listChangedOf(target) === true;
    const key = `${target.primaryProductId}|${target.after.join(",")}|${expected.join(",")}|${listChanged ? 1 : 0}`;
    if (!byKey.has(key)) {
      const group = {
        productId: target.primaryProductId,
        after: target.after,
        expectedLiteral: optionIdsArrayLiteral(expected),
        listChanged,
        ids: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).ids.push(target.id);
  }
  return groups;
}

// 되돌림 기록. admin-api.mjs recordAuditLog 와 같은 모양이다(그 함수는 그 파일 안에서만 쓴다). 여러 줄을 한 문장으로 넣어
// 모두 되거나 모두 안 된다. metadata 는 sanitizeAuditMetadata 로 정리한다(배열 50개 자르기 — 옵션 번호는 50개 이하라
// 잘리지 않고, 추적 id 목록은 50개씩 나눠 쓴다).
async function recordOptionAuditLogs(ctx, payloads) {
  const rows = payloads.map((payload) => ({
    actor_id: null,
    client_id: payload.clientId || null,
    action: payload.action,
    target_table: payload.targetTable,
    target_id: payload.targetId || null,
    metadata: sanitizeAuditMetadata(payload.metadata || {}),
  }));
  try {
    const { error } = await ctx.supabaseAdmin.from("audit_logs").insert(rows);
    return { logged: !error, error };
  } catch (error) {
    return { logged: false, error };
  }
}

function optionAuditFailedWarning(stage, error) {
  console.warn(JSON.stringify({
    level: "warn",
    event: "naver_rank_tracker_options_audit_failed",
    stage,
    errorType: safeRankErrorType(error),
    errorCode: safeRankErrorCode(error),
  }));
}

// 결과 기록: 실제로 저장된 추적(일부만 저장된 경우 포함)과 그중 확인일까지 쓴 추적, 저장됐는지 모르는 추적(H1, 있을 때만),
// 광고주 저장으로 확인일을 비운 추적(있을 때만). 모든 목록을 50개씩 나눠 쓴다. 실패해도 저장은 그대로 두고 경고만 남긴다.
// actor(2026-11-01): client_id 와 metadata 끝의 actorRole·claimedSource·sourcePageId — 광고주 저장 빈도도 이 줄로 센다.
async function recordOptionSaveResult(ctx, trackerId, result, actor = {}) {
  const ids = result.updatedTrackerIds.map((id) => String(id));
  const checkedIds = result.checkedTrackerIds.map((id) => String(id));
  const uncertainIds = (result.uncertainTrackerIds || []).map((id) => String(id));
  const clearedIds = (result.checkedClearedTrackerIds || []).map((id) => String(id));
  const perRow = OPTION_AUDIT_TRACKER_IDS_PER_ROW;
  const partCount = Math.max(
    1,
    Math.ceil(ids.length / perRow),
    Math.ceil(checkedIds.length / perRow),
    Math.ceil(uncertainIds.length / perRow),
    Math.ceil(clearedIds.length / perRow),
  );
  const slice = (list, index) => list.slice(index * perRow, (index + 1) * perRow);
  const logged = await recordOptionAuditLogs(ctx, Array.from({ length: partCount }, (_, index) => ({
    action: "naver_rank_options_save_result",
    targetTable: "naver_rank_trackers",
    targetId: trackerId,
    clientId: actor.clientId || null,
    metadata: {
      updatedTrackerIds: slice(ids, index),
      checkedTrackerIds: slice(checkedIds, index),
      ...(uncertainIds.length ? { uncertainTrackerIds: slice(uncertainIds, index) } : {}),
      ...(clearedIds.length ? { checkedClearedTrackerIds: slice(clearedIds, index) } : {}),
      targetCount: result.targetCount,
      checkedAtRecorded: result.checkedAtRecorded,
      fullReview: result.fullReview,
      ...(result.checkOnly ? { checkOnly: true } : {}),
      outcome: result.outcome,
      ...(partCount > 1
        ? {
          updatedCount: ids.length,
          checkedCount: checkedIds.length,
          ...(uncertainIds.length ? { uncertainCount: uncertainIds.length } : {}),
          ...(clearedIds.length ? { checkedClearedCount: clearedIds.length } : {}),
          part: index + 1,
          partCount,
        }
        : {}),
      ...(actor.metadata || {}),
    },
  })));
  if (!logged.logged) optionAuditFailedWarning("result", logged.error);
}

async function handleTrackerOptions(request, ctx, body, access) {
  // 광고주 사용(2026-11-01): 편집 권한은 optionEditAllowed, 역할은 세션에서만. 광고주 오류 문구는 optionEditError 가 거른다.
  const actorRole = optionActorRole(access, request.headers);
  const clientActor = actorRole === "client";
  if (!optionEditAllowed(access, request.headers)) {
    return optionEditError(request, 403, "RANK_OPTION_FORBIDDEN", "그룹상품 번호는 관리자 화면에서만 바꿀 수 있습니다.");
  }
  const trackerId = normalizeText(body.trackerId || body.id).toLowerCase();
  if (!OPTION_TRACKER_ID_PATTERN.test(trackerId)) {
    return optionEditError(request, 400, "RANK_OPTION_TRACKER_REQUIRED", "trackerId가 필요합니다.");
  }
  const mode = normalizeText(body.mode || "read").toLowerCase();
  if (!OPTION_EDIT_MODES.has(mode)) {
    return optionEditError(request, 400, "RANK_OPTION_MODE_INVALID", "지원하지 않는 그룹상품 번호 작업입니다.");
  }
  // '확인만 기록'은 운영팀 30일 점검 기준이라 광고주에게 열지 않는다. DB 를 읽기 전에 거절한다.
  if (clientActor && mode === "save" && body.checkOnly === true) {
    return optionEditError(request, 403, "RANK_OPTION_CHECK_ONLY_FORBIDDEN", "확인만 기록은 운영팀 기능입니다.");
  }
  const sourcePage = mode === "read" ? { ok: true, value: "" } : optionPageIdValue(body.sourcePageId);
  if (!sourcePage.ok) {
    return optionEditError(
      request,
      400,
      "RANK_OPTION_SOURCE_INVALID",
      "버튼에서 넘어온 상품번호가 올바르지 않습니다. 옵션 확인 버튼을 다시 눌러 주세요.",
    );
  }
  const sourcePageId = sourcePage.value;
  const claimedSource = body.claimedSource === "button" ? "button" : "manual";
  const auditActor = {
    clientId: access.clientId || null,
    metadata: { actorRole, claimedSource, ...(sourcePageId ? { sourcePageId } : {}) },
  };
  const scope = agencyCodeScope(access.agencyCode);
  const self = await readOptionTrackerRows((columns) => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(columns)
    .eq("id", trackerId)
    .in("agency_code", scope)
    .maybeSingle());
  const tracker = self.data;
  if (!tracker) {
    return optionEditError(request, 404, "RANK_OPTION_TRACKER_NOT_FOUND", "추적 항목을 찾을 수 없습니다.");
  }
  if (self.columnReady) forgetOptionColumnMissing();
  const eligibility = trackerOptionEligibility(tracker);
  if (eligibility.reason === "catalog_tracker") {
    return optionEditError(
      request,
      409,
      "RANK_OPTION_CATALOG_TRACKER",
      "원부(가격비교) 추적에는 그룹상품 번호를 붙일 수 없습니다. 원부 순위는 원부 번호로 따로 추적하세요.",
    );
  }
  if (!eligibility.eligible) {
    return optionEditError(
      request,
      409,
      "RANK_OPTION_PRIMARY_INVALID",
      "대표 상품번호를 확인할 수 없는 추적에는 그룹상품 번호를 붙일 수 없습니다. 상품 URL·상품번호를 확인해주세요.",
    );
  }
  const currentIds = self.columnReady
    ? normalizeStoredOptionProductIds(tracker.option_product_ids, eligibility.primaryProductIds)
    : [];
  const applyToSameProduct = body.applyToSameProduct === true;

  let parsed = null;
  let optionIds = currentIds;
  if (mode !== "read") {
    parsed = parseOptionProductInput(typeof body.optionInput === "string" ? body.optionInput : "", {
      primaryProductIds: eligibility.primaryProductIds,
      primaryProductUrl: tracker.product_url,
    });
    if (parsed.error) {
      return optionEditError(
        request,
        400,
        "RANK_OPTION_INPUT_TOO_LONG",
        "붙여 넣은 글이 너무 깁니다. 한 번에 2만 자·60칸까지 넣을 수 있습니다.",
        { parsed },
      );
    }
    if (parsed.overLimit) {
      return optionEditError(
        request,
        400,
        "RANK_OPTION_LIMIT",
        `그룹상품 번호는 최대 ${OPTION_PRODUCT_IDS_MAX}개까지 넣을 수 있습니다.`,
        { parsed },
      );
    }
    optionIds = parsed.optionProductIds;
  }

  const candidates = await loadOptionGroupCandidates(
    ctx,
    scope,
    eligibility.primaryProductId,
    optionIds,
    self.columnReady,
    self.checkedAtReady,
  );
  const plan = planOptionGroupUpdate({
    tracker,
    optionProductIds: optionIds,
    candidates: candidates.sameProduct,
    applyToSameProduct,
    columnReady: self.columnReady,
  });
  if (applyToSameProduct && plan.siblings.length > OPTION_SAME_PRODUCT_TRACKERS_MAX) {
    return optionEditError(
      request,
      400,
      "RANK_OPTION_TOO_MANY_TRACKERS",
      `함께 바꿀 추적이 ${OPTION_SAME_PRODUCT_TRACKERS_MAX}개를 넘습니다. '다른 키워드 추적에도 적용'을 끄고 저장해주세요.`,
    );
  }
  const siblingGroups = await loadTrackerGroups(ctx, plan.siblings.map((sibling) => sibling.id));
  const suggestions = siblingOptionSuggestions(tracker, [...candidates.sameProduct, ...candidates.suggestionRows], optionIds);
  const sameProductRowsById = new Map(candidates.sameProduct.map((row) => [String(row.id), row]));
  const storedById = optionStoredIdsById(tracker, candidates.sameProduct);
  const sameProduct = {
    trackers: plan.siblings.map((sibling) => ({
      id: sibling.id,
      keyword: sibling.keyword,
      status: sibling.status,
      groupName: siblingGroups.get(sibling.id)?.groupName || DEFAULT_RANK_GROUP,
      primaryProductId: sibling.primaryProductId,
      relation: sibling.relation,
      optionProductCount: sibling.before.length,
      beforeOptionProductIds: sibling.before,
      afterOptionProductIds: sibling.after,
      addedCount: sibling.addedCount,
      removedCount: sibling.removedCount,
      optionCheckedAt: candidates.checkedAtReady
        ? optionCheckedAtIso(sameProductRowsById.get(String(sibling.id))?.option_checked_at)
        : null,
    })),
    siblingOptionProductIds: suggestions,
    shrinkingTrackerCount: plan.siblings.filter((sibling) => sibling.removedCount > 0).length,
    limit: OPTION_SAME_PRODUCT_TRACKERS_MAX,
  };
  const targetTrackerIds = plan.targets.map((target) => target.id);
  // 미리 보기 때 본 저장값(B4). 함께 적용 체크와 상관없이 이 추적과 같은 대표 번호 추적을 모두 싣는다(화면이 체크를 바꿔도
  // 다시 받지 않게). 칸을 못 읽었으면 null.
  const expectedOptionProductIds = {};
  for (const id of [tracker.id, ...plan.siblings.map((sibling) => sibling.id)]) {
    expectedOptionProductIds[id] = storedById.get(String(id)) ?? null;
  }
  const common = {
    columnReady: self.columnReady,
    tracker: {
      id: tracker.id,
      keyword: tracker.keyword,
      primaryProductId: eligibility.primaryProductId,
      productUrl: tracker.product_url || "",
      optionProductIds: currentIds,
      optionCheckedAt: self.checkedAtReady ? optionCheckedAtIso(tracker.option_checked_at) : null,
    },
    parsed,
    sameProduct,
    applyToSameProduct,
    willUpdateCount: plan.targets.length,
    targetTrackerIds,
    removedOptionProductIds: mode === "read" ? [] : plan.removedOptionProductIds,
    limit: OPTION_PRODUCT_IDS_MAX,
    // 옵션 확인일(B6). checkedAtReady:false = 확인일 칸을 읽지 못함(대표 SQL 전) — 화면은 '확인만 기록'을 숨긴다.
    checkedAtReady: self.checkedAtReady,
    expectedOptionProductIds,
  };
  const view = clientActor ? clientOptionCommon(common) : common;

  if (mode === "read") {
    return json(request, { ok: true, mode, ...view, message: `그룹상품 번호 ${currentIds.length}개` });
  }
  // 다른 상품 목록 차단(모든 역할, 2026-11-01). 미리 보기는 알려 주기만 하고, 저장은 아래에서 쓰기 전에 409 로 막는다.
  const guard = optionListGuard({
    parsed,
    targets: plan.targets,
    sourcePageId,
    primaryProductId: eligibility.primaryProductId,
    relatedRows: candidates.suggestionRows,
  });
  if (mode === "preview") {
    const rejectedLabel = parsed.rejected.length ? ` · 받지 않은 칸 ${parsed.rejected.length}개` : "";
    return json(request, {
      ok: true,
      mode,
      ...view,
      guard,
      message: `번호 ${optionIds.length}개 · 함께 바뀌는 추적 ${plan.targets.length}개${rejectedLabel}`,
    });
  }

  // save
  // '확인만 기록'(B6, checkOnly:true): 번호는 그대로 두고 옵션 확인일만 남긴다. 전체 확인(fullReview)일 때만 받는다.
  // 광고주는 fullReview 를 무시한다(확인일을 찍지 않는다) — 대신 목록이 실제로 바뀌는 추적의 확인일을 비운다(아래 갱신).
  const checkOnly = body.checkOnly === true;
  const fullReview = !clientActor && body.fullReview === true;
  if (checkOnly && !fullReview) {
    return optionEditError(
      request,
      400,
      "RANK_OPTION_CHECK_ONLY_INVALID",
      "확인만 기록 요청이 올바르지 않습니다. 화면을 새로 고친 뒤 다시 시도해주세요.",
    );
  }
  if (parsed.rejected.length) {
    return optionEditError(
      request,
      400,
      "RANK_OPTION_INPUT_REJECTED",
      "받지 않은 칸이 있어 저장하지 않았습니다. 미리 보기에서 빨간 칸을 지운 뒤 다시 저장해주세요.",
      { parsed },
    );
  }
  if (!self.columnReady) {
    return optionEditError(
      request,
      409,
      "RANK_OPTION_NOT_READY",
      "그룹상품 번호 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요.",
    );
  }
  if (Array.isArray(body.expectedTrackerIds)) {
    const expected = [...new Set(body.expectedTrackerIds.map((id) => normalizeText(id).toLowerCase()))].sort();
    const actual = [...new Set(targetTrackerIds.map((id) => String(id).toLowerCase()))].sort();
    if (expected.join(",") !== actual.join(",")) {
      return optionEditError(
        request,
        409,
        "RANK_OPTION_TARGETS_CHANGED",
        "미리 보기 뒤에 함께 바뀌는 추적이 달라졌습니다. 다시 미리 보기 해주세요.",
        { targetTrackerIds },
      );
    }
  }

  // 동시 변경 보호(B4): 미리 보기 때 본 저장값이 없으면(옛 화면) 저장하지 않고, 지금 값과 다르면 쓰기 전에 거절한다.
  const expectedById = expectedOptionProductIdsMap(body.expectedOptionProductIds);
  if (plan.targets.some((target) => optionIdsArrayLiteral(expectedById.get(String(target.id).toLowerCase())) === null)) {
    return optionEditError(request, 409, "RANK_OPTION_PREVIEW_REQUIRED", "화면을 새로 고친 뒤 다시 미리 보기 해주세요.");
  }
  if (plan.targets.some((target) => !Array.isArray(storedById.get(String(target.id))))) {
    // 함께 바뀌는 추적의 옵션 칸을 못 읽었다(칸 없음 경합). 쓰기 조건을 만들 수 없어 쓰지 않는다.
    return optionEditError(
      request,
      409,
      "RANK_OPTION_NOT_READY",
      "그룹상품 번호 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요.",
    );
  }
  if (plan.targets.some((target) => !sameOptionIdList(
    expectedById.get(String(target.id).toLowerCase()),
    storedById.get(String(target.id)),
  ))) {
    return optionEditError(request, 409, "RANK_OPTION_CHANGED", "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요.");
  }
  // 다른 상품 목록 차단(§2.3): 동시 변경 검사 뒤·되돌림 기록 전. 아무것도 쓰지 않는다.
  if (guard.blocked) {
    return optionEditError(
      request,
      409,
      "RANK_OPTION_FOREIGN_LIST",
      optionGuardMessage(guard, eligibility.primaryProductId),
      { guard },
    );
  }
  if (guard.needsPrimaryConfirm && body.primaryConfirmed !== true) {
    return optionEditError(
      request,
      409,
      "RANK_OPTION_PRIMARY_CONFIRM_REQUIRED",
      `이 번호들이 상품 ${eligibility.primaryProductId} 의 그룹 옵션이 맞는지 확인한 뒤 저장해 주세요.`,
      { guard },
    );
  }
  if (checkOnly) {
    // 확인일 칸이 없으면(대표 SQL 전) '확인만 기록'은 남길 것이 없다.
    if (!self.checkedAtReady) {
      return optionEditError(request, 409, "RANK_OPTION_NOT_READY", OPTION_CHECKED_NOT_READY_MESSAGE);
    }
    // 대상마다 저장된 번호(정리한 목록 = target.before)와 이번 목록이 집합으로 같을 때만 — 다르면 번호가 바뀌는 저장이다.
    if (plan.targets.some((target) => !sameOptionIdSet(target.before, target.after))) {
      return optionEditError(
        request,
        409,
        "RANK_OPTION_CHECK_ONLY_MISMATCH",
        "번호가 저장된 것과 달라 확인만 기록할 수 없습니다. 미리 보기 한 뒤 저장해주세요.",
      );
    }
    // 번호가 없는 추적에는 확인일을 남기지 않는다(아래 조건부 갱신과 같은 규칙) — 이 추적에 번호가 없으면 기록할 것이 없다.
    if (!plan.selfTarget.after.length) {
      return optionEditError(
        request,
        400,
        "RANK_OPTION_CHECK_ONLY_INVALID",
        "저장된 그룹상품 번호가 없어 확인만 기록할 수 없습니다.",
      );
    }
  }

  // 광고주 저장 빈도(§2.2): 저장 직전(되돌림 기록 전). 세지 못하면 저장하지 않는다.
  if (clientActor) {
    if (!access.clientId) {
      return optionEditError(request, 403, "RANK_OPTION_FORBIDDEN", "그룹상품 번호는 관리자 화면에서만 바꿀 수 있습니다.");
    }
    const recent = await optionClientRecentSaveCount(ctx, access.clientId);
    if (!recent.ok) {
      optionAuditFailedWarning("rate", recent.error);
      return optionEditError(
        request,
        409,
        "RANK_OPTION_AUDIT_FAILED",
        "저장 기록을 확인하지 못해 저장하지 않았습니다. 잠시 뒤 다시 저장해주세요.",
      );
    }
    if (recent.count >= OPTION_CLIENT_SAVE_LIMIT) {
      return optionEditError(request, 429, "RANK_OPTION_RATE_LIMITED", "잠시 뒤 다시 저장해 주세요.");
    }
  }

  // 되돌림 기록 먼저(B3): 바꿀 추적마다 저장 전·바꿀 목록 한 줄. 기록을 못 남기면 저장하지 않는다.
  // '확인만 기록'은 번호를 쓰지 않으므로 바꾼 뒤 목록도 저장값 그대로다.
  const intent = await recordOptionAuditLogs(ctx, plan.targets.map((target) => ({
    action: "naver_rank_options_save_intent",
    targetTable: "naver_rank_trackers",
    targetId: target.id,
    clientId: auditActor.clientId,
    metadata: {
      before: storedById.get(String(target.id)),
      after: checkOnly ? storedById.get(String(target.id)) : target.after,
      fullReview,
      ...(checkOnly ? { checkOnly: true } : {}),
      applyToSameProduct,
      primaryProductId: target.primaryProductId,
      keyword: target.keyword,
      ...auditActor.metadata,
    },
  })));
  if (!intent.logged) {
    optionAuditFailedWarning("intent", intent.error);
    return optionEditError(
      request,
      409,
      "RANK_OPTION_AUDIT_FAILED",
      "되돌림 기록을 남기지 못해 저장하지 않았습니다. 잠시 뒤 다시 저장해주세요.",
    );
  }

  // 조건부 갱신(B4): 미리 보기 때 저장값과 같을 때만 쓴다. 확인일(B6)은 전체 목록을 보고 저장한 경우(fullReview)에만, 번호와
  // 같은 문장으로 쓴다 — 추적마다 둘 다 되거나 둘 다 안 된다. 후보 넣기 저장(fullReview:false)은 확인일을 바꾸지 않는다.
  // 번호를 모두 지우는 묶음(바꿀 목록이 빈 목록)에는 확인일을 남기지 않는다 — 확인할 옵션이 없다.
  // '확인만 기록'은 확인일 한 칸만 쓴다(번호를 다시 쓰면 저장 순서가 정리된 순서로 바뀐다). 쓰기 조건은 같다.
  // 광고주 저장(2026-11-01)은 확인일을 찍지 않고, 목록이 실제로 바뀌는(집합이 달라지는) 추적만 같은 문장에서 확인일을 비운다
  // (운영팀 확인일이 남아 '확인됨'처럼 보이지 않게). 안 바뀌는 추적의 확인일은 건드리지 않는다.
  const checkedAt = new Date().toISOString();
  let writeCheckedAt = fullReview && self.checkedAtReady;
  let clearCheckedAt = clientActor && !checkOnly && self.checkedAtReady;
  const stampsCheckedAt = (group) => writeCheckedAt && group.after.length > 0;
  const clearsCheckedAt = (group) => clearCheckedAt && group.listChanged === true;
  const updateValues = (group, withCheckedAt) => {
    if (checkOnly) return { option_checked_at: checkedAt };
    return withCheckedAt
      ? { option_product_ids: group.after, option_checked_at: clientActor ? null : checkedAt }
      : { option_product_ids: group.after };
  };
  const updateGroup = (group, withCheckedAt) => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update(updateValues(group, withCheckedAt))
    .in("id", group.ids)
    .in("agency_code", scope)
    .eq("product_id", group.productId)
    .eq("option_product_ids", group.expectedLiteral)
    .select("id");
  // 갱신 호출이 던진 예외는 결과를 모르는 오류로 돌려준다(H1) — 요청이 DB 에 닿아 이미 썼을 수 있다.
  const runUpdateGroup = async (group, withCheckedAt) => {
    try {
      const { data, error } = await updateGroup(group, withCheckedAt);
      return { data, error, thrown: false };
    } catch (thrownError) {
      return { data: null, error: thrownError || new Error("option_update_threw"), thrown: true };
    }
  };
  const updatedTrackerIds = [];
  // 실제로 확인일까지 쓴 추적. 중간에 확인일 칸 없음으로 바뀌어도 이미 쓴 묶음은 여기에 남는다.
  const checkedTrackerIds = [];
  // 쓰기 오류가 확실한 DB 거절이 아니어서(코드 없음·연결류·예외) 저장됐는지 모르는 추적(H1).
  const uncertainTrackerIds = [];
  // 광고주 저장으로 확인일을 비운 추적.
  const checkedClearedTrackerIds = [];
  let failure = null;
  const resultRecord = () => ({
    updatedTrackerIds,
    checkedTrackerIds,
    uncertainTrackerIds,
    checkedClearedTrackerIds,
    targetCount: plan.targets.length,
    checkedAtRecorded: checkedTrackerIds.length > 0,
    fullReview,
    checkOnly,
  });
  const listChangedOf = clientActor ? (target) => !sameOptionIdSet(target.before, target.after) : () => false;
  try {
    for (const group of optionTargetGroups(plan.targets, storedById, listChangedOf)) {
      let withCheckedAt = stampsCheckedAt(group) || clearsCheckedAt(group);
      // '확인만 기록'에서 확인일을 남기지 않는 묶음(번호 없는 추적)은 쓸 것이 없다.
      if (checkOnly && !withCheckedAt) continue;
      // eslint-disable-next-line no-await-in-loop
      let { data, error, thrown } = await runUpdateGroup(group, withCheckedAt);
      // 확인일 칸만 없으면(대표 SQL 전) 확인일 없이 같은 조건부 갱신을 한 번 더 한다. CHECK 위반(23514)은 먼저 거른다.
      // '확인만 기록'은 확인일 말고 쓸 것이 없어 다시 하지 않는다(아래에서 409).
      if (error && !thrown && withCheckedAt && !checkOnly && String(error.code || "") !== "23514"
        && isOptionCheckedColumnMissingError(error)) {
        rememberOptionCheckedColumnMissing("rank-tracker-options-save");
        writeCheckedAt = false;
        clearCheckedAt = false;
        withCheckedAt = false;
        // eslint-disable-next-line no-await-in-loop
        ({ data, error, thrown } = await runUpdateGroup(group, false));
      }
      if (error && (thrown || !isDefiniteOptionWriteRejection(error))) {
        // 이 묶음은 썼는지 모른다. 남은 묶음은 쓰지 않고, 확인된 저장·모르는 추적을 응답과 결과 기록에 나눠 남긴다.
        uncertainTrackerIds.push(...group.ids);
        console.warn(JSON.stringify({
          level: "warn",
          event: "naver_rank_tracker_options_uncertain",
          updatedCount: updatedTrackerIds.length,
          uncertainCount: uncertainTrackerIds.length,
          targetCount: plan.targets.length,
          thrown,
          errorType: safeRankErrorType(error),
          errorCode: safeRankErrorCode(error),
        }));
        const savedLabel = updatedTrackerIds.length
          ? `추적 ${plan.targets.length}개 중 ${updatedTrackerIds.length}개를 저장했습니다.`
          : "저장 중 오류가 났습니다.";
        failure = {
          code: "RANK_OPTION_PARTIAL",
          message: `${savedLabel} 추적 ${uncertainTrackerIds.length}개는 저장됐는지 확인하지 못했습니다. 편집창을 다시 열어 확인해주세요.`,
          extra: { updatedTrackerIds, uncertainTrackerIds },
        };
        break;
      }
      if (error) {
        if (updatedTrackerIds.length) {
          console.warn(JSON.stringify({
            level: "warn",
            event: "naver_rank_tracker_options_partial",
            updatedCount: updatedTrackerIds.length,
            targetCount: plan.targets.length,
          }));
          // 같은 저장값으로 다시 저장하면 이미 저장된 추적의 조건(저장값)이 맞지 않아 늘 거절된다 — 다시 미리 보기부터.
          failure = {
            code: "RANK_OPTION_PARTIAL",
            message: `추적 ${plan.targets.length}개 중 ${updatedTrackerIds.length}개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요.`,
            extra: { updatedTrackerIds },
          };
          break;
        }
        // CHECK 위반(23514)을 칸 없음 판정보다 먼저 거른다 — 제약 이름에 option_product_ids 가 들어 있어
        // 칸 없음으로 잘못 보면 이 함수 인스턴스의 워커 submit 이 10분 동안 옵션을 무시한다.
        if (String(error.code || "") === "23514") {
          failure = { code: "RANK_OPTION_INVALID", message: "그룹상품 번호 형식을 DB 가 받지 않았습니다. 다시 미리 보기 해주세요." };
          break;
        }
        if (checkOnly && isOptionCheckedColumnMissingError(error)) {
          rememberOptionCheckedColumnMissing("rank-tracker-options-check");
          failure = { code: "RANK_OPTION_NOT_READY", message: OPTION_CHECKED_NOT_READY_MESSAGE };
          break;
        }
        if (isOptionColumnMissingError(error)) {
          rememberOptionColumnMissing("rank-tracker-options-save");
          failure = {
            code: "RANK_OPTION_NOT_READY",
            message: "그룹상품 번호 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요.",
          };
          break;
        }
        throw error;
      }
      const groupUpdatedIds = (data || []).map((row) => row.id);
      updatedTrackerIds.push(...groupUpdatedIds);
      if (withCheckedAt && clientActor) checkedClearedTrackerIds.push(...groupUpdatedIds);
      else if (withCheckedAt) checkedTrackerIds.push(...groupUpdatedIds);
      if (groupUpdatedIds.length < group.ids.length) {
        // 미리 보기 뒤 누가 먼저 바꿨다. 남은 추적은 쓰지 않고, 이미 바뀐 추적은 응답과 결과 기록에 남긴다.
        console.warn(JSON.stringify({
          level: "warn",
          event: "naver_rank_tracker_options_changed",
          updatedCount: updatedTrackerIds.length,
          targetCount: plan.targets.length,
        }));
        failure = {
          code: "RANK_OPTION_CHANGED",
          message: "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요.",
          extra: { updatedTrackerIds },
        };
        break;
      }
    }
  } catch (error) {
    await recordOptionSaveResult(ctx, tracker.id, { ...resultRecord(), outcome: "error" }, auditActor);
    throw error;
  }
  const checkedAtRecorded = resultRecord().checkedAtRecorded;
  await recordOptionSaveResult(ctx, tracker.id, { ...resultRecord(), outcome: failure?.code || "saved" }, auditActor);
  if (failure) return optionEditError(request, 409, failure.code, failure.message, failure.extra);
  console.log(JSON.stringify({
    level: "info",
    event: "naver_rank_tracker_options_saved",
    trackerCount: updatedTrackerIds.length,
    optionCount: optionIds.length,
    ...(checkOnly ? { checkOnly: true } : {}),
  }));
  let message = optionIds.length
    ? `그룹상품 번호 ${optionIds.length}개를 추적 ${updatedTrackerIds.length}개에 저장했습니다. 다음 순위 확인부터 적용됩니다.`
    : `그룹상품 번호를 지웠습니다(추적 ${updatedTrackerIds.length}개). 다음 순위 확인부터 대표 상품번호만 찾습니다.`;
  if (checkOnly) message = `옵션 확인일을 기록했습니다(추적 ${checkedTrackerIds.length}개). 번호는 그대로입니다.`;
  return json(request, {
    ok: true,
    mode,
    updatedCount: updatedTrackerIds.length,
    updatedTrackerIds,
    optionProductIds: optionIds,
    removedOptionProductIds: plan.removedOptionProductIds,
    checkedAtRecorded,
    optionCheckedAt: checkedAtRecorded ? checkedAt : null,
    message,
  });
}

// ───────────────────── N30 그룹상품 표시 (2026-10-27 A안, 관리자 화면 전용) ─────────────────────
// 카드의 '그룹상품으로 표시' 버튼. 한 번 누르면 같은 광고주 범위·같은 대표 상품번호(product_id)의 활성·일시중지 상품 기준
// 추적에 모두 적용하고, 다시 누르면 모두 끈다. group_product_marked 한 칸만 바꾼다 — 순위 확인 시각·임대·깨우기·네이버
// 요청 0, 넣은 옵션 번호·지난 기록은 그대로. 칸이 없으면(대표 SQL 전) 409 이고 화면은 버튼을 숨긴다. 오류는 모두 4xx.
async function readGroupMarkTrackerRows(build) {
  const result = await build(`${OPTION_TRACKER_COLUMNS}, group_product_marked`);
  if (!result.error) {
    forgetGroupMarkColumnMissing();
    return { data: result.data, columnReady: true };
  }
  if (!isGroupMarkColumnMissingError(result.error)) throw result.error;
  rememberGroupMarkColumnMissing("rank-tracker-group-mark");
  return { data: null, columnReady: false };
}

function groupMarkNotReady(request) {
  return optionEditError(
    request,
    409,
    "RANK_GROUP_MARK_NOT_READY",
    "그룹상품 표시 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요.",
  );
}

async function handleTrackerGroupMark(request, ctx, body, access) {
  if (optionEditForbidden(request, access)) {
    return optionEditError(request, 403, "RANK_GROUP_MARK_FORBIDDEN", "그룹상품 표시는 관리자 화면에서만 바꿀 수 있습니다.");
  }
  const trackerId = normalizeText(body.trackerId || body.id).toLowerCase();
  if (!OPTION_TRACKER_ID_PATTERN.test(trackerId)) {
    return optionEditError(request, 400, "RANK_OPTION_TRACKER_REQUIRED", "trackerId가 필요합니다.");
  }
  if (typeof body.marked !== "boolean") {
    return optionEditError(request, 400, "RANK_GROUP_MARK_INVALID", "켜기·끄기 값(marked)이 필요합니다.");
  }
  const marked = body.marked;
  const scope = agencyCodeScope(access.agencyCode);
  const self = await readGroupMarkTrackerRows((columns) => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(columns)
    .eq("id", trackerId)
    .in("agency_code", scope)
    .maybeSingle());
  if (!self.columnReady) return groupMarkNotReady(request);
  const tracker = self.data;
  if (!tracker) {
    return optionEditError(request, 404, "RANK_OPTION_TRACKER_NOT_FOUND", "추적 항목을 찾을 수 없습니다.");
  }
  const eligibility = trackerOptionEligibility(tracker);
  if (eligibility.reason === "catalog_tracker") {
    return optionEditError(
      request,
      409,
      "RANK_OPTION_CATALOG_TRACKER",
      "원부(가격비교) 추적은 그룹상품으로 표시할 수 없습니다. 원부 순위는 원부 번호로 따로 추적하세요.",
    );
  }
  if (!eligibility.eligible) {
    return optionEditError(
      request,
      409,
      "RANK_OPTION_PRIMARY_INVALID",
      "대표 상품번호를 확인할 수 없는 추적은 그룹상품으로 표시할 수 없습니다. 상품 URL·상품번호를 확인해주세요.",
    );
  }
  const siblings = await readGroupMarkTrackerRows((columns) => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(columns)
    .in("agency_code", scope)
    .in("status", ["active", "paused"])
    .eq("product_id", eligibility.primaryProductId)
    .limit(OPTION_SAME_PRODUCT_TRACKERS_MAX + 2));
  if (!siblings.columnReady) return groupMarkNotReady(request);
  const targetIds = [trackerId];
  for (const row of siblings.data || []) {
    const id = String(row?.id || "").toLowerCase();
    if (!id || targetIds.includes(id) || !trackerOptionEligibility(row).eligible) continue;
    targetIds.push(id);
  }
  if (targetIds.length > OPTION_SAME_PRODUCT_TRACKERS_MAX + 1) {
    return optionEditError(
      request,
      400,
      "RANK_OPTION_TOO_MANY_TRACKERS",
      `함께 바꿀 추적이 ${OPTION_SAME_PRODUCT_TRACKERS_MAX}개를 넘습니다. 운영팀에 알려주세요.`,
    );
  }
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({ group_product_marked: marked })
    .in("id", targetIds)
    .in("agency_code", scope)
    .eq("product_id", eligibility.primaryProductId)
    .select("id");
  if (error) {
    if (isGroupMarkColumnMissingError(error)) {
      rememberGroupMarkColumnMissing("rank-tracker-group-mark-save");
      return groupMarkNotReady(request);
    }
    throw error;
  }
  const updatedTrackerIds = (data || []).map((row) => row.id);
  console.log(JSON.stringify({
    level: "info",
    event: "naver_rank_tracker_group_mark_saved",
    trackerCount: updatedTrackerIds.length,
    marked,
  }));
  const count = updatedTrackerIds.length;
  return json(request, {
    ok: true,
    marked,
    updatedCount: count,
    updatedTrackerIds,
    message: marked
      ? `그룹상품으로 표시했습니다(같은 상품 추적 ${count}개). 다음 순위 확인부터 대표 상품번호가 결과에 없으면 같은 스토어 후보를 찾습니다.`
      : `그룹상품 표시를 껐습니다(같은 상품 추적 ${count}개). 후보 찾기를 멈춥니다. 그룹상품 번호를 넣은 추적은 번호가 있는 동안 계속 그룹상품입니다. 넣은 번호와 지난 기록은 그대로입니다.`,
  });
}

// ───────────────────── N30 옵션 확인 버튼 받는 쪽 (2026-11-01, 명세 advertiser-impl-spec §2.5) ─────────────────────
// options-locate: 총관리자 새 탭은 광고주 선택이 비어 있으므로 버튼이 넘긴 상품번호로 광고주·추적을 찾는다(읽기 전용).
// 광고주 범위를 가리지 않으므로 총관리자 세션에만 연다. 네이버 요청 0.
const OPTION_LOCATE_PRODUCT_IDS_MAX = 52;
const OPTION_LOCATE_ITEMS_MAX = 50;
const OPTION_LOCATE_COLUMNS = "id, agency_code, keyword, status, product_id";

function optionLocateRowOrder(left, right) {
  const agency = String(left.agency_code || "").localeCompare(String(right.agency_code || ""));
  if (agency !== 0) return agency;
  const keyword = normalizeText(left.keyword).localeCompare(normalizeText(right.keyword), "ko");
  if (keyword !== 0) return keyword;
  return String(left.id || "").localeCompare(String(right.id || ""));
}

async function optionLocateAdvertiserNames(ctx, agencyCodes) {
  const names = new Map();
  if (!agencyCodes.length) return names;
  try {
    const { data, error } = await ctx.supabaseAdmin
      .from("clients")
      .select("agency_code, name")
      .in("agency_code", agencyCodes);
    if (error) return names;
    for (const row of data || []) {
      const code = normalizeAgencyCode(row?.agency_code);
      const name = normalizeText(row?.name);
      if (code && name && !names.has(code)) names.set(code, name);
    }
  } catch {
    // 광고주 이름은 보조 정보다. 못 읽으면 null 로 둔다.
  }
  return names;
}

async function handleTrackerOptionsLocate(request, ctx, body, access) {
  if (optionActorRole(access, request.headers) !== "owner" || access.admin !== true) {
    return optionEditError(request, 403, "RANK_OPTION_LOCATE_FORBIDDEN", "총관리자만 쓸 수 있는 작업입니다.");
  }
  const raw = body.productIds;
  if (!Array.isArray(raw)
    || raw.length < 1
    || raw.length > OPTION_LOCATE_PRODUCT_IDS_MAX
    || !raw.every((id) => typeof id === "string" && OPTION_PAGE_ID_PATTERN.test(id.trim()))) {
    return optionEditError(
      request,
      400,
      "RANK_OPTION_LOCATE_INVALID",
      `상품번호는 5~20자리 숫자 1~${OPTION_LOCATE_PRODUCT_IDS_MAX}개여야 합니다.`,
    );
  }
  const productIds = [...new Set(raw.map((id) => id.trim()))];
  const limit = OPTION_LOCATE_ITEMS_MAX + 1;
  const base = () => ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(OPTION_LOCATE_COLUMNS)
    .in("status", ["active", "paused"]);
  const byProduct = await base().in("product_id", productIds).limit(limit);
  if (byProduct.error) throw byProduct.error;
  // 대표 번호가 아닌 옵션 번호로만 맞는 추적. 옵션 칸이 없으면(대표 SQL 전) 대표 번호로 맞는 것만 쓴다.
  let byOption = await base().overlaps("option_product_ids", productIds).limit(limit);
  if (byOption.error) {
    if (!isOptionColumnMissingError(byOption.error)) throw byOption.error;
    rememberOptionColumnMissing("rank-tracker-options-locate");
    byOption = { data: [] };
  }
  const seen = new Set();
  const take = (rows) => [...(rows || [])]
    .filter((row) => {
      const id = String(row?.id || "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort(optionLocateRowOrder);
  // 대표 번호로 맞는 추적을 먼저 싣는다(잘릴 때 더 직접적인 쪽을 남긴다).
  const rows = [...take(byProduct.data), ...take(byOption.data)];
  const kept = rows.slice(0, OPTION_LOCATE_ITEMS_MAX);
  const names = await optionLocateAdvertiserNames(
    ctx,
    [...new Set(kept.map((row) => String(row.agency_code || "")).filter(Boolean))],
  );
  return json(request, {
    ok: true,
    items: kept.map((row) => ({
      agencyCode: canonicalAgencyCode(row.agency_code),
      advertiserName: names.get(normalizeAgencyCode(row.agency_code)) || null,
      trackerId: row.id,
      keyword: normalizeText(row.keyword),
      productId: normalizeText(row.product_id),
    })),
    truncated: rows.length > OPTION_LOCATE_ITEMS_MAX,
  });
}

// options-diag: 버튼이 '확인 못 함'일 때 넘긴 진단을 정해진 형식으로 다시 만들어 남긴다(형식 밖 칸·값은 버린다).
// 화면은 진단을 그리지 않는다. 범위(광고주, 없으면 역할+범위)당 하루(24시간) 30건까지만 쓰고 넘치면 조용히 버린다.
const OPTION_DIAG_PATTERN = /^[A-Za-z0-9_-]{1,2000}$/u;
const OPTION_DIAG_REASON_CODES = new Set([
  "source_unreadable",
  "traversal_cap",
  "ambiguous",
  "group_list_split",
  "mixed_id_keys",
  "unrecognized_items",
  "unsafe_number",
  "digit_length",
  "too_many",
  "no_group_list",
  "group_list_without_current",
  "not_found",
]);
const OPTION_DIAG_VERSION_PATTERN = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u;
const OPTION_DIAG_COUNT_KEY_PATTERN = /^[A-Za-z]{1,24}$/u;
const OPTION_DIAG_COUNTS_MAX = 8;
const OPTION_DIAG_COUNT_VALUE_MAX = 10_000_000;
const OPTION_DIAG_KEY_PATTERN = /^[A-Za-z0-9_#.-]{1,40}$/u;
const OPTION_DIAG_KEYS_MAX = 20;
const OPTION_DIAG_DAILY_LIMIT = 30;
const OPTION_DIAG_WINDOW_MS = 24 * 60 * 60_000;

function isPlainOptionDiagObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function rebuildOptionCheckDiag(raw) {
  const unparsed = { reason: "unparsed" };
  if (typeof raw !== "string" || !OPTION_DIAG_PATTERN.test(raw)) return unparsed;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return unparsed;
  }
  if (!isPlainOptionDiagObject(decoded)) return unparsed;
  const diag = {};
  if (typeof decoded.v === "string" && OPTION_DIAG_VERSION_PATTERN.test(decoded.v)) diag.v = decoded.v;
  diag.reason = typeof decoded.reason === "string" && OPTION_DIAG_REASON_CODES.has(decoded.reason) ? decoded.reason : "unparsed";
  const counts = {};
  if (isPlainOptionDiagObject(decoded.counts)) {
    for (const [key, value] of Object.entries(decoded.counts)) {
      if (Object.keys(counts).length >= OPTION_DIAG_COUNTS_MAX) break;
      if (!OPTION_DIAG_COUNT_KEY_PATTERN.test(key) || Object.hasOwn(counts, key)) continue;
      if (!Number.isSafeInteger(value) || value < 0 || value > OPTION_DIAG_COUNT_VALUE_MAX) continue;
      counts[key] = value;
    }
  }
  diag.counts = counts;
  const keys = [];
  if (Array.isArray(decoded.keys)) {
    for (const entry of decoded.keys) {
      if (keys.length >= OPTION_DIAG_KEYS_MAX) break;
      if (typeof entry !== "string") continue;
      // 숫자 5자리 이상(상품번호 등)은 버튼이 이미 가렸지만 서버에서도 한 번 더 가린다.
      const masked = entry.replace(/[0-9]{5,}/gu, "#n");
      if (OPTION_DIAG_KEY_PATTERN.test(masked)) keys.push(masked);
    }
  }
  diag.keys = keys;
  return diag;
}

// 대행사 코드는 접속 코드를 겸해 기록에 남기지 않는다(sanitizeAuditMetadata 도 agencyCode 칸을 지운다).
// 광고주 범위는 client_id 로 세고, 광고주가 없는 범위(총관리자 본 범위·세션 없는 관리자 코드)만 하루 상한을 셀 표식을 남긴다.
// 표식은 서버 세션 비밀값(MI_SESSION_SECRET)으로 만든 HMAC 앞 16자다 — 비밀 없는 해시는 짧은 코드가 금방 되돌려진다.
// 비밀값이 없으면 표식을 남기지 않고 역할로만 센다(상한이 더 빡빡해질 뿐 코드는 남지 않는다).
function optionDiagScopeHash(agencyCode, env = process.env) {
  const secret = String(env.MI_SESSION_SECRET || "");
  if (!secret) return "";
  return crypto
    .createHmac("sha256", secret)
    .update(`naver-rank-option-diag:${canonicalAgencyCode(agencyCode)}`)
    .digest("hex")
    .slice(0, 16);
}

async function optionDiagRecentCount(ctx, { clientId, actorRole, scopeHash }, nowMs = Date.now()) {
  try {
    let query = ctx.supabaseAdmin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("action", "naver_rank_option_check_refused")
      .gt("created_at", new Date(nowMs - OPTION_DIAG_WINDOW_MS).toISOString());
    if (clientId) query = query.eq("client_id", clientId);
    else {
      query = query.eq("metadata->>actorRole", actorRole);
      if (scopeHash) query = query.eq("metadata->>scopeHash", scopeHash);
    }
    const { count, error } = await query;
    if (error || !Number.isFinite(count)) return { ok: false, error: error || new Error("option_diag_count_missing") };
    return { ok: true, count };
  } catch (error) {
    return { ok: false, error };
  }
}

async function handleTrackerOptionsDiag(request, ctx, body, access) {
  const actorRole = optionActorRole(access, request.headers);
  if (!actorRole || !optionEditAllowed(access, request.headers)) {
    return optionEditError(request, 403, "RANK_OPTION_FORBIDDEN", "그룹상품 번호는 관리자 화면에서만 바꿀 수 있습니다.");
  }
  const page = optionPageIdValue(body.pageId);
  if (!page.ok || !page.value) {
    return optionEditError(request, 400, "RANK_OPTION_DIAG_INVALID", "상품번호가 올바르지 않습니다.");
  }
  const clientId = access.clientId || null;
  const scopeHash = clientId ? "" : optionDiagScopeHash(access.agencyCode);
  const recent = await optionDiagRecentCount(ctx, { clientId, actorRole, scopeHash });
  if (!recent.ok || recent.count >= OPTION_DIAG_DAILY_LIMIT) {
    if (!recent.ok) optionAuditFailedWarning("diag-count", recent.error);
    return json(request, { ok: true, recorded: false });
  }
  const logged = await recordOptionAuditLogs(ctx, [{
    action: "naver_rank_option_check_refused",
    targetTable: "naver_rank_trackers",
    targetId: null,
    clientId,
    metadata: { actorRole, pageId: page.value, ...(scopeHash ? { scopeHash } : {}), diag: rebuildOptionCheckDiag(body.diag) },
  }]);
  if (!logged.logged) {
    optionAuditFailedWarning("diag", logged.error);
    return json(request, { ok: true, recorded: false });
  }
  return json(request, { ok: true, recorded: true });
}

async function handlePost(request, ctx) {
  const body = await request.json().catch(() => ({}));
  const action = normalizeText(body.action || "create");

  if (action === "run-due") {
    return json(request, {
      ok: false,
      message: "자동 갱신은 크론 전용 API에서만 실행할 수 있습니다.",
    }, 403);
  }

  const access = await requireRankAccess(request, ctx, body);
  if (!access.ok) return access.response;
  body.agencyCode = access.agencyCode;

  if (SHOPPING_WORKER_CONTROL_ACTIONS.has(action)) {
    return controlShoppingWorker(request, ctx, body, access);
  }

  if (action === "create") return createTracker(request, ctx, body, access);
  if (action === "check") return checkOne(request, ctx, body, access);
  if (action === "queue-refresh-all") return queueRefreshAllTrackers(request, ctx, access);
  if (action === "sync-due") return syncDueTrackers(request, ctx, body, access);
  if (action === "stop") return stopTracker(request, ctx, body, access);
  if (action === "delete") return deleteTracker(request, ctx, body);
  if (action === "group") return updateTrackerGroup(request, ctx, body, access);
  if (action === "move") return moveTracker(request, ctx, body);
  if (action === "reorder") return reorderTrackers(request, ctx, body);
  if (action === "options") return handleTrackerOptions(request, ctx, body, access);
  if (action === "options-locate") return handleTrackerOptionsLocate(request, ctx, body, access);
  if (action === "options-diag") return handleTrackerOptionsDiag(request, ctx, body, access);
  if (action === "group-mark") return handleTrackerGroupMark(request, ctx, body, access);

  return json(request, { ok: false, message: "지원하지 않는 작업입니다." }, 400);
}

export async function handleRankTrackersRequest(request, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, {
    methods: "GET, POST, OPTIONS",
    headers: "authorization, content-type, x-demo-admin-code, x-mi-agency-code, x-mi-rank-access-code",
  }) });

  try {
    if (request.method === "GET") return await listTrackers(request, ctx);
    if (request.method === "POST") return await handlePost(request, ctx);
    return json(request, { ok: false, message: "Method not allowed" }, 405);
  } catch (error) {
    // 2026-09-11: this catch used to swallow the cause entirely, so every
    // tracker-page failure reached the person as the generic "서버 처리 중 오류"
    // with nothing in the function logs to investigate. Log a bounded, secret-
    // free record (the runtime's request id ties it to the response header) and
    // answer with a stable code so the page can say what actually happened.
    console.error(JSON.stringify({
      level: "error",
      event: "naver_rank_trackers_failed",
      requestId: rankTrackersRequestId(request),
      method: request.method,
      action: rankTrackersActionLabel(request),
      stage: String(error?.rankTrackerReadStage || "").slice(0, 24),
      errorType: safeRankErrorType(error),
      errorCode: safeRankErrorCode(error),
    }));
    return json(request, {
      ok: false,
      code: "NAVER_RANK_TRACKERS_FAILED",
      message: "순위 추적 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
    }, 500);
  }
}

function rankTrackersRequestId(request) {
  const supplied = String(request?.headers?.get?.("x-request-id") || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(supplied) ? supplied : "";
}

function rankTrackersActionLabel(request) {
  try {
    const url = new URL(request.url);
    const action = String(url.searchParams.get("action") || url.pathname.split("/").pop() || "").slice(0, 40);
    return /^[a-z0-9-]{1,40}$/u.test(action) ? action : "";
  } catch {
    return "";
  }
}

function safeRankErrorType(error) {
  const name = error instanceof Error ? String(error.name || "Error") : "UnknownError";
  return /^[A-Za-z]{1,40}$/u.test(name) ? name : "UnknownError";
}

function safeRankErrorCode(error) {
  const code = String(error?.code || "");
  return /^[A-Z0-9_]{1,32}$/u.test(code) ? code : "";
}

function rankTrackerReadError(error, stage) {
  if (error && typeof error === "object" && !error.rankTrackerReadStage) {
    try {
      Object.defineProperty(error, "rankTrackerReadStage", { value: stage, configurable: true });
    } catch {
      // The original error remains authoritative even when it is frozen.
    }
  }
  return error;
}

export default {
  fetch: withSupabase({ auth: "none" }, handleRankTrackersRequest),
};

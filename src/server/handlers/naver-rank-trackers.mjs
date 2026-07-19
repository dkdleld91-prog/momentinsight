import crypto from "node:crypto";
import { withSupabase } from "@supabase/server";
import { corsHeaders, isLocalRequest, protectedJson, safeEqual } from "../security.mjs";
import {
  extractProductId,
  findShoppingRank,
  hasShoppingRankConfig,
  isAdItem,
  normalizeText,
  shoppingRankConfig,
  shoppingRankMessage,
} from "./naver-shopping-rank.mjs";

const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const KEYWORD_VOLUME_CACHE_TTL_MS = Number(process.env.MI_RANK_KEYWORD_VOLUME_CACHE_TTL_MS || 1000 * 60 * 30);
const KEYWORD_VOLUME_CACHE_MAX = Number(process.env.MI_RANK_KEYWORD_VOLUME_CACHE_MAX || 300);
const RANK_TRACKER_LEASE_MS = Number(process.env.MI_RANK_TRACKER_LEASE_MS || 1000 * 60 * 12);
const DEFAULT_RANK_GROUP = "기본 그룹";
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

const SNAPSHOT_SELECT = [
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
  "top_items",
  "message",
  "source",
  "created_at",
].join(", ");

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

async function fetchSearchAdKeywordVolume(env, keyword) {
  const cached = getKeywordVolumeCache(keyword);
  if (cached) return cached;

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
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(payload?.errorMessage || payload?.message || "HTTP " + response.status);

    const list = Array.isArray(payload?.keywordList) ? payload.keywordList : [];
    const exact = list.find((item) => normalizeKeywordCompare(item.relKeyword) === normalizeKeywordCompare(keyword));
    const metric = exact ? searchVolumeMetric(exact.monthlyPcQcCnt, exact.monthlyMobileQcCnt) : null;
    const value = metric
      ? { value: metric.value, label: metric.label, status: metric.isUnderThreshold ? "range" : "ok" }
      : { value: null, label: "조회 필요", status: "not_found" };
    setKeywordVolumeCache(keyword, value);
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadKeywordVolumes(keywords) {
  const env = searchAdConfig();
  const result = new Map();
  const lookupLimit = Math.max(1, Math.min(100, Number(process.env.MI_RANK_KEYWORD_VOLUME_LOOKUP_LIMIT || 50)));
  const uniqueKeywords = [...new Set((keywords || []).map((keyword) => normalizeText(keyword)).filter(Boolean))];
  if (!hasSearchAdConfig(env)) return result;

  await Promise.all(uniqueKeywords.slice(0, lookupLimit).map(async (keyword) => {
    try {
      result.set(normalizeKeywordCompare(keyword), await fetchSearchAdKeywordVolume(env, keyword));
    } catch {
      result.set(normalizeKeywordCompare(keyword), { value: null, label: "조회 필요", status: "error" });
    }
  }));
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

export function requestAgencyCode(request, body = {}) {
  const url = new URL(request.url);
  const trustedSession = Boolean(request.headers.get("x-mi-session-role"));
  const trustedAgencyCode = request.headers.get("x-mi-agency-code") || "";
  return canonicalAgencyCode(
    trustedAgencyCode ||
      (trustedSession ? "" : (
      body.agencyCode ||
      body.agency_code ||
      url.searchParams.get("agencyCode") ||
      url.searchParams.get("agency_code")
      ))
  );
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

export const PRODUCT_RANK_TRACKER_MAX_RANK = 300;

function clampMaxRank() {
  return PRODUCT_RANK_TRACKER_MAX_RANK;
}

export function trackerPayload(row, snapshots = [], keywordVolume = null) {
  const recentSnapshots = (snapshots || []).filter(Boolean).slice(0, 30);
  const latestTrackingItem = recentSnapshots[0]?.item || {};
  return {
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
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    currentRank: row.current_rank,
    currentRankSource: latestTrackingItem.trackingRankSource || "",
    currentRankSourceLabel: latestTrackingItem.trackingRankSourceLabel || "",
    exactProductRank: latestTrackingItem.exactProductRank || null,
    relatedCatalogRank: latestTrackingItem.relatedCatalogRank || null,
    bestRank: row.best_rank,
    worstRank: row.worst_rank,
    checkCount: row.check_count,
    foundCount: row.found_count,
    lastMessage: row.last_message,
    lastError: row.last_error || null,
    retryCount: Number(row.retry_count || 0),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snapshots: recentSnapshots.map(snapshotPayload),
  };
}

function snapshotPayload(row) {
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
    item: row.item || null,
    message: row.message,
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

  const clientId = await findClientId(ctx, agencyCode);
  if (!clientId) {
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

async function loadSnapshots(ctx, trackerIds, limit = 5000) {
  if (!trackerIds.length) return new Map();

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_snapshots")
    .select(SNAPSHOT_SELECT)
    .in("tracker_id", trackerIds)
    .order("checked_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const grouped = new Map();
  (data || []).forEach((row) => {
    if (!grouped.has(row.tracker_id)) grouped.set(row.tracker_id, []);
    grouped.get(row.tracker_id).push(row);
  });
  return grouped;
}

async function loadTrackerGroups(ctx, trackerIds) {
  const ids = Array.from(new Set((trackerIds || []).filter(Boolean)));
  if (!ids.length) return new Map();

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id, group_name")
    .in("id", ids);

  if (error) {
    if (isMissingRankGroupColumn(error)) return new Map();
    throw error;
  }

  const groups = new Map();
  (data || []).forEach((row) => {
    groups.set(row.id, normalizeRankGroupName(row.group_name));
  });
  return groups;
}

async function attachTrackerGroups(ctx, rows) {
  const sourceRows = rows || [];
  if (!sourceRows.length) return sourceRows;
  const groups = await loadTrackerGroups(ctx, sourceRows.map((row) => row.id));
  return sourceRows.map((row) => ({
    ...row,
    group_name: groups.get(row.id) || normalizeRankGroupName(row.group_name),
  }));
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

async function listTrackers(request, ctx) {
  const url = new URL(request.url);
  const access = await requireRankAccess(request, ctx, {}, { read: true });
  if (!access.ok) return access.response;
  const agencyCode = access.agencyCode;
  const maxListLimit = access.admin && isPrimaryAgencyCode(agencyCode) ? 500 : 50;
  const limit = Math.max(1, Math.min(maxListLimit, Number(url.searchParams.get("limit") || 20)));

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .in("agency_code", agencyCodeScope(agencyCode))
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const rows = await attachTrackerGroups(ctx, data || []);
  const snapshots = await loadSnapshots(ctx, rows.map((row) => row.id));
  const keywordVolumes = await loadKeywordVolumes(rows.map((row) => row.keyword));
  return json(request, {
    ok: true,
    trackers: rows.map((row) => trackerPayload(row, snapshots.get(row.id) || [], keywordVolumes.get(normalizeKeywordCompare(row.keyword)))),
  });
}

async function insertSnapshot(ctx, tracker, checkedAt, result, message, source = "naver_shopping_search_api") {
  const safeResultItem = isOrganicTrackingItem(result?.item) ? result.item : {};
  const item = {
    ...safeResultItem,
    rankPolicy: "organic_only",
    adExcluded: true,
    excludedAdCount: Number(result?.excludedAdCount || 0),
    ...(result?.trackingRankSource ? {
      trackingRankSource: result.trackingRankSource,
      trackingRankSourceLabel: result.trackingRankSourceLabel,
      exactProductRank: result.exactProductRank || null,
      relatedCatalogRank: result.relatedCatalogRank || null,
      relatedCatalogProductId: result.relatedCatalogProductId || null,
      relatedCatalogTitle: result.relatedCatalogTitle || null,
      rankSelectionBasis: result.rankSelectionBasis,
    } : {}),
  };
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_snapshots")
    .insert({
      tracker_id: tracker.id,
      checked_at: checkedAt,
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
    })
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

function sanitizeOrganicTrackingItems(items) {
  return (Array.isArray(items) ? items : []).filter(isOrganicTrackingItem);
}

export function selectRepresentativeTrackingRank(result = {}) {
  const exposureItems = Array.isArray(result?.productExposureItems) ? result.productExposureItems : [];
  const organicExposureItems = sanitizeOrganicTrackingItems(exposureItems);
  const exactExposure = organicExposureItems
    .filter((item) => item?.isExactTarget)
    .map((item) => ({ ...item, rank: positiveRank(item?.rank) }))
    .filter((item) => item.rank)
    .sort((a, b) => a.rank - b.rank)[0] || null;
  const relatedCatalog = organicExposureItems
    .filter((item) => item?.isRelatedCatalog)
    .map((item) => ({ ...item, rank: positiveRank(item?.rank) }))
    .filter((item) => item.rank)
    .sort((a, b) => a.rank - b.rank)[0] || null;
  const exactExposureRejectedAsAd = exposureItems.some((item) => item?.isExactTarget && !isOrganicTrackingItem(item));
  const relatedExposurePresent = exposureItems.some((item) => item?.isRelatedCatalog);
  const explicitExactItem = result?.exactItem;
  const safeExactItem = isOrganicTrackingItem(explicitExactItem) ? explicitExactItem : exactExposure;
  const legacyExactAllowed = !explicitExactItem
    && !exactExposureRejectedAsAd
    && (!result?.item || isOrganicTrackingItem(result.item));
  const exactProductRank = exactExposure?.rank
    || (safeExactItem ? positiveRank(safeExactItem.rank) || positiveRank(result?.exactProductRank) : null)
    || (legacyExactAllowed
      ? positiveRank(result?.exactProductRank)
        || (result?.matched && result?.trackingRankSource !== "related_catalog" ? positiveRank(result.rank) : null)
      : null);
  const relatedCatalogRank = relatedCatalog?.rank
    || (!relatedExposurePresent ? positiveRank(result?.relatedCatalogRank) : null);
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
    relatedCatalogProductId: relatedCatalog?.productId || null,
    relatedCatalogTitle: relatedCatalog?.title || null,
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

function assertCompleteProductTrackingResult(result = {}) {
  if (result.matched && positiveRank(result.rank)) return;

  const checkedCount = Math.max(0, Number(result.checkedCount || 0));
  if (result.complete === true || checkedCount >= PRODUCT_RANK_TRACKER_MAX_RANK) return;
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

  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
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
    })
    .eq("id", tracker.id);

  if (leaseStartedAt) query = query.eq("status", "active").eq("processing_started_at", leaseStartedAt);
  const { data, error } = await query.select(TRACKER_SELECT).single();

  if (error) throw error;
  return data;
}

async function updateTrackerAfterFailure(ctx, tracker, attemptedAt, message, errorMessage, leaseStartedAt = "") {
  const retryCount = Math.max(0, Number(tracker.retry_count || 0)) + 1;
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      next_check_at: rankRetryAt(tracker, new Date(attemptedAt)),
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

export async function runTrackerCheck(ctx, tracker, options = {}) {
  const checkedAt = new Date().toISOString();
  const env = options.env ?? shoppingRankConfig();
  const findShoppingRankImpl = options.findShoppingRank || findShoppingRank;

  if (!hasShoppingRankConfig(env)) {
    const message = "네이버 쇼핑 검색 API 연결을 확인한 뒤 자동 재시도합니다. 마지막 정상 순위는 유지합니다.";
    const updated = await updateTrackerAfterFailure(
      ctx,
      tracker,
      checkedAt,
      message,
      "shopping_api_not_configured",
      options.leaseStartedAt || ""
    );
    return { ok: false, tracker: updated, message, error: "shopping_api_not_configured" };
  }

  try {
    const lookupResult = await findShoppingRankImpl(env, {
      keyword: tracker.keyword,
      targetProductId: tracker.product_id,
      targetUrl: tracker.product_url,
      targetMallName: tracker.mall_name,
      targetProductTitle: tracker.product_title,
      maxRank: PRODUCT_RANK_TRACKER_MAX_RANK,
    });
    const result = selectRepresentativeTrackingRank(lookupResult);
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
    const message = "네이버 상품 순위 갱신에 실패해 자동 재시도합니다. 마지막 정상 순위는 유지합니다.";
    const errorMessage = error?.message || "lookup_failed";
    const updated = await updateTrackerAfterFailure(
      ctx,
      tracker,
      checkedAt,
      message,
      errorMessage,
      options.leaseStartedAt || ""
    );
    return { ok: false, tracker: updated, message, error: errorMessage };
  }
}

async function createTracker(request, ctx, body, access = {}) {
  const agencyCode = requestAgencyCode(request, body);
  const keyword = normalizeText(body.keyword);
  const productUrl = normalizeText(body.targetUrl || body.productUrl || body.product_url);
  const productId = normalizeText(body.productId || body.product_id) || extractProductId(productUrl);
  const mallName = normalizeText(body.mallName || body.mall_name);
  const productTitle = normalizeText(body.productTitle || body.product_title);
  const groupName = normalizeRankGroupName(body.groupName || body.group_name || body.group);

  if (!keyword) return json(request, { ok: false, message: "키워드를 입력해주세요." }, 400);
  if (!productUrl && !productId && !mallName) {
    return json(request, { ok: false, message: "상품 URL 또는 상품ID를 입력해주세요." }, 400);
  }

  const existingQuery = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .in("agency_code", agencyCodeScope(agencyCode))
    .eq("keyword", keyword)
    .eq("status", "active")
    .limit(100);

  const existing = await existingQuery;
  if (existing.error) throw existing.error;
  const inputProductIdFromUrl = productUrl ? extractProductId(productUrl) : "";
  const existingData = (existing.data || []).find((row) => (
    (productUrl && row.product_url === productUrl) ||
    (productId && row.product_id === productId) ||
    (productId && row.product_url && extractProductId(row.product_url) === productId) ||
    (inputProductIdFromUrl && row.product_url && extractProductId(row.product_url) === inputProductIdFromUrl) ||
    (!productUrl && !productId && mallName && row.mall_name === mallName)
  ));
  if (existingData) {
    const existingTracker = await attachTrackerGroup(ctx, existingData);
    const snapshots = await loadSnapshots(ctx, [existingTracker.id], 30);
    const keywordVolumes = await loadKeywordVolumes([existingTracker.keyword]);
    return json(request, {
      ok: true,
      message: "이미 추적 중인 상품입니다. 최근 30일 기록을 이어서 표시합니다.",
      tracker: trackerPayload(existingTracker, snapshots.get(existingTracker.id) || [], keywordVolumes.get(normalizeKeywordCompare(existingTracker.keyword))),
    });
  }

  const now = new Date();
  const initialLeaseStartedAt = now.toISOString();
  const clientId = await findClientId(ctx, agencyCode);
  const activeCountResult = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id", { count: "exact", head: true })
    .in("agency_code", agencyCodeScope(agencyCode))
    .eq("status", "active");
  if (activeCountResult.error) throw activeCountResult.error;
  const unlimitedOwner = Boolean(access.admin && isPrimaryAgencyCode(agencyCode));
  if (!unlimitedOwner && Number(activeCountResult.count || 0) >= 50) {
    return json(request, {
      ok: false,
      message: "순위 추적은 광고주 코드당 최대 50개까지만 등록할 수 있습니다.",
      limit: 50,
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
      processing_started_at: initialLeaseStartedAt,
      processing_until: new Date(now.getTime() + RANK_TRACKER_LEASE_MS).toISOString(),
      last_message: "추적 등록 후 첫 순위 확인 대기",
      sort_order: nextSortOrder,
    })
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;

  await updateTrackerGroupName(ctx, data.id, agencyCode, groupName);
  const checked = await runTrackerCheck(ctx, { ...data, group_name: groupName }, {
    leaseStartedAt: initialLeaseStartedAt,
  });
  const checkedTracker = await attachTrackerGroup(ctx, { ...checked.tracker, group_name: groupName });
  const keywordVolumes = await loadKeywordVolumes([checked.tracker.keyword]);
  return json(request, {
    ok: checked.ok,
    message: checked.message,
    tracker: trackerPayload(checkedTracker, [checked.snapshot], keywordVolumes.get(normalizeKeywordCompare(checked.tracker.keyword))),
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

async function checkOne(request, ctx, body) {
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

  const claim = await claimTrackerForManualCheck(ctx, data, agencyCode);
  if (!claim) {
    return json(request, { ok: false, message: "이미 순위 갱신이 진행 중입니다. 잠시 후 다시 시도해주세요." }, 409);
  }
  const tracker = await attachTrackerGroup(ctx, claim.tracker);
  const checked = await runTrackerCheck(ctx, tracker, { leaseStartedAt: claim.leaseStartedAt });
  const checkedTracker = await attachTrackerGroup(ctx, checked.tracker);
  const keywordVolumes = await loadKeywordVolumes([checked.tracker.keyword]);
  return json(request, {
    ok: checked.ok,
    message: checked.message,
    tracker: trackerPayload(checkedTracker, [checked.snapshot], keywordVolumes.get(normalizeKeywordCompare(checked.tracker.keyword))),
  });
}

async function stopTracker(request, ctx, body) {
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
  return json(request, { ok: true, tracker: trackerPayload(tracker), message: "추적을 중지했습니다." });
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

async function updateTrackerGroup(request, ctx, body) {
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
    tracker: trackerPayload(tracker),
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
  const summary = await runDueTrackers(ctx, {
    agencyCode: access.agencyCode,
    limit: body.limit || process.env.MI_RANK_CRON_BATCH || 1,
  });
  const ok = summary.failed === 0;
  return json(request, {
    ok,
    message: ok
      ? (summary.checked ? "밀린 자동 순위 갱신을 처리했습니다." : "갱신 대기 항목이 없습니다.")
      : "일부 순위 추적 항목의 자동 갱신이 실패했습니다.",
    summary,
  }, ok ? 200 : 502);
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

  return { claimed: Boolean(data), leaseSupported: true };
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
  const configured = hasShoppingRankConfig(options.env ?? shoppingRankConfig());
  const limit = Math.max(1, Math.min(100, Number(options.limit || process.env.MI_RANK_CRON_BATCH || 1)));
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
  for (const tracker of data || []) {
    // Claim rows before checking so overlapping cron calls do not refresh the same tracker.
    // Missing lease columns fail closed; readiness also verifies this schema contract.
    // Sequential checks keep Naver API quota usage predictable.
    // eslint-disable-next-line no-await-in-loop
    const claim = await claimDueTracker(ctx, tracker, now);
    if (!claim.claimed) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await runTrackerCheck(ctx, tracker, {
        leaseStartedAt: claim.leaseSupported ? now : "",
      });
      if (claim.leaseSupported) {
        // eslint-disable-next-line no-await-in-loop
        const clearResult = await clearDueTrackerClaim(ctx, tracker.id, now);
        if (!clearResult.ok) result.leaseClearError = clearResult.message;
      }
      results.push(result);
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

  let remainingQuery = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .lte("next_check_at", now)
    .or(`processing_until.is.null,processing_until.lt.${now}`);
  if (options.agencyCode) remainingQuery = remainingQuery.in("agency_code", agencyCodeScope(options.agencyCode));
  const remainingResult = await remainingQuery;
  if (remainingResult.error) throw remainingResult.error;
  const remaining = Math.max(0, Number(remainingResult.count || 0));

  return {
    now,
    checked: results.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    remaining,
    drained: remaining === 0,
    configured,
    results: results.map((item) => ({
      ok: item.ok,
      trackerId: item.tracker?.id,
      keyword: item.tracker?.keyword,
      rank: item.tracker?.current_rank,
      message: item.message,
    })),
  };
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

  if (action === "create") return createTracker(request, ctx, body, access);
  if (action === "check") return checkOne(request, ctx, body);
  if (action === "sync-due") return syncDueTrackers(request, ctx, body, access);
  if (action === "stop") return stopTracker(request, ctx, body);
  if (action === "delete") return deleteTracker(request, ctx, body);
  if (action === "group") return updateTrackerGroup(request, ctx, body);
  if (action === "move") return moveTracker(request, ctx, body);
  if (action === "reorder") return reorderTrackers(request, ctx, body);

  return json(request, { ok: false, message: "지원하지 않는 작업입니다." }, 400);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, {
      methods: "GET, POST, OPTIONS",
      headers: "authorization, content-type, x-demo-admin-code, x-mi-agency-code, x-mi-rank-access-code",
    }) });

    try {
      if (request.method === "GET") return listTrackers(request, ctx);
      if (request.method === "POST") return handlePost(request, ctx);
      return json(request, { ok: false, message: "Method not allowed" }, 405);
    } catch (error) {
      return json(request, {
        ok: false,
        message: "네이버 상품 순위 추적 처리 중 오류가 발생했습니다.",
        detail: process.env.NODE_ENV === "development" ? error?.message : undefined,
      }, 500);
    }
  }),
};

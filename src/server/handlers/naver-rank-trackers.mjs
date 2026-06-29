import crypto from "node:crypto";
import { withSupabase } from "@supabase/server";
import { corsHeaders, isLocalRequest, protectedJson, safeEqual } from "../security.mjs";
import {
  extractProductId,
  findShoppingRank,
  hasShoppingRankConfig,
  normalizeText,
  shoppingRankConfig,
  shoppingRankMessage,
} from "./naver-shopping-rank.mjs";

const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const KEYWORD_VOLUME_CACHE_TTL_MS = Number(process.env.MI_RANK_KEYWORD_VOLUME_CACHE_TTL_MS || 1000 * 60 * 30);
const KEYWORD_VOLUME_CACHE_MAX = Number(process.env.MI_RANK_KEYWORD_VOLUME_CACHE_MAX || 300);
const RANK_TRACKER_LEASE_MS = Number(process.env.MI_RANK_TRACKER_LEASE_MS || 1000 * 60 * 12);
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

function normalizeKeywordCompare(value) {
  return normalizeText(value || "").replace(/\s/g, "").toLowerCase();
}

function normalizeSearchAdKeyword(value) {
  return normalizeText(value || "").replace(/\s/g, "");
}

function isMissingRankLeaseColumns(error) {
  return /processing_started_at|processing_until|schema cache|does not exist/i.test(error?.message || "");
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

function requestAgencyCode(request, body = {}) {
  const url = new URL(request.url);
  return canonicalAgencyCode(
    body.agencyCode ||
      body.agency_code ||
      request.headers.get("x-mi-agency-code") ||
      url.searchParams.get("agencyCode") ||
      url.searchParams.get("agency_code")
  );
}

function requestAccessCode(request, body = {}) {
  return normalizeAgencyCode(
    body.accessCode ||
      body.access_code ||
      body.agencyAccessCode ||
      body.agency_access_code ||
      request.headers.get("x-mi-rank-access-code")
  );
}

function requestAdminCode(request, body = {}) {
  return String(
    request.headers.get("x-demo-admin-code") ||
      body.adminCode ||
      body.admin_code ||
      ""
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

function clampMaxRank(value) {
  const number = Number(value || 300);
  if (!Number.isFinite(number)) return 300;
  return Math.max(100, Math.min(1000, Math.round(number)));
}

function trackerPayload(row, snapshots = [], keywordVolume = null) {
  const recentSnapshots = (snapshots || []).slice(0, 30);
  return {
    id: row.id,
    keyword: row.keyword,
    keywordVolume: keywordVolume?.value ?? null,
    keywordVolumeLabel: keywordVolume?.label || "조회 필요",
    keywordVolumeStatus: keywordVolume?.status || "pending",
    productUrl: row.product_url,
    productId: row.product_id,
    mallName: row.mall_name,
    productTitle: row.product_title,
    maxRank: row.max_rank,
    status: row.status,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    currentRank: row.current_rank,
    bestRank: row.best_rank,
    worstRank: row.worst_rank,
    checkCount: row.check_count,
    foundCount: row.found_count,
    lastMessage: row.last_message,
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
      .ilike("agency_code", code)
      .eq("status", "active")
      .maybeSingle();

    if (result.error && /disconnected_at|schema cache/i.test(result.error.message || "")) {
      result = await ctx.supabaseAdmin
        .from("clients")
        .select("id, status")
        .ilike("agency_code", code)
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

  const rows = data || [];
  const snapshots = await loadSnapshots(ctx, rows.map((row) => row.id));
  const keywordVolumes = await loadKeywordVolumes(rows.map((row) => row.keyword));
  return json(request, {
    ok: true,
    trackers: rows.map((row) => trackerPayload(row, snapshots.get(row.id) || [], keywordVolumes.get(normalizeKeywordCompare(row.keyword)))),
  });
}

async function insertSnapshot(ctx, tracker, checkedAt, result, message, source = "naver_shopping_search_api") {
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
      item: result?.item || {},
      top_items: result?.topItems || [],
      message,
      source,
    })
    .select(SNAPSHOT_SELECT)
    .single();

  if (error) throw error;
  return data;
}

async function updateTrackerAfterCheck(ctx, tracker, checkedAt, result, message) {
  const matchedRank = result?.matched && result.rank ? Number(result.rank) : null;
  const nextCheckAt = nextRankCheckAt(new Date(checkedAt));
  const bestRank = matchedRank
    ? Math.min(Number(tracker.best_rank || matchedRank), matchedRank)
    : tracker.best_rank;
  const worstRank = matchedRank
    ? Math.max(Number(tracker.worst_rank || matchedRank), matchedRank)
    : tracker.worst_rank;

  const { data, error } = await ctx.supabaseAdmin
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
      product_id: tracker.product_id || result?.item?.productId || null,
      mall_name: tracker.mall_name || result?.item?.mallName || null,
      product_title: tracker.product_title || result?.item?.title || null,
    })
    .eq("id", tracker.id)
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;
  return data;
}

export async function runTrackerCheck(ctx, tracker) {
  const checkedAt = new Date().toISOString();
  const env = shoppingRankConfig();

  if (!hasShoppingRankConfig(env)) {
    const message = "네이버 쇼핑 검색 API 환경변수가 연결되지 않았습니다.";
    const snapshot = await insertSnapshot(ctx, tracker, checkedAt, { matched: false }, message, "configuration");
    const updated = await updateTrackerAfterCheck(ctx, tracker, checkedAt, { matched: false }, message);
    return { ok: false, tracker: updated, snapshot, message };
  }

  try {
    const result = await findShoppingRank(env, {
      keyword: tracker.keyword,
      targetProductId: tracker.product_id,
      targetUrl: tracker.product_url,
      targetMallName: tracker.mall_name,
      targetProductTitle: tracker.product_title,
      maxRank: tracker.max_rank,
    });
    const message = shoppingRankMessage(result);
    const snapshot = await insertSnapshot(ctx, tracker, checkedAt, result, message);
    const updated = await updateTrackerAfterCheck(ctx, tracker, checkedAt, result, message);
    return { ok: true, tracker: updated, snapshot, result, message };
  } catch (error) {
    const message = "네이버 상품 순위 갱신에 실패했습니다.";
    const snapshot = await insertSnapshot(ctx, tracker, checkedAt, { matched: false }, message, "naver_shopping_search_api");
    const updated = await updateTrackerAfterCheck(ctx, tracker, checkedAt, { matched: false }, message);
    return { ok: false, tracker: updated, snapshot, message, error: error?.message || "lookup_failed" };
  }
}

async function createTracker(request, ctx, body, access = {}) {
  const agencyCode = requestAgencyCode(request, body);
  const keyword = normalizeText(body.keyword);
  const productUrl = normalizeText(body.targetUrl || body.productUrl || body.product_url);
  const productId = normalizeText(body.productId || body.product_id) || extractProductId(productUrl);
  const mallName = normalizeText(body.mallName || body.mall_name);
  const productTitle = normalizeText(body.productTitle || body.product_title);

  if (!keyword) return json(request, { ok: false, message: "키워드를 입력해주세요." }, 400);
  if (!productUrl && !productId && !mallName) {
    return json(request, { ok: false, message: "상품 URL 또는 상품ID를 입력해주세요." }, 400);
  }

  let existingQuery = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .in("agency_code", agencyCodeScope(agencyCode))
    .eq("keyword", keyword)
    .eq("status", "active")
    .limit(1);
  if (productId) existingQuery = existingQuery.eq("product_id", productId);
  else if (productUrl) existingQuery = existingQuery.eq("product_url", productUrl);
  else if (mallName) existingQuery = existingQuery.eq("mall_name", mallName);

  const existing = await existingQuery.maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    const snapshots = await loadSnapshots(ctx, [existing.data.id], 30);
    const keywordVolumes = await loadKeywordVolumes([existing.data.keyword]);
    return json(request, {
      ok: true,
      message: "이미 추적 중인 상품입니다. 최근 30일 기록을 이어서 표시합니다.",
      tracker: trackerPayload(existing.data, snapshots.get(existing.data.id) || [], keywordVolumes.get(normalizeKeywordCompare(existing.data.keyword))),
    });
  }

  const now = new Date();
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
      max_rank: clampMaxRank(body.maxRank || body.max_rank),
      status: "active",
      started_at: now.toISOString(),
      ends_at: addDays(now, 3650),
      next_check_at: now.toISOString(),
      last_message: "추적 등록 후 첫 순위 확인 대기",
      sort_order: nextSortOrder,
    })
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;

  const checked = await runTrackerCheck(ctx, data);
  const keywordVolumes = await loadKeywordVolumes([checked.tracker.keyword]);
  return json(request, {
    ok: checked.ok,
    message: checked.message,
    tracker: trackerPayload(checked.tracker, [checked.snapshot], keywordVolumes.get(normalizeKeywordCompare(checked.tracker.keyword))),
  }, 201);
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

  const checked = await runTrackerCheck(ctx, data);
  const keywordVolumes = await loadKeywordVolumes([checked.tracker.keyword]);
  return json(request, {
    ok: checked.ok,
    message: checked.message,
    tracker: trackerPayload(checked.tracker, [checked.snapshot], keywordVolumes.get(normalizeKeywordCompare(checked.tracker.keyword))),
  });
}

async function stopTracker(request, ctx, body) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({ status: "paused", last_message: "사용자 요청으로 추적을 중지했습니다." })
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode))
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;
  return json(request, { ok: true, tracker: trackerPayload(data), message: "추적을 중지했습니다." });
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
  const rawIds = Array.isArray(body.orderedIds) ? body.orderedIds : body.trackerIds;
  const orderedIds = Array.from(new Set((Array.isArray(rawIds) ? rawIds : [])
    .map((id) => normalizeText(id))
    .filter(Boolean)));

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

  return json(request, { ok: true, message: "추적 항목 순서를 저장했습니다." });
}

async function claimDueTracker(ctx, tracker, nowIso) {
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
    if (isMissingRankLeaseColumns(error)) return { claimed: true, leaseSupported: false };
    throw error;
  }

  return { claimed: Boolean(data), leaseSupported: true };
}

async function clearDueTrackerClaim(ctx, trackerId) {
  const { error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      processing_started_at: null,
      processing_until: null,
    })
    .eq("id", trackerId);

  if (error && !isMissingRankLeaseColumns(error)) {
    return { ok: false, message: error.message };
  }
  return { ok: true };
}

export async function runDueTrackers(ctx, options = {}) {
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(50, Number(options.limit || process.env.MI_RANK_CRON_BATCH || 20)));
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .eq("status", "active")
    .lte("next_check_at", now)
    .order("next_check_at", { ascending: true })
    .limit(limit);

  if (options.agencyCode) query = query.in("agency_code", agencyCodeScope(options.agencyCode));

  const { data, error } = await query;
  if (error) throw error;

  const results = [];
  for (const tracker of data || []) {
    // Claim rows before checking so overlapping cron calls do not refresh the same tracker.
    // If the DB migration is not applied yet, the helper falls back to the previous behavior.
    // Sequential checks keep Naver API quota usage predictable.
    // eslint-disable-next-line no-await-in-loop
    const claim = await claimDueTracker(ctx, tracker, now);
    if (!claim.claimed) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await runTrackerCheck(ctx, tracker);
      if (claim.leaseSupported) {
        // eslint-disable-next-line no-await-in-loop
        const clearResult = await clearDueTrackerClaim(ctx, tracker.id);
        if (!clearResult.ok) result.leaseClearError = clearResult.message;
      }
      results.push(result);
    } catch (error) {
      if (claim.leaseSupported) {
        // eslint-disable-next-line no-await-in-loop
        await clearDueTrackerClaim(ctx, tracker.id);
      }
      results.push({
        ok: false,
        tracker,
        message: "네이버 상품 순위 자동 갱신 처리 중 오류가 발생했습니다.",
        error: error?.message || "rank_tracker_check_failed",
      });
    }
  }

  return {
    now,
    checked: results.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
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
  if (action === "stop") return stopTracker(request, ctx, body);
  if (action === "delete") return deleteTracker(request, ctx, body);
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

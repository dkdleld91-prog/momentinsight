import crypto from "node:crypto";
import { withSupabase } from "@supabase/server";
import { corsHeaders, isLocalRequest, protectedJson, safeEqual } from "../security.mjs";

const DEFAULT_CRON_BATCH = 100;
const NAVER_OPENAPI_BASE_URL = "https://openapi.naver.com";
const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const NAVER_PLACE_URL_TIMEOUT_MS = 6000;
const KEYWORD_VOLUME_CACHE_TTL_MS = Number(process.env.MI_PLACE_KEYWORD_VOLUME_CACHE_TTL_MS || 1000 * 60 * 30);
const KEYWORD_VOLUME_CACHE_MAX = Number(process.env.MI_PLACE_KEYWORD_VOLUME_CACHE_MAX || 300);
const keywordVolumeCache = new Map();
const TRACKER_SELECT = [
  "id",
  "client_id",
  "brand_id",
  "agency_code",
  "keyword",
  "place_url",
  "place_id",
  "place_name",
  "max_rank",
  "status",
  "started_at",
  "last_checked_at",
  "next_check_at",
  "current_rank",
  "best_rank",
  "worst_rank",
  "check_count",
  "found_count",
  "last_message",
  "last_error",
  "sort_order",
  "created_at",
  "updated_at",
].join(", ");

const SNAPSHOT_SELECT = [
  "id",
  "tracker_id",
  "checked_at",
  "rank",
  "matched",
  "checked_count",
  "total",
  "place",
  "top_places",
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

function normalizeText(value) {
  return String(value || "").normalize("NFKC").trim();
}

function normalizeAgencyCode(value) {
  return normalizeText(value).toLowerCase();
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
  return canonicalAgencyCode(
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

function rankAccessAuthorized(request, body = {}, agencyCode = "") {
  const accessCode = requestAccessCode(request, body);
  const scopedAgencyCode = canonicalAgencyCode(agencyCode);
  return Boolean(accessCode && scopedAgencyCode && safeEqual(accessCode, scopedAgencyCode));
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

async function requirePlaceRankAccess(request, ctx, body = {}, options = {}) {
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

  if (adminAuthorized) return { ok: true, agencyCode, clientId, admin: true };

  const accessAllowed = rankAccessAuthorized(request, body, agencyCode) ||
    (isLocalRequest(request) && safeEqual(requestAccessCode(request, body), agencyCode));
  if (!accessAllowed) {
    return {
      ok: false,
      response: json(request, {
        ok: false,
        message: options.read ? "플레이스 순위 추적 조회 권한을 확인할 수 없습니다." : "플레이스 순위 추적 변경 권한을 확인할 수 없습니다.",
      }, 401),
    };
  }

  return { ok: true, agencyCode, clientId, admin: false };
}

function clampMaxRank(value) {
  const number = Number(value || 300);
  if (!Number.isFinite(number)) return 300;
  return Math.max(50, Math.min(1000, Math.round(number)));
}

function extractPlaceId(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const direct = text.match(/^\d{5,}$/);
  if (direct) return direct[0];
  const patterns = [
    /\/place\/(\d+)/i,
    /[?&]placeId=(\d+)/i,
    /[?&]entry=pll[&#].*?[?&]id=(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function normalizeUrlCandidate(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(naver\.me|map\.naver\.com|m\.place\.naver\.com|place\.naver\.com)\//i.test(text)) {
    return "https://" + text;
  }
  return text;
}

function isNaverPlaceUrl(value) {
  const text = normalizeUrlCandidate(value);
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const { hostname } = new URL(text);
    return /(^|\.)naver\.me$/i.test(hostname) ||
      /(^|\.)map\.naver\.com$/i.test(hostname) ||
      /(^|\.)place\.naver\.com$/i.test(hostname);
  } catch {
    return false;
  }
}

function metaAttributes(tag) {
  const attrs = {};
  String(tag || "").replace(/([a-zA-Z_:.-]+)\s*=\s*["']([^"']*)["']/g, (_all, key, value) => {
    attrs[key.toLowerCase()] = value;
    return _all;
  });
  return attrs;
}

function metaContent(html, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = metaAttributes(tag);
    const key = normalizeText(attrs.property || attrs.name).toLowerCase();
    if (wanted.has(key) && normalizeText(attrs.content)) return attrs.content;
  }
  return "";
}

function cleanPlaceNameCandidate(value) {
  return stripHtml(value)
    .replace(/\s*[:|-]\s*네이버\s*(지도|플레이스)?\s*$/i, "")
    .replace(/\s*-\s*NAVER\s*(Map|Place)?\s*$/i, "")
    .trim();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NAVER_PLACE_URL_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 MomentInsightBot/1.0 (+https://insight.momentlabs.co.kr)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveNaverPlaceUrl(value) {
  const originalUrl = normalizeUrlCandidate(value);
  const result = {
    originalUrl,
    url: originalUrl,
    placeId: extractPlaceId(originalUrl),
    placeName: "",
    resolved: false,
  };
  if (!originalUrl || !isNaverPlaceUrl(originalUrl)) return result;

  try {
    const response = await fetchWithTimeout(originalUrl, { method: "GET", redirect: "follow" });
    result.url = normalizeText(response.url) || originalUrl;
    result.placeId = result.placeId || extractPlaceId(result.url);
    result.resolved = result.url !== originalUrl || Boolean(result.placeId);

    const contentType = normalizeText(response.headers.get("content-type"));
    if (/text\/html/i.test(contentType)) {
      const html = await response.text().catch(() => "");
      result.placeId = result.placeId || extractPlaceId(html);
      result.placeName = cleanPlaceNameCandidate(
        metaContent(html, ["og:title", "twitter:title"]) ||
        (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
      );
    }
  } catch {
    return result;
  }
  return result;
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

export function nextPlaceRankCheckAt(date = new Date()) {
  const kstBase = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const after = new Date(date.getTime() + 60 * 1000);
  const slots = [
    kstSlotToUtc(kstBase, 9),
    kstSlotToUtc(kstBase, 15),
    kstSlotToUtc(new Date(kstBase.getTime() + 24 * 60 * 60 * 1000), 9),
  ];
  return slots.find((slot) => slot > after).toISOString();
}

function placeProviderConfig() {
  return {
    url: process.env.NAVER_PLACE_RANK_API_URL || "",
    key: process.env.NAVER_PLACE_RANK_API_KEY || "",
    openapiClientId: process.env.NAVER_OPENAPI_CLIENT_ID || process.env.NAVER_DATALAB_CLIENT_ID || "",
    openapiClientSecret: process.env.NAVER_OPENAPI_CLIENT_SECRET || process.env.NAVER_DATALAB_CLIENT_SECRET || "",
    searchAdApiKey: process.env.NAVER_SEARCHAD_API_KEY || "",
    searchAdSecretKey: process.env.NAVER_SEARCHAD_SECRET_KEY || "",
    searchAdCustomerId: process.env.NAVER_SEARCHAD_CUSTOMER_ID || "",
  };
}

function hasExternalPlaceProviderConfig(config) {
  return Boolean(config.url && config.key);
}

function hasNaverLocalSearchConfig(config) {
  return Boolean(config.openapiClientId && config.openapiClientSecret);
}

function hasPlaceRankLookupConfig(config) {
  return hasExternalPlaceProviderConfig(config) || hasNaverLocalSearchConfig(config);
}

function placeRankLookupMode(config) {
  if (hasExternalPlaceProviderConfig(config)) return "external-provider";
  if (hasNaverLocalSearchConfig(config)) return "naver-openapi-local";
  return "not-configured";
}

function compactErrorMessage(value) {
  return normalizeText(value).slice(0, 500);
}

function snapshotPayload(row) {
  return {
    id: row.id,
    trackerId: row.tracker_id,
    checkedAt: row.checked_at,
    rank: row.rank,
    matched: row.matched,
    checkedCount: row.checked_count,
    total: row.total,
    place: row.place || null,
    message: row.message,
    source: row.source,
    createdAt: row.created_at,
  };
}

function trackerPayload(row, snapshots = []) {
  const recentSnapshots = (snapshots || []).slice(0, 30);
  return {
    id: row.id,
    keyword: row.keyword,
    placeUrl: row.place_url,
    placeId: row.place_id,
    placeName: row.place_name,
    maxRank: row.max_rank,
    status: row.status,
    startedAt: row.started_at,
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    currentRank: row.current_rank,
    bestRank: row.best_rank,
    worstRank: row.worst_rank,
    checkCount: row.check_count,
    foundCount: row.found_count,
    lastMessage: row.last_message,
    lastError: row.last_error || null,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snapshots: recentSnapshots.map(snapshotPayload),
  };
}

async function loadSnapshots(ctx, trackerIds, limit = 5000) {
  if (!trackerIds.length) return new Map();

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_snapshots")
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

async function insertSnapshot(ctx, tracker, checkedAt, result, message, source = "naver_place_rank_provider") {
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_snapshots")
    .insert({
      tracker_id: tracker.id,
      checked_at: checkedAt,
      rank: result?.rank || null,
      matched: Boolean(result?.matched),
      checked_count: result?.checkedCount || null,
      total: result?.total || null,
      place: result?.place || {},
      top_places: result?.topPlaces || [],
      message,
      source,
    })
    .select(SNAPSHOT_SELECT)
    .single();

  if (error) throw error;
  return data;
}

async function updateTrackerAfterCheck(ctx, tracker, checkedAt, result, message, errorMessage = "") {
  const matchedRank = result?.matched && result.rank ? Number(result.rank) : null;
  const bestRank = matchedRank
    ? Math.min(Number(tracker.best_rank || matchedRank), matchedRank)
    : tracker.best_rank;
  const worstRank = matchedRank
    ? Math.max(Number(tracker.worst_rank || matchedRank), matchedRank)
    : tracker.worst_rank;
  const lastError = compactErrorMessage(errorMessage);

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .update({
      status: tracker.status || "active",
      last_checked_at: checkedAt,
      next_check_at: nextPlaceRankCheckAt(new Date(checkedAt)),
      current_rank: matchedRank,
      best_rank: bestRank || null,
      worst_rank: worstRank || null,
      check_count: Number(tracker.check_count || 0) + 1,
      found_count: Number(tracker.found_count || 0) + (matchedRank ? 1 : 0),
      last_message: message,
      last_error: lastError || null,
      place_id: normalizeText(result?.place?.id || tracker.place_id) || null,
      place_name: normalizeText(result?.place?.name || tracker.place_name) || null,
    })
    .eq("id", tracker.id)
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;
  return data;
}

function providerResultMessage(result) {
  if (result?.matched && result.rank) return "네이버 플레이스 오가닉 " + result.rank + "위로 확인되었습니다.";
  if (result?.notConfigured) return "네이버 플레이스 순위 소스가 아직 연결되지 않았습니다.";
  if (result?.needsPlaceName) return "네이버 검색 API는 URL만으로 장소를 식별하지 못해 상호명 입력이 필요합니다.";
  if (result?.officialPlaceIdOnly) return "플레이스ID는 확인했지만 네이버 공식 검색 API가 URL 기준 순위 매칭값을 반환하지 않았습니다.";
  if (result?.officialLocalLimit) return "네이버 공식 검색 API 상위 " + Number(result?.checkedCount || 0).toLocaleString("ko-KR") + "개 안에서 대상 장소를 찾지 못했습니다.";
  return "상위 " + Number(result?.checkedCount || 0).toLocaleString("ko-KR") + "개 안에서 대상 플레이스를 찾지 못했습니다.";
}

function stripHtml(value) {
  return normalizeText(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function compactComparableText(value) {
  return stripHtml(value)
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function normalizeMetricNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.round(number));
}

function firstMetricValue(source, keys) {
  for (const key of keys) {
    const number = normalizeMetricNumber(source?.[key]);
    if (number !== null) return number;
  }
  return null;
}

function normalizePlaceMetrics(value = {}) {
  const source = value?.metrics && typeof value.metrics === "object" ? { ...value, ...value.metrics } : value;
  return {
    blogCount: firstMetricValue(source, ["blogCount", "blog_count", "blogTotal", "blog_total"]),
    visitReviewCount: firstMetricValue(source, ["visitReviewCount", "visit_review_count", "reviewCount", "review_count", "visitorReviewCount", "visitor_review_count"]),
    monthlySearchCount: firstMetricValue(source, ["monthlySearchCount", "monthly_search_count", "keywordVolume", "keyword_volume", "searchCount", "search_count"]),
    businessCount: firstMetricValue(source, ["businessCount", "business_count", "placeCount", "place_count", "total"]),
  };
}

function hasPlaceMetrics(metrics) {
  return Boolean(metrics && Object.values(metrics).some((value) => value !== null && value !== undefined));
}

function hasSearchAdConfig(config) {
  return Boolean(config.searchAdApiKey && config.searchAdSecretKey && config.searchAdCustomerId);
}

function normalizeKeywordCompare(value) {
  return normalizeText(value || "").replace(/\s/g, "").toLowerCase();
}

function normalizeSearchAdKeyword(value) {
  return normalizeText(value || "").replace(/\s/g, "");
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

function naverSearchAdHeaders(config, method, path) {
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", config.searchAdSecretKey)
    .update(timestamp + "." + method + "." + path)
    .digest("base64");

  return {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp": timestamp,
    "X-API-KEY": config.searchAdApiKey,
    "X-Customer": String(config.searchAdCustomerId),
    "X-Signature": signature,
  };
}

async function lookupMonthlySearchCount(config, keyword) {
  const cached = getKeywordVolumeCache(keyword);
  if (cached !== null) return cached;
  if (!hasSearchAdConfig(config) || !normalizeText(keyword)) return null;

  const path = "/keywordstool";
  const params = new URLSearchParams({ hintKeywords: normalizeSearchAdKeyword(keyword), showDetail: "1" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.MI_PLACE_KEYWORD_VOLUME_TIMEOUT_MS || 3500));

  try {
    const response = await fetch(SEARCHAD_BASE_URL + path + "?" + params.toString(), {
      method: "GET",
      headers: naverSearchAdHeaders(config, "GET", path),
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(payload?.errorMessage || payload?.message || "HTTP " + response.status);

    const list = Array.isArray(payload?.keywordList) ? payload.keywordList : [];
    const exact = list.find((item) => normalizeKeywordCompare(item.relKeyword) === normalizeKeywordCompare(keyword));
    const metric = exact ? searchVolumeMetric(exact.monthlyPcQcCnt, exact.monthlyMobileQcCnt) : null;
    const value = metric ? (metric.isUnderThreshold ? metric.upperBound : metric.value) : null;
    setKeywordVolumeCache(keyword, value);
    return value;
  } catch {
    setKeywordVolumeCache(keyword, null);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupNaverBlogCount(config, keyword) {
  if (!hasNaverLocalSearchConfig(config) || !normalizeText(keyword)) return null;
  const params = new URLSearchParams({ query: keyword, display: "1", start: "1" });
  try {
    const response = await fetch(NAVER_OPENAPI_BASE_URL + "/v1/search/blog.json?" + params.toString(), {
      method: "GET",
      headers: {
        "X-Naver-Client-Id": config.openapiClientId,
        "X-Naver-Client-Secret": config.openapiClientSecret,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    return normalizeMetricNumber(payload.total);
  } catch {
    return null;
  }
}

function naverLocalItemPayload(item, index) {
  return {
    id: "",
    rank: index + 1,
    name: stripHtml(item?.title),
    title: stripHtml(item?.title),
    link: normalizeText(item?.link),
    category: normalizeText(item?.category),
    description: stripHtml(item?.description),
    address: normalizeText(item?.address),
    roadAddress: normalizeText(item?.roadAddress),
    telephone: normalizeText(item?.telephone),
    mapx: normalizeText(item?.mapx),
    mapy: normalizeText(item?.mapy),
  };
}

function naverLocalItemMatchesTracker(tracker, item) {
  const targetName = compactComparableText(tracker.place_name);
  const itemName = compactComparableText(item.name || item.title);
  if (targetName && itemName && (itemName.includes(targetName) || targetName.includes(itemName))) return true;

  const targetId = normalizeText(tracker.place_id);
  const itemLink = normalizeText(item.link);
  if (targetId && itemLink && itemLink.includes(targetId)) return true;

  return false;
}

async function lookupNaverLocalSearchRank(config, tracker) {
  const targetName = normalizeText(tracker.place_name);
  const targetId = normalizeText(tracker.place_id);
  const [blogCount, monthlySearchCount] = await Promise.all([
    lookupNaverBlogCount(config, tracker.keyword),
    lookupMonthlySearchCount(config, tracker.keyword),
  ]);

  if (!targetName && !targetId) {
    return {
      ok: true,
      matched: false,
      needsPlaceName: true,
      officialLocalLimit: true,
      checkedCount: 0,
      total: 0,
      place: {
        metrics: normalizePlaceMetrics({ blogCount, monthlySearchCount }),
      },
      topPlaces: [],
      message: "네이버 검색 API는 플레이스 URL만으로 장소를 식별하지 못해 상호명을 함께 입력해야 합니다.",
      source: "naver_openapi_local",
    };
  }

  const params = new URLSearchParams({
    query: tracker.keyword,
    display: "5",
    start: "1",
  });
  const response = await fetch(NAVER_OPENAPI_BASE_URL + "/v1/search/local.json?" + params.toString(), {
    method: "GET",
    headers: {
      "X-Naver-Client-Id": config.openapiClientId,
      "X-Naver-Client-Secret": config.openapiClientSecret,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.errorMessage || payload.message || "naver_local_search_failed");
  }

  const items = Array.isArray(payload.items) ? payload.items.map(naverLocalItemPayload) : [];
  const matchedIndex = items.findIndex((item) => naverLocalItemMatchesTracker(tracker, item));
  const matchedPlace = matchedIndex >= 0 ? items[matchedIndex] : null;
  const officialPlaceIdOnly = Boolean(targetId && !targetName && !matchedPlace);
  const metrics = normalizePlaceMetrics({
    blogCount,
    monthlySearchCount,
    businessCount: payload.total,
  });
  const unresolvedPlace = {
    id: targetId,
    name: targetName,
    url: tracker.place_url,
    metrics,
  };
  return {
    ok: true,
    matched: Boolean(matchedPlace),
    rank: matchedPlace ? matchedIndex + 1 : null,
    checkedCount: items.length,
    total: Number(payload.total || items.length || 0),
    place: matchedPlace ? { ...matchedPlace, metrics } : unresolvedPlace,
    topPlaces: items,
    officialPlaceIdOnly,
    officialLocalLimit: true,
    source: "naver_openapi_local",
    message: matchedPlace
      ? "네이버 공식 검색 API 상위 " + items.length + "개 안에서 " + (matchedIndex + 1) + "위로 확인되었습니다."
      : officialPlaceIdOnly
        ? "플레이스ID는 확인했지만 네이버 공식 검색 API가 URL 기준 순위 매칭값을 반환하지 않았습니다. 상호명을 함께 넣으면 공식 검색 범위 내 매칭 정확도가 올라갑니다."
      : "네이버 공식 검색 API 상위 " + items.length + "개 안에서 대상 장소를 찾지 못했습니다.",
  };
}

async function lookupExternalPlaceProvider(config, tracker) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.NAVER_PLACE_RANK_TIMEOUT_MS || 45000));
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + config.key,
      },
      body: JSON.stringify({
        keyword: tracker.keyword,
        placeId: tracker.place_id,
        placeUrl: tracker.place_url,
        placeName: tracker.place_name,
        maxRank: tracker.max_rank,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || payload.error || "place_rank_provider_failed");
    }

    const rank = Number(payload.rank || payload.position || 0);
    const matched = Boolean(payload.matched || rank > 0);
    const metrics = normalizePlaceMetrics(payload.metrics || payload.place || payload.item || payload);
    const place = payload.place || payload.item || {};
    const placeWithMetrics = hasPlaceMetrics(metrics) ? { ...place, metrics: { ...(place.metrics || {}), ...metrics } } : place;
    return {
      ok: true,
      matched,
      rank: matched ? rank : null,
      checkedCount: Number(payload.checkedCount || payload.checked_count || payload.total || 0),
      total: Number(payload.total || payload.checkedCount || payload.checked_count || 0),
      place: placeWithMetrics,
      topPlaces: Array.isArray(payload.topPlaces) ? payload.topPlaces : (Array.isArray(payload.items) ? payload.items : []),
      source: payload.source || "naver_place_rank_provider",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichTrackerPlaceIdentity(ctx, tracker) {
  const placeUrl = normalizeText(tracker.place_url);
  if (!placeUrl) return tracker;

  const resolved = await resolveNaverPlaceUrl(placeUrl);
  const resolvedUrl = normalizeText(resolved.url);
  const resolvedPlaceId = normalizeText(resolved.placeId);
  const resolvedPlaceName = normalizeText(resolved.placeName);
  const updates = {};

  if (resolvedUrl && resolvedUrl !== placeUrl && extractPlaceId(resolvedUrl)) updates.place_url = resolvedUrl;
  if (resolvedPlaceId && resolvedPlaceId !== normalizeText(tracker.place_id)) updates.place_id = resolvedPlaceId;
  if (resolvedPlaceName && !normalizeText(tracker.place_name)) updates.place_name = resolvedPlaceName;

  const merged = { ...tracker, ...updates };
  if (!Object.keys(updates).length) return merged;

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .update(updates)
    .eq("id", tracker.id)
    .select(TRACKER_SELECT)
    .single();

  if (error) return merged;
  return data || merged;
}

async function lookupPlaceRank(tracker) {
  const config = placeProviderConfig();
  if (!hasPlaceRankLookupConfig(config)) {
    return {
      ok: false,
      notConfigured: true,
      matched: false,
      checkedCount: 0,
      total: 0,
      message: "네이버 플레이스 순위 소스가 아직 연결되지 않았습니다.",
      source: "configuration",
    };
  }

  if (hasExternalPlaceProviderConfig(config)) return lookupExternalPlaceProvider(config, tracker);
  return lookupNaverLocalSearchRank(config, tracker);
}

export async function runPlaceTrackerCheck(ctx, tracker) {
  const checkedAt = new Date().toISOString();

  try {
    const enrichedTracker = await enrichTrackerPlaceIdentity(ctx, tracker);
    const result = await lookupPlaceRank(enrichedTracker);
    const message = result.message || providerResultMessage(result);
    const snapshot = await insertSnapshot(ctx, enrichedTracker, checkedAt, result, message, result.source || "naver_place_rank_provider");
    const updated = await updateTrackerAfterCheck(
      ctx,
      enrichedTracker,
      checkedAt,
      result,
      message,
      result.notConfigured ? "place_rank_provider_not_configured" : ""
    );
    return { ok: Boolean(result.ok && result.matched), tracker: updated, snapshot, result, message };
  } catch (error) {
    const message = "네이버 플레이스 순위 갱신에 실패했습니다.";
    const snapshot = await insertSnapshot(ctx, tracker, checkedAt, { matched: false }, message, "naver_place_rank_provider");
    const updated = await updateTrackerAfterCheck(ctx, tracker, checkedAt, { matched: false }, message, error?.message || "lookup_failed");
    return { ok: false, tracker: updated, snapshot, message, error: error?.message || "lookup_failed" };
  }
}

async function listTrackers(request, ctx) {
  const url = new URL(request.url);
  const access = await requirePlaceRankAccess(request, ctx, {}, { read: true });
  if (!access.ok) return access.response;
  const maxListLimit = access.admin && isPrimaryAgencyCode(access.agencyCode) ? 500 : 50;
  const limit = Math.max(1, Math.min(maxListLimit, Number(url.searchParams.get("limit") || 50)));

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select(TRACKER_SELECT)
    .in("agency_code", agencyCodeScope(access.agencyCode))
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const rows = data || [];
  const snapshots = await loadSnapshots(ctx, rows.map((row) => row.id));
  return json(request, {
    ok: true,
    configured: hasPlaceRankLookupConfig(placeProviderConfig()),
    lookupMode: placeRankLookupMode(placeProviderConfig()),
    trackers: rows.map((row) => trackerPayload(row, snapshots.get(row.id) || [])),
  });
}

async function createTracker(request, ctx, body, access = {}) {
  const agencyCode = requestAgencyCode(request, body);
  const keyword = normalizeText(body.keyword);
  const originalPlaceUrl = normalizeText(body.placeUrl || body.place_url || body.targetUrl || body.target_url);
  const resolved = await resolveNaverPlaceUrl(originalPlaceUrl);
  const placeUrl = normalizeText(resolved.url) || originalPlaceUrl;
  const placeId = normalizeText(body.placeId || body.place_id) || normalizeText(resolved.placeId) || extractPlaceId(placeUrl) || extractPlaceId(originalPlaceUrl);
  const placeName = normalizeText(body.placeName || body.place_name) || normalizeText(resolved.placeName);
  const placeUrlCandidates = [...new Set([originalPlaceUrl, placeUrl].filter(Boolean))];

  if (!keyword) return json(request, { ok: false, message: "키워드를 입력해주세요." }, 400);
  if (!placeUrl && !placeId && !placeName) {
    return json(request, { ok: false, message: "네이버 플레이스 URL 또는 플레이스명을 입력해주세요." }, 400);
  }

  const existing = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select(TRACKER_SELECT)
    .in("agency_code", agencyCodeScope(agencyCode))
    .eq("keyword", keyword)
    .eq("status", "active")
    .limit(100);
  if (existing.error) throw existing.error;

  const existingRow = (existing.data || []).find((row) => (
    (placeId && row.place_id === placeId) ||
    (row.place_url && placeUrlCandidates.includes(row.place_url)) ||
    (!placeId && !placeUrl && placeName && row.place_name === placeName)
  ));
  if (existingRow) {
    const updates = {};
    if (placeId && !normalizeText(existingRow.place_id)) updates.place_id = placeId;
    if (placeUrl && placeUrl !== normalizeText(existingRow.place_url) && extractPlaceId(placeUrl)) updates.place_url = placeUrl;
    if (placeName && !normalizeText(existingRow.place_name)) updates.place_name = placeName;
    let resolvedExistingRow = existingRow;
    if (Object.keys(updates).length) {
      const updatedExisting = await ctx.supabaseAdmin
        .from("naver_place_rank_trackers")
        .update(updates)
        .eq("id", existingRow.id)
        .select(TRACKER_SELECT)
        .single();
      if (!updatedExisting.error && updatedExisting.data) resolvedExistingRow = updatedExisting.data;
    }
    const snapshots = await loadSnapshots(ctx, [existingRow.id], 30);
    return json(request, {
      ok: true,
      message: Object.keys(updates).length
        ? "이미 추적 중인 플레이스입니다. 장소 식별값을 보강하고 기존 기록을 이어서 표시합니다."
        : "이미 추적 중인 플레이스입니다. 기존 기록을 이어서 표시합니다.",
      tracker: trackerPayload(resolvedExistingRow, snapshots.get(existingRow.id) || []),
    });
  }

  const activeCountResult = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select("id", { count: "exact", head: true })
    .in("agency_code", agencyCodeScope(agencyCode))
    .eq("status", "active");
  if (activeCountResult.error) throw activeCountResult.error;
  const unlimitedOwner = Boolean(access.admin && isPrimaryAgencyCode(agencyCode));
  if (!unlimitedOwner && Number(activeCountResult.count || 0) >= 50) {
    return json(request, {
      ok: false,
      message: "플레이스 순위 추적은 광고주 코드당 최대 50개까지만 등록할 수 있습니다.",
      limit: 50,
      count: activeCountResult.count || 0,
    }, 403);
  }

  const sortOrderResult = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select("sort_order")
    .in("agency_code", agencyCodeScope(agencyCode))
    .order("sort_order", { ascending: false })
    .limit(1);
  if (sortOrderResult.error) throw sortOrderResult.error;
  const nextSortOrder = Number(sortOrderResult.data?.[0]?.sort_order || 0) + 100;

  const now = new Date();
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .insert({
      client_id: await findClientId(ctx, agencyCode),
      agency_code: agencyCode,
      keyword,
      place_url: placeUrl || null,
      place_id: placeId || null,
      place_name: placeName || null,
      max_rank: clampMaxRank(body.maxRank || body.max_rank),
      status: "active",
      started_at: now.toISOString(),
      next_check_at: now.toISOString(),
      last_message: "추적 등록 후 첫 플레이스 순위 확인 대기",
      sort_order: nextSortOrder,
    })
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;

  const checked = await runPlaceTrackerCheck(ctx, data);
  return json(request, {
    ok: checked.ok,
    configured: hasPlaceRankLookupConfig(placeProviderConfig()),
    lookupMode: placeRankLookupMode(placeProviderConfig()),
    message: checked.message,
    tracker: trackerPayload(checked.tracker, [checked.snapshot]),
  }, 201);
}

async function checkOne(request, ctx, body) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select(TRACKER_SELECT)
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode))
    .maybeSingle();

  if (error) throw error;
  if (!data) return json(request, { ok: false, message: "플레이스 추적 항목을 찾을 수 없습니다." }, 404);

  const checked = await runPlaceTrackerCheck(ctx, data);
  const snapshots = await loadSnapshots(ctx, [checked.tracker.id], 30);
  return json(request, {
    ok: checked.ok,
    configured: hasPlaceRankLookupConfig(placeProviderConfig()),
    lookupMode: placeRankLookupMode(placeProviderConfig()),
    message: checked.message,
    tracker: trackerPayload(checked.tracker, snapshots.get(checked.tracker.id) || []),
  });
}

async function deleteTracker(request, ctx, body) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const { error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .delete()
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode));
  if (error) throw error;
  return json(request, { ok: true, message: "플레이스 추적 항목을 삭제했습니다." });
}

export async function runDuePlaceTrackers(ctx, options = {}) {
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(100, Number(options.limit || process.env.MI_PLACE_RANK_CRON_BATCH || DEFAULT_CRON_BATCH)));
  let query = ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
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
    // eslint-disable-next-line no-await-in-loop
    results.push(await runPlaceTrackerCheck(ctx, tracker));
  }

  return {
    now,
    checked: results.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    configured: hasPlaceRankLookupConfig(placeProviderConfig()),
    lookupMode: placeRankLookupMode(placeProviderConfig()),
    results: results.map((item) => ({
      ok: item.ok,
      trackerId: item.tracker?.id,
      keyword: item.tracker?.keyword,
      rank: item.tracker?.current_rank,
      message: item.message,
    })),
  };
}

async function syncDueTrackers(request, ctx, body, access = {}) {
  const summary = await runDuePlaceTrackers(ctx, {
    agencyCode: access.agencyCode || requestAgencyCode(request, body),
    limit: body.limit || DEFAULT_CRON_BATCH,
  });
  return json(request, {
    ok: true,
    message: summary.checked ? "밀린 플레이스 순위 갱신을 처리했습니다." : "플레이스 갱신 대기 항목이 없습니다.",
    summary,
  });
}

async function handlePost(request, ctx) {
  const body = await request.json().catch(() => ({}));
  const action = normalizeText(body.action || "create");
  if (action === "run-due") {
    return json(request, { ok: false, message: "자동 갱신은 크론 전용 API에서만 실행할 수 있습니다." }, 403);
  }

  const access = await requirePlaceRankAccess(request, ctx, body);
  if (!access.ok) return access.response;
  body.agencyCode = access.agencyCode;

  if (action === "create") return createTracker(request, ctx, body, access);
  if (action === "check") return checkOne(request, ctx, body);
  if (action === "sync-due") return syncDueTrackers(request, ctx, body, access);
  if (action === "delete") return deleteTracker(request, ctx, body);

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
        message: "네이버 플레이스 순위 추적 처리 중 오류가 발생했습니다.",
        detail: process.env.NODE_ENV === "development" ? error?.message : undefined,
      }, 500);
    }
  }),
};

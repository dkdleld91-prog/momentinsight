import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { withSupabase } from "@supabase/server";
import { corsHeaders, isLocalRequest, protectedJson, safeEqual } from "../security.mjs";

const DEFAULT_CRON_BATCH = 1;
const MAX_CRON_BATCH = 10;
const PLACE_RANK_HISTORY_DAYS = 30;
const PLACE_RANK_HISTORY_MAX_SNAPSHOTS = 120;
const SNAPSHOT_QUERY_PAGE_SIZE = 1000;
const SNAPSHOT_TRACKER_BATCH_SIZE = 50;
const SNAPSHOT_QUERY_CONCURRENCY = 4;
const TRACKER_LIST_MAX = 500;
const TRACKER_LIST_QUERY_LIMIT = TRACKER_LIST_MAX + 1;
const PLACE_TRACKER_LEASE_SECONDS = Math.max(
  300,
  Math.min(600, Number(process.env.MI_PLACE_RANK_LEASE_SECONDS || 360))
);
const NAVER_OPENAPI_BASE_URL = "https://openapi.naver.com";
const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const NAVER_PLACE_URL_TIMEOUT_MS = 6000;
const NAVER_PLACE_URL_MAX_REDIRECTS = 3;
const NAVER_PLACE_URL_MAX_HTML_BYTES = 512 * 1024;
const KEYWORD_VOLUME_CACHE_TTL_MS = Number(process.env.MI_PLACE_KEYWORD_VOLUME_CACHE_TTL_MS || 1000 * 60 * 30);
const KEYWORD_VOLUME_CACHE_MAX = Number(process.env.MI_PLACE_KEYWORD_VOLUME_CACHE_MAX || 300);
const DEFAULT_RANK_GROUP = "기본 그룹";
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
  "processing_token",
  "processing_started_at",
  "processing_until",
  "last_attempt_at",
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

export function normalizePlaceRankGroupName(value) {
  const normalized = normalizeText(value).replace(/\s+/g, " ").slice(0, 40);
  return normalized || DEFAULT_RANK_GROUP;
}

function isMissingPlaceRankGroupColumn(error) {
  return /group_name|schema cache|does not exist/i.test(error?.message || "");
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
  return canonicalAgencyCode(
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

export const PLACE_RANK_TRACKER_MAX_RANK = 300;

function clampMaxRank() {
  return PLACE_RANK_TRACKER_MAX_RANK;
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
  if (!/^https:\/\//i.test(text)) return false;
  try {
    const { hostname } = new URL(text);
    return /(^|\.)naver\.me$/i.test(hostname) ||
      /(^|\.)map\.naver\.com$/i.test(hostname) ||
      /(^|\.)place\.naver\.com$/i.test(hostname);
  } catch {
    return false;
  }
}

function privateNetworkAddress(address) {
  const value = String(address || "").toLowerCase();
  if (!isIP(value)) return true;
  const mappedIpv4 = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4) return privateNetworkAddress(mappedIpv4[1]);
  const mappedHexIpv4 = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHexIpv4) {
    const high = Number.parseInt(mappedHexIpv4[1], 16);
    const low = Number.parseInt(mappedHexIpv4[2], 16);
    return privateNetworkAddress([
      high >>> 8,
      high & 0xff,
      low >>> 8,
      low & 0xff,
    ].join("."));
  }
  if (
    value === "::" ||
    value === "::1" ||
    value === "0.0.0.0" ||
    value.startsWith("fe80:") ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("ff")
  ) return true;
  if (isIP(value) === 4) {
    const parts = value.split(".").map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] >= 224) return true;
  }
  return false;
}

function productionEnvironment() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

export async function assertSafeNaverPlaceUrl(value, lookup = dnsLookup, enforceDns = productionEnvironment()) {
  const candidate = normalizeUrlCandidate(value);
  if (!isNaverPlaceUrl(candidate)) throw new Error("unsafe_naver_place_url");
  const parsed = new URL(candidate);
  if (isIP(parsed.hostname)) throw new Error("unsafe_naver_place_host");
  if (!enforceDns) return parsed.toString();
  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => privateNetworkAddress(entry.address))) {
    throw new Error("unsafe_naver_place_dns");
  }
  return parsed.toString();
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

async function fetchWithTimeout(url, options = {}, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NAVER_PLACE_URL_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
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

async function readResponseTextLimited(response, maxBytes = NAVER_PLACE_URL_MAX_HTML_BYTES) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("naver_place_response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response_too_large").catch(() => {});
      throw new Error("naver_place_response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function fetchNaverPlaceWithRedirects(originalUrl, options = {}) {
  const lookup = options.lookup || dnsLookup;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const enforceDns = options.enforceDns ?? productionEnvironment();
  let currentUrl = await assertSafeNaverPlaceUrl(originalUrl, lookup, enforceDns);

  for (let redirectCount = 0; redirectCount <= NAVER_PLACE_URL_MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchWithTimeout(currentUrl, { method: "GET", redirect: "manual" }, fetchImpl);
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: currentUrl };
    if (redirectCount === NAVER_PLACE_URL_MAX_REDIRECTS) throw new Error("naver_place_redirect_limit");
    const location = response.headers.get("location");
    if (!location) throw new Error("naver_place_redirect_without_location");
    const nextUrl = new URL(location, currentUrl).toString();
    currentUrl = await assertSafeNaverPlaceUrl(nextUrl, lookup, enforceDns);
  }
  throw new Error("naver_place_redirect_limit");
}

export async function resolveNaverPlaceUrl(value, options = {}) {
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
    const { response, finalUrl } = await fetchNaverPlaceWithRedirects(originalUrl, options);
    result.url = normalizeText(finalUrl) || originalUrl;
    result.placeId = result.placeId || extractPlaceId(result.url);
    result.resolved = result.url !== originalUrl || Boolean(result.placeId);

    const contentType = normalizeText(response.headers.get("content-type"));
    if (/text\/html/i.test(contentType)) {
      const html = await readResponseTextLimited(response).catch(() => "");
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

function placeTrackerLeaseLostError() {
  const error = new Error("place_rank_tracker_lease_lost");
  error.code = "PLACE_TRACKER_LEASE_LOST";
  return error;
}

function isPlaceTrackerLeaseLost(error) {
  return error?.code === "PLACE_TRACKER_LEASE_LOST" || error?.message === "place_rank_tracker_lease_lost";
}

function snapshotPayload(row) {
  const checkedCount = Math.max(0, Number(row.checked_count || 0));
  const matched = Boolean(row.matched);
  return {
    id: row.id,
    trackerId: row.tracker_id,
    checkedAt: row.checked_at,
    rank: row.rank,
    matched,
    checkedCount: row.checked_count,
    requestedMaxRank: PLACE_RANK_TRACKER_MAX_RANK,
    complete: matched || checkedCount >= PLACE_RANK_TRACKER_MAX_RANK,
    partial: !matched && checkedCount > 0 && checkedCount < PLACE_RANK_TRACKER_MAX_RANK,
    total: row.total,
    place: row.place || null,
    message: row.message,
    source: row.source,
    createdAt: row.created_at,
  };
}

export function placeTrackerPayload(row, snapshots = []) {
  const historyCutoff = Date.now() - PLACE_RANK_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const recentSnapshots = (snapshots || [])
    .filter((snapshot) => {
      const checkedAt = new Date(snapshot?.checked_at || snapshot?.checkedAt || 0).getTime();
      return Number.isFinite(checkedAt) && checkedAt >= historyCutoff;
    })
    .slice(0, PLACE_RANK_HISTORY_MAX_SNAPSHOTS);
  return {
    id: row.id,
    keyword: row.keyword,
    groupName: normalizePlaceRankGroupName(row.group_name),
    placeUrl: row.place_url,
    placeId: row.place_id,
    placeName: row.place_name,
    maxRank: PLACE_RANK_TRACKER_MAX_RANK,
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

async function loadTrackerGroups(ctx, trackerIds) {
  const ids = Array.from(new Set((trackerIds || []).filter(Boolean)));
  if (!ids.length) return new Map();

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select("id, group_name")
    .in("id", ids);

  if (error) {
    if (isMissingPlaceRankGroupColumn(error)) return new Map();
    throw error;
  }

  const groups = new Map();
  (data || []).forEach((row) => {
    groups.set(row.id, normalizePlaceRankGroupName(row.group_name));
  });
  return groups;
}

async function attachTrackerGroups(ctx, rows) {
  const sourceRows = rows || [];
  if (!sourceRows.length) return sourceRows;
  const groups = await loadTrackerGroups(ctx, sourceRows.map((row) => row.id));
  return sourceRows.map((row) => ({
    ...row,
    group_name: groups.get(row.id) || normalizePlaceRankGroupName(row.group_name),
  }));
}

async function attachTrackerGroup(ctx, row) {
  if (!row) return row;
  const rows = await attachTrackerGroups(ctx, [row]);
  return rows[0] || row;
}

async function updateTrackerGroupName(ctx, trackerId, agencyCode, groupName) {
  const normalizedGroupName = normalizePlaceRankGroupName(groupName);
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .update({ group_name: normalizedGroupName })
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode))
    .select("id");

  if (error) {
    if (isMissingPlaceRankGroupColumn(error)) return { ok: false, missingColumn: true };
    throw error;
  }
  if (!data?.length) return { ok: false, notFound: true };
  return { ok: true, groupName: normalizedGroupName };
}

async function loadSnapshotBatch(ctx, trackerIds, perTrackerLimit, checkedAfter, checkedBefore) {
  const grouped = new Map();
  const seenSnapshotIds = new Set();
  let offset = 0;
  let expectedTotal = null;

  while (true) {
    const { data, error, count } = await ctx.supabaseAdmin
      .from("naver_place_rank_snapshots")
      .select(SNAPSHOT_SELECT, { count: "exact" })
      .in("tracker_id", trackerIds)
      .gte("checked_at", checkedAfter)
      .lte("checked_at", checkedBefore)
      .order("checked_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + SNAPSHOT_QUERY_PAGE_SIZE - 1);

    if (error) throw error;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("place_rank_snapshot_count_unavailable");
    if (expectedTotal === null) expectedTotal = count;
    else if (count !== expectedTotal) throw new Error("place_rank_snapshot_pagination_changed");
    const rows = data || [];
    let newSnapshotCount = 0;
    for (const row of rows) {
      if (!row?.id || !row?.tracker_id) throw new Error("place_rank_snapshot_identity_missing");
      if (seenSnapshotIds.has(row.id)) continue;
      seenSnapshotIds.add(row.id);
      newSnapshotCount += 1;
      const trackerSnapshots = grouped.get(row.tracker_id) || [];
      if (trackerSnapshots.length < perTrackerLimit) {
        trackerSnapshots.push(row);
        grouped.set(row.tracker_id, trackerSnapshots);
      }
    }

    if (rows.length > 0 && newSnapshotCount === 0) throw new Error("place_rank_snapshot_pagination_stalled");
    if (trackerIds.every((trackerId) => (grouped.get(trackerId)?.length || 0) >= perTrackerLimit)) break;
    if (offset + rows.length >= expectedTotal) break;
    if (rows.length === 0) throw new Error("place_rank_snapshot_pagination_stalled");
    offset += rows.length;
  }
  return grouped;
}

export async function loadSnapshots(ctx, trackerIds, requestedLimit = PLACE_RANK_HISTORY_MAX_SNAPSHOTS) {
  const ids = Array.from(new Set((trackerIds || []).filter(Boolean)));
  if (!ids.length) return new Map();
  const numericLimit = Number(requestedLimit);
  const perTrackerLimit = Math.max(1, Math.min(
    PLACE_RANK_HISTORY_MAX_SNAPSHOTS,
    Number.isFinite(numericLimit) ? Math.floor(numericLimit) : PLACE_RANK_HISTORY_MAX_SNAPSHOTS,
  ));
  const snapshotWindowEnd = Date.now();
  const checkedBefore = new Date(snapshotWindowEnd).toISOString();
  const checkedAfter = new Date(snapshotWindowEnd - PLACE_RANK_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
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

async function assertPlaceTrackerLeaseOwnership(ctx, tracker) {
  if (!tracker.processing_token) return;

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select("id")
    .eq("id", tracker.id)
    .eq("status", "active")
    .eq("processing_token", tracker.processing_token)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw placeTrackerLeaseLostError();
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

  let query = ctx.supabaseAdmin
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
      processing_token: null,
      processing_started_at: null,
      processing_until: null,
      retry_count: 0,
      place_id: normalizeText(result?.place?.id || tracker.place_id) || null,
      place_name: normalizeText(result?.place?.name || tracker.place_name) || null,
    })
    .eq("id", tracker.id);

  // A worker whose lease expired must never overwrite a newer worker's result.
  if (tracker.processing_token) query = query.eq("status", "active").eq("processing_token", tracker.processing_token);
  const { data, error } = await query.select(TRACKER_SELECT).maybeSingle();

  if (error) throw error;
  if (!data && tracker.processing_token) throw placeTrackerLeaseLostError();
  if (!data) throw new Error("place_rank_tracker_not_found");
  return data;
}

async function updateTrackerAfterPartial(ctx, tracker, checkedAt, result, message) {
  let query = ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .update({
      status: tracker.status || "active",
      last_checked_at: checkedAt,
      next_check_at: nextPlaceRankCheckAt(new Date(checkedAt)),
      check_count: Number(tracker.check_count || 0) + 1,
      last_message: message,
      last_error: null,
      processing_token: null,
      processing_started_at: null,
      processing_until: null,
      retry_count: 0,
      place_id: normalizeText(result?.place?.id || tracker.place_id) || null,
      place_name: normalizeText(result?.place?.name || tracker.place_name) || null,
    })
    .eq("id", tracker.id);

  if (tracker.processing_token) query = query.eq("status", "active").eq("processing_token", tracker.processing_token);
  const { data, error } = await query.select(TRACKER_SELECT).maybeSingle();
  if (error) throw error;
  if (!data && tracker.processing_token) throw placeTrackerLeaseLostError();
  if (!data) throw new Error("place_rank_tracker_not_found");
  return data;
}

function placeRetryAt(tracker, date = new Date()) {
  const retryCount = Math.max(0, Number(tracker.retry_count || 0));
  const delayMinutes = [5, 10, 20, 40, 80, 160, 320, 360][Math.min(retryCount, 7)];
  return new Date(date.getTime() + delayMinutes * 60 * 1000).toISOString();
}

async function updateTrackerAfterFailure(ctx, tracker, attemptedAt, errorMessage) {
  const retryCount = Math.max(0, Number(tracker.retry_count || 0)) + 1;
  let query = ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .update({
      next_check_at: placeRetryAt(tracker, new Date(attemptedAt)),
      last_message: "네이버 플레이스 순위 갱신을 다시 시도할 예정입니다.",
      last_error: compactErrorMessage(errorMessage || "lookup_failed"),
      processing_token: null,
      processing_started_at: null,
      processing_until: null,
      retry_count: retryCount,
    })
    .eq("id", tracker.id);

  if (tracker.processing_token) query = query.eq("status", "active").eq("processing_token", tracker.processing_token);
  const { data, error } = await query.select(TRACKER_SELECT).maybeSingle();
  if (error) throw error;
  if (!data && tracker.processing_token) throw placeTrackerLeaseLostError();
  if (!data) throw new Error("place_rank_tracker_not_found");
  return data;
}

async function claimDuePlaceTracker(ctx, agencyCode = "") {
  const requestedAgencyCodes = agencyCode ? agencyCodeScope(agencyCode) : null;
  const { data, error } = await ctx.supabaseAdmin.rpc("claim_due_naver_place_rank_tracker", {
    requested_agency_codes: requestedAgencyCodes,
    lease_seconds: PLACE_TRACKER_LEASE_SECONDS,
  });

  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : data || null;
}

function providerResultMessage(result) {
  if (result?.matched && result.rank) return "네이버 플레이스 오가닉 " + result.rank + "위로 확인되었습니다.";
  if (result?.notConfigured) return "네이버 플레이스 순위 소스가 아직 연결되지 않았습니다.";
  if (result?.needsPlaceName) return "플레이스 URL 자동 식별에 실패했습니다. URL을 확인한 뒤 다시 시도해주세요.";
  if (result?.officialPlaceIdOnly) return "플레이스ID는 확인했지만 네이버 공식 검색 API가 URL 기준 순위 매칭값을 반환하지 않았습니다.";
  if (result?.partial) return "상위 " + Number(result?.checkedCount || 0).toLocaleString("ko-KR") + "개까지 부분 확인했습니다. 기존 확정 순위는 유지합니다.";
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.MI_PLACE_BLOG_COUNT_TIMEOUT_MS || 3500));
  try {
    const response = await fetch(NAVER_OPENAPI_BASE_URL + "/v1/search/blog.json?" + params.toString(), {
      method: "GET",
      headers: {
        "X-Naver-Client-Id": config.openapiClientId,
        "X-Naver-Client-Secret": config.openapiClientSecret,
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    return normalizeMetricNumber(payload.total);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
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
      ok: false,
      matched: false,
      needsPlaceName: true,
      requestedMaxRank: PLACE_RANK_TRACKER_MAX_RANK,
      complete: false,
      partial: false,
      checkedCount: 0,
      total: 0,
      place: {
        metrics: normalizePlaceMetrics({ blogCount, monthlySearchCount }),
      },
      topPlaces: [],
      message: "플레이스 URL에서 장소 식별값을 자동 확인하지 못했습니다.",
      source: "naver_openapi_local",
    };
  }

  const params = new URLSearchParams({
    query: tracker.keyword,
    display: "5",
    start: "1",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.MI_PLACE_LOCAL_SEARCH_TIMEOUT_MS || 7000));
  let response;
  let payload;
  try {
    response = await fetch(NAVER_OPENAPI_BASE_URL + "/v1/search/local.json?" + params.toString(), {
      method: "GET",
      headers: {
        "X-Naver-Client-Id": config.openapiClientId,
        "X-Naver-Client-Secret": config.openapiClientSecret,
      },
      signal: controller.signal,
    });
    payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.errorMessage || payload.message || "naver_local_search_failed");
    }
  } finally {
    clearTimeout(timeout);
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
    requestedMaxRank: PLACE_RANK_TRACKER_MAX_RANK,
    complete: false,
    partial: !matchedPlace,
    partialReason: matchedPlace ? null : "official_local_limit",
    stopReason: matchedPlace ? "target_found" : "official_local_limit",
    place: matchedPlace ? { ...matchedPlace, metrics } : unresolvedPlace,
    topPlaces: items,
    officialPlaceIdOnly,
    officialLocalLimit: true,
    source: "naver_openapi_local",
    message: matchedPlace
      ? "네이버 공식 검색 API 상위 " + items.length + "개 안에서 " + (matchedIndex + 1) + "위로 확인되었습니다."
      : officialPlaceIdOnly
        ? "플레이스ID는 확인했지만 네이버 공식 검색 API가 URL 기준 순위 매칭값을 반환하지 않았습니다. 300위 수집기로 다시 확인합니다."
      : "네이버 공식 검색 API 상위 " + items.length + "개 안에서 대상 장소를 찾지 못했습니다.",
  };
}

async function lookupExternalPlaceProvider(config, tracker) {
  const controller = new AbortController();
  const configuredTimeoutMs = Number(process.env.NAVER_PLACE_RANK_TIMEOUT_MS || 240000);
  // A 300-place lookup can use both an Actor and browser fallback. The payload
  // below splits this budget so the downstream collector finishes first.
  const providerTimeoutMs = Math.max(
    225000,
    Math.min(240000, Number.isFinite(configuredTimeoutMs) ? configuredTimeoutMs : 240000)
  );
  // The collector may fall back from Apify to an 80-second browser lookup.
  // Reserve that browser window and a final response buffer inside Vercel's
  // provider timeout instead of letting the downstream job outlive its caller.
  const apifyBudgetMs = Math.max(30_000, Math.min(135_000, providerTimeoutMs - 95_000));
  const timeout = setTimeout(
    () => controller.abort(),
    providerTimeoutMs
  );
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
        maxRank: PLACE_RANK_TRACKER_MAX_RANK,
        apifyBudgetMs,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.message || payload?.error || "place_rank_provider_failed");
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("place_rank_provider_invalid_response");
    }

    const hasMatchedField = Object.prototype.hasOwnProperty.call(payload, "matched");
    if (hasMatchedField && typeof payload.matched !== "boolean") {
      throw new Error("place_rank_provider_invalid_response");
    }
    const rawRankValue = payload.rank ?? payload.position ?? 0;
    const rankProvided = rawRankValue !== null && rawRankValue !== undefined && String(rawRankValue).trim() !== "";
    const rawRank = Number(rawRankValue);
    const rank = Number.isInteger(rawRank) && rawRank >= 1 && rawRank <= PLACE_RANK_TRACKER_MAX_RANK
      ? rawRank
      : 0;
    const invalidProvidedRank = rankProvided && rawRank !== 0 && !rank;
    const contradictoryMatch = (payload.matched === true && !rank) || (payload.matched === false && Boolean(rank));
    if (invalidProvidedRank || contradictoryMatch) {
      throw new Error("place_rank_provider_invalid_response");
    }
    const matched = hasMatchedField ? payload.matched : rank > 0;
    const topPlaces = Array.isArray(payload.topPlaces)
      ? payload.topPlaces
      : (Array.isArray(payload.items) ? payload.items : []);
    const rawCheckedCount = payload.checkedCount ?? payload.checked_count ?? topPlaces.length;
    const parsedCheckedCount = Number(rawCheckedCount);
    const checkedCount = Math.min(
      PLACE_RANK_TRACKER_MAX_RANK,
      Math.max(matched ? rank : 0, Number.isFinite(parsedCheckedCount) ? Math.floor(parsedCheckedCount) : 0)
    );
    if (!matched && checkedCount <= 0) {
      throw new Error("place_rank_provider_invalid_response");
    }
    const complete = !matched && checkedCount >= PLACE_RANK_TRACKER_MAX_RANK;
    const partial = !matched && !complete;
    const metrics = normalizePlaceMetrics(payload.metrics || payload.place || payload.item || payload);
    const place = payload.place || payload.item || {};
    const placeWithMetrics = hasPlaceMetrics(metrics) ? { ...place, metrics: { ...(place.metrics || {}), ...metrics } } : place;
    const parsedTotal = Number(payload.total ?? checkedCount);
    return {
      ok: true,
      matched,
      rank: matched ? rank : null,
      checkedCount,
      total: Number.isFinite(parsedTotal) ? Math.max(0, parsedTotal) : checkedCount,
      requestedMaxRank: PLACE_RANK_TRACKER_MAX_RANK,
      complete,
      partial,
      partialReason: partial
        ? payload.partialReason || payload.partial_reason || payload.stopReason || payload.stop_reason || "collection_incomplete"
        : null,
      stopReason: payload.stopReason || payload.stop_reason || null,
      place: placeWithMetrics,
      topPlaces,
      source: payload.source || "naver_place_rank_provider",
      message: normalizeText(payload.message),
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
  let activeTracker = tracker;

  try {
    const enrichedTracker = await enrichTrackerPlaceIdentity(ctx, tracker);
    activeTracker = enrichedTracker;
    const result = await lookupPlaceRank(enrichedTracker);
    if (!result.ok) {
      const updated = await updateTrackerAfterFailure(
        ctx,
        enrichedTracker,
        checkedAt,
        result.notConfigured ? "place_rank_provider_not_configured" : result.message || "lookup_failed"
      );
      return {
        ok: false,
        outcome: result.notConfigured ? "not_configured" : "failed",
        tracker: updated,
        result,
        message: result.message || providerResultMessage(result),
      };
    }
    if (!result.matched && !result.complete && !result.partial) {
      throw new Error("place_rank_provider_invalid_response");
    }
    const message = result.message || providerResultMessage(result);
    // Check the claim immediately before the non-transactional snapshot insert.
    // The following tracker update is guarded by the same token as a second CAS.
    await assertPlaceTrackerLeaseOwnership(ctx, enrichedTracker);
    const snapshot = await insertSnapshot(ctx, enrichedTracker, checkedAt, result, message, result.source || "naver_place_rank_provider");
    const updated = result.partial && !result.matched && !result.complete
      ? await updateTrackerAfterPartial(ctx, enrichedTracker, checkedAt, result, message)
      : await updateTrackerAfterCheck(
        ctx,
        enrichedTracker,
        checkedAt,
        result,
        message,
        ""
      );
    return {
      ok: true,
      outcome: result.matched ? "found" : (result.partial ? "partial" : "not_found"),
      tracker: updated,
      snapshot,
      result,
      message,
    };
  } catch (error) {
    if (isPlaceTrackerLeaseLost(error)) {
      return {
        ok: false,
        outcome: "lease_lost",
        tracker: activeTracker,
        message: "플레이스 순위 처리 권한이 만료되어 결과를 저장하지 않았습니다.",
        error: "place_rank_tracker_lease_lost",
      };
    }

    let updated;
    try {
      updated = await updateTrackerAfterFailure(ctx, activeTracker, checkedAt, error?.message || "lookup_failed");
    } catch (updateError) {
      if (!isPlaceTrackerLeaseLost(updateError)) throw updateError;
      return {
        ok: false,
        outcome: "lease_lost",
        tracker: activeTracker,
        message: "플레이스 순위 처리 권한이 만료되어 결과를 저장하지 않았습니다.",
        error: "place_rank_tracker_lease_lost",
      };
    }
    return {
      ok: false,
      outcome: "failed",
      tracker: updated,
      message: "네이버 플레이스 순위 갱신에 실패해 자동 재시도를 예약했습니다.",
      error: error?.message || "lookup_failed",
    };
  }
}

async function listTrackers(request, ctx) {
  const access = await requirePlaceRankAccess(request, ctx, {}, { read: true });
  if (!access.ok) return access.response;

  const { data, error, count } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select(TRACKER_SELECT, { count: "exact" })
    .in("agency_code", agencyCodeScope(access.agencyCode))
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(TRACKER_LIST_QUERY_LIMIT);

  if (error) throw error;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("place_rank_tracker_count_unavailable");

  const queriedRows = data || [];
  const hasMore = count > TRACKER_LIST_MAX || queriedRows.length > TRACKER_LIST_MAX;
  const rows = await attachTrackerGroups(ctx, queriedRows.slice(0, TRACKER_LIST_MAX));
  const snapshots = await loadSnapshots(ctx, rows.map((row) => row.id));
  return json(request, {
    ok: true,
    scopeKey: normalizeAgencyCode(access.agencyCode),
    scopeAgencyCode: normalizeAgencyCode(access.agencyCode),
    scopeClientId: String(access.clientId || ""),
    returnedCount: rows.length,
    totalCount: count,
    hasMore,
    complete: !hasMore && rows.length === count,
    configured: hasPlaceRankLookupConfig(placeProviderConfig()),
    lookupMode: placeRankLookupMode(placeProviderConfig()),
    trackers: rows.map((row) => placeTrackerPayload(row, snapshots.get(row.id) || [])),
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
  const groupName = normalizePlaceRankGroupName(body.groupName || body.group_name || body.group);
  const placeUrlCandidates = [...new Set([originalPlaceUrl, placeUrl].filter(Boolean))];

  if (!keyword) return json(request, { ok: false, message: "키워드를 입력해주세요." }, 400);
  if (!originalPlaceUrl) {
    return json(request, { ok: false, message: "네이버 플레이스 URL을 입력해주세요." }, 400);
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
    const existingTracker = await attachTrackerGroup(ctx, resolvedExistingRow);
    const snapshots = await loadSnapshots(ctx, [existingRow.id], PLACE_RANK_HISTORY_MAX_SNAPSHOTS);
    return json(request, {
      ok: true,
      message: Object.keys(updates).length
        ? "이미 추적 중인 플레이스입니다. 장소 식별값을 보강하고 기존 기록을 이어서 표시합니다."
        : "이미 추적 중인 플레이스입니다. 기존 기록을 이어서 표시합니다.",
      tracker: placeTrackerPayload(existingTracker, snapshots.get(existingRow.id) || []),
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
  const initialProcessingToken = crypto.randomUUID();
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .insert({
      client_id: await findClientId(ctx, agencyCode),
      agency_code: agencyCode,
      keyword,
      place_url: placeUrl || null,
      place_id: placeId || null,
      place_name: placeName || null,
      max_rank: clampMaxRank(),
      status: "active",
      started_at: now.toISOString(),
      next_check_at: now.toISOString(),
      processing_token: initialProcessingToken,
      processing_started_at: now.toISOString(),
      processing_until: new Date(now.getTime() + PLACE_TRACKER_LEASE_SECONDS * 1000).toISOString(),
      last_attempt_at: now.toISOString(),
      last_message: "추적 등록 후 첫 플레이스 순위 확인 대기",
      sort_order: nextSortOrder,
    })
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;

  await updateTrackerGroupName(ctx, data.id, agencyCode, groupName);
  const checked = await runPlaceTrackerCheck(ctx, { ...data, group_name: groupName });
  const checkedTracker = await attachTrackerGroup(ctx, { ...checked.tracker, group_name: groupName });
  return json(request, {
    ok: checked.ok,
    configured: hasPlaceRankLookupConfig(placeProviderConfig()),
    lookupMode: placeRankLookupMode(placeProviderConfig()),
    message: checked.message,
    tracker: placeTrackerPayload(checkedTracker, [checked.snapshot].filter(Boolean)),
  }, 201);
}

async function claimPlaceTrackerForManualCheck(ctx, tracker, agencyCode) {
  const now = new Date();
  const processingToken = crypto.randomUUID();
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .update({
      processing_token: processingToken,
      processing_started_at: now.toISOString(),
      processing_until: new Date(now.getTime() + PLACE_TRACKER_LEASE_SECONDS * 1000).toISOString(),
      last_attempt_at: now.toISOString(),
      last_message: "수동 플레이스 순위 갱신 처리 중입니다.",
    })
    .eq("id", tracker.id)
    .in("agency_code", agencyCodeScope(agencyCode))
    .eq("status", "active")
    .or(`processing_until.is.null,processing_until.lte.${now.toISOString()}`)
    .select(TRACKER_SELECT)
    .maybeSingle();

  if (error) throw error;
  return data;
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

  const claimedTracker = await claimPlaceTrackerForManualCheck(ctx, data, agencyCode);
  if (!claimedTracker) {
    return json(request, { ok: false, message: "이미 플레이스 순위 갱신이 진행 중입니다. 잠시 후 다시 시도해주세요." }, 409);
  }
  const tracker = await attachTrackerGroup(ctx, claimedTracker);
  const checked = await runPlaceTrackerCheck(ctx, tracker);
  const checkedTracker = await attachTrackerGroup(ctx, checked.tracker);
  const snapshots = await loadSnapshots(ctx, [checked.tracker.id], PLACE_RANK_HISTORY_MAX_SNAPSHOTS);
  return json(request, {
    ok: checked.ok,
    configured: hasPlaceRankLookupConfig(placeProviderConfig()),
    lookupMode: placeRankLookupMode(placeProviderConfig()),
    message: checked.message,
    tracker: placeTrackerPayload(checkedTracker, snapshots.get(checked.tracker.id) || []),
  });
}

async function deleteTracker(request, ctx, body) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .delete()
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode))
    .select("id");
  if (error) throw error;
  if (!data?.length) return json(request, { ok: false, message: "삭제할 플레이스 추적 항목을 찾을 수 없습니다." }, 404);
  return json(request, { ok: true, deletedId: trackerId, message: "플레이스 추적 항목을 삭제했습니다." });
}

async function updateTrackerGroup(request, ctx, body) {
  const agencyCode = requestAgencyCode(request, body);
  const trackerId = normalizeText(body.trackerId || body.id);
  const groupName = normalizePlaceRankGroupName(body.groupName || body.group_name || body.group);
  if (!trackerId) return json(request, { ok: false, message: "trackerId가 필요합니다." }, 400);

  const updated = await updateTrackerGroupName(ctx, trackerId, agencyCode, groupName);
  if (!updated.ok && updated.missingColumn) {
    return json(request, {
      ok: false,
      message: "그룹 저장 컬럼이 아직 적용되지 않았습니다. DB 마이그레이션 적용 후 다시 시도해주세요.",
    }, 409);
  }
  if (!updated.ok && updated.notFound) {
    return json(request, { ok: false, message: "그룹을 변경할 플레이스 추적 항목을 찾을 수 없습니다." }, 404);
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select(TRACKER_SELECT)
    .eq("id", trackerId)
    .in("agency_code", agencyCodeScope(agencyCode))
    .maybeSingle();

  if (error) throw error;
  if (!data) return json(request, { ok: false, message: "그룹을 변경할 플레이스 추적 항목을 찾을 수 없습니다." }, 404);

  const tracker = await attachTrackerGroup(ctx, { ...data, group_name: groupName });
  return json(request, {
    ok: true,
    message: "플레이스 추적 항목 그룹을 변경했습니다.",
    tracker: placeTrackerPayload(tracker),
  });
}

export async function runDuePlaceTrackers(ctx, options = {}) {
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(
    MAX_CRON_BATCH,
    Number(options.limit || process.env.MI_PLACE_RANK_CRON_BATCH || DEFAULT_CRON_BATCH)
  ));
  const results = [];

  for (let index = 0; index < limit; index += 1) {
    // Claims prevent overlapping hourly and slot-window runs from processing the same tracker.
    // eslint-disable-next-line no-await-in-loop
    const tracker = await claimDuePlaceTracker(ctx, options.agencyCode || "");
    if (!tracker) break;
    // Sequential checks keep the single-browser collector within its concurrency limit.
    // eslint-disable-next-line no-await-in-loop
    results.push(await runPlaceTrackerCheck(ctx, tracker));
  }

  let remainingQuery = ctx.supabaseAdmin
    .from("naver_place_rank_trackers")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .lte("next_check_at", now)
    .or(`processing_until.is.null,processing_until.lte.${now}`);
  if (options.agencyCode) remainingQuery = remainingQuery.in("agency_code", agencyCodeScope(options.agencyCode));
  const remainingResult = await remainingQuery;
  if (remainingResult.error) throw remainingResult.error;
  const remaining = Math.max(0, Number(remainingResult.count || 0));

  return {
    now,
    checked: results.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    found: results.filter((item) => item.outcome === "found").length,
    notFound: results.filter((item) => item.outcome === "not_found").length,
    partial: results.filter((item) => item.outcome === "partial").length,
    remaining,
    drained: remaining === 0,
    configured: hasPlaceRankLookupConfig(placeProviderConfig()),
    lookupMode: placeRankLookupMode(placeProviderConfig()),
    results: results.map((item) => ({
      ok: item.ok,
      outcome: item.outcome,
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
  const ok = summary.failed === 0;
  return json(request, {
    ok,
    message: ok
      ? (summary.checked ? "밀린 플레이스 순위 갱신을 처리했습니다." : "플레이스 갱신 대기 항목이 없습니다.")
      : "일부 플레이스 순위 갱신에 실패해 자동 재시도를 예약했습니다.",
    summary,
  }, ok ? 200 : 502);
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
  if (action === "group") return updateTrackerGroup(request, ctx, body);

  return json(request, { ok: false, message: "지원하지 않는 작업입니다." }, 400);
}

export async function handlePlaceRankTrackersRequest(request, ctx) {
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
}

export default {
  fetch: withSupabase({ auth: "none" }, handlePlaceRankTrackersRequest),
};

import { withSupabase } from "@supabase/server";
import { corsHeaders, protectedJson } from "../security.mjs";
import {
  extractProductId,
  findShoppingRank,
  hasShoppingRankConfig,
  normalizeText,
  shoppingRankConfig,
  shoppingRankMessage,
} from "./naver-shopping-rank.mjs";

const DEFAULT_AGENCY_CODE = "mml-a01";
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
    headers: "authorization, content-type, x-demo-admin-code",
  });
}

function normalizeAgencyCode(value) {
  return normalizeText(value || DEFAULT_AGENCY_CODE).toLowerCase();
}

function requestAgencyCode(request, body = {}) {
  const url = new URL(request.url);
  return normalizeAgencyCode(
    body.agencyCode ||
      body.agency_code ||
      request.headers.get("x-demo-admin-code") ||
      url.searchParams.get("agencyCode") ||
      url.searchParams.get("agency_code")
  );
}

function clampMaxRank(value) {
  const number = Number(value || 300);
  if (!Number.isFinite(number)) return 300;
  return Math.max(100, Math.min(1000, Math.round(number)));
}

function trackerPayload(row, snapshots = []) {
  return {
    id: row.id,
    clientId: row.client_id,
    brandId: row.brand_id,
    agencyCode: row.agency_code,
    keyword: row.keyword,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snapshots: snapshots.map(snapshotPayload),
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
    topItems: row.top_items || [],
    message: row.message,
    source: row.source,
    createdAt: row.created_at,
  };
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function findClientId(ctx, agencyCode) {
  const { data, error } = await ctx.supabaseAdmin
    .from("clients")
    .select("id")
    .ilike("agency_code", agencyCode)
    .maybeSingle();

  if (error) return null;
  return data?.id || null;
}

async function loadSnapshots(ctx, trackerIds, limit = 300) {
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
  const agencyCode = requestAgencyCode(request);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .eq("agency_code", agencyCode)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const snapshots = await loadSnapshots(ctx, (data || []).map((row) => row.id));
  return json(request, {
    ok: true,
    agencyCode,
    trackers: (data || []).map((row) => trackerPayload(row, snapshots.get(row.id) || [])),
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
  const nextCheckAt = addHours(new Date(checkedAt), 3);
  const status = new Date(tracker.ends_at).getTime() <= new Date(checkedAt).getTime()
    ? "completed"
    : tracker.status || "active";
  const bestRank = matchedRank
    ? Math.min(Number(tracker.best_rank || matchedRank), matchedRank)
    : tracker.best_rank;
  const worstRank = matchedRank
    ? Math.max(Number(tracker.worst_rank || matchedRank), matchedRank)
    : tracker.worst_rank;

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({
      status,
      last_checked_at: checkedAt,
      next_check_at: nextCheckAt,
      current_rank: matchedRank,
      best_rank: bestRank || null,
      worst_rank: worstRank || null,
      check_count: Number(tracker.check_count || 0) + 1,
      found_count: Number(tracker.found_count || 0) + (matchedRank ? 1 : 0),
      last_message: message,
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

async function createTracker(request, ctx, body) {
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
    .eq("agency_code", agencyCode)
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
    return json(request, {
      ok: true,
      message: "이미 30일 추적 중인 상품입니다.",
      tracker: trackerPayload(existing.data, snapshots.get(existing.data.id) || []),
    });
  }

  const now = new Date();
  const clientId = await findClientId(ctx, agencyCode);
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
      ends_at: addDays(now, 30),
      next_check_at: now.toISOString(),
      last_message: "추적 등록 후 첫 순위 확인 대기",
    })
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;

  const checked = await runTrackerCheck(ctx, data);
  return json(request, {
    ok: checked.ok,
    message: checked.message,
    tracker: trackerPayload(checked.tracker, [checked.snapshot]),
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
    .eq("agency_code", agencyCode)
    .maybeSingle();

  if (error) throw error;
  if (!data) return json(request, { ok: false, message: "추적 항목을 찾을 수 없습니다." }, 404);

  const checked = await runTrackerCheck(ctx, data);
  return json(request, {
    ok: checked.ok,
    message: checked.message,
    tracker: trackerPayload(checked.tracker, [checked.snapshot]),
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
    .eq("agency_code", agencyCode)
    .select(TRACKER_SELECT)
    .single();

  if (error) throw error;
  return json(request, { ok: true, tracker: trackerPayload(data), message: "추적을 중지했습니다." });
}

export async function runDueTrackers(ctx, options = {}) {
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(50, Number(options.limit || process.env.MI_RANK_CRON_BATCH || 20)));
  let query = ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select(TRACKER_SELECT)
    .eq("status", "active")
    .lte("next_check_at", now)
    .gt("ends_at", now)
    .order("next_check_at", { ascending: true })
    .limit(limit);

  if (options.agencyCode) query = query.eq("agency_code", options.agencyCode);

  const { data, error } = await query;
  if (error) throw error;

  const results = [];
  for (const tracker of data || []) {
    // Sequential checks keep Naver API quota usage predictable.
    // eslint-disable-next-line no-await-in-loop
    results.push(await runTrackerCheck(ctx, tracker));
  }

  await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .update({ status: "completed", last_message: "30일 추적 기간이 종료되었습니다." })
    .eq("status", "active")
    .lte("ends_at", now);

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

  if (action === "create") return createTracker(request, ctx, body);
  if (action === "check") return checkOne(request, ctx, body);
  if (action === "stop") return stopTracker(request, ctx, body);
  if (action === "run-due") {
    const summary = await runDueTrackers(ctx, {
      agencyCode: body.agencyCode ? requestAgencyCode(request, body) : "",
      limit: body.limit,
    });
    return json(request, { ok: true, summary });
  }

  return json(request, { ok: false, message: "지원하지 않는 작업입니다." }, 400);
}

export default {
  fetch: withSupabase({ auth: "none" }, async (request, ctx) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, {
      methods: "GET, POST, OPTIONS",
      headers: "authorization, content-type, x-demo-admin-code",
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

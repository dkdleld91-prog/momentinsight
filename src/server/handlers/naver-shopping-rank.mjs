import { corsHeaders, isLocalRequest, protectedJson } from "../security.mjs";

const NAVER_OPENAPI_BASE_URL = "https://openapi.naver.com";
const RANK_RATE_WINDOW_MS = Number(process.env.MI_RANK_RATE_WINDOW_MS || 60_000);
const RANK_RATE_LIMIT = Number(process.env.MI_RANK_RATE_LIMIT || 20);
const rankRateBucket = new Map();

function config() {
  const openapiClientId = process.env.NAVER_OPENAPI_CLIENT_ID || process.env.NAVER_DATALAB_CLIENT_ID || "";
  const openapiClientSecret = process.env.NAVER_OPENAPI_CLIENT_SECRET || process.env.NAVER_DATALAB_CLIENT_SECRET || "";

  return {
    openapiClientId,
    openapiClientSecret,
  };
}

function hasOpenapiConfig(env) {
  return Boolean(env.openapiClientId && env.openapiClientSecret);
}

function json(request, body, status = 200) {
  return protectedJson(request, body, status);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return normalizeText(String(value || "").replace(/<[^>]*>/g, ""));
}

function normalizeUrl(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^m\./i, "")
    .replace(/^www\./i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function parseNaverNumber(value) {
  const number = Number(String(value || "").replace(/[^\d]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function extractProductId(value) {
  const text = String(value || "");
  const patterns = [
    /[?&](?:nvMid|productId|productNo|catalogId|cat_id)=([0-9]{5,})/i,
    /\/(?:products|catalog)\/([0-9]{5,})/i,
    /\/([0-9]{8,})(?:[/?#]|$)/,
    /\b([0-9]{8,})\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function clientRateKey(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim() || request.headers.get("x-real-ip") || "anonymous";
}

function checkRateLimit(request) {
  if (isLocalRequest(request)) return { allowed: true };
  const now = Date.now();
  const key = clientRateKey(request);
  const fresh = (rankRateBucket.get(key) || []).filter((time) => now - time < RANK_RATE_WINDOW_MS);

  if (fresh.length >= RANK_RATE_LIMIT) {
    rankRateBucket.set(key, fresh);
    const retryAfter = Math.max(1, Math.ceil((RANK_RATE_WINDOW_MS - (now - fresh[0])) / 1000));
    return { allowed: false, retryAfter };
  }

  fresh.push(now);
  rankRateBucket.set(key, fresh);

  if (rankRateBucket.size > 1000) {
    for (const [bucketKey, times] of rankRateBucket.entries()) {
      const activeTimes = times.filter((time) => now - time < RANK_RATE_WINDOW_MS);
      if (activeTimes.length) rankRateBucket.set(bucketKey, activeTimes);
      else rankRateBucket.delete(bucketKey);
    }
  }

  return { allowed: true };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15000));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      const error = new Error(payload?.message || payload?.errorMessage || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchShoppingPage(env, keyword, start) {
  const params = new URLSearchParams({
    query: keyword,
    display: "100",
    start: String(start),
    sort: "sim",
  });

  return fetchJson(`${NAVER_OPENAPI_BASE_URL}/v1/search/shop.json?${params.toString()}`, {
    method: "GET",
    headers: {
      "X-Naver-Client-Id": env.openapiClientId,
      "X-Naver-Client-Secret": env.openapiClientSecret,
    },
  });
}

function itemProductId(item) {
  return String(item?.productId || extractProductId(item?.link) || "");
}

function isTargetItem(item, target) {
  const productId = itemProductId(item);
  if (target.productId && productId === target.productId) return true;

  const itemUrl = normalizeUrl(item?.link);
  if (target.normalizedUrl && itemUrl && itemUrl.includes(target.normalizedUrl)) return true;
  if (target.productId && itemUrl && itemUrl.includes(target.productId)) return true;

  if (target.mallName) {
    const mallMatch = normalizeText(item?.mallName).toLowerCase() === target.mallName.toLowerCase();
    if (mallMatch && target.productTitle) {
      return stripTags(item?.title).replace(/\s/g, "").includes(target.productTitle.replace(/\s/g, ""));
    }
  }

  return false;
}

function serializeItem(item, rank) {
  return {
    rank,
    productId: itemProductId(item),
    title: stripTags(item?.title),
    link: item?.link || "",
    image: item?.image || "",
    mallName: item?.mallName || "",
    lprice: parseNaverNumber(item?.lprice),
    hprice: parseNaverNumber(item?.hprice),
    brand: item?.brand || "",
    maker: item?.maker || "",
    category1: item?.category1 || "",
    category2: item?.category2 || "",
    category3: item?.category3 || "",
    category4: item?.category4 || "",
    productType: item?.productType || "",
  };
}

async function findRank(env, { keyword, targetProductId, targetUrl, targetMallName, targetProductTitle, maxRank }) {
  const target = {
    productId: targetProductId || extractProductId(targetUrl),
    normalizedUrl: normalizeUrl(targetUrl),
    mallName: normalizeText(targetMallName),
    productTitle: normalizeText(targetProductTitle),
  };
  const limit = Math.max(100, Math.min(1000, Number(maxRank || 300)));
  let total = 0;
  const topItems = [];

  for (let start = 1; start <= limit; start += 100) {
    const page = await fetchShoppingPage(env, keyword, start);
    const items = Array.isArray(page?.items) ? page.items : [];
    total = Number(page?.total || total || 0);

    items.slice(0, Math.max(0, 5 - topItems.length)).forEach((item, index) => {
      topItems.push(serializeItem(item, start + index));
    });

    const matchedIndex = items.findIndex((item) => isTargetItem(item, target));
    if (matchedIndex >= 0) {
      const rank = start + matchedIndex;
      return {
        matched: true,
        rank,
        page: Math.ceil(rank / 100),
        position: matchedIndex + 1,
        total,
        checkedCount: start + items.length - 1,
        targetProductId: target.productId,
        item: serializeItem(items[matchedIndex], rank),
        topItems,
      };
    }

    if (!items.length || items.length < 100) break;
  }

  return {
    matched: false,
    rank: null,
    page: null,
    position: null,
    total,
    checkedCount: Math.min(limit, total || limit),
    targetProductId: target.productId,
    item: null,
    topItems,
  };
}

function rankMessage(result) {
  if (result.matched) return `${result.rank}위로 확인되었습니다.`;
  if (result.total) return `상위 ${result.checkedCount}위 안에서 대상 상품을 찾지 못했습니다.`;
  return "검색 결과에서 대상 상품을 찾지 못했습니다.";
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (request.method !== "GET") return json(request, { ok: false, message: "Method not allowed" }, 405);

    const rate = checkRateLimit(request);
    if (!rate.allowed) {
      return json(request, {
        ok: false,
        code: "RANK_RATE_LIMITED",
        message: "순위 조회 요청이 많습니다. 잠시 후 다시 시도해주세요.",
        retryAfter: rate.retryAfter,
      }, 429);
    }

    const env = config();
    if (!hasOpenapiConfig(env)) {
      return json(request, {
        ok: false,
        code: "NAVER_OPENAPI_NOT_CONFIGURED",
        message: "네이버 쇼핑 검색 API가 아직 연결되지 않았습니다.",
        sourceStatus: {
          shoppingRank: { status: "not_configured", label: "네이버 쇼핑 API 연결 필요" },
        },
      }, 503);
    }

    const url = new URL(request.url);
    const keyword = normalizeText(url.searchParams.get("keyword"));
    const targetUrl = normalizeText(url.searchParams.get("targetUrl"));
    const productId = normalizeText(url.searchParams.get("productId")) || extractProductId(targetUrl);
    const targetMallName = normalizeText(url.searchParams.get("mallName"));
    const targetProductTitle = normalizeText(url.searchParams.get("productTitle"));
    const maxRank = Number(url.searchParams.get("maxRank") || 300);

    if (!keyword) return json(request, { ok: false, message: "키워드를 입력해주세요." }, 400);
    if (!targetUrl && !productId && !targetMallName) {
      return json(request, { ok: false, message: "상품 URL 또는 상품ID를 입력해주세요." }, 400);
    }

    try {
      const result = await findRank(env, {
        keyword,
        targetProductId: productId,
        targetUrl,
        targetMallName,
        targetProductTitle,
        maxRank,
      });

      return json(request, {
        ok: true,
        source: "naver_shopping_search_api",
        sourceStatus: {
          shoppingRank: { status: result.matched ? "ok" : "not_found", label: result.matched ? "순위 확인" : "대상 상품 미발견" },
        },
        checkedAt: new Date().toISOString(),
        query: {
          keyword,
          targetUrl,
          productId,
          targetMallName,
          targetProductTitle,
          maxRank: Math.max(100, Math.min(1000, maxRank || 300)),
        },
        result,
        message: rankMessage(result),
      });
    } catch {
      return json(request, {
        ok: false,
        code: "SHOPPING_RANK_LOOKUP_FAILED",
        message: "네이버 순위 조회 중 오류가 발생했습니다.",
      }, 500);
    }
  },
};

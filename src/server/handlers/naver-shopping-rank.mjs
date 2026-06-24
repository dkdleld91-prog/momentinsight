import { corsHeaders, isLocalRequest, protectedJson } from "../security.mjs";

const NAVER_OPENAPI_BASE_URL = "https://openapi.naver.com";
const NAVER_SHOPPING_API_DISPLAY = 100;
const ORGANIC_PAGE_SIZE = 40;
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

function parseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function productIdCandidates(value) {
  const text = String(value || "");
  const candidates = [];
  const parsed = parseUrl(text);

  if (parsed) {
    const params = parsed.searchParams;
    ["nvMid", "productId", "productNo", "catalogId"].forEach((key) => {
      const found = params.get(key);
      if (/^[0-9]{5,}$/.test(found || "")) candidates.push(found);
    });

    const path = decodeURIComponent(parsed.pathname || "");
    [
      /\/(?:products|product|catalog)\/([0-9]{5,})(?:[/?#]|$)/i,
      /\/([0-9]{8,})(?:[/?#]|$)/,
    ].forEach((pattern) => {
      const match = path.match(pattern);
      if (match?.[1]) candidates.push(match[1]);
    });

    return uniqueValues(candidates);
  }

  if (/^[0-9]{5,}$/.test(text.trim())) return [text.trim()];
  return [];
}

function canonicalUrlKey(value) {
  const parsed = parseUrl(value);
  if (!parsed) return "";
  const host = parsed.hostname.toLowerCase().replace(/^m\./, "").replace(/^www\./, "");
  const pathName = decodeURIComponent(parsed.pathname || "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
  if (!host || !pathName || pathName === "/") return "";
  return `${host}${pathName}`;
}

function safeProductUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw) && /(^|\.)naver\.com/i.test(raw)) {
    raw = `https://${raw}`;
  }
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const isNaverHost = host === "naver.com" || host.endsWith(".naver.com");
    return isNaverHost ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function metaContent(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeHtml(match[1]);
    }
  }
  return "";
}

function titleContent(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtml(match?.[1] || "");
}

function parseNaverNumber(value) {
  const number = Number(String(value || "").replace(/[^\d]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function extractProductId(value) {
  return productIdCandidates(value)[0] || "";
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

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 12000));
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 MomentInsightBot/1.0",
        ...(options.headers || {}),
      },
    });
    if (!response.ok) return "";
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function productUrlItem(targetUrl, productId, overrides = {}) {
  const safeUrl = safeProductUrl(targetUrl);
  const id = productId || extractProductId(targetUrl);
  if (!safeUrl && !id) return null;
  return {
    rank: null,
    productId: id,
    title: "",
    link: safeUrl,
    image: "",
    mallName: "",
    lprice: 0,
    hprice: 0,
    brand: "",
    maker: "",
    category1: "",
    category2: "",
    category3: "",
    category4: "",
    productType: "",
    source: "product_url",
    ...overrides,
  };
}

async function fetchProductMetadata(targetUrl, productId) {
  const safeUrl = safeProductUrl(targetUrl);
  if (!safeUrl) return productUrlItem(targetUrl, productId);

  const html = await fetchText(safeUrl);
  if (!html) return productUrlItem(targetUrl, productId);

  const parsed = new URL(safeUrl);
  const ogTitle = metaContent(html, ["og:title", "twitter:title"]);
  const rawTitle = ogTitle || titleContent(html);
  const title = stripTags(rawTitle)
    .replace(/\s*[:|-]\s*네이버\s*(쇼핑|스마트스토어)?\s*$/i, "")
    .replace(/\s*네이버\s*(쇼핑|스마트스토어)\s*$/i, "")
    .trim();
  const image = metaContent(html, ["og:image", "twitter:image"]);
  const description = metaContent(html, ["og:description", "description"]);
  const price = parseNaverNumber(
    metaContent(html, ["product:price:amount", "og:price:amount"]) ||
    html.match(/"(?:salePrice|lowPrice|price|lprice)"\s*:\s*"?([0-9,]+)"?/i)?.[1] ||
    description.match(/([0-9,]+)\s*원/)?.[1]
  );
  const storePath = parsed.hostname === "smartstore.naver.com" || parsed.hostname === "brand.naver.com"
    ? decodeURIComponent(parsed.pathname.split("/").filter(Boolean)[0] || "")
    : "";

  const blockedTitle = title === "네이버쇼핑" && !image && !price;
  const blockedBody = /쇼핑 서비스 접속이 일시적으로 제한|content_error/i.test(html);

  return productUrlItem(targetUrl, productId, {
    title: blockedTitle || blockedBody ? "" : title,
    image,
    mallName: storePath || "",
    lprice: price,
  });
}

async function fetchShoppingPage(env, keyword, start) {
  const params = new URLSearchParams({
    query: keyword,
    display: String(NAVER_SHOPPING_API_DISPLAY),
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

function itemProductIds(item) {
  return uniqueValues([item?.productId, ...productIdCandidates(item?.link)]);
}

function isTruthyAdValue(value) {
  if (value === true) return true;
  if (typeof value === "number") return value > 0;
  const text = normalizeText(value).toLowerCase();
  if (!text) return false;
  return ["true", "1", "y", "yes", "ad", "ads", "sponsored", "paid", "광고"].includes(text);
}

function isAdItem(item) {
  if (!item || typeof item !== "object") return false;
  const directKeys = [
    "ad",
    "ads",
    "isAd",
    "is_ad",
    "adId",
    "ad_id",
    "adType",
    "ad_type",
    "sponsored",
    "isSponsored",
    "is_sponsored",
    "advertising",
    "isAdvertising",
    "is_advertising",
    "promoted",
    "isPromoted",
    "is_promoted",
    "paid",
    "isPaid",
    "is_paid",
  ];
  if (directKeys.some((key) => isTruthyAdValue(item[key]))) return true;
  return Object.entries(item).some(([key, value]) => {
    if (!/(^|_)(ad|ads|sponsored|advertising|promoted|paid)(_|$)/i.test(key)) return false;
    return isTruthyAdValue(value);
  });
}

function matchTargetItem(item, target) {
  const itemIds = itemProductIds(item);
  const targetIds = Array.isArray(target.productIds) ? target.productIds : uniqueValues([target.productId]);
  const targetUrlKeys = Array.isArray(target.urlKeys) ? target.urlKeys : uniqueValues([target.normalizedUrl]);
  const hasDirectTarget = Boolean(target.hasDirectTarget || targetIds.length || targetUrlKeys.length);
  const matchedProductId = itemIds.find((id) => targetIds.includes(id));
  if (matchedProductId) {
    return { matched: true, matchType: "product_id", matchedProductId };
  }

  const itemUrlKey = canonicalUrlKey(item?.link);
  if (targetUrlKeys.length && itemUrlKey && targetUrlKeys.includes(itemUrlKey)) {
    return { matched: true, matchType: "canonical_url" };
  }

  if (!hasDirectTarget && target.mallName) {
    const mallMatch = normalizeText(item?.mallName).toLowerCase() === target.mallName.toLowerCase();
    const targetTitle = target.productTitle.replace(/\s/g, "");
    const itemTitle = stripTags(item?.title).replace(/\s/g, "");
    if (mallMatch && targetTitle.length >= 6 && itemTitle.includes(targetTitle)) {
      return { matched: true, matchType: "mall_title" };
    }
  }

  return { matched: false, matchType: "" };
}

function rankPagePosition(rank, pageSize = ORGANIC_PAGE_SIZE) {
  const rankNumber = Number(rank || 0);
  const size = Math.max(1, Number(pageSize || ORGANIC_PAGE_SIZE));
  if (!Number.isFinite(rankNumber) || rankNumber < 1) {
    return { page: null, position: null, pageSize: size };
  }
  return {
    page: Math.ceil(rankNumber / size),
    position: ((rankNumber - 1) % size) + 1,
    pageSize: size,
  };
}

function buildRankTarget({ targetProductId = "", targetUrl = "", targetMallName = "", targetProductTitle = "" } = {}) {
  const targetProductIds = uniqueValues([targetProductId, ...productIdCandidates(targetUrl)]);
  return {
    productId: targetProductIds[0] || "",
    productIds: targetProductIds,
    normalizedUrl: normalizeUrl(targetUrl),
    urlKeys: uniqueValues([canonicalUrlKey(targetUrl)]),
    hasDirectTarget: Boolean(targetProductId || targetUrl),
    mallName: normalizeText(targetMallName),
    productTitle: normalizeText(targetProductTitle),
  };
}

function serializeItem(item, rank) {
  return {
    rank,
    rankBasis: "organic",
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
    isAd: isAdItem(item),
  };
}

function findOrganicMatchInItems(items, target, options = {}) {
  const topItems = Array.isArray(options.topItems) ? options.topItems : [];
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : Infinity;
  let organicCheckedCount = Number(options.organicOffset || 0);
  let rawCheckedCount = Number(options.rawOffset || 0);
  let excludedAdCount = Number(options.excludedAdCount || 0);
  let stoppedAtLimit = false;

  for (const item of items || []) {
    rawCheckedCount += 1;
    if (isAdItem(item)) {
      excludedAdCount += 1;
      continue;
    }

    if (organicCheckedCount >= limit) {
      stoppedAtLimit = true;
      break;
    }

    organicCheckedCount += 1;
    if (topItems.length < 5) topItems.push(serializeItem(item, organicCheckedCount));

    const match = matchTargetItem(item, target);
    if (match.matched) {
      const position = rankPagePosition(organicCheckedCount);
      return {
        matched: true,
        rank: organicCheckedCount,
        page: position.page,
        position: position.position,
        pageSize: position.pageSize,
        matchType: match.matchType,
        matchedProductId: match.matchedProductId || "",
        item,
        topItems,
        organicCheckedCount,
        rawCheckedCount,
        excludedAdCount,
        stoppedAtLimit,
      };
    }
  }

  return {
    matched: false,
    topItems,
    organicCheckedCount,
    rawCheckedCount,
    excludedAdCount,
    stoppedAtLimit,
  };
}

async function findRank(env, { keyword, targetProductId, targetUrl, targetMallName, targetProductTitle, maxRank }) {
  const target = buildRankTarget({ targetProductId, targetUrl, targetMallName, targetProductTitle });
  const limit = Math.max(100, Math.min(1000, Number(maxRank || 300)));
  let total = 0;
  let organicCheckedCount = 0;
  let rawCheckedCount = 0;
  let excludedAdCount = 0;
  const topItems = [];

  for (let start = 1; start <= 1000 && organicCheckedCount < limit; start += NAVER_SHOPPING_API_DISPLAY) {
    const page = await fetchShoppingPage(env, keyword, start);
    const items = Array.isArray(page?.items) ? page.items : [];
    total = Number(page?.total || total || 0);
    const ranked = findOrganicMatchInItems(items, target, {
      organicOffset: organicCheckedCount,
      rawOffset: rawCheckedCount,
      excludedAdCount,
      limit,
      topItems,
    });
    organicCheckedCount = ranked.organicCheckedCount;
    rawCheckedCount = ranked.rawCheckedCount;
    excludedAdCount = ranked.excludedAdCount;

    if (ranked.matched) {
      return {
        matched: true,
        rank: ranked.rank,
        page: ranked.page,
        position: ranked.position,
        pageSize: ranked.pageSize,
        rankBasis: "organic",
        matchType: ranked.matchType,
        matchedProductId: ranked.matchedProductId || "",
        total,
        checkedCount: ranked.organicCheckedCount,
        organicCheckedCount: ranked.organicCheckedCount,
        rawCheckedCount: ranked.rawCheckedCount,
        excludedAdCount: ranked.excludedAdCount,
        targetProductId: target.productId,
        targetProductIds: target.productIds,
        targetUrlKeys: target.urlKeys,
        item: serializeItem(ranked.item, ranked.rank),
        topItems,
      };
    }

    if (ranked.stoppedAtLimit || !items.length || items.length < NAVER_SHOPPING_API_DISPLAY) break;
  }

  const metadataItem = await fetchProductMetadata(targetUrl, target.productId).catch(() => null);
  return {
    matched: false,
    rank: null,
    page: null,
    position: null,
    pageSize: ORGANIC_PAGE_SIZE,
    rankBasis: "organic",
    total,
    checkedCount: Math.min(limit, organicCheckedCount),
    organicCheckedCount,
    rawCheckedCount,
    excludedAdCount,
    targetProductId: target.productId,
    targetProductIds: target.productIds,
    targetUrlKeys: target.urlKeys,
    item: metadataItem,
    topItems,
  };
}

function rankMessage(result) {
  if (result.matched) return `광고 제외 오가닉 ${result.rank}위로 확인되었습니다.`;
  if (result.total) return `광고 제외 오가닉 상위 ${result.checkedCount}위 안에서 대상 상품을 찾지 못했습니다.`;
  return "검색 결과에서 대상 상품을 찾지 못했습니다.";
}

export {
  config as shoppingRankConfig,
  extractProductId,
  productIdCandidates,
  canonicalUrlKey,
  buildRankTarget,
  findOrganicMatchInItems,
  isAdItem,
  matchTargetItem,
  rankPagePosition,
  findRank as findShoppingRank,
  hasOpenapiConfig as hasShoppingRankConfig,
  normalizeText,
  rankMessage as shoppingRankMessage,
};

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
          shoppingRank: { status: result.matched ? "ok" : "not_found", label: result.matched ? "오가닉 순위 확인" : "오가닉 상품 미발견" },
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

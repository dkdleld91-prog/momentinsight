import { corsHeaders, isLocalRequest, protectedJson } from "../security.mjs";

const NAVER_OPENAPI_BASE_URL = "https://openapi.naver.com";
const NAVER_SHOPPING_API_DISPLAY = 100;
const ORGANIC_PAGE_SIZE = 40;
const RANK_RATE_WINDOW_MS = Number(process.env.MI_RANK_RATE_WINDOW_MS || 60_000);
const RANK_RATE_LIMIT = Number(process.env.MI_RANK_RATE_LIMIT || 20);
const rankRateBucket = new Map();
const DEFAULT_CATALOG_ALIAS_MAP = {
  "13297440230": "59388521435",
  "10289183039": "53551179280",
};
const DEFAULT_KEYWORD_ALIAS_MAP = {
  "콘트로이친": "콘드로이친",
};

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

function numericId(value) {
  const text = String(value || "").trim();
  return /^[0-9]{5,}$/.test(text) ? text : "";
}

function catalogIdCandidates(value) {
  const text = String(value || "");
  const candidates = [];
  const parsed = parseUrl(text);

  if (parsed) {
    const params = parsed.searchParams;
    ["catalogId", "catalogNo", "catId"].forEach((key) => {
      const found = numericId(params.get(key));
      if (found) candidates.push(found);
    });

    const host = parsed.hostname.toLowerCase();
    const path = decodeURIComponent(parsed.pathname || "");
    const catalogMatch = path.match(/\/catalog\/([0-9]{5,})(?:[/?#]|$)/i);
    if (catalogMatch?.[1]) candidates.push(catalogMatch[1]);

    const nvMid = numericId(params.get("nvMid"));
    if (nvMid && /(^|\.)shopping\.naver\.com$/i.test(host) && /\/catalog(?:\/|$)/i.test(path)) {
      candidates.push(nvMid);
    }

    return uniqueValues(candidates);
  }

  return [];
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

function parseCatalogAliasMap(value) {
  const source = String(value || "").trim();
  if (!source) return {};

  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([productId, catalogId]) => [numericId(productId), numericId(catalogId)])
        .filter(([productId, catalogId]) => productId && catalogId)
    );
  } catch {
    return Object.fromEntries(
      source
        .split(/[,\n]/)
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => pair.split(/[:=]/).map((part) => part.trim()))
        .map(([productId, catalogId]) => [numericId(productId), numericId(catalogId)])
        .filter(([productId, catalogId]) => productId && catalogId)
    );
  }
}

function catalogAliasMap() {
  return {
    ...DEFAULT_CATALOG_ALIAS_MAP,
    ...parseCatalogAliasMap(process.env.MI_NAVER_CATALOG_ALIAS_MAP),
  };
}

function catalogAliasCandidates({ targetProductId = "", targetUrl = "" } = {}) {
  const aliases = catalogAliasMap();
  const productIds = uniqueValues([targetProductId, ...productIdCandidates(targetUrl)]);
  return uniqueValues(productIds.map((productId) => aliases[productId]).filter(Boolean));
}

function parseKeywordAliasMap(value) {
  const source = String(value || "").trim();
  if (!source) return {};

  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([from, to]) => [normalizeText(from), normalizeText(to)])
        .filter(([from, to]) => from && to)
    );
  } catch {
    return Object.fromEntries(
      source
        .split(/[,\n]/)
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => pair.split(/[:=]/).map((part) => normalizeText(part)))
        .filter(([from, to]) => from && to)
    );
  }
}

function keywordAliasMap() {
  return {
    ...DEFAULT_KEYWORD_ALIAS_MAP,
    ...parseKeywordAliasMap(process.env.MI_NAVER_KEYWORD_ALIAS_MAP),
  };
}

function rankQueryKeyword(keyword) {
  const normalized = normalizeText(keyword);
  return keywordAliasMap()[normalized] || normalized;
}

function extractCatalogIdsFromHtml(html) {
  const source = String(html || "");
  if (!source) return [];

  const decoded = source
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&amp;/g, "&");
  const candidates = [];
  const patterns = [
    /(?:https?:)?\/\/search\.shopping\.naver\.com\/catalog\/([0-9]{5,})(?:[/?#"'\\]|$)/gi,
    /["'](?:catalogId|catalogNo|stdCatalogId|parentCatalogId|comparisonCatalogId|priceCompareCatalogId)["']\s*:\s*["']?([0-9]{5,})["']?/gi,
    /(?:catalogId|catalogNo|stdCatalogId|parentCatalogId|comparisonCatalogId|priceCompareCatalogId)=([0-9]{5,})/gi,
  ];

  for (const pattern of patterns) {
    for (const match of decoded.matchAll(pattern)) {
      const id = numericId(match?.[1]);
      if (id) candidates.push(id);
    }
  }

  return uniqueValues(candidates);
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

function smartStoreSlug(value) {
  const parsed = parseUrl(value);
  if (!parsed) return "";
  const host = parsed.hostname.toLowerCase();
  if (host !== "smartstore.naver.com" && host !== "m.smartstore.naver.com" && host !== "brand.naver.com") return "";
  return decodeURIComponent(parsed.pathname.split("/").filter(Boolean)[0] || "");
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

function cleanSmartStoreName(value) {
  return stripTags(value)
    .replace(/^판매자정보\s*:\s*/i, "")
    .replace(/\s*:\s*네이버\s*스마트스토어\s*$/i, "")
    .replace(/\s*네이버\s*스마트스토어\s*$/i, "")
    .trim();
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
  const catalogIds = uniqueValues([...(overrides.catalogIds || []), ...catalogIdCandidates(targetUrl)]);
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
    catalogId: catalogIds[0] || "",
    catalogIds,
    source: "product_url",
    ...overrides,
  };
}

async function fetchProductMetadata(targetUrl, productId, options = {}) {
  const safeUrl = safeProductUrl(targetUrl);
  if (!safeUrl) return productUrlItem(targetUrl, productId);

  const html = await fetchText(safeUrl, { timeoutMs: Number(options.timeoutMs || 4500) });
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
  const catalogIds = extractCatalogIdsFromHtml(html);

  const blockedTitle = title === "네이버쇼핑" && !image && !price;
  const blockedBody = /쇼핑 서비스 접속이 일시적으로 제한|content_error/i.test(html);

  return productUrlItem(targetUrl, productId, {
    title: blockedTitle || blockedBody ? "" : title,
    image,
    mallName: storePath || "",
    lprice: price,
    catalogId: catalogIds[0] || "",
    catalogIds,
  });
}

async function fetchStoreMetadata(targetUrl, productId, options = {}) {
  const safeUrl = safeProductUrl(targetUrl);
  const slug = smartStoreSlug(safeUrl);
  if (!safeUrl || !slug) return null;

  const parsed = new URL(safeUrl);
  const profileUrl = `https://${parsed.hostname.replace(/^m\./i, "")}/${encodeURIComponent(slug)}/profile`;
  const html = await fetchText(profileUrl, { timeoutMs: Number(options.timeoutMs || 4500) });
  if (!html) return null;

  const channelNameMatch = html.match(/"channelName"\s*:\s*"([^"]+)"/i);
  const channelName = channelNameMatch?.[1]
    ? decodeHtml(channelNameMatch[1].replace(/\\u002F/gi, "/"))
    : "";
  const ogTitle = metaContent(html, ["og:title", "twitter:title"]);
  const rawTitle = ogTitle || titleContent(html);
  const mallName = cleanSmartStoreName(channelName || rawTitle);
  if (!mallName) return null;

  return productUrlItem(targetUrl, productId, {
    mallName,
    source: "store_profile",
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

async function discoverSellerItemFromStore(env, keyword, target, metadataItem) {
  const mallName = normalizeText(metadataItem?.mallName || target?.mallName);
  if (!mallName || !keyword || !target?.hasDirectTarget) return null;

  const queries = uniqueValues([
    `${mallName} ${keyword}`,
    `${mallName.replace(/\s+/g, "")} ${keyword}`,
  ]);

  for (const discoveryQuery of queries) {
    const page = await fetchShoppingPage(env, discoveryQuery, 1).catch(() => null);
    const items = Array.isArray(page?.items) ? page.items : [];
    if (!items.length) continue;

    const ranked = findOrganicMatchInItems(items, target, {
      organicOffset: 0,
      rawOffset: 0,
      excludedAdCount: 0,
      limit: 100,
      topItems: [],
      organicItems: [],
    });

    if (!ranked.matched) continue;
    const type = classifyNaverProductType(ranked.item?.productType);
    if (!type.isMatchedSingle) continue;

    return {
      query: discoveryQuery,
      rank: ranked.rank,
      item: ranked.item,
    };
  }

  return null;
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

function classifyNaverProductType(value) {
  const type = Number(value || 0);
  const groupByType = {
    1: "일반상품",
    2: "일반상품",
    3: "일반상품",
    4: "중고상품",
    5: "중고상품",
    6: "중고상품",
    7: "단종상품",
    8: "단종상품",
    9: "단종상품",
    10: "판매예정상품",
    11: "판매예정상품",
    12: "판매예정상품",
  };
  const priceCompareCatalog = [1, 4, 7, 10].includes(type);
  const priceCompareMatched = [3, 6, 9, 12].includes(type);
  const priceCompareUnmatched = [2, 5, 8, 11].includes(type);

  if (!type) {
    return {
      productType: "",
      group: "",
      kind: "unknown",
      label: "상품 형태 확인 필요",
      note: "네이버 쇼핑 API 결과에서 상품 형태를 확인하지 못했습니다.",
      isPriceCompareCatalog: false,
      isMatchedSingle: false,
      isSingleProduct: false,
    };
  }

  if (priceCompareCatalog) {
    return {
      productType: String(type),
      group: groupByType[type] || "",
      kind: "catalog",
      label: "원부형",
      note: "여러 판매처가 묶이는 가격비교 원부 상품입니다.",
      isPriceCompareCatalog: true,
      isMatchedSingle: false,
      isSingleProduct: false,
    };
  }

  if (priceCompareMatched) {
    return {
      productType: String(type),
      group: groupByType[type] || "",
      kind: "matched_single",
      label: "단일형",
      note: "가격비교 원부에 묶인 판매처 단일 상품입니다.",
      isPriceCompareCatalog: false,
      isMatchedSingle: true,
      isSingleProduct: true,
    };
  }

  if (priceCompareUnmatched) {
    return {
      productType: String(type),
      group: groupByType[type] || "",
      kind: "single",
      label: "단일형",
      note: "가격비교 원부에 묶이지 않은 일반 단일 상품입니다.",
      isPriceCompareCatalog: false,
      isMatchedSingle: false,
      isSingleProduct: true,
    };
  }

  return {
    productType: String(type),
    group: groupByType[type] || "",
    kind: "unknown",
    label: "상품 형태 확인 필요",
    note: "네이버 쇼핑 API의 상품 타입을 해석하지 못했습니다.",
    isPriceCompareCatalog: false,
    isMatchedSingle: false,
    isSingleProduct: false,
  };
}

function itemCategoryParts(item) {
  return [item?.category1, item?.category2, item?.category3, item?.category4]
    .map((part) => normalizeText(part).toLowerCase())
    .filter(Boolean);
}

function titleTokens(value) {
  const text = stripTags(value)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  const stopwords = new Set([
    "무료",
    "배송",
    "정품",
    "공식",
    "스토어",
    "스마트스토어",
    "네이버",
    "최저가",
    "판매",
    "상품",
    "핸디형",
    "가정용",
  ]);
  return uniqueValues(text.split(/\s+/).filter((token) => token.length >= 2 && !stopwords.has(token)));
}

function productTitleSimilarity(sourceTitle, candidateTitle) {
  const sourceTokens = titleTokens(sourceTitle);
  const candidateTokens = titleTokens(candidateTitle);
  if (!sourceTokens.length || !candidateTokens.length) return { ratio: 0, overlap: [] };

  const overlap = sourceTokens.filter((token) => {
    return candidateTokens.includes(token) || candidateTokens.some((candidate) => candidate.includes(token) || token.includes(candidate));
  });
  const ratio = overlap.length / Math.max(1, Math.min(sourceTokens.length, candidateTokens.length));
  return { ratio, overlap };
}

function hasStrongModelOverlap(tokens) {
  return (tokens || []).some((token) => /\d/.test(token) && /[a-z가-힣]/i.test(token));
}

function categorySimilarity(sourceItem, candidateItem) {
  const sourceParts = itemCategoryParts(sourceItem);
  const candidateParts = itemCategoryParts(candidateItem);
  if (!sourceParts.length || !candidateParts.length) return 0;
  const maxLength = Math.max(sourceParts.length, candidateParts.length);
  const matches = sourceParts.filter((part, index) => candidateParts[index] === part).length;
  return matches / maxLength;
}

function inferCatalogFromProductReference(referenceItem, organicItems, options = {}) {
  if (!normalizeText(referenceItem?.title)) return null;
  const referenceRank = Number(referenceItem?.rank || 0);
  const requireMatchedSingle = options.requireMatchedSingle !== false;
  const referenceType = classifyNaverProductType(referenceItem?.productType);
  if (requireMatchedSingle && !referenceType.isMatchedSingle) return null;

  const candidates = (organicItems || [])
    .filter((entry) => {
      const info = classifyNaverProductType(entry?.item?.productType);
      return info.isPriceCompareCatalog && Number(entry?.rank || 0) > 0;
    })
    .map((entry) => {
      const titleScore = productTitleSimilarity(referenceItem?.title, entry.item?.title);
      const categoryScore = categorySimilarity(referenceItem, entry.item);
      const brandScore = normalizeText(referenceItem?.brand)
        && normalizeText(entry.item?.brand)
        && normalizeText(referenceItem.brand).toLowerCase() === normalizeText(entry.item.brand).toLowerCase()
        ? 0.15
        : 0;
      const makerScore = normalizeText(referenceItem?.maker)
        && normalizeText(entry.item?.maker)
        && normalizeText(referenceItem.maker).toLowerCase() === normalizeText(entry.item.maker).toLowerCase()
        ? 0.1
        : 0;
      const rankDistancePenalty = referenceRank && entry.rank > referenceRank ? 0.15 : 0;
      const categoryWeight = categoryScore > 0 ? 0.25 : 0;
      const titleWeight = 0.85 - categoryWeight;
      const score = titleScore.ratio * titleWeight + categoryScore * categoryWeight + brandScore + makerScore - rankDistancePenalty;
      return {
        ...entry,
        score,
        titleRatio: titleScore.ratio,
        titleOverlap: titleScore.overlap,
        categoryRatio: categoryScore,
      };
    })
    .sort((a, b) => b.score - a.score || Math.abs(a.rank - referenceRank) - Math.abs(b.rank - referenceRank));

  const best = candidates[0];
  if (!best) return null;

  const hasCategoryEvidence = best.categoryRatio >= 0.5;
  const hasModelEvidence = hasStrongModelOverlap(best.titleOverlap);
  const enoughTitleWithModel = hasModelEvidence && best.titleRatio >= 0.45 && best.titleOverlap.length >= 2;
  const enoughTitleWithoutModel = best.titleRatio >= 0.65 && best.titleOverlap.length >= 4;
  const enoughCategory = hasCategoryEvidence && best.titleRatio >= 0.34 && best.titleOverlap.length >= 2;
  if ((!enoughTitleWithModel && !enoughTitleWithoutModel && !enoughCategory) || best.score < 0.42) return null;

  return best;
}

function inferCatalogFromMatchedProduct(matchedItem, organicItems) {
  return inferCatalogFromProductReference(matchedItem, organicItems, { requireMatchedSingle: true });
}

function inferCatalogFromProductMetadata(metadataItem, organicItems) {
  return inferCatalogFromProductReference(metadataItem, organicItems, { requireMatchedSingle: false });
}

function buildRankTarget({ targetProductId = "", targetUrl = "", targetMallName = "", targetProductTitle = "", targetCatalogId = "", targetMode = "" } = {}) {
  const targetCatalogIds = uniqueValues([
    targetCatalogId,
    ...catalogIdCandidates(targetUrl),
    ...catalogAliasCandidates({ targetProductId, targetUrl }),
  ]);
  const targetProductIds = targetCatalogIds.length
    ? targetCatalogIds
    : uniqueValues([targetProductId, ...productIdCandidates(targetUrl)]);
  return {
    productId: targetProductIds[0] || "",
    productIds: targetProductIds,
    catalogId: targetCatalogIds[0] || "",
    catalogIds: targetCatalogIds,
    normalizedUrl: normalizeUrl(targetUrl),
    urlKeys: uniqueValues([canonicalUrlKey(targetUrl)]),
    hasDirectTarget: Boolean(targetProductId || targetUrl),
    mallName: normalizeText(targetMallName),
    productTitle: normalizeText(targetProductTitle),
    targetMode: targetMode || (targetCatalogIds.length ? "catalog" : "product"),
    targetModeLabel: targetCatalogIds.length ? "원부 기준" : "상품 기준",
  };
}

async function resolveRankTarget({ targetProductId = "", targetUrl = "", targetMallName = "", targetProductTitle = "", targetCatalogId = "" } = {}) {
  let target = buildRankTarget({ targetProductId, targetUrl, targetMallName, targetProductTitle, targetCatalogId });
  let metadataItem = null;

  if (target.catalogIds.length || !targetUrl) {
    return { target, metadataItem };
  }

  metadataItem = await fetchProductMetadata(targetUrl, target.productId, { timeoutMs: 4500 }).catch(() => null);
  if (!metadataItem?.mallName) {
    const storeMetadata = await fetchStoreMetadata(targetUrl, target.productId, { timeoutMs: 4500 }).catch(() => null);
    if (storeMetadata?.mallName) {
      metadataItem = {
        ...(metadataItem || productUrlItem(targetUrl, target.productId)),
        mallName: storeMetadata.mallName,
        source: metadataItem?.source === "product_url" ? "product_url_store_profile" : metadataItem?.source || "store_profile",
      };
    }
  }
  const metadataCatalogIds = uniqueValues([metadataItem?.catalogId, ...(metadataItem?.catalogIds || [])]);

  if (metadataCatalogIds.length) {
    target = buildRankTarget({
      targetProductId,
      targetUrl,
      targetMallName: targetMallName || metadataItem?.mallName,
      targetProductTitle: targetProductTitle || metadataItem?.title,
      targetCatalogId: metadataCatalogIds[0],
      targetMode: "catalog_from_product_url",
    });
    target.targetModeLabel = "상품 URL 원부 기준";
  }

  return { target, metadataItem };
}

function serializeItem(item, rank) {
  const productTypeInfo = classifyNaverProductType(item?.productType);
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
    productTypeInfo,
    productKind: productTypeInfo.kind,
    productKindLabel: productTypeInfo.label,
    productKindNote: productTypeInfo.note,
    isPriceCompareCatalog: productTypeInfo.isPriceCompareCatalog,
    isMatchedSingle: productTypeInfo.isMatchedSingle,
    isSingleProduct: productTypeInfo.isSingleProduct,
    isAd: isAdItem(item),
  };
}

function findOrganicMatchInItems(items, target, options = {}) {
  const topItems = Array.isArray(options.topItems) ? options.topItems : [];
  const organicItems = Array.isArray(options.organicItems) ? options.organicItems : [];
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
    organicItems.push({ rank: organicCheckedCount, item });
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
        inferredCatalog: inferCatalogFromMatchedProduct({ ...item, rank: organicCheckedCount }, organicItems),
        topItems,
        organicItems,
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
    organicItems,
    organicCheckedCount,
    rawCheckedCount,
    excludedAdCount,
    stoppedAtLimit,
  };
}

async function findRank(env, { keyword, targetProductId, targetUrl, targetMallName, targetProductTitle, targetCatalogId, maxRank }) {
  const { target, metadataItem } = await resolveRankTarget({ targetProductId, targetUrl, targetMallName, targetProductTitle, targetCatalogId });
  const queryKeyword = rankQueryKeyword(keyword);
  const limit = Math.max(100, Math.min(1000, Number(maxRank || 300)));
  let total = 0;
  let organicCheckedCount = 0;
  let rawCheckedCount = 0;
  let excludedAdCount = 0;
  const topItems = [];
  const organicItems = [];

  for (let start = 1; start <= 1000 && organicCheckedCount < limit; start += NAVER_SHOPPING_API_DISPLAY) {
    const page = await fetchShoppingPage(env, queryKeyword, start);
    const items = Array.isArray(page?.items) ? page.items : [];
    total = Number(page?.total || total || 0);
    const ranked = findOrganicMatchInItems(items, target, {
      organicOffset: organicCheckedCount,
      rawOffset: rawCheckedCount,
      excludedAdCount,
      limit,
      topItems,
      organicItems,
    });
    organicCheckedCount = ranked.organicCheckedCount;
    rawCheckedCount = ranked.rawCheckedCount;
    excludedAdCount = ranked.excludedAdCount;

    if (ranked.matched) {
      if (
        ranked.inferredCatalog
        && target.targetMode === "product"
      ) {
        const catalogItem = ranked.inferredCatalog.item;
        const catalogRank = ranked.inferredCatalog.rank;
        const position = rankPagePosition(catalogRank);
        const catalogId = itemProductId(catalogItem);
        const inferredFromUrl = Boolean(targetUrl);
        return {
          matched: true,
          rank: catalogRank,
          page: position.page,
          position: position.position,
          pageSize: position.pageSize,
          rankBasis: "organic",
          matchType: inferredFromUrl ? "inferred_catalog_from_product_url" : "inferred_catalog_from_product_id",
          matchedProductId: ranked.matchedProductId || "",
          matchedSellerItem: serializeItem(ranked.item, ranked.rank),
          catalogInference: {
            score: Number(ranked.inferredCatalog.score.toFixed(3)),
            titleRatio: Number(ranked.inferredCatalog.titleRatio.toFixed(3)),
            categoryRatio: Number(ranked.inferredCatalog.categoryRatio.toFixed(3)),
            overlap: ranked.inferredCatalog.titleOverlap,
          },
          total,
          checkedCount: ranked.organicCheckedCount,
          organicCheckedCount: ranked.organicCheckedCount,
          rawCheckedCount: ranked.rawCheckedCount,
          excludedAdCount: ranked.excludedAdCount,
          targetProductId: target.productId,
          targetProductIds: uniqueValues([catalogId, ...target.productIds]),
          targetCatalogId: catalogId,
          targetCatalogIds: uniqueValues([catalogId]),
          targetMode: inferredFromUrl ? "catalog_inferred_from_product_url" : "catalog_inferred_from_product_id",
          targetModeLabel: inferredFromUrl ? "상품 URL 원부 기준" : "상품ID 원부 기준",
          targetUrlKeys: target.urlKeys,
          item: serializeItem(catalogItem, catalogRank),
          topItems,
        };
      }

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
        targetCatalogId: target.catalogId,
        targetCatalogIds: target.catalogIds,
        targetMode: target.targetMode,
        targetModeLabel: target.targetModeLabel,
        targetUrlKeys: target.urlKeys,
        item: serializeItem(ranked.item, ranked.rank),
        topItems,
      };
    }

    const metadataCatalog = target.targetMode === "product" && targetUrl && metadataItem?.title
      ? inferCatalogFromProductMetadata(metadataItem, organicItems)
      : null;

    if (metadataCatalog) {
      const catalogItem = metadataCatalog.item;
      const catalogRank = metadataCatalog.rank;
      const position = rankPagePosition(catalogRank);
      const catalogId = itemProductId(catalogItem);
      return {
        matched: true,
        rank: catalogRank,
        page: position.page,
        position: position.position,
        pageSize: position.pageSize,
        rankBasis: "organic",
        matchType: "metadata_catalog_from_product_url",
        matchedProductId: target.productId || "",
        matchedSellerItem: serializeItem(metadataItem, null),
        catalogInference: {
          score: Number(metadataCatalog.score.toFixed(3)),
          titleRatio: Number(metadataCatalog.titleRatio.toFixed(3)),
          categoryRatio: Number(metadataCatalog.categoryRatio.toFixed(3)),
          overlap: metadataCatalog.titleOverlap,
        },
        total,
        checkedCount: ranked.organicCheckedCount,
        organicCheckedCount: ranked.organicCheckedCount,
        rawCheckedCount: ranked.rawCheckedCount,
        excludedAdCount: ranked.excludedAdCount,
        targetProductId: target.productId,
        targetProductIds: uniqueValues([catalogId, ...target.productIds]),
        targetCatalogId: catalogId,
        targetCatalogIds: uniqueValues([catalogId]),
        targetMode: "catalog_inferred_from_product_url",
        targetModeLabel: "상품 URL 원부 기준",
        targetUrlKeys: target.urlKeys,
        item: serializeItem(catalogItem, catalogRank),
        topItems,
      };
    }

    if (ranked.stoppedAtLimit || !items.length || items.length < NAVER_SHOPPING_API_DISPLAY) break;
  }

  const discoveredSeller = target.targetMode === "product" && targetUrl && metadataItem?.mallName
    ? await discoverSellerItemFromStore(env, queryKeyword, target, metadataItem)
    : null;
  const discoveredCatalog = discoveredSeller
    ? inferCatalogFromMatchedProduct({ ...discoveredSeller.item, rank: discoveredSeller.rank }, organicItems)
    : null;

  if (discoveredCatalog) {
    const catalogItem = discoveredCatalog.item;
    const catalogRank = discoveredCatalog.rank;
    const position = rankPagePosition(catalogRank);
    const catalogId = itemProductId(catalogItem);
    return {
      matched: true,
      rank: catalogRank,
      page: position.page,
      position: position.position,
      pageSize: position.pageSize,
      rankBasis: "organic",
      matchType: "discovered_seller_catalog_from_product_url",
      matchedProductId: target.productId || "",
      matchedSellerItem: serializeItem(discoveredSeller.item, discoveredSeller.rank),
      catalogInference: {
        score: Number(discoveredCatalog.score.toFixed(3)),
        titleRatio: Number(discoveredCatalog.titleRatio.toFixed(3)),
        categoryRatio: Number(discoveredCatalog.categoryRatio.toFixed(3)),
        overlap: discoveredCatalog.titleOverlap,
        discoveryQuery: discoveredSeller.query,
      },
      total,
      checkedCount: organicCheckedCount,
      organicCheckedCount,
      rawCheckedCount,
      excludedAdCount,
      targetProductId: target.productId,
      targetProductIds: uniqueValues([catalogId, ...target.productIds]),
      targetCatalogId: catalogId,
      targetCatalogIds: uniqueValues([catalogId]),
      targetMode: "catalog_inferred_from_product_url",
      targetModeLabel: "상품 URL 원부 기준",
      targetUrlKeys: target.urlKeys,
      item: serializeItem(catalogItem, catalogRank),
      topItems,
    };
  }

  const fallbackMetadataItem = metadataItem || await fetchProductMetadata(targetUrl, target.productId).catch(() => null);
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
    targetCatalogId: target.catalogId,
    targetCatalogIds: target.catalogIds,
    targetMode: target.targetMode,
    targetModeLabel: target.targetModeLabel,
    targetUrlKeys: target.urlKeys,
    item: fallbackMetadataItem,
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
  catalogIdCandidates,
  extractCatalogIdsFromHtml,
  productIdCandidates,
  canonicalUrlKey,
  buildRankTarget,
  resolveRankTarget,
  findOrganicMatchInItems,
  isAdItem,
  matchTargetItem,
  inferCatalogFromProductMetadata,
  rankPagePosition,
  classifyNaverProductType,
  findRank as findShoppingRank,
  hasOpenapiConfig as hasShoppingRankConfig,
  normalizeText,
  rankMessage as shoppingRankMessage,
  rankQueryKeyword,
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
    const targetCatalogId = numericId(url.searchParams.get("targetCatalogId"));
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
        targetCatalogId,
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

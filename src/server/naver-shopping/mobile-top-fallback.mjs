import crypto from "node:crypto";

export const MOBILE_TOP_FALLBACK_SOURCE = "naver_integrated_search_mobile_top_fallback";
export const MOBILE_TOP_FALLBACK_EVIDENCE = "naver_integrated_search_mobile_sas_rank";

const BOOTSTRAP_ORIGIN = "https://m.search.naver.com";
const BFF_ORIGIN = "https://ns-portal.shopping.naver.com";
const INITIAL_STATE_MARKER = 'naver.search.ext.newshopping["shopping"]._INITIAL_STATE=';
const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";
const BFF_PAGE = 1;
const BFF_PAGE_SIZE = 50;
const VERIFIED_SLOT_LIMIT = 50;
// Every SAS card carries Naver's absolute organic rank. The public integrated
// search contract returns at most 50 slots, so exact hits remain authoritative
// through rank 50 while misses are still bounded by the contiguous observed
// prefix and never promoted to a false "not found" result.
const VERIFIED_EXACT_RANK_LIMIT = 50;
const BOOTSTRAP_MAX_BYTES = 2 * 1024 * 1024;
const BFF_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 4_500;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const BLOCK_COOLDOWN_MS = 15 * 60_000;
const SCHEMA_COOLDOWN_MS = 30 * 60_000;
const TRANSIENT_COOLDOWN_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 8;
const MAX_IN_FLIGHT = 2;

const fallbackCache = new Map();
const networkAttempts = [];
const keywordCooldownUntil = new Map();
let globalBlockCooldownUntil = 0;
let inFlight = 0;

export class MobileTopFallbackError extends Error {
  constructor(code, { status = 503, retryable = true, detail = "" } = {}) {
    super(code);
    this.name = "MobileTopFallbackError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value, max = 2_048) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
}

function normalizeKeyword(value) {
  return normalizeText(value, 100).normalize("NFC");
}

function numericId(value) {
  const text = normalizeText(value, 100);
  return /^[0-9]{5,}$/u.test(text) ? text : "";
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function nowMs(now) {
  const value = typeof now === "function" ? now() : Date.now();
  if (value instanceof Date) return value.getTime();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function failSchema(detail) {
  throw new MobileTopFallbackError("shopping_mobile_top_schema_drift", {
    retryable: false,
    detail,
  });
}

function safeHeaderValue(value, field, max = 256) {
  if (typeof value !== "string" && typeof value !== "number") failSchema(field);
  const text = String(value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) failSchema(field);
  return text;
}

function safeHttpUrl(value, { image = false } = {}) {
  const text = normalizeText(value, 2_048);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:") return "";
    const hostname = parsed.hostname.toLowerCase();
    const allowed = hostname === "naver.com"
      || hostname.endsWith(".naver.com")
      || (image && (hostname === "pstatic.net" || hostname.endsWith(".pstatic.net")));
    return allowed ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function stripMarkup(value) {
  return normalizeText(String(value || "").replace(/<[^>]*>/gu, ""), 500);
}

function sanitizeJsonLike(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (
      source.startsWith("undefined", index)
      && !/[A-Za-z0-9_$]/u.test(source[index - 1] || "")
      && !/[A-Za-z0-9_$]/u.test(source[index + 9] || "")
    ) {
      result += "null";
      index += 8;
      continue;
    }
    if (source.startsWith("new Date(", index)) {
      const stringStart = index + "new Date(".length;
      if (source[stringStart] !== '"') failSchema("bootstrap_date");
      let stringEnd = stringStart + 1;
      let stringEscaped = false;
      for (; stringEnd < source.length; stringEnd += 1) {
        const dateCharacter = source[stringEnd];
        if (stringEscaped) stringEscaped = false;
        else if (dateCharacter === "\\") stringEscaped = true;
        else if (dateCharacter === '"') break;
      }
      if (source[stringEnd] !== '"' || source[stringEnd + 1] !== ")") {
        failSchema("bootstrap_date");
      }
      const dateLiteral = source.slice(stringStart, stringEnd + 1);
      try {
        if (Number.isNaN(Date.parse(JSON.parse(dateLiteral)))) failSchema("bootstrap_date");
      } catch (error) {
        if (error instanceof MobileTopFallbackError) throw error;
        failSchema("bootstrap_date");
      }
      result += dateLiteral;
      index = stringEnd + 1;
      continue;
    }
    result += character;
  }
  return result;
}

function extractInitialStateSource(html) {
  if (typeof html !== "string" || !html || html.length > BOOTSTRAP_MAX_BYTES) {
    failSchema("bootstrap_size");
  }
  const markerIndex = html.indexOf(INITIAL_STATE_MARKER);
  if (markerIndex < 0) failSchema("bootstrap_marker");
  let start = markerIndex + INITIAL_STATE_MARKER.length;
  while (/\s/u.test(html[start] || "")) start += 1;
  if (html[start] !== "{") failSchema("bootstrap_object");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
      if (depth < 0) break;
    }
  }
  failSchema("bootstrap_unterminated");
}

function normalizeBypassParams(value) {
  if (!isRecord(value)) failSchema("initProps.byPassBFFParams");
  const entries = Object.entries(value);
  if (entries.length > 40) failSchema("initProps.byPassBFFParams.count");
  const result = {};
  let encodedLength = 0;
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) {
      failSchema(`initProps.byPassBFFParams.${key}`);
    }
    let serialized;
    try {
      serialized = typeof rawValue === "object" && rawValue !== null
        ? JSON.stringify(rawValue)
        : String(rawValue ?? "");
    } catch {
      failSchema(`initProps.byPassBFFParams.${key}`);
    }
    if (serialized.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(serialized)) {
      failSchema(`initProps.byPassBFFParams.${key}`);
    }
    encodedLength += key.length + serialized.length;
    if (encodedLength > 8_000) failSchema("initProps.byPassBFFParams.size");
    result[key] = rawValue;
  }
  return result;
}

export function parseMobileSearchBootstrap(html, expectedKeyword) {
  let state;
  try {
    state = JSON.parse(sanitizeJsonLike(extractInitialStateSource(html)));
  } catch (error) {
    if (error instanceof MobileTopFallbackError) throw error;
    failSchema("bootstrap_json");
  }
  if (!isRecord(state) || !isRecord(state.initProps)) failSchema("bootstrap_state");
  const keyword = normalizeKeyword(state.query || state.initProps.query);
  const originKeyword = normalizeKeyword(state.originQuery || state.initProps.originQuery || keyword);
  const requestedKeyword = normalizeKeyword(expectedKeyword);
  if (!requestedKeyword || keyword !== requestedKeyword || originKeyword !== requestedKeyword) {
    failSchema("bootstrap_query");
  }
  const deviceType = safeHeaderValue(state.device?.type || state.initProps.device?.type, "device.type", 30).toLowerCase();
  if (deviceType !== "mobile") failSchema("device.type");
  if (state.bffHost && safeHeaderValue(state.bffHost, "bffHost", 100) !== "ns-portal.shopping.naver.com") {
    failSchema("bffHost");
  }
  const areaCode = safeHeaderValue(state.areaCode || state.initProps.areaCode, "areaCode", 80);
  if (!/^[A-Za-z0-9_-]+$/u.test(areaCode)) failSchema("areaCode");
  return {
    keyword,
    originKeyword,
    pageId: safeHeaderValue(state.pageId || state.initProps.pageId, "pageId"),
    sessionId: safeHeaderValue(state.sessionId || state.initProps.sessionId, "sessionId"),
    viewType: safeHeaderValue(state.viewType || state.initProps.viewType, "viewType", 80),
    areaCode,
    rev: safeHeaderValue(state.rev || state.initProps.rev || state.initProps.byPassBFFParams?.rev, "rev", 30),
    deviceType,
    byPassBFFParams: normalizeBypassParams(state.initProps.byPassBFFParams),
  };
}

export function buildMobileSearchBootstrapUrl(keyword) {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) throw new MobileTopFallbackError("shopping_mobile_top_invalid_keyword", { status: 400, retryable: false });
  const url = new URL("/search.naver", BOOTSTRAP_ORIGIN);
  url.searchParams.set("where", "m");
  url.searchParams.set("query", normalized);
  return url.toString();
}

export function buildMobilePagedSlotRequest(context) {
  if (!isRecord(context)) failSchema("context");
  const params = {
    ...context.byPassBFFParams,
    isFastDelivery: false,
    isArriveGuarantee: false,
    query: context.keyword,
    source: context.areaCode,
    page: BFF_PAGE,
    pageSize: BFF_PAGE_SIZE,
  };
  const url = new URL("/api/v2/shopping-paged-slot", BFF_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    const serialized = typeof value === "object" ? JSON.stringify(value) : String(value);
    url.searchParams.set(key, serialized);
  }
  if (url.toString().length > 12_000) failSchema("bff_url_size");
  return {
    url: url.toString(),
    headers: {
      accept: "application/json, text/plain, */*",
      referer: buildMobileSearchBootstrapUrl(context.keyword),
      "user-agent": MOBILE_USER_AGENT,
      "x-ns-rev": context.rev,
      "x-ns-page-id": context.pageId,
      "x-ns-session-id": context.sessionId,
      "x-ns-device-type": context.deviceType,
      "x-ns-view-type": context.viewType,
    },
  };
}

function firstImageUrl(value) {
  if (!Array.isArray(value) || !isRecord(value[0])) return "";
  return safeHttpUrl(value[0].imageUrl, { image: true });
}

function productLink(value) {
  if (!isRecord(value)) return "";
  return safeHttpUrl(value.pcUrl) || safeHttpUrl(value.mobileUrl);
}

function parseSasItem(data) {
  const rank = positiveInteger(data.rank);
  if (!rank || rank > VERIFIED_SLOT_LIMIT) failSchema(`sas.rank.${rank || "invalid"}`);
  const cardType = safeHeaderValue(data.cardType, `sas.cardType.${rank}`, 80);
  const productId = numericId(data.nvMid);
  const channelProductId = numericId(data.channelProductId);
  const originalMallProductId = numericId(data.originalMallProductId);
  const catalogMatchingId = numericId(data.catalogMatchingId);
  const isCatalog = cardType === "CATALOG_CARD";
  const catalogId = isCatalog ? productId : "";
  const linkedCatalogId = isCatalog ? "" : catalogMatchingId;
  const sellerProductId = channelProductId || originalMallProductId;
  const title = stripMarkup(data.productName);
  const link = productLink(data.productUrl) || productLink(data.productClickUrl);
  if (!title || (!productId && !sellerProductId && !catalogId && !link)) failSchema(`sas.identity.${rank}`);

  const productType = isCatalog ? 1 : (linkedCatalogId ? 3 : 2);
  const categories = [data.lCatName, data.mCatName, data.sCatName, data.ssCatName]
    .map((value) => normalizeText(value, 200));
  const price = Number(data.discountedSalePrice ?? data.salePrice ?? 0);
  return {
    organicRank: rank,
    isAd: false,
    isOrganic: true,
    sourceType: "SAS",
    cardType,
    productId,
    sellerProductId,
    sellerProductIds: [...new Set([channelProductId, originalMallProductId].filter(Boolean))],
    channelProductId,
    originalMallProductId,
    catalogId,
    linkedCatalogId,
    title,
    link,
    image: firstImageUrl(data.images),
    mallName: normalizeText(data.mallName, 200),
    brand: normalizeText(data.brandName || data.brand, 200),
    maker: normalizeText(data.makerName || data.maker, 200),
    category1: categories[0],
    category2: categories[1],
    category3: categories[2],
    category4: categories[3],
    productType,
    lprice: Number.isFinite(price) && price >= 0 ? price : 0,
  };
}

export function parseMobilePagedSlotPayload(payload, {
  keyword,
  collectedAt = new Date().toISOString(),
  collectionSeed = "",
} = {}) {
  if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.length || payload.data.length > BFF_PAGE) {
    failSchema("bff.data");
  }
  const items = [];
  const identityKeys = new Set();
  let rawCount = 0;
  let excludedAdCount = 0;
  let excludedOtherCount = 0;
  let excludedBeyondVerifiedCount = 0;
  let expectedPage = 1;
  let previousSasRank = 0;
  const observedRanks = new Set();

  for (const page of payload.data) {
    if (!isRecord(page) || positiveInteger(page.page) !== expectedPage || Number(page.pageSize) !== BFF_PAGE_SIZE || !Array.isArray(page.slots)) {
      failSchema(`bff.page.${expectedPage}`);
    }
    if (page.slots.length > 50) failSchema(`bff.page.${expectedPage}.slots`);
    expectedPage += 1;
    for (const slot of page.slots) {
      if (!isRecord(slot)) failSchema("bff.slot");
      const slotItems = Array.isArray(slot.data) ? slot.data : [slot.data];
      if (!slotItems.length || slotItems.length > 20 || slotItems.some((item) => !isRecord(item))) {
        failSchema("bff.slot.data");
      }
      for (const data of slotItems) {
        rawCount += 1;
        if (rawCount > VERIFIED_SLOT_LIMIT) failSchema("bff.slot.window");
        const sourceType = safeHeaderValue(data.sourceType, "slot.sourceType", 80);
        const observedRank = positiveInteger(data.rank);
        if (observedRank > VERIFIED_SLOT_LIMIT) failSchema(`slot.rank.${observedRank}`);
        if (observedRank) observedRanks.add(observedRank);
        // The inventory source is authoritative. SUPER_POINT_CARD can still be
        // an absolute SAS organic rank; only non-SAS inventories are excluded.
        if (sourceType !== "SAS") {
          if (["AD", "AITEMS_FORYOU_AD"].includes(sourceType)) excludedAdCount += 1;
          else excludedOtherCount += 1;
          continue;
        }
        if (observedRank > VERIFIED_EXACT_RANK_LIMIT) {
          excludedBeyondVerifiedCount += 1;
          continue;
        }
        const item = parseSasItem(data);
        if (item.organicRank <= previousSasRank) failSchema(`sas.rank_order.${item.organicRank}`);
        previousSasRank = item.organicRank;
        const identityKey = item.sellerProductId
          ? `seller:${item.sellerProductId}`
          : (item.catalogId ? `catalog:${item.catalogId}` : `product:${item.productId}`);
        if (!identityKey || identityKeys.has(identityKey)) failSchema(`sas.duplicate.${item.organicRank}`);
        identityKeys.add(identityKey);
        items.push(item);
      }
    }
  }

  if (!items.length || items.length > VERIFIED_SLOT_LIMIT) failSchema("sas.coverage");
  // `rank` is the position Naver assigned across every slot inventory.  A high
  // rank by itself does not prove the positions below it were all returned.
  // Only the contiguous prefix can safely support a "not found in this range"
  // decision; exact SAS hits continue to keep their individual official rank.
  let contiguousObservedThroughRank = 0;
  while (
    contiguousObservedThroughRank < VERIFIED_EXACT_RANK_LIMIT
    && observedRanks.has(contiguousObservedThroughRank + 1)
  ) {
    contiguousObservedThroughRank += 1;
  }
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword || Number.isNaN(Date.parse(collectedAt))) failSchema("window.metadata");
  const collectionId = `mobile-top-${sha256(`${normalizedKeyword}\n${collectionSeed}\n${items.map((item) => `${item.organicRank}:${item.sellerProductId || item.catalogId || item.productId}`).join("|")}`).slice(0, 48)}`;
  return {
    ok: true,
    schemaVersion: "mi.naver-shopping-organic-window.v1",
    source: MOBILE_TOP_FALLBACK_SOURCE,
    rankEvidence: MOBILE_TOP_FALLBACK_EVIDENCE,
    keyword: normalizedKeyword,
    collectionId,
    collectedAt: new Date(collectedAt).toISOString(),
    complete: false,
    partial: true,
    sourceExhausted: false,
    marketTotal: null,
    marketTotalStatus: "unavailable",
    checkedCount: items.length,
    verifiedThroughRank: contiguousObservedThroughRank,
    rawCount,
    excludedAdCount,
    excludedOtherCount,
    excludedBeyondVerifiedCount,
    items,
  };
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new MobileTopFallbackError("shopping_mobile_top_response_too_large", { retryable: false });
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new MobileTopFallbackError("shopping_mobile_top_response_too_large", { retryable: false });
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new MobileTopFallbackError("shopping_mobile_top_response_too_large", { retryable: false });
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchBoundedText(fetchImpl, url, init, { timeoutMs, maxBytes, contentType }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" });
    if (!response?.ok) {
      const status = Number(response?.status || 0);
      const blocked = [403, 418, 429].includes(status);
      throw new MobileTopFallbackError(`shopping_mobile_top_http_${status || "error"}`, {
        status: status || 502,
        retryable: !blocked,
      });
    }
    const receivedType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!receivedType.includes(contentType)) {
      throw new MobileTopFallbackError("shopping_mobile_top_content_type", { retryable: false });
    }
    return await readBoundedText(response, maxBytes);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new MobileTopFallbackError("shopping_mobile_top_timeout", { status: 504, retryable: true });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cooldownForError(error) {
  const code = String(error?.code || error?.message || "");
  if (/http_(?:403|418|429)$/u.test(code)) return { durationMs: BLOCK_COOLDOWN_MS, global: true };
  if (/schema_drift|content_type|response_too_large/u.test(code)) return { durationMs: SCHEMA_COOLDOWN_MS, global: false };
  return { durationMs: TRANSIENT_COOLDOWN_MS, global: false };
}

async function collectUncached(keyword, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new MobileTopFallbackError("shopping_mobile_top_fetch_unavailable", { retryable: false });
  }
  const timeoutMs = Math.max(1_000, Math.min(8_000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const bootstrapHtml = await fetchBoundedText(fetchImpl, buildMobileSearchBootstrapUrl(keyword), {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ko-KR,ko;q=0.9",
      "user-agent": MOBILE_USER_AGENT,
    },
  }, { timeoutMs, maxBytes: BOOTSTRAP_MAX_BYTES, contentType: "text/html" });
  const context = parseMobileSearchBootstrap(bootstrapHtml, keyword);
  const bffRequest = buildMobilePagedSlotRequest(context);
  const bffText = await fetchBoundedText(fetchImpl, bffRequest.url, {
    method: "GET",
    headers: bffRequest.headers,
  }, { timeoutMs, maxBytes: BFF_MAX_BYTES, contentType: "application/json" });
  let payload;
  try {
    payload = JSON.parse(bffText);
  } catch {
    failSchema("bff.json");
  }
  const collectedAt = new Date(nowMs(options.now)).toISOString();
  return parseMobilePagedSlotPayload(payload, {
    keyword,
    collectedAt,
    collectionSeed: `${context.pageId}\n${context.sessionId}`,
  });
}

export async function collectMobileTopFallbackWindow(keyword, options = {}) {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    throw new MobileTopFallbackError("shopping_mobile_top_invalid_keyword", { status: 400, retryable: false });
  }
  const currentTime = nowMs(options.now);
  const cacheKey = normalizedKeyword.toLowerCase();
  const cached = fallbackCache.get(cacheKey);
  if (cached?.expiresAt > currentTime) return cached.promise;
  if (cached) fallbackCache.delete(cacheKey);
  if (currentTime < globalBlockCooldownUntil || currentTime < Number(keywordCooldownUntil.get(cacheKey) || 0)) {
    throw new MobileTopFallbackError("shopping_mobile_top_cooldown", { status: 503, retryable: true });
  }
  while (networkAttempts.length && currentTime - networkAttempts[0] >= RATE_WINDOW_MS) networkAttempts.shift();
  if (networkAttempts.length >= RATE_LIMIT) {
    throw new MobileTopFallbackError("shopping_mobile_top_rate_limited", { status: 429, retryable: true });
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    throw new MobileTopFallbackError("shopping_mobile_top_busy", { status: 429, retryable: true });
  }

  networkAttempts.push(currentTime);
  inFlight += 1;
  const promise = collectUncached(normalizedKeyword, options)
    .catch((error) => {
      const current = fallbackCache.get(cacheKey);
      if (current?.promise === promise) fallbackCache.delete(cacheKey);
      const cooldown = cooldownForError(error);
      const nextCooldown = nowMs(options.now) + cooldown.durationMs;
      if (cooldown.global) globalBlockCooldownUntil = Math.max(globalBlockCooldownUntil, nextCooldown);
      else keywordCooldownUntil.set(cacheKey, Math.max(Number(keywordCooldownUntil.get(cacheKey) || 0), nextCooldown));
      throw error;
    })
    .finally(() => {
      inFlight = Math.max(0, inFlight - 1);
    });
  fallbackCache.set(cacheKey, {
    expiresAt: currentTime + Math.max(30_000, Math.min(15 * 60_000, Number(options.cacheTtlMs || DEFAULT_CACHE_TTL_MS))),
    promise,
  });
  return promise;
}

export function resetMobileTopFallbackStateForTests() {
  fallbackCache.clear();
  networkAttempts.splice(0, networkAttempts.length);
  keywordCooldownUntil.clear();
  globalBlockCooldownUntil = 0;
  inFlight = 0;
}

export const SCHEMA_VERSION = "mi.naver-shopping-organic-window.v1";
export const SOURCE = "naver_shopping_results_collector";
export const RANK_EVIDENCE = "naver_shopping_organic_list";
const MAX_RANK_LIMIT = 300;
const MAX_KEYWORD_LENGTH = 100;
const DEADLINE_GRACE_MS = 5_000;
const MAX_DEADLINE_AHEAD_MS = 15 * 60_000;

const REQUEST_KEYS = new Set([
  "schemaVersion",
  "keyword",
  "limit",
  "sort",
  "rankPolicy",
  "deadlineAt",
  "requestId",
]);

const ITEM_STRING_LIMITS = Object.freeze({
  productId: 80,
  sellerProductId: 80,
  catalogId: 80,
  linkedCatalogId: 80,
  title: 500,
  link: 2048,
  image: 2048,
  mallName: 200,
  brand: 200,
  maker: 200,
  category1: 200,
  category2: 200,
  category3: 200,
  category4: 200,
});

export class ContractError extends Error {
  constructor(code, detail = "") {
    super(code);
    this.name = "ContractError";
    this.code = code;
    this.detail = detail;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value, field, { required = false, max = 200 } = {}) {
  if (value == null && !required) return undefined;
  if (typeof value !== "string") throw new ContractError("invalid_provider_response", field);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ContractError("invalid_provider_response", field);
  }
  return normalized;
}

function validateDeadline(value, nowMs) {
  if (typeof value !== "string" || value.length > 40) {
    throw new ContractError("invalid_request", "deadlineAt");
  }
  const deadlineMs = Date.parse(value);
  if (
    !Number.isFinite(deadlineMs)
    || deadlineMs < nowMs - DEADLINE_GRACE_MS
    || deadlineMs > nowMs + MAX_DEADLINE_AHEAD_MS
  ) {
    throw new ContractError("invalid_request", "deadlineAt");
  }
  return new Date(deadlineMs).toISOString();
}

export function validateRankRequest(value, { nowMs = Date.now() } = {}) {
  if (!isRecord(value)) throw new ContractError("invalid_request", "body");

  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) throw new ContractError("invalid_request", `unexpected:${key}`);
  }

  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new ContractError("invalid_request", "schemaVersion");
  }
  if (value.sort !== "relevance") throw new ContractError("invalid_request", "sort");
  if (value.rankPolicy !== "organic_only") throw new ContractError("invalid_request", "rankPolicy");

  if (typeof value.keyword !== "string") throw new ContractError("invalid_request", "keyword");
  const keyword = value.keyword.trim().normalize("NFC");
  const keywordLength = Array.from(keyword).length;
  if (
    keywordLength < 1
    || keywordLength > MAX_KEYWORD_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(keyword)
  ) {
    throw new ContractError("invalid_request", "keyword");
  }

  if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_RANK_LIMIT) {
    throw new ContractError("invalid_request", "limit");
  }
  const deadlineAt = validateDeadline(value.deadlineAt, nowMs);

  let requestId;
  if (value.requestId != null) {
    if (
      typeof value.requestId !== "string"
      || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.requestId)
    ) {
      throw new ContractError("invalid_request", "requestId");
    }
    requestId = value.requestId;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    keyword,
    limit: value.limit,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt,
    ...(requestId ? { requestId } : {}),
  };
}

function validateCollectedAt(value) {
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) {
    throw new ContractError("invalid_provider_response", "collectedAt");
  }
  return new Date(Date.parse(value)).toISOString();
}

function validateUrl(value, field) {
  if (!value) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ContractError("invalid_provider_response", field);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ContractError("invalid_provider_response", field);
  }
}

function numericValue(value, field) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ContractError("invalid_provider_response", field);
  }
  return parsed;
}

function validateItem(value, expectedRank, limit) {
  if (!isRecord(value)) throw new ContractError("invalid_provider_response", `items.${expectedRank}`);
  if (value.organicRank !== expectedRank || value.organicRank > limit) {
    throw new ContractError("invalid_provider_response", `items.${expectedRank}.organicRank`);
  }

  const adSignals = [
    value.isAd !== false,
    value.isOrganic !== true,
    value.ad === true,
    value.isAdvertisement === true,
    value.sponsored === true,
    value.adProduct === true,
    Boolean(value.adId),
  ];
  if (adSignals.some(Boolean)) {
    throw new ContractError("provider_ad_item_rejected", `items.${expectedRank}`);
  }

  const item = {
    organicRank: expectedRank,
    isAd: false,
    isOrganic: true,
  };
  for (const [field, max] of Object.entries(ITEM_STRING_LIMITS)) {
    const normalized = stringValue(value[field], field, {
      required: field === "title",
      max,
    });
    if (normalized !== undefined) item[field] = normalized;
  }

  for (const field of ["productId", "sellerProductId", "catalogId", "linkedCatalogId"]) {
    if (item[field] && !/^[0-9]{5,}$/u.test(item[field])) {
      throw new ContractError("invalid_provider_response", `items.${expectedRank}.${field}`);
    }
  }

  if (!item.productId && !item.sellerProductId && !item.catalogId && !item.link) {
    throw new ContractError("invalid_provider_response", `items.${expectedRank}.identity`);
  }
  validateUrl(item.link, `items.${expectedRank}.link`);
  validateUrl(item.image, `items.${expectedRank}.image`);

  if (value.productType != null) {
    if (!Number.isInteger(value.productType) || value.productType < 0 || value.productType > 100) {
      throw new ContractError("invalid_provider_response", `items.${expectedRank}.productType`);
    }
    item.productType = value.productType;
  }
  for (const field of ["lprice", "hprice"]) {
    const normalized = numericValue(value[field], `items.${expectedRank}.${field}`);
    if (normalized !== undefined) item[field] = normalized;
  }
  return item;
}

function identitySignals(item) {
  const isCatalogResult = [1, 4, 7, 10].includes(Number(item.productType));
  if (!isCatalogResult && item.sellerProductId) return [`seller:${item.sellerProductId}`];
  if (isCatalogResult) {
    if (item.catalogId) return [`catalog:${item.catalogId}`];
    return item.productId ? [`product:${item.productId}`] : [];
  }
  if (item.link) {
    const parsed = new URL(item.link);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^m\./u, "").replace(/^www\./u, "");
    parsed.pathname = decodeURIComponent(parsed.pathname).replace(/\/+$/u, "").toLowerCase() || "/";
    parsed.searchParams.sort();
    return [`url:${parsed.hostname}${parsed.pathname}${parsed.search}`];
  }
  if (item.productId) return [`product:${item.productId}`];
  if (item.catalogId) return [`catalog:${item.catalogId}`];
  return [];
}

export function validateProviderWindow(value, request) {
  if (!isRecord(value)) throw new ContractError("invalid_provider_response", "body");
  if (value.ok !== true) throw new ContractError("invalid_provider_response", "ok");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new ContractError("invalid_provider_response", "schemaVersion");
  }
  if (value.keyword !== request.keyword) throw new ContractError("invalid_provider_response", "keyword");
  if (value.source !== SOURCE) throw new ContractError("untrusted_provider_source", "source");
  if (value.rankEvidence !== RANK_EVIDENCE) {
    throw new ContractError("untrusted_provider_source", "rankEvidence");
  }

  const collectionId = stringValue(value.collectionId, "collectionId", {
    required: true,
    max: 128,
  });
  if (!/^[A-Za-z0-9._:-]+$/u.test(collectionId)) {
    throw new ContractError("invalid_provider_response", "collectionId");
  }
  const collectedAt = validateCollectedAt(value.collectedAt);

  const complete = value.complete === true;
  if (typeof value.complete !== "boolean") {
    throw new ContractError("invalid_provider_response", "complete");
  }
  if (typeof value.partial !== "boolean" || value.partial !== !complete) {
    throw new ContractError("invalid_provider_response", "partial");
  }
  if (typeof value.sourceExhausted !== "boolean") {
    throw new ContractError("invalid_provider_response", "sourceExhausted");
  }

  const marketTotalStatus = value.marketTotalStatus;
  if (marketTotalStatus !== "verified" && marketTotalStatus !== "unavailable") {
    throw new ContractError("invalid_provider_response", "marketTotalStatus");
  }
  const marketTotal = marketTotalStatus === "verified" ? value.marketTotal : null;
  if (
    (marketTotalStatus === "verified" && (!Number.isInteger(marketTotal) || marketTotal < 0))
    || (marketTotalStatus === "unavailable" && value.marketTotal !== null)
  ) {
    throw new ContractError("invalid_provider_response", "marketTotal");
  }

  for (const field of ["checkedCount", "rawCount", "excludedAdCount"]) {
    if (!Number.isInteger(value[field]) || value[field] < 0) {
      throw new ContractError("invalid_provider_response", field);
    }
  }
  if (
    value.checkedCount > request.limit
    || (marketTotalStatus === "verified" && marketTotal < value.checkedCount)
    || value.rawCount < value.checkedCount + value.excludedAdCount
  ) {
    throw new ContractError("invalid_provider_response", "counts");
  }
  if (!Array.isArray(value.items) || value.items.length !== value.checkedCount) {
    throw new ContractError("invalid_provider_response", "items");
  }

  const coverageComplete = value.checkedCount >= request.limit || value.sourceExhausted;
  if (!complete || complete !== coverageComplete || value.partial !== false) {
    throw new ContractError("invalid_provider_response", "completion");
  }

  const items = value.items.map((item, index) => validateItem(item, index + 1, request.limit));
  const seenIdentities = new Set();
  for (const item of items) {
    const signals = identitySignals(item);
    if (signals.some((signal) => seenIdentities.has(signal))) {
      throw new ContractError("invalid_provider_response", "duplicate_identity");
    }
    signals.forEach((signal) => seenIdentities.add(signal));
  }

  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    keyword: request.keyword,
    source: SOURCE,
    rankEvidence: RANK_EVIDENCE,
    collectionId,
    collectedAt,
    complete,
    partial: false,
    sourceExhausted: value.sourceExhausted,
    marketTotal,
    marketTotalStatus,
    checkedCount: value.checkedCount,
    rawCount: value.rawCount,
    excludedAdCount: value.excludedAdCount,
    items,
  };
}

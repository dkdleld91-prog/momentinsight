import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RANK_EVIDENCE,
  SCHEMA_VERSION,
  SOURCE,
  validateProviderWindow,
} from "./contract.mjs";

const PROVIDER_NOT_READY = "provider_not_ready";
export const NAVER_SHOPPING_PROFILE_OWNER_MARKER = ".moment-insight-profile-v1";
export const NAVER_SHOPPING_PROFILE_OWNER_MARKER_VALUE = "moment-insight-profile-v1";
export const NAVER_SHOPPING_PROFILE_AUTH_MARKER = ".moment-insight-authenticated-v1";
export const NAVER_SHOPPING_PROFILE_AUTH_MARKER_SCHEMA = "moment-insight-authenticated-v1";
const LEGACY_NAVER_SHOPPING_HOST = "search.shopping.naver.com";
const LOCAL_WORKER_NAVER_SHOPPING_HOST = "msearch.shopping.naver.com";
const ALLOWED_NAVER_SHOPPING_HOSTS = new Set([
  LEGACY_NAVER_SHOPPING_HOST,
  LOCAL_WORKER_NAVER_SHOPPING_HOST,
]);
const NAVER_SHOPPING_PAGE_SIZE = 40;
const NAVER_SHOPPING_MAX_PAGES = 8;
const NAVER_SHOPPING_FRONTEND_PATH = "/api/search/all";
const NEXT_DATA_ROW_SOURCE = "next_data_composite_v1";

const DEADLINE_GUARD_MS = 3_000;
const READINESS_RETRY_MS = 60_000;
const PROVIDER_BLOCK_COOLDOWN_MS = 15 * 60_000;
const PROVIDER_SCHEMA_COOLDOWN_MS = 30 * 60_000;
const BLOCK_TEXT_PATTERNS = [
  ["naver_captcha_detected", /캡챠|captcha|자동입력\s*방지|로봇이\s*아닙니다/i],
  ["naver_access_blocked", /비정상적인\s*접근|이용이\s*제한|access\s*denied|temporarily\s*blocked/i],
];
const EMPTY_TEXT_PATTERN = /검색\s*결과가\s*없|조건에\s*맞는\s*상품이\s*없|상품을\s*찾을\s*수\s*없/i;
const EXPLICIT_AD_TEXT_PATTERN = /^(?:광고|ad|sponsored|스폰서)$/i;
const NON_ORGANIC_TYPE_PATTERN = /(?:^|[_-])(?:supersaving|brand[_-]?ad|powerlink|sponsored|paid)(?:$|[_-])/i;

export class ProviderError extends Error {
  constructor(code, detail = "") {
    super(code);
    this.name = "ProviderError";
    this.code = code;
    this.detail = detail;
  }
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeKeyword(value) {
  return String(value || "").trim().normalize("NFC").replace(/\s+/g, " ");
}

function normalizeNaverQueryKeyword(value) {
  return normalizeKeyword(value).replace(/\s+/g, "");
}

function normalizeString(value, max = 2_048) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numericId(value) {
  const text = normalizeString(value, 100);
  return /^[0-9]{5,}$/.test(text) ? text : "";
}

function parsePositiveNumber(value) {
  const text = String(value ?? "").replace(/[^0-9.]/g, "");
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function truthyFlag(value) {
  if (value === true || value === 1) return true;
  return /^(?:true|1|yes|y|ad|sponsored|paid)$/i.test(normalizeString(value, 30));
}

function deepClone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function allowedShoppingHost(value, fallback = LEGACY_NAVER_SHOPPING_HOST) {
  const host = normalizeString(value || fallback, 253).toLowerCase();
  if (!ALLOWED_NAVER_SHOPPING_HOSTS.has(host)) {
    throw new ProviderError("provider_url_not_allowed");
  }
  return host;
}

export function defaultNaverShoppingProfileDir(homeDirectory = os.homedir()) {
  const home = path.resolve(String(homeDirectory || ""));
  return path.join(
    home,
    "Library",
    "Application Support",
    "MomentInsight",
    "NaverShoppingProfile",
  );
}

function profileStat(filePath, missingCode) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new ProviderError(missingCode);
    throw new ProviderError("provider_profile_unreadable");
  }
}

function privateOwner(stat) {
  if (typeof process.getuid !== "function") return true;
  return Number(stat?.uid) === process.getuid();
}

function readPrivateProfileMarker(profileDir, markerName, missingCode) {
  const markerPath = path.join(profileDir, markerName);
  const markerStat = profileStat(markerPath, missingCode);
  if (markerStat.isSymbolicLink()) {
    throw new ProviderError("provider_profile_symlink_not_allowed");
  }
  if (
    !markerStat.isFile()
    || !privateOwner(markerStat)
    || markerStat.size < 1
    || markerStat.size > 1_024
    || (process.platform !== "win32" && (markerStat.mode & 0o077) !== 0)
  ) {
    throw new ProviderError("provider_profile_marker_invalid");
  }
  try {
    return fs.readFileSync(markerPath, "utf8").trim();
  } catch {
    throw new ProviderError("provider_profile_marker_invalid");
  }
}

export function validateNaverShoppingProfileDir(value, options = {}) {
  const requested = String(value || "").trim();
  if (!requested || !path.isAbsolute(requested)) {
    throw new ProviderError("provider_profile_path_not_allowed");
  }
  const expected = path.resolve(String(
    options.expectedDir || defaultNaverShoppingProfileDir(options.homeDirectory),
  ));
  const resolved = path.resolve(requested);
  if (resolved !== expected) throw new ProviderError("provider_profile_path_not_allowed");

  const parent = path.dirname(resolved);
  const parentStat = profileStat(parent, "provider_profile_missing");
  const profileStatValue = profileStat(resolved, "provider_profile_missing");
  if (parentStat.isSymbolicLink() || profileStatValue.isSymbolicLink()) {
    throw new ProviderError("provider_profile_symlink_not_allowed");
  }
  if (!parentStat.isDirectory() || !profileStatValue.isDirectory()) {
    throw new ProviderError("provider_profile_invalid");
  }
  if (process.platform !== "win32") {
    let canonicalProfile = "";
    try {
      canonicalProfile = fs.realpathSync(resolved);
    } catch {
      throw new ProviderError("provider_profile_unreadable");
    }
    if (canonicalProfile !== resolved) {
      throw new ProviderError("provider_profile_symlink_not_allowed");
    }
  }
  if (!privateOwner(parentStat) || !privateOwner(profileStatValue)) {
    throw new ProviderError("provider_profile_owner_invalid");
  }
  if (process.platform !== "win32" && (profileStatValue.mode & 0o077) !== 0) {
    throw new ProviderError("provider_profile_permissions_invalid");
  }

  const ownerMarkerValue = readPrivateProfileMarker(
    resolved,
    NAVER_SHOPPING_PROFILE_OWNER_MARKER,
    "provider_profile_marker_missing",
  );
  if (ownerMarkerValue !== NAVER_SHOPPING_PROFILE_OWNER_MARKER_VALUE) {
    throw new ProviderError("provider_profile_marker_invalid");
  }
  const authMarkerValue = readPrivateProfileMarker(
    resolved,
    NAVER_SHOPPING_PROFILE_AUTH_MARKER,
    "provider_profile_auth_missing",
  );
  let authMarker = null;
  try {
    authMarker = JSON.parse(authMarkerValue);
  } catch {
    throw new ProviderError("provider_profile_auth_invalid");
  }
  if (
    !isRecord(authMarker)
    || Object.keys(authMarker).sort().join(",") !== "authenticatedAt,schema"
    || authMarker?.schema !== NAVER_SHOPPING_PROFILE_AUTH_MARKER_SCHEMA
    || typeof authMarker?.authenticatedAt !== "string"
    || !Number.isFinite(Date.parse(authMarker.authenticatedAt))
    || new Date(authMarker.authenticatedAt).toISOString() !== authMarker.authenticatedAt
  ) {
    throw new ProviderError("provider_profile_auth_invalid");
  }
  return resolved;
}

export function buildNaverShoppingSearchUrl(keyword, pageIndex = 1, options = {}) {
  const safeKeyword = normalizeKeyword(keyword);
  const safePage = boundedInteger(pageIndex, 1, 1, 100);
  const host = allowedShoppingHost(options?.host);
  if (!safeKeyword) throw new ProviderError("invalid_keyword");
  const url = new URL(`https://${host}/search/all`);
  url.searchParams.set("query", safeKeyword);
  url.searchParams.set("origQuery", safeKeyword);
  url.searchParams.set("productSet", "total");
  url.searchParams.set("sort", "rel");
  url.searchParams.set("viewType", "list");
  url.searchParams.set("pagingIndex", String(safePage));
  url.searchParams.set("pagingSize", String(NAVER_SHOPPING_PAGE_SIZE));
  if (url.protocol !== "https:" || url.hostname !== host || url.pathname !== "/search/all") {
    throw new ProviderError("provider_url_not_allowed");
  }
  return url.toString();
}

export function buildNaverShoppingFrontendUrl(keyword, pageIndex = 1, options = {}) {
  const pageUrl = new URL(buildNaverShoppingSearchUrl(keyword, pageIndex, options));
  const safePage = boundedInteger(pageIndex, 0, 1, NAVER_SHOPPING_MAX_PAGES);
  if (safePage !== Number(pageIndex)) throw new ProviderError("provider_page_out_of_range");
  pageUrl.pathname = NAVER_SHOPPING_FRONTEND_PATH;
  return pageUrl.toString();
}

function parseLoosePayload(raw) {
  if (isRecord(raw) || Array.isArray(raw)) return raw;
  const text = String(raw || "").trim().slice(0, 32_768);
  if (!text) return {};
  const decoded = text
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");
  try {
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    const values = {};
    for (const match of decoded.matchAll(/["']?([A-Za-z][A-Za-z0-9_-]{1,80})["']?\s*(?::|=)\s*["']?([^"'&,}\s]{1,2048})/g)) {
      values[match[1]] ??= match[2];
    }
    return values;
  }
}

function flattenPayload(value, result = new Map(), prefix = "", depth = 0) {
  if (depth > 5 || value == null) return result;
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item, index) => flattenPayload(item, result, `${prefix}.${index}`, depth + 1));
    return result;
  }
  if (typeof value !== "object") {
    const key = prefix.split(".").pop().replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (key && !result.has(key)) result.set(key, value);
    return result;
  }
  for (const [key, item] of Object.entries(value).slice(0, 300)) {
    const normalized = String(key).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (normalized && item != null && typeof item !== "object" && !result.has(normalized)) {
      result.set(normalized, item);
    }
    flattenPayload(item, result, prefix ? `${prefix}.${key}` : key, depth + 1);
  }
  return result;
}

function firstPayloadValue(values, names) {
  for (const name of names) {
    const value = values.get(String(name).replace(/[^A-Za-z0-9]/g, "").toLowerCase());
    if (value != null && String(value).trim()) return value;
  }
  return "";
}

function safeHttpUrl(value) {
  const text = normalizeString(value);
  if (!text) return "";
  try {
    const parsed = new URL(text, `https://${LEGACY_NAVER_SHOPPING_HOST}`);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function idsFromUrl(value) {
  const url = safeHttpUrl(value);
  if (!url) return {};
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname || "");
  const sellerProductId = numericId(path.match(/\/products\/([0-9]{5,})(?:[/?#]|$)/i)?.[1])
    || numericId(parsed.searchParams.get("chnl_prod_no"))
    || numericId(parsed.searchParams.get("channelProductNo"));
  const catalogId = numericId(path.match(/\/catalog\/([0-9]{5,})(?:[/?#]|$)/i)?.[1])
    || numericId(parsed.searchParams.get("catalogId"))
    || numericId(parsed.searchParams.get("catalogNo"));
  const productId = numericId(parsed.searchParams.get("nvMid"))
    || numericId(parsed.searchParams.get("productId"))
    || catalogId;
  return { sellerProductId, catalogId, productId };
}

function nextDataSchemaError(detail) {
  return new ProviderError("naver_next_data_schema_drift", detail);
}

function nextDataRecord(value, detail) {
  if (!isRecord(value)) throw nextDataSchemaError(detail);
  return value;
}

function nextDataNumericId(value, detail, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw nextDataSchemaError(detail);
    return "";
  }
  const result = numericId(value);
  if (!result) throw nextDataSchemaError(detail);
  return result;
}

function nextDataUrl(value, detail) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw nextDataSchemaError(detail);
  const result = safeHttpUrl(value);
  if (!result) throw nextDataSchemaError(detail);
  return result;
}

function nextDataNumber(value, detail) {
  if (value == null || value === "") return undefined;
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+(?:\.\d+)?$/u.test(String(value))) {
    throw nextDataSchemaError(detail);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw nextDataSchemaError(detail);
  return result;
}

function directProductLink(item, detail) {
  const candidateFields = ["mallProductUrl", "mallProdMblUrl", "mblProdUrl", "mallPcUrl"];
  for (const field of candidateFields) {
    const link = nextDataUrl(item[field], `${detail}.${field}`);
    if (!link) continue;
    const ids = idsFromUrl(link);
    if (ids.sellerProductId || ids.catalogId || ids.productId) return link;
  }
  return "";
}

function nextDataOptionalString(value, detail, max = 500) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw nextDataSchemaError(detail);
  }
  const result = normalizeString(value, max);
  if (!result) throw nextDataSchemaError(detail);
  return result;
}

/**
 * Parse the current Naver Shopping SSR contract without guessing through the DOM.
 * `compositeList.list` is already in rendered document order. Ads carry `adId`,
 * while organic products carry an absolute `rank` that must remain contiguous
 * across pagingIndex values (1..300 for the collector contract).
 */
export function parseNaverNextDataPage(payload, {
  pageIndex = 1,
  pageSize = NAVER_SHOPPING_PAGE_SIZE,
  keyword = "",
} = {}) {
  let data = payload;
  if (typeof payload === "string") {
    try {
      data = JSON.parse(payload);
    } catch {
      throw new ProviderError("naver_next_data_invalid_json");
    }
  }
  const root = nextDataRecord(data, "root");
  const props = nextDataRecord(root.props, "props");
  const pageProps = nextDataRecord(props.pageProps, "props.pageProps");
  const searchParam = nextDataRecord(pageProps.searchParam, "props.pageProps.searchParam");
  const compositeList = nextDataRecord(pageProps.compositeList, "props.pageProps.compositeList");
  if (!Array.isArray(compositeList.list)) {
    throw nextDataSchemaError("props.pageProps.compositeList.list");
  }

  const expectedPage = boundedInteger(pageIndex, 0, 1, 100);
  const expectedPageSize = boundedInteger(pageSize, 0, 1, NAVER_SHOPPING_PAGE_SIZE);
  if (expectedPage !== Number(pageIndex) || expectedPageSize !== Number(pageSize)) {
    throw nextDataSchemaError("request.page");
  }
  if (searchParam.pagingIndex !== expectedPage) throw nextDataSchemaError("searchParam.pagingIndex");
  if (searchParam.pagingSize !== expectedPageSize) throw nextDataSchemaError("searchParam.pagingSize");
  if (searchParam.sort !== "rel") throw nextDataSchemaError("searchParam.sort");
  if (searchParam.viewType !== "list") throw nextDataSchemaError("searchParam.viewType");
  if (searchParam.productSet !== "total") throw nextDataSchemaError("searchParam.productSet");
  const expectedKeyword = normalizeKeyword(keyword);
  if (expectedKeyword
    && normalizeNaverQueryKeyword(searchParam.query) !== normalizeNaverQueryKeyword(expectedKeyword)) {
    throw nextDataSchemaError("searchParam.query");
  }

  if (!Number.isSafeInteger(compositeList.total) || compositeList.total < 0) {
    throw nextDataSchemaError("compositeList.total");
  }
  const marketTotal = compositeList.total;
  const expectedStartRank = ((expectedPage - 1) * expectedPageSize) + 1;
  const rows = [];
  let organicCount = 0;

  for (let index = 0; index < compositeList.list.length; index += 1) {
    const entryDetail = `compositeList.list.${index}`;
    const entry = nextDataRecord(compositeList.list[index], entryDetail);
    if (entry.type !== "product") throw nextDataSchemaError(`${entryDetail}.type`);
    const item = nextDataRecord(entry.item, `${entryDetail}.item`);
    if (item.collection !== "product") throw nextDataSchemaError(`${entryDetail}.item.collection`);

    const adId = nextDataOptionalString(item.adId, `${entryDetail}.item.adId`, 200);
    if (adId) {
      rows.push({
        rowSource: NEXT_DATA_ROW_SOURCE,
        extractionKey: `next:${expectedPage}:ad:${index}:${adId}`,
        isAd: true,
        isOrganic: false,
      });
      continue;
    }

    const expectedRank = expectedStartRank + organicCount;
    if (!Number.isInteger(item.rank) || item.rank !== expectedRank) {
      throw new ProviderError(
        "naver_next_data_rank_drift",
        `${entryDetail}.item.rank:${String(item.rank)}!=${expectedRank}`,
      );
    }
    const productId = nextDataNumericId(item.id, `${entryDetail}.item.id`, { required: true });
    const parentCatalogId = nextDataNumericId(
      item.parentCatalogId,
      `${entryDetail}.item.parentCatalogId`,
    );
    const mallId = nextDataOptionalString(item.mallId, `${entryDetail}.item.mallId`, 200);
    if (!mallId) throw nextDataSchemaError(`${entryDetail}.item.mallId`);
    const mallProductId = nextDataOptionalString(
      item.mallProductId,
      `${entryDetail}.item.mallProductId`,
      200,
    );
    const catalogResult = mallId === "naver_model";
    if (catalogResult && mallProductId) {
      throw nextDataSchemaError(`${entryDetail}.item.mallProductId`);
    }
    if (!catalogResult && !mallProductId) {
      throw nextDataSchemaError(`${entryDetail}.item.mallProductId`);
    }
    const matchType = nextDataOptionalString(
      item.stdCatalogMatchType,
      `${entryDetail}.item.stdCatalogMatchType`,
      20,
    );
    if (!/^(?:0|1|2|4)$/u.test(matchType)) {
      throw nextDataSchemaError(`${entryDetail}.item.stdCatalogMatchType`);
    }
    if (catalogResult ? matchType === "0" : matchType !== "0" && !parentCatalogId) {
      throw nextDataSchemaError(`${entryDetail}.item.stdCatalogMatchType`);
    }
    const title = typeof item.productTitle === "string"
      ? normalizeString(item.productTitle, 500)
      : "";
    if (!title) throw nextDataSchemaError(`${entryDetail}.item.productTitle`);
    const link = directProductLink(item, `${entryDetail}.item`);
    const linkIds = idsFromUrl(link);
    const numericMallProductId = numericId(mallProductId);
    if (numericMallProductId && linkIds.sellerProductId && numericMallProductId !== linkIds.sellerProductId) {
      throw nextDataSchemaError(`${entryDetail}.item.mallProductId`);
    }
    const sellerProductId = numericMallProductId || linkIds.sellerProductId || "";
    const catalogId = catalogResult ? (parentCatalogId || productId) : parentCatalogId;
    const linkedCatalogId = parentCatalogId && parentCatalogId !== productId
      ? parentCatalogId
      : "";
    // The public handler already understands Naver Search API product types:
    // 1 = price-comparison catalog, 2 = unmatched seller item,
    // 3 = seller item explicitly linked to a parent catalog.
    const productType = catalogResult ? 1 : parentCatalogId ? 3 : 2;
    const image = nextDataUrl(item.imageUrl, `${entryDetail}.item.imageUrl`);
    const row = {
      rowSource: NEXT_DATA_ROW_SOURCE,
      extractionKey: `next:${expectedPage}:organic:${item.rank}:${productId}`,
      sourceRank: item.rank,
      isAd: false,
      isOrganic: true,
      productId,
      sellerProductId,
      catalogId,
      linkedCatalogId,
      productType,
      title,
      link,
      image,
      mallName: normalizeString(item.mallName, 200),
      brand: normalizeString(item.brand, 200),
      maker: normalizeString(item.maker, 200),
      category1: normalizeString(item.category1Name, 200),
      category2: normalizeString(item.category2Name, 200),
      category3: normalizeString(item.category3Name, 200),
      category4: normalizeString(item.category4Name, 200),
    };
    const lprice = nextDataNumber(item.lowPrice, `${entryDetail}.item.lowPrice`);
    if (lprice !== undefined) row.lprice = lprice;
    rows.push(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== "" && value !== undefined)));
    organicCount += 1;
  }

  const remaining = Math.max(0, marketTotal - ((expectedPage - 1) * expectedPageSize));
  const expectedOrganicCount = Math.min(expectedPageSize, remaining);
  if (organicCount !== expectedOrganicCount) {
    throw new ProviderError(
      "naver_next_data_rank_drift",
      `page:${expectedPage}:count:${organicCount}!=${expectedOrganicCount}`,
    );
  }

  return {
    rows,
    marketTotal,
    sourceExhausted: organicCount < expectedPageSize,
  };
}

/**
 * Parse the first-party partial-search response used by the current Shopping
 * frontend. Paid and benefit inventories live in separate response fields;
 * only `shoppingResult.products` is accepted as organic rank evidence.
 */
export function parseNaverFrontendPage(payload, {
  pageIndex = 1,
  pageSize = NAVER_SHOPPING_PAGE_SIZE,
  keyword = "",
} = {}) {
  let data = payload;
  if (typeof payload === "string") {
    try {
      data = JSON.parse(payload);
    } catch {
      throw new ProviderError("naver_frontend_invalid_json");
    }
  }
  if (!isRecord(data)) throw new ProviderError("naver_frontend_schema_drift", "root");
  const root = data;
  if (!isRecord(root.shoppingResult)) {
    throw new ProviderError("naver_frontend_schema_drift", "shoppingResult");
  }
  const shoppingResult = root.shoppingResult;
  if (!Array.isArray(shoppingResult.products)) {
    throw new ProviderError("naver_frontend_schema_drift", "shoppingResult.products");
  }
  if (!Number.isSafeInteger(shoppingResult.total) || shoppingResult.total < 0) {
    throw new ProviderError("naver_frontend_schema_drift", "shoppingResult.total");
  }
  const expectedPage = boundedInteger(pageIndex, 0, 1, NAVER_SHOPPING_MAX_PAGES);
  if (expectedPage !== Number(pageIndex) || Number(pageSize) !== NAVER_SHOPPING_PAGE_SIZE) {
    throw new ProviderError("naver_frontend_schema_drift", "request.page");
  }

  try {
    return parseNaverNextDataPage({
      props: {
        pageProps: {
          searchParam: {
            sort: "rel",
            pagingIndex: expectedPage,
            pagingSize: NAVER_SHOPPING_PAGE_SIZE,
            viewType: "list",
            productSet: "total",
            query: normalizeKeyword(keyword),
          },
          compositeList: {
            total: shoppingResult.total,
            list: shoppingResult.products.map((item) => ({ type: "product", item })),
          },
        },
      },
    }, { pageIndex: expectedPage, pageSize: NAVER_SHOPPING_PAGE_SIZE, keyword });
  } catch (error) {
    if (error instanceof ProviderError && (
      error.code === "naver_next_data_schema_drift"
      || error.code === "naver_next_data_rank_drift"
    )) {
      throw new ProviderError("naver_frontend_schema_drift", error.detail || error.code);
    }
    throw error;
  }
}

function explicitAdRow(raw, values) {
  const adFields = [
    "isAdProduct",
    "isAdvertisement",
    "advertising",
    "sponsored",
    "paid",
    "adProduct",
  ];
  if (raw?.isAd === true || raw?.sponsored === true || raw?.adProduct === true) return true;
  if (adFields.some((field) => truthyFlag(firstPayloadValue(values, [field])))) return true;
  if (numericId(firstPayloadValue(values, ["adId", "advertisingId"])) || normalizeString(firstPayloadValue(values, ["adId", "advertisingId"]))) {
    return true;
  }
  const type = normalizeString(firstPayloadValue(values, ["contentType", "productContentType", "sourceType", "type"]), 100);
  if (NON_ORGANIC_TYPE_PATTERN.test(type)) return true;
  return (raw?.badgeTexts || []).some((text) => EXPLICIT_AD_TEXT_PATTERN.test(normalizeString(text, 50)));
}

function preferredProductLink(raw, sellerProductId, catalogId) {
  const links = (raw?.links || []).map(safeHttpUrl).filter(Boolean);
  const sellerLink = links.find((link) => sellerProductId && new RegExp(`/products/${sellerProductId}(?:[/?#]|$)`).test(link));
  if (sellerLink) return sellerLink;
  const catalogLink = links.find((link) => catalogId && new RegExp(`/catalog/${catalogId}(?:[/?#]|$)`).test(link));
  if (catalogLink) return catalogLink;
  return links[0] || "";
}

function normalizeBrowserRow(raw, { pageIndex = 1, rowIndex = 0 } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProviderError("provider_row_invalid", `${pageIndex}:${rowIndex}`);
  }
  if (raw.rowSource === NEXT_DATA_ROW_SOURCE) {
    if (raw.isAd === true) {
      return {
        isAd: true,
        isOrganic: false,
        extractionKey: normalizeString(raw.extractionKey || `${pageIndex}:${rowIndex}`),
      };
    }
    const item = {
      ...raw,
      extractionKey: normalizeString(raw.extractionKey || `${pageIndex}:${rowIndex}`),
    };
    delete item.rowSource;
    return item;
  }
  const payload = parseLoosePayload(raw.payload);
  const values = flattenPayload(payload);
  const links = Array.isArray(raw.links) ? raw.links : [];
  const urlIds = links.map(idsFromUrl);

  const sellerProductId = numericId(firstPayloadValue(values, [
    "chnlProdNo", "chnl_prod_no", "channelProductNo", "sellerProductId", "mallProductId", "productNo",
  ])) || urlIds.map((item) => item.sellerProductId).find(Boolean) || "";
  const catalogId = numericId(firstPayloadValue(values, [
    "catalogId", "catalogNo", "stdCatalogId", "parentCatalogId", "comparisonCatalogId", "priceCompareCatalogId",
  ])) || urlIds.map((item) => item.catalogId).find(Boolean) || "";
  const linkedCatalogId = numericId(firstPayloadValue(values, ["linkedCatalogId", "parentCatalogId"]));
  const productId = numericId(firstPayloadValue(values, [
    "nvMid", "nv_mid", "productId", "productNo", "itemId",
  ])) || urlIds.map((item) => item.productId).find(Boolean) || catalogId || sellerProductId;
  const link = preferredProductLink({ links }, sellerProductId, catalogId);
  const title = normalizeString(firstPayloadValue(values, ["productName", "productTitle", "title", "name"]) || raw.title, 500);
  const isAd = explicitAdRow(raw, values);

  if (isAd) {
    return {
      isAd: true,
      isOrganic: false,
      extractionKey: normalizeString(raw.extractionKey || `${pageIndex}:${rowIndex}`),
    };
  }
  if (!title) throw new ProviderError("provider_row_title_missing", `${pageIndex}:${rowIndex}`);
  if (!productId && !sellerProductId && !catalogId && !link) {
    throw new ProviderError("provider_row_identity_missing", `${pageIndex}:${rowIndex}`);
  }

  const result = {
    isAd: false,
    isOrganic: true,
    productId,
    sellerProductId,
    catalogId,
    linkedCatalogId,
    title,
    link,
    image: safeHttpUrl(firstPayloadValue(values, ["image", "imageUrl", "thumbnailUrl"]) || raw.image),
    mallName: normalizeString(firstPayloadValue(values, ["mallName", "mallNm", "storeName", "channelName"]) || raw.mallName, 200),
    brand: normalizeString(firstPayloadValue(values, ["brand", "brandName"]), 200),
    maker: normalizeString(firstPayloadValue(values, ["maker", "makerName", "manufacturer"]), 200),
    category1: normalizeString(firstPayloadValue(values, ["category1", "category1Name", "categoryName1"]), 200),
    category2: normalizeString(firstPayloadValue(values, ["category2", "category2Name", "categoryName2"]), 200),
    category3: normalizeString(firstPayloadValue(values, ["category3", "category3Name", "categoryName3"]), 200),
    category4: normalizeString(firstPayloadValue(values, ["category4", "category4Name", "categoryName4"]), 200),
    extractionKey: normalizeString(raw.extractionKey || `${pageIndex}:${rowIndex}`),
  };
  const productType = parsePositiveNumber(firstPayloadValue(values, ["productType", "product_type"]));
  if (Number.isInteger(productType) && productType <= 100) result.productType = productType;
  const lprice = parsePositiveNumber(firstPayloadValue(values, ["lprice", "lowPrice", "price", "salePrice"]));
  if (lprice !== undefined) result.lprice = lprice;
  const hprice = parsePositiveNumber(firstPayloadValue(values, ["hprice", "highPrice"]));
  if (hprice !== undefined) result.hprice = hprice;
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== "" && value !== undefined));
}

function identityKey(item) {
  return [item.sellerProductId || "", item.catalogId || "", item.productId || "", item.link || ""].join("|");
}

function identitySignals(item) {
  let canonicalUrl = "";
  if (item.link) {
    const parsed = new URL(item.link);
    canonicalUrl = `${parsed.hostname.toLowerCase().replace(/^m\./u, "").replace(/^www\./u, "")}${decodeURIComponent(parsed.pathname).replace(/\/+$/u, "").toLowerCase()}`;
  }
  const isCatalogResult = [1, 4, 7, 10].includes(Number(item.productType));
  return [
    item.sellerProductId ? `seller:${item.sellerProductId}` : "",
    isCatalogResult && item.catalogId ? `catalog:${item.catalogId}` : "",
    item.productId ? `product:${item.productId}` : "",
    canonicalUrl ? `url:${canonicalUrl}` : "",
  ].filter(Boolean);
}

export function appendNormalizedPage(state, pageResult, { pageIndex = 1, limit = 300 } = {}) {
  if (!pageResult || typeof pageResult !== "object" || !Array.isArray(pageResult.rows)) {
    throw new ProviderError("naver_selector_drift", `page:${pageIndex}`);
  }
  const localExtractionKeys = new Set();
  let added = 0;
  for (let index = 0; index < pageResult.rows.length && state.items.length < limit; index += 1) {
    const item = normalizeBrowserRow(pageResult.rows[index], { pageIndex, rowIndex: index });
    if (localExtractionKeys.has(item.extractionKey)) continue;
    localExtractionKeys.add(item.extractionKey);
    state.rawCount += 1;
    if (item.isAd) {
      state.excludedAdCount += 1;
      continue;
    }
    if (item.sourceRank != null && item.sourceRank !== state.items.length + 1) {
      throw new ProviderError(
        "naver_next_data_rank_drift",
        `${pageIndex}:${index}:${item.sourceRank}!=${state.items.length + 1}`,
      );
    }
    const signals = identitySignals(item);
    if (signals.some((signal) => state.identities.has(signal))) {
      throw new ProviderError("provider_duplicate_identity", `${pageIndex}:${index}`);
    }
    signals.forEach((signal) => state.identities.add(signal));
    const { extractionKey: _extractionKey, sourceRank: _sourceRank, ...publicItem } = item;
    state.items.push({
      ...publicItem,
      organicRank: state.items.length + 1,
      isAd: false,
      isOrganic: true,
    });
    added += 1;
  }
  return added;
}

export function classifyNaverPage({
  status = 200,
  url = "",
  title = "",
  bodyText = "",
  rowCount = 0,
  expectedHost = LEGACY_NAVER_SHOPPING_HOST,
} = {}) {
  if (Number(status) === 418) throw new ProviderError("naver_http_418");
  if (Number(status) === 429) throw new ProviderError("naver_http_429");
  if (Number(status) >= 400) throw new ProviderError("naver_http_error", String(status));
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError("provider_navigation_invalid");
  }
  if (parsed.hostname === "nid.naver.com" || /\/(?:login|nidlogin)/i.test(parsed.pathname)) {
    throw new ProviderError("naver_auth_required");
  }
  const allowedHost = allowedShoppingHost(expectedHost);
  if (parsed.protocol !== "https:" || parsed.hostname !== allowedHost) {
    throw new ProviderError("provider_navigation_not_allowed");
  }
  const text = `${title}\n${bodyText}`.slice(0, 120_000);
  for (const [code, pattern] of BLOCK_TEXT_PATTERNS) {
    if (pattern.test(text)) throw new ProviderError(code);
  }
  return { sourceExhausted: Number(rowCount) === 0 && EMPTY_TEXT_PATTERN.test(text) };
}

export function marketTotalFromTexts(texts = []) {
  const patterns = [
    /(?:전체\s*상품|검색\s*결과)\s*(?:수|count)?\s*[:：]?\s*([0-9][0-9,]*)\s*(?:개|건)?/i,
    /([0-9][0-9,]*)\s*(?:개|건)\s*(?:의\s*)?(?:전체\s*상품|검색\s*결과)/i,
  ];
  for (const raw of texts) {
    const text = normalizeString(raw, 5_000);
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const value = Number(String(match[1]).replace(/,/g, ""));
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
  }
  return null;
}

async function readNaverPageSnapshot(page, timeoutMs) {
  await page.waitForFunction(() => {
    const nextData = document.getElementById("__NEXT_DATA__");
    const text = String(document.body?.innerText || "");
    return Boolean(nextData?.textContent) || /검색\s*결과가\s*없|조건에\s*맞는\s*상품이\s*없/i.test(text);
  }, null, { timeout: timeoutMs }).catch(() => {});

  const snapshot = await page.evaluate(() => {
    return {
      nextDataText: String(document.getElementById("__NEXT_DATA__")?.textContent || ""),
      bodyText: String(document.body?.innerText || "").slice(0, 120000),
      title: String(document.title || ""),
      url: String(location.href || ""),
    };
  });
  return snapshot;
}

async function collectNaverSsrPage({
  page,
  url,
  pageIndex,
  timeoutMs,
  expectedHost = LEGACY_NAVER_SHOPPING_HOST,
  response = null,
  snapshot = null,
}) {
  const navigationResponse = response || await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  const status = Number(navigationResponse?.status?.() || 0);
  const pageSnapshot = snapshot || await readNaverPageSnapshot(page, timeoutMs);
  // Preserve typed HTTP/auth/CAPTCHA failures even when blocked pages omit
  // __NEXT_DATA__. Schema parsing runs only after the navigation itself is
  // proven to be a valid Naver Shopping response.
  classifyNaverPage({ status, ...pageSnapshot, rowCount: 0, expectedHost });
  const keyword = new URL(url).searchParams.get("query") || "";
  const parsed = parseNaverNextDataPage(pageSnapshot.nextDataText, {
    pageIndex,
    pageSize: NAVER_SHOPPING_PAGE_SIZE,
    keyword,
  });
  const classified = classifyNaverPage({
    status,
    ...pageSnapshot,
    rowCount: parsed.rows.length,
    expectedHost,
  });
  return {
    ...pageSnapshot,
    ...classified,
    ...parsed,
    sourceExhausted: parsed.sourceExhausted || classified.sourceExhausted,
  };
}

export async function defaultCollectPage({ page, url, pageIndex = 1, timeoutMs }) {
  const keyword = new URL(url).searchParams.get("query") || "";
  const frontendUrl = new URL(buildNaverShoppingFrontendUrl(keyword, pageIndex));
  let initialResponse = null;
  let initialSnapshot = null;

  // The partial-search endpoint is a first-party browser contract. Establish
  // the page/session once so fetch uses the same origin, cookies, and captcha
  // runtime as the actual Shopping frontend.
  if (pageIndex === 1) {
    initialResponse = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    initialSnapshot = await readNaverPageSnapshot(page, timeoutMs);
    classifyNaverPage({
      status: Number(initialResponse?.status?.() || 0),
      ...initialSnapshot,
      rowCount: 0,
    });
  }

  const frontendResult = await page.evaluate(async ({ requestPath, timeout }) => {
    // A CAPTCHA runtime is a hard stop. Never call window.ncaptcha?.f and never
    // send an x-wtm-ncaptcha-token header from the collector.
    if (typeof window.ncaptcha?.f === "function") {
      return {
        status: 418,
        url: String(location.href || ""),
        contentType: "text/plain",
        bodyText: "CAPTCHA",
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = {
        accept: "application/json, text/plain, */*",
        logic: "PART",
      };
      const response = await fetch(requestPath, {
        method: "GET",
        credentials: "include",
        headers,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      return {
        status: response.status,
        url: response.url,
        contentType: response.headers.get("content-type") || "",
        bodyText,
      };
    } finally {
      clearTimeout(timer);
    }
  }, {
    requestPath: `${frontendUrl.pathname}${frontendUrl.search}`,
    timeout: timeoutMs,
  });

  const frontendStatus = Number(frontendResult?.status || 0);
  if (frontendStatus === 404 || frontendStatus === 405) {
    return collectNaverSsrPage({
      page,
      url,
      pageIndex,
      timeoutMs,
      response: initialResponse,
      snapshot: initialSnapshot,
    });
  }
  classifyNaverPage({
    status: frontendStatus,
    url: frontendResult?.url || frontendUrl.toString(),
    bodyText: frontendResult?.bodyText || "",
    rowCount: 0,
  });
  if (!/application\/json/i.test(String(frontendResult?.contentType || ""))) {
    throw new ProviderError("naver_frontend_schema_drift", "content-type");
  }
  const parsed = parseNaverFrontendPage(frontendResult.bodyText, {
    pageIndex,
    pageSize: NAVER_SHOPPING_PAGE_SIZE,
    keyword,
  });
  return {
    title: "",
    bodyText: "",
    url: frontendResult?.url || frontendUrl.toString(),
    ...parsed,
  };
}

async function collectAuthenticatedMsearchPage({ page, url, pageIndex = 1, timeoutMs }) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== LOCAL_WORKER_NAVER_SHOPPING_HOST
    || parsed.pathname !== "/search/all"
  ) {
    throw new ProviderError("provider_navigation_not_allowed");
  }
  return collectNaverSsrPage({
    page,
    url,
    pageIndex,
    timeoutMs,
    expectedHost: LOCAL_WORKER_NAVER_SHOPPING_HOST,
  });
}

function providerConfig(env = process.env) {
  return {
    headless: String(env.NAVER_SHOPPING_PROVIDER_HEADLESS || "true").toLowerCase() !== "false",
    browserChannel: normalizeString(env.NAVER_SHOPPING_PROVIDER_CHANNEL || "chromium", 40).toLowerCase(),
    localWorkerEnabled: String(
      env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED || "",
    ).trim().toLowerCase() === "true",
    searchHost: allowedShoppingHost(
      env.NAVER_SHOPPING_PROVIDER_SEARCH_HOST,
      LEGACY_NAVER_SHOPPING_HOST,
    ),
    userDataDir: String(env.NAVER_SHOPPING_PROVIDER_USER_DATA_DIR || "").trim().slice(0, 4_096),
    timeoutMs: boundedInteger(env.NAVER_SHOPPING_PROVIDER_TIMEOUT_MS, 90_000, 10_000, 225_000),
    pageTimeoutMs: boundedInteger(env.NAVER_SHOPPING_PROVIDER_PAGE_TIMEOUT_MS, 18_000, 3_000, 45_000),
    queueMax: boundedInteger(env.NAVER_SHOPPING_PROVIDER_QUEUE_MAX, 8, 1, 50),
    cacheTtlMs: boundedInteger(env.NAVER_SHOPPING_PROVIDER_CACHE_TTL_MS, 12 * 60_000, 10_000, 30 * 60_000),
    cacheMax: boundedInteger(env.NAVER_SHOPPING_PROVIDER_CACHE_MAX, 64, 1, 500),
    readinessTtlMs: boundedInteger(env.NAVER_SHOPPING_PROVIDER_READINESS_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000),
    blockCooldownMs: boundedInteger(
      env.NAVER_SHOPPING_PROVIDER_BLOCK_COOLDOWN_MS,
      PROVIDER_BLOCK_COOLDOWN_MS,
      60_000,
      24 * 60 * 60_000,
    ),
    schemaCooldownMs: boundedInteger(
      env.NAVER_SHOPPING_PROVIDER_SCHEMA_COOLDOWN_MS,
      PROVIDER_SCHEMA_COOLDOWN_MS,
      60_000,
      24 * 60 * 60_000,
    ),
    canaryKeyword: normalizeKeyword(env.NAVER_SHOPPING_PROVIDER_CANARY_KEYWORD || "온열찜질기"),
    canaryLimit: boundedInteger(env.NAVER_SHOPPING_PROVIDER_CANARY_LIMIT, 5, 1, 40),
  };
}

async function defaultBrowserFactory({ headless, channel }) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new ProviderError("provider_browser_dependency_missing");
  }
  try {
    return await playwright.chromium.launch({ headless, channel });
  } catch (error) {
    throw new ProviderError("provider_browser_launch_failed", error?.message || "");
  }
}

async function defaultPersistentContextFactory({ userDataDir, headless, channel, contextOptions }) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new ProviderError("provider_browser_dependency_missing");
  }
  try {
    return await playwright.chromium.launchPersistentContext(userDataDir, {
      headless,
      channel,
      ...contextOptions,
    });
  } catch (error) {
    throw new ProviderError("provider_browser_launch_failed", error?.message || "");
  }
}

export function createPlaywrightProvider(options = {}) {
  const config = { ...providerConfig(options.env || process.env), ...(options.config || {}) };
  if (config.browserChannel !== "chromium") {
    throw new ProviderError("provider_browser_channel_not_allowed");
  }
  config.searchHost = allowedShoppingHost(config.searchHost);
  const injectedHarness = Boolean(
    options.browserFactory || options.persistentContextFactory || options.collectPage,
  );
  if (!injectedHarness) {
    if (!config.localWorkerEnabled) throw new ProviderError("provider_local_worker_required");
    if (config.searchHost !== LOCAL_WORKER_NAVER_SHOPPING_HOST) {
      throw new ProviderError("provider_local_worker_host_required");
    }
    if (config.headless) throw new ProviderError("provider_headful_required");
    config.userDataDir = String(
      config.userDataDir || defaultNaverShoppingProfileDir(),
    ).trim();
  }
  if (config.searchHost === LOCAL_WORKER_NAVER_SHOPPING_HOST && !config.localWorkerEnabled) {
    throw new ProviderError("provider_local_worker_required");
  }
  const now = options.now || (() => Date.now());
  const browserFactory = options.browserFactory || defaultBrowserFactory;
  const persistentContextFactory = options.persistentContextFactory || defaultPersistentContextFactory;
  const profileValidator = options.profileValidator || validateNaverShoppingProfileDir;
  const collectPage = options.collectPage || (
    config.searchHost === LOCAL_WORKER_NAVER_SHOPPING_HOST
      ? collectAuthenticatedMsearchPage
      : defaultCollectPage
  );
  const autoVerify = options.autoVerify !== false;
  let browserPromise = null;
  let persistentContextPromise = null;
  let active = 0;
  let closed = false;
  let verificationPromise = null;
  let verifiedAt = 0;
  let lastAttemptAt = 0;
  let cooldownUntil = 0;
  let readinessReason = config.canaryKeyword ? "startup_canary_pending" : "canary_keyword_missing";
  const queue = [];
  const cache = new Map();
  const inFlight = new Map();

  function deadlineMs(request) {
    const requested = Date.parse(request.deadlineAt);
    return Math.min(requested, now() + config.timeoutMs);
  }

  function remainingMs(deadlineAt, maximum = config.pageTimeoutMs) {
    const remaining = deadlineAt - now() - DEADLINE_GUARD_MS;
    if (remaining <= 0) throw new ProviderError("provider_deadline_exceeded");
    return Math.max(1, Math.min(maximum, remaining));
  }

  async function ensureBrowser() {
    if (closed) throw new ProviderError("provider_closed");
    if (!browserPromise) {
      browserPromise = Promise.resolve(browserFactory({
        headless: config.headless,
        channel: config.browserChannel,
      }))
        .then((browser) => {
          if (!browser || typeof browser.newContext !== "function") throw new ProviderError("provider_browser_invalid");
          if (typeof browser.on === "function") {
            browser.on("disconnected", () => {
              browserPromise = null;
            });
          }
          return browser;
        })
        .catch((error) => {
          browserPromise = null;
          throw error;
        });
    }
    const browser = await browserPromise;
    if (typeof browser.isConnected === "function" && !browser.isConnected()) {
      browserPromise = null;
      return ensureBrowser();
    }
    return browser;
  }

  const contextOptions = Object.freeze({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1200 },
    colorScheme: "light",
  });

  async function ensurePersistentContext() {
    if (closed) throw new ProviderError("provider_closed");
    if (!persistentContextPromise) {
      persistentContextPromise = Promise.resolve()
        .then(() => profileValidator(config.userDataDir))
        .then((userDataDir) => persistentContextFactory({
          userDataDir,
          headless: config.headless,
          channel: config.browserChannel,
          contextOptions,
        }))
        .then(async (context) => {
          if (!context || typeof context.newPage !== "function" || typeof context.close !== "function") {
            throw new ProviderError("provider_browser_invalid");
          }
          for (const existingPage of context.pages?.() || []) {
            await existingPage?.close?.().catch(() => {});
          }
          const browser = context.browser?.();
          if (typeof browser?.on === "function") {
            browser.on("disconnected", () => {
              persistentContextPromise = null;
            });
          }
          return context;
        })
        .catch((error) => {
          persistentContextPromise = null;
          throw error;
        });
    }
    const context = await persistentContextPromise;
    const browser = context.browser?.();
    if (typeof browser?.isConnected === "function" && !browser.isConnected()) {
      persistentContextPromise = null;
      return ensurePersistentContext();
    }
    return context;
  }

  function pumpQueue() {
    if (closed || active >= 1 || !queue.length) return;
    const job = queue.shift();
    if (job.deadlineAt - now() <= DEADLINE_GUARD_MS) {
      job.reject(new ProviderError("provider_queue_deadline_exceeded"));
      queueMicrotask(pumpQueue);
      return;
    }
    active = 1;
    Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        active = 0;
        pumpQueue();
      });
  }

  function enqueue(run, requestDeadlineAt) {
    if (closed) return Promise.reject(new ProviderError("provider_closed"));
    if (queue.length >= config.queueMax) return Promise.reject(new ProviderError("provider_queue_full"));
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject, deadlineAt: requestDeadlineAt });
      pumpQueue();
    });
  }

  function pruneCache(timestamp = now()) {
    for (const [key, entry] of cache.entries()) {
      if (!entry || entry.expiresAt <= timestamp) cache.delete(key);
    }
    while (cache.size > config.cacheMax) cache.delete(cache.keys().next().value);
  }

  function requestCacheKey(request) {
    return `${normalizeKeyword(request.keyword).toLowerCase()}\n${Number(request.limit)}`;
  }

  function cachedWindow(request) {
    pruneCache();
    const entry = cache.get(requestCacheKey(request));
    if (!entry) return null;
    return deepClone(entry.result);
  }

  async function collectLive(request) {
    const endAt = deadlineMs(request);
    let context;
    let page;
    let ownsContext = false;
    try {
      if (config.userDataDir) {
        context = await ensurePersistentContext();
      } else {
        const browser = await ensureBrowser();
        context = await browser.newContext(contextOptions);
        ownsContext = true;
      }
      page = await context.newPage();
      const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
      let marketTotal = null;
      let marketTotalVerified = true;
      let sourceExhausted = false;
      const pageLimit = Math.min(
        NAVER_SHOPPING_MAX_PAGES,
        Math.ceil(request.limit / NAVER_SHOPPING_PAGE_SIZE) + 2,
      );

      for (let pageIndex = 1; pageIndex <= pageLimit && state.items.length < request.limit && !sourceExhausted; pageIndex += 1) {
        const url = buildNaverShoppingSearchUrl(request.keyword, pageIndex, {
          host: config.searchHost,
        });
        const pageResult = await collectPage({
          page,
          url,
          pageIndex,
          deadlineAt: endAt,
          timeoutMs: remainingMs(endAt),
        });
        if (pageResult.marketTotal != null && marketTotalVerified) {
          if (!Number.isSafeInteger(pageResult.marketTotal) || pageResult.marketTotal < 0) {
            marketTotalVerified = false;
            marketTotal = null;
          } else if (marketTotal != null && marketTotal !== pageResult.marketTotal) {
            marketTotalVerified = false;
            marketTotal = null;
          } else {
            marketTotal = pageResult.marketTotal;
          }
        }
        const before = state.items.length;
        appendNormalizedPage(state, pageResult, { pageIndex, limit: request.limit });
        sourceExhausted = pageResult.sourceExhausted === true;
        if (state.items.length === before && !sourceExhausted) {
          throw new ProviderError("naver_selector_drift", `page:${pageIndex}:no_new_rows`);
        }
        if (marketTotalVerified && marketTotal != null && marketTotal < state.items.length) {
          marketTotalVerified = false;
          marketTotal = null;
        }
      }

      const complete = state.items.length >= request.limit || sourceExhausted;
      if (!complete) throw new ProviderError("provider_partial_window", `${state.items.length}/${request.limit}`);
      const collectedAt = new Date(now()).toISOString();
      const identityDigest = sha256(state.items.map(identityKey).join("\n")).slice(0, 20);
      return {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        keyword: request.keyword,
        source: SOURCE,
        rankEvidence: RANK_EVIDENCE,
        collectionId: `pw-${Date.parse(collectedAt)}-${identityDigest}`,
        collectedAt,
        complete: true,
        partial: false,
        sourceExhausted: state.items.length < request.limit && sourceExhausted,
        marketTotal: marketTotalVerified ? marketTotal : null,
        marketTotalStatus: marketTotalVerified && marketTotal != null ? "verified" : "unavailable",
        checkedCount: state.items.length,
        rawCount: state.rawCount,
        excludedAdCount: state.excludedAdCount,
        items: state.items,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (/timeout|timed out|aborted/i.test(String(error?.message || ""))) {
        throw new ProviderError("provider_deadline_exceeded");
      }
      throw new ProviderError("provider_browser_collection_failed", error?.message || "");
    } finally {
      await page?.close?.().catch(() => {});
      if (ownsContext) await context?.close?.().catch(() => {});
    }
  }

  async function collectAtomic(request, { forceFresh = false } = {}) {
    const cacheKey = requestCacheKey(request);
    if (cooldownUntil > now()) {
      throw new ProviderError("provider_cooldown_active", readinessReason);
    }
    if (!forceFresh) {
      const cached = cachedWindow(request);
      if (cached) return cached;
      const pending = inFlight.get(cacheKey);
      if (pending) {
        const result = await pending.promise;
        return cachedWindow(request) || deepClone(result);
      }
    }
    const promise = enqueue(() => collectLive(request), deadlineMs(request));
    inFlight.set(cacheKey, { promise });
    try {
      const result = await promise;
      cache.set(cacheKey, {
        expiresAt: now() + config.cacheTtlMs,
        result: deepClone(result),
      });
      pruneCache();
      return deepClone(result);
    } finally {
      if (inFlight.get(cacheKey)?.promise === promise) inFlight.delete(cacheKey);
    }
  }

  function markFailure(error) {
    verifiedAt = 0;
    readinessReason = error?.code || error?.message || "startup_canary_failed";
    const code = String(error?.code || "");
    if (
      code === "naver_http_418"
      || code === "naver_http_429"
      || code === "naver_captcha_detected"
      || code === "naver_access_blocked"
    ) {
      cooldownUntil = Math.max(cooldownUntil, now() + config.blockCooldownMs);
    } else if (
      code === "naver_frontend_schema_drift"
      || code === "naver_next_data_schema_drift"
      || code === "naver_next_data_rank_drift"
      || code === "naver_selector_drift"
    ) {
      cooldownUntil = Math.max(cooldownUntil, now() + config.schemaCooldownMs);
    }
  }

  function isRequestLocalFailure(error) {
    return error?.code === "provider_queue_deadline_exceeded"
      || error?.code === "provider_queue_full";
  }

  async function verifyReadiness({ force = false } = {}) {
    if (closed) return false;
    if (!config.canaryKeyword) {
      readinessReason = "canary_keyword_missing";
      return false;
    }
    if (cooldownUntil > now()) return false;
    if (!force && verificationPromise) return verificationPromise;
    if (!force && lastAttemptAt && now() - lastAttemptAt < READINESS_RETRY_MS) return verifiedAt > 0;
    lastAttemptAt = now();
    const request = {
      schemaVersion: SCHEMA_VERSION,
      keyword: config.canaryKeyword,
      limit: config.canaryLimit,
      sort: "relevance",
      rankPolicy: "organic_only",
      deadlineAt: new Date(now() + Math.min(config.timeoutMs, 90_000)).toISOString(),
      requestId: `startup-canary-${now()}`,
    };
    verificationPromise = collectAtomic(request, { forceFresh: true })
      .then((window) => {
        const verified = validateProviderWindow(window, request);
        if (!verified.complete || verified.checkedCount < 1) throw new ProviderError("startup_canary_incomplete");
        verifiedAt = now();
        readinessReason = "";
        return true;
      })
      .catch((error) => {
        if (!isRequestLocalFailure(error)) markFailure(error);
        return false;
      })
      .finally(() => {
        verificationPromise = null;
      });
    return verificationPromise;
  }

  function scheduleVerification() {
    if (verificationPromise || closed || !config.canaryKeyword) return;
    if (cooldownUntil > now()) return;
    if (lastAttemptAt && now() - lastAttemptAt < READINESS_RETRY_MS) return;
    queueMicrotask(() => verifyReadiness().catch(() => {}));
  }

  if (autoVerify) scheduleVerification();

  return {
    async status() {
      if (verifiedAt && now() - verifiedAt > config.readinessTtlMs) {
        verifiedAt = 0;
        readinessReason = "readiness_verification_stale";
      }
      if (autoVerify && !verifiedAt) scheduleVerification();
      return {
        name: "playwright",
        configured: Boolean(config.canaryKeyword) && !closed,
        verified: verifiedAt > 0,
        reason: verifiedAt > 0 ? "" : readinessReason,
        cooldownUntil: cooldownUntil > now() ? new Date(cooldownUntil).toISOString() : "",
        busy: active > 0,
        queueDepth: queue.length,
      };
    },
    async collect(request) {
      try {
        const result = await collectAtomic(request);
        verifiedAt = now();
        cooldownUntil = 0;
        readinessReason = "";
        return result;
      } catch (error) {
        if (!isRequestLocalFailure(error) && error?.code !== "provider_cooldown_active") markFailure(error);
        throw error;
      }
    },
    verifyReadiness,
    async close() {
      closed = true;
      while (queue.length) queue.shift().reject(new ProviderError("provider_closed"));
      const persistentContext = await persistentContextPromise?.catch(() => null);
      persistentContextPromise = null;
      await persistentContext?.close?.().catch(() => {});
      const browser = await browserPromise?.catch(() => null);
      browserPromise = null;
      await browser?.close?.().catch(() => {});
    },
    __testing: {
      cachedWindow,
      cache,
      inFlight,
      config,
    },
  };
}

export function createUnconfiguredProvider(reason = "verified_provider_not_configured") {
  return {
    async status() {
      return {
        name: "unconfigured",
        configured: false,
        verified: false,
        reason,
      };
    },
    async collect() {
      throw new ProviderError(PROVIDER_NOT_READY);
    },
    async close() {},
  };
}

export function createProviderFromEnv(env = process.env) {
  const mode = String(env.NAVER_SHOPPING_PROVIDER_MODE || "not_ready").trim().toLowerCase();
  if (mode === "playwright") {
    return createUnconfiguredProvider("local_worker_only_provider");
  }
  return createUnconfiguredProvider(
    mode === "not_ready"
      ? "verified_provider_not_configured"
      : "unsupported_provider_mode"
  );
}

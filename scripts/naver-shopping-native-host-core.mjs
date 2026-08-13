import crypto from "node:crypto";

import {
  RANK_EVIDENCE,
  SCHEMA_VERSION,
  SOURCE,
  validateProviderWindow,
  validateRankRequest,
} from "../tools/naver-shopping-rank-collector/src/contract.mjs";
import {
  ProviderError,
  appendNormalizedPage,
  parseNaverNextDataPage,
} from "../tools/naver-shopping-rank-collector/src/provider.mjs";

const PAGE_SIZE = 40;
const MAX_PAGES = 8;
const REQUIRED_LIMIT = 300;
const PAGE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
const ROWS_MAX_BYTES = 2 * 1024 * 1024;
const ROWS_MAX_COUNT = 500;

function pagePayload(page) {
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    throw new ProviderError("native_host_page_invalid");
  }
  const pageIndex = Number(page.pageIndex);
  const nextDataText = String(page.nextDataText || "");
  if (!Number.isInteger(pageIndex)
    || pageIndex < 1
    || pageIndex > MAX_PAGES
    || !nextDataText
    || Buffer.byteLength(nextDataText, "utf8") > PAGE_TEXT_MAX_BYTES) {
    throw new ProviderError("native_host_page_invalid", `page:${String(page.pageIndex)}`);
  }
  return { pageIndex, nextDataText };
}

function identityDigest(items) {
  const identity = items.map((item) => [
    item.sellerProductId || "",
    item.catalogId || "",
    item.productId || "",
    item.link || "",
  ].join("|")).join("\n");
  return crypto.createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 20);
}

export function buildNativeWindowFromPages(rawRequest, rawPages, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const request = validateRankRequest(rawRequest, { nowMs });
  if (request.limit !== REQUIRED_LIMIT) throw new ProviderError("native_host_limit_invalid");
  const pages = (Array.isArray(rawPages) ? rawPages : []).map(pagePayload);
  if (pages.length !== MAX_PAGES) throw new ProviderError("native_host_pages_incomplete");
  pages.sort((left, right) => left.pageIndex - right.pageIndex);

  const state = {
    items: [],
    rawCount: 0,
    excludedAdCount: 0,
    identities: new Set(),
  };
  let marketTotal = null;
  let marketTotalVerified = true;
  let sourceExhausted = false;

  for (let index = 0; index < pages.length && state.items.length < request.limit; index += 1) {
    const page = pages[index];
    const expectedPageIndex = index + 1;
    if (page.pageIndex !== expectedPageIndex) {
      throw new ProviderError("native_host_pages_out_of_order", `page:${page.pageIndex}`);
    }
    const parsed = parseNaverNextDataPage(page.nextDataText, {
      pageIndex: page.pageIndex,
      pageSize: PAGE_SIZE,
      keyword: request.keyword,
    });
    if (marketTotal == null) marketTotal = parsed.marketTotal;
    else if (marketTotal !== parsed.marketTotal) {
      marketTotal = null;
      marketTotalVerified = false;
    }
    appendNormalizedPage(state, parsed, {
      pageIndex: page.pageIndex,
      limit: request.limit,
    });
    sourceExhausted = parsed.sourceExhausted === true;
  }

  if (state.items.length !== REQUIRED_LIMIT) {
    throw new ProviderError("provider_partial_window", `${state.items.length}/${REQUIRED_LIMIT}`);
  }
  if (marketTotal != null && marketTotal < state.items.length) {
    marketTotal = null;
    marketTotalVerified = false;
  }
  const collectedAt = new Date(nowMs).toISOString();
  return validateProviderWindow({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    keyword: request.keyword,
    source: SOURCE,
    rankEvidence: RANK_EVIDENCE,
    collectionId: `pw-chrome-${nowMs}-${identityDigest(state.items)}`,
    collectedAt,
    complete: true,
    partial: false,
    sourceExhausted,
    marketTotal: marketTotalVerified ? marketTotal : null,
    marketTotalStatus: marketTotalVerified && marketTotal != null ? "verified" : "unavailable",
    checkedCount: state.items.length,
    rawCount: state.rawCount,
    excludedAdCount: state.excludedAdCount,
    items: state.items,
  }, request);
}

export function buildNativeWindowFromRows(rawRequest, rawRows, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const request = validateRankRequest(rawRequest, { nowMs });
  if (request.limit !== REQUIRED_LIMIT) throw new ProviderError("native_host_limit_invalid");
  if (!Array.isArray(rawRows)
    || rawRows.length < REQUIRED_LIMIT
    || rawRows.length > ROWS_MAX_COUNT
    || Buffer.byteLength(JSON.stringify(rawRows), "utf8") > ROWS_MAX_BYTES) {
    throw new ProviderError("native_host_rows_invalid");
  }
  const rows = rawRows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new ProviderError("native_host_rows_invalid", `row:${index}`);
    }
    return row;
  });
  const state = {
    items: [],
    rawCount: 0,
    excludedAdCount: 0,
    identities: new Set(),
  };
  appendNormalizedPage(state, { rows }, { pageIndex: 1, limit: request.limit });
  if (state.items.length !== REQUIRED_LIMIT) {
    throw new ProviderError("provider_partial_window", `${state.items.length}/${REQUIRED_LIMIT}`);
  }
  const collectedAt = new Date(nowMs).toISOString();
  return validateProviderWindow({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    keyword: request.keyword,
    source: SOURCE,
    rankEvidence: RANK_EVIDENCE,
    collectionId: `pw-chrome-${nowMs}-${identityDigest(state.items)}`,
    collectedAt,
    complete: true,
    partial: false,
    sourceExhausted: false,
    marketTotal: null,
    marketTotalStatus: "unavailable",
    checkedCount: state.items.length,
    rawCount: state.rawCount,
    excludedAdCount: state.excludedAdCount,
    items: state.items,
  }, request);
}

export function createChromeNativeProvider(options = {}) {
  if (typeof options.exchange !== "function") {
    throw new ProviderError("native_host_exchange_missing");
  }
  return {
    async collect(request) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const response = await options.exchange({
          type: "collect",
          request,
        });
        if (!response || response.type !== "collection") {
          throw new ProviderError("native_host_collection_invalid");
        }
        try {
          if (Array.isArray(response.rows)) {
            return buildNativeWindowFromRows(request, response.rows, {
              nowMs: options.nowMs?.() ?? Date.now(),
            });
          }
          return buildNativeWindowFromPages(request, response.pages, {
            nowMs: options.nowMs?.() ?? Date.now(),
          });
        } catch (error) {
          const transientOverlap = error instanceof ProviderError
            && error.code === "provider_duplicate_identity"
            && /^(?:[1-8]):(?:\d+):page_overlap:(?:[1-8])$/u.test(String(error.detail || ""));
          if (!transientOverlap || attempt >= 2) throw error;
        }
      }
      throw new ProviderError("native_host_collection_invalid");
    },
    async close() {},
  };
}

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
const PAGE_NAVIGATION_BUDGET = 16;
const BOUNDARY_RECOLLECTION_ATTEMPTS = 4;
const DEADLINE_GUARD_MS = 3_000;
export const COLLECTION_PROTOCOL = "range-v1";

export function assertNativeExchangeRequestId(response, expectedRequestId) {
  if (typeof expectedRequestId !== "string"
    || !expectedRequestId
    || response?.requestId !== expectedRequestId) {
    throw new ProviderError("native_host_request_id_mismatch");
  }
  return response;
}

export function validateCollectionProtocolAck(message) {
  if (message?.action !== "ready_ack"
    || message?.collectionProtocol !== COLLECTION_PROTOCOL) {
    throw new ProviderError("native_host_ready_ack_invalid");
  }
}

export function resolveNativeExchangeWait(deadlineAt, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const maximumMs = Number(options.maximumMs);
  const absoluteDeadlineMs = Date.parse(String(deadlineAt || ""));
  if (!Number.isFinite(nowMs)
    || !Number.isFinite(maximumMs)
    || maximumMs <= 0
    || !Number.isFinite(absoluteDeadlineMs)) {
    throw new ProviderError("native_request_invalid");
  }
  const remainingMs = Math.floor(absoluteDeadlineMs - nowMs);
  if (remainingMs <= 0) throw new ProviderError("provider_deadline_exceeded");
  const deadlineBounded = remainingMs <= maximumMs;
  return {
    timeoutMs: Math.max(1, Math.min(maximumMs, remainingMs)),
    timeoutCode: deadlineBounded
      ? "provider_deadline_exceeded"
      : "native_host_response_timeout",
  };
}

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

export function createNativePageStreamCollector(options = {}) {
  const requestedPageStart = Number(options.pageStart ?? 1);
  const requestedPageEnd = Number(options.pageEnd ?? MAX_PAGES);
  if (!Number.isInteger(requestedPageStart)
    || !Number.isInteger(requestedPageEnd)
    || requestedPageStart < 1
    || requestedPageEnd > MAX_PAGES
    || requestedPageStart > requestedPageEnd) {
    throw new ProviderError("native_host_page_range_invalid");
  }

  const pages = [];
  let responsePageStart = null;
  let responsePageEnd = null;
  return {
    append(rawPage) {
      const responsePageIndex = Number(rawPage?.pageIndex);
      if (pages.length === 0) {
        if (responsePageIndex === requestedPageStart) {
          responsePageStart = requestedPageStart;
          responsePageEnd = requestedPageEnd;
        } else if (options.allowFullCompatibility === true
          && requestedPageStart > 1
          && responsePageIndex === 1) {
          // A previous service worker can ignore the suffix range and return
          // one complete window. Accept only its exact 1..8 frame sequence;
          // the provider replaces the whole old window with these eight pages.
          responsePageStart = 1;
          responsePageEnd = MAX_PAGES;
        }
      }
      if (responsePageStart == null
        || responsePageIndex !== responsePageStart + pages.length
        || pages.length >= responsePageEnd - responsePageStart + 1) {
        throw new ProviderError("native_host_pages_out_of_order");
      }
      const page = pagePayload(rawPage);
      pages.push(page);
      return page;
    },
    complete() {
      if (responsePageStart == null
        || pages.length !== responsePageEnd - responsePageStart + 1) {
        throw new ProviderError("native_host_pages_incomplete");
      }
      return pages.slice();
    },
  };
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

function overlapBoundary(error) {
  if (!(error instanceof ProviderError) || error.code !== "provider_duplicate_identity") return null;
  const match = String(error.detail || "").match(
    /^(?<collisionPage>[1-8]):\d+:page_overlap:(?<originPage>[1-8])$/u,
  );
  if (!match) return null;
  const collisionPage = Number(match.groups.collisionPage);
  const originPage = Number(match.groups.originPage);
  if (originPage >= collisionPage) return null;
  return { pageStart: originPage, pageEnd: MAX_PAGES };
}

function mergePageRange(basePages, replacementPages, {
  pageStart,
  pageEnd,
  allowFullCompatibility = false,
}) {
  if (!Array.isArray(basePages) || basePages.length !== MAX_PAGES || !Array.isArray(replacementPages)) {
    throw new ProviderError("native_host_pages_incomplete");
  }
  const expectedCount = pageEnd - pageStart + 1;
  const received = replacementPages.map(pagePayload);
  const exactRange = received.length === expectedCount
    && received.every((page, index) => page.pageIndex === pageStart + index);
  const fullCompatibilityWindow = pageStart > 1
    && received.length === MAX_PAGES
    && received.every((page, index) => page.pageIndex === index + 1);
  if (!exactRange && !(allowFullCompatibility && fullCompatibilityWindow)) {
    throw new ProviderError("native_host_pages_out_of_order", `range:${pageStart}-${pageEnd}`);
  }
  const merged = fullCompatibilityWindow
    ? received
    : basePages.map(pagePayload);
  if (!fullCompatibilityWindow) {
    for (const page of received) merged[page.pageIndex - 1] = page;
  }
  return {
    pages: merged,
    navigatedPages: received.length,
    fullCompatibilityWindow,
  };
}

export function createChromeNativeProvider(options = {}) {
  if (typeof options.exchange !== "function") {
    throw new ProviderError("native_host_exchange_missing");
  }
  return {
    async collect(request) {
      let navigatedPages = MAX_PAGES;
      const response = await options.exchange({
        type: "collect",
        request,
      });
      if (!response || response.type !== "collection") {
        throw new ProviderError("native_host_collection_invalid");
      }
      if (Array.isArray(response.rows)) {
        return buildNativeWindowFromRows(request, response.rows, {
          nowMs: options.nowMs?.() ?? Date.now(),
        });
      }
      let latestPages = response.pages;
      let latestError;
      let latestOverlap;
      try {
        return buildNativeWindowFromPages(request, latestPages, {
          nowMs: options.nowMs?.() ?? Date.now(),
        });
      } catch (error) {
        latestError = error;
        latestOverlap = overlapBoundary(error);
        if (!latestOverlap) throw error;
      }

      // Naver can update a relevance list while pages are being traversed. If
      // a complete pass crosses a moving boundary, replace only the affected
      // suffix and revalidate the entire 1..300 window. No row is skipped or
      // compressed; only a fully coherent merged window can pass. The combined
      // navigation budget is hard-capped so recovery cannot outlive the lease.
      for (let attempt = 1; attempt <= BOUNDARY_RECOLLECTION_ATTEMPTS; attempt += 1) {
        const requestedPages = latestOverlap.pageEnd - latestOverlap.pageStart + 1;
        if (navigatedPages + requestedPages > PAGE_NAVIGATION_BUDGET) throw latestError;
        const deadlineAt = Date.parse(String(request.deadlineAt || ""));
        if (!Number.isFinite(deadlineAt)
          || (options.nowMs?.() ?? Date.now()) + DEADLINE_GUARD_MS >= deadlineAt) {
          throw new ProviderError("provider_deadline_exceeded");
        }
        const response = await options.exchange({
          type: "collect",
          request,
          pageStart: latestOverlap.pageStart,
          pageEnd: latestOverlap.pageEnd,
          allowFullCompatibility: attempt === 1,
        });
        if (!response || response.type !== "collection" || Array.isArray(response.rows)) {
          throw new ProviderError("native_host_collection_invalid");
        }
        const merged = mergePageRange(latestPages, response.pages, {
          ...latestOverlap,
          allowFullCompatibility: attempt === 1,
        });
        navigatedPages += merged.navigatedPages;
        if (navigatedPages > PAGE_NAVIGATION_BUDGET) throw latestError;
        latestPages = merged.pages;
        try {
          return buildNativeWindowFromPages(request, latestPages, {
            nowMs: options.nowMs?.() ?? Date.now(),
          });
        } catch (error) {
          latestError = error;
          latestOverlap = overlapBoundary(error);
          if (merged.fullCompatibilityWindow
            || !latestOverlap
            || attempt >= BOUNDARY_RECOLLECTION_ATTEMPTS) throw error;
        }
      }
      throw latestError;
    },
    async close() {},
  };
}

import crypto from "node:crypto";

import {
  RANK_EVIDENCE,
  SCHEMA_VERSION,
  SOURCE,
  STABLE_FINITE_WINDOW_PROOF_VERSION,
  STABLE_FULL_WINDOW_PROOF_VERSION,
  stableFiniteWindowDigest,
  validateProviderWindow,
  validateRankRequest,
} from "../tools/naver-shopping-rank-collector/src/contract.mjs";
import {
  MAX_RENDERED_DUPLICATE_ORGANIC_SLOTS,
  ProviderError,
  appendNormalizedPage,
  buildStableRenderedOrderProof,
  buildStableFullWindowProof,
  marketTotalsWithinTolerance,
  parseNaverNextDataPage,
  parseNaverRenderedOrderCandidatePage,
} from "../tools/naver-shopping-rank-collector/src/provider.mjs";

const PAGE_SIZE = 40;
const MAX_PAGES = 8;
const REQUIRED_LIMIT = 300;
const PAGE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
const ROWS_MAX_BYTES = 2 * 1024 * 1024;
const ROWS_MAX_COUNT = 500;
const PAGE_NAVIGATION_BUDGET = 16;
const STABLE_FINITE_PAGE_NAVIGATION_BUDGET = 24;
// 1.1.31: the stable full-window proof gets the same bounded third capture the
// finite and rendered-order proofs already have (2026-09-15 ~ 09-17 KST, six
// `provider_stable_window_unproven:digest_mismatch` on 러그·칼슘쌀·콘트로이친·키크는).
const STABLE_FULL_WINDOW_PAGE_NAVIGATION_BUDGET = 24;
const RENDERED_ORDER_PAGE_NAVIGATION_BUDGET = 24;
// A zero raw-rank gap on a page seam means Naver reused the previous page's
// last organic number for the next page's first organic row. Coverage, raw-rank
// span, cross-page identity rejection and the two-capture direct-ID digest still
// hold, so a bounded number of seams per capture is tolerated instead of failing
// the capture. Negative gaps (regression) and over-limit gaps (missing rows) stay
// fatal. Seven seams exist in one 1..8 capture; more than two reused seams is
// treated as structural drift.
const MAX_RENDERED_SEAM_OVERLAP_COUNT = 2;
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

function nativeWindowPayloadFromPages(rawRequest, rawPages, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const request = validateRankRequest(rawRequest, { nowMs });
  if (request.limit !== REQUIRED_LIMIT) throw new ProviderError("native_host_limit_invalid");
  const pages = (Array.isArray(rawPages) ? rawPages : []).map(pagePayload);
  if (pages.length !== MAX_PAGES) throw new ProviderError("native_host_pages_incomplete");
  const receivedPageOrder = pages.map(({ pageIndex }) => pageIndex);
  pages.sort((left, right) => left.pageIndex - right.pageIndex);

  const state = {
    items: [],
    rawCount: 0,
    excludedAdCount: 0,
    identities: new Set(),
  };
  let marketTotal = null;
  let marketTotalAnchor = null;
  let marketTotalVerified = true;
  let sourceExhausted = false;
  let previousRankStructureSummary = null;
  let previousRenderedStructureSummary = null;
  let seamOverlapCount = 0;
  const renderedPageStructures = [];
  const renderedOrderCandidate = options.renderedOrderCandidate === true;
  if (renderedOrderCandidate
    && receivedPageOrder.some((pageIndex, index) => pageIndex !== index + 1)) {
    throw new ProviderError("provider_stable_rendered_order_unproven", "page_order");
  }

  for (let index = 0; index < pages.length && state.items.length < request.limit; index += 1) {
    const page = pages[index];
    const expectedPageIndex = index + 1;
    if (page.pageIndex !== expectedPageIndex) {
      throw new ProviderError("native_host_pages_out_of_order", `page:${page.pageIndex}`);
    }
    const parsed = (renderedOrderCandidate
      ? parseNaverRenderedOrderCandidatePage
      : parseNaverNextDataPage)(page.nextDataText, {
      pageIndex: page.pageIndex,
      pageSize: PAGE_SIZE,
      keyword: request.keyword,
      previousRankStructureSummary,
    });
    if (renderedOrderCandidate) {
      const structure = parsed.rankStructureSummary;
      const expectedOrganicCount = Math.min(
        PAGE_SIZE,
        Math.max(0, parsed.marketTotal - ((page.pageIndex - 1) * PAGE_SIZE)),
      );
      const boundaryGap = previousRenderedStructureSummary
        ? structure.firstOrganicRawRank - previousRenderedStructureSummary.lastOrganicRawRank
        : structure.firstOrganicRawRank;
      // Ranked paid slots consume raw numbers, on the first page as well as
      // across a seam (2026-09-11 실측: page 1 with 14 ad slots opened at raw
      // rank 3). The first page may therefore start after its own ad slots.
      const boundaryLimit = previousRenderedStructureSummary
        ? previousRenderedStructureSummary.adSlotCount + structure.adSlotCount + 1
        : structure.adSlotCount + 1;
      // A seam may reuse the previous page's last raw number, or step back by
      // the duplicate slots that page carried (a twin listing pushes the raw
      // numbers of the page it sits on: 2026-09-11 실측 `page_boundary:2:gm1`).
      // Anything further back is a regression and stays fatal.
      const seamOverlap = previousRenderedStructureSummary != null
        && boundaryGap <= 0
        && boundaryGap >= -MAX_RENDERED_DUPLICATE_ORGANIC_SLOTS;
      if (seamOverlap) seamOverlapCount += 1;
      // 1.1.30: a finite market ends before page 8 — pages past the end carry
      // no organic rows and no raw numbers, so they are not a boundary at all.
      const emptyTailPage = expectedOrganicCount === 0 && structure.organicCount === 0;
      if (structure.mode !== "rendered_order_candidate_v1"
        || structure.helperSlotCount !== 0
        || structure.organicCount !== expectedOrganicCount
        || (!emptyTailPage && (
          (boundaryGap < 1 && !seamOverlap)
          || boundaryGap > boundaryLimit
          || seamOverlapCount > MAX_RENDERED_SEAM_OVERLAP_COUNT))) {
        const encodedGap = boundaryGap < 0 ? `m${Math.abs(boundaryGap)}` : String(boundaryGap);
        throw new ProviderError(
          "provider_stable_rendered_order_unproven",
          `page_boundary:${page.pageIndex}:g${encodedGap}:l${boundaryLimit}`,
        );
      }
      renderedPageStructures.push([
        page.pageIndex,
        parsed.marketTotal,
        structure.organicCount,
        structure.adSlotCount,
        structure.firstOrganicRawRank,
        structure.lastOrganicRawRank,
        structure.rawRankDigest,
        seamOverlapCount,
      ]);
      if (!emptyTailPage) previousRenderedStructureSummary = structure;
    }
    previousRankStructureSummary = parsed.rankStructureSummary;
    // The live counter drifts a few dozen products between pages. Every page
    // is compared with the first page's total (an anchor, not a rolling
    // value, so the drift stays bounded over the whole window); only a total
    // outside MARKET_TOTAL_TOLERANCE_RATIO marks the window unverified. The
    // reported total is the most recent page's count.
    if (marketTotalAnchor == null) {
      marketTotalAnchor = parsed.marketTotal;
      marketTotal = parsed.marketTotal;
    } else if (marketTotalVerified
      && !marketTotalsWithinTolerance(marketTotalAnchor, parsed.marketTotal)) {
      marketTotal = null;
      marketTotalVerified = false;
    } else if (marketTotalVerified) {
      marketTotal = parsed.marketTotal;
    }
    appendNormalizedPage(state, parsed, {
      pageIndex: page.pageIndex,
      limit: request.limit,
      crossPageMode: options.crossPageMode || "reject",
      rejectAllIdentityDuplicates: renderedOrderCandidate,
    });
    sourceExhausted = parsed.sourceExhausted === true;
  }

  const finiteCandidate = state.items.length > 0
    && state.items.length < REQUIRED_LIMIT
    && options.allowStableFiniteCandidate === true;
  if (state.items.length !== REQUIRED_LIMIT && !finiteCandidate) {
    throw new ProviderError("provider_partial_window", `${state.items.length}/${REQUIRED_LIMIT}`);
  }
  if (renderedOrderCandidate && !marketTotalVerified) {
    throw new ProviderError("provider_stable_rendered_order_unproven", "market_total");
  }
  if (finiteCandidate
    && sourceExhausted === true
    && marketTotalVerified === true
    && marketTotal !== state.items.length
    && marketTotalsWithinTolerance(marketTotal, state.items.length)) {
    // 1.1.31 (2026-09-15 04:13 KST 탄소매트 `partial_window:220_300`): the live
    // counter jitters by a unit or two between pages (223/222/223 over one
    // capture that rendered 222 rows to exhaustion). Two independent captures
    // still have to reproduce every rendered slot; the rendered count is the
    // market size that rank semantics depend on, so it is the reported total.
    marketTotal = state.items.length;
  }
  if (finiteCandidate && (
    sourceExhausted !== true
    || marketTotalVerified !== true
    || marketTotal !== state.items.length
  )) {
    throw new ProviderError("provider_stable_finite_window_unproven", "coverage");
  }
  if (marketTotal != null && marketTotal < state.items.length) {
    marketTotal = null;
    marketTotalVerified = false;
  }
  const collectedAt = new Date(nowMs).toISOString();
  return {
    request,
    payload: {
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
    ...(options.crossPageProof ? { crossPageProof: options.crossPageProof } : {}),
    ...(options.finiteWindowProof ? { finiteWindowProof: options.finiteWindowProof } : {}),
    ...(options.renderedOrderProof ? { renderedOrderProof: options.renderedOrderProof } : {}),
    },
    ...(renderedOrderCandidate ? {
      renderedOrderStructureDigest: crypto.createHash("sha256").update([
        request.keyword,
        JSON.stringify(renderedPageStructures),
      ].join("\n"), "utf8").digest("hex"),
    } : {}),
  };
}

export function buildNativeWindowFromPages(rawRequest, rawPages, options = {}) {
  if (options.renderedOrderCandidate === true && !options.renderedOrderProof && !options.finiteWindowProof) {
    throw new ProviderError("provider_stable_rendered_order_unproven", "proof_missing");
  }
  const { request, payload } = nativeWindowPayloadFromPages(rawRequest, rawPages, options);
  return validateProviderWindow(payload, request);
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

export const COLLECTION_EVIDENCE_VERSION = "collection-evidence-v2";
// 1.1.31: the bound follows the worker/server bound (24000; the table keeps 32 KB). The first eleven
// production rows (2026-09-14 ~ 09-18) showed that the 1.1.30 14-row trim kept
// the paid rows at the top of every page and dropped the organic rows where the
// two captures actually differed; the trim now drops paid/helper rows first and
// keeps organic slots, and every failure also carries the branch trace and the
// slot-level diff of the last digest comparison.
const COLLECTION_EVIDENCE_MAX_CHARS = 24000;
const COLLECTION_TRACE_MAX = 24;
const COLLECTION_TRACE_ENTRY_MAX = 80;
const COLLECTION_DIFF_MAX_ENTRIES = 12;

function evidenceIdentity(item) {
  const mallProductId = String(item?.mallProductId ?? "").trim();
  const catalogId = String(item?.parentCatalogId ?? "").trim();
  const productId = String(item?.id ?? "").trim();
  if (String(item?.mallId ?? "") === "naver_model") return `c:${productId || catalogId}`;
  if (mallProductId) return `s:${mallProductId}`;
  if (catalogId) return `c:${catalogId}`;
  return `n:${productId}`;
}

export function summarizeCollectionPages(pages, rowLimit = Infinity, options = {}) {
  const organicOnly = options.organicOnly === true;
  return (Array.isArray(pages) ? pages : []).map((page) => {
    let data = null;
    try { data = JSON.parse(String(page?.nextDataText ?? "")); } catch { data = null; }
    const list = data?.props?.pageProps?.compositeList?.list;
    const total = data?.props?.pageProps?.compositeList?.total;
    const rows = [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (rows.length >= rowLimit) break;
      const item = entry?.item;
      if (entry?.type !== "product") { if (!organicOnly) rows.push(["h"]); continue; }
      const rank = Number.isSafeInteger(item?.rank) ? item.rank : null;
      if (item?.adId) { if (!organicOnly) rows.push(["a", rank]); continue; }
      rows.push([rank, evidenceIdentity(item)]);
    }
    return { p: Number(page?.pageIndex) || null, total: Number.isSafeInteger(total) ? total : null, rows };
  });
}

function boundedCollectionTrace(trace) {
  if (!Array.isArray(trace) || !trace.length) return null;
  return trace.slice(0, COLLECTION_TRACE_MAX).map((entry) => String(entry).slice(0, COLLECTION_TRACE_ENTRY_MAX));
}

function evidenceCell(value) {
  if (value == null) return null;
  if (Number.isSafeInteger(value)) return value;
  return String(Array.isArray(value) ? value.slice().sort().join("|") : value).slice(0, 90);
}

// Slot-by-slot comparison of two normalized organic windows: how many slots
// differ and, for the first few, which field carries the difference. Read
// beside the page rows to tell a shifted slot from a swapped identity.
export function slotDiffSummary(firstItems, secondItems) {
  const fields = ["organicRank", "productId", "sellerProductId", "catalogId", "linkedCatalogId", "productType", "catalogSellerProductIds"];
  const first = Array.isArray(firstItems) ? firstItems : [];
  const second = Array.isArray(secondItems) ? secondItems : [];
  const entries = [];
  let changed = 0;
  const length = Math.max(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    const left = first[index] || {};
    const right = second[index] || {};
    let differs = false;
    for (const field of fields) {
      const leftCell = evidenceCell(left[field]);
      const rightCell = evidenceCell(right[field]);
      if (leftCell === rightCell) continue;
      differs = true;
      if (entries.length < COLLECTION_DIFF_MAX_ENTRIES) entries.push([index + 1, field, leftCell, rightCell]);
    }
    if (differs) changed += 1;
  }
  return { a: first.length, b: second.length, changed, first: entries };
}

export function buildCollectionEvidence(request, passes, extra = {}) {
  const keyword = String(request?.keyword ?? "").slice(0, 80);
  const trace = boundedCollectionTrace(extra.trace);
  const diff = extra.diff && typeof extra.diff === "object" && !Array.isArray(extra.diff) ? extra.diff : null;
  const build = (rowLimit, passLimit, organicOnly) => ({
    version: COLLECTION_EVIDENCE_VERSION,
    keyword,
    passes: passes.slice(0, passLimit).map((pages) => summarizeCollectionPages(pages, rowLimit, { organicOnly })),
    truncated: rowLimit !== Infinity || passLimit < passes.length || organicOnly,
    ...(trace ? { trace } : {}),
    ...(diff ? { diff } : {}),
  });
  for (const [rowLimit, passLimit, organicOnly] of [
    [Infinity, 3, false], [Infinity, 3, true], [Infinity, 2, false], [Infinity, 2, true], [14, 2, true], [8, 1, true],
  ]) {
    const evidence = build(rowLimit, passLimit, organicOnly);
    if (JSON.stringify(evidence).length <= COLLECTION_EVIDENCE_MAX_CHARS) return evidence;
  }
  return { version: COLLECTION_EVIDENCE_VERSION, keyword, passes: [], truncated: true, ...(trace ? { trace } : {}) };
}

function attachFailureEvidence(error, request, passes, extra = {}) {
  if (!error || typeof error !== "object" || !passes.length) return;
  try {
    error.evidence = buildCollectionEvidence(request, passes, extra);
  } catch {
    // evidence is best-effort; the failure itself is what matters
  }
}

function traceNoter(collectOptions) {
  const trace = collectOptions?.trace;
  return (text) => {
    if (Array.isArray(trace) && trace.length < COLLECTION_TRACE_MAX) trace.push(String(text).slice(0, COLLECTION_TRACE_ENTRY_MAX));
  };
}

function isStableWindowDigestMismatch(error) {
  return error instanceof ProviderError
    && error.code === "provider_stable_window_unproven"
    && error.detail === "digest_mismatch";
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

function isPartialWindow(error) {
  return error instanceof ProviderError && error.code === "provider_partial_window";
}

function isNextDataRankDrift(error) {
  return error instanceof ProviderError && error.code === "naver_next_data_rank_drift";
}

function renderedPageBoundaryEvidence(error) {
  if (!(error instanceof ProviderError)
    || error.code !== "provider_stable_rendered_order_unproven") return null;
  const match = String(error.detail || "").match(
    /^page_boundary:(?<pageIndex>[1-8]):g(?<gap>m?[0-9]{1,3}):l(?<limit>[0-9]{1,3})$/u,
  );
  if (!match) return null;
  const gap = match.groups.gap.startsWith("m")
    ? -Number(match.groups.gap.slice(1))
    : Number(match.groups.gap);
  const limit = Number(match.groups.limit);
  return {
    pageIndex: Number(match.groups.pageIndex),
    gap,
    limit,
  };
}

function renderedOrderCandidateAttempt(request, response, nowMs) {
  try {
    return {
      candidate: nativeWindowPayloadFromPages(request, response.pages, {
        nowMs,
        renderedOrderCandidate: true,
      }),
      boundaryError: null,
    };
  } catch (error) {
    // 1.1.30 (일신한일의료기 탄소매트 `partial_window:215_300`): a finite market whose
    // pages also drift is arbitrated as a finite window below, not thrown here.
    if (isPartialWindow(error)) return { candidate: null, boundaryError: null, partialError: error };
    if (!renderedPageBoundaryEvidence(error)) throw error;
    return { candidate: null, boundaryError: error };
  }
}

function assertDistinctRenderedCaptureIds(responses) {
  const captureIds = responses.map(({ captureId }) => captureId);
  if (captureIds.some((captureId) => typeof captureId !== "string" || !captureId)
    || new Set(captureIds).size !== captureIds.length) {
    throw new ProviderError("provider_stable_rendered_order_unproven", "capture_ids");
  }
}

function buildRenderedOrderResult(request, firstResponse, firstCandidate, secondResponse,
  secondCandidate, nowMs) {
  const renderedOrderProof = buildStableRenderedOrderProof(
    firstCandidate.payload.items,
    secondCandidate.payload.items,
    {
      keyword: request.keyword,
      captureIds: [firstResponse.captureId, secondResponse.captureId],
      structureDigests: [
        firstCandidate.renderedOrderStructureDigest,
        secondCandidate.renderedOrderStructureDigest,
      ],
    },
  );
  return buildNativeWindowFromPages(request, secondResponse.pages, {
    nowMs,
    renderedOrderCandidate: true,
    renderedOrderProof,
  });
}

function buildStableFiniteWindowProof(firstPayload, secondPayload, captureIds, keyword) {
  if (!Array.isArray(captureIds)
    || captureIds.length !== 2
    || typeof captureIds[0] !== "string"
    || typeof captureIds[1] !== "string"
    || !captureIds[0]
    || captureIds[0] === captureIds[1]) {
    throw new ProviderError("provider_stable_finite_window_unproven", "capture_ids");
  }
  for (const payload of [firstPayload, secondPayload]) {
    if (payload?.sourceExhausted !== true
      || payload?.marketTotalStatus !== "verified"
      || !Number.isInteger(payload?.checkedCount)
      || payload.checkedCount < 1
      || payload.checkedCount >= REQUIRED_LIMIT
      || payload.marketTotal !== payload.checkedCount
      || payload.items?.length !== payload.checkedCount) {
      throw new ProviderError("provider_stable_finite_window_unproven", "coverage");
    }
  }
  if (firstPayload.checkedCount !== secondPayload.checkedCount
    || firstPayload.marketTotal !== secondPayload.marketTotal) {
    throw new ProviderError("provider_stable_finite_window_unproven", "count_mismatch");
  }
  let firstDigest;
  let secondDigest;
  try {
    firstDigest = stableFiniteWindowDigest(firstPayload.items, {
      keyword,
      marketTotal: firstPayload.marketTotal,
    });
    secondDigest = stableFiniteWindowDigest(secondPayload.items, {
      keyword,
      marketTotal: secondPayload.marketTotal,
    });
  } catch {
    throw new ProviderError("provider_stable_finite_window_unproven", "digest_invalid");
  }
  if (firstDigest !== secondDigest) {
    throw new ProviderError("provider_stable_finite_window_unproven", "digest_mismatch");
  }
  return {
    version: STABLE_FINITE_WINDOW_PROOF_VERSION,
    passCount: 2,
    pageCount: MAX_PAGES,
    pageSize: PAGE_SIZE,
    captureIds: captureIds.slice(),
    passDigests: [firstDigest, secondDigest],
    marketTotal: secondPayload.marketTotal,
    checkedCount: secondPayload.checkedCount,
  };
}

function stableFiniteCandidate(request, pages, options = {}) {
  try {
    const payload = nativeWindowPayloadFromPages(request, pages, {
      nowMs: options.nowMs,
      allowStableFiniteCandidate: true,
    }).payload;
    return payload.checkedCount < REQUIRED_LIMIT ? { payload, renderedOrder: false } : null;
  } catch (error) {
    if (isNextDataRankDrift(error)) {
      // 1.1.30: raw ranks drift on this finite market too (paid slots consume
      // numbers). The positional rendered-order parse still yields the ordered
      // identities; the two-capture finite digest below is the proof.
      try {
        const payload = nativeWindowPayloadFromPages(request, pages, {
          nowMs: options.nowMs,
          allowStableFiniteCandidate: true,
          renderedOrderCandidate: true,
        }).payload;
        return payload.checkedCount < REQUIRED_LIMIT ? { payload, renderedOrder: true } : null;
      } catch {
        return null;
      }
    }
    if (overlapBoundary(error)
      || isPartialWindow(error)
      || (error instanceof ProviderError
        && error.code === "provider_stable_finite_window_unproven")) {
      return null;
    }
    throw error;
  }
}

function assertDistinctFiniteCaptureIds(captureIds) {
  if (!Array.isArray(captureIds)
    || captureIds.length < 2
    || captureIds.some((captureId) => typeof captureId !== "string" || !captureId)
    || new Set(captureIds).size !== captureIds.length) {
    throw new ProviderError("provider_stable_finite_window_unproven", "capture_ids");
  }
}

function findStableFinitePair(candidates, captureIds, keyword, onMismatch = null) {
  assertDistinctFiniteCaptureIds(captureIds);
  const pairs = [[0, 1], [0, 2], [1, 2]];
  for (const [firstIndex, secondIndex] of pairs) {
    const firstPayload = candidates[firstIndex]?.payload;
    const secondPayload = candidates[secondIndex]?.payload;
    if (!firstPayload || !secondPayload) continue;
    try {
      return {
        payloadIndex: secondIndex,
        proof: buildStableFiniteWindowProof(
          firstPayload,
          secondPayload,
          [captureIds[firstIndex], captureIds[secondIndex]],
          keyword,
        ),
      };
    } catch (error) {
      if (!(error instanceof ProviderError)
        || error.code !== "provider_stable_finite_window_unproven"
        || !["count_mismatch", "digest_mismatch"].includes(error.detail)) {
        throw error;
      }
      if (typeof onMismatch === "function") onMismatch(firstIndex, secondIndex, error.detail, firstPayload, secondPayload);
    }
  }
  return null;
}

function assertCollectionDeadline(request, nowMs) {
  const deadlineAt = Date.parse(String(request.deadlineAt || ""));
  if (!Number.isFinite(deadlineAt) || nowMs + DEADLINE_GUARD_MS >= deadlineAt) {
    throw new ProviderError("provider_deadline_exceeded");
  }
}

export function createChromeNativeProvider(options = {}) {
  if (typeof options.exchange !== "function") {
    throw new ProviderError("native_host_exchange_missing");
  }
  return {
    // 1.1.30: every capture of a failed collection is summarised onto the error
    // (identities and raw numbers only, bounded) so a production failure can be
    // read from data instead of inferred from its code.
    async collect(request, collectOptions = {}) {
      const passes = [];
      const trace = [];
      const exchange = async (message) => {
        const reply = await options.exchange(message);
        if (reply && reply.type === "collection" && Array.isArray(reply.pages)) passes.push(reply.pages);
        return reply;
      };
      try {
        return await this.collectPasses(request, { ...collectOptions, trace }, exchange);
      } catch (error) {
        traceNoter({ trace })(`throw ${error?.code ?? error?.name ?? "error"}:${error?.detail ?? ""}`);
        attachFailureEvidence(error, request, passes, { trace, diff: error?.proofDiff });
        throw error;
      }
    },
    async collectPasses(request, collectOptions, exchange) {
      const note = traceNoter(collectOptions);
      let navigatedPages = MAX_PAGES;
      const response = await exchange({
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
      let recoveryReason = "";
      try {
        return buildNativeWindowFromPages(request, latestPages, {
          nowMs: options.nowMs?.() ?? Date.now(),
        });
      } catch (error) {
        if (isNextDataRankDrift(error)) recoveryReason = "rendered-order";
        else if (overlapBoundary(error)) recoveryReason = "stable-proof";
        else if (isPartialWindow(error)) recoveryReason = "partial-window";
        else throw error;
        note(`p1 ${error.code}:${error.detail ?? ""} -> ${recoveryReason}`);
      }

      // Discard a partial first pass instead of merging or padding it. A
      // cross-page duplicate can be either a moving pagination boundary or a
      // real Naver rank slot repeated across pages. In either case allow only
      // one independent full 1..8 pass within the shared deadline and the
      // fixed 16-page budget.
      assertCollectionDeadline(request, options.nowMs?.() ?? Date.now());
      if (navigatedPages + MAX_PAGES > PAGE_NAVIGATION_BUDGET) {
        throw new ProviderError("provider_stable_window_unproven", "page_budget");
      }
      const secondResponse = await exchange({
        type: "collect",
        request,
        pageStart: 1,
        pageEnd: MAX_PAGES,
        ...(["stable-proof", "rendered-order"].includes(recoveryReason)
          ? { stableProofPass: 2 }
          : {}),
      });
      if (!secondResponse
        || secondResponse.type !== "collection"
        || Array.isArray(secondResponse.rows)
        || !Array.isArray(secondResponse.pages)) {
        throw new ProviderError("native_host_collection_invalid");
      }
      navigatedPages += secondResponse.pages.length;
      if (navigatedPages !== PAGE_NAVIGATION_BUDGET) {
        throw new ProviderError("provider_stable_window_unproven", "page_budget");
      }

      // If the independent pass no longer overlaps, it is already a strict
      // coherent 300-window and needs no special proof.
      let secondFailure = null;
      try {
        return buildNativeWindowFromPages(request, secondResponse.pages, {
          nowMs: options.nowMs?.() ?? Date.now(),
        });
      } catch (error) {
        secondFailure = error;
        note(`p2 ${error?.code ?? "error"}:${error?.detail ?? ""}`);
        if (recoveryReason === "rendered-order") {
          // 1.1.30: drift on pass A and a partial window on pass B is a finite
          // market that also drifts — arbitrated as a finite window below.
          if (!isNextDataRankDrift(error)
            && !(isPartialWindow(error) && collectOptions.allowStableFinite === true)) throw error;
        } else {
          if (!overlapBoundary(error) && !isPartialWindow(error)
            && !(isNextDataRankDrift(error) && collectOptions.allowStableFinite === true)) throw error;
          if (recoveryReason === "partial-window") {
            if (!isPartialWindow(error)) {
              // A partial pass followed by an overlap cannot prove either a
              // coherent full window or one stable finite market.
              if (collectOptions.allowStableFinite !== true) {
                throw new ProviderError("provider_stable_window_unproven", "page_budget");
              }
            }
          } else if (isPartialWindow(error) && collectOptions.allowStableFinite !== true) {
            throw error;
          }
        }
      }

      let finiteFromRenderedOrder = false;
      if (recoveryReason === "rendered-order") {
        const candidateNowMs = options.nowMs?.() ?? Date.now();
        const attempts = [
          renderedOrderCandidateAttempt(request, response, candidateNowMs),
          renderedOrderCandidateAttempt(request, secondResponse, candidateNowMs),
        ];
        note(`rendered attempts ${attempts.map(({ candidate, partialError }) => (candidate ? "ok" : partialError ? "partial" : "boundary")).join(",")}`);
        const partialAttempt = attempts.find(({ partialError }) => partialError != null);
        if (partialAttempt) {
          if (collectOptions.allowStableFinite !== true) throw partialAttempt.partialError;
          finiteFromRenderedOrder = true;
        }
        if (!finiteFromRenderedOrder && attempts.every(({ candidate }) => candidate != null)) {
          return buildRenderedOrderResult(
            request,
            response,
            attempts[0].candidate,
            secondResponse,
            attempts[1].candidate,
            candidateNowMs,
          );
        }

        if (finiteFromRenderedOrder) {
          // handled by the finite arbitration below
        } else {
        const validIndex = attempts.findIndex(({ candidate }) => candidate != null);
        const invalidIndex = attempts.findIndex(({ boundaryError }) => boundaryError != null);
        const recoverableSingleBoundary = validIndex >= 0
          && invalidIndex >= 0
          && attempts.filter(({ candidate }) => candidate != null).length === 1
          && attempts.filter(({ boundaryError }) => boundaryError != null).length === 1
          && renderedPageBoundaryEvidence(attempts[invalidIndex].boundaryError) != null;
        if (!recoverableSingleBoundary) {
          throw attempts[invalidIndex]?.boundaryError
            || new ProviderError("provider_stable_rendered_order_unproven", "page_boundary");
        }

        // A single page-boundary-invalid pass is never accepted or repaired.
        // Discard it, collect one final independent 1..8 pass, and require that
        // pass to match the one already-valid direct-ID order. This is a fixed
        // 24-page ceiling, not a retry loop or a rank-gap correction.
        assertCollectionDeadline(request, options.nowMs?.() ?? Date.now());
        if (navigatedPages + MAX_PAGES > RENDERED_ORDER_PAGE_NAVIGATION_BUDGET) {
          throw new ProviderError("provider_stable_rendered_order_unproven", "page_budget");
        }
        const thirdResponse = await exchange({
          type: "collect",
          request,
          pageStart: 1,
          pageEnd: MAX_PAGES,
        });
        if (!thirdResponse
          || thirdResponse.type !== "collection"
          || Array.isArray(thirdResponse.rows)
          || !Array.isArray(thirdResponse.pages)) {
          throw new ProviderError("native_host_collection_invalid");
        }
        navigatedPages += thirdResponse.pages.length;
        if (navigatedPages !== RENDERED_ORDER_PAGE_NAVIGATION_BUDGET) {
          throw new ProviderError("provider_stable_rendered_order_unproven", "page_budget");
        }

        // The final capture must be independent even when it happens to
        // produce a strict 300-row window. Never let a replayed capture bypass
        // the rendered-order proof path merely because its raw ranks validate.
        assertDistinctRenderedCaptureIds([response, secondResponse, thirdResponse]);

        // A strict third pass is independently authoritative and needs no
        // rendered-order arbitration.
        try {
          return buildNativeWindowFromPages(request, thirdResponse.pages, {
            nowMs: options.nowMs?.() ?? Date.now(),
          });
        } catch (error) {
          if (!isNextDataRankDrift(error)) throw error;
        }

        const thirdAttempt = renderedOrderCandidateAttempt(
          request,
          thirdResponse,
          options.nowMs?.() ?? Date.now(),
        );
        if (!thirdAttempt.candidate) throw thirdAttempt.boundaryError || thirdAttempt.partialError;
        const validResponses = [response, secondResponse];
        return buildRenderedOrderResult(
          request,
          validResponses[validIndex],
          attempts[validIndex].candidate,
          thirdResponse,
          thirdAttempt.candidate,
          options.nowMs?.() ?? Date.now(),
        );
        }
      }

      const finiteArbitration = collectOptions.allowStableFinite === true
        && (recoveryReason === "partial-window" || isPartialWindow(secondFailure) || finiteFromRenderedOrder);
      note(`finite allow=${collectOptions.allowStableFinite === true} arbitration=${finiteArbitration}`);
      if (finiteArbitration) {
        const passResponses = [response, secondResponse];
        const candidates = passResponses.map((passResponse) => stableFiniteCandidate(
          request,
          passResponse.pages,
          { nowMs: options.nowMs?.() ?? Date.now() },
        ));
        let finiteDiff = null;
        const onFiniteMismatch = (firstIndex, secondIndex, detail, firstPayload, secondPayload) => {
          note(`finite pair ${firstIndex + 1},${secondIndex + 1} ${detail} ${firstPayload.checkedCount}/${secondPayload.checkedCount}`);
          if (detail === "digest_mismatch") finiteDiff = slotDiffSummary(firstPayload.items, secondPayload.items);
        };
        note(`finite candidates ${candidates.map((candidate) => (candidate ? (candidate.renderedOrder ? "ro" : "ok") : "null")).join(",")}`);
        let stablePair = findStableFinitePair(
          candidates,
          passResponses.map(({ captureId }) => captureId),
          request.keyword,
          onFiniteMismatch,
        );
        if (stablePair) {
          return buildNativeWindowFromPages(request, passResponses[stablePair.payloadIndex].pages, {
            nowMs: options.nowMs?.() ?? Date.now(),
            allowStableFiniteCandidate: true,
            renderedOrderCandidate: candidates[stablePair.payloadIndex]?.renderedOrder === true,
            finiteWindowProof: stablePair.proof,
          });
        }

        // The exact allowlisted canary gets one final independent 1..8 pass.
        // This is a fixed 24-page ceiling, not a retry loop. A result is used
        // only when two passes match by rank slot and strong relationship IDs;
        // titles, images, and thumbnails are never arbitration signals.
        assertCollectionDeadline(request, options.nowMs?.() ?? Date.now());
        if (navigatedPages + MAX_PAGES > STABLE_FINITE_PAGE_NAVIGATION_BUDGET) {
          throw new ProviderError("provider_stable_finite_window_unproven", "page_budget");
        }
        const thirdResponse = await exchange({
          type: "collect",
          request,
          pageStart: 1,
          pageEnd: MAX_PAGES,
        });
        if (!thirdResponse
          || thirdResponse.type !== "collection"
          || Array.isArray(thirdResponse.rows)
          || !Array.isArray(thirdResponse.pages)) {
          throw new ProviderError("native_host_collection_invalid");
        }
        navigatedPages += thirdResponse.pages.length;
        if (navigatedPages !== STABLE_FINITE_PAGE_NAVIGATION_BUDGET) {
          throw new ProviderError("provider_stable_finite_window_unproven", "page_budget");
        }
        passResponses.push(thirdResponse);
        candidates.push(stableFiniteCandidate(request, thirdResponse.pages, {
          nowMs: options.nowMs?.() ?? Date.now(),
        }));
        note(`finite candidate 3 ${candidates[2] ? (candidates[2].renderedOrder ? "ro" : "ok") : "null"}`);
        stablePair = findStableFinitePair(
          candidates,
          passResponses.map(({ captureId }) => captureId),
          request.keyword,
          onFiniteMismatch,
        );
        if (!stablePair) {
          const unproven = new ProviderError("provider_stable_finite_window_unproven", "three_passes");
          unproven.proofDiff = finiteDiff;
          throw unproven;
        }
        return buildNativeWindowFromPages(request, passResponses[stablePair.payloadIndex].pages, {
          nowMs: options.nowMs?.() ?? Date.now(),
          allowStableFiniteCandidate: true,
          renderedOrderCandidate: candidates[stablePair.payloadIndex]?.renderedOrder === true,
          finiteWindowProof: stablePair.proof,
        });
      }

      if (recoveryReason === "partial-window" && isPartialWindow(secondFailure)) {
        note("throw p2 partial without finite arbitration");
        throw secondFailure;
      }

      const stableResponses = [response, secondResponse];
      const stableCandidates = stableResponses.map((passResponse) => nativeWindowPayloadFromPages(request, passResponse.pages, {
        nowMs: options.nowMs?.() ?? Date.now(),
        crossPageMode: STABLE_FULL_WINDOW_PROOF_VERSION,
      }).payload);
      const stablePairProof = (firstIndex, secondIndex) => buildStableFullWindowProof(
        stableCandidates[firstIndex].items,
        stableCandidates[secondIndex].items,
        {
          keyword: request.keyword,
          captureIds: [stableResponses[firstIndex].captureId, stableResponses[secondIndex].captureId],
        },
      );
      let stableProof = null;
      try {
        stableProof = { index: 1, proof: stablePairProof(0, 1) };
      } catch (error) {
        if (!isStableWindowDigestMismatch(error)) throw error;
        error.proofDiff = slotDiffSummary(stableCandidates[0].items, stableCandidates[1].items);
        note(`stable pair 1,2 digest_mismatch changed=${error.proofDiff.changed}`);
        // 1.1.31: a live market of two million results moves between two
        // captures; one bounded independent third capture may match either
        // earlier one. The proof itself is unchanged (two captures must agree
        // on every slot and every cross-page collision); this is a fixed
        // 24-page ceiling like the finite and rendered-order proofs, never a
        // retry loop, and a third capture that matches neither fails closed.
        assertCollectionDeadline(request, options.nowMs?.() ?? Date.now());
        if (navigatedPages + MAX_PAGES > STABLE_FULL_WINDOW_PAGE_NAVIGATION_BUDGET) {
          throw new ProviderError("provider_stable_window_unproven", "page_budget");
        }
        const thirdResponse = await exchange({
          type: "collect",
          request,
          pageStart: 1,
          pageEnd: MAX_PAGES,
          stableProofPass: 3,
        });
        if (!thirdResponse
          || thirdResponse.type !== "collection"
          || Array.isArray(thirdResponse.rows)
          || !Array.isArray(thirdResponse.pages)) {
          throw new ProviderError("native_host_collection_invalid");
        }
        navigatedPages += thirdResponse.pages.length;
        if (navigatedPages !== STABLE_FULL_WINDOW_PAGE_NAVIGATION_BUDGET) {
          throw new ProviderError("provider_stable_window_unproven", "page_budget");
        }
        const captureIds = [...stableResponses, thirdResponse].map(({ captureId }) => captureId);
        if (captureIds.some((captureId) => typeof captureId !== "string" || !captureId)
          || new Set(captureIds).size !== captureIds.length) {
          throw new ProviderError("provider_stable_window_unproven", "capture_ids");
        }
        // A strict third capture is independently authoritative and needs no
        // cross-page proof.
        try {
          return buildNativeWindowFromPages(request, thirdResponse.pages, {
            nowMs: options.nowMs?.() ?? Date.now(),
          });
        } catch (thirdError) {
          note(`p3 ${thirdError?.code ?? "error"}:${thirdError?.detail ?? ""}`);
          if (!overlapBoundary(thirdError)) {
            const unproven = new ProviderError("provider_stable_window_unproven", "three_passes");
            unproven.proofDiff = error.proofDiff;
            throw unproven;
          }
        }
        stableResponses.push(thirdResponse);
        stableCandidates.push(nativeWindowPayloadFromPages(request, thirdResponse.pages, {
          nowMs: options.nowMs?.() ?? Date.now(),
          crossPageMode: STABLE_FULL_WINDOW_PROOF_VERSION,
        }).payload);
        for (const firstIndex of [0, 1]) {
          try {
            stableProof = { index: 2, proof: stablePairProof(firstIndex, 2) };
            note(`stable pair ${firstIndex + 1},3 proven`);
            break;
          } catch (pairError) {
            if (!isStableWindowDigestMismatch(pairError)) throw pairError;
            note(`stable pair ${firstIndex + 1},3 digest_mismatch`);
          }
        }
        if (!stableProof) {
          const unproven = new ProviderError("provider_stable_window_unproven", "three_passes");
          unproven.proofDiff = error.proofDiff;
          throw unproven;
        }
      }
      return buildNativeWindowFromPages(request, stableResponses[stableProof.index].pages, {
        nowMs: options.nowMs?.() ?? Date.now(),
        crossPageMode: STABLE_FULL_WINDOW_PROOF_VERSION,
        crossPageProof: stableProof.proof,
      });
    },
    async close() {},
  };
}

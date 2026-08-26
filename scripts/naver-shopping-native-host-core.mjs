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
  ProviderError,
  appendNormalizedPage,
  buildStableFullWindowProof,
  parseNaverNextDataPage,
} from "../tools/naver-shopping-rank-collector/src/provider.mjs";

const PAGE_SIZE = 40;
const MAX_PAGES = 8;
const REQUIRED_LIMIT = 300;
const PAGE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
const ROWS_MAX_BYTES = 2 * 1024 * 1024;
const ROWS_MAX_COUNT = 500;
const PAGE_NAVIGATION_BUDGET = 16;
const STABLE_FINITE_PAGE_NAVIGATION_BUDGET = 24;
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
      crossPageMode: options.crossPageMode || "reject",
    });
    sourceExhausted = parsed.sourceExhausted === true;
  }

  const finiteCandidate = state.items.length > 0
    && state.items.length < REQUIRED_LIMIT
    && options.allowStableFiniteCandidate === true;
  if (state.items.length !== REQUIRED_LIMIT && !finiteCandidate) {
    throw new ProviderError("provider_partial_window", `${state.items.length}/${REQUIRED_LIMIT}`);
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
    },
  };
}

export function buildNativeWindowFromPages(rawRequest, rawPages, options = {}) {
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
    return payload.checkedCount < REQUIRED_LIMIT ? payload : null;
  } catch (error) {
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

function findStableFinitePair(candidates, captureIds, keyword) {
  assertDistinctFiniteCaptureIds(captureIds);
  const pairs = [[0, 1], [0, 2], [1, 2]];
  for (const [firstIndex, secondIndex] of pairs) {
    const firstPayload = candidates[firstIndex];
    const secondPayload = candidates[secondIndex];
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
    async collect(request, collectOptions = {}) {
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
      let recoveryReason = "";
      try {
        return buildNativeWindowFromPages(request, latestPages, {
          nowMs: options.nowMs?.() ?? Date.now(),
        });
      } catch (error) {
        if (overlapBoundary(error)) recoveryReason = "stable-proof";
        else if (isPartialWindow(error)) recoveryReason = "partial-window";
        else throw error;
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
      const secondResponse = await options.exchange({
        type: "collect",
        request,
        pageStart: 1,
        pageEnd: MAX_PAGES,
        ...(recoveryReason === "stable-proof" ? { stableProofPass: 2 } : {}),
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
        if (!overlapBoundary(error) && !isPartialWindow(error)) throw error;
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

      const finiteArbitration = collectOptions.allowStableFinite === true
        && (recoveryReason === "partial-window" || isPartialWindow(secondFailure));
      if (finiteArbitration) {
        const passResponses = [response, secondResponse];
        const candidates = passResponses.map((passResponse) => stableFiniteCandidate(
          request,
          passResponse.pages,
          { nowMs: options.nowMs?.() ?? Date.now() },
        ));
        let stablePair = findStableFinitePair(
          candidates,
          passResponses.map(({ captureId }) => captureId),
          request.keyword,
        );
        if (stablePair) {
          return buildNativeWindowFromPages(request, passResponses[stablePair.payloadIndex].pages, {
            nowMs: options.nowMs?.() ?? Date.now(),
            allowStableFiniteCandidate: true,
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
        const thirdResponse = await options.exchange({
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
        stablePair = findStableFinitePair(
          candidates,
          passResponses.map(({ captureId }) => captureId),
          request.keyword,
        );
        if (!stablePair) {
          throw new ProviderError("provider_stable_finite_window_unproven", "three_passes");
        }
        return buildNativeWindowFromPages(request, passResponses[stablePair.payloadIndex].pages, {
          nowMs: options.nowMs?.() ?? Date.now(),
          allowStableFiniteCandidate: true,
          finiteWindowProof: stablePair.proof,
        });
      }

      if (recoveryReason === "partial-window" && isPartialWindow(secondFailure)) {
        throw secondFailure;
      }

      const firstCandidate = nativeWindowPayloadFromPages(request, latestPages, {
        nowMs: options.nowMs?.() ?? Date.now(),
        crossPageMode: STABLE_FULL_WINDOW_PROOF_VERSION,
      }).payload;
      const secondCandidate = nativeWindowPayloadFromPages(request, secondResponse.pages, {
        nowMs: options.nowMs?.() ?? Date.now(),
        crossPageMode: STABLE_FULL_WINDOW_PROOF_VERSION,
      }).payload;
      const crossPageProof = buildStableFullWindowProof(
        firstCandidate.items,
        secondCandidate.items,
        {
          keyword: request.keyword,
          captureIds: [response.captureId, secondResponse.captureId],
        },
      );
      return buildNativeWindowFromPages(request, secondResponse.pages, {
        nowMs: options.nowMs?.() ?? Date.now(),
        crossPageMode: STABLE_FULL_WINDOW_PROOF_VERSION,
        crossPageProof,
      });
    },
    async close() {},
  };
}

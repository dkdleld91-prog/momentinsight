import { Buffer } from "node:buffer";

import { parseNaverRenderedOrderCandidatePage } from "../tools/naver-shopping-rank-collector/src/provider.mjs";

const PAGE_SIZE = 40;
const PAGE_COUNT = 2;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

function diagnosticError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactPageInput(value, expectedPage) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw diagnosticError("rendered_boundary_input_invalid");
  }
  if (Number(value.pageIndex) !== expectedPage) {
    throw diagnosticError("rendered_boundary_page_order_invalid");
  }
  if (typeof value.nextDataText !== "string"
    || value.nextDataText.length < 2
    || Buffer.byteLength(value.nextDataText, "utf8") > MAX_PAGE_BYTES) {
    throw diagnosticError("rendered_boundary_page_payload_invalid");
  }
  return value.nextDataText;
}

/**
 * Local-only diagnostic projection for one bounded page-1/page-2 capture.
 *
 * The raw Naver payloads stay in caller memory. The returned projection contains
 * only the numeric boundary fields used by the native-host page-boundary gate;
 * it deliberately excludes raw payloads, digests, keywords, product fields,
 * identifiers, images, titles, URLs, cookies and tokens.
 */
export function renderedBoundaryDiagnostic(rawPages, { keyword, pass } = {}) {
  if (!Array.isArray(rawPages) || rawPages.length !== PAGE_COUNT) {
    throw diagnosticError("rendered_boundary_page_count_invalid");
  }
  const normalizedKeyword = String(keyword || "").trim().normalize("NFC").replace(/\s+/gu, " ");
  if (!normalizedKeyword || normalizedKeyword.length > 100) {
    throw diagnosticError("rendered_boundary_keyword_invalid");
  }
  const normalizedPass = Number(pass);
  if (!Number.isSafeInteger(normalizedPass) || normalizedPass < 1 || normalizedPass > 2) {
    throw diagnosticError("rendered_boundary_pass_invalid");
  }

  let previous = null;
  const pages = rawPages.map((rawPage, index) => {
    const page = index + 1;
    const parsed = parseNaverRenderedOrderCandidatePage(
      exactPageInput(rawPage, page),
      {
        pageIndex: page,
        pageSize: PAGE_SIZE,
        keyword: normalizedKeyword,
      },
    );
    const structure = parsed.rankStructureSummary;
    const gap = previous
      ? structure.firstOrganicRawRank - previous.lastOrganicRawRank
      : structure.firstOrganicRawRank;
    const limit = previous
      ? previous.adSlotCount + structure.adSlotCount + 1
      : 1;
    const safe = {
      page,
      organic: structure.organicCount,
      ad: structure.adSlotCount,
      helper: structure.helperSlotCount,
      first: structure.firstOrganicRawRank,
      last: structure.lastOrganicRawRank,
      gap,
      limit,
    };
    previous = structure;
    return safe;
  });

  return {
    pass: normalizedPass,
    pages,
  };
}

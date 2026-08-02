import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractError,
  RANK_EVIDENCE,
  SCHEMA_VERSION,
  SOURCE,
  validateProviderWindow,
  validateRankRequest,
} from "../src/contract.mjs";

const NOW_MS = Date.parse("2026-08-01T00:00:00.000Z");

function rankRequest(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    keyword: "온열찜질기",
    limit: 2,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: "2026-08-01T00:00:40.000Z",
    ...overrides,
  };
}

function validWindow(limit = 2) {
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    keyword: "온열찜질기",
    source: SOURCE,
    rankEvidence: RANK_EVIDENCE,
    collectionId: "fixture-collection-001",
    collectedAt: "2026-08-01T00:00:00.000Z",
    complete: true,
    partial: false,
    sourceExhausted: false,
    marketTotal: 320,
    marketTotalStatus: "verified",
    checkedCount: limit,
    rawCount: limit + 3,
    excludedAdCount: 3,
    items: Array.from({ length: limit }, (_, index) => ({
      organicRank: index + 1,
      isAd: false,
      isOrganic: true,
      productId: String(12000000000 + index),
      sellerProductId: String(5145848584 + index),
      title: `검증 상품 ${index + 1}`,
      link: `https://smartstore.naver.com/example/products/${5145848584 + index}`,
      mallName: "검증 판매처",
      productType: 1,
    })),
  };
}

function assertContractError(run, code, detail) {
  assert.throws(run, (error) => (
    error instanceof ContractError
    && error.code === code
    && (detail === undefined || error.detail === detail)
  ));
}

test("normalizes one bounded organic-rank request", () => {
  const request = validateRankRequest(rankRequest({
    keyword: " 온열찜질기 ",
    requestId: "worker:claim-001",
  }), { nowMs: NOW_MS });

  assert.deepEqual(request, {
    schemaVersion: SCHEMA_VERSION,
    keyword: "온열찜질기",
    limit: 2,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: "2026-08-01T00:00:40.000Z",
    requestId: "worker:claim-001",
  });
});

test("rejects unexpected, out-of-range, stale, and malformed request fields", () => {
  const cases = [
    [rankRequest({ start: 1 }), "unexpected:start"],
    [rankRequest({ limit: 301 }), "limit"],
    [rankRequest({ keyword: "가".repeat(101) }), "keyword"],
    [rankRequest({ deadlineAt: "2026-07-31T23:59:50.000Z" }), "deadlineAt"],
    [rankRequest({ requestId: "unsafe request id" }), "requestId"],
  ];

  for (const [input, detail] of cases) {
    assertContractError(
      () => validateRankRequest(input, { nowMs: NOW_MS }),
      "invalid_request",
      detail,
    );
  }
});

test("fails closed for incomplete, untrusted, advertised, and duplicate windows", () => {
  const request = validateRankRequest(rankRequest(), { nowMs: NOW_MS });
  const cases = [
    [{
      ...validWindow(),
      complete: false,
      partial: true,
      checkedCount: 1,
      items: [validWindow().items[0]],
    }, "invalid_provider_response", "completion"],
    [{ ...validWindow(), source: "legacy_search_api" }, "untrusted_provider_source", "source"],
    [{ ...validWindow(), rankEvidence: "mixed_search_block" }, "untrusted_provider_source", "rankEvidence"],
    [{
      ...validWindow(),
      items: [{ ...validWindow().items[0], isAd: true }, validWindow().items[1]],
    }, "provider_ad_item_rejected", "items.1"],
    [{
      ...validWindow(),
      items: [
        validWindow().items[0],
        { ...validWindow().items[1], productId: validWindow().items[0].productId },
      ],
    }, "invalid_provider_response", "duplicate_identity"],
  ];

  for (const [window, code, detail] of cases) {
    assertContractError(() => validateProviderWindow(window, request), code, detail);
  }
});

test("accepts a short complete window only with proven source exhaustion", () => {
  const request = validateRankRequest(rankRequest(), { nowMs: NOW_MS });
  const result = validateProviderWindow({
    ...validWindow(1),
    sourceExhausted: true,
    marketTotal: 1,
    rawCount: 4,
  }, request);

  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.sourceExhausted, true);
  assert.equal(result.checkedCount, 1);
});

test("keeps a complete rank window when the optional market total is unavailable", () => {
  const request = validateRankRequest(rankRequest(), { nowMs: NOW_MS });
  const result = validateProviderWindow({
    ...validWindow(),
    marketTotal: null,
    marketTotalStatus: "unavailable",
  }, request);

  assert.equal(result.complete, true);
  assert.equal(result.checkedCount, 2);
  assert.equal(result.marketTotal, null);
  assert.equal(result.marketTotalStatus, "unavailable");
});

test("keeps a catalog result and a seller result linked to that catalog distinct", () => {
  const sharedCatalogId = "71000000001";
  const request = validateRankRequest(rankRequest(), { nowMs: NOW_MS });
  const window = validWindow();
  window.items = [
    {
      organicRank: 1,
      isAd: false,
      isOrganic: true,
      productId: "91000000001",
      catalogId: sharedCatalogId,
      title: "검증 원부",
      productType: 1,
    },
    {
      organicRank: 2,
      isAd: false,
      isOrganic: true,
      productId: "91000000002",
      sellerProductId: "12000000002",
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      title: "검증 판매처 상품",
      link: "https://smartstore.naver.com/example/products/12000000002",
      productType: 3,
    },
  ];

  const result = validateProviderWindow(window, request);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].catalogId, sharedCatalogId);
  assert.equal(result.items[1].linkedCatalogId, sharedCatalogId);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS,
  signLocalWorkerRequest,
  verifyLocalWorkerSignature,
} from "../local-worker-auth.mjs";
import {
  LOCAL_WORKER_BODY_MAX_BYTES,
  LOCAL_WORKER_ORGANIC_LIMIT,
  localWorkerCollectionKey,
  localWorkerRankRequest,
  validateLocalWorkerJob,
  validateStrictLocalWorkerWindow,
} from "./local-worker-contract.mjs";
import {
  RANK_EVIDENCE,
  SCHEMA_VERSION,
  SOURCE,
  stableCollisionDigest,
  stableWindowDigest,
  validateProviderWindow,
  validateRankRequest,
} from "../../../tools/naver-shopping-rank-collector/src/contract.mjs";

const NOW = Date.parse("2026-08-01T06:00:00.000Z");
const TRACKER_ONE = "123e4567-e89b-42d3-a456-426614174000";
const TRACKER_TWO = "123e4567-e89b-42d3-a456-426614174001";

function job(overrides = {}) {
  return {
    keyword: "온열찜질기",
    limit: 300,
    claims: [{
      trackerId: TRACKER_ONE,
      leaseStartedAt: "2026-08-01T06:00:00.000Z",
      leaseUntil: "2026-08-01T06:12:00.000Z",
    }],
    ...overrides,
  };
}

function item(index) {
  return {
    organicRank: index,
    isOrganic: true,
    isAd: false,
    productId: String(1000000000 + index),
    sellerProductId: String(2000000000 + index),
    title: `온열찜질기 ${index}`,
    link: `https://smartstore.naver.com/example/products/${2000000000 + index}`,
    productType: "2",
  };
}

function windowFixture(overrides = {}) {
  const items = overrides.items || Array.from({ length: LOCAL_WORKER_ORGANIC_LIMIT }, (_, index) => item(index + 1));
  return {
    ok: true,
    schemaVersion: "mi.naver-shopping-organic-window.v1",
    keyword: "온열찜질기",
    source: "naver_shopping_results_collector",
    rankEvidence: "naver_shopping_organic_list",
    collectionId: "pw-1785564000000-fixture000000000001",
    collectedAt: "2026-08-01T06:00:00.000Z",
    complete: true,
    partial: false,
    sourceExhausted: false,
    marketTotal: null,
    marketTotalStatus: "unavailable",
    checkedCount: items.length,
    rawCount: items.length,
    excludedAdCount: 0,
    items,
    ...overrides,
  };
}

test("accepts only a 300-rank canonical keyword job with unique leases", () => {
  const normalized = validateLocalWorkerJob(job({
    claims: [
      job().claims[0],
      {
        trackerId: TRACKER_TWO,
        leaseStartedAt: "2026-08-01T06:00:00.000Z",
        leaseUntil: "2026-08-01T06:12:00.000Z",
      },
    ],
  }));
  assert.equal(normalized.limit, 300);
  assert.equal(normalized.claims.length, 2);
});

test("fits a contract-valid maximum 300 window and 100 claims inside the 4 MiB server bound", () => {
  const keyword = "용량검증";
  const request = validateRankRequest({
    schemaVersion: SCHEMA_VERSION,
    keyword,
    limit: 300,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: new Date(NOW + 60_000).toISOString(),
  }, { nowMs: NOW });
  const exactUrl = (prefix, length) => prefix + "a".repeat(length - prefix.length);
  const items = Array.from({ length: 300 }, (_, index) => {
    const id = `${String(index + 1).padStart(3, "0")}${"9".repeat(77)}`;
    return {
      organicRank: index + 1,
      isAd: false,
      isOrganic: true,
      productId: id,
      sellerProductId: id,
      catalogId: id,
      linkedCatalogId: id,
      title: "가".repeat(500),
      link: exactUrl(`https://example.com/p/${index}?q=`, 2048),
      image: exactUrl(`https://example.com/i/${index}?q=`, 2048),
      mallName: "나".repeat(200),
      brand: "다".repeat(200),
      maker: "라".repeat(200),
      category1: "마".repeat(200),
      category2: "바".repeat(200),
      category3: "사".repeat(200),
      category4: "아".repeat(200),
      productType: 2,
    };
  });
  const window = validateProviderWindow({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    keyword,
    source: SOURCE,
    rankEvidence: RANK_EVIDENCE,
    collectionId: "pw-chrome-max-payload-regression",
    collectedAt: new Date(NOW).toISOString(),
    complete: true,
    partial: false,
    sourceExhausted: false,
    marketTotal: 300,
    marketTotalStatus: "verified",
    checkedCount: 300,
    rawCount: 300,
    excludedAdCount: 0,
    items,
  }, request);
  const claims = Array.from({ length: 100 }, (_, index) => ({
    trackerId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    leaseStartedAt: new Date(NOW).toISOString(),
    leaseUntil: new Date(NOW + 12 * 60_000).toISOString(),
  }));
  const payload = {
    action: "submit",
    workerId: "windows-desktop-primary",
    laneToken: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    runtimeVersion: "1.1.8",
    runtimeFingerprint: "a".repeat(64),
    job: validateLocalWorkerJob({ keyword, limit: 300, claims }),
    window,
  };
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  assert.ok(bytes > 2 * 1024 * 1024);
  assert.ok(bytes <= LOCAL_WORKER_BODY_MAX_BYTES);
});

test("accepts one isolated lookup claim and rejects tracker-shaped lookup claims", () => {
  const lookup = validateLocalWorkerJob({
    kind: "lookup",
    keyword: "온열찜질기",
    limit: 300,
    claims: [{
      lookupJobId: TRACKER_ONE,
      leaseStartedAt: "2026-08-01T06:00:00.000Z",
      leaseUntil: "2026-08-01T06:12:00.000Z",
    }],
  });
  assert.equal(lookup.kind, "lookup");
  assert.equal(lookup.claims[0].lookupJobId, TRACKER_ONE);
  assert.equal(lookup.claims[0].trackerId, undefined);
  assert.throws(() => validateLocalWorkerJob({
    kind: "lookup",
    keyword: "온열찜질기",
    limit: 300,
    claims: [job().claims[0]],
  }), /local_worker_lease_invalid/);
});

test("rejects non-300 jobs, duplicate tracker claims and invalid leases", () => {
  assert.throws(() => validateLocalWorkerJob(job({ limit: 100 })), /local_worker_job_invalid/);
  assert.throws(() => validateLocalWorkerJob(job({ claims: [job().claims[0], job().claims[0]] })), /local_worker_lease_invalid/);
  assert.throws(() => validateLocalWorkerJob(job({ claims: [{ ...job().claims[0], leaseUntil: "2026-08-01T05:59:00.000Z" }] })), /local_worker_lease_invalid/);
  assert.throws(() => validateLocalWorkerJob(job(), {
    requireActiveLease: true,
    nowMs: Date.parse("2026-08-01T06:12:00.001Z"),
  }), /local_worker_lease_invalid/);
});

test("builds a strict organic-only 300 request", () => {
  assert.deepEqual(localWorkerRankRequest(job(), NOW, 90_000), {
    schemaVersion: "mi.naver-shopping-organic-window.v1",
    keyword: "온열찜질기",
    limit: 300,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: "2026-08-01T06:01:30.000Z",
  });
  assert.equal(
    localWorkerRankRequest(job(), NOW, 60 * 60_000).deadlineAt,
    "2026-08-01T06:14:00.000Z",
  );
});

test("keeps the default and oversized override below the collector deadline contract", () => {
  const defaultRequest = localWorkerRankRequest(job(), NOW);
  const oversizedRequest = localWorkerRankRequest(job(), NOW, 60 * 60_000);

  assert.equal(defaultRequest.deadlineAt, "2026-08-01T06:14:00.000Z");
  assert.equal(oversizedRequest.deadlineAt, defaultRequest.deadlineAt);
  assert.doesNotThrow(() => validateRankRequest(defaultRequest, {
    nowMs: NOW + 45_000,
  }));
});

test("accepts a fresh, complete and sequential 300-item organic window", () => {
  const result = validateStrictLocalWorkerWindow(windowFixture(), {
    keyword: "온열찜질기",
    nowMs: NOW,
  });
  assert.equal(result.checkedCount, 300);
  assert.equal(result.items[299].organicRank, 300);
});

test("uses the signed worker 300-second clock skew for future collection evidence", () => {
  assert.equal(LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS, 300);
  assert.doesNotThrow(() => validateStrictLocalWorkerWindow(windowFixture({
    collectedAt: new Date(NOW + LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS * 1000).toISOString(),
  }), { keyword: "온열찜질기", nowMs: NOW }));
  assert.throws(() => validateStrictLocalWorkerWindow(windowFixture({
    collectedAt: new Date(NOW + LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS * 1000 + 1).toISOString(),
  }), { keyword: "온열찜질기", nowMs: NOW }), /local_worker_window_stale/);
  assert.throws(() => validateStrictLocalWorkerWindow(windowFixture({
    collectedAt: new Date(NOW - 15 * 60_000 - 1).toISOString(),
  }), { keyword: "온열찜질기", nowMs: NOW }), /local_worker_window_stale/);
});

test("keeps same-page repeats and accepts cross-page repeats only with exact stable proof", () => {
  const samePageItems = Array.from({ length: 300 }, (_, index) => item(index + 1));
  samePageItems[1] = { ...samePageItems[1], sellerProductId: samePageItems[0].sellerProductId };
  assert.equal(validateStrictLocalWorkerWindow(windowFixture({ items: samePageItems }), {
    keyword: "온열찜질기", nowMs: NOW,
  }).items.length, 300);

  const crossPageItems = Array.from({ length: 300 }, (_, index) => item(index + 1));
  crossPageItems[40] = { ...crossPageItems[40], sellerProductId: crossPageItems[0].sellerProductId };
  assert.throws(() => validateStrictLocalWorkerWindow(windowFixture({ items: crossPageItems }), {
    keyword: "온열찜질기", nowMs: NOW,
  }));

  const stableItems = Array.from({ length: 300 }, (_, index) => ({
    ...item(index + 1),
    productType: 2,
  }));
  stableItems[40] = { ...stableItems[40], sellerProductId: stableItems[0].sellerProductId };
  assert.throws(() => validateStrictLocalWorkerWindow(windowFixture({ items: stableItems }), {
    keyword: "온열찜질기", nowMs: NOW,
  }));
  const passDigest = stableWindowDigest(stableItems, { keyword: "온열찜질기" });
  const crossPageProof = {
    version: "stable-full-window-v1",
    passCount: 2,
    pageCount: 8,
    pageSize: 40,
    captureIds: ["capture-pass-0001", "capture-pass-0002"],
    passDigests: [passDigest, passDigest],
    collisionDigest: stableCollisionDigest(stableItems),
  };
  assert.equal(validateStrictLocalWorkerWindow(windowFixture({
    items: stableItems,
    crossPageProof,
  }), { keyword: "온열찜질기", nowMs: NOW }).items.length, 300);

  for (const proofOverride of [
    { passDigests: [passDigest, "0".repeat(64)] },
    { collisionDigest: "0".repeat(64) },
    { captureIds: ["capture-pass-0001", "capture-pass-0001"] },
    { unexpected: true },
  ]) {
    assert.throws(() => validateStrictLocalWorkerWindow(windowFixture({
      items: stableItems,
      crossPageProof: { ...crossPageProof, ...proofOverride },
    }), { keyword: "온열찜질기", nowMs: NOW }));
  }

  const driftedItems = structuredClone(stableItems);
  driftedItems[299].linkedCatalogId = "99000000001";
  assert.throws(() => validateStrictLocalWorkerWindow(windowFixture({
    items: driftedItems,
    crossPageProof,
  }), { keyword: "온열찜질기", nowMs: NOW }));

  assert.throws(() => validateStrictLocalWorkerWindow(windowFixture({
    crossPageProof,
  }), { keyword: "온열찜질기", nowMs: NOW }));
});

test("signed submit evidence fails closed when a stable cross-page proof is tampered in transit", () => {
  const secret = "stable-proof-hmac-secret-with-at-least-32-bytes";
  const timestamp = String(Math.trunc(NOW / 1000));
  const base = {
    timestamp,
    nonce: "stable-proof-submit-0001",
    method: "POST",
    audience: "https://insight.momentlabs.co.kr",
    path: "/api/naver-shopping-local-worker",
    body: JSON.stringify({
      action: "submit",
      window: { crossPageProof: { collisionDigest: "a".repeat(64) } },
    }),
  };
  const signature = signLocalWorkerRequest(secret, base);
  const tampered = {
    ...base,
    signature,
    body: JSON.stringify({
      action: "submit",
      window: { crossPageProof: { collisionDigest: "b".repeat(64) } },
    }),
  };
  assert.equal(verifyLocalWorkerSignature(tampered, {
    nowSeconds: Number(timestamp),
    env: {
      MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
      MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET: secret,
    },
  }).code, "LOCAL_WORKER_SIGNATURE_INVALID");
});

test("rejects a source-exhausted short window even when the base collector marks it complete", () => {
  const items = Array.from({ length: 299 }, (_, index) => item(index + 1));
  assert.throws(() => validateStrictLocalWorkerWindow(windowFixture({
    items,
    checkedCount: 299,
    rawCount: 299,
    sourceExhausted: true,
  }), { keyword: "온열찜질기", nowMs: NOW }), /local_worker_window_not_300/);
});

test("rejects partial, advertised, duplicate, rank-gap, keyword and stale evidence", () => {
  const cases = [
    windowFixture({ complete: false, partial: true }),
    windowFixture({ items: [
      { ...item(1), isAd: true, isOrganic: false },
      ...Array.from({ length: 299 }, (_, index) => item(index + 2)),
    ] }),
    windowFixture({ items: [item(1), item(1), ...Array.from({ length: 298 }, (_, index) => item(index + 3))] }),
    windowFixture({ items: [item(1), { ...item(2), organicRank: 3 }, ...Array.from({ length: 298 }, (_, index) => item(index + 3))] }),
    windowFixture({ keyword: "다른 키워드" }),
  ];
  for (const candidate of cases) {
    assert.throws(() => validateStrictLocalWorkerWindow(candidate, {
      keyword: "온열찜질기",
      nowMs: NOW,
    }));
  }
  assert.throws(() => validateStrictLocalWorkerWindow(windowFixture({
    collectedAt: "2026-08-01T05:40:00.000Z",
  }), { keyword: "온열찜질기", nowMs: NOW }), /local_worker_window_stale/);
});

test("creates deterministic tracker plus collection idempotency keys", () => {
  const left = localWorkerCollectionKey(TRACKER_ONE, "pw-1785564000000-fixture000000000001");
  const right = localWorkerCollectionKey(TRACKER_ONE, "pw-1785564000000-fixture000000000001");
  const other = localWorkerCollectionKey(TRACKER_TWO, "pw-1785564000000-fixture000000000001");
  assert.equal(left, right);
  assert.notEqual(left, other);
  assert.match(left, /^[a-f0-9]{64}$/u);
});

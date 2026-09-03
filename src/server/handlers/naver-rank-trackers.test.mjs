import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildProductRankSnapshotRecord,
  claimDueTracker,
  clearKeywordVolumeCache,
  controlShoppingWorker,
  handleRankTrackersRequest,
  loadKeywordVolumes,
  loadShoppingWorkerOperations,
  loadShoppingWorkerStatus,
  loadSnapshots as loadProductSnapshots,
  requestAccessCode,
  requestAgencyCode,
  runDueTrackers,
  runTrackerCheck,
  selectRepresentativeTrackingRank,
  trackerPayload,
  verifiedRelatedCatalogIdFromSnapshots,
} from "./naver-rank-trackers.mjs";
import {
  hasShoppingRankConfig,
  isShoppingCollectorUnavailable,
  isShoppingRankSourceUnavailable,
  shoppingRankSourceStatus,
} from "../naver-shopping/source-status.mjs";
import shoppingRankHandler, {
  buildRankTarget,
  findShoppingRank,
  findShoppingRankFromWindow,
  isAdItem,
  matchTargetItem,
  NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
  shoppingProviderPageCache,
  trustedCollectorWindow,
} from "./naver-shopping-rank.mjs";
import {
  stableCollisionDigest,
  stableRenderedOrderWindowDigest,
  stableWindowDigest,
} from "../../../tools/naver-shopping-rank-collector/src/contract.mjs";

const TRACKERS = "naver_rank_trackers";
const SNAPSHOTS = "naver_rank_snapshots";
const LEGACY_ENV = {
  openapiClientId: "test-client-id",
  openapiClientSecret: "test-client-secret",
};
const COLLECTOR_ENV = {
  mode: "provider",
  providerUrl: "https://collector.example/rank",
  providerKey: "collector-key",
};

async function withoutShoppingCollector(callback) {
  const previousUrl = process.env.NAVER_SHOPPING_RANK_API_URL;
  const previousKey = process.env.NAVER_SHOPPING_RANK_API_KEY;
  const previousMode = process.env.NAVER_SHOPPING_RANK_MODE;
  delete process.env.NAVER_SHOPPING_RANK_API_URL;
  delete process.env.NAVER_SHOPPING_RANK_API_KEY;
  delete process.env.NAVER_SHOPPING_RANK_MODE;
  try {
    return await callback();
  } finally {
    if (previousUrl === undefined) delete process.env.NAVER_SHOPPING_RANK_API_URL;
    else process.env.NAVER_SHOPPING_RANK_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NAVER_SHOPPING_RANK_API_KEY;
    else process.env.NAVER_SHOPPING_RANK_API_KEY = previousKey;
    if (previousMode === undefined) delete process.env.NAVER_SHOPPING_RANK_MODE;
    else process.env.NAVER_SHOPPING_RANK_MODE = previousMode;
  }
}

async function withShoppingHybrid(callback) {
  const keys = [
    "NAVER_SHOPPING_RANK_MODE",
    "MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED",
    "MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NAVER_SHOPPING_RANK_MODE = "hybrid_local_worker";
  process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED = "true";
  process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET = "test-local-worker-secret-that-is-longer-than-32-bytes";
  try {
    return await callback();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("product-rank readiness accepts only the verified collector pair", () => {
  assert.equal(hasShoppingRankConfig(LEGACY_ENV), false);
  assert.equal(hasShoppingRankConfig({ mode: "provider", providerUrl: COLLECTOR_ENV.providerUrl }), false);
  assert.equal(hasShoppingRankConfig(COLLECTOR_ENV), true);
  assert.deepEqual(shoppingRankSourceStatus(LEGACY_ENV), {
    rankSourceReady: false,
    configured: false,
    mode: "",
    coverage: "none",
    fullCoverageReady: false,
    preserveOnMiss: false,
    localWorkerEnabled: false,
    localWorkerSecretReady: false,
    errorCode: "SHOPPING_RANK_SOURCE_NOT_CONFIGURED",
    retryable: false,
  });
});

test("product-rank status exposes a safe cooldown without worker identity", async () => {
  const status = await loadShoppingWorkerStatus({
    supabaseAdmin: {
      from(table) {
        assert.equal(table, "naver_shopping_worker_coordination");
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return {
              data: {
                lane_key: "global",
                primary_seen_at: "2026-08-10T07:00:00.000Z",
                lease_until: null,
                cooldown_until: "2026-08-10T08:00:00.000Z",
                last_block_code: "naver_network_restricted",
                updated_at: "2026-08-10T07:30:00.000Z",
              },
              error: null,
            };
          },
        };
        return query;
      },
    },
  }, Date.parse("2026-08-10T07:30:00.000Z"));

  assert.deepEqual(status, {
    state: "cooldown",
    retryAt: "2026-08-10T08:00:00.000Z",
    blockCode: "naver_network_restricted",
    preservesLastGood: true,
  });
  assert.equal("primaryWorkerId" in status, false);
  assert.equal("leaseWorkerId" in status, false);
});

test("product-rank status reduces an open circuit to a safe client summary", async () => {
  const status = await loadShoppingWorkerStatus({
    supabaseAdmin: {
      from(table) {
        assert.equal(table, "naver_shopping_worker_coordination");
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return {
              data: {
                lane_key: "global",
                circuit_state: "open",
                circuit_reason: "internal_failure_signature",
                primary_worker_id: "windows-primary-secret",
                lease_worker_id: "worker-secret",
                cooldown_until: "2099-08-10T08:00:00.000Z",
              },
              error: null,
            };
          },
        };
        return query;
      },
    },
  });

  assert.deepEqual(status, { state: "stopped", preservesLastGood: true });
  assert.equal("circuitReason" in status, false);
  assert.equal("primaryWorkerId" in status, false);
  assert.equal("leaseWorkerId" in status, false);
});

test("owner operations normalize control-plane evidence and derive release gates", async () => {
  const canaryTrackerId = "10000000-0000-4000-8000-000000000001";
  const operations = await loadShoppingWorkerOperations({
    supabaseAdmin: {
      async rpc(name) {
        assert.equal(name, "mi_get_naver_shopping_worker_operations");
        return {
          data: {
            circuit_state: "closed",
            primary_worker_id: "windows-primary",
            primary_seen_at: "2026-08-10T08:59:00.000Z",
            pending_count: 5,
            lookup_pending_count: 2,
            tracker_pending_count: 3,
            oldest_pending_at: "2026-08-10T08:40:00.000Z",
            runtime_version: "1.0.48",
            runtime_fingerprint: "sha256:test",
            current_stage: "collecting",
            current_page: 3,
            current_job_kind: "tracker",
            current_job_started_at: "2026-08-10T08:58:00.000Z",
            last_success_at: "2026-08-10T08:50:00.000Z",
            last_collection_id: "collection-1",
            last_checked_count: 300,
            last_excluded_ad_count: 42,
            last_duration_ms: 190000,
            last_source: "naver_shopping_results_collector",
            cadence_mode: "baseline",
            cadence_minutes: 10,
            stability_started_at: "2026-08-09T08:00:00.000Z",
            success_streak: 7,
            canary_tracker_id: canaryTrackerId,
          },
          error: null,
        };
      },
    },
  }, Date.parse("2026-08-10T09:00:00.000Z"));

  assert.equal(operations.available, true);
  assert.equal(operations.queue.pendingCount, 5);
  assert.equal(operations.progress.page, 3);
  assert.equal(operations.progress.totalPages, 8);
  assert.equal(operations.lastSuccess.checkedCount, 300);
  assert.equal(operations.cadence.candidateEligible, false);
  assert.equal(operations.controls.canActivateCandidate, false);
  assert.equal(operations.controls.canRunCanary, true);
  assert.equal(operations.controls.canaryTrackerId, canaryTrackerId);
  assert.deepEqual(operations.alerts.map((alert) => alert.code).sort(), ["queue_delayed", "runtime_mismatch"]);
});

test("worker operations stay unavailable instead of breaking the owner tracker list", async () => {
  const operations = await loadShoppingWorkerOperations({
    supabaseAdmin: {
      async rpc() {
        return { data: null, error: new Error("function unavailable") };
      },
    },
  });
  assert.equal(operations.available, false);
  assert.equal(operations.controls.canStop, false);
  assert.equal(operations.alerts[0].code, "operations_unavailable");
});

test("candidate readiness remains informational while activation stays canonical-only", async () => {
  const operations = await loadShoppingWorkerOperations({
    supabaseAdmin: {
      async rpc() {
        return {
          data: {
            circuit_state: "closed",
            runtime_version: "1.1.21",
            runtime_fingerprint: "a".repeat(64),
            last_checked_count: 300,
            last_source: "naver_shopping_results_collector",
            stability_started_at: "2026-08-09T08:00:00.000Z",
            success_streak: 6,
            candidate_eligible: true,
            cadence_mode: "baseline",
            cadence_minutes: 10,
          },
          error: null,
        };
      },
    },
  }, Date.parse("2026-08-10T09:00:00.000Z"));
  assert.equal(operations.cadence.candidateEligible, true);
  assert.equal(operations.controls.canActivateCandidate, false);
});

test("candidate cadence fails closed when database eligibility is missing or malformed", async () => {
  for (const candidateEligibility of [undefined, "true", 1, null]) {
    const operations = await loadShoppingWorkerOperations({
      supabaseAdmin: {
        async rpc() {
          return {
            data: {
              circuit_state: "closed",
              runtime_version: "1.1.21",
              runtime_fingerprint: "b".repeat(64),
              last_checked_count: 300,
              last_source: "naver_shopping_results_collector",
              stability_started_at: "2026-08-09T08:00:00.000Z",
              success_streak: 9,
              candidate_eligible: candidateEligibility,
              cadence_mode: "baseline",
              cadence_minutes: 10,
            },
            error: null,
          };
        },
      },
    }, Date.parse("2026-08-10T09:00:00.000Z"));
    assert.equal(operations.cadence.candidateEligible, false);
    assert.equal(operations.controls.canActivateCandidate, false);
  }
});

test("shopping worker controls are owner-only and use fixed RPC contracts", async () => {
  const request = new Request("https://example.com/api/naver-rank-trackers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  let rpcCalls = 0;
  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        rpcCalls += 1;
        assert.equal(name, "mi_stop_naver_shopping_worker");
        assert.deepEqual(args, { p_reason: "manual_stop" });
        return { data: { accepted: true, circuit_state: "open" }, error: null };
      },
    },
  };

  const denied = await controlShoppingWorker(request, ctx, { action: "worker-stop" }, {
    owner: false,
    agencyCode: "mml93-t01",
  });
  assert.equal(denied.status, 403);
  assert.equal(rpcCalls, 0);

  const allowed = await controlShoppingWorker(request, ctx, { action: "worker-stop", reason: "untrusted" }, {
    owner: true,
    agencyCode: "mml93-a01",
  });
  assert.equal(allowed.status, 200);
  assert.equal(rpcCalls, 1);
  assert.equal((await allowed.json()).result.state, "open");
});

test("owner canary and cadence controls fail closed on invalid or ineligible requests", async () => {
  const request = new Request("https://example.com/api/naver-rank-trackers", { method: "POST" });
  const canaryTrackerId = "10000000-0000-4000-8000-000000000001";
  const calls = [];
  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        calls.push([name, args]);
        if (name === "mi_request_naver_shopping_worker_probe") {
          return { data: { accepted: true, activated: true, circuit_state: "half_open" }, error: null };
        }
        if (name === "mi_request_naver_shopping_worker_wake") {
          assert.deepEqual(args, { p_source: "control-plane-canary" });
          return { data: true, error: null };
        }
        return { data: { activated: false, reason: "not_eligible", cadence_mode: "baseline", cadence_minutes: 10 }, error: null };
      },
    },
  };
  const access = { owner: true, agencyCode: "mml93-a01" };

  const invalid = await controlShoppingWorker(request, ctx, { action: "worker-canary", trackerId: "not-a-uuid" }, access);
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 0);

  const canary = await controlShoppingWorker(request, ctx, { action: "worker-canary", trackerId: canaryTrackerId }, access);
  assert.equal(canary.status, 200);
  assert.deepEqual(calls[0], ["mi_request_naver_shopping_worker_probe", { p_tracker_id: canaryTrackerId }]);
  assert.deepEqual(calls[1], ["mi_request_naver_shopping_worker_wake", { p_source: "control-plane-canary" }]);
  assert.equal((await canary.json()).remoteWakeRequested, true);

  const candidate = await controlShoppingWorker(request, ctx, { action: "worker-cadence", mode: "candidate" }, access);
  assert.equal(candidate.status, 409);
  assert.equal(calls.length, 2);
  const candidateBody = await candidate.json();
  assert.equal(candidateBody.ok, false);
  assert.equal(candidateBody.result.reason, "canonical_transition_required");
  assert.equal(candidateBody.result.activated, false);
  assert.match(candidateBody.message, /검증 전용 전환 절차/u);
});

test("owner API never invokes the candidate cadence RPC directly", async () => {
  const request = new Request("https://example.com/api/naver-rank-trackers", { method: "POST" });
  const access = { owner: true, agencyCode: "mml93-a01" };
  let rpcCalls = 0;
  const response = await controlShoppingWorker(request, {
    supabaseAdmin: {
      async rpc() {
        rpcCalls += 1;
        return { data: { accepted: true, activated: true, mode: "candidate", minutes: 6 }, error: null };
      },
    },
  }, { action: "worker-cadence", mode: "candidate" }, access);
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(rpcCalls, 0);
  assert.equal(body.ok, false);
  assert.deepEqual(body.result, {
    state: "",
    mode: "",
    minutes: null,
    reason: "canonical_transition_required",
    activated: false,
  });
  assert.match(body.message, /검증 전용 전환 절차/u);
});

test("baseline cadence reports success only for the exact activated 10-minute result", async () => {
  const request = new Request("https://example.com/api/naver-rank-trackers", { method: "POST" });
  const access = { owner: true, agencyCode: "mml93-a01" };
  const invoke = (rpcResult) => controlShoppingWorker(request, {
    supabaseAdmin: {
      async rpc(name, args) {
        assert.equal(name, "mi_set_naver_shopping_worker_cadence");
        assert.deepEqual(args, { p_mode: "baseline" });
        return { data: rpcResult, error: null };
      },
    },
  }, { action: "worker-cadence", mode: "baseline" }, access);

  const positive = await invoke({
    accepted: true,
    activated: true,
    mode: "baseline",
    minutes: 10,
  });
  const positiveBody = await positive.json();
  assert.equal(positive.status, 200);
  assert.equal(positiveBody.ok, true);
  assert.equal(positiveBody.result.mode, "baseline");
  assert.equal(positiveBody.result.minutes, 10);
  assert.equal(positiveBody.result.activated, true);

  const mismatchedResults = [
    { accepted: true, activated: true, mode: "candidate", minutes: 10 },
    { accepted: true, activated: true, mode: "baseline", minutes: 8 },
    { accepted: true, activated: true, cadence_mode: "baseline", cadence_minutes: 10 },
    { accepted: true, activated: true, mode: "baseline", minutes: "10" },
  ];
  for (const rpcResult of mismatchedResults) {
    const response = await invoke(rpcResult);
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.ok, false);
    assert.match(body.message, /운영 안전 조건/u);
    assert.equal(body.result.activated, false);
  }
});

test("a repeated canary rejection never sends another remote wake or reports success", async () => {
  const calls = [];
  const response = await controlShoppingWorker(
    new Request("https://example.com/api/naver-rank-trackers", { method: "POST" }),
    {
      supabaseAdmin: {
        async rpc(name, args) {
          calls.push([name, args]);
          return { data: { accepted: false, reason: "probe_active", state: "half_open" }, error: null };
        },
      },
    },
    { action: "worker-canary", trackerId: "10000000-0000-4000-8000-000000000001" },
    { owner: true, agencyCode: "mml93-a01" },
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.ok, false);
  assert.match(body.message, /추가 검증은 시작하지 않았습니다/u);
  assert.equal(body.remoteWakeRequested, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "mi_request_naver_shopping_worker_probe");
});

test("malformed worker control RPC results fail closed without a remote wake", async () => {
  const malformedResults = [null, {}, { accepted: null }, { accepted: true }];
  for (const malformed of malformedResults) {
    const calls = [];
    const response = await controlShoppingWorker(
      new Request("https://example.com/api/naver-rank-trackers", { method: "POST" }),
      {
        supabaseAdmin: {
          async rpc(name) {
            calls.push(name);
            return { data: malformed, error: null };
          },
        },
      },
      { action: "worker-canary", trackerId: "10000000-0000-4000-8000-000000000001" },
      { owner: true, agencyCode: "mml93-a01" },
    );
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.result.activated, false);
    assert.equal(body.remoteWakeRequested, false);
    assert.deepEqual(calls, ["mi_request_naver_shopping_worker_probe"]);
  }
});

test("owner operations UI exists only on the admin surface while clients keep the safe summary", async () => {
  const [adminSource, clientSource] = await Promise.all([
    readFile(new URL("../../pages/admin.html", import.meta.url), "utf8"),
    readFile(new URL("../../pages/client.html", import.meta.url), "utf8"),
  ]);
  for (const marker of [
    "data-rank-worker-operations",
    "N 쇼핑 수집 운영센터",
    "data-rank-worker-stop",
    "data-rank-worker-canary",
    "data-rank-worker-candidate",
    "data-rank-worker-baseline",
    "workerOperations",
  ]) {
    assert.match(adminSource, new RegExp(marker), `admin owner operations marker: ${marker}`);
    assert.doesNotMatch(clientSource, new RegExp(marker), `client must not expose owner operations marker: ${marker}`);
  }
  for (const safeMarker of ["안전 정지", "1건 검증", "기존 정상 순위와 30일 기록 보존"]) {
    assert.match(adminSource, new RegExp(safeMarker));
    assert.match(clientSource, new RegExp(safeMarker));
  }
  assert.match(adminSource, /candidateDisabled\s*=\s*controls\.canActivateCandidate\s*===\s*true\s*\?\s*""\s*:\s*" disabled"/);
  assert.match(adminSource, /data-rank-worker-candidate['"]\s*\+\s*candidateDisabled/);
  assert.match(adminSource, />테스트 1건 검증<\/button>/);
  assert.doesNotMatch(adminSource, />남자팬티 1건 검증<\/button>/);
});

test("seller product URLs cannot be poisoned into catalog mode by query parameters", () => {
  const target = buildRankTarget({
    targetProductId: "12149720593",
    targetUrl: "https://smartstore.naver.com/haedenprime/products/12149720593?catalogId=59031763223",
  });
  assert.equal(target.targetMode, "product");
  assert.equal(target.catalogIds.length, 0);
  assert.deepEqual(target.productIds, ["12149720593"]);
});

test("canonical product paths ignore conflicting product query identifiers", () => {
  const target = buildRankTarget({
    targetUrl: "https://smartstore.naver.com/haedenprime/products/12149720593?nvMid=59031763223&productId=77777777777",
  });
  assert.deepEqual(target.productIds, ["12149720593"]);
  assert.equal(target.catalogIds.length, 0);
  assert.equal(target.targetMode, "product");
});

test("non-Naver catalog URLs cannot poison exact catalog matching", () => {
  const target = buildRankTarget({
    targetProductId: "12149720593",
    targetUrl: "https://evil.example/catalog/59031763223",
  });
  assert.equal(target.catalogIds.includes("59031763223"), false);
  assert.equal(target.targetMode, "product");
});

test("mall and title similarity never create a shopping-rank target", () => {
  const target = buildRankTarget({
    targetMallName: "동일 판매처",
    targetProductTitle: "완전히 동일한 온열찜질기 상품명",
  });
  const matched = matchTargetItem({
    sellerProductId: "99999999999",
    link: "https://smartstore.naver.com/example/products/99999999999",
    mallName: "동일 판매처",
    title: "완전히 동일한 온열찜질기 상품명",
    productType: "2",
  }, target);

  assert.equal(target.hasDirectTarget, false);
  assert.deepEqual(target.productIds, []);
  assert.deepEqual(target.urlKeys, []);
  assert.equal(matched.matched, false);
  assert.equal(matched.matchType, "");
});

test("a wrong seller id never matches even when mall and title are identical", () => {
  const target = buildRankTarget({
    targetProductId: "12149720593",
    targetMallName: "동일 판매처",
    targetProductTitle: "완전히 동일한 온열찜질기 상품명",
  });
  const matched = matchTargetItem({
    sellerProductId: "99999999999",
    link: "https://smartstore.naver.com/example/products/99999999999",
    mallName: "동일 판매처",
    title: "완전히 동일한 온열찜질기 상품명",
    productType: "2",
  }, target);

  assert.equal(target.hasDirectTarget, true);
  assert.equal(matched.matched, false);
});

test("canonical URL equality cannot override a different seller id", () => {
  const target = buildRankTarget({
    targetProductId: "12149720593",
    targetUrl: "https://merchant.example/items/shared",
  });
  const matched = matchTargetItem({
    sellerProductId: "99999999999",
    link: "https://merchant.example/items/shared",
    title: "동일 상품명",
    mallName: "동일 판매처",
    productType: "2",
  }, target);

  assert.equal(target.hasDirectTarget, true);
  assert.equal(matched.matched, false);
});

test("conflicting explicit and trusted URL product ids fail closed", () => {
  const target = buildRankTarget({
    targetProductId: "12149720593",
    targetUrl: "https://smartstore.naver.com/example/products/99999999999",
  });
  const matched = matchTargetItem({
    sellerProductId: "99999999999",
    link: "https://smartstore.naver.com/example/products/99999999999",
    productType: "2",
  }, target);

  assert.equal(target.identityConflict, true);
  assert.equal(target.hasDirectTarget, false);
  assert.deepEqual(target.productIds, []);
  assert.equal(matched.matched, false);
});

test("a trusted Naver product URL alone still matches its exact seller id", () => {
  const target = buildRankTarget({
    targetUrl: "https://smartstore.naver.com/example/products/12149720593",
  });
  const matched = matchTargetItem({
    sellerProductId: "12149720593",
    link: "https://smartstore.naver.com/example/products/12149720593",
    productType: "2",
  }, target);

  assert.equal(target.identityConflict, false);
  assert.deepEqual(target.productIds, ["12149720593"]);
  assert.equal(matched.matched, true);
  assert.equal(matched.matchEvidence, "seller_link_product_id");
});

test("direct GET and the central window matcher reject weak or conflicting identity before collection", async () => {
  const previousMode = process.env.NAVER_SHOPPING_RANK_MODE;
  const previousUrl = process.env.NAVER_SHOPPING_RANK_API_URL;
  const previousKey = process.env.NAVER_SHOPPING_RANK_API_KEY;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  process.env.NAVER_SHOPPING_RANK_MODE = "provider";
  process.env.NAVER_SHOPPING_RANK_API_URL = "https://collector.example/rank";
  process.env.NAVER_SHOPPING_RANK_API_KEY = "collector-key";
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("provider_must_not_run");
  };

  try {
    for (const query of [
      "keyword=%EC%98%A8%EC%97%B4%EC%B0%9C%EC%A7%88%EA%B8%B0&mallName=%EB%8F%99%EC%9D%BC%EB%AA%B0&productTitle=%EB%8F%99%EC%9D%BC%EC%83%81%ED%92%88",
      "keyword=%EC%98%A8%EC%97%B4%EC%B0%9C%EC%A7%88%EA%B8%B0&productId=12149720593&targetUrl=https%3A%2F%2Fsmartstore.naver.com%2Fexample%2Fproducts%2F99999999999",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await shoppingRankHandler.fetch(new Request(`https://example.com/api/naver-shopping-rank?${query}`));
      // eslint-disable-next-line no-await-in-loop
      const payload = await response.json();
      assert.equal(response.status, 400);
      assert.equal(payload.ok, false);
    }
    assert.equal(providerCalls, 0);

    for (const options of [
      {
        keyword: "온열찜질기",
        targetMallName: "동일몰",
        targetProductTitle: "동일상품",
        skipTargetMetadata: true,
      },
      {
        keyword: "온열찜질기",
        targetProductId: "12149720593",
        targetUrl: "https://smartstore.naver.com/example/products/99999999999",
        skipTargetMetadata: true,
      },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        findShoppingRankFromWindow({}, options),
        (error) => error?.code === "SHOPPING_RANK_TARGET_IDENTITY_INVALID" && error?.status === 400,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMode === undefined) delete process.env.NAVER_SHOPPING_RANK_MODE;
    else process.env.NAVER_SHOPPING_RANK_MODE = previousMode;
    if (previousUrl === undefined) delete process.env.NAVER_SHOPPING_RANK_API_URL;
    else process.env.NAVER_SHOPPING_RANK_API_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NAVER_SHOPPING_RANK_API_KEY;
    else process.env.NAVER_SHOPPING_RANK_API_KEY = previousKey;
  }
});

test("URL-only seller and catalog targets keep exact matching compatibility", async () => {
  const sellerProductId = "12149720593";
  const catalogId = "59031763223";
  const window = collectorWindow("온열찜질기", [
    shoppingResultItem(0, {
      sellerProductId,
      link: `https://smartstore.naver.com/example/products/${sellerProductId}`,
      productType: "2",
    }),
    shoppingResultItem(1, {
      productId: catalogId,
      catalogId,
      link: `https://search.shopping.naver.com/catalog/${catalogId}`,
      productType: "1",
    }),
  ], { limit: 2 });

  const seller = await findShoppingRankFromWindow(window, {
    keyword: "온열찜질기",
    targetUrl: `https://smartstore.naver.com/example/products/${sellerProductId}`,
    maxRank: 2,
    skipTargetMetadata: true,
  });
  const catalog = await findShoppingRankFromWindow(window, {
    keyword: "온열찜질기",
    targetUrl: `https://search.shopping.naver.com/catalog/${catalogId}`,
    maxRank: 2,
    skipTargetMetadata: true,
  });

  assert.equal(seller.matched, true);
  assert.equal(seller.rank, 1);
  assert.equal(seller.matchEvidence, "seller_link_product_id");
  assert.equal(catalog.matched, true);
  assert.equal(catalog.rank, 2);
  assert.equal(catalog.matchEvidence, "catalog_id");
});

test("trusted product-rank headers override conflicting body scope", () => {
  const request = new Request("https://example.com/api/naver-rank-trackers?agencyCode=mml93-a98", {
    headers: {
      "x-mi-agency-code": "mml93-a02",
      "x-mi-rank-access-code": "mml93-a02",
    },
  });
  const body = { agencyCode: "mml93-a99", accessCode: "mml93-a99" };
  assert.equal(requestAgencyCode(request, body), "mml93-a02");
  assert.equal(requestAccessCode(request, body), "mml93-a02");
});

test("a code-session request never falls back to body or query credentials", () => {
  const request = new Request("https://example.com/api/naver-rank-trackers?agencyCode=mml93-a98", {
    headers: { "x-mi-session-role": "team", "x-mi-session-scope": "account-only" },
  });
  const body = { agencyCode: "mml93-a99", accessCode: "mml93-a99" };
  assert.equal(requestAgencyCode(request, body), "");
  assert.equal(requestAccessCode(request, body), "");
});

test("an account-only team lists an isolated product-rank scope without a client row", async () => {
  const teamCode = "mml93-t01";
  const request = new Request("https://example.com/api/naver-rank-trackers", {
    headers: {
      "x-mi-session-role": "team",
      "x-mi-session-scope": "account-only",
      "x-mi-team-code": teamCode,
      "x-mi-agency-code": teamCode,
      "x-mi-rank-access-code": teamCode,
    },
  });
  const ctx = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, TRACKERS);
        const query = {
          select() { return query; },
          in(column, values) {
            assert.equal(column, "agency_code");
            assert.deepEqual(values, [teamCode]);
            return query;
          },
          order() { return query; },
          limit() { return query; },
          then(resolve, reject) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };
  const response = await withoutShoppingCollector(() => handleRankTrackersRequest(request, ctx));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.scopeAgencyCode, teamCode);
  assert.equal(body.scopeClientId, "");
  assert.equal(body.scopeMode, "team-account");
  assert.equal(body.returnedCount, 0);
  assert.equal(body.complete, true);
  assert.equal(body.rankSourceReady, false);
  assert.equal(body.configured, false);
  assert.equal(body.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(body.retryable, false);
  assert.deepEqual(body.workerStatus, { state: "unknown" });
  assert.equal("workerOperations" in body, false);
});

test("only a primary owner list receives worker operations", async () => {
  const previousAdminCode = process.env.MI_RANK_ADMIN_CODE;
  process.env.MI_RANK_ADMIN_CODE = "owner-test-code";
  try {
    const request = new Request("https://example.com/api/naver-rank-trackers", {
      headers: {
        "x-demo-admin-code": "owner-test-code",
        "x-mi-agency-code": "mml93-a01",
      },
    });
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          assert.equal(name, "mi_get_naver_shopping_worker_operations");
          return { data: { circuit_state: "closed", cadence_mode: "baseline", cadence_minutes: 10 }, error: null };
        },
        from(table) {
          if (table === "naver_shopping_worker_coordination") {
            const query = {
              select() { return query; },
              eq() { return query; },
              async maybeSingle() {
                return { data: { lane_key: "global", circuit_state: "closed" }, error: null };
              },
            };
            return query;
          }
          assert.equal(table, TRACKERS);
          const query = {
            select() { return query; },
            in() { return query; },
            order() { return query; },
            limit() { return query; },
            then(resolve, reject) {
              return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
            },
          };
          return query;
        },
      },
    };
    const response = await withoutShoppingCollector(() => handleRankTrackersRequest(request, ctx));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.scopeMode, "owner");
    assert.equal(body.workerOperations.available, true);
    assert.equal(body.workerOperations.circuit.state, "closed");
  } finally {
    if (previousAdminCode === undefined) delete process.env.MI_RANK_ADMIN_CODE;
    else process.env.MI_RANK_ADMIN_CODE = previousAdminCode;
  }
});

function productOwnerSessionRequest(method, body, options = {}) {
  const headers = {
    "content-type": "application/json",
    "x-mi-session-role": options.role || "owner",
    "x-mi-session-scope": "advertiser",
    "x-demo-admin-code": "owner-test-code",
  };
  if (options.ownerAgencyCode !== null) {
    headers["x-mi-owner-agency-code"] = options.ownerAgencyCode || "mml93-a01";
  }
  const targetCode = "agencyCode" in options ? options.agencyCode : "owner-session";
  if (targetCode) headers["x-mi-agency-code"] = targetCode;
  return new Request("https://example.com/api/naver-rank-trackers", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function productOwnerListContext(scopes = []) {
  return {
    supabaseAdmin: {
      async rpc() {
        return { data: { circuit_state: "closed", cadence_mode: "baseline", cadence_minutes: 10 }, error: null };
      },
      from(table) {
        if (table === "naver_shopping_worker_coordination") {
          const query = {
            select() { return query; },
            eq() { return query; },
            async maybeSingle() {
              return { data: { lane_key: "global", circuit_state: "closed" }, error: null };
            },
          };
          return query;
        }
        if (table === "clients") {
          const query = {
            select() { return query; },
            eq() { return query; },
            async maybeSingle() { return { data: null, error: null }; },
          };
          return query;
        }
        assert.equal(table, TRACKERS);
        const query = {
          select() { return query; },
          in(column, values) {
            assert.equal(column, "agency_code");
            scopes.push([...values]);
            return query;
          },
          order() { return query; },
          limit() { return query; },
          then(resolve, reject) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };
}

async function withOwnerRankEnv(callback) {
  const previousAdminCode = process.env.MI_RANK_ADMIN_CODE;
  const previousPrimary = process.env.MI_PRIMARY_AGENCY_CODE;
  process.env.MI_RANK_ADMIN_CODE = "owner-test-code";
  process.env.MI_PRIMARY_AGENCY_CODE = "mml93-a01";
  try {
    return await callback();
  } finally {
    if (previousAdminCode === undefined) delete process.env.MI_RANK_ADMIN_CODE;
    else process.env.MI_RANK_ADMIN_CODE = previousAdminCode;
    if (previousPrimary === undefined) delete process.env.MI_PRIMARY_AGENCY_CODE;
    else process.env.MI_PRIMARY_AGENCY_CODE = previousPrimary;
  }
}

test("총관리자 세션의 내부 범위 자리표시자는 대표 대행사 상품 순위 목록으로 열린다", async () => {
  await withOwnerRankEnv(async () => {
    for (const agencyCode of ["owner-session", "session", ""]) {
      const label = agencyCode || "(empty)";
      const scopes = [];
      const ctx = productOwnerListContext(scopes);
      const response = await withoutShoppingCollector(() => handleRankTrackersRequest(
        productOwnerSessionRequest("GET", null, { agencyCode }),
        ctx,
      ));
      const body = await response.json();
      assert.equal(response.status, 200, `${label} must list`);
      assert.equal(body.scopeMode, "owner", `${label} scope mode`);
      assert.equal(body.scopeAgencyCode, "mml93-a01", `${label} scope agency code`);
      assert.equal(body.scopeKey, "mml93-a01", `${label} scope key`);
      assert.equal(body.scopeClientId, "", `${label} scope client id`);
      assert.deepEqual(scopes, [["mml93-a01"]], `${label} query scope`);
    }
  });
});

test("총관리자 표식이 없는 세션은 같은 자리표시자를 보내도 상품 순위에서 막힌다", async () => {
  await withOwnerRankEnv(async () => {
    const rejected = [
      ["team", new Request("https://example.com/api/naver-rank-trackers", {
        headers: {
          "x-mi-session-role": "team",
          "x-mi-session-scope": "account-only",
          "x-mi-team-code": "mml93-t01",
          "x-mi-agency-code": "owner-session",
          "x-mi-rank-access-code": "mml93-t01",
        },
      })],
      ["client", new Request("https://example.com/api/naver-rank-trackers", {
        headers: {
          "x-mi-session-role": "client",
          "x-mi-session-scope": "advertiser",
          "x-mi-agency-code": "owner-session",
          "x-mi-rank-access-code": "owner-session",
        },
      })],
      ["owner-role-without-marker", productOwnerSessionRequest("GET", null, { ownerAgencyCode: null })],
      ["owner-marker-mismatch", productOwnerSessionRequest("GET", null, { ownerAgencyCode: "attacker-a01" })],
    ];
    for (const [label, request] of rejected) {
      const response = await withoutShoppingCollector(() => handleRankTrackersRequest(
        request,
        productOwnerListContext(),
      ));
      const body = await response.json();
      assert.equal(response.status, 403, `${label} must stay rejected`);
      assert.equal(body.ok, false, `${label} payload`);
      assert.equal(body.message, "등록된 대행사 코드를 확인할 수 없습니다.", `${label} message`);
    }
  });
});

test("총관리자 자리표시자 번역은 총관리자 세션에서만 일어난다", async () => {
  await withOwnerRankEnv(() => {
    assert.equal(requestAgencyCode(productOwnerSessionRequest("GET", null, { agencyCode: "owner-session" })), "mml93-a01");
    assert.equal(requestAgencyCode(productOwnerSessionRequest("GET", null, { agencyCode: "" })), "mml93-a01");
    assert.equal(requestAgencyCode(productOwnerSessionRequest("GET", null, { agencyCode: "ishell" })), "ishell");
    assert.equal(requestAgencyCode(productOwnerSessionRequest("GET", null, { ownerAgencyCode: null })), "owner-session");
    const teamRequest = new Request("https://example.com/api/naver-rank-trackers", {
      headers: {
        "x-mi-session-role": "team",
        "x-mi-session-scope": "account-only",
        "x-mi-team-code": "mml93-t01",
        "x-mi-agency-code": "owner-session",
      },
    });
    assert.equal(requestAgencyCode(teamRequest), "owner-session");
  });
});

function productTeamAccountRequest(method, body, teamCode = "mml93-t01") {
  return new Request("https://example.com/api/naver-rank-trackers", {
    method,
    headers: {
      "content-type": "application/json",
      "x-mi-session-role": "team",
      "x-mi-session-scope": "account-only",
      "x-mi-team-code": teamCode,
      "x-mi-agency-code": teamCode,
      "x-mi-rank-access-code": teamCode,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("new shopping trackers require an authoritative numeric product identity", async () => {
  const guardedContext = {
    supabaseAdmin: {
      from() {
        throw new Error("registration must fail before database access");
      },
    },
  };
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", {
      action: "create",
      keyword: "온열찜질기",
      mallName: "동일 판매처",
      productTitle: "완전히 동일한 온열찜질기 상품명",
    }),
    guardedContext,
  ));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.message, "네이버 상품 URL 또는 숫자 상품ID를 입력해주세요.");

  const conflictResponse = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", {
      action: "create",
      keyword: "온열찜질기",
      productId: "12149720593",
      productUrl: "https://smartstore.naver.com/example/products/99999999999",
    }),
    guardedContext,
  ));
  const conflictBody = await conflictResponse.json();
  assert.equal(conflictResponse.status, 400);
  assert.equal(conflictBody.ok, false);
});

test("an account-only team reaches every product-rank action without advertiser scope", async () => {
  const forbiddenDb = {
    supabaseAdmin: {
      from() {
        throw new Error("action validation must run before database access");
      },
    },
  };
  for (const action of ["create", "check", "stop", "delete", "group", "move", "reorder"]) {
    const response = await handleRankTrackersRequest(productTeamAccountRequest("POST", { action }), forbiddenDb);
    assert.equal(response.status, 400, `${action} must reach its action validation`);
    const body = await response.json();
    assert.equal(body.ok, false, `${action} validation payload`);
    assert.notEqual(body.message, "등록된 대행사 코드를 확인할 수 없습니다.", `${action} must not require an advertiser`);
  }

  const emptyDueContext = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, TRACKERS);
        const query = {
          select() { return query; },
          eq() { return query; },
          lte() { return query; },
          or() { return query; },
          order() { return query; },
          limit() { return query; },
          in() { return query; },
          then(resolve, reject) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };
  const syncResponse = await withoutShoppingCollector(() => handleRankTrackersRequest(productTeamAccountRequest("POST", {
    action: "sync-due",
    limit: 1,
  }), emptyDueContext));
  const syncBody = await syncResponse.json();
  assert.equal(syncResponse.status, 503);
  assert.equal(syncBody.ok, false);
  assert.equal(syncBody.configured, false);
  assert.equal(syncBody.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(syncBody.retryable, false);
  assert.equal(syncBody.summary.checked, 0);
});

test("hybrid page sync leaves due rows queued for the signed Mac worker", async () => {
  const teamCode = "mml93-t01";
  let updateCalled = false;
  const wakeSources = [];
  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        assert.equal(name, "mi_request_naver_shopping_worker_wake");
        wakeSources.push(args.p_source);
        return { data: true, error: null };
      },
      from(table) {
        assert.equal(table, TRACKERS);
        const query = {
          select() { return query; },
          eq() { return query; },
          lte() { return query; },
          or() { return query; },
          in(column, values) {
            assert.equal(column, "agency_code");
            assert.deepEqual(values, [teamCode]);
            return query;
          },
          update() {
            updateCalled = true;
            return query;
          },
          then(resolve, reject) {
            return Promise.resolve({ data: null, error: null, count: 2 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };

  const response = await withShoppingHybrid(() => handleRankTrackersRequest(productTeamAccountRequest("POST", {
    action: "sync-due",
    limit: 2,
  }, teamCode), ctx));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.queuedForLocalWorker, true);
  assert.equal(body.remoteWakeRequested, true);
  assert.equal(body.summary.checked, 0);
  assert.equal(body.summary.remaining, 2);
  assert.match(body.message, /중앙 Chrome 300위 갱신 대기 2건/u);
  assert.equal(updateCalled, false);
  assert.deepEqual(wakeSources, ["tracker-sync-due"]);
});

test("hybrid full refresh is account-scoped, wake-only, and preserves cycle state on repeated clicks", async () => {
  const teamCode = "mml93-t01";
  const now = Date.now();
  const trackers = [
    trackerRow({
      id: "10000000-0000-4000-8000-000000000001",
      agency_code: teamCode,
      next_check_at: new Date(now + 6 * 60 * 60_000).toISOString(),
      worker_quarantined_until: null,
    }),
    trackerRow({
      id: "10000000-0000-4000-8000-000000000002",
      agency_code: teamCode,
      next_check_at: new Date(now - 60_000).toISOString(),
      worker_quarantined_until: new Date(now + 12 * 60 * 60_000).toISOString(),
    }),
    trackerRow({
      id: "10000000-0000-4000-8000-000000000003",
      agency_code: teamCode,
      next_check_at: new Date(now - 60_000).toISOString(),
      processing_started_at: new Date(now - 60_000).toISOString(),
      processing_until: new Date(now + 30 * 60_000).toISOString(),
    }),
    trackerRow({
      id: "10000000-0000-4000-8000-000000000004",
      agency_code: "outside-tenant",
    }),
  ];
  const before = structuredClone(trackers);
  const calls = [];
  const wakeSources = [];
  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        assert.equal(name, "mi_request_naver_shopping_worker_wake");
        wakeSources.push(args.p_source);
        return { data: true, error: null };
      },
      from(table) {
        assert.equal(table, TRACKERS);
        const call = { filters: [] };
        calls.push(call);
        const query = {
          select() { return query; },
          update() { throw new Error("refresh_all_must_not_update_trackers"); },
          eq(column, value) {
            call.filters.push(["eq", column, value]);
            return query;
          },
          in(column, values) {
            call.filters.push(["in", column, values]);
            return query;
          },
          then(resolve, reject) {
            const scope = call.filters.find((filter) => filter[0] === "in")?.[2] || [];
            const status = call.filters.find((filter) => filter[1] === "status")?.[2];
            const data = trackers.filter((tracker) => (
              scope.includes(tracker.agency_code) && tracker.status === status
            ));
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };

  const [firstResponse, secondResponse] = await withShoppingHybrid(async () => {
    const first = await handleRankTrackersRequest(productTeamAccountRequest("POST", {
      action: "queue-refresh-all",
    }, teamCode), ctx);
    const second = await handleRankTrackersRequest(productTeamAccountRequest("POST", {
      action: "queue-refresh-all",
    }, teamCode), ctx);
    return [first, second];
  });
  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(firstBody.ok, true);
  assert.equal(secondBody.ok, true);
  assert.equal(firstBody.remoteWakeRequested, true);
  assert.equal(secondBody.remoteWakeRequested, true);
  assert.deepEqual(firstBody.summary, {
    total: 3, queued: 0, alreadyQueued: 2, alreadyProcessing: 1,
  });
  assert.deepEqual(secondBody.summary, {
    total: 3, queued: 0, alreadyQueued: 2, alreadyProcessing: 1,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(wakeSources, ["tracker-refresh-all", "tracker-refresh-all"]);
  for (const call of calls) {
    assert.deepEqual(call.filters.find((filter) => filter[0] === "in"), ["in", "agency_code", [teamCode]]);
    assert.deepEqual(call.filters.find((filter) => filter[1] === "status"), ["eq", "status", "active"]);
  }
  assert.deepEqual(trackers, before);
});

test("wake-only full refresh keeps owner, operator, and client tenant scopes isolated", async () => {
  const previousAdminCode = process.env.MI_RANK_ADMIN_CODE;
  const previousLegacyCodes = process.env.MI_LEGACY_AGENCY_CODES;
  process.env.MI_RANK_ADMIN_CODE = "owner-wake-only-code";
  process.env.MI_LEGACY_AGENCY_CODES = "";
  const cases = [
    {
      label: "owner",
      agencyCode: "mml93-a01",
      request: () => new Request("https://example.com/api/naver-rank-trackers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-admin-code": "owner-wake-only-code",
          "x-mi-agency-code": "mml93-a01",
        },
        body: JSON.stringify({ action: "queue-refresh-all" }),
      }),
    },
    {
      label: "operator",
      agencyCode: "mml93-t01",
      request: () => productTeamAccountRequest("POST", { action: "queue-refresh-all" }, "mml93-t01"),
    },
    {
      label: "client",
      agencyCode: "client-a01",
      request: () => new Request("https://example.com/api/naver-rank-trackers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mi-session-role": "client",
          "x-mi-agency-code": "client-a01",
          "x-mi-rank-access-code": "client-a01",
        },
        body: JSON.stringify({ action: "queue-refresh-all" }),
      }),
    },
  ];

  try {
    for (const item of cases) {
      const seenScopes = [];
      const wakeSources = [];
      const rows = [
        trackerRow({ id: `${item.label}-owned`, agency_code: item.agencyCode }),
        trackerRow({ id: `${item.label}-outside`, agency_code: "outside-tenant" }),
      ];
      const ctx = {
        supabaseAdmin: {
          async rpc(name, args) {
            assert.equal(name, "mi_request_naver_shopping_worker_wake", item.label);
            wakeSources.push(args.p_source);
            return { data: true, error: null };
          },
          from(table) {
            if (table === "clients") {
              const query = {
                select() { return query; },
                eq() { return query; },
                async maybeSingle() {
                  return item.label === "client"
                    ? { data: { id: "client-row", status: "active", disconnected_at: null }, error: null }
                    : { data: null, error: null };
                },
              };
              return query;
            }
            assert.equal(table, TRACKERS, item.label);
            const query = {
              status: "",
              scope: [],
              select() { return query; },
              update() { throw new Error(`${item.label}_refresh_must_not_update`); },
              eq(column, value) {
                if (column === "status") query.status = value;
                return query;
              },
              in(column, values) {
                assert.equal(column, "agency_code", item.label);
                query.scope = values;
                seenScopes.push([...values]);
                return query;
              },
              then(resolve, reject) {
                const data = rows.filter((row) => query.scope.includes(row.agency_code) && row.status === query.status);
                return Promise.resolve({ data, error: null }).then(resolve, reject);
              },
            };
            return query;
          },
        },
      };
      const response = await withShoppingHybrid(() => handleRankTrackersRequest(item.request(), ctx));
      const body = await response.json();
      assert.equal(response.status, 200, item.label);
      assert.equal(body.summary.total, 1, item.label);
      assert.deepEqual(seenScopes, [[item.agencyCode]], item.label);
      assert.deepEqual(wakeSources, ["tracker-refresh-all"], item.label);
    }
  } finally {
    if (previousAdminCode === undefined) delete process.env.MI_RANK_ADMIN_CODE;
    else process.env.MI_RANK_ADMIN_CODE = previousAdminCode;
    if (previousLegacyCodes === undefined) delete process.env.MI_LEGACY_AGENCY_CODES;
    else process.env.MI_LEGACY_AGENCY_CODES = previousLegacyCodes;
  }
});

test("manual hybrid refresh wakes once without changing order, processing, or quarantine", async () => {
  const teamCode = "mml93-t01";
  const now = Date.now();
  const tracker = trackerRow({
    agency_code: teamCode,
    next_check_at: new Date(now + 6 * 60 * 60_000).toISOString(),
    processing_started_at: new Date(now - 60_000).toISOString(),
    processing_until: new Date(now + 30 * 60_000).toISOString(),
    worker_quarantined_until: new Date(now + 12 * 60 * 60_000).toISOString(),
  });
  const outside = trackerRow({ id: "outside-tracker", agency_code: "outside-tenant" });
  const rows = [tracker, outside];
  const before = structuredClone(rows);
  const wakeSources = [];
  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        assert.equal(name, "mi_request_naver_shopping_worker_wake");
        wakeSources.push(args.p_source);
        return { data: true, error: null };
      },
      from(table) {
        if (table === SNAPSHOTS) {
          const query = {
            select() { return query; },
            in() { return query; },
            gte() { return query; },
            lte() { return query; },
            order() { return query; },
            range() { return query; },
            then(resolve, reject) {
              return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
            },
          };
          return query;
        }
        assert.equal(table, TRACKERS);
        const filters = [];
        const query = {
          select() { return query; },
          update() { throw new Error("manual_refresh_must_not_update_tracker"); },
          insert() { throw new Error("manual_refresh_must_not_insert"); },
          eq(column, value) {
            filters.push((row) => row[column] === value);
            return query;
          },
          in(column, values) {
            const allowed = new Set(values);
            filters.push((row) => allowed.has(row[column]));
            return query;
          },
          async maybeSingle() {
            const matched = rows.filter((row) => filters.every((filter) => filter(row)));
            return { data: matched.length === 1 ? matched[0] : null, error: null };
          },
          then(resolve, reject) {
            const data = rows.filter((row) => filters.every((filter) => filter(row)));
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };

  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", { action: "check", trackerId: tracker.id }, teamCode),
    ctx,
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.preserved, true);
  assert.equal(body.queuedForLocalWorker, true);
  assert.equal(body.remoteWakeRequested, true);
  assert.equal(body.errorCode, "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW");
  assert.equal(
    body.message,
    "중앙 Chrome 자동 순환을 깨웠습니다. 기존 순서와 격리 시각을 유지하며 차례가 되면 300위까지 갱신합니다.",
  );
  assert.equal(body.tracker.nextCheckAt, before[0].next_check_at);
  assert.deepEqual(wakeSources, ["tracker-check"]);
  assert.deepEqual(rows, before);

  const forbidden = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", { action: "check", trackerId: outside.id }, teamCode),
    ctx,
  ));
  assert.equal(forbidden.status, 404);
  assert.deepEqual(wakeSources, ["tracker-check"]);
});

test("hybrid create registers an unleased new-first row and wakes the scheduler once", async () => {
  const teamCode = "mml93-t01";
  const trackerRows = [];
  const trackerUpdates = [];
  const wakeSources = [];
  const startedAt = Date.now();

  function trackerQuery() {
    const query = {
      operation: "select",
      values: null,
      filters: [],
      orders: [],
      rowLimit: Infinity,
      head: false,
      select(_columns, options = {}) {
        query.head = options.head === true;
        return query;
      },
      insert(values) {
        query.operation = "insert";
        query.values = values;
        return query;
      },
      update(values) {
        query.operation = "update";
        query.values = values;
        return query;
      },
      eq(column, value) {
        query.filters.push((row) => row[column] === value);
        return query;
      },
      in(column, values) {
        const allowed = new Set(values);
        query.filters.push((row) => allowed.has(row[column]));
        return query;
      },
      order(column, options = {}) {
        query.orders.push({ column, ascending: options.ascending !== false });
        return query;
      },
      limit(value) {
        query.rowLimit = Number(value);
        return query;
      },
      single() { return query.execute(true); },
      maybeSingle() { return query.execute(true, true); },
      then(resolve, reject) { return query.execute(false).then(resolve, reject); },
      async execute(single, allowMissing = false) {
        let selected = trackerRows.filter((row) => query.filters.every((filter) => filter(row)));
        for (const { column, ascending } of [...query.orders].reverse()) {
          selected = [...selected].sort((left, right) => {
            const compared = left[column] === right[column] ? 0 : (left[column] > right[column] ? 1 : -1);
            return ascending ? compared : -compared;
          });
        }
        selected = selected.slice(0, query.rowLimit);
        const selectedCount = selected.length;
        if (query.operation === "insert") {
          const inserted = {
            id: "10000000-0000-4000-8000-000000000099",
            current_rank: null,
            best_rank: null,
            worst_rank: null,
            check_count: 0,
            found_count: 0,
            retry_count: 0,
            sort_order: 100,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...query.values,
          };
          trackerRows.push(inserted);
          selected = [inserted];
        } else if (query.operation === "update") {
          trackerUpdates.push({ ...query.values });
          selected.forEach((row) => Object.assign(row, query.values));
        }
        if (query.head) return { data: null, error: null, count: selectedCount };
        if (single) {
          return selected.length === 1
            ? { data: selected[0], error: null }
            : (allowMissing ? { data: null, error: null } : { data: null, error: { message: "single row not found" } });
        }
        return { data: selected, error: null };
      },
    };
    return query;
  }

  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        assert.equal(name, "mi_request_naver_shopping_worker_wake");
        wakeSources.push(args.p_source);
        return { data: true, error: null };
      },
      from(table) {
        if (table === TRACKERS) return trackerQuery();
        if (table === "clients") {
          const query = {
            select() { return query; },
            eq() { return query; },
            async maybeSingle() { return { data: null, error: null }; },
          };
          return query;
        }
        if (table === "operation_team_codes") {
          const query = { select() { return query; }, eq() { return query; }, async maybeSingle() { return { data: null, error: null }; } };
          return query;
        }
        assert.equal(table, SNAPSHOTS);
        const query = {
          select() { return query; },
          in() { return query; },
          gte() { return query; },
          lte() { return query; },
          order() { return query; },
          range() { return query; },
          then(resolve, reject) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };

  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", {
      action: "create",
      keyword: "새 키워드",
      productId: "1234567890",
    }, teamCode),
    ctx,
  ));
  const body = await response.json();
  const inserted = trackerRows[0];

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.queuedForLocalWorker, true);
  assert.equal(body.remoteWakeRequested, true);
  assert.equal(body.message, "추적 등록 후 첫 순위 확인 대기");
  assert.deepEqual(wakeSources, ["tracker-create"]);
  assert.equal(inserted.last_checked_at, null);
  assert.equal(inserted.processing_started_at, null);
  assert.equal(inserted.processing_until, null);
  assert.ok(Date.parse(inserted.next_check_at) >= startedAt);
  assert.ok(Date.parse(inserted.next_check_at) <= Date.now());
  assert.deepEqual(trackerUpdates, [{ group_name: "기본 그룹" }]);
  assert.equal(body.tracker.lastCheckedAt, null);
  assert.equal(body.tracker.nextCheckAt, inserted.next_check_at);
  assert.equal(body.tracker.snapshots.length, 0);
});

test("hybrid create atomically reactivates the same normalized paused target without moving its cycle position", async () => {
  const teamCode = "mml93-t01";
  const pausedTarget = trackerRow({
    id: "10000000-0000-4000-8000-000000000101",
    agency_code: teamCode,
    keyword: " 자외선 차단 마스크 ",
    product_id: "13656510327",
    product_url: "https://smartstore.naver.com/test/products/13656510327",
    status: "paused",
    processing_started_at: "2026-08-12T08:00:00.000Z",
    processing_until: "2026-08-12T08:35:00.000Z",
    next_check_at: "2026-08-11T05:52:33.000Z",
    sort_order: 700,
    worker_last_cycle_id: "20000000-0000-4000-8000-000000000025",
    worker_quarantined_until: "2026-08-22T03:00:00.000Z",
    group_name: "진단",
  });
  const otherPausedTarget = trackerRow({
    id: "10000000-0000-4000-8000-000000000102",
    agency_code: teamCode,
    keyword: "자외선차단마스크",
    product_id: "99999999999",
    product_url: "https://smartstore.naver.com/test/products/99999999999",
    status: "paused",
  });
  const foreignPausedTarget = trackerRow({
    id: "10000000-0000-4000-8000-000000000103",
    agency_code: "mml93-t02",
    keyword: "자외선차단마스크",
    product_id: pausedTarget.product_id,
    product_url: pausedTarget.product_url,
    status: "paused",
  });
  const trackerRows = [pausedTarget, otherPausedTarget, foreignPausedTarget];
  const insertedValues = [];
  const updateValues = [];
  const wakeSources = [];

  function trackerQuery() {
    const query = {
      operation: "select",
      values: null,
      filters: [],
      orders: [],
      rowLimit: Infinity,
      head: false,
      select(_columns, options = {}) {
        query.head = options.head === true;
        return query;
      },
      insert(values) {
        query.operation = "insert";
        query.values = values;
        return query;
      },
      update(values) {
        query.operation = "update";
        query.values = values;
        return query;
      },
      eq(column, value) {
        query.filters.push((row) => row[column] === value);
        return query;
      },
      is(column, value) {
        query.filters.push((row) => row[column] === value);
        return query;
      },
      in(column, values) {
        const allowed = new Set(values);
        query.filters.push((row) => allowed.has(row[column]));
        return query;
      },
      order(column, options = {}) {
        query.orders.push({ column, ascending: options.ascending !== false });
        return query;
      },
      limit(value) {
        query.rowLimit = Number(value);
        return query;
      },
      single() { return query.execute(true); },
      maybeSingle() { return query.execute(true, true); },
      then(resolve, reject) { return query.execute(false).then(resolve, reject); },
      async execute(single, allowMissing = false) {
        let selected = trackerRows.filter((row) => query.filters.every((filter) => filter(row)));
        for (const { column, ascending } of [...query.orders].reverse()) {
          selected = [...selected].sort((left, right) => {
            const compared = left[column] === right[column] ? 0 : (left[column] > right[column] ? 1 : -1);
            return ascending ? compared : -compared;
          });
        }
        selected = selected.slice(0, query.rowLimit);
        const selectedCount = selected.length;
        if (query.operation === "insert") {
          insertedValues.push({ ...query.values });
          const inserted = trackerRow({
            id: "10000000-0000-4000-8000-000000000199",
            agency_code: query.values.agency_code,
            ...query.values,
          });
          trackerRows.push(inserted);
          selected = [inserted];
        } else if (query.operation === "update") {
          updateValues.push({ ...query.values });
          selected.forEach((row) => Object.assign(row, query.values));
        }
        if (query.head) return { data: null, error: null, count: selectedCount };
        if (single) {
          return selected.length === 1
            ? { data: selected[0], error: null }
            : (allowMissing ? { data: null, error: null } : { data: null, error: { message: "single row not found" } });
        }
        return { data: selected, error: null };
      },
    };
    return query;
  }

  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        assert.equal(name, "mi_request_naver_shopping_worker_wake");
        wakeSources.push(args.p_source);
        return { data: true, error: null };
      },
      from(table) {
        if (table === TRACKERS) return trackerQuery();
        if (table === "clients") {
          const query = {
            select() { return query; },
            eq() { return query; },
            async maybeSingle() { return { data: null, error: null }; },
          };
          return query;
        }
        if (table === "operation_team_codes") {
          const query = { select() { return query; }, eq() { return query; }, async maybeSingle() { return { data: null, error: null }; } };
          return query;
        }
        assert.equal(table, SNAPSHOTS);
        const query = {
          select() { return query; },
          in() { return query; },
          gte() { return query; },
          lte() { return query; },
          order() { return query; },
          range() { return query; },
          then(resolve, reject) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };

  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", {
      action: "create",
      keyword: "자외선차단마스크",
      productId: pausedTarget.product_id,
    }, teamCode),
    ctx,
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.queuedForLocalWorker, true);
  assert.equal(body.remoteWakeRequested, true);
  assert.equal(body.tracker.id, pausedTarget.id);
  assert.deepEqual(wakeSources, ["tracker-create"]);
  assert.equal(insertedValues.length, 0);
  assert.equal(pausedTarget.status, "active");
  assert.equal(pausedTarget.processing_started_at, null);
  assert.equal(pausedTarget.processing_until, null);
  assert.equal(pausedTarget.next_check_at, "2026-08-11T05:52:33.000Z");
  assert.equal(pausedTarget.sort_order, 700);
  assert.equal(pausedTarget.worker_last_cycle_id, "20000000-0000-4000-8000-000000000025");
  assert.equal(pausedTarget.worker_quarantined_until, "2026-08-22T03:00:00.000Z");
  assert.equal(otherPausedTarget.status, "paused");
  assert.equal(foreignPausedTarget.status, "paused");
  assert.deepEqual(updateValues, [{
    status: "active",
    processing_started_at: null,
    processing_until: null,
  }]);

  const repeatedResponse = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", {
      action: "create",
      keyword: "자외선 차단마스크",
      productId: pausedTarget.product_id,
    }, teamCode),
    ctx,
  ));
  const repeatedBody = await repeatedResponse.json();
  assert.equal(repeatedResponse.status, 200);
  assert.equal(repeatedBody.tracker.id, pausedTarget.id);
  assert.equal(insertedValues.length, 0);
  assert.equal(updateValues.length, 1);
  assert.deepEqual(wakeSources, ["tracker-create"]);
});

test("manual product refresh does not claim or update a row without the collector", async () => {
  const teamCode = "mml93-t01";
  const tracker = trackerRow({ agency_code: teamCode });
  let updateCalled = false;
  const ctx = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, TRACKERS);
        const query = {
          select() { return query; },
          eq() { return query; },
          in() { return query; },
          update() {
            updateCalled = true;
            return query;
          },
          async maybeSingle() {
            return { data: tracker, error: null };
          },
        };
        return query;
      },
    },
  };

  const response = await withoutShoppingCollector(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", { action: "check", trackerId: tracker.id }, teamCode),
    ctx,
  ));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.rankSourceReady, false);
  assert.equal(body.configured, false);
  assert.equal(body.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(body.retryable, false);
  assert.equal(updateCalled, false);
});

function trackerRow(values = {}) {
  return {
    id: "tracker-1",
    client_id: "client-1",
    brand_id: null,
    agency_code: "mml93-a01",
    keyword: "테스트 상품",
    product_url: "https://smartstore.naver.com/test/products/1234567890",
    product_id: "1234567890",
    mall_name: "테스트몰",
    product_title: "테스트 상품",
    max_rank: 300,
    status: "active",
    started_at: "2026-07-01T00:00:00.000Z",
    ends_at: null,
    last_checked_at: "2026-07-15T00:00:00.000Z",
    next_check_at: "2026-07-16T00:00:00.000Z",
    current_rank: 27,
    best_rank: 11,
    worst_rank: 42,
    check_count: 9,
    found_count: 8,
    last_message: "마지막 정상 순위는 27위입니다.",
    last_error: null,
    retry_count: 0,
    sort_order: 100,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    ...values,
  };
}

function pagedProductSnapshotContext(rows, options = {}) {
  const state = { ranges: [] };
  return {
    state,
    ctx: {
      supabaseAdmin: {
        from(table) {
          assert.equal(table, SNAPSHOTS);
          const query = {
            trackerIds: [],
            checkedAfter: "",
            checkedBefore: "",
            orders: [],
            rangeStart: 0,
            rangeEnd: 999,
            select() { return query; },
            in(column, values) {
              assert.equal(column, "tracker_id");
              query.trackerIds = values;
              return query;
            },
            gte(column, value) {
              assert.equal(column, "checked_at");
              query.checkedAfter = value;
              return query;
            },
            lte(column, value) {
              assert.equal(column, "checked_at");
              query.checkedBefore = value;
              return query;
            },
            order(column, orderOptions = {}) {
              query.orders.push({ column, ascending: orderOptions.ascending !== false });
              return query;
            },
            range(from, to) {
              query.rangeStart = from;
              query.rangeEnd = to;
              state.ranges.push({ from, to });
              return query;
            },
            then(resolve, reject) {
              let selected = rows
                .filter((row) => query.trackerIds.includes(row.tracker_id))
                .filter((row) => row.checked_at >= query.checkedAfter && row.checked_at <= query.checkedBefore);
              for (const { column, ascending } of [...query.orders].reverse()) {
                selected = [...selected].sort((left, right) => {
                  if (left[column] === right[column]) return 0;
                  const result = left[column] > right[column] ? 1 : -1;
                  return ascending ? result : -result;
                });
              }
              const count = selected.length;
              const start = options.stall ? 0 : query.rangeStart;
              const requestedEnd = options.stall ? query.rangeEnd - query.rangeStart : query.rangeEnd;
              const end = Number.isFinite(options.serverCap)
                ? Math.min(requestedEnd, start + options.serverCap - 1)
                : requestedEnd;
              return Promise.resolve({ data: selected.slice(start, end + 1), error: null, count }).then(resolve, reject);
            },
          };
          return query;
        },
      },
    },
  };
}

class MockQuery {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.operation = "select";
    this.values = null;
    this.filters = [];
    this.orders = [];
    this.rowLimit = Infinity;
    this.head = false;
  }

  update(values) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  insert(values) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  gte(column, value) {
    this.filters.push((row) => row[column] >= value);
    return this;
  }

  lte(column, value) {
    this.filters.push((row) => row[column] <= value);
    return this;
  }

  in(column, values) {
    const allowed = new Set(values);
    this.filters.push((row) => allowed.has(row[column]));
    return this;
  }

  or(expression) {
    const prefix = "processing_until.is.null,processing_until.lt.";
    if (!String(expression).startsWith(prefix)) throw new Error(`unsupported test OR filter: ${expression}`);
    const threshold = String(expression).slice(prefix.length);
    this.filters.push((row) => row.processing_until == null || row.processing_until < threshold);
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(value) {
    this.rowLimit = Math.max(0, Number(value || 0));
    return this;
  }

  select(_columns, options = {}) {
    this.head = options.head === true;
    return this;
  }

  single() {
    return this.execute(true);
  }

  maybeSingle() {
    return this.execute(true, true);
  }

  then(resolve, reject) {
    return this.execute(false).then(resolve, reject);
  }

  async execute(single, allowMissing = false) {
    const rows = this.state.tables[this.table] || [];
    const matches = (row) => this.filters.every((filter) => filter(row));
    let selected = rows.filter(matches);

    for (const { column, ascending } of [...this.orders].reverse()) {
      selected = [...selected].sort((left, right) => {
        if (left[column] === right[column]) return 0;
        const comparison = left[column] > right[column] ? 1 : -1;
        return ascending ? comparison : -comparison;
      });
    }
    selected = selected.slice(0, this.rowLimit);
    const selectedCount = selected.length;

    if (this.operation === "update") {
      this.state.updates.push({ table: this.table, values: { ...this.values } });
      selected.forEach((row) => Object.assign(row, this.values));
    } else if (this.operation === "insert") {
      const inserted = {
        id: `snapshot-${this.state.nextId++}`,
        created_at: new Date().toISOString(),
        ...this.values,
      };
      rows.push(inserted);
      selected = [inserted];
    }

    if (this.head) return { data: null, error: null, count: selectedCount };
    if (single) {
      return selected.length === 1
        ? { data: selected[0], error: null }
        : (allowMissing
          ? { data: null, error: null }
          : { data: null, error: { message: "single row not found" } });
    }
    return { data: selected, error: null };
  }
}

function testContext(tracker, snapshots = []) {
  const state = {
    nextId: 1,
    updates: [],
    tables: {
      [TRACKERS]: [{ ...tracker }],
      [SNAPSHOTS]: snapshots.map((snapshot) => ({ ...snapshot })),
    },
  };
  return {
    state,
    ctx: {
      supabaseAdmin: {
        from(table) {
          return new MockQuery(state, table);
        },
      },
    },
  };
}

function assertPreserved(previous, current) {
  assert.equal(current.current_rank, previous.current_rank);
  assert.equal(current.best_rank, previous.best_rank);
  assert.equal(current.worst_rank, previous.worst_rank);
  assert.equal(current.check_count, previous.check_count);
  assert.equal(current.found_count, previous.found_count);
  assert.equal(current.last_checked_at, previous.last_checked_at);
}

function assertRetryTime(nextCheckAt, startedAt, finishedAt, minutes) {
  const value = Date.parse(nextCheckAt);
  assert.ok(value >= startedAt + minutes * 60 * 1000, `retry must be at least ${minutes} minutes later`);
  assert.ok(value <= finishedAt + minutes * 60 * 1000 + 100, `retry must be about ${minutes} minutes later`);
}

function shoppingResultItem(index, overrides = {}) {
  const sellerProductId = String(80000000000 + index);
  return {
    productId: String(70000000000 + index),
    link: `https://smartstore.naver.com/other-store/products/${sellerProductId}`,
    title: `일반 상품 ${index}`,
    mallName: "다른판매처",
    brand: "다른브랜드",
    maker: "다른제조사",
    category1: "생활/건강",
    category2: "생활가전",
    productType: "2",
    ...overrides,
  };
}

function collectorWindow(keyword, rawItems, options = {}) {
  const limit = Number(options.limit || 300);
  const excludedAdCount = rawItems.filter((item) => isAdItem(item)).length;
  const items = rawItems
    .filter((item) => !isAdItem(item))
    .slice(0, limit)
    .map((item, index) => ({
      ...item,
      organicRank: index + 1,
      isAd: false,
      isOrganic: true,
    }));
  const sourceExhausted = options.sourceExhausted ?? items.length < limit;
  const complete = options.complete ?? (items.length >= limit || sourceExhausted);
  const marketTotalStatus = options.marketTotalStatus || "verified";
  const marketTotal = marketTotalStatus === "unavailable"
    ? null
    : Number(options.marketTotal ?? rawItems.length);
  return {
    ok: true,
    schemaVersion: NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
    source: "naver_shopping_results_collector",
    rankEvidence: "naver_shopping_organic_list",
    keyword,
    collectionId: options.collectionId || "test-collection-1",
    collectedAt: options.collectedAt || "2026-08-01T00:00:00.000Z",
    complete,
    partial: !complete,
    sourceExhausted,
    marketTotal,
    marketTotalStatus,
    checkedCount: items.length,
    rawCount: Number(options.rawCount ?? rawItems.length),
    excludedAdCount: Number(options.excludedAdCount ?? excludedAdCount),
    items,
  };
}

async function withShoppingResults(items, callback) {
  const originalFetch = globalThis.fetch;
  shoppingProviderPageCache.clear();
  globalThis.fetch = async (input, options = {}) => {
    assert.equal(String(input), COLLECTOR_ENV.providerUrl);
    assert.equal(options.method, "POST");
    assert.equal(options.headers?.authorization, `Bearer ${COLLECTOR_ENV.providerKey}`);
    const body = JSON.parse(options.body || "{}");
    assert.equal(body.schemaVersion, NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA);
    assert.equal(body.sort, "relevance");
    assert.equal(body.rankPolicy, "organic_only");
    assert.ok(Number(body.limit) >= 1 && Number(body.limit) <= 300);
    return new Response(JSON.stringify(collectorWindow(body.keyword, items, { limit: body.limit })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return await callback();
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
}

function verifiedCatalogSnapshot(overrides = {}) {
  return {
    id: "snapshot-verified-catalog",
    tracker_id: "tracker-1",
    checked_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    matched: true,
    rank: 16,
    item: {
      trackingRankSource: "related_catalog",
      relatedCatalogProductId: "57907660073",
      relatedCatalogRank: 16,
      relatedCatalogRelationBasis: "catalog_seller_product_id",
      catalogId: "57907660073",
      catalogSellerProductIds: ["12649811979"],
      rankPolicy: "organic_only",
      adExcluded: true,
    },
    ...overrides,
  };
}

test("only a prior matched organic snapshot can supply the continuity catalog id", () => {
  const now = Date.now();
  const snapshots = [
    verifiedCatalogSnapshot({
      id: "title-only-newer",
      checked_at: new Date(now).toISOString(),
      item: {
        title: "같은 제목처럼 보이는 다른 원부",
        productId: "99999999999",
        relatedCatalogRank: 1,
        trackingRankSource: "related_catalog",
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
    verifiedCatalogSnapshot({
      id: "ad-contaminated-newer",
      checked_at: new Date(now - 1000).toISOString(),
      item: {
        trackingRankSource: "related_catalog",
        relatedCatalogProductId: "88888888888",
        relatedCatalogRank: 2,
        rankPolicy: "organic_only",
        adExcluded: false,
      },
    }),
    verifiedCatalogSnapshot({ checked_at: new Date(now - 2000).toISOString() }),
  ];

  assert.equal(verifiedRelatedCatalogIdFromSnapshots(snapshots, "12649811979"), "57907660073");
  assert.equal(verifiedRelatedCatalogIdFromSnapshots([
    verifiedCatalogSnapshot({
      item: {
        trackingRankSource: "related_catalog",
        relatedCatalogProductId: "12649811979",
        relatedCatalogRank: 3,
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
  ], "12649811979"), "");
});

test("inferred or wrong-seller parent snapshots never seed continuity", () => {
  const snapshots = [
    verifiedCatalogSnapshot({
      id: "model-inferred",
      item: {
        trackingRankSource: "related_catalog",
        relatedCatalogProductId: "59776958987",
        relatedCatalogRank: 1,
        relatedCatalogRelationBasis: "model_brand_category",
        catalogId: "59776958987",
        catalogSellerProductIds: ["12649811979"],
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
    verifiedCatalogSnapshot({
      id: "wrong-seller-direct",
      item: {
        trackingRankSource: "related_catalog",
        relatedCatalogProductId: "59776958987",
        relatedCatalogRank: 2,
        relatedCatalogRelationBasis: "catalog_seller_product_id",
        catalogId: "59776958987",
        catalogSellerProductIds: ["99999999999"],
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
  ];

  assert.equal(verifiedRelatedCatalogIdFromSnapshots(snapshots, "12649811979"), "");
});

test("a direct seller list cannot bless a mismatched related catalog id", () => {
  const snapshot = verifiedCatalogSnapshot({
    item: {
      trackingRankSource: "related_catalog",
      relatedCatalogProductId: "59776958987",
      relatedCatalogRank: 2,
      relatedCatalogRelationBasis: "catalog_seller_product_id",
      catalogId: "58888888888",
      catalogSellerProductIds: ["12649811979"],
      rankPolicy: "organic_only",
      adExcluded: true,
    },
  });

  assert.equal(verifiedRelatedCatalogIdFromSnapshots([snapshot], "12649811979"), "");
});

test("standalone seller-product evidence invalidates a previously stored catalog id", () => {
  const snapshots = [
    verifiedCatalogSnapshot({
      checked_at: new Date(Date.now() - 1000).toISOString(),
      item: {
        trackingRankSource: "related_catalog",
        relatedCatalogProductId: "59031763223",
        relatedCatalogRank: 3,
        relationBasis: "prior_verified_catalog_id",
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
    verifiedCatalogSnapshot({
      checked_at: new Date(Date.now() - 2000).toISOString(),
      item: {
        trackingRankSource: "exact_product",
        productType: "2",
        relatedCatalogProductId: "59031763223",
        relatedCatalogRank: 21,
        relatedCatalogRelationBasis: "keyword_brand_category",
        rankPolicy: "organic_only",
        adExcluded: true,
      },
    }),
  ];

  assert.equal(verifiedRelatedCatalogIdFromSnapshots(snapshots, "12149720593"), "");
});

test("a tracker reuses the exact prior catalog id when the seller product is outside 300", async () => {
  const tracker = trackerRow({
    keyword: "음파 전동칫솔",
    product_id: "12649811979",
    product_url: "https://smartstore.naver.com/lav/products/12649811979",
  });
  const { ctx, state } = testContext(tracker, [verifiedCatalogSnapshot()]);
  let lookupOptions = null;

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async (_env, options) => {
      lookupOptions = options;
      return {
        matched: true,
        rank: 15,
        trackingRankSource: "related_catalog",
        exactProductRank: null,
        relatedCatalogRank: 15,
        checkedCount: 300,
        complete: true,
        partial: false,
        productExposureItems: [{
          rank: 15,
          productId: "57907660073",
          catalogId: "57907660073",
          catalogSellerProductIds: [tracker.product_id],
          title: "라이브오랄스 오라원 회전법 음파전동칫솔",
          isRelatedCatalog: true,
          isOrganic: true,
          relationBasis: "catalog_seller_product_id",
        }],
        topItems: [],
      };
    },
  });

  assert.equal(lookupOptions.verifiedRelatedCatalogId, "57907660073");
  assert.equal(result.ok, true);
  assert.equal(state.tables[TRACKERS][0].current_rank, 15);
  assert.equal(state.tables[SNAPSHOTS].length, 2);
  assert.equal(state.tables[SNAPSHOTS][1].rank, 15);
  assert.equal(state.tables[SNAPSHOTS][1].item.relatedCatalogProductId, "57907660073");
  assert.equal(state.tables[SNAPSHOTS][1].item.trackingRankSource, "related_catalog");
});

test("a complete miss clears the current rank only after exact product and verified catalog are both absent", async () => {
  const tracker = trackerRow({
    product_id: "12649811979",
    product_url: "https://smartstore.naver.com/lav/products/12649811979",
  });
  const { ctx, state } = testContext(tracker, [verifiedCatalogSnapshot()]);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async (_env, options) => {
      assert.equal(options.verifiedRelatedCatalogId, "57907660073");
      return {
        matched: false,
        checkedCount: 300,
        total: 10000,
        complete: true,
        partial: false,
        verifiedRelatedCatalogId: options.verifiedRelatedCatalogId,
        productExposureItems: [],
        topItems: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(state.tables[TRACKERS][0].current_rank, null);
  assert.equal(state.tables[TRACKERS][0].found_count, tracker.found_count);
  assert.equal(state.tables[SNAPSHOTS].length, 2);
  assert.equal(state.tables[SNAPSHOTS][1].matched, false);
});

test("remote tracker checks preserve history when direct identity is missing or conflicting", async () => {
  const cases = [
    trackerRow({
      product_id: null,
      product_url: null,
      mall_name: "동일 판매처",
      product_title: "완전히 동일한 상품명",
    }),
    trackerRow({
      product_id: "12149720593",
      product_url: "https://smartstore.naver.com/example/products/99999999999",
    }),
  ];

  for (const tracker of cases) {
    const { ctx, state } = testContext(tracker);
    let lookupCalled = false;
    // eslint-disable-next-line no-await-in-loop
    const result = await runTrackerCheck(ctx, tracker, {
      env: COLLECTOR_ENV,
      findShoppingRank: async () => {
        lookupCalled = true;
        return {};
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "shopping_rank_target_identity_invalid");
    assert.equal(lookupCalled, false);
    assert.equal(state.tables[SNAPSHOTS].length, 0);
    assertPreserved(tracker, state.tables[TRACKERS][0]);
  }
});

test("missing shopping API config preserves the last good rank and schedules a five-minute retry", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);
  let lookupCalled = false;
  const startedAt = Date.now();

  const result = await runTrackerCheck(ctx, tracker, {
    env: {},
    findShoppingRank: async () => {
      lookupCalled = true;
      return {};
    },
  });
  const finishedAt = Date.now();
  const current = state.tables[TRACKERS][0];

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_rank_source_not_configured");
  assert.equal(result.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(result.retryable, false);
  assert.equal(result.rankSourceReady, false);
  assert.equal(result.configured, false);
  assert.equal(lookupCalled, false);
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, current);
  assert.equal(current.last_error, "shopping_rank_source_not_configured");
  assert.equal(current.retry_count, 1);
  assert.match(current.last_message, /마지막 정상 순위는 유지/);
  assertRetryTime(current.next_check_at, startedAt, finishedAt, 5);
  assert.deepEqual(Object.keys(state.updates[0].values).sort(), [
    "last_error",
    "last_message",
    "next_check_at",
    "retry_count",
  ]);
});

test("shopping lookup exceptions preserve history and use exponential retry backoff", async () => {
  const tracker = trackerRow({ retry_count: 2 });
  const { ctx, state } = testContext(tracker);
  const startedAt = Date.now();

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => {
      throw new Error("naver lookup timeout");
    },
  });
  const finishedAt = Date.now();
  const current = state.tables[TRACKERS][0];

  assert.equal(result.ok, false);
  assert.equal(result.error, "naver lookup timeout");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, current);
  assert.equal(current.last_error, "naver lookup timeout");
  assert.equal(current.retry_count, 3);
  assert.match(current.last_message, /자동 재시도/);
  assertRetryTime(current.next_check_at, startedAt, finishedAt, 20);
});

test("manual hybrid miss queues the exact tracker for the Mac 300-rank worker", async () => {
  const tracker = trackerRow({ retry_count: 2, last_error: "old_error" });
  const { ctx, state } = testContext(tracker);
  const startedAt = Date.now();

  const result = await runTrackerCheck(ctx, tracker, {
    env: {
      mode: "hybrid_local_worker",
      localWorkerEnabled: true,
      localWorkerSecretReady: true,
    },
    queueLocalWorker: true,
    findShoppingRank: async () => {
      throw new Error("shopping_rank_top_fallback_inconclusive");
    },
  });
  const finishedAt = Date.now();
  const current = state.tables[TRACKERS][0];
  const queuedAt = Date.parse(current.next_check_at);

  assert.equal(result.ok, false);
  assert.equal(result.preserved, true);
  assert.equal(result.queuedForLocalWorker, true);
  assert.equal(result.errorCode, "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, current);
  assert.equal(current.last_error, null);
  assert.equal(current.retry_count, 0);
  assert.ok(queuedAt >= startedAt && queuedAt <= finishedAt);
  assert.match(current.last_message, /중앙 Chrome 300위 갱신을 대기/u);
});

test("collector authentication and configuration failures fail closed without fast retry", async () => {
  for (const [failure, errorCode] of [
    [Object.assign(new Error("provider_unauthorized"), { status: 401 }), "SHOPPING_RANK_PROVIDER_UNAUTHORIZED"],
    [Object.assign(new Error("verified_provider_not_configured"), { status: 503 }), "SHOPPING_RANK_PROVIDER_MISCONFIGURED"],
  ]) {
    const tracker = trackerRow({ retry_count: 2 });
    const { ctx, state } = testContext(tracker);
    const result = await runTrackerCheck(ctx, tracker, {
      env: COLLECTOR_ENV,
      findShoppingRank: async () => { throw failure; },
    });
    const current = state.tables[TRACKERS][0];
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.retryable, false);
    assert.equal(result.rankSourceReady, false);
    assert.equal(state.tables[SNAPSHOTS].length, 0);
    assertPreserved(tracker, current);
  }
});

test("a removed legacy shopping endpoint preserves history and waits for the next regular slot", async () => {
  const tracker = trackerRow({ retry_count: 5 });
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => {
      throw new Error("Invalid search api (존재하지 않는 검색 api 입니다.)");
    },
  });
  const current = state.tables[TRACKERS][0];
  const next = new Date(current.next_check_at);
  const kstHour = (next.getUTCHours() + 9) % 24;

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_rank_source_unavailable");
  assert.equal(isShoppingRankSourceUnavailable("Invalid search api (존재하지 않는 검색 api 입니다.)"), true);
  assert.equal(isShoppingRankSourceUnavailable("provider_not_ready"), false);
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, current);
  assert.equal(current.last_error, "shopping_rank_source_unavailable");
  assert.equal(current.retry_count, 6);
  assert.match(current.last_message, /마지막 정상 순위와 30일 기록은 유지/);
  assert.ok([9, 15].includes(kstHour));
  assert.equal(next.getUTCMinutes(), 0);
});

test("the external shopping collector requires native organic evidence", () => {
  const trusted = trustedCollectorWindow(collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 }), {
    keyword: "테스트 상품",
    maxRank: 1,
  });
  assert.equal(trusted.items.length, 1);
  assert.equal(trusted.rankEvidence, "naver_shopping_organic_list");
  assert.equal(trusted.collectionId, "test-collection-1");

  const unavailableTotal = trustedCollectorWindow(collectorWindow(
    "테스트 상품",
    [shoppingResultItem(0)],
    { limit: 1, marketTotalStatus: "unavailable" },
  ), { keyword: "테스트 상품", maxRank: 1 });
  assert.equal(unavailableTotal.marketTotal, null);
  assert.equal(unavailableTotal.marketTotalStatus, "unavailable");
  assert.equal(unavailableTotal.checkedCount, 1);

  assert.throws(() => trustedCollectorWindow({
    ...collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 }),
    source: "unverified_serp",
    rankEvidence: "provider_array_order",
  }, { keyword: "테스트 상품", maxRank: 1 }), /shopping_rank_provider_untrusted_evidence/);

  const nonSequential = collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 });
  nonSequential.items[0].organicRank = 2;
  assert.throws(
    () => trustedCollectorWindow(nonSequential, { keyword: "테스트 상품", maxRank: 1 }),
    /shopping_rank_provider_untrusted_evidence/,
  );

  const contaminated = collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 });
  contaminated.items[0].isAd = true;
  assert.throws(
    () => trustedCollectorWindow(contaminated, { keyword: "테스트 상품", maxRank: 1 }),
    /shopping_rank_provider_untrusted_evidence/,
  );

  const samePageDuplicate = collectorWindow(
    "테스트 상품",
    [shoppingResultItem(0), shoppingResultItem(1)],
    { limit: 2 },
  );
  samePageDuplicate.items[1].link = samePageDuplicate.items[0].link;
  assert.equal(
    trustedCollectorWindow(samePageDuplicate, { keyword: "테스트 상품", maxRank: 2 }).items.length,
    2,
  );

  const crossPageDuplicate = collectorWindow(
    "테스트 상품",
    Array.from({ length: 41 }, (_, index) => shoppingResultItem(index)),
    { limit: 41 },
  );
  crossPageDuplicate.items[40].link = crossPageDuplicate.items[0].link;
  assert.throws(
    () => trustedCollectorWindow(crossPageDuplicate, { keyword: "테스트 상품", maxRank: 41 }),
    /shopping_rank_provider_untrusted_evidence/,
  );

  const stableCrossPageDuplicate = collectorWindow(
    "테스트 상품",
    Array.from({ length: 300 }, (_, index) => shoppingResultItem(index, { productType: 2 })),
    { limit: 300 },
  );
  stableCrossPageDuplicate.items[40].link = stableCrossPageDuplicate.items[0].link;
  assert.throws(() => trustedCollectorWindow(stableCrossPageDuplicate, {
    keyword: "테스트 상품",
    maxRank: 300,
  }), /shopping_rank_provider_untrusted_evidence/);
  const stablePassDigest = stableWindowDigest(stableCrossPageDuplicate.items, {
    keyword: "테스트 상품",
  });
  stableCrossPageDuplicate.crossPageProof = {
    version: "stable-full-window-v1",
    passCount: 2,
    pageCount: 8,
    pageSize: 40,
    captureIds: ["capture-pass-0001", "capture-pass-0002"],
    passDigests: [stablePassDigest, stablePassDigest],
    collisionDigest: stableCollisionDigest(stableCrossPageDuplicate.items),
  };
  assert.equal(trustedCollectorWindow(stableCrossPageDuplicate, {
    keyword: "테스트 상품",
    maxRank: 300,
  }).items.length, 300);

  const invalidStableProofs = [
    { passDigests: [stablePassDigest, "0".repeat(64)] },
    { collisionDigest: "0".repeat(64) },
    { captureIds: ["capture-pass-0001", "capture-pass-0001"] },
    { unexpected: true },
  ];
  for (const proofOverride of invalidStableProofs) {
    const candidate = structuredClone(stableCrossPageDuplicate);
    candidate.crossPageProof = { ...candidate.crossPageProof, ...proofOverride };
    assert.throws(() => trustedCollectorWindow(candidate, {
      keyword: "테스트 상품",
      maxRank: 300,
    }), /shopping_rank_provider_untrusted_evidence/);
  }

  const driftedStableWindow = structuredClone(stableCrossPageDuplicate);
  driftedStableWindow.items[299].linkedCatalogId = "99000000001";
  assert.throws(() => trustedCollectorWindow(driftedStableWindow, {
    keyword: "테스트 상품",
    maxRank: 300,
  }), /shopping_rank_provider_untrusted_evidence/);

  const unexpectedProof = collectorWindow(
    "테스트 상품",
    Array.from({ length: 300 }, (_, index) => shoppingResultItem(index, { productType: 2 })),
    { limit: 300 },
  );
  unexpectedProof.crossPageProof = stableCrossPageDuplicate.crossPageProof;
  assert.throws(() => trustedCollectorWindow(unexpectedProof, {
    keyword: "테스트 상품",
    maxRank: 300,
  }), /shopping_rank_provider_untrusted_evidence/);

  const falselyPartial = collectorWindow("테스트 상품", [shoppingResultItem(0)], { limit: 1 });
  falselyPartial.complete = false;
  falselyPartial.partial = true;
  assert.throws(
    () => trustedCollectorWindow(falselyPartial, { keyword: "테스트 상품", maxRank: 1 }),
    /shopping_rank_provider_untrusted_evidence/,
  );

  const sharedCatalogId = "59031763223";
  const catalogAndSeller = collectorWindow("테스트 상품", [
    shoppingResultItem(0, {
      productId: "91000000001",
      sellerProductId: undefined,
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      link: "",
      productType: "1",
    }),
    shoppingResultItem(1, {
      productId: "91000000002",
      sellerProductId: "12149720593",
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      link: "https://smartstore.naver.com/haedenprime/products/12149720593",
      productType: "3",
    }),
  ], { limit: 2 });
  assert.equal(
    trustedCollectorWindow(catalogAndSeller, { keyword: "테스트 상품", maxRank: 2 }).items.length,
    2,
  );

  const weakProductCollision = collectorWindow("테스트 상품", [
    shoppingResultItem(0, {
      sellerProductId: "80000000000",
      link: "https://smartstore.naver.com/other-store/products/80000000000",
    }),
    shoppingResultItem(1, {
      productId: "70000000000",
      sellerProductId: "80000000001",
      link: "https://smartstore.naver.com/other-store/products/80000000001",
    }),
  ], { limit: 2 });
  assert.equal(
    trustedCollectorWindow(weakProductCollision, { keyword: "테스트 상품", maxRank: 2 }).items.length,
    2,
  );
});

test("rendered-order evidence stays fail-closed at the handler and records only its proven version", async () => {
  const keyword = "테스트 상품";
  const rawItems = Array.from({ length: 300 }, (_, index) => {
    const sellerProductId = String(80000000000 + index);
    return shoppingResultItem(index, {
      sellerProductId,
      link: `https://smartstore.naver.com/other-store/products/${sellerProductId}`,
      productType: 2,
    });
  });
  const window = collectorWindow(keyword, rawItems, { limit: 300 });
  const passDigest = stableRenderedOrderWindowDigest(window.items, { keyword });
  const renderedOrderProof = {
    version: "stable-rendered-order-v1",
    passCount: 2,
    pageCount: 8,
    pageSize: 40,
    captureIds: ["rendered-capture-0001", "rendered-capture-0002"],
    passDigests: [passDigest, passDigest],
    structureDigests: ["a".repeat(64), "b".repeat(64)],
  };
  window.renderedOrderProof = renderedOrderProof;

  const trusted = trustedCollectorWindow(window, { keyword, maxRank: 300 });
  assert.deepEqual(trusted.renderedOrderProof, renderedOrderProof);

  for (const proofOverride of [
    { captureIds: ["rendered-capture-0001", "rendered-capture-0001"] },
    { passDigests: [passDigest, "b".repeat(64)] },
    { structureDigests: ["a".repeat(64), "not-a-sha256"] },
    { unexpected: true },
  ]) {
    assert.throws(() => trustedCollectorWindow({
      ...window,
      renderedOrderProof: { ...renderedOrderProof, ...proofOverride },
    }, { keyword, maxRank: 300 }), /shopping_rank_provider_untrusted_evidence/u);
  }

  const directIdentityDrift = structuredClone(window);
  directIdentityDrift.items[0].sellerProductId = "99999999999";
  directIdentityDrift.items[0].link = "https://smartstore.naver.com/other-store/products/99999999999";
  assert.equal(directIdentityDrift.items[0].title, window.items[0].title);
  assert.throws(() => trustedCollectorWindow(directIdentityDrift, {
    keyword,
    maxRank: 300,
  }), /shopping_rank_provider_untrusted_evidence/u);

  const result = await findShoppingRankFromWindow(trusted, {
    keyword,
    targetProductId: rawItems[0].sellerProductId,
    targetUrl: rawItems[0].link,
    maxRank: 300,
    skipTargetMetadata: true,
  });
  assert.equal(result.rank, 1);
  assert.equal(result.renderedOrderProofVersion, "stable-rendered-order-v1");
  assert.equal("renderedOrderProof" in result, false);

  const record = buildProductRankSnapshotRecord(
    trackerRow({ product_id: rawItems[0].sellerProductId, product_url: rawItems[0].link }),
    "2026-08-01T00:00:00.000Z",
    result,
    "입력 상품의 네이버쇼핑 오가닉 순위는 1위입니다.",
  );
  assert.equal(record.item.renderedOrderProofVersion, "stable-rendered-order-v1");
  assert.equal("renderedOrderProof" in record.item, false);
});

test("a catalog target matches only the real catalog card, never a linked seller", async () => {
  const sharedCatalogId = "59031763223";
  const window = collectorWindow("테스트 상품", [
    shoppingResultItem(0, {
      productId: "91000000001",
      sellerProductId: "12149720593",
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      link: "https://smartstore.naver.com/haedenprime/products/12149720593",
      productType: "3",
    }),
    shoppingResultItem(1, {
      productId: sharedCatalogId,
      sellerProductId: undefined,
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      link: `https://search.shopping.naver.com/catalog/${sharedCatalogId}`,
      productType: "1",
    }),
  ], { limit: 2 });
  const result = await findShoppingRankFromWindow(window, {
    keyword: "테스트 상품",
    targetUrl: `https://search.shopping.naver.com/catalog/${sharedCatalogId}`,
    maxRank: 2,
    skipTargetMetadata: true,
  });
  assert.equal(result.matched, true);
  assert.equal(result.rank, 2);
  assert.equal(result.item?.productType, "1");
});

test("collector typed runtime failure remains explicit when no exact fallback target exists", async () => {
  const originalFetch = globalThis.fetch;
  shoppingProviderPageCache.clear();
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    message: "provider_collection_failed",
    detail: "naver_http_418",
  }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });

  try {
    let captured;
    await assert.rejects(
      findShoppingRank(COLLECTOR_ENV, {
        keyword: "수집차단검증",
        targetProductId: "",
        maxRank: 300,
      }),
      (error) => {
        captured = error;
        return /provider_collection_failed:naver_http_418/.test(error.message);
      },
    );
    assert.equal(captured.status, 502);
    assert.equal(isShoppingRankSourceUnavailable(captured.message), true);
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
});

test("collector queue pressure stays retryable and never opens the source circuit breaker", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const detail of ["provider_queue_full", "provider_queue_deadline_exceeded"]) {
      shoppingProviderPageCache.clear();
      globalThis.fetch = async () => new Response(JSON.stringify({
        ok: false,
        message: "provider_busy",
        detail,
      }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });

      let captured;
      await assert.rejects(
        findShoppingRank(COLLECTOR_ENV, {
          keyword: `수집혼잡검증-${detail}`,
          targetProductId: "",
          maxRank: 300,
        }),
        (error) => {
          captured = error;
          return new RegExp(`provider_busy:${detail}`).test(error.message);
        },
      );
      assert.equal(captured.status, 429);
      assert.equal(captured.code, "provider_busy");
      assert.equal(captured.detail, detail);
      assert.equal(isShoppingRankSourceUnavailable(captured.message), false);

      const tracker = trackerRow({ retry_count: 0, keyword: `추적혼잡-${detail}` });
      const { ctx, state } = testContext(tracker);
      const startedAt = Date.now();
      const result = await runTrackerCheck(ctx, tracker, { env: COLLECTOR_ENV });
      const finishedAt = Date.now();
      const current = state.tables[TRACKERS][0];

      assert.equal(result.ok, false);
      assert.equal(result.errorCode, "SHOPPING_RANK_LOOKUP_FAILED");
      assert.equal(result.retryable, true);
      assert.equal(result.rankSourceReady, true);
      assert.equal(current.last_error, `provider_busy:${detail}`);
      assert.equal(current.retry_count, 1);
      assert.equal(state.tables[SNAPSHOTS].length, 0);
      assertPreserved(tracker, current);
      assertRetryTime(current.next_check_at, startedAt, finishedAt, 5);
    }

    assert.equal(isShoppingCollectorUnavailable({
      status: 502,
      message: "provider_collection_failed",
      detail: "provider_queue_full",
    }), false);
    assert.equal(isShoppingRankSourceUnavailable("provider_collection_failed:provider_queue_full"), false);
    assert.equal(isShoppingCollectorUnavailable({
      status: 502,
      message: "provider_collection_failed",
      detail: "naver_http_418",
    }), true);
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
});

test("the external shopping collector can supply a complete 300-item organic window", async () => {
  shoppingProviderPageCache.clear();
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[24] = shoppingResultItem(24, {
    productId: "57907660073",
    link: "https://search.shopping.naver.com/catalog/57907660073",
    title: "라이브오랄스 음파 전동칫솔 원부",
    productType: "1",
  });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    if (String(input) !== "https://collector.example/rank") {
      return new Response("", { status: 404 });
    }
    const body = JSON.parse(options.body || "{}");
    requests.push(body);
    return new Response(JSON.stringify(collectorWindow(body.keyword, items, { limit: body.limit })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await findShoppingRank({
      mode: "provider",
      providerUrl: "https://collector.example/rank",
      providerKey: "collector-key",
    }, {
      keyword: "음파 전동칫솔",
      targetUrl: "https://search.shopping.naver.com/catalog/57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 25);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.complete, true);
    assert.equal(result.source, "naver_shopping_results_collector");
    assert.equal(result.rankEvidence, "naver_shopping_organic_list");
    assert.equal(result.collectionId, "test-collection-1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].limit, 300);
    assert.equal(requests[0].schemaVersion, NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA);

    const second = await findShoppingRank({
      mode: "provider",
      providerUrl: "https://collector.example/rank",
      providerKey: "collector-key",
    }, {
      keyword: "음파 전동칫솔",
      targetUrl: "https://search.shopping.naver.com/catalog/99999999999",
      maxRank: 300,
    });
    assert.equal(second.matched, false);
    assert.equal(second.checkedCount, 300);
    assert.equal(second.complete, true);
    assert.equal(requests.length, 1);
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
});

test("a valid not-found response still records a checked snapshot", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => ({
      matched: false,
      rank: null,
      checkedCount: 300,
      total: 300,
      complete: true,
      source: "naver_shopping_results_collector",
      rankEvidence: "naver_shopping_organic_list",
      collectionId: "test-complete-miss",
      collectedAt: "2026-08-01T00:00:00.000Z",
      productExposureItems: [],
      topItems: [],
    }),
  });
  const current = state.tables[TRACKERS][0];

  assert.equal(result.ok, true);
  assert.equal(state.tables[SNAPSHOTS].length, 1);
  assert.equal(state.tables[SNAPSHOTS][0].matched, false);
  assert.equal(state.tables[SNAPSHOTS][0].checked_count, 300);
  assert.equal(state.tables[SNAPSHOTS][0].source, "naver_shopping_results_collector");
  assert.equal(state.tables[SNAPSHOTS][0].item.collectionId, "test-complete-miss");
  assert.equal(current.current_rank, null);
  assert.equal(current.check_count, tracker.check_count + 1);
  assert.notEqual(current.last_checked_at, tracker.last_checked_at);
  assert.equal(current.last_error, null);
  assert.equal(current.retry_count, 0);
});

test("an empty product provider response preserves the last confirmed rank", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => ({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_rank_provider_invalid_response");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, state.tables[TRACKERS][0]);
  assert.equal(state.tables[TRACKERS][0].retry_count, 1);
});

test("a failed create or manual check can serialize a tracker without a snapshot", () => {
  const payload = trackerPayload(trackerRow(), [undefined]);
  assert.deepEqual(payload.snapshots, []);
  assert.equal(payload.currentRank, 27);
});

test("tracker payload keeps the parent-catalog source beside the current rank", () => {
  const tracker = trackerRow({ current_rank: 1, best_rank: 1, worst_rank: 1 });
  const payload = trackerPayload(tracker, [{
    id: "snapshot-related-catalog",
    tracker_id: tracker.id,
    checked_at: new Date().toISOString(),
    rank: 9,
    matched: true,
    checked_count: 300,
    total: 300,
    item: {
      trackingRankSource: "related_catalog",
      trackingRankSourceLabel: "관련 원부 기준",
      relatedCatalogProductId: "59776958987",
      relatedCatalogRelationBasis: "catalog_seller_product_id",
      catalogId: "59776958987",
      catalogSellerProductIds: [tracker.product_id],
    },
    message: "관련 원부 9위",
    source: "naver_shopping_results_collector",
    created_at: new Date().toISOString(),
  }]);

  assert.equal(payload.currentRank, 9);
  assert.equal(payload.currentRankSource, "related_catalog");
  assert.equal(payload.currentRankSourceLabel, "관련 원부 기준");
  assert.equal(payload.bestRank, 9);
  assert.equal(payload.worstRank, 9);
});

test("tracker payload presents an exact catalog target as a parent rank in current and history views", () => {
  const tracker = trackerRow({
    product_id: "59776958987",
    product_url: "https://search.shopping.naver.com/catalog/59776958987",
    current_rank: 9,
    best_rank: 9,
    worst_rank: 9,
  });
  const payload = trackerPayload(tracker, [{
    id: "snapshot-exact-catalog",
    tracker_id: tracker.id,
    checked_at: new Date().toISOString(),
    rank: 9,
    matched: true,
    checked_count: 300,
    total: 300,
    item: {
      productId: tracker.product_id,
      catalogId: tracker.product_id,
      isExactTarget: true,
      isRelatedCatalog: false,
      exposureType: "exact_catalog",
      trackingRankSource: "exact_product",
      trackingRankSourceLabel: "정확 상품 기준",
      rankPolicy: "organic_only",
      adExcluded: true,
    },
    message: "조회 원부 9위",
    source: "naver_shopping_results_collector",
  }]);

  assert.equal(payload.currentRank, 9);
  assert.equal(payload.currentRankSource, "related_catalog");
  assert.equal(payload.currentRankSourceLabel, "원부 기준");
  assert.equal(payload.snapshots[0].item.trackingRankSource, "related_catalog");
  assert.equal(payload.snapshots[0].item.trackingRankSourceLabel, "원부 기준");
  assert.equal(payload.snapshots[0].item.exposureType, "exact_catalog");
});

test("tracker payload never promotes an exact-catalog-shaped item without the exact tracker id", () => {
  const checkedAt = new Date().toISOString();
  const item = {
    productId: "59776958987",
    catalogId: "59776958987",
    isExactTarget: true,
    isRelatedCatalog: false,
    exposureType: "exact_catalog",
    trackingRankSource: "exact_product",
    trackingRankSourceLabel: "정확 상품 기준",
    rankPolicy: "organic_only",
    adExcluded: true,
  };
  const snapshot = {
    id: "snapshot-spoofed-exact-catalog",
    tracker_id: "tracker-exact-catalog",
    checked_at: checkedAt,
    rank: 9,
    matched: true,
    checked_count: 300,
    total: 300,
    item,
    message: "조회 원부 9위",
    source: "naver_shopping_results_collector",
  };

  const mismatched = trackerPayload(trackerRow({
    id: snapshot.tracker_id,
    product_id: "13327339525",
  }), [snapshot]);
  assert.equal(mismatched.currentRankSource, "exact_product");
  assert.equal(mismatched.currentRankSourceLabel, "정확 상품 기준");
  assert.equal(mismatched.snapshots[0].item.trackingRankSource, "exact_product");

  const missing = trackerPayload(trackerRow({
    id: snapshot.tracker_id,
    product_id: "",
  }), [snapshot]);
  assert.equal(missing.currentRankSource, "exact_product");
  assert.equal(missing.currentRankSourceLabel, "정확 상품 기준");
  assert.equal(missing.snapshots[0].item.trackingRankSource, "exact_product");
});

test("tracker payload hides inferred parent history and falls back to the last direct-id rank", () => {
  const tracker = trackerRow({ current_rank: 1, best_rank: 1, product_id: "13327339525" });
  const now = Date.now();
  const inferred = {
    id: "snapshot-inferred-parent",
    tracker_id: tracker.id,
    checked_at: new Date(now).toISOString(),
    rank: 1,
    matched: true,
    checked_count: 300,
    total: 300,
    item: {
      trackingRankSource: "related_catalog",
      trackingRankSourceLabel: "관련 원부 기준",
      relatedCatalogProductId: "59776958987",
      relatedCatalogRank: 1,
      relatedCatalogRelationBasis: "model_brand_category",
      catalogId: "59776958987",
      catalogSellerProductIds: ["99999999999"],
      rankPolicy: "organic_only",
      adExcluded: true,
    },
    source: "naver_shopping_results_collector",
    message: "추론 원부 1위",
  };
  const direct = {
    ...inferred,
    id: "snapshot-direct-parent",
    checked_at: new Date(now - 60_000).toISOString(),
    rank: 9,
    item: {
      ...inferred.item,
      relatedCatalogRank: 9,
      relatedCatalogRelationBasis: "catalog_seller_product_id",
      catalogSellerProductIds: [tracker.product_id],
    },
    message: "직접 ID 원부 9위",
  };

  const payload = trackerPayload(tracker, [inferred, direct]);
  assert.equal(payload.currentRank, 9);
  assert.equal(payload.currentRankSource, "related_catalog");
  assert.equal(payload.currentRankSourceLabel, "관련 원부 기준");
  assert.equal(payload.bestRank, 9);
  assert.equal(payload.worstRank, 9);
  assert.equal(payload.lastCheckedAt, direct.checked_at);
  assert.equal(payload.lastMessage, "직접 ID 원부 9위");
  assert.deepEqual(payload.snapshots.map((snapshot) => snapshot.id), ["snapshot-direct-parent"]);

  const untrustedOnly = trackerPayload(tracker, [inferred]);
  assert.equal(untrustedOnly.currentRank, null);
  assert.equal(untrustedOnly.currentRankSource, "");
  assert.equal(untrustedOnly.currentRankSourceLabel, "");
  assert.equal(untrustedOnly.bestRank, null);
  assert.equal(untrustedOnly.worstRank, null);
  assert.equal(untrustedOnly.lastCheckedAt, null);
  assert.equal(untrustedOnly.lastMessage, null);
  assert.deepEqual(untrustedOnly.snapshots, []);
});

test("product rank history keeps up to 120 snapshots from the most recent 30 days", () => {
  const now = Date.now();
  const recent = Array.from({ length: 121 }, (_, index) => ({
    id: `recent-${index}`,
    tracker_id: "tracker-1",
    checked_at: new Date(now - index * 60 * 60 * 1000).toISOString(),
    rank: index + 1,
    matched: true,
    checked_count: 300,
    total: 300,
    item: {},
    message: "ok",
    source: "test",
    created_at: new Date(now).toISOString(),
  }));
  const older = {
    ...recent[0],
    id: "older-than-30-days",
    checked_at: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const payload = trackerPayload(trackerRow(), [...recent, older]);
  assert.equal(payload.snapshots.length, 120);
  assert.equal(payload.snapshots[0].id, "recent-0");
  assert.equal(payload.snapshots.at(-1).id, "recent-119");
  assert.equal(payload.snapshots.some((snapshot) => snapshot.id === "older-than-30-days"), false);
});

test("product snapshot loading paginates beyond 5000 rows without truncating tracker histories", async () => {
  const now = Date.now();
  const trackerIds = Array.from({ length: 60 }, (_, index) => `tracker-${index}`);
  const rows = trackerIds.flatMap((trackerId, trackerIndex) => {
    const count = trackerIndex === 0 ? 130 : 100;
    const recent = Array.from({ length: count }, (_, snapshotIndex) => ({
      id: `${trackerId}-recent-${snapshotIndex}`,
      tracker_id: trackerId,
      checked_at: new Date(now - snapshotIndex * 60 * 60 * 1000).toISOString(),
    }));
    return [...recent, {
      id: `${trackerId}-old`,
      tracker_id: trackerId,
      checked_at: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
    }];
  });
  const { ctx, state } = pagedProductSnapshotContext(rows, { serverCap: 250 });

  const grouped = await loadProductSnapshots(ctx, trackerIds);
  assert.equal(grouped.get("tracker-0").length, 120);
  trackerIds.slice(1).forEach((trackerId) => assert.equal(grouped.get(trackerId).length, 100));
  assert.equal(Array.from(grouped.values()).reduce((sum, snapshots) => sum + snapshots.length, 0), 6020);
  assert.ok(state.ranges.length > 20);
  assert.equal(Array.from(grouped.values()).flat().some((snapshot) => snapshot.id.endsWith("-old")), false);
});

test("product snapshot pagination fails instead of returning a silently incomplete page", async () => {
  const now = Date.now();
  const rows = [
    ...Array.from({ length: 1000 }, (_, index) => ({
      id: `dominant-${index}`,
      tracker_id: "tracker-dominant",
      checked_at: new Date(now - index * 1000).toISOString(),
    })),
    {
      id: "later-tracker-row",
      tracker_id: "tracker-later",
      checked_at: new Date(now - 2000 * 1000).toISOString(),
    },
  ];
  const { ctx } = pagedProductSnapshotContext(rows, { stall: true });

  await assert.rejects(
    loadProductSnapshots(ctx, ["tracker-dominant", "tracker-later"]),
    /rank_snapshot_pagination_stalled/,
  );
});

test("a prior catalog id alone cannot reconstruct a current parent relationship", async () => {
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[14] = shoppingResultItem(14, {
    productId: "57907660073",
    link: "https://search.shopping.naver.com/catalog/57907660073",
    title: "라이브오랄스 오라원 회전법 음파전동칫솔 진동 C타입 충전식",
    mallName: "네이버",
    brand: "라이브오랄스",
    maker: "라이브오랄스",
    category2: "구강청정기기",
    productType: "1",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "음파 전동칫솔",
      targetProductId: "12649811979",
      verifiedRelatedCatalogId: "57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, false);
    assert.equal(result.rank, null);
    assert.equal(result.trackingRankSource, undefined);
    assert.equal(result.relatedCatalogContinuityUsed, false);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.targetCatalogId, "57907660073");
    assert.equal(result.productExposureItems, undefined);
  });
});

test("shopping lookup bootstraps a folded parent catalog from its exact seller-product id", async () => {
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[8] = shoppingResultItem(8, {
    productId: "59776958987",
    catalogId: "59776958987",
    link: "https://search.shopping.naver.com/catalog/59776958987",
    title: "아이쉘 차량용 거치대 원부",
    mallName: "네이버",
    brand: "아이쉘",
    category2: "차량용휴대폰용품",
    productType: "1",
    catalogSellerProductIds: ["13327339525"],
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "아이쉘 차량용 거치대",
      targetProductId: "13327339525",
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 9);
    assert.equal(result.exactProductRank, null);
    assert.equal(result.relatedCatalogRank, 9);
    assert.equal(result.trackingRankSource, "related_catalog");
    assert.equal(result.trackingRankSourceLabel, "원부 기준");
    const tracking = selectRepresentativeTrackingRank(result);
    assert.equal(tracking.relatedCatalogProductId, "59776958987");
    assert.equal(tracking.relatedCatalogRelationBasis, "catalog_seller_product_id");
    assert.equal(tracking.trackingRankSource, "related_catalog");
    assert.equal(tracking.trackingRankSourceLabel, "관련 원부 기준");
  });
});

test("legacy representative fallback requires exact numeric relation evidence", () => {
  const targetProductId = "12149720593";
  const base = {
    matched: true,
    rank: 7,
    exactProductRank: 7,
    trackingRankSource: "exact_product",
    matchedProductId: targetProductId,
    item: {
      rank: 7,
      isOrganic: true,
      isAd: false,
      mallName: "동일 판매처",
      title: "동일 상품명",
    },
  };

  const weak = selectRepresentativeTrackingRank({
    ...base,
    matchEvidence: "mall_title",
  }, targetProductId);
  assert.equal(weak.matched, false);
  assert.equal(weak.rank, null);
  assert.equal(weak.trackingRankSource, "not_found");

  const wrongId = selectRepresentativeTrackingRank({
    ...base,
    matchedProductId: "99999999999",
    matchEvidence: "seller_link_product_id",
  }, targetProductId);
  assert.equal(wrongId.matched, false);
  assert.equal(wrongId.rank, null);

  const direct = selectRepresentativeTrackingRank({
    ...base,
    matchEvidence: "seller_link_product_id",
  }, targetProductId);
  assert.equal(direct.matched, true);
  assert.equal(direct.rank, 7);
  assert.equal(direct.trackingRankSource, "exact_product");
});

test("shopping lookup compares the exact seller product and verified catalog in one 300-result pass", async () => {
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[23] = shoppingResultItem(23, {
    productId: "57907660073",
    catalogId: "57907660073",
    link: "https://search.shopping.naver.com/catalog/57907660073",
    title: "라이브오랄스 오라원 회전법 음파전동칫솔",
    mallName: "네이버",
    brand: "라이브오랄스",
    category2: "구강청정기기",
    productType: "1",
    catalogSellerProductIds: ["12649811979"],
  });
  items[167] = shoppingResultItem(167, {
    productId: "98765432101",
    link: "https://smartstore.naver.com/lav/products/12649811979",
    title: "라이브오랄스 음파 전동칫솔 회전 IPX8 방수",
    mallName: "라이브오랄스",
    brand: "라이브오랄스",
    category2: "구강청정기기",
    productType: "3",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "전동칫솔",
      targetProductId: "12649811979",
      verifiedRelatedCatalogId: "57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 24);
    assert.equal(result.exactProductRank, 168);
    assert.equal(result.relatedCatalogRank, 24);
    assert.equal(result.trackingRankSource, "related_catalog");
    assert.equal(result.checkedCount, 300);
    assert.deepEqual(result.productExposureItems.map((item) => item.productId), [
      "57907660073",
      "98765432101",
    ]);
  });
});

test("shopping lookup ignores a stored catalog when the exact item is an unmatched single product", async () => {
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[2] = shoppingResultItem(2, {
    productId: "59031763223",
    link: "https://search.shopping.naver.com/catalog/59031763223",
    title: "한일의료기 프리볼트 전기 온열 찜질기 원적외선 찜질팩",
    mallName: "네이버",
    brand: "한일의료기",
    maker: "한일의료기",
    category2: "냉온/찜질용품",
    productType: "1",
  });
  items[75] = shoppingResultItem(75, {
    productId: "89694231298",
    link: "https://smartstore.naver.com/haedenprime/products/12149720593",
    title: "일신한일의료기 온열찜질기 허리찜질팩 원적외선 전기 어깨 복부 배 M",
    mallName: "소노팜스토어",
    brand: "한일의료기",
    maker: "한일의료기",
    category2: "냉온/찜질용품",
    productType: "2",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "온열찜질기",
      targetProductId: "12149720593",
      verifiedRelatedCatalogId: "59031763223",
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 76);
    assert.equal(result.exactProductRank, 76);
    assert.equal(result.relatedCatalogRank, null);
    assert.equal(result.trackingRankSource, "exact_product");
    assert.equal(result.verifiedRelatedCatalogId, null);
    assert.equal(result.relatedCatalogContinuityUsed, false);
    assert.deepEqual(result.productExposureItems.map((item) => item.productId), ["89694231298"]);
  });
});

test("shopping lookup never labels another linked seller as the related catalog", async () => {
  const sharedCatalogId = "59031763223";
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[2] = shoppingResultItem(2, {
    productId: "89694230003",
    sellerProductId: "13000000003",
    catalogId: sharedCatalogId,
    linkedCatalogId: sharedCatalogId,
    link: "https://smartstore.naver.com/other-store/products/13000000003",
    title: "같은 원부에 연결된 다른 판매처 상품",
    productType: "3",
  });
  items[75] = shoppingResultItem(75, {
    productId: "89694231298",
    sellerProductId: "12149720593",
    catalogId: sharedCatalogId,
    linkedCatalogId: sharedCatalogId,
    link: "https://smartstore.naver.com/haedenprime/products/12149720593",
    title: "일신한일의료기 온열찜질기",
    productType: "3",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "온열찜질기",
      targetProductId: "12149720593",
      verifiedRelatedCatalogId: sharedCatalogId,
      maxRank: 300,
    });
    assert.equal(result.matched, true);
    assert.equal(result.rank, 76);
    assert.equal(result.exactProductRank, 76);
    assert.equal(result.relatedCatalogRank, null);
    assert.equal(result.trackingRankSource, "exact_product");
    assert.equal(result.productExposureItems.some((item) => item.rank === 3), false);
  });
});

test("shopping lookup prefers the current linked catalog over stale snapshot continuity", async () => {
  const staleCatalogId = "59031763223";
  const currentCatalogId = "59031769999";
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[2] = shoppingResultItem(2, {
    productId: "91000000003",
    sellerProductId: undefined,
    catalogId: staleCatalogId,
    linkedCatalogId: staleCatalogId,
    link: "",
    title: "과거에 잘못 연결된 다른 원부",
    productType: "1",
  });
  items[75] = shoppingResultItem(75, {
    productId: "89694231298",
    sellerProductId: "12149720593",
    catalogId: currentCatalogId,
    linkedCatalogId: currentCatalogId,
    link: "https://smartstore.naver.com/haedenprime/products/12149720593",
    title: "일신한일의료기 온열찜질기",
    productType: "3",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "온열찜질기",
      targetProductId: "12149720593",
      verifiedRelatedCatalogId: staleCatalogId,
      maxRank: 300,
    });
    assert.equal(result.rank, 76);
    assert.equal(result.relatedCatalogRank, null);
    assert.equal(result.trackingRankSource, "exact_product");
    assert.equal(result.targetCatalogId, currentCatalogId);
    assert.equal(result.relatedCatalogContinuityUsed, false);
  });
});

test("shopping lookup still selects a real current catalog above its exact seller product", async () => {
  const sharedCatalogId = "59031763223";
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[2] = shoppingResultItem(2, {
    productId: "91000000003",
    sellerProductId: undefined,
    catalogId: sharedCatalogId,
    linkedCatalogId: sharedCatalogId,
    link: "",
    title: "한일의료기 온열찜질기 원부",
    productType: "1",
    catalogSellerProductIds: ["12149720593"],
  });
  items[75] = shoppingResultItem(75, {
    productId: "89694231298",
    sellerProductId: "12149720593",
    catalogId: sharedCatalogId,
    linkedCatalogId: sharedCatalogId,
    link: "https://smartstore.naver.com/haedenprime/products/12149720593",
    title: "일신한일의료기 온열찜질기",
    productType: "3",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "온열찜질기",
      targetProductId: "12149720593",
      verifiedRelatedCatalogId: "59031760000",
      maxRank: 300,
    });
    assert.equal(result.rank, 3);
    assert.equal(result.exactProductRank, 76);
    assert.equal(result.relatedCatalogRank, 3);
    assert.equal(result.trackingRankSource, "related_catalog");
    assert.equal(result.relatedCatalogIds[0], sharedCatalogId);
  });
});

test("shopping lookup rejects an atomic partial window at the main trust boundary", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => shoppingResultItem(index));
  firstPage[9] = shoppingResultItem(9, {
    productId: "98765432101",
    link: "https://smartstore.naver.com/lav/products/12649811979",
    title: "라이브오랄스 음파 전동칫솔",
    mallName: "라이브오랄스",
    productType: "3",
  });
  const originalFetch = globalThis.fetch;
  shoppingProviderPageCache.clear();
  globalThis.fetch = async (input, options = {}) => {
    assert.equal(String(input), COLLECTOR_ENV.providerUrl);
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body || "{}");
    return new Response(JSON.stringify(collectorWindow(body.keyword, firstPage, {
      limit: body.limit,
      complete: false,
      sourceExhausted: false,
      marketTotal: 500,
    })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      findShoppingRank(COLLECTOR_ENV, {
        keyword: "전동칫솔",
        targetProductId: "12649811979",
        verifiedRelatedCatalogId: "57907660073",
        maxRank: 300,
      }),
      /shopping_rank_provider_untrusted_evidence/,
    );
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
});

test("shopping lookup never substitutes a title-similar catalog for the verified catalog id", async () => {
  const items = Array.from({ length: 300 }, (_, index) => shoppingResultItem(index));
  items[4] = shoppingResultItem(4, {
    productId: "99999999999",
    link: "https://search.shopping.naver.com/catalog/99999999999",
    title: "라이브오랄스 오라원 회전법 음파전동칫솔 진동 C타입 충전식",
    mallName: "네이버",
    brand: "라이브오랄스",
    maker: "라이브오랄스",
    category2: "구강청정기기",
    productType: "1",
  });

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "음파 전동칫솔",
      targetProductId: "12649811979",
      targetMallName: "라이브오랄스",
      targetProductTitle: "라이브오랄스 오라원 회전법 음파전동칫솔 진동 C타입 충전식",
      verifiedRelatedCatalogId: "57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, false);
    assert.equal(result.complete, true);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.verifiedRelatedCatalogId, "57907660073");
    assert.equal(result.relatedCatalogContinuityUsed, false);
  });
});

test("shopping lookup excludes an ad even when it carries the verified catalog id", async () => {
  const items = [
    shoppingResultItem(999, {
      productId: "57907660073",
      link: "https://search.shopping.naver.com/catalog/57907660073",
      productType: "1",
      isAdProduct: true,
    }),
    ...Array.from({ length: 300 }, (_, index) => shoppingResultItem(index)),
  ];

  await withShoppingResults(items, async () => {
    const result = await findShoppingRank(COLLECTOR_ENV, {
      keyword: "음파 전동칫솔",
      targetProductId: "12649811979",
      verifiedRelatedCatalogId: "57907660073",
      maxRank: 300,
    });
    assert.equal(result.matched, false);
    assert.equal(result.complete, true);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.excludedAdCount, 1);
  });
});

test("the real shopping lookup rejects an empty 2xx payload without trusted collector evidence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(
      findShoppingRank(COLLECTOR_ENV, {
        keyword: "테스트 상품",
        targetProductId: "1234567890",
        maxRank: 300,
      }),
      /shopping_rank_provider_untrusted_evidence/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an explicitly partial atomic shopping window is rejected", async () => {
  const originalFetch = globalThis.fetch;
  shoppingProviderPageCache.clear();
  globalThis.fetch = async (_input, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    return new Response(JSON.stringify(collectorWindow(body.keyword, [], {
      limit: body.limit,
      complete: false,
      sourceExhausted: false,
      marketTotal: 500,
      rawCount: 0,
    })), {
    status: 200,
    headers: { "content-type": "application/json" },
    });
  };
  try {
    await assert.rejects(
      findShoppingRank(COLLECTOR_ENV, {
        keyword: "테스트 상품",
        targetProductId: "1234567890",
        maxRank: 300,
      }),
      /shopping_rank_provider_untrusted_evidence/,
    );
  } finally {
    shoppingProviderPageCache.clear();
    globalThis.fetch = originalFetch;
  }
});

test("an incomplete product miss preserves rank and schedules retry", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => ({
      matched: false,
      checkedCount: 62,
      complete: false,
      partial: true,
      productExposureItems: [],
      topItems: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_rank_lookup_incomplete");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, state.tables[TRACKERS][0]);
  assert.equal(state.tables[TRACKERS][0].retry_count, 1);
});

test("an early exact match from an incomplete window never overwrites the last confirmed rank", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => ({
      matched: true,
      rank: 7,
      checkedCount: 100,
      complete: false,
      partial: true,
      source: "naver_shopping_results_collector",
      rankEvidence: "naver_shopping_organic_list",
      collectionId: "partial-match",
      collectedAt: "2026-08-01T00:00:00.000Z",
      productExposureItems: [{ isExactTarget: true, isOrganic: true, isAd: false, rank: 7 }],
      topItems: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "shopping_rank_lookup_incomplete");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assertPreserved(tracker, state.tables[TRACKERS][0]);
});

test("a fully exhausted short product result is a valid not-found check", async () => {
  const tracker = trackerRow();
  const { ctx, state } = testContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => ({
      matched: false,
      checkedCount: 50,
      total: 50,
      complete: true,
      partial: false,
      productExposureItems: [],
      topItems: [],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(state.tables[SNAPSHOTS].length, 1);
  assert.equal(state.tables[TRACKERS][0].current_rank, null);
  assert.equal(state.tables[TRACKERS][0].check_count, tracker.check_count + 1);
});

test("a stale product-rank lease cannot insert a snapshot", async () => {
  const tracker = trackerRow({ processing_started_at: "2026-07-16T00:00:00.000Z" });
  const { ctx, state } = testContext(tracker);

  await assert.rejects(
    runTrackerCheck(ctx, tracker, {
      env: COLLECTOR_ENV,
      leaseStartedAt: "2026-07-16T00:05:00.000Z",
      findShoppingRank: async () => ({
        matched: true,
        rank: 9,
        checkedCount: 9,
        complete: true,
        productExposureItems: [{ isExactTarget: true, isOrganic: true, rank: 9 }],
      }),
    }),
    /rank_tracker_lease_lost/,
  );

  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.updates.length, 0);
  assert.equal(state.tables[TRACKERS][0].current_rank, tracker.current_rank);
});

test("pausing a product tracker invalidates an in-flight lease before snapshot", async () => {
  const leaseStartedAt = "2026-07-16T00:00:00.000Z";
  const tracker = trackerRow({ processing_started_at: leaseStartedAt });
  const { ctx, state } = testContext(tracker);

  await assert.rejects(
    runTrackerCheck(ctx, tracker, {
      env: COLLECTOR_ENV,
      leaseStartedAt,
      findShoppingRank: async () => {
        state.tables[TRACKERS][0].status = "paused";
        state.tables[TRACKERS][0].processing_started_at = null;
        return {
          matched: true,
          rank: 9,
          checkedCount: 9,
          complete: true,
          productExposureItems: [{ isExactTarget: true, isOrganic: true, rank: 9 }],
        };
      },
    }),
    /rank_tracker_lease_lost/,
  );

  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.tables[TRACKERS][0].status, "paused");
  assert.equal(state.tables[TRACKERS][0].current_rank, tracker.current_rank);
});

test("missing product-rank lease columns fail closed", async () => {
  const query = {
    update() { return this; },
    eq() { return this; },
    lte() { return this; },
    or() { return this; },
    select() { return this; },
    async maybeSingle() {
      return {
        data: null,
        error: { message: "Could not find the processing_started_at column in the schema cache" },
      };
    },
  };
  const ctx = { supabaseAdmin: { from: () => query } };

  await assert.rejects(
    claimDueTracker(ctx, trackerRow(), "2026-07-16T00:00:00.000Z"),
    (error) => error?.code === "RANK_TRACKER_LEASE_SCHEMA_MISSING",
  );
});

test("a missing collector circuit-breaks the due queue without claiming or updating rows", async () => {
  let queryCount = 0;
  let updateCalled = false;
  const ctx = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, TRACKERS);
        queryCount += 1;
        const query = {
          select() { return query; },
          eq() { return query; },
          lte() { return query; },
          or() { return query; },
          in() { return query; },
          update() {
            updateCalled = true;
            return query;
          },
          then(resolve, reject) {
            return Promise.resolve({ data: null, error: null, count: 25 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };

  const summary = await runDueTrackers(ctx, { env: LEGACY_ENV, limit: 25 });

  assert.equal(summary.configured, false);
  assert.equal(summary.rankSourceReady, false);
  assert.equal(summary.errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
  assert.equal(summary.retryable, false);
  assert.equal(summary.checked, 0);
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.remaining, 25);
  assert.equal(summary.remainingCount, 25);
  assert.equal(summary.drained, false);
  assert.deepEqual(summary.results, []);
  assert.equal(queryCount, 1);
  assert.equal(updateCalled, false);
});

test("a configured but unready collector stops the due queue after the first claimed tracker", async () => {
  const first = trackerRow({ id: "tracker-1" });
  const second = trackerRow({ id: "tracker-2", product_id: "1234567891" });
  const { ctx, state } = testContext(first);
  state.tables[TRACKERS].push(second);
  let checkCalls = 0;

  const summary = await runDueTrackers(ctx, {
    env: COLLECTOR_ENV,
    limit: 2,
    runTrackerCheck: async (_ctx, tracker) => {
      checkCalls += 1;
      tracker.next_check_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      return {
        ok: false,
        tracker,
        message: "수집원 준비 확인이 필요합니다.",
        errorCode: "SHOPPING_RANK_SOURCE_UNAVAILABLE",
        retryable: false,
        configured: true,
        rankSourceReady: false,
      };
    },
  });

  assert.equal(checkCalls, 1);
  assert.equal(summary.configured, true);
  assert.equal(summary.rankSourceReady, false);
  assert.equal(summary.errorCode, "SHOPPING_RANK_SOURCE_UNAVAILABLE");
  assert.equal(summary.retryable, false);
  assert.equal(summary.checked, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.remaining, 1);
  assert.equal(state.tables[TRACKERS][1].processing_started_at, undefined);
});

test("collector authentication and configuration failures stop before claiming the second tracker", async () => {
  for (const errorCode of [
    "SHOPPING_RANK_PROVIDER_UNAUTHORIZED",
    "SHOPPING_RANK_PROVIDER_MISCONFIGURED",
  ]) {
    const first = trackerRow({ id: `tracker-first-${errorCode}` });
    const second = trackerRow({ id: `tracker-second-${errorCode}`, product_id: "1234567891" });
    const { ctx, state } = testContext(first);
    state.tables[TRACKERS].push(second);
    let checkCalls = 0;

    const summary = await runDueTrackers(ctx, {
      env: COLLECTOR_ENV,
      limit: 2,
      runTrackerCheck: async (_ctx, tracker) => {
        checkCalls += 1;
        tracker.next_check_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        return {
          ok: false,
          tracker,
          message: "수집원 설정 확인이 필요합니다.",
          errorCode,
          retryable: false,
          configured: true,
          rankSourceReady: false,
        };
      },
    });

    assert.equal(checkCalls, 1, errorCode);
    assert.equal(summary.checked, 1, errorCode);
    assert.equal(summary.failed, 1, errorCode);
    assert.equal(summary.rankSourceReady, false, errorCode);
    assert.equal(summary.errorCode, errorCode, errorCode);
    assert.equal(summary.retryable, false, errorCode);
    assert.equal(summary.remaining, 1, errorCode);
    assert.equal(state.tables[TRACKERS][1].processing_started_at, undefined, errorCode);
  }
});

test("coverage-limited rows are preserved and the due queue drains without failures", async () => {
  const first = trackerRow({ id: "tracker-preserved-1", retry_count: 3, last_error: "old_error" });
  const second = trackerRow({ id: "tracker-preserved-2", product_id: "1234567891", retry_count: 2 });
  const { ctx, state } = testContext(first);
  state.tables[TRACKERS].push(second);
  let checkCalls = 0;

  const summary = await runDueTrackers(ctx, {
    env: { mode: "mobile_top_fallback", mobileTopFallbackOnly: true },
    limit: 2,
    runTrackerCheck: async (_ctx, tracker) => {
      checkCalls += 1;
      tracker.next_check_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      tracker.last_error = null;
      tracker.retry_count = 0;
      return {
        ok: false,
        tracker,
        message: "현재 검증 범위 밖이어서 기존 순위를 유지합니다.",
        errorCode: "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW",
        retryable: false,
        rankSourceReady: true,
        configured: true,
        preserved: true,
        outcome: "preserved",
      };
    },
  });

  assert.equal(checkCalls, 2);
  assert.equal(summary.checked, 2);
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.preserved, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.rankSourceReady, true);
  assert.equal(summary.drained, true);
  assert.equal(summary.remaining, 0);
  assert.deepEqual(summary.results.map((item) => item.outcome), ["preserved", "preserved"]);
  assert.equal(state.tables[TRACKERS].every((tracker) => tracker.retry_count === 0 && tracker.last_error === null), true);
});

test("an empty product-rank due queue reports drained", async () => {
  let queryCount = 0;
  const chain = (result) => ({
    select() { return this; },
    eq() { return this; },
    lte() { return this; },
    or() { return this; },
    order() { return this; },
    limit() { return this; },
    in() { return this; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  });
  const ctx = {
    supabaseAdmin: {
      from() {
        queryCount += 1;
        return chain(queryCount === 1
          ? { data: [], error: null }
          : { data: null, error: null, count: 0 });
      },
    },
  };

  const summary = await runDueTrackers(ctx, { env: COLLECTOR_ENV, limit: 1 });
  assert.equal(summary.checked, 0);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.drained, true);
  assert.equal(queryCount, 2);
});

test("product due refresh stays global for cron and accepts any advertiser scope", async () => {
  function scopeContext() {
    let queryCount = 0;
    const scopes = [];
    const chain = (result) => ({
      select() { return this; },
      eq() { return this; },
      lte() { return this; },
      or() { return this; },
      order() { return this; },
      limit() { return this; },
      in(column, values) {
        scopes.push({ column, values: [...values] });
        return this;
      },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
    });
    return {
      scopes,
      ctx: {
        supabaseAdmin: {
          from() {
            queryCount += 1;
            return chain(queryCount === 1
              ? { data: [], error: null }
              : { data: null, error: null, count: 0 });
          },
        },
      },
    };
  }

  const siteWide = scopeContext();
  const globalSummary = await runDueTrackers(siteWide.ctx, { env: COLLECTOR_ENV, limit: 1 });
  assert.equal(globalSummary.drained, true);
  assert.deepEqual(siteWide.scopes, []);

  const advertiser = scopeContext();
  const scopedSummary = await runDueTrackers(advertiser.ctx, {
    agencyCode: "agency-b02",
    env: COLLECTOR_ENV,
    limit: 1,
  });
  assert.equal(scopedSummary.drained, true);
  assert.deepEqual(advertiser.scopes, [
    { column: "agency_code", values: ["agency-b02"] },
    { column: "agency_code", values: ["agency-b02"] },
  ]);
});

// ─────────────────────────────────────────────────────────────
// 계정별 키워드 등록 한도 (총관리자가 콘솔에서 지정)
//
// 지금까지 두 곳에 50 이 박혀 있었다. 이제 clients.rank_keyword_limit /
// operation_team_codes.rank_keyword_limit 이 있으면 그 값을 쓰고, 컬럼이 없는
// DB(마이그레이션 적용 전)에서는 예전과 똑같이 50 으로 동작해야 한다.
// ─────────────────────────────────────────────────────────────
function quotaTrackerContext(options = {}) {
  const trackerRows = [...(options.trackerRows || [])];
  const activeCount = Number(options.activeCount || 0);
  const state = { quotaLookups: [], wakeSources: [], inserted: [] };

  function trackerQuery() {
    const query = {
      operation: "select",
      values: null,
      head: false,
      select(_columns, opts = {}) {
        query.head = opts.head === true;
        return query;
      },
      insert(values) { query.operation = "insert"; query.values = values; return query; },
      update(values) { query.operation = "update"; query.values = values; return query; },
      eq() { return query; },
      in() { return query; },
      order() { return query; },
      limit() { return query; },
      single() { return query.execute(true); },
      maybeSingle() { return query.execute(true, true); },
      then(resolve, reject) { return query.execute(false).then(resolve, reject); },
      async execute(single, allowMissing = false) {
        if (query.head) return { data: null, error: null, count: activeCount };
        if (query.operation === "insert") {
          if (options.insertError) return { data: null, error: options.insertError };
          const inserted = {
            id: "10000000-0000-4000-8000-0000000000aa",
            current_rank: null,
            best_rank: null,
            worst_rank: null,
            check_count: 0,
            found_count: 0,
            retry_count: 0,
            sort_order: 100,
            created_at: "2026-08-28T00:00:00.000Z",
            updated_at: "2026-08-28T00:00:00.000Z",
            ...query.values,
          };
          state.inserted.push(inserted);
          trackerRows.push(inserted);
          return { data: inserted, error: null };
        }
        if (query.operation === "update") {
          if (options.reactivationError) return { data: null, error: options.reactivationError };
          const target = trackerRows.find((row) => row.status === "paused");
          if (target) target.status = "active";
          return single ? { data: target || null, error: null } : { data: target ? [target] : [], error: null };
        }
        const selected = trackerRows.filter((row) => row.status === "active" || row.status === "paused");
        if (single) return selected.length === 1 ? { data: selected[0], error: null } : (allowMissing ? { data: null, error: null } : { data: null, error: { message: "single row not found" } });
        return { data: selected, error: null };
      },
    };
    return query;
  }

  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        state.wakeSources.push(args?.p_source || name);
        return { data: true, error: null };
      },
      from(table) {
        if (table === TRACKERS) return trackerQuery();
        if (table === "clients") {
          const query = {
            columns: "",
            select(columns) { query.columns = String(columns || ""); return query; },
            eq() { return query; },
            async maybeSingle() {
              // findClientId 와 한도 조회가 같은 표를 본다. 고르는 열로 갈라 본다.
              if (query.columns.includes("rank_keyword_limit")) {
                state.quotaLookups.push("clients");
                if (options.clientQuotaError) return { data: null, error: options.clientQuotaError };
                return { data: options.clientQuotaRow ?? null, error: null };
              }
              return { data: { id: "client-1", status: "active", disconnected_at: null }, error: null };
            },
          };
          return query;
        }
        if (table === "operation_team_codes") {
          const query = {
            select() { return query; },
            eq() { return query; },
            async maybeSingle() {
              state.quotaLookups.push("operation_team_codes");
              return { data: options.teamQuotaRow ?? null, error: null };
            },
          };
          return query;
        }
        assert.equal(table, SNAPSHOTS);
        const query = {
          select() { return query; },
          in() { return query; },
          gte() { return query; },
          lte() { return query; },
          order() { return query; },
          range() { return query; },
          then(resolve, reject) {
            return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };
  return { ctx, state };
}

function quotaCreateBody(overrides = {}) {
  return { action: "create", keyword: "한도 시험 키워드", productId: "9876543210", ...overrides };
}

function productOwnerRequest(method, body) {
  return new Request("https://example.com/api/naver-rank-trackers", {
    method,
    headers: {
      "content-type": "application/json",
      "x-demo-admin-code": "owner-quota-test-code",
      "x-mi-agency-code": "mml93-a01",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("총관리자가 올려 준 한도만큼 상품 순위 키워드를 더 등록할 수 있다", async () => {
  const { ctx, state } = quotaTrackerContext({ activeCount: 60, clientQuotaRow: { rank_keyword_limit: 100 } });
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", quotaCreateBody()),
    ctx,
  ));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.ok, true);
  // 광고주 행이 값을 갖고 있으면 운영팀 표는 보지 않는다.
  assert.deepEqual(state.quotaLookups, ["clients"]);
});

test("registration never reuses a legacy row whose product id conflicts with its URL", async () => {
  const corruptRow = trackerRow({
    id: "10000000-0000-4000-8000-0000000000ab",
    keyword: "한도 시험 키워드",
    product_id: "99999999999",
    product_url: "https://smartstore.naver.com/example/products/9876543210",
    status: "active",
  });
  const { ctx, state } = quotaTrackerContext({
    activeCount: 1,
    clientQuotaRow: { rank_keyword_limit: 100 },
    trackerRows: [corruptRow],
  });
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", quotaCreateBody({
      productUrl: "https://smartstore.naver.com/example/products/9876543210",
    })),
    ctx,
  ));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(state.inserted.length, 1);
  assert.equal(state.inserted[0].product_id, "9876543210");
});

test("registration reuses a valid legacy seller URL-only row", async () => {
  const productUrl = "https://smartstore.naver.com/example/products/9876543210";
  const legacyRow = trackerRow({
    id: "10000000-0000-4000-8000-0000000000ac",
    agency_code: "mml93-t01",
    keyword: "한도 시험 키워드",
    product_id: null,
    product_url: productUrl,
    status: "active",
  });
  const { ctx, state } = quotaTrackerContext({
    activeCount: 1,
    clientQuotaRow: { rank_keyword_limit: 100 },
    trackerRows: [legacyRow],
  });
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", quotaCreateBody({
      productId: undefined,
      productUrl,
    })),
    ctx,
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.tracker.id, legacyRow.id);
  assert.equal(state.inserted.length, 0);
});

test("registration does not reuse the same numeric id across product and catalog modes", async () => {
  const catalogRow = trackerRow({
    id: "10000000-0000-4000-8000-0000000000ad",
    agency_code: "mml93-t01",
    keyword: "한도 시험 키워드",
    product_id: "9876543210",
    product_url: "https://search.shopping.naver.com/catalog/9876543210",
    status: "active",
  });
  const { ctx, state } = quotaTrackerContext({
    activeCount: 1,
    clientQuotaRow: { rank_keyword_limit: 100 },
    trackerRows: [catalogRow],
  });
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", quotaCreateBody({
      productId: "9876543210",
      productUrl: undefined,
    })),
    ctx,
  ));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(state.inserted.length, 1);
  assert.notEqual(body.tracker.id, catalogRow.id);
  assert.equal(state.inserted[0].product_id, "9876543210");
  assert.equal(state.inserted[0].product_url, null);
});

test("한도를 다 쓴 계정은 실제 한도 숫자와 다음 방법을 담은 403 을 받는다", async () => {
  const { ctx } = quotaTrackerContext({ activeCount: 100, clientQuotaRow: { rank_keyword_limit: 100 } });
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", quotaCreateBody()),
    ctx,
  ));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "RANK_KEYWORD_LIMIT_REACHED");
  assert.equal(body.limit, 100);
  assert.equal(body.count, 100);
  assert.ok(body.message.includes("100개"));
  assert.equal(body.message, "키워드 등록 한도 100개를 모두 사용했습니다. 한도 상향이 필요하시면 관리자에게 문의해주세요.");
});

test("한도 컬럼이 없는 DB 에서는 예전과 똑같이 50 에서 막힌다", async () => {
  const { ctx } = quotaTrackerContext({
    activeCount: 50,
    clientQuotaError: { code: "42703", message: "column clients.rank_keyword_limit does not exist" },
  });
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", quotaCreateBody()),
    ctx,
  ));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.limit, 50);
  assert.equal(body.code, "RANK_KEYWORD_LIMIT_REACHED");
});

test("총관리자 코드는 한도를 조회하지도 않고 계속 무제한이다", async () => {
  const previousAdminCode = process.env.MI_RANK_ADMIN_CODE;
  const previousPrimary = process.env.MI_PRIMARY_AGENCY_CODE;
  process.env.MI_RANK_ADMIN_CODE = "owner-quota-test-code";
  process.env.MI_PRIMARY_AGENCY_CODE = "mml93-a01";
  try {
    const { ctx, state } = quotaTrackerContext({ activeCount: 500 });
    const response = await withShoppingHybrid(() => handleRankTrackersRequest(
      productOwnerRequest("POST", quotaCreateBody()),
      ctx,
    ));
    assert.equal(response.status, 201);
    assert.deepEqual(state.quotaLookups, []);
  } finally {
    if (previousAdminCode === undefined) delete process.env.MI_RANK_ADMIN_CODE;
    else process.env.MI_RANK_ADMIN_CODE = previousAdminCode;
    if (previousPrimary === undefined) delete process.env.MI_PRIMARY_AGENCY_CODE;
    else process.env.MI_PRIMARY_AGENCY_CODE = previousPrimary;
  }
});

test("일시중지 추적 재개가 DB 한도에 막히면 500 이 아니라 같은 안내로 돌아온다", async () => {
  // reactivatePausedTracker 는 JS 개수 검사보다 먼저 paused → active 를 뒤집어서
  // 트리거(P0001)만이 막는다. 한도를 낮춘 계정에서 여기가 500 이 되면 안 된다.
  const { ctx } = quotaTrackerContext({
    activeCount: 200,
    clientQuotaRow: { rank_keyword_limit: 200 },
    trackerRows: [{
      id: "10000000-0000-4000-8000-0000000000bb",
      agency_code: "mml93-t01",
      keyword: "한도 시험 키워드",
      product_id: "9876543210",
      product_url: null,
      mall_name: null,
      status: "paused",
    }],
    reactivationError: { code: "P0001", message: "키워드 등록 한도 200개를 모두 사용했습니다. 한도 상향이 필요하시면 관리자에게 문의해주세요." },
  });
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", quotaCreateBody()),
    ctx,
  ));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "RANK_KEYWORD_LIMIT_REACHED");
  assert.equal(body.limit, 200);
  assert.ok(body.message.includes("관리자에게 문의해주세요"));
});

test("등록 순간 트리거와 부딪혀도(경합) 같은 403 안내로 내려간다", async () => {
  const { ctx } = quotaTrackerContext({
    activeCount: 99,
    clientQuotaRow: { rank_keyword_limit: 100 },
    insertError: { code: "P0001", message: "키워드 등록 한도 100개를 모두 사용했습니다. 한도 상향이 필요하시면 관리자에게 문의해주세요." },
  });
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", quotaCreateBody()),
    ctx,
  ));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "RANK_KEYWORD_LIMIT_REACHED");
  assert.equal(body.limit, 100);
  assert.equal(body.count, 99);
});

// ─────────────────────────────────────────────────────────────
// 한도를 현재 활성 개수보다 낮게 내려 잡은 계정
//
// 총관리자가 한도를 12 → 10 으로 내리면 이미 활성인 12건은 그대로 돌아야 한다.
// 한도는 '새로 활성이 되는 순간'에만 걸리는 문이지, 기존 행의 갱신을 멈추는
// 스위치가 아니다. 수집기(updateTrackerAfterCheck)는 회차마다 status 를 다시
// 써넣는데 그 칼럼에 DB 트리거가 걸려 있어, 서버·DB 양쪽 모두 전환일 때만
// 세어야 한다. 아래 두 시험은 그 한 쌍(기존 갱신 통과 / 신규 활성 차단)이다.
// ─────────────────────────────────────────────────────────────
function overQuotaCollectorContext(tracker) {
  const base = testContext(tracker);
  base.state.quotaLookups = [];
  return {
    state: base.state,
    ctx: {
      supabaseAdmin: {
        from(table) {
          if (table === "clients" || table === "operation_team_codes") {
            base.state.quotaLookups.push(table);
            throw new Error(`수집 갱신 경로가 한도 표(${table})를 조회했다`);
          }
          return base.ctx.supabaseAdmin.from(table);
        },
      },
    },
  };
}

test("한도를 내려 잡아도 이미 활성인 상품 추적의 수집 갱신은 그대로 성공한다", async () => {
  const tracker = trackerRow({ id: "over-quota-active", agency_code: "mml93-t01" });
  const { ctx, state } = overQuotaCollectorContext(tracker);

  const result = await runTrackerCheck(ctx, tracker, {
    env: COLLECTOR_ENV,
    findShoppingRank: async () => ({
      matched: true,
      rank: 12,
      checkedCount: 300,
      total: 300,
      complete: true,
      partial: false,
      source: "naver_shopping_results_collector",
      rankEvidence: "naver_shopping_organic_list",
      collectionId: "over-quota-collection",
      productExposureItems: [{
        rank: 12,
        productId: tracker.product_id,
        title: tracker.product_title,
        isExactTarget: true,
        isOrganic: true,
      }],
      topItems: [],
    }),
  });

  assert.equal(result.ok, true);
  // 갱신 경로는 한도를 조회하지도 않는다. 조회했다면 위 컨텍스트가 던져서 ok 가 false 다.
  assert.deepEqual(state.quotaLookups, []);
  assert.equal(state.tables[SNAPSHOTS].length, 1);

  const current = state.tables[TRACKERS][0];
  assert.equal(current.status, "active");
  assert.equal(current.current_rank, 12);
  assert.equal(current.check_count, tracker.check_count + 1);
  assert.notEqual(current.last_checked_at, tracker.last_checked_at);

  // 트리거가 걸린 status 칼럼을 값이 같아도 매번 다시 대입한다. `update of status` 는
  // 이 대입만으로 깨어나므로, DB 쪽 게이트도 '전환일 때만' 이어야 한다.
  const trackerUpdate = state.updates.find((entry) => entry.table === TRACKERS);
  assert.equal(trackerUpdate.values.status, "active");
});

test("한도를 내려 잡은 같은 계정에서 새 상품 키워드 등록만 403 으로 막힌다", async () => {
  const { ctx } = quotaTrackerContext({ activeCount: 12, clientQuotaRow: { rank_keyword_limit: 10 } });
  const response = await withShoppingHybrid(() => handleRankTrackersRequest(
    productTeamAccountRequest("POST", quotaCreateBody()),
    ctx,
  ));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "RANK_KEYWORD_LIMIT_REACHED");
  assert.equal(body.limit, 10);
  assert.equal(body.count, 12);
});

// ---------------------------------------------------------------------------
// C1 결함 A — 키워드 검색량 조회: 청크·동시성·백오프·시간상한·캐시
// ---------------------------------------------------------------------------

const SEARCHAD_ENV_KEYS = ["NAVER_SEARCHAD_API_KEY", "NAVER_SEARCHAD_SECRET_KEY", "NAVER_SEARCHAD_CUSTOMER_ID"];

async function withSearchAdEnv(callback) {
  const previous = Object.fromEntries(SEARCHAD_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NAVER_SEARCHAD_API_KEY = "test-searchad-key";
  process.env.NAVER_SEARCHAD_SECRET_KEY = "test-searchad-secret";
  process.env.NAVER_SEARCHAD_CUSTOMER_ID = "123456";
  const originalFetch = globalThis.fetch;
  clearKeywordVolumeCache();
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    clearKeywordVolumeCache();
    for (const key of SEARCHAD_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function searchAdHintKeyword(input) {
  return new URL(String(input)).searchParams.get("hintKeywords") || "";
}

function searchAdVolumeResponse(keyword, pc = 100, mobile = 200) {
  return new Response(JSON.stringify({
    keywordList: [{ relKeyword: keyword, monthlyPcQcCnt: pc, monthlyMobileQcCnt: mobile }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("keyword volume lookup queries every unique keyword in small concurrent chunks", async () => {
  await withSearchAdEnv(async () => {
    const keywords = Array.from({ length: 120 }, (_, index) => `청크키워드${index}`);
    const requested = [];
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const keyword = searchAdHintKeyword(input);
      requested.push(keyword);
      await sleepMs(2);
      active -= 1;
      return searchAdVolumeResponse(keyword);
    };

    // 중복 키워드·공백 차이는 한 번만 조회한다.
    const result = await loadKeywordVolumes([...keywords, "청크키워드0", " 청크키워드1 "], { concurrency: 3, budgetMs: 8000 });

    assert.equal(requested.length, 120);
    assert.equal(new Set(requested).size, 120);
    assert.ok(maxActive <= 3, `동시 호출 ${maxActive}건은 상한 3을 넘는다`);
    assert.ok(maxActive >= 2, "청크가 순차로만 돌면 동시성 제한이 무의미하다");
    assert.equal(result.size, 120);
    for (const keyword of keywords) {
      const entry = result.get(keyword.toLowerCase());
      assert.equal(entry.status, "ok");
      assert.equal(entry.value, 300);
      assert.equal(entry.label, "300");
    }
  });
});

test("keyword volume lookup retries 429 and 5xx once with a short backoff and never retries 4xx", async () => {
  await withSearchAdEnv(async () => {
    const calls = new Map();
    const stamps = new Map();
    globalThis.fetch = async (input) => {
      const keyword = searchAdHintKeyword(input);
      const count = (calls.get(keyword) || 0) + 1;
      calls.set(keyword, count);
      stamps.set(keyword, [...(stamps.get(keyword) || []), Date.now()]);
      if (keyword === "재시도성공") {
        if (count === 1) return new Response(JSON.stringify({ code: 429, message: "Too Many Requests" }), { status: 429 });
        return searchAdVolumeResponse(keyword);
      }
      if (keyword === "재시도실패") return new Response(JSON.stringify({ message: "Internal Error" }), { status: 500 });
      if (keyword === "즉시실패") return new Response(JSON.stringify({ message: "Bad Request" }), { status: 400 });
      return searchAdVolumeResponse(keyword);
    };

    const result = await loadKeywordVolumes(["재시도성공", "재시도실패", "즉시실패"], {
      concurrency: 3,
      budgetMs: 8000,
      retryDelayMs: 30,
    });

    assert.equal(calls.get("재시도성공"), 2);
    assert.equal(result.get("재시도성공").status, "ok");
    assert.equal(result.get("재시도성공").value, 300);
    const retryStamps = stamps.get("재시도성공");
    assert.ok(retryStamps[1] - retryStamps[0] >= 25, `백오프 대기 ${retryStamps[1] - retryStamps[0]}ms 가 너무 짧다`);

    assert.equal(calls.get("재시도실패"), 2);
    assert.deepEqual(result.get("재시도실패"), { value: null, label: "조회 필요", status: "error" });

    assert.equal(calls.get("즉시실패"), 1);
    assert.deepEqual(result.get("즉시실패"), { value: null, label: "조회 필요", status: "error" });
  });
});

test("keyword volume lookup stops at the time budget and reports the rest as pending", async () => {
  await withSearchAdEnv(async () => {
    const keywords = Array.from({ length: 12 }, (_, index) => `예산키워드${index}`);
    let requests = 0;
    globalThis.fetch = async (input) => {
      requests += 1;
      await sleepMs(60);
      return searchAdVolumeResponse(searchAdHintKeyword(input));
    };

    const startedAt = Date.now();
    const result = await loadKeywordVolumes(keywords, { concurrency: 2, budgetMs: 150 });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 600, `시간상한 150ms 인데 ${elapsed}ms 걸렸다`);
    assert.equal(result.size, 12, "예산 초과 키워드도 응답에는 포함되어야 한다");
    const statuses = keywords.map((keyword) => result.get(keyword.toLowerCase()));
    const ready = statuses.filter((entry) => entry.status === "ok");
    const pending = statuses.filter((entry) => entry.status === "pending");
    assert.ok(ready.length >= 2, "예산 안에서 끝난 키워드는 정상 값이어야 한다");
    assert.ok(pending.length >= 1, "예산을 넘긴 키워드는 pending 으로 남아야 한다");
    assert.equal(ready.length + pending.length, 12);
    for (const entry of pending) assert.deepEqual(entry, { value: null, label: "조회 중", status: "pending" });
    assert.ok(requests < 12, `예산이 끝난 뒤에도 새 호출을 시작했다 (${requests}건)`);
  });
});

test("cached keyword volumes are served without calling the search-ad API again", async () => {
  await withSearchAdEnv(async () => {
    let requests = 0;
    globalThis.fetch = async (input) => {
      requests += 1;
      return searchAdVolumeResponse(searchAdHintKeyword(input));
    };

    const first = await loadKeywordVolumes(["캐시키워드A", "캐시키워드B"], { concurrency: 2, budgetMs: 8000 });
    assert.equal(requests, 2);
    assert.equal(first.get("캐시키워드a").status, "ok");

    const second = await loadKeywordVolumes(["캐시키워드A", "캐시 키워드 B"], { concurrency: 2, budgetMs: 8000 });
    assert.equal(requests, 2, "캐시 히트는 API 를 호출하지 않는다");
    assert.deepEqual(second.get("캐시키워드a"), first.get("캐시키워드a"));
    assert.deepEqual(second.get("캐시키워드b"), first.get("캐시키워드b"));

    // 캐시 히트는 시간 예산을 소모하지 않고, 신규 키워드만 조회한다.
    const third = await loadKeywordVolumes(["캐시키워드A", "캐시키워드C"], { concurrency: 2, budgetMs: 8000 });
    assert.equal(requests, 3);
    assert.equal(third.get("캐시키워드c").status, "ok");
  });
});

test("keyword volume lookup stays empty without search-ad configuration", async () => {
  const previous = Object.fromEntries(SEARCHAD_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SEARCHAD_ENV_KEYS) delete process.env[key];
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const result = await loadKeywordVolumes(["미설정키워드"]);
    assert.equal(result.size, 0);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of SEARCHAD_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

// ---------------------------------------------------------------------------
// C1 결함 B — 미발견 감지: neverFound / foundRate / lastFoundAt
// ---------------------------------------------------------------------------

function foundSnapshot(id, checkedAt, matched, values = {}) {
  return {
    id,
    tracker_id: "tracker-1",
    checked_at: checkedAt,
    rank: matched ? 12 : null,
    page: matched ? 1 : null,
    position: matched ? 12 : null,
    matched,
    checked_count: 300,
    total: 300,
    item: matched ? { productId: "1234567890" } : null,
    message: matched ? "12위" : "300위 안에 없습니다.",
    source: "naver_shopping_results_collector",
    created_at: checkedAt,
    ...values,
  };
}

test("tracker payload flags a tracker that was checked at least three times without ever being found", () => {
  assert.equal(trackerPayload(trackerRow({ check_count: 3, found_count: 0 })).neverFound, true);
  assert.equal(trackerPayload(trackerRow({ check_count: 12, found_count: 0 })).neverFound, true);
  assert.equal(trackerPayload(trackerRow({ check_count: 2, found_count: 0 })).neverFound, false);
  assert.equal(trackerPayload(trackerRow({ check_count: 0, found_count: 0 })).neverFound, false);
  assert.equal(trackerPayload(trackerRow({ check_count: 3, found_count: 1 })).neverFound, false);
  assert.equal(trackerPayload(trackerRow({ check_count: 9, found_count: 8 })).neverFound, false);
  assert.equal(trackerPayload(trackerRow({ check_count: null, found_count: null })).neverFound, false);
});

test("tracker payload reports the found rate rounded to two decimals or null without checks", () => {
  assert.equal(trackerPayload(trackerRow({ check_count: 9, found_count: 8 })).foundRate, 0.89);
  assert.equal(trackerPayload(trackerRow({ check_count: 3, found_count: 1 })).foundRate, 0.33);
  assert.equal(trackerPayload(trackerRow({ check_count: 4, found_count: 4 })).foundRate, 1);
  assert.equal(trackerPayload(trackerRow({ check_count: 5, found_count: 0 })).foundRate, 0);
  assert.equal(trackerPayload(trackerRow({ check_count: 0, found_count: 0 })).foundRate, null);
  assert.equal(trackerPayload(trackerRow({ check_count: null, found_count: null })).foundRate, null);
});

test("tracker payload derives the last found time from loaded snapshots without another query", () => {
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60 * 1000).toISOString();
  const snapshots = [
    foundSnapshot("s-latest-miss", iso(10), false),
    foundSnapshot("s-found-older", iso(600), true),
    foundSnapshot("s-found-newest", iso(120), true),
    foundSnapshot("s-miss-older", iso(900), false),
  ];

  const payload = trackerPayload(trackerRow(), snapshots);
  assert.equal(payload.lastFoundAt, iso(120));

  assert.equal(trackerPayload(trackerRow(), [foundSnapshot("s-miss", iso(5), false)]).lastFoundAt, null);
  assert.equal(trackerPayload(trackerRow(), []).lastFoundAt, null);
  assert.equal(trackerPayload(trackerRow(), [undefined]).lastFoundAt, null);
});

test("tracker payload keeps its existing fields in order and appends the not-found detection fields", () => {
  const before = [
    "id", "keyword", "groupName", "keywordVolume", "keywordVolumeLabel", "keywordVolumeStatus",
    "productUrl", "productId", "mallName", "productTitle", "maxRank", "status", "startedAt", "endsAt",
    "lastCheckedAt", "nextCheckAt", "currentRank", "currentRankSource", "currentRankSourceLabel",
    "exactProductRank", "relatedCatalogRank", "bestRank", "worstRank", "checkCount", "foundCount",
    "lastMessage", "lastError", "retryCount", "sortOrder", "createdAt", "updatedAt", "snapshots",
  ];
  const keys = Object.keys(trackerPayload(trackerRow(), []));
  assert.deepEqual(keys.slice(0, before.length), before);
  assert.deepEqual(keys.slice(before.length), ["neverFound", "foundRate", "lastFoundAt"]);
});

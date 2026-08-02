import assert from "node:assert/strict";
import test from "node:test";

import {
  NAVER_RANK_CRON_ITEM_FAILURE,
  NAVER_RANK_PROVIDER_NOT_CONFIGURED,
  NAVER_RANK_PROVIDER_UNAVAILABLE,
  NAVER_RANK_PROVIDER_WARMING,
  productRankCronBatchLimit,
  productRankCronExecutionMode,
  productRankCronProviderConfigured,
  productRankCronProviderReadiness,
  hybridWorkerGraceActive,
  hybridWorkerRecentlyActive,
  safeProductRankCronSummary,
} from "./naver-rank-cron.mjs";

function limit(value) {
  const url = new URL("https://example.com/api/naver-rank-cron");
  if (value !== undefined) url.searchParams.set("limit", value);
  return productRankCronBatchLimit(url);
}

test("product cron keeps a conservative default batch", () => {
  assert.equal(limit(), 1);
  assert.equal(limit("not-a-number"), 1);
});

test("product cron accepts only a bounded sequential batch", () => {
  assert.equal(limit("1"), 1);
  assert.equal(limit("5"), 5);
  assert.equal(limit("3.9"), 3);
  assert.equal(limit("0"), 1);
  assert.equal(limit("-10"), 1);
  assert.equal(limit("100"), 5);
});

test("product cron requires the dedicated external collector pair", () => {
  assert.equal(productRankCronProviderConfigured({}), false);
  assert.equal(productRankCronProviderConfigured({ providerUrl: "https://collector.example" }), false);
  assert.equal(productRankCronProviderConfigured({ providerKey: "collector-key" }), false);
  assert.equal(productRankCronProviderConfigured({ clientId: "legacy-id", clientSecret: "legacy-secret" }), false);
  assert.equal(productRankCronProviderConfigured({
    mode: "provider",
    providerUrl: "https://collector.example",
    providerKey: "collector-key",
  }), true);
  assert.equal(NAVER_RANK_PROVIDER_NOT_CONFIGURED, "NAVER_RANK_PROVIDER_NOT_CONFIGURED");
  assert.equal(NAVER_RANK_PROVIDER_WARMING, "NAVER_RANK_PROVIDER_WARMING");
  assert.equal(NAVER_RANK_PROVIDER_UNAVAILABLE, "NAVER_RANK_PROVIDER_UNAVAILABLE");
  assert.equal(NAVER_RANK_CRON_ITEM_FAILURE, "NAVER_RANK_CRON_ITEM_FAILURE");
});

test("product cron prewarms the configured collector before claiming due rows", async () => {
  let prewarmCalls = 0;
  const configured = {
    mode: "provider",
    providerUrl: "https://collector.example/rank",
    providerKey: "collector-key",
  };
  const readiness = await productRankCronProviderReadiness(configured, {
    prewarm: async (received) => {
      prewarmCalls += 1;
      assert.equal(received, configured);
      return {
        ready: false,
        status: "warming",
        errorCode: "SHOPPING_RANK_PROVIDER_WARMING",
        retryable: true,
        retryAfterSeconds: 15,
        httpStatus: 503,
      };
    },
  });
  assert.equal(prewarmCalls, 1);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.status, "warming");
  assert.equal(readiness.retryable, true);
});

test("product cron uses the mobile top fallback only for the explicit mode", () => {
  assert.deepEqual(productRankCronExecutionMode({ ready: true, status: "ready" }), {
    run: true,
    mobileTopFallbackOnly: false,
  });
  assert.deepEqual(productRankCronExecutionMode({ ready: false, status: "unavailable" }), {
    run: false,
    mobileTopFallbackOnly: false,
  });
  assert.deepEqual(productRankCronExecutionMode({ ready: false, status: "mobile_top_fallback_ready" }), {
    run: true,
    mobileTopFallbackOnly: true,
  });
  for (const status of ["warming", "not_configured", "error", "unauthorized", "database_error"]) {
    assert.deepEqual(productRankCronExecutionMode({ ready: false, status }), {
      run: false,
      mobileTopFallbackOnly: false,
    }, status);
  }
});

test("hybrid cron gives the 300-rank worker priority before bounded fallback rescue", () => {
  const readiness = { ready: false, status: "hybrid_local_worker_ready" };
  const insideGrace = new Date("2026-08-01T00:30:00.000Z"); // 09:30 KST
  const afterGrace = new Date("2026-08-01T01:01:00.000Z"); // 10:01 KST
  assert.equal(hybridWorkerGraceActive(insideGrace), true);
  assert.equal(hybridWorkerGraceActive(afterGrace), false);
  assert.deepEqual(productRankCronExecutionMode(readiness, {
    now: insideGrace,
    localWorkerActive: true,
  }), {
    run: false,
    mobileTopFallbackOnly: false,
    deferredToLocalWorker: true,
  });
  assert.deepEqual(productRankCronExecutionMode(readiness, {
    now: insideGrace,
    localWorkerActive: false,
  }), {
    run: true,
    mobileTopFallbackOnly: true,
    fallbackRescue: true,
    localWorkerInactive: true,
  });
  assert.deepEqual(productRankCronExecutionMode(readiness, {
    now: afterGrace,
    localWorkerActive: true,
  }), {
    run: true,
    mobileTopFallbackOnly: true,
    fallbackRescue: true,
    localWorkerInactive: false,
  });
});

test("hybrid cron suppresses fallback only after a signed worker heartbeat", async () => {
  const calls = [];
  const query = {
    select(value) { calls.push(["select", value]); return this; },
    gte(name, value) { calls.push(["gte", name, value]); return this; },
    order(name, value) { calls.push(["order", name, value]); return this; },
    async limit(value) { calls.push(["limit", value]); return { data: [{ created_at: "2026-08-01T00:00:02.000Z" }], error: null }; },
  };
  const ctx = { supabaseAdmin: { from(name) { calls.push(["from", name]); return query; } } };
  assert.equal(await hybridWorkerRecentlyActive(ctx, new Date("2026-08-01T00:05:00.000Z")), true);
  assert.equal(calls[0][1], "naver_shopping_worker_nonces");
  assert.equal(await hybridWorkerRecentlyActive({}, new Date("2026-08-01T00:05:00.000Z")), false);
  assert.equal(await hybridWorkerRecentlyActive({
    supabaseAdmin: { from() { throw new Error("db_down"); } },
  }, new Date("2026-08-01T00:05:00.000Z")), false);
});

test("product cron accepts the explicit fallback without prewarming a provider", async () => {
  let prewarmCalls = 0;
  const readiness = await productRankCronProviderReadiness({
    mode: "mobile_top_fallback",
    mobileTopFallbackOnly: true,
  }, {
    prewarm: async () => {
      prewarmCalls += 1;
      return { ready: true };
    },
  });
  assert.equal(prewarmCalls, 0);
  assert.equal(readiness.status, "mobile_top_fallback_ready");
  assert.equal(readiness.fullCoverageReady, false);
});

test("product cron accepts only a fully signed hybrid worker configuration", async () => {
  let prewarmCalls = 0;
  const readiness = await productRankCronProviderReadiness({
    mode: "hybrid_local_worker",
    mobileTopFallbackOnly: true,
    localWorkerEnabled: true,
    localWorkerSecretReady: true,
  }, {
    prewarm: async () => {
      prewarmCalls += 1;
      return { ready: true };
    },
  });
  assert.equal(prewarmCalls, 0);
  assert.equal(readiness.status, "hybrid_local_worker_ready");
  assert.equal(readiness.fullCoverageReady, false);
  assert.equal(readiness.fullCoverageConfigured, true);
});

test("product cron rejects missing provider configuration without starting prewarm", async () => {
  let prewarmCalls = 0;
  const readiness = await productRankCronProviderReadiness({}, {
    prewarm: async () => {
      prewarmCalls += 1;
      return { ready: true };
    },
  });
  assert.equal(prewarmCalls, 0);
  assert.deepEqual(readiness, {
    ready: false,
    status: "not_configured",
    errorCode: "NAVER_RANK_PROVIDER_NOT_CONFIGURED",
    retryable: false,
    retryAfterSeconds: 0,
    httpStatus: 503,
  });
});

test("product cron exposes only aggregate counts in its summary", () => {
  const summary = safeProductRankCronSummary({
    now: "2026-07-31T01:02:03.000Z",
    checked: 5,
    succeeded: 3,
    preserved: 0,
    failed: 2,
    remaining: 7,
    drained: false,
    configured: true,
    rankSourceReady: true,
    results: [{
      trackerId: "private-tracker-id",
      keyword: "private-keyword",
      productId: "private-product-id",
    }],
  });

  assert.deepEqual(summary, {
    now: "2026-07-31T01:02:03.000Z",
    checked: 5,
    succeeded: 3,
    preserved: 0,
    failed: 2,
    remaining: 7,
    drained: false,
    configured: true,
    rankSourceReady: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /private|trackerId|keyword|productId/);
});

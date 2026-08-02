import assert from "node:assert/strict";
import test from "node:test";

import {
  clearShoppingProviderPrewarmCache,
  prewarmShoppingRankProvider,
  resolveShoppingRankProvider,
  shoppingProviderExecutionMode,
  shoppingProviderReadyUrl,
  shoppingProviderRequestTimeoutMs,
  shoppingProviderRuntimeConfig,
} from "./provider-runtime.mjs";

const COLLECTOR = {
  mode: "provider",
  providerUrl: "https://collector.example/rank/naver-shopping?secret=no",
  providerKey: "collector-key",
};

function readinessResponse({ ready = false, reason = "" } = {}) {
  return new Response(JSON.stringify({
    ready,
    provider: {
      configured: true,
      verified: ready,
      reason,
    },
  }), {
    status: ready ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}

test("provider runtime keeps request and prewarm budgets within the server envelope", () => {
  assert.equal(shoppingProviderRequestTimeoutMs(undefined), 90_000);
  assert.equal(shoppingProviderRequestTimeoutMs("1"), 30_000);
  assert.equal(shoppingProviderRequestTimeoutMs("999999"), 120_000);
  assert.equal(shoppingProviderRequestTimeoutMs("invalid"), 90_000);
  assert.equal(shoppingProviderRuntimeConfig({}).prewarmTimeoutMs, 75_000);
  assert.equal(shoppingProviderRuntimeConfig({
    MI_NAVER_SHOPPING_PREWARM_TIMEOUT_MS: "999999",
  }).prewarmTimeoutMs, 90_000);
  assert.deepEqual(shoppingProviderRuntimeConfig({
    MI_NAVER_SHOPPING_PROVIDER_TIMEOUT_MS: "45000",
    MI_NAVER_SHOPPING_PREWARM_TIMEOUT_MS: "500",
    MI_NAVER_SHOPPING_PREWARM_POLL_MS: "9999",
    MI_NAVER_SHOPPING_READY_CACHE_TTL_MS: "1",
  }), {
    requestTimeoutMs: 45_000,
    prewarmTimeoutMs: 1_000,
    prewarmPollMs: 3_000,
    readyCacheTtlMs: 30_000,
  });
});

test("provider readiness URL stays on the configured origin and drops rank query data", () => {
  assert.equal(
    shoppingProviderReadyUrl(COLLECTOR.providerUrl),
    "https://collector.example/ready",
  );
  assert.throws(
    () => shoppingProviderReadyUrl("file:///tmp/collector"),
    /shopping_rank_provider_url_invalid/,
  );
});

test("prewarm polls a cold provider with authenticated readiness", async () => {
  clearShoppingProviderPrewarmCache();
  const calls = [];
  const responses = [readinessResponse(), readinessResponse({ ready: true })];
  const result = await prewarmShoppingRankProvider(COLLECTOR, {
    timeoutMs: 1_000,
    pollMs: 250,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return responses.shift();
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.status, "ready");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url === "https://collector.example/ready"));
  assert.ok(calls.every((call) => call.options.headers.authorization === `Bearer ${COLLECTOR.providerKey}`));
});

test("prewarm accepts the full bounded cold-start budget", async () => {
  clearShoppingProviderPrewarmCache();
  let clock = 0;
  let fetchCalls = 0;
  const result = await prewarmShoppingRankProvider(COLLECTOR, {
    timeoutMs: 75_000,
    pollMs: 3_000,
    now: () => clock,
    sleep: async (delay) => { clock += delay; },
    fetchImpl: async () => {
      fetchCalls += 1;
      if (clock >= 60_000) return readinessResponse({ ready: true });
      return readinessResponse();
    },
  });

  assert.equal(result.ready, true);
  assert.ok(clock >= 60_000, "the provider must be allowed to outlive a 30-second cold start");
  assert.ok(fetchCalls > 10);
});

test("prewarm deduplicates concurrent cold starts and caches only verified readiness", async () => {
  clearShoppingProviderPrewarmCache();
  let fetchCalls = 0;
  let release;
  const responseGate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    fetchCalls += 1;
    await responseGate;
    return readinessResponse({ ready: true });
  };

  const first = prewarmShoppingRankProvider(COLLECTOR, { fetchImpl, timeoutMs: 1_000 });
  const second = prewarmShoppingRankProvider(COLLECTOR, { fetchImpl, timeoutMs: 1_000 });
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ready, true);
  assert.equal(secondResult.ready, true);
  assert.equal(fetchCalls, 1);

  const cached = await prewarmShoppingRankProvider(COLLECTOR, {
    fetchImpl: async () => {
      throw new Error("verified readiness should have been cached");
    },
  });
  assert.equal(cached.ready, true);
});

test("prewarm distinguishes a permanent collector blocker from a retryable warmup", async () => {
  clearShoppingProviderPrewarmCache();
  const unavailable = await prewarmShoppingRankProvider(COLLECTOR, {
    timeoutMs: 1_000,
    fetchImpl: async () => readinessResponse({ reason: "naver_http_418" }),
  });
  assert.deepEqual(unavailable, {
    ready: false,
    status: "unavailable",
    errorCode: "SHOPPING_RANK_SOURCE_UNAVAILABLE",
    retryable: false,
    retryAfterSeconds: 0,
    httpStatus: 503,
  });

  clearShoppingProviderPrewarmCache();
  let clock = 0;
  const warming = await prewarmShoppingRankProvider(COLLECTOR, {
    timeoutMs: 1_000,
    pollMs: 250,
    now: () => {
      clock += 250;
      return clock;
    },
    sleep: async () => {},
    fetchImpl: async () => readinessResponse(),
  });
  assert.equal(warming.ready, false);
  assert.equal(warming.status, "warming");
  assert.equal(warming.errorCode, "SHOPPING_RANK_PROVIDER_WARMING");
  assert.equal(warming.retryable, true);
  assert.equal(warming.retryAfterSeconds, 15);
});

test("prewarm fails closed immediately for authentication and configuration errors", async () => {
  for (const [reason, expected] of [
    ["naver_auth_required", "unauthorized"],
    ["collector_secret_missing", "misconfigured"],
    ["verified_provider_not_configured", "misconfigured"],
    ["provider_browser_dependency_missing", "misconfigured"],
  ]) {
    clearShoppingProviderPrewarmCache();
    let fetchCalls = 0;
    const result = await prewarmShoppingRankProvider(COLLECTOR, {
      timeoutMs: 75_000,
      fetchImpl: async () => {
        fetchCalls += 1;
        return readinessResponse({ reason });
      },
      sleep: async () => {
        throw new Error("terminal readiness failures must not be polled");
      },
    });
    assert.equal(result.ready, false);
    assert.equal(result.status, expected);
    assert.equal(result.retryable, false);
    assert.equal(fetchCalls, 1);
  }
});

test("execution mode never silently falls back when a provider becomes unavailable", async () => {
  assert.deepEqual(shoppingProviderExecutionMode({ ready: true, status: "ready" }), {
    run: true,
    mobileTopFallbackOnly: false,
  });
  assert.deepEqual(shoppingProviderExecutionMode({ ready: false, status: "unavailable" }), {
    run: false,
    mobileTopFallbackOnly: false,
  });
  for (const status of ["unauthorized", "warming", "not_configured", "database_error"]) {
    assert.deepEqual(shoppingProviderExecutionMode({ ready: false, status }), {
      run: false,
      mobileTopFallbackOnly: false,
    });
  }

  const resolved = await resolveShoppingRankProvider(COLLECTOR, {
    prewarm: async () => ({ ready: false, status: "unavailable" }),
  });
  assert.equal(resolved.run, false);
  assert.equal(resolved.env.mobileTopFallbackOnly, undefined);
});

test("resolver enables the mobile top window only through the explicit mode", async () => {
  let prewarmCalls = 0;
  const resolved = await resolveShoppingRankProvider({
    mode: "mobile_top_fallback",
    mobileTopFallbackOnly: true,
  }, {
    prewarm: async () => {
      prewarmCalls += 1;
      return { ready: true };
    },
  });
  assert.equal(prewarmCalls, 0);
  assert.equal(resolved.run, true);
  assert.equal(resolved.mobileTopFallbackOnly, true);
  assert.equal(resolved.env.mobileTopFallbackOnly, true);
  assert.equal(resolved.readiness.status, "mobile_top_fallback_ready");
  assert.equal(resolved.readiness.fullCoverageReady, false);
});

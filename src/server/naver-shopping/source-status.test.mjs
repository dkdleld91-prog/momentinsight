import assert from "node:assert/strict";
import test from "node:test";

import {
  hasShoppingRankConfig,
  hasShoppingRankHybridConfig,
  hasShoppingRankProviderConfig,
  isHybridLocalWorkerMode,
  isMobileTopFallbackMode,
  isShoppingCollectorUnavailable,
  isShoppingRankSourceUnavailable,
  shoppingCollectorFailureStatus,
  shoppingRankConfig,
  shoppingRankSourceStatus,
} from "./source-status.mjs";

test("shopping collector configuration requires the current URL and key pair", () => {
  assert.deepEqual(shoppingRankConfig({
    NAVER_SHOPPING_RANK_MODE: "provider",
    NAVER_SHOPPING_RANK_API_URL: " https://collector.example/rank ",
    NAVER_SHOPPING_RANK_API_KEY: " secret ",
  }), {
    providerUrl: "https://collector.example/rank",
    providerKey: "secret",
    mode: "provider",
    mobileTopFallbackOnly: false,
    localWorkerEnabled: false,
    localWorkerSecretReady: false,
  });
  assert.equal(hasShoppingRankConfig({ providerUrl: "https://collector.example/rank" }), false);
  assert.equal(hasShoppingRankConfig({ providerUrl: "https://collector.example/rank", providerKey: "secret" }), false);
  assert.equal(hasShoppingRankConfig({ mode: "provider", providerUrl: "https://collector.example/rank", providerKey: "secret" }), true);
  assert.equal(shoppingRankSourceStatus({}).errorCode, "SHOPPING_RANK_SOURCE_NOT_CONFIGURED");
});

test("shopping rank mode enables only an explicit safe fallback and fails closed on typos", () => {
  const fallback = shoppingRankConfig({ NAVER_SHOPPING_RANK_MODE: " mobile_top_fallback " });
  assert.equal(isMobileTopFallbackMode(fallback), true);
  assert.equal(hasShoppingRankConfig(fallback), true);
  assert.equal(hasShoppingRankProviderConfig(fallback), false);
  assert.deepEqual(shoppingRankSourceStatus(fallback), {
    rankSourceReady: true,
    configured: true,
    mode: "mobile_top_fallback",
    coverage: "verified_top_window",
    fullCoverageReady: false,
    preserveOnMiss: true,
    localWorkerEnabled: false,
    localWorkerSecretReady: false,
  });

  const invalid = shoppingRankConfig({
    NAVER_SHOPPING_RANK_MODE: "mobile_top_fallbak",
    NAVER_SHOPPING_RANK_API_URL: "https://collector.example/rank",
    NAVER_SHOPPING_RANK_API_KEY: "secret",
  });
  assert.equal(hasShoppingRankConfig(invalid), false);
  assert.equal(hasShoppingRankProviderConfig(invalid), false);
  assert.equal(shoppingRankSourceStatus(invalid).errorCode, "SHOPPING_RANK_MODE_INVALID");
});

test("hybrid mode requires the signed local worker and keeps immediate fallback available", () => {
  const incomplete = shoppingRankConfig({
    NAVER_SHOPPING_RANK_MODE: "hybrid_local_worker",
    MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
    MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET: "short",
  });
  assert.equal(isHybridLocalWorkerMode(incomplete), true);
  assert.equal(isMobileTopFallbackMode(incomplete), true);
  assert.equal(hasShoppingRankHybridConfig(incomplete), false);
  assert.equal(hasShoppingRankConfig(incomplete), false);

  const hybrid = shoppingRankConfig({
    NAVER_SHOPPING_RANK_MODE: "hybrid_local_worker",
    MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
    MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET: "a-secure-worker-secret-that-is-longer-than-32-bytes",
  });
  assert.equal(hasShoppingRankHybridConfig(hybrid), true);
  assert.equal(hasShoppingRankConfig(hybrid), true);
  assert.deepEqual(shoppingRankSourceStatus(hybrid), {
    rankSourceReady: true,
    configured: true,
    mode: "hybrid_local_worker",
    coverage: "verified_top_window_plus_local_300",
    fullCoverageReady: true,
    preserveOnMiss: true,
    localWorkerEnabled: true,
    localWorkerSecretReady: true,
  });
});

test("collector outages open the source circuit while queue pressure remains retryable", () => {
  assert.equal(isShoppingCollectorUnavailable({
    status: 502,
    message: "provider_collection_failed",
    detail: "naver_http_418",
  }), true);
  assert.equal(isShoppingCollectorUnavailable({
    status: 502,
    message: "provider_collection_failed",
    detail: "provider_queue_full",
  }), false);
  assert.deepEqual(shoppingCollectorFailureStatus({
    status: 401,
    message: "provider_unauthorized",
  }), {
    status: "unauthorized",
    errorCode: "SHOPPING_RANK_PROVIDER_UNAUTHORIZED",
    retryable: false,
    retryAfterSeconds: 0,
    httpStatus: 401,
  });
  assert.equal(isShoppingCollectorUnavailable({ status: 401, message: "provider_unauthorized" }), false);
  assert.equal(shoppingCollectorFailureStatus({
    status: 503,
    message: "provider_not_ready",
    detail: "naver_auth_required",
  }).status, "unauthorized");
  for (const detail of [
    "collector_secret_missing",
    "verified_provider_not_configured",
    "unsupported_provider_mode",
    "canary_keyword_missing",
    "provider_browser_dependency_missing",
    "provider_browser_launch_failed",
  ]) {
    assert.equal(shoppingCollectorFailureStatus({
      status: 503,
      message: "provider_not_ready",
      detail,
    }).status, "misconfigured");
    assert.equal(isShoppingCollectorUnavailable({
      status: 503,
      message: "provider_not_ready",
      detail,
    }), false);
  }
  assert.deepEqual(shoppingCollectorFailureStatus({
    status: 503,
    message: "provider_not_ready",
  }), {
    status: "warming",
    errorCode: "SHOPPING_RANK_PROVIDER_WARMING",
    retryable: true,
    retryAfterSeconds: 15,
    httpStatus: 503,
  });
  assert.equal(isShoppingCollectorUnavailable({
    status: 503,
    message: "provider_not_ready",
  }), false);
  assert.equal(shoppingCollectorFailureStatus({
    status: 504,
    message: "shopping_rank_provider_timeout",
  }).retryable, true);
  assert.deepEqual(shoppingCollectorFailureStatus({
    status: 502,
    message: "provider_collection_failed",
    detail: "naver_http_429",
  }), {
    status: "error",
    errorCode: "SHOPPING_RANK_LOOKUP_FAILED",
    retryable: true,
    retryAfterSeconds: 5,
    httpStatus: 502,
  });
  assert.equal(isShoppingRankSourceUnavailable("Invalid search api (존재하지 않는 검색 api 입니다.)"), true);
  assert.equal(isShoppingRankSourceUnavailable("provider_busy:provider_queue_deadline_exceeded"), false);
  assert.deepEqual(shoppingCollectorFailureStatus({
    status: 503,
    code: "SHOPPING_RANK_TOP_FALLBACK_INCONCLUSIVE",
    message: "shopping_rank_top_fallback_inconclusive",
  }), {
    status: "coverage_limited",
    errorCode: "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW",
    retryable: false,
    retryAfterSeconds: 0,
    httpStatus: 409,
  });
  assert.equal(shoppingCollectorFailureStatus({
    status: 403,
    code: "shopping_mobile_top_http_403",
  }).status, "unavailable");
  assert.equal(shoppingCollectorFailureStatus({
    status: 503,
    code: "shopping_mobile_top_schema_drift",
  }).status, "unavailable");
});

import assert from "node:assert/strict";
import test from "node:test";

import handler from "./integration-status.mjs";
import { resetMobileTopFallbackStateForTests } from "../naver-shopping/mobile-top-fallback.mjs";

test("integration status separates migrated API Hub calls from the terminating shopping search API", async () => {
  const names = [
    "NAVER_SEARCHAD_API_KEY",
    "NAVER_SEARCHAD_SECRET_KEY",
    "NAVER_SEARCHAD_CUSTOMER_ID",
    "NAVER_OPENAPI_CLIENT_ID",
    "NAVER_OPENAPI_CLIENT_SECRET",
    "NAVER_API_HUB_CLIENT_ID",
    "NAVER_API_HUB_CLIENT_SECRET",
    "NAVER_API_HUB_MODE",
    "NAVER_SHOPPING_RANK_API_URL",
    "NAVER_SHOPPING_RANK_API_KEY",
    "NAVER_SHOPPING_RANK_MODE",
    "MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED",
    "MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET",
    "MI_KEYWORD_API_ENABLED",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    NAVER_SEARCHAD_API_KEY: "search-ad-key",
    NAVER_SEARCHAD_SECRET_KEY: "search-ad-secret",
    NAVER_SEARCHAD_CUSTOMER_ID: "123456",
    NAVER_OPENAPI_CLIENT_ID: "legacy-id",
    NAVER_OPENAPI_CLIENT_SECRET: "legacy-secret",
    NAVER_API_HUB_CLIENT_ID: "hub-id",
    NAVER_API_HUB_CLIENT_SECRET: "hub-secret",
    NAVER_API_HUB_MODE: "hub",
    MI_KEYWORD_API_ENABLED: "true",
  });
  delete process.env.NAVER_SHOPPING_RANK_API_URL;
  delete process.env.NAVER_SHOPPING_RANK_API_KEY;
  delete process.env.NAVER_SHOPPING_RANK_MODE;

  try {
    const response = await handler.fetch(new Request("http://localhost/api/integration-status"));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.missingEnvCount, 3);
    assert.deepEqual(body.integrations.naverApiHubMigration, {
      ready: true,
      credentialsReady: true,
      cutoverLocked: true,
      mode: "hub",
      searchProvider: "hub",
      datalabProvider: "hub",
    });
    assert.equal(body.integrations.keywordTrendAndRatios.source, "naver_api_hub_datalab");
    assert.equal(body.integrations.shoppingReferenceAndRank.source, "unavailable_no_official_replacement");
    assert.equal(body.integrations.shoppingReferenceAndRank.ready, false);
    assert.equal(body.integrations.shoppingReferenceAndRank.configured, false);
    assert.equal(body.integrations.shoppingReferenceAndRank.verification, "not_configured");
    assert.equal(body.integrations.shoppingReferenceAndRank.contract, "naver_shopping_results_collector");
    assert.equal(body.integrations.shoppingReferenceAndRank.rankEvidence, "naver_shopping_organic_list");
    assert.deepEqual(body.integrations.shoppingReferenceAndRank.capabilities, {
      keywordReference: false,
      productRank: false,
      full300: false,
      full300Configured: false,
      verifiedRankLimit: 0,
      keywordReferenceMode: "none",
      full300Mode: "none",
    });
    assert.equal(body.integrations.shoppingReferenceAndRank.lifecycle, "ended_2026-07-31_no_official_replacement");

    process.env.NAVER_SHOPPING_RANK_API_URL = "https://collector.example/rank";
    process.env.NAVER_SHOPPING_RANK_API_KEY = "collector-key";
    process.env.NAVER_SHOPPING_RANK_MODE = "provider";
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      ready: true,
      service: "unexpected-service",
      schemaVersion: "mi.naver-shopping-organic-window.v1",
      secretConfigured: true,
      provider: { configured: true, verified: true },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const unverifiedResponse = await handler.fetch(new Request("http://localhost/api/integration-status"));
    const unverifiedBody = await unverifiedResponse.json();
    assert.equal(unverifiedBody.ok, false);
    assert.equal(unverifiedBody.missingEnvCount, 0);
    assert.equal(unverifiedBody.integrations.shoppingReferenceAndRank.configured, true);
    assert.equal(unverifiedBody.integrations.shoppingReferenceAndRank.ready, false);
    assert.equal(unverifiedBody.integrations.shoppingReferenceAndRank.verification, "configured_unverified");
    assert.equal(unverifiedBody.integrations.shoppingReferenceAndRank.source, "configured_unverified");
    assert.equal(unverifiedBody.integrations.shoppingReferenceAndRank.lifecycle, "collector_configured_unverified");
    assert.equal(JSON.stringify(unverifiedBody).includes("collector-key"), false);

    resetMobileTopFallbackStateForTests();
    process.env.NAVER_SHOPPING_RANK_MODE = "mobile_top_fallback";
    delete process.env.NAVER_SHOPPING_RANK_API_URL;
    delete process.env.NAVER_SHOPPING_RANK_API_KEY;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/ready") {
        return new Response(JSON.stringify({
          ok: false,
          ready: false,
          provider: { configured: true, verified: false, reason: "naver_http_418" },
        }), { status: 503, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "m.search.naver.com") {
        const state = {
          initProps: { byPassBFFParams: { aq: "0", rev: "4" } },
          device: { type: "mobile" },
          query: "온열찜질기",
          originQuery: "온열찜질기",
          pageId: "status/page",
          sessionId: "status/session",
          viewType: "GUIDE",
          areaCode: "shp_tli",
          rev: "4",
          bffHost: "ns-portal.shopping.naver.com",
        };
        return new Response(`<!doctype html><script>naver.search.ext.newshopping["shopping"]._INITIAL_STATE=${JSON.stringify(state)};</script>`, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      assert.equal(url.hostname, "ns-portal.shopping.naver.com");
      return new Response(JSON.stringify({
        data: [{
          page: 1,
          pageSize: 50,
          slots: Array.from({ length: 40 }, (_, index) => ({
            data: {
              sourceType: "SAS",
              cardType: "ORGANIC_CARD",
              rank: index + 1,
              nvMid: String(90000000001 + index),
              channelProductId: String(12000000001 + index),
              originalMallProductId: String(11000000001 + index),
              productName: `검증 상품 ${index + 1}`,
              productUrl: { pcUrl: `https://smartstore.naver.com/example/products/${12000000001 + index}` },
            },
          })),
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const fallbackResponse = await handler.fetch(new Request("http://localhost/api/integration-status"));
    const fallbackBody = await fallbackResponse.json();
    assert.equal(fallbackBody.ok, true);
    assert.equal(fallbackBody.integrations.shoppingReferenceAndRank.ready, true);
    assert.equal(fallbackBody.integrations.shoppingReferenceAndRank.verification, "mobile_top_verified");
    assert.equal(fallbackBody.integrations.shoppingReferenceAndRank.source, "verified_naver_integrated_search_mobile_top_fallback");
    assert.equal(fallbackBody.integrations.shoppingReferenceAndRank.lifecycle, "server_fallback_preserve_on_miss");
    assert.deepEqual(fallbackBody.integrations.shoppingReferenceAndRank.capabilities, {
      keywordReference: true,
      productRank: true,
      full300: false,
      full300Configured: false,
      verifiedRankLimit: 40,
      keywordReferenceMode: "partial_sample",
      full300Mode: "none",
    });

    resetMobileTopFallbackStateForTests();
    process.env.NAVER_SHOPPING_RANK_MODE = "hybrid_local_worker";
    process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED = "true";
    process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET = "integration-worker-secret-that-is-longer-than-32-bytes";
    const hybridResponse = await handler.fetch(new Request("http://localhost/api/integration-status"));
    const hybridBody = await hybridResponse.json();
    assert.equal(hybridBody.ok, true);
    assert.equal(hybridBody.integrations.shoppingReferenceAndRank.ready, true);
    assert.equal(hybridBody.integrations.shoppingReferenceAndRank.source, "verified_mobile_top_plus_signed_local_worker_configured");
    assert.equal(hybridBody.integrations.shoppingReferenceAndRank.lifecycle, "server_fallback_plus_signed_local_worker_pending_live_proof");
    assert.equal(hybridBody.integrations.shoppingReferenceAndRank.capabilities.full300, false);
    assert.equal(hybridBody.integrations.shoppingReferenceAndRank.capabilities.full300Configured, true);
    assert.equal(hybridBody.integrations.shoppingReferenceAndRank.capabilities.full300Mode, "signed_local_worker_configured");

    process.env.NAVER_SHOPPING_RANK_MODE = "provider";
    process.env.NAVER_SHOPPING_RANK_API_URL = "https://collector.example/rank";
    process.env.NAVER_SHOPPING_RANK_API_KEY = "collector-key";
    let readyRequest;
    globalThis.fetch = async (input, init = {}) => {
      readyRequest = { input: String(input), init };
      return new Response(JSON.stringify({
        ok: true,
        ready: true,
        service: "moment-naver-shopping-rank-collector",
        release: "2026-08-01-organic-window-v1",
        schemaVersion: "mi.naver-shopping-organic-window.v1",
        secretConfigured: true,
        provider: { name: "fixture", configured: true, verified: true, reason: "" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const collectorResponse = await handler.fetch(new Request("http://localhost/api/integration-status"));
    const collectorBody = await collectorResponse.json();
    assert.equal(collectorBody.integrations.shoppingReferenceAndRank.ready, true);
    assert.equal(collectorBody.integrations.shoppingReferenceAndRank.configured, true);
    assert.equal(collectorBody.integrations.shoppingReferenceAndRank.verification, "verified");
    assert.equal(collectorBody.integrations.shoppingReferenceAndRank.source, "verified_naver_shopping_results_collector");
    assert.equal(collectorBody.integrations.shoppingReferenceAndRank.lifecycle, "server_collector");
    assert.deepEqual(collectorBody.integrations.shoppingReferenceAndRank.capabilities, {
      keywordReference: true,
      productRank: true,
      full300: true,
      full300Configured: true,
      verifiedRankLimit: 300,
      keywordReferenceMode: "full_window",
      full300Mode: "server_collector",
    });
    assert.equal(collectorBody.ok, true);
    assert.equal(collectorBody.missingEnvCount, 0);
    assert.equal(new URL(readyRequest.input).pathname, "/ready");
    assert.equal(readyRequest.init.method, "GET");
    assert.equal(new Headers(readyRequest.init.headers).has("authorization"), false);
    assert.equal(readyRequest.init.signal instanceof AbortSignal, true);
    assert.equal(JSON.stringify(collectorBody).includes("collector-key"), false);

    process.env.NAVER_API_HUB_MODE = "legacy";
    const legacyModeResponse = await handler.fetch(new Request("http://localhost/api/integration-status"));
    const legacyModeBody = await legacyModeResponse.json();
    assert.equal(legacyModeBody.ok, false);
    assert.equal(legacyModeBody.integrations.naverApiHubMigration.ready, false);
    assert.equal(legacyModeBody.integrations.keywordTrendAndRatios.ready, false);
    assert.equal(legacyModeBody.integrations.keywordTrendAndRatios.source, "not_configured");
    assert.equal(legacyModeBody.integrations.shoppingReferenceAndRank.ready, true);
  } finally {
    resetMobileTopFallbackStateForTests();
    globalThis.fetch = previousFetch;
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

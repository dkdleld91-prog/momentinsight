import assert from "node:assert/strict";
import test from "node:test";

import handler from "./integration-status.mjs";

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
    "MI_KEYWORD_API_ENABLED",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
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

  try {
    const response = await handler.fetch(new Request("http://localhost/api/integration-status"));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.missingEnvCount, 2);
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
    assert.equal(body.integrations.shoppingReferenceAndRank.lifecycle, "ended_2026-07-31_no_official_replacement");

    process.env.NAVER_SHOPPING_RANK_API_URL = "https://collector.example/rank";
    process.env.NAVER_SHOPPING_RANK_API_KEY = "collector-key";
    const collectorResponse = await handler.fetch(new Request("http://localhost/api/integration-status"));
    const collectorBody = await collectorResponse.json();
    assert.equal(collectorBody.integrations.shoppingReferenceAndRank.ready, true);
    assert.equal(collectorBody.integrations.shoppingReferenceAndRank.configured, true);
    assert.equal(collectorBody.integrations.shoppingReferenceAndRank.source, "verified_naver_shopping_results_collector");
    assert.equal(collectorBody.integrations.shoppingReferenceAndRank.lifecycle, "server_collector");
    assert.equal(collectorBody.ok, true);
    assert.equal(collectorBody.missingEnvCount, 0);
  } finally {
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

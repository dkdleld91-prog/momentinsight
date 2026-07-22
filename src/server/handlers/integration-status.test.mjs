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
    NAVER_API_HUB_MODE: "auto",
    MI_KEYWORD_API_ENABLED: "true",
  });

  try {
    const response = await handler.fetch(new Request("http://localhost/api/integration-status"));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.integrations.naverApiHubMigration, {
      ready: true,
      mode: "auto",
      searchProvider: "hub",
      datalabProvider: "hub",
    });
    assert.equal(body.integrations.keywordTrendAndRatios.source, "naver_api_hub_datalab");
    assert.equal(body.integrations.shoppingReferenceAndRank.source, "naver_developers_shopping_search");
    assert.equal(body.integrations.shoppingReferenceAndRank.lifecycle, "ends_2026-07-31_no_official_replacement");
  } finally {
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

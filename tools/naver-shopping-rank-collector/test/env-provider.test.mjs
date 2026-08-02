import assert from "node:assert/strict";
import test from "node:test";

import { SCHEMA_VERSION } from "../src/contract.mjs";
import { ProviderError, createProviderFromEnv } from "../src/provider.mjs";

function rankRequest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    keyword: "온열찜질기",
    limit: 1,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("environment selection cannot turn the local engine into a bundled remote provider", async () => {
  for (const env of [
    {},
    {
      NAVER_SHOPPING_PROVIDER_MODE: "playwright",
      MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
      NAVER_SHOPPING_PROVIDER_SEARCH_HOST: "msearch.shopping.naver.com",
      NAVER_SHOPPING_PROVIDER_HEADLESS: "false",
    },
  ]) {
    const provider = createProviderFromEnv(env);
    const status = await provider.status();
    assert.equal(status.configured, false);
    assert.equal(status.verified, false);
    await assert.rejects(
      provider.collect(rankRequest()),
      (error) => error instanceof ProviderError && error.code === "provider_not_ready",
    );
  }
});

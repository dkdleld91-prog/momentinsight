import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { SCHEMA_VERSION, SOURCE, RANK_EVIDENCE } from "../tools/naver-shopping-rank-collector/src/contract.mjs";
import {
  assertGitHubHostedRunner,
  githubCloudCollectionId,
} from "../tools/naver-shopping-rank-collector/src/github-cloud.mjs";
import { verifyGitHubCloudCollector } from "./naver-shopping-cloud-worker.mjs";

const hostedEnv = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_RUN_ID: "123456789",
  GITHUB_RUN_ATTEMPT: "2",
  MI_NAVER_SHOPPING_CLOUD_CANARY_KEYWORD: "온열찜질기",
};

function strictWindow(keyword = "온열찜질기") {
  const collectedAt = new Date().toISOString();
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    keyword,
    source: SOURCE,
    rankEvidence: RANK_EVIDENCE,
    collectionId: "gh-123456789-2-0123456789abcdef",
    collectedAt,
    complete: true,
    partial: false,
    sourceExhausted: false,
    marketTotal: null,
    marketTotalStatus: "unavailable",
    checkedCount: 300,
    rawCount: 300,
    excludedAdCount: 0,
    items: Array.from({ length: 300 }, (_, index) => ({
      organicRank: index + 1,
      productId: String(90000000000 + index),
      sellerProductId: String(12000000000 + index),
      title: `검증 상품 ${index + 1}`,
      link: `https://smartstore.naver.com/example/products/${12000000000 + index}`,
      mallName: "검증몰",
      isAd: false,
      isOrganic: true,
    })),
  };
}

test("allows only a GitHub-hosted Actions runner", () => {
  assert.equal(assertGitHubHostedRunner(hostedEnv), true);
  assert.throws(() => assertGitHubHostedRunner({}), /github_cloud_runner_required/u);
  assert.throws(() => assertGitHubHostedRunner({
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "self-hosted",
  }), /github_cloud_runner_required/u);
});

test("stamps a separate GitHub collection lineage", () => {
  const collectionId = githubCloudCollectionId({
    collectionId: "pw-1750000000000-0123456789abcdef0123",
  }, hostedEnv);
  assert.equal(collectionId, "gh-123456789-2-0123456789abcdef0123");
});

test("accepts only a complete 300-item canary window", async () => {
  let closed = 0;
  const success = await verifyGitHubCloudCollector({
    env: hostedEnv,
    provider: {
      async collect() { return strictWindow(); },
      async close() { closed += 1; },
    },
  });
  assert.equal(success.checkedCount, 300);
  assert.equal(closed, 0, "an injected provider remains owned by its caller");

  await assert.rejects(
    verifyGitHubCloudCollector({
      env: hostedEnv,
      provider: {
        async collect() {
          const partial = strictWindow();
          partial.items = partial.items.slice(0, 299);
          partial.checkedCount = 299;
          return partial;
        },
      },
    }),
    /local_worker_window_not_300|invalid_provider_response|shopping_rank_provider_untrusted_evidence/u,
  );
});

test("cloud workflows are manual-canary first and production-disabled by default", () => {
  const cloudProvider = fs.readFileSync("tools/naver-shopping-rank-collector/src/github-cloud.mjs", "utf8");
  const canary = fs.readFileSync(".github/workflows/naver-shopping-cloud-canary.yml", "utf8");
  const safariCanary = fs.readFileSync(".github/workflows/naver-shopping-safari-canary.yml", "utf8");
  const production = fs.readFileSync(".github/workflows/naver-shopping-cloud-rank.yml", "utf8");
  for (const workflow of [canary, production]) {
    assert.match(workflow, /persist-credentials:\s*false/u);
    assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/u);
    assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/u);
    assert.match(workflow, /ci --ignore-scripts/u);
    assert.match(workflow, /playwright install --with-deps chromium/u);
  }
  assert.match(canary, /workflow_dispatch:/u);
  assert.match(canary, /push:/u);
  assert.match(canary, /branches:\s*\n\s*- main/u);
  assert.doesNotMatch(canary, /schedule:/u);
  assert.match(canary, /--canary-only/u);
  assert.match(safariCanary, /runs-on: macos-15/u);
  assert.match(safariCanary, /safaridriver --enable/u);
  assert.match(safariCanary, /without saving/u);
  assert.doesNotMatch(safariCanary, /MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET/u);
  assert.match(production, /cron: "0 0,6 \* \* \*"/u);
  assert.match(production, /vars\.MI_NAVER_SHOPPING_CLOUD_ENABLED == 'true'/u);
  assert.match(production, /MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET/u);
  assert.match(production, /Verify 300 first, then atomically update due trackers/u);
  assert.doesNotMatch(cloudProvider, /^import\s+\{\s*chromium\s*\}\s+from\s+["']playwright["']/mu);
  assert.match(cloudProvider, /await import\(["']playwright["']\)/u);
});

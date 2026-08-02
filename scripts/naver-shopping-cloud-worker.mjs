import { pathToFileURL } from "node:url";

import { runLocalShoppingWorker } from "./naver-shopping-local-worker.mjs";
import {
  LOCAL_WORKER_ORGANIC_LIMIT,
  validateStrictLocalWorkerWindow,
} from "../src/server/naver-shopping/local-worker-contract.mjs";
import { NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA } from "../src/server/handlers/naver-shopping-rank.mjs";
import { createGitHubCloudProvider } from "../tools/naver-shopping-rank-collector/src/github-cloud.mjs";

const CLOUD_TIMEOUT_MS = 225_000;

function canaryRequest(env = process.env, nowMs = Date.now()) {
  const keyword = String(env.MI_NAVER_SHOPPING_CLOUD_CANARY_KEYWORD || "온열찜질기")
    .trim()
    .normalize("NFC");
  if (!keyword) throw new Error("cloud_canary_keyword_missing");
  return {
    schemaVersion: NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
    keyword,
    limit: LOCAL_WORKER_ORGANIC_LIMIT,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: new Date(nowMs + CLOUD_TIMEOUT_MS).toISOString(),
    requestId: `github-cloud-canary-${nowMs}`,
  };
}

export async function verifyGitHubCloudCollector(options = {}) {
  const env = options.env || process.env;
  const nowMs = options.nowMs?.() ?? Date.now();
  const provider = options.provider || createGitHubCloudProvider({ env });
  const ownsProvider = !options.provider;
  try {
    const request = canaryRequest(env, nowMs);
    const window = validateStrictLocalWorkerWindow(await provider.collect(request), {
      keyword: request.keyword,
      nowMs: options.nowMs?.() ?? Date.now(),
    });
    return {
      ok: true,
      keyword: request.keyword,
      checkedCount: window.checkedCount,
      source: window.source,
      rankEvidence: window.rankEvidence,
      collectionId: window.collectionId,
      excludedAdCount: window.excludedAdCount,
    };
  } finally {
    if (ownsProvider) await provider.close?.().catch(() => {});
  }
}

export async function runGitHubCloudShoppingWorker(options = {}) {
  const env = options.env || process.env;
  const provider = options.provider || createGitHubCloudProvider({ env });
  try {
    const proof = await verifyGitHubCloudCollector({
      env,
      provider,
      nowMs: options.nowMs,
    });
    const summary = await runLocalShoppingWorker({
      env: {
        ...env,
        MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
        NAVER_SHOPPING_PROVIDER_TIMEOUT_MS: String(CLOUD_TIMEOUT_MS),
      },
      provider,
      log: options.log,
      fetchImpl: options.fetchImpl,
      nowMs: options.nowMs,
      randomUUID: options.randomUUID,
      skipLock: options.skipLock,
    });
    return { proof, summary };
  } catch (error) {
    await provider.close?.().catch(() => {});
    throw error;
  }
}

const directlyExecuted = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (directlyExecuted) {
  const canaryOnly = process.argv.includes("--canary-only");
  const task = canaryOnly
    ? verifyGitHubCloudCollector({})
    : runGitHubCloudShoppingWorker({ log: console.log });
  task
    .then((result) => {
      console.log(JSON.stringify(result));
      if (!canaryOnly && (result.summary.failed > 0 || result.summary.releaseFailed > 0)) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(String(error?.code || error?.message || "github_cloud_worker_failed"));
      process.exitCode = 1;
    });
}


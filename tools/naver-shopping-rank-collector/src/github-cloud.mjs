import { chromium } from "playwright";

import { validateProviderWindow } from "./contract.mjs";
import { createPlaywrightProvider, ProviderError } from "./provider.mjs";

const GITHUB_HOSTED = "github-hosted";
const CLOUD_COLLECTION_PREFIX = "gh";

function normalizedRunnerValue(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

export function assertGitHubHostedRunner(env = process.env) {
  if (
    normalizedRunnerValue(env.GITHUB_ACTIONS).toLowerCase() !== "true"
    || normalizedRunnerValue(env.RUNNER_ENVIRONMENT).toLowerCase() !== GITHUB_HOSTED
  ) {
    throw new ProviderError("github_cloud_runner_required");
  }
  return true;
}

export function githubCloudCollectionId(window, env = process.env) {
  const runId = normalizedRunnerValue(env.GITHUB_RUN_ID, 40);
  const runAttempt = normalizedRunnerValue(env.GITHUB_RUN_ATTEMPT || "1", 10);
  const original = normalizedRunnerValue(window?.collectionId, 160);
  const digest = original.match(/([a-f0-9]{12,64})$/iu)?.[1]?.slice(0, 32) || "window";
  if (!/^\d+$/u.test(runId) || !/^\d+$/u.test(runAttempt)) {
    throw new ProviderError("github_cloud_run_identity_invalid");
  }
  return `${CLOUD_COLLECTION_PREFIX}-${runId}-${runAttempt}-${digest}`;
}

export function createGitHubCloudProvider(options = {}) {
  const env = options.env || process.env;
  assertGitHubHostedRunner(env);
  const browserFactory = options.browserFactory || (async () => chromium.launch({ headless: true }));
  const provider = createPlaywrightProvider({
    autoVerify: false,
    browserFactory,
    env,
    config: {
      browserChannel: "chromium",
      localWorkerEnabled: false,
      searchHost: "search.shopping.naver.com",
      headless: true,
      userDataDir: "",
      timeoutMs: 225_000,
      pageTimeoutMs: 30_000,
      queueMax: 2,
      cacheTtlMs: 10_000,
      cacheMax: 4,
      readinessTtlMs: 60_000,
      blockCooldownMs: 15 * 60_000,
      schemaCooldownMs: 30 * 60_000,
      canaryKeyword: normalizedRunnerValue(env.MI_NAVER_SHOPPING_CLOUD_CANARY_KEYWORD, 100)
        || "온열찜질기",
      canaryLimit: 5,
    },
  });

  return {
    async status() {
      return provider.status();
    },
    async collect(request) {
      const rawWindow = await provider.collect(request);
      const window = {
        ...rawWindow,
        collectionId: githubCloudCollectionId(rawWindow, env),
      };
      return validateProviderWindow(window, request);
    },
    async close() {
      await provider.close();
    },
  };
}


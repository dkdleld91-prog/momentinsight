import { pathToFileURL } from "node:url";

import { validateStrictLocalWorkerWindow } from "../src/server/naver-shopping/local-worker-contract.mjs";
import { collectGitHubSafariWindow } from "../tools/naver-shopping-rank-collector/src/safari-cloud.mjs";

export async function verifyGitHubSafariCollector(options = {}) {
  const result = await collectGitHubSafariWindow(options);
  const nowMs = options.nowMs?.() ?? Date.now();
  const window = validateStrictLocalWorkerWindow(result.window, {
    keyword: result.window.keyword,
    nowMs,
  });
  return {
    ok: true,
    browser: result.browser,
    userAgent: result.userAgent,
    keyword: window.keyword,
    checkedCount: window.checkedCount,
    source: window.source,
    rankEvidence: window.rankEvidence,
    collectionId: window.collectionId,
    excludedAdCount: window.excludedAdCount,
    saved: false,
  };
}

const directlyExecuted = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (directlyExecuted) {
  verifyGitHubSafariCollector({})
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(String(error?.code || error?.message || "github_safari_canary_failed"));
      if (error?.detail) console.error(String(error.detail).slice(0, 1_000));
      process.exitCode = 1;
    });
}

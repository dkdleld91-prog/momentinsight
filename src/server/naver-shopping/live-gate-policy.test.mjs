import assert from "node:assert/strict";
import test from "node:test";

import { hybridLiveGateEvidence } from "./live-gate-policy.mjs";

const workerEvidence = {
  checkedAt: "2026-08-03T00:00:00.000Z",
  ageMinutes: 10,
  checkedCount: 300,
  source: "naver_shopping_normal_chrome",
};

test("hybrid gate accepts recent atomic 300 proof when the optional top window fails closed", () => {
  const evidence = hybridLiveGateEvidence({
    workerEvidence,
    mobileError: Object.assign(new Error("shopping_mobile_top_schema_drift"), {
      code: "shopping_mobile_top_schema_drift",
    }),
    latencyMs: 123,
  });

  assert.equal(evidence.ok, true);
  assert.equal(evidence.deploymentEligible, true);
  assert.equal(evidence.fullCoverageReady, true);
  assert.equal(evidence.safeExactMatchReady, false);
  assert.equal(evidence.topFallbackStatus, "temporarily_unavailable");
  assert.equal(evidence.code, "SHOPPING_RANK_HYBRID_WORKER_READY_TOP_FALLBACK_DEGRADED");
  assert.equal(evidence.missPolicy, "preserve_last_verified_rank_and_queue_local_worker");
});

test("hybrid gate reports both verified paths when the exact top window is healthy", () => {
  const evidence = hybridLiveGateEvidence({
    workerEvidence,
    mobileEvidence: {
      fallback: {
        source: "naver_integrated_search_mobile_top_fallback",
        rankEvidence: "naver_integrated_search_mobile_sas_rank",
        checkedCount: 44,
        verifiedThroughRank: 9,
      },
      ranks: [1, 2, 3, 5, 6],
      organicOnly: true,
      highestExactRank: 6,
    },
  });

  assert.equal(evidence.code, "SHOPPING_RANK_HYBRID_LIVE_READY");
  assert.equal(evidence.safeExactMatchReady, true);
  assert.equal(evidence.topFallbackStatus, "ready");
  assert.equal(evidence.fullCoverageReady, true);
});

test("hybrid gate rejects missing or incomplete worker proof", () => {
  assert.throws(
    () => hybridLiveGateEvidence({ workerEvidence: { checkedCount: 299 } }),
    /hybrid_worker_recent_300_proof_missing/u,
  );
});

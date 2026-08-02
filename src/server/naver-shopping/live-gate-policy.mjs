function safeMessage(error) {
  return String(error?.code || error?.message || "mobile_top_fallback_unavailable")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 160) || "mobile_top_fallback_unavailable";
}

export function hybridLiveGateEvidence({
  workerEvidence,
  mobileEvidence = null,
  mobileError = null,
  latencyMs = 0,
} = {}) {
  if (!workerEvidence || Number(workerEvidence.checkedCount) !== 300) {
    throw new Error("hybrid_worker_recent_300_proof_missing");
  }

  const fallback = mobileEvidence?.fallback || null;
  const ranks = Array.isArray(mobileEvidence?.ranks) ? mobileEvidence.ranks : [];
  const topFallbackReady = Boolean(fallback && ranks.length > 0 && mobileEvidence?.organicOnly === true);

  return {
    ok: true,
    code: topFallbackReady
      ? "SHOPPING_RANK_HYBRID_LIVE_READY"
      : "SHOPPING_RANK_HYBRID_WORKER_READY_TOP_FALLBACK_DEGRADED",
    mode: "hybrid_local_worker",
    source: topFallbackReady
      ? `${fallback.source}+signed_local_worker`
      : "signed_local_worker",
    rankEvidence: topFallbackReady ? fallback.rankEvidence : "atomic_organic_300_window",
    checkedCount: topFallbackReady ? fallback.checkedCount : 300,
    firstRank: topFallbackReady ? ranks[0] : undefined,
    highestExactRank: topFallbackReady ? mobileEvidence.highestExactRank : undefined,
    verifiedThroughRank: topFallbackReady ? fallback.verifiedThroughRank : undefined,
    organicOnly: topFallbackReady ? true : undefined,
    safeExactMatchReady: topFallbackReady,
    fullCoverageReady: true,
    deploymentEligible: true,
    workerEvidence,
    topFallbackStatus: topFallbackReady ? "ready" : "temporarily_unavailable",
    topFallbackMessage: topFallbackReady ? undefined : safeMessage(mobileError),
    missPolicy: "preserve_last_verified_rank_and_queue_local_worker",
    latencyMs: Math.max(0, Number(latencyMs) || 0),
    message: topFallbackReady
      ? "The exact top window and a recent atomic 300-rank worker result both passed."
      : "The recent atomic 300-rank worker result passed. The optional immediate top window failed closed and does not block queued 300-rank tracking.",
  };
}

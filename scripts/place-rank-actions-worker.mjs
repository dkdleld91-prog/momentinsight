// 2026-09-26 대표 결정(무료 기준): 플레이스 순위를 GitHub Actions 러너에서 직접 수집한다.
// Render 무료(512MB·0.1 CPU)로는 1쪽(약 70곳)을 넘지 못했다. 공개 저장소의 러너(4코어·16GB)는 무료다.
// 흐름: 서버에서 할 일 하나 받기(worker-claim) → 이 러너의 브라우저로 순위 세기 → 결과 돌려주기(worker-complete).
// 공개 저장소라 실행 기록이 공개된다. 키워드·장소 이름·순위는 기록하지 않고 개수만 남긴다.
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_ENDPOINT = "https://insight.momentlabs.co.kr/api/naver-place-rank-cron";
export const MAX_JOBS = 20;
const REQUEST_TIMEOUT_MS = 120000;
const ERROR_CODE_PATTERN = /^[a-z0-9_:.-]{1,80}$/;

function errorCode(error) {
  const message = String(error?.message || "");
  return ERROR_CODE_PATTERN.test(message) ? message : "place_rank_worker_failed";
}

async function postJson(fetchImpl, url, secret, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  } catch {
    return { status: 0, payload: null };
  } finally {
    clearTimeout(timeout);
  }
}

// fallback=true 이면 워크플로가 예전 경로(서버 → Render 수집기)로 이어서 처리한다.
export async function runPlaceRankWorker({
  fetchImpl = fetch,
  lookup,
  secret,
  endpoint = DEFAULT_ENDPOINT,
  maxJobs = MAX_JOBS,
  log = console.log,
} = {}) {
  const totals = { claimed: 0, saved: 0, found: 0, notFound: 0, partial: 0, failed: 0, leaseLost: 0, lookupErrors: 0 };
  let consecutiveLookupErrors = 0;
  for (let index = 0; index < maxJobs; index += 1) {
    const claim = await postJson(fetchImpl, `${endpoint}?mode=worker-claim`, secret, {});
    if (claim.status !== 200 || claim.payload?.ok !== true || claim.payload?.worker !== true) {
      // 서버가 아직 새 기능 전 버전이거나 응답이 이상하면 이 러너는 손을 떼고 예전 경로에 맡긴다.
      return { fallback: true, reason: "worker_api_unavailable", drained: false, totals };
    }
    const job = claim.payload.job;
    if (!job) return { fallback: false, reason: "", drained: true, totals };
    totals.claimed += 1;

    let result = null;
    let error = "";
    try {
      result = await lookup({
        keyword: job.keyword,
        placeId: job.placeId,
        placeUrl: job.placeUrl,
        placeName: job.placeName,
        maxRank: job.maxRank,
        providerDeadlineAt: job.providerDeadlineAt,
      });
      consecutiveLookupErrors = 0;
    } catch (lookupError) {
      error = errorCode(lookupError);
      totals.lookupErrors += 1;
      consecutiveLookupErrors += 1;
    }

    const complete = await postJson(fetchImpl, `${endpoint}?mode=worker-complete`, secret, {
      trackerId: job.trackerId,
      processingToken: job.processingToken,
      result,
      error,
    });
    const outcome = complete.status === 200 && complete.payload?.worker === true ? String(complete.payload.outcome || "") : "complete_failed";
    if (complete.payload?.saved === true) totals.saved += 1;
    if (outcome === "found") totals.found += 1;
    else if (outcome === "not_found") totals.notFound += 1;
    else if (outcome === "partial") totals.partial += 1;
    else if (outcome === "lease_lost") totals.leaseLost += 1;
    else totals.failed += 1;
    log("Naver place rank worker item " + JSON.stringify({ job: index + 1, outcome, lookupError: error ? error : undefined }));

    // 이 러너에서 연속으로 조회가 실패하고 아직 한 건도 저장하지 못했으면(예: 러너 IP 접근 제한)
    // 나머지는 예전 경로에 맡긴다.
    if (consecutiveLookupErrors >= 2 && totals.saved === 0) {
      return { fallback: true, reason: "runner_lookup_failing", drained: false, totals };
    }
  }
  return { fallback: false, reason: "", drained: false, totals };
}

async function main() {
  const secret = String(process.env.MI_RANK_CRON_SECRET || "").trim();
  if (!secret) {
    console.log("::error::MI_RANK_CRON_SECRET is missing");
    process.exit(1);
  }
  const collectorPath = fileURLToPath(new URL("../tools/naver-place-rank-collector/src/naver-place-rank.mjs", import.meta.url));
  const { lookupNaverPlaceRank } = await import(pathToFileURL(collectorPath).href);
  const outcome = await runPlaceRankWorker({
    secret,
    endpoint: process.env.MI_PLACE_CRON_ENDPOINT || DEFAULT_ENDPOINT,
    lookup: (payload) => lookupNaverPlaceRank(payload),
  });
  console.log("Naver place rank worker window " + JSON.stringify({ ...outcome.totals, drained: outcome.drained, fallback: outcome.fallback, reason: outcome.reason }));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `fallback=${outcome.fallback ? "true" : "false"}\n`);
  }
  if (outcome.fallback) {
    console.log(`::warning::Naver place rank worker handed off to the server collector (${outcome.reason})`);
    return;
  }
  if (outcome.totals.failed > 0) {
    throw new Error(`Naver place rank worker finished with ${outcome.totals.failed} failed tracker(s)`);
  }
  if (outcome.totals.partial > 0) {
    throw new Error(`Naver place rank worker completed with ${outcome.totals.partial} partial tracker result(s)`);
  }
  if (!outcome.drained) {
    throw new Error(`Naver place rank worker reached the ${MAX_JOBS}-job safety cap before the queue drained`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.log("::error::" + String(error?.message || error).slice(0, 300));
    process.exit(1);
  });
}

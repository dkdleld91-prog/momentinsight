// 2026-09-26 대표 결정(무료 기준): 플레이스 순위를 GitHub Actions 러너에서 직접 수집한다.
// Render 무료(512MB·0.1 CPU)로는 1쪽(약 70곳)을 넘지 못했다. 공개 저장소의 러너(4코어·16GB)는 무료다.
// 흐름: 서버에서 할 일 하나 받기(worker-claim) → 이 러너의 브라우저로 순위 세기 → 결과 돌려주기(worker-complete).
// 공개 저장소라 실행 기록이 공개된다. 키워드·장소 이름·순위는 기록하지 않고 개수만 남긴다.
// 2026-09-27 대표 승인: 밀린 할 일이 많다는 이유만으로 실행이 실패(빨간 X)하지 않는다(예전 20건 상한 제거).
// 서버가 '할 일 없음'이라 할 때까지 한 건씩 차례로 처리하되 새 할 일은 시작 후 45분 안에서만 받고,
// 시간 예산·안전 상한·같은 추적기 재방문에서는 성공(알림 한 줄)으로 멈춰 남은 일을 다음 예약 실행에 넘긴다.
// 추적기당 네이버 요청은 늘지 않는다: 한 실행에서 한 추적기는 한 번만 세고, 동시에 두 곳을 세지 않는다.
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_ENDPOINT = "https://insight.momentlabs.co.kr/api/naver-place-rank-cron";
// 새 할 일을 받는 시간 상한(러너 수집 단계 시작부터). 워크플로 timeout-minutes 100 에서
//   준비(체크아웃·브라우저 설치 + push 실행의 90초 대기) 약 4분,
//   예산 직전에 받은 한 건의 꼬리(받기 120초 + 조회 보호 최대 330초 + 결과 120초) 약 10분,
//   러너가 한 건도 저장하기 전에 손을 뗄 때(fallback) 이어받는 예전 단계(서버 → Render) 여유 40분
// 을 빼고 남긴 값이다. fallback 은 시작 후 10분 안에서만 나므로(FALLBACK_WINDOW_MS) 예전 단계는 적어도
// 100 − 4 − 10 = 86분을 갖는다. 예전 단계의 이론상 최악(90초 대기 + 20묶음 × 262초 ≈ 89분)은 20묶음이
// 전부 요청 제한(260초) 직전까지 걸릴 때뿐이다.
export const DEFAULT_TIME_BUDGET_MS = 45 * 60 * 1000;
// 예전 경로로 넘길(fallback) 수 있는 시간(러너 수집 단계 시작부터). 이보다 늦게 넘기면 예전 단계가
// 작업 제한 시간(100분) 안에 끝난다는 보장이 없고, 러너가 이미 쓴 시간만큼 알림도 늦어진다.
export const FALLBACK_WINDOW_MS = 10 * 60 * 1000;
// 정상 운영에서는 닿지 않는 안전 상한(2026-09-27 활성 플레이스 추적기 16곳). 닿아도 실패가 아니다.
export const MAX_JOBS_PER_RUN = 200;
// 결과를 기록하지 못한 추적기(결과 전송 실패·처리 권한 만료)가 리스 만료 뒤 다시 올 때 건너뛰는 횟수 상한.
export const MAX_UNRECORDED_REVISITS = 3;
export const LOOKUP_TIMEOUT_CODE = "place_rank_worker_lookup_timeout";
const REQUEST_TIMEOUT_MS = 120000;
// 서버가 준 조회 마감(providerDeadlineAt, 약 210초) 뒤 이만큼 더 기다려도 끝나지 않으면 멈춘 것으로 본다.
// 최대값 330초는 서버 처리 권한(리스 360초) 안에 들어온다 — 보호 시간 초과로 lease_lost 가 생기지 않는다.
// (테스트가 서버 기본값 360초·조회 예산 210초와 함께 고정한다.)
export const LOOKUP_GUARD_GRACE_MS = 60000;
export const LOOKUP_GUARD_MAX_MS = 330000;
// 한 건이라도 저장한 뒤 조회가 연달아 이만큼 실패하면(차단·러너 이상 의심) 이번 실행은 더 보내지 않는다.
// 예전 20건 상한이 하던 '요청 폭주 방지'를 시간 예산 아래에서도 유지한다.
const MAX_CONSECUTIVE_LOOKUP_ERRORS = 3;
// 서버가 결과를 받아 추적기에 기록한 결과(성공·부분·실패 재시도 예약). 이 밖(결과 전송 실패·lease_lost 등)은
// 처리 권한이 그대로 남아 있다가 리스 만료 뒤 같은 추적기가 다시 받기 순서 맨 앞으로 온다.
const RECORDED_OUTCOMES = new Set(["found", "not_found", "partial", "failed", "not_configured"]);
const ERROR_CODE_PATTERN = /^[a-z0-9_:.-]{1,80}$/;
// 이 멈춤 이유는 결과 전송이 lease_lost 로 돌아와 실패 건수가 0 이어도 실패(빨간 X)다.
const FAILING_STOP_REASONS = new Set(["worker_api_lost", "lookup_timeout", "lookup_failing"]);
// 예전 경로로 넘기지 않은 이유(공개 로그·오류 줄에 쓰는 설명).
const HANDOFF_BLOCK_TEXT = {
  saved: "trackers already saved",
  lookup_succeeded: "a lookup already succeeded on this runner",
  late: `more than ${FALLBACK_WINDOW_MS / 60000} minutes since start`,
};

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

function lookupGuardDelay(job, nowMs, override) {
  if (Number.isFinite(override) && override > 0) return override;
  const remaining = Number(job?.providerDeadlineAt) - nowMs;
  if (!Number.isFinite(remaining)) return LOOKUP_GUARD_MAX_MS;
  return Math.min(LOOKUP_GUARD_MAX_MS, Math.max(0, remaining) + LOOKUP_GUARD_GRACE_MS);
}

// 조회가 끝나지 않으면(브라우저 멈춤) 보호 시간 뒤 오류로 끝낸다. 멈춘 조회는 계속 돌 수 있으므로
// 호출자는 이 경우 새 할 일을 받지 않는다(두 번째 브라우저를 띄우지 않는다).
async function lookupWithGuard(lookup, payload, delayMs) {
  let timer = null;
  let timedOut = false;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(LOOKUP_TIMEOUT_CODE));
    }, delayMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => lookup(payload)), guard]);
    return { result, error: "", timedOut: false };
  } catch (lookupError) {
    return { result: null, error: timedOut ? LOOKUP_TIMEOUT_CODE : errorCode(lookupError), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

// fallback=true 이면 워크플로가 예전 경로(서버 → Render 수집기)로 이어서 처리한다. 계기는 예전과 같다:
// 워커 API 가 안 되거나(worker_api_unavailable) 저장 0건에서 조회가 연속 2회 실패(runner_lookup_failing).
// 단, 늦은 fallback 은 없다 — 세 조건을 모두 채울 때만 넘긴다: 아무것도 저장하지 않았고, 이 러너에서 조회가
// 한 번도 성공하지 않았고(쓸 수 있는 결과를 돌려준 적 없음), 시작 후 10분이 지나지 않았다. 하나라도 어기면
// 넘기지 않고 실패(빨간 X)로 끝내며 이유(handoffBlockedBy: saved · lookup_succeeded · late)를 로그에 남긴다.
// 예전 경로도 같은 서버를 부르고, 이미 센 추적기를 다시 세게 되며, 늦게 넘기면 작업 제한 시간에 걸린다.
// stopReason: drained(받을 일 없음) · time_budget · job_cap · revisit · lookup_timeout · lookup_failing · worker_api_lost
export async function runPlaceRankWorker({
  fetchImpl = fetch,
  lookup,
  secret,
  endpoint = DEFAULT_ENDPOINT,
  maxJobs = MAX_JOBS_PER_RUN,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  lookupGuardMs = null,
  now = Date.now,
  log = console.log,
} = {}) {
  const totals = { claimed: 0, saved: 0, found: 0, notFound: 0, partial: 0, failed: 0, leaseLost: 0, lookupErrors: 0 };
  const startedAt = now();
  // 추적기 → 서버가 결과를 기록했는지. 한 실행에서 한 추적기는 한 번만 센다.
  const attempted = new Map();
  let unrecordedRevisits = 0;
  let consecutiveLookupErrors = 0;
  let lookupSuccesses = 0;
  const stopped = (stopReason) => ({ fallback: false, reason: "", drained: false, stopReason, totals });
  // 예전 경로로 넘기면 안 되는 이유. 빈 문자열이면 넘겨도 된다.
  const handoffBlockedBy = () => {
    if (totals.saved > 0) return "saved";
    if (lookupSuccesses > 0) return "lookup_succeeded";
    if (now() - startedAt >= FALLBACK_WINDOW_MS) return "late";
    return "";
  };
  const refuseHandoff = (stopReason, reason, blockedBy) => {
    log("Naver place rank worker stopped " + JSON.stringify({
      stopReason,
      reason,
      action: "no_handoff",
      handoffBlockedBy: blockedBy,
      saved: totals.saved,
      lookupSucceeded: lookupSuccesses,
      elapsedSeconds: Math.round((now() - startedAt) / 1000),
    }));
    return { fallback: false, reason, drained: false, stopReason, handoffBlockedBy: blockedBy, totals };
  };

  for (;;) {
    if (totals.claimed >= maxJobs) return stopped("job_cap");
    if (now() - startedAt >= timeBudgetMs) return stopped("time_budget");

    const claim = await postJson(fetchImpl, `${endpoint}?mode=worker-claim`, secret, {});
    if (claim.status !== 200 || claim.payload?.ok !== true || claim.payload?.worker !== true) {
      const blockedBy = handoffBlockedBy();
      if (blockedBy) return refuseHandoff("worker_api_lost", "worker_api_unavailable", blockedBy);
      // 서버가 아직 새 기능 전 버전이거나 응답이 이상하면 이 러너는 손을 떼고 예전 경로에 맡긴다.
      return { fallback: true, reason: "worker_api_unavailable", drained: false, stopReason: "", totals };
    }
    const job = claim.payload.job;
    if (!job) return { fallback: false, reason: "", drained: true, stopReason: "drained", totals };

    const trackerKey = String(job.trackerId || "");
    if (attempted.has(trackerKey)) {
      if (attempted.get(trackerKey) === true) {
        // 이 실행에서 이미 결과를 기록한 추적기가 서버 재시도 일정(5분 뒤부터)으로 다시 왔다. 받는 순서가
        // next_check_at 오름차순이라 이때는 처음부터 밀려 있던 할 일을 모두 받은 뒤다. 다시 세면 추적기당
        // 네이버 요청이 늘어나므로 세지 않고 멈춘다. 방금 받은 처리 권한은 리스(360초) 뒤 저절로 풀린다.
        log("Naver place rank worker revisit " + JSON.stringify({ job: totals.claimed + 1, action: "deferred_to_next_run" }));
        return stopped("revisit");
      }
      // 결과를 기록하지 못한 추적기(결과 전송 실패 등)가 리스 만료 뒤 원래의 이른 next_check_at 으로 맨 앞에
      // 돌아왔다. 여기서 멈추면 아직 받지 못한 밀린 할 일이 다음 실행으로 밀린다. 다시 세지 않고(요청 불변)
      // 건너뛴 뒤 다음 할 일을 받는다. 건너뛴 추적기는 다음 예약 실행이 처리한다.
      if (unrecordedRevisits >= MAX_UNRECORDED_REVISITS) {
        log("Naver place rank worker revisit " + JSON.stringify({ job: totals.claimed + 1, action: "deferred_to_next_run" }));
        return stopped("revisit");
      }
      unrecordedRevisits += 1;
      log("Naver place rank worker revisit " + JSON.stringify({ job: totals.claimed + 1, action: "unrecorded_revisit_skipped" }));
      continue;
    }
    attempted.set(trackerKey, false);
    totals.claimed += 1;

    const lookupOutcome = await lookupWithGuard(lookup, {
      keyword: job.keyword,
      placeId: job.placeId,
      placeUrl: job.placeUrl,
      placeName: job.placeName,
      maxRank: job.maxRank,
      providerDeadlineAt: job.providerDeadlineAt,
    }, lookupGuardDelay(job, Date.now(), lookupGuardMs));
    const result = lookupOutcome.result;
    const error = lookupOutcome.error;
    if (error) {
      totals.lookupErrors += 1;
      consecutiveLookupErrors += 1;
    } else {
      consecutiveLookupErrors = 0;
      // 쓸 수 있는 결과(ok:false 가 아님)를 돌려줬으면 이 러너의 조회는 된다 — 이후로는 예전 경로로 넘기지 않는다.
      if (result?.ok !== false) lookupSuccesses += 1;
    }

    const complete = await postJson(fetchImpl, `${endpoint}?mode=worker-complete`, secret, {
      trackerId: job.trackerId,
      processingToken: job.processingToken,
      result: error ? null : result,
      error,
    });
    const outcome = complete.status === 200 && complete.payload?.worker === true ? String(complete.payload.outcome || "") : "complete_failed";
    attempted.set(trackerKey, RECORDED_OUTCOMES.has(outcome));
    if (complete.payload?.saved === true) totals.saved += 1;
    if (outcome === "found") totals.found += 1;
    else if (outcome === "not_found") totals.notFound += 1;
    else if (outcome === "partial") totals.partial += 1;
    else if (outcome === "lease_lost") totals.leaseLost += 1;
    else totals.failed += 1;
    log("Naver place rank worker item " + JSON.stringify({ job: totals.claimed, outcome, lookupError: error ? error : undefined }));

    // 이 러너에서 연속으로 조회가 실패하고 아직 한 건도 저장하지 못했으면(예: 러너 IP 접근 제한)
    // 나머지는 예전 경로에 맡긴다. 넘길 수 없으면(조회 성공이 있었거나 10분 지남) 여기서 멈춘다 —
    // 예전에 fallback 하던 자리라 러너가 보내는 요청 수는 예전과 같다.
    if (consecutiveLookupErrors >= 2 && totals.saved === 0) {
      const blockedBy = handoffBlockedBy();
      if (blockedBy) {
        return refuseHandoff(lookupOutcome.timedOut ? "lookup_timeout" : "lookup_failing", "runner_lookup_failing", blockedBy);
      }
      return { fallback: true, reason: "runner_lookup_failing", drained: false, stopReason: "", totals };
    }
    if (lookupOutcome.timedOut) return stopped("lookup_timeout");
    if (consecutiveLookupErrors >= MAX_CONSECUTIVE_LOOKUP_ERRORS) return stopped("lookup_failing");
  }
}

// 실행 결과 판정. 실패·부분 결과·조회 멈춤(lookup_timeout·lookup_failing)·워커 API 끊김은 빨간 X 이고,
// 많이 밀려서 멈춘 것은 알림 한 줄(성공)이다. 판정은 합계만이 아니라 멈춘 이유도 본다 — 조회가 멈추거나
// 연달아 실패했는데 결과 전송이 lease_lost 로 돌아오면 실패 건수가 0 이라 합계만으로는 초록이 된다.
export function placeRankWorkerVerdict(outcome) {
  const totals = outcome?.totals || {};
  if (outcome?.fallback) {
    return { fail: false, annotation: `::warning::Naver place rank worker handed off to the server collector (${outcome.reason})` };
  }
  const stopReason = String(outcome?.stopReason || "");
  if (FAILING_STOP_REASONS.has(stopReason)) {
    const blocked = HANDOFF_BLOCK_TEXT[outcome?.handoffBlockedBy];
    const counts = ["claimed", "saved", "failed", "leaseLost", "lookupErrors"].map((key) => `${key}=${Number(totals[key] || 0)}`).join(" ");
    let what = "";
    if (stopReason === "worker_api_lost") {
      what = `lost the worker API after saving ${Number(totals.saved || 0)} tracker(s)`;
    } else if (stopReason === "lookup_timeout") {
      what = "stopped (lookup_timeout): a lookup did not finish within the guard time";
    } else {
      what = "stopped (lookup_failing): lookups kept failing on this runner";
    }
    const handoff = stopReason === "worker_api_lost" || blocked
      ? `; not handing off to the server collector (${outcome?.reason || "worker_api_unavailable"}${blocked ? `: ${blocked}` : ""})`
      : "";
    return { fail: true, annotation: "", message: `Naver place rank worker ${what}${handoff} [${counts}]` };
  }
  if (Number(totals.failed || 0) > 0) {
    return { fail: true, annotation: "", message: `Naver place rank worker finished with ${totals.failed} failed tracker(s)` };
  }
  if (Number(totals.partial || 0) > 0) {
    return { fail: true, annotation: "", message: `Naver place rank worker completed with ${totals.partial} partial tracker result(s)` };
  }
  if (!outcome?.drained) {
    return {
      fail: false,
      annotation: `::notice::Naver place rank worker stopped (${outcome?.stopReason || "unknown"}) after ${Number(totals.claimed || 0)} tracker(s); remaining due trackers continue in the next scheduled run`,
    };
  }
  return { fail: false, annotation: "" };
}

async function main() {
  const secret = String(process.env.MI_RANK_CRON_SECRET || "").trim();
  if (!secret) {
    console.log("::error::MI_RANK_CRON_SECRET is missing");
    process.exit(1);
  }
  const collectorPath = fileURLToPath(new URL("../tools/naver-place-rank-collector/src/naver-place-rank.mjs", import.meta.url));
  const { lookupNaverPlaceRank } = await import(pathToFileURL(collectorPath).href);
  const startedAt = Date.now();
  const outcome = await runPlaceRankWorker({
    secret,
    endpoint: process.env.MI_PLACE_CRON_ENDPOINT || DEFAULT_ENDPOINT,
    lookup: (payload) => lookupNaverPlaceRank(payload),
  });
  console.log("Naver place rank worker window " + JSON.stringify({
    ...outcome.totals,
    drained: outcome.drained,
    fallback: outcome.fallback,
    reason: outcome.reason,
    stopReason: outcome.stopReason,
    handoffBlockedBy: outcome.handoffBlockedBy || undefined,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `fallback=${outcome.fallback ? "true" : "false"}\n`);
  }
  const verdict = placeRankWorkerVerdict(outcome);
  if (verdict.annotation) console.log(verdict.annotation);
  if (verdict.fail) throw new Error(verdict.message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // 멈춘 조회(보호 시간 초과)가 남긴 브라우저가 프로세스를 붙잡아 작업 제한 시간까지 끌지 않도록 명시적으로 끝낸다.
  main().then(
    () => process.exit(0),
    (error) => {
      console.log("::error::" + String(error?.message || error).slice(0, 300));
      process.exit(1);
    },
  );
}

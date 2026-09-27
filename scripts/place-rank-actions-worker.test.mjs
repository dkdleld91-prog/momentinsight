import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  DEFAULT_TIME_BUDGET_MS,
  FALLBACK_WINDOW_MS,
  LOOKUP_GUARD_GRACE_MS,
  LOOKUP_GUARD_MAX_MS,
  LOOKUP_TIMEOUT_CODE,
  MAX_JOBS_PER_RUN,
  MAX_UNRECORDED_REVISITS,
  placeRankWorkerVerdict,
  runPlaceRankWorker,
} from "./place-rank-actions-worker.mjs";

function job(id) {
  return { trackerId: id, processingToken: `tok-${id}`, keyword: "비밀키워드", placeId: "123", placeUrl: "https://map.naver.com/p/entry/place/123", placeName: "비밀상호", maxRank: 300, providerDeadlineAt: Date.now() + 60000 };
}

function fakeServer(jobs, outcomes, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || "{}");
    calls.push({ url: String(url), body, auth: init.headers.authorization });
    if (String(url).includes("worker-claim")) {
      if (options.oldServer) return new Response(JSON.stringify({ ok: false, summary: {} }), { status: 503 });
      return new Response(JSON.stringify({ ok: true, worker: true, job: jobs.shift() || null }), { status: 200 });
    }
    const outcome = outcomes.shift() || "found";
    // "complete_failed" 는 서버가 결과를 받지 못한 경우(예: 일시적 504)를 흉내 낸다.
    if (outcome === "complete_failed") return new Response("gateway timeout", { status: 504 });
    const saved = ["found", "not_found", "partial"].includes(outcome);
    return new Response(JSON.stringify({ ok: true, worker: true, outcome, saved }), { status: 200 });
  };
  return { fetchImpl, calls };
}

test("러너는 큐가 빌 때까지 할 일을 받아 결과를 돌려주고, 공개 로그에 키워드·상호를 남기지 않는다", async () => {
  const server = fakeServer([job("a"), job("b")], ["found", "not_found"]);
  const logs = [];
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s3cret",
    lookup: async (payload) => ({ ok: true, matched: true, rank: 120, checkedCount: 300, keywordEcho: payload.keyword }),
    log: (line) => logs.push(line),
  });
  assert.equal(outcome.fallback, false);
  assert.equal(outcome.drained, true);
  assert.equal(outcome.totals.claimed, 2);
  assert.equal(outcome.totals.found, 1);
  assert.equal(outcome.totals.notFound, 1);
  const completes = server.calls.filter((call) => call.url.includes("worker-complete"));
  assert.equal(completes.length, 2);
  assert.equal(completes[0].body.processingToken, "tok-a");
  assert.equal(completes[0].body.result.rank, 120);
  assert.ok(server.calls.every((call) => call.auth === "Bearer s3cret"));
  const joined = logs.join("\n");
  assert.equal(joined.includes("비밀키워드") || joined.includes("비밀상호") || joined.includes("s3cret"), false);
});

test("서버가 아직 새 기능 전 버전이면 러너는 손을 떼고 예전 경로(Render)에 맡긴다", async () => {
  const server = fakeServer([job("a")], [], { oldServer: true });
  let lookups = 0;
  const outcome = await runPlaceRankWorker({ fetchImpl: server.fetchImpl, secret: "s", lookup: async () => { lookups += 1; return {}; }, log: () => {} });
  assert.equal(outcome.fallback, true);
  assert.equal(outcome.reason, "worker_api_unavailable");
  assert.equal(lookups, 0);
});

test("러너에서 조회가 연속 실패하고 저장이 한 건도 없으면 오류 코드를 돌려주고 예전 경로로 넘긴다", async () => {
  const server = fakeServer([job("a"), job("b"), job("c")], ["failed", "failed"]);
  server.fetchImpl = ((inner) => async (url, init) => {
    const response = await inner(url, init);
    if (String(url).includes("worker-complete")) {
      return new Response(JSON.stringify({ ok: true, worker: true, outcome: "failed", saved: false }), { status: 200 });
    }
    return response;
  })(server.fetchImpl);
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    lookup: async () => { throw new Error("naver_place_access_limited"); },
    log: () => {},
  });
  assert.equal(outcome.fallback, true);
  assert.equal(outcome.reason, "runner_lookup_failing");
  assert.equal(outcome.totals.claimed, 2, "세 번째는 받지 않는다");
  const completes = server.calls.filter((call) => call.url.includes("worker-complete"));
  assert.equal(completes[0].body.error, "naver_place_access_limited");
  assert.equal(completes[0].body.result, null);
});

// ── 2026-09-27 대표 승인: 밀린 할 일이 많다는 이유만으로 실행이 실패하지 않는다 ──
const found = async () => ({ ok: true, matched: true, rank: 7, checkedCount: 300 });
const claimCalls = (server) => server.calls.filter((call) => call.url.includes("worker-claim")).length;
const completeCalls = (server) => server.calls.filter((call) => call.url.includes("worker-complete"));
const jobs = (count, prefix = "t") => Array.from({ length: count }, (_, index) => job(`${prefix}${index}`));

test("할 일이 20건을 넘어도 실패하지 않고, 서버가 '할 일 없음'이라 할 때까지 한 건씩 차례로 처리한다", async () => {
  const server = fakeServer(jobs(25), []);
  let inFlight = 0;
  let maxInFlight = 0;
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    log: () => {},
    lookup: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return found();
    },
  });
  assert.equal(outcome.fallback, false);
  assert.equal(outcome.drained, true);
  assert.equal(outcome.stopReason, "drained");
  assert.equal(outcome.totals.claimed, 25);
  assert.equal(outcome.totals.found, 25);
  assert.equal(claimCalls(server), 26, "마지막 받기에서 서버가 할 일 없음(null)을 돌려준다");
  assert.equal(maxInFlight, 1, "동시에 두 곳을 세지 않는다");
  assert.deepEqual(placeRankWorkerVerdict(outcome), { fail: false, annotation: "" });
});

test("새 할 일은 시작 후 45분 안에서만 받는다 — 45분이 되면 받지 않고 성공(알림 줄)으로 끝낸다", async () => {
  assert.equal(DEFAULT_TIME_BUDGET_MS, 45 * 60 * 1000);
  for (const [lookupMinutes, expectedClaims] of [[15, 3], [10, 5]]) {
    const server = fakeServer(jobs(10), []);
    let current = 0;
    const outcome = await runPlaceRankWorker({
      fetchImpl: server.fetchImpl,
      secret: "s",
      log: () => {},
      now: () => current,
      lookup: async () => {
        current += lookupMinutes * 60 * 1000;
        return found();
      },
    });
    // 15분짜리 조회: 0·15·30분에 받고 45분 정각에는 받지 않는다. 10분짜리: 0~40분에 5건.
    assert.equal(outcome.stopReason, "time_budget", `lookup ${lookupMinutes}m`);
    assert.equal(outcome.drained, false);
    assert.equal(outcome.fallback, false);
    assert.equal(outcome.totals.claimed, expectedClaims);
    assert.equal(claimCalls(server), expectedClaims, "예산이 지난 뒤에는 할 일을 받지 않는다");
    const verdict = placeRankWorkerVerdict(outcome);
    assert.equal(verdict.fail, false);
    assert.match(verdict.annotation, /^::notice::Naver place rank worker stopped \(time_budget\) after \d+ tracker\(s\)/u);
  }
});

test("안전 상한 200건에 닿아도 실패가 아니며 상한을 넘는 할 일은 받지 않는다", async () => {
  assert.equal(MAX_JOBS_PER_RUN, 200);
  const server = fakeServer(jobs(205), []);
  const outcome = await runPlaceRankWorker({ fetchImpl: server.fetchImpl, secret: "s", log: () => {}, lookup: found });
  assert.equal(outcome.stopReason, "job_cap");
  assert.equal(outcome.totals.claimed, 200);
  assert.equal(claimCalls(server), 200);
  const verdict = placeRankWorkerVerdict(outcome);
  assert.equal(verdict.fail, false);
  assert.match(verdict.annotation, /^::notice::.*\(job_cap\) after 200 tracker\(s\)/u);
});

test("같은 실행에서 이미 결과를 기록한 추적기가 다시 오면(서버 재시도 일정) 세지 않고 성공으로 멈춘다", async () => {
  const again = { ...job("a"), processingToken: "tok-a-2" };
  const server = fakeServer([job("a"), job("b"), again, job("c")], ["failed", "found"]);
  let lookups = 0;
  const logs = [];
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    log: (line) => logs.push(line),
    lookup: async () => {
      lookups += 1;
      if (lookups === 1) throw new Error("naver_place_access_limited");
      return found();
    },
  });
  assert.equal(outcome.stopReason, "revisit");
  assert.equal(lookups, 2, "추적기당 네이버 요청은 한 실행에 한 번이다");
  assert.equal(outcome.totals.claimed, 2);
  assert.equal(claimCalls(server), 3, "재방문 뒤에는 더 받지 않는다");
  assert.equal(completeCalls(server).length, 2);
  assert.equal(logs.join("\n").includes("tok-a"), false, "처리 토큰을 공개 로그에 남기지 않는다");
  // 조회 실패가 있었으므로 실행은 빨간 X 다(조회 실패는 지금처럼 실패).
  assert.equal(placeRankWorkerVerdict(outcome).fail, true);
  // 실패가 없었다면 재방문 멈춤은 알림 줄(성공)이다.
  const clean = placeRankWorkerVerdict({ ...outcome, totals: { ...outcome.totals, failed: 0 } });
  assert.equal(clean.fail, false);
  assert.match(clean.annotation, /^::notice::.*\(revisit\)/u);
});

test("결과 전송이 실패해 처리 권한 만료 뒤 같은 추적기가 다시 와도 다시 세지 않고, 남은 할 일은 계속 처리한다", async () => {
  // a 의 결과 전송이 504 로 실패 → 360초 리스 만료 → next_check_at 이 가장 이른 a 가 맨 앞으로 돌아온다.
  const server = fakeServer([job("a"), job("b"), { ...job("a"), processingToken: "tok-a-2" }, job("c")], ["complete_failed", "found", "found"]);
  const lookedUp = [];
  const logs = [];
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    log: (line) => logs.push(line),
    lookup: async (payload) => {
      lookedUp.push(payload.placeId);
      return found();
    },
  });
  assert.equal(outcome.stopReason, "drained", "밀린 c 까지 받은 뒤 서버가 할 일 없음이라 할 때 끝난다");
  assert.equal(outcome.drained, true);
  assert.equal(lookedUp.length, 3, "a·b·c 한 번씩만 센다(a 재등장은 조회하지 않는다)");
  assert.equal(outcome.totals.claimed, 3);
  assert.equal(outcome.totals.found, 2);
  assert.equal(outcome.totals.failed, 1, "a 는 결과를 기록하지 못했다");
  assert.equal(claimCalls(server), 5);
  assert.deepEqual(completeCalls(server).map((call) => call.body.trackerId), ["a", "b", "c"]);
  assert.ok(logs.some((line) => line.includes("unrecorded_revisit_skipped")));
  assert.equal(logs.join("\n").includes("tok-a"), false);
  assert.equal(placeRankWorkerVerdict(outcome).fail, true, "결과 전송 실패는 그대로 빨간 X 로 알린다");
});

test("결과를 기록하지 못한 추적기의 재등장 건너뛰기는 한 실행에 3번까지다", async () => {
  assert.equal(MAX_UNRECORDED_REVISITS, 3);
  const again = (index) => ({ ...job("a"), processingToken: `tok-a-${index}` });
  const server = fakeServer([job("a"), again(2), again(3), again(4), again(5), job("b")], ["complete_failed"]);
  let lookups = 0;
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    log: () => {},
    lookup: async () => {
      lookups += 1;
      return found();
    },
  });
  assert.equal(outcome.stopReason, "revisit");
  assert.equal(lookups, 1);
  assert.equal(outcome.totals.claimed, 1);
  assert.equal(claimCalls(server), 5, "a 첫 처리 + 건너뛰기 3번 + 네 번째 재등장에서 멈춘다");
  assert.equal(completeCalls(server).length, 1);
});

test("조회가 끝나지 않으면 보호 시간 뒤 오류로 돌려주고 더 받지 않는다(두 번째 브라우저 금지)", async () => {
  const server = fakeServer([job("a"), job("b")], ["failed"]);
  let lookups = 0;
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    log: () => {},
    lookupGuardMs: 20,
    lookup: () => {
      lookups += 1;
      return new Promise(() => {});
    },
  });
  assert.equal(outcome.stopReason, "lookup_timeout");
  assert.equal(lookups, 1);
  assert.equal(claimCalls(server), 1);
  const completes = completeCalls(server);
  assert.equal(completes.length, 1);
  assert.equal(completes[0].body.error, LOOKUP_TIMEOUT_CODE);
  assert.equal(completes[0].body.result, null);
  assert.equal(placeRankWorkerVerdict(outcome).fail, true, "실패로 기록된 추적기는 그대로 빨간 X 로 알린다");
});

test("저장한 뒤라도 조회가 3번 연달아 실패하면 이번 실행은 더 보내지 않는다(차단 의심 시 요청 폭주 방지)", async () => {
  const server = fakeServer(jobs(10), ["found", "failed", "failed", "failed"]);
  let lookups = 0;
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    log: () => {},
    lookup: async () => {
      lookups += 1;
      if (lookups === 1) return found();
      throw new Error("naver_place_access_limited");
    },
  });
  assert.equal(outcome.fallback, false, "이미 저장한 뒤라 예전 경로로 넘기지 않는다(기존 규칙 유지)");
  assert.equal(outcome.stopReason, "lookup_failing");
  assert.equal(lookups, 4);
  assert.equal(claimCalls(server), 4);
  assert.equal(placeRankWorkerVerdict(outcome).fail, true);
});

test("저장한 뒤 워커 API 가 끊기면 예전 경로로 넘기지 않고 실패(빨간 X)로 끝내며 이유를 로그에 남긴다", async () => {
  const server = fakeServer([job("a"), job("b")], ["found"]);
  const inner = server.fetchImpl;
  let claims = 0;
  server.fetchImpl = async (url, init) => {
    if (String(url).includes("worker-claim")) {
      claims += 1;
      if (claims === 2) return new Response("bad gateway", { status: 502 });
    }
    return inner(url, init);
  };
  const logs = [];
  const outcome = await runPlaceRankWorker({ fetchImpl: server.fetchImpl, secret: "s", log: (line) => logs.push(line), lookup: found });
  assert.equal(outcome.fallback, false);
  assert.equal(outcome.reason, "worker_api_unavailable");
  assert.equal(outcome.stopReason, "worker_api_lost");
  assert.equal(outcome.totals.saved, 1);
  assert.ok(logs.some((line) => line.includes("worker_api_lost") && line.includes("worker_api_unavailable")));
  const verdict = placeRankWorkerVerdict(outcome);
  assert.equal(verdict.fail, true);
  assert.match(verdict.message, /after saving 1 tracker\(s\).*worker_api_unavailable/u);
});

test("아직 아무것도 저장하지 못했으면 워커 API 불가는 지금처럼 예전 경로로 넘긴다", async () => {
  const server = fakeServer([job("a"), job("b")], ["failed"]);
  const inner = server.fetchImpl;
  let claims = 0;
  server.fetchImpl = async (url, init) => {
    if (String(url).includes("worker-claim")) {
      claims += 1;
      if (claims === 2) return new Response("bad gateway", { status: 502 });
    }
    return inner(url, init);
  };
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    log: () => {},
    lookup: async () => { throw new Error("naver_place_access_limited"); },
  });
  assert.equal(outcome.totals.saved, 0);
  assert.equal(outcome.fallback, true);
  assert.equal(outcome.reason, "worker_api_unavailable");
  const verdict = placeRankWorkerVerdict(outcome);
  assert.equal(verdict.fail, false);
  assert.match(verdict.annotation, /^::warning::.*\(worker_api_unavailable\)/u);
});

// ── 판정은 멈춘 이유도 본다: 조회 멈춤·연속 실패는 결과 전송이 lease_lost 로 돌아와도 빨간 X ──
test("조회가 보호 시간 안에 끝나지 않아 멈췄으면 결과 전송이 lease_lost 로 돌아와 실패 건수가 0 이어도 실패(빨간 X)다", async () => {
  const server = fakeServer([job("a"), job("b")], ["lease_lost"]);
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    log: () => {},
    lookupGuardMs: 20,
    lookup: () => new Promise(() => {}),
  });
  assert.equal(outcome.stopReason, "lookup_timeout");
  assert.equal(outcome.totals.failed, 0);
  assert.equal(outcome.totals.leaseLost, 1);
  assert.equal(claimCalls(server), 1, "두 번째 브라우저를 띄우지 않는다");
  const verdict = placeRankWorkerVerdict(outcome);
  assert.equal(verdict.fail, true);
  assert.equal(verdict.annotation, "", "성공 알림(::notice::)으로 끝내지 않는다");
  assert.match(verdict.message, /\(lookup_timeout\).*leaseLost=1/u);
});

test("저장한 뒤 조회가 3번 연달아 실패해 멈췄으면 결과 전송이 모두 lease_lost 여도 실패(빨간 X)다", async () => {
  const server = fakeServer(jobs(10), ["found", "lease_lost", "lease_lost", "lease_lost"]);
  let lookups = 0;
  const outcome = await runPlaceRankWorker({
    fetchImpl: server.fetchImpl,
    secret: "s",
    log: () => {},
    lookup: async () => {
      lookups += 1;
      if (lookups === 1) return found();
      throw new Error("naver_place_access_limited");
    },
  });
  assert.equal(outcome.stopReason, "lookup_failing");
  assert.equal(outcome.totals.failed, 0);
  assert.equal(outcome.totals.leaseLost, 3);
  const verdict = placeRankWorkerVerdict(outcome);
  assert.equal(verdict.fail, true);
  assert.equal(verdict.annotation, "");
  assert.match(verdict.message, /\(lookup_failing\).*leaseLost=3 lookupErrors=3/u);
});

// ── 늦은 fallback 금지: 저장 0건 + 조회 성공 0건 + 시작 후 10분 안일 때만 예전 경로로 넘긴다 ──
function failClaimAt(server, failingClaim) {
  const inner = server.fetchImpl;
  let claims = 0;
  server.fetchImpl = async (url, init) => {
    if (String(url).includes("worker-claim")) {
      claims += 1;
      if (claims === failingClaim) return new Response("bad gateway", { status: 502 });
    }
    return inner(url, init);
  };
  return server;
}

test("시작 후 10분이 지나 워커 API 가 끊기면 저장 0건이어도 예전 경로로 넘기지 않고 실패로 끝내며 이유를 로그에 남긴다", async () => {
  assert.equal(FALLBACK_WINDOW_MS, 10 * 60 * 1000);
  for (const [elapsedMs, handoff] of [[FALLBACK_WINDOW_MS - 1, true], [FALLBACK_WINDOW_MS, false]]) {
    const server = failClaimAt(fakeServer([job("a"), job("b")], ["failed"]), 2);
    let current = 0;
    const logs = [];
    const outcome = await runPlaceRankWorker({
      fetchImpl: server.fetchImpl,
      secret: "s",
      log: (line) => logs.push(line),
      now: () => current,
      lookup: async () => {
        current += elapsedMs;
        throw new Error("naver_place_access_limited");
      },
    });
    assert.equal(outcome.totals.saved, 0);
    const verdict = placeRankWorkerVerdict(outcome);
    if (handoff) {
      assert.equal(outcome.fallback, true, "10분 안이면 지금처럼 넘긴다");
      assert.equal(outcome.reason, "worker_api_unavailable");
      assert.equal(verdict.fail, false);
      continue;
    }
    assert.equal(outcome.fallback, false, "10분이 지나면 넘기지 않는다");
    assert.equal(outcome.stopReason, "worker_api_lost");
    assert.equal(outcome.handoffBlockedBy, "late");
    const stopLine = logs.find((line) => line.startsWith("Naver place rank worker stopped "));
    assert.ok(stopLine, "넘기지 않은 이유를 로그 한 줄로 남긴다");
    assert.deepEqual(
      (({ stopReason, reason, action, handoffBlockedBy, elapsedSeconds }) => ({ stopReason, reason, action, handoffBlockedBy, elapsedSeconds }))(
        JSON.parse(stopLine.slice("Naver place rank worker stopped ".length)),
      ),
      { stopReason: "worker_api_lost", reason: "worker_api_unavailable", action: "no_handoff", handoffBlockedBy: "late", elapsedSeconds: 600 },
    );
    assert.equal(verdict.fail, true);
    assert.match(verdict.message, /not handing off to the server collector \(worker_api_unavailable: more than 10 minutes since start\)/u);
  }
});

test("이 러너에서 조회가 성공한 적 있으면(결과 전송이 lease_lost 라 저장 0건) 워커 API 가 끊겨도 예전 경로로 넘기지 않는다", async () => {
  const server = failClaimAt(fakeServer([job("a"), job("b")], ["lease_lost"]), 2);
  const logs = [];
  const outcome = await runPlaceRankWorker({ fetchImpl: server.fetchImpl, secret: "s", log: (line) => logs.push(line), lookup: found });
  assert.equal(outcome.totals.saved, 0);
  assert.equal(outcome.totals.leaseLost, 1);
  assert.equal(outcome.fallback, false);
  assert.equal(outcome.stopReason, "worker_api_lost");
  assert.equal(outcome.handoffBlockedBy, "lookup_succeeded");
  assert.ok(logs.some((line) => line.includes("\"action\":\"no_handoff\"") && line.includes("\"handoffBlockedBy\":\"lookup_succeeded\"")));
  const verdict = placeRankWorkerVerdict(outcome);
  assert.equal(verdict.fail, true);
  assert.match(verdict.message, /a lookup already succeeded on this runner/u);
});

test("조회 성공이 있었거나 10분이 지났으면 저장 0건에서 조회가 연속 2회 실패해도 예전 경로로 넘기지 않고 그 자리에서 멈춘다", async () => {
  // (가) 조회는 성공했지만 결과 전송이 lease_lost(저장 0건) → 이어서 연속 2회 실패.
  {
    const server = fakeServer(jobs(5), ["lease_lost", "failed", "failed"]);
    let lookups = 0;
    const logs = [];
    const outcome = await runPlaceRankWorker({
      fetchImpl: server.fetchImpl,
      secret: "s",
      log: (line) => logs.push(line),
      lookup: async () => {
        lookups += 1;
        if (lookups === 1) return found();
        throw new Error("naver_place_access_limited");
      },
    });
    assert.equal(outcome.totals.saved, 0);
    assert.equal(outcome.fallback, false);
    assert.equal(outcome.reason, "runner_lookup_failing");
    assert.equal(outcome.stopReason, "lookup_failing");
    assert.equal(outcome.handoffBlockedBy, "lookup_succeeded");
    assert.equal(lookups, 3, "예전에 넘기던 자리(연속 2회)에서 멈춘다 — 러너 요청 수는 예전과 같다");
    assert.equal(claimCalls(server), 3);
    assert.ok(logs.some((line) => line.includes("\"action\":\"no_handoff\"") && line.includes("\"stopReason\":\"lookup_failing\"")));
    const verdict = placeRankWorkerVerdict(outcome);
    assert.equal(verdict.fail, true);
    assert.match(verdict.message, /\(lookup_failing\).*\(runner_lookup_failing: a lookup already succeeded on this runner\)/u);
  }
  // (가') 같은 자리에서 두 번째 실패가 보호 시간 초과(멈춘 브라우저)면 멈춘 이유는 lookup_timeout 이다.
  {
    const server = fakeServer(jobs(5), ["lease_lost", "failed", "failed"]);
    let lookups = 0;
    const outcome = await runPlaceRankWorker({
      fetchImpl: server.fetchImpl,
      secret: "s",
      log: () => {},
      lookupGuardMs: 20,
      lookup: async () => {
        lookups += 1;
        if (lookups === 1) return found();
        if (lookups === 2) throw new Error("naver_place_access_limited");
        return new Promise(() => {});
      },
    });
    assert.equal(outcome.fallback, false);
    assert.equal(outcome.stopReason, "lookup_timeout");
    assert.equal(outcome.handoffBlockedBy, "lookup_succeeded");
    assert.equal(claimCalls(server), 3);
    assert.match(placeRankWorkerVerdict(outcome).message, /\(lookup_timeout\).*\(runner_lookup_failing: a lookup already succeeded on this runner\)/u);
  }
  // (나) 조회 한 번에 6분 → 두 번째 실패가 시작 후 12분 → 늦었다.
  // (다) 조회 한 번에 4분 → 8분 → 지금처럼 넘긴다.
  for (const [minutesPerLookup, handoff] of [[6, false], [4, true]]) {
    const server = fakeServer(jobs(5), ["failed", "failed"]);
    let current = 0;
    const outcome = await runPlaceRankWorker({
      fetchImpl: server.fetchImpl,
      secret: "s",
      log: () => {},
      now: () => current,
      lookup: async () => {
        current += minutesPerLookup * 60 * 1000;
        throw new Error("naver_place_access_limited");
      },
    });
    assert.equal(outcome.totals.claimed, 2, `${minutesPerLookup}m`);
    if (handoff) {
      assert.equal(outcome.fallback, true);
      assert.equal(outcome.reason, "runner_lookup_failing");
    } else {
      assert.equal(outcome.fallback, false);
      assert.equal(outcome.stopReason, "lookup_failing");
      assert.equal(outcome.handoffBlockedBy, "late");
      assert.match(placeRankWorkerVerdict(outcome).message, /more than 10 minutes since start/u);
    }
  }
  // (라) ok:false 결과(장소 식별 실패 등)는 서버가 실패로 기록하므로 '조회 성공'이 아니다 — 10분 안이면 지금처럼 넘긴다.
  {
    const server = fakeServer(jobs(5), ["failed", "failed", "failed"]);
    let lookups = 0;
    const outcome = await runPlaceRankWorker({
      fetchImpl: server.fetchImpl,
      secret: "s",
      log: () => {},
      lookup: async () => {
        lookups += 1;
        if (lookups === 1) return { ok: false, matched: false, checkedCount: 0 };
        throw new Error("naver_place_access_limited");
      },
    });
    assert.equal(outcome.fallback, true);
    assert.equal(outcome.reason, "runner_lookup_failing");
  }
});

test("기본 조회 보호 시간은 서버 조회 마감(providerDeadlineAt) + 60초, 최대 330초 — 서버 처리 권한(리스 360초)보다 짧다", async (t) => {
  const serverSource = fs.readFileSync(new URL("../src/server/handlers/naver-place-rank-trackers.mjs", import.meta.url), "utf8");
  const leaseSeconds = Number(serverSource.match(/MI_PLACE_RANK_LEASE_SECONDS \|\| (\d+)\)/u)?.[1]);
  const lookupBudgetMs = Number(serverSource.match(/PLACE_WORKER_LOOKUP_BUDGET_MS = Math\.min\((\d+),/u)?.[1]);
  assert.equal(leaseSeconds, 360, "서버 기본 리스");
  assert.equal(lookupBudgetMs, 210000, "서버가 러너에 주는 조회 예산(providerDeadlineAt = 받은 시각 + 이 값)");
  assert.equal(LOOKUP_GUARD_GRACE_MS, 60000);
  assert.equal(LOOKUP_GUARD_MAX_MS, 330000);
  assert.ok(LOOKUP_GUARD_MAX_MS < leaseSeconds * 1000, "보호 시간 초과로 lease_lost 가 생기지 않는다");
  assert.ok(lookupBudgetMs + LOOKUP_GUARD_GRACE_MS <= LOOKUP_GUARD_MAX_MS, "서버가 준 마감이면 상한 전에 멈춘다");

  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  for (const [label, deadlineOffsetMs, guardMs] of [
    ["서버 조회 예산", lookupBudgetMs, lookupBudgetMs + 60000],
    ["마감이 이미 지남", -5000, 60000],
    ["마감 300초 → 상한", 300000, 330000],
    ["마감 없음 → 상한", null, 330000],
  ]) {
    const claimedAt = Date.now();
    const pending = { ...job("a"), providerDeadlineAt: deadlineOffsetMs === null ? undefined : claimedAt + deadlineOffsetMs };
    const server = fakeServer([pending], ["failed"]);
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let settled = false;
    const run = runPlaceRankWorker({
      fetchImpl: server.fetchImpl,
      secret: "s",
      log: () => {},
      lookup: () => {
        markStarted();
        return new Promise(() => {});
      },
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await started;
    t.mock.timers.tick(guardMs - 1);
    await settle();
    assert.equal(settled, false, `${label}: 보호 시간 전에는 멈추지 않는다`);
    assert.equal(completeCalls(server).length, 0, label);
    t.mock.timers.tick(1);
    await settle();
    // 보호 시간이 어긋나면 여기서 바로 실패한다(끝나지 않는 조회를 기다리며 멈추지 않는다).
    assert.equal(settled, true, `${label}: 보호 시간(${guardMs}ms)이 되면 멈춘다`);
    const outcome = await run;
    assert.equal(outcome.stopReason, "lookup_timeout", label);
    assert.equal(completeCalls(server)[0].body.error, LOOKUP_TIMEOUT_CODE, label);
  }
});

test("실행 판정: 시간 예산·상한·재방문은 성공 알림, 실패·부분 결과·저장 뒤 API 끊김은 실패, 예전 경로 넘김은 경고", () => {
  const totals = { claimed: 3, saved: 3, found: 3, notFound: 0, partial: 0, failed: 0, leaseLost: 0, lookupErrors: 0 };
  for (const stopReason of ["time_budget", "job_cap", "revisit"]) {
    const verdict = placeRankWorkerVerdict({ fallback: false, reason: "", drained: false, stopReason, totals });
    assert.equal(verdict.fail, false, stopReason);
    assert.match(verdict.annotation, new RegExp(`^::notice::.*\\(${stopReason}\\)`, "u"));
    assert.equal(verdict.annotation.split("\n").length, 1, "알림은 한 줄이다");
  }
  assert.deepEqual(placeRankWorkerVerdict({ fallback: false, reason: "", drained: true, stopReason: "drained", totals }), { fail: false, annotation: "" });
  assert.equal(placeRankWorkerVerdict({ fallback: false, reason: "", drained: true, stopReason: "drained", totals: { ...totals, failed: 1 } }).fail, true);
  assert.equal(placeRankWorkerVerdict({ fallback: false, reason: "", drained: false, stopReason: "time_budget", totals: { ...totals, partial: 1 } }).fail, true);
  assert.equal(placeRankWorkerVerdict({ fallback: false, reason: "", drained: false, stopReason: "revisit", totals: { ...totals, failed: 1 } }).fail, true);
  assert.equal(placeRankWorkerVerdict({ fallback: false, reason: "worker_api_unavailable", drained: false, stopReason: "worker_api_lost", totals }).fail, true);
  // 조회 멈춤·연속 실패는 실패 건수와 무관하게 빨간 X(결과 전송이 lease_lost 로 돌아온 경우).
  for (const stopReason of ["lookup_timeout", "lookup_failing"]) {
    const verdict = placeRankWorkerVerdict({ fallback: false, reason: "", drained: false, stopReason, totals: { ...totals, saved: 0, found: 0, leaseLost: 3 } });
    assert.equal(verdict.fail, true, stopReason);
    assert.equal(verdict.annotation, "", stopReason);
  }
  // 오류 줄은 main() 이 300자에서 자르므로 가장 긴 경우도 잘리지 않는다.
  const longest = placeRankWorkerVerdict({
    fallback: false,
    reason: "runner_lookup_failing",
    drained: false,
    stopReason: "lookup_timeout",
    handoffBlockedBy: "lookup_succeeded",
    totals: { claimed: 200, saved: 200, found: 200, notFound: 0, partial: 0, failed: 200, leaseLost: 200, lookupErrors: 200 },
  });
  assert.ok(longest.message.length < 300, String(longest.message.length));
  const handoff = placeRankWorkerVerdict({ fallback: true, reason: "worker_api_unavailable", drained: false, stopReason: "", totals });
  assert.equal(handoff.fail, false);
  assert.match(handoff.annotation, /^::warning::/u);
});

test("시간 예산은 워크플로 제한 시간 안에서 준비·꼬리·예전 단계 여유를 남기고, 던지는 20건 상한은 없다", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/naver-place-rank-cron.yml", import.meta.url), "utf8");
  const timeoutMinutes = Number(workflow.match(/timeout-minutes: (\d+)/u)?.[1]);
  assert.equal(timeoutMinutes, 100);
  // 준비: 체크아웃·Node·브라우저 설치와 push 실행의 90초 대기(약 4분).
  const setupMinutes = 4;
  // 꼬리: 예산 직전에 받은 한 건 — 받기 120초 + 조회 보호 최대 330초 + 결과 120초 ≈ 9.5분.
  const tailMinutes = 10;
  // 예전 단계 여유: 러너가 한 건도 저장하기 전에 손을 떼면(fallback) 서버 → Render 경로가 이어받는다.
  const fallbackRoomMinutes = 40;
  assert.ok(DEFAULT_TIME_BUDGET_MS / 60000 + setupMinutes + tailMinutes + fallbackRoomMinutes <= timeoutMinutes);
  // 늦은 fallback 없음: 넘기는 것은 시작 후 10분 안뿐이라 예전 단계는 적어도 100 − 4 − 10 = 86분을 갖는다
  // (예전 단계 최악 ≈ 90초 + 20묶음 × 262초 ≈ 89분은 20묶음이 전부 260초 제한 직전까지 걸릴 때뿐).
  assert.equal(FALLBACK_WINDOW_MS, 10 * 60 * 1000);
  assert.ok(FALLBACK_WINDOW_MS < DEFAULT_TIME_BUDGET_MS);
  assert.equal(timeoutMinutes - setupMinutes - FALLBACK_WINDOW_MS / 60000, 86);
  const source = fs.readFileSync(new URL("./place-rank-actions-worker.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /safety cap before the queue drained/u);
  assert.doesNotMatch(source, /MAX_JOBS = 20/u);
  assert.match(source, /\(\) => process\.exit\(0\)/u, "멈춘 브라우저가 단계 종료를 붙잡지 않는다");
  // 러너 단계는 여전히 fallback 출력을 먼저 남긴다(예전 단계 조건이 이 값을 읽는다).
  assert.match(workflow, /steps\.place_worker\.outputs\.fallback == 'true'/u);
});

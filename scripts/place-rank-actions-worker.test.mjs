import assert from "node:assert/strict";
import test from "node:test";
import { runPlaceRankWorker } from "./place-rank-actions-worker.mjs";

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
    return new Response(JSON.stringify({ ok: true, worker: true, outcome: outcomes.shift() || "found", saved: true }), { status: 200 });
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

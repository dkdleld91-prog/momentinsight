import assert from "node:assert/strict";
import test from "node:test";

import productRankCronHandler, {
  NAVER_RANK_CRON_ITEM_FAILURE,
  NAVER_RANK_PROVIDER_NOT_CONFIGURED,
  NAVER_RANK_PROVIDER_UNAVAILABLE,
  NAVER_RANK_PROVIDER_WARMING,
  productRankCronBatchLimit,
  productRankCronExecutionMode,
  productRankCronProviderConfigured,
  productRankCronProviderReadiness,
  HYBRID_WORKER_SILENCE_MINUTES,
  NAVER_RANK_WORKER_NO_COMMIT,
  NAVER_RANK_WORKER_SIGNAL_UNKNOWN,
  NAVER_RANK_WORKER_SILENT,
  hybridWorkerFailure,
  hybridWorkerGraceActive,
  hybridWorkerNoCommitFailure,
  hybridWorkerProgressAt,
  hybridWorkerRecentlyActive,
  hybridWorkerSignal,
  safeProductRankCronSummary,
} from "./naver-rank-cron.mjs";
import { EXPECTED_WORKER_RUNTIME_VERSION } from "../naver-shopping/worker-runtime-expectation.mjs";

const HYBRID_CRON_ENV_KEYS = [
  "NAVER_SHOPPING_RANK_MODE",
  "MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED",
  "MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET",
  "MI_RANK_CRON_SECRET",
  "CRON_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
];
const HYBRID_CRON_SECRET = "unit-test-rank-cron-secret-0123456789";

// 워커 진척 기록(coordination 행)만 바꿔가며 상품 크론 분기를 실제로 호출한다.
// Supabase REST 호출은 전부 이 스텁이 가로채므로 네트워크에 나가지 않는다.
// 스텁은 nonce 테이블도 "매분 서명이 들어오는" 프로덕션 상태 그대로 응답한다 —
// 크론이 그 표를 보고 살아 있다고 오판하지 않는 것까지 검증하기 위해서다.
// worker_runs 는 기본값으로 "서버 기대와 같은 실행본"을 돌려준다 — 프로덕션의 정상
// 상태이고, 이 갈래에서는 낡은 실행본 판정이 성립하지 않아 아래 분기들이 원래 의도대로
// 검증된다. 라우트를 비워 두면 postgrest-js 가 throw 를 3회 재시도하며 1s·2s·4s 를
// 실제로 기다려 핸들러 테스트마다 7초가 붙는다(실측: 파일 전체 0.3초 → 28초).
function stubHybridCronEnvironment({
  coordinationRows = [],
  wakeGranted = true,
  coordinationStatus = 200,
  workerRunRows = [{ runtime_version: EXPECTED_WORKER_RUNTIME_VERSION }],
}) {
  const previousEnv = Object.fromEntries(HYBRID_CRON_ENV_KEYS.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    NAVER_SHOPPING_RANK_MODE: "hybrid_local_worker",
    MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
    MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET: "u".repeat(48),
    MI_RANK_CRON_SECRET: HYBRID_CRON_SECRET,
    SUPABASE_URL: "https://stub-project.supabase.test",
    SUPABASE_SECRET_KEY: "sb_secret_unit_test_stub_key",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_unit_test_stub_key",
  });
  delete process.env.CRON_SECRET;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input || "");
    calls.push(url);
    if (url.includes("/rest/v1/rpc/mi_request_naver_shopping_worker_wake")) {
      return new Response(JSON.stringify(wakeGranted), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/rest/v1/naver_shopping_worker_coordination")) {
      if (coordinationStatus !== 200) {
        return new Response(
          JSON.stringify({ message: "permission denied for table naver_shopping_worker_coordination" }),
          { status: coordinationStatus, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(coordinationRows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/rest/v1/naver_shopping_worker_runs")) {
      return new Response(JSON.stringify(workerRunRows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/rest/v1/naver_shopping_worker_nonces")) {
      // 프로덕션과 같은 상태: 서명은 1분 전에도 들어와 있다.
      return new Response(JSON.stringify([{ created_at: "2026-08-01T01:59:00.000Z" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected_fetch:${url}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function hybridCronRequest() {
  return new Request("https://insight.example/api/naver-rank-cron?mode=drain", {
    headers: { authorization: `Bearer ${HYBRID_CRON_SECRET}` },
  });
}

function limit(value) {
  const url = new URL("https://example.com/api/naver-rank-cron");
  if (value !== undefined) url.searchParams.set("limit", value);
  return productRankCronBatchLimit(url);
}

test("product cron keeps a conservative default batch", () => {
  assert.equal(limit(), 1);
  assert.equal(limit("not-a-number"), 1);
});

test("product cron accepts only a bounded sequential batch", () => {
  assert.equal(limit("1"), 1);
  assert.equal(limit("5"), 5);
  assert.equal(limit("3.9"), 3);
  assert.equal(limit("0"), 1);
  assert.equal(limit("-10"), 1);
  assert.equal(limit("100"), 5);
});

test("product cron requires the dedicated external collector pair", () => {
  assert.equal(productRankCronProviderConfigured({}), false);
  assert.equal(productRankCronProviderConfigured({ providerUrl: "https://collector.example" }), false);
  assert.equal(productRankCronProviderConfigured({ providerKey: "collector-key" }), false);
  assert.equal(productRankCronProviderConfigured({ clientId: "legacy-id", clientSecret: "legacy-secret" }), false);
  assert.equal(productRankCronProviderConfigured({
    mode: "provider",
    providerUrl: "https://collector.example",
    providerKey: "collector-key",
  }), true);
  assert.equal(NAVER_RANK_PROVIDER_NOT_CONFIGURED, "NAVER_RANK_PROVIDER_NOT_CONFIGURED");
  assert.equal(NAVER_RANK_PROVIDER_WARMING, "NAVER_RANK_PROVIDER_WARMING");
  assert.equal(NAVER_RANK_PROVIDER_UNAVAILABLE, "NAVER_RANK_PROVIDER_UNAVAILABLE");
  assert.equal(NAVER_RANK_CRON_ITEM_FAILURE, "NAVER_RANK_CRON_ITEM_FAILURE");
});

test("product cron prewarms the configured collector before claiming due rows", async () => {
  let prewarmCalls = 0;
  const configured = {
    mode: "provider",
    providerUrl: "https://collector.example/rank",
    providerKey: "collector-key",
  };
  const readiness = await productRankCronProviderReadiness(configured, {
    prewarm: async (received) => {
      prewarmCalls += 1;
      assert.equal(received, configured);
      return {
        ready: false,
        status: "warming",
        errorCode: "SHOPPING_RANK_PROVIDER_WARMING",
        retryable: true,
        retryAfterSeconds: 15,
        httpStatus: 503,
      };
    },
  });
  assert.equal(prewarmCalls, 1);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.status, "warming");
  assert.equal(readiness.retryable, true);
});

test("product cron uses the mobile top fallback only for the explicit mode", () => {
  assert.deepEqual(productRankCronExecutionMode({ ready: true, status: "ready" }), {
    run: true,
    mobileTopFallbackOnly: false,
  });
  assert.deepEqual(productRankCronExecutionMode({ ready: false, status: "unavailable" }), {
    run: false,
    mobileTopFallbackOnly: false,
  });
  assert.deepEqual(productRankCronExecutionMode({ ready: false, status: "mobile_top_fallback_ready" }), {
    run: true,
    mobileTopFallbackOnly: true,
  });
  for (const status of ["warming", "not_configured", "error", "unauthorized", "database_error"]) {
    assert.deepEqual(productRankCronExecutionMode({ ready: false, status }), {
      run: false,
      mobileTopFallbackOnly: false,
    }, status);
  }
});

test("hybrid cron always defers to the durable 300-rank cycle", () => {
  const readiness = { ready: false, status: "hybrid_local_worker_ready" };
  const insideGrace = new Date("2026-08-01T00:30:00.000Z"); // 09:30 KST
  const afterGrace = new Date("2026-08-01T01:01:00.000Z"); // 10:01 KST
  assert.equal(hybridWorkerGraceActive(insideGrace), true);
  assert.equal(hybridWorkerGraceActive(afterGrace), false);
  assert.deepEqual(productRankCronExecutionMode(readiness, {
    now: insideGrace,
    localWorkerActive: true,
  }), {
    run: false,
    mobileTopFallbackOnly: false,
    deferredToLocalWorker: true,
  });
  assert.deepEqual(productRankCronExecutionMode(readiness, {
    now: insideGrace,
    localWorkerActive: false,
  }), {
    run: false,
    mobileTopFallbackOnly: false,
    deferredToLocalWorker: true,
  });
  assert.deepEqual(productRankCronExecutionMode(readiness, {
    now: afterGrace,
    localWorkerActive: true,
  }), {
    run: false,
    mobileTopFallbackOnly: false,
    deferredToLocalWorker: true,
  });
});

test("hybrid worker heartbeat diagnostic remains fail closed", async () => {
  const calls = [];
  const query = {
    select(value) { calls.push(["select", value]); return this; },
    eq(name, value) { calls.push(["eq", name, value]); return this; },
    async limit(value) {
      calls.push(["limit", value]);
      return { data: [{ primary_seen_at: "2026-08-01T00:00:02.000Z", last_success_at: null }], error: null };
    },
  };
  const ctx = { supabaseAdmin: { from(name) { calls.push(["from", name]); return query; } } };
  assert.equal(await hybridWorkerRecentlyActive(ctx, new Date("2026-08-01T00:05:00.000Z")), true);
  assert.equal(calls[0][1], "naver_shopping_worker_coordination");
  assert.deepEqual(calls[2], ["eq", "lane_key", "global"]);
  assert.equal(await hybridWorkerRecentlyActive({}, new Date("2026-08-01T00:05:00.000Z")), false);
  assert.equal(await hybridWorkerRecentlyActive({
    supabaseAdmin: { from() { throw new Error("db_down"); } },
  }, new Date("2026-08-01T00:05:00.000Z")), false);
});

test("hybrid worker progress takes the newest of the two coordination stamps", () => {
  assert.equal(hybridWorkerProgressAt(null), 0);
  assert.equal(hybridWorkerProgressAt({}), 0);
  assert.equal(hybridWorkerProgressAt({ primary_seen_at: null, last_success_at: null }), 0);
  assert.equal(hybridWorkerProgressAt({ primary_seen_at: "not-a-date" }), 0);
  assert.equal(
    hybridWorkerProgressAt({ primary_seen_at: "2026-08-01T01:00:00.000Z", last_success_at: "2026-08-01T00:10:00.000Z" }),
    Date.parse("2026-08-01T01:00:00.000Z"),
  );
  assert.equal(
    hybridWorkerProgressAt({ primary_seen_at: "2026-08-01T00:10:00.000Z", last_success_at: "2026-08-01T01:00:00.000Z" }),
    Date.parse("2026-08-01T01:00:00.000Z"),
  );
});

function coordinationCtx(rows) {
  return {
    supabaseAdmin: {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async limit() { return { data: rows, error: null }; },
        };
      },
    },
  };
}

const coordinationErrorCtx = {
  supabaseAdmin: {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async limit() { return { data: null, error: { message: "permission denied" } }; },
      };
    },
  },
};

test("hybrid worker signal separates an unreadable heartbeat from real silence", async () => {
  const now = new Date("2026-08-01T02:00:00.000Z"); // 11:00 KST, 유예 종료 후
  const throwCtx = { supabaseAdmin: { from() { throw new Error("db_down"); } } };
  const fresh = [{ primary_seen_at: "2026-08-01T01:50:00.000Z", last_success_at: "2026-08-01T01:40:00.000Z" }];
  const staleHandshake = [{ primary_seen_at: "2026-08-01T00:01:00.000Z", last_success_at: null }];
  const blankRow = [{ primary_seen_at: null, last_success_at: null }];

  assert.equal(await hybridWorkerSignal(coordinationCtx(fresh), now), "active");
  assert.equal(await hybridWorkerSignal(coordinationCtx(staleHandshake), now), "silent");
  assert.equal(await hybridWorkerSignal(coordinationCtx([]), now), "unknown");
  assert.equal(await hybridWorkerSignal(coordinationCtx(blankRow), now), "unknown");
  assert.equal(await hybridWorkerSignal(coordinationErrorCtx, now), "unknown");
  assert.equal(await hybridWorkerSignal(throwCtx, now), "unknown");
  assert.equal(await hybridWorkerSignal({}, now), "unknown");

  // 읽기 실패는 "워커가 죽었다"로 단정하지 않는다 — 코드와 상태가 분리된다.
  assert.equal((await hybridWorkerFailure(coordinationErrorCtx, now)).code, NAVER_RANK_WORKER_SIGNAL_UNKNOWN);
  assert.equal((await hybridWorkerFailure(coordinationErrorCtx, now)).status, "worker_signal_unknown");
  assert.equal((await hybridWorkerFailure(coordinationCtx(staleHandshake), now)).code, NAVER_RANK_WORKER_SILENT);
  assert.equal(await hybridWorkerFailure(coordinationCtx(fresh), now), null);
  assert.equal(HYBRID_WORKER_SILENCE_MINUTES, 30);
  assert.equal(NAVER_RANK_WORKER_SIGNAL_UNKNOWN, "NAVER_RANK_WORKER_SIGNAL_UNKNOWN");
});

test("last_success_at alone keeps a long collecting run out of the silent bucket", async () => {
  const now = new Date("2026-08-01T02:00:00.000Z");
  const collecting = [{ primary_seen_at: "2026-08-01T00:05:00.000Z", last_success_at: "2026-08-01T01:55:00.000Z" }];
  assert.equal(await hybridWorkerSignal(coordinationCtx(collecting), now), "active");
  assert.equal(await hybridWorkerFailure(coordinationCtx(collecting), now), null);
});

test("hybrid worker silence is suppressed only inside the post-slot grace window", async () => {
  const silentCtx = coordinationCtx([
    { primary_seen_at: "2026-07-31T18:00:00.000Z", last_success_at: "2026-07-31T18:00:00.000Z" },
  ]);
  const activeCtx = coordinationCtx([
    { primary_seen_at: "2026-08-01T01:59:00.000Z", last_success_at: "2026-08-01T01:50:00.000Z" },
  ]);
  const insideGrace = new Date("2026-08-01T00:30:00.000Z"); // 09:30 KST
  const afterGrace = new Date("2026-08-01T02:00:00.000Z"); // 11:00 KST
  assert.equal(await hybridWorkerFailure(silentCtx, insideGrace), null);
  assert.equal((await hybridWorkerFailure(silentCtx, afterGrace)).code, NAVER_RANK_WORKER_SILENT);
  assert.equal(await hybridWorkerFailure(activeCtx, afterGrace), null);
  assert.equal(NAVER_RANK_WORKER_SILENT, "NAVER_RANK_WORKER_SILENT");
});

// 프로덕션 사각지대 재현(2026-09-01T08:30Z 실측): nonce 는 1분 전에도 들어오는데
// 코디네이션 진척은 15시간 전에 멈춰 있었다. 서명 기준이면 202 ok 가 나간다.
test("product cron answers 503 while the worker keeps signing but records no progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-01T02:00:00.000Z") }); // 11:00 KST
  const stub = stubHybridCronEnvironment({
    coordinationRows: [{
      primary_seen_at: "2026-07-31T11:00:00.000Z", // 15시간 전
      last_success_at: "2026-07-31T11:00:00.000Z",
    }],
  });
  try {
    const response = await productRankCronHandler.fetch(hybridCronRequest());
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.code, NAVER_RANK_WORKER_SILENT);
    assert.equal(body.claimed, 0);
    assert.equal(body.sourceStatus.shoppingRank.status, "worker_silent");
    assert.equal(body.deferred, undefined);
    assert.ok(stub.calls.some((url) => url.includes("naver_shopping_worker_coordination")));
    // 서명 표는 침묵 판정의 근거가 아니다 — 이 갈래에서는 조회조차 하지 않는다.
    // (서명은 낡은 실행본 판정의 두 번째 조건일 뿐이고, 실행본이 서버 기대와 같은
    //  여기서는 그 판정이 첫 조건에서 이미 끝나 서명 표까지 내려가지 않는다.)
    assert.ok(!stub.calls.some((url) => url.includes("naver_shopping_worker_nonces")));
  } finally {
    stub.restore();
  }
});

test("product cron answers 503 NAVER_RANK_WORKER_SILENT when the worker only claimed the lane at the slot and died", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-01T02:00:00.000Z") }); // 11:00 KST
  // 09:06 KST 에 레인 한 번 잡고 죽은 워커. 예전 "슬롯 이후 1건" 기준이면 감춰졌다.
  const stub = stubHybridCronEnvironment({
    coordinationRows: [{ primary_seen_at: "2026-08-01T00:06:00.000Z", last_success_at: null }],
  });
  try {
    const response = await productRankCronHandler.fetch(hybridCronRequest());
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.code, NAVER_RANK_WORKER_SILENT);
    assert.equal(body.sourceStatus.shoppingRank.status, "worker_silent");
  } finally {
    stub.restore();
  }
});

test("product cron reports an unreadable heartbeat as unknown, never as worker silence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-01T02:00:00.000Z") }); // 11:00 KST
  const stub = stubHybridCronEnvironment({ coordinationRows: [], coordinationStatus: 403 });
  try {
    const response = await productRankCronHandler.fetch(hybridCronRequest());
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.code, NAVER_RANK_WORKER_SIGNAL_UNKNOWN);
    assert.equal(body.sourceStatus.shoppingRank.status, "worker_signal_unknown");
    assert.ok(!body.message.includes("멈췄습니다"));
  } finally {
    stub.restore();
  }
});

test("product cron keeps its 202 deferral while the hybrid worker keeps making progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-01T02:00:00.000Z") }); // 11:00 KST
  const stub = stubHybridCronEnvironment({
    coordinationRows: [{
      primary_seen_at: "2026-08-01T01:59:00.000Z",
      last_success_at: "2026-08-01T01:50:00.000Z",
    }],
  });
  try {
    const response = await productRankCronHandler.fetch(hybridCronRequest());
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.deferred, true);
    assert.equal(body.sourceStatus.shoppingRank.status, "worker_priority");
    // 깨우기가 "소비됐다"고 단정하지 않는다.
    assert.ok(!body.message.includes("깨웠으며"));
    assert.ok(body.message.includes("깨우기를 요청했고"));
  } finally {
    stub.restore();
  }
});

// ── F11: "레인은 잡히는데 커밋 0" 축 ─────────────────────────────
// 2026-09-03 게이트 장애(2시간): 트래커 격리 코드로 전 키워드가 실패해도 primary_seen_at
// 은 레인 claim 시 매분 갱신돼 진척 판정이 "active" 로 남았고, 크론은 영구 202 를 냈다.
// 하트비트가 신선한데 last_success_at(커밋)이 90분+ 멈춘 상태는 202 로 감추지 않고
// 새 코드 NAVER_RANK_WORKER_NO_COMMIT(503) 으로 보고한다. 기존 SILENT 의 의미·문구는 불변이다.
test("F11: 레인은 매분 잡히는데 커밋이 90분+ 없으면 202 대신 503 NAVER_RANK_WORKER_NO_COMMIT", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-01T02:00:00.000Z") }); // 11:00 KST, 유예 밖
  const stub = stubHybridCronEnvironment({
    coordinationRows: [{
      primary_seen_at: "2026-08-01T01:59:00.000Z", // 1분 전 — 레인 claim 은 계속된다
      last_success_at: "2026-08-01T00:00:00.000Z", // 2시간 전 — 커밋 0
    }],
  });
  try {
    const response = await productRankCronHandler.fetch(hybridCronRequest());
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.code, NAVER_RANK_WORKER_NO_COMMIT);
    assert.equal(body.sourceStatus.shoppingRank.status, "worker_no_commit");
    assert.equal(body.claimed, 0);
    assert.equal(body.deferred, undefined);
    assert.equal(NAVER_RANK_WORKER_NO_COMMIT, "NAVER_RANK_WORKER_NO_COMMIT");
    // 기존 침묵 코드와 절대 섞이지 않는다 — 침묵은 "레인 확보도 없음", 여기는 "확보만 있음".
    assert.notEqual(body.code, NAVER_RANK_WORKER_SILENT);
    assert.ok(!body.message.includes(`${HYBRID_WORKER_SILENCE_MINUTES}분 넘게 레인 확보도`), "SILENT 문구를 재사용하면 안 된다");
  } finally {
    stub.restore();
  }
});

test("F11: 커밋 정체 판정은 90분 초과·하트비트 신선·기록 존재를 모두 요구한다", () => {
  const judge = (primary, success, date) => hybridWorkerNoCommitFailure(
    { primary_seen_at: primary, last_success_at: success },
    date,
  );
  const now = new Date("2026-08-01T02:00:00.000Z"); // 11:00 KST
  // 오늘 장애의 지문: 레인 claim 1분 전 · 커밋 2시간 전.
  const incident = judge("2026-08-01T01:59:00.000Z", "2026-08-01T00:00:00.000Z", now);
  assert.equal(incident.code, NAVER_RANK_WORKER_NO_COMMIT);
  assert.equal(incident.status, "worker_no_commit");
  // 정확히 90분은 초과가 아니다.
  assert.equal(judge("2026-08-01T01:59:00.000Z", "2026-08-01T00:30:00.000Z", now), null);
  assert.equal(judge("2026-08-01T01:59:00.000Z", "2026-08-01T00:29:00.000Z", now).code, NAVER_RANK_WORKER_NO_COMMIT);
  // 하트비트 자체가 낡으면(15분+) 이 축이 아니라 침묵 축의 일이다.
  assert.equal(judge("2026-08-01T01:40:00.000Z", "2026-08-01T00:00:00.000Z", now), null);
  // 커밋 기록이 아예 없으면(최초 배치 등) 단정하지 않는다 — fail-safe.
  assert.equal(judge("2026-08-01T01:59:00.000Z", null, now), null);
  assert.equal(judge(null, null, now), null);
  assert.equal(hybridWorkerNoCommitFailure(null, now), null);
});

test("F11: 유예 창 안에서는 커밋 정체를 판정하지 않고, 유예 밖에서만 실패다", async () => {
  // 슬롯 직후에는 밤새 커밋이 없던 것이 정상이다(첫 커밋까지 수 분). 유예가 그 구간을 막는다.
  const rows = [{ primary_seen_at: "2026-08-01T00:29:00.000Z", last_success_at: "2026-07-31T20:00:00.000Z" }];
  const insideGrace = new Date("2026-08-01T00:30:00.000Z"); // 09:30 KST
  assert.equal(await hybridWorkerFailure(coordinationCtx(rows), insideGrace), null);
  const afterGrace = new Date("2026-08-01T02:00:00.000Z"); // 11:00 KST
  const stalled = [{ primary_seen_at: "2026-08-01T01:59:00.000Z", last_success_at: "2026-07-31T20:00:00.000Z" }];
  assert.equal((await hybridWorkerFailure(coordinationCtx(stalled), afterGrace)).code, NAVER_RANK_WORKER_NO_COMMIT);
  // 커밋이 90분 안이면 202 경로 그대로다.
  const committing = [{ primary_seen_at: "2026-08-01T01:59:00.000Z", last_success_at: "2026-08-01T01:50:00.000Z" }];
  assert.equal(await hybridWorkerFailure(coordinationCtx(committing), afterGrace), null);
});

test("product cron accepts the explicit fallback without prewarming a provider", async () => {
  let prewarmCalls = 0;
  const readiness = await productRankCronProviderReadiness({
    mode: "mobile_top_fallback",
    mobileTopFallbackOnly: true,
  }, {
    prewarm: async () => {
      prewarmCalls += 1;
      return { ready: true };
    },
  });
  assert.equal(prewarmCalls, 0);
  assert.equal(readiness.status, "mobile_top_fallback_ready");
  assert.equal(readiness.fullCoverageReady, false);
});

test("product cron accepts only a fully signed hybrid worker configuration", async () => {
  let prewarmCalls = 0;
  const readiness = await productRankCronProviderReadiness({
    mode: "hybrid_local_worker",
    mobileTopFallbackOnly: true,
    localWorkerEnabled: true,
    localWorkerSecretReady: true,
  }, {
    prewarm: async () => {
      prewarmCalls += 1;
      return { ready: true };
    },
  });
  assert.equal(prewarmCalls, 0);
  assert.equal(readiness.status, "hybrid_local_worker_ready");
  assert.equal(readiness.fullCoverageReady, false);
  assert.equal(readiness.fullCoverageConfigured, true);
});

test("product cron rejects missing provider configuration without starting prewarm", async () => {
  let prewarmCalls = 0;
  const readiness = await productRankCronProviderReadiness({}, {
    prewarm: async () => {
      prewarmCalls += 1;
      return { ready: true };
    },
  });
  assert.equal(prewarmCalls, 0);
  assert.deepEqual(readiness, {
    ready: false,
    status: "not_configured",
    errorCode: "NAVER_RANK_PROVIDER_NOT_CONFIGURED",
    retryable: false,
    retryAfterSeconds: 0,
    httpStatus: 503,
  });
});

test("product cron exposes only aggregate counts in its summary", () => {
  const summary = safeProductRankCronSummary({
    now: "2026-07-31T01:02:03.000Z",
    checked: 5,
    succeeded: 3,
    preserved: 0,
    failed: 2,
    remaining: 7,
    drained: false,
    configured: true,
    rankSourceReady: true,
    results: [{
      trackerId: "private-tracker-id",
      keyword: "private-keyword",
      productId: "private-product-id",
    }],
  });

  assert.deepEqual(summary, {
    now: "2026-07-31T01:02:03.000Z",
    checked: 5,
    succeeded: 3,
    preserved: 0,
    failed: 2,
    remaining: 7,
    drained: false,
    configured: true,
    rankSourceReady: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /private|trackerId|keyword|productId/);
});

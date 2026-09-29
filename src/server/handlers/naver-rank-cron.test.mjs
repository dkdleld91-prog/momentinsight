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
  hybridWorkerProductLastCheckedAt,
  hybridWorkerProgressAt,
  hybridWorkerRecentlyActive,
  hybridWorkerSignal,
  safeProductRankCronSummary,
} from "./naver-rank-cron.mjs";
import {
  EXPECTED_WORKER_RUNTIME_VERSION,
  WORKER_CHECKED_AT_MAX_AHEAD_MS,
  WORKER_COMMIT_STALL_MINUTES,
} from "../naver-shopping/worker-runtime-expectation.mjs";
import { rankCollectionHealthBody } from "./rank-collection-health.mjs";

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
// 1.1.34: 코디네이션만으로 SILENT·NO_COMMIT 으로 보이면 크론이 상품 추적기 표 MAX(last_checked_at)
// 를 한 번 더 읽는다. 기본값은 빈 결과(표식 없음 = 1.1.33 과 같은 판정)다.
function stubHybridCronEnvironment({
  coordinationRows = [],
  wakeGranted = true,
  coordinationStatus = 200,
  workerRunRows = [{ runtime_version: EXPECTED_WORKER_RUNTIME_VERSION }],
  productTrackerRows = [],
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
    if (url.includes("/rest/v1/naver_rank_trackers")) {
      return new Response(JSON.stringify(productTrackerRows), {
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
// 진척이 active 인데 last_success_at(커밋)이 45분 이상 멈춘 상태는 202 로 감추지 않고
// 새 코드 NAVER_RANK_WORKER_NO_COMMIT(503) 으로 보고한다. 기존 SILENT 의 의미·문구는 불변이다.
// (2026-09-27: 90분 초과 → 45분 이상, 하트비트 15분 안쪽 조건 제거 — 헬스와 같은 판정 함수.)
test("F11: 레인은 매분 잡히는데 커밋이 45분 이상 없으면 202 대신 503 NAVER_RANK_WORKER_NO_COMMIT", async (t) => {
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
    assert.ok(body.message.includes("45분 이상"), body.message);
  } finally {
    stub.restore();
  }
});

test("F11: 커밋 정체 판정은 45분 이상·기록 존재만 요구한다(하트비트 무관, 2026-09-27)", () => {
  const judge = (primary, success, date) => hybridWorkerNoCommitFailure(
    { primary_seen_at: primary, last_success_at: success },
    date,
  );
  const now = new Date("2026-08-01T02:00:00.000Z"); // 11:00 KST
  // 2026-09-03 게이트 장애의 지문: 레인 claim 1분 전 · 커밋 2시간 전.
  const incident = judge("2026-08-01T01:59:00.000Z", "2026-08-01T00:00:00.000Z", now);
  assert.equal(incident.code, NAVER_RANK_WORKER_NO_COMMIT);
  assert.equal(incident.status, "worker_no_commit");
  assert.ok(incident.message.includes("45분 이상"), incident.message);
  // 경계는 "이상"이다: 44분 59.999초는 아니고, 정확히 45분부터 정체다.
  assert.equal(judge("2026-08-01T01:59:00.000Z", "2026-08-01T01:15:00.001Z", now), null);
  assert.equal(judge("2026-08-01T01:59:00.000Z", "2026-08-01T01:15:00.000Z", now).code, NAVER_RANK_WORKER_NO_COMMIT);
  // 2026-09-27: 하트비트가 15분 넘게 낡아도(진척은 30분 안) 커밋 정체다.
  assert.equal(judge("2026-08-01T01:40:00.000Z", "2026-08-01T00:00:00.000Z", now).code, NAVER_RANK_WORKER_NO_COMMIT);
  assert.equal(judge(null, "2026-08-01T00:00:00.000Z", now).code, NAVER_RANK_WORKER_NO_COMMIT);
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
  // 커밋이 45분 안이면 202 경로 그대로다.
  const committing = [{ primary_seen_at: "2026-08-01T01:59:00.000Z", last_success_at: "2026-08-01T01:50:00.000Z" }];
  assert.equal(await hybridWorkerFailure(coordinationCtx(committing), afterGrace), null);
  const edge = [{ primary_seen_at: "2026-08-01T01:59:00.000Z", last_success_at: "2026-08-01T01:15:00.001Z" }];
  assert.equal(await hybridWorkerFailure(coordinationCtx(edge), afterGrace), null, "44분 59.999초는 아직 202 다");
  // 2026-09-27: 레인 확보가 20분 전(진척 active)이고 커밋이 2시간 없으면 202 가 아니라 NO_COMMIT 이다.
  const heartbeatAging = [{ primary_seen_at: "2026-08-01T01:40:00.000Z", last_success_at: "2026-07-31T20:00:00.000Z" }];
  assert.equal((await hybridWorkerFailure(coordinationCtx(heartbeatAging), afterGrace)).code, NAVER_RANK_WORKER_NO_COMMIT);
  // 진척까지 30분 넘게 끊기면(주작업기 꺼짐) 기존대로 SILENT 가 먼저 받는다.
  const silent = [{ primary_seen_at: "2026-08-01T01:20:00.000Z", last_success_at: "2026-07-31T20:00:00.000Z" }];
  assert.equal((await hybridWorkerFailure(coordinationCtx(silent), afterGrace)).code, NAVER_RANK_WORKER_SILENT);
});

// ── 1.1.34: 유한 창 커밋도 커밋이다(헬스와 같은 "마지막 커밋") ─────────────
// 2026-09-29 훈련 3: 16:45:49 유한 창 커밋은 last_success_at 을 갱신하지 않아 헬스가 16:56 까지
// ok:false 였다. 헬스와 크론은 같은 재료(코디네이션 last_success_at + 상품 추적기
// MAX(last_checked_at))를 본다. 크론은 코디네이션만으로 SILENT·NO_COMMIT 으로 보일 때(와
// last_success_at 이 비었을 때)만 상품 표를 한 번 읽는다.
const AFTER_GRACE_0801 = new Date("2026-08-01T02:00:00.000Z"); // 11:00 KST, 유예 밖
const MINUTE_MS = 60_000;
const agoIso = (ms) => new Date(AFTER_GRACE_0801.getTime() - ms).toISOString();

// productRows: 배열(성공) · Error(체인 throw) · "postgrest_error"(error 필드). calls 에 표 이름을 남긴다.
function productTrackerCtx(coordinationRows, productRows, calls = []) {
  return {
    supabaseAdmin: {
      from(table) {
        calls.push(table);
        if (table === "naver_rank_trackers") {
          const chain = {
            select() { return chain; },
            not() { return chain; },
            order() { return chain; },
            async limit() {
              if (productRows instanceof Error) throw productRows;
              if (productRows === "postgrest_error") return { data: null, error: { message: "permission denied" } };
              return { data: productRows, error: null };
            },
          };
          return chain;
        }
        const rows = table === "naver_shopping_worker_runs"
          ? [{ runtime_version: EXPECTED_WORKER_RUNTIME_VERSION }]
          : coordinationRows;
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          order() { return chain; },
          async limit() { return { data: rows, error: null }; },
        };
        return chain;
      },
    },
  };
}
const productRow = (iso) => [{ last_checked_at: iso }];

test("1.1.34: 코디네이션으로는 NO_COMMIT 이어도 상품 추적기 커밋(유한 창)이 45분 안이면 크론 실패가 아니다", async () => {
  const stale = [{ primary_seen_at: agoIso(MINUTE_MS), last_success_at: agoIso(2 * 60 * MINUTE_MS) }];
  const failure = (productRows) => hybridWorkerFailure(productTrackerCtx(stale, productRows), AFTER_GRACE_0801);
  assert.equal(await failure(productRow(agoIso(5 * MINUTE_MS))), null);
  assert.equal(await failure(productRow(agoIso(45 * MINUTE_MS - 1))), null, "44분 59.999초는 아직 정상이다");
  assert.equal((await failure(productRow(agoIso(45 * MINUTE_MS)))).code, NAVER_RANK_WORKER_NO_COMMIT, "정확히 45분부터 정체");
  assert.equal((await failure([])).code, NAVER_RANK_WORKER_NO_COMMIT, "상품 표식이 없으면 코디네이션 판정 그대로");
  // 읽기 실패는 1.1.33 과 같은 판정(코디네이션만)으로 물러난다 — 정지를 가리지 않는다.
  assert.equal((await failure(new Error("db_down"))).code, NAVER_RANK_WORKER_NO_COMMIT);
  assert.equal((await failure("postgrest_error")).code, NAVER_RANK_WORKER_NO_COMMIT);
  assert.equal(WORKER_COMMIT_STALL_MINUTES, 45);
});

test("1.1.34: SILENT 축도 같은 마지막 커밋을 본다 — 대기기 단독 유한 창 커밋(09-19 모양)이면 SILENT 가 아니다", async () => {
  // 09-19 15:36:39 300위 커밋 뒤 주작업기 고장, 대기기 단독(대기기 claim 은 primary_seen_at 을 갱신하지
  // 않는다), 16:23:38 유한 창 커밋. 16:37 크론은 예전에는 진척 61분 → SILENT 503 이었다(헬스는 1.1.34 에서 ok:true).
  const standbyOnly = [{ primary_seen_at: agoIso(61 * MINUTE_MS), last_success_at: agoIso(61 * MINUTE_MS) }];
  const failure = (productRows) => hybridWorkerFailure(productTrackerCtx(standbyOnly, productRows), AFTER_GRACE_0801);
  assert.equal((await failure(new Error("db_down"))).code, NAVER_RANK_WORKER_SILENT, "코디네이션만으로는 침묵이다");
  assert.equal(await failure(productRow(agoIso(13 * MINUTE_MS))), null, "유한 창 커밋 13분 전이면 진척·커밋 모두 신선");
  // 진척 축은 30분이라, 유한 창 커밋이 30~45분 전이면 크론은 여전히 SILENT 다(헬스 45분 축과의 차이 — RUNBOOK 1.1.34 B).
  assert.equal((await failure(productRow(agoIso(35 * MINUTE_MS)))).code, NAVER_RANK_WORKER_SILENT);
  assert.equal((await failure(productRow(agoIso(50 * MINUTE_MS)))).code, NAVER_RANK_WORKER_SILENT);
  assert.equal((await failure([])).code, NAVER_RANK_WORKER_SILENT);
});

test("1.1.34: last_success_at 이 비어 있으면 크론도 헬스처럼 상품 표 하나로 커밋 축을 잰다", async () => {
  const noSuccess = [{ primary_seen_at: agoIso(MINUTE_MS), last_success_at: null }];
  const failure = (productRows) => hybridWorkerFailure(productTrackerCtx(noSuccess, productRows), AFTER_GRACE_0801);
  assert.equal(await failure(productRow(agoIso(10 * MINUTE_MS))), null);
  assert.equal((await failure(productRow(agoIso(50 * MINUTE_MS)))).code, NAVER_RANK_WORKER_NO_COMMIT);
  assert.equal(await failure([]), null, "커밋 기록이 하나도 없으면 단정하지 않는다");
  assert.equal(await failure(new Error("db_down")), null, "읽기 실패는 1.1.33 과 같다(단정하지 않음)");
});

test("1.1.34: 상품 추적기 표는 코디네이션 판정이 실패로 보일 때만 읽는다(정상 경로 왕복 불변)", async () => {
  const productReads = async (coordinationRows, date = AFTER_GRACE_0801) => {
    const calls = [];
    await hybridWorkerFailure(productTrackerCtx(coordinationRows, [], calls), date);
    return calls.filter((table) => table === "naver_rank_trackers").length;
  };
  const committing = [{ primary_seen_at: agoIso(MINUTE_MS), last_success_at: agoIso(10 * MINUTE_MS) }];
  const noCommit = [{ primary_seen_at: agoIso(MINUTE_MS), last_success_at: agoIso(2 * 60 * MINUTE_MS) }];
  const silent = [{ primary_seen_at: agoIso(61 * MINUTE_MS), last_success_at: agoIso(61 * MINUTE_MS) }];
  const noSuccess = [{ primary_seen_at: agoIso(MINUTE_MS), last_success_at: null }];
  assert.equal(await productReads(committing), 0, "커밋이 신선하면 추가 조회 0");
  assert.equal(await productReads(noCommit), 1);
  assert.equal(await productReads(silent), 1);
  assert.equal(await productReads(noSuccess), 1, "last_success_at 이 비면 헬스와 같게 읽는다");
  assert.equal(await productReads([]), 0, "코디네이션을 못 읽으면(unknown) 상품 표로 메우지 않는다");
  assert.equal(await productReads(noCommit, new Date("2026-08-01T00:30:00.000Z")), 0, "유예 안에서는 판정도 조회도 없다");
});

test("1.1.34: 작업기 시계가 서버보다 2분 넘게 앞선 상품 표식은 커밋·진척으로 세지 않는다", async () => {
  assert.equal(WORKER_CHECKED_AT_MAX_AHEAD_MS, 2 * MINUTE_MS);
  const ahead = (ms) => productRow(new Date(AFTER_GRACE_0801.getTime() + ms).toISOString());
  const noCommit = [{ primary_seen_at: agoIso(MINUTE_MS), last_success_at: agoIso(2 * 60 * MINUTE_MS) }];
  const silent = [{ primary_seen_at: agoIso(61 * MINUTE_MS), last_success_at: agoIso(61 * MINUTE_MS) }];
  const failure = (rows, productRows) => hybridWorkerFailure(productTrackerCtx(rows, productRows), AFTER_GRACE_0801);
  assert.equal(await failure(noCommit, ahead(2 * MINUTE_MS)), null, "2분까지는 시계 차로 받는다");
  assert.equal((await failure(noCommit, ahead(2 * MINUTE_MS + 1))).code, NAVER_RANK_WORKER_NO_COMMIT);
  assert.equal((await failure(noCommit, ahead(365 * 24 * 60 * MINUTE_MS))).code, NAVER_RANK_WORKER_NO_COMMIT, "먼 미래 값이 정지를 가리지 않는다");
  assert.equal((await failure(silent, ahead(3 * MINUTE_MS))).code, NAVER_RANK_WORKER_SILENT);
});

test("1.1.34: hybridWorkerNoCommitFailure 세 번째 인자·조회기의 fail-safe", async () => {
  const row = { primary_seen_at: agoIso(MINUTE_MS), last_success_at: agoIso(2 * 60 * MINUTE_MS) };
  assert.equal(hybridWorkerNoCommitFailure(row, AFTER_GRACE_0801, agoIso(5 * MINUTE_MS)), null);
  assert.equal(hybridWorkerNoCommitFailure(row, AFTER_GRACE_0801, agoIso(45 * MINUTE_MS)).code, NAVER_RANK_WORKER_NO_COMMIT);
  assert.equal(hybridWorkerNoCommitFailure(row, AFTER_GRACE_0801, "").code, NAVER_RANK_WORKER_NO_COMMIT, "빈 값은 1.1.33 과 같다");
  assert.equal(hybridWorkerNoCommitFailure(row, AFTER_GRACE_0801, "not-a-date").code, NAVER_RANK_WORKER_NO_COMMIT);
  assert.equal(hybridWorkerNoCommitFailure(row, AFTER_GRACE_0801).code, NAVER_RANK_WORKER_NO_COMMIT, "옛 호출 모양 호환");
  assert.ok(hybridWorkerNoCommitFailure(row, AFTER_GRACE_0801).message.includes("45분 이상"));
  assert.equal(await hybridWorkerProductLastCheckedAt(null), null);
  assert.equal(await hybridWorkerProductLastCheckedAt({}), null);
  assert.equal(await hybridWorkerProductLastCheckedAt(productTrackerCtx([], new Error("db_down"))), null);
  assert.equal(await hybridWorkerProductLastCheckedAt(productTrackerCtx([], "postgrest_error")), null);
  assert.equal(await hybridWorkerProductLastCheckedAt(productTrackerCtx([], [])), "");
  assert.equal(
    await hybridWorkerProductLastCheckedAt(productTrackerCtx([], productRow("2026-08-01T01:55:00.000Z"))),
    "2026-08-01T01:55:00.000Z",
  );
});

test("1.1.34: 크론 핸들러 — last_success_at 2시간 전이라도 유한 창 커밋 5분 전이면 202, 대기기 단독(09-19 모양)도 202", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: AFTER_GRACE_0801.getTime() });
  const cases = [
    { primary_seen_at: agoIso(MINUTE_MS), last_success_at: agoIso(2 * 60 * MINUTE_MS), finite: agoIso(5 * MINUTE_MS) },
    { primary_seen_at: agoIso(61 * MINUTE_MS), last_success_at: agoIso(61 * MINUTE_MS), finite: agoIso(13 * MINUTE_MS) },
  ];
  for (const { finite, ...coordination } of cases) {
    const stub = stubHybridCronEnvironment({
      coordinationRows: [coordination],
      productTrackerRows: productRow(finite),
    });
    try {
      const response = await productRankCronHandler.fetch(hybridCronRequest());
      const body = await response.json();
      assert.equal(response.status, 202, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.sourceStatus.shoppingRank.status, "worker_priority");
      assert.equal(stub.calls.filter((url) => url.includes("/rest/v1/naver_rank_trackers")).length, 1);
    } finally {
      stub.restore();
    }
  }
});

// 헬스 commitStalled 와 크론 판정이 같은 입력에서 같은 답을 내는지 표로 대조한다. 한쪽만 재료를 바꾸면
// 여기서 깨진다. band 행은 문서화된 차이다 — 크론의 진척(SILENT) 축은 30분이라 커밋이 30~45분 전이고
// 주작업기 하트비트도 낡았으면 크론은 SILENT, 헬스(45분 축)는 정상이다(1.1.33 부터 있던 차이, RUNBOOK 1.1.34 B).
test("1.1.34: 헬스 commitStalled 와 크론 판정은 같은 입력에서 같은 답을 낸다(대조표)", async () => {
  const ahead = (ms) => new Date(AFTER_GRACE_0801.getTime() + ms).toISOString();
  const rows = [
    { name: "300위 커밋 신선", primary: agoIso(MINUTE_MS), success: agoIso(10 * MINUTE_MS), product: agoIso(11 * MINUTE_MS), cron: null, stalled: false },
    { name: "유한 창만 신선", primary: agoIso(MINUTE_MS), success: agoIso(120 * MINUTE_MS), product: agoIso(5 * MINUTE_MS), cron: null, stalled: false },
    { name: "유한 창 44:59.999", primary: agoIso(MINUTE_MS), success: agoIso(120 * MINUTE_MS), product: agoIso(45 * MINUTE_MS - 1), cron: null, stalled: false },
    { name: "유한 창 45:00", primary: agoIso(MINUTE_MS), success: agoIso(120 * MINUTE_MS), product: agoIso(45 * MINUTE_MS), cron: NAVER_RANK_WORKER_NO_COMMIT, stalled: true },
    { name: "상품 표식 없음", primary: agoIso(MINUTE_MS), success: agoIso(120 * MINUTE_MS), product: "", cron: NAVER_RANK_WORKER_NO_COMMIT, stalled: true },
    { name: "last_success_at 없음·상품 10분", primary: agoIso(MINUTE_MS), success: null, product: agoIso(10 * MINUTE_MS), cron: null, stalled: false },
    { name: "last_success_at 없음·상품 50분", primary: agoIso(MINUTE_MS), success: null, product: agoIso(50 * MINUTE_MS), cron: NAVER_RANK_WORKER_NO_COMMIT, stalled: true },
    { name: "커밋 기록 없음", primary: agoIso(MINUTE_MS), success: null, product: "", cron: null, stalled: false },
    { name: "대기기 단독 유한 창 13분(09-19)", primary: agoIso(61 * MINUTE_MS), success: agoIso(61 * MINUTE_MS), product: agoIso(13 * MINUTE_MS), cron: null, stalled: false },
    { name: "침묵·모든 커밋 50분", primary: agoIso(61 * MINUTE_MS), success: agoIso(61 * MINUTE_MS), product: agoIso(50 * MINUTE_MS), cron: NAVER_RANK_WORKER_SILENT, stalled: true },
    { name: "상품 표식 +3분(무시)", primary: agoIso(MINUTE_MS), success: agoIso(120 * MINUTE_MS), product: ahead(3 * MINUTE_MS), cron: NAVER_RANK_WORKER_NO_COMMIT, stalled: true },
    { name: "상품 표식 +2분(허용)", primary: agoIso(MINUTE_MS), success: agoIso(120 * MINUTE_MS), product: ahead(2 * MINUTE_MS), cron: null, stalled: false },
    { name: "침묵·커밋 35분(band)", primary: agoIso(61 * MINUTE_MS), success: agoIso(61 * MINUTE_MS), product: agoIso(35 * MINUTE_MS), cron: NAVER_RANK_WORKER_SILENT, stalled: false, band: true },
  ];
  for (const row of rows) {
    const cron = await hybridWorkerFailure(
      productTrackerCtx([{ primary_seen_at: row.primary, last_success_at: row.success }], row.product ? productRow(row.product) : []),
      AFTER_GRACE_0801,
    );
    const health = rankCollectionHealthBody({
      now: AFTER_GRACE_0801.getTime(),
      lanes: [],
      primarySeenAt: row.primary,
      lastSuccessAt: row.success || "",
      productLastCheckedAt: row.product,
      trackers: { activeProduct: 49 },
    });
    assert.equal(cron?.code ?? null, row.cron, `크론: ${row.name}`);
    assert.equal(health.lanes.product.commitStalled, row.stalled, `헬스: ${row.name}`);
    assert.equal(health.ok, !row.stalled, `헬스 ok: ${row.name}`);
    if (!row.band) assert.equal(cron !== null, health.lanes.product.commitStalled, `대조: ${row.name}`);
  }
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

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS,
  signLocalWorkerRequest,
} from "../local-worker-auth.mjs";
import { validateLocalWorkerJob } from "../naver-shopping/local-worker-contract.mjs";
import { handleLocalWorkerRequest } from "./naver-shopping-local-worker.mjs";

const SECRET = "test-local-worker-secret-that-is-longer-than-32-bytes";
const ENDPOINT = "https://insight.momentlabs.co.kr/api/naver-shopping-local-worker";
const TRACKER_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_TRACKER_ID = "123e4567-e89b-42d3-a456-426614174001";
const WORKER_ID = "test-primary-worker";
const LANE_TOKEN = "223e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "323e4567-e89b-42d3-a456-426614174000";
const CYCLE_ID = "423e4567-e89b-42d3-a456-426614174000";
const REPAIR_REQUEST_ID = "523e4567-e89b-42d3-a456-426614174000";
const RUNTIME_FINGERPRINT = "a".repeat(64);
const LANE_ACTIONS = new Set([
  "claim-wake",
  "claim",
  "queue-all-active-trackers",
  "submit",
  "fail",
]);

function signedRequest(payload, options = {}) {
  let coordinatedPayload = LANE_ACTIONS.has(payload?.action)
    ? { ...payload, workerId: WORKER_ID, laneToken: LANE_TOKEN }
    : payload;
  if (payload?.action === "claim-lane" || LANE_ACTIONS.has(payload?.action)) {
    coordinatedPayload = {
      ...coordinatedPayload,
      runId: coordinatedPayload.runId || RUN_ID,
      runtimeVersion: coordinatedPayload.runtimeVersion || "1.1.6",
      runtimeFingerprint: coordinatedPayload.runtimeFingerprint || RUNTIME_FINGERPRINT,
    };
  }
  const body = JSON.stringify(coordinatedPayload);
  const timestamp = String(Math.trunc(Number(options.nowMs ?? Date.now()) / 1000));
  const nonce = `worker-test-${crypto.randomUUID()}`;
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mi-worker-timestamp": timestamp,
      "x-mi-worker-nonce": nonce,
      "x-mi-worker-signature": signLocalWorkerRequest(SECRET, {
        timestamp,
        nonce,
        method: "POST",
        audience: "https://insight.momentlabs.co.kr",
        path: "/api/naver-shopping-local-worker",
        body,
      }),
    },
    body,
  });
}

function signedRawRequest(rawBody) {
  const timestamp = String(Math.trunc(Date.now() / 1000));
  const nonce = `worker-test-${crypto.randomUUID()}`;
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mi-worker-timestamp": timestamp,
      "x-mi-worker-nonce": nonce,
      "x-mi-worker-signature": signLocalWorkerRequest(SECRET, {
        timestamp,
        nonce,
        method: "POST",
        audience: "https://insight.momentlabs.co.kr",
        path: "/api/naver-shopping-local-worker",
        body: rawBody,
      }),
    },
    body: rawBody,
  });
}

function tracker(overrides = {}) {
  return {
    id: TRACKER_ID,
    keyword: "온열찜질기",
    product_url: "https://smartstore.naver.com/example/products/2000000011",
    product_id: "2000000011",
    mall_name: "예시몰",
    product_title: "온열찜질기 11",
    max_rank: 300,
    status: "active",
    current_rank: 15,
    best_rank: 10,
    worst_rank: 20,
    check_count: 5,
    found_count: 5,
    retry_count: 0,
    processing_started_at: new Date().toISOString(),
    processing_until: new Date(Date.now() + 12 * 60_000).toISOString(),
    ...overrides,
  };
}

function organicItem(rank) {
  return {
    organicRank: rank,
    isOrganic: true,
    isAd: false,
    productId: String(1000000000 + rank),
    sellerProductId: String(2000000000 + rank),
    title: `온열찜질기 ${rank}`,
    mallName: rank === 11 ? "예시몰" : `판매처 ${rank}`,
    link: `https://smartstore.naver.com/example/products/${2000000000 + rank}`,
    productType: "2",
  };
}

function completeWindow() {
  const collectedAt = new Date().toISOString();
  const items = Array.from({ length: 300 }, (_, index) => organicItem(index + 1));
  return {
    ok: true,
    schemaVersion: "mi.naver-shopping-organic-window.v1",
    keyword: "온열찜질기",
    source: "naver_shopping_results_collector",
    rankEvidence: "naver_shopping_organic_list",
    collectionId: `pw-${Date.now()}-worker-handler-test`,
    collectedAt,
    complete: true,
    partial: false,
    sourceExhausted: false,
    marketTotal: null,
    marketTotalStatus: "unavailable",
    checkedCount: 300,
    rawCount: 300,
    excludedAdCount: 0,
    items,
  };
}

function microsecondLeaseFixture() {
  const startedSecond = new Date(Date.now() - 60_000).toISOString().slice(0, 19);
  const untilSecond = new Date(Date.now() + 35 * 60_000).toISOString().slice(0, 19);
  return {
    databaseLeaseStartedAt: `${startedSecond}.333392Z`,
    databaseLeaseUntil: `${untilSecond}.333392Z`,
    normalizedLeaseStartedAt: `${startedSecond}.333Z`,
    normalizedLeaseUntil: `${untilSecond}.333Z`,
  };
}

function resolvingQuery(result) {
  const query = {
    select() { return query; },
    eq() { return query; },
    in() { return query; },
    gte() { return query; },
    lte() { return query; },
    is() { return query; },
    not() { return query; },
    or() { return query; },
    order() { return query; },
    limit() { return query; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return query;
}

function cycleClaimContext(data, onClaim = () => {}, onRpc = () => {}) {
  return {
    supabaseAdmin: {
      async rpc(name, args) {
        onRpc(name, args);
        if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
        if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
        if (name === "mi_claim_naver_shopping_repair_priority") {
          return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
        }
        assert.equal(name, "mi_claim_naver_shopping_cycle_keyword");
        onClaim(args);
        return { data, error: null };
      },
      from() { throw new Error("cycle_claim_must_be_atomic_in_database"); },
    },
  };
}

async function withWorkerEnv(callback) {
  const previous = {
    enabled: process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED,
    secret: process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET,
  };
  process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED = "true";
  process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET = SECRET;
  try {
    return await callback();
  } finally {
    if (previous.enabled === undefined) delete process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED;
    else process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED = previous.enabled;
    if (previous.secret === undefined) delete process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET;
    else process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET = previous.secret;
  }
}

test("rejects a correctly signed request when its nonce was already consumed", async () => {
  await withWorkerEnv(async () => {
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          assert.equal(name, "mi_consume_naver_shopping_worker_nonce");
          return { data: false, error: null };
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), ctx);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "LOCAL_WORKER_REPLAY_REJECTED");
  });
});

test("rejects signed invalid UTF-8 after authenticating the exact raw bytes", async () => {
  await withWorkerEnv(async () => {
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          assert.equal(name, "mi_consume_naver_shopping_worker_nonce");
          return { data: true, error: null };
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRawRequest(new Uint8Array([0xff])), ctx);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "LOCAL_WORKER_JSON_INVALID");
  });
});

test("atomically claims one pending remote wake through the signed worker endpoint", async () => {
  await withWorkerEnv(async () => {
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          assert.equal(name, "mi_claim_naver_shopping_worker_wake");
          return { data: true, error: null };
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({ action: "claim-wake" }), ctx);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, wake: true });
    assert.deepEqual(calls, [
      "mi_consume_naver_shopping_worker_nonce",
      "mi_touch_naver_shopping_worker_lane",
      "mi_claim_naver_shopping_worker_wake",
    ]);
  });
});

test("primary worker claims the global lane through the service-role-only RPC", async () => {
  await withWorkerEnv(async () => {
    let claimArgs = null;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_worker_lane") {
            claimArgs = args;
            return {
              data: { granted: true, reason: "granted", leaseUntil: new Date(Date.now() + 20 * 60_000).toISOString() },
              error: null,
            };
          }
          assert.equal(name, "mi_report_naver_shopping_worker_progress");
          assert.equal(args.p_runtime_version, "1.1.6");
          assert.equal(args.p_runtime_fingerprint, RUNTIME_FINGERPRINT);
          assert.equal(args.p_stage, "claiming");
          return { data: true, error: null };
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "claim-lane",
      workerId: WORKER_ID,
      workerRole: "primary",
      laneToken: LANE_TOKEN,
    }), ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).granted, true);
    assert.deepEqual(claimArgs, {
      p_worker_id: WORKER_ID,
      p_worker_role: "primary",
      p_lease_token: LANE_TOKEN,
      p_lease_seconds: 35 * 60,
      p_primary_stale_seconds: 180,
    });
  });
});

test("rejects stale worker runtime before it can claim the global lane", async () => {
  await withWorkerEnv(async () => {
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          throw new Error("stale_runtime_must_not_claim_lane");
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "claim-lane",
      workerId: WORKER_ID,
      workerRole: "primary",
      laneToken: LANE_TOKEN,
      runtimeVersion: "1.0.48",
    }), ctx);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "LOCAL_WORKER_RUNTIME_IDENTITY_INVALID");
    assert.deepEqual(calls, ["mi_consume_naver_shopping_worker_nonce"]);
  });
});

test("rejects stale runtime on an already-issued lane before claiming work", async () => {
  await withWorkerEnv(async () => {
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          throw new Error("stale_runtime_must_not_touch_or_claim");
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "claim",
      runtimeVersion: "1.0.48",
    }), ctx);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "LOCAL_WORKER_RUNTIME_IDENTITY_INVALID");
    assert.deepEqual(calls, ["mi_consume_naver_shopping_worker_nonce"]);
  });
});

test("records signed progress and atomic 300 success evidence against the active lane", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    const job = {
      keyword: "온열찜질기",
      limit: 300,
      claims: [{ trackerId: TRACKER_ID, leaseStartedAt, leaseUntil }],
    };
    const rpcCalls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          rpcCalls.push([name, args]);
          if (name === "mi_report_naver_shopping_worker_progress") return { data: true, error: null };
          assert.equal(name, "mi_record_naver_shopping_worker_success");
          return {
            data: { recorded: true, circuitState: "closed", successStreak: 7, cadenceEligible: false },
            error: null,
          };
        },
      },
    };
    const identity = {
      workerId: WORKER_ID,
      laneToken: LANE_TOKEN,
      runId: RUN_ID,
      runtimeVersion: "1.1.6",
      runtimeFingerprint: RUNTIME_FINGERPRINT,
    };
    const progressResponse = await handleLocalWorkerRequest(signedRequest({
      action: "progress",
      ...identity,
      stage: "collecting",
      page: 4,
      jobKind: "tracker",
      trackerId: TRACKER_ID,
    }), ctx);
    assert.equal(progressResponse.status, 200);
    const successResponse = await handleLocalWorkerRequest(signedRequest({
      action: "record-success",
      ...identity,
      job,
      collectionId: "pw-chrome-atomic300-control-plane",
      checkedCount: 300,
      excludedAdCount: 12,
      durationMs: 123_456,
      source: "naver_shopping_results_collector",
    }), ctx);
    assert.equal(successResponse.status, 200);
    assert.equal((await successResponse.json()).recorded, true);
    assert.equal(rpcCalls[0][1].p_stage, "collecting");
    assert.equal(rpcCalls[0][1].p_page, 4);
    assert.equal(rpcCalls[1][1].p_checked_count, 300);
    assert.equal(rpcCalls[1][1].p_tracker_id, TRACKER_ID);
    assert.equal(rpcCalls[1][1].p_source, "naver_shopping_results_collector");
  });
});

test("records typed tracker failures without changing rank data in the HTTP handler", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    let failureArgs = null;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          assert.equal(name, "mi_record_naver_shopping_worker_failure");
          failureArgs = args;
          return {
            data: {
              recorded: true,
              circuitState: "closed",
              failureStreak: 2,
              quarantinedUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
            },
            error: null,
          };
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "record-failure",
      workerId: WORKER_ID,
      laneToken: LANE_TOKEN,
      runId: RUN_ID,
      runtimeVersion: "1.1.6",
      runtimeFingerprint: RUNTIME_FINGERPRINT,
      job: {
        keyword: "온열찜질기",
        limit: 300,
        claims: [{ trackerId: TRACKER_ID, leaseStartedAt, leaseUntil }],
      },
      errorCode: "local_worker_tracker_mismatch",
      scope: "tracker",
    }), ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).failureStreak, 2);
    assert.equal(failureArgs.p_scope, "tracker");
    assert.equal(failureArgs.p_tracker_id, TRACKER_ID);
    assert.equal(Object.hasOwn(failureArgs, "current_rank"), false);
  });
});

test("forwards a bounded duplicate-identity suffix as one tracker-scoped failure", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    let failureArgs = null;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          assert.equal(name, "mi_record_naver_shopping_worker_failure");
          failureArgs = args;
          return {
            data: { recorded: true, circuitState: "closed", quarantined: true },
            error: null,
          };
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "record-failure",
      workerId: WORKER_ID,
      laneToken: LANE_TOKEN,
      runId: RUN_ID,
      runtimeVersion: "1.1.6",
      runtimeFingerprint: RUNTIME_FINGERPRINT,
      job: {
        keyword: "남성 사각팬티",
        limit: 300,
        claims: [{ trackerId: TRACKER_ID, leaseStartedAt, leaseUntil }],
      },
      errorCode: "provider_duplicate_identity:8:2:page_overlap:7",
      scope: "tracker",
    }), ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).quarantined, true);
    assert.equal(failureArgs.p_error_code, "provider_duplicate_identity:8:2:page_overlap:7");
    assert.equal(failureArgs.p_scope, "tracker");
    assert.equal(failureArgs.p_tracker_id, TRACKER_ID);
    assert.equal(Object.hasOwn(failureArgs, "retry_count"), false);
    assert.equal(Object.hasOwn(failureArgs, "current_rank"), false);
  });
});

test("never claims a tracker after the global lane was lost", async () => {
  await withWorkerEnv(async () => {
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          assert.equal(name, "mi_touch_naver_shopping_worker_lane");
          return { data: false, error: null };
        },
        from() { throw new Error("tracker_claim_must_not_run"); },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), ctx);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "LOCAL_WORKER_LANE_LOST");
  });
});

test("repair priority claims one selected tracker before the durable cycle and strips raw tracker payload", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    const calls = [];
    let repairArgs = null;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          assert.equal(name, "mi_claim_naver_shopping_repair_priority");
          repairArgs = args;
          return {
            data: {
              status: "claimed",
              priority: "repair",
              cycleId: CYCLE_ID,
              requestId: REPAIR_REQUEST_ID,
              position: 1,
              keyword: "남자 사각팬티",
              tracker: { current_rank: 1, product_id: "untrusted-raw-payload" },
              claims: [{
                trackerId: TRACKER_ID,
                leaseStartedAt,
                leaseUntil,
                currentRank: 1,
                productId: "untrusted-raw-payload",
              }],
            },
            error: null,
          };
        },
        from() { throw new Error("repair_claim_must_load_canonical_tracker_only_during_submit"); },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.job, {
      keyword: "남자 사각팬티",
      limit: 300,
      claims: [{ trackerId: TRACKER_ID, leaseStartedAt, leaseUntil }],
    });
    assert.deepEqual(repairArgs, {
      p_worker_id: WORKER_ID,
      p_lane_token: LANE_TOKEN,
      p_run_id: RUN_ID,
      p_lease_seconds: 35 * 60,
    });
    assert.equal(calls.includes("mi_claim_naver_shopping_cycle_keyword"), false);
  });
});

test("repair priority waiting blocks the normal cycle without requeue or lookup bypass", async () => {
  await withWorkerEnv(async () => {
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          assert.equal(name, "mi_claim_naver_shopping_repair_priority");
          return {
            data: { status: "waiting", priority: "repair", claims: [] },
            error: null,
          };
        },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).job, null);
    assert.equal(calls.includes("mi_claim_naver_shopping_cycle_keyword"), false);
    assert.equal(calls.includes("mi_claim_naver_shopping_rank_lookup_job"), false);
  });
});

test("an empty repair queue falls through once to the existing durable cycle", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_repair_priority") {
            return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
          }
          assert.equal(name, "mi_claim_naver_shopping_cycle_keyword");
          return {
            data: {
              cycleId: CYCLE_ID,
              status: "claimed",
              priority: "normal",
              keyword: "기존 순서 키워드",
              claims: [{ trackerId: SECOND_TRACKER_ID, leaseStartedAt, leaseUntil }],
            },
            error: null,
          };
        },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "기존 순서 키워드");
    assert.deepEqual(calls.slice(-2), [
      "mi_claim_naver_shopping_repair_priority",
      "mi_claim_naver_shopping_cycle_keyword",
    ]);
  });
});

test("malformed repair claims fail closed before any normal cycle claim", async () => {
  await withWorkerEnv(async () => {
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          assert.equal(name, "mi_claim_naver_shopping_repair_priority");
          return {
            data: {
              status: "claimed",
              priority: "repair",
              requestId: REPAIR_REQUEST_ID,
              position: 1,
              keyword: "손상 응답",
              claims: [{ trackerId: "not-a-uuid", leaseStartedAt: "bad", leaseUntil: "bad" }],
            },
            error: null,
          };
        },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "LOCAL_WORKER_REPAIR_INVALID");
    assert.equal(calls.includes("mi_claim_naver_shopping_cycle_keyword"), false);
  });
});

test("cycle RPC is the canonical authority for whitespace-normalized keyword grouping", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    const ctx = cycleClaimContext({
      cycleId: CYCLE_ID,
      status: "claimed",
      priority: "normal",
      keyword: "온열 찜질기",
      claims: [
        { trackerId: TRACKER_ID, leaseStartedAt, leaseUntil },
        { trackerId: SECOND_TRACKER_ID, leaseStartedAt, leaseUntil },
      ],
    });
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "온열 찜질기");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [TRACKER_ID, SECOND_TRACKER_ID]);
  });
});

test("cycle claim surfaces the next deterministic group after database lease contention", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    const ctx = cycleClaimContext({
      cycleId: CYCLE_ID,
      status: "claimed",
      priority: "normal",
      keyword: "다음 키워드",
      claims: [{ trackerId: SECOND_TRACKER_ID, leaseStartedAt, leaseUntil }],
    });
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "다음 키워드");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [SECOND_TRACKER_ID]);
  });
});

test("cycle claim preserves newly registered keyword priority from the atomic scheduler", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    const ctx = cycleClaimContext({
      cycleId: CYCLE_ID,
      status: "claimed",
      priority: "new",
      keyword: "신규 키워드",
      claims: [{ trackerId: TRACKER_ID, leaseStartedAt, leaseUntil }],
    });
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "신규 키워드");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [TRACKER_ID]);
  });
});

test("cycle claim preserves normal cursor order after no new keyword remains", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    const ctx = cycleClaimContext({
      cycleId: CYCLE_ID,
      status: "claimed",
      priority: "resume",
      keyword: "기존 다음 키워드",
      claims: [{ trackerId: SECOND_TRACKER_ID, leaseStartedAt, leaseUntil }],
    });
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "기존 다음 키워드");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [SECOND_TRACKER_ID]);
  });
});

test("cycle claim returns the new first keyword and groups its cross-agency trackers", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    let cycleArgs = null;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_repair_priority") {
            return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
          }
          if (name === "mi_claim_naver_shopping_rank_lookup_job") return { data: [], error: null };
          assert.equal(name, "mi_claim_naver_shopping_cycle_keyword");
          cycleArgs = args;
          return {
            data: {
              cycleId: CYCLE_ID,
              status: "claimed",
              priority: "new",
              keyword: "신규 키워드",
              limit: 50,
              claims: [
                {
                  tracker_id: TRACKER_ID,
                  agency_code: "agency-a",
                  lease_started_at: leaseStartedAt,
                  lease_until: leaseUntil,
                },
                {
                  tracker_id: SECOND_TRACKER_ID,
                  agency_code: "agency-b",
                  lease_started_at: leaseStartedAt,
                  lease_until: leaseUntil,
                },
              ],
            },
            error: null,
          };
        },
        from() { throw new Error("cycle_claim_must_be_atomic_in_database"); },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "claim",
      schedulerVersion: "v2",
    }), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "신규 키워드");
    assert.equal(body.job.limit, 300);
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [TRACKER_ID, SECOND_TRACKER_ID]);
    assert.deepEqual(cycleArgs, {
      p_worker_id: WORKER_ID,
      p_lane_token: LANE_TOKEN,
      p_run_id: RUN_ID,
      p_probe_tracker_id: null,
      p_lease_seconds: 35 * 60,
    });
  });
});

test("cycle claim remains single-winner under concurrent signed requests", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    let claimed = false;
    let claimCalls = 0;
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_repair_priority") {
            return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
          }
          assert.equal(name, "mi_claim_naver_shopping_cycle_keyword");
          claimCalls += 1;
          if (claimed) return { data: { status: "waiting" }, error: null };
          claimed = true;
          return {
            data: {
              cycleId: CYCLE_ID,
              status: "claimed",
              priority: "normal",
              keyword: "순환 키워드",
              claims: [{
                trackerId: TRACKER_ID,
                leaseStartedAt,
                leaseUntil,
              }],
            },
            error: null,
          };
        },
      },
    };
    const responses = await Promise.all([
      handleLocalWorkerRequest(signedRequest({ action: "claim", schedulerVersion: "v2" }), ctx),
      handleLocalWorkerRequest(signedRequest({ action: "claim", schedulerVersion: "v2" }), ctx),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(bodies.filter((body) => body.job?.claims?.length === 1).length, 1);
    assert.equal(bodies.filter((body) => body.job === null).length, 1);
    assert.equal(claimCalls, 2);
  });
});

test("cycle claim fails closed on an expired lease instead of weakening the 300 contract", async () => {
  await withWorkerEnv(async () => {
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_repair_priority") {
            return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
          }
          assert.equal(name, "mi_claim_naver_shopping_cycle_keyword");
          return {
            data: {
              cycleId: CYCLE_ID,
              status: "claimed",
              priority: "normal",
              keyword: "만료 키워드",
              limit: 300,
              claims: [{
                trackerId: TRACKER_ID,
                leaseStartedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
                leaseUntil: new Date(Date.now() - 60_000).toISOString(),
              }],
            },
            error: null,
          };
        },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "LOCAL_WORKER_CYCLE_INVALID");
  });
});

test("active cycle waiting never lets an interactive lookup bypass tracker order", async () => {
  await withWorkerEnv(async () => {
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_repair_priority") {
            return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
          }
          if (name === "mi_claim_naver_shopping_cycle_keyword") {
            return { data: { status: "waiting" }, error: null };
          }
          throw new Error("lookup_must_not_bypass_active_cycle");
        },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).job, null);
    assert.equal(calls.includes("mi_claim_naver_shopping_rank_lookup_job"), false);
  });
});

test("a completed cycle permits one bounded lookup claim", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_repair_priority") {
            return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
          }
          if (name === "mi_claim_naver_shopping_cycle_keyword") {
            return { data: { status: "cycle_completed" }, error: null };
          }
          assert.equal(name, "mi_claim_naver_shopping_rank_lookup_job");
          return {
            data: [{
              id: TRACKER_ID,
              keyword: "즉시 조회",
              lease_started_at: leaseStartedAt,
              lease_until: leaseUntil,
            }],
            error: null,
          };
        },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.kind, "lookup");
    assert.equal(body.job.claims.length, 1);
    assert.deepEqual(calls.slice(-2), [
      "mi_claim_naver_shopping_cycle_keyword",
      "mi_claim_naver_shopping_rank_lookup_job",
    ]);
  });
});

test("probe cycle never falls through to an unrelated lookup", async () => {
  await withWorkerEnv(async () => {
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_cycle_keyword") {
            return { data: { status: "no_cycle" }, error: null };
          }
          throw new Error("probe_must_not_claim_lookup");
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "claim",
      schedulerVersion: "v2",
      probeTrackerId: TRACKER_ID,
    }), ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).job, null);
    assert.equal(calls.includes("mi_claim_naver_shopping_rank_lookup_job"), false);
  });
});

test("probe claims its exact tracker without opening or consuming a normal cycle", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseUntil = new Date(Date.now() + 35 * 60_000).toISOString();
    let claimArgs = null;
    const calls = [];
    const ctx = cycleClaimContext({
      cycleId: null,
      status: "claimed",
      priority: "probe",
      keyword: "남자팬티",
      claims: [{ trackerId: TRACKER_ID, leaseStartedAt, leaseUntil }],
    }, (args) => { claimArgs = args; }, (name) => { calls.push(name); });
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "claim",
      schedulerVersion: "v2",
      probeTrackerId: TRACKER_ID,
    }), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "남자팬티");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [TRACKER_ID]);
    assert.equal(claimArgs.p_probe_tracker_id, TRACKER_ID);
    assert.equal(calls.includes("mi_claim_naver_shopping_repair_priority"), false);
  });
});

test("legacy v1 scheduler fails closed without querying or claiming a tracker", async () => {
  await withWorkerEnv(async () => {
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          throw new Error("legacy_scheduler_must_not_claim");
        },
        from() { throw new Error("legacy_scheduler_must_not_query"); },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v1" }),
      ctx,
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "LOCAL_WORKER_SCHEDULER_VERSION_STALE");
    assert.deepEqual(calls, [
      "mi_consume_naver_shopping_worker_nonce",
      "mi_touch_naver_shopping_worker_lane",
    ]);
  });
});

test("central collector delegates deterministic ordering, quarantine and grouping to the cycle RPC", () => {
  const source = fs.readFileSync(new URL("./naver-shopping-local-worker.mjs", import.meta.url), "utf8");
  const repairStart = source.indexOf("async function claimRepairPriority");
  const cycleStart = source.indexOf("async function claimCycleKeyword");
  const cycleEnd = source.indexOf("async function loadClaimTrackers");
  const repairSource = source.slice(repairStart, cycleStart);
  const cycleSource = source.slice(cycleStart, cycleEnd);
  assert.ok(repairStart >= 0 && cycleStart > repairStart && cycleEnd > cycleStart);
  assert.match(repairSource, /mi_claim_naver_shopping_repair_priority/u);
  assert.match(repairSource, /priority !== "repair"/u);
  assert.match(repairSource, /raw tracker payload[\s\S]*discarded/u);
  assert.match(repairSource, /validateLocalWorkerJob\(job, \{ requireActiveLease: true/u);
  assert.doesNotMatch(repairSource, /next_check_at|sort_order|scheduler_cycle_cursor/u);
  assert.match(cycleSource, /mi_claim_naver_shopping_cycle_keyword/u);
  assert.match(cycleSource, /p_worker_id: control\.workerId/u);
  assert.match(cycleSource, /p_lane_token: control\.laneToken/u);
  assert.match(cycleSource, /p_run_id: control\.runId/u);
  assert.match(cycleSource, /p_probe_tracker_id/u);
  assert.match(cycleSource, /p_lease_seconds: WORKER_COLLECTION_LEASE_SECONDS/u);
  assert.match(cycleSource, /validateLocalWorkerJob\(job, \{ requireActiveLease: true/u);
  assert.doesNotMatch(cycleSource, /\.from\("naver_rank_trackers"\)/u);
  assert.doesNotMatch(cycleSource, /next_check_at|sort_order|worker_quarantined_until/u);
  assert.match(source, /body\.schedulerVersion === "v2"/u);
  assert.match(source, /LOCAL_WORKER_SCHEDULER_VERSION_STALE/u);
});

test("signed manual queue opens one idempotent cycle without rewriting tracker order or due time", async () => {
  await withWorkerEnv(async () => {
    const rpcCalls = [];
    const cycleId = "423e4567-e89b-42d3-a456-426614174000";
    const cycleStartedAt = new Date().toISOString();
    let queueCount = 0;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          rpcCalls.push([name, args]);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          assert.equal(name, "mi_queue_naver_shopping_cycle");
          queueCount += 1;
          return {
            data: {
              status: "active",
              cycle_id: cycleId,
              cycle_started_at: cycleStartedAt,
              started: queueCount === 1,
              total: 3,
              remaining: 2,
              processing: 1,
            },
            error: null,
          };
        },
        from() { throw new Error("queue_cycle_must_not_rewrite_trackers"); },
      },
    };

    const firstResponse = await handleLocalWorkerRequest(
      signedRequest({ action: "queue-all-active-trackers" }),
      ctx,
    );
    const secondResponse = await handleLocalWorkerRequest(
      signedRequest({ action: "queue-all-active-trackers" }),
      ctx,
    );
    const body = await firstResponse.json();
    const repeatedBody = await secondResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual({
      total: body.total,
      queued: body.queued,
      alreadyQueued: body.alreadyQueued,
      alreadyProcessing: body.alreadyProcessing,
    }, { total: 3, queued: 2, alreadyQueued: 0, alreadyProcessing: 1 });
    assert.deepEqual({
      total: repeatedBody.total,
      queued: repeatedBody.queued,
      alreadyQueued: repeatedBody.alreadyQueued,
      alreadyProcessing: repeatedBody.alreadyProcessing,
    }, { total: 3, queued: 0, alreadyQueued: 2, alreadyProcessing: 1 });
    assert.equal(body.cycleId, cycleId);
    assert.equal(repeatedBody.cycleId, cycleId);
    assert.equal(rpcCalls.filter(([name]) => name === "mi_queue_naver_shopping_cycle").length, 2);
    assert.equal(rpcCalls.find(([name]) => name === "mi_queue_naver_shopping_cycle")[1], undefined);
    assert.equal(JSON.stringify(rpcCalls).includes("next_check_at"), false);
    assert.equal(JSON.stringify(rpcCalls).includes("sort_order"), false);
    assert.equal(Object.hasOwn(body, "trackerIds"), false);
    assert.equal(Object.hasOwn(repeatedBody, "trackerIds"), false);
  });
});

test("signed queue reports an empty tracker set without inventing a cycle", async () => {
  await withWorkerEnv(async () => {
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          assert.equal(name, "mi_queue_naver_shopping_cycle");
          return { data: {
            status: "empty",
            cycleId: null,
            cycleStartedAt: null,
            started: false,
            total: 0,
            remaining: 0,
            processing: 0,
          }, error: null };
        },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "queue-all-active-trackers" }),
      ctx,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      total: 0,
      queued: 0,
      alreadyQueued: 0,
      alreadyProcessing: 0,
      cycleId: null,
      cycleStartedAt: null,
    });
  });
});

test("claims an interactive lookup only after the tracker cycle completes and stores its strict 300 result", async () => {
  await withWorkerEnv(async () => {
    const {
      databaseLeaseStartedAt,
      databaseLeaseUntil,
      normalizedLeaseStartedAt,
      normalizedLeaseUntil,
    } = microsecondLeaseFixture();
    const rawLookupJob = {
      kind: "lookup",
      keyword: "온열찜질기",
      limit: 300,
      claims: [{
        lookupJobId: TRACKER_ID,
        leaseStartedAt: databaseLeaseStartedAt,
        leaseUntil: databaseLeaseUntil,
      }],
    };
    const claimCtx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_repair_priority") {
            return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
          }
          if (name === "mi_claim_naver_shopping_cycle_keyword") {
            return { data: { status: "cycle_completed" }, error: null };
          }
          assert.equal(name, "mi_claim_naver_shopping_rank_lookup_job");
          return {
            data: [{
              id: TRACKER_ID,
              keyword: "온열찜질기",
              lease_started_at: databaseLeaseStartedAt,
              lease_until: databaseLeaseUntil,
            }],
            error: null,
          };
        },
        from() { throw new Error("periodic_tracker_should_not_be_claimed"); },
      },
    };
    const claimResponse = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      claimCtx,
    );
    assert.equal(claimResponse.status, 200);
    const claimedPayload = await claimResponse.json();
    assert.deepEqual(claimedPayload.job, rawLookupJob);
    const lookupJob = validateLocalWorkerJob(claimedPayload.job);
    assert.equal(lookupJob.claims[0].leaseStartedAt, normalizedLeaseStartedAt);
    assert.equal(lookupJob.claims[0].leaseUntil, normalizedLeaseUntil);

    let completeArgs = null;
    const submitCtx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          assert.equal(name, "mi_complete_naver_shopping_rank_lookup_job");
          completeArgs = args;
          return { data: "committed", error: null };
        },
        from(table) {
          assert.equal(table, "naver_shopping_rank_lookup_jobs");
          const query = {
            select() { return query; },
            eq() { return query; },
            async maybeSingle() {
              return {
                data: {
                  id: TRACKER_ID,
                  keyword: "온열찜질기",
                  product_url: "https://smartstore.naver.com/example/products/2000000011",
                  product_id: "2000000011",
                  target_catalog_id: null,
                  mall_name: "예시몰",
                  product_title: "온열찜질기 11",
                  max_rank: 300,
                  status: "processing",
                  processing_started_at: databaseLeaseStartedAt,
                  processing_until: databaseLeaseUntil,
                },
                error: null,
              };
            },
          };
          return query;
        },
      },
    };
    const submitResponse = await handleLocalWorkerRequest(signedRequest({
      action: "submit",
      job: lookupJob,
      window: completeWindow(),
    }), submitCtx);
    const submitPayload = await submitResponse.json();
    assert.equal(submitResponse.status, 200);
    assert.equal(submitPayload.committedCount, 1);
    assert.equal(completeArgs.p_job_id, TRACKER_ID);
    assert.equal(completeArgs.p_lease_started_at, normalizedLeaseStartedAt);
    assert.equal(completeArgs.p_result.result.rank, 11);
    assert.equal(completeArgs.p_result.result.checkedCount, 300);
  });
});

test("normalizes a microsecond lookup claim before the failure RPC round trip", async () => {
  await withWorkerEnv(async () => {
    const {
      databaseLeaseStartedAt,
      databaseLeaseUntil,
      normalizedLeaseStartedAt,
    } = microsecondLeaseFixture();
    const claimCtx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_repair_priority") {
            return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
          }
          if (name === "mi_claim_naver_shopping_cycle_keyword") {
            return { data: { status: "cycle_completed" }, error: null };
          }
          assert.equal(name, "mi_claim_naver_shopping_rank_lookup_job");
          return {
            data: [{
              id: TRACKER_ID,
              keyword: "온열찜질기",
              lease_started_at: databaseLeaseStartedAt,
              lease_until: databaseLeaseUntil,
            }],
            error: null,
          };
        },
        from() { throw new Error("periodic_tracker_should_not_be_claimed"); },
      },
    };
    const claimResponse = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      claimCtx,
    );
    assert.equal(claimResponse.status, 200);
    const job = validateLocalWorkerJob((await claimResponse.json()).job);
    assert.equal(job.claims[0].leaseStartedAt, normalizedLeaseStartedAt);

    let failArgs = null;
    const failCtx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          assert.equal(name, "mi_fail_naver_shopping_rank_lookup_job");
          failArgs = args;
          return { data: true, error: null };
        },
      },
    };
    const failResponse = await handleLocalWorkerRequest(signedRequest({
      action: "fail",
      job,
      errorCode: "provider_partial_window:299_300",
    }), failCtx);
    assert.equal(failResponse.status, 200);
    assert.equal((await failResponse.json()).releasedCount, 1);
    assert.equal(failArgs.p_job_id, TRACKER_ID);
    assert.equal(failArgs.p_lease_started_at, normalizedLeaseStartedAt);
  });
});

test("atomic cycle claim fails closed without attempting a legacy compensating release", async () => {
  await withWorkerEnv(async () => {
    const calls = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          calls.push(name);
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_repair_priority") {
            return { data: { status: "empty", priority: "repair", claims: [] }, error: null };
          }
          assert.equal(name, "mi_claim_naver_shopping_cycle_keyword");
          return { data: null, error: { message: "atomic_claim_failed" } };
        },
        from() { throw new Error("legacy_claim_query_must_not_run"); },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "claim", schedulerVersion: "v2" }),
      ctx,
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "LOCAL_WORKER_CYCLE_UNAVAILABLE");
    assert.equal(calls.includes("mi_fail_naver_shopping_worker_claim"), false);
  });
});

test("submits one strict 300 window at the shared signed-worker clock skew", async () => {
  await withWorkerEnv(async () => {
    const row = tracker();
    const workerNowMs = Date.now() + (LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS - 1) * 1000;
    const window = {
      ...completeWindow(),
      collectedAt: new Date(workerNowMs).toISOString(),
    };
    const job = {
      keyword: row.keyword,
      limit: 300,
      claims: [{
        trackerId: row.id,
        leaseStartedAt: row.processing_started_at,
        leaseUntil: row.processing_until,
      }],
    };
    let commitArgs = null;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_load_naver_shopping_worker_catalog_history") return { data: [], error: null };
          assert.equal(name, "mi_commit_naver_shopping_worker_result");
          commitArgs = args;
          return { data: { status: "committed", snapshotId: crypto.randomUUID() }, error: null };
        },
        from(table) {
          if (table === "naver_rank_trackers") return resolvingQuery({ data: [row], error: null });
          if (table === "naver_rank_snapshots") return resolvingQuery({ data: [], error: null });
          throw new Error(`unexpected table ${table}`);
        },
      },
    };
    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "submit", job, window }, { nowMs: workerNowMs }),
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.committedCount, 1);
    assert.equal(commitArgs.p_collection_id, window.collectionId);
    assert.equal(commitArgs.p_checked_at, window.collectedAt);
    assert.equal(commitArgs.p_snapshot.checked_count, 300);
    assert.equal(commitArgs.p_snapshot.matched, true);
    assert.equal(commitArgs.p_snapshot.rank, 11);
    assert.equal(commitArgs.p_snapshot.item.rankPolicy, "organic_only");
    assert.equal(commitArgs.p_snapshot.item.adExcluded, true);
  });
});

test("submits nine same-keyword agency claims while loading catalog history in 8 plus 1 chunks", async () => {
  await withWorkerEnv(async () => {
    const rows = Array.from({ length: 9 }, (_, index) => tracker({
      id: `923e4567-e89b-42d3-a456-42661417400${index + 1}`,
      agency_code: `agency-${index + 1}`,
      keyword: index % 2 === 0 ? "온열찜질기" : " 온열 찜질기 ",
    }));
    const job = {
      keyword: rows[0].keyword,
      limit: 300,
      claims: rows.map((row) => ({
        trackerId: row.id,
        leaseStartedAt: row.processing_started_at,
        leaseUntil: row.processing_until,
      })),
    };
    const historyBatchSizes = [];
    let commitCount = 0;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_load_naver_shopping_worker_catalog_history") {
            historyBatchSizes.push(args.p_tracker_ids.length);
            return { data: [], error: null };
          }
          assert.equal(name, "mi_commit_naver_shopping_worker_result");
          commitCount += 1;
          return { data: { status: "committed", snapshotId: crypto.randomUUID() }, error: null };
        },
        from(table) {
          assert.equal(table, "naver_rank_trackers");
          return resolvingQuery({ data: rows, error: null });
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "submit",
      job,
      window: completeWindow(),
    }), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.committedCount, 9);
    assert.equal(commitCount, 9);
    assert.deepEqual(historyBatchSizes, [8, 1]);
  });
});

test("bulk-loads continuity once, avoids external metadata fetches and reports partial commits", async () => {
  await withWorkerEnv(async () => {
    const first = tracker();
    const second = tracker({
      id: SECOND_TRACKER_ID,
      product_id: "2000000012",
      product_url: "https://smartstore.naver.com/example/products/2000000012",
      product_title: "온열찜질기 12",
    });
    const window = completeWindow();
    const job = {
      keyword: first.keyword,
      limit: 300,
      claims: [first, second].map((row) => ({
        trackerId: row.id,
        leaseStartedAt: row.processing_started_at,
        leaseUntil: row.processing_until,
      })),
    };
    let snapshotQueryCount = 0;
    let commitCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("unexpected_external_metadata_fetch");
    };
    try {
      const ctx = {
        supabaseAdmin: {
          async rpc(name) {
            if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
            if (name === "mi_load_naver_shopping_worker_catalog_history") {
              snapshotQueryCount += 1;
              return { data: [], error: null };
            }
            assert.equal(name, "mi_commit_naver_shopping_worker_result");
            commitCount += 1;
            if (commitCount === 1) {
              return { data: { status: "committed", snapshotId: crypto.randomUUID() }, error: null };
            }
            return { data: null, error: { code: "db_unavailable", message: "db_unavailable" } };
          },
          from(table) {
            if (table === "naver_rank_trackers") return resolvingQuery({ data: [first, second], error: null });
            throw new Error(`unexpected table ${table}`);
          },
        },
      };
      const response = await handleLocalWorkerRequest(signedRequest({ action: "submit", job, window }), ctx);
      const body = await response.json();
      assert.equal(response.status, 409);
      assert.equal(body.ok, false);
      assert.equal(body.code, "LOCAL_WORKER_SUBMIT_PARTIAL");
      assert.equal(body.partial.committedCount, 1);
      assert.equal(body.partial.processedCount, 1);
      assert.equal(snapshotQueryCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("failure uses the lease-only RPC and never sends a rank value", async () => {
  await withWorkerEnv(async () => {
    const row = tracker();
    const job = {
      keyword: row.keyword,
      limit: 300,
      claims: [{ trackerId: row.id, leaseStartedAt: row.processing_started_at, leaseUntil: row.processing_until }],
    };
    let failArgs = null;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          assert.equal(name, "mi_fail_naver_shopping_worker_claim");
          failArgs = args;
          return { data: true, error: null };
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "fail",
      job,
      errorCode: "naver_http_418",
    }), ctx);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).releasedCount, 1);
    assert.equal(Object.hasOwn(failArgs, "current_rank"), false);
  });
});

test("submit reports lost leases and conflicts without treating them as committed", async () => {
  await withWorkerEnv(async () => {
    for (const [status, expectedCode] of [
      ["lease_lost", "LOCAL_WORKER_LEASE_LOST"],
      ["collection_conflict", "LOCAL_WORKER_COLLECTION_CONFLICT"],
    ]) {
      const row = tracker();
      const window = completeWindow();
      const job = {
        keyword: row.keyword,
        limit: 300,
        claims: [{
          trackerId: row.id,
          leaseStartedAt: row.processing_started_at,
          leaseUntil: row.processing_until,
        }],
      };
      const ctx = {
        supabaseAdmin: {
          async rpc(name) {
            if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
            if (name === "mi_load_naver_shopping_worker_catalog_history") return { data: [], error: null };
            assert.equal(name, "mi_commit_naver_shopping_worker_result");
            return { data: { status }, error: null };
          },
          from(table) {
            if (table === "naver_rank_trackers") return resolvingQuery({ data: [row], error: null });
            if (table === "naver_rank_snapshots") return resolvingQuery({ data: [], error: null });
            throw new Error(`unexpected table ${table}`);
          },
        },
      };
      const response = await handleLocalWorkerRequest(signedRequest({ action: "submit", job, window }), ctx);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.processedCount, 1);
      assert.equal(body.committedCount, 0);
      assert.equal(body.leaseLostCount, status === "lease_lost" ? 1 : 0);
      assert.equal(body.collectionConflictCount, status === "collection_conflict" ? 1 : 0);
      assert.ok(expectedCode);
    }
  });
});

test("migration makes nonce consumption and snapshot plus tracker commit service-role only", () => {
  const sql = fs.readFileSync(new URL("../../../supabase/migrations/20260801125959_naver_shopping_local_worker.sql", import.meta.url), "utf8");
  assert.match(sql, /unique index[^;]+tracker_id, collection_id/is);
  assert.match(sql, /index[^;]+naver_shopping_worker_nonces\(created_at\)/is);
  assert.match(sql, /mi_consume_naver_shopping_worker_nonce/);
  assert.match(sql, /mi_load_naver_shopping_worker_catalog_history/);
  assert.match(sql, /cardinality[^;]+between 1 and 8/is);
  assert.match(sql, /cross join lateral[\s\S]+limit least/is);
  assert.match(sql, /mi_commit_naver_shopping_worker_result/);
  assert.match(sql, /grant execute[^;]+to service_role/is);
  const commitBody = sql.slice(
    sql.indexOf("create or replace function public.mi_commit_naver_shopping_worker_result"),
    sql.indexOf("create or replace function public.mi_fail_naver_shopping_worker_claim"),
  );
  assert.ok(commitBody.indexOf("for update") < commitBody.indexOf("where tracker_id = p_tracker_id and collection_id = p_collection_id"));
  assert.match(commitBody, /processing_started_at is null[\s\S]+already_committed/i);
  assert.match(commitBody, /processing_until\s*>\s*clock_timestamp\(\)/i);
  assert.match(commitBody, /collection_conflict/i);
  assert.match(commitBody, /collection_conflict[\s\S]+processing_started_at = null/i);
  const failureBody = sql.slice(sql.indexOf("create or replace function public.mi_fail_naver_shopping_worker_claim"));
  assert.doesNotMatch(failureBody, /current_rank\s*=/i);
});

test("lookup queue migration is isolated, deduplicated and claimed without blocking", () => {
  const sql = fs.readFileSync(new URL("../../../supabase/migrations/20260802161731_naver_shopping_rank_lookup_jobs.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/iu);
  assert.match(sql, /force row level security/iu);
  assert.match(sql, /revoke all on table public\.naver_shopping_rank_lookup_jobs from public, anon, authenticated/iu);
  assert.match(sql, /grant select, insert, update, delete[^;]+service_role/isu);
  assert.match(sql, /unique index[^;]+scope_hash, request_hash[^;]+pending[^;]+processing/isu);
  assert.match(sql, /pg_advisory_xact_lock/iu);
  assert.match(sql, /for update skip locked/iu);
  assert.match(sql, /mi_complete_naver_shopping_rank_lookup_job/iu);
  assert.match(sql, /mi_fail_naver_shopping_rank_lookup_job/iu);
  assert.doesNotMatch(sql, /grant[^;]+to authenticated/iu);
});

test("remote wake migration is atomic and service-role only", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260809113105_naver_shopping_worker_remote_wake.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /enable row level security/iu);
  assert.match(sql, /force row level security/iu);
  assert.match(sql, /revoke all on table public\.naver_shopping_worker_wakes from public, anon, authenticated, service_role/iu);
  assert.match(sql, /grant select, insert, update on table public\.naver_shopping_worker_wakes to service_role/iu);
  assert.match(sql, /security invoker/iu);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.match(sql, /consumed_at is null or consumed_at < requested_at/iu);
  assert.match(sql, /get diagnostics claimed_count = row_count/iu);
  assert.match(sql, /grant execute on function public\.mi_request_naver_shopping_worker_wake\(text\)[\s\S]+to service_role/iu);
  assert.match(sql, /grant execute on function public\.mi_claim_naver_shopping_worker_wake\(\)[\s\S]+to service_role/iu);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

test("global worker lane makes Windows primary, Mac standby and access cooldown atomic", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260809203826_naver_shopping_global_worker_lane.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /create table if not exists public\.naver_shopping_worker_coordination/iu);
  assert.match(sql, /enable row level security/iu);
  assert.match(sql, /force row level security/iu);
  assert.match(sql, /revoke all on table public\.naver_shopping_worker_coordination[\s\S]+service_role/iu);
  assert.match(sql, /security invoker/iu);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.match(sql, /normalized_worker_role = 'standby'[\s\S]+primary_seen_at/iu);
  assert.match(sql, /lease_worker_id is distinct from normalized_worker_id/iu);
  assert.match(sql, /mi_touch_naver_shopping_worker_lane/iu);
  assert.match(sql, /mi_release_naver_shopping_worker_lane/iu);
  assert.match(sql, /mi_block_naver_shopping_worker_lane/iu);
  assert.match(sql, /naver_network_restricted'\) then 1800/iu);
  assert.match(sql, /'naver_verification_required'[\s\S]+then 3600/iu);
  assert.match(sql, /grant execute on function public\.mi_claim_naver_shopping_worker_lane[\s\S]+to service_role/iu);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

test("global worker lane timestamp repair avoids the PostgreSQL current_time keyword", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260810011000_fix_naver_shopping_worker_lane_timestamp.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /v_now timestamptz := clock_timestamp\(\)/iu);
  assert.doesNotMatch(sql, /\bcurrent_time\b/iu);
  assert.match(sql, /mi_claim_naver_shopping_worker_lane/iu);
  assert.match(sql, /mi_touch_naver_shopping_worker_lane/iu);
  assert.match(sql, /mi_block_naver_shopping_worker_lane/iu);
  assert.match(sql, /security invoker/iu);
  assert.doesNotMatch(sql, /security definer/iu);
});

test("collection lease migration keeps safe pacing below the atomic submit boundary", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260810093810_extend_naver_shopping_worker_collection_lease.sql",
    import.meta.url,
  ), "utf8");
  const laneSql = sql.slice(0, sql.indexOf("create or replace function public.mi_claim_naver_shopping_rank_lookup_job"));
  assert.match(laneSql, /p_lease_seconds integer default 2100/iu);
  assert.match(laneSql, /least\(2100, coalesce\(p_lease_seconds, 2100\)\)/iu);
  assert.match(laneSql, /security invoker/iu);
  assert.doesNotMatch(laneSql, /security definer/iu);
  assert.match(sql, /p_lease_seconds < 60 or p_lease_seconds > 2100/iu);
  assert.match(sql, /for update skip locked/iu);
  assert.match(sql, /grant execute on function public\.mi_claim_naver_shopping_rank_lookup_job\(integer\)[\s\S]+to service_role/iu);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

test("lookup claim lease precision survives the JavaScript millisecond round trip", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260811142000_fix_naver_shopping_lookup_lease_precision.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /v_lease_started_at timestamptz := date_trunc\('milliseconds', clock_timestamp\(\)\)/iu);
  assert.match(sql, /processing_started_at = v_lease_started_at/iu);
  assert.match(sql, /processing_until = v_lease_started_at \+ make_interval\(secs => p_lease_seconds\)/iu);
  assert.match(sql, /updated_at = v_lease_started_at/iu);
  assert.match(sql, /for update skip locked/iu);
  assert.match(sql, /v_job\.processing_started_at is distinct from p_lease_started_at[\s\S]+date_trunc\('milliseconds', v_job\.processing_started_at\)[\s\S]+date_trunc\('milliseconds', p_lease_started_at\)/iu);
  assert.match(sql, /processing_started_at = p_lease_started_at[\s\S]+or date_trunc\('milliseconds', processing_started_at\)[\s\S]+= date_trunc\('milliseconds', p_lease_started_at\)/iu);
  assert.match(sql, /select \* into v_job[\s\S]+for update/iu);
  assert.match(sql, /grant execute on function public\.mi_claim_naver_shopping_rank_lookup_job\(integer\)[\s\S]+to service_role/iu);
  assert.match(sql, /grant execute on function public\.mi_complete_naver_shopping_rank_lookup_job[\s\S]+to service_role/iu);
  assert.match(sql, /grant execute on function public\.mi_fail_naver_shopping_rank_lookup_job[\s\S]+to service_role/iu);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

test("worker control plane is service-role-only, atomic-300 gated and circuit bounded", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260811095137_naver_shopping_worker_control_plane.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /circuit_state in \('closed', 'open', 'half_open'\)/iu);
  assert.match(sql, /mi_report_naver_shopping_worker_progress/iu);
  assert.match(sql, /trim\(coalesce\(p_runtime_version, ''\)\) <> '1\.1\.0'/iu);
  assert.match(sql, /mi_record_naver_shopping_worker_success/iu);
  assert.match(sql, /p_collection_id[\s\S]+\^pw-chrome-/iu);
  assert.match(sql, /p_checked_count is distinct from 300/iu);
  assert.match(sql, /mi_record_naver_shopping_worker_failure/iu);
  assert.match(sql, /next_streak >= 2/iu);
  assert.match(sql, /worker_quarantined_until/iu);
  assert.match(sql, /normalized_scope = 'tracker'[\s\S]+cadence_mode = 'baseline'[\s\S]+cadence_minutes = 10/iu);
  assert.match(sql, /scheduler_urgent_streak >= 2/iu);
  assert.match(sql, /p_oldest_due_at[\s\S]+interval '30 minutes'/iu);
  assert.match(sql, /probe_incomplete/iu);
  assert.match(sql, /security invoker/iu);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.match(sql, /grant execute on function public\.mi_record_naver_shopping_worker_success[\s\S]+to service_role/iu);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

test("queue continuity gives new trackers the first slot and pins runtime 1.1.1", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260811113622_naver_shopping_queue_continuity.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /trim\(coalesce\(p_runtime_version, ''\)\) <> '1\.1\.1'/iu);
  assert.match(sql, /if coalesce\(p_has_new, false\) then\s*work_class := 'new'/iu);
  assert.match(sql, /scheduler_urgent_streak >= 2/iu);
  assert.match(sql, /p_oldest_due_at[\s\S]+interval '30 minutes'/iu);
  assert.match(sql, /scheduler_last_agency_code/iu);
  assert.match(sql, /current_row\.runtime_version = '1\.1\.1'/iu);
  assert.match(sql, /last_checked_count = 300/iu);
  assert.match(sql, /last_source = 'naver_shopping_results_collector'/iu);
  assert.match(sql, /security invoker/iu);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.match(sql, /revoke all on function public\.mi_report_naver_shopping_worker_progress[\s\S]+from public, anon, authenticated, service_role/iu);
  assert.match(sql, /grant execute on function public\.mi_choose_naver_shopping_worker_turn[\s\S]+to service_role/iu);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

test("runtime 1.1.2 is fail-closed and keeps the atomic 300 cadence gate", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260813070000_naver_shopping_runtime_1_1_2.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /trim\(coalesce\(p_runtime_version, ''\)\) <> '1\.1\.2'/iu);
  assert.match(sql, /current_row\.runtime_version = '1\.1\.2'/iu);
  assert.match(sql, /current_row\.last_checked_count = 300/iu);
  assert.match(sql, /current_row\.last_source = 'naver_shopping_results_collector'/iu);
  assert.match(sql, /security invoker/iu);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.match(sql, /revoke all on function public\.mi_report_naver_shopping_worker_progress[\s\S]+from public, anon, authenticated, service_role/iu);
  assert.match(sql, /grant execute on function public\.mi_set_naver_shopping_worker_cadence[\s\S]+to service_role/iu);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

test("runtime 1.1.4 independently gates bounded coherent boundary recovery", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260813084000_naver_shopping_runtime_1_1_4.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /trim\(coalesce\(p_runtime_version, ''\)\) <> '1\.1\.4'/iu);
  assert.match(sql, /current_row\.runtime_version = '1\.1\.4'/iu);
  assert.match(sql, /current_row\.last_checked_count = 300/iu);
  assert.match(sql, /current_row\.last_source = 'naver_shopping_results_collector'/iu);
  assert.match(sql, /security invoker/iu);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.match(sql, /revoke all on function public\.mi_report_naver_shopping_worker_progress[\s\S]+from public, anon, authenticated, service_role/iu);
  assert.match(sql, /grant execute on function public\.mi_set_naver_shopping_worker_cadence[\s\S]+to service_role/iu);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

test("runtime 1.1.6 independently gates worker hardening and tracker-isolated failures", () => {
  const sql = fs.readFileSync(new URL(
    "../../../supabase/migrations/20260814110000_naver_shopping_runtime_1_1_5.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /trim\(coalesce\(p_runtime_version, ''\)\) <> '1\.1\.5'/iu);
  assert.match(sql, /current_row\.runtime_version = '1\.1\.5'/iu);
  assert.match(sql, /current_row\.last_checked_count = 300/iu);
  assert.match(sql, /current_row\.last_source = 'naver_shopping_results_collector'/iu);
  assert.match(sql, /security invoker/iu);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.match(sql, /revoke all on function public\.mi_report_naver_shopping_worker_progress[\s\S]+from public, anon, authenticated, service_role/iu);
  assert.match(sql, /grant execute on function public\.mi_set_naver_shopping_worker_cadence[\s\S]+to service_role/iu);
  assert.doesNotMatch(sql, /grant[^;]+to (?:anon|authenticated)/iu);
});

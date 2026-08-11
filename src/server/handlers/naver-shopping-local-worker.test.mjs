import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { signLocalWorkerRequest } from "../local-worker-auth.mjs";
import { validateLocalWorkerJob } from "../naver-shopping/local-worker-contract.mjs";
import { handleLocalWorkerRequest } from "./naver-shopping-local-worker.mjs";

const SECRET = "test-local-worker-secret-that-is-longer-than-32-bytes";
const ENDPOINT = "https://insight.momentlabs.co.kr/api/naver-shopping-local-worker";
const TRACKER_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_TRACKER_ID = "123e4567-e89b-42d3-a456-426614174001";
const WORKER_ID = "test-primary-worker";
const LANE_TOKEN = "223e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "323e4567-e89b-42d3-a456-426614174000";
const RUNTIME_FINGERPRINT = "a".repeat(64);
const LANE_ACTIONS = new Set([
  "claim-wake",
  "claim",
  "queue-all-active-trackers",
  "submit",
  "fail",
]);

function signedRequest(payload) {
  let coordinatedPayload = LANE_ACTIONS.has(payload?.action)
    ? { ...payload, workerId: WORKER_ID, laneToken: LANE_TOKEN }
    : payload;
  if (payload?.action === "claim-lane" || LANE_ACTIONS.has(payload?.action)) {
    coordinatedPayload = {
      ...coordinatedPayload,
      runId: coordinatedPayload.runId || RUN_ID,
      runtimeVersion: coordinatedPayload.runtimeVersion || "1.1.0",
      runtimeFingerprint: coordinatedPayload.runtimeFingerprint || RUNTIME_FINGERPRINT,
    };
  }
  const body = JSON.stringify(coordinatedPayload);
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

function claimContext(rows, claimableIds, attemptedIds) {
  return {
    supabaseAdmin: {
      async rpc(name) {
        if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
        if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
        assert.equal(name, "mi_claim_naver_shopping_rank_lookup_job");
        return { data: [], error: null };
      },
      from(table) {
        assert.equal(table, "naver_rank_trackers");
        let trackerId = "";
        const query = {
          select() { return query; },
          update() { return query; },
          eq(column, value) {
            if (column === "id") trackerId = String(value);
            return query;
          },
          lte() { return query; },
          is() { return query; },
          not() { return query; },
          or() { return query; },
          order() { return query; },
          limit() { return query; },
          async maybeSingle() {
            attemptedIds.push(trackerId);
            return {
              data: claimableIds.has(trackerId) ? { id: trackerId } : null,
              error: null,
            };
          },
          then(resolve, reject) {
            return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
          },
        };
        return query;
      },
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
          assert.equal(args.p_runtime_version, "1.1.0");
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
      runtimeVersion: "1.1.0",
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
      runtimeVersion: "1.1.0",
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

test("claim keeps whitespace-distinct keywords in separate collection jobs", async () => {
  await withWorkerEnv(async () => {
    const attemptedIds = [];
    const rows = [
      { id: TRACKER_ID, keyword: "온열 찜질기" },
      { id: SECOND_TRACKER_ID, keyword: "온열찜질기" },
    ];
    const ctx = claimContext(rows, new Set([TRACKER_ID, SECOND_TRACKER_ID]), attemptedIds);
    const response = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "온열 찜질기");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [TRACKER_ID]);
    assert.deepEqual(attemptedIds, [TRACKER_ID]);
  });
});

test("claim continues to the next exact keyword group after lease contention", async () => {
  await withWorkerEnv(async () => {
    const attemptedIds = [];
    const rows = [
      { id: TRACKER_ID, keyword: "온열 찜질기" },
      { id: SECOND_TRACKER_ID, keyword: "온열찜질기" },
    ];
    const ctx = claimContext(rows, new Set([SECOND_TRACKER_ID]), attemptedIds);
    const response = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "온열찜질기");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [SECOND_TRACKER_ID]);
    assert.deepEqual(attemptedIds, [TRACKER_ID, SECOND_TRACKER_ID]);
  });
});

test("claim prioritizes a newly registered keyword before the existing due sequence", async () => {
  await withWorkerEnv(async () => {
    const candidateModes = [];
    const newTracker = {
      ...tracker({
        id: TRACKER_ID,
        keyword: "신규 키워드",
        last_checked_at: null,
        created_at: "2026-08-08T00:00:00.000Z",
      }),
    };
    const existingTracker = {
      ...tracker({
        id: SECOND_TRACKER_ID,
        keyword: "기존 키워드",
        last_checked_at: "2026-08-07T00:00:00.000Z",
        created_at: "2026-08-01T00:00:00.000Z",
      }),
    };
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          assert.equal(name, "mi_claim_naver_shopping_rank_lookup_job");
          return { data: [], error: null };
        },
        from(table) {
          assert.equal(table, "naver_rank_trackers");
          let mode = "";
          let isUpdate = false;
          let trackerId = "";
          const query = {
            select() { return query; },
            update() { isUpdate = true; return query; },
            eq(column, value) {
              if (column === "id") trackerId = String(value);
              return query;
            },
            lte() { return query; },
            or() { return query; },
            is(column) {
              if (column === "last_checked_at") mode = "new";
              return query;
            },
            not(column) {
              if (column === "last_checked_at") mode = "existing";
              return query;
            },
            order() { return query; },
            limit() { return query; },
            async maybeSingle() {
              return { data: { id: trackerId }, error: null };
            },
            then(resolve, reject) {
              if (!isUpdate) candidateModes.push(mode);
              const rows = mode === "new" ? [newTracker] : [existingTracker];
              return Promise.resolve({ data: isUpdate ? null : rows, error: null }).then(resolve, reject);
            },
          };
          return query;
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "신규 키워드");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [TRACKER_ID]);
    assert.deepEqual(candidateModes, ["new"]);
  });
});

test("claim returns to oldest due trackers when no uninitialized keyword remains", async () => {
  await withWorkerEnv(async () => {
    const candidateModes = [];
    const existingTracker = tracker({
      id: SECOND_TRACKER_ID,
      keyword: "기존 키워드",
      last_checked_at: "2026-08-07T00:00:00.000Z",
      created_at: "2026-08-01T00:00:00.000Z",
    });
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          assert.equal(name, "mi_claim_naver_shopping_rank_lookup_job");
          return { data: [], error: null };
        },
        from(table) {
          assert.equal(table, "naver_rank_trackers");
          let mode = "";
          let isUpdate = false;
          let trackerId = "";
          const query = {
            select() { return query; },
            update() { isUpdate = true; return query; },
            eq(column, value) {
              if (column === "id") trackerId = String(value);
              return query;
            },
            lte() { return query; },
            or() { return query; },
            is(column) {
              if (column === "last_checked_at") mode = "new";
              return query;
            },
            not(column) {
              if (column === "last_checked_at") mode = "existing";
              return query;
            },
            order() { return query; },
            limit() { return query; },
            async maybeSingle() {
              return { data: { id: trackerId }, error: null };
            },
            then(resolve, reject) {
              if (!isUpdate) candidateModes.push(mode);
              const rows = mode === "new" ? [] : [existingTracker];
              return Promise.resolve({ data: isUpdate ? null : rows, error: null }).then(resolve, reject);
            },
          };
          return query;
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "기존 키워드");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [SECOND_TRACKER_ID]);
    assert.deepEqual(candidateModes, ["new", "existing"]);
  });
});

test("fair scheduler forces an aged due advertiser after at most two urgent turns", async () => {
  await withWorkerEnv(async () => {
    const newTracker = tracker({
      id: TRACKER_ID,
      agency_code: "agency-a",
      keyword: "신규 키워드",
      last_checked_at: null,
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      next_check_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const dueTracker = tracker({
      id: SECOND_TRACKER_ID,
      agency_code: "agency-b",
      keyword: "기존 키워드",
      last_checked_at: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
      next_check_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    let schedulerArgs = null;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          assert.equal(name, "mi_choose_naver_shopping_worker_turn");
          schedulerArgs = args;
          return { data: { workClass: "due", agencyCode: "agency-b", urgentStreak: 2 }, error: null };
        },
        from(table) {
          let mode = "";
          let isUpdate = false;
          let trackerId = "";
          const query = {
            select() { return query; },
            update() { isUpdate = true; return query; },
            eq(column, value) {
              if (column === "id") trackerId = String(value);
              return query;
            },
            gt() { return query; },
            lt() { return query; },
            lte() { return query; },
            or() { return query; },
            is(column) { if (column === "last_checked_at") mode = "new"; return query; },
            not(column) { if (column === "last_checked_at") mode = "due"; return query; },
            order() { return query; },
            limit() { return query; },
            async maybeSingle() {
              assert.equal(isUpdate, true);
              return { data: { id: trackerId }, error: null };
            },
            then(resolve, reject) {
              let data;
              if (table === "naver_shopping_rank_lookup_jobs") data = [{ id: TRACKER_ID }];
              else if (isUpdate) data = null;
              else data = mode === "new" ? [newTracker] : [dueTracker];
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            },
          };
          return query;
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({
      action: "claim",
      schedulerVersion: "v1",
    }), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.job.keyword, "기존 키워드");
    assert.deepEqual(body.job.claims.map((claim) => claim.trackerId), [SECOND_TRACKER_ID]);
    assert.equal(schedulerArgs.p_has_lookup, true);
    assert.equal(schedulerArgs.p_has_new, true);
    assert.equal(schedulerArgs.p_has_due, true);
    assert.deepEqual(schedulerArgs.p_due_agencies, ["agency-b"]);
    assert.equal(schedulerArgs.p_oldest_due_at, dueTracker.next_check_at);
  });
});

test("central collector stays global while using agency only for fair queue ordering", () => {
  const source = fs.readFileSync(new URL("./naver-shopping-local-worker.mjs", import.meta.url), "utf8");
  const claimStart = source.indexOf("async function claimOneKeywordJob");
  const claimEnd = source.indexOf("async function loadClaimTrackers");
  const claimSource = source.slice(claimStart, claimEnd);
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  assert.match(claimSource, /\.eq\("status", "active"\)/u);
  assert.match(claimSource, /\.lte\("next_check_at", nowIso\)/u);
  assert.match(claimSource, /worker_quarantined_until/u);
  assert.doesNotMatch(claimSource, /admin_code|client_id|user_code/iu);
  const fairStart = source.indexOf("async function claimFairJob");
  const fairSource = source.slice(source.indexOf("async function chooseFairWorkerTurn"), claimStart);
  assert.ok(fairStart >= 0);
  assert.match(fairSource, /mi_choose_naver_shopping_worker_turn/u);
  assert.match(fairSource, /agency_code/u);
  assert.match(fairSource, /if \(turn\.workClass === "none"\) return null/u);
});

test("signed manual queue registers every active tracker without exposing account scopes", async () => {
  await withWorkerEnv(async () => {
    const operations = [];
    let updateCount = 0;
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          assert.equal(name, "mi_touch_naver_shopping_worker_lane");
          return { data: true, error: null };
        },
        from(table) {
          assert.equal(table, "naver_rank_trackers");
          let mode = "count";
          const operation = { table, filters: [], update: null, selection: null };
          operations.push(operation);
          const query = {
            select(columns, options) {
              operation.selection = { columns, options };
              return query;
            },
            update(values) {
              mode = "update";
              operation.update = values;
              return query;
            },
            eq(column, value) {
              operation.filters.push(["eq", column, value]);
              return query;
            },
            or(value) {
              operation.filters.push(["or", value]);
              return query;
            },
            gt(column, value) {
              operation.filters.push(["gt", column, value]);
              return query;
            },
            lte(column, value) {
              operation.filters.push(["lte", column, value]);
              return query;
            },
            then(resolve, reject) {
              let result;
              if (mode === "update") {
                updateCount += 1;
                const data = updateCount === 1 ? [{ id: TRACKER_ID }, { id: SECOND_TRACKER_ID }] : [];
                result = { data, count: data.length, error: null };
              } else {
                const isWaitingCount = operation.filters.some((filter) => filter[0] === "lte");
                result = { data: null, count: isWaitingCount ? 2 : 3, error: null };
              }
              return Promise.resolve(result).then(resolve, reject);
            },
          };
          return query;
        },
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
    assert.equal(operations.length, 6);
    assert.deepEqual(operations[0].filters, [["eq", "status", "active"]]);
    assert.deepEqual(operations[1].filters[0], ["eq", "status", "active"]);
    assert.deepEqual(operations[1].filters[1].slice(0, 2), ["gt", "next_check_at"]);
    assert.match(operations[1].filters[2][1], /processing_until\.is\.null,processing_until\.lt\./u);
    assert.deepEqual(operations[2].filters[1].slice(0, 2), ["lte", "next_check_at"]);
    assert.equal(typeof operations[1].update.next_check_at, "string");
    assert.equal(operations[1].update.last_message, "전체 순위 갱신 대기 중입니다.");
    assert.equal(JSON.stringify(operations).includes("agency_code"), false);
    assert.equal(Object.hasOwn(body, "trackerIds"), false);
    assert.equal(Object.hasOwn(repeatedBody, "trackerIds"), false);
  });
});

test("claims an interactive lookup before periodic trackers and atomically stores its 300 result", async () => {
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
    const claimResponse = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), claimCtx);
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
    const claimResponse = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), claimCtx);
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

test("claim releases leases acquired before a later conditional update fails", async () => {
  await withWorkerEnv(async () => {
    const rows = [tracker(), tracker({ id: SECOND_TRACKER_ID })];
    const released = [];
    let claimedUpdates = 0;
    const ctx = {
      supabaseAdmin: {
        async rpc(name, args) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          if (name === "mi_touch_naver_shopping_worker_lane") return { data: true, error: null };
          if (name === "mi_claim_naver_shopping_rank_lookup_job") return { data: [], error: null };
          assert.equal(name, "mi_fail_naver_shopping_worker_claim");
          released.push(args.p_tracker_id);
          return { data: true, error: null };
        },
        from(table) {
          assert.equal(table, "naver_rank_trackers");
          let isUpdate = false;
          const query = {
            select() { return query; },
            update() { isUpdate = true; return query; },
            eq() { return query; },
            lte() { return query; },
            is() { return query; },
            not() { return query; },
            or() { return query; },
            order() { return query; },
            limit() { return query; },
            async maybeSingle() {
              claimedUpdates += 1;
              if (claimedUpdates === 1) return { data: { id: TRACKER_ID }, error: null };
              return { data: null, error: { message: "claim_write_failed" } };
            },
            then(resolve, reject) {
              return Promise.resolve(isUpdate ? { data: null, error: null } : { data: rows, error: null })
                .then(resolve, reject);
            },
          };
          return query;
        },
      },
    };
    const response = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), ctx);
    assert.equal(response.status, 500);
    assert.deepEqual(released, [TRACKER_ID]);
  });
});

test("submits one strict 300 window through the shared matcher and atomic RPC", async () => {
  await withWorkerEnv(async () => {
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
    const response = await handleLocalWorkerRequest(signedRequest({ action: "submit", job, window }), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.committedCount, 1);
    assert.equal(commitArgs.p_collection_id, window.collectionId);
    assert.equal(commitArgs.p_snapshot.checked_count, 300);
    assert.equal(commitArgs.p_snapshot.matched, true);
    assert.equal(commitArgs.p_snapshot.rank, 11);
    assert.equal(commitArgs.p_snapshot.item.rankPolicy, "organic_only");
    assert.equal(commitArgs.p_snapshot.item.adExcluded, true);
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

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { signLocalWorkerRequest } from "../local-worker-auth.mjs";
import { handleLocalWorkerRequest } from "./naver-shopping-local-worker.mjs";

const SECRET = "test-local-worker-secret-that-is-longer-than-32-bytes";
const ENDPOINT = "https://insight.momentlabs.co.kr/api/naver-shopping-local-worker";
const TRACKER_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_TRACKER_ID = "123e4567-e89b-42d3-a456-426614174001";

function signedRequest(payload) {
  const body = JSON.stringify(payload);
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

function resolvingQuery(result) {
  const query = {
    select() { return query; },
    eq() { return query; },
    in() { return query; },
    gte() { return query; },
    lte() { return query; },
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

test("central collector claims all due trackers without an owner, team or client scope", () => {
  const source = fs.readFileSync(new URL("./naver-shopping-local-worker.mjs", import.meta.url), "utf8");
  const claimStart = source.indexOf("async function claimOneKeywordJob");
  const claimEnd = source.indexOf("async function loadClaimTrackers");
  const claimSource = source.slice(claimStart, claimEnd);
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  assert.match(claimSource, /\.eq\("status", "active"\)/u);
  assert.match(claimSource, /\.lte\("next_check_at", nowIso\)/u);
  assert.doesNotMatch(claimSource, /agency_code|admin_code|client_id|user_code/iu);
});

test("signed manual queue registers every active tracker without exposing account scopes", async () => {
  await withWorkerEnv(async () => {
    const operations = [];
    const ctx = {
      supabaseAdmin: {
        async rpc(name) {
          assert.equal(name, "mi_consume_naver_shopping_worker_nonce");
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
            then(resolve, reject) {
              const result = mode === "update"
                ? { data: [{ id: TRACKER_ID }, { id: SECOND_TRACKER_ID }], count: 2, error: null }
                : { data: null, count: 3, error: null };
              return Promise.resolve(result).then(resolve, reject);
            },
          };
          return query;
        },
      },
    };

    const response = await handleLocalWorkerRequest(
      signedRequest({ action: "queue-all-active-trackers" }),
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual({
      total: body.total,
      queued: body.queued,
      alreadyProcessing: body.alreadyProcessing,
    }, { total: 3, queued: 2, alreadyProcessing: 1 });
    assert.equal(operations.length, 2);
    assert.deepEqual(operations[0].filters, [["eq", "status", "active"]]);
    assert.deepEqual(operations[1].filters[0], ["eq", "status", "active"]);
    assert.match(operations[1].filters[1][1], /processing_until\.is\.null,processing_until\.lt\./u);
    assert.equal(typeof operations[1].update.next_check_at, "string");
    assert.equal(operations[1].update.last_message, "전체 순위 갱신 대기 중입니다.");
    assert.equal(JSON.stringify(operations).includes("agency_code"), false);
    assert.equal(Object.hasOwn(body, "trackerIds"), false);
  });
});

test("claims an interactive lookup before periodic trackers and atomically stores its 300 result", async () => {
  await withWorkerEnv(async () => {
    const leaseStartedAt = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 12 * 60_000).toISOString();
    const lookupJob = {
      kind: "lookup",
      keyword: "온열찜질기",
      limit: 300,
      claims: [{ lookupJobId: TRACKER_ID, leaseStartedAt, leaseUntil }],
    };
    const claimCtx = {
      supabaseAdmin: {
        async rpc(name) {
          if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
          assert.equal(name, "mi_claim_naver_shopping_rank_lookup_job");
          return {
            data: [{ id: TRACKER_ID, keyword: "온열찜질기", lease_started_at: leaseStartedAt, lease_until: leaseUntil }],
            error: null,
          };
        },
        from() { throw new Error("periodic_tracker_should_not_be_claimed"); },
      },
    };
    const claimResponse = await handleLocalWorkerRequest(signedRequest({ action: "claim" }), claimCtx);
    assert.equal(claimResponse.status, 200);
    assert.deepEqual((await claimResponse.json()).job, lookupJob);

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
                  processing_started_at: leaseStartedAt,
                  processing_until: leaseUntil,
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
    assert.equal(completeArgs.p_result.result.rank, 11);
    assert.equal(completeArgs.p_result.result.checkedCount, 300);
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

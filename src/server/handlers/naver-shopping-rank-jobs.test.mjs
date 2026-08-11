import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  handleShoppingRankJobsRequest,
  rankLookupScopeHash,
} from "./naver-shopping-rank-jobs.mjs";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const lookupGrantMigration = fs.readFileSync(new URL(
  "../../../supabase/migrations/20260802164548_harden_naver_shopping_rank_lookup_jobs_grants.sql",
  import.meta.url,
), "utf8");

test("keeps the lookup queue private while granting only required service operations", () => {
  assert.match(lookupGrantMigration, /revoke all on table public\.naver_shopping_rank_lookup_jobs from service_role;/u);
  assert.match(lookupGrantMigration, /grant select, insert, update, delete on table public\.naver_shopping_rank_lookup_jobs to service_role;/u);
  assert.doesNotMatch(lookupGrantMigration, /grant .*\b(?:references|trigger|truncate)\b.* to service_role/iu);
});

function sessionRequest(path = "", options = {}, agencyCode = "agency-a01") {
  const headers = new Headers(options.headers || {});
  headers.set("x-mi-session-role", "client");
  headers.set("x-mi-session-scope", "advertiser");
  headers.set("x-mi-agency-code", agencyCode);
  return new Request(`https://insight.momentlabs.co.kr/api/naver-shopping-rank-jobs${path}`, {
    ...options,
    headers,
  });
}

test("derives a one-way lookup scope only from trusted session headers", () => {
  const first = rankLookupScopeHash(sessionRequest("", {}, "agency-a01"));
  const second = rankLookupScopeHash(sessionRequest("", {}, "agency-b02"));
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.notEqual(first, second);
  assert.equal(rankLookupScopeHash(new Request("https://example.test/api/naver-shopping-rank-jobs")), "");
});

test("enqueues one exact 300 lookup without storing a raw account code", async () => {
  let rpcArgs = null;
  let wakeArgs = null;
  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        if (name === "mi_enqueue_naver_shopping_rank_lookup_job") {
          rpcArgs = args;
          return {
            data: { id: JOB_ID, status: "pending", deduplicated: false, expiresAt: "2026-08-03T01:30:00.000Z" },
            error: null,
          };
        }
        assert.equal(name, "mi_request_naver_shopping_worker_wake");
        wakeArgs = args;
        return { data: true, error: null };
      },
    },
  };
  const response = await handleShoppingRankJobsRequest(sessionRequest("", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      keyword: "온열찜질기",
      targetUrl: "https://smartstore.naver.com/example/products/12149720593",
      maxRank: 1000,
    }),
  }), ctx);
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.jobId, JOB_ID);
  assert.equal(payload.pending, true);
  assert.equal(payload.remoteWakeRequested, true);
  assert.equal(rpcArgs.p_product_id, "12149720593");
  assert.match(rpcArgs.p_scope_hash, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(rpcArgs), /agency-a01/u);
  assert.deepEqual(wakeArgs, { p_source: "rank-lookup" });
});

test("poll returns a completed result only inside the same hashed scope", async () => {
  const filters = [];
  const query = {
    select() { return query; },
    eq(column, value) { filters.push([column, value]); return query; },
    async maybeSingle() {
      return {
        data: {
          id: JOB_ID,
          status: "completed",
          checked_at: "2026-08-03T01:20:00.000Z",
          result: {
            source: "naver_shopping_results_collector",
            query: { keyword: "온열찜질기", maxRank: 300 },
            result: { matched: true, rank: 11, checkedCount: 300, complete: true },
            message: "입력 상품의 네이버쇼핑 오가닉 순위는 11위입니다.",
          },
          message: null,
          error_code: null,
          expires_at: "2026-08-03T01:30:00.000Z",
        },
        error: null,
      };
    },
  };
  const ctx = { supabaseAdmin: { from(table) { assert.equal(table, "naver_shopping_rank_lookup_jobs"); return query; } } };
  const request = sessionRequest(`?jobId=${JOB_ID}`);
  const expectedScope = rankLookupScopeHash(request);
  const response = await handleShoppingRankJobsRequest(request, ctx);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.result.rank, 11);
  assert.equal(payload.result.checkedCount, 300);
  assert.deepEqual(filters, [["id", JOB_ID], ["scope_hash", expectedScope]]);
});

test("rejects a job request without a verified session scope before database access", async () => {
  const response = await handleShoppingRankJobsRequest(new Request(
    `https://insight.momentlabs.co.kr/api/naver-shopping-rank-jobs?jobId=${JOB_ID}`,
  ), { supabaseAdmin: { from() { throw new Error("unexpected_db_access"); } } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "RANK_LOOKUP_SCOPE_REQUIRED");
});

function pollingContext(data, selectedColumns = []) {
  const query = {
    select(columns) { selectedColumns.push(columns); return query; },
    eq() { return query; },
    async maybeSingle() { return { data, error: null }; },
  };
  return {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, "naver_shopping_rank_lookup_jobs");
        return query;
      },
    },
  };
}

test("poll terminates a pending job after its expiry instead of polling forever", async () => {
  const selectedColumns = [];
  const response = await handleShoppingRankJobsRequest(sessionRequest(`?jobId=${JOB_ID}`), pollingContext({
    id: JOB_ID,
    status: "pending",
    result: null,
    expires_at: "2000-01-01T00:00:00.000Z",
    processing_until: null,
  }, selectedColumns));
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.pending, false);
  assert.equal(payload.status, "expired");
  assert.equal(payload.code, "RANK_LOOKUP_EXPIRED");
  assert.match(selectedColumns[0], /processing_until/u);
});

test("poll terminates a processing job after its worker lease instead of polling forever", async () => {
  const response = await handleShoppingRankJobsRequest(sessionRequest(`?jobId=${JOB_ID}`), pollingContext({
    id: JOB_ID,
    status: "processing",
    result: null,
    expires_at: "2099-01-01T00:00:00.000Z",
    processing_until: "2000-01-01T00:00:00.000Z",
  }));
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.pending, false);
  assert.equal(payload.status, "failed");
  assert.equal(payload.code, "RANK_LOOKUP_WORKER_STALLED");
});

test("poll keeps an active processing lease pending", async () => {
  const response = await handleShoppingRankJobsRequest(sessionRequest(`?jobId=${JOB_ID}`), pollingContext({
    id: JOB_ID,
    status: "processing",
    result: null,
    expires_at: "2099-01-01T00:00:00.000Z",
    processing_until: "2099-01-01T00:00:00.000Z",
  }));
  const payload = await response.json();

  assert.equal(response.status, 202);
  assert.equal(payload.pending, true);
  assert.equal(payload.status, "processing");
});

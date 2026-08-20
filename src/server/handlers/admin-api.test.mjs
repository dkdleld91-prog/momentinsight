import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAdminApiRequest,
  resourceHardDeleteBlocked,
} from "./admin-api.mjs";

function queryRecorder(results = {}) {
  const calls = [];
  const supabaseAdmin = {
    from(table) {
      calls.push([table, "from"]);
      const builder = {
        select(value) { calls.push([table, "select", value]); return builder; },
        insert(value) { calls.push([table, "insert", value]); return builder; },
        update(value) { calls.push([table, "update", value]); return builder; },
        delete() { calls.push([table, "delete"]); return builder; },
        eq(column, value) { calls.push([table, "eq", column, value]); return builder; },
        is(column, value) { calls.push([table, "is", column, value]); return builder; },
        order(column, options) { calls.push([table, "order", column, options]); return builder; },
        limit(value) { calls.push([table, "limit", value]); return builder; },
        maybeSingle() { calls.push([table, "maybeSingle"]); return Promise.resolve(results[table] || { data: null, error: null }); },
        then(resolve, reject) { return Promise.resolve(results[table] || { data: [], error: null }).then(resolve, reject); },
      };
      return builder;
    },
  };
  return { calls, ctx: { supabaseAdmin } };
}

function adminRequest(method, path, body) {
  return new Request(`https://insight.momentlabs.co.kr${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("generic admin API blocks hard deletion of client and rank history records", () => {
  assert.equal(resourceHardDeleteBlocked("clients"), true);
  assert.equal(resourceHardDeleteBlocked("naver-rank-trackers"), true);
  assert.equal(resourceHardDeleteBlocked("naver-rank-snapshots"), true);
});

test("ordinary mutable admin resources keep their existing delete behavior", () => {
  assert.equal(resourceHardDeleteBlocked("reports"), false);
  assert.equal(resourceHardDeleteBlocked("schedule-items"), false);
});

test("admin schedule list and overview scope every schedule_items read to personal rows", async () => {
  const list = queryRecorder();
  await handleAdminApiRequest(adminRequest("GET", "/api/admin/schedule-items"), list.ctx);
  assert.equal(list.calls.some(([table, method, column, value]) => (
    table === "schedule_items" && method === "is" && column === "calendar_id" && value === null
  )), true);

  const overview = queryRecorder({ clients: { data: { id: "client-1" }, error: null } });
  await handleAdminApiRequest(adminRequest("GET", "/api/admin/overview?client_id=client-1"), overview.ctx);
  assert.equal(overview.calls.some(([table, method, column, value]) => (
    table === "schedule_items" && method === "is" && column === "calendar_id" && value === null
  )), true);
});

test("admin schedule create rejects non-personal calendar keys before database access", async (t) => {
  for (const body of [
    { title: "공유 일정 우회", calendarId: "34343434-3434-4434-8434-343434343434" },
    { title: "공유 일정 우회", calendar_id: "34343434-3434-4434-8434-343434343434" },
  ]) {
    await t.test(Object.hasOwn(body, "calendarId") ? "calendarId" : "calendar_id", async () => {
      const harness = queryRecorder();
      const response = await handleAdminApiRequest(adminRequest("POST", "/api/admin/schedule-items", body), harness.ctx);
      assert.equal(response.status >= 400 && response.status < 500, true);
      assert.deepEqual(harness.calls, []);
    });
  }
});

test("admin schedule PATCH and DELETE include the final personal-row predicate", async (t) => {
  for (const method of ["PATCH", "DELETE"]) {
    await t.test(method, async () => {
      const harness = queryRecorder();
      const expectedOperation = method === "PATCH" ? "update" : "delete";
      await handleAdminApiRequest(adminRequest(
        method,
        "/api/admin/schedule-items/34343434-3434-4434-8434-343434343434",
        method === "PATCH" ? { title: "개인 일정만 수정" } : undefined,
      ), harness.ctx);
      assert.equal(harness.calls.some(([table, operation]) => table === "schedule_items" && operation === expectedOperation), true);
      assert.equal(harness.calls.some(([table, operation, column, value]) => (
        table === "schedule_items" && operation === "is" && column === "calendar_id" && value === null
      )), true);
    });
  }
});

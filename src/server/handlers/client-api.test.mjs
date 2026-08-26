import assert from "node:assert/strict";
import test from "node:test";
import {
  clientScheduleSelectFields,
  clientSelfConnectEnabled,
  handleClientApiRequest,
  handleClientPublicStateRequest,
  handleAgencyCode
} from "./client-api.mjs";

const ACTIVE_CLIENT = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "연결 광고주",
  business_name: null,
  agency_code: "mml93-a01",
  status: "active",
  disconnected_at: null
};

// 서버 응답이 없는 값은 화면에서 빈 상태 문구가 되어야 하므로, 픽스처에서도
// 없는 값은 만들지 않는다. 여기서 숫자를 채우면 테스트가 거짓을 통과시킨다.
function adminRecorder(results = {}) {
  const calls = [];
  const writes = [];
  const supabaseAdmin = {
    from(table) {
      calls.push([table, "from"]);
      const node = {
        mode: "list",
        select(value) { calls.push([table, "select", value]); return node; },
        eq(column, value) { calls.push([table, "eq", column, value]); return node; },
        is(column, value) { calls.push([table, "is", column, value]); return node; },
        order(column, options) { calls.push([table, "order", column, options]); return node; },
        limit(value) { calls.push([table, "limit", value]); return node; },
        update(body) { writes.push([table, "update", body]); node.mode = "write"; return node; },
        insert(body) { writes.push([table, "insert", body]); node.mode = "write"; return node; },
        upsert(body) { writes.push([table, "upsert", body]); node.mode = "write"; return node; },
        delete() { writes.push([table, "delete"]); node.mode = "write"; return node; },
        maybeSingle() {
          const key = node.mode === "write" ? `${table}:write` : `${table}:single`;
          return Promise.resolve(results[key] || { data: null, error: null });
        },
        then(resolve, reject) {
          return Promise.resolve(results[table] || { data: [], error: null }).then(resolve, reject);
        }
      };
      return node;
    }
  };
  return { calls, writes, ctx: { supabaseAdmin } };
}

function sessionRequest(path, { role = "client", agencyCode = "mml93-a01", method = "GET", body, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (role) requestHeaders.set("x-mi-session-role", role);
  if (agencyCode) requestHeaders.set("x-mi-agency-code", agencyCode);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  return new Request(`https://insight.momentlabs.co.kr${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function queryRecorder(results = {}) {
  const calls = [];
  const supabase = {
    from(table) {
      calls.push([table, "from"]);
      const builder = {
        select(value) { calls.push([table, "select", value]); return builder; },
        eq(column, value) { calls.push([table, "eq", column, value]); return builder; },
        is(column, value) { calls.push([table, "is", column, value]); return builder; },
        order(column, options) { calls.push([table, "order", column, options]); return builder; },
        limit(value) { calls.push([table, "limit", value]); return builder; },
        then(resolve, reject) { return Promise.resolve(results[table] || { data: [], error: null }).then(resolve, reject); },
      };
      return builder;
    },
  };
  return {
    calls,
    ctx: {
      supabase,
      userClaims: { sub: "00000000-0000-4000-8000-000000000001", email: "client@example.com" },
    },
  };
}

function clientRequest(path) {
  return new Request(`https://insight.momentlabs.co.kr${path}`);
}

test("client schedule selects only the public title and public fields", () => {
  const fields = clientScheduleSelectFields();
  assert.match(fields, /title:public_title/u);
  assert.doesNotMatch(fields, /(?:^|,)\s*title\s*(?:,|$)/u);
  assert.doesNotMatch(fields, /internal_note|owner_agency_code|operation_team_id/u);
});

test("client schedule list and overview scope every schedule_items read to personal rows", async () => {
  const list = queryRecorder();
  await handleClientApiRequest(clientRequest("/api/client/schedule-items"), list.ctx);
  assert.equal(list.calls.some(([table, method, column, value]) => (
    table === "schedule_items" && method === "is" && column === "calendar_id" && value === null
  )), true);

  const overview = queryRecorder();
  await handleClientApiRequest(clientRequest("/api/client/overview?client_id=client-1"), overview.ctx);
  assert.equal(overview.calls.some(([table, method, column, value]) => (
    table === "schedule_items" && method === "is" && column === "calendar_id" && value === null
  )), true);
});

test("client self-connect is enabled only by the exact true flag", () => {
  assert.equal(clientSelfConnectEnabled({}), false);
  assert.equal(clientSelfConnectEnabled({ MI_CLIENT_SELF_CONNECT_ENABLED: "false" }), false);
  assert.equal(clientSelfConnectEnabled({ MI_CLIENT_SELF_CONNECT_ENABLED: "TRUE" }), false);
  assert.equal(clientSelfConnectEnabled({ MI_CLIENT_SELF_CONNECT_ENABLED: "true" }), true);
});

test("agency-code connect is denied before database access when disabled", async (t) => {
  const previousFlag = process.env.MI_CLIENT_SELF_CONNECT_ENABLED;
  delete process.env.MI_CLIENT_SELF_CONNECT_ENABLED;
  t.after(() => {
    if (previousFlag === undefined) {
      delete process.env.MI_CLIENT_SELF_CONNECT_ENABLED;
    } else {
      process.env.MI_CLIENT_SELF_CONNECT_ENABLED = previousFlag;
    }
  });

  let databaseTouched = false;
  const ctx = {
    userClaims: {
      sub: "00000000-0000-0000-0000-000000000001",
      email: "client@example.com"
    },
    supabaseAdmin: new Proxy({}, {
      get() {
        databaseTouched = true;
        throw new Error("database must not be accessed while self-connect is disabled");
      }
    })
  };
  const request = new Request("https://example.com/api/client/agency-code/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agencyCode: "mml93-a02" })
  });

  const response = await handleAgencyCode(request, ctx);

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "CLIENT_SELF_CONNECT_DISABLED",
    message: "광고주 셀프 연결 기능이 비활성화되어 있습니다. 운영팀에 연결을 요청해주세요."
  });
  assert.equal(databaseTouched, false);
});

test("public-state refuses any request that carries an external Supabase credential", async () => {
  const recorder = adminRecorder();
  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", { headers: { apikey: "sb-secret" } }),
    recorder.ctx
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "SESSION_REQUIRED");
  assert.equal(recorder.calls.length, 0);
});

test("public-state refuses a request without a gate-issued session role", async () => {
  const recorder = adminRecorder();
  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", { role: "" }),
    recorder.ctx
  );
  assert.equal(response.status, 401);
  assert.equal(recorder.calls.length, 0);
});

test("public-state refuses a session with no connected advertiser", async () => {
  const recorder = adminRecorder();
  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", { role: "team", agencyCode: "" }),
    recorder.ctx
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "CLIENT_SCOPE_REQUIRED");
  assert.equal(recorder.calls.length, 0);
});

test("public-state returns empty-state nulls instead of invented numbers when the server has no rows", async () => {
  const recorder = adminRecorder({ "clients:single": { data: ACTIVE_CLIENT, error: null } });
  const response = await handleClientPublicStateRequest(sessionRequest("/api/client/public-state"), recorder.ctx);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.ok, true);
  assert.equal(payload.metrics.available, false);
  assert.equal(payload.metrics.period, null);
  for (const field of ["sales", "roas", "adSpend", "orders", "achievement", "status", "nextSchedule", "updatedAt", "comment"]) {
    assert.equal(payload.publicState[field], null, `${field} must stay null when the server has no value`);
  }
  for (const field of ["reports", "actions", "schedules", "channelDetails", "keywords"]) {
    assert.deepEqual(payload.publicState[field], [], `${field} must be an empty list`);
  }
  assert.equal(payload.publicState.client, "연결 광고주");
  assert.equal(payload.publicState.code, "MML93-A01");
});

test("public-state renders every metric from the server row for a client that has published data", async () => {
  const recorder = adminRecorder({
    "clients:single": { data: ACTIVE_CLIENT, error: null },
    dashboard_snapshots: {
      data: [{
        period: "2026-08-01",
        sales: 18600000,
        ad_spend: 3200000,
        roas: 581.25,
        orders: 642,
        achievement_rate: 116,
        public_comment: "검색 매출 흐름 양호",
        updated_at: "2026-08-19T02:00:00.000Z"
      }],
      error: null
    },
    schedule_items: {
      data: [{ title: "소재 교체", starts_at: "2026-08-21T01:00:00.000Z", status: "in_progress", public_comment: "피로도 반영", schedule_type: "operation" }],
      error: null
    },
    ad_performance: {
      data: [{ revenue: 18600000, ad_spend: 3200000, roas: 581.25, orders: 642, ctr: 3.8, cvr: 4.9, cpa: 3365, cpc: 165, public_comment: null, channel: { code: "naver", name: "네이버" } }],
      error: null
    },
    reports: { data: [{ title: "8월 월간 보고서", report_type: "monthly", report_date: "2026-08-31", summary: "월간 합산", public_comment: null }], error: null },
    action_plans: { data: [], error: null },
    keywords: { data: [], error: null }
  });

  const payload = await (await handleClientPublicStateRequest(sessionRequest("/api/client/public-state"), recorder.ctx)).json();

  assert.equal(payload.metrics.available, true);
  assert.equal(payload.metrics.period, "2026-08-01");
  assert.equal(payload.publicState.sales, "1,860만원");
  assert.equal(payload.publicState.adSpend, "320만원");
  assert.equal(payload.publicState.roas, "581.3%");
  assert.equal(payload.publicState.orders, "642건");
  assert.equal(payload.publicState.achievement, "116%");
  assert.equal(payload.publicState.status, "목표 초과");
  assert.equal(payload.publicState.updatedAt, "2026.08.19");
  assert.equal(payload.publicState.comment, "검색 매출 흐름 양호");
  assert.match(payload.publicState.nextSchedule, /소재 교체$/u);
  assert.equal(payload.publicState.reports.length, 1);
  assert.equal(payload.publicState.channelDetails[0].name, "네이버");
  assert.equal(payload.publicState.channelDetails[0].summary, null);
});

test("public-state scopes every read to the session client and never to a query parameter", async () => {
  const recorder = adminRecorder({ "clients:single": { data: ACTIVE_CLIENT, error: null } });
  await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state?client_id=bbbbbbbb-0000-4000-8000-000000000002"),
    recorder.ctx
  );

  const clientLookup = recorder.calls.filter(([table, method, column]) => table === "clients" && method === "eq" && column === "agency_code");
  assert.deepEqual(clientLookup, [["clients", "eq", "agency_code", "mml93-a01"]]);

  for (const table of ["dashboard_snapshots", "ad_performance", "reports", "schedule_items", "action_plans", "keywords"]) {
    const scoped = recorder.calls.filter(([name, method, column, value]) => (
      name === table && method === "eq" && column === "client_id" && value === ACTIVE_CLIENT.id
    ));
    assert.equal(scoped.length, 1, `${table} must be scoped to the session client id`);
  }
  assert.equal(
    recorder.calls.some(([, method, column, value]) => method === "eq" && column === "client_id" && value !== ACTIVE_CLIENT.id),
    false,
    "no read may use a caller-supplied client id"
  );
});

test("public-state keeps advertiser visibility filters and personal-calendar isolation on the schedule read", async () => {
  const recorder = adminRecorder({ "clients:single": { data: ACTIVE_CLIENT, error: null } });
  await handleClientPublicStateRequest(sessionRequest("/api/client/public-state"), recorder.ctx);

  assert.equal(recorder.calls.some(([table, method, column, value]) => (
    table === "schedule_items" && method === "is" && column === "calendar_id" && value === null
  )), true);
  assert.equal(recorder.calls.some(([table, method, column, value]) => (
    table === "schedule_items" && method === "eq" && column === "visibility" && value === "client_visible"
  )), true);
  assert.equal(recorder.calls.some(([table, method, column, value]) => (
    table === "reports" && method === "eq" && column === "visibility" && value === "client_visible"
  )), true);
  assert.equal(recorder.calls.some(([table, method, column, value]) => (
    table === "action_plans" && method === "eq" && column === "is_client_visible" && value === true
  )), true);
});

test("public-state never lets an advertiser session write published numbers", async () => {
  const recorder = adminRecorder({ "clients:single": { data: ACTIVE_CLIENT, error: null } });
  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", { method: "POST", body: { publicState: { sales: "1,860만원" } } }),
    recorder.ctx
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "PUBLIC_STATE_READ_ONLY");
  assert.deepEqual(recorder.writes, []);
});

test("public-state write stores only the submitted fields and never deletes rows", async () => {
  const recorder = adminRecorder({
    "clients:single": { data: ACTIVE_CLIENT, error: null },
    "dashboard_snapshots:single": { data: null, error: null },
    "dashboard_snapshots:write": { data: { id: "row-1", period: "2026-08-01", updated_at: "2026-08-26T00:00:00.000Z" }, error: null }
  });

  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", {
      role: "team",
      method: "POST",
      body: { publicState: { sales: "3,280만원", adSpend: "720만원", orders: "1,080건", updatedAt: "2026.08.19", comment: "8월 공개 수치" } }
    }),
    recorder.ctx
  );

  assert.equal(response.status, 200);
  assert.equal(recorder.writes.length, 1);
  const [table, method, body] = recorder.writes[0];
  assert.equal(table, "dashboard_snapshots");
  assert.equal(method, "insert");
  assert.equal(body.client_id, ACTIVE_CLIENT.id);
  assert.equal(body.period, "2026-08-01");
  assert.equal(body.sales, 32800000);
  assert.equal(body.ad_spend, 7200000);
  assert.equal(body.orders, 1080);
  assert.equal(body.public_comment, "8월 공개 수치");
  assert.equal("impressions" in body, false, "fields the operator did not submit must not be written");
  assert.equal(recorder.writes.some(([, action]) => action === "delete"), false);
});

test("public-state write updates the existing month row instead of adding a duplicate", async () => {
  const recorder = adminRecorder({
    "clients:single": { data: ACTIVE_CLIENT, error: null },
    "dashboard_snapshots:single": { data: { id: "row-existing" }, error: null },
    "dashboard_snapshots:write": { data: { id: "row-existing", period: "2026-08-01", updated_at: "2026-08-26T00:00:00.000Z" }, error: null }
  });

  await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", {
      role: "owner",
      method: "POST",
      body: { publicState: { sales: "3,280만원", updatedAt: "2026.08.19" } }
    }),
    recorder.ctx
  );

  assert.deepEqual(recorder.writes.map(([, action]) => action), ["update"]);
  assert.equal(recorder.calls.some(([table, method, column, value]) => (
    table === "dashboard_snapshots" && method === "eq" && column === "id" && value === "row-existing"
  )), true);
});

test("public-state write rejects a payload with no usable numbers", async () => {
  const recorder = adminRecorder({ "clients:single": { data: ACTIVE_CLIENT, error: null } });
  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", { role: "team", method: "POST", body: { publicState: { sales: "", adSpend: "입력 전" } } }),
    recorder.ctx
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "PUBLIC_STATE_EMPTY");
  assert.deepEqual(recorder.writes, []);
});

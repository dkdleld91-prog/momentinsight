import assert from "node:assert/strict";
import test from "node:test";
import {
  clientScheduleSelectFields,
  clientSelfConnectEnabled,
  computeKpiProgress,
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
  for (const field of ["sales", "roas", "adSpend", "orders", "achievement", "status", "kpi", "nextSchedule", "updatedAt", "comment"]) {
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

  for (const table of ["dashboard_snapshots", "ad_performance", "reports", "schedule_items", "action_plans", "keywords", "kpi_targets", "kpi_results"]) {
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

// KPI 목표·진행률 -----------------------------------------------------------
// 목표는 kpi_targets 행이 있을 때만 존재하고, 진행률은 실적 행이나 스냅샷이
// 있을 때만 존재한다. 둘 중 하나가 없으면 그 자리는 null 로 남아야 한다.
const KPI_TARGET_ROW = {
  id: "kpi-target-2026-08",
  client_id: ACTIVE_CLIENT.id,
  brand_id: null,
  period_month: "2026-08-01",
  target_revenue: 20000000,
  target_ad_spend: null,
  target_orders: null
};

test("computeKpiProgress returns null when there is no target row at all", () => {
  assert.equal(computeKpiProgress(null, null, null), null);
  assert.equal(computeKpiProgress(undefined, { actual_revenue: 18600000 }, { sales: 18600000 }), null);
});

test("computeKpiProgress returns null when every target value is zero or missing", () => {
  const empty = { ...KPI_TARGET_ROW, target_revenue: 0, target_ad_spend: 0, target_orders: 0 };
  assert.equal(computeKpiProgress(empty, null, { sales: 18600000 }), null);
  assert.equal(computeKpiProgress({ ...KPI_TARGET_ROW, target_revenue: null }, null, { sales: 18600000 }), null);
});

test("computeKpiProgress prefers the achievement rate stored on the matching result row", () => {
  const kpi = computeKpiProgress(
    KPI_TARGET_ROW,
    { kpi_target_id: KPI_TARGET_ROW.id, actual_revenue: 18600000, achievement_rate: 93.5 },
    { sales: 1 }
  );
  assert.deepEqual(kpi, {
    periodMonth: "2026-08",
    metric: "revenue",
    metricLabel: "매출",
    targetValue: 20000000,
    actualValue: 18600000,
    progressRate: 93.5,
    source: "kpi_results_rate"
  });
});

test("computeKpiProgress computes the rate from the result actual when no rate is stored", () => {
  const kpi = computeKpiProgress(
    KPI_TARGET_ROW,
    { kpi_target_id: KPI_TARGET_ROW.id, actual_revenue: 18600000, achievement_rate: null },
    { sales: 1 }
  );
  assert.equal(kpi.source, "kpi_results");
  assert.equal(kpi.actualValue, 18600000);
  assert.equal(kpi.progressRate, 93);
});

test("computeKpiProgress falls back to the dashboard snapshot when there is no result row", () => {
  const kpi = computeKpiProgress(KPI_TARGET_ROW, null, { sales: 15300000 });
  assert.equal(kpi.source, "dashboard_snapshot");
  assert.equal(kpi.actualValue, 15300000);
  assert.equal(kpi.progressRate, 76.5);
});

test("computeKpiProgress ignores a result row that belongs to a different target", () => {
  const foreign = { kpi_target_id: "kpi-target-2026-07", actual_revenue: 99999999, achievement_rate: 500 };

  const withSnapshot = computeKpiProgress(KPI_TARGET_ROW, foreign, { sales: 15300000 });
  assert.equal(withSnapshot.source, "dashboard_snapshot");
  assert.equal(withSnapshot.progressRate, 76.5);

  const withoutSnapshot = computeKpiProgress(KPI_TARGET_ROW, foreign, null);
  assert.equal(withoutSnapshot.source, null);
  assert.equal(withoutSnapshot.progressRate, null);
  assert.equal(withoutSnapshot.actualValue, null);
  assert.equal(withoutSnapshot.targetValue, 20000000, "목표는 알고 있으므로 그대로 남는다");
});

test("computeKpiProgress picks the ad spend metric when only the ad spend target is set", () => {
  const kpi = computeKpiProgress(
    { ...KPI_TARGET_ROW, target_revenue: null, target_ad_spend: 4000000 },
    null,
    { sales: 18600000, ad_spend: 3200000 }
  );
  assert.equal(kpi.metric, "ad_spend");
  assert.equal(kpi.metricLabel, "광고비");
  assert.equal(kpi.targetValue, 4000000);
  assert.equal(kpi.actualValue, 3200000);
  assert.equal(kpi.progressRate, 80);
  assert.equal(kpi.source, "dashboard_snapshot");
});

test("computeKpiProgress picks the orders metric when only the orders target is set", () => {
  const kpi = computeKpiProgress(
    { ...KPI_TARGET_ROW, target_revenue: null, target_ad_spend: null, target_orders: 800 },
    { kpi_target_id: KPI_TARGET_ROW.id, actual_orders: 642, achievement_rate: null },
    { orders: 10 }
  );
  assert.equal(kpi.metric, "orders");
  assert.equal(kpi.metricLabel, "구매수");
  assert.equal(kpi.targetValue, 800);
  assert.equal(kpi.actualValue, 642);
  assert.equal(kpi.progressRate, 80.3);
  assert.equal(kpi.source, "kpi_results");
});

test("public-state publishes the KPI target and lets its progress rate drive the achievement text", async () => {
  const recorder = adminRecorder({
    "clients:single": { data: ACTIVE_CLIENT, error: null },
    dashboard_snapshots: {
      data: [{ period: "2026-08-01", sales: 18600000, achievement_rate: 116, updated_at: "2026-08-19T02:00:00.000Z" }],
      error: null
    },
    kpi_targets: { data: [KPI_TARGET_ROW], error: null },
    kpi_results: {
      data: [{ id: "kpi-result-1", kpi_target_id: KPI_TARGET_ROW.id, client_id: ACTIVE_CLIENT.id, actual_revenue: 18500000, achievement_rate: 92.5, updated_at: "2026-08-25T00:00:00.000Z" }],
      error: null
    }
  });

  const payload = await (await handleClientPublicStateRequest(sessionRequest("/api/client/public-state"), recorder.ctx)).json();

  assert.deepEqual(payload.publicState.kpi, {
    periodMonth: "2026-08",
    metric: "revenue",
    metricLabel: "매출",
    targetValue: 20000000,
    actualValue: 18500000,
    progressRate: 92.5,
    source: "kpi_results_rate"
  });
  assert.equal(payload.publicState.achievement, "92.5%", "KPI 진행률이 스냅샷 달성률보다 우선한다");
  assert.equal(payload.publicState.status, "진행 중");
});

test("public-state keeps the snapshot achievement rate when no KPI target row exists", async () => {
  const recorder = adminRecorder({
    "clients:single": { data: ACTIVE_CLIENT, error: null },
    dashboard_snapshots: {
      data: [{ period: "2026-08-01", sales: 18600000, achievement_rate: 116, updated_at: "2026-08-19T02:00:00.000Z" }],
      error: null
    }
  });

  const payload = await (await handleClientPublicStateRequest(sessionRequest("/api/client/public-state"), recorder.ctx)).json();

  assert.equal(payload.publicState.kpi, null);
  assert.equal(payload.publicState.achievement, "116%");
  assert.equal(payload.publicState.status, "목표 초과");
});

test("public-state leaves achievement empty when there is neither a KPI target nor a snapshot rate", async () => {
  const recorder = adminRecorder({
    "clients:single": { data: ACTIVE_CLIENT, error: null },
    dashboard_snapshots: {
      data: [{ period: "2026-08-01", sales: 18600000, achievement_rate: null, updated_at: "2026-08-19T02:00:00.000Z" }],
      error: null
    },
    kpi_targets: { data: [], error: null },
    kpi_results: { data: [], error: null }
  });

  const payload = await (await handleClientPublicStateRequest(sessionRequest("/api/client/public-state"), recorder.ctx)).json();

  assert.equal(payload.publicState.kpi, null);
  assert.equal(payload.publicState.achievement, null, "없는 달성률을 만들어 채우면 안 된다");
  assert.equal(payload.publicState.status, null);
  assert.equal(payload.publicState.sales, "1,860만원");
});

test("save-kpi-target is refused for an advertiser session before any database write", async () => {
  const recorder = adminRecorder({ "clients:single": { data: ACTIVE_CLIENT, error: null } });
  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", {
      method: "POST",
      body: { action: "save-kpi-target", kpiTarget: { periodMonth: "2026-08", metric: "revenue", targetValue: "2,000만원" } }
    }),
    recorder.ctx
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "PUBLIC_STATE_READ_ONLY");
  assert.deepEqual(recorder.writes, []);
});

test("save-kpi-target inserts a new month row scoped to the session client only", async () => {
  const recorder = adminRecorder({
    "clients:single": { data: ACTIVE_CLIENT, error: null },
    "kpi_targets:single": { data: null, error: null },
    "kpi_targets:write": { data: { id: "kpi-target-new", period_month: "2026-08-01", updated_at: "2026-08-26T00:00:00.000Z" }, error: null }
  });

  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state?client_id=bbbbbbbb-0000-4000-8000-000000000002", {
      role: "team",
      method: "POST",
      body: { action: "save-kpi-target", kpiTarget: { periodMonth: "2026-08", metric: "revenue", targetValue: "2,000만원" } }
    }),
    recorder.ctx
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    message: "KPI 목표가 저장되었습니다.",
    saved: { clientId: ACTIVE_CLIENT.id, periodMonth: "2026-08", metric: "revenue", targetValue: 20000000 }
  });

  assert.equal(recorder.writes.length, 1);
  const [table, method, body] = recorder.writes[0];
  assert.equal(table, "kpi_targets");
  assert.equal(method, "insert");
  assert.deepEqual(body, { client_id: ACTIVE_CLIENT.id, period_month: "2026-08-01", target_revenue: 20000000 });
  assert.equal(
    recorder.calls.some(([name, action, column, value]) => (
      name === "kpi_targets" && action === "eq" && column === "client_id" && value !== ACTIVE_CLIENT.id
    )),
    false,
    "요청 파라미터의 client_id 로는 대상 광고주를 바꿀 수 없다"
  );
  assert.equal(recorder.writes.some(([, action]) => action === "delete" || action === "upsert"), false);
});

test("save-kpi-target updates the existing month row and touches only that one target column", async () => {
  const recorder = adminRecorder({
    "clients:single": { data: ACTIVE_CLIENT, error: null },
    "kpi_targets:single": { data: { id: "kpi-target-existing" }, error: null },
    "kpi_targets:write": { data: { id: "kpi-target-existing", period_month: "2026-08-01", updated_at: "2026-08-26T00:00:00.000Z" }, error: null }
  });

  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", {
      role: "owner",
      method: "POST",
      body: { action: "save-kpi-target", kpiTarget: { periodMonth: "2026.08", metric: "orders", targetValue: "800건" } }
    }),
    recorder.ctx
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).saved.metric, "orders");
  assert.deepEqual(recorder.writes.map(([, action]) => action), ["update"]);
  const [, , body] = recorder.writes[0];
  assert.deepEqual(Object.keys(body).sort(), ["target_orders", "updated_at"]);
  assert.equal(body.target_orders, 800);
  assert.equal(recorder.calls.some(([table, action, column, value]) => (
    table === "kpi_targets" && action === "eq" && column === "id" && value === "kpi-target-existing"
  )), true);
  assert.equal(recorder.calls.some(([table, action, column, value]) => (
    table === "kpi_targets" && action === "is" && column === "brand_id" && value === null
  )), true);
});

test("save-kpi-target rejects a target value that is not a usable number", async () => {
  for (const targetValue of ["입력 전", "", 0, -100]) {
    const recorder = adminRecorder({ "clients:single": { data: ACTIVE_CLIENT, error: null } });
    const response = await handleClientPublicStateRequest(
      sessionRequest("/api/client/public-state", {
        role: "team",
        method: "POST",
        body: { action: "save-kpi-target", kpiTarget: { periodMonth: "2026-08", metric: "revenue", targetValue } }
      }),
      recorder.ctx
    );
    assert.equal(response.status, 400, `${JSON.stringify(targetValue)} must be refused`);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "KPI_TARGET_INVALID",
      message: "목표값을 숫자로 입력해주세요."
    });
    assert.deepEqual(recorder.writes, []);
  }
});

test("save-kpi-target rejects a metric that is not one of the three published tiles", async () => {
  const recorder = adminRecorder({ "clients:single": { data: ACTIVE_CLIENT, error: null } });
  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", {
      role: "team",
      method: "POST",
      body: { action: "save-kpi-target", kpiTarget: { periodMonth: "2026-08", metric: "roas", targetValue: "600" } }
    }),
    recorder.ctx
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "KPI_TARGET_INVALID");
  assert.deepEqual(recorder.writes, []);
});

test("a POST without the kpi action still saves dashboard numbers exactly as before", async () => {
  const recorder = adminRecorder({
    "clients:single": { data: ACTIVE_CLIENT, error: null },
    "dashboard_snapshots:single": { data: null, error: null },
    "dashboard_snapshots:write": { data: { id: "row-1", period: "2026-08-01", updated_at: "2026-08-26T00:00:00.000Z" }, error: null }
  });

  const response = await handleClientPublicStateRequest(
    sessionRequest("/api/client/public-state", {
      role: "team",
      method: "POST",
      body: { publicState: { sales: "3,280만원", updatedAt: "2026.08.19" } }
    }),
    recorder.ctx
  );

  assert.equal(response.status, 200);
  assert.equal(recorder.writes.length, 1);
  assert.equal(recorder.writes[0][0], "dashboard_snapshots");
  assert.equal(recorder.writes[0][2].sales, 32800000);
});

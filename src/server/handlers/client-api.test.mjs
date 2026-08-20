import assert from "node:assert/strict";
import test from "node:test";
import {
  clientScheduleSelectFields,
  clientSelfConnectEnabled,
  handleClientApiRequest,
  handleAgencyCode
} from "./client-api.mjs";

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

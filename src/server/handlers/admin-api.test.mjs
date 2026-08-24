import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAdminApiRequest,
  resourceHardDeleteBlocked,
} from "./admin-api.mjs";
import { roleAllowsPath } from "../session-gate.mjs";

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
        or(expression) { calls.push([table, "or", expression]); return builder; },
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

// PostgREST 의 `or=(a.not.is.null,b.not.is.null)` 의미를 그대로 흉내 낸다.
// 이 테스트가 쓰는 표현식(`is.null` / `not.is.null`)만 지원하고, 그 밖의 표현식은
// 조용히 통과시키지 않고 즉시 실패시킨다 — 술어가 바뀌면 테스트가 먼저 깨져야 한다.
function orPredicate(expression) {
  const terms = String(expression).split(",").map((term) => {
    const match = /^([a-z_]+)\.(not\.)?is\.null$/.exec(term.trim());
    assert.ok(match, `테스트 스텁이 지원하지 않는 or() 표현식입니다: ${term}`);
    const [, column, negated] = match;
    const columnIsNull = (row) => row[column] === null || row[column] === undefined;
    return negated ? (row) => !columnIsNull(row) : columnIsNull;
  });
  return (row) => terms.some((matches) => matches(row));
}

// 호출 기록만 남기는 queryRecorder 와 달리, 이 스텁은 실제 행 집합에 필터를 적용해
// "무엇이 반환되는가"를 그대로 보여 준다. 유출 여부는 호출 문자열이 아니라
// 반환된 행으로 판정해야 한다.
function rowStore(rowsByTable = {}) {
  const calls = [];
  const supabaseAdmin = {
    from(table) {
      calls.push([table, "from"]);
      const filters = [];
      let operation = "select";
      const builder = {
        select(value) { calls.push([table, "select", value]); return builder; },
        insert(value) { operation = "insert"; calls.push([table, "insert", value]); return builder; },
        update(value) { operation = "update"; calls.push([table, "update", value]); return builder; },
        delete() { operation = "delete"; calls.push([table, "delete"]); return builder; },
        eq(column, value) {
          calls.push([table, "eq", column, value]);
          filters.push((row) => String(row[column] ?? "") === String(value));
          return builder;
        },
        is(column, value) {
          calls.push([table, "is", column, value]);
          filters.push((row) => (value === null
            ? row[column] === null || row[column] === undefined
            : row[column] === value));
          return builder;
        },
        or(expression) { calls.push([table, "or", expression]); filters.push(orPredicate(expression)); return builder; },
        order(column, options) { calls.push([table, "order", column, options]); return builder; },
        limit(value) { calls.push([table, "limit", value]); return builder; },
        maybeSingle() {
          calls.push([table, "maybeSingle"]);
          const [row = null] = (rowsByTable[table] || []).filter((item) => filters.every((matches) => matches(item)));
          return Promise.resolve({ data: row, error: null });
        },
        then(resolve, reject) {
          const source = operation === "insert" ? [] : (rowsByTable[table] || []);
          const data = source.filter((row) => filters.every((matches) => matches(row)));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { calls, ctx: { supabaseAdmin } };
}

const OWNER_CODE = "mml93-a01";

// owner_agency_code 는 사실상 모든 행이 대표 코드다
// (20260730074106_extend_schedule_items_for_work_operations.sql:9-10 의 not null default).
// 그래서 개인/운영을 가르는 유일한 현행 신호는 client_id / operation_team_id 다.
const SCHEDULE_ROWS = [
  {
    id: "row-google-personal",
    owner_agency_code: OWNER_CODE,
    client_id: null,
    operation_team_id: null,
    calendar_id: null,
    google_source: "google",
    google_calendar_id: "owner@example.com",
    google_event_id: "gcal-evt-1",
    title: "대표님 개인 일정(구글에서 가져옴)",
    visibility: "internal",
  },
  {
    id: "row-owner-personal",
    owner_agency_code: OWNER_CODE,
    client_id: null,
    operation_team_id: null,
    calendar_id: null,
    google_source: null,
    google_calendar_id: null,
    google_event_id: null,
    title: "대표님 개인 일정(서비스에서 직접 생성)",
    visibility: "internal",
  },
  {
    id: "row-advertiser-operational",
    owner_agency_code: OWNER_CODE,
    client_id: "client-1",
    operation_team_id: null,
    calendar_id: null,
    google_source: null,
    google_calendar_id: null,
    google_event_id: null,
    title: "광고주 범위 업무 운영 일정",
    visibility: "client_visible",
  },
  {
    id: "row-team-operational",
    owner_agency_code: OWNER_CODE,
    client_id: null,
    operation_team_id: "team-1",
    calendar_id: null,
    google_source: null,
    google_calendar_id: null,
    google_event_id: null,
    title: "운영팀 범위 업무 운영 일정",
    visibility: "internal",
  },
  {
    // 대표가 만든 광고주 범위 행도 구글로 push 되어 google_event_id 를 갖는다
    // (google-calendar-sync.mjs 의 ownerSyncableRows 는 client_id 를 보지 않는다).
    // 구글 식별자 유무로 거르면 이 행이 사라진다 = 운영 행 과잉 차단.
    id: "row-advertiser-operational-synced",
    owner_agency_code: OWNER_CODE,
    client_id: "client-2",
    operation_team_id: null,
    calendar_id: null,
    google_source: "moment-insight",
    google_calendar_id: "owner@example.com",
    google_event_id: "gcal-evt-2",
    title: "광고주 범위 운영 일정(구글 동기화됨)",
    visibility: "internal",
  },
  {
    id: "row-retired-shared-calendar",
    owner_agency_code: OWNER_CODE,
    client_id: "client-1",
    operation_team_id: null,
    calendar_id: "cal-1",
    google_source: null,
    google_calendar_id: null,
    google_event_id: null,
    title: "폐기된 공유 일정표 행",
    visibility: "internal",
  },
];

function scheduleIds(payload) {
  return (payload?.data || []).map((row) => row.id).sort();
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

test("팀·광고주 세션은 관리 일정 API 경로 자체에 도달하지 못한다", () => {
  // 1차 방어선: 세션 게이트가 /api/admin/* 을 owner 로 제한한다
  // (session-gate.mjs 의 roleAllowsPath). 아래 조회 필터는 2차 방어선이다.
  assert.equal(roleAllowsPath("owner", "/api/admin/schedule-items"), true);
  assert.equal(roleAllowsPath("team", "/api/admin/schedule-items"), false);
  assert.equal(roleAllowsPath("client", "/api/admin/schedule-items"), false);
});

test("관리 일정 목록은 대표님 개인 행을 반환하지 않고 운영 행은 그대로 반환한다", async () => {
  const store = rowStore({ schedule_items: SCHEDULE_ROWS });
  const response = await handleAdminApiRequest(adminRequest("GET", "/api/admin/schedule-items"), store.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(scheduleIds(payload), [
    "row-advertiser-operational",
    "row-advertiser-operational-synced",
    "row-team-operational",
  ]);

  // 구글에서 가져온 개인 일정이 한 건도 새어 나가지 않는다.
  assert.equal((payload.data || []).some((row) => row.google_source === "google"), false);
  assert.equal((payload.data || []).some((row) => row.id === "row-google-personal"), false);
  assert.equal((payload.data || []).some((row) => row.id === "row-owner-personal"), false);

  // 과잉 차단 방지: 구글로 동기화된 광고주 범위 운영 행은 남아 있어야 한다.
  assert.equal((payload.data || []).some((row) => row.id === "row-advertiser-operational-synced"), true);

  // 술어가 두 개 다 걸렸는지 호출로도 고정한다.
  assert.equal(store.calls.some(([table, method, column, value]) => (
    table === "schedule_items" && method === "is" && column === "calendar_id" && value === null
  )), true);
  assert.equal(store.calls.some(([table, method, expression]) => (
    table === "schedule_items"
      && method === "or"
      && expression === "client_id.not.is.null,operation_team_id.not.is.null"
  )), true);
});

test("관리 일정 API는 대표님 개인 행을 수정·삭제 대상으로도 잡지 못한다", async (t) => {
  for (const personalId of ["row-google-personal", "row-owner-personal"]) {
    await t.test(personalId, async () => {
      for (const method of ["PATCH", "DELETE"]) {
        const store = rowStore({ schedule_items: SCHEDULE_ROWS });
        const response = await handleAdminApiRequest(adminRequest(
          method,
          `/api/admin/schedule-items/${personalId}`,
          method === "PATCH" ? { title: "남의 개인 일정 수정 시도" } : undefined,
        ), store.ctx);
        assert.equal(response.status, 404);
        assert.equal(store.calls.some(([table]) => table === "audit_logs"), false);
      }
    });
  }
});

test("관리 일정 API는 운영 행에 대한 수정·삭제는 그대로 처리한다", async (t) => {
  for (const method of ["PATCH", "DELETE"]) {
    await t.test(method, async () => {
      const store = rowStore({ schedule_items: SCHEDULE_ROWS });
      const response = await handleAdminApiRequest(adminRequest(
        method,
        "/api/admin/schedule-items/row-advertiser-operational-synced",
        method === "PATCH" ? { title: "운영 일정 수정" } : undefined,
      ), store.ctx);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(scheduleIds(payload), ["row-advertiser-operational-synced"]);
      assert.equal(store.calls.some(([table]) => table === "audit_logs"), true);
    });
  }
});

test("관리 overview 일정 조회는 광고주 범위에 묶여 개인 행이 섞이지 않는다", async () => {
  const store = rowStore({
    schedule_items: SCHEDULE_ROWS,
    clients: [{ id: "client-1" }],
  });
  const response = await handleAdminApiRequest(
    adminRequest("GET", "/api/admin/overview?client_id=client-1"),
    store.ctx,
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual((payload.data?.schedule || []).map((row) => row.id), ["row-advertiser-operational"]);
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
      const response = await handleAdminApiRequest(adminRequest(
        method,
        "/api/admin/schedule-items/34343434-3434-4434-8434-343434343434",
        method === "PATCH" ? { title: "개인 일정만 수정" } : undefined,
      ), harness.ctx);
      assert.equal(response.status, 404);
      assert.equal(harness.calls.some(([table, operation]) => table === "schedule_items" && operation === expectedOperation), true);
      assert.equal(harness.calls.some(([table, operation, column, value]) => (
        table === "schedule_items" && operation === "is" && column === "calendar_id" && value === null
      )), true);
      assert.equal(harness.calls.some(([table]) => table === "audit_logs"), false);
    });
  }
});

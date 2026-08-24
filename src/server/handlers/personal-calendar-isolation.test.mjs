import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { roleAllowsPath, sessionScopeAllowsPath } from "../session-gate.mjs";
import { handleAdminApiRequest } from "./admin-api.mjs";
import googleCalendarHandler, {
  oauthStateNonce,
  signOauthState,
  verifyOauthState,
} from "./google-calendar-api.mjs";
import {
  OPTIONAL_PERSONAL_COLUMNS,
  disableOptionalColumns,
  mapGoogleEventToScheduleRow,
  resetOptionalColumns,
  setOptionalColumnClock,
} from "./google-calendar-sync.mjs";
import {
  PERSONAL_GOOGLE_CALENDAR_PATH,
  PERSONAL_GOOGLE_LOGIN_PATH,
  PERSONAL_WORK_ITEMS_PATH,
  personalPrincipalKey,
} from "./personal-identity.mjs";
import { handleWorkItemsRequest } from "./work-items.mjs";

// 이 파일은 설계 §5.2 의 N1~N17 부정 테스트 목록을 그대로 옮긴 것이다.
// 각 테스트 이름 앞의 [N##] 이 그 표의 행 번호이고, 목록과 파일이 어긋나면
// 어느 쪽이 빠졌는지 이름만 보고 셀 수 있어야 한다.
//
// N11(브라우저가 x-mi-agency-code / x-mi-team-code 를 직접 실어 보내는 위조)은
// src/server/session-gate.test.mjs 가 이미 헤더 삭제·재설정으로 고정하고 있으므로
// 여기서 중복하지 않는다.

// ─────────────────────────────────────────────────────────────
// 주변 환경 고정 (work-items.test.mjs 와 같은 방식)
//
// Vercel 프로덕션 빌드는 GOOGLE_OAUTH_* 가 실린 채 테스트를 돌린다. 기준선을
// "없음" 으로 못 박아 두어야 구글을 부르지 않는 경로가 환경에 따라 흔들리지
// 않는다. 구글 경로를 검증하는 테스트만 withGoogleEnv 로 값을 넣었다 되돌린다.
// ─────────────────────────────────────────────────────────────
const PINNED_GOOGLE_ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "MI_GOOGLE_OAUTH_REDIRECT",
];
const AMBIENT_GOOGLE_ENV = {};
for (const key of PINNED_GOOGLE_ENV_KEYS) {
  AMBIENT_GOOGLE_ENV[key] = process.env[key];
  delete process.env[key];
}
process.on("exit", () => {
  for (const key of PINNED_GOOGLE_ENV_KEYS) {
    if (AMBIENT_GOOGLE_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = AMBIENT_GOOGLE_ENV[key];
  }
});

// ─────────────────────────────────────────────────────────────
// 고정 픽스처
// ─────────────────────────────────────────────────────────────
const OWNER_CODE = "mml93-a01";
const TEAM_A = { id: "11111111-1111-4111-8111-111111111111", code: "team-a1" };
const TEAM_B = { id: "22222222-2222-4222-8222-222222222222", code: "team-b1" };
const CLIENT_A = { id: "33333333-3333-4333-8333-333333333333", agencyCode: "mml93-a02" };
const CLIENT_B = { id: "44444444-4444-4444-8444-444444444444", agencyCode: "mml93-a03" };
const TEAM_A_KEY = `team:${TEAM_A.id}`;
const TEAM_B_KEY = `team:${TEAM_B.id}`;
const CLIENT_A_KEY = `client:${CLIENT_A.id}`;
const CLIENT_B_KEY = `client:${CLIENT_B.id}`;

const GOOGLE_ENV = { GOOGLE_OAUTH_CLIENT_ID: "cid-1", GOOGLE_OAUTH_CLIENT_SECRET: "sec-1" };
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const OWNER_CALENDAR = "owner@example.com";
const TEAM_A_CALENDAR = "team-a@example.com";
const SHARED_CALENDAR = "shared@group.calendar.google.com";

function teamRow(team, overrides = {}) {
  return {
    id: team.id,
    team_name: `운영팀 ${team.code}`,
    team_code: team.code,
    status: "active",
    client_id: null,
    revoked_at: null,
    ...overrides,
  };
}

function clientRow(client, overrides = {}) {
  return {
    id: client.id,
    name: `광고주 ${client.agencyCode}`,
    business_name: `광고주 ${client.agencyCode}`,
    agency_code: client.agencyCode,
    status: "active",
    disconnected_at: null,
    ...overrides,
  };
}

// 개인 행 한 건. 서버가 채우는 세 값(personal_role · personal_code ·
// owner_agency_code)이 언제나 함께 붙어 있어야 한다.
function personalScheduleRow(role, code, overrides = {}) {
  const key = personalPrincipalKey(role, code);
  return {
    id: `row-${role}-${String(code).slice(0, 8)}`,
    owner_agency_code: key,
    personal_role: role,
    personal_code: String(code).toLowerCase(),
    client_id: null,
    operation_team_id: null,
    calendar_id: null,
    title: `${role} 개인 일정`,
    schedule_type: "meeting",
    status: "planned",
    priority: "medium",
    visibility: "internal",
    is_all_day: false,
    starts_at: "2026-09-01T00:00:00.000Z",
    ends_at: "2026-09-01T01:00:00.000Z",
    google_calendar_id: null,
    google_event_id: null,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function operationalScheduleRow(overrides = {}) {
  return {
    id: "row-owner-operational",
    owner_agency_code: OWNER_CODE,
    personal_role: null,
    personal_code: null,
    client_id: null,
    operation_team_id: null,
    calendar_id: null,
    title: "대표님 운영 일정",
    schedule_type: "meeting",
    status: "planned",
    priority: "medium",
    visibility: "internal",
    is_all_day: false,
    starts_at: "2026-09-01T00:00:00.000Z",
    ends_at: "2026-09-01T01:00:00.000Z",
    google_calendar_id: null,
    google_event_id: null,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

// 모든 계정의 개인 행 + 대표님 운영 행이 한 테이블에 섞여 있는 상태.
// "필터가 무엇을 걸었는가" 가 아니라 "무엇이 돌아왔는가" 로 판정하기 위한 것이다.
const EVERY_ACCOUNT_ROWS = [
  operationalScheduleRow(),
  personalScheduleRow("owner", OWNER_CODE, { id: "row-owner-personal" }),
  personalScheduleRow("team", TEAM_A.id, { id: "row-team-a-personal" }),
  personalScheduleRow("team", TEAM_B.id, { id: "row-team-b-personal" }),
  personalScheduleRow("client", CLIENT_A.id, { id: "row-client-a-personal" }),
  personalScheduleRow("client", CLIENT_B.id, { id: "row-client-b-personal" }),
];

// ─────────────────────────────────────────────────────────────
// 하니스 — work-items.test.mjs 의 from() 기록기 + admin-api.test.mjs 의
// 술어 평가기를 합친 것이다. 테이블 값은 결과 큐(배열)이거나 매 호출을 직접
// 처리하는 함수이고, rowsTable() 이 그 함수 자리에 들어가 실제 행 집합에
// 기록된 필터를 적용한다.
// ─────────────────────────────────────────────────────────────
function tableCtx(tables = {}) {
  const ops = [];
  const rpcCalls = [];
  const queues = Object.fromEntries(Object.entries(tables)
    .filter(([, list]) => Array.isArray(list))
    .map(([name, list]) => [name, [...list]]));
  const from = (table) => {
    const op = { table, kind: "select", values: null, options: null, fields: "", filters: [] };
    const settle = (shape) => {
      ops.push(op);
      const handler = tables[table];
      if (typeof handler === "function") {
        const out = handler(op, shape);
        return out === undefined ? { data: null, error: null } : out;
      }
      const queue = queues[table];
      const next = queue && queue.length ? queue.shift() : undefined;
      return next === undefined ? { data: null, error: null } : next;
    };
    const query = {
      select(fields) { op.fields = fields || ""; return query; },
      insert(values) { op.kind = "insert"; op.values = values; return query; },
      update(values) { op.kind = "update"; op.values = values; return query; },
      upsert(values, options) { op.kind = "upsert"; op.values = values; op.options = options; return query; },
      delete() { op.kind = "delete"; return query; },
      maybeSingle() { return Promise.resolve(settle("single")); },
      single() { return Promise.resolve(settle("single")); },
      then(onOk, onErr) { return Promise.resolve(settle("list")).then(onOk, onErr); },
    };
    for (const method of ["eq", "is", "in", "or", "gt", "gte", "lt", "lte", "not", "ilike", "order", "limit"]) {
      query[method] = (...args) => { op.filters.push([method, ...args]); return query; };
    }
    return query;
  };
  const rpc = async (name, params) => {
    rpcCalls.push({ name, params });
    return { data: null, error: null };
  };
  return { ctx: { supabaseAdmin: { from, rpc } }, ops, rpcCalls };
}

// PostgREST 의 `or=(a.not.is.null,b.not.is.null)` 의미를 그대로 흉내 낸다.
// 지원하지 않는 표현식은 조용히 통과시키지 않고 즉시 실패시킨다.
function orPredicate(expression) {
  const terms = String(expression).split(",").map((term) => {
    const match = /^([a-z_]+)\.(not\.)?is\.null$/u.exec(term.trim());
    assert.ok(match, `테스트 스텁이 지원하지 않는 or() 표현식입니다: ${term}`);
    const [, column, negated] = match;
    const columnIsNull = (row) => row[column] === null || row[column] === undefined;
    return negated ? (row) => !columnIsNull(row) : columnIsNull;
  });
  return (row) => terms.some((matches) => matches(row));
}

function matchesFilters(row, filters) {
  return filters.every(([method, ...args]) => {
    if (method === "order" || method === "limit") return true;
    const [column, value] = args;
    if (method === "eq") return String(row[column] ?? "") === String(value);
    if (method === "ilike") return String(row[column] ?? "").toLowerCase() === String(value ?? "").toLowerCase();
    if (method === "is") {
      return value === null ? (row[column] === null || row[column] === undefined) : row[column] === value;
    }
    if (method === "gte") return String(row[column] ?? "") >= String(value);
    if (method === "lt") return String(row[column] ?? "") < String(value);
    if (method === "or") return orPredicate(column)(row);
    return assert.fail(`테스트 스텁이 지원하지 않는 필터입니다: ${method}`);
  });
}

// 기록된 필터를 실제 행 집합에 적용하는 인메모리 술어 평가기.
// 유출 여부는 호출 문자열이 아니라 반환된 행으로 판정한다.
function rowsTable(rows) {
  return (op, shape) => {
    if (op.kind !== "select") return { data: null, error: null };
    const matched = rows.filter((row) => matchesFilters(row, op.filters));
    return shape === "single"
      ? { data: matched[0] ?? null, error: null }
      : { data: matched, error: null };
  };
}

function opsFor(ops, table, kind) {
  return ops.filter((op) => op.table === table && op.kind === kind);
}

// 기록된 필터 전체를 한 문자열로 눌러 "이 문자열이 등장하는가" 를 묻는다.
function filterText(op) {
  return JSON.stringify(op.filters);
}

function googleFetchMock(routes) {
  const calls = [];
  return {
    calls,
    impl: async (url, options = {}) => {
      const [base, search = ""] = String(url).split("?");
      const method = options.method || "GET";
      calls.push({ method, url: base, query: Object.fromEntries(new URLSearchParams(search)), options });
      const route = routes[`${method} ${base}`];
      if (route === undefined) throw new Error(`unexpected fetch: ${method} ${base}`);
      const body = typeof route === "function" ? route(calls.at(-1)) : route;
      return {
        ok: body.status >= 200 && body.status < 300,
        status: body.status,
        async json() { return body.body; },
      };
    },
  };
}

function googleJson(status, body) {
  return { status, body };
}

async function withGoogleEnv(impl, run) {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, GOOGLE_ENV);
  if (impl) globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(GOOGLE_ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 요청 만들기
// ─────────────────────────────────────────────────────────────
const SESSION_HEADERS = {
  owner: { "x-mi-session-role": "owner", "x-mi-owner-agency-code": OWNER_CODE },
  teamA: { "x-mi-session-role": "team", "x-mi-team-code": TEAM_A.code },
  teamB: { "x-mi-session-role": "team", "x-mi-team-code": TEAM_B.code },
  clientA: { "x-mi-session-role": "client", "x-mi-agency-code": CLIENT_A.agencyCode },
  clientB: { "x-mi-session-role": "client", "x-mi-agency-code": CLIENT_B.agencyCode },
};

function miRequest(path, { method = "GET", session = "owner", headers = {}, body } = {}) {
  return new Request(`https://insight.momentlabs.co.kr${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...SESSION_HEADERS[session],
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function personalRequest(options = {}) {
  return miRequest(PERSONAL_WORK_ITEMS_PATH, options);
}

function operationalRequest(options = {}) {
  return miRequest("/api/work-items", options);
}

function itemIds(payload) {
  return (payload?.items || []).map((item) => item.id).sort();
}

// ─────────────────────────────────────────────────────────────
// N1 · N2 — 개인 피드는 자기 계정 키에만 못 박힌다
// ─────────────────────────────────────────────────────────────
test("[N1] 운영팀 개인 피드 조회는 자기 계정 키 세 술어에만 못 박힌다", async () => {
  resetOptionalColumns();
  const harness = tableCtx({
    operation_team_codes: [{ data: teamRow(TEAM_A), error: null }],
    schedule_items: [{ data: [], error: null }],
  });

  const response = await handleWorkItemsRequest(personalRequest({ session: "teamA" }), harness.ctx);
  assert.equal(response.status, 200);

  const selects = opsFor(harness.ops, "schedule_items", "select");
  assert.equal(selects.length, 1);
  const filters = selects[0].filters;
  for (const expected of [
    ["is", "calendar_id", null],
    ["eq", "personal_role", "team"],
    ["eq", "personal_code", TEAM_A.id],
    ["eq", "owner_agency_code", TEAM_A_KEY],
  ]) {
    assert.ok(
      filters.some((filter) => JSON.stringify(filter) === JSON.stringify(expected)),
      `개인 술어가 빠졌습니다: ${JSON.stringify(expected)}`,
    );
  }
  // 남의 계정 좌표는 한 글자도 실려서는 안 된다.
  const text = filterText(selects[0]);
  for (const forbidden of [OWNER_CODE, TEAM_B.id, TEAM_B_KEY, CLIENT_A.id, CLIENT_A_KEY, CLIENT_B.id]) {
    assert.equal(text.includes(forbidden), false, `개인 조회에 남의 좌표가 섞였습니다: ${forbidden}`);
  }
  resetOptionalColumns();
});

test("[N1b] 운영팀 A 의 개인 피드에는 운영팀 B·광고주·대표님 개인 행이 한 건도 없다", async () => {
  resetOptionalColumns();
  const harness = tableCtx({
    operation_team_codes: rowsTable([teamRow(TEAM_A), teamRow(TEAM_B)]),
    schedule_items: rowsTable(EVERY_ACCOUNT_ROWS),
  });

  const response = await handleWorkItemsRequest(personalRequest({ session: "teamA" }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(itemIds(payload), ["row-team-a-personal"]);
  resetOptionalColumns();
});

test("[N2] 광고주 개인 피드 조회는 그 광고주 키만 언급한다", async () => {
  resetOptionalColumns();
  const harness = tableCtx({
    clients: [{ data: clientRow(CLIENT_A), error: null }],
    schedule_items: [{ data: [], error: null }],
  });

  const response = await handleWorkItemsRequest(personalRequest({ session: "clientA" }), harness.ctx);
  assert.equal(response.status, 200);

  const selects = opsFor(harness.ops, "schedule_items", "select");
  assert.equal(selects.length, 1);
  const filters = selects[0].filters;
  for (const expected of [
    ["is", "calendar_id", null],
    ["eq", "personal_role", "client"],
    ["eq", "personal_code", CLIENT_A.id],
    ["eq", "owner_agency_code", CLIENT_A_KEY],
  ]) {
    assert.ok(
      filters.some((filter) => JSON.stringify(filter) === JSON.stringify(expected)),
      `개인 술어가 빠졌습니다: ${JSON.stringify(expected)}`,
    );
  }
  // 이 목록이 언급하는 계정 좌표는 정확히 이 광고주 하나뿐이다.
  const text = filterText(selects[0]);
  for (const forbidden of [OWNER_CODE, TEAM_A.id, TEAM_A_KEY, TEAM_B.id, CLIENT_B.id, CLIENT_B_KEY]) {
    assert.equal(text.includes(forbidden), false, `개인 조회에 남의 좌표가 섞였습니다: ${forbidden}`);
  }
  resetOptionalColumns();
});

test("[N2b] 광고주 A 의 개인 피드에는 광고주 B 의 개인 행이 없다", async () => {
  resetOptionalColumns();
  const harness = tableCtx({
    clients: rowsTable([clientRow(CLIENT_A), clientRow(CLIENT_B)]),
    schedule_items: rowsTable(EVERY_ACCOUNT_ROWS),
  });

  const response = await handleWorkItemsRequest(personalRequest({ session: "clientA" }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(itemIds(payload), ["row-client-a-personal"]);
  // 개인 공간의 일정은 그 자신이 쓴 것이라 가려진 광고주 페이로드가 아니다.
  assert.equal(payload.items[0].title, "client 개인 일정");
  resetOptionalColumns();
});

// ─────────────────────────────────────────────────────────────
// N3 · N4 — 운영 표면은 개인 행을 걷어낸다
// ─────────────────────────────────────────────────────────────
test("[N3] 대표님 운영 피드(/api/work-items)는 personal_role 이 있는 행을 반환하지 않는다", async () => {
  resetOptionalColumns();
  const harness = tableCtx({ schedule_items: rowsTable(EVERY_ACCOUNT_ROWS) });

  const response = await handleWorkItemsRequest(operationalRequest({ session: "owner" }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  // 대표님 개인 행은 owner_agency_code 가 대표 코드라 테넌트 술어로는 걸리지
  // 않는다. is("personal_role", null) 하나가 이 행을 거른다.
  assert.deepEqual(itemIds(payload), ["row-owner-operational"]);

  const selects = opsFor(harness.ops, "schedule_items", "select");
  assert.equal(selects.length, 1);
  assert.ok(selects[0].filters.some((filter) => JSON.stringify(filter) === JSON.stringify(["is", "personal_role", null])));
  resetOptionalColumns();
});

test("[N4] /api/admin/schedule-items 는 어느 계정의 개인 행도 반환하지 않는다 (I11 회귀)", async () => {
  resetOptionalColumns();
  // 운영 범위 술어(client_id / operation_team_id)만으로는 못 거르는 개인 행을
  // 일부러 섞는다. personal_role IS NULL 이 1차 술어라는 것이 이 테스트의 요점이다.
  const rows = [
    ...EVERY_ACCOUNT_ROWS,
    personalScheduleRow("team", TEAM_A.id, {
      id: "row-team-a-personal-with-scope",
      operation_team_id: "team-scope-1",
    }),
    personalScheduleRow("client", CLIENT_B.id, {
      id: "row-client-b-personal-with-scope",
      client_id: CLIENT_B.id,
    }),
    operationalScheduleRow({ id: "row-advertiser-operational", client_id: CLIENT_A.id }),
  ];
  const harness = tableCtx({ schedule_items: rowsTable(rows) });

  const response = await handleAdminApiRequest(
    new Request("https://insight.momentlabs.co.kr/api/admin/schedule-items"),
    harness.ctx,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual((payload.data || []).map((row) => row.id).sort(), ["row-advertiser-operational"]);
  assert.equal((payload.data || []).some((row) => row.personal_role), false);

  const selects = opsFor(harness.ops, "schedule_items", "select");
  assert.equal(selects.length, 1);
  const filters = selects[0].filters;
  for (const expected of [
    ["is", "calendar_id", null],
    ["or", "client_id.not.is.null,operation_team_id.not.is.null"],
    ["is", "personal_role", null],
  ]) {
    assert.ok(
      filters.some((filter) => JSON.stringify(filter) === JSON.stringify(expected)),
      `관리 일정 술어가 빠졌습니다: ${JSON.stringify(expected)}`,
    );
  }
  resetOptionalColumns();
});

// ─────────────────────────────────────────────────────────────
// N5 — 남의 개인 행 id 로는 존재조차 알 수 없다
// ─────────────────────────────────────────────────────────────
test("[N5] 운영팀 A 가 운영팀 B 의 행 id 로 수정·삭제하면 404 이고 쓰기가 한 건도 없다", async (t) => {
  for (const method of ["PATCH", "DELETE"]) {
    await t.test(method, async () => {
      resetOptionalColumns();
      const harness = tableCtx({
        operation_team_codes: rowsTable([teamRow(TEAM_A), teamRow(TEAM_B)]),
        schedule_items: rowsTable(EVERY_ACCOUNT_ROWS),
        audit_logs: [{ error: null }],
      });

      const response = await handleWorkItemsRequest(personalRequest({
        method,
        session: "teamA",
        body: { id: "row-team-b-personal", expectedUpdatedAt: "2026-09-01T00:00:00.000Z" },
      }), harness.ctx);
      const payload = await response.json();

      // 403 이 아니라 404 다 — 존재 여부조차 알려 주지 않는 것이 최소 조건이다.
      assert.equal(response.status, 404);
      assert.equal(payload.ok, false);
      assert.equal(opsFor(harness.ops, "schedule_items", "update").length, 0);
      assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 0);
      resetOptionalColumns();
    });
  }
});

// ─────────────────────────────────────────────────────────────
// N6 · N7 — /api/my/google-calendar 는 계정 단위다
//
// 이 두 테스트만 실제 핸들러(withSupabase)를 통과시키므로 PostgREST 수준의
// fetch 라우터를 쓴다. google-calendar-api.test.mjs 의 방식 그대로다.
// ─────────────────────────────────────────────────────────────
const SUPABASE_TEST_URL = "http://supabase.test";
const REST_BASE = `${SUPABASE_TEST_URL}/rest/v1`;
const RATE_RPC_URL = `${REST_BASE}/rpc/consume_code_login_rate_limit`;
const SYNC_SLOT_RPC_URL = `${REST_BASE}/rpc/mi_claim_google_sync_slot`;
const OAUTH_CALLBACK_URL = "https://insight.momentlabs.co.kr/api/google-oauth/callback";
const NONCE_COOKIE = "mi-goauth-nonce";
const HANDLER_ENV = {
  SUPABASE_URL: SUPABASE_TEST_URL,
  SUPABASE_PUBLISHABLE_KEY: "pub-test",
  SUPABASE_PUBLISHABLE_KEYS: undefined,
  SUPABASE_SECRET_KEY: "secret-test",
  SUPABASE_SECRET_KEYS: undefined,
  SUPABASE_JWKS: undefined,
  SUPABASE_JWKS_URL: undefined,
  MI_SESSION_SECRET: "unit-test-session-secret-0123456789abcdef",
  ...GOOGLE_ENV,
};

const INTEGRATION_ROWS = [
  {
    owner_agency_code: OWNER_CODE,
    refresh_token: "rt-owner",
    calendar_id: OWNER_CALENDAR,
    google_email: "owner@example.com",
    connected_at: "2026-08-01T00:00:00.000Z",
    last_sync_at: "2026-08-24T00:00:00.000Z",
    last_sync_attempt_at: null,
    sync_status: "ok",
    sync_error: null,
  },
  {
    owner_agency_code: TEAM_A_KEY,
    refresh_token: "rt-team-a",
    calendar_id: TEAM_A_CALENDAR,
    google_email: "team-a@example.com",
    connected_at: "2026-08-20T00:00:00.000Z",
    last_sync_at: null,
    last_sync_attempt_at: null,
    sync_status: "needs_reconnect",
    sync_error: null,
  },
  {
    owner_agency_code: CLIENT_A_KEY,
    refresh_token: "rt-client-a",
    calendar_id: null,
    google_email: "client-a@example.com",
    connected_at: "2026-08-21T00:00:00.000Z",
    last_sync_at: null,
    last_sync_attempt_at: null,
    sync_status: "ok",
    sync_error: null,
  },
];

async function withEnv(overrides, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function restJson(rows) {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// PostgREST 의 `column=eq.<value>` 만 해석하는 최소 라우터. 조회 필터를 실제로
// 적용하므로 "핸들러가 어떤 키를 물었는가" 가 반환 값으로 드러난다.
function restStore(rows) {
  return (call) => {
    const params = new URL(call.url).searchParams;
    const matched = rows.filter((row) => [...params.entries()].every(([column, condition]) => {
      if (column === "select" || column === "limit" || column === "order") return true;
      const [operator, ...rest] = String(condition).split(".");
      const value = rest.join(".");
      if (operator === "eq") return String(row[column] ?? "") === value;
      if (operator === "ilike") return String(row[column] ?? "").toLowerCase() === value.toLowerCase();
      if (operator === "is") return value === "null" ? (row[column] ?? null) === null : String(row[column]) === value;
      return assert.fail(`테스트 라우터가 지원하지 않는 조건입니다: ${column}=${condition}`);
    }));
    return restJson(matched);
  };
}

function restRouter(routes) {
  const calls = [];
  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input.url);
    const method = String(init.method || input?.method || "GET").toUpperCase();
    const call = { method, url, headers: new Headers(init.headers || {}), body: init.body };
    calls.push(call);
    for (const [routeMethod, prefix, respond] of routes) {
      if (routeMethod === method && url.startsWith(prefix)) {
        return typeof respond === "function" ? respond(call) : respond;
      }
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return { calls, impl };
}

async function callGoogleHandler(request, routes) {
  const { calls, impl } = restRouter(routes);
  const savedFetch = globalThis.fetch;
  const response = await withEnv(HANDLER_ENV, async () => {
    globalThis.fetch = impl;
    try {
      return await googleCalendarHandler.fetch(request);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
  return { response, calls };
}

function restRoutesFor(tables = {}) {
  return Object.entries(tables).map(([table, rows]) => ["GET", `${REST_BASE}/${table}`, restStore(rows)]);
}

function integrationWrites(calls) {
  return calls.filter((call) => call.url.startsWith(`${REST_BASE}/owner_google_integrations`)
    && call.method !== "GET");
}

function integrationReads(calls) {
  return calls.filter((call) => call.url.startsWith(`${REST_BASE}/owner_google_integrations`)
    && call.method === "GET");
}

test("[N6] 운영팀 개인 구글 캘린더 상태는 자기 계정 연동만 읽는다", async () => {
  const { response, calls } = await callGoogleHandler(
    miRequest(PERSONAL_GOOGLE_CALENDAR_PATH, { session: "teamA" }),
    [
      ...restRoutesFor({
        operation_team_codes: [teamRow(TEAM_A)],
        owner_google_integrations: INTEGRATION_ROWS,
      }),
    ],
  );
  const text = await response.text();
  const payload = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(payload.googleEmail, "team-a@example.com");
  assert.equal(payload.role, "team");
  assert.equal(payload.canManageCalendars, true);

  const reads = integrationReads(calls);
  assert.equal(reads.length, 1);
  assert.equal(decodeURIComponent(reads[0].url).includes(`owner_agency_code=eq.${TEAM_A_KEY}`), true);
  assert.equal(decodeURIComponent(reads[0].url).includes(OWNER_CODE), false);

  // 응답 본문에 대표님 계정의 흔적이 한 글자도 없어야 한다. 카탈로그(이름·색·
  // 표시 여부)는 이 표면이 아예 싣지 않으므로 여기서 함께 고정한다.
  for (const forbidden of ["owner@example.com", OWNER_CALENDAR, OWNER_CODE, "rt-owner", "calendars", "colorId"]) {
    assert.equal(text.includes(forbidden), false, `대표님 계정 정보가 새어 나갔습니다: ${forbidden}`);
  }
});

test("[N6] 광고주 개인 구글 캘린더 상태도 자기 계정 연동만 읽는다", async () => {
  const { response, calls } = await callGoogleHandler(
    miRequest(PERSONAL_GOOGLE_CALENDAR_PATH, { session: "clientA" }),
    [
      ...restRoutesFor({
        clients: [clientRow(CLIENT_A), clientRow(CLIENT_B)],
        owner_google_integrations: INTEGRATION_ROWS,
      }),
    ],
  );
  const text = await response.text();
  const payload = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(payload.googleEmail, "client-a@example.com");
  assert.equal(payload.role, "client");
  // 캘린더 생성·참가자 초대는 owner·team 만 (설계 §7.3).
  assert.equal(payload.canManageCalendars, false);

  const reads = integrationReads(calls);
  assert.equal(reads.length, 1);
  assert.equal(decodeURIComponent(reads[0].url).includes(`owner_agency_code=eq.${CLIENT_A_KEY}`), true);
  for (const forbidden of ["owner@example.com", "team-a@example.com", OWNER_CODE, TEAM_A_KEY, "rt-owner"]) {
    assert.equal(text.includes(forbidden), false, `남의 계정 정보가 새어 나갔습니다: ${forbidden}`);
  }
});

test("[N7] 운영팀 sync 는 mi_claim_google_sync_slot 을 team:<uuid> 로 선점한다", async () => {
  const slotCalls = [];
  const { response, calls } = await callGoogleHandler(
    miRequest(PERSONAL_GOOGLE_CALENDAR_PATH, {
      method: "POST",
      session: "teamA",
      body: { action: "sync" },
    }),
    [
      ["POST", SYNC_SLOT_RPC_URL, (call) => {
        slotCalls.push(JSON.parse(String(call.body)));
        return restJson([{ owner_agency_code: TEAM_A_KEY }]);
      }],
      ...restRoutesFor({
        operation_team_codes: [teamRow(TEAM_A)],
        owner_google_integrations: INTEGRATION_ROWS,
      }),
    ],
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(slotCalls.length, 1);
  assert.equal(slotCalls[0].p_owner_agency_code, TEAM_A_KEY);
  assert.notEqual(slotCalls[0].p_owner_agency_code, OWNER_CODE);

  // runOwnerCalendarSync 가 같은 키로 실행됐다는 증거는 그 함수가 곧바로 읽는
  // 연동 행이다. 운영팀 연동은 needs_reconnect 라 그 지점에서 되돌아 나온다.
  assert.equal(payload.needsReconnect, true);
  const reads = integrationReads(calls);
  assert.equal(reads.length >= 1, true);
  for (const read of reads) {
    const decoded = decodeURIComponent(read.url);
    assert.equal(decoded.includes(`owner_agency_code=eq.${TEAM_A_KEY}`), true);
    assert.equal(decoded.includes(`owner_agency_code=eq.${OWNER_CODE}`), false);
  }
});

// ─────────────────────────────────────────────────────────────
// N8 · N9 · N10 — OAuth state 는 서명 안에서만 의미를 가진다
// ─────────────────────────────────────────────────────────────
function statePayload(state) {
  return JSON.parse(Buffer.from(String(state).split(".")[0], "base64url").toString("utf8"));
}

// 서명은 그대로 두고 페이로드만 바꾼다 = 1비트 변조.
function tamperedState(state, patch) {
  const signature = String(state).split(".")[1];
  const encoded = Buffer.from(JSON.stringify({ ...statePayload(state), ...patch }), "utf8").toString("base64url");
  return `${encoded}.${signature}`;
}

// 우리 서버가 옛 판본에서 발급했을 법한 state 를 그대로 만든다(r 필드 없음).
function legacySignedState(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", GOOGLE_ENV.GOOGLE_OAUTH_CLIENT_SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function callbackUrl(state) {
  return `${OAUTH_CALLBACK_URL}?code=auth-1&state=${encodeURIComponent(state)}`;
}

function callbackRequest(state) {
  return new Request(callbackUrl(state), {
    headers: { cookie: `${NONCE_COOKIE}=${oauthStateNonce(state)}` },
  });
}

test("[N8] 콜백 분기는 서명된 p 로만 갈리고 r·owner 를 1비트 바꾸면 검증이 실패한다", () => {
  const calendarState = signOauthState(OWNER_CODE, GOOGLE_ENV, Date.now(), "calendar", "owner");
  const linkState = signOauthState(OWNER_CODE, GOOGLE_ENV, Date.now(), "link", "owner");

  assert.equal(verifyOauthState(calendarState, GOOGLE_ENV).p, "calendar");
  assert.equal(verifyOauthState(linkState, GOOGLE_ENV).p, "link");

  // p 를 바꿔 끼우려는 순간 서명이 깨진다 — 분기 자체가 성립하지 않는다.
  assert.equal(verifyOauthState(tamperedState(calendarState, { p: "link" }), GOOGLE_ENV), null);
  assert.equal(verifyOauthState(tamperedState(linkState, { p: "calendar" }), GOOGLE_ENV), null);
  // r 과 owner 도 마찬가지다.
  assert.equal(verifyOauthState(tamperedState(calendarState, { r: "team" }), GOOGLE_ENV), null);
  assert.equal(verifyOauthState(tamperedState(calendarState, { owner: TEAM_A.id }), GOOGLE_ENV), null);
});

test("[N8] 역할을 위조한 state 는 서명이 맞아도 연동을 완성하지 못한다", async () => {
  // 알 수 없는 역할은 우리 서버가 서명했더라도 verify 단계에서 끝난다.
  for (const rogueRole of ["admin", "super", "operator"]) {
    const rogue = signOauthState(TEAM_A.id, GOOGLE_ENV, Date.now(), "calendar", rogueRole);
    assert.equal(verifyOauthState(rogue, GOOGLE_ENV), null, `알 수 없는 역할이 통과했습니다: ${rogueRole}`);
  }

  // r 은 owner 인데 owner 가 운영팀 uuid 인 state. 서명은 정상이지만 대표님
  // 코드가 아니므로 activePersonalPrincipal 이 거절한다.
  const forged = signOauthState(TEAM_A.id, GOOGLE_ENV, Date.now(), "calendar", "owner");
  assert.equal(verifyOauthState(forged, GOOGLE_ENV).r, "owner");

  const { response, calls } = await callGoogleHandler(callbackRequest(forged), [
    ["POST", RATE_RPC_URL, () => restJson([{ allowed: true, retry_after: 0 }])],
    ...restRoutesFor({ owner_google_integrations: INTEGRATION_ROWS }),
  ]);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin?gcal=invalid#mi-admin-owner-assistant");
  assert.deepEqual(integrationWrites(calls), []);
});

test("[N9] r 이 없는 옛 state 는 owner 로 읽히고 대표님 코드가 아니면 거절된다", async () => {
  const legacy = legacySignedState({
    owner: TEAM_A.code,
    p: "calendar",
    exp: Date.now() + 10 * 60 * 1000,
    nonce: "legacy-nonce-1",
  });
  const verified = verifyOauthState(legacy, GOOGLE_ENV);
  assert.equal(verified.r, "owner");
  assert.equal(verified.owner, TEAM_A.code);

  const { response, calls } = await callGoogleHandler(callbackRequest(legacy), [
    ["POST", RATE_RPC_URL, () => restJson([{ allowed: true, retry_after: 0 }])],
    ...restRoutesFor({
      operation_team_codes: [teamRow(TEAM_A)],
      owner_google_integrations: INTEGRATION_ROWS,
    }),
  ]);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin?gcal=invalid#mi-admin-owner-assistant");
  assert.deepEqual(integrationWrites(calls), []);
});

test("[N10] 해지된 운영팀·연결 해제된 광고주는 콜백을 완주하지 못한다", async (t) => {
  await t.test("해지된 운영팀 (calendar 목적)", async () => {
    const revoked = signOauthState(TEAM_A.id, GOOGLE_ENV, Date.now(), "calendar", "team");
    const { response, calls } = await callGoogleHandler(callbackRequest(revoked), [
      ["POST", RATE_RPC_URL, () => restJson([{ allowed: true, retry_after: 0 }])],
      // 해지된 팀은 status=active 조회에서 사라진다.
      ...restRoutesFor({
        operation_team_codes: [],
        owner_google_integrations: INTEGRATION_ROWS,
      }),
    ]);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/admin?gcal=invalid");
    assert.deepEqual(integrationWrites(calls), []);
  });

  await t.test("연결 해제된 광고주 (link 목적)", async () => {
    const disconnected = signOauthState(CLIENT_B.agencyCode, GOOGLE_ENV, Date.now(), "link", "client");
    const identityWrites = [];
    const { response, calls } = await callGoogleHandler(callbackRequest(disconnected), [
      ["POST", RATE_RPC_URL, () => restJson([{ allowed: true, retry_after: 0 }])],
      ["POST", `${REST_BASE}/audit_logs`, () => new Response(null, { status: 201 })],
      ...["POST", "PATCH", "DELETE"].map((method) => [method, `${REST_BASE}/login_identities`, (call) => {
        identityWrites.push(call.url);
        return restJson([]);
      }]),
      ...restRoutesFor({
        clients: [],
        login_identities: [],
        owner_google_integrations: INTEGRATION_ROWS,
      }),
    ]);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/client?glogin=inactive");
    assert.deepEqual(identityWrites, []);
    assert.deepEqual(integrationWrites(calls), []);
  });
});

// ─────────────────────────────────────────────────────────────
// N12 — 운영팀 키와 그 팀이 맡은 광고주 키는 절대 같지 않다
// ─────────────────────────────────────────────────────────────
test("[N12] 운영팀 개인키는 x-mi-agency-code 가 아니라 팀 uuid 에서만 나온다", async () => {
  resetOptionalColumns();
  assert.notEqual(personalPrincipalKey("team", TEAM_A.id), personalPrincipalKey("client", CLIENT_A.id));

  // 광고주 A 를 맡은 운영팀 T. 세션에는 그 광고주 코드가 함께 실려 온다.
  const servingTeam = teamRow(TEAM_A, { client_id: CLIENT_A.id });
  const harness = tableCtx({
    operation_team_codes: rowsTable([servingTeam, teamRow(TEAM_B)]),
    clients: rowsTable([clientRow(CLIENT_A), clientRow(CLIENT_B)]),
    schedule_items: rowsTable(EVERY_ACCOUNT_ROWS),
  });

  const response = await handleWorkItemsRequest(personalRequest({
    session: "teamA",
    // 세션이 실어 보낸 광고주 코드를 그대로 흉내 낸다. 개인키 계산에 쓰이면 안 된다.
    headers: { "x-mi-agency-code": CLIENT_A.agencyCode },
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(itemIds(payload), ["row-team-a-personal"]);

  const selects = opsFor(harness.ops, "schedule_items", "select");
  assert.equal(selects.length, 1);
  const text = filterText(selects[0]);
  assert.equal(text.includes(TEAM_A_KEY), true);
  for (const forbidden of ["client:", CLIENT_A.id, CLIENT_A.agencyCode]) {
    assert.equal(text.includes(forbidden), false, `개인키가 광고주 좌표에서 나왔습니다: ${forbidden}`);
  }
  resetOptionalColumns();
});

// ─────────────────────────────────────────────────────────────
// N13 — 같은 공유 캘린더의 같은 이벤트를 두 계정이 각각 갖는다
// ─────────────────────────────────────────────────────────────
const ACCOUNT_KEYS_MIGRATION = new URL(
  "../../../supabase/migrations/20260826090100_personal_calendar_account_keys.sql",
  import.meta.url,
);

test("[N13] 같은 공유 캘린더의 같은 이벤트가 두 계정 공간에 각각 들어간다", () => {
  const event = {
    id: "shared-event-1",
    summary: "합동 미팅",
    start: { dateTime: "2026-09-10T10:00:00+09:00" },
    end: { dateTime: "2026-09-10T11:00:00+09:00" },
  };
  const teamRowFromEvent = mapGoogleEventToScheduleRow(event, {
    ownerCode: TEAM_A_KEY,
    calendarId: SHARED_CALENDAR,
    personalRole: "team",
    personalCode: TEAM_A.id,
  });
  const clientRowFromEvent = mapGoogleEventToScheduleRow(event, {
    ownerCode: CLIENT_A_KEY,
    calendarId: SHARED_CALENDAR,
    personalRole: "client",
    personalCode: CLIENT_A.id,
  });

  // 구글 좌표는 같다 — 옛 전역 유니크 인덱스라면 두 번째가 23505 로 죽는다.
  assert.equal(teamRowFromEvent.google_calendar_id, clientRowFromEvent.google_calendar_id);
  assert.equal(teamRowFromEvent.google_event_id, clientRowFromEvent.google_event_id);
  // 새 부분 유니크 인덱스의 키 앞 두 열이 다르므로 두 행이 함께 산다.
  assert.deepEqual(
    [teamRowFromEvent.personal_role, teamRowFromEvent.personal_code],
    ["team", TEAM_A.id],
  );
  assert.deepEqual(
    [clientRowFromEvent.personal_role, clientRowFromEvent.personal_code],
    ["client", CLIENT_A.id],
  );
  const indexKey = (row) => [
    row.personal_role || "",
    row.personal_code || "",
    row.google_calendar_id,
    row.google_event_id,
  ].join(" ");
  assert.notEqual(indexKey(teamRowFromEvent), indexKey(clientRowFromEvent));

  // 마이그레이션은 새 인덱스를 먼저 만들고 옛 인덱스를 나중에 지운다.
  // 순서가 뒤집히면 그 사이에 중복 방어가 없는 창이 생긴다.
  const migration = fs.readFileSync(ACCOUNT_KEYS_MIGRATION, "utf8");
  const created = migration.indexOf("uq_schedule_items_google_event_personal");
  const dropped = migration.indexOf("drop index if exists public.uq_schedule_items_google_event;");
  assert.ok(created >= 0, "새 부분 유니크 인덱스가 없습니다");
  assert.ok(dropped >= 0, "옛 인덱스 제거문이 없습니다");
  assert.ok(created < dropped, "새 인덱스는 옛 인덱스보다 먼저 만들어져야 합니다");
  for (const marker of [
    "coalesce(personal_role, '')",
    "coalesce(personal_code, '')",
    "google_calendar_id",
    "google_event_id",
  ]) {
    assert.equal(migration.includes(marker), true, `인덱스 키에 ${marker} 가 없습니다`);
  }
});

// ─────────────────────────────────────────────────────────────
// N14 — 대표실 전용 표면
// ─────────────────────────────────────────────────────────────
test("[N14] 대표실 전용 표면에는 schedule_items 읽기가 없고 대표님 운영 피드는 예전 그대로다", async () => {
  resetOptionalColumns();
  // owner-tool-api.mjs 는 schedule_items 를 한 번도 읽지 않는다. 읽는 곳이 생기면
  // 이 단언이 먼저 깨지고, 그때는 그 조회에도 개인 행 제외 술어를 달아야 한다.
  const ownerToolSource = fs.readFileSync(new URL("./owner-tool-api.mjs", import.meta.url), "utf8");
  assert.equal(ownerToolSource.includes("schedule_items"), false,
    "owner-tool-api.mjs 에 schedule_items 조회가 생겼습니다. 개인 행 제외 술어를 확인하세요.");

  // 그래서 대표님이 일정을 읽는 경로는 /api/work-items 하나이고, 그 결과는
  // 대표님 운영 행뿐이다 — 팀·광고주 개인 행은 0건이다.
  const harness = tableCtx({ schedule_items: rowsTable(EVERY_ACCOUNT_ROWS) });
  const response = await handleWorkItemsRequest(operationalRequest({ session: "owner" }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(itemIds(payload), ["row-owner-operational"]);
  assert.equal((payload.items || []).some((item) => String(item.id).includes("team")), false);
  assert.equal((payload.items || []).some((item) => String(item.id).includes("client")), false);
  resetOptionalColumns();
});

// ─────────────────────────────────────────────────────────────
// N15 · N16 — 개인 쓰기·삭제는 그 계정의 연동만 쓴다
// ─────────────────────────────────────────────────────────────
const TEAM_EVENTS_URL = `${CALENDAR_BASE}/calendars/${encodeURIComponent(TEAM_A_CALENDAR)}/events`;
const OWNER_EVENTS_URL = `${CALENDAR_BASE}/calendars/${encodeURIComponent(OWNER_CALENDAR)}/events`;

function personalDialogBody(overrides = {}) {
  return {
    title: "운영팀 개인 일정",
    scheduleType: "meeting",
    status: "planned",
    priority: "medium",
    startsAt: "2026-09-10T10:00:00+09:00",
    endsAt: "2026-09-10T11:00:00+09:00",
    googleCalendarId: TEAM_A_CALENDAR,
    sendUpdates: "none",
    ...overrides,
  };
}

test("[N15] 운영팀 개인 저장은 그 팀의 연동만 읽고 대표님 리프레시 토큰을 절대 쓰지 않는다", async () => {
  resetOptionalColumns();
  const harness = tableCtx({
    operation_team_codes: rowsTable([teamRow(TEAM_A), teamRow(TEAM_B)]),
    owner_google_integrations: rowsTable(INTEGRATION_ROWS),
    schedule_items: [{ data: [{ ...personalScheduleRow("team", TEAM_A.id), id: "row-new" }], error: null }],
    audit_logs: [{ error: null }],
  });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-team-a" }),
    [`POST ${TEAM_EVENTS_URL}`]: googleJson(200, { id: "evt-1", etag: '"e1"', htmlLink: "https://calendar.google.com/evt-1" }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(
    personalRequest({ method: "POST", session: "teamA", body: personalDialogBody() }),
    harness.ctx,
  ));
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);

  // 연동 조회는 오직 운영팀 키로만 나간다.
  const reads = opsFor(harness.ops, "owner_google_integrations", "select");
  assert.equal(reads.length >= 1, true);
  for (const read of reads) {
    assert.deepEqual(read.filters, [["eq", "owner_agency_code", TEAM_A_KEY]]);
  }

  // 어떤 구글 요청도 대표님 리프레시 토큰이나 대표님 캘린더를 싣지 않는다.
  for (const call of calls) {
    assert.equal(String(call.options?.body ?? "").includes("rt-owner"), false, "대표님 리프레시 토큰이 실렸습니다");
    assert.equal(call.url.startsWith(OWNER_EVENTS_URL), false, "대표님 캘린더로 요청이 나갔습니다");
  }
  assert.equal(calls.some((call) => String(call.options?.body ?? "").includes("rt-team-a")), true);

  // 저장문에는 서버가 세션에서 뽑은 개인 세 값이 그대로 실린다.
  const inserts = opsFor(harness.ops, "schedule_items", "insert");
  assert.equal(inserts.length, 1);
  const inserted = Array.isArray(inserts[0].values) ? inserts[0].values[0] : inserts[0].values;
  assert.equal(inserted.personal_role, "team");
  assert.equal(inserted.personal_code, TEAM_A.id);
  assert.equal(inserted.owner_agency_code, TEAM_A_KEY);
  resetOptionalColumns();
});

test("[N16] 운영팀 개인 삭제는 대표님 캘린더에 어떤 요청도 보내지 않는다", async () => {
  resetOptionalColumns();
  const teamPersonalRow = personalScheduleRow("team", TEAM_A.id, {
    id: "row-team-a-personal",
    google_calendar_id: TEAM_A_CALENDAR,
    google_event_id: "evt-1",
    google_etag: '"e1"',
  });
  const harness = tableCtx({
    operation_team_codes: rowsTable([teamRow(TEAM_A), teamRow(TEAM_B)]),
    owner_google_integrations: rowsTable(INTEGRATION_ROWS),
    schedule_items: [
      { data: teamPersonalRow, error: null },
      { data: { id: teamPersonalRow.id }, error: null },
    ],
    audit_logs: [{ error: null }, { error: null }],
  });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-team-a" }),
    [`DELETE ${TEAM_EVENTS_URL}/evt-1`]: googleJson(204, {}),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(
    personalRequest({
      method: "DELETE",
      session: "teamA",
      body: { id: teamPersonalRow.id, expectedUpdatedAt: teamPersonalRow.updated_at },
    }),
    harness.ctx,
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  // deleteRowFromGoogle 이 부른 연동은 운영팀 것 하나뿐이다.
  const reads = opsFor(harness.ops, "owner_google_integrations", "select");
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].filters, [["eq", "owner_agency_code", TEAM_A_KEY]]);

  // 대표님 캘린더로는 단 한 건도 나가지 않는다.
  assert.deepEqual(
    calls.filter((call) => call.method !== "POST").map((call) => `${call.method} ${call.url}`),
    [`DELETE ${TEAM_EVENTS_URL}/evt-1`],
  );
  for (const call of calls) {
    assert.equal(call.url.startsWith(OWNER_EVENTS_URL), false);
    assert.equal(String(call.options?.body ?? "").includes("rt-owner"), false);
  }
  resetOptionalColumns();
});

// ─────────────────────────────────────────────────────────────
// N17 — 개인 키는 본문으로 받지 않는다
// ─────────────────────────────────────────────────────────────
test("[N17] 개인 API 본문에 개인 키를 실으면 저장소를 건드리기 전에 400 이다", async (t) => {
  for (const key of ["personal_role", "personal_code", "owner_agency_code"]) {
    for (const method of ["POST", "PATCH"]) {
      await t.test(`${method} ${key}`, async () => {
        resetOptionalColumns();
        const harness = tableCtx({
          operation_team_codes: rowsTable([teamRow(TEAM_A)]),
          schedule_items: rowsTable(EVERY_ACCOUNT_ROWS),
        });
        const body = {
          ...personalDialogBody(),
          ...(method === "PATCH"
            ? { id: "row-team-a-personal", expectedUpdatedAt: "2026-09-01T00:00:00.000Z" }
            : {}),
          [key]: key === "personal_role" ? "owner" : OWNER_CODE,
        };

        const response = await handleWorkItemsRequest(
          personalRequest({ method, session: "teamA", body }),
          harness.ctx,
        );
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.match(payload.message, /허용되지 않은 값/u);
        // 계정 판정에 필요한 조회 외에 schedule_items 는 한 번도 열리지 않는다.
        assert.equal(harness.ops.some((op) => op.table === "schedule_items"), false);
        resetOptionalColumns();
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────
// 게이트 — /api/my/* 세 경로
//
// N11(브라우저가 자격 헤더를 직접 실어 보내는 위조)은
// src/server/session-gate.test.mjs 가 이미 고정한다. 여기서 중복하지 않는다.
// ─────────────────────────────────────────────────────────────
const PERSONAL_PATHS = [
  PERSONAL_WORK_ITEMS_PATH,
  PERSONAL_GOOGLE_CALENDAR_PATH,
  PERSONAL_GOOGLE_LOGIN_PATH,
];

test("[Gate] 광고주 미연결 운영팀 세션도 /api/my/* 세 경로를 통과한다", () => {
  const accountOnlyTeam = { role: "team", teamCode: TEAM_A.code, clientId: "", agencyCode: "" };
  for (const path of PERSONAL_PATHS) {
    assert.equal(sessionScopeAllowsPath(accountOnlyTeam, path), true, `${path} 가 막혔습니다`);
    assert.equal(roleAllowsPath("owner", path), true);
    assert.equal(roleAllowsPath("team", path), true);
    assert.equal(roleAllowsPath("client", path), true);
  }
  // 목록이 비어 있지 않다는 것을 반증으로 고정한다.
  assert.equal(sessionScopeAllowsPath(accountOnlyTeam, "/api/report-center"), false);

  // 대표실·관리 표면은 여전히 운영팀·광고주에게 닫혀 있다.
  for (const role of ["team", "client"]) {
    assert.equal(roleAllowsPath(role, "/api/owner/google-calendar"), false);
    assert.equal(roleAllowsPath(role, "/api/owner/tool"), false);
    assert.equal(roleAllowsPath(role, "/api/admin/schedule-items"), false);
  }
});

// ─────────────────────────────────────────────────────────────
// Fail-closed — 개인 열이 강등된 창
// ─────────────────────────────────────────────────────────────
test("[Fail-closed] 개인 열이 강등되면 개인 경로는 503 이고 운영 경로 필터는 배포 전 그대로다", async () => {
  resetOptionalColumns();
  try {
    setOptionalColumnClock(() => 1_000_000);
    const demoted = disableOptionalColumns(
      { code: "42703", message: 'column schedule_items.personal_role does not exist' },
      OPTIONAL_PERSONAL_COLUMNS,
    );
    assert.equal(demoted, true);

    const personal = tableCtx({
      operation_team_codes: rowsTable([teamRow(TEAM_A)]),
      schedule_items: rowsTable(EVERY_ACCOUNT_ROWS),
    });
    const blocked = await handleWorkItemsRequest(personalRequest({ session: "teamA" }), personal.ctx);
    const payload = await blocked.json();

    assert.equal(blocked.status, 503);
    assert.equal(payload.code, "personal_calendar_not_ready");
    // 격리해서 저장할 방법이 없으면 행을 한 건도 건드리지 않는다.
    assert.equal(personal.ops.some((op) => op.table === "schedule_items"), false);
    // 계정 판정 자체가 일어나지 않는다 — 열 확인이 그보다 먼저다.
    assert.equal(personal.ops.some((op) => op.table === "operation_team_codes"), false);

    const operational = tableCtx({ schedule_items: rowsTable(EVERY_ACCOUNT_ROWS) });
    const ok = await handleWorkItemsRequest(operationalRequest({ session: "owner" }), operational.ctx);
    assert.equal(ok.status, 200);

    const selects = opsFor(operational.ops, "schedule_items", "select");
    assert.equal(selects.length, 1);
    // 배포 전과 글자 하나 다르지 않다: personal_role 술어가 붙지 않는다.
    assert.deepEqual(selects[0].filters, [
      ["order", "starts_at", { ascending: true }],
      ["limit", 201],
      ["is", "calendar_id", null],
      ["eq", "owner_agency_code", OWNER_CODE],
    ]);
    assert.equal(selects[0].fields.includes("personal_role"), false);
  } finally {
    resetOptionalColumns();
  }
});

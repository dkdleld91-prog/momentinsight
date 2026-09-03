import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RANK_CHRONIC_ISOLATION_MS,
  RANK_NEVER_FOUND_MIN_CHECKS,
  RANK_PLACE_PARTIAL_MIN_RETRIES,
  RANK_RETRY_EXHAUSTED_AT,
  RANK_STUCK_TRACKER_MS,
} from "../naver-rank-requeue.mjs";
import handler, {
  adminRateConfiguration,
  auditActionLabel,
  auditLogQueryOptions,
  normalizeAgencyCode,
  teamActionAccess,
  teamActionPayload,
} from "./super-admin-api.mjs";

test("new advertiser and operation-team codes keep the six-character minimum", () => {
  assert.equal(normalizeAgencyCode("abc12"), "");
  assert.equal(normalizeAgencyCode("abc123"), "abc123");
});

test("admin rate configuration cannot be disabled by invalid environment values", () => {
  assert.deepEqual(adminRateConfiguration({
    MI_ADMIN_CODE_RATE_WINDOW_MS: "NaN",
    MI_ADMIN_CODE_RATE_LIMIT: "Infinity",
  }), { windowMs: 60_000, limit: 40 });
  assert.deepEqual(adminRateConfiguration({
    MI_ADMIN_CODE_RATE_WINDOW_MS: "120000",
    MI_ADMIN_CODE_RATE_LIMIT: "20",
  }), { windowMs: 120_000, limit: 20 });
});

test("team actions trust only the server-injected team header", () => {
  const request = new Request("https://insight.momentlabs.co.kr/api/team-agency-codes", {
    headers: { "x-mi-team-code": "mml93-t01" },
  });
  assert.deepEqual(teamActionAccess(request, { teamCode: "mml93-t99", targetTeamCode: "mml93-t98" }), {
    ok: true,
    teamCode: "mml93-t01",
    ownerTarget: false,
  });

  const browserBodyOnly = new Request("https://insight.momentlabs.co.kr/api/team-agency-codes");
  const rejected = teamActionAccess(browserBodyOnly, { teamCode: "mml93-t01" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 400);

  const wildcard = new Request("https://insight.momentlabs.co.kr/api/team-agency-codes", {
    headers: { "x-mi-team-code": "mml93-t__" },
  });
  assert.equal(teamActionAccess(wildcard, {}).ok, false);
});

test("only an authenticated owner may select a team by owner-only target code", () => {
  const previousSecret = process.env.MI_SUPER_ADMIN_CODE;
  const previousOwner = process.env.MI_PRIMARY_AGENCY_CODE;
  process.env.MI_SUPER_ADMIN_CODE = "server-only-super-secret";
  process.env.MI_PRIMARY_AGENCY_CODE = "mml93-a01";
  try {
    const ownerRequest = new Request("https://insight.momentlabs.co.kr/api/team-agency-codes", {
      headers: {
        "x-mi-super-admin-code": "server-only-super-secret",
        "x-mi-owner-agency-code": "mml93-a01",
      },
    });
    assert.deepEqual(teamActionAccess(ownerRequest, { targetTeamCode: "mml93-t01" }), {
      ok: true,
      teamCode: "mml93-t01",
      ownerTarget: true,
    });
    const rawOwnerCode = teamActionAccess(ownerRequest, { teamCode: "mml93-t01" });
    assert.equal(rawOwnerCode.ok, false);
    assert.equal(rawOwnerCode.status, 400);

    const teamRequest = new Request("https://insight.momentlabs.co.kr/api/team-agency-codes", {
      headers: { "x-mi-team-code": "mml93-t01" },
    });
    assert.deepEqual(teamActionAccess(teamRequest, { targetTeamCode: "mml93-t99" }), {
      ok: true,
      teamCode: "mml93-t01",
      ownerTarget: false,
    });
  } finally {
    if (previousSecret === undefined) delete process.env.MI_SUPER_ADMIN_CODE;
    else process.env.MI_SUPER_ADMIN_CODE = previousSecret;
    if (previousOwner === undefined) delete process.env.MI_PRIMARY_AGENCY_CODE;
    else process.env.MI_PRIMARY_AGENCY_CODE = previousOwner;
  }
});

test("team action responses omit credential-like team code fields", () => {
  const row = {
    id: "team-1",
    owner_agency_code: "mml93-a01",
    team_name: "운영팀 1",
    team_code: "mml93-t01",
    status: "active",
    client_id: "client-1",
    clients: {
      id: "client-1",
      name: "광고주 1",
      agency_code: "mml93-a02",
      issued_by_team_code: "mml93-t01",
      status: "active",
    },
  };

  const teamVisible = teamActionPayload(row, { ownerTarget: false });
  assert.equal("teamCode" in teamVisible, false);
  assert.equal("agencyCode" in teamVisible.client, false);
  assert.equal("issuedByTeamCode" in teamVisible.client, false);

  const ownerVisible = teamActionPayload(row, { ownerTarget: true });
  assert.equal(ownerVisible.teamCode, "mml93-t01");
  assert.equal(ownerVisible.client.issuedByTeamCode, "mml93-t01");
});

test("team creation never reactivates or reveals an existing client", async () => {
  const source = await readFile(new URL("./super-admin-api.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function createClientForTeam");
  const end = source.indexOf("async function disconnectTeamClient", start);
  const block = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(block, /if \(existing\.data\)[\s\S]*사용할 수 없는 광고주 코드입니다/);
  assert.doesNotMatch(block, /client\.reactivated_by_team/);
  assert.doesNotMatch(block, /Reissued by authenticated operation team/);
  assert.doesNotMatch(block, /client:\s*clientPayload\(existing\.data\)/);
  assert.match(block, /TEAM_CLIENT_LINK_CONFLICT/);
  assert.match(block, /\.from\("clients"\)[\s\S]*\.delete\(\)[\s\S]*\.eq\("id", client\.id\)/);
});

test("advertiser codes are never suggested or generated from an empty request", async () => {
  const serverSource = await readFile(new URL("./super-admin-api.mjs", import.meta.url), "utf8");
  const adminSource = await readFile(new URL("../../pages/admin.html", import.meta.url), "utf8");
  const ownerStart = serverSource.indexOf("async function createClient(request");
  const ownerEnd = serverSource.indexOf("async function createTeam", ownerStart);
  const teamStart = serverSource.indexOf("async function createClientForTeam");
  const teamEnd = serverSource.indexOf("async function disconnectTeamClient", teamStart);
  const validateStart = serverSource.indexOf("async function validateTeam");
  const validateEnd = serverSource.indexOf("async function createClientForTeam", validateStart);
  const defaultsStart = adminSource.indexOf("function syncOwnerCodeDefaults");
  const defaultsEnd = adminSource.indexOf("function activeOwnerClients", defaultsStart);
  const operationStart = adminSource.indexOf("function renderOperationTeamCodePanel");
  const operationEnd = adminSource.indexOf("async function refreshOperationTeamPanel", operationStart);

  for (const index of [ownerStart, ownerEnd, teamStart, teamEnd, validateStart, validateEnd, defaultsStart, defaultsEnd, operationStart, operationEnd]) {
    assert.notEqual(index, -1);
  }

  const ownerBlock = serverSource.slice(ownerStart, ownerEnd);
  const teamBlock = serverSource.slice(teamStart, teamEnd);
  const validateBlock = serverSource.slice(validateStart, validateEnd);
  const defaultsBlock = adminSource.slice(defaultsStart, defaultsEnd);
  const operationBlock = adminSource.slice(operationStart, operationEnd);

  assert.match(ownerBlock, /if \(!agencyCode\) return json\([^;]*생성할 광고주 코드를 직접 입력해주세요\./);
  assert.match(teamBlock, /if \(!agencyCode\) return json\([^;]*생성할 광고주 코드를 직접 입력해주세요\./);
  assert.doesNotMatch(serverSource, /function nextAgencyCode\(/);
  assert.doesNotMatch(serverSource, /nextAgencyCode:/);
  assert.doesNotMatch(validateBlock, /nextAgencyCode|nextAgencyCodeFromDb/);
  assert.doesNotMatch(defaultsBlock, /clientCodeInput|nextAgencyCode/);
  assert.doesNotMatch(operationBlock, /clientCodeInput\.value\s*=\s*payload\.nextAgencyCode/);
  assert.match(adminSource, /data-team-client-agency-code[^>]*placeholder="광고주 코드 직접 입력"[^>]*autocomplete="off"/);
});

test("operation-team codes are never suggested or generated from an empty request", async () => {
  const serverSource = await readFile(new URL("./super-admin-api.mjs", import.meta.url), "utf8");
  const adminSource = await readFile(new URL("../../pages/admin.html", import.meta.url), "utf8");
  const createStart = serverSource.indexOf("async function createTeam(request");
  const createEnd = serverSource.indexOf("async function revokeClient", createStart);
  const defaultsStart = adminSource.indexOf("function syncOwnerCodeDefaults");
  const defaultsEnd = adminSource.indexOf("function activeOwnerClients", defaultsStart);

  for (const index of [createStart, createEnd, defaultsStart, defaultsEnd]) {
    assert.notEqual(index, -1);
  }

  const createBlock = serverSource.slice(createStart, createEnd);
  const defaultsBlock = adminSource.slice(defaultsStart, defaultsEnd);

  assert.match(createBlock, /if \(!teamCode\) return json\([^;]*생성할 운영팀 코드를 직접 입력해주세요\./);
  assert.doesNotMatch(serverSource, /function nextTeamCode\(/);
  assert.doesNotMatch(serverSource, /nextTeamCode:/);
  assert.doesNotMatch(defaultsBlock, /teamCreateInput|nextTeamCode/);
  assert.match(adminSource, /data-owner-team-code[^>]*placeholder="6자리 이상 직접 입력"[^>]*autocomplete="off"/);
});

test("admin team requests do not serialize raw team codes", async () => {
  const source = await readFile(new URL("../../pages/admin.html", import.meta.url), "utf8");
  const start = source.indexOf("async function requestTeamCodes");
  const end = source.indexOf("function reportTypeLabel", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const requestSource = source.slice(start, end);

  assert.doesNotMatch(requestSource, /["']x-mi-team-code["']/);
  assert.match(requestSource, /delete requestBody\.teamCode/);
  assert.match(requestSource, /secureSession\.role === "owner"/);
  assert.match(requestSource, /requestBody\.targetTeamCode = code/);
  assert.match(source, /secureSession\.scopeKey = String\(session\.scopeKey \|\| ""\)/);
  assert.doesNotMatch(source, /secureSession\.accountLabel/);
  assert.doesNotMatch(source, /teamCode:\s*session\.accountLabel/);
  assert.doesNotMatch(source, /requestTeamCodes\("POST",\s*currentOperationTeam\.teamCode/);

  const publishStart = source.indexOf("async function publishReportCenterRecord");
  const publishEnd = source.indexOf("function getClientPublicStateApiUrl", publishStart);
  assert.notEqual(publishStart, -1);
  assert.notEqual(publishEnd, -1);
  assert.doesNotMatch(source.slice(publishStart, publishEnd), /["']x-mi-team-code["']/);
});

test("operation team sessions resynchronize after advertiser link changes", async () => {
  const source = await readFile(new URL("../../pages/admin.html", import.meta.url), "utf8");
  const syncStart = source.indexOf("async function synchronizeOperationTeamSession");
  const syncEnd = source.indexOf("async function activateAdminSession", syncStart);
  const createStart = source.indexOf('var teamClientButton = root.querySelector("[data-team-client-create]")');
  const createEnd = source.indexOf('var ownerRefreshButton = root.querySelector("[data-owner-code-refresh]")', createStart);
  const disconnectStart = source.indexOf('root.addEventListener("click", async function (event)');
  const disconnectEnd = source.indexOf('var codeSaveButton = root.querySelector("[data-admin-code-save]")', disconnectStart);

  for (const index of [syncStart, syncEnd, createStart, createEnd, disconnectStart, disconnectEnd]) {
    assert.notEqual(index, -1);
  }

  const syncBlock = source.slice(syncStart, syncEnd);
  const createBlock = source.slice(createStart, createEnd);
  const disconnectBlock = source.slice(disconnectStart, disconnectEnd);
  assert.match(syncBlock, /restoreSecureSession\(\)/);
  assert.match(syncBlock, /applySecureSession\(payload\)/);
  assert.match(syncBlock, /mi:rank-scope-changed/);
  assert.match(syncBlock, /mi:rank-auth-ready/);
  assert.match(createBlock, /synchronizeOperationTeamSession/);
  assert.match(disconnectBlock, /synchronizeOperationTeamSession/);
  assert.match(source, /운영팀 단독 모드가 열렸습니다/);
  assert.match(source, /광고주 없이 운영팀 단독 사용이 가능합니다/);
});

// ─────────────────────────────────────────────────────────────
// 운영 이력(GET ?view=audit-logs) 하니스
//
// 핸들러가 withSupabase 로 감싸여 있어 ctx 를 직접 주입할 수 없다. 그래서
// google-calendar-api.test.mjs 와 같은 방식으로 가짜 SUPABASE_URL 을 넣고
// globalThis.fetch 를 가로채, PostgREST 로 나가는 질의문 자체를 확인한다.
// 요청 URL 은 localhost 라 isLocalRequest 가 참이 되고 코드 관리 속도 제한을
// 타지 않는다.
// ─────────────────────────────────────────────────────────────
const SUPER_ADMIN_TEST_CODE = "server-only-super-secret";
const OWNER_AGENCY_TEST_CODE = "mml93-a01";
const SUPABASE_TEST_URL = "http://supabase.test";
const AUDIT_REST_URL = `${SUPABASE_TEST_URL}/rest/v1/audit_logs`;
const SUPER_ADMIN_API_URL = "http://localhost:8784/api/super-admin/agency-codes";
const AUDIT_HANDLER_ENV = {
  SUPABASE_URL: SUPABASE_TEST_URL,
  SUPABASE_PUBLISHABLE_KEY: "pub-test",
  SUPABASE_PUBLISHABLE_KEYS: undefined,
  SUPABASE_SECRET_KEY: "secret-test",
  SUPABASE_SECRET_KEYS: undefined,
  MI_SUPER_ADMIN_CODE: SUPER_ADMIN_TEST_CODE,
  MI_PRIMARY_AGENCY_CODE: OWNER_AGENCY_TEST_CODE,
  NODE_ENV: undefined,
  VERCEL_ENV: undefined,
};

async function withEnv(overrides, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
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

async function withGlobalFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function auditRestStub(rows) {
  const queries = [];
  const impl = async (input) => {
    const rawUrl = typeof input === "string" ? input : String(input.url);
    if (!rawUrl.startsWith(AUDIT_REST_URL)) throw new Error(`unexpected fetch: ${rawUrl}`);
    queries.push(new URL(rawUrl));
    return Response.json(rows);
  };
  return { queries, impl };
}

function auditRow(action, createdAt, overrides = {}) {
  return {
    action,
    target_table: "clients",
    metadata: { source: "super-admin-api" },
    created_at: createdAt,
    ...overrides,
  };
}

function auditLogRequest(query, headers = {
  "x-mi-super-admin-code": SUPER_ADMIN_TEST_CODE,
  "x-mi-owner-agency-code": OWNER_AGENCY_TEST_CODE,
}) {
  return new Request(`${SUPER_ADMIN_API_URL}?${query}`, { headers });
}

test("운영 이력 동작 이름은 아는 값·동적 접미사만 우리말로 바꾼다", () => {
  assert.equal(auditActionLabel("client.created_by_owner"), "광고주 생성(총관리자)");
  assert.equal(auditActionLabel("work_item_completed_by_assistant"), "실장 비서 일정 완료");
  assert.equal(auditActionLabel("reports.updated"), "reports 수정");
  assert.equal(auditActionLabel("files.created"), "files 생성");
  assert.equal(auditActionLabel("schedule_items.deleted"), "schedule_items 삭제");
  assert.equal(auditActionLabel("something.unknown"), null);
  assert.equal(auditActionLabel("totally_unknown_action"), null);
  assert.equal(auditActionLabel(""), null);
  assert.equal(auditActionLabel(undefined), null);
  // 프로토타입 속성이 이름으로 새어 나오면 안 된다.
  assert.equal(auditActionLabel("constructor"), null);
});

test("운영 이력 질의 옵션은 개수를 묶고 이상한 값은 버린다", () => {
  const base = `${SUPER_ADMIN_API_URL}?view=audit-logs`;
  assert.deepEqual(auditLogQueryOptions(new URL(base)), { action: null, limit: 50, before: null });
  assert.equal(auditLogQueryOptions(new URL(`${base}&limit=500`)).limit, 50);
  assert.equal(auditLogQueryOptions(new URL(`${base}&limit=0`)).limit, 50);
  assert.equal(auditLogQueryOptions(new URL(`${base}&limit=-3`)).limit, 1);
  assert.equal(auditLogQueryOptions(new URL(`${base}&limit=abc`)).limit, 50);
  assert.equal(auditLogQueryOptions(new URL(`${base}&limit=20`)).limit, 20);

  assert.equal(auditLogQueryOptions(new URL(`${base}&action=Client.Created`)).action, null);
  assert.equal(auditLogQueryOptions(new URL(`${base}&action=client'--`)).action, null);
  assert.equal(auditLogQueryOptions(new URL(`${base}&action=${"a".repeat(65)}`)).action, null);
  assert.equal(auditLogQueryOptions(new URL(`${base}&action=client.created_by_owner`)).action, "client.created_by_owner");

  assert.equal(auditLogQueryOptions(new URL(`${base}&before=yesterday`)).before, null);
  assert.equal(auditLogQueryOptions(new URL(`${base}&before=2026-08-26T00:00:00.000Z`)).before, "2026-08-26T00:00:00.000Z");

  assert.deepEqual(auditLogQueryOptions(new URL(`${base}&limit=10&action=work_item_updated&before=2026-08-26T00:00:00.000Z`)), {
    action: "work_item_updated",
    limit: 10,
    before: "2026-08-26T00:00:00.000Z",
  });
});

test("총관리자 운영 이력 조회는 네 개 열만 최신순 그대로 돌려준다", async () => {
  const rows = [
    auditRow("client.created_by_owner", "2026-08-26T03:00:00.000Z", {
      actor_id: "actor-1",
      client_id: "client-1",
      target_id: "client-1",
    }),
    auditRow("work_item_updated", "2026-08-26T02:00:00.000Z", { target_table: "work_items", metadata: null }),
    auditRow("client.created_by_owner", "2026-08-26T01:00:00.000Z"),
  ];
  const stub = auditRestStub(rows);
  const response = await withEnv(AUDIT_HANDLER_ENV, () => withGlobalFetch(
    stub.impl,
    () => handler.fetch(auditLogRequest("view=audit-logs&limit=10")),
  ));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.view, "audit-logs");

  assert.equal(payload.auditLogs.length, 3);
  assert.deepEqual(Object.keys(payload.auditLogs[0]), ["action", "actionLabel", "targetTable", "metadata", "createdAt"]);
  assert.deepEqual(payload.auditLogs.map((row) => row.createdAt), [
    "2026-08-26T03:00:00.000Z",
    "2026-08-26T02:00:00.000Z",
    "2026-08-26T01:00:00.000Z",
  ]);
  assert.equal(payload.auditLogs[0].actionLabel, "광고주 생성(총관리자)");
  assert.equal(payload.auditLogs[1].actionLabel, "일정 수정");
  assert.equal(payload.auditLogs[1].targetTable, "work_items");
  assert.deepEqual(payload.auditLogs[1].metadata, {});

  // 응답 어디에도 식별자 열이 붙어 나오면 안 된다.
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /actor_id|actorId|targetId|target_id/);
  assert.doesNotMatch(serialized, /"clientId"/);

  assert.deepEqual(payload.actionOptions, [
    { value: "client.created_by_owner", label: "광고주 생성(총관리자)" },
    { value: "work_item_updated", label: "일정 수정" },
  ]);
  assert.equal(payload.nextBefore, null);

  assert.equal(stub.queries.length, 1);
  const query = stub.queries[0];
  assert.equal(query.pathname, "/rest/v1/audit_logs");
  assert.equal(query.searchParams.get("select"), "action,target_table,metadata,created_at");
  assert.equal(query.searchParams.get("order"), "created_at.desc");
  assert.equal(query.searchParams.get("limit"), "10");
  assert.equal(query.searchParams.get("action"), null);
  assert.equal(query.searchParams.get("created_at"), null);
});

test("운영 이력이 요청 개수만큼 차면 다음 조회 기준을 함께 내려준다", async () => {
  const rows = [
    auditRow("operation_team.created", "2026-08-26T05:00:00.000Z", { target_table: "operation_team_codes" }),
    auditRow("operation_team.created", "2026-08-26T04:00:00.000Z", { target_table: "operation_team_codes" }),
  ];
  const stub = auditRestStub(rows);
  const response = await withEnv(AUDIT_HANDLER_ENV, () => withGlobalFetch(
    stub.impl,
    () => handler.fetch(auditLogRequest("view=audit-logs&limit=2&action=operation_team.created&before=2026-08-27T00:00:00.000Z")),
  ));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.nextBefore, "2026-08-26T04:00:00.000Z");
  assert.deepEqual(payload.actionOptions, [{ value: "operation_team.created", label: "운영팀 생성" }]);

  const query = stub.queries[0];
  assert.equal(query.searchParams.get("select"), "action,target_table,metadata,created_at");
  assert.equal(query.searchParams.get("limit"), "2");
  assert.equal(query.searchParams.get("action"), "eq.operation_team.created");
  assert.equal(query.searchParams.get("created_at"), "lt.2026-08-27T00:00:00.000Z");
});

test("운영 이력은 총관리자 코드가 어긋나면 조회 전에 막힌다", async () => {
  const stub = auditRestStub([]);

  const missingCode = await withEnv(AUDIT_HANDLER_ENV, () => withGlobalFetch(
    stub.impl,
    () => handler.fetch(auditLogRequest("view=audit-logs", { "x-mi-owner-agency-code": OWNER_AGENCY_TEST_CODE })),
  ));
  assert.equal(missingCode.status, 401);

  const wrongCode = await withEnv(AUDIT_HANDLER_ENV, () => withGlobalFetch(
    stub.impl,
    () => handler.fetch(auditLogRequest("view=audit-logs", {
      "x-mi-super-admin-code": "wrong-super-admin-code",
      "x-mi-owner-agency-code": OWNER_AGENCY_TEST_CODE,
    })),
  ));
  assert.equal(wrongCode.status, 401);

  const wrongOwner = await withEnv(AUDIT_HANDLER_ENV, () => withGlobalFetch(
    stub.impl,
    () => handler.fetch(auditLogRequest("view=audit-logs", {
      "x-mi-super-admin-code": SUPER_ADMIN_TEST_CODE,
      "x-mi-owner-agency-code": "mml93-a09",
    })),
  ));
  assert.equal(wrongOwner.status, 403);

  const teamSession = await withEnv(AUDIT_HANDLER_ENV, () => withGlobalFetch(
    stub.impl,
    () => handler.fetch(auditLogRequest("view=audit-logs", { "x-mi-team-code": "mml93-t01" })),
  ));
  assert.equal(teamSession.status, 401);

  // 거절된 요청은 audit_logs 를 한 번도 건드리지 않는다.
  assert.equal(stub.queries.length, 0);
});

// ─────────────────────────────────────────────────────────────
// 계정별 키워드 등록 한도 설정 (총관리자 전용)
// ─────────────────────────────────────────────────────────────
function rankKeywordLimitStub(options = {}) {
  const calls = [];
  const impl = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : String(input.url);
    const url = new URL(rawUrl);
    const method = String(init.method || "GET").toUpperCase();
    const bodyText = init.body ? String(init.body) : "";
    calls.push({ pathname: url.pathname, method, searchParams: url.searchParams, body: bodyText ? JSON.parse(bodyText) : null });

    if (url.pathname === "/rest/v1/audit_logs") return Response.json([], { status: 201 });
    if (url.pathname === "/rest/v1/clients") {
      if (options.clientError) {
        return Response.json(options.clientError, { status: options.clientErrorStatus || 400 });
      }
      return Response.json(options.clientRows || []);
    }
    if (url.pathname === "/rest/v1/operation_team_codes") {
      if (options.teamError) {
        return Response.json(options.teamError, { status: options.teamErrorStatus || 400 });
      }
      return Response.json(options.teamRows || []);
    }
    throw new Error(`unexpected fetch: ${rawUrl}`);
  };
  return { calls, impl };
}

function rankKeywordLimitRequest(body, headers = {
  "x-mi-super-admin-code": SUPER_ADMIN_TEST_CODE,
  "x-mi-owner-agency-code": OWNER_AGENCY_TEST_CODE,
}) {
  return new Request(SUPER_ADMIN_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ action: "set-rank-keyword-limit", ...body }),
  });
}

async function setRankKeywordLimit(body, options = {}, headers) {
  const stub = rankKeywordLimitStub(options);
  const response = await withEnv(AUDIT_HANDLER_ENV, () => withGlobalFetch(
    stub.impl,
    () => handler.fetch(rankKeywordLimitRequest(body, headers)),
  ));
  return { stub, response, payload: await response.json() };
}

const QUOTA_CLIENT_ROW = {
  id: "client-quota-1",
  name: "한도 시험 광고주",
  business_name: "한도 시험",
  agency_code: "mml93-c07",
  status: "active",
  issued_by_team_code: null,
  disconnected_at: null,
  public_summary: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-28T00:00:00.000Z",
  rank_keyword_limit: 200,
};

test("키워드 한도 설정은 총관리자 코드 없이는 손도 못 댄다", async () => {
  const missingCode = await setRankKeywordLimit(
    { agencyCode: "mml93-c07", rankKeywordLimit: 200 },
    { clientRows: [QUOTA_CLIENT_ROW] },
    { "x-mi-owner-agency-code": OWNER_AGENCY_TEST_CODE },
  );
  assert.equal(missingCode.response.status, 401);
  assert.equal(missingCode.stub.calls.length, 0);

  // 총관리자 코드는 맞지만 총관리자 대행사가 아니면 여기서 끝난다.
  const nonOwner = await setRankKeywordLimit(
    { agencyCode: "mml93-c07", rankKeywordLimit: 200 },
    { clientRows: [QUOTA_CLIENT_ROW] },
    { "x-mi-super-admin-code": SUPER_ADMIN_TEST_CODE, "x-mi-owner-agency-code": "mml93-c07" },
  );
  assert.equal(nonOwner.response.status, 403);
  assert.equal(nonOwner.stub.calls.length, 0);
});

test("총관리자 코드 자신에게는 한도를 매기지 않는다", async () => {
  const result = await setRankKeywordLimit({ agencyCode: OWNER_AGENCY_TEST_CODE, rankKeywordLimit: 10 });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.message, "총관리자 코드는 한도 없이 사용합니다.");
  assert.equal(result.stub.calls.length, 0);

  const missingTarget = await setRankKeywordLimit({ rankKeywordLimit: 10 });
  assert.equal(missingTarget.response.status, 400);
  assert.equal(missingTarget.payload.message, "한도를 지정할 코드를 입력해주세요.");
});

test("범위를 벗어난 한도는 저장 전에 되돌려 보낸다", async () => {
  for (const bad of [1001, 0, -1, "열개"]) {
    const result = await setRankKeywordLimit({ agencyCode: "mml93-c07", rankKeywordLimit: bad });
    assert.equal(result.response.status, 400, String(bad));
    assert.equal(result.payload.message, "키워드 한도는 1~1000 사이 숫자로 입력해주세요.");
    assert.equal(result.stub.calls.length, 0);
  }
});

test("광고주 코드의 한도를 저장하면 계정 목록과 운영 이력에 함께 남는다", async () => {
  const result = await setRankKeywordLimit(
    { agencyCode: "mml93-c07", rankKeywordLimit: 200 },
    { clientRows: [QUOTA_CLIENT_ROW] },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.message, "키워드 한도를 200개로 저장했습니다.");
  assert.equal(result.payload.client.rankKeywordLimit, 200);
  assert.equal(result.payload.auditLogged, true);

  const update = result.stub.calls.find((call) => call.pathname === "/rest/v1/clients");
  assert.equal(update.method, "PATCH");
  assert.deepEqual(update.body, { rank_keyword_limit: 200 });
  assert.equal(update.searchParams.get("agency_code"), "eq.mml93-c07");

  const audit = result.stub.calls.find((call) => call.pathname === "/rest/v1/audit_logs");
  assert.equal(audit.body.action, "client.rank_keyword_limit_updated");
  assert.equal(audit.body.target_table, "clients");
  assert.equal(auditActionLabel("client.rank_keyword_limit_updated"), "광고주 키워드 한도 변경");
  assert.equal(auditActionLabel("team.rank_keyword_limit_updated"), "운영팀 키워드 한도 변경");
});

test("빈 값은 기본값 50 으로 되돌리는 뜻이라 컬럼을 비운다", async () => {
  for (const blank of ["", null]) {
    const result = await setRankKeywordLimit(
      { agencyCode: "mml93-c07", rankKeywordLimit: blank },
      { clientRows: [{ ...QUOTA_CLIENT_ROW, rank_keyword_limit: null }] },
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.message, "키워드 한도를 기본값 50개로 되돌렸습니다.");
    assert.equal(result.payload.client.rankKeywordLimit, null);
    const update = result.stub.calls.find((call) => call.pathname === "/rest/v1/clients");
    assert.deepEqual(update.body, { rank_keyword_limit: null });
  }
});

test("광고주 행이 없으면 운영팀 코드를 보고, 그것도 없으면 404 다", async () => {
  const teamRow = {
    id: "team-quota-1",
    owner_agency_code: OWNER_AGENCY_TEST_CODE,
    team_name: "운영팀",
    team_code: "mml93-t02",
    status: "active",
    client_id: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    revoked_at: null,
    rank_keyword_limit: 300,
  };
  const team = await setRankKeywordLimit(
    { teamCode: "mml93-t02", rankKeywordLimit: 300 },
    { clientRows: [], teamRows: [teamRow] },
  );
  assert.equal(team.response.status, 200);
  assert.equal(team.payload.team.rankKeywordLimit, 300);
  assert.equal(team.payload.team.client, null);
  const teamAudit = team.stub.calls.find((call) => call.pathname === "/rest/v1/audit_logs");
  assert.equal(teamAudit.body.action, "team.rank_keyword_limit_updated");
  assert.equal(teamAudit.body.target_table, "operation_team_codes");

  const unknown = await setRankKeywordLimit(
    { agencyCode: "mml93-x99", rankKeywordLimit: 100 },
    { clientRows: [], teamRows: [] },
  );
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.payload.message, "등록된 광고주 코드나 운영팀 코드를 찾을 수 없습니다.");
});

test("컬럼이 아직 없는 DB 에서는 500 이 아니라 마이그레이션 대기라고 솔직히 알린다", async () => {
  const result = await setRankKeywordLimit(
    { agencyCode: "mml93-c07", rankKeywordLimit: 200 },
    {
      clientError: { code: "PGRST204", message: "Could not find the 'rank_keyword_limit' column of 'clients' in the schema cache" },
      clientErrorStatus: 400,
    },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.schemaPending, true);
  assert.equal(result.payload.code, "RANK_KEYWORD_LIMIT_SCHEMA_PENDING");
  assert.equal(
    result.payload.message,
    "키워드 한도 DB 마이그레이션 적용 전입니다. 마이그레이션을 적용한 뒤 다시 시도해주세요.",
  );
});

// ─────────────────────────────────────────────────────────────
// 계정 목록(GET) 열 사다리
//
// 배포가 마이그레이션보다 먼저 나가면 clients.rank_keyword_limit 하나만 없다.
// 그때 최소 열까지 한 번에 내려가면 이미 운영 DB 에 있는 issued_by_team_code /
// disconnected_at 까지 같이 떨어져서, 총관리자 화면이 운영팀 발급 광고주를
// '직접 발급' 으로 잘못 표시한다. 가짜 PostgREST 로 열이 없는 DB 를 흉내내
// 사다리 세 단이 각각 무엇을 지키는지 못박는다.
// ─────────────────────────────────────────────────────────────
const LIST_CLIENT_ROWS = [
  {
    id: "client-owner-1",
    name: "총관리자 직접 발급 광고주",
    business_name: "직접 발급 상호",
    agency_code: "mml93-c01",
    status: "active",
    issued_by_team_code: null,
    disconnected_at: null,
    public_summary: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    rank_keyword_limit: 120,
  },
  {
    id: "client-team-1",
    name: "운영팀 발급 광고주",
    business_name: "운영팀 발급 상호",
    agency_code: "mml93-c02",
    status: "active",
    issued_by_team_code: "mml93-t01",
    disconnected_at: "2026-08-20T00:00:00.000Z",
    public_summary: null,
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    rank_keyword_limit: null,
  },
];

// 요청한 열만 돌려주는 진짜 PostgREST 의 행동을 흉내낸다.
function projectClientRow(row, select) {
  const picked = {};
  for (const column of select.split(",").map((name) => name.trim()).filter(Boolean)) {
    if (column in row) picked[column] = row[column];
  }
  return picked;
}

function ownerListStub(options = {}) {
  const missing = options.missingClientColumns || [];
  const selects = [];
  const impl = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : String(input.url);
    const url = new URL(rawUrl);
    const method = String(init.method || "GET").toUpperCase();

    // 총관리자 요약 카운트는 HEAD 라 개수만 돌려주면 된다.
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
    }

    const select = url.searchParams.get("select") || "";
    if (url.pathname === "/rest/v1/clients") {
      selects.push(select);
      const absent = missing.find((column) => select.includes(column));
      if (absent) {
        return Response.json(
          { code: "42703", message: `column clients.${absent} does not exist`, details: null, hint: null },
          { status: 400 },
        );
      }
      return Response.json(LIST_CLIENT_ROWS.map((row) => projectClientRow(row, select)));
    }
    // 운영팀 목록은 늘 성공시킨다. schemaPending 이 오직 광고주 사다리에서만
    // 올라온다는 것을 보이기 위해서다.
    if (url.pathname === "/rest/v1/operation_team_codes") return Response.json([]);
    throw new Error(`unexpected fetch: ${rawUrl}`);
  };
  return { selects, impl };
}

async function listOwnerAccounts(options = {}) {
  const stub = ownerListStub(options);
  const response = await withEnv(AUDIT_HANDLER_ENV, () => withGlobalFetch(
    stub.impl,
    () => handler.fetch(new Request(SUPER_ADMIN_API_URL, {
      headers: {
        "x-mi-super-admin-code": SUPER_ADMIN_TEST_CODE,
        "x-mi-owner-agency-code": OWNER_AGENCY_TEST_CODE,
      },
    })),
  ));
  return { stub, response, payload: await response.json() };
}

test("마이그레이션이 끝난 DB 에서는 첫 단에서 한도까지 한 번에 읽는다", async () => {
  const result = await listOwnerAccounts();
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.ok, true);
  assert.ok(!result.payload.schemaPending);

  assert.equal(result.stub.selects.length, 1);
  assert.match(result.stub.selects[0], /rank_keyword_limit/);

  const [owner, team] = result.payload.clients;
  assert.equal(owner.rankKeywordLimit, 120);
  assert.equal(owner.issuedByTeamCode, null);
  assert.equal(team.issuedByTeamCode, "mml93-t01");
  assert.equal(team.disconnectedAt, "2026-08-20T00:00:00.000Z");
  assert.equal(team.rankKeywordLimit, null);
});

test("한도 열만 없는 배포 직후에도 운영팀 발급 표시는 그대로 살아 있다", async () => {
  const result = await listOwnerAccounts({ missingClientColumns: ["rank_keyword_limit"] });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.schemaPending, true);

  // 첫 단은 한도까지, 두 번째 단은 한도만 뺀 기존 전체 열이어야 한다.
  assert.equal(result.stub.selects.length, 2);
  assert.match(result.stub.selects[0], /rank_keyword_limit/);
  assert.doesNotMatch(result.stub.selects[1], /rank_keyword_limit/);
  assert.match(result.stub.selects[1], /issued_by_team_code/);
  assert.match(result.stub.selects[1], /disconnected_at/);

  const [owner, team] = result.payload.clients;
  assert.equal(owner.issuedByTeamCode, null);
  assert.equal(owner.rankKeywordLimit, null);
  // 이 한 줄이 이번 수정의 이유다. 여기가 undefined 로 오면 화면이
  // 운영팀 발급 광고주를 '직접 발급' 으로 잘못 표시한다.
  assert.equal(team.issuedByTeamCode, "mml93-t01");
  assert.equal(team.disconnectedAt, "2026-08-20T00:00:00.000Z");
  assert.equal(team.rankKeywordLimit, null);
});

test("운영팀 열까지 없는 옛 DB 는 마지막 단으로 내려가되 깨지지 않는다", async () => {
  const result = await listOwnerAccounts({
    missingClientColumns: ["rank_keyword_limit", "issued_by_team_code", "disconnected_at"],
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.schemaPending, true);

  assert.equal(result.stub.selects.length, 3);
  assert.doesNotMatch(result.stub.selects[2], /rank_keyword_limit|issued_by_team_code|disconnected_at/);

  assert.equal(result.payload.clients.length, 2);
  assert.equal(result.payload.clients[1].agencyCode, "mml93-c02");
  assert.equal(result.payload.clients[1].rankKeywordLimit, null);
});

// ─────────────────────────────────────────────────────────────
// 총관리자 요약 카운터 — neverFoundTrackers · stuckTrackers (C2 결함 E)
//
// chronicTrackers 와 같은 패턴이다: safeCount(HEAD · count=exact) 한 번, 실패는
// { count:null, error } 로 접히고 응답은 200 을 유지한다. 임계값은 서버 상수를 그대로
// 쓰므로 잔존 감사 스크립트·헬스 API 와 같은 행을 센다.
// ─────────────────────────────────────────────────────────────
const countResponse = (total) => new Response(null, { status: 200, headers: { "content-range": `*/${total}` } });

function ownerHealthStub(resolveCount) {
  const heads = [];
  const base = ownerListStub();
  const impl = async (input, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    if (method === "HEAD") {
      const url = new URL(typeof input === "string" ? input : String(input.url));
      heads.push(url);
      return resolveCount(url);
    }
    return base.impl(input, init);
  };
  return { heads, impl };
}

async function listOwnerAccountsWith(impl) {
  const response = await withEnv(AUDIT_HANDLER_ENV, () => withGlobalFetch(
    impl,
    () => handler.fetch(new Request(SUPER_ADMIN_API_URL, {
      headers: {
        "x-mi-super-admin-code": SUPER_ADMIN_TEST_CODE,
        "x-mi-owner-agency-code": OWNER_AGENCY_TEST_CODE,
      },
    })),
  ));
  return { response, payload: await response.json() };
}

const isProductTrackers = (url) => url.pathname === "/rest/v1/naver_rank_trackers";
const isNeverFoundQuery = (url) => isProductTrackers(url) && url.searchParams.has("check_count");
const isStuckQuery = (url) => isProductTrackers(url) && url.searchParams.has("or") && !url.searchParams.has("retry_count");
const isChronicQuery = (url) => isProductTrackers(url) && url.searchParams.has("or") && url.searchParams.has("retry_count");
// loadOwnerHealth 에서 플레이스 표를 보는 유일한 질의(F18, partial 반복).
const isPlacePartialQuery = (url) => url.pathname === "/rest/v1/naver_place_rank_trackers"
  && url.searchParams.get("last_error") === "is.null";

test("총관리자 요약에 neverFoundTrackers·stuckTrackers 가 chronicTrackers 와 같은 방식으로 실린다", async () => {
  const stub = ownerHealthStub((url) => {
    if (isNeverFoundQuery(url)) return countResponse(5);
    if (isStuckQuery(url)) return countResponse(2);
    if (isChronicQuery(url)) return countResponse(1);
    return countResponse(0);
  });
  const { response, payload } = await listOwnerAccountsWith(stub.impl);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  const health = payload.health;
  assert.deepEqual(health.chronicTrackers, { count: 1, error: null });
  assert.deepEqual(health.neverFoundTrackers, { count: 5, error: null });
  assert.deepEqual(health.stuckTrackers, { count: 2, error: null });
  // 기존 키·순서 뒤에 append 한다.
  assert.deepEqual(Object.keys(health), [
    "checkedAt",
    "activeClients",
    "activeTeams",
    "dueTrackers",
    "failedTrackers",
    "chronicTrackers",
    "neverFoundTrackers",
    "stuckTrackers",
    "placePartialTrackers",
    "sourceFiles",
    "publicReports",
  ]);

  // 질의 모양: 상품 표만, 각각 정확히 한 번.
  const neverFoundQueries = stub.heads.filter(isNeverFoundQuery);
  const stuckQueries = stub.heads.filter(isStuckQuery);
  assert.equal(neverFoundQueries.length, 1);
  assert.equal(stuckQueries.length, 1);
  // placePartial 질의 외에는 플레이스 표를 보지 않는다.
  assert.ok(stub.heads.every((url) => url.pathname !== "/rest/v1/naver_place_rank_trackers" || isPlacePartialQuery(url)));

  const [neverFound] = neverFoundQueries;
  assert.equal(neverFound.searchParams.get("status"), "eq.active");
  assert.equal(neverFound.searchParams.get("check_count"), `gte.${RANK_NEVER_FOUND_MIN_CHECKS}`);
  assert.equal(neverFound.searchParams.get("found_count"), "eq.0");
  assert.equal(neverFound.searchParams.has("last_error"), false);

  const [stuck] = stuckQueries;
  assert.equal(stuck.searchParams.get("status"), "eq.active");
  assert.equal(stuck.searchParams.get("last_error"), "not.is.null");
  assert.equal(stuck.searchParams.has("retry_count"), false, "재시도 소진과 무관하게 멈춘 추적기를 센다");
  const or = stuck.searchParams.get("or");
  assert.ok(or.includes("last_checked_at.lt."), or);
  assert.ok(or.includes("and(last_checked_at.is.null,created_at.lt."), or);
  // 컷오프는 checkedAt 에서 유도되므로 정확히 checkedAt - 36h 다(서버 상수와 값 일치).
  const expectedCutoff = new Date(Date.parse(health.checkedAt) - RANK_STUCK_TRACKER_MS).toISOString();
  const cutoffs = [...or.matchAll(/\.lt\.([0-9TZ:.\-]+)/g)].map((match) => match[1]);
  assert.deepEqual(cutoffs, [expectedCutoff, expectedCutoff]);
  // 만성 카운트의 컷오프(3일)와는 다른 값이어야 한다 — 두 집계가 같은 질의를 복사한 게 아니다.
  const chronicCutoff = new Date(Date.parse(health.checkedAt) - RANK_CHRONIC_ISOLATION_MS).toISOString();
  assert.notEqual(expectedCutoff, chronicCutoff);
  const [chronic] = stub.heads.filter(isChronicQuery);
  assert.equal(chronic.searchParams.get("retry_count"), `gte.${RANK_RETRY_EXHAUSTED_AT}`);
  assert.ok(chronic.searchParams.get("or").includes(chronicCutoff));
});

test("두 카운터의 조회 실패는 count:null·error 로 접히고 응답은 200 이다(fail-safe)", async () => {
  const stub = ownerHealthStub((url) => {
    if (isNeverFoundQuery(url) || isStuckQuery(url)) {
      return Response.json(
        { code: "42703", message: "column naver_rank_trackers.check_count does not exist", details: null, hint: null },
        { status: 400 },
      );
    }
    return countResponse(0);
  });
  const { response, payload } = await listOwnerAccountsWith(stub.impl);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.health.neverFoundTrackers.count, null);
  assert.match(String(payload.health.neverFoundTrackers.error), /does not exist/);
  assert.equal(payload.health.stuckTrackers.count, null);
  assert.match(String(payload.health.stuckTrackers.error), /does not exist/);
  // 다른 카운터는 영향받지 않는다.
  assert.deepEqual(payload.health.chronicTrackers, { count: 0, error: null });
});

test("경계: 0건이면 count:0 이고 null 이 아니다", async () => {
  const stub = ownerHealthStub(() => countResponse(0));
  const { payload } = await listOwnerAccountsWith(stub.impl);
  assert.deepEqual(payload.health.neverFoundTrackers, { count: 0, error: null });
  assert.deepEqual(payload.health.stuckTrackers, { count: 0, error: null });
  assert.deepEqual(payload.health.placePartialTrackers, { count: 0, error: null });
});

// ─────────────────────────────────────────────────────────────
// 총관리자 요약 카운터 — placePartialTrackers (F18)
//
// 플레이스 partial 결과는 last_error 를 null 로 둔 채 retry_count 만 올려서 잔존·stuck
// 어느 집계에도 잡히지 않는다. 이 카운터가 loadOwnerHealth 에서 플레이스 표를 보는
// 유일한 질의이고, 잔존 감사(placePartialCount)와 같은 서버 상수를 쓴다.
// ─────────────────────────────────────────────────────────────
test("총관리자 요약에 placePartialTrackers 가 실리고 플레이스 표는 그 한 번만 본다", async () => {
  const stub = ownerHealthStub((url) => (isPlacePartialQuery(url) ? countResponse(7) : countResponse(0)));
  const { response, payload } = await listOwnerAccountsWith(stub.impl);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.health.placePartialTrackers, { count: 7, error: null });

  const placePartialQueries = stub.heads.filter(isPlacePartialQuery);
  assert.equal(placePartialQueries.length, 1);
  const [placePartial] = placePartialQueries;
  assert.equal(placePartial.searchParams.get("status"), "eq.active");
  assert.equal(placePartial.searchParams.get("last_error"), "is.null");
  assert.equal(placePartial.searchParams.get("retry_count"), `gte.${RANK_PLACE_PARTIAL_MIN_RETRIES}`);
  assert.equal(placePartial.searchParams.has("or"), false, "partial 반복은 앵커 컷오프를 보지 않는다");
  assert.equal(placePartial.searchParams.has("check_count"), false);
  // 플레이스 표로 나가는 질의는 이것 하나뿐이다.
  assert.equal(stub.heads.filter((url) => url.pathname === "/rest/v1/naver_place_rank_trackers").length, 1);
});

test("placePartial 조회 실패도 count:null·error 로 접히고 다른 카운터는 그대로다", async () => {
  const stub = ownerHealthStub((url) => {
    if (isPlacePartialQuery(url)) {
      return Response.json(
        { code: "42P01", message: "relation naver_place_rank_trackers does not exist", details: null, hint: null },
        { status: 400 },
      );
    }
    return countResponse(0);
  });
  const { response, payload } = await listOwnerAccountsWith(stub.impl);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.health.placePartialTrackers.count, null);
  assert.match(String(payload.health.placePartialTrackers.error), /does not exist/);
  assert.deepEqual(payload.health.chronicTrackers, { count: 0, error: null });
  assert.deepEqual(payload.health.neverFoundTrackers, { count: 0, error: null });
  assert.deepEqual(payload.health.stuckTrackers, { count: 0, error: null });
});

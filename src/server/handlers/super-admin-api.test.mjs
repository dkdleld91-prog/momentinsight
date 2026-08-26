import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adminRateConfiguration, teamActionAccess, teamActionPayload } from "./super-admin-api.mjs";

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
  const publishEnd = source.indexOf("async function persistDemoState", publishStart);
  assert.notEqual(publishStart, -1);
  assert.notEqual(publishEnd, -1);
  assert.doesNotMatch(source.slice(publishStart, publishEnd), /["']x-mi-team-code["']/);
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { openSession, sessionConfiguration } from "../code-session.mjs";
import handler, {
  buildGoogleAuthUrl,
  decodeGoogleIdToken,
  findLoginIdentity,
  loadOwnerGoogleIntegration,
  mapScheduleRowToGoogleEvent,
  oauthStateNonce,
  resolveGoogleLoginAccess,
  signOauthState,
  syncOwnerScheduleRows,
  upsertLoginIdentity,
  verifyOauthState,
} from "./google-calendar-api.mjs";
import { resetOptionalColumns } from "./google-calendar-sync.mjs";

const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "cid-1",
  GOOGLE_OAUTH_CLIENT_SECRET: "sec-1",
};
const OWNER_ACCESS = { role: "owner", ownerAgencyCode: "MML93-A01" };

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

function googleFetchMock(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const call = { method: options.method || "GET", url: String(url), options };
    calls.push(call);
    const route = routes[`${call.method} ${call.url}`];
    if (!route) throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
    return typeof route === "function" ? route(call) : route;
  };
  return { calls, impl };
}

function tokenRoute(accessToken = "gat-1") {
  return (call) => {
    assert.match(String(call.options.body), /grant_type=refresh_token/);
    assert.match(String(call.options.body), /refresh_token=rt-1/);
    assert.match(String(call.options.body), /client_id=cid-1/);
    assert.match(String(call.options.body), /client_secret=sec-1/);
    return jsonResponse(200, { access_token: accessToken });
  };
}

function syncContext({ integration = null, integrationError = null } = {}) {
  const state = { integrationFilters: [], scheduleUpdates: [], auditInserts: [] };
  const ctx = {
    supabaseAdmin: {
      from(table) {
        if (table === "owner_google_integrations") {
          const query = {
            select() { return query; },
            eq(column, value) {
              state.integrationFilters.push([column, value]);
              return query;
            },
            async maybeSingle() {
              return { data: integration, error: integrationError };
            },
          };
          return query;
        }
        if (table === "schedule_items") {
          const call = { values: null, filters: [] };
          const query = {
            update(values) {
              call.values = values;
              return query;
            },
            eq(column, value) {
              call.filters.push([column, value]);
              return query;
            },
            then(resolve, reject) {
              state.scheduleUpdates.push(call);
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return query;
        }
        if (table === "audit_logs") {
          return {
            insert(values) {
              state.auditInserts.push(values);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
  return { ctx, state };
}

function forbiddenContext(label) {
  return {
    supabaseAdmin: {
      from() {
        throw new Error(`${label}: database must not be touched`);
      },
    },
  };
}

async function forbiddenFetch(url) {
  throw new Error(`fetch must not be called: ${url}`);
}

function personalRow(values = {}) {
  return {
    id: "sched-1",
    title: "개인 일정",
    starts_at: "2026-08-21T05:00:00.000Z",
    ends_at: "2026-08-21T06:00:00.000Z",
    status: "planned",
    is_all_day: false,
    client_id: null,
    operation_team_id: null,
    calendar_id: null,
    google_event_id: null,
    ...values,
  };
}

const INTEGRATION = {
  owner_agency_code: "mml93-a01",
  refresh_token: "rt-1",
  calendar_id: "cal-1",
  google_email: "owner@example.com",
  connected_at: "2026-08-01T00:00:00.000Z",
};

test("oauth state signs a lowercase owner payload and round-trips through verification", () => {
  const now = 1_700_000_000_000;
  const state = signOauthState("  MML93-A01  ", GOOGLE_ENV, now);
  assert.equal(state.split(".").length, 2);
  const payload = verifyOauthState(state, GOOGLE_ENV, now);
  assert.equal(payload.owner, "mml93-a01");
  assert.equal(payload.exp, now + STATE_TTL_MS);
  assert.equal(typeof payload.nonce, "string");
  assert.ok(payload.nonce.length > 0);
  // the state stays valid up to and including its exact expiry instant
  assert.equal(verifyOauthState(state, GOOGLE_ENV, now + STATE_TTL_MS).owner, "mml93-a01");
});

test("oauth state verification rejects forgery, expiry, and missing secrets", () => {
  const now = 1_700_000_000_000;
  const state = signOauthState("mml93-a01", GOOGLE_ENV, now);
  const [encoded, signature] = state.split(".");

  const flippedSignature = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  assert.equal(verifyOauthState(`${encoded}.${flippedSignature}`, GOOGLE_ENV, now), null);

  const forgedPayload = Buffer.from(JSON.stringify({
    owner: "attacker-code",
    exp: now + STATE_TTL_MS,
    nonce: "forged",
  }), "utf8").toString("base64url");
  assert.equal(verifyOauthState(`${forgedPayload}.${signature}`, GOOGLE_ENV, now), null);

  assert.equal(verifyOauthState(state, GOOGLE_ENV, now + STATE_TTL_MS + 1), null);
  assert.equal(verifyOauthState("", GOOGLE_ENV, now), null);
  assert.equal(verifyOauthState(encoded, GOOGLE_ENV, now), null);

  const noSecretEnv = { GOOGLE_OAUTH_CLIENT_ID: "cid-1" };
  assert.equal(signOauthState("mml93-a01", noSecretEnv, now), "");
  assert.equal(verifyOauthState(state, noSecretEnv, now), null);
});

test("google auth URL carries offline consent parameters and fails closed without state", () => {
  const url = buildGoogleAuthUrl("state-token", GOOGLE_ENV);
  assert.ok(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
  const params = new URL(url).searchParams;
  assert.equal(params.get("client_id"), "cid-1");
  assert.equal(params.get("redirect_uri"), "https://insight.momentlabs.co.kr/api/google-oauth/callback");
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("scope"), "https://www.googleapis.com/auth/calendar");
  assert.equal(params.get("access_type"), "offline");
  assert.equal(params.get("prompt"), "consent");
  assert.equal(params.get("include_granted_scopes"), "false");
  assert.equal(params.get("state"), "state-token");

  assert.equal(buildGoogleAuthUrl("", GOOGLE_ENV), "");
  assert.equal(buildGoogleAuthUrl("state-token", { GOOGLE_OAUTH_CLIENT_SECRET: "sec-1" }), "");
});

test("timed schedule rows map to Asia/Seoul events with a one-hour default duration", () => {
  const explicit = mapScheduleRowToGoogleEvent({
    id: "sched-1",
    title: "광고주 미팅",
    starts_at: "2026-08-21T05:00:00.000Z",
    ends_at: "2026-08-21T06:30:00.000Z",
    status: "planned",
  });
  assert.deepEqual(explicit, {
    summary: "광고주 미팅",
    extendedProperties: { private: { miScheduleId: "sched-1" } },
    start: { dateTime: "2026-08-21T05:00:00.000Z", timeZone: "Asia/Seoul" },
    end: { dateTime: "2026-08-21T06:30:00.000Z", timeZone: "Asia/Seoul" },
  });

  const defaulted = mapScheduleRowToGoogleEvent({
    id: "sched-2",
    title: "보고서 검토",
    starts_at: "2026-08-21T05:00:00.000Z",
    status: "done",
  });
  assert.equal(defaulted.summary, "✓ 보고서 검토");
  assert.equal(defaulted.end.dateTime, "2026-08-21T06:00:00.000Z");
  assert.equal(defaulted.extendedProperties.private.miScheduleId, "sched-2");

  assert.equal(mapScheduleRowToGoogleEvent({ id: "sched-3", title: "시작 없음" }), null);
  assert.equal(mapScheduleRowToGoogleEvent({ id: "sched-4", title: "빈 시작", starts_at: "   " }), null);
});

test("all-day schedule rows map to exclusive next-day ranges with occurrence priority", () => {
  const withOccurrence = mapScheduleRowToGoogleEvent({
    id: "sched-5",
    title: "월간 휴무",
    starts_at: "2026-07-31T15:00:00.000Z",
    occurrence_on: "2026-08-21",
    is_all_day: true,
  });
  assert.deepEqual(withOccurrence.start, { date: "2026-08-21" });
  assert.deepEqual(withOccurrence.end, { date: "2026-08-22" });

  // without occurrence_on the Seoul calendar date of starts_at is used
  const fromStartsAt = mapScheduleRowToGoogleEvent({
    id: "sched-6",
    title: "종일 일정",
    starts_at: "2026-08-20T15:00:00.000Z",
    is_all_day: true,
  });
  assert.deepEqual(fromStartsAt.start, { date: "2026-08-21" });
  assert.deepEqual(fromStartsAt.end, { date: "2026-08-22" });

  const multiDay = mapScheduleRowToGoogleEvent({
    id: "sched-7",
    title: "워크숍",
    starts_at: "2026-08-20T15:00:00.000Z",
    ends_at: "2026-08-22T15:00:00.000Z",
    occurrence_on: "2026-08-21",
    is_all_day: true,
  });
  assert.deepEqual(multiDay.start, { date: "2026-08-21" });
  assert.deepEqual(multiDay.end, { date: "2026-08-24" });
});

test("sync skips out-of-scope access and rows without touching the database", async () => {
  const cases = [
    ["missing access", null, [personalRow()]],
    ["non-owner role", { role: "team" }, [personalRow()]],
    ["foreign owner row", OWNER_ACCESS, [personalRow({ owner_agency_code: "other-a01" })]],
    ["shared calendar row", OWNER_ACCESS, [personalRow({ calendar_id: "shared-cal" })]],
    ["empty rows", OWNER_ACCESS, []],
    ["non-array rows", OWNER_ACCESS, null],
  ];
  for (const [label, access, rows] of cases) {
    const result = await syncOwnerScheduleRows(
      forbiddenContext(label), GOOGLE_ENV, access, rows, "upsert", forbiddenFetch,
    );
    assert.deepEqual(result, { skipped: true, reason: "scope" }, label);
  }
});

test("sync skips with env before any network or database call when oauth vars are missing", async () => {
  for (const env of [{}, { GOOGLE_OAUTH_CLIENT_ID: "cid-1" }, { GOOGLE_OAUTH_CLIENT_SECRET: "sec-1" }]) {
    const result = await syncOwnerScheduleRows(
      forbiddenContext("env"), env, OWNER_ACCESS, [personalRow()], "upsert", forbiddenFetch,
    );
    assert.deepEqual(result, { skipped: true, reason: "env" });
  }
});

test("sync skips with not-connected when the owner integration row is absent", async () => {
  const { ctx, state } = syncContext({ integration: null });
  const result = await syncOwnerScheduleRows(
    ctx, GOOGLE_ENV, OWNER_ACCESS, [personalRow()], "upsert", forbiddenFetch,
  );
  assert.deepEqual(result, { skipped: true, reason: "not-connected" });
  assert.deepEqual(state.integrationFilters, [["owner_agency_code", "mml93-a01"]]);
  assert.equal(state.scheduleUpdates.length, 0);
  assert.equal(state.auditInserts.length, 0);

  const failed = syncContext({ integrationError: { message: "boom" } });
  const errored = await syncOwnerScheduleRows(
    failed.ctx, GOOGLE_ENV, OWNER_ACCESS, [personalRow()], "upsert", forbiddenFetch,
  );
  assert.deepEqual(errored, { skipped: true, reason: "not-connected" });
});

test("sync inserts a new google event and stores the returned event id", async () => {
  const { ctx, state } = syncContext({
    integration: { ...INTEGRATION, calendar_id: "cal@moment" },
  });
  const eventsUrl = `${CALENDAR_BASE}/calendars/cal%40moment/events`;
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute("gat-1"),
    [`POST ${eventsUrl}`]: (call) => {
      assert.equal(call.options.headers.authorization, "Bearer gat-1");
      assert.equal(call.options.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(call.options.body), {
        summary: "개인 일정",
        extendedProperties: {
          private: {
            miScheduleId: "sched-1",
            miOwnerCode: "mml93-a01",
            miStatus: "planned",
            miScope: "internal",
            miVersion: "1",
          },
        },
        start: { dateTime: "2026-08-21T05:00:00.000Z", timeZone: "Asia/Seoul" },
        end: { dateTime: "2026-08-21T06:00:00.000Z", timeZone: "Asia/Seoul" },
      });
      return jsonResponse(200, { id: "gev1", etag: '"e1"', updated: "2026-08-21T05:30:00.000Z" });
    },
  });

  const result = await syncOwnerScheduleRows(
    ctx, GOOGLE_ENV, OWNER_ACCESS, [personalRow()], "upsert", impl,
  );

  assert.deepEqual(result, { skipped: false, synced: 1, failed: 0 });
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["POST", TOKEN_URL],
    ["POST", eventsUrl],
  ]);
  assert.equal(state.scheduleUpdates.length, 1);
  // 구글 응답을 그대로 미러링해 둬야 다음 inbound 가 자기 메아리를 알아본다.
  const stored = state.scheduleUpdates[0].values;
  assert.equal(stored.google_event_id, "gev1");
  assert.equal(stored.google_calendar_id, "cal@moment");
  assert.equal(stored.google_etag, '"e1"');
  assert.equal(stored.google_updated_at, "2026-08-21T05:30:00.000Z");
  assert.equal(stored.google_sync_state, "synced");
  assert.deepEqual(state.scheduleUpdates[0].filters, [["id", "sched-1"]]);
  assert.equal(state.auditInserts.length, 0);
});

test("sync patches an existing google event without rewriting the stored id", async () => {
  const { ctx, state } = syncContext({ integration: INTEGRATION });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`PATCH ${CALENDAR_BASE}/calendars/cal-1/events/gev-old`]: jsonResponse(200, {
      id: "gev-old", etag: '"e2"', updated: "2026-08-21T07:00:00.000Z",
    }),
  });

  const result = await syncOwnerScheduleRows(
    ctx, GOOGLE_ENV, OWNER_ACCESS, [personalRow({ google_event_id: "gev-old" })], "upsert", impl,
  );

  assert.deepEqual(result, { skipped: false, synced: 1, failed: 0 });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "PATCH"]);
  assert.equal(state.scheduleUpdates.length, 1);
  assert.equal(state.scheduleUpdates[0].values.google_event_id, "gev-old");
  assert.equal(state.scheduleUpdates[0].values.google_etag, '"e2"');
  assert.equal(state.auditInserts.length, 0);
});

test("sync recreates the event through POST when the stored id returns 404", async () => {
  const { ctx, state } = syncContext({ integration: INTEGRATION });
  const eventsUrl = `${CALENDAR_BASE}/calendars/cal-1/events`;
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`PATCH ${eventsUrl}/gev-stale`]: jsonResponse(404, { error: { code: 404 } }),
    [`POST ${eventsUrl}`]: jsonResponse(200, { id: "gev-new" }),
  });

  const result = await syncOwnerScheduleRows(
    ctx, GOOGLE_ENV, OWNER_ACCESS, [personalRow({ google_event_id: "gev-stale" })], "upsert", impl,
  );

  assert.deepEqual(result, { skipped: false, synced: 1, failed: 0 });
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["POST", TOKEN_URL],
    ["PATCH", `${eventsUrl}/gev-stale`],
    ["POST", eventsUrl],
  ]);
  assert.equal(state.scheduleUpdates[0].values.google_event_id, "gev-new");
  assert.equal(state.scheduleUpdates[0].values.google_sync_state, "synced");
  assert.deepEqual(state.scheduleUpdates[0].filters, [["id", "sched-1"]]);
});

test("owner-scoped advertiser rows now reach google with a client marker", async () => {
  const { ctx } = syncContext({ integration: INTEGRATION });
  const eventsUrl = `${CALENDAR_BASE}/calendars/cal-1/events`;
  const { impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`POST ${eventsUrl}`]: (call) => {
      const body = JSON.parse(call.options.body);
      assert.equal(body.summary, "[모먼트커피] 개인 일정");
      assert.equal(body.extendedProperties.private.miClientName, "모먼트커피");
      assert.equal(body.extendedProperties.private.miScope, "client");
      return jsonResponse(200, { id: "gev-client" });
    },
  });
  const row = personalRow({ client_id: "client-1", client: { id: "client-1", name: "모먼트커피" } });
  const result = await syncOwnerScheduleRows(
    ctx, GOOGLE_ENV, { role: "owner", ownerAgencyCode: "MML93-A01", client: { id: "client-1" } },
    [row], "upsert", impl,
  );
  assert.deepEqual(result, { skipped: false, synced: 1, failed: 0 });
});

test("delete sync removes only rows with google event ids and tolerates 404", async () => {
  const { ctx, state } = syncContext({ integration: INTEGRATION });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`DELETE ${CALENDAR_BASE}/calendars/cal-1/events/gev-1`]: jsonResponse(404, { error: { code: 404 } }),
  });

  const result = await syncOwnerScheduleRows(ctx, GOOGLE_ENV, OWNER_ACCESS, [
    personalRow({ id: "sched-1", google_event_id: "gev-1" }),
    personalRow({ id: "sched-2", google_event_id: null }),
  ], "delete", impl);

  assert.deepEqual(result, { skipped: false, synced: 2, failed: 0 });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "DELETE"]);
  assert.equal(state.scheduleUpdates.length, 0);
  assert.equal(state.auditInserts.length, 0);
});

test("a partially failed sync counts the failure and records an audit log", async () => {
  const { ctx, state } = syncContext({ integration: INTEGRATION });
  const eventsUrl = `${CALENDAR_BASE}/calendars/cal-1/events`;
  const { impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`POST ${eventsUrl}`]: (call) => {
      const event = JSON.parse(call.options.body);
      if (event.extendedProperties.private.miScheduleId === "sched-fail") {
        throw new Error("google unreachable");
      }
      return jsonResponse(200, { id: "gev-ok" });
    },
  });

  const result = await syncOwnerScheduleRows(ctx, GOOGLE_ENV, OWNER_ACCESS, [
    personalRow({ id: "sched-ok" }),
    personalRow({ id: "sched-fail" }),
  ], "upsert", impl);

  assert.deepEqual(result, { skipped: false, synced: 1, failed: 1 });
  assert.equal(state.scheduleUpdates.length, 1);
  assert.deepEqual(state.scheduleUpdates[0].filters, [["id", "sched-ok"]]);
  assert.equal(state.auditInserts.length, 1);
  const audit = state.auditInserts[0];
  assert.equal(audit.action, "google_calendar_sync_failed");
  assert.equal(audit.target_table, "schedule_items");
  assert.equal(audit.target_id, "sched-ok");
  assert.deepEqual(audit.metadata, { mode: "upsert", failed: 1, total: 2 });
});

test("loadOwnerGoogleIntegration lowercases the owner code and surfaces errors", async () => {
  const { ctx, state } = syncContext({ integration: INTEGRATION });
  const loaded = await loadOwnerGoogleIntegration(ctx, "  MML93-A01  ");
  assert.deepEqual(state.integrationFilters, [["owner_agency_code", "mml93-a01"]]);
  assert.deepEqual(loaded, { integration: INTEGRATION, error: null });

  const failure = { message: "db down" };
  const errored = await loadOwnerGoogleIntegration(
    syncContext({ integrationError: failure }).ctx, "mml93-a01",
  );
  assert.deepEqual(errored, { integration: null, error: failure });
});

// ---------------------------------------------------------------------------
// Google login additions
// ---------------------------------------------------------------------------

const OAUTH_CALLBACK_URL = "https://insight.momentlabs.co.kr/api/google-oauth/callback";
const LOGIN_START_URL = "https://insight.momentlabs.co.kr/api/google-login/start";
const OWNER_LOGIN_API_URL = "https://insight.momentlabs.co.kr/api/owner/google-login";
const OWNER_CALENDAR_API_URL = "https://insight.momentlabs.co.kr/api/owner/google-calendar";
const SUPABASE_TEST_URL = "http://supabase.test";
const IDENTITY_REST_URL = `${SUPABASE_TEST_URL}/rest/v1/login_identities`;
const AUDIT_REST_URL = `${SUPABASE_TEST_URL}/rest/v1/audit_logs`;
const TEAM_REST_URL = `${SUPABASE_TEST_URL}/rest/v1/operation_team_codes`;
const CLIENT_REST_URL = `${SUPABASE_TEST_URL}/rest/v1/clients`;
const RATE_RPC_URL = `${SUPABASE_TEST_URL}/rest/v1/rpc/consume_code_login_rate_limit`;
const NONCE_COOKIE = "mi-goauth-nonce";
const SESSION_ENV = { MI_SESSION_SECRET: "unit-test-session-secret-0123456789abcdef" };
const LOGIN_HANDLER_ENV = {
  ...GOOGLE_ENV,
  SUPABASE_URL: SUPABASE_TEST_URL,
  SUPABASE_PUBLISHABLE_KEY: "pub-test",
  SUPABASE_PUBLISHABLE_KEYS: undefined,
  SUPABASE_SECRET_KEY: "secret-test",
  SUPABASE_SECRET_KEYS: undefined,
  SUPABASE_JWKS: undefined,
  SUPABASE_JWKS_URL: undefined,
  MI_SESSION_SECRET: SESSION_ENV.MI_SESSION_SECRET,
  MI_SESSION_SECRET_PREVIOUS: undefined,
  MI_SESSION_TTL_SECONDS: undefined,
  MI_PRIMARY_AGENCY_CODE: undefined,
  MI_GOOGLE_OAUTH_REDIRECT: undefined,
  MI_GOOGLE_LOGIN_ROLES: undefined,
  NODE_ENV: undefined,
  VERCEL_ENV: undefined,
};

function signStatePayload(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function fakeIdToken(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(payload)}.sig`;
}

// Every fixture id_token carries the claims the verifier now demands, so a test
// that omits one is deliberately exercising the fail-closed path.
function idTokenClaims(overrides = {}) {
  return {
    aud: "cid-1",
    iss: "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    email_verified: true,
    ...overrides,
  };
}

function validIdToken(overrides = {}) {
  return fakeIdToken(idTokenClaims(overrides));
}

function identityContext({ identity = null, error = null } = {}) {
  const state = { tables: [], selects: [], filters: [], upserts: [] };
  const query = {
    select(columns) { state.selects.push(columns); return query; },
    eq(column, value) { state.filters.push([column, value]); return query; },
    async maybeSingle() { return { data: identity, error }; },
    async upsert(values, options) { state.upserts.push([values, options]); return { error }; },
  };
  const ctx = {
    supabaseAdmin: {
      from(table) { state.tables.push(table); return query; },
    },
  };
  return { ctx, state };
}

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

function loginFetchRouter(routes) {
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

function restJson(rows) {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function restCreated() {
  return new Response(null, { status: 201 });
}

function rateRoute(allowed = true) {
  return ["POST", RATE_RPC_URL, () => restJson([{ allowed, retry_after: allowed ? 0 : 120 }])];
}

// The per-IP OAuth throttle is infrastructure, not part of the login flow the
// assertions below describe, so it is filtered out of the recorded call list.
function flowCalls(calls) {
  return calls.filter((call) => !call.url.startsWith(RATE_RPC_URL));
}

function flowMethods(calls) {
  return flowCalls(calls).map((call) => call.method);
}

function sessionCookies(response) {
  const name = sessionConfiguration(SESSION_ENV).cookieName;
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${name}=`));
}

function nonceCookies(response) {
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${NONCE_COOKIE}=`));
}

function googleTokenRoute(idTokenPayload) {
  return ["POST", TOKEN_URL, (call) => {
    assert.match(String(call.body), /grant_type=authorization_code/);
    assert.match(String(call.body), /client_id=cid-1/);
    assert.match(String(call.body), /client_secret=sec-1/);
    return new Response(JSON.stringify({ id_token: validIdToken(idTokenPayload) }), { status: 200 });
  }];
}

async function callLoginHandler(url, {
  routes = [],
  env = {},
  nonce = "",
  cookie,
  ip = "",
  rateAllowed = true,
  method = "GET",
} = {}) {
  const { calls, impl } = loginFetchRouter([rateRoute(rateAllowed), ...routes]);
  const headers = {};
  const cookieHeader = cookie === undefined ? (nonce ? `${NONCE_COOKIE}=${nonce}` : "") : cookie;
  if (cookieHeader) headers.cookie = cookieHeader;
  if (ip) headers["x-vercel-forwarded-for"] = ip;
  const response = await withEnv({ ...LOGIN_HANDLER_ENV, ...env }, () => (
    withGlobalFetch(impl, () => handler.fetch(new Request(url, { method, headers })))
  ));
  return { response, calls };
}

function loginState(owner = "mml93-a01", purpose = "login") {
  const state = signOauthState(owner, GOOGLE_ENV, Date.now(), purpose);
  return { state, nonce: oauthStateNonce(state), url: `${OAUTH_CALLBACK_URL}?code=auth-1&state=${encodeURIComponent(state)}` };
}

// Serves both login_identities reads: the lookup by google_sub, and the link
// flow's lookup of whatever row currently holds the target (role, code).
function identityRoute(rows, expectedSub = "sub-123", targetRows = []) {
  return ["GET", IDENTITY_REST_URL, (call) => {
    if (call.url.includes("role=eq.")) {
      assert.match(call.url, /code=eq\.mml93-a01/);
      return restJson(targetRows);
    }
    assert.match(call.url, new RegExp(`google_sub=eq\\.${expectedSub}`));
    return restJson(rows);
  }];
}

// Records every write shape the link flow could take so a test can assert that
// the ones it must not use were never issued.
function identityWriteSinks() {
  const deletes = [];
  const patches = [];
  const upserts = [];
  const routes = [
    ["DELETE", IDENTITY_REST_URL, (call) => {
      deletes.push(call.url);
      return restJson([]);
    }],
    ["PATCH", IDENTITY_REST_URL, (call) => {
      patches.push({
        url: call.url,
        prefer: call.headers.get("prefer") || "",
        row: JSON.parse(String(call.body)),
      });
      return restJson([{ google_sub: "sub-123" }]);
    }],
    ["POST", IDENTITY_REST_URL, (call) => {
      upserts.push({
        url: call.url,
        prefer: call.headers.get("prefer") || "",
        row: JSON.parse(String(call.body)),
      });
      return restCreated();
    }],
  ];
  return { deletes, patches, upserts, routes };
}

function auditRoute(sink) {
  return ["POST", AUDIT_REST_URL, (call) => {
    sink.push(JSON.parse(String(call.body)));
    return restCreated();
  }];
}

test("oauth state purpose defaults to calendar and round-trips link and login", () => {
  const now = 1_700_000_000_000;
  assert.equal(verifyOauthState(signOauthState("mml93-a01", GOOGLE_ENV, now), GOOGLE_ENV, now).p, "calendar");
  assert.equal(verifyOauthState(signOauthState("mml93-a01", GOOGLE_ENV, now, "link"), GOOGLE_ENV, now).p, "link");

  const login = verifyOauthState(signOauthState("MML93-A01", GOOGLE_ENV, now, "login"), GOOGLE_ENV, now);
  assert.equal(login.p, "login");
  assert.equal(login.owner, "mml93-a01");
  assert.equal(login.exp, now + STATE_TTL_MS);

  // blank purposes fall back to calendar, and purposes are trimmed before signing
  assert.equal(verifyOauthState(signOauthState("mml93-a01", GOOGLE_ENV, now, "   "), GOOGLE_ENV, now).p, "calendar");
  assert.equal(verifyOauthState(signOauthState("mml93-a01", GOOGLE_ENV, now, "  link  "), GOOGLE_ENV, now).p, "link");
});

test("legacy oauth states without a purpose verify as calendar states", () => {
  const now = 1_700_000_000_000;
  const legacy = signStatePayload(
    { owner: "mml93-a01", exp: now + STATE_TTL_MS, nonce: "legacy-1" },
    GOOGLE_ENV.GOOGLE_OAUTH_CLIENT_SECRET,
  );
  const payload = verifyOauthState(legacy, GOOGLE_ENV, now);
  assert.equal(payload.owner, "mml93-a01");
  assert.equal(payload.p, "calendar");
  assert.equal(payload.nonce, "legacy-1");
});

test("google auth url reflects a custom login scope", () => {
  const url = buildGoogleAuthUrl("state-token", GOOGLE_ENV, "openid email");
  const params = new URL(url).searchParams;
  assert.equal(params.get("scope"), "openid email");
  assert.equal(params.get("client_id"), "cid-1");
  assert.equal(params.get("access_type"), "offline");
  assert.equal(params.get("prompt"), "consent");
  assert.equal(params.get("state"), "state-token");
});

test("google auth url for the login purpose drops offline access and forced consent", () => {
  const url = buildGoogleAuthUrl("state-token", GOOGLE_ENV, "openid email", "login");
  const params = new URL(url).searchParams;
  assert.equal(params.get("scope"), "openid email");
  assert.equal(params.get("access_type"), null);
  assert.equal(params.get("prompt"), "select_account");
  assert.equal(params.get("include_granted_scopes"), "false");
  assert.equal(params.get("state"), "state-token");

  // linking and calendar keep the refresh-token grant
  for (const purpose of ["link", "calendar"]) {
    const other = new URL(buildGoogleAuthUrl("state-token", GOOGLE_ENV, "openid email", purpose)).searchParams;
    assert.equal(other.get("access_type"), "offline");
    assert.equal(other.get("prompt"), "consent");
  }
});

test("oauthStateNonce extracts the issued nonce and fails soft on damaged states", () => {
  const state = signOauthState("mml93-a01", GOOGLE_ENV, Date.now(), "login");
  const nonce = oauthStateNonce(state);
  assert.equal(typeof nonce, "string");
  assert.ok(nonce.length > 0);
  assert.equal(verifyOauthState(state, GOOGLE_ENV).nonce, nonce);

  assert.equal(oauthStateNonce(""), "");
  assert.equal(oauthStateNonce("!!!.sig"), "");
  assert.equal(oauthStateNonce(`${Buffer.from("not json", "utf8").toString("base64url")}.sig`), "");
});

test("google id token decoding extracts the sub and lowercases the verified email", () => {
  assert.deepEqual(
    decodeGoogleIdToken(validIdToken({ sub: "  sub-123  ", email: "  Owner@EXAMPLE.com  " }), { env: GOOGLE_ENV }),
    { sub: "sub-123", email: "owner@example.com" },
  );
  assert.deepEqual(
    decodeGoogleIdToken(validIdToken({ sub: "sub-123" }), { env: GOOGLE_ENV }),
    { sub: "sub-123", email: null },
  );
  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "s".repeat(200) }), { env: GOOGLE_ENV }).sub.length, 128);
});

test("google id token decoding fails closed on missing subs and malformed tokens", () => {
  const options = { env: GOOGLE_ENV };
  assert.equal(decodeGoogleIdToken(validIdToken({ email: "owner@example.com" }), options), null);
  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "   " }), options), null);
  assert.equal(decodeGoogleIdToken("", options), null);
  assert.equal(decodeGoogleIdToken(null, options), null);
  assert.equal(decodeGoogleIdToken("one.two", options), null);
  assert.equal(decodeGoogleIdToken("a.!!!.c", options), null);
  assert.equal(decodeGoogleIdToken(`a.${Buffer.from("not json", "utf8").toString("base64url")}.c`, options), null);
});

test("google id token decoding rejects foreign audiences, issuers, and expired tokens", () => {
  const options = { env: GOOGLE_ENV };
  const now = Math.floor(Date.now() / 1000);

  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "sub-1", aud: "attacker-client" }), options), null);
  assert.equal(decodeGoogleIdToken(fakeIdToken({ sub: "sub-1", iss: "https://accounts.google.com", exp: now + 60 }), options), null);
  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "sub-1", iss: "https://evil.example" }), options), null);
  assert.equal(decodeGoogleIdToken(fakeIdToken({ sub: "sub-1", aud: "cid-1", exp: now + 60 }), options), null);
  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "sub-1", exp: now - 61 }), options), null);
  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "sub-1", exp: "soon" }), options), null);

  // both accepted issuer spellings survive, and the 60s skew window is honoured
  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "sub-1", iss: "accounts.google.com" }), options).sub, "sub-1");
  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "sub-1", exp: now - 30 }), options).sub, "sub-1");

  // an unknown expected audience fails closed instead of trusting the token
  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "sub-1" }), { env: {} }), null);
  assert.equal(decodeGoogleIdToken(validIdToken({ sub: "sub-1" }), { aud: "cid-1" }).sub, "sub-1");
});

test("google id token decoding drops unverified email addresses", () => {
  const options = { env: GOOGLE_ENV };
  assert.equal(
    decodeGoogleIdToken(validIdToken({ sub: "sub-1", email: "owner@example.com", email_verified: false }), options).email,
    null,
  );
  assert.equal(
    decodeGoogleIdToken(fakeIdToken({
      sub: "sub-1",
      aud: "cid-1",
      iss: "https://accounts.google.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: "owner@example.com",
    }), options).email,
    null,
  );
  assert.equal(
    decodeGoogleIdToken(validIdToken({ sub: "sub-1", email: "owner@example.com", email_verified: "true" }), options).email,
    null,
  );
});

test("findLoginIdentity filters login_identities by trimmed google sub and surfaces errors", async () => {
  const row = {
    google_sub: "sub-123",
    google_email: "owner@example.com",
    role: "owner",
    code: "mml93-a01",
    linked_at: "2026-08-01T00:00:00.000Z",
  };
  const found = identityContext({ identity: row });
  assert.deepEqual(await findLoginIdentity(found.ctx, "  sub-123  "), { identity: row, error: null });
  assert.deepEqual(found.state.tables, ["login_identities"]);
  assert.deepEqual(found.state.selects, ["google_sub, google_email, role, code, linked_at"]);
  assert.deepEqual(found.state.filters, [["google_sub", "sub-123"]]);

  const missing = identityContext({ identity: null });
  assert.deepEqual(await findLoginIdentity(missing.ctx, "sub-404"), { identity: null, error: null });

  const failure = { message: "db down" };
  assert.deepEqual(
    await findLoginIdentity(identityContext({ error: failure }).ctx, "sub-123"),
    { identity: null, error: failure },
  );
});

test("upsertLoginIdentity normalizes fields and upserts on the google_sub conflict key", async () => {
  const saved = identityContext();
  const before = Date.now();
  const ok = await upsertLoginIdentity(saved.ctx, {
    googleSub: "  sub-123  ",
    googleEmail: "  Owner@EXAMPLE.com  ",
    role: " owner ",
    code: "  MML93-A01  ",
  });
  assert.equal(ok, true);
  assert.deepEqual(saved.state.tables, ["login_identities"]);
  assert.equal(saved.state.upserts.length, 1);
  const [values, options] = saved.state.upserts[0];
  assert.equal(values.google_sub, "sub-123");
  assert.equal(values.google_email, "owner@example.com");
  assert.equal(values.role, "owner");
  assert.equal(values.code, "mml93-a01");
  assert.ok(Date.parse(values.linked_at) >= before);
  assert.ok(Date.parse(values.updated_at) >= before);
  assert.deepEqual(options, { onConflict: "google_sub" });

  const blankEmail = identityContext();
  await upsertLoginIdentity(blankEmail.ctx, {
    googleSub: "sub-9", googleEmail: "   ", role: "owner", code: "mml93-a01",
  });
  assert.equal(blankEmail.state.upserts[0][0].google_email, null);

  const failed = await upsertLoginIdentity(identityContext({ error: { message: "conflict" } }).ctx, {
    googleSub: "sub-123", googleEmail: null, role: "owner", code: "mml93-a01",
  });
  assert.equal(failed, false);
});

test("login start endpoint redirects to google with an openid scope and login purpose", async () => {
  const { response, calls } = await callLoginHandler(LOGIN_START_URL);
  assert.equal(response.status, 302);
  assert.equal(flowCalls(calls).length, 0);
  const location = new URL(response.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(location.searchParams.get("scope"), "openid email");
  assert.equal(location.searchParams.get("prompt"), "select_account");
  assert.equal(location.searchParams.get("access_type"), null);
  const statePayload = verifyOauthState(location.searchParams.get("state"), GOOGLE_ENV);
  assert.equal(statePayload.p, "login");
  assert.equal(statePayload.owner, "mml93-a01");

  const unconfigured = await callLoginHandler(LOGIN_START_URL, {
    env: { GOOGLE_OAUTH_CLIENT_ID: undefined },
  });
  assert.equal(unconfigured.response.status, 302);
  assert.equal(unconfigured.response.headers.get("location"), "/admin?glogin=not-configured");
});

test("login start binds the issued state nonce to the browser with a Lax host cookie", async () => {
  const { response } = await callLoginHandler(LOGIN_START_URL);
  const cookies = nonceCookies(response);
  assert.equal(cookies.length, 1);
  const state = new URL(response.headers.get("location")).searchParams.get("state");
  assert.equal(cookies[0].split(";")[0], `${NONCE_COOKIE}=${oauthStateNonce(state)}`);
  assert.match(cookies[0], /HttpOnly/);
  // Strict would be dropped by the cross-site top-level redirect back from Google
  assert.match(cookies[0], /SameSite=Lax/);
  assert.match(cookies[0], /Path=\//);
  assert.match(cookies[0], /Max-Age=600/);
  assert.doesNotMatch(cookies[0], /Secure/);

  const hosted = await callLoginHandler(LOGIN_START_URL, { env: { NODE_ENV: "production" } });
  assert.match(nonceCookies(hosted.response)[0], /Secure/);
});

test("the owner link-url and calendar auth-url responses bind the same state nonce", async () => {
  const ownerHeaders = {
    "content-type": "application/json",
    "x-mi-session-role": "owner",
    "x-mi-owner-agency-code": "mml93-a01",
  };
  const cases = [
    [OWNER_LOGIN_API_URL, "link-url", "link"],
    [OWNER_CALENDAR_API_URL, "auth-url", "calendar"],
  ];
  for (const [url, action, purpose] of cases) {
    const { impl } = loginFetchRouter([]);
    const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => handler.fetch(
      new Request(url, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ action }) }),
    )));
    const payload = await response.json();
    assert.equal(payload.ok, true, action);
    const state = new URL(payload.url).searchParams.get("state");
    assert.equal(verifyOauthState(state, GOOGLE_ENV).p, purpose);
    const cookies = response.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${NONCE_COOKIE}=`));
    assert.equal(cookies.length, 1, action);
    assert.equal(cookies[0].split(";")[0], `${NONCE_COOKIE}=${oauthStateNonce(state)}`);
    assert.match(cookies[0], /HttpOnly; SameSite=Lax; Max-Age=600/);
  }
});

test("oauth callback redirects forged states and wrong-owner link states without side effects", async () => {
  const linkState = signOauthState("mml93-a01", GOOGLE_ENV, Date.now(), "link");
  const [encoded, signature] = linkState.split(".");
  const tampered = `${encoded}.${(signature[0] === "A" ? "B" : "A") + signature.slice(1)}`;
  const forged = await callLoginHandler(`${OAUTH_CALLBACK_URL}?code=auth-1&state=${encodeURIComponent(tampered)}`, {
    nonce: oauthStateNonce(linkState),
  });
  assert.equal(forged.response.status, 302);
  assert.equal(forged.response.headers.get("location"), "/admin?gcal=invalid#mi-admin-owner-assistant");
  assert.equal(flowCalls(forged.calls).length, 0);

  const audits = [];
  const wrongOwner = loginState("intruder-a01", "link");
  const rejected = await callLoginHandler(wrongOwner.url, {
    nonce: wrongOwner.nonce,
    routes: [auditRoute(audits)],
  });
  assert.equal(rejected.response.status, 302);
  assert.equal(rejected.response.headers.get("location"), "/admin?glogin=invalid");
  // no token exchange, no identity write — only the fail-closed audit trail
  assert.deepEqual(flowMethods(rejected.calls), ["POST"]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "google_login_failed");
  assert.deepEqual(audits[0].metadata, { reason: "invalid-state" });
});

test("oauth callback refuses a state that is not bound to the caller's browser", async () => {
  const audits = [];
  const missing = await callLoginHandler(loginState().url, { routes: [auditRoute(audits)] });
  assert.equal(missing.response.status, 302);
  assert.equal(missing.response.headers.get("location"), "/admin?glogin=invalid");
  assert.deepEqual(flowMethods(missing.calls), ["POST"]);
  assert.deepEqual(audits[0].metadata, { reason: "nonce-mismatch" });
  assert.equal(sessionCookies(missing.response).length, 0);

  const wrong = await callLoginHandler(loginState().url, { nonce: "someone-elses-nonce", routes: [auditRoute(audits)] });
  assert.equal(wrong.response.headers.get("location"), "/admin?glogin=invalid");
  assert.deepEqual(flowMethods(wrong.calls), ["POST"]);
  assert.deepEqual(audits[1].metadata, { reason: "nonce-mismatch" });

  // a calendar-purpose state keeps the calendar redirect surface and stays silent
  const calendar = loginState("mml93-a01", "calendar");
  const gcal = await callLoginHandler(calendar.url, { nonce: "not-the-issued-nonce" });
  assert.equal(gcal.response.headers.get("location"), "/admin?gcal=invalid#mi-admin-owner-assistant");
  assert.equal(flowCalls(gcal.calls).length, 0);
});

test("oauth callback clears the browser nonce on every outcome so a state is single use", async () => {
  const clearedCookie = /^mi-goauth-nonce=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/;
  const invalid = await callLoginHandler(`${OAUTH_CALLBACK_URL}?code=auth-1&state=nonsense`);
  assert.match(nonceCookies(invalid.response)[0], clearedCookie);

  const audits = [];
  const login = loginState();
  const success = await callLoginHandler(login.url, {
    nonce: login.nonce,
    routes: [
      googleTokenRoute({ sub: "sub-123" }),
      identityRoute([{ google_sub: "sub-123", google_email: null, role: "owner", code: "mml93-a01", linked_at: null }]),
      auditRoute(audits),
    ],
  });
  assert.equal(success.response.headers.get("location"), "/admin?glogin=success");
  assert.match(nonceCookies(success.response)[0], clearedCookie);
  assert.equal(sessionCookies(success.response).length, 1);
});

test("oauth callback maps a cancelled consent screen to a purpose-aware notice", async () => {
  const cases = [
    ["login", "access_denied", "/admin?glogin=cancelled"],
    ["login", "invalid_scope", "/admin?glogin=invalid"],
    ["link", "access_denied", "/admin?glogin=cancelled"],
    ["link", "", "/admin?glogin=invalid"],
    ["calendar", "access_denied", "/admin?gcal=invalid#mi-admin-owner-assistant"],
  ];
  for (const [purpose, error, location] of cases) {
    const state = signOauthState("mml93-a01", GOOGLE_ENV, Date.now(), purpose);
    const query = `state=${encodeURIComponent(state)}${error ? `&error=${error}` : ""}`;
    const { response, calls } = await callLoginHandler(`${OAUTH_CALLBACK_URL}?${query}`);
    assert.equal(response.headers.get("location"), location, `${purpose}/${error}`);
    assert.equal(flowCalls(calls).length, 0);
  }

  // an unverifiable state may still pick the redirect surface, but never authorizes anything
  const unsigned = signStatePayload({ owner: "mml93-a01", p: "login", exp: Date.now() + STATE_TTL_MS, nonce: "x" }, "wrong-secret");
  const cancelled = await callLoginHandler(`${OAUTH_CALLBACK_URL}?state=${encodeURIComponent(unsigned)}&error=access_denied`);
  assert.equal(cancelled.response.headers.get("location"), "/admin?glogin=cancelled");
  assert.equal(flowCalls(cancelled.calls).length, 0);
});

test("google oauth endpoints shed abusive per-IP traffic without touching google", async () => {
  const start = await callLoginHandler(LOGIN_START_URL, { rateAllowed: false, ip: "203.0.113.7" });
  assert.equal(start.response.status, 302);
  assert.equal(start.response.headers.get("location"), "/admin?glogin=busy");
  assert.equal(flowCalls(start.calls).length, 0);
  assert.equal(nonceCookies(start.response).length, 0);

  const login = loginState();
  const callback = await callLoginHandler(login.url, {
    rateAllowed: false,
    ip: "203.0.113.7",
    nonce: login.nonce,
  });
  assert.equal(callback.response.headers.get("location"), "/admin?glogin=busy");
  assert.equal(flowCalls(callback.calls).length, 0);
  assert.equal(sessionCookies(callback.response).length, 0);

  const limiterCall = JSON.parse(String(callback.calls[0].body));
  assert.equal(limiterCall.p_window_seconds, 900);
  assert.equal(limiterCall.p_attempt_limit, 20);
  assert.match(limiterCall.p_key_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(limiterCall.p_key_hash, JSON.parse(String(start.calls[0].body)).p_key_hash);
});

test("google oauth throttling degrades to a local bucket instead of blocking login", async () => {
  const brokenLimiter = ["POST", RATE_RPC_URL, () => new Response(JSON.stringify({ message: "rpc down" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  })];
  const { calls, impl } = loginFetchRouter([brokenLimiter]);
  const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => handler.fetch(
    new Request(LOGIN_START_URL, { headers: { "x-vercel-forwarded-for": "198.51.100.31" } }),
  )));
  assert.equal(response.status, 302);
  assert.ok(String(response.headers.get("location")).startsWith("https://accounts.google.com/"));
  assert.equal(nonceCookies(response).length, 1);
  assert.equal(flowCalls(calls).length, 0);
});

test("login callback redirects unlinked and non-owner identities without creating a session", async () => {
  const audits = [];
  const unlinkedState = loginState();
  const unlinked = await callLoginHandler(unlinkedState.url, {
    nonce: unlinkedState.nonce,
    routes: [googleTokenRoute({ sub: "sub-123", email: "Owner@Example.com" }), identityRoute([]), auditRoute(audits)],
  });
  assert.equal(unlinked.response.status, 302);
  assert.equal(unlinked.response.headers.get("location"), "/admin?glogin=unlinked");
  assert.equal(sessionCookies(unlinked.response).length, 0);
  assert.deepEqual(flowMethods(unlinked.calls), ["POST", "GET", "POST"]);
  assert.deepEqual(audits[0].metadata, { reason: "unlinked" });

  const teamIdentity = {
    google_sub: "sub-123", google_email: "owner@example.com", role: "team", code: "mml93-a01", linked_at: null,
  };
  const notReadyState = loginState();
  const notReady = await callLoginHandler(notReadyState.url, {
    nonce: notReadyState.nonce,
    routes: [googleTokenRoute({ sub: "sub-123" }), identityRoute([teamIdentity]), auditRoute(audits)],
  });
  assert.equal(notReady.response.headers.get("location"), "/admin?glogin=not-ready");
  assert.equal(sessionCookies(notReady.response).length, 0);
  assert.deepEqual(audits[1].metadata, { reason: "not-ready" });

  const wrongCodeState = loginState();
  const wrongCode = await callLoginHandler(wrongCodeState.url, {
    nonce: wrongCodeState.nonce,
    routes: [
      googleTokenRoute({ sub: "sub-123" }),
      identityRoute([{ ...teamIdentity, role: "owner", code: "other-a01" }]),
      auditRoute(audits),
    ],
  });
  assert.equal(wrongCode.response.headers.get("location"), "/admin?glogin=not-ready");
  assert.equal(sessionCookies(wrongCode.response).length, 0);
});

test("login callback success seals an owner session cookie and records an audit log", async () => {
  const audits = [];
  const login = loginState();
  const { response, calls } = await callLoginHandler(login.url, {
    nonce: login.nonce,
    routes: [
      googleTokenRoute({ sub: "sub-123", email: "Owner@Example.com" }),
      identityRoute([{
        google_sub: "sub-123",
        google_email: "owner@example.com",
        role: "owner",
        code: "mml93-a01",
        linked_at: "2026-08-01T00:00:00.000Z",
      }]),
      auditRoute(audits),
    ],
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin?glogin=success");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(flowMethods(calls), ["POST", "GET", "POST"]);

  const cookies = sessionCookies(response);
  assert.equal(cookies.length, 1);
  const cookieName = sessionConfiguration(SESSION_ENV).cookieName;
  assert.ok(cookies[0].startsWith(`${cookieName}=v1.`));
  assert.match(cookies[0], /HttpOnly/);
  assert.match(cookies[0], /SameSite=Strict/);
  const token = cookies[0].split(";")[0].slice(cookieName.length + 1);
  const claims = openSession(token, SESSION_ENV);
  assert.equal(claims.role, "owner");
  assert.equal(claims.agencyCode, "mml93-a01");

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "google_login_succeeded");
  assert.equal(audits[0].target_table, "login_identities");
});

test("google login sessions expire on the configured code-login lifetime", async () => {
  const login = loginState();
  const { response } = await callLoginHandler(login.url, {
    nonce: login.nonce,
    env: { MI_SESSION_TTL_SECONDS: "1800" },
    routes: [
      googleTokenRoute({ sub: "sub-123" }),
      identityRoute([{ google_sub: "sub-123", google_email: null, role: "owner", code: "mml93-a01", linked_at: null }]),
      ["POST", AUDIT_REST_URL, () => restCreated()],
    ],
  });

  const cookieName = sessionConfiguration(SESSION_ENV).cookieName;
  const cookie = sessionCookies(response)[0];
  assert.match(cookie, /Max-Age=1800/);
  const claims = openSession(cookie.split(";")[0].slice(cookieName.length + 1), SESSION_ENV);
  assert.equal(claims.exp - claims.iat, 1800);
});

test("login callback without a session secret redirects to session-unavailable", async () => {
  const login = loginState();
  const { response, calls } = await callLoginHandler(login.url, {
    nonce: login.nonce,
    env: { MI_SESSION_SECRET: undefined },
    routes: [
      googleTokenRoute({ sub: "sub-123" }),
      identityRoute([{
        google_sub: "sub-123",
        google_email: "owner@example.com",
        role: "owner",
        code: "mml93-a01",
        linked_at: null,
      }]),
    ],
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin?glogin=session-unavailable");
  assert.equal(sessionCookies(response).length, 0);
  // the audit endpoint is never reached when sealing fails
  assert.deepEqual(flowMethods(calls), ["POST", "GET"]);
});

test("login callback audits a failed token exchange and an unusable id token", async () => {
  const audits = [];
  const exchangeFailed = loginState();
  const failed = await callLoginHandler(exchangeFailed.url, {
    nonce: exchangeFailed.nonce,
    routes: [
      ["POST", TOKEN_URL, () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })],
      auditRoute(audits),
    ],
  });
  assert.equal(failed.response.headers.get("location"), "/admin?glogin=exchange-failed");
  assert.deepEqual(audits[0].metadata, { reason: "exchange-failed" });

  const foreign = loginState();
  const noIdentity = await callLoginHandler(foreign.url, {
    nonce: foreign.nonce,
    routes: [
      ["POST", TOKEN_URL, () => new Response(
        JSON.stringify({ id_token: validIdToken({ sub: "sub-123", aud: "attacker-client" }) }),
        { status: 200 },
      )],
      auditRoute(audits),
    ],
  });
  assert.equal(noIdentity.response.headers.get("location"), "/admin?glogin=no-identity");
  assert.deepEqual(audits[1].metadata, { reason: "no-identity" });
  assert.deepEqual(flowMethods(noIdentity.calls), ["POST", "POST"]);
});

test("google login keeps team and client identities out until their role is enabled", async () => {
  const audits = [];
  const teamIdentity = {
    google_sub: "sub-team", google_email: null, role: "team", code: "mml93-t01", linked_at: null,
  };
  const blocked = loginState();
  const notReady = await callLoginHandler(blocked.url, {
    nonce: blocked.nonce,
    routes: [
      googleTokenRoute({ sub: "sub-team" }),
      identityRoute([teamIdentity], "sub-team"),
      auditRoute(audits),
    ],
  });
  assert.equal(notReady.response.headers.get("location"), "/admin?glogin=not-ready");
  assert.equal(sessionCookies(notReady.response).length, 0);
  // the team lookup never runs while the canary keeps google login owner-only
  assert.deepEqual(flowMethods(notReady.calls), ["POST", "GET", "POST"]);
  assert.deepEqual(audits[0].metadata, { reason: "not-ready" });
});

test("an enabled operation-team role logs in with the same claims code login issues", async () => {
  const login = loginState();
  const { response, calls } = await callLoginHandler(login.url, {
    nonce: login.nonce,
    env: { MI_GOOGLE_LOGIN_ROLES: "owner, team" },
    routes: [
      googleTokenRoute({ sub: "sub-team" }),
      identityRoute([{
        google_sub: "sub-team", google_email: null, role: "team", code: "MML93-T01", linked_at: null,
      }], "sub-team"),
      ["GET", TEAM_REST_URL, (call) => {
        assert.match(call.url, /team_code=ilike\.mml93-t01/);
        assert.match(call.url, /status=eq\.active/);
        return restJson([{
          id: "team-1",
          team_name: "운영팀",
          team_code: "mml93-t01",
          status: "active",
          client_id: "client-1",
          revoked_at: null,
        }]);
      }],
      ["GET", CLIENT_REST_URL, () => restJson([{
        id: "client-1",
        name: "고객",
        business_name: "고객사",
        agency_code: "mml93-a02",
        status: "active",
        disconnected_at: null,
      }])],
      ["POST", AUDIT_REST_URL, () => restCreated()],
    ],
  });

  assert.equal(response.headers.get("location"), "/admin?glogin=success");
  assert.deepEqual(flowMethods(calls), ["POST", "GET", "GET", "GET", "POST"]);
  const cookieName = sessionConfiguration(SESSION_ENV).cookieName;
  const cookie = sessionCookies(response)[0];
  const claims = openSession(cookie.split(";")[0].slice(cookieName.length + 1), SESSION_ENV);
  assert.equal(claims.role, "team");
  assert.equal(claims.teamCode, "mml93-t01");
  assert.equal(claims.teamId, "team-1");
  assert.equal(claims.clientId, "client-1");
  assert.equal(claims.agencyCode, "mml93-a02");
});

test("an enabled advertiser role logs in and a revoked code is refused as inactive", async () => {
  const login = loginState();
  const { response, calls } = await callLoginHandler(login.url, {
    nonce: login.nonce,
    env: { MI_GOOGLE_LOGIN_ROLES: "owner,client" },
    routes: [
      googleTokenRoute({ sub: "sub-client" }),
      identityRoute([{
        google_sub: "sub-client", google_email: null, role: "client", code: "mml93-a02", linked_at: null,
      }], "sub-client"),
      ["GET", CLIENT_REST_URL, (call) => {
        assert.match(call.url, /agency_code=ilike\.mml93-a02/);
        return restJson([{
          id: "client-9",
          name: "고객",
          business_name: "고객사",
          agency_code: "mml93-a02",
          status: "active",
          disconnected_at: null,
        }]);
      }],
      ["POST", AUDIT_REST_URL, () => restCreated()],
    ],
  });
  assert.equal(response.headers.get("location"), "/admin?glogin=success");
  const cookieName = sessionConfiguration(SESSION_ENV).cookieName;
  const claims = openSession(sessionCookies(response)[0].split(";")[0].slice(cookieName.length + 1), SESSION_ENV);
  assert.equal(claims.role, "client");
  assert.equal(claims.clientId, "client-9");
  assert.equal(claims.agencyCode, "mml93-a02");
  assert.deepEqual(flowMethods(calls), ["POST", "GET", "GET", "POST"]);

  const audits = [];
  const revoked = loginState();
  const inactive = await callLoginHandler(revoked.url, {
    nonce: revoked.nonce,
    env: { MI_GOOGLE_LOGIN_ROLES: "owner,client" },
    routes: [
      googleTokenRoute({ sub: "sub-client" }),
      identityRoute([{
        google_sub: "sub-client", google_email: null, role: "client", code: "mml93-a02", linked_at: null,
      }], "sub-client"),
      ["GET", CLIENT_REST_URL, () => restJson([])],
      auditRoute(audits),
    ],
  });
  assert.equal(inactive.response.headers.get("location"), "/admin?glogin=inactive");
  assert.equal(sessionCookies(inactive.response).length, 0);
  assert.deepEqual(audits[0].metadata, { reason: "inactive" });
});

test("resolveGoogleLoginAccess keeps the owner canary and reads the role allow-list", async () => {
  const untouched = { supabaseAdmin: { from() { throw new Error("no lookup expected"); } } };
  assert.deepEqual(
    await resolveGoogleLoginAccess({ role: "owner", code: "MML93-A01" }, untouched, {}),
    { ok: true, access: { role: "owner", agencyCode: "mml93-a01" } },
  );
  assert.deepEqual(
    await resolveGoogleLoginAccess({ role: "owner", code: "other-a01" }, untouched, {}),
    { ok: false, reason: "not-ready" },
  );
  assert.deepEqual(
    await resolveGoogleLoginAccess({ role: "team", code: "mml93-t01" }, untouched, {}),
    { ok: false, reason: "not-ready" },
  );
  assert.deepEqual(
    await resolveGoogleLoginAccess({ role: "super", code: "mml93-a01" }, untouched, { MI_GOOGLE_LOGIN_ROLES: "owner,team" }),
    { ok: false, reason: "not-ready" },
  );
  assert.deepEqual(
    await resolveGoogleLoginAccess(null, untouched, {}),
    { ok: false, reason: "not-ready" },
  );
  // a blank allow-list still falls back to the owner-only canary
  assert.deepEqual(
    await resolveGoogleLoginAccess({ role: "owner", code: "mml93-a01" }, untouched, { MI_GOOGLE_LOGIN_ROLES: " , " }),
    { ok: true, access: { role: "owner", agencyCode: "mml93-a01" } },
  );
});

test("link callback inserts a first mapping through the google_sub conflict key", async () => {
  const link = loginState("mml93-a01", "link");
  const writes = identityWriteSinks();
  const audits = [];
  const { response, calls } = await callLoginHandler(link.url, {
    nonce: link.nonce,
    routes: [
      googleTokenRoute({ sub: "sub-123", email: "Owner@Example.com" }),
      identityRoute([], "sub-123", []),
      ...writes.routes,
      auditRoute(audits),
    ],
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin?glogin=linked");
  assert.equal(sessionCookies(response).length, 0);
  assert.deepEqual(flowMethods(calls), ["POST", "GET", "GET", "POST", "POST"]);

  // nothing is ever cleared: an empty target is written, not replaced
  assert.equal(writes.deletes.length, 0);
  assert.equal(writes.patches.length, 0);
  assert.equal(writes.upserts.length, 1);
  assert.match(writes.upserts[0].url, /on_conflict=google_sub/);
  assert.match(writes.upserts[0].prefer, /resolution=merge-duplicates/);
  assert.equal(writes.upserts[0].row.google_sub, "sub-123");
  assert.equal(writes.upserts[0].row.google_email, "owner@example.com");
  assert.equal(writes.upserts[0].row.role, "owner");
  assert.equal(writes.upserts[0].row.code, "mml93-a01");

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "google_login_linked");
  assert.equal(audits[0].target_table, "login_identities");
});

test("link callback moves an occupied target onto the new google account in one update", async () => {
  const link = loginState("mml93-a01", "link");
  const writes = identityWriteSinks();
  const audits = [];
  const before = Date.now();
  const { response, calls } = await callLoginHandler(link.url, {
    nonce: link.nonce,
    routes: [
      googleTokenRoute({ sub: "sub-123", email: "Owner@Example.com" }),
      identityRoute([], "sub-123", [{ google_sub: "sub-old", role: "owner", code: "mml93-a01" }]),
      ...writes.routes,
      auditRoute(audits),
    ],
  });

  assert.equal(response.headers.get("location"), "/admin?glogin=linked");
  assert.deepEqual(flowMethods(calls), ["POST", "GET", "GET", "PATCH", "POST"]);

  // exactly one atomic statement — never a delete, never a second insert
  assert.equal(writes.deletes.length, 0);
  assert.equal(writes.upserts.length, 0);
  assert.equal(writes.patches.length, 1);
  assert.match(writes.patches[0].url, /role=eq\.owner/);
  assert.match(writes.patches[0].url, /code=eq\.mml93-a01/);
  assert.doesNotMatch(writes.patches[0].url, /google_sub=/);
  assert.match(writes.patches[0].prefer, /return=representation/);
  assert.equal(writes.patches[0].row.google_sub, "sub-123");
  assert.equal(writes.patches[0].row.google_email, "owner@example.com");
  assert.ok(Date.parse(writes.patches[0].row.linked_at) >= before);

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "google_login_linked");
});

test("a failed link move leaves the previous google mapping in place", async () => {
  const cases = [
    ["rejected update", () => new Response(JSON.stringify({ message: "conflict" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })],
    // a filter that matches nothing means the row moved underneath us
    ["no row updated", () => restJson([])],
  ];
  for (const [label, patchResponse] of cases) {
    const link = loginState("mml93-a01", "link");
    const writes = identityWriteSinks();
    const { response, calls } = await callLoginHandler(link.url, {
      nonce: link.nonce,
      routes: [
        googleTokenRoute({ sub: "sub-123", email: "Owner@Example.com" }),
        identityRoute([], "sub-123", [{ google_sub: "sub-old", role: "owner", code: "mml93-a01" }]),
        ["DELETE", IDENTITY_REST_URL, (call) => {
          writes.deletes.push(call.url);
          return restJson([]);
        }],
        ["PATCH", IDENTITY_REST_URL, patchResponse],
        ["POST", IDENTITY_REST_URL, (call) => {
          writes.upserts.push(call.url);
          return restCreated();
        }],
      ],
    });

    assert.equal(response.headers.get("location"), "/admin?glogin=save-failed", label);
    assert.deepEqual(flowMethods(calls), ["POST", "GET", "GET", "PATCH"], label);
    // sub-old still owns the mapping: nothing was deleted and nothing replaced it
    assert.equal(writes.deletes.length, 0, label);
    assert.equal(writes.upserts.length, 0, label);
  }
});

test("link callback refuses to re-map a google account that belongs to another login", async () => {
  const audits = [];
  const link = loginState("mml93-a01", "link");
  const { response, calls } = await callLoginHandler(link.url, {
    nonce: link.nonce,
    routes: [
      googleTokenRoute({ sub: "sub-123", email: "Owner@Example.com" }),
      identityRoute([{
        google_sub: "sub-123", google_email: "team@example.com", role: "team", code: "mml93-t01", linked_at: null,
      }]),
      auditRoute(audits),
    ],
  });

  assert.equal(response.headers.get("location"), "/admin?glogin=already-linked");
  // exchange, lookup, audit — no delete and no upsert touch the stored mapping
  assert.deepEqual(flowMethods(calls), ["POST", "GET", "POST"]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "google_login_failed");
  assert.deepEqual(audits[0].metadata, { reason: "already-linked" });

  // the same google account already pointing at this owner code re-links normally
  const owned = loginState("mml93-a01", "link");
  const writes = identityWriteSinks();
  const relink = await callLoginHandler(owned.url, {
    nonce: owned.nonce,
    routes: [
      googleTokenRoute({ sub: "sub-123" }),
      identityRoute([{
        google_sub: "sub-123", google_email: null, role: "owner", code: "MML93-A01", linked_at: null,
      }]),
      ...writes.routes,
      ["POST", AUDIT_REST_URL, () => restCreated()],
    ],
  });
  assert.equal(relink.response.headers.get("location"), "/admin?glogin=linked");
  // the row is already this account's, so it refreshes in place without a target lookup
  assert.deepEqual(flowMethods(relink.calls), ["POST", "GET", "POST", "POST"]);
  assert.equal(writes.deletes.length, 0);
  assert.equal(writes.patches.length, 0);
  assert.equal(writes.upserts.length, 1);
});

test("the owner unlink action records an audit trail without blocking the response", async () => {
  const audits = [];
  const deletes = [];
  const { impl } = loginFetchRouter([
    ["DELETE", IDENTITY_REST_URL, (call) => {
      deletes.push(call.url);
      return restJson([]);
    }],
    auditRoute(audits),
  ]);
  const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => handler.fetch(
    new Request(OWNER_LOGIN_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mi-session-role": "owner",
        "x-mi-owner-agency-code": "mml93-a01",
      },
      body: JSON.stringify({ action: "unlink" }),
    }),
  )));

  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(deletes.length, 1);
  assert.match(deletes[0], /role=eq\.owner/);
  assert.match(deletes[0], /code=eq\.mml93-a01/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "google_login_unlinked");
  assert.equal(audits[0].target_table, "login_identities");
  assert.deepEqual(audits[0].metadata, { role: "owner" });
});

// ---------------------------------------------------------------------------
// 쓰기 가능한 캘린더 목록 (owner action: "calendars")
// ---------------------------------------------------------------------------

const INTEGRATION_REST_URL = `${SUPABASE_TEST_URL}/rest/v1/owner_google_integrations`;
const CALENDAR_SYNC_REST_URL = `${SUPABASE_TEST_URL}/rest/v1/owner_google_calendar_sync`;
const CALENDAR_LIST_URL = `${CALENDAR_BASE}/users/me/calendarList`;
const OWNER_INTEGRATION_ROW = {
  owner_agency_code: "mml93-a01",
  refresh_token: "rt-1",
  calendar_id: "dedicated@group.calendar.google.com",
  google_email: "owner@example.com",
  connected_at: "2026-08-01T00:00:00.000Z",
  sync_status: "ok",
};

function ownerCalendarsRequest() {
  return new Request(OWNER_CALENDAR_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mi-session-role": "owner",
      "x-mi-owner-agency-code": "mml93-a01",
    },
    body: JSON.stringify({ action: "calendars" }),
  });
}

test("the owner calendars action refreshes the catalog from google and returns the cached list", async () => {
  const upserts = [];
  const { calls, impl } = loginFetchRouter([
    ["GET", INTEGRATION_REST_URL, () => restJson([OWNER_INTEGRATION_ROW])],
    ["POST", TOKEN_URL, () => restJson({ access_token: "gat-1" })],
    ["GET", CALENDAR_LIST_URL, (call) => {
      // minAccessRole 은 더 이상 걸지 않는다 — 읽기 전용 캘린더까지 목록에 담는다.
      assert.equal(/minAccessRole/u.test(call.url), false);
      assert.match(call.url, /showHidden=false/);
      assert.match(call.url, /showDeleted=false/);
      return restJson({
        items: [
          { id: "dedicated@group.calendar.google.com", summary: "모먼트 인사이트", accessRole: "owner" },
          { id: "owner@example.com", summary: "내 캘린더", accessRole: "owner", primary: true },
        ],
      });
    }],
    ["POST", CALENDAR_SYNC_REST_URL, (call) => {
      upserts.push(JSON.parse(String(call.body)));
      return restCreated();
    }],
    ["GET", CALENDAR_SYNC_REST_URL, () => restJson([
      { google_calendar_id: "owner@example.com", calendar_role: "primary", calendar_summary: "내 캘린더", calendar_access_role: "owner", calendar_is_primary: true, calendar_writable: true },
      { google_calendar_id: "dedicated@group.calendar.google.com", calendar_role: "dedicated", calendar_summary: "모먼트 인사이트", calendar_access_role: "owner", calendar_is_primary: false, calendar_writable: true },
    ])],
  ]);

  const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => handler.fetch(ownerCalendarsRequest())));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.refreshed, true);
  assert.deepEqual(payload.calendars.map((entry) => entry.id),
    ["dedicated@group.calendar.google.com", "owner@example.com"]);
  assert.equal(payload.calendars[0].dedicated, true);
  assert.equal(payload.calendars[1].primary, true);
  assert.equal(upserts.length, 2);
  assert.equal(upserts[0].calendar_writable, true);
  assert.ok(calls.some((call) => call.url.startsWith(CALENDAR_LIST_URL)));
});

test("the owner calendars action reports 409 before touching google when nothing is connected", async () => {
  const { calls, impl } = loginFetchRouter([
    ["GET", INTEGRATION_REST_URL, () => restJson([])],
  ]);

  const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => handler.fetch(ownerCalendarsRequest())));
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.ok, false);
  assert.match(payload.message, /아직 연결되지 않았습니다/);
  assert.equal(calls.filter((call) => call.url.startsWith(CALENDAR_BASE)).length, 0);
});

test("the owner calendars action fails closed with the shared missing-env shape", async () => {
  const { calls, impl } = loginFetchRouter([]);
  const response = await withEnv({ ...LOGIN_HANDLER_ENV, GOOGLE_OAUTH_CLIENT_ID: undefined }, () => (
    withGlobalFetch(impl, () => handler.fetch(ownerCalendarsRequest()))
  ));
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.code, "missing_google_env");
  assert.equal(calls.length, 0);
});

test("a stale google token still returns the cached calendar list", async () => {
  const { impl } = loginFetchRouter([
    ["GET", INTEGRATION_REST_URL, () => restJson([OWNER_INTEGRATION_ROW])],
    ["POST", TOKEN_URL, () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })],
    ["GET", CALENDAR_SYNC_REST_URL, () => restJson([])],
  ]);

  const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => handler.fetch(ownerCalendarsRequest())));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.refreshed, false);
  assert.deepEqual(payload.calendars, [{
    id: "dedicated@group.calendar.google.com",
    name: "모먼트 인사이트",
    primary: false,
    accessRole: "owner",
    dedicated: true,
  }]);
});

// ---------------------------------------------------------------------------
// 사이드바 캘린더 목록 (owner actions: "calendar-refresh" / "calendar-visibility")
// ---------------------------------------------------------------------------

const HOLIDAY_CALENDAR = "holidays@group.calendar.google.com";

function ownerCalendarRequest(body) {
  return new Request(OWNER_CALENDAR_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mi-session-role": "owner",
      "x-mi-owner-agency-code": "mml93-a01",
    },
    body: JSON.stringify(body),
  });
}

function catalogRestRows() {
  return [
    { google_calendar_id: "dedicated@group.calendar.google.com", calendar_role: "dedicated", calendar_summary: "모먼트 인사이트", calendar_access_role: "owner", calendar_writable: true, calendar_visible: true },
    { google_calendar_id: HOLIDAY_CALENDAR, calendar_role: "secondary", calendar_summary: "대한민국 공휴일", calendar_access_role: "reader", calendar_writable: false, calendar_visible: false, calendar_background_color: "#616161" },
  ];
}

test("calendar-refresh reloads the full calendarList and answers with the sidebar catalog", async () => {
  const { calls, impl } = loginFetchRouter([
    ["GET", INTEGRATION_REST_URL, () => restJson([OWNER_INTEGRATION_ROW])],
    ["POST", TOKEN_URL, () => restJson({ access_token: "gat-1" })],
    ["GET", CALENDAR_LIST_URL, (call) => {
      assert.equal(/minAccessRole/u.test(call.url), false, "읽기 전용 캘린더까지 받아야 한다");
      return restJson({
        items: [
          { id: "dedicated@group.calendar.google.com", summary: "모먼트 인사이트", accessRole: "owner", selected: true },
          { id: HOLIDAY_CALENDAR, summary: "대한민국 공휴일", accessRole: "reader", backgroundColor: "#616161" },
        ],
      });
    }],
    ["POST", CALENDAR_SYNC_REST_URL, () => restCreated()],
    ["GET", CALENDAR_SYNC_REST_URL, () => restJson(catalogRestRows())],
  ]);

  const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => (
    handler.fetch(ownerCalendarRequest({ action: "calendar-refresh" }))
  )));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.refreshed, true);
  assert.deepEqual(payload.calendars.map((entry) => entry.id),
    ["dedicated@group.calendar.google.com", HOLIDAY_CALENDAR]);
  assert.equal(payload.calendars[0].group, "own");
  assert.equal(payload.calendars[1].group, "other");
  assert.equal(payload.calendars[1].writable, false, "읽기 전용 캘린더도 목록에 남는다");
  assert.equal(payload.calendars[1].visible, false);
  assert.equal(payload.calendars[1].color, "#616161");
  assert.ok(calls.some((call) => call.url.startsWith(CALENDAR_LIST_URL)));
});

test("calendar-refresh reports 409 before touching google when nothing is connected", async () => {
  const { calls, impl } = loginFetchRouter([
    ["GET", INTEGRATION_REST_URL, () => restJson([])],
  ]);

  const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => (
    handler.fetch(ownerCalendarRequest({ action: "calendar-refresh" }))
  )));

  assert.equal(response.status, 409);
  assert.equal(calls.filter((call) => call.url.startsWith(CALENDAR_BASE)).length, 0);
});

test("calendar-visibility saves the MI toggle and never calls google", async () => {
  const patches = [];
  const { calls, impl } = loginFetchRouter([
    ["GET", INTEGRATION_REST_URL, () => restJson([OWNER_INTEGRATION_ROW])],
    ["PATCH", CALENDAR_SYNC_REST_URL, (call) => {
      patches.push(JSON.parse(String(call.body)));
      return restJson([{ google_calendar_id: HOLIDAY_CALENDAR }]);
    }],
    ["GET", CALENDAR_SYNC_REST_URL, () => restJson(catalogRestRows())],
  ]);

  const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => (
    handler.fetch(ownerCalendarRequest({ action: "calendar-visibility", calendarId: HOLIDAY_CALENDAR, visible: false }))
  )));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(patches.map((entry) => entry.calendar_visible), [false]);
  assert.equal("calendar_selected" in patches[0], false, "구글 쪽 selected 는 건드리지 않는다");
  assert.deepEqual(payload.calendars.map((entry) => entry.id),
    ["dedicated@group.calendar.google.com", HOLIDAY_CALENDAR]);
  assert.equal(calls.filter((call) => call.url.startsWith(CALENDAR_BASE)).length, 0, "표시 토글은 구글을 부르지 않는다");
  assert.equal(calls.filter((call) => call.url.startsWith(TOKEN_URL)).length, 0);
});

test("calendar-visibility refuses a missing calendar id or a non-boolean flag", async () => {
  const { calls, impl } = loginFetchRouter([]);

  const missing = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => (
    handler.fetch(ownerCalendarRequest({ action: "calendar-visibility", visible: true }))
  )));
  const oversized = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => (
    handler.fetch(ownerCalendarRequest({ action: "calendar-visibility", calendarId: "가".repeat(1025), visible: true }))
  )));
  const badFlag = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => (
    handler.fetch(ownerCalendarRequest({ action: "calendar-visibility", calendarId: HOLIDAY_CALENDAR, visible: "false" }))
  )));

  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).message, "캘린더를 선택해주세요.");
  assert.equal(oversized.status, 400);
  assert.equal(badFlag.status, 400);
  assert.equal((await badFlag.json()).message, "표시 여부 값을 확인해주세요.");
  assert.equal(calls.length, 0, "입력이 틀리면 저장소도 건드리지 않는다");
});

test("calendar-visibility reports 404 for a calendar the catalog does not hold", async () => {
  const { impl } = loginFetchRouter([
    ["GET", INTEGRATION_REST_URL, () => restJson([OWNER_INTEGRATION_ROW])],
    ["PATCH", CALENDAR_SYNC_REST_URL, () => restJson([])],
  ]);

  const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => (
    handler.fetch(ownerCalendarRequest({ action: "calendar-visibility", calendarId: "gone@group.calendar.google.com", visible: true }))
  )));
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.match(payload.message, /찾을 수 없습니다/);
});

test("calendar-visibility asks for the migration when the catalog columns are missing", async () => {
  resetOptionalColumns();
  try {
    const { impl } = loginFetchRouter([
      ["GET", INTEGRATION_REST_URL, () => restJson([OWNER_INTEGRATION_ROW])],
      ["PATCH", CALENDAR_SYNC_REST_URL, () => new Response(
        JSON.stringify({ code: "42703", message: "column owner_google_calendar_sync.calendar_visible does not exist" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )],
    ]);

    const response = await withEnv(LOGIN_HANDLER_ENV, () => withGlobalFetch(impl, () => (
      handler.fetch(ownerCalendarRequest({ action: "calendar-visibility", calendarId: HOLIDAY_CALENDAR, visible: false }))
    )));
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.code, "calendar_catalog_missing");
    assert.match(payload.message, /마이그레이션/);
  } finally {
    resetOptionalColumns();
  }
});

test("the sidebar actions stay owner-only", async () => {
  for (const action of ["calendar-refresh", "calendar-visibility"]) {
    const request = new Request(OWNER_CALENDAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mi-session-role": "team" },
      body: JSON.stringify({ action, calendarId: HOLIDAY_CALENDAR, visible: true }),
    });
    const response = await withEnv(LOGIN_HANDLER_ENV, () => handler.fetch(request));
    assert.equal(response.status, 403);
  }
});

test("the sidebar actions fail closed with the shared missing-env shape", async () => {
  for (const body of [
    { action: "calendar-refresh" },
    { action: "calendar-visibility", calendarId: HOLIDAY_CALENDAR, visible: true },
  ]) {
    const { calls, impl } = loginFetchRouter([]);
    const response = await withEnv({ ...LOGIN_HANDLER_ENV, GOOGLE_OAUTH_CLIENT_ID: undefined }, () => (
      withGlobalFetch(impl, () => handler.fetch(ownerCalendarRequest(body)))
    ));
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.code, "missing_google_env");
    assert.equal(calls.length, 0);
  }
});

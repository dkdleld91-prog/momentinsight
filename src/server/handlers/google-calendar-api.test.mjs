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
  signOauthState,
  syncOwnerScheduleRows,
  upsertLoginIdentity,
  verifyOauthState,
} from "./google-calendar-api.mjs";

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
    ["owner with client scope", { role: "owner", client: { id: "client-1" } }, [personalRow()]],
    ["owner with team scope", { role: "owner", team: { id: "team-1" } }, [personalRow()]],
    ["client row", OWNER_ACCESS, [personalRow({ client_id: "client-1" })]],
    ["team row", OWNER_ACCESS, [personalRow({ operation_team_id: "team-1" })]],
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
        extendedProperties: { private: { miScheduleId: "sched-1" } },
        start: { dateTime: "2026-08-21T05:00:00.000Z", timeZone: "Asia/Seoul" },
        end: { dateTime: "2026-08-21T06:00:00.000Z", timeZone: "Asia/Seoul" },
      });
      return jsonResponse(200, { id: "gev1" });
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
  assert.deepEqual(state.scheduleUpdates[0].values, { google_event_id: "gev1" });
  assert.deepEqual(state.scheduleUpdates[0].filters, [["id", "sched-1"]]);
  assert.equal(state.auditInserts.length, 0);
});

test("sync patches an existing google event without rewriting the stored id", async () => {
  const { ctx, state } = syncContext({ integration: INTEGRATION });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`PATCH ${CALENDAR_BASE}/calendars/cal-1/events/gev-old`]: jsonResponse(200, { id: "gev-old" }),
  });

  const result = await syncOwnerScheduleRows(
    ctx, GOOGLE_ENV, OWNER_ACCESS, [personalRow({ google_event_id: "gev-old" })], "upsert", impl,
  );

  assert.deepEqual(result, { skipped: false, synced: 1, failed: 0 });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "PATCH"]);
  assert.equal(state.scheduleUpdates.length, 0);
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
  assert.deepEqual(state.scheduleUpdates[0].values, { google_event_id: "gev-new" });
  assert.deepEqual(state.scheduleUpdates[0].filters, [["id", "sched-1"]]);
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
const SUPABASE_TEST_URL = "http://supabase.test";
const IDENTITY_REST_URL = `${SUPABASE_TEST_URL}/rest/v1/login_identities`;
const AUDIT_REST_URL = `${SUPABASE_TEST_URL}/rest/v1/audit_logs`;
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

function googleTokenRoute(idTokenPayload) {
  return ["POST", TOKEN_URL, (call) => {
    assert.match(String(call.body), /grant_type=authorization_code/);
    assert.match(String(call.body), /client_id=cid-1/);
    assert.match(String(call.body), /client_secret=sec-1/);
    return new Response(JSON.stringify({ id_token: fakeIdToken(idTokenPayload) }), { status: 200 });
  }];
}

async function callLoginHandler(url, { routes = [], env = {} } = {}) {
  const { calls, impl } = loginFetchRouter(routes);
  const response = await withEnv({ ...LOGIN_HANDLER_ENV, ...env }, () => (
    withGlobalFetch(impl, () => handler.fetch(new Request(url)))
  ));
  return { response, calls };
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

test("google id token decoding extracts the sub and lowercases the email", () => {
  assert.deepEqual(
    decodeGoogleIdToken(fakeIdToken({ sub: "  sub-123  ", email: "  Owner@EXAMPLE.com  " })),
    { sub: "sub-123", email: "owner@example.com" },
  );
  assert.deepEqual(decodeGoogleIdToken(fakeIdToken({ sub: "sub-123" })), { sub: "sub-123", email: null });
  assert.equal(decodeGoogleIdToken(fakeIdToken({ sub: "s".repeat(200) })).sub.length, 128);
});

test("google id token decoding fails closed on missing subs and malformed tokens", () => {
  assert.equal(decodeGoogleIdToken(fakeIdToken({ email: "owner@example.com" })), null);
  assert.equal(decodeGoogleIdToken(fakeIdToken({ sub: "   " })), null);
  assert.equal(decodeGoogleIdToken(""), null);
  assert.equal(decodeGoogleIdToken(null), null);
  assert.equal(decodeGoogleIdToken("one.two"), null);
  assert.equal(decodeGoogleIdToken("a.!!!.c"), null);
  assert.equal(decodeGoogleIdToken(`a.${Buffer.from("not json", "utf8").toString("base64url")}.c`), null);
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
  assert.equal(calls.length, 0);
  const location = new URL(response.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(location.searchParams.get("scope"), "openid email");
  const statePayload = verifyOauthState(location.searchParams.get("state"), GOOGLE_ENV);
  assert.equal(statePayload.p, "login");
  assert.equal(statePayload.owner, "mml93-a01");

  const unconfigured = await callLoginHandler(LOGIN_START_URL, {
    env: { GOOGLE_OAUTH_CLIENT_ID: undefined },
  });
  assert.equal(unconfigured.response.status, 302);
  assert.equal(unconfigured.response.headers.get("location"), "/admin?glogin=not-configured");
});

test("oauth callback redirects forged states and wrong-owner link states without side effects", async () => {
  const linkState = signOauthState("mml93-a01", GOOGLE_ENV, Date.now(), "link");
  const [encoded, signature] = linkState.split(".");
  const tampered = `${encoded}.${(signature[0] === "A" ? "B" : "A") + signature.slice(1)}`;
  const forged = await callLoginHandler(`${OAUTH_CALLBACK_URL}?code=auth-1&state=${encodeURIComponent(tampered)}`);
  assert.equal(forged.response.status, 302);
  assert.equal(forged.response.headers.get("location"), "/admin?gcal=invalid#mi-admin-owner-assistant");
  assert.equal(forged.calls.length, 0);

  const wrongOwner = signOauthState("intruder-a01", GOOGLE_ENV, Date.now(), "link");
  const rejected = await callLoginHandler(`${OAUTH_CALLBACK_URL}?code=auth-1&state=${encodeURIComponent(wrongOwner)}`);
  assert.equal(rejected.response.status, 302);
  assert.equal(rejected.response.headers.get("location"), "/admin?glogin=invalid");
  assert.equal(rejected.calls.length, 0);
});

test("login callback redirects unlinked and non-owner identities without creating a session", async () => {
  const callbackUrl = () => {
    const state = signOauthState("mml93-a01", GOOGLE_ENV, Date.now(), "login");
    return `${OAUTH_CALLBACK_URL}?code=auth-1&state=${encodeURIComponent(state)}`;
  };
  const identityRoute = (rows) => ["GET", IDENTITY_REST_URL, (call) => {
    assert.match(call.url, /google_sub=eq\.sub-123/);
    return restJson(rows);
  }];

  const unlinked = await callLoginHandler(callbackUrl(), {
    routes: [googleTokenRoute({ sub: "sub-123", email: "Owner@Example.com" }), identityRoute([])],
  });
  assert.equal(unlinked.response.status, 302);
  assert.equal(unlinked.response.headers.get("location"), "/admin?glogin=unlinked");
  assert.equal(unlinked.response.headers.getSetCookie().length, 0);
  assert.deepEqual(unlinked.calls.map((call) => call.method), ["POST", "GET"]);

  const teamIdentity = {
    google_sub: "sub-123", google_email: "owner@example.com", role: "team", code: "mml93-a01", linked_at: null,
  };
  const notReady = await callLoginHandler(callbackUrl(), {
    routes: [googleTokenRoute({ sub: "sub-123" }), identityRoute([teamIdentity])],
  });
  assert.equal(notReady.response.headers.get("location"), "/admin?glogin=not-ready");
  assert.equal(notReady.response.headers.getSetCookie().length, 0);

  const wrongCode = await callLoginHandler(callbackUrl(), {
    routes: [
      googleTokenRoute({ sub: "sub-123" }),
      identityRoute([{ ...teamIdentity, role: "owner", code: "other-a01" }]),
    ],
  });
  assert.equal(wrongCode.response.headers.get("location"), "/admin?glogin=not-ready");
  assert.equal(wrongCode.response.headers.getSetCookie().length, 0);
});

test("login callback success seals an owner session cookie and records an audit log", async () => {
  const state = signOauthState("mml93-a01", GOOGLE_ENV, Date.now(), "login");
  const audits = [];
  const { response, calls } = await callLoginHandler(
    `${OAUTH_CALLBACK_URL}?code=auth-1&state=${encodeURIComponent(state)}`,
    {
      routes: [
        googleTokenRoute({ sub: "sub-123", email: "Owner@Example.com" }),
        ["GET", IDENTITY_REST_URL, restJson([{
          google_sub: "sub-123",
          google_email: "owner@example.com",
          role: "owner",
          code: "mml93-a01",
          linked_at: "2026-08-01T00:00:00.000Z",
        }])],
        ["POST", AUDIT_REST_URL, (call) => {
          audits.push(JSON.parse(String(call.body)));
          return restCreated();
        }],
      ],
    },
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin?glogin=success");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET", "POST"]);

  const cookies = response.headers.getSetCookie();
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

test("login callback without a session secret redirects to session-unavailable", async () => {
  const state = signOauthState("mml93-a01", GOOGLE_ENV, Date.now(), "login");
  const { response, calls } = await callLoginHandler(
    `${OAUTH_CALLBACK_URL}?code=auth-1&state=${encodeURIComponent(state)}`,
    {
      env: { MI_SESSION_SECRET: undefined },
      routes: [
        googleTokenRoute({ sub: "sub-123" }),
        ["GET", IDENTITY_REST_URL, restJson([{
          google_sub: "sub-123",
          google_email: "owner@example.com",
          role: "owner",
          code: "mml93-a01",
          linked_at: null,
        }])],
      ],
    },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin?glogin=session-unavailable");
  assert.equal(response.headers.getSetCookie().length, 0);
  // the audit endpoint is never reached when sealing fails
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
});

test("link callback success upserts the identity keyed by google_sub before confirming", async () => {
  const state = signOauthState("mml93-a01", GOOGLE_ENV, Date.now(), "link");
  const upserts = [];
  const audits = [];
  const { response, calls } = await callLoginHandler(
    `${OAUTH_CALLBACK_URL}?code=auth-1&state=${encodeURIComponent(state)}`,
    {
      routes: [
        googleTokenRoute({ sub: "sub-123", email: "Owner@Example.com" }),
        ["POST", IDENTITY_REST_URL, (call) => {
          upserts.push({
            url: call.url,
            prefer: call.headers.get("prefer") || "",
            row: JSON.parse(String(call.body)),
          });
          return restCreated();
        }],
        ["POST", AUDIT_REST_URL, (call) => {
          audits.push(JSON.parse(String(call.body)));
          return restCreated();
        }],
      ],
    },
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin?glogin=linked");
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "POST"]);

  assert.equal(upserts.length, 1);
  assert.match(upserts[0].url, /on_conflict=google_sub/);
  assert.match(upserts[0].prefer, /resolution=merge-duplicates/);
  assert.equal(upserts[0].row.google_sub, "sub-123");
  assert.equal(upserts[0].row.google_email, "owner@example.com");
  assert.equal(upserts[0].row.role, "owner");
  assert.equal(upserts[0].row.code, "mml93-a01");

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "google_login_linked");
  assert.equal(audits[0].target_table, "login_identities");
});

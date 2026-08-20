import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGoogleAuthUrl,
  loadOwnerGoogleIntegration,
  mapScheduleRowToGoogleEvent,
  signOauthState,
  syncOwnerScheduleRows,
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

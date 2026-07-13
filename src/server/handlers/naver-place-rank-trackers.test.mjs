import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  handlePlaceRankTrackersRequest,
  normalizePlaceRankGroupName,
  placeTrackerPayload,
  runDuePlaceTrackers,
} from "./naver-place-rank-trackers.mjs";

const AGENCY_CODE = "mml93-a01";
const ADMIN_CODE = "place-rank-group-test";
const TRACKERS = "naver_place_rank_trackers";
const SNAPSHOTS = "naver_place_rank_snapshots";

function trackerRow(values = {}) {
  const now = "2026-07-12T00:00:00.000Z";
  return {
    id: values.id || "tracker-1",
    client_id: null,
    brand_id: null,
    agency_code: AGENCY_CODE,
    keyword: "성수 카페",
    place_url: null,
    place_id: "1234567890",
    place_name: "테스트 플레이스",
    max_rank: 300,
    status: "active",
    started_at: now,
    last_checked_at: null,
    next_check_at: now,
    current_rank: null,
    best_rank: null,
    worst_rank: null,
    check_count: 0,
    found_count: 0,
    last_message: "대기",
    last_error: null,
    processing_token: null,
    processing_started_at: null,
    processing_until: null,
    last_attempt_at: null,
    retry_count: 0,
    sort_order: 100,
    created_at: now,
    updated_at: now,
    group_name: "기본 그룹",
    ...values,
  };
}

class MockQuery {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.operation = "select";
    this.filters = [];
    this.orders = [];
    this.limitValue = null;
    this.columns = "*";
    this.selectOptions = {};
    this.values = null;
  }

  select(columns = "*", options = {}) {
    this.columns = columns;
    this.selectOptions = options;
    return this;
  }

  insert(values) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  update(values) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column, values) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  ilike(column, value) {
    const expected = String(value).toLowerCase();
    this.filters.push((row) => String(row[column] || "").toLowerCase() === expected);
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  maybeSingle() {
    return this.execute("maybeSingle");
  }

  single() {
    return this.execute("single");
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute(mode = "many") {
    const groupColumnRequested = this.table === TRACKERS && (
      String(this.columns).includes("group_name") ||
      Object.prototype.hasOwnProperty.call(this.values || {}, "group_name")
    );
    if (this.state.missingGroupColumn && groupColumnRequested) {
      return { data: null, error: { message: "column group_name does not exist" } };
    }

    const tableRows = this.state.tables[this.table] || [];
    const matches = (row) => this.filters.every((filter) => filter(row));
    let rows;

    if (this.operation === "insert") {
      const inserted = this.table === TRACKERS
        ? trackerRow({
          ...this.values,
          id: `tracker-${this.state.nextId++}`,
          group_name: this.values.group_name || "기본 그룹",
        })
        : { ...this.values, id: `snapshot-${this.state.nextId++}` };
      tableRows.push(inserted);
      rows = [inserted];
    } else if (this.operation === "update") {
      rows = tableRows.filter(matches);
      rows.forEach((row) => Object.assign(row, this.values));
    } else if (this.operation === "delete") {
      rows = tableRows.filter(matches);
      this.state.tables[this.table] = tableRows.filter((row) => !matches(row));
    } else {
      rows = tableRows.filter(matches);
    }

    for (const { column, ascending } of [...this.orders].reverse()) {
      rows.sort((left, right) => {
        if (left[column] === right[column]) return 0;
        const result = left[column] > right[column] ? 1 : -1;
        return ascending ? result : -result;
      });
    }
    if (Number.isFinite(this.limitValue)) rows = rows.slice(0, this.limitValue);

    if (this.selectOptions.count === "exact" && this.selectOptions.head) {
      return { data: null, count: rows.length, error: null };
    }
    if (mode === "maybeSingle") return { data: rows[0] || null, error: null };
    if (mode === "single") {
      return rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { message: "single row not found" } };
    }
    return { data: rows, error: null };
  }
}

function testContext(rows = [], options = {}) {
  const state = {
    missingGroupColumn: Boolean(options.missingGroupColumn),
    nextId: 10,
    tables: {
      [TRACKERS]: rows.map((row) => trackerRow(row)),
      [SNAPSHOTS]: [],
    },
  };
  return {
    state,
    ctx: {
      supabaseAdmin: {
        from(table) {
          return new MockQuery(state, table);
        },
        async rpc(name, params = {}) {
          if (name !== "claim_due_naver_place_rank_tracker") {
            return { data: null, error: { message: `unknown rpc: ${name}` } };
          }
          const requestedAgencyCodes = params.requested_agency_codes;
          const now = Date.now();
          const tracker = state.tables[TRACKERS]
            .filter((row) => row.status === "active")
            .filter((row) => !requestedAgencyCodes?.length || requestedAgencyCodes.includes(row.agency_code))
            .filter((row) => new Date(row.next_check_at).getTime() <= now)
            .filter((row) => !row.processing_until || new Date(row.processing_until).getTime() <= now)
            .sort((left, right) => new Date(left.next_check_at) - new Date(right.next_check_at))[0];
          if (!tracker) return { data: [], error: null };
          tracker.processing_token = `claim-${state.nextId++}`;
          tracker.processing_started_at = new Date().toISOString();
          tracker.processing_until = new Date(now + 180_000).toISOString();
          tracker.last_attempt_at = new Date().toISOString();
          return { data: [{ ...tracker }], error: null };
        },
      },
    },
  };
}

function request(method, body) {
  return new Request("http://localhost/api/naver-place-rank-trackers?agencyCode=" + AGENCY_CODE, {
    method,
    headers: {
      "content-type": "application/json",
      "x-demo-admin-code": ADMIN_CODE,
      "x-mi-agency-code": AGENCY_CODE,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function payload(response) {
  return { status: response.status, body: await response.json() };
}

const originalEnv = {
  adminCode: process.env.MI_RANK_ADMIN_CODE,
  providerUrl: process.env.NAVER_PLACE_RANK_API_URL,
  providerKey: process.env.NAVER_PLACE_RANK_API_KEY,
  openapiId: process.env.NAVER_OPENAPI_CLIENT_ID,
  openapiSecret: process.env.NAVER_OPENAPI_CLIENT_SECRET,
  datalabId: process.env.NAVER_DATALAB_CLIENT_ID,
  datalabSecret: process.env.NAVER_DATALAB_CLIENT_SECRET,
};

test.before(() => {
  process.env.MI_RANK_ADMIN_CODE = ADMIN_CODE;
  delete process.env.NAVER_PLACE_RANK_API_URL;
  delete process.env.NAVER_PLACE_RANK_API_KEY;
  delete process.env.NAVER_OPENAPI_CLIENT_ID;
  delete process.env.NAVER_OPENAPI_CLIENT_SECRET;
  delete process.env.NAVER_DATALAB_CLIENT_ID;
  delete process.env.NAVER_DATALAB_CLIENT_SECRET;
});

test.after(() => {
  const envNames = {
    MI_RANK_ADMIN_CODE: originalEnv.adminCode,
    NAVER_PLACE_RANK_API_URL: originalEnv.providerUrl,
    NAVER_PLACE_RANK_API_KEY: originalEnv.providerKey,
    NAVER_OPENAPI_CLIENT_ID: originalEnv.openapiId,
    NAVER_OPENAPI_CLIENT_SECRET: originalEnv.openapiSecret,
    NAVER_DATALAB_CLIENT_ID: originalEnv.datalabId,
    NAVER_DATALAB_CLIENT_SECRET: originalEnv.datalabSecret,
  };
  Object.entries(envNames).forEach(([name, value]) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
});

test("normalizes place rank group names like product rank groups", () => {
  assert.equal(normalizePlaceRankGroupName(""), "기본 그룹");
  assert.equal(normalizePlaceRankGroupName("  서울   매장  "), "서울 매장");
  assert.equal(normalizePlaceRankGroupName("가".repeat(50)).length, 40);
});

test("reads legacy rows as the default group before the migration is applied", async () => {
  const { ctx } = testContext([{ id: "legacy", group_name: undefined, max_rank: 1000 }], { missingGroupColumn: true });
  const result = await payload(await handlePlaceRankTrackersRequest(request("GET"), ctx));

  assert.equal(result.status, 200);
  assert.equal(result.body.trackers[0].groupName, "기본 그룹");
  assert.equal(result.body.trackers[0].maxRank, 300);
});

test("returns 409 when a group update reaches a database without the migration", async () => {
  const { ctx } = testContext([{ id: "legacy", group_name: undefined }], { missingGroupColumn: true });
  const result = await payload(await handlePlaceRankTrackersRequest(request("POST", {
    action: "group",
    trackerId: "legacy",
    groupName: "신규 그룹",
  }), ctx));

  assert.equal(result.status, 409);
  assert.equal(result.body.ok, false);
});

test("creates from a place URL only and preserves groups through update and refresh", async () => {
  const { ctx, state } = testContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    url: "https://map.naver.com/p/entry/place/9876543210?placePath=%2Fhome",
    headers: new Headers({ "content-type": "text/plain" }),
  });
  let created;
  try {
    created = await payload(await handlePlaceRankTrackersRequest(request("POST", {
      action: "create",
      keyword: "강남 맛집",
      placeUrl: "https://naver.me/place-url-only",
      group_name: "  강남   지점  ",
      maxRank: 1000,
    }), ctx));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(created.status, 201);
  assert.equal(created.body.tracker.groupName, "강남 지점");
  assert.equal(created.body.tracker.maxRank, 300);
  assert.equal(created.body.tracker.placeId, "9876543210");
  assert.equal(created.body.tracker.placeUrl, "https://map.naver.com/p/entry/place/9876543210?placePath=%2Fhome");
  assert.equal(state.tables[TRACKERS][0].group_name, "강남 지점");
  assert.equal(state.tables[TRACKERS][0].max_rank, 300);
  assert.equal(state.tables[TRACKERS][0].place_id, "9876543210");
  assert.equal(state.tables[TRACKERS][0].place_name, null);

  const trackerId = created.body.tracker.id;
  const grouped = await payload(await handlePlaceRankTrackersRequest(request("POST", {
    action: "group",
    trackerId,
    groupName: "핵심 매장",
  }), ctx));
  assert.equal(grouped.status, 200);
  assert.equal(grouped.body.tracker.groupName, "핵심 매장");

  const checked = await payload(await handlePlaceRankTrackersRequest(request("POST", {
    action: "check",
    trackerId,
  }), ctx));
  assert.equal(checked.status, 200);
  assert.equal(checked.body.tracker.groupName, "핵심 매장");
});

test("deletes owned trackers and returns 404 when no row was deleted", async () => {
  const { ctx } = testContext([{ id: "delete-me", group_name: "삭제 그룹" }]);
  const deleted = await payload(await handlePlaceRankTrackersRequest(request("POST", {
    action: "delete",
    trackerId: "delete-me",
  }), ctx));
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deletedId, "delete-me");

  const missing = await payload(await handlePlaceRankTrackersRequest(request("POST", {
    action: "delete",
    trackerId: "delete-me",
  }), ctx));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);
});

test("migration backfills legacy rows and enforces the default group", () => {
  const migration = fs.readFileSync(
    new URL("../../../supabase/migrations/20260712090000_naver_place_rank_tracker_groups.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /add column if not exists group_name text/);
  assert.match(migration, /set group_name = '기본 그룹'/);
  assert.match(migration, /alter column group_name set default '기본 그룹'/);
  assert.match(migration, /alter column group_name set not null/);
});

test("returns only the most recent 30 days of place rank history", () => {
  const now = Date.now();
  const snapshot = (id, daysAgo) => ({
    id,
    tracker_id: "tracker-1",
    checked_at: new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    rank: daysAgo + 1,
    matched: true,
    checked_count: 300,
    total: 300,
    place: {},
    message: "ok",
    source: "test",
    created_at: new Date(now).toISOString(),
  });

  const tracker = placeTrackerPayload(trackerRow(), [
    snapshot("today", 0),
    snapshot("day-29", 29),
    snapshot("day-31", 31),
  ]);

  assert.deepEqual(tracker.snapshots.map((item) => item.id), ["today", "day-29"]);
  assert.equal(tracker.snapshots[0].requestedMaxRank, 300);
  assert.equal(tracker.snapshots[0].complete, true);
  assert.equal(tracker.snapshots[0].partial, false);
});

test("marks a short place-rank snapshot as partial instead of 300-rank absence", () => {
  const tracker = placeTrackerPayload(trackerRow(), [{
    id: "partial",
    tracker_id: "tracker-1",
    checked_at: new Date().toISOString(),
    rank: null,
    matched: false,
    checked_count: 54,
    total: 54,
    place: { id: "2019299673", name: "팽오리농장 부평점" },
    message: "오가닉 54개까지 부분 확인",
    source: "naver_map_pc_list_collector_fallback",
    created_at: new Date().toISOString(),
  }]);

  assert.equal(tracker.snapshots[0].checkedCount, 54);
  assert.equal(tracker.snapshots[0].complete, false);
  assert.equal(tracker.snapshots[0].partial, true);
});

test("processes multiple due place trackers up to the requested batch limit", async () => {
  const dueAt = "2026-01-01T00:00:00.000Z";
  const { ctx, state } = testContext([
    { id: "due-1", place_id: "101", next_check_at: dueAt },
    { id: "due-2", place_id: "102", next_check_at: dueAt },
    { id: "due-3", place_id: "103", next_check_at: dueAt },
    { id: "due-4", place_id: "104", next_check_at: dueAt },
  ]);
  const originalFetch = globalThis.fetch;
  const previousProviderUrl = process.env.NAVER_PLACE_RANK_API_URL;
  const previousProviderKey = process.env.NAVER_PLACE_RANK_API_KEY;
  process.env.NAVER_PLACE_RANK_API_URL = "https://collector.example.test/rank";
  process.env.NAVER_PLACE_RANK_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      ok: true,
      matched: true,
      rank: Number(requestBody.placeId) - 100,
      checkedCount: 300,
      total: 300,
      complete: true,
      place: { id: requestBody.placeId, name: "테스트 플레이스" },
      source: "test-collector",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const summary = await runDuePlaceTrackers(ctx, { agencyCode: AGENCY_CODE, limit: 3 });
    assert.equal(summary.checked, 3);
    assert.equal(summary.succeeded, 3);
    assert.equal(summary.found, 3);
    assert.equal(state.tables[SNAPSHOTS].length, 3);
    assert.equal(state.tables[TRACKERS].filter((row) => row.last_checked_at).length, 3);
    assert.equal(state.tables[TRACKERS].find((row) => row.id === "due-4").last_checked_at, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProviderUrl === undefined) delete process.env.NAVER_PLACE_RANK_API_URL;
    else process.env.NAVER_PLACE_RANK_API_URL = previousProviderUrl;
    if (previousProviderKey === undefined) delete process.env.NAVER_PLACE_RANK_API_KEY;
    else process.env.NAVER_PLACE_RANK_API_KEY = previousProviderKey;
  }
});

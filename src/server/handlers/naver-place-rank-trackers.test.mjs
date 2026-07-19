import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  assertSafeNaverPlaceUrl,
  handlePlaceRankTrackersRequest,
  loadSnapshots as loadPlaceSnapshots,
  normalizePlaceRankGroupName,
  placeTrackerPayload,
  requestAccessCode,
  requestAgencyCode,
  resolveNaverPlaceUrl,
  runDuePlaceTrackers,
  runPlaceTrackerCheck,
} from "./naver-place-rank-trackers.mjs";

const AGENCY_CODE = "mml93-a01";
const ADMIN_CODE = "place-rank-group-test";
const TRACKERS = "naver_place_rank_trackers";
const SNAPSHOTS = "naver_place_rank_snapshots";
const CLIENTS = "clients";

test("trusted place-rank headers override conflicting body scope", () => {
  const request = new Request("https://example.com/api/naver-place-rank-trackers?agencyCode=mml93-a98", {
    headers: {
      "x-mi-agency-code": "mml93-a02",
      "x-mi-rank-access-code": "mml93-a02",
    },
  });
  const body = { agencyCode: "mml93-a99", accessCode: "mml93-a99" };
  assert.equal(requestAgencyCode(request, body), "mml93-a02");
  assert.equal(requestAccessCode(request, body), "mml93-a02");
});

test("a place code-session request never falls back to body or query credentials", () => {
  const request = new Request("https://example.com/api/naver-place-rank-trackers?agencyCode=mml93-a98", {
    headers: { "x-mi-session-role": "team", "x-mi-session-scope": "account-only" },
  });
  const body = { agencyCode: "mml93-a99", accessCode: "mml93-a99" };
  assert.equal(requestAgencyCode(request, body), "");
  assert.equal(requestAccessCode(request, body), "");
});

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
    this.rangeStart = 0;
    this.rangeEnd = null;
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

  is(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  lte(column, value) {
    const expected = new Date(value).getTime();
    this.filters.push((row) => new Date(row[column]).getTime() <= expected);
    return this;
  }

  gte(column, value) {
    const expected = new Date(value).getTime();
    this.filters.push((row) => new Date(row[column]).getTime() >= expected);
    return this;
  }

  or(expression) {
    const leaseMatch = String(expression).match(/^processing_until\.is\.null,processing_until\.lte\.(.+)$/);
    if (!leaseMatch) throw new Error(`unsupported mock or expression: ${expression}`);
    const expected = new Date(leaseMatch[1]).getTime();
    this.filters.push((row) => !row.processing_until || new Date(row.processing_until).getTime() <= expected);
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

  range(from, to) {
    this.rangeStart = from;
    this.rangeEnd = to;
    this.state.ranges.push({ table: this.table, from, to });
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
    const totalCount = rows.length;
    if (Number.isFinite(this.limitValue)) rows = rows.slice(0, this.limitValue);
    if (Number.isFinite(this.rangeEnd)) rows = rows.slice(this.rangeStart, this.rangeEnd + 1);

    if (this.selectOptions.count === "exact" && this.selectOptions.head) {
      return { data: null, count: totalCount, error: null };
    }
    if (mode === "maybeSingle") return { data: rows[0] || null, error: null };
    if (mode === "single") {
      return rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { message: "single row not found" } };
    }
    return {
      data: rows,
      count: this.selectOptions.count === "exact" ? totalCount : null,
      error: null,
    };
  }
}

function testContext(rows = [], options = {}) {
  const state = {
    missingGroupColumn: Boolean(options.missingGroupColumn),
    nextId: 10,
    lastRpcParams: null,
    ranges: [],
    tables: {
      [TRACKERS]: rows.map((row) => trackerRow(row)),
      [SNAPSHOTS]: (options.snapshots || []).map((row) => ({ ...row })),
      [CLIENTS]: (options.clients || []).map((row) => ({ ...row })),
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
          state.lastRpcParams = { ...params };
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
          tracker.processing_until = new Date(now + Number(params.lease_seconds || 0) * 1000).toISOString();
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

function clientRequest(method, body, options = {}) {
  const agencyCode = options.agencyCode || AGENCY_CODE;
  const headers = {
    "content-type": "application/json",
    "x-mi-agency-code": agencyCode,
  };
  if (options.accessCode !== null) headers["x-mi-rank-access-code"] = options.accessCode || agencyCode;
  return new Request("http://localhost/api/naver-place-rank-trackers?agencyCode=" + agencyCode, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function payload(response) {
  return { status: response.status, body: await response.json() };
}

async function withExternalProvider(fetchImpl, callback) {
  const originalFetch = globalThis.fetch;
  const previousProviderUrl = process.env.NAVER_PLACE_RANK_API_URL;
  const previousProviderKey = process.env.NAVER_PLACE_RANK_API_KEY;
  process.env.NAVER_PLACE_RANK_API_URL = "https://collector.example.test/rank";
  process.env.NAVER_PLACE_RANK_API_KEY = "test-key";
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProviderUrl === undefined) delete process.env.NAVER_PLACE_RANK_API_URL;
    else process.env.NAVER_PLACE_RANK_API_URL = previousProviderUrl;
    if (previousProviderKey === undefined) delete process.env.NAVER_PLACE_RANK_API_KEY;
    else process.env.NAVER_PLACE_RANK_API_KEY = previousProviderKey;
  }
}

async function withOfficialProvider(fetchImpl, callback) {
  const originalFetch = globalThis.fetch;
  const previous = {
    providerUrl: process.env.NAVER_PLACE_RANK_API_URL,
    providerKey: process.env.NAVER_PLACE_RANK_API_KEY,
    openapiId: process.env.NAVER_OPENAPI_CLIENT_ID,
    openapiSecret: process.env.NAVER_OPENAPI_CLIENT_SECRET,
  };
  delete process.env.NAVER_PLACE_RANK_API_URL;
  delete process.env.NAVER_PLACE_RANK_API_KEY;
  process.env.NAVER_OPENAPI_CLIENT_ID = "official-test-id";
  process.env.NAVER_OPENAPI_CLIENT_SECRET = "official-test-secret";
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    const restore = {
      NAVER_PLACE_RANK_API_URL: previous.providerUrl,
      NAVER_PLACE_RANK_API_KEY: previous.providerKey,
      NAVER_OPENAPI_CLIENT_ID: previous.openapiId,
      NAVER_OPENAPI_CLIENT_SECRET: previous.openapiSecret,
    };
    Object.entries(restore).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
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

test("place tracker lists expose complete scope metadata and cap responses at 500 rows", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    id: `tracker-${String(index).padStart(3, "0")}`,
    sort_order: index,
    created_at: new Date(Date.now() - index * 1000).toISOString(),
  }));
  const { ctx } = testContext(rows);
  const result = await payload(await handlePlaceRankTrackersRequest(request("GET"), ctx));

  assert.equal(result.status, 200);
  assert.equal(result.body.scopeKey, AGENCY_CODE);
  assert.equal(result.body.scopeAgencyCode, AGENCY_CODE);
  assert.equal(result.body.scopeClientId, "");
  assert.equal(result.body.returnedCount, 500);
  assert.equal(result.body.totalCount, 501);
  assert.equal(result.body.trackers.length, 500);
  assert.equal(result.body.hasMore, true);
  assert.equal(result.body.complete, false);
});

test("advertiser place tracker lists return the resolved client scope", async () => {
  const { ctx } = testContext([{ id: "client-tracker" }], {
    clients: [{ id: "client-1", agency_code: AGENCY_CODE, status: "active", disconnected_at: null }],
  });
  const result = await payload(await handlePlaceRankTrackersRequest(clientRequest("GET"), ctx));

  assert.equal(result.status, 200);
  assert.equal(result.body.scopeKey, AGENCY_CODE);
  assert.equal(result.body.scopeAgencyCode, AGENCY_CODE);
  assert.equal(result.body.scopeClientId, "client-1");
  assert.equal(result.body.returnedCount, 1);
  assert.equal(result.body.totalCount, 1);
  assert.equal(result.body.hasMore, false);
  assert.equal(result.body.complete, true);
});

test("place snapshot loading paginates recent history instead of applying one global limit", async () => {
  const now = Date.now();
  const trackerIds = Array.from({ length: 12 }, (_, index) => `place-tracker-${index}`);
  const snapshots = trackerIds.flatMap((trackerId) => [
    ...Array.from({ length: 100 }, (_, snapshotIndex) => ({
      id: `${trackerId}-recent-${snapshotIndex}`,
      tracker_id: trackerId,
      checked_at: new Date(now - snapshotIndex * 60 * 60 * 1000).toISOString(),
    })),
    {
      id: `${trackerId}-old`,
      tracker_id: trackerId,
      checked_at: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ]);
  const { ctx, state } = testContext([], { snapshots });

  const grouped = await loadPlaceSnapshots(ctx, trackerIds);
  trackerIds.forEach((trackerId) => assert.equal(grouped.get(trackerId).length, 100));
  assert.equal(Array.from(grouped.values()).flat().some((snapshot) => snapshot.id.endsWith("-old")), false);
  assert.deepEqual(
    state.ranges.filter((entry) => entry.table === SNAPSHOTS).map(({ from, to }) => [from, to]),
    [[0, 999], [1000, 1999]],
  );
});

test("accepts only HTTPS Naver place hosts before resolving them", async () => {
  const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];

  assert.equal(
    await assertSafeNaverPlaceUrl(
      "https://map.naver.com/p/entry/place/2019299673?placePath=%2Fhome",
      publicLookup,
      true,
    ),
    "https://map.naver.com/p/entry/place/2019299673?placePath=%2Fhome",
  );
  assert.equal(
    await assertSafeNaverPlaceUrl("naver.me/example", publicLookup, true),
    "https://naver.me/example",
  );

  await assert.rejects(
    assertSafeNaverPlaceUrl("http://map.naver.com/p/entry/place/2019299673", publicLookup, true),
    /unsafe_naver_place_url/,
  );
  await assert.rejects(
    assertSafeNaverPlaceUrl("https://naver.example.test/p/entry/place/2019299673", publicLookup, true),
    /unsafe_naver_place_url/,
  );
  await assert.rejects(
    assertSafeNaverPlaceUrl("https://127.0.0.1/p/entry/place/2019299673", publicLookup, true),
    /unsafe_naver_place_url/,
  );
});

test("rejects Naver hosts when DNS includes a private or link-local address", async () => {
  const unsafeAddresses = [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
  ];

  for (const address of unsafeAddresses) {
    await assert.rejects(
      assertSafeNaverPlaceUrl(
        "https://map.naver.com/p/entry/place/2019299673",
        async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        true,
      ),
      /unsafe_naver_place_dns/,
      address,
    );
  }

  await assert.rejects(
    assertSafeNaverPlaceUrl(
      "https://map.naver.com/p/entry/place/2019299673",
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
      true,
    ),
    /unsafe_naver_place_dns/,
  );
});

test("stops before fetching a redirect whose Naver hostname resolves privately", async () => {
  const originalUrl = "https://naver.me/place-short-link";
  const lookupHosts = [];
  let fetchCalls = 0;
  const result = await resolveNaverPlaceUrl(originalUrl, {
    enforceDns: true,
    lookup: async (hostname) => {
      lookupHosts.push(hostname);
      return hostname === "naver.me"
        ? [{ address: "8.8.8.8", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://map.naver.com/p/entry/place/2019299673" },
      });
    },
  });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(lookupHosts, ["naver.me", "map.naver.com"]);
  assert.equal(result.url, originalUrl);
  assert.equal(result.resolved, false);
});

test("enforces the Naver place redirect limit", async () => {
  const originalUrl = "https://naver.me/redirect-loop";
  let fetchCalls = 0;
  const result = await resolveNaverPlaceUrl(originalUrl, {
    enforceDns: true,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://map.naver.com/redirect/${fetchCalls}` },
      });
    },
  });

  assert.equal(fetchCalls, 4);
  assert.equal(result.url, originalUrl);
  assert.equal(result.resolved, false);
});

test("does not read an oversized Naver place HTML response", async () => {
  let readerRequested = false;
  const result = await resolveNaverPlaceUrl("https://naver.me/oversized-html", {
    enforceDns: true,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetchImpl: async () => ({
      status: 200,
      headers: new Headers({
        "content-type": "text/html; charset=utf-8",
        "content-length": String(512 * 1024 + 1),
      }),
      body: {
        getReader() {
          readerRequested = true;
          throw new Error("oversized body must not be read");
        },
      },
    }),
  });

  assert.equal(readerRequested, false);
  assert.equal(result.placeName, "");
  assert.equal(result.placeId, "");
  assert.equal(result.resolved, false);
});

test("resolves a missing place name from the bounded official mobile detail page", async () => {
  const originalUrl = "https://map.naver.com/p/entry/place/2019299673?placePath=%2Fhome";
  const mobileHtml = [
    "<html><head>",
    "<meta property=\"og:title\" content=\"팽오리농장 부평점 : 네이버\u001c\">",
    "</head><body>",
    "x".repeat(540 * 1024),
    "</body></html>",
  ].join("");
  const requestedUrls = [];

  const result = await resolveNaverPlaceUrl(originalUrl, {
    enforceDns: true,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      if (String(url) === originalUrl) {
        return new Response("<html><head></head><body>map shell</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (String(url).includes("/place/2019299673/home")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://m.place.naver.com/restaurant/2019299673/home" },
        });
      }
      return new Response(mobileHtml, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(Buffer.byteLength(mobileHtml)),
        },
      });
    },
  });

  assert.equal(result.placeId, "2019299673");
  assert.equal(result.placeName, "팽오리농장 부평점");
  assert.deepEqual(requestedUrls, [
    originalUrl,
    "https://m.place.naver.com/place/2019299673/home",
    "https://m.place.naver.com/restaurant/2019299673/home",
  ]);
});

test("allows advertiser sync-due with its rank access code and rejects invalid access", async () => {
  const { ctx } = testContext([], {
    clients: [{ id: "client-1", agency_code: AGENCY_CODE, status: "active", disconnected_at: null }],
  });

  const allowed = await payload(await handlePlaceRankTrackersRequest(clientRequest("POST", {
    action: "sync-due",
    limit: 1,
  }), ctx));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);
  assert.equal(allowed.body.summary.checked, 0);

  const missing = await payload(await handlePlaceRankTrackersRequest(clientRequest("POST", {
    action: "sync-due",
    limit: 1,
  }, { accessCode: null }), ctx));
  assert.equal(missing.status, 401);
  assert.equal(missing.body.ok, false);

  const wrong = await payload(await handlePlaceRankTrackersRequest(clientRequest("POST", {
    action: "sync-due",
    limit: 1,
  }, { accessCode: "wrong-agency" }), ctx));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.ok, false);
});

test("returns 502 when a due place refresh fails and preserves it for retry", async () => {
  const { ctx, state } = testContext([{
    id: "retry-place",
    current_rank: 12,
    best_rank: 8,
    worst_rank: 17,
    check_count: 9,
    last_checked_at: "2026-07-15T00:00:00.000Z",
    next_check_at: "2026-01-01T00:00:00.000Z",
  }], {
    clients: [{ id: "client-1", agency_code: AGENCY_CODE, status: "active", disconnected_at: null }],
  });

  const result = await payload(await handlePlaceRankTrackersRequest(clientRequest("POST", {
    action: "sync-due",
    limit: 1,
  }), ctx));
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.summary.failed, 1);
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.tables[TRACKERS][0].current_rank, 12);
  assert.equal(state.tables[TRACKERS][0].check_count, 9);
  assert.equal(state.tables[TRACKERS][0].retry_count, 1);
});

test("rejects a malformed successful provider response without creating a snapshot", async () => {
  const { ctx, state } = testContext([{
    id: "malformed-provider",
    current_rank: 12,
    best_rank: 8,
    worst_rank: 17,
    check_count: 9,
  }]);

  const result = await withExternalProvider(
    async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failed");
  assert.equal(result.error, "place_rank_provider_invalid_response");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.tables[TRACKERS][0].current_rank, 12);
  assert.equal(state.tables[TRACKERS][0].best_rank, 8);
  assert.equal(state.tables[TRACKERS][0].worst_rank, 17);
  assert.equal(state.tables[TRACKERS][0].check_count, 9);
  assert.equal(state.tables[TRACKERS][0].retry_count, 1);
});

test("rejects contradictory or non-numeric place ranks from a successful provider", async () => {
  const payloads = [
    { ok: true, matched: false, rank: "abc", checkedCount: 300, complete: true },
    { ok: true, matched: false, rank: 7, checkedCount: 300, complete: true },
  ];

  for (const [index, providerPayload] of payloads.entries()) {
    const { ctx, state } = testContext([{
      id: `invalid-rank-${index}`,
      current_rank: 12,
      best_rank: 8,
      worst_rank: 17,
      check_count: 9,
    }]);

    const result = await withExternalProvider(
      async () => new Response(JSON.stringify(providerPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "place_rank_provider_invalid_response");
    assert.equal(state.tables[SNAPSHOTS].length, 0);
    assert.equal(state.tables[TRACKERS][0].current_rank, 12);
    assert.equal(state.tables[TRACKERS][0].check_count, 9);
  }
});

test("rejects a provider result whose explicit place ID conflicts with the tracker", async () => {
  const { ctx, state } = testContext([{
    id: "conflicting-provider-id",
    place_id: "2019299673",
    place_name: "팽오리농장 부평점",
    current_rank: 12,
    check_count: 9,
  }]);

  const result = await withExternalProvider(
    async () => new Response(JSON.stringify({
      ok: true,
      matched: true,
      rank: 7,
      checkedCount: 7,
      place: { id: "9999999999", name: "팽오리농장 부평점" },
      source: "test-collector",
    }), { status: 200, headers: { "content-type": "application/json" } }),
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "place_rank_provider_invalid_response");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.tables[TRACKERS][0].place_id, "2019299673");
  assert.equal(state.tables[TRACKERS][0].current_rank, 12);
  assert.equal(state.tables[TRACKERS][0].check_count, 9);
});

test("rejects a matched provider result that omits the tracked place ID", async () => {
  const { ctx, state } = testContext([{
    id: "missing-provider-id",
    place_id: "2019299673",
    place_name: "팽오리농장 부평점",
    current_rank: 12,
    check_count: 9,
  }]);

  const result = await withExternalProvider(
    async () => new Response(JSON.stringify({
      ok: true,
      matched: true,
      rank: 7,
      checkedCount: 7,
      place: { name: "팽오리농장 부평점" },
      source: "test-collector",
    }), { status: 200, headers: { "content-type": "application/json" } }),
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "place_rank_provider_invalid_response");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.tables[TRACKERS][0].current_rank, 12);
  assert.equal(state.tables[TRACKERS][0].check_count, 9);
});

test("records a 62-result partial snapshot while preserving the last confirmed rank", async () => {
  const { ctx, state } = testContext([{
    id: "partial-provider",
    current_rank: 12,
    best_rank: 8,
    worst_rank: 17,
    check_count: 9,
    found_count: 6,
  }]);

  const result = await withExternalProvider(
    async () => new Response(JSON.stringify({
      ok: true,
      matched: false,
      checkedCount: 62,
      total: 62,
      complete: false,
      partial: true,
      partialReason: "collection_deadline_reached",
      place: { id: "1234567890", name: "테스트 플레이스" },
      source: "test-collector",
    }), { status: 200, headers: { "content-type": "application/json" } }),
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.result.complete, false);
  assert.equal(result.result.partial, true);
  assert.equal(state.tables[SNAPSHOTS].length, 1);
  assert.equal(state.tables[SNAPSHOTS][0].checked_count, 62);
  assert.equal(state.tables[TRACKERS][0].current_rank, 12);
  assert.equal(state.tables[TRACKERS][0].best_rank, 8);
  assert.equal(state.tables[TRACKERS][0].worst_rank, 17);
  assert.equal(state.tables[TRACKERS][0].check_count, 10);
  assert.equal(state.tables[TRACKERS][0].found_count, 6);
  assert.equal(state.tables[TRACKERS][0].retry_count, 0);
});

test("refresh persists an official place name without inventing a rank", async () => {
  const placeId = "2019299673";
  const placeUrl = `https://map.naver.com/p/entry/place/${placeId}?placePath=%2Fhome`;
  const mobileHtml = `<meta property="og:title" content="팽오리농장 부평점 : 네이버">${"x".repeat(540 * 1024)}`;
  const { ctx, state } = testContext([{
    id: "name-enrichment-partial",
    place_url: placeUrl,
    place_id: placeId,
    place_name: null,
    current_rank: 12,
    check_count: 9,
  }]);
  let providerRequest = null;

  const result = await withExternalProvider(
    async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl === placeUrl) {
        return new Response("<html><body>map shell</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (requestUrl.includes(`/place/${placeId}/home`)) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://m.place.naver.com/restaurant/${placeId}/home` },
        });
      }
      if (requestUrl.includes(`/restaurant/${placeId}/home`)) {
        return new Response(mobileHtml, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(Buffer.byteLength(mobileHtml)),
          },
        });
      }

      providerRequest = JSON.parse(options.body);
      return new Response(JSON.stringify({
        ok: true,
        matched: false,
        rank: null,
        checkedCount: 54,
        total: 54,
        complete: false,
        partial: true,
        partialReason: "naver_result_list_exhausted",
        place: { id: placeId, name: "" },
        source: "test-collector",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.result.rank, null);
  assert.equal(providerRequest.placeName, "팽오리농장 부평점");
  assert.equal(state.tables[TRACKERS][0].place_name, "팽오리농장 부평점");
  assert.equal(state.tables[TRACKERS][0].current_rank, 12);
});

test("clears current rank only after a full 300-result miss", async () => {
  const { ctx, state } = testContext([{
    id: "full-provider-miss",
    current_rank: 12,
    best_rank: 8,
    worst_rank: 17,
    check_count: 9,
    found_count: 6,
  }]);

  const result = await withExternalProvider(
    async () => new Response(JSON.stringify({
      ok: true,
      matched: false,
      checkedCount: 300,
      total: 300,
      complete: true,
      place: { id: "1234567890", name: "테스트 플레이스" },
      source: "test-collector",
    }), { status: 200, headers: { "content-type": "application/json" } }),
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "not_found");
  assert.equal(result.result.complete, true);
  assert.equal(result.result.partial, false);
  assert.equal(state.tables[SNAPSHOTS].length, 1);
  assert.equal(state.tables[SNAPSHOTS][0].checked_count, 300);
  assert.equal(state.tables[TRACKERS][0].current_rank, null);
  assert.equal(state.tables[TRACKERS][0].best_rank, 8);
  assert.equal(state.tables[TRACKERS][0].worst_rank, 17);
  assert.equal(state.tables[TRACKERS][0].check_count, 10);
});

test("refuses a stale processing token before inserting a snapshot", async () => {
  const { ctx, state } = testContext([{
    id: "stale-lease",
    current_rank: 12,
    best_rank: 8,
    worst_rank: 17,
    check_count: 9,
    processing_token: "claim-old",
  }]);
  const claimedTracker = { ...state.tables[TRACKERS][0] };

  const result = await withExternalProvider(
    async () => {
      state.tables[TRACKERS][0].processing_token = "claim-new";
      return new Response(JSON.stringify({
        ok: true,
        matched: true,
        rank: 7,
        checkedCount: 7,
        total: 300,
        complete: false,
        place: { id: "1234567890", name: "테스트 플레이스" },
        source: "test-collector",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    () => runPlaceTrackerCheck(ctx, claimedTracker),
  );

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "lease_lost");
  assert.equal(result.error, "place_rank_tracker_lease_lost");
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.tables[TRACKERS][0].processing_token, "claim-new");
  assert.equal(state.tables[TRACKERS][0].current_rank, 12);
  assert.equal(state.tables[TRACKERS][0].check_count, 9);
  assert.equal(state.tables[TRACKERS][0].retry_count, 0);
});

test("treats an official top-five miss as partial and preserves the confirmed rank", async () => {
  const { ctx, state } = testContext([{
    id: "official-partial",
    current_rank: 14,
    best_rank: 7,
    worst_rank: 19,
    check_count: 4,
    place_id: "target-place",
    place_name: "대상 식당",
  }]);
  const officialItems = Array.from({ length: 5 }, (_, index) => ({
    title: `다른 식당 ${index + 1}`,
    link: `https://map.naver.com/p/entry/place/other-${index + 1}`,
  }));

  const result = await withOfficialProvider(
    async (url) => String(url).includes("/v1/search/blog.json")
      ? new Response(JSON.stringify({ total: 20 }), { status: 200 })
      : new Response(JSON.stringify({ total: 420, items: officialItems }), { status: 200 }),
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.result.partialReason, "official_local_limit");
  assert.equal(result.result.checkedCount, 5);
  assert.equal(state.tables[SNAPSHOTS].length, 1);
  assert.equal(state.tables[TRACKERS][0].current_rank, 14);
  assert.equal(state.tables[TRACKERS][0].best_rank, 7);
  assert.equal(state.tables[TRACKERS][0].worst_rank, 19);
});

test("official lookup uses exact place ID before a same-name candidate", async () => {
  const { ctx, state } = testContext([{
    id: "official-exact-id",
    place_id: "2019299673",
    place_name: "팽오리농장 부평점",
  }]);
  const officialItems = [
    {
      title: "팽오리농장 부평점",
      link: "https://map.naver.com/p/entry/place/9999999999",
    },
    {
      title: "표시명이 변경된 대상 장소",
      link: "https://map.naver.com/p/entry/place/2019299673",
    },
  ];

  const result = await withOfficialProvider(
    async (url) => String(url).includes("/v1/search/blog.json")
      ? new Response(JSON.stringify({ total: 20 }), { status: 200 })
      : new Response(JSON.stringify({ total: 2, items: officialItems }), { status: 200 }),
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "found");
  assert.equal(result.result.rank, 2);
  assert.equal(state.tables[TRACKERS][0].current_rank, 2);
});

test("official lookup keeps name-only matching when the tracker has no place ID", async () => {
  const { ctx, state } = testContext([{
    id: "official-name-only",
    place_id: null,
    place_name: "대상 식당",
  }]);

  const result = await withOfficialProvider(
    async (url) => String(url).includes("/v1/search/blog.json")
      ? new Response(JSON.stringify({ total: 20 }), { status: 200 })
      : new Response(JSON.stringify({
        total: 1,
        items: [{ title: "대상 식당", link: "https://map.naver.com/p/entry/place/1111111111" }],
      }), { status: 200 }),
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "found");
  assert.equal(result.result.rank, 1);
});

test("fails official lookup when neither place id nor name can be resolved", async () => {
  const { ctx, state } = testContext([{
    id: "official-no-identity",
    place_id: null,
    place_name: null,
    current_rank: 14,
    best_rank: 7,
    worst_rank: 19,
    check_count: 4,
  }]);

  const result = await withOfficialProvider(
    async () => new Response(JSON.stringify({ total: 20 }), { status: 200 }),
    () => runPlaceTrackerCheck(ctx, { ...state.tables[TRACKERS][0] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failed");
  assert.equal(result.result.needsPlaceName, true);
  assert.equal(state.tables[SNAPSHOTS].length, 0);
  assert.equal(state.tables[TRACKERS][0].current_rank, 14);
  assert.equal(state.tables[TRACKERS][0].check_count, 4);
  assert.equal(state.tables[TRACKERS][0].retry_count, 1);
});

test("keeps advertiser place trackers isolated by agency code", async () => {
  const secondAgency = "agency-b02";
  const { ctx } = testContext([
    { id: "primary-tracker", agency_code: AGENCY_CODE },
    { id: "second-tracker", agency_code: secondAgency, client_id: "client-2" },
  ], {
    clients: [
      { id: "client-1", agency_code: AGENCY_CODE, status: "active", disconnected_at: null },
      { id: "client-2", agency_code: secondAgency, status: "active", disconnected_at: null },
    ],
  });

  const result = await payload(await handlePlaceRankTrackersRequest(clientRequest("GET", null, {
    agencyCode: secondAgency,
    accessCode: secondAgency,
  }), ctx));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.trackers.map((tracker) => tracker.id), ["second-tracker"]);
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
  let placeFetchCount = 0;
  globalThis.fetch = async () => {
    placeFetchCount += 1;
    if (placeFetchCount === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://map.naver.com/p/entry/place/9876543210?placePath=%2Fhome" },
      });
    }
    return new Response(null, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
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

test("treats an early matched place as complete rather than partial", () => {
  const tracker = placeTrackerPayload(trackerRow(), [{
    id: "found-early",
    tracker_id: "tracker-1",
    checked_at: new Date().toISOString(),
    rank: 4,
    matched: true,
    checked_count: 4,
    total: 300,
    place: { id: "2019299673", name: "테스트 플레이스" },
    message: "오가닉 4위",
    source: "naver_local_search_api",
    created_at: new Date().toISOString(),
  }]);

  assert.equal(tracker.snapshots[0].complete, true);
  assert.equal(tracker.snapshots[0].partial, false);
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
    assert.equal(summary.remaining, 1);
    assert.equal(summary.drained, false);
    assert.equal(state.lastRpcParams.lease_seconds, 360);
    assert.equal(state.tables[SNAPSHOTS].length, 3);
    assert.equal(state.tables[TRACKERS].filter((row) => row.last_checked_at).length, 3);
    assert.equal(state.tables[TRACKERS].find((row) => row.id === "due-4").last_checked_at, null);

    const finalSummary = await runDuePlaceTrackers(ctx, { agencyCode: AGENCY_CODE, limit: 3 });
    assert.equal(finalSummary.checked, 1);
    assert.equal(finalSummary.remaining, 0);
    assert.equal(finalSummary.drained, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProviderUrl === undefined) delete process.env.NAVER_PLACE_RANK_API_URL;
    else process.env.NAVER_PLACE_RANK_API_URL = previousProviderUrl;
    if (previousProviderKey === undefined) delete process.env.NAVER_PLACE_RANK_API_KEY;
    else process.env.NAVER_PLACE_RANK_API_KEY = previousProviderKey;
  }
});

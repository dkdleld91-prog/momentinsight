import assert from "node:assert/strict";
import test from "node:test";

import { forgetGroupMarkColumnMissing, forgetOptionColumnMissing } from "../naver-rank-option-group.mjs";
import { handleRankTrackersRequest } from "./naver-rank-trackers.mjs";

// N30 그룹상품 후보(대표 승인 2026-10-27 A안) — 목록 응답 groupCandidates(관리자 세션만)와 '그룹상품으로 표시' API.
//   L1 관리자 목록: 그룹상품 추적에만 후보(최근 7일 두 번 이상), 기록 칸에는 후보가 없다
//   L2 광고주 세션 목록: 후보가 응답 어디에도 없다 · 운영팀은 받는다
//   L3 표시 칸 없음(대표 SQL 전): 목록 200·표시 버튼 숨김 신호·그룹 이름·옵션 번호 유지
//   M1 표시 API: 같은 범위·같은 대표 번호의 활성·일시중지 상품 기준 추적에 함께, group_product_marked 한 칸만, 네이버 요청 0
//   M2 권한·입력·원부·칸 없음은 4xx
// 운영 DB 대신 메모리 표를 쓴다(options 시험과 같은 가짜).

const OWNER_CODE = "mml93-a01";
const ADVERTISER = "brand-a";
const PRIMARY = "12356459438";
const OPTION_16PRO = "99900000001";
const OPTION_15 = "99900000002";
const SELF_ID = "123e4567-e89b-42d3-a456-426614174000";

function uuid(n) {
  return `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
}

function trackerRow(overrides = {}) {
  return {
    id: SELF_ID,
    client_id: null,
    brand_id: null,
    agency_code: OWNER_CODE,
    keyword: "아이폰 17 필름",
    product_url: `https://smartstore.naver.com/ishell/products/${PRIMARY}`,
    product_id: PRIMARY,
    mall_name: "아이쉘",
    product_title: "아이쉘 아이폰17 저반사 액정보호필름 2매",
    max_rank: 300,
    status: "active",
    started_at: "2026-10-01T00:00:00.000Z",
    ends_at: "2036-10-01T00:00:00.000Z",
    last_checked_at: null,
    next_check_at: "2026-10-23T06:00:00.000Z",
    current_rank: null,
    best_rank: null,
    worst_rank: null,
    check_count: 0,
    found_count: 0,
    last_message: null,
    last_error: null,
    retry_count: 0,
    sort_order: 100,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    group_name: "아이쉘",
    option_product_ids: [],
    ...overrides,
  };
}

function project(row, columns) {
  if (!columns || columns === "*") return { ...row };
  const projected = {};
  for (const column of String(columns).split(",").map((value) => value.trim()).filter(Boolean)) {
    if (column in row) projected[column] = Array.isArray(row[column]) ? [...row[column]] : row[column];
  }
  return projected;
}

// supabase-js 의 쓰는 부분만 흉내 낸다. 옵션 칸 없음(대표 SQL 전)·CHECK 위반을 고를 수 있다.
function fakeDatabase(tables, options = {}) {
  const state = { updates: [], selects: [], rpcCalls: [], queries: 0 };
  const supabaseAdmin = {
    async rpc(name, args) {
      state.rpcCalls.push(name);
      if (name === "mi_get_naver_shopping_worker_operations") {
        return { data: { circuit_state: "closed", cadence_mode: "baseline", cadence_minutes: 10 }, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}`, args } };
    },
    from(table) {
      const ops = { filters: [], columns: "*", limit: Infinity, update: null, count: false, touchesOptions: false };
      const run = async () => {
        state.queries += 1;
        if (table === "naver_shopping_worker_coordination") {
          return { data: [{ lane_key: "global", circuit_state: "closed" }], error: null };
        }
        if (table === "clients") {
          return { data: options.clients || [], error: null };
        }
        const rows = tables[table] || [];
        const touchesOptions = ops.touchesOptions
          || String(ops.columns).includes("option_product_ids")
          || Boolean(ops.update && Object.hasOwn(ops.update, "option_product_ids"));
        if (table === "naver_rank_trackers" && touchesOptions && options.optionColumnMissing) {
          return { data: null, error: { code: "42703", message: "column naver_rank_trackers.option_product_ids does not exist" } };
        }
        const touchesMark = String(ops.columns).includes("group_product_marked")
          || Boolean(ops.update && Object.hasOwn(ops.update, "group_product_marked"));
        if (table === "naver_rank_trackers" && touchesMark && options.markColumnMissing) {
          return { data: null, error: { code: "42703", message: "column naver_rank_trackers.group_product_marked does not exist" } };
        }
        const matched = rows.filter((row) => ops.filters.every((filter) => filter(row)));
        if (ops.update) {
          if (options.updateError) return { data: null, error: options.updateError(ops, state) };
          state.updates.push({ table, values: JSON.parse(JSON.stringify(ops.update)), ids: matched.map((row) => row.id) });
          matched.forEach((row) => Object.assign(row, JSON.parse(JSON.stringify(ops.update))));
          return { data: matched.map((row) => project(row, ops.columns)), error: null };
        }
        state.selects.push({ table, columns: ops.columns });
        const limited = matched.slice(0, ops.limit);
        return {
          data: limited.map((row) => project(row, ops.columns)),
          error: null,
          ...(ops.count ? { count: matched.length } : {}),
        };
      };
      const query = {
        select(columns, selectOptions = {}) {
          if (!ops.update) ops.columns = columns;
          else ops.columns = columns;
          if (selectOptions.count) ops.count = true;
          return query;
        },
        update(values) { ops.update = values; return query; },
        eq(column, value) { ops.filters.push((row) => String(row[column]) === String(value)); return query; },
        in(column, values) {
          const allowed = values.map(String);
          ops.filters.push((row) => allowed.includes(String(row[column])));
          return query;
        },
        contains(column, values) {
          if (column === "option_product_ids") ops.touchesOptions = true;
          ops.filters.push((row) => Array.isArray(row[column]) && values.every((value) => row[column].includes(value)));
          return query;
        },
        gte(column, value) { ops.filters.push((row) => String(row[column] || "") >= String(value)); return query; },
        lte(column, value) { ops.filters.push((row) => String(row[column] || "") <= String(value)); return query; },
        order() { return query; },
        // 기록 페이지 넘김 커서(checked_at DESC, id DESC)만 흉내 낸다. 표 행은 최신 순으로 둔다.
        or(expression) {
          const cursor = String(expression).match(/^checked_at\.lt\.([^,]+),and\(checked_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/u);
          if (cursor) {
            ops.filters.push((row) => String(row.checked_at) < cursor[1]
              || (String(row.checked_at) === cursor[2] && String(row.id) < cursor[3]));
          }
          return query;
        },
        limit(value) { ops.limit = value; return query; },
        async maybeSingle() {
          const result = await run();
          return { data: result.data?.[0] ?? null, error: result.error };
        },
        async single() {
          const result = await run();
          return { data: result.data?.[0] ?? null, error: result.error };
        },
        then(resolve, reject) { return run().then(resolve, reject); },
      };
      return query;
    },
  };
  return { ctx: { supabaseAdmin }, state };
}

function request(method, body, options = {}) {
  const headers = { "content-type": "application/json" };
  const role = "role" in options ? options.role : "owner";
  if (role) {
    headers["x-mi-session-role"] = role;
    headers["x-mi-session-scope"] = "advertiser";
  }
  if (role === "owner" || options.adminCode) headers["x-demo-admin-code"] = "owner-test-code";
  if (role === "owner") headers["x-mi-owner-agency-code"] = OWNER_CODE;
  headers["x-mi-agency-code"] = options.agencyCode || OWNER_CODE;
  if (options.accessCode) headers["x-mi-rank-access-code"] = options.accessCode;
  return new Request("https://insight.momentlabs.co.kr/api/naver-rank-trackers", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function withEnv(callback) {
  const keys = ["MI_RANK_ADMIN_CODE", "MI_PRIMARY_AGENCY_CODE", "NAVER_SEARCHAD_API_KEY", "NAVER_SEARCHAD_SECRET_KEY", "NAVER_SEARCHAD_CUSTOMER_ID"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.MI_RANK_ADMIN_CODE = "owner-test-code";
  process.env.MI_PRIMARY_AGENCY_CODE = OWNER_CODE;
  delete process.env.NAVER_SEARCHAD_API_KEY;
  delete process.env.NAVER_SEARCHAD_SECRET_KEY;
  delete process.env.NAVER_SEARCHAD_CUSTOMER_ID;
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error("unexpected_network_request");
  };
  const originalLog = console.log;
  const logs = [];
  console.log = (line) => logs.push(String(line));
  forgetOptionColumnMissing();
  forgetGroupMarkColumnMissing();
  try {
    return await callback({ fetchCalls, logs });
  } finally {
    forgetOptionColumnMissing();
    forgetGroupMarkColumnMissing();
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

const CAND_A = "99900000011";
const CAND_B = "99900000012";
const HOUR = 60 * 60 * 1000;

function candidateTables(now = Date.now()) {
  const iso = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  const entry = (productId, rank) => ({ productId, rank, title: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매", mallName: "아이쉘", lprice: 9900, link: `https://smartstore.naver.com/main/products/${productId}` });
  const notFound = (id, trackerId, hoursAgo, candidates) => ({
    id,
    tracker_id: trackerId,
    checked_at: iso(hoursAgo),
    rank: null,
    matched: false,
    checked_count: 300,
    item: { trackingRankSource: "not_found", rankPolicy: "organic_only", adExcluded: true, groupCandidates: candidates },
    message: "검색 결과에서 대상 상품을 찾지 못했습니다.",
  });
  return {
    naver_rank_trackers: [
      trackerRow({ group_product_marked: true }),
      trackerRow({ id: uuid(1), keyword: "아이폰 필름", group_product_marked: true, sort_order: 101 }),
      trackerRow({ id: uuid(2), keyword: "표시 안 함", product_id: "88888888888", product_url: "https://smartstore.naver.com/ishell/products/88888888888", group_product_marked: false, sort_order: 102 }),
      trackerRow({ id: uuid(3), keyword: "끝난 추적", status: "completed", group_product_marked: false, sort_order: 103 }),
      trackerRow({ id: uuid(4), keyword: "다른 광고주", agency_code: "brand-x", group_product_marked: false }),
      trackerRow({ id: uuid(5), keyword: "원부 추적", product_id: "55555555555", product_url: "https://search.shopping.naver.com/catalog/55555555555", group_product_marked: false, sort_order: 105 }),
    ],
    // 기록은 checked_at DESC, id DESC(목록 페이지 넘김 규칙) 순서로 둔다.
    naver_rank_snapshots: [
      notFound("s5", SELF_ID, 1, [entry(CAND_A, 41), entry(CAND_B, 50)]),
      notFound("s4", uuid(1), 2, [entry(CAND_B, 33)]),
      notFound("s2", uuid(2), 3, [entry("99900000077", 20)]),
      notFound("s3", SELF_ID, 30, [entry(CAND_A, 39)]),
      notFound("s1", uuid(2), 30, [entry("99900000077", 21)]),
    ],
  };
}

// 광고주 세션(광고주와 연결된 운영팀 포함)은 광고주 범위 표로 본다.
const CLIENTS = [{ id: "client-1", status: "active", disconnected_at: null }];
function advertiserTables() {
  const tables = candidateTables();
  tables.naver_rank_trackers.forEach((row) => { if (row.agency_code === OWNER_CODE) row.agency_code = ADVERTISER; });
  return tables;
}
const ADVERTISER_SESSION = { agencyCode: ADVERTISER, accessCode: ADVERTISER };

test("L1 관리자 목록: 그룹상품 추적에만 후보(두 번 이상), 기록 칸에는 후보가 없다, 네이버 요청 0", async () => {
  await withEnv(async ({ fetchCalls }) => {
    const { ctx, state } = fakeDatabase(candidateTables());
    const response = await handleRankTrackersRequest(request("GET"), ctx);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body).slice(0, 300));
    const byId = new Map(body.trackers.map((entry) => [entry.id, entry]));
    const self = byId.get(SELF_ID);
    assert.equal(self.groupMarkReady, true);
    assert.equal(self.groupProductMarked, true);
    assert.equal(self.groupProduct, true);
    assert.deepEqual(self.groupCandidates.map((entry) => [entry.productId, entry.seenCount, entry.keywordCount, entry.bestRank]), [
      [CAND_B, 2, 2, 33],
      [CAND_A, 2, 1, 39],
    ]);
    assert.deepEqual(self.groupCandidates[0].warnings.map((warning) => warning.text), ["기종 다름: 아이폰 16 프로"]);
    assert.deepEqual(byId.get(uuid(1)).groupCandidates.map((entry) => entry.productId), [CAND_B, CAND_A], "같은 대표 번호의 다른 키워드 추적도 같은 후보");
    assert.equal(Object.hasOwn(byId.get(uuid(2)), "groupCandidates"), false, "표시 안 한 추적에는 후보 칸 자체가 없다");
    assert.equal(byId.get(uuid(2)).groupProduct, false);
    assert.equal(byId.get(uuid(2)).groupMarkReady, true);
    assert.equal(Object.hasOwn(byId.get(uuid(5)), "groupCandidates"), false, "원부 추적은 그룹상품이 아니다");
    const raw = JSON.stringify(body.trackers.map((entry) => entry.snapshots));
    assert.equal(raw.includes("groupCandidates"), false, "기록(날짜 칸) 응답에는 후보를 싣지 않는다");
    assert.equal(fetchCalls.length, 0);
    assert.equal(state.updates.length, 0, "목록은 아무것도 쓰지 않는다");
    assert.ok(state.selects.some((entry) => entry.columns === "id, group_name, option_product_ids, group_product_marked"));
  });
});

test("L2 광고주 세션 목록에는 후보가 응답 어디에도 없다 · 운영팀 세션은 받는다", async () => {
  await withEnv(async () => {
    const client = fakeDatabase(advertiserTables(), { clients: CLIENTS });
    const clientResponse = await handleRankTrackersRequest(request("GET", null, { role: "client", ...ADVERTISER_SESSION }), client.ctx);
    const clientBody = await clientResponse.json();
    assert.equal(clientResponse.status, 200);
    assert.ok(clientBody.trackers.length > 0);
    assert.equal(JSON.stringify(clientBody).includes("groupCandidates"), false);
    assert.equal(JSON.stringify(clientBody).includes(CAND_A), false, "후보 번호도 없다");

    const team = fakeDatabase(advertiserTables(), { clients: CLIENTS });
    const teamResponse = await handleRankTrackersRequest(request("GET", null, { role: "team", ...ADVERTISER_SESSION }), team.ctx);
    const teamBody = await teamResponse.json();
    assert.equal(teamResponse.status, 200);
    assert.equal(teamBody.trackers.find((entry) => entry.id === SELF_ID).groupCandidates.length, 2);
  });
});

test("L3 표시 칸 없음(대표 SQL 전): 목록 200, 표시 버튼 숨김 신호, 그룹 이름·옵션 번호 유지, 10분 기억", async () => {
  await withEnv(async () => {
    const tables = candidateTables();
    tables.naver_rank_trackers[0].option_product_ids = [OPTION_15];
    const missing = fakeDatabase(tables, { markColumnMissing: true });
    const original = console.warn;
    const warnings = [];
    console.warn = (line) => warnings.push(String(line));
    try {
      const response = await handleRankTrackersRequest(request("GET"), missing.ctx);
      const body = await response.json();
      assert.equal(response.status, 200);
      const self = body.trackers.find((entry) => entry.id === SELF_ID);
      assert.equal(self.groupMarkReady, false);
      assert.equal(self.groupProductMarked, false);
      assert.deepEqual(self.optionProductIds, [OPTION_15]);
      assert.equal(self.groupProduct, true, "옵션 번호가 있으면 칸이 없어도 그룹상품");
      assert.equal(self.groupName, "아이쉘");
      const marked = body.trackers.find((entry) => entry.id === uuid(1));
      assert.equal(marked.groupProduct, false, "표시를 못 읽으면 표시 없음");
      assert.equal(Object.hasOwn(marked, "groupCandidates"), false);
      const again = await handleRankTrackersRequest(request("GET"), missing.ctx);
      assert.equal(again.status, 200);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.filter((line) => line.includes("naver_rank_group_mark_column_missing")).length, 1);
    const groupSelects = missing.state.selects.filter((entry) => String(entry.columns).startsWith("id, group_name"));
    assert.deepEqual(groupSelects.map((entry) => entry.columns), [
      "id, group_name, option_product_ids",
      "id, group_name, option_product_ids",
    ], "실패한 조회는 기록되지 않고, 두 번째 목록은 표시 칸을 묻지 않는다");
  });
});

async function mark(ctx, body, options) {
  const response = await handleRankTrackersRequest(request("POST", { action: "group-mark", trackerId: SELF_ID, ...body }, options), ctx);
  return { response, body: await response.json() };
}

test("M1 표시 API: 같은 범위·같은 대표 번호의 활성·일시중지 상품 기준 추적에 함께, 한 칸만, 다시 누르면 끈다", async () => {
  await withEnv(async ({ fetchCalls, logs }) => {
    const tables = candidateTables();
    tables.naver_rank_trackers.forEach((row) => { row.group_product_marked = false; });
    tables.naver_rank_trackers.push(trackerRow({ id: uuid(6), keyword: "일시중지", status: "paused", group_product_marked: false }));
    const { ctx, state } = fakeDatabase(tables);
    const on = await mark(ctx, { marked: true });
    assert.equal(on.response.status, 200);
    assert.equal(on.body.ok, true);
    assert.equal(on.body.marked, true);
    assert.deepEqual([...on.body.updatedTrackerIds].sort(), [SELF_ID, uuid(1), uuid(6)].sort(), "끝난 추적·다른 광고주·다른 상품은 바꾸지 않는다");
    assert.match(on.body.message, /그룹상품으로 표시했습니다\(같은 상품 추적 3개\)/u);
    assert.equal(state.updates.length, 1);
    assert.deepEqual(Object.keys(state.updates[0].values), ["group_product_marked"], "다른 칸(수집 순서·옵션 번호)은 쓰지 않는다");
    const byId = new Map(tables.naver_rank_trackers.map((row) => [row.id, row]));
    assert.equal(byId.get(uuid(3)).group_product_marked, false);
    assert.equal(byId.get(uuid(4)).group_product_marked, false);
    assert.equal(byId.get(uuid(2)).group_product_marked, false);
    assert.equal(byId.get(SELF_ID).next_check_at, "2026-10-23T06:00:00.000Z");

    const off = await mark(ctx, { marked: false });
    assert.equal(off.response.status, 200);
    assert.match(off.body.message, /그룹상품 표시를 껐습니다\(같은 상품 추적 3개\).*넣은 번호와 지난 기록은 그대로/u);
    assert.equal(byId.get(uuid(1)).group_product_marked, false);
    assert.equal(fetchCalls.length, 0, "네이버 요청 0");
    assert.equal(logs.filter((line) => line.includes("naver_rank_tracker_group_mark_saved")).length, 2);
  });
});

test("M2 권한·입력·원부·칸 없음은 4xx 이고 아무것도 쓰지 않는다", async () => {
  await withEnv(async () => {
    const advertiser = fakeDatabase(advertiserTables(), { clients: CLIENTS });
    const client = await mark(advertiser.ctx, { marked: true }, { role: "client", ...ADVERTISER_SESSION });
    assert.equal(client.response.status, 403);
    assert.equal(client.body.code, "RANK_GROUP_MARK_FORBIDDEN");
    const anonymous = await mark(advertiser.ctx, { marked: true }, { role: null, ...ADVERTISER_SESSION });
    assert.equal(anonymous.response.status, 403);
    assert.equal(advertiser.state.updates.length, 0);
    const team = await mark(advertiser.ctx, { marked: true }, { role: "team", ...ADVERTISER_SESSION });
    assert.equal(team.response.status, 200);
    const { ctx, state } = fakeDatabase(candidateTables());
    assert.equal((await mark(ctx, { marked: "yes" })).response.status, 400);
    assert.equal((await mark(ctx, { trackerId: "nope", marked: true })).response.status, 400);
    assert.equal((await mark(ctx, { trackerId: uuid(4), marked: true })).response.status, 404, "다른 광고주 범위");
    const catalog = await mark(ctx, { trackerId: uuid(5), marked: true });
    assert.equal(catalog.response.status, 409);
    assert.equal(catalog.body.code, "RANK_OPTION_CATALOG_TRACKER");
    assert.equal(state.updates.length, 0);

    const missing = fakeDatabase(candidateTables(), { markColumnMissing: true });
    const original = console.warn;
    console.warn = () => {};
    try {
      const notReady = await mark(missing.ctx, { marked: true });
      assert.equal(notReady.response.status, 409);
      assert.equal(notReady.body.code, "RANK_GROUP_MARK_NOT_READY");
      assert.match(notReady.body.message, /대표 SQL 실행 뒤/u);
    } finally {
      console.warn = original;
    }
    assert.equal(missing.state.updates.length, 0);
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { forgetOptionColumnMissing } from "../naver-rank-option-group.mjs";
import { handleRankTrackersRequest, trackerPayload } from "./naver-rank-trackers.mjs";

// N30 그룹상품 번호 편집 API(POST action "options")와 목록 응답 새 칸(2026-10-23).
// 운영 DB 대신 메모리 표를 쓰고, 네이버 요청·깨우기·수집 순서 칸 쓰기가 0 인지 함께 본다.

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
  try {
    return await callback({ fetchCalls, logs });
  } finally {
    forgetOptionColumnMissing();
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function groupTables() {
  return {
    naver_rank_trackers: [
      trackerRow({ option_product_ids: [OPTION_15] }),
      trackerRow({ id: uuid(1), keyword: "아이폰17 케이스", group_name: "기본 그룹" }),
      trackerRow({
        id: uuid(2),
        keyword: "아이폰16 프로 필름",
        product_id: OPTION_16PRO,
        product_url: `https://smartstore.naver.com/ishell/products/${OPTION_16PRO}`,
        option_product_ids: ["99900000077"],
      }),
      trackerRow({ id: uuid(3), keyword: "끝난 추적", status: "completed" }),
      trackerRow({ id: uuid(4), keyword: "다른 광고주", agency_code: "brand-x" }),
      trackerRow({
        id: uuid(5),
        keyword: "원부 추적",
        product_id: "55555555555",
        product_url: "https://search.shopping.naver.com/catalog/55555555555",
      }),
      trackerRow({ id: uuid(6), keyword: "다른 상품", product_id: "88888888888", product_url: "" }),
      trackerRow({
        id: uuid(7),
        keyword: "16 프로를 옵션으로 가진 다른 추적",
        product_id: "77777777777",
        product_url: "",
        option_product_ids: [PRIMARY, "99900000055"],
      }),
    ],
  };
}

async function post(ctx, body, options) {
  const response = await handleRankTrackersRequest(request("POST", { action: "options", trackerId: SELF_ID, ...body }, options), ctx);
  return { response, body: await response.json() };
}

test("A5 미리 보기는 아무것도 쓰지 않고, 함께 바뀌는 추적·전후 개수·가져오기 후보를 보여준다", async () => {
  await withEnv(async ({ fetchCalls }) => {
    const { ctx, state } = fakeDatabase(groupTables());
    const { response, body } = await post(ctx, {
      mode: "preview",
      optionInput: `${OPTION_16PRO}\n${OPTION_16PRO}\nabc`,
      applyToSameProduct: true,
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mode, "preview");
    assert.equal(body.columnReady, true);
    assert.deepEqual(body.tracker.optionProductIds, [OPTION_15]);
    assert.deepEqual(body.parsed.optionProductIds, [OPTION_16PRO]);
    assert.equal(body.parsed.duplicatesRemoved, 1);
    assert.deepEqual(body.parsed.rejected.map((entry) => entry.reason), ["not_product_number"]);
    // 함께 바뀌는 추적은 같은 대표 번호만(명세 §8.3-4). 대표가 OPTION_16PRO 인 uuid(2) 는 대상이 아니다.
    assert.deepEqual(body.sameProduct.trackers.map((entry) => [entry.id, entry.relation, entry.afterOptionProductIds]), [
      [uuid(1), "same_primary", [OPTION_16PRO]],
    ]);
    assert.equal(body.sameProduct.trackers[0].groupName, "기본 그룹");
    assert.equal(body.sameProduct.shrinkingTrackerCount, 0);
    assert.deepEqual(body.removedOptionProductIds, [OPTION_15]);
    assert.equal(body.willUpdateCount, 2);
    assert.deepEqual(body.targetTrackerIds, [SELF_ID, uuid(1)]);
    // 가져오기 후보(쓰지 않음)는 같은 그룹 다른 대표 추적·이 대표 번호를 옵션으로 가진 추적에서도 모은다.
    assert.deepEqual(body.sameProduct.siblingOptionProductIds.sort(), ["77777777777", "99900000055", "99900000077"].sort());
    assert.equal(body.message, "번호 1개 · 함께 바뀌는 추적 2개 · 받지 않은 칸 1개");
    assert.equal(state.updates.length, 0);
    assert.equal(state.rpcCalls.length, 0);
    assert.equal(fetchCalls.length, 0);
  });
});

test("A6 저장 + 함께 적용: 같은 범위·같은 대표 번호의 상품 기준 활성·일시중지 추적만, option_product_ids 한 칸만 쓴다", async () => {
  await withEnv(async ({ fetchCalls, logs }) => {
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables);
    const { response, body } = await post(ctx, {
      mode: "save",
      optionInput: `https://smartstore.naver.com/main/products/${OPTION_16PRO}`,
      applyToSameProduct: true,
      expectedTrackerIds: [uuid(1), SELF_ID],
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.updatedCount, 2);
    assert.deepEqual(body.updatedTrackerIds.sort(), [SELF_ID, uuid(1)].sort());
    assert.deepEqual(body.optionProductIds, [OPTION_16PRO]);
    assert.equal(body.message, "그룹상품 번호 1개를 추적 2개에 저장했습니다. 다음 순위 확인부터 적용됩니다.");
    // 같은 대표 번호·같은 목록이라 update 는 한 번(일부만 저장되는 길이 없다).
    assert.equal(state.updates.length, 1);
    for (const update of state.updates) {
      assert.deepEqual(Object.keys(update.values), ["option_product_ids"]);
    }
    const byId = new Map(tables.naver_rank_trackers.map((row) => [row.id, row]));
    assert.deepEqual(byId.get(SELF_ID).option_product_ids, [OPTION_16PRO]);
    assert.deepEqual(byId.get(uuid(1)).option_product_ids, [OPTION_16PRO]);
    // 대표 번호가 다른 그룹 구성원은 덮어쓰지 않는다(반박 검토 2026-10-23).
    assert.deepEqual(byId.get(uuid(2)).option_product_ids, ["99900000077"]);
    assert.deepEqual(byId.get(uuid(3)).option_product_ids, []);
    assert.deepEqual(byId.get(uuid(4)).option_product_ids, []);
    assert.deepEqual(byId.get(uuid(5)).option_product_ids, []);
    assert.deepEqual(byId.get(uuid(7)).option_product_ids, [PRIMARY, "99900000055"]);
    // 수집 순서·임대 칸은 그대로, 깨우기·네이버 요청 0.
    assert.equal(byId.get(SELF_ID).next_check_at, "2026-10-23T06:00:00.000Z");
    assert.equal(state.rpcCalls.length, 0);
    assert.equal(fetchCalls.length, 0);
    const saved = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "naver_rank_tracker_options_saved");
    assert.deepEqual(saved, { level: "info", event: "naver_rank_tracker_options_saved", trackerCount: 2, optionCount: 1 });
    assert.equal(logs.join("").includes(OPTION_16PRO), false);
  });
});

test("A6 함께 적용을 끄면 이 추적 하나만 바뀐다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables);
    const { response, body } = await post(ctx, { mode: "save", optionInput: OPTION_16PRO, applyToSameProduct: false });
    assert.equal(response.status, 200);
    assert.deepEqual(body.updatedTrackerIds, [SELF_ID]);
    assert.equal(state.updates.length, 1);
    assert.deepEqual(tables.naver_rank_trackers.find((row) => row.id === uuid(1)).option_product_ids, []);
  });
});

test("미리 보기 뒤 함께 바뀌는 추적이 달라지면 저장하지 않는다(409)", async () => {
  await withEnv(async () => {
    const { ctx, state } = fakeDatabase(groupTables());
    const { response, body } = await post(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      // 예전 미리 보기(다른 대표 번호 추적까지 함께 바꾸던 화면)가 보낸 대상 목록.
      expectedTrackerIds: [SELF_ID, uuid(1), uuid(2)],
    });
    assert.equal(response.status, 409);
    assert.equal(body.code, "RANK_OPTION_TARGETS_CHANGED");
    assert.deepEqual(body.targetTrackerIds, [SELF_ID, uuid(1)]);
    assert.equal(state.updates.length, 0);
  });
});

test("다른 상품 대표 번호를 잘못 붙여 넣어도 그 상품의 추적은 바뀌지 않는다(같은 스토어여도)", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const CASE_PRIMARY = "88800000001";
    tables.naver_rank_trackers.push(trackerRow({
      id: uuid(9),
      keyword: "아이폰17 케이스 단독",
      product_id: CASE_PRIMARY,
      product_url: `https://smartstore.naver.com/ishell/products/${CASE_PRIMARY}`,
      option_product_ids: ["88800000002", "88800000003"],
    }));
    const { ctx, state } = fakeDatabase(tables);
    const preview = await post(ctx, { mode: "preview", optionInput: `${CASE_PRIMARY}\n${OPTION_16PRO}`, applyToSameProduct: true });
    assert.equal(preview.response.status, 200);
    assert.deepEqual(preview.body.targetTrackerIds, [SELF_ID, uuid(1)]);
    const saved = await post(ctx, {
      mode: "save",
      optionInput: `${CASE_PRIMARY}\n${OPTION_16PRO}`,
      applyToSameProduct: true,
      expectedTrackerIds: preview.body.targetTrackerIds,
    });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(tables.naver_rank_trackers.find((row) => row.id === uuid(9)).option_product_ids, ["88800000002", "88800000003"]);
    assert.ok(state.updates.every((update) => !update.ids.includes(uuid(9))));
  });
});

test("A7 권한: 광고주 세션·세션 없는 접속 코드는 403, 총관리자·운영팀은 허용", async () => {
  await withEnv(async () => {
    const advertiserTables = {
      naver_rank_trackers: [trackerRow({ agency_code: ADVERTISER })],
    };
    const clients = [{ id: "client-1", status: "active", disconnected_at: null }];
    for (const [label, options] of [
      ["client", { role: "client", agencyCode: ADVERTISER, accessCode: ADVERTISER }],
      ["no-session access code", { role: null, agencyCode: ADVERTISER, accessCode: ADVERTISER }],
    ]) {
      const { ctx, state } = fakeDatabase(structuredClone(advertiserTables), { clients });
      // eslint-disable-next-line no-await-in-loop
      const { response, body } = await post(ctx, { mode: "save", optionInput: OPTION_16PRO }, options);
      assert.equal(response.status, 403, label);
      assert.equal(body.code, "RANK_OPTION_FORBIDDEN");
      assert.equal(body.message, "그룹상품 번호는 관리자 화면에서만 바꿀 수 있습니다.");
      assert.equal(state.updates.length, 0);
    }
    const team = fakeDatabase(structuredClone(advertiserTables), { clients });
    const teamResult = await post(team.ctx, { mode: "read" }, { role: "team", agencyCode: ADVERTISER, accessCode: ADVERTISER });
    assert.equal(teamResult.response.status, 200);
    const owner = fakeDatabase(groupTables());
    assert.equal((await post(owner.ctx, { mode: "read" })).response.status, 200);
    const localAdmin = fakeDatabase(groupTables());
    assert.equal((await post(localAdmin.ctx, { mode: "read" }, { role: null, adminCode: true })).response.status, 200);
  });
});

test("A7 다른 광고주 범위의 추적은 찾을 수 없다(404)", async () => {
  await withEnv(async () => {
    const { ctx } = fakeDatabase(groupTables());
    const response = await handleRankTrackersRequest(
      request("POST", { action: "options", trackerId: uuid(4), mode: "read" }),
      ctx,
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "RANK_OPTION_TRACKER_NOT_FOUND");
  });
});

test("A8 원부 추적·대표 번호 없는 추적에는 붙일 수 없다(409)", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx } = fakeDatabase(tables);
    const catalog = await handleRankTrackersRequest(
      request("POST", { action: "options", trackerId: uuid(5), mode: "preview", optionInput: OPTION_16PRO }),
      ctx,
    );
    assert.equal(catalog.status, 409);
    assert.equal((await catalog.json()).code, "RANK_OPTION_CATALOG_TRACKER");
    tables.naver_rank_trackers.push(trackerRow({ id: uuid(9), product_id: "", product_url: "https://smartstore.naver.com/ishell" }));
    const legacy = await handleRankTrackersRequest(
      request("POST", { action: "options", trackerId: uuid(9), mode: "read" }),
      ctx,
    );
    assert.equal(legacy.status, 409);
    assert.equal((await legacy.json()).code, "RANK_OPTION_PRIMARY_INVALID");
  });
});

test("A9 칸 없음(대표 SQL 전): 저장은 409 RANK_OPTION_NOT_READY, 목록은 200·빈 목록·그룹 이름 유지", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const save = fakeDatabase(tables, { optionColumnMissing: true });
    const quiet = console.warn;
    console.warn = () => {};
    try {
      const preview = await post(save.ctx, { mode: "preview", optionInput: OPTION_16PRO });
      assert.equal(preview.response.status, 200);
      assert.equal(preview.body.columnReady, false);
      const { response, body } = await post(save.ctx, { mode: "save", optionInput: OPTION_16PRO });
      assert.equal(response.status, 409);
      assert.equal(body.code, "RANK_OPTION_NOT_READY");
      assert.equal(save.state.updates.length, 0);

      forgetOptionColumnMissing();
      const list = fakeDatabase(tables, { optionColumnMissing: true });
      const listResponse = await handleRankTrackersRequest(request("GET"), list.ctx);
      const listBody = await listResponse.json();
      assert.equal(listResponse.status, 200);
      const self = listBody.trackers.find((entry) => entry.id === SELF_ID);
      assert.equal(self.groupName, "아이쉘");
      assert.deepEqual(self.optionProductIds, []);
      assert.equal(self.optionProductCount, 0);
      assert.equal(self.optionEditable, true);
      assert.equal(listBody.trackers.find((entry) => entry.id === uuid(5)).optionEditable, false);
    } finally {
      console.warn = quiet;
    }
  });
});

test("A3·A11·A13 51개·거절 칸·너무 긴 입력은 400 이고 아무것도 쓰지 않는다", async () => {
  await withEnv(async () => {
    const { ctx, state } = fakeDatabase(groupTables());
    const many = Array.from({ length: 51 }, (_, index) => String(99900000300 + index)).join("\n");
    const limit = await post(ctx, { mode: "save", optionInput: many });
    assert.equal(limit.response.status, 400);
    assert.equal(limit.body.code, "RANK_OPTION_LIMIT");
    assert.equal(limit.body.message, "그룹상품 번호는 최대 50개까지 넣을 수 있습니다.");
    const rejected = await post(ctx, { mode: "save", optionInput: `${OPTION_16PRO} abc` });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.code, "RANK_OPTION_INPUT_REJECTED");
    const long = await post(ctx, { mode: "preview", optionInput: "1".repeat(20_001) });
    assert.equal(long.response.status, 400);
    assert.equal(long.body.code, "RANK_OPTION_INPUT_TOO_LONG");
    const tokens = await post(ctx, { mode: "preview", optionInput: Array.from({ length: 121 }, (_, index) => String(99900000500 + index)).join(" ") });
    assert.equal(tokens.response.status, 400);
    assert.equal(tokens.body.code, "RANK_OPTION_INPUT_TOO_LONG");
    const badMode = await post(ctx, { mode: "delete-all" });
    assert.equal(badMode.response.status, 400);
    const badId = await handleRankTrackersRequest(request("POST", { action: "options", trackerId: "not-a-uuid", mode: "read" }), ctx);
    assert.equal(badId.status, 400);
    assert.equal(state.updates.length, 0);
  });
});

test("A12 빈 입력 저장 = 그룹상품 해제([] 저장)", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx } = fakeDatabase(tables);
    const { response, body } = await post(ctx, { mode: "save", optionInput: "", applyToSameProduct: false });
    assert.equal(response.status, 200);
    assert.deepEqual(body.optionProductIds, []);
    assert.deepEqual(body.removedOptionProductIds, [OPTION_15]);
    assert.equal(body.message, "그룹상품 번호를 지웠습니다(추적 1개). 다음 순위 확인부터 대표 상품번호만 찾습니다.");
    assert.deepEqual(tables.naver_rank_trackers.find((row) => row.id === SELF_ID).option_product_ids, []);
  });
});

test("A14 DB CHECK 위반은 409, 일부만 저장되면 409 RANK_OPTION_PARTIAL — 5xx 없음", async () => {
  await withEnv(async () => {
    const check = fakeDatabase(groupTables(), {
      updateError: () => ({ code: "23514", message: "new row violates check constraint" }),
    });
    const invalid = await post(check.ctx, { mode: "save", optionInput: OPTION_16PRO });
    assert.equal(invalid.response.status, 409);
    assert.equal(invalid.body.code, "RANK_OPTION_INVALID");

    // CHECK 위반 문구에 칸 이름(제약 이름)과 '42703' 같은 숫자가 섞여도 칸 없음(RANK_OPTION_NOT_READY)으로 보지 않는다.
    const checkWithNumbers = fakeDatabase(groupTables(), {
      updateError: () => ({
        code: "23514",
        message: 'new row for relation "naver_rank_trackers" violates check constraint "naver_rank_trackers_option_product_ids_shape"',
        details: "Failing row contains (123e4567-e89b-42d3-a456-426614174000, 99427031234).",
      }),
    });
    const quiet = console.warn;
    const warnings = [];
    console.warn = (line) => warnings.push(String(line));
    try {
      const numbered = await post(checkWithNumbers.ctx, { mode: "save", optionInput: OPTION_16PRO });
      assert.equal(numbered.response.status, 409);
      assert.equal(numbered.body.code, "RANK_OPTION_INVALID");
    } finally {
      console.warn = quiet;
    }
    assert.equal(warnings.some((line) => line.includes("naver_rank_option_column_missing")), false, "칸 없음 기억을 켜지 않는다");

    // 함께 적용 대상은 같은 대표 번호·같은 목록이라 update 한 번에 모두 바뀐다(일부만 저장되는 길 없음).
    const tables = groupTables();
    const single = fakeDatabase(tables);
    const { response, body } = await post(single.ctx, { mode: "save", optionInput: OPTION_16PRO, applyToSameProduct: true });
    assert.equal(response.status, 200);
    assert.equal(single.state.updates.length, 1);
    assert.deepEqual(single.state.updates[0].ids.sort(), [SELF_ID, uuid(1)].sort());
    assert.deepEqual(body.updatedTrackerIds.sort(), [SELF_ID, uuid(1)].sort());
  });
});

test("A10 목록 응답: 새 칸, 날짜 칸 압축 키, 옵션 목록을 고쳐도 지난 기록은 그대로(A10b), 가져오기 알림 개수", async () => {
  await withEnv(async () => {
    const now = Date.now();
    const iso = (hoursAgo) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
    const optionItem = (optionId) => ({
      trackingRankSource: "exact_product",
      trackingRankSourceLabel: "상품 ID 기준",
      title: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매",
      productId: "3000000037",
      mallName: "아이쉘",
      link: `https://smartstore.naver.com/main/products/${optionId}`,
      isOrganic: true,
      isAd: false,
      rankPolicy: "organic_only",
      adExcluded: true,
      matchBasis: "group_option",
      matchedOptionProductId: optionId,
      optionGroup: { checkedOptionCount: 1, matchedOptionTitle: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매", mallCheck: "unverified", titleCheck: "ok" },
    });
    const snapshots = [
      { id: "s3", tracker_id: SELF_ID, checked_at: iso(1), rank: 37, matched: true, checked_count: 300, item: optionItem(OPTION_16PRO), message: "옵션" },
      { id: "s2", tracker_id: SELF_ID, checked_at: iso(10), rank: 30, matched: true, checked_count: 300, item: optionItem(OPTION_16PRO), message: "옵션" },
      { id: "s1", tracker_id: SELF_ID, checked_at: iso(20), rank: 12, matched: true, checked_count: 300, item: { trackingRankSource: "exact_product", title: "대표", isOrganic: true, isAd: false }, message: "대표" },
    ];
    const kept = trackerPayload(trackerRow({ option_product_ids: [OPTION_16PRO] }), snapshots);
    assert.deepEqual(kept.optionProductIds, [OPTION_16PRO]);
    assert.equal(kept.optionProductCount, 1);
    assert.equal(kept.optionEditable, true);
    assert.equal(kept.currentRank, 37);
    assert.equal(kept.currentMatchBasis, "group_option");
    assert.equal(kept.currentMatchedOptionProductId, OPTION_16PRO);
    assert.equal(kept.currentMatchedOptionTitle, "아이쉘 아이폰16 프로 저반사 액정보호필름 2매");
    assert.equal(kept.currentOptionMallCheck, "unverified");
    assert.equal(kept.currentOptionTitleCheck, "ok");
    assert.equal(kept.bestRank, 12);
    assert.deepEqual(kept.snapshots[1].item, {
      trackingRankSource: "exact_product",
      trackingRankSourceLabel: "상품 ID 기준",
      title: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매",
      productId: "3000000037",
      mallName: "아이쉘",
      link: `https://smartstore.naver.com/main/products/${OPTION_16PRO}`,
      matchBasis: "group_option",
      matchedOptionProductId: OPTION_16PRO,
    });

    // 명세 §7.3·§15-4: 번호를 바꾸거나 모두 지워도 옵션으로 잡힌 지난 기록은 숨기지 않는다(현재·최근 확인도 그대로).
    for (const optionProductIds of [[], [OPTION_15]]) {
      const edited = trackerPayload(trackerRow({ option_product_ids: optionProductIds, current_rank: 37 }), snapshots);
      assert.deepEqual(edited.snapshots.map((snapshot) => snapshot.id), ["s3", "s2", "s1"]);
      assert.equal(edited.currentRank, 37);
      assert.equal(edited.lastCheckedAt, snapshots[0].checked_at);
      assert.equal(edited.currentMatchBasis, "group_option");
      assert.equal(edited.currentMatchedOptionProductId, OPTION_16PRO);
      assert.equal(edited.bestRank, 12);
      assert.deepEqual(edited.optionProductIds, optionProductIds);
      assert.equal(edited.snapshots[1].item.matchBasis, "group_option", "날짜 칸 '옵션' 표시용 압축 키는 남는다");
    }

    // 옵션 목록을 모르는 경로(칸 정보 없음·null)도 같은 결과, 화면 목록은 빈 목록.
    const { option_product_ids: _unknown, ...unknownRow } = trackerRow();
    for (const row of [unknownRow, trackerRow({ option_product_ids: null })]) {
      const payload = trackerPayload(row, snapshots);
      assert.equal(payload.snapshots.length, 3);
      assert.equal(payload.currentRank, 37);
      assert.deepEqual(payload.optionProductIds, []);
      assert.equal(payload.optionProductCount, 0);
    }

    // 퍼센트 인코딩이 깨진 옛 URL 행도 던지지 않는다(옵션 없음으로 본다).
    const broken = trackerPayload(trackerRow({ product_url: `https://smartstore.naver.com/%E0%A4%A/products/${PRIMARY}` }), snapshots);
    assert.equal(broken.optionEditable, false);
    assert.deepEqual(broken.optionProductIds, []);

    // 목록 GET: 같은 그룹 다른 추적에만 있는 번호 개수.
    const { ctx } = fakeDatabase(groupTables());
    const listResponse = await handleRankTrackersRequest(request("GET"), ctx);
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    const byId = new Map(listBody.trackers.map((entry) => [entry.id, entry]));
    assert.deepEqual(byId.get(SELF_ID).optionProductIds, [OPTION_15]);
    assert.equal(byId.get(uuid(1)).groupOptionSuggestionCount, 3);
    assert.equal(byId.get(uuid(6)).groupOptionSuggestionCount, 0);
  });
});

test("칸 없음(되돌리기 SQL 뒤·10분 기억 중) 목록도 옵션으로 잡힌 기록·현재 순위를 그대로 보인다('모름' ≠ 빈 목록)", async () => {
  await withEnv(async () => {
    const now = Date.now();
    const iso = (hoursAgo) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
    const tables = groupTables();
    tables.naver_rank_trackers[0].current_rank = 37;
    tables.naver_rank_trackers[0].last_checked_at = iso(1);
    tables.naver_rank_snapshots = [
      {
        id: "s2", tracker_id: SELF_ID, checked_at: iso(1), rank: 37, matched: true, checked_count: 300, message: "옵션",
        item: {
          trackingRankSource: "exact_product", title: "옵션 카드", isOrganic: true, isAd: false,
          matchBasis: "group_option", matchedOptionProductId: OPTION_15, optionGroup: { checkedOptionCount: 1 },
        },
      },
      {
        id: "s1", tracker_id: SELF_ID, checked_at: iso(30), rank: 12, matched: true, checked_count: 300, message: "대표",
        item: { trackingRankSource: "exact_product", title: "대표", isOrganic: true, isAd: false },
      },
    ];
    const quiet = console.warn;
    console.warn = () => {};
    try {
      const missing = fakeDatabase(tables, { optionColumnMissing: true });
      const response = await handleRankTrackersRequest(request("GET"), missing.ctx);
      const body = await response.json();
      assert.equal(response.status, 200);
      const self = body.trackers.find((entry) => entry.id === SELF_ID);
      assert.equal(self.groupName, "아이쉘");
      assert.deepEqual(self.optionProductIds, []);
      assert.equal(self.currentRank, 37);
      assert.equal(self.currentMatchBasis, "group_option");
      assert.deepEqual(self.snapshots.map((snapshot) => snapshot.id), ["s2", "s1"]);
    } finally {
      console.warn = quiet;
    }
  });
});

test("목록 GET: 퍼센트 인코딩이 깨진 옛 URL 행이 섞여도 500 이 아니다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    tables.naver_rank_trackers.push(trackerRow({
      id: uuid(8),
      keyword: "깨진 주소 옛 추적",
      status: "completed",
      product_url: "https://smartstore.naver.com/%E0%A4%A/products/12345678901",
      product_id: "12345678901",
    }));
    const { ctx } = fakeDatabase(tables);
    const response = await handleRankTrackersRequest(request("GET"), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    const broken = body.trackers.find((entry) => entry.id === uuid(8));
    assert.ok(broken, "깨진 행도 목록에 그대로 나온다");
    assert.equal(broken.optionEditable, false);
    assert.equal(broken.groupOptionSuggestionCount, 0);
  });
});

test("옵션 판정 건너뜀(2026-10-30): 관리자 응답은 이유 코드만, 광고주 응답은 변경 전 item 그대로, 오류 이름·문구는 어디에도 없다", async () => {
  const now = Date.now();
  const iso = (hoursAgo) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
  const skippedItem = {
    trackingRankSource: "not_found",
    isOrganic: true,
    isAd: false,
    optionGroup: { checkedOptionCount: 3, skipped: "evaluation_error", errorName: "TypeError", errorMessage: "x is not a function" },
  };
  const plainItem = { trackingRankSource: "exact_product", title: "대표", isOrganic: true, isAd: false };
  const snapshots = [
    { id: "s2", tracker_id: SELF_ID, checked_at: iso(1), rank: null, matched: false, checked_count: 300, item: skippedItem, message: "대표" },
    { id: "s1", tracker_id: SELF_ID, checked_at: iso(10), rank: 12, matched: true, checked_count: 300, item: plainItem, message: "대표" },
  ];
  const row = () => trackerRow({ option_product_ids: [OPTION_16PRO] });
  const admin = trackerPayload(row(), snapshots, null, { optionSkipVisible: true });
  assert.deepEqual(admin.snapshots[0].item.optionGroup, { checkedOptionCount: 3, skipped: "evaluation_error" });
  assert.equal(admin.currentMatchBasis, "");
  // 기본값(권한 표시 없음)은 광고주와 같다: 건너뜀 표시 optionGroup 을 통째로 뺀다.
  const advertiser = trackerPayload(row(), snapshots);
  assert.deepEqual(advertiser.snapshots[0].item, { trackingRankSource: "not_found", isOrganic: true, isAd: false });
  for (const payload of [admin, advertiser]) {
    assert.equal(JSON.stringify(payload).includes("x is not a function"), false);
    assert.equal(JSON.stringify(payload).includes("TypeError"), false);
  }
  assert.equal(skippedItem.optionGroup.errorName, "TypeError", "저장된 행은 건드리지 않는다");
  const plain = trackerPayload(row(), [snapshots[1]], null, { optionSkipVisible: true });
  assert.equal("optionGroup" in plain.snapshots[0].item, false);
  // 정식 판정(matchBasis 있음) 행은 광고주 응답에서도 예전 그대로다.
  const optionItem = { trackingRankSource: "exact_product", title: "옵션", isOrganic: true, isAd: false, matchBasis: "group_option", matchedOptionProductId: OPTION_16PRO, optionGroup: { checkedOptionCount: 1 } };
  const matched = trackerPayload(row(), [{ ...snapshots[0], rank: 5, matched: true, item: optionItem }]);
  assert.deepEqual(matched.snapshots[0].item.optionGroup, { checkedOptionCount: 1 });

  await withEnv(async () => {
    const ownerTables = groupTables();
    ownerTables.naver_rank_snapshots = [{ ...snapshots[0], item: structuredClone(skippedItem) }];
    const advertiserTables = {
      naver_rank_trackers: [trackerRow({ agency_code: ADVERTISER, option_product_ids: [OPTION_16PRO] })],
      naver_rank_snapshots: [{ ...snapshots[0], item: structuredClone(skippedItem) }],
    };
    const clients = [{ id: "client-1", status: "active", disconnected_at: null }];
    const advertiserScope = { agencyCode: ADVERTISER, accessCode: ADVERTISER };
    const quiet = console.warn;
    console.warn = () => {};
    try {
      for (const [label, tables, options, expected] of [
        ["owner", ownerTables, {}, { checkedOptionCount: 3, skipped: "evaluation_error" }],
        ["team", advertiserTables, { role: "team", ...advertiserScope }, { checkedOptionCount: 3, skipped: "evaluation_error" }],
        ["client", advertiserTables, { role: "client", ...advertiserScope }, undefined],
        ["no-session access code", advertiserTables, { role: null, ...advertiserScope }, undefined],
      ]) {
        const { ctx } = fakeDatabase(structuredClone(tables), { clients });
        // eslint-disable-next-line no-await-in-loop
        const response = await handleRankTrackersRequest(request("GET", null, options), ctx);
        // eslint-disable-next-line no-await-in-loop
        const body = await response.json();
        assert.equal(response.status, 200, label);
        const self = body.trackers.find((entry) => entry.id === SELF_ID);
        assert.ok(self?.snapshots?.length, label);
        assert.deepEqual(self.snapshots[0].item.optionGroup, expected, label);
        assert.equal(JSON.stringify(body).includes("x is not a function"), false, label);
      }
    } finally {
      console.warn = quiet;
    }
  });
});

test("창에 보였지만 순위에 못 쓴 번호(2026-10-30 추가): 관리자 응답만 상세, 광고주 응답은 변경 전 item·currentMatchBasis 그대로", async () => {
  const now = Date.now();
  const iso = (hoursAgo) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
  const ishellOption = "11463197547";
  const dropped = { droppedVisibleCount: 1, droppedVisible: [{ productId: ishellOption, reason: "not_exact" }] };
  const primaryItem = {
    trackingRankSource: "exact_product", title: "대표", isOrganic: true, isAd: false,
    matchBasis: "primary", optionGroup: { checkedOptionCount: 3, ...dropped },
  };
  const notFoundItem = {
    trackingRankSource: "not_found", isOrganic: true, isAd: false,
    matchBasis: "not_found", optionGroup: { checkedOptionCount: 3, ...dropped },
  };
  const mismatchPrimaryItem = {
    ...primaryItem,
    optionGroup: { checkedOptionCount: 3, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_16PRO], ...dropped },
  };
  const snap = (id, hoursAgo, rank, item) => ({
    id, tracker_id: SELF_ID, checked_at: iso(hoursAgo), rank, matched: Boolean(rank), checked_count: 300, item, message: "대표",
  });
  const row = () => trackerRow({ option_product_ids: [OPTION_16PRO, ishellOption] });
  const snapshots = [snap("s3", 1, 12, primaryItem), snap("s2", 5, null, notFoundItem), snap("s1", 10, 12, mismatchPrimaryItem)];

  const admin = trackerPayload(row(), snapshots, null, { optionSkipVisible: true });
  assert.deepEqual(admin.snapshots[0].item.optionGroup, primaryItem.optionGroup);
  assert.equal(admin.currentMatchBasis, "primary");
  assert.equal(admin.snapshots[1].item.matchBasis, "not_found", "옛 기록 칸(compact)에도 판정 키");

  const advertiser = trackerPayload(row(), snapshots);
  // 대표가 이기고 남는 표시가 옵션 개수뿐이면 변경 전에는 대표 결과 그대로였다 — 두 키를 통째로 뺀다.
  assert.deepEqual(advertiser.snapshots[0].item, { trackingRankSource: "exact_product", title: "대표", isOrganic: true, isAd: false });
  assert.equal(advertiser.currentMatchBasis, "");
  assert.equal("matchBasis" in advertiser.snapshots[0].item, false);
  // 옛 기록 칸은 compact 이고, 거기서도 변경 전과 같다(not_found 는 원래 판정 키가 있었다).
  assert.equal(advertiser.snapshots[1].item.matchBasis, "not_found");
  const notFoundOnly = trackerPayload(row(), [snapshots[1]]);
  assert.deepEqual(notFoundOnly.snapshots[0].item.optionGroup, { checkedOptionCount: 3 });
  assert.equal(notFoundOnly.currentMatchBasis, "not_found");
  const mismatchOnly = trackerPayload(row(), [snapshots[2]]);
  assert.deepEqual(mismatchOnly.snapshots[0].item.optionGroup, { checkedOptionCount: 3, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_16PRO] });
  assert.equal(mismatchOnly.currentMatchBasis, "primary");
  for (const payload of [advertiser, notFoundOnly, mismatchOnly]) {
    assert.equal(JSON.stringify(payload).includes("droppedVisible"), false);
    assert.equal(JSON.stringify(payload.snapshots).includes(ishellOption), false, "기록 칸에는 빠진 번호가 없다(넣은 번호 목록은 예전처럼 추적 칸에)");
  }
  assert.equal(primaryItem.optionGroup.droppedVisibleCount, 1, "저장된 행은 건드리지 않는다");

  await withEnv(async () => {
    const ownerTables = groupTables();
    ownerTables.naver_rank_snapshots = [{ ...snapshots[1], item: structuredClone(notFoundItem) }];
    const advertiserTables = {
      naver_rank_trackers: [trackerRow({ agency_code: ADVERTISER, option_product_ids: [OPTION_16PRO, ishellOption] })],
      naver_rank_snapshots: [{ ...snapshots[1], item: structuredClone(notFoundItem) }],
    };
    const clients = [{ id: "client-1", status: "active", disconnected_at: null }];
    const advertiserScope = { agencyCode: ADVERTISER, accessCode: ADVERTISER };
    const quiet = console.warn;
    console.warn = () => {};
    try {
      for (const [label, tables, options, expected] of [
        ["owner", ownerTables, {}, notFoundItem.optionGroup],
        ["team", advertiserTables, { role: "team", ...advertiserScope }, notFoundItem.optionGroup],
        ["client", advertiserTables, { role: "client", ...advertiserScope }, { checkedOptionCount: 3 }],
        ["no-session access code", advertiserTables, { role: null, ...advertiserScope }, { checkedOptionCount: 3 }],
      ]) {
        const { ctx } = fakeDatabase(structuredClone(tables), { clients });
        // eslint-disable-next-line no-await-in-loop
        const response = await handleRankTrackersRequest(request("GET", null, options), ctx);
        // eslint-disable-next-line no-await-in-loop
        const body = await response.json();
        assert.equal(response.status, 200, label);
        const self = body.trackers.find((entry) => entry.id === SELF_ID);
        assert.deepEqual(self.snapshots[0].item.optionGroup, expected, label);
      }
    } finally {
      console.warn = quiet;
    }
  });
});

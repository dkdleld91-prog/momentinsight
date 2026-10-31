import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeAuditMetadata } from "../audit-security.mjs";
import {
  forgetGroupMarkColumnMissing,
  forgetOptionCheckedColumnMissing,
  forgetOptionColumnMissing,
  isGroupMarkColumnMissingError,
  isOptionCheckedColumnMissingError,
  isOptionColumnMissingError,
} from "../naver-rank-option-group.mjs";
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
// 2026-10-31: 되돌림 기록(audit_logs insert)·조건부 갱신(배열 칸 eq '{…}')·확인일 칸 없음·갱신 직전 경합을 더했다.
// writes 는 쓰기 순서(insert·update)를 그대로 남긴다.
function fakeDatabase(tables, options = {}) {
  const state = { updates: [], selects: [], rpcCalls: [], queries: 0, inserts: [], writes: [], checkedMisses: 0 };
  const supabaseAdmin = {
    async rpc(name, args) {
      state.rpcCalls.push(name);
      if (name === "mi_get_naver_shopping_worker_operations") {
        return { data: { circuit_state: "closed", cadence_mode: "baseline", cadence_minutes: 10 }, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}`, args } };
    },
    from(table) {
      const ops = { filters: [], eqs: [], columns: "*", limit: Infinity, update: null, insert: null, count: false, touchesOptions: false };
      const run = async () => {
        state.queries += 1;
        if (table === "naver_shopping_worker_coordination") {
          return { data: [{ lane_key: "global", circuit_state: "closed" }], error: null };
        }
        if (table === "clients") {
          return { data: options.clients || [], error: null };
        }
        if (ops.insert) {
          const inserted = JSON.parse(JSON.stringify(Array.isArray(ops.insert) ? ops.insert : [ops.insert]));
          const insertError = options.insertError ? options.insertError(table, inserted, state) : null;
          if (insertError) return { data: null, error: insertError };
          tables[table] = [...(tables[table] || []), ...inserted];
          state.inserts.push({ table, rows: inserted });
          state.writes.push({ kind: "insert", table, actions: inserted.map((row) => row.action) });
          return { data: null, error: null };
        }
        const rows = tables[table] || [];
        const touchesOptions = ops.touchesOptions
          || String(ops.columns).includes("option_product_ids")
          || Boolean(ops.update && Object.hasOwn(ops.update, "option_product_ids"));
        if (table === "naver_rank_trackers" && touchesOptions && options.optionColumnMissing) {
          return { data: null, error: { code: "42703", message: "column naver_rank_trackers.option_product_ids does not exist" } };
        }
        // 확인일 칸 없음: true = 읽기·쓰기 모두, "update" = 쓰기만(스키마 캐시가 늦게 바뀐 경우).
        const touchesChecked = String(ops.columns).includes("option_checked_at")
          || Boolean(ops.update && Object.hasOwn(ops.update, "option_checked_at"));
        if (table === "naver_rank_trackers" && touchesChecked
          && (options.checkedColumnMissing === true || (options.checkedColumnMissing === "update" && ops.update))) {
          state.checkedMisses += 1;
          return {
            data: null,
            error: options.checkedColumnError || { code: "42703", message: "column naver_rank_trackers.option_checked_at does not exist" },
          };
        }
        if (ops.update && options.beforeUpdate) options.beforeUpdate(tables, state);
        const matched = rows.filter((row) => ops.filters.every((filter) => filter(row)));
        if (ops.update) {
          if (options.updateError) {
            const updateError = options.updateError(ops, state);
            if (updateError) return { data: null, error: updateError };
          }
          state.updates.push({
            table,
            values: JSON.parse(JSON.stringify(ops.update)),
            ids: matched.map((row) => row.id),
            eqs: ops.eqs.slice(),
          });
          state.writes.push({ kind: "update", table, ids: matched.map((row) => row.id) });
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
        insert(values) { ops.insert = values; return query; },
        // 배열 칸은 PostgREST 처럼 text[] 리터럴('{a,b}', 순서 포함)과 비교한다. 배열을 그대로 넘기면 맞지 않는다.
        eq(column, value) {
          ops.eqs.push([column, value]);
          ops.filters.push((row) => (Array.isArray(row[column])
            ? typeof value === "string" && `{${row[column].join(",")}}` === value
            : String(row[column]) === String(value)));
          return query;
        },
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
  const forgetColumnMemos = () => {
    forgetOptionColumnMissing();
    forgetGroupMarkColumnMissing();
    forgetOptionCheckedColumnMissing();
  };
  forgetColumnMemos();
  try {
    return await callback({ fetchCalls, logs });
  } finally {
    forgetColumnMemos();
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

// 미리 보기 응답이 싣는 저장값(DB 그대로)과 같은 모양. 저장 요청은 이 값을 그대로 돌려보낸다(2026-10-31 B4).
function expectedFor(tables, ids) {
  return Object.fromEntries(ids.map((id) => [id, [...tables.naver_rank_trackers.find((row) => row.id === id).option_product_ids]]));
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
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
    });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.updatedCount, 2);
    assert.deepEqual(body.updatedTrackerIds.sort(), [SELF_ID, uuid(1)].sort());
    assert.deepEqual(body.optionProductIds, [OPTION_16PRO]);
    assert.equal(body.message, "그룹상품 번호 1개를 추적 2개에 저장했습니다. 다음 순위 확인부터 적용됩니다.");
    // 같은 대표 번호·같은 목록이어도 미리 보기 때 저장값이 다르면(이 추적 [OPTION_15]·uuid(1) []) 조건부 갱신을 따로 한다(2026-10-31).
    assert.equal(state.updates.length, 2);
    for (const update of state.updates) {
      assert.deepEqual(Object.keys(update.values), ["option_product_ids"], "확인일은 전체 확인 저장(fullReview)일 때만");
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
    const { response, body } = await post(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: false,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID]),
    });
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
      expectedOptionProductIds: preview.body.expectedOptionProductIds,
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
    const { response, body } = await post(ctx, {
      mode: "save",
      optionInput: "",
      applyToSameProduct: false,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID]),
    });
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
    const selfExpected = { [SELF_ID]: [OPTION_15] };
    const invalid = await post(check.ctx, { mode: "save", optionInput: OPTION_16PRO, expectedOptionProductIds: selfExpected });
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
      const numbered = await post(checkWithNumbers.ctx, { mode: "save", optionInput: OPTION_16PRO, expectedOptionProductIds: selfExpected });
      assert.equal(numbered.response.status, 409);
      assert.equal(numbered.body.code, "RANK_OPTION_INVALID");
    } finally {
      console.warn = quiet;
    }
    assert.equal(warnings.some((line) => line.includes("naver_rank_option_column_missing")), false, "칸 없음 기억을 켜지 않는다");

    // 함께 적용 대상이 같은 대표 번호·같은 목록·같은 저장값이면 update 한 번에 모두 바뀐다(일부만 저장되는 길 없음).
    // 저장값이 다르면 따로 쓴다(일부 저장·경합은 아래 B4 시험).
    const tables = groupTables();
    tables.naver_rank_trackers[1].option_product_ids = [OPTION_15];
    const single = fakeDatabase(tables);
    const { response, body } = await post(single.ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
    });
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

test("광고주 응답 문장(2026-10-30): lastMessage·snapshots[].message 에서 관리자 전용 꼬리 2종을 서버가 빼고, 관리자·운영팀은 그대로", async () => {
  const now = Date.now();
  const iso = (hoursAgo) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
  const ishellOption = "11463197547";
  const notFoundMain = "대표 상품번호와 그룹상품 옵션 2개 모두 오가닉 상위 300개 결과에서 순위로 잡지 못했습니다.";
  const droppedTail = " 옵션 2개 중 1개는 결과에 보였지만 같은 상품으로 확인되지 않아 순위에 쓰지 않았습니다.";
  const hitMain = `그룹상품 옵션(상품번호 ${OPTION_16PRO})이 오가닉 37위로 잡혀 30일 대표 순위로 기록했습니다. 대표 상품번호는 이번 결과에 없습니다.`;
  const unverifiedTail = " 스토어를 확인하지 못해 확인 없이 기록했습니다.";
  const dropped = { droppedVisibleCount: 1, droppedVisible: [{ productId: ishellOption, reason: "not_exact" }] };
  const hitItem = {
    trackingRankSource: "exact_product", title: "옵션", isOrganic: true, isAd: false,
    matchBasis: "group_option", matchedOptionProductId: OPTION_16PRO,
    optionGroup: { checkedOptionCount: 2, mallCheck: "unverified", ...dropped },
  };
  const notFoundItem = { trackingRankSource: "not_found", isOrganic: true, isAd: false, matchBasis: "not_found", optionGroup: { checkedOptionCount: 2, ...dropped } };
  const snapshots = [
    { id: "s2", tracker_id: SELF_ID, checked_at: iso(1), rank: 37, matched: true, checked_count: 300, item: hitItem, message: hitMain + unverifiedTail },
    { id: "s1", tracker_id: SELF_ID, checked_at: iso(10), rank: null, matched: false, checked_count: 300, item: notFoundItem, message: notFoundMain + droppedTail },
  ];
  const row = () => trackerRow({ option_product_ids: [OPTION_16PRO, ishellOption], last_message: hitMain + unverifiedTail });
  const admin = trackerPayload(row(), snapshots, null, { optionSkipVisible: true });
  assert.equal(admin.lastMessage, hitMain + unverifiedTail);
  assert.deepEqual(admin.snapshots.map((entry) => entry.message), [hitMain + unverifiedTail, notFoundMain + droppedTail]);
  assert.deepEqual(admin.snapshots[0].item.optionGroup, hitItem.optionGroup, "옵션이 이긴 측정의 빠진 번호도 관리자에게");
  const advertiser = trackerPayload(row(), snapshots);
  assert.equal(advertiser.lastMessage, hitMain);
  assert.deepEqual(advertiser.snapshots.map((entry) => entry.message), [hitMain, notFoundMain]);
  assert.deepEqual(advertiser.snapshots[0].item.optionGroup, { checkedOptionCount: 2, mallCheck: "unverified" }, "광고주 item 은 변경 전과 같다");
  assert.equal(advertiser.currentMatchBasis, "group_option");
  assert.equal(snapshots[0].message, hitMain + unverifiedTail, "저장된 문장은 건드리지 않는다");
  // 꼬리 없는 문장은 그대로(같은 글자).
  const plain = trackerPayload(trackerRow({ last_message: "네이버쇼핑 오가닉 12위" }), []);
  assert.equal(plain.lastMessage, "네이버쇼핑 오가닉 12위");

  await withEnv(async () => {
    const rows = (agency) => [trackerRow({ ...(agency ? { agency_code: agency } : {}), option_product_ids: [OPTION_16PRO, ishellOption], last_message: notFoundMain + droppedTail })];
    const ownerTables = groupTables();
    ownerTables.naver_rank_snapshots = [{ ...snapshots[1], item: structuredClone(notFoundItem) }];
    const advertiserTables = { naver_rank_trackers: rows(ADVERTISER), naver_rank_snapshots: [{ ...snapshots[1], item: structuredClone(notFoundItem) }] };
    const clients = [{ id: "client-1", status: "active", disconnected_at: null }];
    const advertiserScope = { agencyCode: ADVERTISER, accessCode: ADVERTISER };
    const quiet = console.warn;
    console.warn = () => {};
    try {
      for (const [label, tables, options, expected] of [
        ["owner", ownerTables, {}, notFoundMain + droppedTail],
        ["team", advertiserTables, { role: "team", ...advertiserScope }, notFoundMain + droppedTail],
        ["client", advertiserTables, { role: "client", ...advertiserScope }, notFoundMain],
        ["no-session access code", advertiserTables, { role: null, ...advertiserScope }, notFoundMain],
      ]) {
        const { ctx } = fakeDatabase(structuredClone(tables), { clients });
        // eslint-disable-next-line no-await-in-loop
        const response = await handleRankTrackersRequest(request("GET", null, options), ctx);
        // eslint-disable-next-line no-await-in-loop
        const body = await response.json();
        assert.equal(response.status, 200, label);
        const self = body.trackers.find((entry) => entry.id === SELF_ID);
        assert.equal(self.snapshots[0].message, expected, label);
        assert.equal(self.lastMessage, expected, label);
        assert.equal(JSON.stringify(body).includes("결과에 보였지만"), expected.includes("결과에 보였지만"), label);
      }
    } finally {
      console.warn = quiet;
    }
  });
});

// ───────────── 옵션 번호 정식 기능(대표 요청 2026-10-31): 동시 변경 보호(B4)·되돌림 기록(B3)·옵션 확인일(B6) ─────────────

const auditRows = (tables, action) => (tables.audit_logs || []).filter((row) => row.action === action);
const rowById = (tables, id) => tables.naver_rank_trackers.find((row) => row.id === id);

async function quietWarnings(callback) {
  const original = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(String(line));
  try {
    return await callback(warnings);
  } finally {
    console.warn = original;
  }
}

test("B4 저장에는 미리 보기 때 저장값이 있어야 한다: 없거나·대상이 빠지거나·모양이 틀리면 409 PREVIEW_REQUIRED, 쓰기·기록 0", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables);
    for (const [label, extra] of [
      ["없음(옛 화면 캐시)", { applyToSameProduct: false }],
      ["함께 바뀌는 추적이 빠짐", { applyToSameProduct: true, expectedOptionProductIds: { [SELF_ID]: [OPTION_15] } }],
      ["배열이 아님", { expectedOptionProductIds: { [SELF_ID]: OPTION_15 } }],
      ["숫자형 번호", { expectedOptionProductIds: { [SELF_ID]: [Number(OPTION_15)] } }],
      ["숫자가 아닌 글자(리터럴 깨짐)", { expectedOptionProductIds: { [SELF_ID]: [`${OPTION_15}},{1`] } }],
      ["객체가 아님", { expectedOptionProductIds: [[OPTION_15]] }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { response, body } = await post(ctx, { mode: "save", optionInput: OPTION_16PRO, ...extra });
      assert.equal(response.status, 409, label);
      assert.equal(body.code, "RANK_OPTION_PREVIEW_REQUIRED", label);
      assert.equal(body.message, "화면을 새로 고친 뒤 다시 미리 보기 해주세요.", label);
    }
    assert.equal(state.updates.length, 0);
    assert.equal(state.inserts.length, 0, "되돌림 기록도 쓰지 않는다");
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, [OPTION_15]);
    // 추적 id 의 대소문자는 가리지 않는다.
    const upper = await post(ctx, { mode: "save", optionInput: OPTION_16PRO, expectedOptionProductIds: { [SELF_ID.toUpperCase()]: [OPTION_15] } });
    assert.equal(upper.response.status, 200);
  });
});

test("B4 미리 보기 뒤 저장값이 바뀌었으면 쓰기 전에 409 CHANGED(순서만 달라도), 같은 저장값으로 두 번 저장하면 나중 것은 거절", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables);
    const preview = await post(ctx, { mode: "preview", optionInput: OPTION_16PRO, applyToSameProduct: true });
    assert.equal(preview.response.status, 200);
    // 다른 관리자가 미리 보기 뒤에 같은 대표 번호 추적의 목록을 바꿨다.
    rowById(tables, uuid(1)).option_product_ids = ["99900000088"];
    const stale = await post(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedTrackerIds: preview.body.targetTrackerIds,
      expectedOptionProductIds: preview.body.expectedOptionProductIds,
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.code, "RANK_OPTION_CHANGED");
    assert.equal(stale.body.message, "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요.");
    assert.equal(state.updates.length, 0);
    assert.equal(state.inserts.length, 0, "쓰기 전 거절이라 되돌림 기록도 없다");
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, [OPTION_15]);

    // 같은 번호라도 순서가 다르면 다른 값이다(DB 그대로 비교).
    rowById(tables, SELF_ID).option_product_ids = [OPTION_15, "99900000003"];
    const reordered = await post(ctx, { mode: "save", optionInput: OPTION_16PRO, expectedOptionProductIds: { [SELF_ID]: ["99900000003", OPTION_15] } });
    assert.equal(reordered.response.status, 409);
    assert.equal(reordered.body.code, "RANK_OPTION_CHANGED");

    // 두 화면이 같은 저장값을 보고 차례로 저장: 먼저 누른 쪽만 저장되고 나중 쪽은 덮어쓰지 않는다.
    const seen = { [SELF_ID]: [OPTION_15, "99900000003"] };
    const first = await post(ctx, { mode: "save", optionInput: OPTION_16PRO, expectedOptionProductIds: seen });
    assert.equal(first.response.status, 200);
    const second = await post(ctx, { mode: "save", optionInput: "99900000004", expectedOptionProductIds: seen });
    assert.equal(second.response.status, 409);
    assert.equal(second.body.code, "RANK_OPTION_CHANGED");
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, [OPTION_16PRO]);
  });
});

test("B4 조건부 갱신: option_product_ids = 미리 보기 때 저장값 리터럴('{…}', 빈 목록 '{}')일 때만 쓴다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables);
    const preview = await post(ctx, { mode: "preview", optionInput: OPTION_16PRO, applyToSameProduct: true });
    const saved = await post(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedTrackerIds: preview.body.targetTrackerIds,
      expectedOptionProductIds: preview.body.expectedOptionProductIds,
    });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(state.updates.map((update) => [update.ids, update.eqs]), [
      [[SELF_ID], [["product_id", PRIMARY], ["option_product_ids", `{${OPTION_15}}`]]],
      [[uuid(1)], [["product_id", PRIMARY], ["option_product_ids", "{}"]]],
    ]);
  });
});

test("B4 쓰는 사이 경합으로 갱신 줄 수가 모자라면 멈추고 409 CHANGED, 이미 바뀐 추적은 응답·결과 기록에 남는다", async () => {
  await withEnv(async () => {
    // 한 묶음(같은 저장값) 안에서 한 추적이 먼저 바뀜.
    const tables = groupTables();
    rowById(tables, uuid(1)).option_product_ids = [OPTION_15];
    let raced = false;
    const { ctx } = fakeDatabase(tables, {
      beforeUpdate(current) {
        if (raced) return;
        raced = true;
        current.naver_rank_trackers.find((row) => row.id === uuid(1)).option_product_ids = ["99900000099"];
      },
    });
    const { response, body } = await quietWarnings(() => post(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      fullReview: true,
    }));
    assert.equal(response.status, 409);
    assert.equal(body.code, "RANK_OPTION_CHANGED");
    assert.equal(body.message, "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요.");
    assert.deepEqual(body.updatedTrackerIds, [SELF_ID]);
    assert.deepEqual(rowById(tables, uuid(1)).option_product_ids, ["99900000099"], "먼저 바꾼 값은 덮어쓰지 않는다");
    assert.equal(Object.hasOwn(rowById(tables, uuid(1)), "option_checked_at"), false);
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, [OPTION_16PRO]);
    assert.equal(typeof rowById(tables, SELF_ID).option_checked_at, "string", "저장된 추적은 번호와 확인일이 함께 바뀐다");
    const results = auditRows(tables, "naver_rank_options_save_result");
    assert.deepEqual(results.map((row) => row.metadata), [{
      updatedTrackerIds: [SELF_ID],
      checkedTrackerIds: [SELF_ID],
      targetCount: 2,
      checkedAtRecorded: true,
      fullReview: true,
      outcome: "RANK_OPTION_CHANGED",
    }]);

    // 첫 묶음이 0줄이면 다음 묶음은 쓰지 않는다.
    const other = groupTables();
    const race = fakeDatabase(other, {
      beforeUpdate(current) {
        current.naver_rank_trackers.find((row) => row.id === SELF_ID).option_product_ids = ["99900000099"];
      },
    });
    const stopped = await quietWarnings(() => post(race.ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(other, [SELF_ID, uuid(1)]),
    }));
    assert.equal(stopped.response.status, 409);
    assert.equal(stopped.body.code, "RANK_OPTION_CHANGED");
    assert.deepEqual(stopped.body.updatedTrackerIds, []);
    assert.equal(race.state.updates.length, 1);
    assert.deepEqual(rowById(other, uuid(1)).option_product_ids, []);
    assert.deepEqual(auditRows(other, "naver_rank_options_save_result")[0].metadata.updatedTrackerIds, []);
  });
});

test("B4 두 번째 묶음 쓰기가 실패하면 기존대로 409 PARTIAL, 이미 저장된 추적은 응답·결과 기록에 남는다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    let calls = 0;
    const { ctx } = fakeDatabase(tables, {
      updateError: () => {
        calls += 1;
        return calls === 2 ? { code: "57014", message: "canceling statement due to statement timeout" } : null;
      },
    });
    const { response, body } = await quietWarnings(() => post(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
    }));
    assert.equal(response.status, 409);
    assert.equal(body.code, "RANK_OPTION_PARTIAL");
    // 같은 저장값으로 다시 저장하면 이미 저장된 추적의 조건이 맞지 않아 늘 거절되므로 다시 미리 보기부터 하게 한다.
    assert.equal(body.message, "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요.");
    assert.equal(body.message.includes("같은 내용으로"), false);
    assert.deepEqual(body.updatedTrackerIds, [SELF_ID]);
    // 코드가 실린 DB 거절(57014 문장 취소)은 되돌려진 것이라 '저장됐는지 모름'이 아니다(H1).
    assert.equal(Object.hasOwn(body, "uncertainTrackerIds"), false);
    const [result] = auditRows(tables, "naver_rank_options_save_result");
    assert.deepEqual(result.metadata, {
      updatedTrackerIds: [SELF_ID],
      checkedTrackerIds: [],
      targetCount: 2,
      checkedAtRecorded: false,
      fullReview: false,
      outcome: "RANK_OPTION_PARTIAL",
    });
  });
});

const UNCERTAIN_NOTICE = "저장됐는지 확인하지 못했습니다. 편집창을 다시 열어 확인해주세요.";

async function quietSave(ctx, body) {
  return quietWarnings(async (warnings) => ({ ...(await post(ctx, body)), warnings }));
}

test("H1 두 번째 묶음 쓰기가 예외로 끝나면 409 PARTIAL, 저장된 추적과 저장됐는지 모르는 추적을 응답·결과 기록에 나눠 남긴다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    let calls = 0;
    const { ctx } = fakeDatabase(tables, {
      updateError: () => {
        calls += 1;
        if (calls === 2) throw new TypeError("fetch failed");
        return null;
      },
    });
    const { response, body, warnings } = await quietSave(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
    });
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, "RANK_OPTION_PARTIAL");
    assert.equal(body.message, `추적 2개 중 1개를 저장했습니다. 추적 1개는 ${UNCERTAIN_NOTICE}`);
    assert.deepEqual(body.updatedTrackerIds, [SELF_ID]);
    assert.deepEqual(body.uncertainTrackerIds, [uuid(1)]);
    assert.equal(calls, 2);
    const results = auditRows(tables, "naver_rank_options_save_result");
    assert.deepEqual(results.map((row) => row.metadata), [{
      updatedTrackerIds: [SELF_ID],
      checkedTrackerIds: [],
      uncertainTrackerIds: [uuid(1)],
      targetCount: 2,
      checkedAtRecorded: false,
      fullReview: false,
      outcome: "RANK_OPTION_PARTIAL",
    }]);
    const warning = warnings.find((line) => line.includes("naver_rank_tracker_options_uncertain"));
    assert.ok(warning, "모르는 추적 경고를 남긴다");
    assert.equal(JSON.parse(warning).thrown, true);
    assert.equal(JSON.parse(warning).uncertainCount, 1);
    assert.equal(warnings.some((line) => line.includes("fetch failed")), false, "오류 문구는 로그에 남기지 않는다");
  });
});

test("H1 확실한 거절이 아닌 오류(코드 없음·연결류 코드)는 저장됐는지 모름, 코드가 실린 DB 거절은 기존대로", async () => {
  await withEnv(async () => {
    const uncertainErrors = [
      // 게이트웨이 5xx 의 JSON 아닌 본문(postgrest-js 는 code 없이 message 만 준다)
      { message: "<html><body>504 Gateway Time-out</body></html>" },
      // postgrest-js 의 fetch 실패
      { message: "TypeError: fetch failed", details: "Caused by: Error: other side closed", hint: "", code: "" },
      { message: "AbortError: This operation was aborted", code: "20" },
      { message: "read ECONNRESET", code: "ECONNRESET" },
      { message: "connection failure", code: "08006" },
      { message: "Database client error. Retrying the connection.", code: "PGRST001" },
    ];
    for (const updateError of uncertainErrors) {
      const tables = groupTables();
      let calls = 0;
      const { ctx } = fakeDatabase(tables, {
        updateError: () => {
          calls += 1;
          return calls === 2 ? updateError : null;
        },
      });
      // eslint-disable-next-line no-await-in-loop
      const { response, body } = await quietSave(ctx, {
        mode: "save",
        optionInput: OPTION_16PRO,
        applyToSameProduct: true,
        expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      });
      const label = JSON.stringify(updateError);
      assert.equal(response.status, 409, label);
      assert.equal(body.code, "RANK_OPTION_PARTIAL", label);
      assert.equal(body.message, `추적 2개 중 1개를 저장했습니다. 추적 1개는 ${UNCERTAIN_NOTICE}`, label);
      assert.deepEqual(body.updatedTrackerIds, [SELF_ID], label);
      assert.deepEqual(body.uncertainTrackerIds, [uuid(1)], label);
      assert.deepEqual(auditRows(tables, "naver_rank_options_save_result")[0].metadata.uncertainTrackerIds, [uuid(1)], label);
    }

    // PostgREST 가 코드를 실어 거절한 오류(권한 42501·PGRST 코드)는 지금처럼 일부 저장(모르는 추적 없음)이다.
    for (const updateError of [
      { message: "permission denied for table naver_rank_trackers", code: "42501" },
      { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
    ]) {
      const tables = groupTables();
      let calls = 0;
      const { ctx } = fakeDatabase(tables, {
        updateError: () => {
          calls += 1;
          return calls === 2 ? updateError : null;
        },
      });
      // eslint-disable-next-line no-await-in-loop
      const { response, body } = await quietSave(ctx, {
        mode: "save",
        optionInput: OPTION_16PRO,
        applyToSameProduct: true,
        expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      });
      const label = JSON.stringify(updateError);
      assert.equal(response.status, 409, label);
      assert.equal(body.code, "RANK_OPTION_PARTIAL", label);
      assert.equal(body.message, "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요.", label);
      assert.equal(Object.hasOwn(body, "uncertainTrackerIds"), false, label);
      assert.equal(Object.hasOwn(auditRows(tables, "naver_rank_options_save_result")[0].metadata, "uncertainTrackerIds"), false, label);
    }
  });
});

test("F6 문장 완료 여부 모름(40003)·관리자 개입/서버 종료(57P01·57P02·57P03)는 저장됐는지 모름, 57014·40001·40P01·23514·42501 은 확실한 거절", async () => {
  await withEnv(async () => {
    const runSecondGroupFailure = async (updateError) => {
      const tables = groupTables();
      let calls = 0;
      const { ctx } = fakeDatabase(tables, {
        updateError: () => {
          calls += 1;
          return calls === 2 ? updateError : null;
        },
      });
      const result = await quietSave(ctx, {
        mode: "save",
        optionInput: OPTION_16PRO,
        applyToSameProduct: true,
        expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      });
      return { ...result, tables };
    };

    // 확정 중에 연결·서버가 끊겼을 수 있는 코드 — DB 가 이미 썼는지 알 수 없다.
    for (const updateError of [
      { message: "statement completion unknown", code: "40003" },
      { message: "terminating connection due to administrator command", code: "57P01" },
      { message: "terminating connection due to crash of another server process", code: "57P02" },
      { message: "the database system is shutting down", code: "57P03" },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { response, body, tables } = await runSecondGroupFailure(updateError);
      const label = JSON.stringify(updateError);
      assert.equal(response.status, 409, label);
      assert.equal(body.code, "RANK_OPTION_PARTIAL", label);
      assert.equal(body.message, `추적 2개 중 1개를 저장했습니다. 추적 1개는 ${UNCERTAIN_NOTICE}`, label);
      assert.deepEqual(body.updatedTrackerIds, [SELF_ID], label);
      assert.deepEqual(body.uncertainTrackerIds, [uuid(1)], label);
      assert.deepEqual(auditRows(tables, "naver_rank_options_save_result")[0].metadata.uncertainTrackerIds, [uuid(1)], label);
    }

    // 문장이 되돌려진 거절(문장 취소·직렬화 실패·교착·CHECK 위반·권한) — 지금처럼 일부 저장(모르는 추적 없음)이다.
    for (const updateError of [
      { message: "canceling statement due to statement timeout", code: "57014" },
      { message: "could not serialize access due to concurrent update", code: "40001" },
      { message: "deadlock detected", code: "40P01" },
      { message: "new row violates check constraint", code: "23514" },
      { message: "permission denied for table naver_rank_trackers", code: "42501" },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { response, body, tables } = await runSecondGroupFailure(updateError);
      const label = JSON.stringify(updateError);
      assert.equal(response.status, 409, label);
      assert.equal(body.code, "RANK_OPTION_PARTIAL", label);
      assert.equal(body.message, "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요.", label);
      assert.deepEqual(body.updatedTrackerIds, [SELF_ID], label);
      assert.equal(Object.hasOwn(body, "uncertainTrackerIds"), false, label);
      assert.equal(Object.hasOwn(auditRows(tables, "naver_rank_options_save_result")[0].metadata, "uncertainTrackerIds"), false, label);
    }
  });
});

test("H1 첫 묶음 쓰기가 예외로 끝나도 409 PARTIAL(저장 0·모름 n), 다음 묶음은 쓰지 않는다 — 코드가 실린 거절은 기존대로 500", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    let calls = 0;
    const { ctx, state } = fakeDatabase(tables, {
      updateError: () => {
        calls += 1;
        throw new Error("socket hang up");
      },
    });
    const { response, body } = await quietSave(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      fullReview: true,
    });
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, "RANK_OPTION_PARTIAL");
    assert.equal(body.message, `저장 중 오류가 났습니다. 추적 1개는 ${UNCERTAIN_NOTICE}`);
    assert.deepEqual(body.updatedTrackerIds, []);
    assert.deepEqual(body.uncertainTrackerIds, [SELF_ID]);
    assert.equal(calls, 1, "모르는 묶음 뒤 묶음은 쓰지 않는다");
    assert.equal(state.updates.length, 0);
    assert.deepEqual(rowById(tables, uuid(1)).option_product_ids, []);
    assert.deepEqual(auditRows(tables, "naver_rank_options_save_result").map((row) => row.metadata), [{
      updatedTrackerIds: [],
      checkedTrackerIds: [],
      uncertainTrackerIds: [SELF_ID],
      targetCount: 2,
      checkedAtRecorded: false,
      fullReview: true,
      outcome: "RANK_OPTION_PARTIAL",
    }]);

    // 첫 묶음이 코드가 실린 DB 거절(권한)이면 기존대로 500 이고, 결과 기록에 모르는 추적이 없다.
    const deniedTables = groupTables();
    const denied = fakeDatabase(deniedTables, {
      updateError: () => ({ message: "permission denied for table naver_rank_trackers", code: "42501" }),
    });
    const originalError = console.error;
    console.error = () => {};
    let deniedResult;
    try {
      deniedResult = await quietSave(denied.ctx, {
        mode: "save",
        optionInput: OPTION_16PRO,
        expectedOptionProductIds: expectedFor(deniedTables, [SELF_ID]),
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(deniedResult.response.status, 500);
    assert.equal(Object.hasOwn(deniedResult.body, "uncertainTrackerIds"), false);
    const [deniedAudit] = auditRows(deniedTables, "naver_rank_options_save_result");
    assert.equal(deniedAudit.metadata.outcome, "error");
    assert.equal(Object.hasOwn(deniedAudit.metadata, "uncertainTrackerIds"), false);
  });
});

test("H1 저장됐는지 모르는 추적이 51개 이상이면 결과 기록을 50개씩 나눠 쓴다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    rowById(tables, SELF_ID).option_product_ids = ["99900000300"];
    const extraIds = Array.from({ length: 59 }, (_, index) => uuid(100 + index));
    extraIds.forEach((id, index) => tables.naver_rank_trackers.push(trackerRow({ id, keyword: `같은 상품 추적 ${index}`, group_name: "기본 그룹" })));
    const ids = [SELF_ID, uuid(1), ...extraIds];
    let calls = 0;
    const { ctx } = fakeDatabase(tables, {
      updateError: () => {
        calls += 1;
        if (calls === 2) throw new TypeError("fetch failed");
        return null;
      },
    });
    const { response, body } = await quietSave(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, ids),
    });
    assert.equal(response.status, 409, JSON.stringify(body).slice(0, 300));
    assert.deepEqual(body.updatedTrackerIds, [SELF_ID]);
    assert.equal(body.uncertainTrackerIds.length, 60);
    assert.equal(body.message, `추적 61개 중 1개를 저장했습니다. 추적 60개는 ${UNCERTAIN_NOTICE}`);
    const results = auditRows(tables, "naver_rank_options_save_result");
    assert.deepEqual(results.map((row) => [
      row.metadata.part,
      row.metadata.partCount,
      row.metadata.updatedTrackerIds.length,
      row.metadata.updatedCount,
      row.metadata.uncertainTrackerIds.length,
      row.metadata.uncertainCount,
    ]), [[1, 2, 1, 1, 50, 60], [2, 2, 0, 1, 10, 60]]);
    assert.deepEqual(results.flatMap((row) => row.metadata.uncertainTrackerIds).sort(), ids.filter((id) => id !== SELF_ID).sort());
  });
});

test("B3 되돌림 기록 먼저: 바꿀 추적마다 한 줄(저장 전·바꿀 목록) → 조건부 갱신 → 결과 한 줄, 기록 실패면 저장하지 않는다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables);
    const { response } = await post(ctx, {
      mode: "save",
      optionInput: `${PRIMARY}\n${OPTION_16PRO}`,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      fullReview: true,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(state.writes.map((write) => (write.kind === "insert" ? write.actions : write.ids)), [
      ["naver_rank_options_save_intent", "naver_rank_options_save_intent"],
      [SELF_ID],
      [uuid(1)],
      ["naver_rank_options_save_result"],
    ]);
    const intent = (targetId, before, keyword) => ({
      actor_id: null,
      client_id: null,
      action: "naver_rank_options_save_intent",
      target_table: "naver_rank_trackers",
      target_id: targetId,
      metadata: {
        before,
        after: [OPTION_16PRO],
        fullReview: true,
        applyToSameProduct: true,
        primaryProductId: PRIMARY,
        keyword,
      },
    });
    assert.deepEqual(auditRows(tables, "naver_rank_options_save_intent"), [
      intent(SELF_ID, [OPTION_15], "아이폰 17 필름"),
      intent(uuid(1), [], "아이폰17 케이스"),
    ]);
    const [result] = auditRows(tables, "naver_rank_options_save_result");
    assert.equal(result.target_id, SELF_ID);
    assert.deepEqual(result.metadata, {
      updatedTrackerIds: [SELF_ID, uuid(1)],
      checkedTrackerIds: [SELF_ID, uuid(1)],
      targetCount: 2,
      checkedAtRecorded: true,
      fullReview: true,
      outcome: "saved",
    });
    assert.equal(JSON.stringify(tables.audit_logs).includes(OWNER_CODE), false, "범위 코드는 기록에 없다");

    // 되돌림 기록을 못 남기면 저장하지 않는다.
    const failTables = groupTables();
    const failing = fakeDatabase(failTables, {
      insertError: () => ({ code: "42501", message: "permission denied for table audit_logs" }),
    });
    const failed = await quietWarnings(async (warnings) => {
      const outcome = await post(failing.ctx, {
        mode: "save",
        optionInput: OPTION_16PRO,
        expectedOptionProductIds: expectedFor(failTables, [SELF_ID]),
        fullReview: true,
      });
      return { ...outcome, warnings };
    });
    assert.equal(failed.response.status, 409);
    assert.equal(failed.body.code, "RANK_OPTION_AUDIT_FAILED");
    assert.equal(failed.body.message, "되돌림 기록을 남기지 못해 저장하지 않았습니다. 잠시 뒤 다시 저장해주세요.");
    assert.equal(failing.state.updates.length, 0);
    assert.deepEqual(rowById(failTables, SELF_ID).option_product_ids, [OPTION_15]);
    assert.ok(failed.warnings.some((line) => line.includes("naver_rank_tracker_options_audit_failed") && line.includes('"stage":"intent"')));

    // 결과 기록만 실패하면 저장은 그대로 두고 경고만 남긴다.
    const resultTables = groupTables();
    const resultFailing = fakeDatabase(resultTables, {
      insertError: (_table, rows) => (rows[0]?.action === "naver_rank_options_save_result" ? { code: "XX000", message: "boom" } : null),
    });
    const kept = await quietWarnings(async (warnings) => {
      const outcome = await post(resultFailing.ctx, {
        mode: "save",
        optionInput: OPTION_16PRO,
        expectedOptionProductIds: expectedFor(resultTables, [SELF_ID]),
      });
      return { ...outcome, warnings };
    });
    assert.equal(kept.response.status, 200);
    assert.deepEqual(rowById(resultTables, SELF_ID).option_product_ids, [OPTION_16PRO]);
    assert.ok(kept.warnings.some((line) => line.includes("naver_rank_tracker_options_audit_failed") && line.includes('"stage":"result"')));
  });
});

test("B3 기록이 잘리지 않는다: 옵션 50개는 저장 전·후 그대로, 추적 51개 이상은 결과 기록을 50개씩 나눠 쓴다", async () => {
  await withEnv(async () => {
    const fifty = Array.from({ length: 50 }, (_, index) => String(99900000300 + index));
    assert.equal(sanitizeAuditMetadata({ before: fifty }).before.length, 50, "정리 규칙은 50개까지 자르지 않는다");
    const tables = groupTables();
    rowById(tables, SELF_ID).option_product_ids = [...fifty];
    const extraIds = Array.from({ length: 59 }, (_, index) => uuid(100 + index));
    extraIds.forEach((id, index) => tables.naver_rank_trackers.push(trackerRow({ id, keyword: `같은 상품 추적 ${index}`, group_name: "기본 그룹" })));
    const next = Array.from({ length: 50 }, (_, index) => String(99900000400 + index));
    const ids = [SELF_ID, uuid(1), ...extraIds];
    const { ctx } = fakeDatabase(tables);
    const { response, body } = await post(ctx, {
      mode: "save",
      optionInput: next.join("\n"),
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, ids),
      fullReview: true,
    });
    assert.equal(response.status, 200, JSON.stringify(body).slice(0, 300));
    assert.equal(body.updatedCount, 61);
    const intents = auditRows(tables, "naver_rank_options_save_intent");
    assert.equal(intents.length, 61, "추적 하나당 한 줄");
    const selfIntent = intents.find((row) => row.target_id === SELF_ID);
    assert.deepEqual(selfIntent.metadata.before, fifty);
    assert.deepEqual(selfIntent.metadata.after, next);
    const results = auditRows(tables, "naver_rank_options_save_result");
    // 확인일을 쓴 추적 목록도 50개씩 나눠 쓴다(잘리지 않는다).
    assert.deepEqual(results.map((row) => [
      row.metadata.part,
      row.metadata.partCount,
      row.metadata.updatedTrackerIds.length,
      row.metadata.updatedCount,
      row.metadata.checkedTrackerIds.length,
      row.metadata.checkedCount,
    ]), [[1, 2, 50, 61, 50, 61], [2, 2, 11, 61, 11, 61]]);
    assert.deepEqual(results.flatMap((row) => row.metadata.updatedTrackerIds).sort(), [...ids].sort());
    assert.deepEqual(results.flatMap((row) => row.metadata.checkedTrackerIds).sort(), [...ids].sort());
  });
});

test("B6 확인일: 전체 확인 저장(fullReview)이면 실제로 저장된 추적에만 번호와 같은 문장으로, 후보 넣기 저장(false)은 쓰지 않는다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables);
    const saved = await post(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      fullReview: true,
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.checkedAtRecorded, true);
    assert.match(saved.body.optionCheckedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    assert.equal(state.updates.length, 2);
    for (const update of state.updates) {
      assert.deepEqual(update.values, { option_product_ids: [OPTION_16PRO], option_checked_at: saved.body.optionCheckedAt });
    }
    assert.equal(rowById(tables, SELF_ID).option_checked_at, saved.body.optionCheckedAt);
    assert.equal(rowById(tables, uuid(1)).option_checked_at, saved.body.optionCheckedAt);
    assert.equal(Object.hasOwn(rowById(tables, uuid(2)), "option_checked_at"), false, "대표 번호가 다른 추적은 그대로");

    // 함께 적용을 끄면 이 추적만.
    const solo = groupTables();
    const soloDb = fakeDatabase(solo);
    const soloSaved = await post(soloDb.ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: false,
      expectedOptionProductIds: expectedFor(solo, [SELF_ID]),
      fullReview: true,
    });
    assert.equal(soloSaved.body.checkedAtRecorded, true);
    assert.equal(rowById(solo, SELF_ID).option_checked_at, soloSaved.body.optionCheckedAt);
    assert.equal(Object.hasOwn(rowById(solo, uuid(1)), "option_checked_at"), false);

    // 후보 넣기 저장(fullReview:false)·true 가 아닌 값은 확인일을 바꾸지 않는다.
    for (const fullReview of [false, "true", undefined]) {
      const candidate = groupTables();
      rowById(candidate, SELF_ID).option_checked_at = "2026-10-01T00:00:00.000Z";
      const candidateDb = fakeDatabase(candidate);
      // eslint-disable-next-line no-await-in-loop
      const added = await post(candidateDb.ctx, {
        mode: "save",
        optionInput: `${OPTION_15}\n${OPTION_16PRO}`,
        expectedOptionProductIds: expectedFor(candidate, [SELF_ID]),
        ...(fullReview === undefined ? {} : { fullReview }),
      });
      assert.equal(added.response.status, 200, String(fullReview));
      assert.equal(added.body.checkedAtRecorded, false, String(fullReview));
      assert.equal(added.body.optionCheckedAt, null, String(fullReview));
      assert.deepEqual(candidateDb.state.updates.map((update) => Object.keys(update.values)), [["option_product_ids"]]);
      assert.equal(rowById(candidate, SELF_ID).option_checked_at, "2026-10-01T00:00:00.000Z");
      assert.equal(auditRows(candidate, "naver_rank_options_save_intent")[0].metadata.fullReview, false);
    }
  });
});

test("B6 '확인만 기록'(checkOnly): 읽기 응답의 현재 목록·저장값으로 보내면 확인일 한 칸만 쓴다 — 번호는 DB 그대로(순서·옛 값 포함)", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    // 저장값에 대표 번호·중복이 섞인 옛 값이 있어도 '확인만 기록'은 번호를 다시 쓰지 않는다(정리된 순서로 바뀌지 않게).
    const raw = [OPTION_16PRO, PRIMARY, OPTION_15, OPTION_16PRO];
    rowById(tables, SELF_ID).option_product_ids = [...raw];
    rowById(tables, SELF_ID).option_checked_at = null;
    const { ctx, state } = fakeDatabase(tables);
    const read = await post(ctx, { mode: "read" });
    assert.equal(read.response.status, 200);
    assert.equal(read.body.checkedAtReady, true);
    assert.equal(read.body.tracker.optionCheckedAt, null);
    assert.deepEqual(read.body.tracker.optionProductIds, [OPTION_16PRO, OPTION_15]);
    const confirmed = await post(ctx, {
      mode: "save",
      // 화면 목록 순서가 달라도 집합이 같으면 된다.
      optionInput: [...read.body.tracker.optionProductIds].reverse().join("\n"),
      applyToSameProduct: false,
      expectedTrackerIds: read.body.targetTrackerIds,
      expectedOptionProductIds: read.body.expectedOptionProductIds,
      fullReview: true,
      checkOnly: true,
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.checkedAtRecorded, true);
    assert.deepEqual(confirmed.body.updatedTrackerIds, [SELF_ID]);
    assert.deepEqual(confirmed.body.removedOptionProductIds, []);
    assert.equal(confirmed.body.message, "옵션 확인일을 기록했습니다(추적 1개). 번호는 그대로입니다.");
    assert.deepEqual(state.updates.map((update) => [update.values, update.eqs]), [[
      { option_checked_at: confirmed.body.optionCheckedAt },
      [["product_id", PRIMARY], ["option_product_ids", `{${raw.join(",")}}`]],
    ]]);
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, raw, "번호는 DB 그대로");
    assert.equal(rowById(tables, SELF_ID).option_checked_at, confirmed.body.optionCheckedAt);
    const [intent] = auditRows(tables, "naver_rank_options_save_intent");
    assert.deepEqual(intent.metadata, {
      before: raw,
      after: raw,
      fullReview: true,
      checkOnly: true,
      applyToSameProduct: false,
      primaryProductId: PRIMARY,
      keyword: "아이폰 17 필름",
    });
    const [result] = auditRows(tables, "naver_rank_options_save_result");
    assert.deepEqual(result.metadata, {
      updatedTrackerIds: [SELF_ID],
      checkedTrackerIds: [SELF_ID],
      targetCount: 1,
      checkedAtRecorded: true,
      fullReview: true,
      checkOnly: true,
      outcome: "saved",
    });
    const again = await post(ctx, { mode: "read" });
    assert.equal(again.body.tracker.optionCheckedAt, confirmed.body.optionCheckedAt);

    // 함께 적용: 같은 대표 번호 추적도 저장된 번호가 같으면 확인일만 함께 쓴다.
    const both = groupTables();
    rowById(both, uuid(1)).option_product_ids = [OPTION_15];
    const bothDb = fakeDatabase(both);
    const together = await post(bothDb.ctx, {
      mode: "save",
      optionInput: OPTION_15,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(both, [SELF_ID, uuid(1)]),
      fullReview: true,
      checkOnly: true,
    });
    assert.equal(together.response.status, 200);
    assert.deepEqual(together.body.updatedTrackerIds.sort(), [SELF_ID, uuid(1)].sort());
    assert.deepEqual(bothDb.state.updates.map((update) => Object.keys(update.values)), [["option_checked_at"]]);
    assert.equal(rowById(both, uuid(1)).option_checked_at, together.body.optionCheckedAt);
  });
});

test("B6 '확인만 기록'(checkOnly): 번호가 저장된 것과 다르면 409 CHECK_ONLY_MISMATCH, fullReview 없거나 번호가 없으면 400 — 쓰기·기록 0", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables);
    const selfExpected = expectedFor(tables, [SELF_ID]);
    for (const [label, extra] of [
      ["번호 추가", { optionInput: `${OPTION_15}\n${OPTION_16PRO}`, expectedOptionProductIds: selfExpected }],
      ["번호 바꿈", { optionInput: OPTION_16PRO, expectedOptionProductIds: selfExpected }],
      ["모두 지움", { optionInput: "", expectedOptionProductIds: selfExpected }],
      // 함께 적용: 이 추적은 같아도 다른 키워드 추적(빈 목록)의 번호가 바뀌게 되면 거절한다.
      ["다른 키워드 추적이 다름", {
        optionInput: OPTION_15,
        applyToSameProduct: true,
        expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { response, body } = await post(ctx, { mode: "save", fullReview: true, checkOnly: true, ...extra });
      assert.equal(response.status, 409, label);
      assert.equal(body.code, "RANK_OPTION_CHECK_ONLY_MISMATCH", label);
      assert.equal(body.message, "번호가 저장된 것과 달라 확인만 기록할 수 없습니다. 미리 보기 한 뒤 저장해주세요.", label);
    }
    // 저장값이 바뀌었으면(다른 사람이 먼저 바꿈) 일반 저장과 같이 CHANGED 가 먼저다.
    const stale = await post(ctx, {
      mode: "save",
      optionInput: OPTION_15,
      fullReview: true,
      checkOnly: true,
      expectedOptionProductIds: { [SELF_ID]: ["99900000088"] },
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.code, "RANK_OPTION_CHANGED");
    for (const fullReview of [false, undefined, "true"]) {
      // eslint-disable-next-line no-await-in-loop
      const { response, body } = await post(ctx, {
        mode: "save",
        optionInput: OPTION_15,
        checkOnly: true,
        expectedOptionProductIds: selfExpected,
        ...(fullReview === undefined ? {} : { fullReview }),
      });
      assert.equal(response.status, 400, String(fullReview));
      assert.equal(body.code, "RANK_OPTION_CHECK_ONLY_INVALID", String(fullReview));
    }
    assert.equal(state.updates.length, 0);
    assert.equal(state.inserts.length, 0, "되돌림 기록도 쓰지 않는다");
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, [OPTION_15]);
    assert.equal(Object.hasOwn(rowById(tables, SELF_ID), "option_checked_at"), false);

    // 저장된 번호가 없는 추적은 확인일을 남기지 않는다(빈 목록끼리 같아도 400).
    const empty = groupTables();
    rowById(empty, SELF_ID).option_product_ids = [];
    const emptyDb = fakeDatabase(empty);
    const none = await post(emptyDb.ctx, {
      mode: "save",
      optionInput: "",
      fullReview: true,
      checkOnly: true,
      expectedOptionProductIds: expectedFor(empty, [SELF_ID]),
    });
    assert.equal(none.response.status, 400);
    assert.equal(none.body.code, "RANK_OPTION_CHECK_ONLY_INVALID");
    assert.equal(emptyDb.state.updates.length, 0);
    assert.equal(emptyDb.state.inserts.length, 0);
  });
});

test("B6 '확인만 기록'(checkOnly): 확인일 칸이 없으면 409(번호는 쓰지 않음), 쓰는 사이 경합이면 409 CHANGED", async () => {
  await withEnv(async () => {
    // 읽을 때부터 칸 없음(대표 SQL 전): 쓰기 전에 거절.
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables, { checkedColumnMissing: true });
    const notReady = await quietWarnings(() => post(ctx, {
      mode: "save",
      optionInput: OPTION_15,
      fullReview: true,
      checkOnly: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID]),
    }));
    assert.equal(notReady.response.status, 409);
    assert.equal(notReady.body.code, "RANK_OPTION_NOT_READY");
    assert.equal(notReady.body.message, "확인일 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요.");
    assert.equal(state.updates.length, 0);
    assert.equal(state.inserts.length, 0);

    // 쓸 때만 칸 없음(스키마 캐시): 확인일 없이 다시 쓰지 않는다(번호를 다시 쓰지 않음) — 409, 쓰기 0.
    const late = groupTables();
    const lateDb = fakeDatabase(late, {
      checkedColumnMissing: "update",
      checkedColumnError: { code: "PGRST204", message: "Could not find the 'option_checked_at' column of 'naver_rank_trackers' in the schema cache" },
    });
    const lateOutcome = await quietWarnings(async (warnings) => ({
      ...(await post(lateDb.ctx, {
        mode: "save",
        optionInput: OPTION_15,
        fullReview: true,
        checkOnly: true,
        expectedOptionProductIds: expectedFor(late, [SELF_ID]),
      })),
      warnings,
    }));
    assert.equal(lateOutcome.response.status, 409);
    assert.equal(lateOutcome.body.code, "RANK_OPTION_NOT_READY");
    assert.equal(lateOutcome.body.message, "확인일 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요.");
    assert.equal(lateDb.state.checkedMisses, 1);
    assert.equal(lateDb.state.updates.length, 0, "확인일 없이 번호만 다시 쓰지 않는다");
    assert.ok(lateOutcome.warnings.some((line) => line.includes("naver_rank_option_checked_column_missing")));
    assert.equal(auditRows(late, "naver_rank_options_save_result")[0].metadata.outcome, "RANK_OPTION_NOT_READY");

    // 쓰는 사이 누가 먼저 바꿈: 조건(저장값)이 맞지 않아 0줄 → 409 CHANGED, 확인일도 남지 않는다.
    const race = groupTables();
    const raceDb = fakeDatabase(race, {
      beforeUpdate(current) {
        current.naver_rank_trackers.find((row) => row.id === SELF_ID).option_product_ids = ["99900000099"];
      },
    });
    const raced = await quietWarnings(() => post(raceDb.ctx, {
      mode: "save",
      optionInput: OPTION_15,
      fullReview: true,
      checkOnly: true,
      expectedOptionProductIds: expectedFor(race, [SELF_ID]),
    }));
    assert.equal(raced.response.status, 409);
    assert.equal(raced.body.code, "RANK_OPTION_CHANGED");
    assert.deepEqual(raced.body.updatedTrackerIds, []);
    assert.equal(Object.hasOwn(rowById(race, SELF_ID), "option_checked_at"), false);
    assert.deepEqual(auditRows(race, "naver_rank_options_save_result")[0].metadata.checkedTrackerIds, []);
  });
});

test("B6 번호를 모두 지우는 전체 확인 저장에는 확인일을 남기지 않는다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    rowById(tables, SELF_ID).option_checked_at = "2026-10-01T00:00:00.000Z";
    const { ctx, state } = fakeDatabase(tables);
    const cleared = await post(ctx, {
      mode: "save",
      optionInput: "",
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      fullReview: true,
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.body.checkedAtRecorded, false);
    assert.equal(cleared.body.optionCheckedAt, null);
    assert.deepEqual(state.updates.map((update) => Object.keys(update.values)), [["option_product_ids"], ["option_product_ids"]]);
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, []);
    assert.equal(rowById(tables, SELF_ID).option_checked_at, "2026-10-01T00:00:00.000Z", "지난 확인일은 그대로");
    assert.equal(Object.hasOwn(rowById(tables, uuid(1)), "option_checked_at"), false);
    const [result] = auditRows(tables, "naver_rank_options_save_result");
    assert.deepEqual(result.metadata.checkedTrackerIds, []);
    assert.equal(result.metadata.checkedAtRecorded, false);
  });
});

test("B4·B6 읽기·미리 보기 응답: expectedOptionProductIds = 이 추적 + 같은 대표 번호 추적 전부(함께 적용과 무관)·DB 그대로, 확인일", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    // 화면 목록은 정리된 값이지만 저장값은 DB 그대로(대표 번호·중복이 섞인 옛 값도 순서 그대로)다.
    rowById(tables, SELF_ID).option_product_ids = [OPTION_16PRO, PRIMARY, OPTION_15, OPTION_16PRO];
    rowById(tables, SELF_ID).option_checked_at = "2026-10-30T01:02:03+00:00";
    rowById(tables, uuid(1)).option_checked_at = null;
    const { ctx } = fakeDatabase(tables);
    let preview = null;
    for (const [mode, extra] of [["read", {}], ["preview", { optionInput: OPTION_15 }]]) {
      // eslint-disable-next-line no-await-in-loop
      const { response, body } = await post(ctx, { mode, applyToSameProduct: false, ...extra });
      assert.equal(response.status, 200, mode);
      assert.deepEqual(body.tracker.optionProductIds, [OPTION_16PRO, OPTION_15], mode);
      assert.deepEqual(body.expectedOptionProductIds, {
        [SELF_ID]: [OPTION_16PRO, PRIMARY, OPTION_15, OPTION_16PRO],
        [uuid(1)]: [],
      }, mode);
      assert.deepEqual(body.targetTrackerIds, [SELF_ID], mode);
      assert.equal(body.checkedAtReady, true, mode);
      assert.equal(body.tracker.optionCheckedAt, "2026-10-30T01:02:03.000Z", mode);
      assert.deepEqual(body.sameProduct.trackers.map((entry) => [entry.id, entry.optionCheckedAt]), [[uuid(1), null]], mode);
      if (mode === "preview") preview = body;
    }
    assert.equal(preview.parsed.primaryRemoved, false, "대표 번호 포함 여부는 기존 칸 그대로");
    const saved = await post(ctx, { mode: "save", optionInput: OPTION_15, expectedOptionProductIds: preview.expectedOptionProductIds });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, [OPTION_15]);

    // 옵션 칸을 못 읽으면 저장값은 null(모름)이고 확인일도 모른다.
    const missing = fakeDatabase(groupTables(), { optionColumnMissing: true });
    const read = await quietWarnings(() => post(missing.ctx, { mode: "read" }));
    assert.equal(read.body.columnReady, false);
    assert.equal(read.body.checkedAtReady, false);
    assert.deepEqual(read.body.expectedOptionProductIds, { [SELF_ID]: null, [uuid(1)]: null });
  });
});

test("확인일 칸 없음 오류 판정은 옵션 칸·표시 칸 없음 판정과 겹치지 않는다", () => {
  for (const error of [
    { code: "42703", message: "column naver_rank_trackers.option_checked_at does not exist" },
    { code: "PGRST204", message: "Could not find the 'option_checked_at' column of 'naver_rank_trackers' in the schema cache" },
    { message: 'column "option_checked_at" does not exist' },
  ]) {
    assert.equal(isOptionCheckedColumnMissingError(error), true, error.message);
    assert.equal(isOptionColumnMissingError(error), false, `옵션 칸 없음으로 보면 수집 제출이 옵션을 무시한다: ${error.message}`);
    assert.equal(isGroupMarkColumnMissingError(error), false, error.message);
  }
  for (const error of [
    { code: "42703", message: "column naver_rank_trackers.option_product_ids does not exist" },
    { code: "42703", message: "column naver_rank_trackers.group_product_marked does not exist" },
    { code: "23514", message: 'new row violates check constraint "naver_rank_trackers_option_product_ids_shape"' },
    { code: "23514", message: "option_checked_at check failed" },
    { code: "42501", message: "permission denied for column option_checked_at" },
    { message: "option_checked_at is fine" },
    null,
    "column option_checked_at does not exist",
  ]) {
    assert.equal(isOptionCheckedColumnMissingError(error), false, String(error?.message ?? error));
  }
});

test("B6 확인일 칸 없음(대표 SQL 전): 읽기는 checkedAtReady:false, 전체 확인 저장도 번호만, 목록은 그 칸만 빼고 읽고 10분 동안 다시 묻지 않는다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    tables.naver_rank_trackers.forEach((row) => { row.group_product_marked = false; });
    const { ctx, state } = fakeDatabase(tables, { checkedColumnMissing: true });
    const outcome = await quietWarnings(async (warnings) => {
      const read = await post(ctx, { mode: "read" });
      const saved = await post(ctx, {
        mode: "save",
        optionInput: OPTION_16PRO,
        expectedOptionProductIds: read.body.expectedOptionProductIds,
        fullReview: true,
      });
      return { read, saved, warnings };
    });
    assert.equal(outcome.read.response.status, 200);
    assert.equal(outcome.read.body.columnReady, true, "옵션 칸은 그대로 읽는다");
    assert.equal(outcome.read.body.checkedAtReady, false);
    assert.equal(outcome.read.body.tracker.optionCheckedAt, null);
    assert.deepEqual(outcome.read.body.expectedOptionProductIds[SELF_ID], [OPTION_15]);
    assert.equal(outcome.saved.response.status, 200);
    assert.equal(outcome.saved.body.checkedAtRecorded, false);
    assert.equal(outcome.saved.body.optionCheckedAt, null);
    assert.deepEqual(state.updates.map((update) => Object.keys(update.values)), [["option_product_ids"]]);
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, [OPTION_16PRO]);
    assert.ok(outcome.warnings.some((line) => line.includes("naver_rank_option_checked_column_missing")));
    assert.equal(outcome.warnings.some((line) => line.includes("naver_rank_option_column_missing")), false, "옵션 칸 없음 기억을 켜지 않는다");
    assert.equal(outcome.warnings.some((line) => line.includes("naver_rank_group_mark_column_missing")), false);

    // 목록: 새로 시작한 함수 인스턴스(기억 없음)에서 첫 목록은 확인일 칸만 빼고 다시 읽고, 두 번째 목록은 묻지 않는다.
    forgetOptionCheckedColumnMissing();
    const list = fakeDatabase(tables, { checkedColumnMissing: true });
    const bodies = await quietWarnings(async () => {
      const first = await handleRankTrackersRequest(request("GET"), list.ctx);
      const second = await handleRankTrackersRequest(request("GET"), list.ctx);
      return [first.status, await first.json(), second.status];
    });
    assert.equal(bodies[0], 200);
    assert.equal(bodies[2], 200);
    const self = bodies[1].trackers.find((entry) => entry.id === SELF_ID);
    assert.equal(self.optionCheckReady, false);
    assert.equal(self.optionCheckedAt, null);
    assert.equal(self.groupMarkReady, true, "표시 칸은 그대로 읽는다");
    assert.deepEqual(self.optionProductIds, [OPTION_16PRO]);
    assert.equal(self.groupName, "아이쉘");
    assert.equal(list.state.checkedMisses, 1, "실패할 조회는 한 번만");
    assert.deepEqual(
      list.state.selects.filter((entry) => String(entry.columns).startsWith("id, group_name")).map((entry) => entry.columns),
      ["id, group_name, option_product_ids, group_product_marked", "id, group_name, option_product_ids, group_product_marked"],
    );
  });
});

test("B6 저장 때만 확인일 칸이 없으면(스키마 캐시 PGRST204) 확인일만 빼고 같은 조건부 갱신을 한 번 더 한다", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    const { ctx, state } = fakeDatabase(tables, {
      checkedColumnMissing: "update",
      checkedColumnError: { code: "PGRST204", message: "Could not find the 'option_checked_at' column of 'naver_rank_trackers' in the schema cache" },
    });
    const outcome = await quietWarnings(async (warnings) => ({
      ...(await post(ctx, {
        mode: "save",
        optionInput: OPTION_16PRO,
        applyToSameProduct: true,
        expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
        fullReview: true,
      })),
      warnings,
    }));
    assert.equal(outcome.response.status, 200);
    assert.equal(outcome.body.checkedAtRecorded, false);
    assert.equal(outcome.body.optionCheckedAt, null);
    assert.deepEqual(outcome.body.updatedTrackerIds, [SELF_ID, uuid(1)]);
    assert.equal(state.checkedMisses, 1, "실패한 확인일 쓰기는 한 번, 다음 묶음은 처음부터 확인일 없이");
    assert.deepEqual(state.updates.map((update) => [Object.keys(update.values), update.eqs.at(-1)]), [
      [["option_product_ids"], ["option_product_ids", `{${OPTION_15}}`]],
      [["option_product_ids"], ["option_product_ids", "{}"]],
    ]);
    assert.deepEqual(rowById(tables, SELF_ID).option_product_ids, [OPTION_16PRO]);
    assert.equal(auditRows(tables, "naver_rank_options_save_result")[0].metadata.checkedAtRecorded, false);
    assert.ok(outcome.warnings.some((line) => line.includes("naver_rank_option_checked_column_missing")));
    assert.equal(outcome.warnings.some((line) => line.includes("naver_rank_option_column_missing")), false);
  });
});

test("B6 목록 응답: optionCheckedAt(ISO)·optionCheckReady, 칸 정보 없음·옵션 칸 없음이면 모름(false)", async () => {
  const checkFields = (payload) => ({ optionCheckedAt: payload.optionCheckedAt, optionCheckReady: payload.optionCheckReady });
  const admin = { optionSkipVisible: true };
  assert.deepEqual(checkFields(trackerPayload(trackerRow(), [], null, admin)), { optionCheckedAt: null, optionCheckReady: false });
  assert.deepEqual(checkFields(trackerPayload(trackerRow({ option_checked_at: null }), [], null, admin)), { optionCheckedAt: null, optionCheckReady: true });
  assert.deepEqual(
    checkFields(trackerPayload(trackerRow({ option_checked_at: "2026-10-30T01:02:03+00:00" }), [], null, admin)),
    { optionCheckedAt: "2026-10-30T01:02:03.000Z", optionCheckReady: true },
  );
  assert.deepEqual(
    checkFields(trackerPayload(trackerRow({ option_checked_at: "not-a-date" }), [], null, admin)),
    { optionCheckedAt: null, optionCheckReady: true },
  );
  // 기본값(권한 표시 없음)은 광고주와 같다: 확인일을 싣지 않는다.
  assert.deepEqual(
    checkFields(trackerPayload(trackerRow({ option_checked_at: "2026-10-30T01:02:03+00:00" }), [])),
    { optionCheckedAt: null, optionCheckReady: false },
  );

  await withEnv(async () => {
    const tables = groupTables();
    rowById(tables, SELF_ID).option_checked_at = "2026-10-30T01:02:03+00:00";
    const { ctx } = fakeDatabase(tables);
    const response = await handleRankTrackersRequest(request("GET"), ctx);
    const body = await response.json();
    assert.equal(response.status, 200);
    const byId = new Map(body.trackers.map((entry) => [entry.id, entry]));
    assert.deepEqual(checkFields(byId.get(SELF_ID)), { optionCheckedAt: "2026-10-30T01:02:03.000Z", optionCheckReady: true });
    assert.deepEqual(checkFields(byId.get(uuid(1))), { optionCheckedAt: null, optionCheckReady: true });

    // 옵션 칸이 없으면(대표 SQL 전) 확인일 칸도 읽지 않는다 — 그룹 이름은 그대로.
    const missing = fakeDatabase(groupTables(), { optionColumnMissing: true });
    const missingBody = await quietWarnings(async () => (await handleRankTrackersRequest(request("GET"), missing.ctx)).json());
    const self = missingBody.trackers.find((entry) => entry.id === SELF_ID);
    assert.deepEqual(checkFields(self), { optionCheckedAt: null, optionCheckReady: false });
    assert.equal(self.groupName, "아이쉘");
  });
});

test("B6 광고주 응답에는 옵션 확인일이 없다(키·순서는 그대로 null·false), 관리자·운영팀 응답에만 실린다", async () => {
  await withEnv(async () => {
    const checkedAt = "2026-10-30T01:02:03+00:00";
    const advertiserTables = {
      naver_rank_trackers: [trackerRow({ agency_code: ADVERTISER, option_product_ids: [OPTION_16PRO], option_checked_at: checkedAt })],
    };
    const ownerTables = groupTables();
    rowById(ownerTables, SELF_ID).option_checked_at = checkedAt;
    const clients = [{ id: "client-1", status: "active", disconnected_at: null }];
    const advertiserScope = { agencyCode: ADVERTISER, accessCode: ADVERTISER };
    await quietWarnings(async () => {
      for (const [label, tables, options, expected] of [
        ["owner", ownerTables, {}, { optionCheckedAt: "2026-10-30T01:02:03.000Z", optionCheckReady: true }],
        ["team", advertiserTables, { role: "team", ...advertiserScope }, { optionCheckedAt: "2026-10-30T01:02:03.000Z", optionCheckReady: true }],
        ["client", advertiserTables, { role: "client", ...advertiserScope }, { optionCheckedAt: null, optionCheckReady: false }],
        ["no-session access code", advertiserTables, { role: null, ...advertiserScope }, { optionCheckedAt: null, optionCheckReady: false }],
      ]) {
        const { ctx } = fakeDatabase(structuredClone(tables), { clients });
        // eslint-disable-next-line no-await-in-loop
        const response = await handleRankTrackersRequest(request("GET", null, options), ctx);
        // eslint-disable-next-line no-await-in-loop
        const body = await response.json();
        assert.equal(response.status, 200, label);
        const self = body.trackers.find((entry) => entry.id === SELF_ID);
        assert.deepEqual({ optionCheckedAt: self.optionCheckedAt, optionCheckReady: self.optionCheckReady }, expected, label);
        const keys = Object.keys(self);
        assert.deepEqual(keys.slice(keys.indexOf("groupProduct") + 1, keys.indexOf("groupProduct") + 3), ["optionCheckedAt", "optionCheckReady"], label);
        if (expected.optionCheckedAt === null) {
          assert.equal(JSON.stringify(body).includes("2026-10-30T01:02:03"), false, `${label}: 확인일 값이 응답 어디에도 없다`);
        }
      }
    });
  });
});

test("B6 저장 중간에 확인일 칸이 사라져도 이미 확인일을 쓴 추적은 기록됨으로 본다(checkedTrackerIds·응답 optionCheckedAt)", async () => {
  await withEnv(async () => {
    const tables = groupTables();
    // 저장값이 달라 묶음 두 개(이 추적 → 같은 대표 번호 추적)로 나뉜다. 두 번째 묶음에서만 확인일 칸 없음(스키마 캐시가 바뀜).
    let calls = 0;
    const { ctx, state } = fakeDatabase(tables, {
      updateError: (ops) => {
        calls += 1;
        return calls === 2 && Object.hasOwn(ops.update, "option_checked_at")
          ? { code: "PGRST204", message: "Could not find the 'option_checked_at' column of 'naver_rank_trackers' in the schema cache" }
          : null;
      },
    });
    const outcome = await quietWarnings(() => post(ctx, {
      mode: "save",
      optionInput: OPTION_16PRO,
      applyToSameProduct: true,
      expectedOptionProductIds: expectedFor(tables, [SELF_ID, uuid(1)]),
      fullReview: true,
    }));
    assert.equal(outcome.response.status, 200);
    assert.deepEqual(outcome.body.updatedTrackerIds, [SELF_ID, uuid(1)]);
    assert.equal(outcome.body.checkedAtRecorded, true, "첫 묶음은 확인일까지 썼다");
    assert.equal(outcome.body.optionCheckedAt, rowById(tables, SELF_ID).option_checked_at);
    assert.match(outcome.body.optionCheckedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(Object.hasOwn(rowById(tables, uuid(1)), "option_checked_at"), false);
    assert.deepEqual(state.updates.map((update) => [update.ids, Object.keys(update.values)]), [
      [[SELF_ID], ["option_product_ids", "option_checked_at"]],
      [[uuid(1)], ["option_product_ids"]],
    ]);
    const [result] = auditRows(tables, "naver_rank_options_save_result");
    assert.deepEqual(result.metadata, {
      updatedTrackerIds: [SELF_ID, uuid(1)],
      checkedTrackerIds: [SELF_ID],
      targetCount: 2,
      checkedAtRecorded: true,
      fullReview: true,
      outcome: "saved",
    });
  });
});

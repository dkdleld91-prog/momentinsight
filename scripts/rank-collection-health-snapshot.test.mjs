import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import {
  RANK_NEVER_FOUND_MIN_CHECKS,
  RANK_OVERDUE_THRESHOLD_MS,
  RANK_PLACE_PARTIAL_MIN_RETRIES,
  RANK_STUCK_TRACKER_MS,
} from "../src/server/naver-rank-requeue.mjs";
import {
  RANK_KEYWORD_GROUP_MAX_PAGES,
  RANK_KEYWORD_GROUP_PAGE_SIZE,
  RANK_KEYWORD_GROUP_ROW_LIMIT,
  observeSnapshotKeywordGroups,
  rankKeywordGroupSnapshotArgs,
} from "../src/server/rank-capacity.mjs";
import {
  EXPECTED_WORKER_RUNTIME_VERSION,
  WORKER_COMMIT_STALL_MINUTES,
} from "../src/server/naver-shopping/worker-runtime-expectation.mjs";

// B안(대표 승인 2026-10-16): /api/rank-collection-health 가 캐시 미스 1회에 Supabase 를
// 12번 읽던 것을 읽기 전용 RPC public.mi_rank_collection_health_snapshot 1번으로 바꿨다(로그 저장량 167%).
// 이 파일이 고정하는 것:
//  (a) 핸들러 — RPC 경로는 캐시 미스 1회에 요청이 정확히 1건이고, RPC 없음·오류·모양 틀림이면 예전 개별
//      조회 12건으로 돌아간다. 여러 상태에서 두 경로의 응답(상태·헤더·본문 바이트)이 같다.
//      두 경로 모두 같은 PGlite DB 를 본다: RPC 는 실제 마이그레이션 함수로, 개별 조회는 핸들러가 보낸
//      PostgREST 질의를 그대로 SQL 로 옮겨(아래 restResponse) 답한다.
//  (b) SQL — 실제 마이그레이션의 표 정의로 만든 표에서 함수 결과가 12개 조회의 의미(JS 로 다시 센 값)와
//      같다. 경계값(경계와 같은 시각, null, active 가 아닌 행)을 넣는다.
//  (c) 원문 — sha256 고정, docs/sql 대표용 사본과 바이트 같음, begin … commit 한 묶음, 읽기 전용.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const MIGRATION_NAME = "20261017100000_rank_collection_health_snapshot.sql";
const DOCS_COPY = path.join(root, "docs", "sql", "log-b-rank-health-snapshot.sql");
const migration = fs.readFileSync(path.join(migrationDirectory, MIGRATION_NAME), "utf8");
const handlerSource = fs.readFileSync(path.join(root, "src", "server", "handlers", "rank-collection-health.mjs"), "utf8");
// 원문을 바꾸면 이 값과 docs/sql 사본을 함께 고친다.
const MIGRATION_SHA256 = "0034ff564b5875fcea13a89c3fe72876cc8cc1e91ed72ccaf8bf7563b88b0997";

const RPC = "mi_rank_collection_health_snapshot";
const RPC_SIGNATURE = `public.${RPC}(timestamptz,timestamptz,integer,integer,integer)`;
const SNAPSHOT_ARG_NAMES = [
  "p_overdue_cutoff",
  "p_stuck_cutoff",
  "p_never_found_min_checks",
  "p_place_partial_min_retries",
  "p_keyword_row_limit",
];
const REST_TABLES = new Set([
  "naver_rank_trackers",
  "naver_place_rank_trackers",
  "naver_shopping_worker_coordination",
  "naver_shopping_worker_runs",
  "naver_shopping_worker_nonces",
]);
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
// 2026-10-17 12:00 KST. 핸들러의 Date.now() 는 아래 mock 으로 이 값에 고정한다.
const NOW = Date.parse("2026-10-17T03:00:00.000Z");
const iso = (offsetMs, base = NOW) => new Date(base + offsetMs).toISOString();
const FINGERPRINT = "ab".repeat(32);

// ───────────────────────── 표: 실제 마이그레이션 원문에서 가져온다 ─────────────────────────

const readMigration = (name) => fs.readFileSync(path.join(migrationDirectory, name), "utf8");
function statementFrom(name, startMarker, endMarker) {
  const source = readMigration(name);
  const from = source.indexOf(startMarker);
  assert.ok(from >= 0, `${name} 에 ${startMarker} 가 없다`);
  const to = source.indexOf(endMarker, from);
  assert.ok(to > from, `${name} 에서 ${startMarker} 의 끝을 찾지 못했다`);
  return source.slice(from, to + endMarker.length);
}
// 외래 키 대상(clients·brands·auth.users)은 이 시험과 무관하므로 references 절만 걷어 낸다.
const withoutReferences = (sql) => sql.replace(
  /\s+references\s+(?:public|auth)\.[a-z_]+\([a-z_]+\)(?:\s+on delete (?:cascade|set null))?/gu,
  "",
);
const TABLE_DDL = [
  statementFrom("20260624003000_naver_rank_tracking.sql", "do $$ begin", "end $$;"),
  withoutReferences(statementFrom(
    "20260624003000_naver_rank_tracking.sql",
    "create table if not exists public.naver_rank_trackers (",
    "\n);",
  )),
  statementFrom("20260629025402_naver_rank_tracker_processing_lease.sql", "alter table public.naver_rank_trackers", ";"),
  withoutReferences(statementFrom(
    "20260707000100_naver_place_rank_tracking.sql",
    "create table if not exists public.naver_place_rank_trackers (",
    "\n);",
  )),
  statementFrom("20260711173414_naver_place_rank_processing_lease.sql", "alter table public.naver_place_rank_trackers", ";"),
  statementFrom(
    "20260809203826_naver_shopping_global_worker_lane.sql",
    "create table if not exists public.naver_shopping_worker_coordination (",
    "\n);",
  ),
  statementFrom(
    "20260811095137_naver_shopping_worker_control_plane.sql",
    "alter table public.naver_shopping_worker_coordination",
    ";",
  ),
  statementFrom(
    "20260824165332_naver_shopping_runtime_1_1_13_candidate_6_minute_cadence.sql",
    "create table if not exists public.naver_shopping_worker_runs (",
    "\n);",
  ),
  statementFrom(
    "20260801125959_naver_shopping_local_worker.sql",
    "create table if not exists public.naver_shopping_worker_nonces (",
    "\n);",
  ),
];

async function fixture() {
  const db = new PGlite();
  // Supabase 의 세션 시간대는 UTC 다(PostgREST 응답의 +00:00).
  await db.exec("set time zone 'UTC'; create role anon; create role authenticated; create role service_role;");
  for (const ddl of TABLE_DDL) await db.exec(ddl);
  await db.exec(migration);
  return db;
}

async function resetTables(db) {
  await db.exec(`truncate public.naver_rank_trackers, public.naver_place_rank_trackers,
    public.naver_shopping_worker_coordination, public.naver_shopping_worker_runs, public.naver_shopping_worker_nonces`);
}

const PRODUCT_COLUMNS = [
  "keyword", "status", "last_checked_at", "next_check_at", "check_count", "found_count", "last_error", "created_at", "retry_count",
];
async function insertProducts(db, rows) {
  for (const [index, row] of rows.entries()) {
    const values = {
      keyword: `상품 ${index}`,
      status: "active",
      last_checked_at: null,
      next_check_at: iso(HOUR),
      check_count: 0,
      found_count: 0,
      last_error: null,
      created_at: iso(-7 * 24 * HOUR),
      retry_count: 0,
      ...row,
    };
    await db.query(
      `insert into public.naver_rank_trackers (product_id, ${PRODUCT_COLUMNS.join(", ")})
       values ($1, ${PRODUCT_COLUMNS.map((_, column) => `$${column + 2}`).join(", ")})`,
      [`p${index}`, ...PRODUCT_COLUMNS.map((column) => values[column])],
    );
  }
}

const PLACE_COLUMNS = ["keyword", "status", "last_checked_at", "next_check_at", "last_error", "retry_count", "created_at"];
async function insertPlaces(db, rows) {
  for (const [index, row] of rows.entries()) {
    const values = {
      keyword: `플레이스 ${index}`,
      status: "active",
      last_checked_at: null,
      next_check_at: iso(HOUR),
      last_error: null,
      retry_count: 0,
      created_at: iso(-7 * 24 * HOUR),
      ...row,
    };
    await db.query(
      `insert into public.naver_place_rank_trackers (place_id, ${PLACE_COLUMNS.join(", ")})
       values ($1, ${PLACE_COLUMNS.map((_, column) => `$${column + 2}`).join(", ")})`,
      [`pl${index}`, ...PLACE_COLUMNS.map((column) => values[column])],
    );
  }
}

async function insertCoordination(db, row) {
  const values = {
    circuit_state: "closed",
    circuit_reason: null,
    cooldown_until: null,
    primary_seen_at: null,
    last_success_at: null,
    ...row,
  };
  await db.query(
    `insert into public.naver_shopping_worker_coordination
       (lane_key, circuit_state, circuit_reason, cooldown_until, primary_seen_at, last_success_at)
     values ('global', $1, $2, $3, $4, $5)`,
    [values.circuit_state, values.circuit_reason, values.cooldown_until, values.primary_seen_at, values.last_success_at],
  );
}

async function insertRuns(db, rows) {
  for (const row of rows) {
    await db.query(
      `insert into public.naver_shopping_worker_runs (run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint, started_at)
       values (gen_random_uuid(), 'windows-desktop-primary', 'rank-catch-up', $1, $2, $3)`,
      [row.runtime_version, FINGERPRINT, row.started_at],
    );
  }
}

async function insertNonces(db, createdAts) {
  for (const [index, createdAt] of createdAts.entries()) {
    await db.query(
      "insert into public.naver_shopping_worker_nonces (nonce, request_timestamp, created_at) values ($1, $2, $2)",
      [`nonce-${String(index).padStart(12, "0")}`, createdAt],
    );
  }
}

// ───────────────────────── 가짜 Supabase(같은 PGlite 를 보는 PostgREST 흉내) ─────────────────────────

const JSON_HEADERS = { "content-type": "application/json" };
const IDENTIFIER = /^[a-z_]+$/u;
function ident(name) {
  assert.match(name, IDENTIFIER, `예상하지 못한 식별자: ${name}`);
  return `"${name}"`;
}

// 핸들러가 실제로 쓰는 연산자만 옮긴다. 다른 연산자가 나오면 시험이 먼저 깨진다.
function filterSql(column, expression, params) {
  if (expression === "is.null") return `${ident(column)} is null`;
  if (expression === "not.is.null") return `${ident(column)} is not null`;
  const dot = expression.indexOf(".");
  const operator = { eq: "=", lt: "<", gte: ">=" }[expression.slice(0, dot)];
  assert.ok(operator, `예상하지 못한 필터: ${column}=${expression}`);
  params.push(expression.slice(dot + 1));
  return `${ident(column)} ${operator} $${params.length}`;
}

// or=(a.lt.x,and(b.is.null,c.lt.x)) 꼴. 맨 바깥 괄호 안의 최상위 쉼표로 나눈다.
function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}
function logicalSql(list, joiner, params) {
  assert.ok(list.startsWith("(") && list.endsWith(")"), list);
  return `(${splitTopLevel(list.slice(1, -1)).map((term) => {
    if (term.startsWith("and(")) return logicalSql(term.slice(3), " and ", params);
    const dot = term.indexOf(".");
    return filterSql(term.slice(0, dot), term.slice(dot + 1), params);
  }).join(joiner)})`;
}

async function restResponse(db, url, method, headers) {
  const table = url.pathname.replace("/rest/v1/", "");
  assert.ok(REST_TABLES.has(table), `예상하지 못한 표: ${table}`);
  const params = [];
  const where = [];
  let select = "*";
  let order = "";
  let limit = "";
  let offset = "";
  for (const [key, value] of url.searchParams) {
    if (key === "select") select = value.split(",").map(ident).join(", ");
    else if (key === "order") {
      const [column, direction] = value.split(".");
      assert.ok(direction === "asc" || direction === "desc", value);
      order = ` order by ${ident(column)} ${direction}`;
    } else if (key === "limit") limit = ` limit ${Number.parseInt(value, 10)}`;
    else if (key === "offset") offset = ` offset ${Number.parseInt(value, 10)}`;
    else if (key === "or") where.push(logicalSql(value, " or ", params));
    else where.push(filterSql(key, value, params));
  }
  const whereSql = where.length ? ` where ${where.join(" and ")}` : "";
  if (method === "HEAD") {
    assert.match(headers.get("prefer") || "", /count=exact/u);
    const { rows } = await db.query(`select count(*)::int as total from public.${ident(table)}${whereSql}`, params);
    return new Response(null, { status: 200, headers: { "content-range": `*/${rows[0].total}` } });
  }
  assert.equal(method, "GET");
  const { rows } = await db.query(
    `select coalesce(json_agg(t), '[]'::json)::text as body
     from (select ${select} from public.${ident(table)}${whereSql}${order}${limit}${offset}) as t`,
    params,
  );
  return new Response(rows[0].body, { status: 200, headers: JSON_HEADERS });
}

async function realSnapshotText(db, args) {
  assert.deepEqual(Object.keys(args).sort(), [...SNAPSHOT_ARG_NAMES].sort(), "RPC 인자는 정확히 5개다");
  const { rows } = await db.query(
    `select public.${RPC}($1, $2, $3, $4, $5)::text as body`,
    SNAPSHOT_ARG_NAMES.map((name) => args[name]),
  );
  return rows[0].body;
}

// mode: "rpc"(실제 함수) · "missing"(대표 SQL 전 PostgREST 404 PGRST202) · "error"(500) · "throw"(네트워크)
//       · "denied"(403 42501, 실행 권한 빠짐) · "slow"(끊길 때까지 답하지 않음)
//       · 함수(실제 스냅샷 객체를 받아 바꾼 응답을 돌려준다).
async function rpcResponse(db, mode, rawBody) {
  if (mode === "missing") {
    return new Response(JSON.stringify({
      code: "PGRST202",
      details: `Searched for the function public.${RPC} with parameters ${SNAPSHOT_ARG_NAMES.join(", ")} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`,
      hint: null,
      message: `Could not find the function public.${RPC}(${SNAPSHOT_ARG_NAMES.join(", ")}) in the schema cache`,
    }), { status: 404, headers: JSON_HEADERS });
  }
  if (mode === "denied") {
    return new Response(JSON.stringify({
      code: "42501",
      details: null,
      hint: null,
      message: `permission denied for function ${RPC}`,
    }), { status: 403, headers: JSON_HEADERS });
  }
  if (mode === "error") {
    return new Response(JSON.stringify({
      code: "57014",
      details: null,
      hint: null,
      message: "canceling statement due to statement timeout",
    }), { status: 500, headers: JSON_HEADERS });
  }
  const text = await realSnapshotText(db, JSON.parse(String(rawBody)));
  if (typeof mode === "function") return mode(JSON.parse(text));
  assert.equal(mode, "rpc");
  return new Response(text, { status: 200, headers: JSON_HEADERS });
}

// 가짜 안에서 난 assert 실패는 postgrest-js 가 오류 응답으로 삼켜 버린다(GET 은 1·2·4초 재시도까지 한다).
// 그래서 실패를 따로 모아 restore() 에서 다시 던지고, 핸들러 쪽에는 재시도 없는 AbortError 로 넘긴다.
function installSupabase(db, mode, { restOverride } = {}) {
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  const calls = [];
  const failures = [];
  // 핸들러의 대체 기록 줄(console.warn)을 모은다. 테스트 출력도 조용해진다.
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input?.url || input || ""));
    const method = String(init.method || "GET").toUpperCase();
    calls.push({ method, path: url.pathname, url, body: init.body, signal: init.signal });
    // 의도한 네트워크 실패. POST 라 postgrest-js 가 재시도하지 않는다.
    if (url.pathname === `/rest/v1/rpc/${RPC}` && mode === "throw") throw new TypeError("fetch failed");
    // 느린 RPC: 핸들러의 시간 상한 신호가 끊을 때까지 답하지 않는다(실제 fetch 처럼 신호의 이유로 거절).
    if (url.pathname === `/rest/v1/rpc/${RPC}` && mode === "slow") {
      const signal = init.signal;
      if (!signal) throw new Error("RPC 에 시간 상한 신호가 없다");
      return await new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    try {
      if (url.pathname === `/rest/v1/rpc/${RPC}`) {
        assert.equal(method, "POST", "RPC 는 POST 다(네트워크 throw 재시도 없음)");
        return await rpcResponse(db, mode, init.body);
      }
      assert.ok(!url.pathname.startsWith("/rest/v1/rpc/"), `예상하지 못한 RPC: ${url.pathname}`);
      if (restOverride) {
        const overridden = await restOverride(url, method);
        if (overridden) return overridden;
      }
      return await restResponse(db, url, method, new Headers(init.headers));
    } catch (error) {
      failures.push(error);
      const abort = new Error(`stub failure: ${error?.message}`);
      abort.name = "AbortError";
      throw abort;
    }
  };
  return {
    calls,
    restCalls: () => calls.filter((call) => !call.path.startsWith("/rest/v1/rpc/")),
    rpcCalls: () => calls.filter((call) => call.path === `/rest/v1/rpc/${RPC}`),
    warnings,
    restore() {
      globalThis.fetch = previousFetch;
      console.warn = previousWarn;
      if (failures.length) throw failures[0];
    },
  };
}

const ENV_NAMES = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY"];
const previousEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
let db;
before(async () => {
  Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:3",
    SUPABASE_SECRET_KEY: "sb_secret_rank_health_snapshot_test",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_rank_health_snapshot_test",
  });
  db = await fixture();
});
after(async () => {
  for (const name of ENV_NAMES) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
  await db?.close();
});

// 모듈 최상단 cached·snapshotMissingUntil 은 인스턴스마다 따로 갖게 쿼리스트링으로 새로 받는다
// (rank-collection-stability.test.mjs 의 freshRankHealthHandler 와 같은 방법).
let handlerSequence = 0;
async function freshHandler() {
  handlerSequence += 1;
  const module = await import(`../src/server/handlers/rank-collection-health.mjs?snapshot=${handlerSequence}`);
  return module.default;
}

async function read(response) {
  return {
    status: response.status,
    headers: [...response.headers].sort(([left], [right]) => left.localeCompare(right)),
    text: await response.text(),
  };
}
const get = (handler) => handler.fetch(new Request("https://example.com/api/rank-collection-health")).then(read);

// 같은 DB·같은 시각에서 한 경로로 한 번 받는다. 경로마다 새 핸들러(빈 캐시)다.
async function onePath(mode, options) {
  const stub = installSupabase(db, mode, options);
  try {
    const handler = await freshHandler();
    const response = await get(handler);
    return { response, stub };
  } finally {
    stub.restore();
  }
}

async function assertPathsAgree(t, label) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const viaRpc = await onePath("rpc");
  assert.equal(viaRpc.stub.calls.length, 1, `${label}: RPC 경로는 캐시 미스 1회에 Supabase 요청이 정확히 1건이다`);
  assert.equal(viaRpc.stub.rpcCalls().length, 1);
  const args = JSON.parse(String(viaRpc.stub.calls[0].body));
  assert.deepEqual(args, {
    p_overdue_cutoff: new Date(NOW - RANK_OVERDUE_THRESHOLD_MS).toISOString(),
    p_stuck_cutoff: new Date(NOW - RANK_STUCK_TRACKER_MS).toISOString(),
    p_never_found_min_checks: RANK_NEVER_FOUND_MIN_CHECKS,
    p_place_partial_min_retries: RANK_PLACE_PARTIAL_MIN_RETRIES,
    p_keyword_row_limit: RANK_KEYWORD_GROUP_MAX_PAGES * RANK_KEYWORD_GROUP_PAGE_SIZE,
  });
  for (const mode of ["missing", "error", "throw"]) {
    const fallback = await onePath(mode);
    assert.equal(fallback.stub.rpcCalls().length, 1, `${label}/${mode}: RPC 를 먼저 한 번 시도한다`);
    assert.ok(fallback.stub.restCalls().length >= 12, `${label}/${mode}: 개별 조회 12건 이상으로 돌아간다`);
    assert.deepEqual(fallback.response, viaRpc.response, `${label}/${mode}: 두 경로의 응답이 바이트 단위로 같다`);
  }
  return { status: viaRpc.response.status, body: JSON.parse(viaRpc.response.text) };
}

// ───────────────────────── 상태별 자료 ─────────────────────────

async function seedHealthy() {
  await resetTables(db);
  await insertProducts(db, [
    { keyword: "아이폰 케이스", last_checked_at: iso(-5 * MINUTE), check_count: 10, found_count: 8 },
    { keyword: "아이폰케이스", last_checked_at: iso(-20 * MINUTE), next_check_at: iso(30 * MINUTE) },
    // 3회 확인했는데 한 번도 못 찾음 → neverFound.
    { keyword: "갤럭시 케이스", last_checked_at: iso(-30 * MINUTE), check_count: RANK_NEVER_FOUND_MIN_CHECKS },
    // 공백뿐인 검색어는 묶음이 아니다.
    { keyword: "   ", last_checked_at: iso(-40 * MINUTE) },
    // active 가 아니어도 레인 최신 확인 시각에는 들어간다(개별 조회에 status 조건이 없다).
    { keyword: "iPhone Case", status: "paused", last_checked_at: iso(-1 * MINUTE) },
  ]);
  await insertPlaces(db, [
    { last_checked_at: iso(-10 * MINUTE), retry_count: RANK_PLACE_PARTIAL_MIN_RETRIES },
    { last_checked_at: iso(-12 * MINUTE), retry_count: RANK_PLACE_PARTIAL_MIN_RETRIES - 1 },
  ]);
  await insertCoordination(db, { primary_seen_at: iso(-1 * MINUTE), last_success_at: iso(-5 * MINUTE) });
  await insertRuns(db, [
    { runtime_version: "1.1.33", started_at: iso(-24 * HOUR) },
    { runtime_version: EXPECTED_WORKER_RUNTIME_VERSION, started_at: iso(-10 * MINUTE) },
  ]);
  await insertNonces(db, [iso(-2 * MINUTE), iso(-30_000)]);
}

test("(a) 정상: RPC 1건으로 ok:true 이고 개별 조회와 바이트가 같다", async (t) => {
  await seedHealthy();
  const { status, body } = await assertPathsAgree(t, "정상");
  assert.equal(status, 200);
  assert.equal(body.ok, true, "시험이 실패끼리 비교하는 헛비교가 아니다");
  assert.equal(body.lastSuccessAt, iso(-10 * MINUTE), "가장 나쁜 레인(플레이스 10분 전)");
  assert.equal(body.lanes.product.lastSuccessAt, iso(-1 * MINUTE), "paused 행도 상품 레인 최신 시각이다");
  assert.equal(body.lanes.product.lastCommitAgeMinutes, 1);
  assert.equal(body.heartbeatAgeMinutes, 1);
  assert.deepEqual(body.trackers, {
    neverFound: 1,
    stuck: 0,
    placePartial: 1,
    activeProduct: 4,
    activeProductKeywordGroups: 2,
  });
});

test("(a) 정체: 상품 수집기가 10시간 죽음 — 두 경로 모두 queueStalled·commitStalled", async (t) => {
  await resetTables(db);
  await insertProducts(db, [
    { keyword: "정체 1", last_checked_at: iso(-10 * HOUR), next_check_at: iso(-7 * HOUR) },
    { keyword: "정체 2", last_checked_at: iso(-40 * HOUR), last_error: "naver_page_navigation_failed" },
  ]);
  await insertPlaces(db, [{ last_checked_at: iso(-30 * MINUTE) }]);
  await insertCoordination(db, {
    circuit_state: "open",
    circuit_reason: "probe_incomplete",
    primary_seen_at: iso(-10 * HOUR),
    last_success_at: iso(-10 * HOUR),
  });
  await insertRuns(db, [{ runtime_version: EXPECTED_WORKER_RUNTIME_VERSION, started_at: iso(-10 * HOUR) }]);
  await insertNonces(db, [iso(-2 * HOUR)]);
  const { body } = await assertPathsAgree(t, "정체");
  assert.equal(body.ok, false);
  assert.equal(body.queueStalled, true);
  assert.equal(body.lanes.product.queueStalled, true);
  assert.equal(body.lanes.product.commitStalled, true);
  assert.equal(body.stalledMinutes, 600);
  assert.equal(body.trackers.stuck, 1);
});

test("(a) 지연만 있고 수집은 도는 중 — 정상(적체는 정체가 아니다)", async (t) => {
  await resetTables(db);
  await insertProducts(db, [
    { keyword: "적체", last_checked_at: iso(-10 * MINUTE), next_check_at: iso(-8 * HOUR) },
  ]);
  await insertPlaces(db, [{ last_checked_at: iso(-5 * MINUTE), next_check_at: iso(-7 * HOUR) }]);
  await insertCoordination(db, { primary_seen_at: iso(-30_000), last_success_at: iso(-10 * MINUTE) });
  await insertRuns(db, [{ runtime_version: EXPECTED_WORKER_RUNTIME_VERSION, started_at: iso(-12 * MINUTE) }]);
  await insertNonces(db, [iso(-20_000)]);
  const { body } = await assertPathsAgree(t, "지연");
  assert.equal(body.ok, true);
  assert.equal(body.queueStalled, false);
});

test("(a) 낡은 실행본: 매분 서명 + 옛 버전 — workerOutdated", async (t) => {
  await resetTables(db);
  await insertProducts(db, [{ keyword: "낡음", last_checked_at: iso(-30 * MINUTE) }]);
  await insertCoordination(db, { primary_seen_at: iso(-14.4 * HOUR), last_success_at: iso(-30 * MINUTE) });
  await insertRuns(db, [{ runtime_version: "1.1.19", started_at: iso(-15 * HOUR) }]);
  await insertNonces(db, [iso(-54_000)]);
  const { body } = await assertPathsAgree(t, "낡은 실행본");
  assert.equal(body.workerOutdated, true);
  assert.equal(body.ok, false);
  assert.equal(body.heartbeatAgeMinutes, 30);
  assert.ok(!JSON.stringify(body).includes("1.1.19"), "버전 문자열은 공개 표면에 없다");
});

for (const [label, coordination] of [
  ["쿨다운", { cooldown_until: iso(20 * MINUTE), circuit_state: "open", circuit_reason: "auto_navigation_probe" }],
  ["긴급 안전 정지", { circuit_state: "open", circuit_reason: "manual_stop" }],
  ["수동 복구 필요", { circuit_state: "open", circuit_reason: "transient_recovery_manual_required" }],
]) {
  test(`(a) 의도적 정지(${label}) — 복구 신호는 누르고 ok:false, 두 경로 같음`, async (t) => {
    await resetTables(db);
    await insertProducts(db, [{ keyword: "정지", last_checked_at: iso(-9 * HOUR), next_check_at: iso(-8 * HOUR) }]);
    await insertCoordination(db, { ...coordination, primary_seen_at: iso(-9 * HOUR), last_success_at: iso(-9 * HOUR) });
    await insertRuns(db, [{ runtime_version: "1.1.19", started_at: iso(-9 * HOUR) }]);
    await insertNonces(db, [iso(-30_000)]);
    const { body } = await assertPathsAgree(t, label);
    assert.equal(body.ok, false);
    assert.equal(body.queueStalled, false);
    assert.equal(body.workerOutdated, false);
    assert.equal(body.lanes.product.commitStalled, false);
  });
}

async function seedManyActive(count) {
  await resetTables(db);
  await db.query(
    `insert into public.naver_rank_trackers (keyword, product_id, status, last_checked_at, next_check_at)
     select '키워드 ' || (g % 700), 'p' || g, 'active', $1, $2 from generate_series(1, $3::int) as g`,
    [iso(-5 * MINUTE), iso(HOUR), count],
  );
  // active 가 아닌 행은 상한 계산에 들어가지 않는다.
  await insertProducts(db, [{ keyword: "멈춘 묶음", status: "completed", last_checked_at: iso(-HOUR) }]);
  await insertCoordination(db, { primary_seen_at: iso(-MINUTE), last_success_at: iso(-5 * MINUTE) });
  await insertRuns(db, [{ runtime_version: EXPECTED_WORKER_RUNTIME_VERSION, started_at: iso(-6 * MINUTE) }]);
  await insertNonces(db, [iso(-10_000)]);
}

test("(a) 키워드 상한 도달(활성 10,000행): 두 경로 모두 하한값 + ok:false", async (t) => {
  assert.equal(RANK_KEYWORD_GROUP_ROW_LIMIT, 10_000);
  await seedManyActive(RANK_KEYWORD_GROUP_ROW_LIMIT);
  const { body } = await assertPathsAgree(t, "상한 도달");
  assert.equal(body.trackers.activeProduct, 10_000);
  assert.equal(body.trackers.activeProductKeywordGroups, 700);
  assert.equal(body.ok, false, "끝까지 세지 못한 관측을 정상으로 단정하지 않는다");
});

test("(a) 키워드 상한 바로 아래(활성 9,999행): 두 경로 모두 완전 관측 ok:true", async (t) => {
  await seedManyActive(RANK_KEYWORD_GROUP_ROW_LIMIT - 1);
  const { body } = await assertPathsAgree(t, "상한 아래");
  assert.equal(body.trackers.activeProduct, 9_999);
  assert.equal(body.trackers.activeProductKeywordGroups, 700);
  assert.equal(body.ok, true);
});

test("(a) 빈 표(코디네이션 행도 없음): 제어면 소실 → 두 경로 모두 200/ok:false", async (t) => {
  await resetTables(db);
  const { status, body } = await assertPathsAgree(t, "빈 표");
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.lastSuccessAt, null);
  assert.equal(body.lanes.product.lastCommitAgeMinutes, null);
  assert.deepEqual(body.trackers, { neverFound: 0, stuck: 0, placePartial: 0, activeProduct: 0, activeProductKeywordGroups: 0 });
});

test("(a) 빈 추적기 + 코디네이션 행: 정상 유휴 → 두 경로 모두 ok:true", async (t) => {
  await resetTables(db);
  await insertCoordination(db, { primary_seen_at: iso(-MINUTE), last_success_at: null });
  const { body } = await assertPathsAgree(t, "정상 유휴");
  assert.equal(body.ok, true);
  assert.equal(body.heartbeatAgeMinutes, 1);
});

test("(a) 경계값(경계와 같은 시각·null 앵커·active 아님)에서도 두 경로가 같다", async (t) => {
  await resetTables(db);
  const overdueCutoff = NOW - RANK_OVERDUE_THRESHOLD_MS;
  const stuckCutoff = NOW - RANK_STUCK_TRACKER_MS;
  const at = (ms) => new Date(ms).toISOString();
  await insertProducts(db, [
    // 예정 시각이 경계와 같다 → 지연 아님(lt).
    { keyword: "경계 a", last_checked_at: at(overdueCutoff - MINUTE), next_check_at: at(overdueCutoff) },
    // 앵커가 경계와 같다 → stuck 아님. 1ms 앞서면 stuck.
    { keyword: "경계 b", last_error: "x", last_checked_at: at(stuckCutoff) },
    { keyword: "경계 c", last_error: "x", last_checked_at: at(stuckCutoff - 1) },
    { keyword: "경계 d", last_error: "x", last_checked_at: null, created_at: at(stuckCutoff) },
    { keyword: "경계 e", last_error: "x", last_checked_at: null, created_at: at(stuckCutoff - 1) },
    // 성공 이력이 있으면 created_at 이 아무리 오래돼도 앵커가 아니다.
    { keyword: "경계 f", last_error: "x", last_checked_at: at(NOW - HOUR), created_at: at(NOW - 100 * HOUR) },
    // active 가 아니면 어떤 집계에도 들지 않는다.
    { keyword: "경계 g", status: "paused", last_error: "x", last_checked_at: at(stuckCutoff - HOUR), next_check_at: at(overdueCutoff - HOUR) },
    { keyword: "경계 h", status: "failed", check_count: 9 },
    // neverFound 경계: 2회는 아님, 3회는 맞음, 찾은 적이 있으면 아님.
    { keyword: "경계 i", check_count: RANK_NEVER_FOUND_MIN_CHECKS - 1 },
    { keyword: "경계 j", check_count: RANK_NEVER_FOUND_MIN_CHECKS },
    { keyword: "경계 k", check_count: RANK_NEVER_FOUND_MIN_CHECKS + 2, found_count: 1 },
  ]);
  await insertPlaces(db, [
    { last_checked_at: at(NOW - 2 * MINUTE), next_check_at: at(overdueCutoff - 1) },
    { retry_count: RANK_PLACE_PARTIAL_MIN_RETRIES - 1 },
    { retry_count: RANK_PLACE_PARTIAL_MIN_RETRIES },
    { retry_count: RANK_PLACE_PARTIAL_MIN_RETRIES + 5, last_error: "x" },
    { retry_count: RANK_PLACE_PARTIAL_MIN_RETRIES + 5, status: "paused" },
  ]);
  await insertCoordination(db, { primary_seen_at: at(NOW - MINUTE), last_success_at: at(NOW - 2 * MINUTE) });
  const { body } = await assertPathsAgree(t, "경계");
  assert.deepEqual(body.trackers, {
    neverFound: 1,
    stuck: 2,
    placePartial: 1,
    activeProduct: 9,
    activeProductKeywordGroups: 9,
  });
  assert.equal(body.queueStalled, false, "플레이스 지연은 있지만 2분 전에 수집했다");
});

// ───────────────────────── (a) 캐시·되돌아감·거짓 정상 ─────────────────────────

test("(a) RPC 경로도 60초 캐시를 그대로 쓴다 — 캐시 히트 0건, 만료 뒤 다시 1건", async (t) => {
  await seedHealthy();
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const stub = installSupabase(db, "rpc");
  try {
    const handler = await freshHandler();
    const first = await get(handler);
    assert.equal(stub.calls.length, 1);
    t.mock.timers.setTime(NOW + 59_999);
    assert.deepEqual(await get(handler), first, "캐시 히트는 같은 응답이다");
    assert.equal(stub.calls.length, 1, "캐시 히트는 Supabase 를 치지 않는다");
    t.mock.timers.setTime(NOW + 60_000);
    await get(handler);
    assert.equal(stub.calls.length, 2, "만료 뒤 캐시 미스 1회 = RPC 1건");
    assert.equal(stub.restCalls().length, 0);
  } finally {
    stub.restore();
  }
});

test("(a) 45분 커밋 정체 경계에서 캐시가 끊기는 시각이 두 경로에서 같다", async (t) => {
  // 경계(커밋 + 45분)가 60초 캐시 만료보다 먼저 오게 한다 — 캐시가 경계에서 끊기는지를 본다.
  const lastCommit = NOW - 44 * MINUTE - 30_000;
  const boundary = lastCommit + WORKER_COMMIT_STALL_MINUTES * MINUTE;
  await resetTables(db);
  await insertProducts(db, [{ keyword: "경계 커밋", last_checked_at: iso(-50 * MINUTE) }]);
  await insertCoordination(db, { primary_seen_at: iso(-MINUTE), last_success_at: new Date(lastCommit).toISOString() });
  await insertRuns(db, [{ runtime_version: EXPECTED_WORKER_RUNTIME_VERSION, started_at: iso(-45 * MINUTE) }]);
  await insertNonces(db, [iso(-20_000)]);
  const timeline = async (mode) => {
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    const stub = installSupabase(db, mode);
    try {
      const handler = await freshHandler();
      const steps = [];
      for (const at of [NOW, boundary - 1, boundary]) {
        t.mock.timers.setTime(at);
        const before = stub.calls.length;
        const response = await get(handler);
        steps.push({ at, response, requests: stub.calls.length - before });
      }
      return steps;
    } finally {
      stub.restore();
      t.mock.timers.reset();
    }
  };
  const viaRpc = await timeline("rpc");
  const viaFallback = await timeline("missing");
  assert.deepEqual(viaRpc.map((step) => step.requests), [1, 0, 1], "경계 1ms 전은 캐시, 경계에서 RPC 1건");
  assert.deepEqual(viaFallback.map((step) => step.requests > 0), [true, false, true]);
  assert.deepEqual(viaRpc.map((step) => step.response), viaFallback.map((step) => step.response));
  assert.equal(JSON.parse(viaRpc[0].response.text).ok, true);
  assert.equal(JSON.parse(viaRpc[2].response.text).ok, false, "경계에서 commitStalled 로 ok:false");
  assert.equal(JSON.parse(viaRpc[2].response.text).lanes.product.commitStalled, true);
});

test("(a) RPC 없음(PGRST202)이면 10분 동안 RPC 를 건너뛰어 SQL 전 요청 수가 지금(12건)과 같다", async (t) => {
  await seedHealthy();
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const stub = installSupabase(db, "missing");
  try {
    const handler = await freshHandler();
    await get(handler);
    assert.equal(stub.rpcCalls().length, 1);
    const restPerMiss = stub.restCalls().length;
    assert.equal(restPerMiss, 12, "활성 행이 1,000 미만이면 개별 조회는 정확히 12건이다");
    t.mock.timers.setTime(NOW + 61_000);
    await get(handler);
    assert.equal(stub.rpcCalls().length, 1, "확인된 없음은 다시 묻지 않는다");
    assert.equal(stub.restCalls().length, restPerMiss * 2);
    t.mock.timers.setTime(NOW + 10 * MINUTE + 1);
    await get(handler);
    assert.equal(stub.rpcCalls().length, 2, "10분 뒤에는 다시 시도한다(대표 SQL 실행 뒤 넘어가게)");
  } finally {
    stub.restore();
  }
});

// 캐시 미스를 낸 시각(NOW 기준 ms)마다 그 미스의 요청 수를 센다. 같은 핸들러 인스턴스다.
async function missesAt(t, mode, offsets) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const stub = installSupabase(db, mode);
  const steps = [];
  try {
    const handler = await freshHandler();
    for (const offset of offsets) {
      t.mock.timers.setTime(NOW + offset);
      const before = { rpc: stub.rpcCalls().length, rest: stub.restCalls().length };
      const response = await get(handler);
      steps.push({
        rpc: stub.rpcCalls().length - before.rpc,
        rest: stub.restCalls().length - before.rest,
        response,
      });
    }
  } finally {
    stub.restore();
    t.mock.timers.reset();
  }
  return { steps, warnings: stub.warnings };
}

// 61초 간격 = 매번 캐시 미스(성공 캐시 60초).
const EVERY_MISS = (count) => Array.from({ length: count }, (_, index) => index * 61_000);

test("(a) 일시 오류(500·네트워크)는 1분 뒤 다시 시도하고, 이어지면 2·4·8분으로 늘려 10분에서 멈춘다", async (t) => {
  await seedHealthy();
  for (const mode of ["error", "throw"]) {
    // 1분마다 캐시 미스(성공 캐시 60초가 딱 끝나는 시각)를 13번 낸다. 실패 시각 0·1·3·7분에
    // 쉬는 시간이 1·2·4·8분으로 늘어 RPC 는 0·1·3·7분에만 나간다(쉬는 시간이 끝나는 바로 그 시각에 다시 묻는다).
    const offsets = Array.from({ length: 13 }, (_, index) => index * MINUTE);
    const { steps, warnings } = await missesAt(t, mode, offsets);
    assert.deepEqual(steps.map((step) => step.rpc), [1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0], `${mode}: 1·2·4분 쉬고 다시 묻는다`);
    assert.ok(steps.every((step) => step.rest === 12), `${mode}: 개별 조회는 매번 12건`);
    // 쉬는 동안의 미스는 B안 전과 같은 12건뿐이다.
    assert.equal(steps.filter((step) => step.rpc + step.rest === 13).length, 4);
    assert.equal(warnings.length, 4, `${mode}: 버릴 때마다 한 줄, 쉬는 동안은 없다`);
    assert.deepEqual(warnings.map((line) => JSON.parse(line).retryInMs), [MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE]);
    assert.ok(warnings.every((line) => JSON.parse(line).reason === "transient"));
  }
  // 상한: 열 번 연달아 실패해도 쉬는 시간은 10분을 넘지 않는다.
  let at = 0;
  const offsets = [];
  for (const wait of [0, 1, 2, 4, 8, 10, 10, 10, 10, 10]) {
    at += wait * MINUTE;
    offsets.push(at);
  }
  const capped = await missesAt(t, "error", offsets);
  assert.ok(capped.steps.every((step) => step.rpc === 1), "쉬는 시간이 끝날 때마다 한 번씩 다시 묻는다");
  assert.deepEqual(capped.warnings.map((line) => JSON.parse(line).retryInMs), [
    1, 2, 4, 8, 10, 10, 10, 10, 10, 10,
  ].map((minutes) => minutes * MINUTE));
});

test("(a) 동시에 난 캐시 미스가 함께 일시 실패해도 한 번으로 친다 — 쉬는 시간 1분, 기록 줄 1개", async (t) => {
  await seedHealthy();
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const stub = installSupabase(db, "error");
  try {
    const handler = await freshHandler();
    await Promise.all([get(handler), get(handler), get(handler)]);
    assert.equal(stub.warnings.length, 1, "동시 실패 셋은 줄 하나");
    assert.equal(JSON.parse(stub.warnings[0]).retryInMs, MINUTE);
    t.mock.timers.setTime(NOW + MINUTE);
    const before = stub.rpcCalls().length;
    await get(handler);
    assert.equal(stub.rpcCalls().length - before, 1, "1분 뒤 다시 묻는다(여러 단계 오르지 않았다)");
    assert.equal(JSON.parse(stub.warnings.at(-1)).retryInMs, 2 * MINUTE);
  } finally {
    stub.restore();
    t.mock.timers.reset();
  }
});

test("(a) 다시 물어도 같은 실패(403 42501 권한 없음)는 10분 쉰다 — 캐시 미스마다 13건이 되지 않는다", async (t) => {
  await seedHealthy();
  // 검토 재현과 같은 순서: 61초 간격 캐시 미스 5번, 그리고 10분 경계.
  const offsets = [...EVERY_MISS(5), 10 * MINUTE, 10 * MINUTE + 61_000];
  const reference = (await missesAt(t, "missing", offsets)).steps.map((step) => step.response);
  const { steps, warnings } = await missesAt(t, "denied", offsets);
  assert.deepEqual(steps.map((step) => step.rpc + step.rest), [13, 12, 12, 12, 12, 13, 12]);
  assert.ok(steps.every((step) => step.rest === 12));
  assert.deepEqual(steps.map((step) => step.response), reference, "응답은 같은 시각의 개별 조회와 바이트가 같다");
  assert.equal(warnings.length, 2);
  for (const line of warnings) {
    assert.deepEqual(JSON.parse(line), {
      event: "rank_collection_health_snapshot_fallback",
      reason: "lasting",
      status: 403,
      errorCode: "42501",
      retryInMs: 10 * MINUTE,
    });
  }
});

test("(a) 상태 코드로 가른다: 400·401·300 은 10분, 408·429·500·503 은 1분부터", async (t) => {
  await seedHealthy();
  const failing = (status, code) => async () => new Response(JSON.stringify({ code, details: null, hint: null, message: "x" }), {
    status,
    headers: JSON_HEADERS,
  });
  for (const [status, code, reason, retryInMs] of [
    [400, "22023", "lasting", 10 * MINUTE],
    [401, "PGRST301", "lasting", 10 * MINUTE],
    [300, "PGRST203", "lasting", 10 * MINUTE],
    [408, "", "transient", MINUTE],
    [429, "", "transient", MINUTE],
    [500, "57014", "transient", MINUTE],
    [503, "PGRST001", "transient", MINUTE],
  ]) {
    const { steps, warnings } = await missesAt(t, failing(status, code), [0, MINUTE]);
    assert.deepEqual(warnings.map((line) => JSON.parse(line)).slice(0, 1), [{
      event: "rank_collection_health_snapshot_fallback",
      reason,
      status,
      errorCode: code,
      retryInMs,
    }], `${status} ${code}`);
    assert.deepEqual(steps.map((step) => step.rpc), reason === "lasting" ? [1, 0] : [1, 1], `${status} ${code}`);
  }
});

test("(a) 모양이 틀린 스냅샷도 10분 쉬고, 쓸 수 있는 스냅샷이 오면 일시 실패 횟수가 처음으로 돌아간다", async (t) => {
  await seedHealthy();
  const malformed = (snapshot) => new Response(JSON.stringify({ ...snapshot, stuck: "0" }), {
    status: 200,
    headers: JSON_HEADERS,
  });
  const shaped = await missesAt(t, malformed, [0, 61_000, 10 * MINUTE]);
  assert.deepEqual(shaped.steps.map((step) => step.rpc), [1, 0, 1]);
  assert.deepEqual(shaped.warnings.map((line) => JSON.parse(line).reason), ["malformed", "malformed"]);

  // 일시 실패 두 번(1분·2분 쉼) → 성공 → 다시 일시 실패면 쉬는 시간은 1분부터 다시 시작한다.
  let phase = "error";
  const switching = async (snapshot) => (phase === "error"
    ? new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), {
      status: 500,
      headers: JSON_HEADERS,
    })
    : new Response(JSON.stringify(snapshot), { status: 200, headers: JSON_HEADERS }));
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const stub = installSupabase(db, switching);
  try {
    const handler = await freshHandler();
    await get(handler);
    t.mock.timers.setTime(NOW + MINUTE);
    await get(handler);
    phase = "ok";
    t.mock.timers.setTime(NOW + 3 * MINUTE);
    await get(handler);
    assert.equal(stub.rpcCalls().length, 3);
    phase = "error";
    t.mock.timers.setTime(NOW + 3 * MINUTE + 61_000);
    await get(handler);
    assert.equal(stub.rpcCalls().length, 4);
    assert.deepEqual(stub.warnings.map((line) => JSON.parse(line).retryInMs), [MINUTE, 2 * MINUTE, MINUTE]);
  } finally {
    stub.restore();
    t.mock.timers.reset();
  }
});

test("(a) 느린 RPC 는 2.5초에서 끊고 개별 조회로 간다 — 응답 시간에 그 이상 더해지지 않는다", async (t) => {
  await seedHealthy();
  const reference = (await missesAt(t, "missing", [0])).steps[0].response;
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const stub = installSupabase(db, "slow");
  try {
    const handler = await freshHandler();
    const started = process.hrtime.bigint();
    const response = await get(handler);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepEqual(response, reference, "끊긴 뒤 개별 조회와 바이트가 같다");
    assert.equal(stub.rpcCalls().length, 1);
    assert.equal(stub.restCalls().length, 12);
    assert.ok(stub.rpcCalls()[0].signal, "RPC 에 시간 상한 신호를 넘긴다");
    assert.ok(elapsedMs >= 2_400, `상한 전에 끊지 않는다(${elapsedMs}ms)`);
    assert.ok(elapsedMs < 6_000, `상한 뒤 곧바로 개별 조회로 넘어간다(${elapsedMs}ms)`);
    assert.deepEqual(stub.warnings.map((line) => JSON.parse(line)), [{
      event: "rank_collection_health_snapshot_fallback",
      reason: "transient",
      status: 0,
      errorCode: "",
      retryInMs: MINUTE,
    }]);
    // 시간 초과도 일시 실패라 1분 동안은 RPC 를 기다리지 않는다.
    t.mock.timers.setTime(NOW + 30_000);
    await get(handler);
    assert.equal(stub.rpcCalls().length, 1);
  } finally {
    stub.restore();
    t.mock.timers.reset();
  }
});

test("(c) 대체 기록 줄에는 코드·상태·이유만 있고 오류 문장·행 값은 없다", async (t) => {
  await seedHealthy();
  const { warnings } = await missesAt(t, "missing", [0]);
  assert.equal(warnings.length, 1);
  const line = JSON.parse(warnings[0]);
  assert.deepEqual(Object.keys(line).sort(), ["errorCode", "event", "reason", "retryInMs", "status"]);
  assert.deepEqual(line, {
    event: "rank_collection_health_snapshot_fallback",
    reason: "missing",
    status: 404,
    errorCode: "PGRST202",
    retryInMs: 10 * MINUTE,
  });
  assert.ok(!warnings[0].includes("schema cache"), "PostgREST 오류 문장은 남기지 않는다");
});

const MALFORMED = [
  ["배열", () => []],
  ["null", () => null],
  ["칸 빠짐", (snapshot) => { delete snapshot.never_found; return snapshot; }],
  ["집계가 문자열", (snapshot) => ({ ...snapshot, stuck: "0" })],
  ["집계가 음수", (snapshot) => ({ ...snapshot, active_product: -1 })],
  ["집계가 소수", (snapshot) => ({ ...snapshot, place_partial: 0.5 })],
  ["불리언이 문자열", (snapshot) => ({ ...snapshot, product_overdue: "false" })],
  ["시각이 깨짐", (snapshot) => ({ ...snapshot, product_latest_checked_at: "not-a-date" })],
  ["시각이 숫자", (snapshot) => ({ ...snapshot, latest_signature_at: 0 })],
  ["버전이 숫자", (snapshot) => ({ ...snapshot, latest_run_runtime_version: 1 })],
  ["코디네이션 칸 빠짐", (snapshot) => {
    const { last_success_at: _dropped, ...coordination } = snapshot.coordination;
    return { ...snapshot, coordination };
  }],
  ["코디네이션이 배열", (snapshot) => ({ ...snapshot, coordination: [snapshot.coordination] })],
  ["검색어가 배열 아님", (snapshot) => ({ ...snapshot, active_product_keywords: "아이폰" })],
  ["검색어 원소가 숫자", (snapshot) => ({ ...snapshot, active_product_keywords: [1] })],
  ["상한 표시가 길이와 어긋남", (snapshot) => ({ ...snapshot, active_product_keywords_truncated: true })],
  ["상한 표시 빠짐", (snapshot) => { delete snapshot.active_product_keywords_truncated; return snapshot; }],
];

test("(a) 모양이 틀린 스냅샷은 통째로 버리고 개별 조회와 같은 응답을 낸다", async (t) => {
  await seedHealthy();
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const reference = (await onePath("missing")).response;
  assert.equal(JSON.parse(reference.text).ok, true);
  for (const [label, mutate] of MALFORMED) {
    const { response, stub } = await onePath((snapshot) => new Response(JSON.stringify(mutate(snapshot)), {
      status: 200,
      headers: JSON_HEADERS,
    }));
    assert.equal(stub.rpcCalls().length, 1, label);
    assert.equal(stub.restCalls().length, 12, `${label}: 개별 조회로 돌아간다`);
    assert.deepEqual(response, reference, `${label}: 응답이 개별 조회와 같다`);
  }
});

test("(a) 거짓 정상 없음: 스냅샷이 틀리고 개별 조회도 실패하면 503/ok:false 다", async (t) => {
  await seedHealthy();
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const failing = async () => new Response(JSON.stringify({ message: "upstream unavailable" }), {
    status: 500,
    headers: JSON_HEADERS,
  });
  const allDown = await onePath(() => new Response("[]", { status: 200, headers: JSON_HEADERS }), {
    restOverride: failing,
  });
  assert.equal(allDown.response.status, 503);
  assert.equal(JSON.parse(allDown.response.text).ok, false);
  assert.deepEqual(JSON.parse(allDown.response.text).trackers, {
    neverFound: 0, stuck: 0, placePartial: 0, activeProduct: 0, activeProductKeywordGroups: 0,
  });

  // 핵심 레인 조회는 되고 관측 조회 하나(실행 기록)만 실패하면 200/ok:false — 예전 그대로다.
  const partial = await onePath("missing", {
    restOverride: async (url) => (url.pathname === "/rest/v1/naver_shopping_worker_runs" ? failing() : null),
  });
  assert.equal(partial.response.status, 200);
  assert.equal(JSON.parse(partial.response.text).ok, false);
});

// ───────────────────────── (b) SQL: 함수 결과 = 12개 조회의 의미 ─────────────────────────

// 표의 원래 행을 읽어 JS 로 다시 센다(개별 조회 경로의 필터·정렬·null·lt/gte·status 의미 그대로).
async function oracle(args) {
  const rows = async (table) => (await db.query(`select * from public.${table}`)).rows;
  const product = await rows("naver_rank_trackers");
  const place = await rows("naver_place_rank_trackers");
  const lane = (await rows("naver_shopping_worker_coordination")).find((row) => row.lane_key === "global") || null;
  const runs = await rows("naver_shopping_worker_runs");
  const nonces = await rows("naver_shopping_worker_nonces");
  const ms = (value) => (value === null ? null : value.getTime());
  const latest = (list) => {
    const values = list.filter((value) => value !== null).map((value) => value.getTime());
    return values.length ? Math.max(...values) : null;
  };
  const active = (list) => list.filter((row) => row.status === "active");
  const overdueCutoff = Date.parse(args.p_overdue_cutoff);
  const stuckCutoff = Date.parse(args.p_stuck_cutoff);
  const activeProduct = active(product);
  const newestRun = [...runs].sort((left, right) => right.started_at - left.started_at)[0];
  return {
    product_latest_checked_at: latest(product.map((row) => row.last_checked_at)),
    place_latest_checked_at: latest(place.map((row) => row.last_checked_at)),
    product_overdue: activeProduct.some((row) => row.next_check_at.getTime() < overdueCutoff),
    place_overdue: active(place).some((row) => row.next_check_at.getTime() < overdueCutoff),
    coordination: lane && {
      circuit_state: lane.circuit_state,
      circuit_reason: lane.circuit_reason,
      cooldown_until: ms(lane.cooldown_until),
      primary_seen_at: ms(lane.primary_seen_at),
      last_success_at: ms(lane.last_success_at),
    },
    latest_run_runtime_version: newestRun ? newestRun.runtime_version : null,
    latest_signature_at: latest(nonces.map((row) => row.created_at)),
    never_found: activeProduct.filter((row) => row.check_count >= args.p_never_found_min_checks && row.found_count === 0).length,
    stuck: activeProduct.filter((row) => row.last_error !== null && (row.last_checked_at !== null
      ? row.last_checked_at.getTime() < stuckCutoff
      : row.created_at.getTime() < stuckCutoff)).length,
    place_partial: active(place).filter((row) => row.last_error === null && row.retry_count >= args.p_place_partial_min_retries).length,
    active_product: activeProduct.length,
    active_product_keywords: activeProduct.length < args.p_keyword_row_limit
      ? activeProduct.map((row) => row.keyword).sort()
      : null,
    active_product_keywords_truncated: activeProduct.length >= args.p_keyword_row_limit,
  };
}

async function snapshot(args) {
  return JSON.parse(await realSnapshotText(db, args));
}

function comparable(result) {
  const ms = (value) => (value === null ? null : Date.parse(value));
  return {
    ...result,
    product_latest_checked_at: ms(result.product_latest_checked_at),
    place_latest_checked_at: ms(result.place_latest_checked_at),
    latest_signature_at: ms(result.latest_signature_at),
    coordination: result.coordination && {
      ...result.coordination,
      cooldown_until: ms(result.coordination.cooldown_until),
      primary_seen_at: ms(result.coordination.primary_seen_at),
      last_success_at: ms(result.coordination.last_success_at),
    },
    active_product_keywords: result.active_product_keywords_truncated ? null : [...result.active_product_keywords].sort(),
  };
}

const sqlArgs = (overrides = {}) => ({
  p_overdue_cutoff: new Date(NOW - RANK_OVERDUE_THRESHOLD_MS).toISOString(),
  p_stuck_cutoff: new Date(NOW - RANK_STUCK_TRACKER_MS).toISOString(),
  p_never_found_min_checks: RANK_NEVER_FOUND_MIN_CHECKS,
  p_place_partial_min_retries: RANK_PLACE_PARTIAL_MIN_RETRIES,
  ...rankKeywordGroupSnapshotArgs(),
  ...overrides,
});

test("(b) SQL: 경계값 자료에서 함수 결과가 12개 조회의 의미와 칸마다 같다", async () => {
  await resetTables(db);
  const args = sqlArgs();
  const overdueCutoff = Date.parse(args.p_overdue_cutoff);
  const stuckCutoff = Date.parse(args.p_stuck_cutoff);
  const at = (value) => new Date(value).toISOString();
  await insertProducts(db, [
    { keyword: "a", next_check_at: at(overdueCutoff) },
    { keyword: "b", status: "paused", next_check_at: at(overdueCutoff - HOUR), last_checked_at: at(NOW - MINUTE) },
    { keyword: "c", last_error: "x", last_checked_at: at(stuckCutoff) },
    { keyword: "d", last_error: "x", last_checked_at: at(stuckCutoff - 1) },
    { keyword: "e", last_error: "x", created_at: at(stuckCutoff) },
    { keyword: "f", last_error: "x", created_at: at(stuckCutoff - 1) },
    { keyword: "g", last_error: "x", status: "completed", created_at: at(stuckCutoff - HOUR) },
    { keyword: "h", check_count: args.p_never_found_min_checks - 1 },
    { keyword: "i", check_count: args.p_never_found_min_checks },
    { keyword: "i", check_count: args.p_never_found_min_checks, found_count: 2 },
  ]);
  await insertPlaces(db, [
    { next_check_at: at(overdueCutoff), last_checked_at: at(NOW - 3 * MINUTE) },
    { retry_count: args.p_place_partial_min_retries },
    { retry_count: args.p_place_partial_min_retries - 1 },
    { retry_count: args.p_place_partial_min_retries, last_error: "x" },
    { retry_count: args.p_place_partial_min_retries, status: "failed" },
  ]);
  await insertCoordination(db, {
    circuit_state: "half_open",
    circuit_reason: "auto_navigation_probe",
    cooldown_until: at(NOW + MINUTE),
    primary_seen_at: at(NOW - MINUTE),
    last_success_at: null,
  });
  await insertRuns(db, [
    { runtime_version: "1.1.33", started_at: at(NOW - HOUR) },
    { runtime_version: EXPECTED_WORKER_RUNTIME_VERSION, started_at: at(NOW - MINUTE) },
    { runtime_version: "1.1.32", started_at: at(NOW - 2 * HOUR) },
  ]);
  await insertNonces(db, [at(NOW - HOUR), at(NOW - 5_000), at(NOW - MINUTE)]);
  const result = await snapshot(args);
  assert.deepEqual(Object.keys(result).sort(), [
    "active_product",
    "active_product_keywords",
    "active_product_keywords_truncated",
    "coordination",
    "latest_run_runtime_version",
    "latest_signature_at",
    "never_found",
    "place_latest_checked_at",
    "place_overdue",
    "place_partial",
    "product_latest_checked_at",
    "product_overdue",
    "stuck",
  ]);
  assert.deepEqual(comparable(result), await oracle(args));
  // 기대값을 직접 적어 둔다(오라클 자체가 틀려도 잡히게).
  assert.equal(result.product_overdue, false, "경계와 같은 예정 시각은 지연이 아니고 paused 는 세지 않는다");
  assert.equal(result.place_overdue, false);
  assert.equal(result.stuck, 2);
  assert.equal(result.never_found, 1);
  assert.equal(result.place_partial, 1);
  assert.equal(result.active_product, 8);
  assert.equal(result.latest_run_runtime_version, EXPECTED_WORKER_RUNTIME_VERSION);
  assert.equal(Date.parse(result.latest_signature_at), NOW - 5_000);
  assert.equal(Date.parse(result.product_latest_checked_at), NOW - MINUTE, "paused 행도 최신 확인 시각에 든다");
  assert.equal(result.coordination.last_success_at, null);
});

test("(b) SQL: 빈 표는 null·false·0·빈 배열이고, 1ms 앞선 지연은 지연이다", async () => {
  await resetTables(db);
  const args = sqlArgs();
  const empty = await snapshot(args);
  assert.deepEqual(empty, {
    product_latest_checked_at: null,
    place_latest_checked_at: null,
    product_overdue: false,
    place_overdue: false,
    coordination: null,
    latest_run_runtime_version: null,
    latest_signature_at: null,
    never_found: 0,
    stuck: 0,
    place_partial: 0,
    active_product: 0,
    active_product_keywords: [],
    active_product_keywords_truncated: false,
  });
  await insertProducts(db, [{ next_check_at: new Date(Date.parse(args.p_overdue_cutoff) - 1).toISOString() }]);
  await insertPlaces(db, [{ next_check_at: new Date(Date.parse(args.p_overdue_cutoff) - 1).toISOString() }]);
  const overdue = await snapshot(args);
  assert.equal(overdue.product_overdue, true);
  assert.equal(overdue.place_overdue, true);
  assert.deepEqual(comparable(overdue), await oracle(args));
});

test("(b) SQL: 키워드 상한 — 활성 행이 상한 이상이면 truncated, 원문 배열은 상한까지만", async () => {
  await resetTables(db);
  await insertProducts(db, [
    { keyword: "아이폰 케이스" },
    { keyword: "아이폰케이스" },
    { keyword: "IPHONE CASE" },
    { keyword: "꺼진 묶음", status: "paused" },
  ]);
  for (const [limit, truncated, length] of [[4, false, 3], [3, true, 3], [2, true, 2], [1, true, 1]]) {
    const result = await snapshot(sqlArgs({ p_keyword_row_limit: limit }));
    assert.equal(result.active_product_keywords_truncated, truncated, `limit=${limit}`);
    assert.equal(result.active_product_keywords.length, length, `limit=${limit}`);
    assert.ok(!result.active_product_keywords.includes("꺼진 묶음"));
  }
  // 정규화는 SQL 이 아니라 JS 다. 원문 3개 → 정규화 키 2개(아이폰케이스·iphonecase).
  const full = await snapshot(sqlArgs());
  assert.deepEqual([...full.active_product_keywords].sort(), ["IPHONE CASE", "아이폰 케이스", "아이폰케이스"].sort());
  assert.deepEqual(observeSnapshotKeywordGroups(full), { value: 2, reliable: true });
});

test("(b) SQL: 시각 문자열이 PostgREST 표 응답(json_agg)과 글자까지 같다", async () => {
  await resetTables(db);
  await db.query(
    `insert into public.naver_rank_trackers (keyword, product_id, last_checked_at, next_check_at)
     values ('마이크로초', 'p1', '2026-10-17T02:55:00.123456Z', '2026-10-17T05:00:00Z')`,
  );
  await insertCoordination(db, { primary_seen_at: "2026-10-17T02:59:59.999999Z", last_success_at: "2026-10-17T02:55:00.5Z" });
  await insertNonces(db, ["2026-10-17T02:59:30.000001Z"]);
  const result = await snapshot(sqlArgs());
  const restLike = async (sql) => JSON.parse((await db.query(`select coalesce(json_agg(t), '[]'::json)::text as body from (${sql}) as t`)).rows[0].body)[0];
  assert.equal(
    result.product_latest_checked_at,
    (await restLike("select last_checked_at from public.naver_rank_trackers where last_checked_at is not null order by last_checked_at desc limit 1")).last_checked_at,
  );
  assert.equal(result.product_latest_checked_at, "2026-10-17T02:55:00.123456+00:00");
  const lane = await restLike("select circuit_state, circuit_reason, cooldown_until, primary_seen_at, last_success_at from public.naver_shopping_worker_coordination where lane_key = 'global'");
  assert.deepEqual(result.coordination, lane);
  assert.equal(
    result.latest_signature_at,
    (await restLike("select created_at from public.naver_shopping_worker_nonces order by created_at desc limit 1")).created_at,
  );
});

test("(b) SQL: 읽기 전용 거래 안에서 돈다 · 다시 실행해도 같다 · 권한은 service_role 만", async () => {
  await seedHealthy();
  const args = sqlArgs();
  await db.exec("begin transaction read only");
  const readOnly = await snapshot(args);
  await db.exec("commit");
  const before = (await db.query(`select pg_get_functiondef('${RPC_SIGNATURE}'::regprocedure) as def`)).rows[0].def;
  await db.exec(migration);
  const after = (await db.query(`select pg_get_functiondef('${RPC_SIGNATURE}'::regprocedure) as def`)).rows[0].def;
  assert.equal(after, before, "create or replace 재실행은 같은 정의를 남긴다");
  assert.deepEqual(await snapshot(args), readOnly);

  const { rows: [meta] } = await db.query(
    `select p.provolatile, p.prosecdef, p.proconfig, pg_catalog.format_type(p.prorettype, null) as returns,
            pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon,
            pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
            pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service_role,
            exists (select 1 from pg_catalog.aclexplode(p.proacl) as acl where acl.grantee = 0) as public_grant
     from pg_catalog.pg_proc as p where p.oid = '${RPC_SIGNATURE}'::regprocedure`,
  );
  assert.equal(meta.provolatile, "s", "stable");
  assert.equal(meta.prosecdef, false, "security invoker");
  assert.deepEqual(meta.proconfig, ['search_path=""']);
  assert.equal(meta.returns, "jsonb");
  assert.equal(meta.anon, false);
  assert.equal(meta.authenticated, false);
  assert.equal(meta.public_grant, false);
  assert.equal(meta.service_role, true);
});

// ───────────────────────── (c) 원문 ─────────────────────────

test("(c) 원문 고정: sha256·docs/sql 사본 바이트·begin … commit 한 묶음", () => {
  assert.equal(crypto.createHash("sha256").update(migration).digest("hex"), MIGRATION_SHA256);
  assert.ok(
    fs.readFileSync(DOCS_COPY).equals(fs.readFileSync(path.join(migrationDirectory, MIGRATION_NAME))),
    "docs/sql/log-b-rank-health-snapshot.sql 이 마이그레이션과 바이트 단위로 다르다",
  );
  const lines = migration.split("\n");
  assert.equal(lines.filter((line) => line === "begin;").length, 1);
  assert.equal(lines.filter((line) => line === "commit;").length, 1);
  assert.equal(migration.trimEnd().split("\n").at(-1), "commit;");
  assert.ok(migration.indexOf("begin;") < migration.indexOf("create or replace function"));
});

test("(c) 원문: 함수 하나만 만들고 표·색인·다른 함수는 건드리지 않는다, 시각은 인자로만 받는다", () => {
  const code = migration.replace(/--[^\n]*/gu, "");
  const statements = code.split(/;\s*\n/u).map((statement) => statement.trim()).filter(Boolean);
  // 함수 본문 안의 세미콜론은 select 끝 하나뿐이라 본문은 "$$" 한 조각으로 갈라진다.
  assert.deepEqual(statements.map((statement) => statement.split(/\s+/u).slice(0, 2).join(" ")), [
    "begin",
    "create or",
    "$$",
    "revoke all",
    "grant execute",
    "commit",
  ]);
  assert.equal((code.match(/create or replace function/gu) || []).length, 1);
  assert.ok(code.includes(`create or replace function public.${RPC}(`));
  for (const forbidden of [
    /\bcreate\s+(?:table|index|unique|trigger|view|policy|type|schema)\b/iu,
    /\balter\s+(?:table|function|type)\b/iu,
    /\bdrop\b/iu,
    /\binsert\s+into\b/iu,
    /\bupdate\s+public\./iu,
    /\bdelete\s+from\b/iu,
    /\bnow\s*\(/iu,
    /\bcurrent_timestamp\b/iu,
    /\bclock_timestamp\b/iu,
    /'\d+\.\d+\.\d+'/u,
    /[0-9a-f]{64}/iu,
  ]) {
    assert.ok(!forbidden.test(code), `금지된 구문: ${forbidden}`);
  }
  assert.ok(code.includes("language sql\nstable\nsecurity invoker\nset search_path = ''"));
  assert.ok(code.includes("from public, anon, authenticated, service_role;"));
  assert.ok(code.includes(") to service_role;"));
  // 되돌리는 법(함수 drop)은 주석에 있고, 그 서명은 실제 서명과 같다.
  assert.ok(migration.includes(
    "-- 되돌리기: drop function if exists public.mi_rank_collection_health_snapshot(timestamptz, timestamptz, integer, integer, integer);",
  ));
});

test("(c) 핸들러: RPC 이름·인자 이름이 마이그레이션과 같고 상수는 서버 원본을 쓴다", () => {
  assert.ok(handlerSource.includes(`const RANK_HEALTH_SNAPSHOT_RPC = "${RPC}";`));
  for (const name of SNAPSHOT_ARG_NAMES.filter((arg) => arg !== "p_keyword_row_limit")) {
    assert.ok(handlerSource.includes(`${name}: `), `핸들러가 ${name} 를 넘긴다`);
    assert.ok(migration.includes(`  ${name} `), `마이그레이션이 ${name} 를 받는다`);
  }
  assert.ok(migration.includes("  p_keyword_row_limit integer"));
  assert.deepEqual(rankKeywordGroupSnapshotArgs(), { p_keyword_row_limit: RANK_KEYWORD_GROUP_ROW_LIMIT });
  assert.ok(handlerSource.includes("p_never_found_min_checks: RANK_NEVER_FOUND_MIN_CHECKS,"));
  assert.ok(handlerSource.includes("p_place_partial_min_retries: RANK_PLACE_PARTIAL_MIN_RETRIES,"));
  assert.ok(handlerSource.includes("p_overdue_cutoff: cutoffIso,"));
  assert.ok(handlerSource.includes("p_stuck_cutoff: stuckCutoffIso,"));
  // npm test 가 이 파일을 돈다.
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts.test, /scripts\/rank-collection-health-snapshot\.test\.mjs/u);
  // 대체 경로(개별 조회 12건)는 지우지 않았다.
  assert.ok(handlerSource.includes("async function separateObservations(ctx, now, cutoffIso, stuckCutoffIso)"));
  assert.ok(handlerSource.includes("} = await snapshotObservations(ctx, now, cutoffIso, stuckCutoffIso)\n        || await separateObservations(ctx, now, cutoffIso, stuckCutoffIso);"));
});

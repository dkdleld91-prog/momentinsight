// C 30일 순위 ① '지금 확인' 대표 SQL 검사(spec-manual §5·§10.1, 2026-10-23 재구현).
// PGlite(메모리 DB)에 C 원문(SQL0) 위로 수동 SQL 을 올려 관문·확인·결과·그날 중지를 실제로 돌린다. 운영 DB 에는 접속하지 않는다.
// 시험 DB 에서만 시간 칸 제약(09~19시)을 지우고 0~24시로 연다(지금 시각과 무관하게 돌리려고). 시간 관문 자체는
// 지금 KST 시를 뺀 창으로 따로 본다. 시각이 필요한 조건(간격·기한·5초)은 저장된 시각을 앞당겨 만든다(기다리지 않는다).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import {
  ERROR_HTTP_STATUS,
  MANUAL_CLAIM_KEEP_DAYS,
  MANUAL_CLAIM_STATUSES,
  MANUAL_CLAIM_TTL_SECONDS,
  MANUAL_FROM_HOUR,
  MANUAL_MAX_PER_DAY,
  MANUAL_MIN_GAP_SECONDS,
  MANUAL_MIN_MEASURE_SECONDS,
  MANUAL_RECORD_MAX_AGE_MINUTES,
  MANUAL_SEARCH_WINDOW_SECONDS,
  MANUAL_STATES,
  MANUAL_STOP_CODES,
  MANUAL_TO_HOUR,
} from "../src/server/coupang-rank/contract.mjs";
import {
  auditMigrationRuntimeLiterals,
  collectFinalFunctionDeclarations,
  stripSqlComments,
} from "./migration-runtime-literal-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const BASE_NAME = "20261017090000_coupang_rank_tracking.sql";
const MANUAL_NAME = "20261018090000_coupang_rank_manual_check.sql";
const baseSql = fs.readFileSync(path.join(migrationDirectory, BASE_NAME), "utf8");
const sql = fs.readFileSync(path.join(migrationDirectory, MANUAL_NAME), "utf8");
const DOCS_COPY = path.join(root, "docs", "sql", "c30-2-manual-check.sql");
const ROLLBACK = fs.readFileSync(path.join(root, "docs", "sql", "c30-2-manual-check.rollback.sql"), "utf8");
const RUNBOOK = fs.readFileSync(path.join(root, "docs", "RUNBOOK.md"), "utf8");

// 원문 해시. 한 글자라도 고치면 이 값·docs/sql 사본·RUNBOOK 의 해시를 함께 고친다.
const SPEC_SHA256 = "7a958e9700c204122d03d81a8b6e7bc639aa90d8f3b676d19aa7047291414577";
const PRIMARY = "mml93-a01";

const EXPECTED_FUNCTIONS = [
  "coupang_rank_manual_claim(uuid,text,text,text,text)",
  "coupang_rank_manual_record(uuid,text,text,text,text,text,jsonb,text)",
  "coupang_rank_manual_stop(uuid,text,text,text,uuid)",
  "coupang_rank_manual_summary(uuid)",
  "coupang_rank_manual_verify(uuid,text,text)",
];
const MANUAL_SETTING_COLUMNS = [
  "manual_enabled", "manual_min_gap_seconds", "manual_max_per_day", "manual_from_hour", "manual_to_hour",
  "manual_last_claim_at", "manual_last_search_at", "manual_stopped_day", "manual_stopped_at", "manual_stopped_run_id",
  "manual_stopped_code",
];

// RUNBOOK '지금 확인' 확인문(대표가 SQL 실행 뒤 따로 돌린다).
const CONFIRM_SQL = String.raw`select s.manual_enabled, s.manual_min_gap_seconds, s.manual_max_per_day, s.manual_from_hour, s.manual_to_hour,
  (select count(*) from pg_catalog.pg_proc where proname like 'coupang\_rank\_manual\_%') as fns,
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'coupang_rank_manual_claims') as claims_table,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'coupang_rank_runs' and column_name in ('source', 'requested_by')) as run_cols
from public.coupang_rank_settings s where s.id = 1;`;

const FIXTURE_SQL = `
  create role anon; create role authenticated; create role service_role;
  create or replace function public.set_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end; $$;
  create type public.client_status as enum ('active', 'paused', 'archived');
  create table public.clients (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    agency_code text unique not null,
    status public.client_status not null default 'active',
    disconnected_at timestamptz);
  create table public.operation_team_codes (
    id uuid primary key default gen_random_uuid(),
    owner_agency_code text not null default 'mml93-a01',
    team_name text not null,
    team_code text unique not null,
    status text not null default 'active' check (status in ('active', 'revoked')));`;

// 시험 DB 에서만: 시간 칸 제약을 지우고 0~24시로 연다, 켠다, 간격 기준을 비운다.
const OPEN_SQL = `
  alter table public.coupang_rank_settings drop constraint coupang_rank_settings_manual_from_hour_check;
  alter table public.coupang_rank_settings drop constraint coupang_rank_settings_manual_to_hour_check;
  update public.coupang_rank_settings set manual_enabled = true, manual_from_hour = 0, manual_to_hour = 24 where id = 1;`;

const sorted = (list) => [...list].sort();

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function functionBody(name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} 선언이 없다`);
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  return sql.slice(open + 2, close);
}

// KST 자정 앞 90초·뒤 4분 안이면 벗어날 때까지 기다린다(하루 횟수·오늘 중지의 '오늘'이 시나리오 도중 바뀌지 않게,
// 시나리오가 확인 시각을 최대 3분쯤 앞당겨도 어제가 되지 않게). 하루 6분 남짓 구간에서만 기다린다.
async function awayFromKstMidnight() {
  const msOfKstDay = (Date.now() + 9 * 3_600_000) % 86_400_000;
  let wait = 0;
  if (msOfKstDay > 86_400_000 - 90_000) wait = 86_400_000 - msOfKstDay + 240_000;
  else if (msOfKstDay < 240_000) wait = 240_000 - msOfKstDay;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 2_000));
}

async function freshBase() {
  const db = new PGlite();
  await db.exec(FIXTURE_SQL);
  await db.exec(baseSql);
  return db;
}

async function fresh() {
  const db = await freshBase();
  await db.exec(sql);
  return db;
}

async function withDb(fn, { open = true } = {}) {
  await awayFromKstMidnight();
  const db = await fresh();
  try {
    if (open) await db.exec(OPEN_SQL);
    return await fn(db, helpers(db));
  } finally {
    await db.close();
  }
}

function organicList(hitAt, productId = "8533720933", count = 50) {
  const list = Array.from({ length: count }, (_, index) => ({ p: String(9000000 + index), v: "", s: index + 3 }));
  if (hitAt) list[hitAt - 1] = { p: productId, v: "96009802650", s: hitAt + 2, t: "아이쉘 360도 필름" };
  return list;
}

function okRun(organic, ads = [{ p: "7000001", v: "", s: 1 }, { p: "7000002", v: "", s: 2 }]) {
  return {
    httpStatus: 200, loginWall: true, stable: true, itemCount: organic.length + ads.length, organic, ads,
    finalHost: "www.coupang.com", finalPath: "/np/search", durationMs: 14000, collectorVersion: "1.0.0",
    browser: "chrome 141", errorCode: null,
  };
}

function blockedRun(httpStatus = 403) {
  return {
    httpStatus, loginWall: false, stable: false, itemCount: 0, organic: [], ads: [],
    finalHost: "www.coupang.com", finalPath: "/np/search", durationMs: 3000, collectorVersion: "1.0.0",
    browser: "chrome 141", errorCode: null,
  };
}

function helpers(db) {
  const one = async (query, params = []) => (await db.query(query, params)).rows[0];
  const all = async (query, params = []) => (await db.query(query, params)).rows;
  let counter = 0;
  const token = () => sha(`mcm1_test_${(counter += 1)}_${crypto.randomUUID()}`);
  const addClient = async (agencyCode, disconnected = false) => (await one(
    "insert into public.clients (name, agency_code, disconnected_at) values ($1, $2, $3) returning id",
    [`광고주 ${agencyCode}`, agencyCode, disconnected ? new Date().toISOString() : null],
  )).id;
  const addTracker = async ({ agency = PRIMARY, keyword = "아이폰 필름", productId = "8533720933", clientId = null, status = "active" } = {}) => (await one(
    `insert into public.coupang_rank_trackers (agency_code, client_id, keyword, keyword_key, product_id, product_url, status)
     values ($1, $2, $3, lower($3), $4, 'https://www.coupang.com/vp/products/' || $4, $5) returning id`,
    [agency, clientId, keyword, productId, status],
  )).id;
  const claim = async (trackerId, tokenHash, { agency = PRIMARY, by = "owner", role = "owner" } = {}) => (await one(
    "select public.coupang_rank_manual_claim($1, $2, $3, $4, $5) as j", [trackerId, agency, by, role, tokenHash],
  )).j;
  const verify = async (claimId, tokenHash, by = "owner") => (await one(
    "select public.coupang_rank_manual_verify($1, $2, $3) as j", [claimId, tokenHash, by],
  )).j;
  const record = async (claimId, tokenHash, { outcome = "measured", code = null, status = null, run = null, stopCode = null, by = "owner" } = {}) => (await one(
    "select public.coupang_rank_manual_record($1, $2, $3, $4, $5, $6, $7, $8) as j",
    [claimId, tokenHash, by, outcome, code, status, run === null ? null : JSON.stringify(run), stopCode],
  )).j;
  const stop = async (claimId, tokenHash, code, by = "owner") => (await one(
    "select public.coupang_rank_manual_stop($1, $2, $3, $4, null) as j", [claimId, tokenHash, by, code],
  )).j;
  const summary = async () => (await one("select public.coupang_rank_manual_summary(null) as j")).j;
  const settings = async () => one("select * from public.coupang_rank_settings where id = 1");
  const claimRow = async (claimId) => one("select * from public.coupang_rank_manual_claims where id = $1", [claimId]);
  // 간격 기준(마지막 실제 검색·자동 임대)을 지난 일로 돌린다.
  const clearGap = async () => db.exec(
    "update public.coupang_rank_settings set manual_last_search_at = now() - interval '1 hour', last_claim_at = null where id = 1",
  );
  // 확인 시각을 앞당긴다(5초 하한·검색 중 판정을 기다리지 않고 지나게).
  const ageVerify = async (claimId, seconds) => db.query(
    "update public.coupang_rank_manual_claims set verified_at = verified_at - make_interval(secs => $2), claimed_at = claimed_at - make_interval(secs => $2) where id = $1",
    [claimId, seconds],
  );
  // 요청 → 확인 → (확인 뒤 10초가 지난 것으로) 반환. 측정 결과를 보낼 준비가 된 요청.
  const verified = async (trackerId) => {
    const hash = token();
    const claimed = await claim(trackerId, hash);
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const checked = await verify(claimed.claimId, hash);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    await ageVerify(claimed.claimId, 10);
    return { claimId: claimed.claimId, hash, claimed, checked };
  };
  return { one, all, token, addClient, addTracker, claim, verify, record, stop, summary, settings, claimRow, clearGap, ageVerify, verified };
}

// ───────────────────────── 글자 검사 ─────────────────────────

test("원문 고정: 해시·docs/sql 사본 바이트 같음·begin … commit 한 묶음", () => {
  assert.equal(sha(sql), SPEC_SHA256);
  assert.ok(fs.readFileSync(DOCS_COPY).equals(fs.readFileSync(path.join(migrationDirectory, MANUAL_NAME))),
    "docs/sql/c30-2-manual-check.sql 이 마이그레이션과 바이트 단위로 다르다");
  for (const text of [sql, ROLLBACK]) {
    const lines = text.split("\n");
    assert.equal(lines.filter((line) => line === "begin;").length, 1);
    assert.equal(lines.filter((line) => line === "commit;").length, 1);
    assert.equal(text.trimEnd().split("\n").at(-1), "commit;");
    assert.equal(lines.find((line) => line.trim() && !line.startsWith("--")), "begin;");
  }
  assert.ok(RUNBOOK.includes(SPEC_SHA256), "RUNBOOK 에 원문 해시가 없다");
});

test("금지 문자열 0개(잠금 정규식·'x.y.z'·64자리 16진·naver), 리터럴 감사 통과, 최종 선언 5개, C 함수 18개는 다시 정의하지 않음", () => {
  const lockSource = fs.readFileSync(path.join(root, "scripts", "check-protected-rank-features.mjs"), "utf8");
  const declared = /const RANK_MIGRATION_PATTERN = \/(.+)\/([a-z]*);/.exec(lockSource);
  assert.ok(declared);
  const lockPattern = new RegExp(declared[1], declared[2]);
  for (const text of [sql, ROLLBACK]) {
    assert.equal(lockPattern.test(text), false);
    assert.equal(/'[0-9]+\.[0-9]+\.[0-9]+'/.test(text), false);
    assert.equal(/[0-9a-f]{64}/i.test(text), false);
    assert.equal(/naver/i.test(text), false);
  }
  const own = collectFinalFunctionDeclarations(migrationDirectory, [MANUAL_NAME]);
  assert.deepEqual(sorted(own.map((entry) => entry.function)), sorted(EXPECTED_FUNCTIONS.map((sig) => `public.${sig.split("(")[0]}`)));
  assert.ok(own.every((entry) => entry.hasBody));
  const audit = auditMigrationRuntimeLiterals({ migrationDirectory, files: [MANUAL_NAME], allowlist: [] });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.violations, []);
  const headers = [...sql.matchAll(/create or replace function public\.([a-z_]+)\(([\s\S]*?)\nas \$\$/g)];
  assert.equal(headers.length, 5);
  for (const [, name, header] of headers) {
    assert.ok(name.startsWith("coupang_rank_manual_"), name);
    assert.match(header, /\nsecurity definer\n/, `${name}: security definer`);
    assert.match(header, /\nset search_path = ''$/, `${name}: set search_path = ''`);
  }
});

test("독립: 쓰는 표는 coupang_rank_* 뿐이고 그 밖의 표는 읽지도 않는다", () => {
  const code = stripSqlComments(sql);
  const writes = [...code.matchAll(
    /\b(?:insert\s+into|update|delete\s+from|alter\s+table(?:\s+if\s+exists)?|truncate(?:\s+table)?|drop\s+table(?:\s+if\s+exists)?|create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+[a-z_]+\s+on|create\s+table\s+if\s+not\s+exists)\s+public\.([a-z0-9_]+)/gi,
  )].map((hit) => hit[1]);
  assert.ok(writes.length > 15);
  assert.deepEqual(writes.filter((name) => !name.startsWith("coupang_rank_")), []);
  const referenced = [...new Set([...code.matchAll(/\bpublic\.([a-z0-9_]+)/g)].map((hit) => hit[1]))]
    .filter((name) => !name.startsWith("coupang_rank_"));
  assert.deepEqual(referenced, []);
});

test("시간·상태 상수가 contract.mjs 와 같다(60초·150초·10분·5초·60일, 상태 이름, 요청 상태, 대표 결정 값)", () => {
  const claimBody = functionBody("coupang_rank_manual_claim");
  const summaryBody = functionBody("coupang_rank_manual_summary");
  const recordBody = functionBody("coupang_rank_manual_record");
  assert.ok(claimBody.includes(`interval '${MANUAL_CLAIM_TTL_SECONDS} seconds'`));
  assert.ok(claimBody.includes(`interval '${MANUAL_RECORD_MAX_AGE_MINUTES} minutes'`));
  assert.ok(claimBody.includes(`interval '${MANUAL_CLAIM_KEEP_DAYS} days'`));
  assert.ok(summaryBody.includes(`interval '${MANUAL_SEARCH_WINDOW_SECONDS} seconds'`));
  assert.ok(recordBody.includes(`interval '${MANUAL_SEARCH_WINDOW_SECONDS} seconds'`));
  assert.ok(recordBody.includes(`interval '${MANUAL_RECORD_MAX_AGE_MINUTES} minutes'`));
  assert.ok(recordBody.includes(`interval '${MANUAL_MIN_MEASURE_SECONDS} seconds'`));
  // 요청 TTL 은 간격보다 짧다(열린 요청이 끝나기 전에 다음 검색이 허락될 일이 없다)
  assert.ok(MANUAL_CLAIM_TTL_SECONDS < MANUAL_MIN_GAP_SECONDS && MANUAL_SEARCH_WINDOW_SECONDS < MANUAL_MIN_GAP_SECONDS);
  const states = [...summaryBody.matchAll(/then '([a-z_]+)'/g)].map((hit) => hit[1]);
  assert.deepEqual(sorted([...states, "ready", "setup_required"]), sorted(MANUAL_STATES));
  const statusCheck = /status in \(([^)]*)\)\)/.exec(sql.slice(sql.indexOf("create table if not exists public.coupang_rank_manual_claims")));
  assert.deepEqual([...statusCheck[1].matchAll(/'([a-z_]+)'/g)].map((hit) => hit[1]), [...MANUAL_CLAIM_STATUSES]);
  assert.ok(sql.includes(`manual_min_gap_seconds integer not null default ${MANUAL_MIN_GAP_SECONDS}`));
  assert.ok(sql.includes(`check (manual_min_gap_seconds between ${MANUAL_MIN_GAP_SECONDS} and 3600)`));
  assert.ok(sql.includes(`manual_max_per_day smallint not null default ${MANUAL_MAX_PER_DAY}`));
  assert.ok(sql.includes(`check (manual_max_per_day between 1 and ${MANUAL_MAX_PER_DAY})`));
  assert.ok(sql.includes(`manual_from_hour smallint not null default ${MANUAL_FROM_HOUR}`));
  assert.ok(sql.includes(`manual_to_hour smallint not null default ${MANUAL_TO_HOUR}`));
  // SQL 이 돌려주는 코드는 모두 4xx 계약 코드다
  const codes = [...new Set([...sql.matchAll(/'(COUPANG_[A-Z_]+)'/g)].map((hit) => hit[1]))];
  for (const code of codes) {
    const status = ERROR_HTTP_STATUS[code];
    assert.ok(Number.isInteger(status) && status >= 400 && status < 500, `${code} → ${status}`);
  }
  // 기본 중지 사유(blocked_page)는 중지 사유 목록 안에 있다
  assert.ok(MANUAL_STOP_CODES.includes("blocked_page"));
});

// ───────────────────────── 적용·되돌리기 ─────────────────────────

const CATALOG_SQL = String.raw`select
  (select string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef::text || '|' ||
     coalesce(array_to_string(p.proconfig, ','), ''), ';' order by 1) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'coupang\_rank\_%') as functions,
  (select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, ''), ';' order by table_name, column_name)
     from information_schema.columns where table_schema = 'public' and table_name like 'coupang\_rank\_%') as columns,
  (select string_agg(conname || ':' || pg_catalog.pg_get_constraintdef(oid), ';' order by conname)
     from pg_catalog.pg_constraint where conrelid::regclass::text like 'coupang\_rank\_%') as constraints,
  (select string_agg(indexname, ';' order by indexname) from pg_catalog.pg_indexes
    where schemaname = 'public' and tablename like 'coupang\_rank\_%') as indexes`;

test("다시 실행 안전: SQL0 → 수동 → 수동 → 수동 오류 0, 카탈로그 그대로, 값도 그대로", async () => {
  const db = await fresh();
  try {
    const first = (await db.query(CATALOG_SQL)).rows[0];
    await db.exec("update public.coupang_rank_settings set manual_enabled = true, manual_stopped_day = '2026-10-20', manual_stopped_code = 'blocked_text' where id = 1");
    await db.exec(sql);
    await db.exec(sql);
    const again = (await db.query(CATALOG_SQL)).rows[0];
    assert.deepEqual(again, first);
    const kept = (await db.query("select manual_enabled, manual_stopped_day::text as d, manual_stopped_code from public.coupang_rank_settings")).rows[0];
    assert.deepEqual(kept, { manual_enabled: true, d: "2026-10-20", manual_stopped_code: "blocked_text" });
  } finally {
    await db.close();
  }
});

test("확인문 기대값: false | 180 | 30 | 9 | 19 | 5 | 1 | 2", async () => {
  const db = await fresh();
  try {
    const row = (await db.query(CONFIRM_SQL)).rows[0];
    assert.deepEqual(
      [row.manual_enabled, row.manual_min_gap_seconds, row.manual_max_per_day, row.manual_from_hour, row.manual_to_hour,
        Number(row.fns), Number(row.claims_table), Number(row.run_cols)],
      [false, 180, 30, 9, 19, 5, 1, 2],
    );
    assert.ok(RUNBOOK.includes("false | 180 | 30 | 9 | 19 | 5 | 1 | 2"), "RUNBOOK 확인문 기대값");
  } finally {
    await db.close();
  }
});

test("되돌리기 SQL 두 번 → SQL0 직후 카탈로그와 같음(C 함수 18), 다시 적용 성공. C 표가 없어도 오류 없음", async () => {
  const base = await freshBase();
  const baseline = (await base.query(CATALOG_SQL)).rows[0];
  await base.close();
  const db = await fresh();
  try {
    await db.exec(ROLLBACK);
    await db.exec(ROLLBACK);
    assert.deepEqual((await db.query(CATALOG_SQL)).rows[0], baseline);
    const count = (await db.query("select count(*)::int as n from pg_catalog.pg_proc where proname like 'coupang\\_rank\\_%'")).rows[0].n;
    assert.equal(count, 18);
    await db.exec(sql);
    assert.equal(Number((await db.query(CONFIRM_SQL)).rows[0].fns), 5);
  } finally {
    await db.close();
  }
  const empty = new PGlite();
  try {
    await empty.exec(FIXTURE_SQL);
    await empty.exec(ROLLBACK);
  } finally {
    await empty.close();
  }
});

test("RUNBOOK 'C 완전 제거' SQL: 수동 SQL 뒤에도 C 표·함수 0개, 그 뒤 SQL0 + 수동 다시 설치", async () => {
  const section = RUNBOOK.slice(RUNBOOK.indexOf("### 완전 제거"));
  const block = /```sql\n([\s\S]*?)```/.exec(section);
  assert.ok(block, "RUNBOOK 완전 제거 SQL 블록");
  assert.ok(block[1].includes("coupang_rank_manual_claims"));
  const db = await fresh();
  try {
    await db.exec(block[1]);
    const left = (await db.query(String.raw`select
      (select count(*)::int from information_schema.tables where table_schema = 'public' and table_name like 'coupang\_rank\_%') as tables,
      (select count(*)::int from pg_catalog.pg_proc where proname like 'coupang\_rank\_%') as functions`)).rows[0];
    assert.deepEqual(left, { tables: 0, functions: 0 });
    await db.exec(baseSql);
    await db.exec(sql);
    assert.equal(Number((await db.query(CONFIRM_SQL)).rows[0].fns), 5);
  } finally {
    await db.close();
  }
});

// ───────────────────────── 권한·기본값·제약 ─────────────────────────

test("권한: 함수 5개 anon·authenticated 실행 불가·service_role 가능, 요청 표 RLS 켜짐·강제, anon 표 권한 없음", async () => {
  const db = await fresh();
  try {
    const rows = (await db.query(String.raw`select p.oid::regprocedure::text as sig,
        pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon,
        pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as auth,
        pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_catalog.pg_proc p where p.proname like 'coupang\_rank\_manual\_%' order by 1`)).rows;
    assert.deepEqual(rows.map((row) => row.sig.replace(/ /g, "")), sorted(EXPECTED_FUNCTIONS));
    for (const row of rows) assert.deepEqual([row.anon, row.auth, row.service], [false, false, true], row.sig);
    const table = (await db.query(`select c.relrowsecurity, c.relforcerowsecurity,
        pg_catalog.has_table_privilege('anon', c.oid, 'select') as anon_select,
        pg_catalog.has_table_privilege('authenticated', c.oid, 'insert') as auth_insert,
        pg_catalog.has_table_privilege('service_role', c.oid, 'update') as service_update
      from pg_catalog.pg_class c where c.relname = 'coupang_rank_manual_claims'`)).rows[0];
    assert.deepEqual(table, { relrowsecurity: true, relforcerowsecurity: true, anon_select: false, auth_insert: false, service_update: true });
  } finally {
    await db.close();
  }
});

test("기본값 false·180·30·9·19, 제약은 대표 결정보다 느슨한 값을 거절(179·3601·0·31·8시·20시·from ≥ to)", async () => {
  const db = await fresh();
  try {
    const row = (await db.query("select manual_enabled, manual_min_gap_seconds, manual_max_per_day, manual_from_hour, manual_to_hour, manual_last_search_at, manual_stopped_day from public.coupang_rank_settings")).rows[0];
    assert.deepEqual(row, {
      manual_enabled: false, manual_min_gap_seconds: 180, manual_max_per_day: 30, manual_from_hour: 9, manual_to_hour: 19,
      manual_last_search_at: null, manual_stopped_day: null,
    });
    for (const patch of [
      "manual_min_gap_seconds = 179", "manual_min_gap_seconds = 3601", "manual_max_per_day = 0", "manual_max_per_day = 31",
      "manual_from_hour = 8", "manual_to_hour = 20", "manual_from_hour = 15, manual_to_hour = 12", "manual_stopped_code = 'Bad Code'",
    ]) {
      await assert.rejects(db.exec(`update public.coupang_rank_settings set ${patch} where id = 1`), /violates check constraint/, patch);
    }
    // 더 엄격하게는 된다
    await db.exec("update public.coupang_rank_settings set manual_min_gap_seconds = 600, manual_max_per_day = 10, manual_from_hour = 10, manual_to_hour = 18 where id = 1");
    await assert.rejects(db.exec("insert into public.coupang_rank_runs (keyword_key, lease_until, source) values ('k', now(), 'robot')"), /violates check constraint/);
  } finally {
    await db.close();
  }
});

// ───────────────────────── 관문 ─────────────────────────

test("관문 순서: off → budget → stopped → cooldown(차단급만) → hours → busy → daily_cap → gap → ready", async () => {
  await withDb(async (db, h) => {
    await db.exec("update public.coupang_rank_settings set manual_enabled = false where id = 1");
    assert.equal((await h.summary()).state, "off");
    await db.exec("update public.coupang_rank_settings set manual_enabled = true, budget_blocked = true, budget_reason = 'storage' where id = 1");
    assert.equal((await h.summary()).state, "budget");
    await db.exec(`update public.coupang_rank_settings set budget_blocked = false, budget_reason = null,
      manual_stopped_day = (now() at time zone 'Asia/Seoul')::date where id = 1`);
    assert.equal((await h.summary()).state, "stopped");
    await db.exec("update public.coupang_rank_settings set manual_stopped_day = null, cooldown_until = now() + interval '1 hour', cooldown_reason = 'error_streak' where id = 1");
    assert.equal((await h.summary()).state, "ready", "연속 오류 쉬기(error_streak)는 수동 확인을 막지 않는다");
    await db.exec("update public.coupang_rank_settings set cooldown_reason = 'blocked' where id = 1");
    const cooling = await h.summary();
    assert.equal(cooling.state, "cooldown");
    assert.ok(cooling.cooldownUntil);
    await db.exec("update public.coupang_rank_settings set cooldown_until = null, cooldown_reason = null where id = 1");

    // 시간 밖: 지금 KST 시를 뺀 창(시가 바뀌어도 창 밖이다)
    const hour = Number((await h.one("select extract(hour from (now() at time zone 'Asia/Seoul'))::int as h")).h);
    const from = (hour + 2) % 24;
    await db.query("update public.coupang_rank_settings set manual_from_hour = $1, manual_to_hour = $2 where id = 1", [from, from + 1]);
    assert.equal((await h.summary()).state, "hours");
    await db.exec("update public.coupang_rank_settings set manual_from_hour = 0, manual_to_hour = 24 where id = 1");

    const tracker = await h.addTracker();
    const hash = h.token();
    const claimed = await h.claim(tracker, hash);
    assert.equal(claimed.ok, true);
    const busy = await h.summary();
    assert.equal(busy.state, "busy");
    assert.equal(Date.parse(busy.busyUntil), Date.parse(claimed.expiresAt), "확인 전 진행 중은 요청 기한까지");
    await h.verify(claimed.claimId, hash);
    const searching = await h.summary();
    assert.equal(searching.state, "busy");
    assert.equal(Date.parse(searching.busyUntil) - new Date((await h.claimRow(claimed.claimId)).verified_at).getTime(), MANUAL_SEARCH_WINDOW_SECONDS * 1000);
    await h.record(claimed.claimId, hash, { outcome: "lost", code: "extension_timeout" });
    assert.equal((await h.summary()).state, "busy", "응답 없음(lost)이어도 확인 뒤 150초는 검색 중으로 본다");
    await h.ageVerify(claimed.claimId, 151);
    const gap = await h.summary();
    assert.equal(gap.state, "gap");
    assert.equal(gap.usedToday, 1);
    await h.clearGap();
    assert.equal((await h.summary()).state, "ready");
    await db.exec("update public.coupang_rank_settings set manual_max_per_day = 1 where id = 1");
    assert.equal((await h.summary()).state, "daily_cap");
  });
});

test("간격은 실제 검색(확장 확인) 시각부터 서버 시계로 잰다: 요청 시각·화면 시계와 무관, 자동 임대가 더 늦으면 그것 기준", async () => {
  await withDb(async (db, h) => {
    // 요청만 방금 있었고 검색은 1시간 전 → 간격 아님
    await db.exec("update public.coupang_rank_settings set manual_last_claim_at = now(), manual_last_search_at = now() - interval '1 hour' where id = 1");
    assert.equal((await h.summary()).state, "ready");
    // 마지막 검색 179초 전 → gap, nextAt = 검색 + 180초
    await db.exec("update public.coupang_rank_settings set manual_last_search_at = now() - interval '179 seconds' where id = 1");
    const gap = await h.summary();
    assert.equal(gap.state, "gap");
    const settings = await h.settings();
    assert.equal(Date.parse(gap.nextAt) - new Date(settings.manual_last_search_at).getTime(), MANUAL_MIN_GAP_SECONDS * 1000);
    await db.exec("update public.coupang_rank_settings set manual_last_search_at = now() - interval '181 seconds' where id = 1");
    assert.equal((await h.summary()).state, "ready");
    // 자동 수집 임대가 더 늦으면 그것부터(같은 회선)
    await db.exec("update public.coupang_rank_settings set last_claim_at = now() - interval '10 seconds' where id = 1");
    assert.equal((await h.summary()).state, "gap");
    await h.clearGap();

    // 요청은 간격 안에서도 확인 시각이 기준: 검색 A 확인 → 결과 → 179초 뒤로 만든 상태에서 B 요청은 gap
    const tracker = await h.addTracker();
    const a = await h.verified(tracker);
    assert.equal((await h.record(a.claimId, a.hash, { status: "ok", run: okRun(organicList(3)) })).accepted, true);
    await db.query("update public.coupang_rank_settings set manual_last_search_at = now() - interval '179 seconds' where id = 1");
    const refused = await h.claim(tracker, h.token());
    assert.deepEqual([refused.ok, refused.state], [false, "gap"]);
  });
});

test("확인(verify)도 서버 시계로 관문을 다시 본다: 요청 뒤 간격·하루 상한·중지·끔이 생기면 거절하고 요청을 닫는다", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker();
    for (const [label, patch, state] of [
      ["gap", "manual_last_search_at = now() - interval '5 seconds'", "gap"],
      ["stopped", "manual_stopped_day = (now() at time zone 'Asia/Seoul')::date", "stopped"],
      ["off", "manual_enabled = false", "off"],
      ["cap", "manual_max_per_day = 1", null],
    ]) {
      await h.clearGap();
      await db.exec("update public.coupang_rank_settings set manual_enabled = true, manual_stopped_day = null, manual_max_per_day = 30 where id = 1");
      const hash = h.token();
      const claimed = await h.claim(tracker, hash);
      assert.equal(claimed.ok, true, label);
      if (label === "cap") {
        // 다른 요청이 그사이 검색을 1번 써서 하루 상한(1)에 닿은 경우
        await db.query(`insert into public.coupang_rank_manual_claims (token_sha256, keyword_key, search_text, requested_by, requested_role, expires_at, verified_at, status)
          values ($1, 'x', 'x', 'owner', 'owner', now(), now() - interval '10 seconds', 'recorded')`, [h.token()]);
        await db.exec(`update public.coupang_rank_settings set ${"manual_max_per_day = 1"} where id = 1`);
      } else {
        await db.exec(`update public.coupang_rank_settings set ${patch} where id = 1`);
      }
      const refused = await h.verify(claimed.claimId, hash);
      assert.equal(refused.ok, false, label);
      assert.equal(refused.state, state ?? "daily_cap", label);
      const row = await h.claimRow(claimed.claimId);
      assert.deepEqual([row.status, row.verified_at, row.outcome_code], ["cancelled", null, `verify_${state ?? "daily_cap"}`], label);
      await db.exec("delete from public.coupang_rank_manual_claims");
    }
  });
});

test("확인: 1회용·토큰·기한·추적기 — 두 번째는 CLAIM_USED, 남의 토큰 MISMATCH, 기한 지남 EXPIRED, 활성 추적기 없음 TRACKER_PAUSED", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker({ keyword: "Galaxy  필름" });
    await db.exec("insert into public.coupang_rank_keywords (keyword_key, search_text) values ('galaxy  필름', 'Galaxy  필름')");
    const hash = h.token();
    const claimed = await h.claim(tracker, hash);
    assert.equal(claimed.keyword, "Galaxy  필름");
    assert.equal(Date.parse(claimed.expiresAt) - Date.parse(claimed.serverTime), MANUAL_CLAIM_TTL_SECONDS * 1000);
    assert.equal((await h.verify(claimed.claimId, h.token())).code, "COUPANG_MANUAL_CLAIM_MISMATCH");
    assert.equal((await h.verify(claimed.claimId, hash, "team")).code, "COUPANG_MANUAL_CLAIM_MISMATCH");
    assert.equal((await h.verify(crypto.randomUUID(), hash)).code, "COUPANG_MANUAL_CLAIM_NOT_FOUND");
    assert.equal((await h.verify(claimed.claimId, "nothex")).code, "COUPANG_ACTION_INVALID");
    const ok = await h.verify(claimed.claimId, hash);
    assert.deepEqual([ok.ok, ok.verified, ok.claimId, ok.keyword, ok.keywordKey], [true, true, claimed.claimId, "Galaxy  필름", "galaxy  필름"]);
    const settings = await h.settings();
    assert.equal(new Date(settings.manual_last_search_at).toISOString(), new Date(ok.verifiedAt).toISOString());
    assert.equal(Date.parse(ok.recordUntil) - new Date((await h.claimRow(claimed.claimId)).claimed_at).getTime(), MANUAL_RECORD_MAX_AGE_MINUTES * 60000);
    assert.equal((await h.verify(claimed.claimId, hash)).code, "COUPANG_MANUAL_CLAIM_USED");

    await h.clearGap();
    await db.exec("delete from public.coupang_rank_manual_claims");
    const late = h.token();
    const lateClaim = await h.claim(tracker, late);
    await db.query("update public.coupang_rank_manual_claims set expires_at = now() - interval '1 second' where id = $1", [lateClaim.claimId]);
    assert.equal((await h.verify(lateClaim.claimId, late)).code, "COUPANG_MANUAL_CLAIM_EXPIRED");
    assert.deepEqual([(await h.claimRow(lateClaim.claimId)).status, (await h.claimRow(lateClaim.claimId)).outcome_code], ["expired", "verify_late"]);
    assert.equal((await h.verify(lateClaim.claimId, late)).code, "COUPANG_MANUAL_CLAIM_EXPIRED");

    const gone = h.token();
    const goneClaim = await h.claim(tracker, gone);
    await db.query("update public.coupang_rank_trackers set status = 'paused' where id = $1", [tracker]);
    assert.equal((await h.verify(goneClaim.claimId, gone)).code, "COUPANG_MANUAL_TRACKER_PAUSED");
    assert.equal((await h.claimRow(goneClaim.claimId)).status, "cancelled");
  });
});

test("요청 거절: 다른 범위 → TRACKER_NOT_FOUND, 일시중지 → TRACKER_PAUSED, 연결 끊긴 광고주 → INELIGIBLE, 토큰·역할 형식 → ACTION_INVALID", async () => {
  await withDb(async (db, h) => {
    const own = await h.addTracker();
    assert.equal((await h.claim(own, h.token(), { agency: "adv-x" })).code, "COUPANG_TRACKER_NOT_FOUND");
    const paused = await h.addTracker({ productId: "1111", status: "paused" });
    assert.equal((await h.claim(paused, h.token())).code, "COUPANG_MANUAL_TRACKER_PAUSED");
    const gone = await h.addClient("adv-gone", true);
    const ineligible = await h.addTracker({ agency: "adv-gone", clientId: gone, productId: "2222" });
    assert.equal((await h.claim(ineligible, h.token(), { agency: "adv-gone" })).code, "COUPANG_MANUAL_TRACKER_INELIGIBLE");
    assert.equal((await h.claim(own, "ABC")).code, "COUPANG_ACTION_INVALID");
    assert.equal((await h.claim(own, h.token(), { role: "robot" })).code, "COUPANG_ACTION_INVALID");
    assert.equal((await h.claim(own, h.token(), { by: "" })).code, "COUPANG_ACTION_INVALID");
    assert.equal(Number((await h.one("select count(*) as n from public.coupang_rank_manual_claims")).n), 0);
    // 꺼져 있으면 manual 칸과 함께 상태 거절
    await db.exec("update public.coupang_rank_settings set manual_enabled = false where id = 1");
    const off = await h.claim(own, h.token());
    assert.deepEqual([off.ok, off.state, off.manual.state], [false, "off", "off"]);
  });
});

test("하루 횟수 = 오늘 확장 확인을 받은 검색만(확인 전에 끝난 요청은 검색이 아니라 세지 않음), 30번째 뒤 daily_cap", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker();
    // 확인 전에 '시작 못 함'으로 끝난 요청 3개: 횟수·간격 모두 그대로
    for (let index = 0; index < 3; index += 1) {
      const hash = h.token();
      const claimed = await h.claim(tracker, hash);
      const result = await h.record(claimed.claimId, hash, { outcome: "not_started", code: "incognito_window_open" });
      assert.deepEqual([result.ok, result.accepted, result.counted], [true, false, false]);
      assert.equal((await h.claimRow(claimed.claimId)).status, "cancelled");
    }
    const after = await h.summary();
    assert.deepEqual([after.state, after.usedToday, after.lastSearchAt], ["ready", 0, null]);
    assert.equal(Number((await h.one("select count(*) as n from public.coupang_rank_runs")).n), 0);

    // 확인받은 검색 29개(어제 1개는 세지 않음) + 오늘 1개 더 = 30 → daily_cap
    await db.query(`insert into public.coupang_rank_manual_claims (token_sha256, keyword_key, search_text, requested_by, requested_role, claimed_at, expires_at, verified_at, status)
      select encode(sha256(convert_to('t' || g::text, 'UTF8')), 'hex'), 'k', 'k', 'owner', 'owner', now() - interval '2 seconds', now(), now() - interval '2 seconds', 'recorded'
        from generate_series(1, 29) g`);
    await db.query(`insert into public.coupang_rank_manual_claims (token_sha256, keyword_key, search_text, requested_by, requested_role, claimed_at, expires_at, verified_at, status)
      values ($1, 'k', 'k', 'owner', 'owner', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'recorded')`, [h.token()]);
    assert.equal((await h.summary()).usedToday, 29);
    const last = await h.verified(tracker);
    await h.record(last.claimId, last.hash, { status: "ok", run: okRun(organicList(2)) });
    await h.clearGap();
    const capped = await h.summary();
    assert.deepEqual([capped.state, capped.usedToday], ["daily_cap", 30]);
    assert.equal((await h.claim(tracker, h.token())).state, "daily_cap");
  });
});

// ───────────────────────── 결과 저장 ─────────────────────────

test("성공 기록: 회차 1줄(manual·수집기 없음·칸 0·검색 날짜·확인 시각·제목 뺀 목록), 같은 키워드 활성 추적기 모두 반영, 일시중지는 그대로", async () => {
  await withDb(async (db, h) => {
    const a = await h.addTracker({ productId: "8533720933" });
    const b = await h.addTracker({ agency: "adv-b", clientId: await h.addClient("adv-b"), productId: "4444" });
    const paused = await h.addTracker({ agency: "adv-c", clientId: await h.addClient("adv-c"), productId: "8533720933", status: "paused" });
    const job = await h.verified(a);
    const result = await h.record(job.claimId, job.hash, { status: "ok", run: okRun(organicList(12)), code: null });
    assert.deepEqual([result.ok, result.accepted, result.duplicate, result.status, result.matched, result.counted, result.stopped],
      [true, true, false, "ok", 2, true, false]);
    assert.deepEqual(result.tracker, {
      trackerId: a, result: "found", rank: 12, organicCount: 50, adOrder: null, checkedAt: result.tracker.checkedAt,
    });
    const run = await h.one("select * from public.coupang_rank_runs");
    const claim = await h.claimRow(job.claimId);
    assert.deepEqual(
      [run.source, run.collector_id, run.slot_index, run.slot_minute, run.status, run.requested_by, run.organic_count, run.ad_count, run.matched_count],
      ["manual", null, 0, 0, "ok", "owner", 50, 2, 2],
    );
    assert.equal(new Date(run.claimed_at).toISOString(), new Date(claim.verified_at).toISOString());
    const kstDay = (await h.one("select ((verified_at at time zone 'Asia/Seoul')::date)::text as d from public.coupang_rank_manual_claims where id = $1", [job.claimId])).d;
    assert.equal((await h.one("select slot_day::text as d from public.coupang_rank_runs")).d, kstDay);
    assert.equal(run.organic.some((item) => Object.hasOwn(item, "t")), false, "증거 목록에서 제목을 뺀다");
    assert.deepEqual([claim.status, claim.run_id], ["recorded", run.id]);
    const days = await h.all("select tracker_id, result, rank, slot_minute from public.coupang_rank_days order by result");
    assert.deepEqual(days.map((row) => [row.tracker_id, row.result, row.rank, row.slot_minute]), [[a, "found", 12, 0], [b, "out", null, 0]]);
    assert.equal(Number((await h.one("select count(*) as n from public.coupang_rank_snapshots where tracker_id = $1", [paused])).n), 0);
    const pausedRow = await h.one("select current_result, last_checked_at from public.coupang_rank_trackers where id = $1", [paused]);
    assert.deepEqual(pausedRow, { current_result: null, last_checked_at: null });
  });
});

test("같은 날 두 번째 성공은 같은 일별 칸을 최신 값으로(success_count 2, best_rank 최소), 같은 보고 다시 보내기는 duplicate", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker();
    const first = await h.verified(tracker);
    await h.record(first.claimId, first.hash, { status: "ok", run: okRun(organicList(8)) });
    await h.clearGap();
    const second = await h.verified(tracker);
    await h.record(second.claimId, second.hash, { status: "ok", run: okRun(organicList(15)) });
    const day = await h.one("select result, rank, success_count, best_rank from public.coupang_rank_days");
    assert.deepEqual(day, { result: "found", rank: 15, success_count: 2, best_rank: 8 });
    const again = await h.record(second.claimId, second.hash, { status: "ok", run: okRun(organicList(3)) });
    assert.deepEqual([again.ok, again.accepted, again.duplicate, again.status], [true, false, true, "ok"]);
    assert.equal(Number((await h.one("select count(*) as n from public.coupang_rank_snapshots")).n), 2);
    assert.equal((await h.one("select success_count from public.coupang_rank_days")).success_count, 2);
  });
});

test("꾸민 결과 막기: 확장 확인 없는 요청의 측정은 NOT_VERIFIED, 확인 뒤 5초 안의 목록 결과는 RECORD_INVALID(timing), 남의 토큰은 MISMATCH", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker();
    const hash = h.token();
    const claimed = await h.claim(tracker, hash);
    const forged = await h.record(claimed.claimId, hash, { status: "ok", run: okRun(organicList(1)) });
    assert.deepEqual([forged.ok, forged.code, forged.stopped], [false, "COUPANG_MANUAL_CLAIM_NOT_VERIFIED", false]);
    assert.deepEqual([(await h.claimRow(claimed.claimId)).status, (await h.claimRow(claimed.claimId)).outcome_code], ["cancelled", "not_verified"]);
    assert.equal(Number((await h.one("select count(*) as n from public.coupang_rank_runs")).n), 0);

    await db.exec("delete from public.coupang_rank_manual_claims");
    const fastHash = h.token();
    const fast = await h.claim(tracker, fastHash);
    await h.verify(fast.claimId, fastHash);
    for (const status of ["ok", "noresult", "partial", "empty"]) {
      const result = await h.record(fast.claimId, fastHash, { status, run: okRun(organicList(1)) });
      assert.deepEqual([result.ok, result.code, result.field], [false, "COUPANG_MANUAL_RECORD_INVALID", "timing"], status);
    }
    assert.equal((await h.claimRow(fast.claimId)).status, "verified", "빠른 결과는 요청을 닫지 않는다");
    assert.equal((await h.record(fast.claimId, h.token(), { status: "ok", run: okRun(organicList(1)) })).code, "COUPANG_MANUAL_CLAIM_MISMATCH");
    assert.equal((await h.record(fast.claimId, fastHash, { status: "ok", run: okRun(organicList(1)), by: "team" })).code, "COUPANG_MANUAL_CLAIM_MISMATCH");
    // 차단·시간 초과 같은 빠른 실패는 5초 안이어도 받는다
    const quickFail = await h.record(fast.claimId, fastHash, { status: "timeout", run: { ...blockedRun(200), errorCode: "page_timeout" } });
    assert.deepEqual([quickFail.ok, quickFail.accepted, quickFail.status, quickFail.errorCode], [true, true, "timeout", "page_timeout"]);
    assert.equal((await h.record(crypto.randomUUID(), fastHash, { status: "ok", run: okRun([]) })).code, "COUPANG_MANUAL_CLAIM_NOT_FOUND");
    assert.equal((await h.record(fast.claimId, fastHash, { outcome: "done" })).field, "outcome");
    assert.equal((await h.record(fast.claimId, fastHash, { status: "leased", run: okRun([]) })).field, "status");
    assert.equal((await h.record(fast.claimId, fastHash, { status: "error", run: okRun([]), stopCode: "Bad" })).field, "stopCode");
  });
});

test("시작 못 함·응답 없음: 확인 전이면 cancelled(횟수·간격 그대로), 확인 뒤 lost 는 늦게 온 측정을 10분 안 받는다", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker();
    const job = await h.verified(tracker);
    const lost = await h.record(job.claimId, job.hash, { outcome: "lost", code: "extension_timeout" });
    assert.deepEqual([lost.ok, lost.accepted, lost.duplicate, lost.counted], [true, false, false, true]);
    assert.equal((await h.claimRow(job.claimId)).status, "lost");
    const lostAgain = await h.record(job.claimId, job.hash, { outcome: "lost", code: "extension_timeout" });
    assert.equal(lostAgain.duplicate, true);
    const late = await h.record(job.claimId, job.hash, { status: "ok", run: okRun(organicList(5)) });
    assert.deepEqual([late.ok, late.accepted, late.status], [true, true, "ok"]);
    assert.equal((await h.claimRow(job.claimId)).status, "recorded");
    assert.equal((await h.one("select late from public.coupang_rank_runs")).late, false);

    // 확인 뒤 '시작 못 함'(창 만들기 실패 등)은 횟수에 센다(창이 생겼을 수 있다)
    await h.clearGap();
    const second = await h.verified(tracker);
    const notStarted = await h.record(second.claimId, second.hash, { outcome: "not_started", code: "window_create_failed" });
    assert.deepEqual([notStarted.accepted, notStarted.counted], [false, true]);
    assert.equal((await h.claimRow(second.claimId)).status, "cancelled");
    const closed = await h.record(second.claimId, second.hash, { status: "ok", run: okRun(organicList(5)) });
    assert.equal(closed.code, "COUPANG_MANUAL_CLAIM_CLOSED");
  });
});

// ───────────────────────── 그날 중지 ─────────────────────────

test("차단 → 그날(KST) 전체 중지: 사유·회차 id, 성공 없는 칸은 failed·성공 칸은 그대로, 내일이면 다시 ready", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker();
    const success = await h.verified(tracker);
    await h.record(success.claimId, success.hash, { status: "ok", run: okRun(organicList(4)) });
    const other = await h.addTracker({ keyword: "케이스", productId: "5555" });
    await h.clearGap();
    const blockedOther = await h.verified(other);
    const result = await h.record(blockedOther.claimId, blockedOther.hash, { status: "blocked", run: blockedRun(403), stopCode: "blocked_http_403" });
    assert.deepEqual([result.ok, result.accepted, result.status, result.stopped, result.stopCode], [true, true, "blocked", true, "blocked_http_403"]);
    const settings = await h.settings();
    const run = await h.one("select id from public.coupang_rank_runs where status = 'blocked'");
    assert.equal(settings.manual_stopped_run_id, run.id);
    assert.equal(settings.manual_stopped_code, "blocked_http_403");
    assert.equal((await h.summary()).state, "stopped");
    assert.equal((await h.one("select result from public.coupang_rank_days where tracker_id = $1", [other])).result, "failed");
    assert.equal((await h.one("select result from public.coupang_rank_days where tracker_id = $1", [tracker])).result, "found");
    // 수동 차단은 자동 쉬기·키워드 일정을 건드리지 않는다
    assert.equal(settings.cooldown_until, null);
    assert.equal(Number((await h.one("select count(*) as n from public.coupang_rank_cooldowns")).n), 0);
    // 같은 날 두 번째 차단은 처음 사유를 남긴다
    await db.exec("update public.coupang_rank_settings set manual_stopped_day = (now() at time zone 'Asia/Seoul')::date where id = 1");
    assert.equal((await h.stop(blockedOther.claimId, blockedOther.hash, "blocked_text")).stopped, true);
    assert.equal((await h.settings()).manual_stopped_code, "blocked_http_403");
    // 어제 중지면 오늘은 다시 된다(D2: 대표가 푸는 버튼 없이 다음 날 자동)
    await db.exec("update public.coupang_rank_settings set manual_stopped_day = manual_stopped_day - 1 where id = 1");
    await h.clearGap();
    assert.equal((await h.summary()).state, "ready");
    // 확장이 차단만 알린 경우(blocked 인데 사유 없음)도 blocked_page 로 중지
    const plain = await h.verified(tracker);
    const noCode = await h.record(plain.claimId, plain.hash, { status: "blocked", run: blockedRun(200) });
    assert.deepEqual([noCode.stopped, noCode.stopCode], [true, "blocked_page"]);
  });
});

test("차단 신호는 어느 갈래에서든 중지를 건다: 중복·끝난 요청·10분 지난 보고·확인 없음·시작 못 함(blocked_today)·직접 알림(stop)", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker();
    const today = async () => (await h.settings()).manual_stopped_day !== null;
    const reset = async () => {
      await db.exec("update public.coupang_rank_settings set manual_stopped_day = null, manual_stopped_code = null, manual_stopped_run_id = null where id = 1");
      await db.exec("update public.coupang_rank_manual_claims set verified_at = verified_at - interval '1 hour', claimed_at = claimed_at - interval '1 hour' where verified_at is not null");
      await db.exec("update public.coupang_rank_manual_claims set status = 'expired' where status = 'open'");
      await h.clearGap();
    };

    // ① 이미 저장한 성공 요청에 차단 보고가 다시 옴(중복) → 중지
    const dup = await h.verified(tracker);
    await h.record(dup.claimId, dup.hash, { status: "ok", run: okRun(organicList(2)) });
    const dupStop = await h.record(dup.claimId, dup.hash, { status: "blocked", run: blockedRun(429), stopCode: "blocked_http_429" });
    assert.deepEqual([dupStop.duplicate, dupStop.stopped], [true, true]);
    assert.equal(await today(), true);
    await reset();

    // ② '시작 못 함'으로 닫힌 요청에 측정 차단 → CLOSED + 중지
    const closed = await h.verified(tracker);
    await h.record(closed.claimId, closed.hash, { outcome: "not_started", code: "window_create_failed" });
    const closedStop = await h.record(closed.claimId, closed.hash, { status: "blocked", run: blockedRun(403), stopCode: "blocked_http_403" });
    assert.deepEqual([closedStop.code, closedStop.stopped], ["COUPANG_MANUAL_CLAIM_CLOSED", true]);
    await reset();

    // ③ 10분 넘은 보고 → EXPIRED(late_record) + 중지, 회차는 저장하지 않음
    const late = await h.verified(tracker);
    await db.query("update public.coupang_rank_manual_claims set claimed_at = now() - interval '11 minutes' where id = $1", [late.claimId]);
    const lateStop = await h.record(late.claimId, late.hash, { status: "blocked", run: blockedRun(503), stopCode: "blocked_http_503" });
    assert.deepEqual([lateStop.code, lateStop.stopped], ["COUPANG_MANUAL_CLAIM_EXPIRED", true]);
    assert.deepEqual([(await h.claimRow(late.claimId)).status, (await h.claimRow(late.claimId)).outcome_code], ["expired", "late_record"]);
    assert.equal(Number((await h.one("select count(*) as n from public.coupang_rank_runs where status = 'blocked'")).n), 0);
    // 10분 넘은 성공 보고는 중지 없이 EXPIRED
    const lateOk = await h.record(late.claimId, late.hash, { status: "ok", run: okRun(organicList(2)) });
    assert.equal(lateOk.code, "COUPANG_MANUAL_CLAIM_EXPIRED");
    await reset();

    // ④ 확인 없는 요청에 차단 보고 → NOT_VERIFIED + 중지(더 엄격하게만)
    const unverifiedHash = h.token();
    const unverified = await h.claim(tracker, unverifiedHash);
    const unverifiedStop = await h.record(unverified.claimId, unverifiedHash, { status: "blocked", run: blockedRun(403), stopCode: "blocked_http_403" });
    assert.deepEqual([unverifiedStop.code, unverifiedStop.stopped], ["COUPANG_MANUAL_CLAIM_NOT_VERIFIED", true]);
    await reset();

    // ⑤ 확장이 '오늘 차단을 봤다'(not_started blocked_today) → 중지(extension_reported)
    const reportedHash = h.token();
    const reported = await h.claim(tracker, reportedHash);
    const reportedStop = await h.record(reported.claimId, reportedHash, { outcome: "not_started", code: "blocked_today", stopCode: "extension_reported" });
    assert.deepEqual([reportedStop.ok, reportedStop.stopped, reportedStop.counted], [true, true, false]);
    assert.equal((await h.settings()).manual_stopped_code, "extension_reported");
    await reset();

    // ⑥ 직접 알림(GET view=manual-stop 이 부르는 함수): 토큰이 맞을 때만, 확인 시각의 날짜로
    const direct = await h.verified(tracker);
    assert.equal((await h.stop(direct.claimId, h.token(), "page_unreadable")).code, "COUPANG_MANUAL_CLAIM_MISMATCH");
    assert.equal(await today(), false);
    assert.equal((await h.stop(direct.claimId, direct.hash, "Bad Code")).code, "COUPANG_ACTION_INVALID");
    const directStop = await h.stop(direct.claimId, direct.hash, "page_unreadable");
    assert.deepEqual([directStop.ok, directStop.stopped, directStop.stopCode, directStop.manual.state], [true, true, "page_unreadable", "stopped"]);
    assert.equal((await h.claimRow(direct.claimId)).stop_applied, true);
    assert.equal((await h.claimRow(direct.claimId)).status, "verified", "알림은 요청을 닫지 않는다(결과 보고가 뒤따른다)");
    // 이어서 온 결과 보고는 그대로 저장되고 같은 날 중지 사유는 처음 것
    const followed = await h.record(direct.claimId, direct.hash, { status: "blocked", run: { ...blockedRun(200), errorCode: "page_unreadable", finalHost: "" }, stopCode: "page_unreadable" });
    assert.deepEqual([followed.accepted, followed.stopped], [true, true]);
    const run = await h.one("select id from public.coupang_rank_runs where status = 'blocked'");
    assert.equal((await h.settings()).manual_stopped_run_id, run.id, "같은 날 중지에 회차 id 를 채운다");
  });
});

test("광고만 있고 일반 0개(empty)·쿠팡 안 다른 쪽(unsupported)은 중지가 아니다", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker();
    const job = await h.verified(tracker);
    const empty = await h.record(job.claimId, job.hash, { status: "empty", run: okRun([], [{ p: "7000001", v: "", s: 1 }]) });
    assert.deepEqual([empty.accepted, empty.status, empty.stopped], [true, "empty", false]);
    assert.equal((await h.settings()).manual_stopped_day, null);
    assert.equal((await h.one("select result from public.coupang_rank_days")).result, "failed");
    await h.clearGap();
    const moved = await h.verified(tracker);
    const unsupported = await h.record(moved.claimId, moved.hash, { status: "unsupported", run: { ...okRun([]), finalPath: "/np/campaigns/1" } });
    assert.deepEqual([unsupported.accepted, unsupported.stopped], [true, false]);
    assert.equal((await h.summary()).state, "gap");
  });
});

// ───────────────────────── 정리·자동 경로 ─────────────────────────

test("정리: 다음 요청 때 확인 없이 기한 지난 요청 → expired(no_verify), 확인 뒤 10분 결과 없음 → expired(no_record), 60일 지난 줄 삭제(500개씩)", async () => {
  await withDb(async (db, h) => {
    const tracker = await h.addTracker();
    const openHash = h.token();
    const open = await h.claim(tracker, openHash);
    await db.query("update public.coupang_rank_manual_claims set expires_at = now() - interval '1 second', claimed_at = now() - interval '2 minutes' where id = $1", [open.claimId]);
    const job = await h.verified(tracker);
    await db.query("update public.coupang_rank_manual_claims set claimed_at = now() - interval '11 minutes', verified_at = now() - interval '11 minutes' where id = $1", [job.claimId]);
    await db.query(`insert into public.coupang_rank_manual_claims (token_sha256, keyword_key, search_text, requested_by, requested_role, claimed_at, expires_at, status)
      select encode(sha256(convert_to('old' || g::text, 'UTF8')), 'hex'), 'k', 'k', 'owner', 'owner', now() - interval '61 days', now() - interval '61 days', 'expired'
        from generate_series(1, 502) g`);
    await h.clearGap();
    const next = await h.claim(tracker, h.token());
    assert.equal(next.ok, true);
    assert.deepEqual([(await h.claimRow(open.claimId)).status, (await h.claimRow(open.claimId)).outcome_code], ["expired", "no_verify"]);
    assert.deepEqual([(await h.claimRow(job.claimId)).status, (await h.claimRow(job.claimId)).outcome_code], ["expired", "no_record"]);
    assert.equal(Number((await h.one("select count(*) as n from public.coupang_rank_manual_claims where claimed_at < now() - interval '60 days'")).n), 2);
  });
});

test("자동 경로 무변경: 수동 SQL 뒤에도 수집기 claim → record 그대로, 자동 회차 source = collector, 수동 기록은 키워드 일정을 바꾸지 않는다", async () => {
  await withDb(async (db, h) => {
    const col = await h.one("insert into public.coupang_rank_collectors (token_sha256, token_hint) values (repeat('a', 64), 'abcd') returning id");
    await db.exec(`update public.coupang_rank_settings set enabled = true, active_from_hour = 0, active_to_hour = 24,
      checks_per_day = 2, min_gap_seconds = 30, gap_jitter_seconds = 0`);
    const tracker = await h.addTracker();
    await db.exec(`update public.coupang_rank_keywords set next_due_at = now() - interval '1 minute', slot_ends_at = now() + interval '3 hours'`);
    const auto = (await h.one("select public.coupang_rank_claim($1) as j", [col.id])).j;
    if (auto.state !== "job") {
      // 칸 계획이 아직 없으면 한 번 더(SQL0 의 보충·재계획이 첫 claim 에서 돈다)
      await db.exec(`update public.coupang_rank_settings set next_claim_not_before = null; update public.coupang_rank_collectors set last_claim_at = null;
        update public.coupang_rank_keywords set next_due_at = now() - interval '1 minute', slot_ends_at = now() + interval '3 hours'`);
    }
    const job = auto.state === "job" ? auto : (await h.one("select public.coupang_rank_claim($1) as j", [col.id])).j;
    assert.equal(job.state, "job", JSON.stringify(job));
    assert.equal((await h.one("select source from public.coupang_rank_runs where id = $1", [job.runId])).source, "collector");
    const recorded = (await h.one("select public.coupang_rank_record($1, $2, $3, $4, $5) as j",
      [job.runId, col.id, job.keywordKey, "ok", JSON.stringify(okRun(organicList(9)))])).j;
    assert.deepEqual([recorded.ok, recorded.accepted, recorded.matched], [true, true, 1]);

    const keywordBefore = await h.one("select next_due_at, slot_index, consecutive_failures, last_status, last_run_at from public.coupang_rank_keywords");
    await db.exec("update public.coupang_rank_settings set manual_last_search_at = now() - interval '1 hour', last_claim_at = now() - interval '1 hour' where id = 1");
    const manual = await h.verified(tracker);
    await h.record(manual.claimId, manual.hash, { status: "error", run: { ...blockedRun(500), errorCode: "page_load_failed" } });
    assert.deepEqual(await h.one("select next_due_at, slot_index, consecutive_failures, last_status, last_run_at from public.coupang_rank_keywords"), keywordBefore);
    const settings = await h.settings();
    assert.deepEqual([settings.error_streak, settings.empty_streak, settings.cooldown_until], [0, 0, null]);
  });
});

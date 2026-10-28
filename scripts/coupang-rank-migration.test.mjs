// C 30일 순위(쿠팡) 마이그레이션 검사(명세 v3 §4.7, WP1).
// 원문 PGlite 검증 스크립트(check-v3.mjs 18항목)를 node:test 로 옮기고, §3 공유 계약(contract.mjs)과
// SQL 의 열거값·상한이 같은지도 함께 본다. 운영 DB 에는 접속하지 않는다(PGlite 메모리 DB만 쓴다).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import {
  ADS_MAX,
  BLOCKING_COOLDOWN_REASONS,
  BUDGET_REASONS,
  CLAIM_THROTTLE_MAX_SECONDS,
  CLAIM_WAIT_REASONS,
  COOLDOWN_REASONS,
  DAY_RESULTS,
  DEFAULT_GROUP,
  DEFAULT_WINDOW_MODE,
  ERROR_HTTP_STATUS,
  FIRST_CHECKS,
  GROUP_MAX,
  KEYWORD_MAX,
  LEASE_SECONDS,
  ORGANIC_MAX,
  PLATFORMS,
  RANK_TOP,
  RECORD_FINAL_CODES,
  RECORD_MAX_AGE_MINUTES,
  RELEASE_REASONS,
  RUN_STATUSES,
  SLOT_MAX,
  SNAPSHOT_RESULTS,
  SUCCESS_RUN_STATUSES,
  TITLE_MAX,
  TRACKER_STATUSES,
  WINDOW_MODES,
} from "../src/server/coupang-rank/contract.mjs";
import { PRIMARY_AGENCY_CODE } from "../src/server/owner-identity.mjs";
import {
  auditMigrationRuntimeLiterals,
  collectFinalFunctionDeclarations,
  stripSqlComments,
} from "./migration-runtime-literal-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");
const MIGRATION_NAME = "20261017090000_coupang_rank_tracking.sql";
const sql = fs.readFileSync(path.join(migrationDirectory, MIGRATION_NAME), "utf8");

// 원문 해시(1,261줄, 65,809바이트). 명세 v3 머리말·§4.5 의 해시(1eec1bac…3b07e, 1,251줄, 64,719바이트)에
// 통합 검토 2026-10-16 고침 2건(claim 의 지금 하루 횟수에 없는 칸 재계획, after_activate 잠금 순서)을 더한 것이다.
// 그래서 명세 사본(~/.config/momentinsight/c30/v3/)과는 이제 다르다. 원문을 바꾸면 이 값과 docs/sql 사본을 함께 고친다.
const SPEC_SHA256 = "362b0fb5d111d5f339e5bc66be33d6760a0081647e49a95f34356458bf23a67c";
const DOCS_COPY = path.join(root, "docs", "sql", "c30-1-tables.sql");

// 명세 §4.3 함수 18개(§10.5 제거 SQL 의 서명과 같다).
const EXPECTED_FUNCTIONS = [
  "coupang_rank_after_activate(uuid)",
  "coupang_rank_apply_cooldown(text,uuid)",
  "coupang_rank_apply_success(uuid,uuid,jsonb,jsonb)",
  "coupang_rank_claim(uuid)",
  "coupang_rank_housekeeping()",
  "coupang_rank_limit_status(text,text)",
  "coupang_rank_mark_failed(uuid,text)",
  "coupang_rank_match(jsonb,jsonb,text,text,boolean)",
  "coupang_rank_note_error(uuid)",
  "coupang_rank_plan_next(text,timestamp with time zone,boolean)",
  "coupang_rank_record(uuid,uuid,text,text,jsonb)",
  "coupang_rank_release(uuid,uuid,text)",
  "coupang_rank_replan_all()",
  "coupang_rank_reschedule_failure(text,uuid,text)",
  "coupang_rank_reschedule_success(text,uuid,text)",
  "coupang_rank_stats()",
  "coupang_rank_tracker_is_eligible(uuid,text)",
  "coupang_rank_tracker_limit_guard()",
];
const EXPECTED_TABLES = [
  "coupang_rank_account_limits",
  "coupang_rank_collectors",
  "coupang_rank_cooldowns",
  "coupang_rank_days",
  "coupang_rank_keywords",
  "coupang_rank_runs",
  "coupang_rank_settings",
  "coupang_rank_snapshots",
  "coupang_rank_trackers",
];

// 명세 §4.6 대표 SQL 실행 뒤 확인문(원문).
const CONFIRM_SQL = String.raw`select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name like 'coupang\_rank\_%') as tables,        -- 9
  (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'coupang\_rank\_%') as functions,          -- 18
  (select enabled from public.coupang_rank_settings where id = 1) as enabled,             -- false
  (select window_mode from public.coupang_rank_settings where id = 1) as window_mode,     -- offscreen
  (select keyword_limit from public.coupang_rank_account_limits where agency_code = 'mml93-a01') as owner_limit; -- 100`;

// 명세 §10.4 일별 칸 재생성(원문).
const DAYS_REBUILD_SQL = `insert into public.coupang_rank_days (
  tracker_id, kst_day, slot_minute, slot_index, result, rank, organic_count, ad_order, checked_at,
  success_count, failure_count, best_rank)
select distinct on (s.tracker_id, s.kst_day, s.slot_minute)
  s.tracker_id, s.kst_day, s.slot_minute, s.slot_index, s.result, s.rank, s.organic_count, s.ad_order, s.checked_at,
  count(*) over w, 0, min(s.rank) over w
from public.coupang_rank_snapshots s
window w as (partition by s.tracker_id, s.kst_day, s.slot_minute)
order by s.tracker_id, s.kst_day, s.slot_minute, s.checked_at desc
on conflict (tracker_id, kst_day, slot_minute) do nothing;`;

// 명세 §10.5 C 완전 제거 SQL(원문).
const DROP_SQL = `begin;
drop table if exists
  public.coupang_rank_days, public.coupang_rank_snapshots, public.coupang_rank_runs,
  public.coupang_rank_keywords, public.coupang_rank_trackers, public.coupang_rank_collectors,
  public.coupang_rank_account_limits, public.coupang_rank_cooldowns, public.coupang_rank_settings cascade;
drop function if exists
  public.coupang_rank_stats(), public.coupang_rank_housekeeping(), public.coupang_rank_release(uuid, uuid, text),
  public.coupang_rank_record(uuid, uuid, text, text, jsonb), public.coupang_rank_claim(uuid), public.coupang_rank_replan_all(),
  public.coupang_rank_after_activate(uuid), public.coupang_rank_limit_status(text, text), public.coupang_rank_tracker_limit_guard(),
  public.coupang_rank_reschedule_success(text, uuid, text), public.coupang_rank_reschedule_failure(text, uuid, text),
  public.coupang_rank_note_error(uuid), public.coupang_rank_apply_cooldown(text, uuid), public.coupang_rank_mark_failed(uuid, text),
  public.coupang_rank_apply_success(uuid, uuid, jsonb, jsonb), public.coupang_rank_match(jsonb, jsonb, text, text, boolean),
  public.coupang_rank_plan_next(text, timestamptz, boolean), public.coupang_rank_tracker_is_eligible(uuid, text);
commit;`;

// PGlite 준비(§4.7): Supabase 역할 3개, set_updated_at(), 읽기만 하는 두 표의 최소 모양.
// clients.status 는 운영과 같은 enum(public.client_status), operation_team_codes.status 는 운영과 같은 text+check.
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

function functionBody(name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} 선언이 없다`);
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  return sql.slice(open + 2, close);
}

function quotedValues(text, pattern) {
  return [...text.matchAll(pattern)].map((hit) => hit[1]);
}

const sorted = (list) => [...list].sort();
const uniqueSorted = (list) => [...new Set(list)].sort();

async function fresh() {
  const db = new PGlite();
  await db.exec(FIXTURE_SQL);
  await db.exec(sql);
  return db;
}

async function withDb(fn) {
  const db = await fresh();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

function helpers(db) {
  return {
    one: async (query, params = []) => (await db.query(query, params)).rows[0],
    all: async (query, params = []) => (await db.query(query, params)).rows,
  };
}

// 시나리오는 실제 시계(now())로 돈다. KST 칸 경계(하루 2회 00·12시, 하루 3회 08·16시) 60초 안에서는
// 첫 측정이 다음 칸으로 계획되고, 자정을 넘으면 '다음 날' 비교가 어긋난다. 경계 90초 안에서 시작하면
// 경계가 지날 때까지 기다린다(하루 6분 구간, 최대 92초 대기). 시나리오 하나는 2초 안에 끝난다.
async function awayFromSlotBoundary() {
  const MARGIN_MS = 90_000;
  const msOfKstDay = (Date.now() + 9 * 3_600_000) % 86_400_000;
  const next = [8, 12, 16, 24].map((hour) => hour * 3_600_000).find((boundary) => boundary > msOfKstDay);
  const wait = next - msOfKstDay;
  if (wait < MARGIN_MS) await new Promise((resolve) => setTimeout(resolve, wait + 2_000));
}

// 공용 시나리오 바탕: 수집기 1대, 켜짐, 0~24시, 하루 2회, 간격 30초(흔들기 0).
async function base(db) {
  await awayFromSlotBoundary();
  const h = helpers(db);
  const col = await h.one(
    "insert into public.coupang_rank_collectors (token_sha256, token_hint) values (repeat('a', 64), 'abcd') returning id",
  );
  await db.exec(`update public.coupang_rank_settings set enabled = true, active_from_hour = 0, active_to_hour = 24,
    checks_per_day = 2, min_gap_seconds = 30, gap_jitter_seconds = 0`);
  // 빈도 조절·간격을 비운 뒤 부른다(연속 claim 시험용, §4.7).
  const claim = async () => {
    await db.exec(`update public.coupang_rank_settings set next_claim_not_before = null;
      update public.coupang_rank_collectors set last_claim_at = null`);
    return (await h.one("select public.coupang_rank_claim($1) as j", [col.id])).j;
  };
  // 아무것도 비우지 않고 그대로 부른다(간격·빈도 조절 시험용).
  const claimRaw = async () => (await h.one("select public.coupang_rank_claim($1) as j", [col.id])).j;
  const record = async (run, status, body) => (await h.one(
    "select public.coupang_rank_record($1, $2, $3, $4, $5) as j",
    [run.runId, col.id, run.keywordKey, status, JSON.stringify(body || {})],
  )).j;
  const addClient = async (agencyCode) => (await h.one(
    "insert into public.clients (name, agency_code) values ($1, $2) returning id",
    [`광고주 ${agencyCode}`, agencyCode],
  )).id;
  const addTracker = async (agency, keyword, productId, clientId = null, vendor = null) => (await h.one(
    `insert into public.coupang_rank_trackers (agency_code, client_id, keyword, keyword_key, product_id, product_url, vendor_item_id)
     values ($1, $2, $3, lower($3), $4, 'https://www.coupang.com/vp/products/' || $4, $5) returning id`,
    [agency, clientId, keyword, productId, vendor],
  )).id;
  // 키워드를 지금 잴 수 있게 만든다(칸 끝은 3시간 뒤라 20분 재시도 갈래가 시각과 무관하게 정해진다).
  const due = async (keywordKey) => db.query(
    `update public.coupang_rank_keywords set next_due_at = now() - interval '1 minute', slot_ends_at = now() + interval '3 hours',
       slot_attempts = 0, lease_run_id = null where keyword_key = $1`,
    [keywordKey],
  );
  const expire = async (runId) => db.query(
    "update public.coupang_rank_runs set lease_until = now() - interval '1 second' where id = $1",
    [runId],
  );
  const settings = async () => h.one("select * from public.coupang_rank_settings where id = 1");
  return { ...h, col, claim, claimRaw, record, addClient, addTracker, due, expire, settings };
}

// 일반 n개(위치 s 는 광고 2칸 뒤부터). hitAt 번째(1부터)에 대상 상품을 넣는다.
function organicList(hitAt, productId = "8533720933", count = 50) {
  const list = Array.from({ length: count }, (_, index) => ({ p: String(9000000 + index), v: "", s: index + 3 }));
  if (hitAt) list[hitAt - 1] = { p: productId, v: "96009802650", s: hitAt + 2, t: "아이쉘 360도 필름" };
  return list;
}

function okBody(organic, ads = []) {
  return {
    httpStatus: 200, loginWall: true, stable: true, itemCount: organic.length + ads.length, organic, ads,
    finalHost: "www.coupang.com", finalPath: "/np/search", durationMs: 14000, collectorVersion: "1.0.0", browser: "edge 141",
  };
}

// n=2, 0~24시: 칸 시작 분은 0번 칸 0, 1번 칸 720.
const minuteOfSlot = (slotIndex) => (slotIndex === 0 ? 0 : 720);

// ───────────────────────── 글자 검사(원문·금지 문자열·리터럴 감사) ─────────────────────────

test("원문 고정: 고정 해시와 같고, docs/sql 대표용 사본과 바이트가 같고, 전체가 begin … commit 한 묶음이다", () => {
  assert.equal(crypto.createHash("sha256").update(sql).digest("hex"), SPEC_SHA256);
  assert.ok(fs.readFileSync(DOCS_COPY).equals(fs.readFileSync(path.join(migrationDirectory, MIGRATION_NAME))),
    "docs/sql/c30-1-tables.sql 이 마이그레이션과 바이트 단위로 다르다");
  const lines = sql.split("\n");
  assert.equal(lines.filter((line) => line === "begin;").length, 1);
  assert.equal(lines.filter((line) => line === "commit;").length, 1);
  assert.equal(sql.trimEnd().split("\n").at(-1), "commit;");
  const firstStatement = lines.find((line) => line.trim() && !line.startsWith("--"));
  assert.equal(firstStatement, "begin;");
});

test("함수 18개 모두 security definer + set search_path = '' 이고, 표 9개를 만든다", () => {
  const headers = [...sql.matchAll(/create or replace function public\.([a-z_]+)\(([\s\S]*?)\nas \$\$/g)];
  assert.equal(headers.length, 18);
  assert.deepEqual(sorted(headers.map((hit) => hit[1])), sorted(EXPECTED_FUNCTIONS.map((sig) => sig.split("(")[0])));
  for (const [, name, header] of headers) {
    assert.match(header, /\nsecurity definer\n/, `${name}: security definer`);
    assert.match(header, /\nset search_path = ''$/, `${name}: set search_path = ''`);
  }
  const tables = quotedValues(sql, /create table if not exists public\.([a-z_]+) \(/g);
  assert.deepEqual(sorted(tables), EXPECTED_TABLES);
});

test("다른 순위 기능 잠금 정규식에 걸리지 않고, 'x.y.z'·64자리 16진·naver 가 0개다", () => {
  const lockSource = fs.readFileSync(path.join(root, "scripts", "check-protected-rank-features.mjs"), "utf8");
  const declared = /const RANK_MIGRATION_PATTERN = \/(.+)\/([a-z]*);/.exec(lockSource);
  assert.ok(declared, "잠금 검사기의 RANK_MIGRATION_PATTERN 을 찾지 못했다");
  const lockPattern = new RegExp(declared[1], declared[2]);
  assert.equal(lockPattern.test(sql), false, "잠금 정규식에 걸리는 이름이 있다(주석 포함 금지)");
  assert.equal(/'[0-9]+\.[0-9]+\.[0-9]+'/.test(sql), false);
  assert.equal(/[0-9a-f]{64}/i.test(sql), false);
  assert.equal(/naver/i.test(sql), false);
});

test("migration-runtime-literal-audit: 이 파일의 함수 18개는 최종 선언이고 리터럴 위반이 없다", () => {
  const own = collectFinalFunctionDeclarations(migrationDirectory, [MIGRATION_NAME]);
  assert.equal(own.length, 18);
  assert.ok(own.every((entry) => entry.hasBody && entry.function.startsWith("public.coupang_rank_")));
  const ownAudit = auditMigrationRuntimeLiterals({ migrationDirectory, files: [MIGRATION_NAME], allowlist: [] });
  assert.equal(ownAudit.ok, true);
  assert.deepEqual(ownAudit.violations, []);

  // 이 파일의 18개는 모두 이 파일이 최종 선언이다(다른 마이그레이션이 다시 선언하지 않는다).
  // 그 밖의 C 함수는 ① 지금 확인 SQL(20261018090000)의 coupang_rank_manual_* 5개뿐이다(spec-manual §6.10).
  const all = collectFinalFunctionDeclarations(migrationDirectory);
  const coupang = all.filter((entry) => entry.function.startsWith("public.coupang_rank_"));
  const own18 = new Set(EXPECTED_FUNCTIONS.map((sig) => `public.${sig.split("(")[0]}`));
  const base = coupang.filter((entry) => own18.has(entry.function));
  assert.equal(base.length, 18);
  assert.ok(base.every((entry) => entry.file === MIGRATION_NAME), "다른 마이그레이션이 C 함수를 다시 선언했다");
  const others = coupang.filter((entry) => !own18.has(entry.function));
  assert.deepEqual(others.map((entry) => entry.function).sort(), [
    "public.coupang_rank_manual_claim",
    "public.coupang_rank_manual_record",
    "public.coupang_rank_manual_stop",
    "public.coupang_rank_manual_summary",
    "public.coupang_rank_manual_verify",
  ]);
  // 차단 뒤 30분 쉼(c30-4, 2026-10-27)·차단될 때마다 30분 쉼(c30-5, 2026-10-28)이 요약·차단 알림 2개를 다시 선언한다(최종 = c30-5).
  // 나머지 3개는 ① 지금 확인 SQL 이 최종 선언.
  const PAUSE_REDEFINED = new Set(["public.coupang_rank_manual_summary", "public.coupang_rank_manual_stop"]);
  assert.ok(others.every((entry) => entry.file === (PAUSE_REDEFINED.has(entry.function)
    ? "20261028090000_coupang_rank_manual_pause_every_block.sql"
    : "20261018090000_coupang_rank_manual_check.sql")), "지금 확인 함수의 최종 선언 파일");
  assert.equal(auditMigrationRuntimeLiterals({ migrationDirectory }).ok, true);
});

test("독립 모듈: coupang_rank_* 밖의 표는 쓰지 않고(만들기·고치기·지우기 0), 읽기는 clients·operation_team_codes 뿐이다", () => {
  const code = stripSqlComments(sql);
  const writes = quotedValues(
    code,
    /\b(?:insert\s+into|update|delete\s+from|alter\s+table|truncate(?:\s+table)?|drop\s+table(?:\s+if\s+exists)?|create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+[a-z_]+\s+on|create\s+trigger\s+[a-z_]+\s+[\s\S]{0,80}?\s+on)\s+public\.([a-z0-9_]+)/gi,
  );
  assert.ok(writes.length > 20);
  assert.deepEqual(writes.filter((name) => !name.startsWith("coupang_rank_")), []);
  const referenced = uniqueSorted(quotedValues(code, /\bpublic\.([a-z0-9_]+)/g))
    .filter((name) => !name.startsWith("coupang_rank_"));
  assert.deepEqual(referenced, ["clients", "operation_team_codes", "set_updated_at"]);
});

// ───────────────────────── §3 공유 계약과 SQL 의 일치 ─────────────────────────

test("§3 계약: 열거값·기본값이 contract.mjs 와 같다", async () => {
  await withDb(async (db) => {
    const { all, one } = helpers(db);
    const checks = await all(`select c.conrelid::regclass::text as tbl, pg_get_constraintdef(c.oid) as def
      from pg_constraint c where c.contype = 'c' and c.conrelid::regclass::text like 'coupang\\_rank\\_%'`);
    const valuesOf = (table, column) => {
      const def = checks.find((row) => row.tbl === table && row.def.includes(`(${column} = ANY`))?.def
        || checks.find((row) => row.tbl === table && new RegExp(`\\b${column}\\b`).test(row.def) && row.def.includes("ANY"))?.def;
      assert.ok(def, `${table}.${column} 열거 check 가 없다`);
      return sorted(quotedValues(def, /'([a-z_]+)'::text/g));
    };
    assert.deepEqual(valuesOf("coupang_rank_runs", "status"), sorted(RUN_STATUSES));
    assert.deepEqual(valuesOf("coupang_rank_snapshots", "result"), sorted(SNAPSHOT_RESULTS));
    assert.deepEqual(valuesOf("coupang_rank_days", "result"), sorted(DAY_RESULTS));
    assert.deepEqual(valuesOf("coupang_rank_trackers", "status"), sorted(TRACKER_STATUSES));
    assert.deepEqual(valuesOf("coupang_rank_trackers", "current_result"), sorted(SNAPSHOT_RESULTS));
    assert.deepEqual(valuesOf("coupang_rank_settings", "window_mode"), sorted(WINDOW_MODES));
    assert.deepEqual(valuesOf("coupang_rank_settings", "cooldown_reason"), sorted(COOLDOWN_REASONS));
    assert.deepEqual(valuesOf("coupang_rank_cooldowns", "reason"), sorted(COOLDOWN_REASONS));
    assert.deepEqual(valuesOf("coupang_rank_settings", "budget_reason"), sorted(BUDGET_REASONS));
    assert.deepEqual(valuesOf("coupang_rank_collectors", "platform"), sorted(PLATFORMS));

    const row = await one("select window_mode, enabled, team_access_enabled, client_view_enabled from public.coupang_rank_settings");
    assert.equal(row.window_mode, DEFAULT_WINDOW_MODE);
    assert.deepEqual([row.enabled, row.team_access_enabled, row.client_view_enabled], [false, false, false]);
    const group = await one(`select column_default from information_schema.columns
      where table_name = 'coupang_rank_trackers' and column_name = 'group_name'`);
    assert.equal(group.column_default, `'${DEFAULT_GROUP}'::text`);
  });

  // 함수 본문의 열거값
  assert.deepEqual(
    uniqueSorted(quotedValues(functionBody("coupang_rank_claim"), /'reason', '([a-z_]+)'/g)),
    sorted(CLAIM_WAIT_REASONS),
  );
  const recordAccepts = /p_status not in \(([^)]+)\)/.exec(functionBody("coupang_rank_record"))[1];
  assert.deepEqual(
    sorted(quotedValues(recordAccepts, /'([a-z_]+)'/g)),
    sorted(RUN_STATUSES.filter((status) => !["leased", "expired", "released"].includes(status))),
  );
  const releaseAccepts = /p_reason not in \(([^)]+)\)/.exec(functionBody("coupang_rank_release"))[1];
  assert.deepEqual(sorted(quotedValues(releaseAccepts, /'([a-z_]+)'/g)), sorted(RELEASE_REASONS));
  const blocking = /if p_reason in \(([^)]+)\)/.exec(functionBody("coupang_rank_apply_cooldown"))[1];
  assert.deepEqual(sorted(quotedValues(blocking, /'([a-z_]+)'/g)), sorted(BLOCKING_COOLDOWN_REASONS));
  const success = /r\.status not in \(([^)]+)\)/.exec(functionBody("coupang_rank_apply_success"))[1];
  assert.deepEqual(sorted(quotedValues(success, /'([a-z_]+)'/g)), sorted(SUCCESS_RUN_STATUSES));
  assert.ok(FIRST_CHECKS.every((value) => functionBody("coupang_rank_after_activate").includes(`'${value}'`)));
});

test("§3 계약: SQL 이 돌려주는 오류 코드는 모두 §3.4 에 있고, record 의 것은 RECORD_FINAL_CODES 안이다", () => {
  const codes = (name) => uniqueSorted(quotedValues(functionBody(name), /'code', '([A-Z_]+)'/g));
  const recordCodes = codes("coupang_rank_record");
  assert.deepEqual(recordCodes, sorted(["JOB_KEYWORD_MISMATCH", "JOB_LEASE_MISMATCH", "JOB_NOT_FOUND", "JOB_TOO_OLD", "RUN_STATUS_INVALID"]));
  assert.ok(recordCodes.every((code) => RECORD_FINAL_CODES.includes(code)));
  const releaseCodes = codes("coupang_rank_release");
  const limitCodes = uniqueSorted(quotedValues(functionBody("coupang_rank_tracker_limit_guard"), /message = '([A-Z_]+)'/g));
  assert.deepEqual(limitCodes, ["COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED", "COUPANG_KEYWORD_LIMIT_REACHED"]);
  for (const code of [...recordCodes, ...releaseCodes, ...limitCodes]) {
    assert.ok(Object.hasOwn(ERROR_HTTP_STATUS, code), `${code} 가 §3.4 에 없다`);
  }
});

test("§3 계약: 키워드·그룹·순위·목록·제목 상한과 임대·보고 기한·빈도 조절 값이 같다", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    const insertTracker = (keyword, group) => db.query(
      `insert into public.coupang_rank_trackers (agency_code, keyword, keyword_key, product_id, product_url, group_name)
       values ('mml93-a01', $1, $1, '1234', 'https://www.coupang.com/vp/products/1234', $2)`,
      [keyword, group],
    );
    await insertTracker("가".repeat(KEYWORD_MAX), "그".repeat(GROUP_MAX));
    await assert.rejects(insertTracker("나".repeat(KEYWORD_MAX + 1), "그룹"), /check constraint/);
    await assert.rejects(insertTracker("다다", "그".repeat(GROUP_MAX + 1)), /check constraint/);

    // 순위 열은 1~RANK_TOP 만 받는다.
    await assert.rejects(
      db.query(`update public.coupang_rank_trackers set current_rank = $1`, [RANK_TOP + 1]),
      /check constraint/,
    );
    // 회차 증거 목록 상한(ORGANIC_MAX·ADS_MAX), 위치 상한(SLOT_MAX).
    const insertRun = (organic, ads) => db.query(
      `insert into public.coupang_rank_runs (keyword_key, lease_until, organic, ads) values ('x', now(), $1::jsonb, $2::jsonb)`,
      [JSON.stringify(organic), JSON.stringify(ads)],
    );
    await insertRun(Array.from({ length: ORGANIC_MAX }, () => ({})), Array.from({ length: ADS_MAX }, () => ({})));
    await assert.rejects(insertRun(Array.from({ length: ORGANIC_MAX + 1 }, () => ({})), []), /check constraint/);
    await assert.rejects(insertRun([], Array.from({ length: ADS_MAX + 1 }, () => ({}))), /check constraint/);
    const slot = (await b.one(`select public.coupang_rank_match($1::jsonb, '[]', '7777', null, false) as m`,
      [JSON.stringify([{ p: "7777", v: "", s: SLOT_MAX }])])).m;
    assert.deepEqual([slot.result, slot.rank, slot.organicSlot], ["found", 1, SLOT_MAX]);

    // 제목은 코드 포인트 단위로 TITLE_MAX 자까지만 남긴다(서러게이트 쌍 이모지로 확인).
    const longTitle = "😀".repeat(TITLE_MAX + 5);
    const titled = (await b.one(`select public.coupang_rank_match($1::jsonb, '[]', '7777', null, false) as m`,
      [JSON.stringify([{ p: "7777", v: "", s: 1, t: longTitle }])])).m;
    assert.equal(Array.from(titled.title).length, TITLE_MAX);
    assert.equal(titled.title.isWellFormed(), true);

    // 임대 LEASE_SECONDS, 보고 기한 RECORD_MAX_AGE_MINUTES.
    await db.exec("delete from public.coupang_rank_trackers");
    await b.addTracker(PRIMARY_AGENCY_CODE, "lease", "4321");
    const job = await b.claim();
    assert.equal(job.state, "job");
    const lease = await b.one("select extract(epoch from lease_until - claimed_at)::int as sec from public.coupang_rank_runs where id = $1", [job.runId]);
    assert.equal(lease.sec, LEASE_SECONDS);
    await db.query(`update public.coupang_rank_runs set claimed_at = now() - make_interval(mins => $2), lease_until = now() + interval '1 minute' where id = $1`,
      [job.runId, RECORD_MAX_AGE_MINUTES + 1]);
    assert.equal((await b.record(job, "ok", okBody(organicList(1)))).code, "JOB_TOO_OLD");
    await db.query(`update public.coupang_rank_runs set claimed_at = now() - make_interval(mins => $2) where id = $1`,
      [job.runId, RECORD_MAX_AGE_MINUTES - 1]);
    assert.equal((await b.record(job, "ok", okBody(organicList(1)))).accepted, true);

    // 빈도 조절: '기다려' 뒤 min(CLAIM_THROTTLE_MAX_SECONDS, retryAfterSec) − 1초 안이면 같은 답 + throttled.
    const waitReply = JSON.stringify({ state: "wait", reason: "idle", retryAfterSec: 600 });
    await db.query(`update public.coupang_rank_collectors set last_claim_at = now() - make_interval(secs => $1), last_claim_reply = $2::jsonb`,
      [CLAIM_THROTTLE_MAX_SECONDS - 2, waitReply]);
    const throttled = await b.claimRaw();
    assert.deepEqual([throttled.throttled, throttled.reason, throttled.state], [true, "idle", "wait"]);
    await db.query(`update public.coupang_rank_collectors set last_claim_at = now() - make_interval(secs => $1), last_claim_reply = $2::jsonb`,
      [CLAIM_THROTTLE_MAX_SECONDS - 0.5, waitReply]);
    assert.equal((await b.claimRaw()).throttled, undefined);
  });
});

// ───────────────────────── PGlite 시나리오(§4.7 1~18) ─────────────────────────

test("1. 두 번 연속 실행: 표 9·함수 18, RLS·FORCE RLS, 권한은 service_role 만, window_mode = offscreen, §4.6 확인문", async () => {
  await withDb(async (db) => {
    await db.exec(sql);
    const { one, all } = helpers(db);
    const confirm = await one(CONFIRM_SQL);
    assert.deepEqual(
      [Number(confirm.tables), Number(confirm.functions), confirm.enabled, confirm.window_mode, confirm.owner_limit],
      [9, 18, false, "offscreen", 100],
    );
    const owner = await one("select keyword_limit from public.coupang_rank_account_limits where agency_code = $1", [PRIMARY_AGENCY_CODE]);
    assert.equal(owner.keyword_limit, 100);
    assert.equal(Number((await one("select count(*) as n from public.coupang_rank_settings")).n), 1);

    const functions = await all(String.raw`select p.oid::regprocedure::text as sig, p.prosecdef, array_to_string(p.proconfig, ',') as cfg,
        has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('authenticated', p.oid, 'execute') as auth,
        has_function_privilege('service_role', p.oid, 'execute') as svc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'coupang\_rank\_%'`);
    assert.deepEqual(sorted(functions.map((row) => row.sig)), sorted(EXPECTED_FUNCTIONS));
    for (const row of functions) {
      assert.equal(row.prosecdef, true, row.sig);
      assert.match(row.cfg, /search_path=""/, row.sig);
      assert.deepEqual([row.anon, row.auth, row.svc], [false, false, true], row.sig);
    }

    const tables = await all(String.raw`select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies,
        has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon,
        has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') as auth,
        has_table_privilege('service_role', c.oid, 'select') and has_table_privilege('service_role', c.oid, 'insert')
          and has_table_privilege('service_role', c.oid, 'update') and has_table_privilege('service_role', c.oid, 'delete') as svc
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'coupang\_rank\_%'`);
    assert.deepEqual(sorted(tables.map((row) => row.relname)), EXPECTED_TABLES);
    for (const row of tables) {
      assert.deepEqual(
        [row.relrowsecurity, row.relforcerowsecurity, row.policies, row.anon, row.auth, row.svc],
        [true, true, 0, false, false, true],
        row.relname,
      );
    }
    const triggers = await all(String.raw`select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname like 'coupang\_rank\_%'`);
    assert.equal(triggers.length, 6);
  });
});

test("2. 한도: 계정·전체 고유 키워드, 이미 수집 중인 키워드, 연결 해제된 광고주는 세지 않음(H2)", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    const clientId = await b.addClient("adv-1");
    await b.addTracker("adv-1", "a1", "1001", clientId);
    await db.exec("update public.coupang_rank_settings set default_account_limit = 1");
    await assert.rejects(b.addTracker("adv-1", "a2", "1002", clientId), (error) => {
      assert.equal(error.message, "COUPANG_KEYWORD_LIMIT_REACHED");
      assert.deepEqual([error.detail, error.hint], ["1", "1"]);
      return true;
    });
    await db.exec("update public.coupang_rank_settings set default_account_limit = 20, global_keyword_limit = 2");
    await b.addTracker(PRIMARY_AGENCY_CODE, "o1", "1003");
    await assert.rejects(b.addTracker(PRIMARY_AGENCY_CODE, "o2", "1004"), (error) => {
      assert.equal(error.message, "COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED");
      assert.deepEqual([error.detail, error.hint], ["2", "2"]);
      return true;
    });
    await b.addTracker(PRIMARY_AGENCY_CODE, "o1", "1005"); // 이미 수집 중인 키워드는 전체 한도와 무관

    await db.query("update public.clients set disconnected_at = now() where id = $1", [clientId]);
    await b.addTracker(PRIMARY_AGENCY_CODE, "o2", "1004"); // a1 이 빠져 자리가 난다
    const status = (await b.one("select public.coupang_rank_limit_status($1, 'a1') as j", [PRIMARY_AGENCY_CODE])).j;
    assert.deepEqual(
      [status.limit, status.used, status.globalLimit, status.globalUsed, status.keywordActive],
      [100, 3, 2, 2, false],
    );
    const stats = (await b.one("select public.coupang_rank_stats() as j")).j;
    assert.equal(stats.ineligibleActiveTrackers, 1);
    assert.equal(stats.activeKeywords, 2);
  });
});

test("3~4. 꺼짐 → disabled, 켜고 claim → job(처음 원문), 곧바로 → gap, ok 기록(일반 28번째·광고·옵션·제목·증거·중복)", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    await db.exec("update public.coupang_rank_settings set enabled = false");
    const trackerId = await b.addTracker(PRIMARY_AGENCY_CODE, "Phone Film", "8533720933", null, "96009802650");
    assert.equal((await b.claim()).reason, "disabled");
    await db.exec("update public.coupang_rank_settings set enabled = true");
    const activated = (await b.one("select public.coupang_rank_after_activate($1) as j", [trackerId])).j;
    assert.equal(activated.firstCheck, "queued");

    const job = await b.claim();
    assert.equal(job.state, "job");
    assert.equal(job.keyword, "Phone Film");
    assert.equal(job.keywordKey, "phone film");
    assert.equal(job.windowMode, "offscreen");
    // 직전 답이 job 이라 빈도 조절이 걸리지 않고, 간격 관문이 gap 으로 답한다.
    const gap = await b.claimRaw();
    assert.deepEqual([gap.state, gap.reason, gap.throttled], ["wait", "gap", undefined]);
    assert.ok(gap.retryAfterSec >= 1 && gap.retryAfterSec <= 30);

    const ads = [{ p: "8533720933", v: "96009802650", s: 1, t: "광고" }];
    const recorded = await b.record(job, "ok", okBody(organicList(28), ads));
    assert.deepEqual([recorded.ok, recorded.accepted, recorded.duplicate, recorded.late, recorded.matched, recorded.stop],
      [true, true, false, false, 1, false]);
    const tracker = await b.one(`select current_result, current_rank, current_ad_order, current_same_option, product_title,
        current_organic_count, check_count, found_count from public.coupang_rank_trackers where id = $1`, [trackerId]);
    assert.deepEqual(
      [tracker.current_result, tracker.current_rank, tracker.current_ad_order, tracker.current_same_option, tracker.product_title,
        tracker.current_organic_count, tracker.check_count, tracker.found_count],
      ["found", 28, 1, true, "아이쉘 360도 필름", 50, 1, 1],
    );
    const run = await b.one("select organic->27 as hit, ads->0 as ad, slot_minute, status from public.coupang_rank_runs where id = $1", [job.runId]);
    assert.equal(run.hit.t, undefined);
    assert.equal(run.ad.t, undefined);
    assert.equal(run.hit.p, "8533720933");
    assert.equal(run.status, "ok");
    assert.equal(run.slot_minute, minuteOfSlot(job.slotIndex));
    const snapshot = await b.one("select result, rank, organic_slot, ad_order, same_option, title, slot_minute from public.coupang_rank_snapshots where run_id = $1", [job.runId]);
    assert.deepEqual(
      [snapshot.result, snapshot.rank, snapshot.organic_slot, snapshot.ad_order, snapshot.same_option, snapshot.title, snapshot.slot_minute],
      ["found", 28, 30, 1, true, "아이쉘 360도 필름", minuteOfSlot(job.slotIndex)],
    );
    const day = await b.one("select result, rank, success_count, failure_count, best_rank from public.coupang_rank_days where tracker_id = $1", [trackerId]);
    assert.deepEqual([day.result, day.rank, day.success_count, day.failure_count, day.best_rank], ["found", 28, 1, 0, 28]);

    const duplicate = await b.record(job, "ok", {});
    assert.deepEqual([duplicate.ok, duplicate.accepted, duplicate.duplicate, duplicate.status], [true, false, true, "ok"]);
  });
});

test("5. 임대 만료 → expired·실패 칸·키워드 연속 실패 1·20분 뒤·전역 연속 오류 1, 늦게 온 성공 → late", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    const trackerId = await b.addTracker(PRIMARY_AGENCY_CODE, "Phone Film", "8533720933");
    const first = await b.claim();
    await b.record(first, "ok", okBody(organicList(28)));

    await b.due("phone film");
    const job = await b.claim();
    assert.equal(job.state, "job");
    await b.expire(job.runId);
    await b.claim();
    const run = await b.one("select status, error_code from public.coupang_rank_runs where id = $1", [job.runId]);
    assert.deepEqual([run.status, run.error_code], ["expired", "lease_expired"]);
    const keyword = await b.one(`select consecutive_failures, lease_run_id is null as free,
        round(extract(epoch from next_due_at - now()) / 60) as minutes from public.coupang_rank_keywords`);
    assert.deepEqual([keyword.consecutive_failures, keyword.free, Number(keyword.minutes)], [1, true, 20]);
    assert.equal((await b.settings()).error_streak, 1);

    const late = await b.record(job, "ok", okBody(organicList(30)));
    assert.deepEqual([late.accepted, late.late, late.matched], [true, true, 1]);
    const day = await b.one(`select failure_count, success_count, rank, result from public.coupang_rank_days
      where tracker_id = $1 and kst_day = $2::date and slot_minute = $3`, [trackerId, job.slotDay, minuteOfSlot(job.slotIndex)]);
    assert.deepEqual([day.failure_count, day.success_count, day.rank, day.result], [1, 1, 30, "found"]);
    assert.equal((await b.settings()).error_streak, 0); // 성공은 연속 오류를 0으로
  });
});

test("6~7. A8 옛 회차의 늦은 실패가 새 임대를 풀지 않고, unsupported 는 다음 날 0번 칸", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    const trackerId = await b.addTracker(PRIMARY_AGENCY_CODE, "k", "1234");
    const old = await b.claim();
    await b.expire(old.runId);
    await b.claim();
    await b.due("k");
    const current = await b.claim();
    assert.equal(current.state, "job");
    const lateFailure = await b.record(old, "error", { errorCode: "cdp_error" });
    assert.deepEqual([lateFailure.accepted, lateFailure.late, lateFailure.stop], [true, true, false]);
    const kept = await b.one("select lease_run_id = $1 as kept, consecutive_failures from public.coupang_rank_keywords", [current.runId]);
    assert.deepEqual([kept.kept, kept.consecutive_failures], [true, 1]); // 늦은 실패는 다시 세지 않는다
    assert.equal((await b.settings()).error_streak, 1);

    const unsupported = await b.record(current, "unsupported", { finalHost: "www.coupang.com", finalPath: "/np/campaigns/82" });
    assert.equal(unsupported.stop, false);
    const keyword = await b.one(`select consecutive_unsupported, slot_index, lease_run_id is null as free,
        slot_day = (now() at time zone 'Asia/Seoul')::date + 1 as next_day from public.coupang_rank_keywords`);
    assert.deepEqual([keyword.consecutive_unsupported, keyword.next_day, keyword.slot_index, keyword.free], [1, true, 0, true]);
    const cell = await b.one(`select result, failure_count from public.coupang_rank_days
      where tracker_id = $1 and kst_day = $2::date and slot_minute = $3`, [trackerId, current.slotDay, minuteOfSlot(current.slotIndex)]);
    // 옛 회차의 만료가 같은 칸이면 그 실패 1회가 이미 있다(칸 끝이 가까우면 만료 뒤 다음 칸으로 넘어가 다른 칸이 된다).
    const sameSlot = old.slotDay === current.slotDay && old.slotIndex === current.slotIndex;
    assert.deepEqual([cell.result, cell.failure_count], ["unsupported", sameSlot ? 2 : 1]);
  });
});

test("8. 연속 오류: 임대 만료만 3연속 → 30분(P3), 그 뒤 timeout 3연속 → error_escalated 1단계 6시간(P2)", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    for (let index = 0; index < 4; index += 1) await b.addTracker(PRIMARY_AGENCY_CODE, `kw${index}`, `1000${index}`);
    for (let index = 0; index < 3; index += 1) {
      const job = await b.claim();
      assert.equal(job.state, "job");
      await db.exec("update public.coupang_rank_runs set lease_until = now() - interval '1 second' where status = 'leased'");
    }
    const cooled = await b.claim();
    const settings = await b.one(`select error_streak, cooldown_reason, cooldown_until > now() + interval '29 minutes' as thirty,
        cooldown_until < now() + interval '31 minutes' as not_longer from public.coupang_rank_settings`);
    assert.deepEqual([cooled.state, cooled.reason], ["wait", "cooldown"]);
    assert.deepEqual([settings.error_streak, settings.cooldown_reason, settings.thirty, settings.not_longer], [0, "error_streak", true, true]);

    for (let index = 0; index < 3; index += 1) {
      await db.exec(`update public.coupang_rank_settings set cooldown_until = null;
        update public.coupang_rank_keywords set next_due_at = now() - interval '1 minute', slot_ends_at = now() + interval '3 hours',
          slot_attempts = 0, lease_run_id = null`);
      const job = await b.claim();
      assert.equal(job.state, "job", JSON.stringify(job));
      const result = await b.record(job, "timeout", { errorCode: "page_timeout" });
      assert.equal(result.stop, index === 2);
    }
    const escalated = await b.one(`select cooldown_reason, cooldown_until > now() + interval '5 hours 59 minutes' as six,
        cooldown_until < now() + interval '6 hours 1 minute' as not_longer from public.coupang_rank_settings`);
    const level = await b.one("select level from public.coupang_rank_cooldowns where reason = 'error_escalated'");
    assert.deepEqual([escalated.cooldown_reason, escalated.six, escalated.not_longer, level.level], ["error_escalated", true, true, 1]);
  });
});

test("9. 빈 쪽: 2연속 → 1시간, 24시간 안 다시 2연속 → empty_escalated, 긴 쉬기 중 짧은 쉬기는 사유를 바꾸지 않음", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    await b.addTracker(PRIMARY_AGENCY_CODE, "e", "1234");
    const reasons = [];
    for (let index = 0; index < 4; index += 1) {
      await db.exec("update public.coupang_rank_settings set cooldown_until = null");
      await b.due("e");
      const job = await b.claim();
      assert.equal(job.state, "job");
      const result = await b.record(job, "empty", { organic: [] });
      assert.equal(result.stop, true);
      reasons.push((await b.settings()).cooldown_reason);
    }
    assert.deepEqual(reasons, [null, "empty", "empty", "empty_escalated"]);
    await b.one("select public.coupang_rank_apply_cooldown('empty', null)");
    assert.equal((await b.settings()).cooldown_reason, "empty_escalated");
  });
});

test("10. 7일 안 세 번째 차단급 쉬기 → 24시간 + 대표 확인, 그 뒤 claim 사유는 review", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    await b.addTracker(PRIMARY_AGENCY_CODE, "b", "1234");
    await db.exec(`insert into public.coupang_rank_cooldowns (ends_at, reason, level) values
      (now(), 'blocked', 1), (now(), 'error_escalated', 2)`);
    const job = await b.claim();
    const result = await b.record(job, "blocked", { httpStatus: 403 });
    assert.deepEqual([result.stop, result.reviewRequired], [true, true]);
    const cooldown = await b.one(`select level, ends_at > now() + interval '23 hours 59 minutes' as day
      from public.coupang_rank_cooldowns where run_id = $1`, [job.runId]);
    assert.deepEqual([cooldown.level, cooldown.day], [3, true]);
    const settings = await b.settings();
    assert.deepEqual([settings.needs_owner_review, settings.review_reason, settings.cooldown_reason],
      [true, "blocked_3_in_7d", "blocked"]);
    await db.exec("update public.coupang_rank_settings set cooldown_until = null");
    const waiting = await b.claim();
    assert.deepEqual([waiting.state, waiting.reason], ["wait", "review"]);
  });
});

test("11. 상한·빈도: hourly_cap(반납은 안 셈), wait 직후 재호출 → throttled 같은 사유(M9), window ≤ 3600초", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    for (let index = 0; index < 4; index += 1) await b.addTracker(PRIMARY_AGENCY_CODE, `h${index}`, `2000${index}`);
    await db.exec("update public.coupang_rank_settings set max_runs_per_hour = 2");
    const first = await b.claim();
    await b.record(first, "ok", okBody(organicList(0)));
    const released = await b.claim();
    assert.equal(released.state, "job");
    const release = (await b.one("select public.coupang_rank_release($1, $2, 'guard') as j", [released.runId, b.col.id])).j;
    assert.equal(release.released, true);
    const again = (await b.one("select public.coupang_rank_release($1, $2, 'guard') as j", [released.runId, b.col.id])).j;
    assert.deepEqual([again.released, again.status], [false, "released"]);
    assert.equal((await b.one("select public.coupang_rank_release($1, $2, 'nope') as j", [released.runId, b.col.id])).j.code,
      "RELEASE_REASON_INVALID");
    const second = await b.claim();
    assert.equal(second.state, "job");
    await b.record(second, "ok", okBody(organicList(0)));
    const capped = await b.claim();
    assert.deepEqual([capped.state, capped.reason], ["wait", "hourly_cap"]);

    const before = await b.one("select last_claim_at from public.coupang_rank_collectors where id = $1", [b.col.id]);
    const throttled = await b.claimRaw();
    assert.deepEqual([throttled.state, throttled.reason, throttled.throttled], ["wait", "hourly_cap", true]);
    assert.ok(throttled.retryAfterSec >= 1 && throttled.retryAfterSec <= capped.retryAfterSec);
    const after = await b.one("select last_claim_at from public.coupang_rank_collectors where id = $1", [b.col.id]);
    assert.equal(after.last_claim_at.getTime(), before.last_claim_at.getTime()); // 조절된 답은 기록 시각을 밀지 않는다

    // 지금(KST) 시각과 바로 다음 시각을 모두 뺀 1시간 창. 정각을 넘겨도 시간대 밖이다.
    const hour = Number((await b.one("select extract(hour from now() at time zone 'Asia/Seoul')::int as h")).h);
    const [from, to] = hour <= 21 ? [hour + 2, hour + 3] : [hour === 22 ? 0 : 1, hour === 22 ? 1 : 2];
    await db.query("update public.coupang_rank_settings set max_runs_per_hour = 60, active_from_hour = $1, active_to_hour = $2", [from, to]);
    const window = await b.claim();
    assert.deepEqual([window.state, window.reason], ["wait", "window"]);
    assert.ok(window.retryAfterSec >= 60 && window.retryAfterSec <= 3600, String(window.retryAfterSec));
  });
});

test("12. 대상 판정: 광고주 연결 해제·일시중지, 팀 코드 revoked → false, 총관리자 → true", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    const eligible = async (clientId, agencyCode) => (await b.one(
      "select public.coupang_rank_tracker_is_eligible($1, $2) as e", [clientId, agencyCode],
    )).e;
    const clientId = await b.addClient("adv-2");
    await db.exec("insert into public.operation_team_codes (team_name, team_code) values ('팀', 'team-1')");
    assert.equal(await eligible(clientId, "adv-2"), true);
    await db.query("update public.clients set status = 'paused' where id = $1", [clientId]);
    assert.equal(await eligible(clientId, "adv-2"), false);
    await db.query("update public.clients set status = 'active', disconnected_at = now() where id = $1", [clientId]);
    assert.equal(await eligible(clientId, "adv-2"), false);
    assert.equal(await eligible(null, "team-1"), true);
    await db.exec("update public.operation_team_codes set status = 'revoked'");
    assert.equal(await eligible(null, "team-1"), false);
    assert.equal(await eligible(null, PRIMARY_AGENCY_CODE), true);
  });
});

test("13. plan_next(08~23시, 하루 2회): 00:30 → 같은 날 0번, 12:00 첫 측정 → 지금, 15:30 → 1번, 23:30 → 다음 날 0번", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    await db.exec("update public.coupang_rank_settings set active_from_hour = 8, active_to_hour = 23, checks_per_day = 2");
    const rows = await b.all(`select to_char(slot_day, 'MM-DD') as d, slot_index as i,
        to_char(due_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI') as due,
        to_char(slot_ends_at at time zone 'Asia/Seoul', 'HH24:MI') as ends from (
      select 1 as o, * from public.coupang_rank_plan_next('phone film', '2026-10-17T00:30:00+09:00', false) union all
      select 2, * from public.coupang_rank_plan_next('phone film', '2026-10-17T12:00:00+09:00', true) union all
      select 3, * from public.coupang_rank_plan_next('phone film', '2026-10-17T15:30:00+09:00', false) union all
      select 4, * from public.coupang_rank_plan_next('phone film', '2026-10-17T23:30:00+09:00', false)) q order by o`);
    assert.deepEqual(rows.map((row) => [row.d, row.i]), [["10-17", 0], ["10-17", 0], ["10-17", 1], ["10-18", 0]]);
    assert.equal(rows[1].due, "10-17 12:00");
    assert.deepEqual(rows.map((row) => row.ends), ["15:30", "15:30", "23:00", "15:30"]);
    // 키워드 위치는 칸 앞 60% 안이다.
    assert.ok(rows[0].due >= "10-17 08:00" && rows[0].due < "10-17 12:31", rows[0].due);
  });
});

test("14. match: 일반 50개 미만·상품 없음 → short, 55개 중 53번째 → out·rank null·organicSlot 53, 50번째 → found 50(H3)", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    const match = async (organic, productId, vendor = null, noResult = false) => (await b.one(
      "select public.coupang_rank_match($1::jsonb, '[]', $2, $3, $4) as m",
      [JSON.stringify(organic), productId, vendor, noResult],
    )).m;
    const short = await match([{ p: "1111", v: "", s: 1 }], "2222");
    assert.deepEqual([short.result, short.rank, short.organicCount], ["short", null, 1]);
    const list55 = Array.from({ length: 55 }, (_, index) => ({ p: index === 52 ? "9999" : String(100000 + index), v: "", s: index + 1 }));
    const out = await match(list55, "9999");
    assert.deepEqual([out.result, out.rank, out.organicSlot, out.organicCount, out.sameOption], ["out", null, 53, 55, null]);
    const at50 = await match(list55.map((item, index) => (index === 49 ? { p: "9999", v: "", s: 50 } : item)), "9999");
    assert.deepEqual([at50.result, at50.rank], ["found", RANK_TOP]);
    const absent50 = await match(list55.slice(0, 50), "8888");
    assert.equal(absent50.result, "out");
    const noResult = await match([], "9999", null, true);
    assert.deepEqual([noResult.result, noResult.organicCount], ["noresult", 0]);
    const option = await match([{ p: "9999", v: "1", s: 4 }], "9999", "2");
    assert.deepEqual([option.result, option.rank, option.sameOption, option.vendorItemId], ["found", 1, false, "1"]);
  });
});

test("15. H6: 실패만 한 키워드는 일시중지→재개, after_activate, replan_all 뒤에도 미룬 시각보다 앞당겨지지 않음", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    const trackerId = await b.addTracker(PRIMARY_AGENCY_CODE, "f", "1234");
    const job = await b.claim();
    assert.equal(job.state, "job");
    // 칸 끝을 멀리 둬서 실패가 20분 재시도 갈래로 가게 한다(실행 시각과 무관).
    await db.exec("update public.coupang_rank_keywords set slot_ends_at = now() + interval '3 hours'");
    await b.record(job, "error", { errorCode: "cdp_error" });
    const before = await b.one("select next_due_at, next_due_at > now() + interval '19 minutes' as later from public.coupang_rank_keywords");
    assert.equal(before.later, true);

    await db.query("update public.coupang_rank_trackers set status = 'paused', paused_at = now() where id = $1", [trackerId]);
    await db.query("update public.coupang_rank_trackers set status = 'active', paused_at = null where id = $1", [trackerId]);
    const activated = (await b.one("select public.coupang_rank_after_activate($1) as j", [trackerId])).j;
    assert.equal(activated.firstCheck, "queued");
    assert.ok(new Date(activated.nextDueAt) >= before.next_due_at);
    await b.one("select public.coupang_rank_replan_all()");
    const after = await b.one("select next_due_at from public.coupang_rank_keywords");
    assert.ok(after.next_due_at >= before.next_due_at, `${after.next_due_at.toISOString()} < ${before.next_due_at.toISOString()}`);
    const waiting = await b.claim();
    assert.deepEqual([waiting.state, waiting.reason], ["wait", "idle"]);
  });
});

test("16. H1: 기한 지난 두 키워드 중 마지막 성공이 더 오래된 것을 먼저 고른다", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    await b.addTracker(PRIMARY_AGENCY_CODE, "aaa", "1111");
    await b.addTracker(PRIMARY_AGENCY_CODE, "zzz", "2222");
    await b.claim(); // 키워드 행을 만든다(하나는 임대됨)
    await db.exec(`update public.coupang_rank_runs set status = 'ok' where status = 'leased';
      update public.coupang_rank_keywords set lease_run_id = null, next_due_at = now() - interval '1 minute',
        slot_ends_at = now() + interval '3 hours';
      update public.coupang_rank_keywords set last_success_at = now() - interval '1 hour' where keyword_key = 'aaa';
      update public.coupang_rank_keywords set last_success_at = now() - interval '2 days', next_due_at = now() - interval '10 seconds'
        where keyword_key = 'zzz'`);
    assert.equal((await b.claim()).keywordKey, "zzz");
    // 성공한 적 없는 키워드가 맨 앞이다.
    await db.exec(`update public.coupang_rank_runs set status = 'ok' where status = 'leased';
      update public.coupang_rank_keywords set lease_run_id = null, next_due_at = now() - interval '1 minute',
        slot_ends_at = now() + interval '3 hours';
      update public.coupang_rank_keywords set last_success_at = null, next_due_at = now() - interval '5 seconds' where keyword_key = 'aaa'`);
    assert.equal((await b.claim()).keywordKey, "aaa");
  });
});

test("17. 일별 칸 재생성 SQL(§10.4, slot_minute 기준)과 완전 제거 SQL(§10.5) 뒤 재설치", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    const trackerId = await b.addTracker(PRIMARY_AGENCY_CODE, "k", "1234");
    await db.query(`insert into public.coupang_rank_snapshots (tracker_id, run_id, checked_at, kst_day, slot_index, slot_minute, result, rank, organic_count) values
      ($1, gen_random_uuid(), now() - interval '1 hour', '2026-10-16', 0, 480, 'found', 30, 50),
      ($1, gen_random_uuid(), now(), '2026-10-16', 0, 480, 'found', 25, 50),
      ($1, gen_random_uuid(), now(), '2026-10-16', 1, 930, 'out', null, 50)`, [trackerId]);
    await db.exec(DAYS_REBUILD_SQL);
    await db.exec(DAYS_REBUILD_SQL); // 다시 실행해도 그대로
    const rows = await b.all("select slot_minute, slot_index, result, rank, success_count, failure_count, best_rank from public.coupang_rank_days order by slot_minute");
    assert.deepEqual(
      rows.map((row) => [row.slot_minute, row.slot_index, row.result, row.rank, row.success_count, row.failure_count, row.best_rank]),
      [[480, 0, "found", 25, 2, 0, 25], [930, 1, "out", null, 1, 0, null]],
    );

    await db.exec(DROP_SQL);
    const left = await b.one(String.raw`select
      (select count(*)::int from pg_proc where proname like 'coupang\_rank\_%') as functions,
      (select count(*)::int from information_schema.tables where table_name like 'coupang\_rank\_%') as tables,
      (select count(*)::int from public.clients) as clients`);
    assert.deepEqual([left.functions, left.tables, left.clients], [0, 0, 0]);
    await db.exec(sql);
    const confirm = await b.one(CONFIRM_SQL);
    assert.deepEqual([Number(confirm.tables), Number(confirm.functions), confirm.window_mode, confirm.owner_limit], [9, 18, "offscreen", 100]);
  });
});

test("18. 하루 3회(0~24시) 칸 시작 분 = 0·480·960, housekeeping 이 보관 기간을 정리한다", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    await db.exec("update public.coupang_rank_settings set active_from_hour = 0, active_to_hour = 24, checks_per_day = 3");
    const trackerId = await b.addTracker(PRIMARY_AGENCY_CODE, "m", "1234");
    const job = await b.claim();
    assert.equal(job.state, "job");
    const run = await b.one("select slot_index, slot_minute from public.coupang_rank_runs where id = $1", [job.runId]);
    assert.equal(run.slot_minute, [0, 480, 960][run.slot_index]);
    const expected = await b.all(`select (0 * 60 + floor((24 - 0) * 60.0 * i / 3))::int as m from generate_series(0, 2) i`);
    assert.deepEqual(expected.map((row) => row.m), [0, 480, 960]);

    await db.query(`insert into public.coupang_rank_snapshots (tracker_id, run_id, checked_at, kst_day, result, rank, organic_count, created_at)
      values ($1, gen_random_uuid(), now() - interval '61 days', current_date - 61, 'out', null, 50, now() - interval '61 days')`, [trackerId]);
    await db.exec(`insert into public.coupang_rank_runs (keyword_key, claimed_at, lease_until, status)
        values ('m', now() - interval '15 days', now() - interval '15 days', 'ok');
      insert into public.coupang_rank_cooldowns (started_at, ends_at, reason) values (now() - interval '91 days', now() - interval '91 days', 'empty')`);
    const housekeeping = (await b.one("select public.coupang_rank_housekeeping() as j")).j;
    assert.deepEqual(
      [housekeeping.snapshots, housekeeping.runs, housekeeping.cooldowns, typeof housekeeping.coupangBytes, typeof housekeeping.databaseBytes],
      [1, 1, 1, "number", "number"],
    );
    const settings = await b.settings();
    assert.equal(settings.budget_blocked, false);
    assert.ok(settings.last_housekeeping_at instanceof Date);
    assert.equal(Number((await b.one("select count(*) as n from public.coupang_rank_runs where id = $1", [job.runId])).n), 1); // 임대 중 회차는 남김
  });
});

// ───────────────────────── 통합 검토 회귀(2026-10-16) ─────────────────────────

// 임대 중에 하루 횟수를 내리면 replan_all 이 그 키워드를 건너뛴다(임대 중). 그 회차가 실패·만료·차단으로 끝나면
// 지금 설정에 없는 칸 번호가 남는다. 고치기 전에는 다음 claim 의 slot_minute 가 0~1439 를 넘어
// 23514(coupang_rank_runs_slot_minute_check)로 claim 전체가 되돌려지고 모든 수집이 멈췄다(0~24시 3→1 → 2880,
// 2→1 → 1440, 08~23시 3→1 → 2280). 범위 안이어도 없는 칸의 시작 분이 기록됐다(08~23시 2→1 → 1380).
async function leasedThenLowered(db, { from, to, slotIndex, hours = [0, 24] }) {
  const b = await base(db);
  const keywordKey = "아이폰 필름";
  await db.query("update public.coupang_rank_settings set checks_per_day = $1, active_from_hour = $2, active_to_hour = $3",
    [from, hours[0], hours[1]]);
  const trackerId = await b.addTracker(PRIMARY_AGENCY_CODE, keywordKey, "8533720933");
  // 실행 시각과 무관하게 임대가 slotIndex 번 칸에 서도록 키워드 행을 미리 둔다(칸 끝은 3시간 뒤).
  await db.query(
    `insert into public.coupang_rank_keywords (keyword_key, search_text, next_due_at, slot_day, slot_index, slot_ends_at)
     values ($1, $1, now() - interval '1 minute', (now() at time zone 'Asia/Seoul')::date, $2, now() + interval '3 hours')`,
    [keywordKey, slotIndex],
  );
  const job = await b.claim();
  assert.equal(job.state, "job", JSON.stringify(job));
  assert.equal(job.slotIndex, slotIndex);
  // settings-update 가 하는 그대로: 설정 저장 → replan_all. 임대 중이라 0건이고 칸 번호가 그대로 남는다.
  await db.query("update public.coupang_rank_settings set checks_per_day = $1", [to]);
  assert.equal((await b.one("select public.coupang_rank_replan_all() as n")).n, 0);
  assert.equal((await b.one("select slot_index from public.coupang_rank_keywords")).slot_index, slotIndex);
  return { b, job, keywordKey, trackerId };
}

// 수집 시간대 [fromHour, toHour) 에서 하루 n회일 때 칸 i 의 시작 분(claim 과 같은 식).
const minuteOf = (index, perDay, [fromHour, toHour] = [0, 24]) =>
  fromHour * 60 + Math.floor(((toHour - fromHour) * 60 * index) / perDay);

async function claimNoThrow(b) {
  try {
    return await b.claim();
  } catch (error) {
    assert.fail(`claim 이 ${error.code || ""} 로 실패했다: ${error.message}`);
  }
}

async function assertFreshSlot(b, keywordKey, perDay, hours = [0, 24]) {
  const keyword = await b.one("select slot_index from public.coupang_rank_keywords where keyword_key = $1", [keywordKey]);
  assert.ok(keyword.slot_index < perDay, `칸 번호 ${keyword.slot_index} 가 하루 ${perDay}회에 없다`);
  await b.due(keywordKey);
  const job = await claimNoThrow(b);
  assert.equal(job.state, "job", JSON.stringify(job));
  const run = await b.one("select slot_index, slot_minute from public.coupang_rank_runs where id = $1", [job.runId]);
  assert.ok(run.slot_index < perDay);
  assert.equal(run.slot_minute, minuteOf(run.slot_index, perDay, hours));
  return job;
}

test("19. 임대 중 하루 횟수 3→1 뒤 시간 초과 → 20분 뒤 claim 이 23514 없이 지금 설정의 칸으로 다시 계획한다(검토 high, 원래 순서)", async () => {
  await withDb(async (db) => {
    const { b, job, keywordKey, trackerId } = await leasedThenLowered(db, { from: 3, to: 1, slotIndex: 2 });
    const timeout = await b.record(job, "timeout", { errorCode: "page_timeout", finalHost: "www.coupang.com" });
    assert.equal(timeout.accepted, true);
    // 20분 재시도 갈래: 칸 번호 2·옛 칸 끝이 남는다. 20분이 지난 것으로 둔다.
    await db.query("update public.coupang_rank_keywords set next_due_at = now() - interval '1 minute'");
    const reply = await claimNoThrow(b);
    if (reply.state === "job") {
      const run = await b.one("select slot_index, slot_minute from public.coupang_rank_runs where id = $1", [reply.runId]);
      assert.deepEqual([run.slot_index, run.slot_minute], [0, 0]);
    }
    const next = await assertFreshSlot(b, keywordKey, 1);
    const recorded = await b.record(next, "ok", okBody(organicList(9)));
    assert.equal(recorded.matched, 1);
    const day = await b.one(`select slot_index, slot_minute, rank from public.coupang_rank_days
      where tracker_id = $1 and success_count > 0`, [trackerId]);
    assert.deepEqual([day.slot_index, day.slot_minute, day.rank], [0, 0, 9]);
  });
});

test("19-2. 같은 상태가 임대 만료·차단으로 끝나도 claim 이 멈추지 않고, 만료 뒤 20분 미룸은 지킨다(H6)", async () => {
  await withDb(async (db) => {
    const { b, job, keywordKey } = await leasedThenLowered(db, { from: 3, to: 1, slotIndex: 2 });
    await b.expire(job.runId);
    const cleanup = await claimNoThrow(b); // 만료 정리(20분 재시도 갈래)와 같은 claim 안에서 칸을 다시 계획한다
    assert.deepEqual([cleanup.state, cleanup.reason], ["wait", "idle"]);
    const keyword = await b.one(`select slot_index, next_due_at > now() + interval '19 minutes' as later
      from public.coupang_rank_keywords`);
    assert.deepEqual([keyword.slot_index, keyword.later], [0, true]);
    await db.query("update public.coupang_rank_keywords set next_due_at = now() - interval '1 minute'");
    await claimNoThrow(b);
    await assertFreshSlot(b, keywordKey, 1);
  });
  await withDb(async (db) => {
    const { b, job, keywordKey } = await leasedThenLowered(db, { from: 3, to: 1, slotIndex: 2 });
    const blocked = await b.record(job, "blocked", { httpStatus: 403 });
    assert.equal(blocked.stop, true);
    await db.exec("update public.coupang_rank_settings set cooldown_until = null");
    await claimNoThrow(b); // 쉬기가 끝난 뒤
    await assertFreshSlot(b, keywordKey, 1);
  });
});

test("19-3. 임대 중 하루 횟수 2→1 뒤 실패 → 지금 설정에 없는 칸의 시작 분을 남기지 않는다(범위 안이어도)", async () => {
  // 지금 KST 시각을 품는 2시간 시간대. 옛 칸 1번을 하루 1회 식으로 세면 시간대 끝(to×60)이 나온다:
  // to < 24 면 범위 안의 틀린 값(08~23시 2→1 의 1380 과 같은 꼴), to = 24 면 1440 → 23514.
  // 자정 경계 대기를 먼저 해서, 시각을 읽은 뒤 날짜가 넘어가 시간대 밖이 되지 않게 한다(시나리오 중 시는 최대 1 오른다).
  await awayFromSlotBoundary();
  const hour = Number((await withDb(async (db) => (await helpers(db).one(
    "select extract(hour from now() at time zone 'Asia/Seoul')::int as h")).h)));
  const hours = [Math.min(hour, 22), Math.min(hour, 22) + 2];
  await withDb(async (db) => {
    const { b, job, keywordKey } = await leasedThenLowered(db, { from: 2, to: 1, slotIndex: 1, hours });
    assert.equal((await b.one("select slot_minute from public.coupang_rank_runs where id = $1", [job.runId])).slot_minute,
      minuteOf(1, 2, hours));
    await b.record(job, "error", { errorCode: "cdp_error" });
    await db.query("update public.coupang_rank_keywords set next_due_at = now() - interval '1 minute'");
    const reply = await claimNoThrow(b);
    if (reply.state === "job") {
      const run = await b.one("select slot_minute from public.coupang_rank_runs where id = $1", [reply.runId]);
      assert.equal(run.slot_minute, hours[0] * 60);
    }
    await assertFreshSlot(b, keywordKey, 1, hours);
    const minutes = await b.all("select distinct slot_minute from public.coupang_rank_runs where id <> $1", [job.runId]);
    assert.deepEqual(minutes.map((row) => row.slot_minute), [hours[0] * 60]);
  });
});

// after_activate 는 키워드 → 추적기, record·claim 은 추적기 → 키워드 순서로 잠가 교착(40P01)이 날 수 있었다(검토 low).
// PGlite 는 연결이 하나라 동시 실행 대신, 추적기를 잡는 두 함수(apply_success·mark_failed)에 들어가는 순간
// 같은 트랜잭션이 그 키워드 행을 이미 잠갔는지(xmax = 지금 트랜잭션)를 기록해 순서를 확인한다.
test("20. 잠금 순서: after_activate·record·claim 모두 추적기를 키워드보다 먼저 잡는다(교착 없음)", async () => {
  await withDb(async (db) => {
    const b = await base(db);
    await db.exec(`
      create table public.lock_probe (seq serial primary key, fn text not null, keyword_locked boolean not null);
      alter function public.coupang_rank_apply_success(uuid, uuid, jsonb, jsonb) rename to probe_inner_apply_success;
      alter function public.coupang_rank_mark_failed(uuid, text) rename to probe_inner_mark_failed;
      create function public.coupang_rank_apply_success(p_run_id uuid, p_tracker_id uuid, p_page_organic jsonb, p_page_ads jsonb)
      returns boolean language plpgsql as $$
      begin
        insert into public.lock_probe (fn, keyword_locked)
        select 'apply_success', exists (
          select 1 from public.coupang_rank_keywords k join public.coupang_rank_runs r on r.keyword_key = k.keyword_key
           where r.id = p_run_id and k.xmax::text = txid_current()::text);
        return public.probe_inner_apply_success(p_run_id, p_tracker_id, p_page_organic, p_page_ads);
      end $$;
      create function public.coupang_rank_mark_failed(p_run_id uuid, p_result text)
      returns integer language plpgsql as $$
      begin
        insert into public.lock_probe (fn, keyword_locked)
        select 'mark_failed', exists (
          select 1 from public.coupang_rank_keywords k join public.coupang_rank_runs r on r.keyword_key = k.keyword_key
           where r.id = p_run_id and k.xmax::text = txid_current()::text);
        return public.probe_inner_mark_failed(p_run_id, p_result);
      end $$;`);
    const probes = async () => (await b.all("select fn, keyword_locked from public.lock_probe order by seq"))
      .map((row) => `${row.fn}:${row.keyword_locked ? "키워드 먼저" : "추적기 먼저"}`);

    const first = await b.addTracker(PRIMARY_AGENCY_CODE, "k", "8533720933");
    const job = await b.claim();
    assert.equal((await b.record(job, "ok", okBody(organicList(5)))).matched, 1); // record 성공 경로
    await b.due("k");
    const failing = await b.claim();
    await b.record(failing, "error", { errorCode: "cdp_error" }); // record 실패 경로
    await b.due("k");
    const expiring = await b.claim();
    await b.expire(expiring.runId);
    await b.claim(); // claim 만료 정리 경로
    assert.deepEqual(await probes(), ["apply_success:추적기 먼저", "mark_failed:추적기 먼저", "mark_failed:추적기 먼저"]);

    // 오늘 성공 회차가 있는 키워드에 추적기를 더 붙이면 after_activate 가 그 회차를 바로 적용한다(추적기 잠금).
    await db.exec("delete from public.lock_probe");
    await db.query("update public.coupang_rank_trackers set status = 'paused', paused_at = now() where id = $1", [first]);
    const second = await b.addTracker(PRIMARY_AGENCY_CODE, "k", "9000003");
    await db.exec("begin");
    const activated = (await b.one("select public.coupang_rank_after_activate($1) as j", [second])).j;
    const held = await b.one(`select
        (select xmax::text = txid_current()::text from public.coupang_rank_keywords where keyword_key = 'k') as keyword,
        (select xmin::text = txid_current()::text from public.coupang_rank_trackers where id = $1) as tracker`, [second]);
    await db.exec("commit");
    assert.equal(activated.firstCheck, "recorded");
    assert.deepEqual([held.keyword, held.tracker], [true, true]); // 둘 다 여전히 잡는다(키워드는 마지막)
    assert.deepEqual(await probes(), ["apply_success:추적기 먼저"]);
    const tracker = await b.one("select current_result, current_rank from public.coupang_rank_trackers where id = $1", [second]);
    assert.deepEqual([tracker.current_result, tracker.current_rank], ["found", 4]); // organicList 의 4번째 = 9000003
  });
});

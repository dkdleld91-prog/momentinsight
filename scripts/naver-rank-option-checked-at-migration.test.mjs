import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

// N30 그룹상품 옵션 확인일 칸(대표 요청 2026-10-31, 옵션 번호 정식 기능 B6). 대표가 Supabase SQL Editor 에서 실행하는 원문을
// 고정하고, 실제 Postgres(PGlite)로 재실행 안전·기존 행 비어 있음·옵션 번호 칸 무변경·조건부 갱신·되돌리기·확인문을 확인한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_PATH = path.join(root, "supabase", "migrations", "20261031120000_naver_rank_option_checked_at.sql");
const DOCS_COPY = path.join(root, "docs", "sql", "n30-group-4-option-checked-at.sql");
const ROLLBACK = path.join(root, "docs", "sql", "n30-group-4-option-checked-at.rollback.sql");
const VERIFY = path.join(root, "docs", "sql", "n30-group-4-option-checked-at.verify-applied.sql");
const MIGRATION_SHA256 = "7a399368c036d4e2f1b87dabaeff1ebe1c1b2467793055af60a9bd07ee7278bf";
const migration = fs.readFileSync(MIGRATION_PATH, "utf8");

async function freshDb() {
  const db = new PGlite();
  // 운영 표의 이 작업과 관계있는 칸만 둔다(옵션 번호 칸·표시 칸은 20261023090000·20261027090000 마이그레이션 뒤 모양).
  await db.exec(`
    create table public.naver_rank_trackers (
      id uuid primary key default gen_random_uuid(),
      keyword text not null,
      product_id text,
      status text not null default 'active',
      option_product_ids text[] not null default '{}'::text[],
      group_product_marked boolean not null default false
    );
    insert into public.naver_rank_trackers (keyword, product_id, option_product_ids) values
      ('아이폰 17 필름', '12356459438', '{99900000001,99900000002}'),
      ('대표 번호 없는 옛 행', null, '{}');
  `);
  return db;
}

test("C1 원문 고정: sha256·docs/sql 사본 바이트·begin … commit 한 묶음·칸 하나만 더한다·칸 이름에 옵션 번호 칸 이름 없음", () => {
  assert.equal(crypto.createHash("sha256").update(migration).digest("hex"), MIGRATION_SHA256);
  assert.ok(fs.readFileSync(DOCS_COPY).equals(fs.readFileSync(MIGRATION_PATH)), "docs/sql 사본이 마이그레이션과 바이트 단위로 다르다");
  const lines = migration.split("\n");
  assert.equal(lines.filter((line) => line === "begin;").length, 1);
  assert.equal(lines.filter((line) => line === "commit;").length, 1);
  assert.equal(migration.trimEnd().split("\n").at(-1), "commit;");
  assert.match(migration, /set local lock_timeout = '5s';/u);
  assert.match(migration, /add column if not exists option_checked_at timestamptz;/u);
  const code = migration.replace(/--[^\n]*/gu, "");
  assert.equal(/create\s+(or\s+replace\s+)?(function|trigger|table|view|index)/iu.test(code), false, "함수·트리거·표·색인을 만들지 않는다");
  assert.equal((code.match(/alter table public\.naver_rank_trackers/gu) || []).length, 1);
  assert.equal(/\bdefault\b|not null/iu.test(code), false, "기본값·not null 없음(비어 있음 = 기록 없음)");
  // 옵션 칸 없음 판정(isOptionColumnMissingError)은 오류 문구의 'option_product_ids' 글자를 본다. 새 칸 이름·설명에 넣으면
  // 이 칸 없음 오류가 옵션 칸 없음으로 잘못 걸려 수집 제출이 10분 동안 옵션을 무시한다.
  assert.equal(/option_product_ids|group_product_marked|constraint/iu.test(migration), false, "옵션 번호 칸·표시 칸·제약은 이름도 쓰지 않는다");
  assert.match(code, /notify pgrst, 'reload schema';/u);
});

test("C2 두 번 실행해도 오류가 없고 기존 행은 비어 있음(기록 없음), 옵션 번호·표시는 그대로, 새 추적도 비어 있음", async () => {
  const db = await freshDb();
  await db.exec(migration);
  await db.exec(migration);
  const rows = (await db.query("select keyword, option_checked_at, option_product_ids, group_product_marked from public.naver_rank_trackers order by keyword")).rows;
  assert.deepEqual(rows.map((row) => [row.keyword, row.option_checked_at, row.option_product_ids, row.group_product_marked]), [
    ["대표 번호 없는 옛 행", null, [], false],
    ["아이폰 17 필름", null, ["99900000001", "99900000002"], false],
  ]);
  await db.exec("insert into public.naver_rank_trackers (keyword, product_id) values ('새 추적', '12345678901')");
  const fresh = (await db.query("select option_checked_at from public.naver_rank_trackers where keyword = '새 추적'")).rows[0];
  assert.equal(fresh.option_checked_at, null, "새 추적도 기록 없음으로 시작");
});

test("C3 서버가 보내는 조건부 갱신 모양: 옵션 번호 칸이 미리 보기 때 값과 같을 때만 번호·확인일이 함께 바뀐다", async () => {
  const db = await freshDb();
  await db.exec(migration);
  const checkedAt = "2026-10-31T03:00:00.000Z";
  // PostgREST eq.{…} 와 같은 비교(text[] 배열 리터럴, 순서 포함). 다른 값이면 0줄.
  const stale = await db.query(
    "update public.naver_rank_trackers set option_product_ids = $1, option_checked_at = $2 where product_id = '12356459438' and option_product_ids = $3::text[] returning id",
    [["99900000003"], checkedAt, "{99900000002,99900000001}"],
  );
  assert.equal(stale.rows.length, 0, "순서가 다른 옛 값으로는 갱신되지 않는다");
  const fresh = await db.query(
    "update public.naver_rank_trackers set option_product_ids = $1, option_checked_at = $2 where product_id = '12356459438' and option_product_ids = $3::text[] returning id",
    [["99900000003"], checkedAt, "{99900000001,99900000002}"],
  );
  assert.equal(fresh.rows.length, 1);
  const row = (await db.query("select option_product_ids, option_checked_at from public.naver_rank_trackers where product_id = '12356459438'")).rows[0];
  assert.deepEqual(row.option_product_ids, ["99900000003"]);
  assert.equal(new Date(row.option_checked_at).toISOString(), checkedAt);
  // 빈 목록 '{}' 도 같은 비교로 맞는다(대표 번호 없는 옛 행).
  const empty = await db.query(
    "update public.naver_rank_trackers set option_checked_at = $1 where product_id is null and option_product_ids = $2::text[] returning id",
    [checkedAt, "{}"],
  );
  assert.equal(empty.rows.length, 1);
});

test("C4 확인문: 적용 직후 timestamp with time zone | 비어 있음 | YES | 0, 기록하면 checked_rows 가 센다", async () => {
  const db = await freshDb();
  await db.exec(migration);
  const verify = fs.readFileSync(VERIFY, "utf8");
  const code = verify.replace(/--[^\n]*/gu, "");
  assert.equal(/\b(insert|update|delete|alter|drop|create)\b/iu.test(code), false, "확인문은 읽기만 한다");
  const row = (await db.query(verify)).rows[0];
  assert.deepEqual({ ...row, checked_rows: Number(row.checked_rows) }, {
    column_type: "timestamp with time zone",
    column_default: null,
    is_nullable: "YES",
    checked_rows: 0,
  });
  await db.exec("update public.naver_rank_trackers set option_checked_at = now() where product_id = '12356459438'");
  assert.equal(Number((await db.query(verify)).rows[0].checked_rows), 1);
});

test("C5 되돌리기: 칸만 지우고(옵션 번호·표시는 그대로) 다시 실행 안전, 뒤 확인문은 칸 없음 오류, 다시 적용 가능", async () => {
  const db = await freshDb();
  await db.exec(migration);
  await db.exec("update public.naver_rank_trackers set option_checked_at = now(), group_product_marked = true where product_id = '12356459438'");
  const rollback = fs.readFileSync(ROLLBACK, "utf8");
  await db.exec(rollback);
  await db.exec(rollback);
  const columns = (await db.query("select column_name from information_schema.columns where table_name = 'naver_rank_trackers' order by column_name")).rows.map((row) => row.column_name);
  assert.equal(columns.includes("option_checked_at"), false);
  assert.equal(columns.includes("option_product_ids"), true);
  assert.equal(columns.includes("group_product_marked"), true);
  const kept = (await db.query("select option_product_ids, group_product_marked from public.naver_rank_trackers where product_id = '12356459438'")).rows[0];
  assert.deepEqual(kept, { option_product_ids: ["99900000001", "99900000002"], group_product_marked: true });
  await assert.rejects(db.query(fs.readFileSync(VERIFY, "utf8")), /option_checked_at.*does not exist/u);
  assert.match(rollback, /'column "option_checked_at" does not exist' 오류로 끝난다/u);
  await db.exec(migration);
  assert.equal((await db.query("select count(*)::int as n from public.naver_rank_trackers where option_checked_at is null")).rows[0].n, 2);
});

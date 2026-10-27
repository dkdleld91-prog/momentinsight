import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

// N30 그룹상품 표시 칸(대표 승인 2026-10-27 A안). 대표가 Supabase SQL Editor 에서 실행하는 원문을 고정하고,
// 실제 Postgres(PGlite)로 재실행 안전·기존 행 false·옵션 번호 칸 무변경·되돌리기·확인문을 확인한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_PATH = path.join(root, "supabase", "migrations", "20261027090000_naver_rank_group_product_mark.sql");
const DOCS_COPY = path.join(root, "docs", "sql", "n30-group-2-group-product-mark.sql");
const ROLLBACK = path.join(root, "docs", "sql", "n30-group-2-group-product-mark.rollback.sql");
const VERIFY = path.join(root, "docs", "sql", "n30-group-2-group-product-mark.verify-applied.sql");
const MIGRATION_SHA256 = "c7b25b97df33009190781fe82fc6687992b80d425353ed6e0d931f96d72cfe96";
const migration = fs.readFileSync(MIGRATION_PATH, "utf8");

async function freshDb() {
  const db = new PGlite();
  // 운영 표의 이 작업과 관계있는 칸만 둔다(옵션 번호 칸은 20261023090000 마이그레이션 뒤 모양).
  await db.exec(`
    create table public.naver_rank_trackers (
      id uuid primary key default gen_random_uuid(),
      keyword text not null,
      product_id text,
      status text not null default 'active',
      option_product_ids text[] not null default '{}'::text[]
    );
    insert into public.naver_rank_trackers (keyword, product_id, option_product_ids) values
      ('아이폰 17 필름', '12356459438', '{99900000001}'),
      ('대표 번호 없는 옛 행', null, '{}');
  `);
  return db;
}

test("G1 원문 고정: sha256·docs/sql 사본 바이트·begin … commit 한 묶음·칸 하나만 더한다", () => {
  assert.equal(crypto.createHash("sha256").update(migration).digest("hex"), MIGRATION_SHA256);
  assert.ok(fs.readFileSync(DOCS_COPY).equals(fs.readFileSync(MIGRATION_PATH)), "docs/sql 사본이 마이그레이션과 바이트 단위로 다르다");
  const lines = migration.split("\n");
  assert.equal(lines.filter((line) => line === "begin;").length, 1);
  assert.equal(lines.filter((line) => line === "commit;").length, 1);
  assert.equal(migration.trimEnd().split("\n").at(-1), "commit;");
  assert.match(migration, /set local lock_timeout = '5s';/u);
  assert.match(migration, /add column if not exists group_product_marked boolean not null default false;/u);
  const code = migration.replace(/--[^\n]*/gu, "");
  assert.equal(/create\s+(or\s+replace\s+)?(function|trigger|table|view|index)/iu.test(code), false, "함수·트리거·표·색인을 만들지 않는다");
  assert.equal((code.match(/alter table public\.naver_rank_trackers/gu) || []).length, 1);
  assert.equal(/option_product_ids|constraint/iu.test(code), false, "옵션 번호 칸·제약은 건드리지 않는다");
  assert.match(code, /notify pgrst, 'reload schema';/u);
});

test("G2 두 번 실행해도 오류가 없고 기존 행은 false(표시 안 함), 옵션 번호는 그대로", async () => {
  const db = await freshDb();
  await db.exec(migration);
  await db.exec(migration);
  const rows = (await db.query("select keyword, group_product_marked, option_product_ids from public.naver_rank_trackers order by keyword")).rows;
  assert.deepEqual(rows.map((row) => [row.keyword, row.group_product_marked, row.option_product_ids]), [
    ["대표 번호 없는 옛 행", false, []],
    ["아이폰 17 필름", false, ["99900000001"]],
  ]);
  await assert.rejects(db.exec("update public.naver_rank_trackers set group_product_marked = null"), /null value|not-null/u);
  await db.exec("update public.naver_rank_trackers set group_product_marked = true where product_id = '12356459438'");
  await db.exec("insert into public.naver_rank_trackers (keyword, product_id) values ('새 추적', '12345678901')");
  const fresh = (await db.query("select group_product_marked from public.naver_rank_trackers where keyword = '새 추적'")).rows[0];
  assert.equal(fresh.group_product_marked, false, "새 추적도 표시 안 함으로 시작");
});

test("G3 확인문: 적용 직후 boolean | false | NO | 0, 표시하면 marked_rows 가 센다", async () => {
  const db = await freshDb();
  await db.exec(migration);
  const verify = fs.readFileSync(VERIFY, "utf8");
  const code = verify.replace(/--[^\n]*/gu, "");
  assert.equal(/\b(insert|update|delete|alter|drop|create)\b/iu.test(code), false, "확인문은 읽기만 한다");
  const row = (await db.query(verify)).rows[0];
  assert.deepEqual({ ...row, marked_rows: Number(row.marked_rows) }, {
    column_type: "boolean",
    column_default: "false",
    is_nullable: "NO",
    marked_rows: 0,
  });
  await db.exec("update public.naver_rank_trackers set group_product_marked = true where product_id = '12356459438'");
  assert.equal(Number((await db.query(verify)).rows[0].marked_rows), 1);
});

test("G4 되돌리기: 칸만 지우고(옵션 번호는 그대로) 다시 실행 안전, 뒤 확인문은 칸 없음 오류, 다시 적용 가능", async () => {
  const db = await freshDb();
  await db.exec(migration);
  const rollback = fs.readFileSync(ROLLBACK, "utf8");
  await db.exec(rollback);
  await db.exec(rollback);
  const columns = (await db.query("select column_name from information_schema.columns where table_name = 'naver_rank_trackers' order by column_name")).rows.map((row) => row.column_name);
  assert.equal(columns.includes("group_product_marked"), false);
  assert.equal(columns.includes("option_product_ids"), true);
  assert.deepEqual((await db.query("select option_product_ids from public.naver_rank_trackers where product_id = '12356459438'")).rows[0].option_product_ids, ["99900000001"]);
  await assert.rejects(db.query(fs.readFileSync(VERIFY, "utf8")), /group_product_marked.*does not exist/u);
  assert.match(rollback, /'column "group_product_marked" does not exist' 오류로 끝난다/u);
  await db.exec(migration);
  assert.equal((await db.query("select count(*)::int as n from public.naver_rank_trackers where group_product_marked = false")).rows[0].n, 2);
});

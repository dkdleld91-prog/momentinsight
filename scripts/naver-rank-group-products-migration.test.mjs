import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

// N30 그룹상품 번호 칸(2026-10-23). 대표가 Supabase SQL Editor 에서 실행하는 원문을 고정하고,
// 실제 Postgres(PGlite)로 재실행 안전·기존 행 빈 목록·제약·되돌리기·확인문을 확인한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_NAME = "20261023090000_naver_rank_group_products.sql";
const MIGRATION_PATH = path.join(root, "supabase", "migrations", MIGRATION_NAME);
const DOCS_COPY = path.join(root, "docs", "sql", "n30-group-1-option-product-ids.sql");
const ROLLBACK = path.join(root, "docs", "sql", "n30-group-1-option-product-ids.rollback.sql");
const VERIFY = path.join(root, "docs", "sql", "n30-group-1-option-product-ids.verify-applied.sql");
const MIGRATION_SHA256 = "54245429f9da75c53fe2eeb2876626fdf326b3dc6b16d994f1f0145df1fd8bfc";
const migration = fs.readFileSync(MIGRATION_PATH, "utf8");
const PRIMARY = "12356459438";

async function freshDb() {
  const db = new PGlite();
  // 운영 표의 이 작업과 관계있는 칸만 둔다(원본 20260624003000_naver_rank_tracking.sql).
  await db.exec(`
    create table public.naver_rank_trackers (
      id uuid primary key default gen_random_uuid(),
      keyword text not null,
      product_id text,
      mall_name text,
      status text not null default 'active'
    );
    insert into public.naver_rank_trackers (keyword, product_id) values
      ('아이폰 17 필름', '${PRIMARY}'),
      ('대표 번호 없는 옛 행', null);
  `);
  return db;
}

async function setOptions(db, keyword, valueSql) {
  await db.exec(`update public.naver_rank_trackers set option_product_ids = ${valueSql} where keyword = '${keyword}'`);
}

async function rejects(db, valueSql) {
  try {
    await setOptions(db, "아이폰 17 필름", valueSql);
    return false;
  } catch (error) {
    assert.match(String(error.message), /naver_rank_trackers_option_product_ids_shape|violates check constraint/u);
    return true;
  }
}

test("S1 원문 고정: sha256·docs/sql 사본 바이트·begin … commit 한 묶음", () => {
  assert.equal(crypto.createHash("sha256").update(migration).digest("hex"), MIGRATION_SHA256);
  assert.ok(
    fs.readFileSync(DOCS_COPY).equals(fs.readFileSync(MIGRATION_PATH)),
    "docs/sql/n30-group-1-option-product-ids.sql 이 마이그레이션과 바이트 단위로 다르다",
  );
  const lines = migration.split("\n");
  assert.equal(lines.filter((line) => line === "begin;").length, 1);
  assert.equal(lines.filter((line) => line === "commit;").length, 1);
  assert.equal(migration.trimEnd().split("\n").at(-1), "commit;");
  assert.match(migration, /add column if not exists option_product_ids text\[\] not null default '\{\}'::text\[\]/u);
  assert.match(migration, /drop constraint if exists naver_rank_trackers_option_product_ids_shape/u);
  assert.match(migration, /set local lock_timeout = '5s';/u);
  // 함수·트리거·다른 표를 만들거나 바꾸지 않는다.
  const code = migration.replace(/--[^\n]*/gu, "");
  assert.equal(/create\s+(or\s+replace\s+)?(function|trigger|table|view|index)/iu.test(code), false);
  assert.equal((code.match(/alter table public\.naver_rank_trackers/gu) || []).length, 3);
  // 커밋 RPC 가 빈 product_id 를 채우는 갱신이 제약에 걸리지 않도록 제약은 product_id 를 보지 않는다.
  const constraint = code.slice(code.indexOf("add constraint"), code.indexOf("comment on column"));
  assert.equal(/product_id\b/u.test(constraint.replace(/option_product_ids/gu, "")), false);
});

test("S2·S3 두 번 실행해도 오류가 없고 기존 행은 빈 목록으로 시작한다", async () => {
  const db = await freshDb();
  await db.exec(migration);
  await db.exec(migration);
  const rows = (await db.query("select keyword, option_product_ids from public.naver_rank_trackers order by keyword")).rows;
  assert.deepEqual(rows.map((row) => row.option_product_ids), [[], []]);
  const constraints = (await db.query(`select count(*)::int as count from pg_catalog.pg_constraint
    where conname = 'naver_rank_trackers_option_product_ids_shape'`)).rows[0].count;
  assert.equal(constraints, 1);
  // 새 행도 빈 목록, NULL 은 넣을 수 없다.
  await db.exec("insert into public.naver_rank_trackers (keyword, product_id) values ('새 추적', '99900000009')");
  assert.deepEqual(
    (await db.query("select option_product_ids from public.naver_rank_trackers where keyword = '새 추적'")).rows[0].option_product_ids,
    [],
  );
  await assert.rejects(() => setOptions(db, "새 추적", "null"), /null value|not-null|violates not-null/u);
});

test("S4 제약: 20개 정상, 21개·숫자 아님·자리 수 밖·NULL 칸·빈 칸·쉼표 칸·2차원·첫 번호 다른 배열 거절", async () => {
  const db = await freshDb();
  await db.exec(migration);
  const ids = (count) => `array[${Array.from({ length: count }, (_, index) => `'${99900000000 + index}'`).join(",")}]::text[]`;

  await setOptions(db, "아이폰 17 필름", ids(20));
  assert.equal(
    (await db.query("select cardinality(option_product_ids)::int as n from public.naver_rank_trackers where keyword = '아이폰 17 필름'")).rows[0].n,
    20,
  );
  await setOptions(db, "아이폰 17 필름", "'{}'");
  await setOptions(db, "아이폰 17 필름", "'{12345}'");
  await setOptions(db, "아이폰 17 필름", "'{12345678901234567890}'");

  for (const [label, valueSql] of [
    ["21개", ids(21)],
    ["숫자 아님", "'{abc12345}'"],
    ["4자리", "'{1234}'"],
    ["21자리", "'{123456789012345678901}'"],
    ["NULL 칸", "array['99900000001', null]::text[]"],
    ["빈 칸", "array['']::text[]"],
    ["쉼표가 든 칸", "array['123456,123457']::text[]"],
    ["앞뒤 공백 칸", "array[' 99900000001']::text[]"],
    ["2차원", "'{{99900000001},{99900000002}}'"],
    ["첫 번호 0", "'[0:0]={99900000001}'"],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await rejects(db, valueSql), true, `${label} 은 거절돼야 한다`);
  }

  // 대표 번호 겹침은 서버가 막는다(DB 는 막지 않는다). 커밋 RPC 가 빈 product_id 를 채우는 갱신은 통과한다.
  await setOptions(db, "대표 번호 없는 옛 행", "'{99900000001}'");
  await db.exec("update public.naver_rank_trackers set product_id = '99900000001' where keyword = '대표 번호 없는 옛 행'");
  assert.equal(
    (await db.query("select product_id from public.naver_rank_trackers where keyword = '대표 번호 없는 옛 행'")).rows[0].product_id,
    "99900000001",
  );
});

test("S5 되돌리기 뒤 칸·제약이 없고 다시 적용할 수 있다", async () => {
  const db = await freshDb();
  await db.exec(migration);
  await setOptions(db, "아이폰 17 필름", "'{99900000001}'");
  await db.exec(fs.readFileSync(ROLLBACK, "utf8"));
  await db.exec(fs.readFileSync(ROLLBACK, "utf8"));
  const column = (await db.query(`select count(*)::int as count from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers' and column_name = 'option_product_ids'`)).rows[0].count;
  assert.equal(column, 0);
  const constraints = (await db.query(`select count(*)::int as count from pg_catalog.pg_constraint
    where conname = 'naver_rank_trackers_option_product_ids_shape'`)).rows[0].count;
  assert.equal(constraints, 0);
  // 되돌리기 머리말 안내대로, 되돌린 뒤 적용 확인문은 칸 없음 오류로 끝난다(그것이 정상).
  await assert.rejects(db.query(fs.readFileSync(VERIFY, "utf8")), /option_product_ids.*does not exist/u);
  assert.match(fs.readFileSync(ROLLBACK, "utf8"), /'column "option_product_ids" does not exist' 오류로 끝난다/u);
  // 다른 칸·행은 그대로.
  assert.equal((await db.query("select count(*)::int as count from public.naver_rank_trackers")).rows[0].count, 2);
  await db.exec(migration);
  assert.deepEqual(
    (await db.query("select option_product_ids from public.naver_rank_trackers where keyword = '아이폰 17 필름'")).rows[0].option_product_ids,
    [],
  );
});

test("확인문은 읽기 전용이고 적용 직후 ARRAY | '{}'::text[] | NO | 1 | true | 0 을 돌려준다", async () => {
  const verify = fs.readFileSync(VERIFY, "utf8");
  const code = verify.replace(/--[^\n]*/gu, "");
  assert.equal(/\b(insert|update|delete|alter|drop|create|grant|revoke|truncate)\b/iu.test(code), false);
  const db = await freshDb();
  await db.exec(migration);
  const row = (await db.query(verify)).rows[0];
  assert.equal(row.column_type, "ARRAY");
  assert.equal(row.column_default, "'{}'::text[]");
  assert.equal(row.is_nullable, "NO");
  assert.equal(Number(row.constraint_count), 1);
  assert.equal(row.roundtrip_guard, true);
  assert.equal(Number(row.grouped_rows), 0);
  await setOptions(db, "아이폰 17 필름", "'{99900000001}'");
  assert.equal(Number((await db.query(verify)).rows[0].grouped_rows), 1);
});

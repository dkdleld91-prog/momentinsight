import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

// N30 그룹상품 옵션 번호 상한 20 → 50(2026-10-27 대표 요청). 앞선 칸 SQL(20261023090000) 위에 이 SQL 을 실행해
// 50개는 받고 51개·번호 모양 위반은 거절하는지, 다시 실행해도 안전한지, 되돌리기·확인문을 실제 Postgres(PGlite)로 본다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const BASE = read("supabase", "migrations", "20261023090000_naver_rank_group_products.sql");
const MIGRATION = read("supabase", "migrations", "20261027150000_naver_rank_option_ids_max_50.sql");
const DOCS_COPY = read("docs", "sql", "n30-group-3-option-ids-max-50.sql");
const ROLLBACK = read("docs", "sql", "n30-group-3-option-ids-max-50.rollback.sql");
const VERIFY = read("docs", "sql", "n30-group-3-option-ids-max-50.verify-applied.sql");
const MIGRATION_SHA256 = "70760581dfafd737d3f2b1bdfb64c48fe71319f06ec42f9ca9844f0db16c0a26";
const ids = (n) => "'{" + Array.from({ length: n }, (_, index) => String(99900000300 + index)).join(",") + "}'";

async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    create table public.naver_rank_trackers (
      id uuid primary key default gen_random_uuid(),
      keyword text not null,
      product_id text,
      mall_name text,
      status text not null default 'active'
    );
    insert into public.naver_rank_trackers (keyword, product_id) values ('아이폰 17 필름', '12356459438');
  `);
  await db.exec(BASE);
  return db;
}

const setIds = (db, value) => db.query(`update public.naver_rank_trackers set option_product_ids = ${value} where keyword = '아이폰 17 필름'`);

test("원문 고정: 마이그레이션 = docs 사본(바이트 같음), sha256 고정, begin/commit 1개씩", () => {
  assert.equal(DOCS_COPY, MIGRATION);
  assert.equal(crypto.createHash("sha256").update(MIGRATION).digest("hex"), MIGRATION_SHA256);
  assert.equal((MIGRATION.match(/^begin;$/gmu) || []).length, 1);
  assert.equal((MIGRATION.match(/^commit;$/gmu) || []).length, 1);
});

test("상한: 적용 전 21개 거절 → 적용 뒤 50개 받고 51개·모양 위반 거절, 두 번 실행해도 같음", async () => {
  const db = await freshDb();
  await assert.rejects(setIds(db, ids(21)));
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  await setIds(db, ids(50));
  assert.equal((await db.query("select cardinality(option_product_ids)::int as n from public.naver_rank_trackers")).rows[0].n, 50);
  await assert.rejects(setIds(db, ids(51)));
  await assert.rejects(setIds(db, "'{abc}'"));
  await assert.rejects(setIds(db, "'{1234}'"));
  assert.equal((await db.query(VERIFY)).rows[0].has_50, true);
});

test("되돌리기: 20개 이하면 상한 20으로 돌아가고, 확인문은 false", async () => {
  const db = await freshDb();
  await db.exec(MIGRATION);
  await setIds(db, ids(20));
  await db.exec(ROLLBACK);
  await assert.rejects(setIds(db, ids(21)));
  assert.equal((await db.query(VERIFY)).rows[0].has_50, false);
});

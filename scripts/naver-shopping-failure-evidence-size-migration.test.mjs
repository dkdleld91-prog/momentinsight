import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// 2026-09-25: 1.1.31 이 증거 상한을 24000자로 올렸지만 표의 32 KB 크기 검사는 그대로여서, 세 캡처 증거
// (정작 원인 분석에 필요한 three_passes 실패)가 조용히 버려졌다. 실제 Postgres(PGlite)로 고정한다.
const dir = path.join(process.cwd(), "supabase/migrations");
const tableSql = fs.readFileSync(path.join(dir, "20260913140000_naver_shopping_failure_evidence.sql"), "utf8");
const nextSql = fs.readFileSync(path.join(dir, "20260925010000_naver_shopping_failure_evidence_size_limit.sql"), "utf8");

function evidence(passes, organicOnly) {
  const page = (p) => {
    const organic = Array.from({ length: p === 8 ? 20 : 40 }, (_, i) => [(p - 1) * 40 + i + 1, `s:${12000000000 + p * 100 + i}`]);
    return { p, total: 5230000, rows: organicOnly ? organic : [["h"], ["a", 1], ["a", 2], ["a", 3], ["a", 4], ["a", 5], ...organic, ["a", 44], ["a", 45], ["h"]] };
  };
  return {
    version: "collection-evidence-v2",
    keyword: "대나무 수건",
    passes: Array.from({ length: passes }, () => Array.from({ length: 8 }, (_, i) => page(i + 1))),
    truncated: organicOnly,
    trace: Array.from({ length: 10 }, (_, i) => `step ${i} provider_stable_window_unproven:digest_mismatch`),
    diff: { a: 300, b: 300, changed: 3, first: Array.from({ length: 12 }, (_, i) => [i + 1, "sellerProductId", `1200000${i}`, `1300000${i}`]) },
  };
}

async function fixture(apply) {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(tableSql);
  if (apply) await db.exec(nextSql);
  return db;
}
const insert = (db, value) => db.query(
  "insert into public.naver_shopping_failure_evidence (worker_id, keyword, error_code, scope, evidence) values ('w', 'k', 'e', 'tracker', $1::jsonb)",
  [JSON.stringify(value)],
);

test("migration only swaps the size check and keeps the table bounded", () => {
  assert.match(nextSql, /^begin;$/mu);
  assert.match(nextSql, /^commit;$/mu);
  assert.match(nextSql, /drop constraint if exists naver_shopping_failure_evidence_size;/u);
  assert.match(nextSql, /add constraint naver_shopping_failure_evidence_size check \(pg_column_size\(evidence\) <= 65536\);/u);
  assert.doesNotMatch(nextSql, /create or replace function|drop table|delete from|update public|grant |revoke /iu);
});

test("RED: the old check rejects three-capture evidence the collector is allowed to send; GREEN accepts it", async (t) => {
  for (const organicOnly of [false, true]) {
    const value = evidence(3, organicOnly);
    assert.ok(JSON.stringify(value).length <= 24000, "within the collector bound");
    const red = await fixture(false);
    t.after(() => red.close());
    await assert.rejects(() => insert(red, value), /naver_shopping_failure_evidence_size/u);
    const green = await fixture(true);
    t.after(() => green.close());
    await insert(green, value);
    assert.equal((await green.query("select count(*)::int as n from public.naver_shopping_failure_evidence")).rows[0].n, 1);
  }
});

test("the table stays bounded: an oversized document is still rejected", async (t) => {
  const db = await fixture(true);
  t.after(() => db.close());
  const huge = { ...evidence(3, false), trace: Array.from({ length: 2000 }, (_, i) => `padding ${i} ${"x".repeat(40)}`) };
  await assert.rejects(() => insert(db, huge), /naver_shopping_failure_evidence_size/u);
});

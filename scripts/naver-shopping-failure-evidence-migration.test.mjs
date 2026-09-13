import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260913140000_naver_shopping_failure_evidence.sql"), "utf8");

test("failure evidence table is service-role only, bounded and time-limited", () => {
  assert.match(migration, /create table if not exists public\.naver_shopping_failure_evidence/u);
  assert.match(migration, /enable row level security/u);
  assert.match(migration, /revoke all on table public\.naver_shopping_failure_evidence from public, anon, authenticated;/u);
  assert.match(migration, /grant select, insert, delete on table public\.naver_shopping_failure_evidence to service_role;/u);
  assert.match(migration, /pg_column_size\(evidence\) <= 32768/u);
  assert.match(migration, /retention_until timestamptz not null default \(now\(\) \+ interval '30 days'\)/u);
  assert.doesNotMatch(migration, /create or replace function/u);
  assert.doesNotMatch(migration, /create policy/u);
});

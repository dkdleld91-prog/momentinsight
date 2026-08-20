import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260820152359_schedule_monthly_no_end_mode.sql", import.meta.url);

test("monthly no-end migration preserves finite recurrence and stores explicit intent", async () => {
  const sql = (await readFile(migrationUrl, "utf8")).toLowerCase();

  assert.match(sql, /add column if not exists recurrence_no_end boolean not null default false/);
  assert.match(sql, /check\s*\([\s\S]*not recurrence_no_end[\s\S]*series_id is not null[\s\S]*recurrence_kind = 'monthly'/);
  assert.doesNotMatch(sql, /drop\s+(?:table|column)/);
  assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete)[^;]*to\s+(?:public|anon|authenticated)/);
  assert.match(sql, /comment on column public\.schedule_items\.recurrence_no_end/);
});

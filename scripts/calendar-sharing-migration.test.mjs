import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260820110000_schedule_calendar_sharing.sql", import.meta.url);

test("calendar sharing migration is additive, service-role-only, and recurrence-safe", async () => {
  const sql = (await readFile(migrationUrl, "utf8")).toLowerCase();

  for (const table of ["schedule_calendars", "schedule_calendar_memberships", "schedule_calendar_invites"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`alter table public\\.${table} force row level security`));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role`));
    assert.match(sql, new RegExp(`grant [^;]+ on table public\\.${table} to service_role`));
  }

  assert.match(sql, /add column if not exists calendar_id uuid/);
  assert.match(sql, /add column if not exists series_id uuid/);
  assert.match(sql, /add column if not exists occurrence_on date/);
  assert.match(sql, /create unique index[^;]+\(series_id, occurrence_on\)[^;]+where series_id is not null/);
  assert.doesNotMatch(sql, /update\s+public\.schedule_items\s+set\s+calendar_id/);

  assert.match(sql, /revoke all on table public\.schedule_items from public, anon, authenticated/);
  assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete)[^;]*on table public\.schedule_items to (?:public|anon|authenticated)/);

  for (const signature of [
    "public.mi_create_schedule_calendar(text, text, uuid, text, text, text)",
    "public.mi_accept_schedule_calendar_invite(text, text, text)",
    "public.mi_insert_shared_schedule_items(uuid, text, jsonb)",
    "public.mi_update_shared_schedule_item(uuid, text, uuid, timestamptz, jsonb)",
    "public.mi_delete_shared_schedule_item(uuid, text, uuid, timestamptz)",
  ]) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(sql, new RegExp(`revoke execute on function ${escaped}\\s+from public, anon, authenticated, service_role`));
    assert.match(sql, new RegExp(`grant execute on function ${escaped}\\s+to service_role`));
  }
  assert.equal((sql.match(/security invoker/g) || []).length >= 5, true);
  assert.equal((sql.match(/set search_path = ''/g) || []).length >= 5, true);

  assert.match(sql, /for update/);
  assert.match(sql, /invalid_or_expired_calendar_invite/);
  assert.match(sql, /on conflict \(calendar_id, principal_key\)/);
  assert.match(sql, /when membership\.revoked_at is null and membership\.role = 'owner' then 'owner'/);
  assert.match(sql, /when membership\.revoked_at is null and \(membership\.role = 'editor' or excluded\.role = 'editor'\) then 'editor'/);
  assert.match(sql, /created_by_operation_team_id uuid/);
  assert.match(sql, /archived_at timestamptz/);
  assert.match(sql, /role text not null default 'viewer'/);
  assert.match(sql, /grant_role text not null default 'editor'/);
  assert.match(sql, /max_uses smallint not null default 1/);
  assert.match(sql, /used_count smallint not null default 0/);
  assert.match(sql, /recurrence_day_policy = 'last_day'/);
  assert.doesNotMatch(sql, /accepted_at/);
  assert.doesNotMatch(sql, /\b(code|invite_code)\s+text\b/);
  assert.match(sql, /code_digest text/);
  assert.match(sql, /execute function public\.set_updated_at\(\)/);
  assert.equal((sql.match(/for update of membership, calendar/g) || []).length >= 3, true);
  assert.match(sql, /raise exception using errcode = '42501', message = 'calendar_edit_forbidden'/);
  assert.match(sql, /jsonb_to_recordset\(p_rows\)/);
  assert.match(sql, /schedule_type public\.schedule_type/);
  assert.match(sql, /status public\.schedule_status/);
  assert.match(sql, /priority public\.priority_level/);
  assert.match(sql, /p_payload is null/);
  assert.match(sql, /create or replace function public\.mi_update_shared_schedule_item\([\s\S]+returns setof public\.schedule_items[\s\S]+return query\s+update public\.schedule_items as item[\s\S]+returning item\.\*;/);
  assert.doesNotMatch(sql, /returning item\.\* into v_item/);
  assert.match(sql, /create or replace function public\.mi_delete_shared_schedule_item\([\s\S]+returns uuid[\s\S]+returning item\.id into v_item_id;[\s\S]+return v_item_id;/);
  assert.match(sql, /where item\.id = p_item_id[\s\S]+item\.calendar_id = p_calendar_id[\s\S]+item\.updated_at = p_expected_updated_at/);
});

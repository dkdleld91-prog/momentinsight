-- 2026-09-25: failure evidence rows were silently dropped for the most informative failures.
-- Runtime 1.1.31 raised the collector's evidence bound to 24000 JSON characters (three captures
-- plus branch trace and slot diff), but this table still checked pg_column_size(evidence) <= 32768.
-- jsonb stores these many small [rank, identity] arrays at about 1.8-1.9 bytes per JSON character,
-- so three-capture evidence (19-24k characters -> 39-45 KB) failed the check and the best-effort
-- insert was discarded. Production: no evidence row after 2026-09-19 although
-- `provider_stable_window_unproven:three_passes` failed twice (대나무 수건, 09-21 15:06, 09-22 00:24).
-- Measured with Postgres: stored 2-capture row 13,940 chars -> 25,056 bytes (accepted);
-- 3-capture 21,619-23,300 chars -> 39,238-44,710 bytes (rejected by the old check).
-- The bound becomes 65536 bytes: every evidence object the collector can send (<= 24000 chars)
-- fits, and the table stays bounded. Only the check constraint changes; no data is touched.
begin;
alter table public.naver_shopping_failure_evidence
  drop constraint if exists naver_shopping_failure_evidence_size;
alter table public.naver_shopping_failure_evidence
  add constraint naver_shopping_failure_evidence_size check (pg_column_size(evidence) <= 65536);
commit;

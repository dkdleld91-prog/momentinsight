-- C 30일 순위 · ① '지금 확인' 되돌리기(대표 승인 뒤에만, 반드시 코드를 먼저 되돌린 다음 실행).
-- 순서: 함수 5개 → 확인 요청 표 → 회차 색인·칸 2개 → 설정 제약·칸 12개. 모두 if exists 라 다시 실행해도 안전하다.
-- 이미 기록한 순위(일별 칸·스냅숏)는 지우지 않는다(회차의 출처 표시만 사라진다). C 표가 없어도 오류 없이 끝난다.
begin;

drop function if exists public.coupang_rank_manual_record(uuid, text, text, text, text, text, jsonb, text);
drop function if exists public.coupang_rank_manual_stop(uuid, text, text, text, uuid);
drop function if exists public.coupang_rank_manual_verify(uuid, text, text);
drop function if exists public.coupang_rank_manual_claim(uuid, text, text, text, text);
drop function if exists public.coupang_rank_manual_summary(uuid);

drop table if exists public.coupang_rank_manual_claims;

drop index if exists public.coupang_rank_runs_manual_idx;
alter table if exists public.coupang_rank_runs
  drop column if exists requested_by,
  drop column if exists source;

alter table if exists public.coupang_rank_settings
  drop constraint if exists coupang_rank_settings_manual_hours_chk;
alter table if exists public.coupang_rank_settings
  drop column if exists manual_stopped_code,
  drop column if exists manual_stopped_run_id,
  drop column if exists manual_stopped_at,
  drop column if exists manual_stopped_day,
  drop column if exists manual_last_search_at,
  drop column if exists manual_last_claim_at,
  drop column if exists manual_to_hour,
  drop column if exists manual_from_hour,
  drop column if exists manual_max_per_day,
  drop column if exists manual_min_gap_seconds,
  drop column if exists manual_enabled;

notify pgrst, 'reload schema';

commit;

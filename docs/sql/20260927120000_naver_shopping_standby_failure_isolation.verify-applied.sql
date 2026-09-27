-- 20260927120000 대기기 실패 격리 적용 확인 (읽기 전용, Supabase SQL 편집기에서 실행).
-- 정상: 9행 모두 applied = true (함수 3개 + 새 열 6개).
-- 함수 행이 false 면 마이그레이션이 적용되지 않았거나 되돌려진 상태다.
select 'function' as kind,
       proname as name,
       position('mi:standby-failure-isolation' in prosrc) > 0 as applied
from pg_proc
where proname in (
  'mi_claim_naver_shopping_worker_lane',
  'mi_record_naver_shopping_worker_failure',
  'mi_release_naver_shopping_worker_lane'
)
union all
select 'column' as kind,
       required.name,
       exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'naver_shopping_worker_coordination'
           and column_name = required.name
       ) as applied
from (
  values
    ('circuit_opened_by_worker'),
    ('standby_failure_worker_id'),
    ('standby_failure_streak'),
    ('standby_last_failure_at'),
    ('standby_last_failure_code'),
    ('standby_benched_until')
) as required(name)
order by 1 desc, 2;

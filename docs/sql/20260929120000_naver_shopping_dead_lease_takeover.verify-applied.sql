-- 20260929120000 죽은 잠금 인계 적용 확인 (읽기 전용, Supabase SQL 편집기에서 실행).
-- 정상: 10행 모두 applied = true (함수 2개 + 트리거 1개 + 새 열 7개).
-- 함수·트리거 행이 false 면 마이그레이션이 적용되지 않았거나 되돌려진 상태다(되돌린 뒤에도 열 7개는 남아 true).
select 'function' as kind,
       required.name,
       exists (
         select 1
         from pg_catalog.pg_proc as proc
         where proc.proname = required.name
           and position('mi:dead-lease-takeover' in proc.prosrc) > 0
       ) as applied
from (
  values
    ('mi_claim_naver_shopping_worker_lane'),
    ('mi_stamp_naver_shopping_worker_lease_heartbeat')
) as required(name)
union all
select 'trigger' as kind,
       'trg_mi_stamp_naver_shopping_worker_lease_heartbeat' as name,
       exists (
         select 1
         from pg_catalog.pg_trigger as trig
         join pg_catalog.pg_class as rel on rel.oid = trig.tgrelid
         where trig.tgname = 'trg_mi_stamp_naver_shopping_worker_lease_heartbeat'
           and rel.relname = 'naver_shopping_worker_coordination'
           and trig.tgenabled <> 'D'
       ) as applied
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
    ('lease_heartbeat_at'),
    ('lease_collection_started_at'),
    ('lease_reaped_at'),
    ('lease_reaped_worker_id'),
    ('lease_reaped_run_id'),
    ('lease_reaped_stage'),
    ('lease_reaped_by_worker_id')
) as required(name)
order by 1 desc, 2;

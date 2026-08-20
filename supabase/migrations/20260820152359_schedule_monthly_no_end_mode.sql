alter table public.schedule_items
add column if not exists recurrence_no_end boolean not null default false;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_recurrence_no_end_coherent
    check (
      not recurrence_no_end
      or (
        series_id is not null
        and recurrence_kind = 'monthly'
        and recurrence_until is not null
      )
    );
exception when duplicate_object then null;
end $$;

comment on column public.schedule_items.recurrence_no_end is
  '사용자가 반복 종료일을 정하지 않았음을 보존한다. recurrence_until은 현재 안전하게 물리 생성된 마지막 날짜다.';

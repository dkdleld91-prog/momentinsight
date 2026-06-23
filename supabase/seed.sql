begin;

with demo_client as (
  insert into public.clients (
    id,
    name,
    business_name,
    agency_code,
    status,
    public_summary,
    internal_note
  )
  values (
    '11111111-1111-4111-8111-111111111111',
    '비타민 앰플 데모',
    '모먼트 인사이트 데모 광고주',
    'MI-DEMO-01',
    'active',
    '이번 달 핵심 지표와 실행 일정을 확인할 수 있는 데모 광고주입니다.',
    '내부 테스트용 샘플 광고주입니다.'
  )
  on conflict (id) do update
  set name = excluded.name,
      public_summary = excluded.public_summary,
      internal_note = excluded.internal_note
  returning id
),
demo_brand as (
  insert into public.brands (
    id,
    client_id,
    name,
    category,
    main_marketplace,
    status
  )
  values (
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    '비타민 앰플',
    '뷰티/스킨케어',
    'naver',
    'active'
  )
  on conflict (id) do update
  set name = excluded.name,
      category = excluded.category,
      main_marketplace = excluded.main_marketplace
  returning id
)
insert into public.dashboard_snapshots (
  client_id,
  brand_id,
  period,
  sales,
  ad_spend,
  impressions,
  clicks,
  orders,
  reviews,
  conversion_rate,
  click_rate,
  achievement_rate,
  public_comment,
  internal_note
)
values (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  date_trunc('month', now())::date,
  18400000,
  3200000,
  420000,
  16800,
  530,
  74,
  3.15,
  4.00,
  82.5,
  '매출과 ROAS 흐름은 양호하며, 검색 키워드 보강이 다음 우선순위입니다.',
  '네이버 검색광고 예산 증액 전 키워드 효율을 한 번 더 확인합니다.'
)
on conflict (client_id, brand_id, period) do update
set sales = excluded.sales,
    ad_spend = excluded.ad_spend,
    impressions = excluded.impressions,
    clicks = excluded.clicks,
    orders = excluded.orders,
    reviews = excluded.reviews,
    conversion_rate = excluded.conversion_rate,
    click_rate = excluded.click_rate,
    achievement_rate = excluded.achievement_rate,
    public_comment = excluded.public_comment,
    internal_note = excluded.internal_note;

insert into public.reports (
  client_id,
  brand_id,
  report_type,
  title,
  report_date,
  period_start,
  period_end,
  summary,
  public_comment,
  internal_note,
  visibility
)
values (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'weekly',
  '6월 4주차 주간 보고서',
  current_date,
  current_date - interval '7 days',
  current_date,
  '검색 유입과 구매 전환이 함께 상승했습니다.',
  '다음 주에는 고효율 키워드 중심으로 예산을 재배치합니다.',
  '광고주에게는 예산 증액 표현보다 효율 개선 중심으로 안내합니다.',
  'client_visible'
)
on conflict do nothing;

insert into public.schedule_items (
  client_id,
  brand_id,
  title,
  schedule_type,
  status,
  starts_at,
  ends_at,
  public_comment,
  internal_note,
  visibility
)
values (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '네이버 검색광고 키워드 재정리',
  'keyword',
  'planned',
  now() + interval '2 days',
  now() + interval '2 days 2 hours',
  '검색량이 높은 키워드 위주로 광고 그룹을 정리할 예정입니다.',
  '작업 전 키워드 제외 목록 확인 필요.',
  'client_visible'
)
on conflict do nothing;

insert into public.action_plans (
  client_id,
  brand_id,
  period_week,
  title,
  category,
  priority,
  status,
  description,
  expected_impact,
  client_request,
  internal_note,
  is_client_visible
)
values (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  date_trunc('week', now())::date,
  '검색 상위 키워드 중심 예산 재배치',
  'keyword',
  'high',
  'planned',
  '전환 기여도가 높은 네이버 검색 키워드에 예산을 우선 배치합니다.',
  'ROAS 유지와 구매 수량 증가를 기대합니다.',
  '프로모션 가능 기간을 확인해주세요.',
  '광고비 증액안은 내부 승인 후 공개.',
  true
)
on conflict do nothing;

commit;

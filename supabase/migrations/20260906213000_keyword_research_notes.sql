-- 키워드 조사 노트(2026-09-06): 키워드 조회 결과를 광고주 계정 단위로 저장한다.
-- 순위 수집·추적 표와 무관한 독립 표. 서비스 롤로만 접근(RLS 활성, 정책 없음 = anon/authenticated 차단).
create table if not exists public.keyword_research_notes (
  id uuid primary key default gen_random_uuid(),
  agency_code text not null,
  title text not null default '',
  keywords text[] not null default '{}',
  snapshots jsonb not null default '[]'::jsonb,
  created_by_role text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists keyword_research_notes_agency_created_idx
  on public.keyword_research_notes (agency_code, created_at desc);

alter table public.keyword_research_notes enable row level security;
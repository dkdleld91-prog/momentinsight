begin;

-- 계정별 개인 캘린더 공간 — 스키마 골격(P1).
-- 대표 결재(2026-08-25)로 "MI 공유 일정" 개념은 폐기됐다. 모든 계정(대표
-- mml93-a01 · 각 운영팀 · 각 광고주)이 각자 개인 캘린더 하나만 쓰고 남의
-- 일정은 보이지 않는다. 공유는 구글 네이티브(참석자 초대 · 캘린더 공유)로만 한다.
--
-- 실행 전 반드시 눈으로 확인한다:
--   select owner_agency_code from public.owner_google_integrations;
--   → 'mml93-a01' 단 한 행이어야 한다. 아니면 다음 파일(…090100)의 형식
--     CHECK 가 기존 행을 거절해 그 파일이 통째로 롤백된다.
--
-- 가산(additive) · 멱등(idempotent) · 재실행 안전. 새 테이블이 없으므로
-- RLS/grant 는 기존 것(정책 없는 강제 RLS + service_role 전용)을 그대로 상속한다.
-- 대표님 기존 행 백필은 이 파일에 없다. 대표실 화면 전환과 같은 배포에 묶지
-- 않으면 그 순간 대표실이 비기 때문에, 별도 파일로 Phase 6 에서만 실행한다.

-- ─────────────────────────────────────────────────────────────
-- 1) schedule_items: 개인 공간 꼬리표
--    personal_role IS NOT NULL ⟺ 그 계정 단독 개인 공간.
--    이 한 줄이 이 설계의 유일한 격리 불변식이다.
-- ─────────────────────────────────────────────────────────────
alter table public.schedule_items add column if not exists personal_role text;
alter table public.schedule_items add column if not exists personal_code text;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_personal_pair
    check (
      (personal_role is null and personal_code is null)
      or (
        personal_role in ('owner', 'team', 'client')
        and personal_code is not null
        and char_length(btrim(personal_code)) between 3 and 128
      )
    );
exception when duplicate_object then null; end $$;

-- 개인 행에서는 owner_agency_code 가 개인키를 담는다. 두 표현이 어긋나면
-- 동기화 엔진(matchRowForEvent, pushPendingRows)이 남의 행을 집는다.
-- 함수 없이 인라인 CASE 로 박아 pg_dump 순서 문제도 만들지 않는다.
do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_personal_key_matches_owner_code
    check (
      personal_role is null
      or lower(btrim(owner_agency_code)) = case
           when personal_role = 'owner' then lower(btrim(personal_code))
           else personal_role || ':' || lower(btrim(personal_code))
         end
    );
exception when duplicate_object then null; end $$;

comment on column public.schedule_items.personal_role is
  'owner/team/client 이면 그 계정 단독 개인 캘린더 일정이며 다른 계정에서 절대 보이지 않는다. 신규 개인 행은 전 계정 필수이고, NULL 은 P6 백필 이전의 대표님 레거시 운영 행뿐이다.';
comment on column public.schedule_items.personal_code is
  '개인 공간 소유자 식별자. owner=''mml93-a01'', team=operation_team_codes.id, client=clients.id.';

-- ─────────────────────────────────────────────────────────────
-- 2) 조회 인덱스
--    개인 조회는 언제나 (역할, 코드)로 계정을 좁힌 뒤 기간을 자르므로
--    그 순서로 만들어야 격리 술어가 인덱스 안에서 끝난다.
-- ─────────────────────────────────────────────────────────────
create index if not exists idx_schedule_items_personal_start
on public.schedule_items (personal_role, personal_code, starts_at)
where personal_role is not null;

create index if not exists idx_schedule_items_personal_retry
on public.schedule_items (personal_role, personal_code, google_sync_state)
where personal_role is not null and google_sync_state in ('pending', 'failed');

-- P6 백필 전까지 운영 조회가 personal_role IS NULL 을 계속 타므로 그 경로도 받쳐 준다.
create index if not exists idx_schedule_items_operational_start
on public.schedule_items (owner_agency_code, starts_at)
where personal_role is null and calendar_id is null;

commit;

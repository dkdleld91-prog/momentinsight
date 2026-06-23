# 모먼트 인사이트

마케팅 데이터를 정리하는 성과 대시보드입니다. 마케팅 대행사가 광고주별 KPI, 매출, 광고 성과, 키워드, 보고서, 일정, 실행 인사이트를 한곳에서 관리하고 공유하기 위한 B2B SaaS 대시보드 프로젝트입니다.

이 저장소는 먼저 제품 구조와 기획 문서를 기준으로 정리되어 있습니다. 이후 Next.js 기반 프론트엔드, 인증, DB, 파일 업로드, 외부 데이터 연동을 단계적으로 붙이는 방향을 전제로 합니다.

## 핵심 방향

- 광고주별 독립 워크스페이스 제공
- 관리자와 광고주 화면 분리
- 현재 상태 요약에서 다음 액션까지 이어지는 대시보드 흐름
- KPI, 보고서, 일정, 파일, 코멘트의 운영 중심 관리
- 내부 메모와 광고주 공개 코멘트의 명확한 분리
- 1차 MVP는 수동 입력과 업로드 기반으로 빠르게 운영 가능하게 구축
- 2차부터 채널별 분석, 키워드 인사이트, 자동 그래프 확장
- 3차부터 네이버, 쿠팡, 메타, 구글시트, 엑셀 연동 고려

## 추천 기술 스택

초기 개발 기준 권장안입니다.

- Frontend: Next.js, React, TypeScript
- Styling: Tailwind CSS 또는 CSS Modules
- UI: shadcn/ui 계열 컴포넌트 구조, lucide-react 아이콘
- Backend: Next.js Route Handlers 또는 NestJS API
- Database: PostgreSQL
- ORM: Prisma
- Auth: NextAuth/Auth.js 또는 Supabase Auth
- File Storage: Supabase Storage, S3 호환 스토리지, Google Drive 링크 병행
- Charts: Recharts 또는 Tremor 기반 차트
- Deployment: Vercel, Railway, Supabase 조합

## 현재 저장소 구조

```txt
.
├── AGENTS.md
├── README.md
├── database/
│   └── schema-draft.md
├── docs/
│   ├── 00-project-structure.md
│   ├── 01-product-requirements.md
│   ├── 02-information-architecture.md
│   ├── 03-page-specification.md
│   ├── 04-data-model.md
│   ├── 05-ui-components.md
│   ├── 06-mvp-roadmap.md
│   └── 07-development-guidelines.md
├── public/
│   └── assets/
└── src/
    ├── app/
    ├── components/
    ├── data/
    ├── features/
    ├── lib/
    └── types/
```

## 주요 메뉴

- Dashboard
- KPI Report
- Sales Report
- Ads Performance
- Keyword Analysis
- Weekly Report
- Monthly Report
- Schedule
- Files
- Action Plan
- Client Management
- Admin Settings

## 1차 MVP 범위

1차는 실제 대행사 운영에 필요한 최소 기능을 우선합니다.

- 관리자 로그인
- 광고주 계정 및 브랜드 생성
- 광고주별 대시보드
- 월간 KPI 목표와 실제값 입력
- 보고서 업로드 및 링크 등록
- 일정 캘린더 및 리스트
- 공개 코멘트와 내부 메모 분리
- 광고주 전용 화면에서 본인 데이터만 조회

## 문서 안내

- [제품 요구사항](docs/01-product-requirements.md)
- [정보 구조와 메뉴](docs/02-information-architecture.md)
- [페이지별 기능 정의](docs/03-page-specification.md)
- [데이터 모델](docs/04-data-model.md)
- [UI 컴포넌트 설계](docs/05-ui-components.md)
- [MVP 로드맵](docs/06-mvp-roadmap.md)
- [개발 가이드](docs/07-development-guidelines.md)
- [DB 초안](database/schema-draft.md)

## 다음 개발 단계

1. Next.js, TypeScript, Tailwind CSS 프로젝트 초기화
2. 인증, 권한, 광고주 선택 구조 구현
3. 대시보드 샘플 데이터와 UI 컴포넌트 구현
4. KPI, 보고서, 일정 CRUD 구현
5. PostgreSQL, Prisma 스키마 반영
6. 파일 업로드와 링크 관리 구현
7. 채널별 광고 성과와 키워드 분석 확장

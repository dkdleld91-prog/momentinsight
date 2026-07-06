# 프로젝트 구조

이 저장소는 문서, 데이터 모델, 프론트엔드 기능 영역을 분리해 관리합니다.

```txt
.
├── README.md
├── AGENTS.md
├── docs/
├── database/
├── public/
└── src/
```

## docs

서비스 기획, 화면 정의, 데이터 구조, 개발 우선순위를 보관합니다. 기능 구현 전에 기준 문서로 사용합니다.

## database

DB 테이블 초안, ERD 설명, 마이그레이션 전 설계 자료를 보관합니다. Prisma를 도입하면 `prisma/schema.prisma`로 구체화합니다.

## src/app

Next.js App Router 기준 라우트 영역입니다.

예상 라우트:

- `/login`
- `/dashboard`
- `/kpi-report`
- `/sales-report`
- `/ads-performance`
- `/keyword-analysis`
- `/monthly-report`
- `/schedule`
- `/files`
- `/action-plan`
- `/admin/clients`
- `/admin/settings`

## src/features

도메인 기능별 UI, 훅, 유틸, 타입을 배치합니다.

- `dashboard`: 메인 요약 대시보드
- `kpi`: KPI 목표, 실적, 달성률
- `reports`: 주간, 월간, KPI, 캠페인 보고서
- `schedule`: 캘린더와 리스트 일정
- `admin`: 광고주, 권한, 브랜드 관리
- `ads-performance`: 채널별 광고 성과
- `keyword-analysis`: 키워드 순위와 인사이트
- `action-plan`: 실행 계획과 확인 요청
- `files`: 업로드 파일과 외부 링크

## src/components

여러 기능에서 공유하는 UI 컴포넌트를 둡니다.

- Layout
- Sidebar
- Header
- MetricCard
- ProgressBar
- StatusBadge
- DataTable
- ChartCard
- EmptyState
- UploadBox

## src/lib

공통 유틸과 클라이언트 설정을 둡니다.

- 인증 유틸
- 권한 체크
- 숫자 포맷
- KPI 계산
- 날짜 포맷
- 파일 업로드 헬퍼

## src/types

공용 타입을 둡니다.

- UserRole
- Client
- Brand
- KPI
- Report
- ScheduleItem
- ChannelPerformance
- KeywordMetric
- ActionPlan

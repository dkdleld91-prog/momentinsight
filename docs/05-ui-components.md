# 핵심 UI 컴포넌트

## 디자인 톤

- 전문적이고 신뢰감 있는 B2B SaaS
- 블랙, 화이트, 그레이, 딥네이비 중심
- 과도한 원색 대신 상태 표현에만 제한적으로 컬러 사용
- 카드, 표, 차트, 배지를 일관되게 사용
- 숫자보다 해석과 다음 액션이 돋보이게 구성

## 레이아웃

### AppShell

- 좌측 사이드바
- 상단 헤더
- 광고주 선택 드롭다운
- 기간 선택 필터
- 사용자 메뉴

### Sidebar

메뉴:

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

광고주 계정은 관리자 메뉴를 숨깁니다.

## 대시보드 컴포넌트

### StatusSummary

현재 브랜드 상태를 문장과 핵심 지표로 요약합니다.

예시:

- 이번 달 매출은 목표 대비 78% 진행
- 광고비는 예산 대비 64% 사용
- ROAS는 전월 대비 12% 상승
- 키워드 3개는 보완 작업 필요

### MetricCard

핵심 수치를 크게 보여주는 카드입니다.

속성:

- title
- value
- unit
- delta
- deltaDirection
- targetRate
- helperText

### ProgressBar

목표 대비 달성률을 표시합니다.

사용 위치:

- 월간 KPI
- 광고비 사용률
- 보고서 제출률
- 액션 플랜 진행률

### StatusBadge

일정과 작업 상태를 표시합니다.

상태:

- 예정
- 진행 중
- 완료
- 보류
- 확인 필요

### ChannelPerformanceCard

채널별 광고 성과를 보여줍니다.

표시 항목:

- 채널명
- 광고비
- 매출
- ROAS
- CTR
- CVR
- 전월 대비 변화

### InsightPanel

데이터 해석과 실행 방향을 정리합니다.

섹션:

- 이번 주 핵심 변화
- 성과가 좋은 채널
- 성과가 낮은 채널
- 개선 필요 지표
- 다음 액션

### ActionPlanList

실행 계획을 우선순위와 상태로 보여줍니다.

표시 항목:

- 제목
- 카테고리
- 우선순위
- 담당자
- 상태
- 광고주 확인 필요 여부

## 테이블 컴포넌트

### DataTable

공통 표 컴포넌트입니다.

기능:

- 정렬
- 필터
- 페이지네이션
- 빈 상태
- 로딩 상태
- 행 클릭 상세 보기

### ReportTable

보고서 목록 전용 표입니다.

필터:

- 광고주명
- 브랜드명
- 채널명
- 보고서 유형
- 기간
- 공개 여부

### KeywordTable

키워드 분석 표입니다.

컬럼:

- 키워드
- 현재 순위
- 이전 순위
- 변화
- 검색량
- CTR
- 전환 기여도
- 광고 노출 여부
- SEO 작업 필요 여부
- 인사이트

## 입력 컴포넌트

### KpiInputForm

관리자가 월간 목표와 실적을 입력합니다.

### ReportUploadForm

보고서 파일과 외부 링크를 등록합니다.

지원 항목:

- PDF
- 이미지
- 엑셀
- 구글 드라이브 링크
- 노션 링크

### ScheduleForm

일정을 등록하고 상태를 변경합니다.

### CommentFields

내부 메모와 광고주 공개 코멘트를 동시에 입력하되 시각적으로 분리합니다.

필드:

- public_comment
- internal_note

## 차트 컴포넌트

### KpiTrendChart

월별 KPI 추이를 표시합니다.

### ChannelComparisonChart

채널별 광고비, 매출, ROAS를 비교합니다.

### FunnelChart

노출, 클릭, 전환, 구매 흐름을 표시합니다.

### KeywordRankChart

키워드 순위 변화를 표시합니다.


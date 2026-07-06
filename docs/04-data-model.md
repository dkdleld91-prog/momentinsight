# 데이터 모델

## 설계 원칙

- 광고주 단위 데이터 격리를 기본으로 한다.
- 브랜드가 여러 개인 광고주를 고려해 `client_id`와 `brand_id`를 분리한다.
- 모든 운영 데이터는 작성자, 공개 여부, 기간 정보를 가진다.
- 내부 메모와 광고주 공개 코멘트는 별도 필드 또는 별도 테이블로 분리한다.
- 1차 MVP에서는 수동 입력을 기준으로 하고, 3차 연동 단계에서 외부 데이터 원본을 연결한다.

## 주요 엔티티

| 엔티티 | 설명 |
| --- | --- |
| users | 관리자와 광고주 사용자 |
| clients | 광고주 회사 |
| brands | 광고주가 운영하는 브랜드 |
| client_members | 사용자와 광고주 연결 및 권한 |
| channels | 네이버, 쿠팡, 메타 등 채널 |
| kpi_targets | 월간 KPI 목표 |
| kpi_results | 실제 KPI 실적 |
| sales_reports | 매출 보고 데이터 |
| ad_performance | 채널별 광고 성과 |
| campaign_performance | 캠페인별 성과 |
| creative_performance | 소재별 성과 |
| keywords | 핵심 키워드 마스터 |
| keyword_metrics | 키워드 순위와 성과 |
| reports | 업로드 보고서와 외부 링크 |
| schedule_items | 일정 |
| action_plans | 실행 계획 |
| comments | 공개 코멘트와 내부 메모 |
| files | 업로드 파일과 링크 |
| audit_logs | 주요 변경 기록 |

## 핵심 테이블 구조

### users

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | 사용자 ID |
| name | text | 이름 |
| email | text | 이메일 |
| role | enum | super_admin, manager, analyst, client_owner, client_viewer |
| status | enum | active, invited, suspended |
| created_at | timestamp | 생성일 |
| updated_at | timestamp | 수정일 |

### clients

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | 광고주 ID |
| name | text | 광고주명 |
| business_name | text | 사업자명 |
| status | enum | active, paused, archived |
| primary_manager_id | uuid | 담당 관리자 |
| public_summary | text | 광고주 공개 요약 |
| internal_note | text | 내부 메모 |
| created_at | timestamp | 생성일 |
| updated_at | timestamp | 수정일 |

### brands

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | 브랜드 ID |
| client_id | uuid | 광고주 ID |
| name | text | 브랜드명 |
| category | text | 업종 |
| main_marketplace | text | 주력 판매 채널 |
| status | enum | active, paused, archived |
| created_at | timestamp | 생성일 |
| updated_at | timestamp | 수정일 |

### kpi_targets

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | KPI 목표 ID |
| client_id | uuid | 광고주 ID |
| brand_id | uuid | 브랜드 ID |
| period_month | date | 기준 월 |
| target_revenue | numeric | 목표 매출 |
| target_ad_spend | numeric | 목표 광고비 |
| target_roas | numeric | 목표 ROAS |
| target_orders | integer | 목표 구매 수량 |
| target_reviews | integer | 목표 리뷰 수 |
| target_keyword_rank | numeric | 목표 키워드 평균 순위 |
| created_by | uuid | 작성자 |
| created_at | timestamp | 생성일 |

### kpi_results

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | KPI 실적 ID |
| kpi_target_id | uuid | KPI 목표 ID |
| actual_revenue | numeric | 실제 매출 |
| actual_ad_spend | numeric | 실제 광고비 |
| actual_roas | numeric | 실제 ROAS |
| actual_orders | integer | 실제 구매 수량 |
| actual_cpa | numeric | CPA |
| actual_cpc | numeric | CPC |
| actual_ctr | numeric | CTR |
| actual_cvr | numeric | CVR |
| actual_reviews | integer | 리뷰 수 |
| achievement_rate | numeric | 평균 달성률 |
| public_comment | text | 광고주 공개 코멘트 |
| internal_note | text | 내부 메모 |
| updated_at | timestamp | 수정일 |

### ad_performance

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | 광고 성과 ID |
| client_id | uuid | 광고주 ID |
| brand_id | uuid | 브랜드 ID |
| channel_id | uuid | 채널 ID |
| period_start | date | 시작일 |
| period_end | date | 종료일 |
| ad_spend | numeric | 광고비 |
| revenue | numeric | 매출 |
| roas | numeric | ROAS |
| impressions | integer | 노출수 |
| clicks | integer | 클릭수 |
| ctr | numeric | 클릭률 |
| conversions | integer | 전환수 |
| cvr | numeric | 전환율 |
| orders | integer | 구매 수량 |
| cpa | numeric | CPA |
| cpc | numeric | CPC |
| previous_delta_rate | numeric | 전월 대비 변화율 |

### keywords

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | 키워드 ID |
| client_id | uuid | 광고주 ID |
| brand_id | uuid | 브랜드 ID |
| keyword | text | 키워드명 |
| priority | enum | high, medium, low |
| target_channel | text | 주요 채널 |
| is_active | boolean | 사용 여부 |

### keyword_metrics

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | 키워드 성과 ID |
| keyword_id | uuid | 키워드 ID |
| period_date | date | 기준일 |
| current_rank | integer | 현재 순위 |
| previous_rank | integer | 이전 순위 |
| search_volume | integer | 검색량 |
| impressions | integer | 노출수 |
| ctr | numeric | 클릭률 |
| conversion_contribution | numeric | 전환 기여도 |
| naver_rank | integer | 네이버 순위 |
| coupang_rank | integer | 쿠팡 순위 |
| is_ad_exposed | boolean | 광고 노출 여부 |
| needs_seo_work | boolean | SEO 작업 필요 여부 |
| insight | text | 보완 인사이트 |

### reports

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | 보고서 ID |
| client_id | uuid | 광고주 ID |
| brand_id | uuid | 브랜드 ID |
| report_type | enum | monthly, kpi, sales, ads, keyword, campaign, content |
| title | text | 제목 |
| report_date | date | 보고 기준일 |
| period_start | date | 시작일 |
| period_end | date | 종료일 |
| channel_id | uuid | 관련 채널 |
| summary | text | 요약 |
| public_comment | text | 광고주 공개 코멘트 |
| internal_note | text | 내부 메모 |
| visibility | enum | internal, client_visible |
| created_by | uuid | 작성자 |
| created_at | timestamp | 생성일 |

### schedule_items

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | 일정 ID |
| client_id | uuid | 광고주 ID |
| brand_id | uuid | 브랜드 ID |
| title | text | 일정 제목 |
| schedule_type | enum | ad_setup, content_upload, distribution, review, shooting, promotion, report_due, meeting, creative, keyword |
| status | enum | planned, in_progress, done, paused, needs_check |
| starts_at | timestamp | 시작일시 |
| ends_at | timestamp | 종료일시 |
| assignee_id | uuid | 담당자 |
| public_comment | text | 광고주 공개 코멘트 |
| internal_note | text | 내부 메모 |

### action_plans

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| id | uuid | 액션 플랜 ID |
| client_id | uuid | 광고주 ID |
| brand_id | uuid | 브랜드 ID |
| period_week | date | 기준 주 |
| title | text | 실행 계획 제목 |
| category | enum | budget, keyword, content, campaign, report, client_check |
| priority | enum | high, medium, low |
| status | enum | planned, in_progress, done, blocked |
| description | text | 실행 내용 |
| expected_impact | text | 기대 효과 |
| client_request | text | 광고주 확인 필요 사항 |
| is_client_visible | boolean | 광고주 공개 여부 |

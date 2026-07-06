# DB 스키마 초안

이 문서는 Prisma 또는 SQL 마이그레이션 작성 전의 설계 초안입니다.

## Enum

```txt
user_role: super_admin, manager, analyst, client_owner, client_viewer
user_status: active, invited, suspended
client_status: active, paused, archived
visibility: internal, client_visible
schedule_status: planned, in_progress, done, paused, needs_check
priority: high, medium, low
action_status: planned, in_progress, done, blocked
report_type: monthly, kpi, sales, ads, keyword, campaign, content
```

## MVP 테이블

1차 개발에서 우선 구현할 테이블입니다.

```txt
users
clients
brands
client_members
kpi_targets
kpi_results
reports
files
schedule_items
action_plans
comments
audit_logs
```

## 2차 확장 테이블

```txt
channels
ad_performance
campaign_performance
creative_performance
keywords
keyword_metrics
sales_reports
```

## 3차 연동 테이블

```txt
data_sources
integration_accounts
import_jobs
raw_import_rows
metric_snapshots
```

## 관계 요약

```txt
clients 1:N brands
clients 1:N client_members
users 1:N client_members
clients 1:N kpi_targets
kpi_targets 1:1 kpi_results
clients 1:N reports
reports 1:N files
clients 1:N schedule_items
clients 1:N action_plans
clients 1:N comments
brands 1:N ad_performance
brands 1:N keywords
keywords 1:N keyword_metrics
```

## 필수 인덱스

- `client_members.user_id`
- `client_members.client_id`
- `brands.client_id`
- `kpi_targets.client_id, kpi_targets.period_month`
- `reports.client_id, reports.report_date`
- `reports.client_id, reports.report_type`
- `schedule_items.client_id, schedule_items.starts_at`
- `action_plans.client_id, action_plans.period_week`
- `ad_performance.client_id, ad_performance.period_start`
- `keyword_metrics.keyword_id, keyword_metrics.period_date`

## 공개 데이터 주의사항

광고주 사용자에게 내려가는 조회 쿼리는 다음 조건을 기본으로 가져야 합니다.

```txt
client_id in current_user.allowed_client_ids
visibility = client_visible
internal_note is not selected
```

RLS는 행 접근 제어이지 컬럼 보안이 아닙니다. 광고주용 조회는 `select *`를 금지하고, 내부 메모가 없는 client-safe view 또는 명시적 컬럼 select만 사용해야 합니다. `internal_note`, 내부 비용, 미승인 보고서 필드는 관리자 전용 API에서만 내려갑니다.

관리자 화면은 내부 메모를 볼 수 있지만, 공개 코멘트와 같은 영역에 섞어 보여주면 안 됩니다.

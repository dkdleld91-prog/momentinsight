# 모먼트 인사이트

마케팅 데이터를 정리하는 성과 대시보드입니다. 마케팅 대행사가 광고주별 KPI, 매출, 광고 성과, 키워드, 보고서, 일정, 실행 인사이트를 한곳에서 관리하고 공유하기 위한 B2B SaaS 대시보드 프로젝트입니다.

현재 저장소는 정적 HTML 기반 화면, Vercel Serverless API, Supabase DB를 조합한 MVP 운영 구조입니다. Next.js 전환은 추후 선택 사항이며, 지금 운영 기준은 `02_아임웹_적용코드`의 화면 파일과 `src/server`의 API 핸들러입니다.

## 핵심 방향

- 광고주별 독립 워크스페이스 제공
- 관리자와 광고주 화면 분리
- 현재 상태 요약에서 다음 액션까지 이어지는 대시보드 흐름
- KPI, 보고서, 일정, 파일, 코멘트의 운영 중심 관리
- 내부 메모와 광고주 공개 코멘트의 명확한 분리
- 1차 MVP는 수동 입력과 업로드 기반으로 빠르게 운영 가능하게 구축
- 2차부터 채널별 분석, 키워드 인사이트, 자동 그래프 확장
- 3차부터 네이버, 쿠팡, 메타, 구글시트, 엑셀 연동 고려

## 현재 기술 구조

- Frontend: 정적 HTML/CSS/JavaScript
- Backend: Vercel Serverless API, `@supabase/server`
- Database: Supabase PostgreSQL
- Automation: GitHub Actions twice-daily rank tracking cron
- Deployment: Vercel Production, `https://insight.momentlabs.co.kr`
- Local build: `npm run build:vercel`

## 현재 저장소 구조

```txt
.
├── AGENTS.md
├── README.md
├── .github/workflows/
│   └── naver-rank-cron.yml
├── 02_아임웹_적용코드/
│   ├── 아임웹_원샷코드_홈페이지형_모먼트인사이트.html
│   ├── 아임웹_원샷코드_관리자형_모먼트인사이트.html
│   └── 아임웹_원샷코드_대시보드형_모먼트인사이트.html
├── 03_운영시트_템플릿/
├── 05_네이버_API_연동/
├── 06_Supabase_연동/
├── api/
│   └── index.mjs
├── docs/
│   └── 08-work-spec-autosave.md
├── public/
│   └── downloads/
├── scripts/
├── supabase/
└── src/
    └── server/
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

1차는 실제 대행사 운영에 필요한 최소 기능을 우선합니다. 현재 구현 기준은 아래 범위입니다.

- 총관리자, 운영팀, 광고주 코드 기반 접속
- 총관리자의 운영팀/광고주 코드 생성과 권한 해제
- 운영팀 1개당 광고주 1개 연결
- 광고주별 대시보드와 공개 데이터 분리
- 월간 KPI 목표와 실제값 입력
- 보고서 다운로드 영역
- 운영 원본 파일 업로드/다운로드 MVP
- 일정 및 공개 코멘트 영역
- 공개 코멘트와 내부 메모 분리
- 키워드 조회, 네이버 상품 순위 추적, 네이버 SEO 확인, Meta 광고 조사

## 문서 안내

- [작업 명세서](docs/08-work-spec-autosave.md)
- [Supabase 연동 자료](06_Supabase_연동/README.md)
- [네이버 API 연동 자료](05_네이버_API_연동/README.md)

## 작업 폴더 정리

로컬에서 무거워지는 배포 산출물과 임시 캐시는 아래 명령으로 정리합니다.

```bash
npm run clean:workspace:dry
npm run clean:workspace
```

- 기본 정리 대상: `dist`, `supabase/.temp`, 임시 출력물, macOS 캐시 파일
- 기본 보존 대상: `.env.local`, `.vercel`, 루트 `node_modules`
- 의존성까지 다시 설치할 수 있을 때만 `npm run clean:workspace:deps`를 사용합니다.

## 작업명세 관리

개발 내역은 [작업 명세서](docs/08-work-spec-autosave.md)에 저장합니다.

```bash
npm run work:autosave
```

- 개발 완료 후에는 작업명세서에 완료 체크를 남기고 로컬 커밋합니다.
- `git push`, Vercel 배포, Supabase 배포는 운영상 필요하거나 별도 지시가 있을 때만 실행합니다.
- 자동 순위추적은 Vercel의 `MI_RANK_CRON_SECRET`과 GitHub Actions repository secret `MI_RANK_CRON_SECRET`이 같은 값이어야 정상 동작합니다.
- Meta 광고 조사는 공식 Meta 광고 라이브러리 검색 페이지로 연결하고, 확인한 소재 URL과 메모를 `meta_ad_research_items` 서버 DB에 저장합니다. DB 테이블이 아직 반영되지 않았거나 일시 장애가 있으면 화면은 브라우저 임시 저장으로 fallback됩니다. `META_AD_LIBRARY_ACCESS_TOKEN` 기반 API 조회는 Meta 정책 범위에서만 선택적으로 사용합니다.

## 다음 개발 단계

1. 보고서 업로드/다운로드를 Supabase Storage 기준으로 서버 저장화
2. 운영팀 입력 엑셀을 서버에서 파싱해 고정 보고서 디자인에 반영
3. 광고주별 공개 데이터 저장을 localStorage MVP에서 DB 저장 구조로 전환
4. 순위추적 실패/성공 로그를 운영 화면에서 더 명확하게 표시
5. 결제 전환 전 계정별 사용량 제한과 플랜 정책 정리

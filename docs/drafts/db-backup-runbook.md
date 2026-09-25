# DB 일일 백업 런북 (2026-09-07)

왜: 이용 기간 만료 + 유예 5일 뒤 광고주 데이터를 자동 삭제하는 크론이 매일 03:30·03:40 KST 에 돈다. 삭제 전 상태를 매일 03:00 KST 에 한 벌 남긴다. 복구 기능은 두지 않기로 했지만(대표 결정), 만료일을 잘못 잡은 사고에는 되돌릴 근거가 필요하다.

## 먼저 확인 — 이미 갖고 있는 것
- Supabase 대시보드 → Database → Backups. **Pro 플랜이면 일일 백업(7일)이 이미 있다.** 있으면 아래 로컬 백업은 보조다. 무료 플랜이면 백업이 없으므로 아래가 유일한 백업이다.

## 로컬 백업(맥, node 만 있으면 됨 · pg_dump 불필요)
스크립트 `scripts/db-export.mjs` — Supabase REST 를 서비스 키로 **읽기만** 해서 표별 `json.gz` 로 저장. 토큰 표(owner_google_integrations)와 워커 임시 표는 제외, 감사 기록은 최근 90일.

### 1) 자격증명 파일(한 번만, 채팅·저장소 금지)
```bash
mkdir -p ~/.config/momentinsight && touch ~/.config/momentinsight/backup.env && chmod 600 ~/.config/momentinsight/backup.env && open -e ~/.config/momentinsight/backup.env
```
편집기에 두 줄(값은 Supabase 대시보드 → Project Settings → API 에서):
```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role 키>
```

### 2) 손으로 한 번 실행해 확인
```bash
cd ~/Desktop/개발/모먼트\ 인사이트\ 개발 && node scripts/db-export.mjs --out ~/MomentInsightBackups
```
`~/MomentInsightBackups/2026-09-08_0300/` 같은 폴더에 표별 파일 + `manifest.json`(행 수·오류). 실패한 표가 있으면 종료 코드 1.

### 3) 매일 03:00 자동 실행(launchd)
```bash
cd ~/Desktop/개발/모먼트\ 인사이트\ 개발 && sed "s#__REPO__#$(pwd)#g; s#__HOME__#$HOME#g" scripts/db-export.launchd.plist.example > ~/Library/LaunchAgents/kr.co.momentlabs.insight.db-export.plist && launchctl unload ~/Library/LaunchAgents/kr.co.momentlabs.insight.db-export.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/kr.co.momentlabs.insight.db-export.plist && launchctl list | grep insight.db-export
```
- 로그: `~/MomentInsightBackups/launchd.log`
- 보관: 최근 14개 폴더(`--keep`), 그보다 오래된 백업 폴더는 자동 삭제.
- 맥이 03:00 에 잠자기 중이면 launchd 가 깨어난 뒤 바로 실행한다(놓치지 않음).

### 증분 백업(2026-09-25, Supabase 전송량 절감)
- 스냅숏 두 표(`naver_rank_snapshots`·`naver_place_rank_snapshots`)는 매일 통째로 받지 않는다. 표마다 **마지막으로 성공한 백업 폴더**의 파일을 기준으로 `created_at` 최댓값 − 2시간 이후 줄만 받아 합치고, 지워진 줄은 id 목록(`select=id`)으로 찾아 뺀 뒤, 서버 줄 수(`count=exact` HEAD)와 대조한다. 어긋나면(줄 수·모르는 줄·열 변경) 그 표만 통째로 다시 받는다.
- 나머지 22개 표는 예전처럼 통째로 받는다(합쳐 약 0.4MB). 예전 코드가 첫 1,000줄을 두 번 받던 중복도 없앴다.
- **결과 파일 형식·폴더 구조는 그대로**다. 증분으로 만든 파일도 통째로 받은 파일과 내용·순서가 같다(실제 백업 사본으로 확인: 09-24→09-25, 그리고 09-23 실패를 건너뛴 09-22→09-24 모두 24개 표 바이트 일치). 그래서 되돌리는 방법은 바뀌지 않는다.
- `manifest.json` 표마다 `method`(full·incremental·fallback)·`bytes`(받은 응답 본문, 압축 풀린 기준)·`requests`, 증분이면 `base`(기준 폴더)·`since`·`added`·`deleted`, 다시 받았으면 `fallbackReason`. 맨 아래 `totalBytes`·`totalRequests`.
- 요청마다 제한시간 120초(맥이 잠든 동안은 흐르지 않는 것으로 봄), 끊기면 5초·30초 뒤 두 번 더 시도한다(맥 잠자기 대비). 그래도 실패한 표는 다음 날 그 전 성공 폴더를 기준으로 이어 간다.
- 통째로 한 번 받고 싶으면(예: 스냅숏 줄을 고치는 마이그레이션 뒤): `node scripts/db-export.mjs --out ~/MomentInsightBackups --full`

### 되돌릴 때(수동)
백업 폴더의 `clients.json.gz` 등을 열어 해당 광고주 행을 확인하고, 총관리자 화면에서 광고주를 다시 만든 뒤 순위 추적 키워드를 다시 등록한다. 스냅샷(naver_rank_snapshots)은 참고용으로 보관하며 자동 복원 도구는 없다.

## 상태
- 2026-09-07: 스크립트·테스트·plist 예시 작성. 자격증명 파일과 launchd 등록은 대표가 실행해야 한다(비밀번호·키는 채팅에 올리지 않는다).

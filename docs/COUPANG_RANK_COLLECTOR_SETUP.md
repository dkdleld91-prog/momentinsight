# C 30일 순위(쿠팡) 수집기 설치 — 대표용

쿠팡 순위를 매일 기록하려면 사무실 PC 한 대에 '수집기'를 설치해야 합니다. 이 문서는 그 순서입니다.

- 순서: **시작 전 확인 → 1. 0단계 시험 → 2. 연결 코드 발급 → 3. 설치 → 4. 켜기 → 5. 확인 → 6. 제거**
- 단계마다 **어디서 실행하는지**와 **기대 출력 한 줄**을 적었습니다. 출력이 다르면 다음 단계로 가지 말고, 나온 줄을 그대로 보내 주세요.
- 기대 출력은 구현 명세(v3) 기준입니다. 실제 PC에서는 아직 한 번도 돌려 보지 않았습니다 **[미확인]**. 첫 설치 때 실제 출력을 보고 이 문서를 고칩니다.
- 수집기는 N30(네이버 순위)이 쓰는 크롬이 아니라 **Microsoft Edge**를 씁니다. 그래서 N30 업데이트·훈련·스케줄러와 서로 닿지 않습니다.
- 비용은 0원입니다. Edge와 Node.js는 무료이고, 유료 서비스는 쓰지 않습니다.
- 수집기는 **PC가 켜져 있고 그 사용자로 로그인되어 있을 때만** 돕니다. PC가 꺼지거나 잠자기에 들어가면 그동안은 기록이 비어 있습니다(따라잡지 않음).

---

## 시작 전 확인

| # | 할 일 | 어디서 | 기대 결과 |
|---|---|---|---|
| ① | 배포 확인(수집은 꺼진 상태) | 작업 담당 | 관리자 화면 메뉴에 `C 30일 순위`가 보이고, 열면 "대표 SQL 실행 전입니다(설정 필요)" |
| ② | 대표 SQL 실행 | **Supabase SQL 편집기용** | 아래 ②-1~②-3 |
| ③ | 무료 한도 확인 | Supabase 대시보드 | DB 크기 400MB 미만, 이번 달 전송량(egress)이 한도의 80% 미만. 넘으면 켜기를 보류합니다. 두 숫자를 캡처해 보내 주세요 |

**② 대표 SQL — Supabase SQL 편집기용**
1. 작업 담당이 바탕화면에 `C30-1-테이블만들기.txt`를 만들어 TextEdit로 열어 둡니다.
   - 만드는 줄(작업 담당, 맥 터미널): `bash ~/.claude/skills/mi-operator-feature/scripts/stage-sql.sh supabase/migrations/20261017090000_coupang_rank_tracking.sql C30-1-테이블만들기.txt`
   - 기대 출력: `준비됨: ~/Desktop/C30-1-테이블만들기.txt (1251줄, begin/commit 2개) — Supabase SQL 편집기용`
   - 같은 원문이 저장소 `docs/sql/c30-1-tables.sql`에도 있습니다(바이트 단위로 같음, sha256 `362b0fb5…a67c`).
2. TextEdit에서 전체 선택 → 복사 → Supabase SQL 편집기에 붙여 넣고 **Run**.
   - 기대: `Success`로 시작하는 문구(오류 빨간 글씨 없음). 정확한 문구는 화면에 나온 그대로 알려 주세요.
   - 다시 실행해도 안전합니다(이미 있는 표·함수는 그대로 둡니다).
3. 같은 편집기에서 아래 확인문을 **Run** → 결과 한 줄을 캡처해 보내 주세요.
   ```sql
   select
     (select count(*) from information_schema.tables
       where table_schema = 'public' and table_name like 'coupang\_rank\_%') as tables,        -- 9
     (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'coupang\_rank\_%') as functions,          -- 18
     (select enabled from public.coupang_rank_settings where id = 1) as enabled,             -- false
     (select window_mode from public.coupang_rank_settings where id = 1) as window_mode,     -- offscreen
     (select keyword_limit from public.coupang_rank_account_limits where agency_code = 'mml93-a01') as owner_limit; -- 100
   ```
   - 기대 결과 한 줄: `9 | 18 | false | offscreen | 100`
   - 그 뒤 관리자 화면 `C 30일 순위`의 상태 띠가 "수집기 연결 안 됨"으로 바뀝니다.

---

## 1. 0단계 시험(윈도우 데스크탑) — 윈도우 관리자 PowerShell용

서버에 아무것도 보내지 않고, 이 PC에서 쿠팡 검색을 5번만 재 보는 시험입니다. 결과는 이 PC에만 남습니다.

- **언제**: 10/19 12:00 맥 시험이 끝난 **뒤에만**. 같은 사무실 인터넷이면 두 시험이 겹쳐 판단이 흐려지기 때문입니다 [추정: 같은 공인 IP].
- **준비**: 이 PC에 Node.js 22~24, Microsoft Edge(윈도우 기본 설치)
- **줄**: 관리자 화면 `C 30일 순위` → 총관리자 수집기 칸 → `윈도우 설치·업데이트` 복사 → 끝에 ` -TrialOnly`를 붙여 실행
  ```powershell
  iwr -UseBasicParsing https://insight.momentlabs.co.kr/coupang-collector/install-windows.ps1 -OutFile "$env:TEMP\mi-coupang-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\mi-coupang-install.ps1" -Release <7자리> -TrialOnly
  ```
  - `<7자리>`는 화면 복사 버튼이 채웁니다. 손으로 고치지 마세요(배포가 바뀌면 줄도 바뀝니다).
  - 관리자 PowerShell = 시작 메뉴에서 **Windows PowerShell**을 오른쪽 클릭 → 관리자 권한으로 실행.
- **걸리는 시간**: 약 20~30분(5회, 4~6분 간격). 창을 닫지 말고 기다립니다. 창 안을 클릭하면 멈출 수 있으니, 눌렀다면 `Esc`를 누릅니다.
- **기대 출력 한 줄**:
  `MI_COUPANG_TRIAL runs=5 ok=5 blocked=0 stableAll=yes item60=3/3 modes=normal:1/1,offscreen:1/1,minimized:1/1 caseSame=yes cleanupFail=0 leftover=0 priority=BelowNormal avgMs=… browser=edge/…`

| 칸 | 합격 | 아니면 |
|---|---|---|
| `blocked` | `0` | `1`이면 **켜기 보류**. 그 줄을 보내 주세요. 다시 논의합니다 |
| `modes` | 고를 창 방식이 `1/1` | 그 방식은 쓰지 않습니다 |
| `stableAll` | `yes` | 줄을 보내 주세요 |
| `cleanupFail`·`leftover` | 둘 다 `0` | 줄을 보내 주세요 |
| `priority` | `BelowNormal`(또는 `Idle`) | 줄을 보내 주세요 |
| `caseSame` | `yes` | `no`면 작업 담당이 대소문자 설정을 바꿔 다시 배포한 뒤 진행합니다 |
| 창 방해 | 대표가 보기에 거슬리지 않음(또는 감수) | 다른 창 방식을 고릅니다 |

**창 방식 고르기**(시험 결과를 보고 대표가 정함)
- `offscreen`(기본): 화면에 창이 보이지 않습니다.
- `normal`: 약 4~6분마다 Edge 창이 떴다가 약 13초 뒤 저절로 닫힙니다. 닫아도 고장 나지 않고 그 회차만 실패로 남습니다. 그 창에서 다른 사이트로 가도 차단으로 세지 않습니다.
- `minimized`: 작업 표시줄에만 잠깐 나타납니다 [추정].

---

## 2. 연결 코드 발급 — 관리자 화면

**발급 전에**(켜기 조건, 하나라도 아니면 멈추고 다시 논의)
1. 맥 시험 결과에서 10/16 05:30(UTC) 뒤 차단(`403`·`429`·`503` 또는 `blocked`)이 0회 — 작업 담당이 확인합니다.
2. 1단계 시험이 `blocked=0`.
3. 대표가 정합니다: 하루 측정 횟수(`checksPerDay`, 기본 2)와 **시작 속도(시간당 최대 회차 `maxRunsPerHour`)**. 권장은 **6**입니다 **[결정 필요]**. 기본값이 12이므로, 6으로 정하면 총관리자 수집기 칸 설정에서 내려 저장합니다(내리기는 바로 됩니다. 올리기는 서버 규칙 때문에 48시간 조용한 기록이 있어야 합니다).
   - 6이면 하루 최대 90회 → 하루 2회 기준 키워드 약 45개까지 제때 잽니다.
4. 맥 시험을 내립니다(같은 인터넷에서 겹치지 않게) — **맥 터미널용**, 작업 담당이 대신 실행할 수 있습니다.
   ```bash
   launchctl bootout gui/$(id -u)/com.momentinsight.coupang-trial
   ```
   - 기대: 아무 출력 없이 끝남 [추정].

**발급**
1. 관리자 화면 `C 30일 순위` → 총관리자 수집기 칸 → `새 연결 코드 만들기` → 이름 `윈도우 데스크탑`.
2. 기대: `mic1_`로 시작하는 코드가 **한 번만** 보이고, 목록에 이름과 끝 4자리가 생깁니다.
3. 복사 버튼으로 복사해 두고 바로 3단계로 갑니다.
- **주의**: 이 창을 닫으면 코드를 다시 볼 수 없습니다. 수집기 PC의 설치 창에만 붙여 넣으세요. 채팅·메신저·메모에 남기지 마세요. 잃어버리면 `폐기`하고 새로 만듭니다.
- 연결 코드는 동시에 3개까지만 쓸 수 있습니다. 새 코드를 만들어도 옛 코드는 저절로 폐기되지 않습니다.

---

## 3. 설치 — 윈도우 관리자 PowerShell용(같은 데스크탑)

1. 관리자 화면에서 `윈도우 설치·업데이트`를 복사해 **그대로** 실행합니다(` -TrialOnly` 없이).
   ```powershell
   iwr -UseBasicParsing https://insight.momentlabs.co.kr/coupang-collector/install-windows.ps1 -OutFile "$env:TEMP\mi-coupang-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\mi-coupang-install.ps1" -Release <7자리>
   ```
2. `Paste connection code`가 나오면 2단계 코드를 붙여 넣고 `Enter`. 글자 대신 `*`만 보이는 것이 정상입니다.
3. 기대 출력 한 줄(받기·검사 뒤, 첫 실행 확인에 최대 약 2분 더 걸립니다):
   `MI_COUPANG_INSTALL_OK release=<7자리> version=1.0.0 node=<버전> browser=edge/<버전> task=Ready auth=ok first_run=<요약>`

실패하면 `MI_COUPANG_INSTALL_FAIL code=…` 한 줄이 나옵니다. 그 줄의 `code=…`를 아래 표에서 찾습니다.

| 나온 것 | 뜻 | 할 일 |
|---|---|---|
| `code=powershell_51_admin_required` | 관리자 Windows PowerShell(5.1)이 아님 | **Windows PowerShell**을 관리자 권한으로 열고 다시(PowerShell 7 아님) |
| `code=node_version_must_be_22_to_24` | Node.js 판이 맞지 않음 | Node.js 22 LTS를 설치한 뒤 다시 |
| `code=edge_not_found` | Edge를 못 찾음 | Edge를 설치·업데이트한 뒤 다시 |
| `code=release_mismatch` | 줄이 옛 배포 것 | 화면에서 줄을 **다시 복사**해 실행 |
| `code=connection_code_invalid` | 붙여 넣은 값이 연결 코드 형식이 아님(`mic1_`로 시작하지 않음, 설치 줄 전체 등) | 저장하지 않았습니다. 코드**만** 복사해 같은 줄을 다시 실행(처음 설치면 다시 묻습니다. 코드를 바꾸던 중이면 끝에 ` -ResetToken`을 붙입니다) |
| `code=auth_rejected` | 코드가 틀렸거나 폐기됨 | 새 코드를 만든 뒤 설치 줄 끝에 ` -ResetToken`을 붙여 다시 실행 |
| `code=auth_update_required` | 수집기 판이 낮음 | 화면에서 줄을 다시 복사해 실행(업데이트). 그래도 같으면 줄을 보내 주세요 |
| `code=auth_setup_required` | 대표 SQL 전 | 시작 전 확인 ②부터 |
| `code=auth_route_missing` | 서버 경로가 없음(다른 배포가 덮음) | 줄을 보내 주세요(작업 담당 확인) |
| `code=auth_unreachable` | 서버에 닿지 못함(인터넷·방화벽) | 인터넷 연결과 방화벽을 확인하고 같은 줄을 다시 실행 |
| `code=auth_error` | 서버 답을 알아보지 못함 | 줄 전체를 보내 주세요(작업 담당 확인) |
| 그 밖의 `code=…` | 표에 없는 실패 | 줄 전체를 보내 주세요 |

- 업데이트도 같은 한 줄입니다. 업데이트 때는 코드를 다시 묻지 않습니다.

---

## 4. 켜기 — 관리자 화면

1. 대표 계정(총관리자 대표 범위)에 추적을 **3~5개** 등록합니다.
   - 키워드 + 쿠팡 상품 주소. 주소는 **상품 페이지를 연 뒤 주소창의 주소**를 붙입니다(짧은 링크 `link.coupang.com`·`coupa.ng`는 안 됨).
   - 등록 결과 문구: "오늘 측정으로 바로 기록했습니다" 또는 "다음 수집 때(수집기가 켜져 있을 때) 첫 순위가 기록됩니다"
2. 총관리자 수집기 칸에서 `수집 켜기` → 확인.
3. 기대(상태 띠):
   - 08~23시: `정상 · 마지막 수집 HH:MM · 하루 n회(08~23시)` — 첫 수집 전에는 '마지막 수집' 칸이 비어 보일 수 있습니다 [미확인]
   - 그 밖 시간: `수집 시간이 아닙니다(08~23시)`
4. **첫 2시간 기준**(작업 담당이 확인): 회차 1회 이상, 차단 0, 시간당 회차가 설정값 이하, 카드의 30일 칸에 오늘 기록.

---

## 5. 확인 — 평소 점검

**화면**: 상태 띠가 `정상`이면 됩니다. 다른 문구별 조치는 `docs/RUNBOOK.md`의 "C 30일 순위(쿠팡)" 표를 봅니다.

**수집기 PC — 윈도우 PowerShell용**(관리자 창 그대로 써도 됩니다): 화면의 `윈도우 확인` 복사 줄
```powershell
Get-ScheduledTaskInfo -TaskName CoupangRank -TaskPath '\MomentInsight\' | Select-Object LastRunTime,LastTaskResult,NextRunTime; Get-Content "$env:LOCALAPPDATA\MomentInsight\CoupangRank\logs\worker.log" -Tail 10 -Encoding UTF8
```
- 기대: `LastRunTime`이 10분 안쪽, `LastTaskResult`가 `0` [추정: 수집기는 늘 0으로 끝남], `NextRunTime`이 10분 안쪽, 로그 마지막 줄들에 `run_end`.

**48~72시간 점검**(작업 담당): 48시간 차단 0·빈 쪽 0, 성공률 90% 이상, 남은 임시 프로필 0, N30 실패율이 켜기 전 3일보다 나빠지지 않음(기준 1.5%). 나빠지면 끄고 원인을 봅니다. 이 점검을 통과해야 속도 올리기·운영팀 공개를 판단합니다.

---

## 6. 제거

- **잠깐 멈추기**: 관리자 화면 `수집 끄기` — 다음 회차부터 바로 멈춥니다. 다시 켜면 이어서 잽니다.
- **완전히 지우기**
  1. 관리자 화면 `수집 끄기`
  2. **윈도우 관리자 PowerShell용**: 화면의 `윈도우 제거` 복사 줄
     ```powershell
     iwr -UseBasicParsing https://insight.momentlabs.co.kr/coupang-collector/install-windows.ps1 -OutFile "$env:TEMP\mi-coupang-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\mi-coupang-install.ps1" -Release <7자리> -Uninstall
     ```
     기대 출력: `MI_COUPANG_UNINSTALL_OK`
  3. 관리자 화면에서 그 연결 코드를 `폐기`(제거 뒤 코드도 반드시 폐기)
- 제거는 이 수집기의 예약 작업·폴더·우리 Edge만 지웁니다. N30 크롬·폴더는 건드리지 않습니다.

---

## 부록 — 맥(맥 미니) 설치

약 2달 뒤 수집을 맥 미니로 옮길 때 씁니다. 지금 맥북에서는 운영하지 않습니다.

- **필수 조건**: 맥 미니에 **Microsoft Edge for Mac(무료)**과 Node.js 22 LTS. Edge가 없으면 이전을 진행하지 않습니다.
- **설치 — 맥 터미널용(관리자 아님)**: 화면의 `맥 설치·업데이트` 복사 줄
  ```bash
  curl -fsSL https://insight.momentlabs.co.kr/coupang-collector/install-macos.sh -o /tmp/mi-coupang-install.sh && /bin/zsh /tmp/mi-coupang-install.sh --release <7자리>
  ```
  - 코드를 **두 번** 묻습니다. 두 번 모두 붙여 넣고 `Enter`(글자는 보이지 않음). 설치 줄을 복사한 직후라 클립보드에 설치 줄이 들어 있으니, 관리자 화면에서 **코드를 다시 복사한 뒤** 붙여 넣습니다.
  - 기대 출력: `MI_COUPANG_INSTALL_OK release=<7자리> version=1.0.0 node=<버전> browser=edge/<버전> guard=none agent=loaded auth=ok first_run=<요약>`
  - **`browser=edge guard=none`이 아니면 이전을 멈춥니다**(Edge 설치부터).
  - 실패하면 `MI_COUPANG_INSTALL_FAIL code=…` 한 줄이 나옵니다. 맥에서 코드를 다시 넣는 옵션은 ` --reset-token`입니다(윈도우의 ` -ResetToken`을 붙이면 `code=unknown_option`).

  | 나온 것 | 뜻 | 할 일 |
  |---|---|---|
  | `code=trial_agent_loaded` | 맥 시험이 아직 켜져 있음 | 2단계의 `launchctl bootout …` 줄을 먼저 실행 |
  | `code=browser_app_required` | Edge가 없음 | Edge 설치 뒤 다시 |
  | `code=node_version_must_be_22_to_24` | Node.js 판이 맞지 않음 | Node.js 22 LTS를 설치한 뒤 다시 |
  | `code=release_mismatch` | 줄이 옛 배포 것 | 화면에서 줄을 **다시 복사**해 실행 |
  | `code=connection_code_invalid` | 붙여 넣은 값이 연결 코드 형식이 아님(설치 줄 전체, 앞뒤 공백 등) | 키체인에 남기지 않고 끝났습니다. 코드**만** 복사해 같은 줄을 다시 실행(다시 묻습니다). ` --reset-token`으로 코드를 바꾸던 중이었다면 옛 코드도 이미 바뀐 상태라 수집이 멈춰 있으니, 바로 다시 실행합니다 |
  | `code=auth_rejected` | 코드가 틀렸거나 폐기됨 | 새 코드를 만든 뒤 설치 줄 끝에 ` --reset-token`을 붙여 다시 실행 |
  | `code=auth_update_required` | 수집기 판이 낮음 | 화면에서 줄을 다시 복사해 실행(업데이트). 그래도 같으면 줄을 보내 주세요 |
  | `code=auth_setup_required` | 대표 SQL 전 | 시작 전 확인 ②부터 |
  | `code=auth_route_missing` | 서버 경로가 없음(다른 배포가 덮음) | 줄을 보내 주세요(작업 담당 확인) |
  | `code=auth_unreachable` | 서버에 닿지 못함(인터넷·방화벽) | 인터넷 연결을 확인하고 같은 줄을 다시 실행 |
  | `code=auth_error` | 서버 답을 알아보지 못함 | 줄 전체를 보내 주세요(작업 담당 확인) |
  | 그 밖의 `code=…` | 표에 없는 실패 | 줄 전체를 보내 주세요 |
- **확인 — 맥 터미널용**: 화면의 `맥 확인` 복사 줄
  ```bash
  launchctl print gui/$(id -u)/co.kr.momentinsight.coupang-rank-collector | grep -E 'state|last exit code'; tail -n 10 "$HOME/Library/Application Support/MomentInsight/CoupangRank/logs/worker.log"
  ```
  - 기대: `last exit code = 0` [추정], 로그 마지막 줄들에 `run_end`.
- **제거 — 맥 터미널용**: 화면의 `맥 제거` 복사 줄(`… --release <7자리> --uninstall`) → 기대 `MI_COUPANG_UNINSTALL_OK` → 화면에서 코드 `폐기`.

**맥 미니로 옮기는 순서**
1. 맥 미니에 Node 22 LTS와 Microsoft Edge for Mac을 설치합니다.
2. 관리자 화면에서 새 연결 코드(이름 `맥 미니`)를 만듭니다. 윈도우 코드는 그대로 둡니다.
3. 맥 미니 터미널에서 맥 설치 줄을 실행하고 `browser=edge guard=none auth=ok`를 확인합니다.
4. 하루 동안 두 대를 같이 돌립니다. 속도 상한은 서버 전체에 걸리므로 요청량은 늘지 않습니다. 총관리자 수집기 칸에서 두 수집기의 마지막 신호와 마지막 claim 사유를 봅니다.
5. 윈도우 코드를 `폐기`하고, 윈도우에서 제거 줄을 실행합니다.
6. 나중에 N30도 맥 미니로 옮겨 크롬을 쓰게 되어도, C는 Edge라서 서로 닿지 않습니다.

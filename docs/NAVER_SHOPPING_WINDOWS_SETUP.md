# N 쇼핑 순위 Windows 작업용 데스크탑 설치

## 설치 전

1. Windows 10 또는 11의 작업용 사용자 계정으로 로그인합니다.
2. Google Chrome과 Node.js 22~24를 설치합니다.
3. Chrome에서 새 프로필을 만들고 표시 이름을 정확히 `프로그램 개발`로 지정합니다.
4. `프로그램 개발` 프로필에서 네이버에 정상 로그인하고 가격비교 검색 화면이 열리는지 확인합니다.
5. VPN·프록시와 불필요한 쇼핑 확장 프로그램은 사용하지 않습니다.

## 설치

1. 이 저장소를 ZIP으로 내려받아 고정 폴더에 압축 해제합니다.
2. `INSTALL-NAVER-SHOPPING-WINDOWS.cmd`를 마우스 오른쪽 버튼으로 눌러 `관리자 권한으로 실행`합니다.
3. 운영 워커 비밀키 입력 창이 나오면 화면이나 메신저에 남기지 말고 보안 전달받은 값을 입력합니다.
4. 설치기는 현재 Windows 사용자만 복호화할 수 있는 DPAPI 파일로 비밀키를 저장합니다. 명령줄·설정 파일·Chrome 확장에는 평문 비밀키를 저장하지 않습니다.
5. 설치가 끝나면 `프로그램 개발` 프로필의 `chrome://extensions`가 열립니다.
6. 오른쪽 위 `개발자 모드`를 켜고 `압축해제된 확장 프로그램을 로드합니다`를 누릅니다.
7. 설치 결과의 `extensionPath` 폴더를 선택합니다. 기본 경로는 `%LOCALAPPDATA%\MomentInsight\NaverShoppingBridge\tools\naver-shopping-chrome-extension`입니다.
8. `Moment Insight N Shopping Rank` 버전 `1.0.15`, ID `pflggephankeefaeoaafkmggampnaefm`을 확인합니다.

## 자동 실행

- Windows 작업 스케줄러의 `\MomentInsight\NaverShoppingChrome` 작업이 로그인 직후와 10분 간격으로 `프로그램 개발` Chrome 프로필을 확인합니다.
- 확장은 20분마다 사이트 전체 활성 대기열을 멱등 등록하고 oldest-first로 키워드 1개만 순차 수집합니다.
- 네트워크 제한·418·429는 30분, 60분, 120분 뒤 재시도하고 이후에도 120분을 상한으로 유지합니다.
- CAPTCHA·보안확인은 자동 우회하지 않습니다. 열린 확인 화면을 사람이 완료하면 확장이 정상 상태를 감지해 1건부터 재개합니다.
- 실패·부분 수집은 현재 순위와 30일 이력을 덮지 않습니다.

## 운영 전환

- Windows 데스크탑의 신규 `pw-chrome-*`, `checked_count=300` 실증 전에는 기존 Mac을 종료하지 않습니다.
- Windows 실증이 끝나면 Windows만 주 작업자로 두고 Mac 확장은 비활성 대기 상태로 전환합니다. 두 장비를 동시에 주 작업자로 돌리지 않습니다.

## 확인 명령

관리자 PowerShell에서 다음을 확인합니다.

```powershell
Get-ScheduledTask -TaskPath "\MomentInsight\" -TaskName "NaverShoppingChrome"
Get-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\co.kr.momentinsight.naver_shopping"
Get-Content "$env:LOCALAPPDATA\MomentInsight\Logs\naver-shopping-chrome-scheduler.log" -Tail 20
```

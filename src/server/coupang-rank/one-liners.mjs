// C 30일 순위 수집기 설치·확인·제거 복사 줄(명세 §9.5.6·§9.6.6, WP2). 총관리자 패널(GET ?view=collector)이 보여 준다.
// release 는 커밋 앞 7자(소문자 16진). 아니면 0000000 으로 바꾼다. 비밀값은 넣지 않는다(연결 코드는 설치기가 따로 묻는다).
import { COLLECTOR_PUBLIC_PATH, PUBLIC_ORIGIN, RELEASE_PATTERN, UNKNOWN_RELEASE } from "./contract.mjs";

export function safeRelease(release) {
  const text = String(release ?? "");
  return RELEASE_PATTERN.test(text) ? text : UNKNOWN_RELEASE;
}

// 반환: { windowsInstall, windowsCheck, windowsUninstall, macInstall, macCheck, macUninstall }
export function collectorOneLiners(release) {
  const tag = safeRelease(release);
  const base = `${PUBLIC_ORIGIN}${COLLECTOR_PUBLIC_PATH}`;
  const windowsInstall = `iwr -UseBasicParsing ${base}/install-windows.ps1 -OutFile "$env:TEMP\\mi-coupang-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\mi-coupang-install.ps1" -Release ${tag}`;
  const windowsCheck = "Get-ScheduledTaskInfo -TaskName CoupangRank -TaskPath '\\MomentInsight\\' | Select-Object LastRunTime,LastTaskResult,NextRunTime; Get-Content \"$env:LOCALAPPDATA\\MomentInsight\\CoupangRank\\logs\\worker.log\" -Tail 10 -Encoding UTF8";
  const macInstall = `curl -fsSL ${base}/install-macos.sh -o /tmp/mi-coupang-install.sh && /bin/zsh /tmp/mi-coupang-install.sh --release ${tag}`;
  const macCheck = "launchctl print gui/$(id -u)/co.kr.momentinsight.coupang-rank-collector | grep -E 'state|last exit code'; tail -n 10 \"$HOME/Library/Application Support/MomentInsight/CoupangRank/logs/worker.log\"";
  return {
    windowsInstall,
    windowsCheck,
    windowsUninstall: `${windowsInstall} -Uninstall`,
    macInstall,
    macCheck,
    macUninstall: `${macInstall} --uninstall`,
  };
}

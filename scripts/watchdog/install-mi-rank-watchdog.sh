#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIR="${0:A:h}"
LABEL="co.kr.momentinsight.rank-watchdog"
TEMPLATE_PATH="${SCRIPT_DIR}/${LABEL}.plist.template"
WATCHDOG_SOURCE_PATH="${SCRIPT_DIR}/mi-rank-watchdog.sh"
LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIRECTORY="${HOME}/Library/Logs/MomentInsight"
SUPPORT_DIRECTORY="${HOME}/Library/Application Support/MomentInsight"
SCHEDULER_CONFIG_PATH="${SUPPORT_DIRECTORY}/naver-shopping-chrome-scheduler.conf"
# launchd 가 저장소 워킹트리를 직접 실행하면 저장소 파일 변경이 곧바로 10분 주기
# 자동 실행이 된다. n30 브리지의 installRuntime() 과 같이 사본을 만들어 등록한다.
RUNTIME_DIRECTORY="${SUPPORT_DIRECTORY}/rank-watchdog"
WATCHDOG_SCRIPT_PATH="${RUNTIME_DIRECTORY}/mi-rank-watchdog.sh"

if [[ ! -f "${TEMPLATE_PATH}" || ! -x "${WATCHDOG_SOURCE_PATH}" ]]; then
  print -u2 -- "rank_watchdog_install_source_missing"
  exit 1
fi

if [[ ! -f "${SCHEDULER_CONFIG_PATH}" ]]; then
  print -u2 -- "rank_watchdog_scheduler_config_missing"
  exit 1
fi

/bin/mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIRECTORY}" "${RUNTIME_DIRECTORY}"
/bin/chmod 700 "${LOG_DIRECTORY}" "${SUPPORT_DIRECTORY}" "${RUNTIME_DIRECTORY}"
# install(1) 은 임시 파일에 쓴 뒤 rename 하므로 재설치(덮어쓰기)가 원자적이다.
/usr/bin/install -m 700 "${WATCHDOG_SOURCE_PATH}" "${WATCHDOG_SCRIPT_PATH}"

PLIST_CONTENT="$(<"${TEMPLATE_PATH}")"
PLIST_CONTENT="${PLIST_CONTENT//__WATCHDOG_SCRIPT_PATH__/${WATCHDOG_SCRIPT_PATH}}"
PLIST_CONTENT="${PLIST_CONTENT//__WATCHDOG_RUNTIME_DIRECTORY__/${RUNTIME_DIRECTORY}}"
PLIST_CONTENT="${PLIST_CONTENT//__LOG_DIRECTORY__/${LOG_DIRECTORY}}"
TEMP_PATH="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/${LABEL}.XXXXXX")"
trap '/bin/rm -f "${TEMP_PATH}"' EXIT INT TERM
/usr/bin/printf '%s\n' "${PLIST_CONTENT}" > "${TEMP_PATH}"
/usr/bin/plutil -lint "${TEMP_PATH}" >/dev/null
/usr/bin/install -m 600 "${TEMP_PATH}" "${LAUNCH_AGENT_PATH}"

DOMAIN="gui/$(/usr/bin/id -u)"
/bin/launchctl bootout "${DOMAIN}" "${LAUNCH_AGENT_PATH}" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "${DOMAIN}" "${LAUNCH_AGENT_PATH}"
/bin/launchctl enable "${DOMAIN}/${LABEL}"
/bin/launchctl kickstart -k "${DOMAIN}/${LABEL}"

print -- "rank_watchdog_launch_agent_installed"

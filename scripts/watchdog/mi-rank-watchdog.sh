#!/bin/zsh
# 순위 수집 정체 워치독.
# 공개 집계 엔드포인트(/api/rank-collection-health)만 폴링해 대기열 정체를 판정하고,
# 정체가 60분 이상 연속으로 관측될 때만 Chrome 을 정상 종료 후 다시 연다.
# 강제 종료 폴백은 두지 않는다. 모든 분기는 반드시 한 줄을 로그로 남긴다.
set -euo pipefail
umask 077

USER_HOME="${HOME:-/Users/$(/usr/bin/id -un)}"
SUPPORT_DIRECTORY="${USER_HOME}/Library/Application Support/MomentInsight"
SCHEDULER_CONFIG_PATH="${SUPPORT_DIRECTORY}/naver-shopping-chrome-scheduler.conf"
WATCHDOG_CONFIG_PATH="${SUPPORT_DIRECTORY}/mi-rank-watchdog.conf"
STATE_PATH="${SUPPORT_DIRECTORY}/mi-rank-watchdog.state"
LOG_DIRECTORY="${USER_HOME}/Library/Logs/MomentInsight"
LOG_PATH="${LOG_DIRECTORY}/mi-rank-watchdog.log"

PRODUCTION_HEALTH_URL="https://insight.momentlabs.co.kr/api/rank-collection-health"
STALL_REQUIRED_SECONDS=3600
RESTART_COOLDOWN_SECONDS=10800
CURL_MAX_SECONDS=15
QUIT_SETTLE_SECONDS=8
LOG_MAX_BYTES=1048576
DRY_RUN="${MI_RANK_WATCHDOG_DRY_RUN:-0}"

/bin/mkdir -p "${LOG_DIRECTORY}"
/bin/chmod 700 "${LOG_DIRECTORY}"
if [[ -f "${LOG_PATH}" ]]; then
  LOG_BYTES="$(/usr/bin/stat -f '%z' "${LOG_PATH}" 2>/dev/null || print 0)"
  if [[ "${LOG_BYTES}" =~ '^[0-9]+$' ]] && (( LOG_BYTES > LOG_MAX_BYTES )); then
    /bin/mv -f "${LOG_PATH}" "${LOG_PATH}.1"
    /bin/chmod 600 "${LOG_PATH}.1"
  fi
fi
/usr/bin/touch "${LOG_PATH}"
/bin/chmod 600 "${LOG_PATH}"

log_event() {
  /bin/date -u '+%Y-%m-%dT%H:%M:%SZ' | /usr/bin/tr -d '\n' >> "${LOG_PATH}"
  print -r -- " $1" >> "${LOG_PATH}"
}

# ── 상태 읽기 ────────────────────────────────────────────────
# 찢어진 상태 파일이 "영원히 정체"로 읽히면 안 된다. 파싱 불가 줄은 무시하고 0 을 쓴다.
STALLED_SINCE=0
LAST_RESTART_AT=0
if [[ -f "${STATE_PATH}" ]]; then
  STATE_LINES=("${(@f)$(/bin/cat "${STATE_PATH}")}")
  for STATE_LINE in "${STATE_LINES[@]}"; do
    if [[ "${STATE_LINE}" =~ '^stalled_since=[0-9]+$' ]]; then
      STALLED_SINCE="${STATE_LINE#stalled_since=}"
    elif [[ "${STATE_LINE}" =~ '^last_restart_at=[0-9]+$' ]]; then
      LAST_RESTART_AT="${STATE_LINE#last_restart_at=}"
    fi
  done
fi

write_state() {   # $1=stalled_since $2=last_restart_at
  if [[ "${DRY_RUN}" == "1" ]]; then
    log_event "dry_run state_write_skipped stalled_since=$1 last_restart_at=$2"
    return 0
  fi
  local temp
  /bin/mkdir -p "${SUPPORT_DIRECTORY}"
  temp="$(/usr/bin/mktemp "${SUPPORT_DIRECTORY}/mi-rank-watchdog.state.XXXXXX")"
  /usr/bin/printf 'stalled_since=%s\nlast_restart_at=%s\n' "$1" "$2" > "${temp}"
  /bin/chmod 600 "${temp}"
  /bin/mv -f "${temp}" "${STATE_PATH}"
}

# ── 헬스 URL 허용목록 ────────────────────────────────────────
HEALTH_URL="${MI_RANK_WATCHDOG_HEALTH_URL:-}"
if [[ -z "${HEALTH_URL}" && -f "${WATCHDOG_CONFIG_PATH}" ]]; then
  HEALTH_URL="$(/usr/bin/head -n 1 "${WATCHDOG_CONFIG_PATH}")"
fi
if [[ -z "${HEALTH_URL}" ]]; then
  HEALTH_URL="${PRODUCTION_HEALTH_URL}"
fi
if [[ "${HEALTH_URL}" != "${PRODUCTION_HEALTH_URL}" ]] \
  && [[ ! "${HEALTH_URL}" =~ '^http://(127\.0\.0\.1|localhost):[0-9]{1,5}/api/rank-collection-health$' ]]; then
  log_event "health_url_invalid"
  exit 1
fi

# ── 프로브 ───────────────────────────────────────────────────
set +e
BODY="$(/usr/bin/curl --fail --silent --show-error --location \
  --max-time "${CURL_MAX_SECONDS}" --retry 0 --tlsv1.2 \
  -H 'Accept: application/json' "${HEALTH_URL}" 2>/dev/null)"
CURL_STATUS=$?
set -e
if (( CURL_STATUS != 0 )); then
  # 네트워크 장애는 정체가 아니다. 상태를 건드리지 않고 물러난다.
  log_event "health_unreachable curl_status=${CURL_STATUS} action=none"
  exit 0
fi
if ! print -r -- "${BODY}" | /usr/bin/grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
  log_event "health_body_unusable action=none"
  exit 0
fi
if print -r -- "${BODY}" | /usr/bin/grep -Eq '"queueStalled"[[:space:]]*:[[:space:]]*true'; then
  QUEUE_STALLED=1
elif print -r -- "${BODY}" | /usr/bin/grep -Eq '"queueStalled"[[:space:]]*:[[:space:]]*false'; then
  QUEUE_STALLED=0
else
  log_event "health_body_unusable action=none"
  exit 0
fi
# BSD sed(1) 은 라벨 없는 t 를 세미콜론으로 끝낼 수 없다. -n 과 p 플래그로 추출한다.
STALLED_MINUTES="$(print -r -- "${BODY}" | /usr/bin/sed -n -E 's/.*"stalledMinutes"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p')"
if [[ -z "${STALLED_MINUTES}" ]]; then
  STALLED_MINUTES="unknown"
fi
NOW="$(/bin/date -u '+%s')"

# ── 판정 ─────────────────────────────────────────────────────
if (( QUEUE_STALLED == 0 )); then
  if (( STALLED_SINCE > 0 )); then
    log_event "stall_cleared stalled_minutes=${STALLED_MINUTES}"
    write_state 0 "${LAST_RESTART_AT}"
  else
    log_event "healthy stalled_minutes=${STALLED_MINUTES}"
  fi
  exit 0
fi

if (( STALLED_SINCE <= 0 )); then
  # 첫 정체 관측만으로는 절대 재기동하지 않는다(맥 절전 복귀 오탐 차단).
  log_event "stall_started stalled_minutes=${STALLED_MINUTES}"
  write_state "${NOW}" "${LAST_RESTART_AT}"
  exit 0
fi

STALLED_SECONDS=$(( NOW - STALLED_SINCE ))
if (( STALLED_SECONDS < 0 )); then
  log_event "stall_clock_reset previous=${STALLED_SINCE}"
  write_state "${NOW}" "${LAST_RESTART_AT}"
  exit 0
fi
if (( STALLED_SECONDS < STALL_REQUIRED_SECONDS )); then
  log_event "stall_pending seconds=${STALLED_SECONDS} required=${STALL_REQUIRED_SECONDS}"
  exit 0
fi

COOLDOWN_ELAPSED=$(( NOW - LAST_RESTART_AT ))
if (( LAST_RESTART_AT > 0 && COOLDOWN_ELAPSED < 0 )); then
  # 시계가 뒤로 점프해 last_restart_at 이 미래다. 남은 쿨다운을 계산할 수 없으므로
  # fail-closed 로 재기동을 보류하고 쿨다운 기준점만 현재 시각으로 재고정한다.
  log_event "restart_cooldown_clock_reset previous=${LAST_RESTART_AT}"
  write_state "${STALLED_SINCE}" "${NOW}"
  exit 0
fi
if (( LAST_RESTART_AT > 0 && COOLDOWN_ELAPSED < RESTART_COOLDOWN_SECONDS )); then
  log_event "restart_suppressed_cooldown seconds_left=$(( RESTART_COOLDOWN_SECONDS - COOLDOWN_ELAPSED ))"
  exit 0
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  log_event "dry_run restart_would_run stalled_seconds=${STALLED_SECONDS}"
  exit 0
fi

# ── 재기동 ───────────────────────────────────────────────────
if [[ ! -f "${SCHEDULER_CONFIG_PATH}" ]]; then
  log_event "chrome_config_invalid reason=config_missing"
  exit 1
fi
CONFIG_LINES=("${(@f)$(/bin/cat "${SCHEDULER_CONFIG_PATH}")}")
CHROME_APPLICATION_PATH="${CONFIG_LINES[1]:-}"
PROFILE_DIRECTORY="${CONFIG_LINES[2]:-}"
CHROME_EXECUTABLE="${CHROME_APPLICATION_PATH}/Contents/MacOS/Google Chrome"
if [[ -z "${CHROME_APPLICATION_PATH}" || ! -d "${CHROME_APPLICATION_PATH}" || ! -x "${CHROME_EXECUTABLE}" ]]; then
  log_event "chrome_config_invalid reason=chrome_application_missing"
  exit 1
fi
if [[ ! "${PROFILE_DIRECTORY}" =~ '^(Default|Profile [1-9][0-9]{0,2})$' ]]; then
  log_event "chrome_config_invalid reason=chrome_profile_directory_invalid"
  exit 1
fi

log_event "restart_begin stalled_seconds=${STALLED_SECONDS}"

set +e
QUIT_OUTPUT="$(/usr/bin/osascript -e 'quit app "Google Chrome"' 2>&1)"
QUIT_STATUS=$?
set -e
if (( QUIT_STATUS != 0 )); then
  # 쿨다운은 성공·실패를 가리지 않고 시도 시점에 걸린다(10분마다 재시도하는 루프 차단).
  if print -r -- "${QUIT_OUTPUT}" | /usr/bin/grep -Eq '\-1743|[Nn]ot authoriz|[Nn]ot allowed to send'; then
    log_event "chrome_quit_unauthorized status=${QUIT_STATUS}"
  else
    log_event "chrome_quit_failed status=${QUIT_STATUS}"
  fi
  write_state "${STALLED_SINCE}" "${NOW}"
  exit 1
fi

/bin/sleep "${QUIT_SETTLE_SECONDS}"

set +e
/usr/bin/open -gj "${CHROME_APPLICATION_PATH}" --args \
  "--profile-directory=${PROFILE_DIRECTORY}" \
  --no-first-run \
  --no-default-browser-check
OPEN_STATUS=$?
set -e
if (( OPEN_STATUS != 0 )); then
  log_event "chrome_start_failed status=${OPEN_STATUS}"
  write_state "${STALLED_SINCE}" "${NOW}"
  exit "${OPEN_STATUS}"
fi

log_event "chrome_restarted profile=${PROFILE_DIRECTORY}"
write_state 0 "${NOW}"
exit 0

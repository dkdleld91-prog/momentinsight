#!/bin/zsh
set -euo pipefail
umask 077

KEYCHAIN_ACCOUNT="${USER:-$(/usr/bin/id -un)}"
USER_HOME="${HOME:-/Users/${KEYCHAIN_ACCOUNT}}"
CONFIG_DIRECTORY="${USER_HOME}/Library/Application Support/MomentInsight"
CONFIG_PATH="${CONFIG_DIRECTORY}/naver-shopping-chrome-scheduler.conf"
LOG_DIRECTORY="${USER_HOME}/Library/Logs/MomentInsight"
LOG_PATH="${LOG_DIRECTORY}/naver-shopping-chrome-scheduler.log"

/bin/mkdir -p "${LOG_DIRECTORY}"
/bin/chmod 700 "${LOG_DIRECTORY}"
/usr/bin/touch "${LOG_PATH}"
/bin/chmod 600 "${LOG_PATH}"

log_event() {
  /bin/date -u '+%Y-%m-%dT%H:%M:%SZ' | /usr/bin/tr -d '\n' >> "${LOG_PATH}"
  print -r -- " $1" >> "${LOG_PATH}"
}

if [[ ! -f "${CONFIG_PATH}" ]]; then
  log_event "config_missing"
  exit 1
fi

CHROME_APPLICATION_PATH=""
PROFILE_DIRECTORY=""
{
  IFS= read -r CHROME_APPLICATION_PATH
  IFS= read -r PROFILE_DIRECTORY
} < "${CONFIG_PATH}"
CHROME_EXECUTABLE="${CHROME_APPLICATION_PATH}/Contents/MacOS/Google Chrome"

if [[ ! -d "${CHROME_APPLICATION_PATH}" || ! -x "${CHROME_EXECUTABLE}" ]]; then
  log_event "chrome_application_missing"
  exit 1
fi
if [[ ! "${PROFILE_DIRECTORY}" =~ '^(Default|Profile [1-9][0-9]{0,2})$' ]]; then
  log_event "chrome_profile_directory_invalid"
  exit 1
fi

set +e
if /usr/bin/pgrep -x 'Google Chrome' >/dev/null 2>&1; then
  # Chrome is already running — typically the owner browsing in another profile.
  # `open --args` never reaches a running instance: macOS only re-activates it and
  # drops the profile argument, so the standby profile stays unloaded while this
  # script keeps logging chrome_ready (실측 2026-09-10 09:46 ~ 2026-09-11 12:04,
  # 26시간 동안 대기기 확장이 한 번도 돌지 않음). Chrome's own executable forwards
  # the command line to the running instance (process singleton), which loads the
  # profile without a window or focus change and exits right after the handoff.
  "${CHROME_EXECUTABLE}" \
    "--profile-directory=${PROFILE_DIRECTORY}" \
    --no-startup-window \
    --no-first-run \
    --no-default-browser-check >/dev/null 2>&1
  FORWARD_STATUS=$?
  if (( FORWARD_STATUS != 0 )); then
    log_event "chrome_profile_forward_failed status=${FORWARD_STATUS}"
    exit "${FORWARD_STATUS}"
  fi
  # Confirm the profile really opened: the main Chrome process (oldest match)
  # holds files under the profile directory once it is loaded.
  CHROME_MAIN_PID="$(/usr/bin/pgrep -x -o 'Google Chrome')"
  PROFILE_LOADED=0
  for _ in 1 2 3 4 5; do
    if /usr/sbin/lsof -p "${CHROME_MAIN_PID}" 2>/dev/null \
      | /usr/bin/grep -Fq "/Google/Chrome/${PROFILE_DIRECTORY}/"; then
      PROFILE_LOADED=1
      break
    fi
    /bin/sleep 2
  done
  log_event "chrome_profile_forwarded profile=${PROFILE_DIRECTORY} loaded=${PROFILE_LOADED}"
  exit 0
fi
/usr/bin/open -gj "${CHROME_APPLICATION_PATH}" --args \
  "--profile-directory=${PROFILE_DIRECTORY}" \
  --no-first-run \
  --no-default-browser-check
OPEN_STATUS=$?
set -e
if (( OPEN_STATUS != 0 )); then
  log_event "chrome_start_failed status=${OPEN_STATUS}"
  exit "${OPEN_STATUS}"
fi

log_event "chrome_ready profile=${PROFILE_DIRECTORY}"

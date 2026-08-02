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

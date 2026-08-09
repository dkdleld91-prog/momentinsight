#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIR="${0:A:h}"
REPOSITORY_PATH="${SCRIPT_DIR:h}"
KEYCHAIN_SERVICE="co.kr.momentinsight.naver-shopping-local-worker"
KEYCHAIN_ACCOUNT="${USER:-$(/usr/bin/id -un)}"
USER_HOME="${HOME:-/Users/${KEYCHAIN_ACCOUNT}}"
CONFIG_DIRECTORY="${USER_HOME}/Library/Application Support/MomentInsight"
CONFIG_PATH="${CONFIG_DIRECTORY}/naver-shopping-native-host.conf"
LOG_DIRECTORY="${USER_HOME}/Library/Logs/MomentInsight"
LOG_PATH="${LOG_DIRECTORY}/naver-shopping-native-host.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

/bin/mkdir -p "${LOG_DIRECTORY}"
/bin/chmod 700 "${LOG_DIRECTORY}"
/usr/bin/touch "${LOG_PATH}"
/bin/chmod 600 "${LOG_PATH}"

log_event() {
  /bin/date -u '+%Y-%m-%dT%H:%M:%SZ' | /usr/bin/tr -d '\n' >> "${LOG_PATH}"
  print -r -- " $1" >> "${LOG_PATH}"
}

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  log_event "node_missing"
  print -u2 -- "native_host_node_missing"
  exit 1
fi

WORKER_SECRET="$(/usr/bin/security find-generic-password \
  -s "${KEYCHAIN_SERVICE}" \
  -a "${KEYCHAIN_ACCOUNT}" \
  -w 2>/dev/null || true)"
if [[ "${#WORKER_SECRET}" -lt 32 ]]; then
  log_event "keychain_secret_missing_or_weak"
  print -u2 -- "native_host_keychain_secret_missing_or_weak"
  exit 1
fi

export MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED="true"
export MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET="${WORKER_SECRET}"
# A strict 300-rank job opens eight price-comparison result pages. Process only
# one keyword per continuous cycle so the whole-site queue drains without a
# parallel request burst.
export MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS="1"
export MI_NAVER_SHOPPING_WORKER_ID="macbook-standby"
export MI_NAVER_SHOPPING_WORKER_ROLE="standby"
unset WORKER_SECRET

ENDPOINT_KIND="production"
if [[ -f "${CONFIG_PATH}" ]]; then
  CONFIG_LINES=("${(@f)$(<"${CONFIG_PATH}")}")
  CONFIGURED_API_URL="${CONFIG_LINES[1]:-}"
  CONFIGURED_MAX_JOBS="${CONFIG_LINES[2]:-1}"
  if [[ "${CONFIGURED_API_URL}" == "https://insight.momentlabs.co.kr/api/naver-shopping-local-worker" ]]; then
    export MI_NAVER_SHOPPING_LOCAL_WORKER_API_URL="${CONFIGURED_API_URL}"
    export MI_NAVER_SHOPPING_LOCAL_WORKER_ALLOWED_ORIGINS="https://insight.momentlabs.co.kr"
  elif [[ "${CONFIGURED_API_URL}" =~ '^http://(127\.0\.0\.1|localhost):[0-9]{1,5}/api/naver-shopping-local-worker$' ]]; then
    export MI_NAVER_SHOPPING_LOCAL_WORKER_API_URL="${CONFIGURED_API_URL}"
    export MI_NAVER_SHOPPING_LOCAL_WORKER_ALLOWED_ORIGINS="${CONFIGURED_API_URL%/api/naver-shopping-local-worker}"
    ENDPOINT_KIND="local_canary"
  else
    log_event "config_api_url_invalid"
    exit 1
  fi
  if [[ ! "${CONFIGURED_MAX_JOBS}" =~ '^[1-9][0-9]{0,2}$' ]] || (( CONFIGURED_MAX_JOBS > 500 )); then
    log_event "config_max_jobs_invalid"
    exit 1
  fi
  export MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS="${CONFIGURED_MAX_JOBS}"
fi

log_event "start endpoint=${ENDPOINT_KIND} max_jobs=${MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS}"
cd "${REPOSITORY_PATH}"
set +e
"${NODE_BIN}" scripts/naver-shopping-native-host.mjs 2>> "${LOG_PATH}"
HOST_STATUS=$?
set -e
log_event "exit status=${HOST_STATUS}"
exit "${HOST_STATUS}"

#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIR="${0:A:h}"
REPOSITORY_PATH="${SCRIPT_DIR:h}"
KEYCHAIN_SERVICE="co.kr.momentinsight.naver-shopping-local-worker"
KEYCHAIN_ACCOUNT="${USER:-$(/usr/bin/id -un)}"
PROFILE_DIRECTORY="${HOME}/Library/Application Support/MomentInsight/NaverShoppingProfile"
PROFILE_MARKER="${PROFILE_DIRECTORY}/.moment-insight-profile-v1"
AUTH_MARKER="${PROFILE_DIRECTORY}/.moment-insight-authenticated-v1"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Never borrow a personal browser profile or claim a tracker before the owner
# has completed the one-time official Naver login in the dedicated profile.
if [[ -L "${PROFILE_DIRECTORY}" || ! -f "${PROFILE_MARKER}" || ! -f "${AUTH_MARKER}" ]]; then
  print -u2 -- "local_worker_profile_not_initialized"
  exit 1
fi
export NAVER_SHOPPING_PROVIDER_USER_DATA_DIR="${PROFILE_DIRECTORY}"

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  print -u2 -- "local_worker_node_missing"
  exit 1
fi

NPM_BIN="$(command -v npm || true)"
COLLECTOR_DIR="${REPOSITORY_PATH}/tools/naver-shopping-rank-collector"
PLAYWRIGHT_BIN="${COLLECTOR_DIR}/node_modules/.bin/playwright"

# A clean checkout must be able to recover its collector runtime without a
# manual developer session. Install only the locked collector dependencies and
# the pinned Chromium bundle when either is absent.
if [[ ! -x "${PLAYWRIGHT_BIN}" ]]; then
  if [[ -z "${NPM_BIN}" ]]; then
    print -u2 -- "local_worker_npm_missing"
    exit 1
  fi
  "${NPM_BIN}" --prefix "${COLLECTOR_DIR}" ci --ignore-scripts
fi
if ! "${NODE_BIN}" --input-type=module -e \
  "import('node:fs').then(fs=>import('node:url').then(({pathToFileURL})=>import(pathToFileURL('${COLLECTOR_DIR}/node_modules/playwright/index.mjs').href).then(({chromium})=>process.exit(fs.existsSync(chromium.executablePath())?0:1)))).catch(()=>process.exit(1))"; then
  "${PLAYWRIGHT_BIN}" install chromium
fi

WORKER_SECRET="$(/usr/bin/security find-generic-password \
  -s "${KEYCHAIN_SERVICE}" \
  -a "${KEYCHAIN_ACCOUNT}" \
  -w 2>/dev/null || true)"
if [[ "${#WORKER_SECRET}" -lt 32 ]]; then
  print -u2 -- "local_worker_keychain_secret_missing_or_weak"
  exit 1
fi

export MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED="true"
export MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET="${WORKER_SECRET}"
export MI_NAVER_SHOPPING_WORKER_ID="macbook-standby"
export MI_NAVER_SHOPPING_WORKER_ROLE="standby"
unset WORKER_SECRET

cd "${REPOSITORY_PATH}"

# A transient network/provider failure must not postpone catch-up until the next
# 09:00/15:00 schedule. Retry at most twice with bounded backoff; the Node worker
# and DB lease contract keep every retry idempotent and fail closed.
MAX_ATTEMPTS=3
ATTEMPT=1
while (( ATTEMPT <= MAX_ATTEMPTS )); do
  if /usr/bin/caffeinate -i -s "${NODE_BIN}" scripts/naver-shopping-local-worker.mjs; then
    exit 0
  else
    STATUS=$?
  fi
  if (( ATTEMPT == MAX_ATTEMPTS )); then
    exit "${STATUS}"
  fi
  BACKOFF_SECONDS=$(( ATTEMPT * 300 ))
  print -u2 -- "local_worker_retry_scheduled:${BACKOFF_SECONDS}s"
  /bin/sleep "${BACKOFF_SECONDS}"
  ATTEMPT=$(( ATTEMPT + 1 ))
done

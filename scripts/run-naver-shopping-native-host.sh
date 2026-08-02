#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIR="${0:A:h}"
REPOSITORY_PATH="${SCRIPT_DIR:h}"
KEYCHAIN_SERVICE="co.kr.momentinsight.naver-shopping-local-worker"
KEYCHAIN_ACCOUNT="${USER:-$(/usr/bin/id -un)}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  print -u2 -- "native_host_node_missing"
  exit 1
fi

WORKER_SECRET="$(/usr/bin/security find-generic-password \
  -s "${KEYCHAIN_SERVICE}" \
  -a "${KEYCHAIN_ACCOUNT}" \
  -w 2>/dev/null || true)"
if [[ "${#WORKER_SECRET}" -lt 32 ]]; then
  print -u2 -- "native_host_keychain_secret_missing_or_weak"
  exit 1
fi

export MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED="true"
export MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET="${WORKER_SECRET}"
unset WORKER_SECRET
cd "${REPOSITORY_PATH}"
exec "${NODE_BIN}" scripts/naver-shopping-native-host.mjs

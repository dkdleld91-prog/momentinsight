#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIR="${0:A:h}"
REPOSITORY_PATH="${SCRIPT_DIR:h}"
LABEL="co.kr.momentinsight.naver-shopping-local-worker"
TEMPLATE_PATH="${SCRIPT_DIR}/${LABEL}.plist.template"
LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIRECTORY="${HOME}/Library/Logs/MomentInsight"
KEYCHAIN_ACCOUNT="${USER:-$(/usr/bin/id -un)}"
PROFILE_DIRECTORY="${HOME}/Library/Application Support/MomentInsight/NaverShoppingProfile"
PROFILE_MARKER="${PROFILE_DIRECTORY}/.moment-insight-profile-v1"
AUTH_MARKER="${PROFILE_DIRECTORY}/.moment-insight-authenticated-v1"

if [[ ! -f "${TEMPLATE_PATH}" || ! -x "${SCRIPT_DIR}/run-naver-shopping-local-worker.sh" ]]; then
  print -u2 -- "local_worker_install_source_missing"
  exit 1
fi

WORKER_SECRET="$(/usr/bin/security find-generic-password \
  -s "${LABEL}" \
  -a "${KEYCHAIN_ACCOUNT}" \
  -w 2>/dev/null || true)"
if [[ "${#WORKER_SECRET}" -lt 32 ]]; then
  print -u2 -- "local_worker_keychain_secret_missing_or_weak"
  exit 1
fi
unset WORKER_SECRET

if [[ -L "${PROFILE_DIRECTORY}" || ! -f "${PROFILE_MARKER}" || ! -f "${AUTH_MARKER}" ]]; then
  print -u2 -- "local_worker_profile_not_initialized"
  exit 1
fi

/bin/mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIRECTORY}"
/bin/chmod 700 "${LOG_DIRECTORY}"

PLIST_CONTENT="$(<"${TEMPLATE_PATH}")"
PLIST_CONTENT="${PLIST_CONTENT//__REPOSITORY_PATH__/${REPOSITORY_PATH}}"
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

print -- "local_worker_launch_agent_installed"

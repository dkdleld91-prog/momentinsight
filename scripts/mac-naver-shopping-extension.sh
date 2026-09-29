#!/bin/bash
# 맥 수집 프로필 확장의 등록 서비스 워커 확인과 확장 페이지 새 창 — 1.1.34 배포 절차 0)·3)·5) (docs/RUNBOOK.md "D 배포·훈련 도구").
#   bash scripts/mac-naver-shopping-extension.sh check  읽기 전용: SW_VERSION=<등록> DISK_VERSION=<디스크 manifest> PROFILE=<프로필> VERDICT=OK|STALE|UNKNOWN
#   bash scripts/mac-naver-shopping-extension.sh open   STALE 일 때만 수집 프로필 새 창 하나를 열어 그 창(id)만 chrome://extensions 로 옮긴다(대표가 ↻).
#                                                       OK 면 ALREADY_CURRENT(0), UNKNOWN 이면 SW_UNKNOWN(7) — 둘 다 창을 열지 않는다.
# 크롬 재시작은 확장 서비스 워커를 다시 등록하지 않을 수 있다(2026-09-29 실측: Profile 5 가 09-19 에 등록된 1.1.32 SW 를
# 디스크 1.1.33 인 채로 실행) → 판정은 Secure Preferences 의 service_worker_registration_info.version 으로만 한다.
# 대표의 다른 창·탭 주소는 바꾸지 않는다: front window 를 쓰지 않는다. 실행 전후 창 id 를 비교해 새로 생긴 창이 정확히 하나이고
# 그 창의 탭이 이 스크립트가 연 about:blank 이며 최소화되지 않았을 때만 그 id 의 창을 옮긴다. 아니면 옮기지 않고 멈춘다.
# Chrome 이 꺼져 있으면 켜지 않는다. 네이티브 호스트가 도는 중(수집 중일 수 있음)이면 열지 않는다.
set -u

EXTENSION_ID="pflggephankeefaeoaafkmggampnaefm"
EXTENSION_URL="chrome://extensions/?id=${EXTENSION_ID}"
SUPPORT_DIRECTORY="${HOME}/Library/Application Support"
CONFIG_PATH="${SUPPORT_DIRECTORY}/MomentInsight/naver-shopping-chrome-scheduler.conf"
OSASCRIPT="${MI_OSASCRIPT:-/usr/bin/osascript}"
PGREP="${MI_PGREP:-/usr/bin/pgrep}"
NODE="${MI_NODE:-node}"
WINDOW_POLLS="${MI_WINDOW_POLLS:-12}"
POLL_SECONDS="${MI_WINDOW_POLL_SECONDS:-0.5}"
PROFILE_PATTERN='^(Default|Profile [1-9][0-9]{0,2})$'

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "CONFIG_MISSING ${CONFIG_PATH}"
  exit 2
fi
CHROME_APPLICATION_PATH=""
PROFILE_DIRECTORY=""
{
  IFS= read -r CHROME_APPLICATION_PATH
  IFS= read -r PROFILE_DIRECTORY
} < "${CONFIG_PATH}"
if [[ ! "${PROFILE_DIRECTORY}" =~ ${PROFILE_PATTERN} ]]; then
  echo "PROFILE_INVALID ${PROFILE_DIRECTORY}"
  exit 2
fi
CHROME_EXECUTABLE="${CHROME_APPLICATION_PATH}/Contents/MacOS/Google Chrome"
PROFILE_LABEL="${PROFILE_DIRECTORY// /_}"

sw_check() {
  "${NODE}" -e '
const fs = require("fs"); const path = require("path");
const [profilePath, id, label] = process.argv.slice(1);
let entry = null;
for (const name of ["Secure Preferences", "Preferences"]) {
  try { entry = JSON.parse(fs.readFileSync(path.join(profilePath, name), "utf8"))?.extensions?.settings?.[id] || null; } catch { entry = null; }
  if (entry) break;
}
const registered = String(entry?.service_worker_registration_info?.version ?? "");
let disk = "";
try { disk = String(JSON.parse(fs.readFileSync(path.join(String(entry?.path ?? ""), "manifest.json"), "utf8")).version ?? ""); } catch {}
const verdict = !entry ? "UNKNOWN reason=extension_not_found" : !registered || !disk ? "UNKNOWN" : registered === disk ? "OK" : "STALE";
console.log(`SW_VERSION=${registered} DISK_VERSION=${disk} PROFILE=${label} VERDICT=${verdict}`);
' "${SUPPORT_DIRECTORY}/Google/Chrome/${PROFILE_DIRECTORY}" "${EXTENSION_ID}" "${PROFILE_LABEL}"
}

# 모든 Chrome 창 id(한 줄에 하나). osascript 가 실패하면 실패로 돌려준다(빈 목록으로 오인하지 않게).
window_ids() {
  local raw
  raw="$("${OSASCRIPT}" -e 'tell application "Google Chrome" to get id of every window' 2>/dev/null)" || return 1
  printf '%s\n' "${raw}" | tr ',' '\n' | tr -d ' ' | grep -E '^[0-9]+$' | sort -n
  return 0
}

# $2(나중 목록)에만 있는 id.
new_window_ids() {
  local id
  while IFS= read -r id; do
    [[ -z "${id}" ]] && continue
    printf '%s\n' "$1" | grep -qx "${id}" || printf '%s\n' "${id}"
  done <<< "$2"
}

open_extensions_window() {
  local verdict
  verdict="$(sw_check)"
  echo "${verdict}"
  # 새로고침이 무해하다고 아는 것은 STALE(옛 SW 를 새 호스트가 거절하는 상태)뿐이다. 판독 실패(UNKNOWN)는 열지 않는다.
  case "${verdict}" in
    *"VERDICT=OK"*) echo "ALREADY_CURRENT 등록 SW 가 디스크와 같다 — 새로고침할 필요 없음"; return 0 ;;
    *"VERDICT=STALE"*) ;;
    *)
      echo "SW_UNKNOWN 등록 SW 버전·확장 경로·디스크 manifest 중 하나를 못 읽었다 — 새로고침해도 되는지 몰라 창을 열지 않았다. 대표에게 수집 프로필(${PROFILE_DIRECTORY}) ${EXTENSION_URL} 카드의 버전·오류 확인 요청"
      return 7
      ;;
  esac
  if "${PGREP}" -f 'naver-shopping-native-host\.mjs' >/dev/null 2>&1; then
    echo "HOST_RUNNING 네이티브 호스트가 도는 중(수집 중일 수 있음) — 창을 열지 않았다. 1분 뒤 다시 실행"
    return 3
  fi
  if ! "${PGREP}" -x 'Google Chrome' >/dev/null 2>&1; then
    echo "CHROME_NOT_RUNNING Chrome 을 켜지 않는다 — 대표가 Chrome 을 켠 뒤 다시 실행"
    return 4
  fi
  if [[ ! -x "${CHROME_EXECUTABLE}" ]]; then
    echo "CHROME_MISSING ${CHROME_EXECUTABLE}"
    return 2
  fi
  local before
  if ! before="$(window_ids)"; then
    echo "WINDOW_LIST_FAILED osascript 로 창 목록을 못 읽었다(자동화 권한) — 대표에게 수집 프로필 창에서 ${EXTENSION_URL} 입력 요청"
    return 5
  fi
  # 실행 중인 Chrome 에 명령줄을 넘긴다(process singleton): 수집 프로필에 about:blank 새 창 하나.
  "${CHROME_EXECUTABLE}" "--profile-directory=${PROFILE_DIRECTORY}" --new-window --no-first-run --no-default-browser-check about:blank >/dev/null 2>&1
  local forward_status=$?
  if (( forward_status != 0 )); then
    echo "CHROME_FORWARD_FAILED status=${forward_status}"
    return 5
  fi
  local after="" fresh="" poll
  for (( poll = 0; poll < WINDOW_POLLS; poll++ )); do
    sleep "${POLL_SECONDS}"
    after="$(window_ids)" || continue
    fresh="$(new_window_ids "${before}" "${after}")"
    [[ -n "${fresh}" ]] && break
  done
  if [[ -n "${fresh}" ]]; then
    # 세션 복원 등으로 창이 더 열리는지 한 번 더 본다.
    sleep "${POLL_SECONDS}"
    after="$(window_ids)" && fresh="$(new_window_ids "${before}" "${after}")"
  fi
  local count
  count="$(printf '%s\n' "${fresh}" | grep -c '^[0-9]')"
  if (( count == 0 )); then
    echo "NO_NEW_WINDOW 새 창이 안 생겼다 — 어떤 창도 옮기지 않았다. 대표에게 수집 프로필(${PROFILE_DIRECTORY}) 창에서 ${EXTENSION_URL} 입력 요청"
    return 6
  fi
  if (( count > 1 )); then
    echo "AMBIGUOUS_NEW_WINDOWS ids=$(printf '%s' "${fresh}" | tr '\n' ',') — 어느 창이 이 스크립트 것인지 몰라 옮기지 않았다"
    return 6
  fi
  local window_id="${fresh}"
  local state
  state="$("${OSASCRIPT}" -e "tell application \"Google Chrome\" to get {URL of active tab of window id ${window_id}, minimized of window id ${window_id}}" 2>/dev/null)"
  if [[ "${state}" != "about:blank, false" ]]; then
    echo "NOT_OUR_WINDOW window_id=${window_id} state=${state} — 이 스크립트가 연 about:blank 창이 아니라 옮기지 않았다"
    return 6
  fi
  if ! "${OSASCRIPT}" -e "tell application \"Google Chrome\" to set URL of active tab of window id ${window_id} to \"${EXTENSION_URL}\"" >/dev/null 2>&1; then
    echo "NAVIGATE_FAILED window_id=${window_id}"
    return 6
  fi
  local url
  url="$("${OSASCRIPT}" -e "tell application \"Google Chrome\" to get URL of active tab of window id ${window_id}" 2>/dev/null)"
  echo "OPENED window_id=${window_id} profile=${PROFILE_LABEL} url=${url} — 대표가 Moment Insight 카드의 새로고침(↻)을 누른 뒤: bash scripts/mac-naver-shopping-extension.sh check"
  return 0
}

case "${1:-}" in
  check) sw_check ;;
  open) open_extensions_window ;;
  *) echo "usage: bash scripts/mac-naver-shopping-extension.sh check|open"; exit 2 ;;
esac

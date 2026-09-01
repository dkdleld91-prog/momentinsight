#!/bin/zsh
# 순위 수집 워치독. 한 틱(10분)에 두 가지 일을 한다.
# (i) 대기열 정체 감시·Chrome 재기동 — 공개 집계 엔드포인트
#     (/api/rank-collection-health)만 폴링해 대기열 정체를 판정하고, 정체가 30분 이상
#     연속으로 관측될 때만 Chrome 을 정상 종료 후 다시 연다. 강제 종료 폴백은 없다.
# (ii) 저장소 대비 설치 사본 드리프트 점검·자가 복구 — Application Support 사본이
#     저장소보다 뒤처졌는지 14개 파일 해시로 대조하고, 게이트를 모두 통과할 때만
#     설치기를 다시 돌려 사본을 스스로 되살린다.
# 판정을 내린 모든 분기는 반드시 한 줄을 로그로 남긴다. 다만 동기화 원본이 설정된
# 적 없는 기계에서는 (ii) 가 아무 줄도 남기지 않고 조용히 건너뛴다.
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
STALL_REQUIRED_SECONDS=1800
RESTART_COOLDOWN_SECONDS=10800
CURL_MAX_SECONDS=15
QUIT_SETTLE_SECONDS=8
LOG_MAX_BYTES=1048576
DRY_RUN="${MI_RANK_WATCHDOG_DRY_RUN:-0}"
SYNC_COOLDOWN_SECONDS=10800
SYNC_INSTALL_TIMEOUT_SECONDS=180
RUNTIME_COPY_PATH="${SUPPORT_DIRECTORY}/NaverShoppingBridge"
SYNC_CONF_PATH="${SUPPORT_DIRECTORY}/mi-rank-runtime-sync.conf"
SYNC_DISABLED="${MI_RANK_WATCHDOG_SYNC_DISABLED:-0}"

# 아래 14개는 scripts/install-naver-shopping-chrome-bridge.mjs 의 RUNTIME_FILES 를
# 그대로 옮긴 것이다. 구성원과 순서가 그 목록과 같아야 한다(테스트가 설치기 소스를
# 파싱해 이 배열과 1:1 로 대조한다). 설치기에 파일이 늘면 여기도 같이 늘려야 한다.
RUNTIME_SYNC_FILES=(
  "scripts/run-naver-shopping-native-host.sh"
  "scripts/run-naver-shopping-chrome-scheduler.sh"
  "scripts/naver-shopping-native-host.mjs"
  "scripts/naver-shopping-native-host-core.mjs"
  "scripts/naver-shopping-local-worker.mjs"
  "src/server/local-worker-auth.mjs"
  "src/server/security.mjs"
  "src/server/handlers/naver-shopping-rank.mjs"
  "src/server/naver-shopping/local-worker-contract.mjs"
  "src/server/naver-shopping/source-status.mjs"
  "src/server/naver-shopping/provider-runtime.mjs"
  "src/server/naver-shopping/mobile-top-fallback.mjs"
  "tools/naver-shopping-rank-collector/src/contract.mjs"
  "tools/naver-shopping-rank-collector/src/provider.mjs"
)

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
# 키가 두 개뿐인 옛 상태 파일도 그대로 읽혀야 한다(last_sync_at 은 0 이 된다).
STALLED_SINCE=0
LAST_RESTART_AT=0
LAST_SYNC_AT=0
if [[ -f "${STATE_PATH}" ]]; then
  STATE_LINES=("${(@f)$(/bin/cat "${STATE_PATH}")}")
  for STATE_LINE in "${STATE_LINES[@]}"; do
    if [[ "${STATE_LINE}" =~ '^stalled_since=[0-9]+$' ]]; then
      STALLED_SINCE="${STATE_LINE#stalled_since=}"
    elif [[ "${STATE_LINE}" =~ '^last_restart_at=[0-9]+$' ]]; then
      LAST_RESTART_AT="${STATE_LINE#last_restart_at=}"
    elif [[ "${STATE_LINE}" =~ '^last_sync_at=[0-9]+$' ]]; then
      LAST_SYNC_AT="${STATE_LINE#last_sync_at=}"
    fi
  done
fi

write_state() {   # $1=stalled_since $2=last_restart_at $3=last_sync_at
  if [[ "${DRY_RUN}" == "1" ]]; then
    log_event "dry_run state_write_skipped stalled_since=$1 last_restart_at=$2 last_sync_at=$3"
    return 0
  fi
  local temp
  /bin/mkdir -p "${SUPPORT_DIRECTORY}"
  temp="$(/usr/bin/mktemp "${SUPPORT_DIRECTORY}/mi-rank-watchdog.state.XXXXXX")"
  /usr/bin/printf 'stalled_since=%s\nlast_restart_at=%s\nlast_sync_at=%s\n' "$1" "$2" "$3" > "${temp}"
  /bin/chmod 600 "${temp}"
  /bin/mv -f "${temp}" "${STATE_PATH}"
}

# ── Chrome 재기동(정체 경로와 동기화 경로가 함께 쓰는 단 하나의 구현) ──────────
# scripts/rank-collection-stability.test.mjs 는 이 함수 안의 두 문자열을 원문 그대로
# 찾는다. (1) 여덟 줄 아래의 /usr/bin/open 호출 첫 줄 — n30 스케줄러 원본과 바이트가
# 같아야 한다. (2) 프로필 디렉터리 검증 정규식 리터럴. 둘 다 형태를 바꾸면 테스트가
# 깨지므로 공백 하나도 손대지 말 것.
chrome_restart_cycle() {   # $1 = 시작 로그 문구
  # setopt localoptions 로 이 함수 안의 옵션 변경이 반환 시 자동으로 되돌려진다.
  # errexit 를 끈 채 단계마다 상태를 직접 확인하므로, 어느 한 단계가 실패해도 셸이
  # 통째로 죽지 않는다. 드리프트 경로가 정체 감시를 중단시키는 일은 없어야 한다.
  setopt localoptions
  set +e

  if [[ ! -f "${SCHEDULER_CONFIG_PATH}" ]]; then
    log_event "chrome_config_invalid reason=config_missing"
    return 1
  fi
  local -a CONFIG_LINES
  CONFIG_LINES=("${(@f)$(/bin/cat "${SCHEDULER_CONFIG_PATH}")}")
  local CHROME_APPLICATION_PATH="${CONFIG_LINES[1]:-}"
  local PROFILE_DIRECTORY="${CONFIG_LINES[2]:-}"
  local CHROME_EXECUTABLE="${CHROME_APPLICATION_PATH}/Contents/MacOS/Google Chrome"
  if [[ -z "${CHROME_APPLICATION_PATH}" || ! -d "${CHROME_APPLICATION_PATH}" || ! -x "${CHROME_EXECUTABLE}" ]]; then
    log_event "chrome_config_invalid reason=chrome_application_missing"
    return 1
  fi
  if [[ ! "${PROFILE_DIRECTORY}" =~ '^(Default|Profile [1-9][0-9]{0,2})$' ]]; then
    log_event "chrome_config_invalid reason=chrome_profile_directory_invalid"
    return 1
  fi

  # 시작 로그는 검증을 모두 통과한 뒤에 남는다(설정이 깨진 기계가 매 틱 "시작"을
  # 찍고 실패하면 로그만 늘고 판독이 어려워진다).
  log_event "$1"

  local QUIT_OUTPUT=""
  local QUIT_STATUS=0
  QUIT_OUTPUT="$(/usr/bin/osascript -e 'quit app "Google Chrome"' 2>&1)"
  QUIT_STATUS=$?
  if (( QUIT_STATUS != 0 )); then
    # 쿨다운은 성공·실패를 가리지 않고 시도 시점에 걸린다(10분마다 재시도하는 루프 차단).
    if print -r -- "${QUIT_OUTPUT}" | /usr/bin/grep -Eq '\-1743|[Nn]ot authoriz|[Nn]ot allowed to send'; then
      log_event "chrome_quit_unauthorized status=${QUIT_STATUS}"
    else
      log_event "chrome_quit_failed status=${QUIT_STATUS}"
    fi
    write_state "${STALLED_SINCE}" "${NOW}" "${LAST_SYNC_AT}"
    return 1
  fi

  /bin/sleep "${QUIT_SETTLE_SECONDS}"

  local OPEN_STATUS=0
  /usr/bin/open -gj "${CHROME_APPLICATION_PATH}" --args \
    "--profile-directory=${PROFILE_DIRECTORY}" \
    --no-first-run \
    --no-default-browser-check
  OPEN_STATUS=$?
  if (( OPEN_STATUS != 0 )); then
    log_event "chrome_start_failed status=${OPEN_STATUS}"
    write_state "${STALLED_SINCE}" "${NOW}" "${LAST_SYNC_AT}"
    return "${OPEN_STATUS}"
  fi

  log_event "chrome_restarted profile=${PROFILE_DIRECTORY}"
  write_state 0 "${NOW}" "${LAST_SYNC_AT}"
  return 0
}

NOW="$(/bin/date -u '+%s')"

# ── 저장소 대비 설치 사본 드리프트 ───────────────────────────
# 수집은 전부 Application Support 사본에서 돌기 때문에, 사본이 저장소보다 뒤처지면
# 수집이 로컬에서 조용히 전부 죽는다. 매 틱 14개 파일을 해시로 대조하고, 게이트를
# 모두 통과했을 때만 설치기를 다시 돌린다.
# 반환값: 0 = 헬스 프로브로 계속 진행, 10 = 이번 틱 종료.
# 이 함수는 절대 exit 하지 않는다. 어떤 실패도 로그 한 줄로 강등되고, 정체 감시는
# 그대로 이어진다.
runtime_drift_pass() {
  setopt localoptions
  set +e

  if [[ "${SYNC_DISABLED}" == "1" ]]; then
    log_event "sync_disabled"
    return 0
  fi

  local SYNC_SOURCE_PATH="${MI_RANK_WATCHDOG_SYNC_SOURCE_PATH:-}"
  if [[ -z "${SYNC_SOURCE_PATH}" && -f "${SYNC_CONF_PATH}" ]]; then
    SYNC_SOURCE_PATH="$(/usr/bin/head -n 1 "${SYNC_CONF_PATH}" 2>/dev/null)" || SYNC_SOURCE_PATH=""
  fi
  if [[ -z "${SYNC_SOURCE_PATH}" ]]; then
    # 동기화 원본을 설치한 적이 없는 기계다. 로그 한 줄도 남기지 않고 물러난다.
    # 켠 적 없는 기능이 10분마다 로그를 더럽히면 정체 판독이 어려워진다.
    return 0
  fi
  if [[ "${SYNC_SOURCE_PATH}" != /* ]] \
    || [[ ! -d "${SYNC_SOURCE_PATH}" ]] \
    || [[ ! -f "${SYNC_SOURCE_PATH}/scripts/install-naver-shopping-chrome-bridge.mjs" ]]; then
    log_event "sync_check_failed reason=sync_source_unresolved"
    return 0
  fi

  # 사본이 아예 없는 것은 드리프트가 아니다. 최초 설치는 소유자의 일이지
  # 워치독의 일이 아니다.
  if [[ ! -d "${RUNTIME_COPY_PATH}" ]]; then
    log_event "sync_check_failed reason=runtime_copy_missing"
    return 0
  fi

  local REL="" SOURCE_FILE="" COPY_FILE="" SOURCE_HASH="" COPY_HASH=""
  local DRIFT_COUNT=0
  for REL in "${RUNTIME_SYNC_FILES[@]}"; do
    SOURCE_FILE="${SYNC_SOURCE_PATH}/${REL}"
    COPY_FILE="${RUNTIME_COPY_PATH}/${REL}"
    SOURCE_HASH="$(/usr/bin/shasum -a 256 "${SOURCE_FILE}" 2>/dev/null)" || SOURCE_HASH=""
    SOURCE_HASH="${SOURCE_HASH%% *}"
    COPY_HASH="$(/usr/bin/shasum -a 256 "${COPY_FILE}" 2>/dev/null)" || COPY_HASH=""
    COPY_HASH="${COPY_HASH%% *}"
    if [[ -z "${SOURCE_HASH}" || -z "${COPY_HASH}" ]]; then
      log_event "sync_check_failed reason=hash_unreadable file=${REL}"
      return 0
    fi
    if [[ "${SOURCE_HASH}" != "${COPY_HASH}" ]]; then
      DRIFT_COUNT=$(( DRIFT_COUNT + 1 ))
    fi
  done

  if (( DRIFT_COUNT == 0 )); then
    log_event "runtime_in_sync files=14"
    return 0
  fi

  # guard 2 — 저장소 신뢰. 클린 트리 게이트가 "저장소 파일을 고치는 순간 10분 주기
  # 자동 실행이 된다"는 사태를 막는 유일한 장치다. 커밋된 상태만 실행된다.
  local GIT_WORKTREE_STATUS=0
  /usr/bin/git -C "${SYNC_SOURCE_PATH}" rev-parse --is-inside-work-tree >/dev/null 2>&1
  GIT_WORKTREE_STATUS=$?
  if (( GIT_WORKTREE_STATUS != 0 )); then
    log_event "sync_check_failed reason=not_a_git_worktree"
    return 0
  fi
  local GIT_PORCELAIN=""
  local GIT_PORCELAIN_STATUS=0
  GIT_PORCELAIN="$(/usr/bin/git -C "${SYNC_SOURCE_PATH}" status --porcelain -- \
    "${RUNTIME_SYNC_FILES[@]}" "tools/naver-shopping-chrome-extension" 2>/dev/null)"
  GIT_PORCELAIN_STATUS=$?
  # 조회 자체가 실패하면 깨끗한지 알 수 없다. fail-closed 로 건너뛴다.
  if (( GIT_PORCELAIN_STATUS != 0 )) || [[ -n "${GIT_PORCELAIN}" ]]; then
    log_event "drift_detected files=${DRIFT_COUNT} sync_skipped=repository_dirty"
    return 0
  fi

  # guard 1 — 수집 진행 중. 신호 두 개 중 하나라도 잡히면 이번 틱은 손대지 않는다.
  # 이것이 낭비 방지가 아니라 손상 방지인 이유:
  # installRuntime(scripts/install-naver-shopping-chrome-bridge.mjs:207-215)은
  # 스테이징 없이 copyFileSync 로 목적지를 제자리에서 덮어쓴다. 그리고 목록 1번이
  # scripts/run-naver-shopping-native-host.sh — 바로 그 순간 Chrome 이 실행하고 있을
  # 수 있는 zsh 스크립트다. zsh 는 스크립트를 오프셋 단위로 나눠 읽으므로, 돌고 있는
  # 인터프리터 밑에서 그 아이노드를 잘라내고 다시 쓰면 쓰레기를 읽을 수 있다.
  #
  # 신호 (1) 네이티브 호스트 프로세스. 확장이 chrome.runtime.connectNative 로 포트를
  # 열고 있는 동안에만 존재한다
  # (tools/naver-shopping-chrome-extension/service-worker.js:816, :530 주석).
  # 프로세스 argv 에는 상대 경로가 들어가므로 반드시 파일명만으로 맞춰야 한다.
  #
  # 신호 (2) 워커 잠금. moment-insight-n-shopping-worker.lock 은 owner.json 을 담은
  # 디렉터리다(scripts/naver-shopping-local-worker.mjs:540-551). :638 에서 claim-lane
  # 이전에 잠그고 :1149 에서 release-lane 이후에 푸므로 잠금 구간이 리스 구간을 완전히
  # 포함한다 — 잠금이 없으면 이 맥은 리스를 쥐고 있지 않다(안전한 방향의 판정이다).
  # LaunchAgent 의 TMPDIR 이 Chrome 자식 프로세스와 다른 /var/folders 경로로 풀릴 수
  # 있어 후보 세 곳을 차례로 본다. 죽은 소유자의 잠금은 최대 8시간
  # (DEFAULT_LOCK_STALE_MS, :24) 남을 수 있으므로, 디렉터리가 있고 owner.json 의 pid
  # 가 살아 있을 때만 유효한 잠금으로 친다.
  local COLLECTION_ACTIVE=0
  if /usr/bin/pgrep -f 'naver-shopping-native-host\.mjs' >/dev/null 2>&1; then
    COLLECTION_ACTIVE=1
  fi
  if (( COLLECTION_ACTIVE == 0 )); then
    local DARWIN_TEMP_DIRECTORY=""
    DARWIN_TEMP_DIRECTORY="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR 2>/dev/null)" || DARWIN_TEMP_DIRECTORY=""
    local -a LOCK_ROOTS=()
    if [[ -n "${TMPDIR:-}" ]]; then
      LOCK_ROOTS+=("${TMPDIR%/}")
    fi
    if [[ -n "${DARWIN_TEMP_DIRECTORY}" ]]; then
      LOCK_ROOTS+=("${DARWIN_TEMP_DIRECTORY%/}")
    fi
    LOCK_ROOTS+=("/tmp")
    local LOCK_ROOT="" LOCK_DIRECTORY="" OWNER_JSON="" OWNER_PID=""
    for LOCK_ROOT in "${LOCK_ROOTS[@]}"; do
      LOCK_DIRECTORY="${LOCK_ROOT}/moment-insight-n-shopping-worker.lock"
      [[ -d "${LOCK_DIRECTORY}" ]] || continue
      OWNER_JSON="$(/bin/cat "${LOCK_DIRECTORY}/owner.json" 2>/dev/null)" || OWNER_JSON=""
      [[ -n "${OWNER_JSON}" ]] || continue
      [[ "${OWNER_JSON}" =~ '"pid"[[:space:]]*:[[:space:]]*([0-9]+)' ]] || continue
      OWNER_PID="${match[1]}"
      if kill -0 "${OWNER_PID}" 2>/dev/null; then
        COLLECTION_ACTIVE=1
        break
      fi
    done
  fi
  if (( COLLECTION_ACTIVE == 1 )); then
    log_event "drift_detected files=${DRIFT_COUNT} sync_skipped=collection_active"
    return 0
  fi

  # guard 4 — 쿨다운.
  local SYNC_ELAPSED=$(( NOW - LAST_SYNC_AT ))
  if (( LAST_SYNC_AT > 0 && SYNC_ELAPSED < 0 )); then
    # 시계가 뒤로 점프해 last_sync_at 이 미래다. 남은 쿨다운을 계산할 수 없으므로
    # fail-closed 로 동기화를 보류하고 쿨다운 기준점만 현재 시각으로 재고정한다.
    log_event "sync_cooldown_clock_reset previous=${LAST_SYNC_AT}"
    write_state "${STALLED_SINCE}" "${LAST_RESTART_AT}" "${NOW}"
    return 0
  fi
  if (( LAST_SYNC_AT > 0 && SYNC_ELAPSED < SYNC_COOLDOWN_SECONDS )); then
    log_event "drift_detected files=${DRIFT_COUNT} sync_suppressed_cooldown seconds_left=$(( SYNC_COOLDOWN_SECONDS - SYNC_ELAPSED ))"
    return 0
  fi

  if [[ "${DRY_RUN}" == "1" ]]; then
    log_event "dry_run drift_sync_would_run files=${DRIFT_COUNT}"
    return 0
  fi

  # guard 3 — 설치기는 스테이징도 롤백도 없다.
  # scripts/install-naver-shopping-chrome-bridge.mjs:207-215 는 14개 파일을
  # statSync+copyFileSync 로 하나씩 돈다. 도중에 throw 나면 사본이 부분 갱신 상태로
  # 남는다. 그래서 워치독이 스스로 백업을 뜨고 실패하면 되돌린다.
  local BACKUP_PATH="${RUNTIME_COPY_PATH}.backup-$$"
  local BACKUP_STATUS=0
  /bin/rm -rf "${BACKUP_PATH}"
  /bin/cp -Rp "${RUNTIME_COPY_PATH}" "${BACKUP_PATH}"
  BACKUP_STATUS=$?
  if (( BACKUP_STATUS != 0 )); then
    log_event "sync_check_failed reason=backup_failed"
    /bin/rm -rf "${BACKUP_PATH}"
    return 0
  fi

  # node 탐색은 scripts/run-naver-shopping-native-host.sh:26-31 과 같은 방식이다.
  # launchd 의 PATH 에는 Homebrew 가 없으므로 잠깐만 넓혀 찾고 곧바로 되돌린다.
  local SAVED_PATH="${PATH}"
  local NODE_BIN=""
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  NODE_BIN="$(command -v node)" || NODE_BIN=""
  export PATH="${SAVED_PATH}"
  if [[ -z "${NODE_BIN}" ]]; then
    log_event "sync_check_failed reason=node_missing"
    /bin/rm -rf "${BACKUP_PATH}"
    return 0
  fi

  # 설치기를 CLI 로 실행하지 않는다. 같은 일을 하는 npm 스크립트를 거치는 실행도,
  # 파일 경로를 인자로 넘기는 실행도 모두 금지다. 설치기 :296-297 이 process.argv[1] 로
  # "직접 실행"을 판정하고, 그 경로에 걸리면 installChromeBridge() 가 기본값 전부로
  # 돌아간다. 기본값 경로의 실측 결과는 이렇다.
  #  · installChromeScheduler(:277-283)가 naver-shopping-chrome-scheduler.conf 를 다시
  #    쓴다. 워치독이 어느 Chrome·어느 프로필을 끄고 다시 열지 읽어 오는 바로 그
  #    파일이다. 자기 입력을 자기가 망가뜨리는 셈이 된다.
  #  · 이어서 스케줄러 에이전트에 launchctl bootout/bootstrap/enable/kickstart 를 건다.
  #    그 plist 는 RunAtLoad 이고 래퍼는 Chrome 을 띄운다. 꺼져 있던 맥에서는 이것이
  #    Chrome 을 시작시키고, periodInMinutes 1 짜리 rank-remote 알람이 붙어 60초 안에
  #    수집이 시작된다. 10분 주기 점검이 할 일이 절대 아니다.
  # 그래서 모듈로 불러들여 함수만 부른다. argv[1] 이 없으니 자동 실행 판정이 거짓이
  # 되고, 옵션 두 개로 부작용을 모두 끈다. disableOldAutomaticWorker:false 가 없으면
  # :262 가 매 동기화마다 launchctl bootout·disable 을 돈다. 저장소 경로에 공백과
  # 한글이 있으므로 file:// 문자열을 손으로 잇지 말고 pathToFileURL 로 변환한다.
  # 작업 디렉터리는 옮길 필요가 없다 — 설치기가 :225-227 에서 자기 import.meta.url 로
  # 저장소 경로를 스스로 구한다.
  # keychainReady 는 :233, 즉 첫 쓰기(:236 installRuntime) 세 줄 앞에서 확인되므로
  # 키체인이 비어 있으면 부작용 없이 그대로 실패한다. 따로 감쌀 필요가 없다.
  # 설치기 표준출력에는 절대경로와 확장 id 가 찍히므로 절대 로그로 남기지 않는다.
  local INSTALL_PID=0
  local INSTALL_WAITED=0
  local INSTALL_TIMED_OUT=0
  local INSTALL_STATUS=0
  MI_BRIDGE_INSTALLER="${SYNC_SOURCE_PATH}/scripts/install-naver-shopping-chrome-bridge.mjs" \
    "${NODE_BIN}" --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const m = await import(pathToFileURL(process.env.MI_BRIDGE_INSTALLER).href); m.installChromeBridge({ installChromeScheduler: false, disableOldAutomaticWorker: false });' >/dev/null 2>&1 &
  INSTALL_PID=$!
  # macOS 에는 timeout(1) 이 없다. kill -0 으로 생존만 확인하며 상한까지 센다.
  while (( INSTALL_WAITED < SYNC_INSTALL_TIMEOUT_SECONDS )); do
    kill -0 "${INSTALL_PID}" 2>/dev/null || break
    /bin/sleep 1
    INSTALL_WAITED=$(( INSTALL_WAITED + 1 ))
  done
  if kill -0 "${INSTALL_PID}" 2>/dev/null; then
    INSTALL_TIMED_OUT=1
    kill "${INSTALL_PID}" 2>/dev/null
  fi
  wait "${INSTALL_PID}"
  INSTALL_STATUS=$?

  if (( INSTALL_TIMED_OUT == 1 )); then
    # 백업을 병합이 아니라 통째로 되돌린다. 부분 갱신 사본이 남으면 안 된다.
    /bin/rm -rf "${RUNTIME_COPY_PATH}"
    /bin/mv -f "${BACKUP_PATH}" "${RUNTIME_COPY_PATH}"
    log_event "drift_sync_failed status=timeout"
    LAST_SYNC_AT="${NOW}"
    write_state "${STALLED_SINCE}" "${LAST_RESTART_AT}" "${NOW}"
    return 0
  fi
  if (( INSTALL_STATUS != 0 )); then
    # 실패도 쿨다운을 건다. 깨진 설치를 10분마다 다시 시도하면 안 된다.
    /bin/rm -rf "${RUNTIME_COPY_PATH}"
    /bin/mv -f "${BACKUP_PATH}" "${RUNTIME_COPY_PATH}"
    log_event "drift_sync_failed status=${INSTALL_STATUS}"
    LAST_SYNC_AT="${NOW}"
    write_state "${STALLED_SINCE}" "${LAST_RESTART_AT}" "${NOW}"
    return 0
  fi
  /bin/rm -rf "${BACKUP_PATH}"
  log_event "drift_sync_ok files=${DRIFT_COUNT}"
  LAST_SYNC_AT="${NOW}"
  write_state "${STALLED_SINCE}" "${LAST_RESTART_AT}" "${NOW}"

  # 동기화가 성공했을 때만 여기까지 온다. 확장 쪽 절반이 아직 남아 있다.
  # 확장은 사본으로 복사되지 않는다(installChromeBridge:229-232 는 manifest.json 을
  # 읽어 확장 id 만 뽑는다). 확장은 저장소 폴더에서 unpacked 로 로드된다.
  # service-worker.js:93 이 chrome.runtime.getManifest().version 을 네이티브 호스트에
  # 넘기고, 사본의 runtimeIdentityInput(scripts/naver-shopping-local-worker.mjs:198-224)
  # 은 그 값이 사본의 EXPECTED_RUNTIME_VERSION(:164)과 다르면
  # local_worker_runtime_identity_invalid 로 던진다. Chrome 은 브라우저 시작 시에만
  # unpacked 확장을 다시 읽으므로, 사본만 갱신하면 살아 있는 Chrome 이 옛 manifest
  # 버전을 새 사본에 계속 먹인다 — 방향만 반대인 불일치다. 즉 사본 동기화만으로는
  # 부족하고 Chrome 재시작까지 해야 한 쌍이 맞물린다.
  if ! /usr/bin/pgrep -x 'Google Chrome' >/dev/null 2>&1; then
    # 다음 Chrome 시작이 새 확장을 스스로 읽는다. 지금 할 일은 없다.
    log_event "sync_chrome_restart_skipped reason=not_running"
    return 10
  fi
  local SYNC_RESTART_ELAPSED=$(( NOW - LAST_RESTART_AT ))
  if (( LAST_RESTART_AT > 0 && SYNC_RESTART_ELAPSED >= 0 && SYNC_RESTART_ELAPSED < RESTART_COOLDOWN_SECONDS )); then
    log_event "sync_chrome_restart_suppressed_cooldown seconds_left=$(( RESTART_COOLDOWN_SECONDS - SYNC_RESTART_ELAPSED ))"
    return 10
  fi
  # 재기동 성패와 무관하게 이번 틱은 exit 0 으로 끝낸다. 드리프트 기능이 워치독
  # 자체를 실패(비영 종료)로 만들면 안 된다. 함수는 이미 chrome_restarted /
  # chrome_quit_failed / chrome_quit_unauthorized / chrome_start_failed 중 한 줄을
  # 남기고, 성공이든 실패든 시도 시점에 last_restart_at 을 걸어 둔다.
  chrome_restart_cycle "sync_chrome_restart_begin"
  return 10
}

set +e
runtime_drift_pass
DRIFT_VERDICT=$?
set -e
if (( DRIFT_VERDICT == 10 )); then
  exit 0
fi

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

# ── 판정 ─────────────────────────────────────────────────────
if (( QUEUE_STALLED == 0 )); then
  if (( STALLED_SINCE > 0 )); then
    log_event "stall_cleared stalled_minutes=${STALLED_MINUTES}"
    write_state 0 "${LAST_RESTART_AT}" "${LAST_SYNC_AT}"
  else
    log_event "healthy stalled_minutes=${STALLED_MINUTES}"
  fi
  exit 0
fi

if (( STALLED_SINCE <= 0 )); then
  # 첫 정체 관측만으로는 절대 재기동하지 않는다(맥 절전 복귀 오탐 차단).
  log_event "stall_started stalled_minutes=${STALLED_MINUTES}"
  write_state "${NOW}" "${LAST_RESTART_AT}" "${LAST_SYNC_AT}"
  exit 0
fi

STALLED_SECONDS=$(( NOW - STALLED_SINCE ))
if (( STALLED_SECONDS < 0 )); then
  log_event "stall_clock_reset previous=${STALLED_SINCE}"
  write_state "${NOW}" "${LAST_RESTART_AT}" "${LAST_SYNC_AT}"
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
  write_state "${STALLED_SINCE}" "${NOW}" "${LAST_SYNC_AT}"
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
set +e
chrome_restart_cycle "restart_begin stalled_seconds=${STALLED_SECONDS}"
RESTART_STATUS=$?
set -e
exit "${RESTART_STATUS}"

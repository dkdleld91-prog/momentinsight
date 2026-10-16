#!/bin/zsh
# C 30일 순위(쿠팡) 수집기 맥 설치·업데이트·시험·제거(명세 §9.6.3). 일반 사용자 터미널에서 실행한다(관리자 아님).
#   /bin/zsh /tmp/mi-coupang-install.sh --release abc1234 [--reset-token] [--browser-app "<…/Google Chrome.app>"] [--trial-only] [--uninstall]
# 브라우저는 Microsoft Edge 를 우선한다(맥 미니는 Edge 필수, G11). Edge 가 없을 때만 --browser-app 으로 준 Chrome 을
# 예비 경로로 쓰고, 이때는 N30 보호(lib/guards.mjs)가 켜진다. 다른 프로세스는 우리 runs 폴더·우리 worker/trial 명령줄이
# 든 것만 끈다. N30 에이전트는 건드리지 않는다. N30 로그 두 개의 경로는 이 파일에서만 collector.json 에 쓴다(읽기 전용 보호용, M8).
set -euo pipefail
umask 077

LABEL="co.kr.momentinsight.coupang-rank-collector"
SERVICE="co.kr.momentinsight.coupang-rank-collector"
TRIAL_AGENT="com.momentinsight.coupang-trial"
ORIGIN="https://insight.momentlabs.co.kr"
BUNDLE_URL="https://insight.momentlabs.co.kr/coupang-collector/bundle.json"
ROOT="$HOME/Library/Application Support/MomentInsight/CoupangRank"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNS_MARKER="/MomentInsight/CoupangRank/runs/"
WORKER_MARKER="/CoupangRank/app/worker.mjs"
TRIAL_MARKER="/CoupangRank/app/trial.mjs"
N30_SCHEDULER_LOG="$HOME/Library/Logs/MomentInsight/naver-shopping-chrome-scheduler.log"
N30_WATCHDOG_LOG="$HOME/Library/Logs/MomentInsight/mi-rank-watchdog.log"
RELEASE_RE='^[0-9a-f]{7}$'
TOKEN_RE='^mic1_[A-Za-z0-9_-]{43}$'
VERSION_RE='^[0-9]+(\.[0-9]+){1,3}$'
TRIAL_JSON='{"keywords":["\uc544\uc774\ud3f0 18\ud504\ub85c \uc0ac\uc0dd\ud65c \ubcf4\ud638 \ud544\ub984"],"casePair":["iPhone 17 \ucf00\uc774\uc2a4","iphone 17 \ucf00\uc774\uc2a4"],"modes":["normal","offscreen","minimized"],"gapSeconds":[240,360]}'

RELEASE=""
RESET_TOKEN=0
BROWSER_APP=""
TRIAL_ONLY=0
UNINSTALL=0
TMP_DIR=""

fail() {
  print -r -- "MI_COUPANG_INSTALL_FAIL code=$1"
  exit 1
}

info() {
  print -r -- "$*" >&2
}

cleanup() {
  [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]] && /bin/rm -rf "$TMP_DIR"
  return 0
}
trap cleanup EXIT

while (( $# > 0 )); do
  case "$1" in
    --release) (( $# >= 2 )) || fail missing_release; RELEASE="$2"; shift 2 ;;
    --reset-token) RESET_TOKEN=1; shift ;;
    --browser-app) (( $# >= 2 )) || fail missing_browser_app; BROWSER_APP="$2"; shift 2 ;;
    --trial-only) TRIAL_ONLY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) fail unknown_option ;;
  esac
done

[[ "$RELEASE" =~ $RELEASE_RE ]] || fail release_invalid
[[ "$(/usr/bin/uname -s)" == "Darwin" ]] || fail macos_only
(( EUID != 0 )) || fail run_as_user
[[ -n "$HOME" && "$ROOT" == "$HOME/Library/Application Support/MomentInsight/CoupangRank" ]] || fail home_invalid
UID_NUM="$(/usr/bin/id -u)"
ACCOUNT="$(/usr/bin/id -un)"

# 명령줄에 주어진 표식이 든 프로세스 번호(이 설치기 자신은 뺀다). 읽기만 한다.
our_pids() {
  local line pid cmd marker
  /bin/ps -axo pid=,command= | while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    pid="${line%% *}"
    cmd="${line#* }"
    [[ "$pid" == <-> ]] || continue
    (( pid == $$ )) && continue
    for marker in "$@"; do
      if [[ "$cmd" == *"$marker"* ]]; then
        print -r -- "$pid"
        break
      fi
    done
  done
}

# 우리 표식이 든 프로세스만 TERM → 5초 → KILL.
stop_ours() {
  local -a pids
  local pid
  pids=( ${(f)"$(our_pids "$@")"} )
  (( ${#pids} > 0 )) || return 0
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
  sleep 5
  pids=( ${(f)"$(our_pids "$@")"} )
  for pid in $pids; do kill -KILL "$pid" 2>/dev/null || true; done
  return 0
}

agent_loaded() {
  /bin/launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1
}

wait_lock() {
  local i
  for i in {1..30}; do
    [[ -d "$ROOT/state/worker.lock" ]] || return 0
    sleep 2
  done
  return 0
}

if (( UNINSTALL )); then
  /bin/launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  /bin/rm -f "$PLIST"
  stop_ours "$WORKER_MARKER" "$TRIAL_MARKER"
  stop_ours "$RUNS_MARKER"
  [[ -d "$ROOT" ]] && /bin/rm -rf "$ROOT"
  /usr/bin/security delete-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || true
  print -r -- "MI_COUPANG_UNINSTALL_OK"
  exit 0
fi

# 1. 맥 시험 에이전트가 떠 있으면 멈춘다(같은 IP 겹침 방지). 내릴 명령만 알려 준다.
if /bin/launchctl print "gui/$UID_NUM/$TRIAL_AGENT" >/dev/null 2>&1; then
  info "맥 시험 에이전트($TRIAL_AGENT)가 아직 켜져 있습니다. 10/19 12:00 시험이 끝난 뒤 아래 명령으로 내리고 다시 실행하세요."
  info "launchctl bootout gui/$UID_NUM/$TRIAL_AGENT"
  fail trial_agent_loaded
fi

# 2. Node(절대 경로, 22~24)
NODE="$(command -v node 2>/dev/null || true)"
[[ "$NODE" == /* && -x "$NODE" ]] || fail node_version_must_be_22_to_24
NODE_VERSION="$("$NODE" -p 'process.versions.node' 2>/dev/null || true)"
[[ "$NODE_VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]] || fail node_version_must_be_22_to_24
NODE_MAJOR="${NODE_VERSION%%.*}"
(( NODE_MAJOR >= 22 && NODE_MAJOR <= 24 )) || fail node_version_must_be_22_to_24

# 3. 브라우저 선택: Edge 우선, 없으면 --browser-app 으로 준 Chrome(예비 경로)
KIND=""
BROWSER_APP_PATH=""
BROWSER_PATH=""
GUARD="none"
for candidate in "/Applications/Microsoft Edge.app" "$HOME/Applications/Microsoft Edge.app"; do
  if [[ -x "$candidate/Contents/MacOS/Microsoft Edge" ]]; then
    KIND="edge"
    BROWSER_APP_PATH="$candidate"
    BROWSER_PATH="$candidate/Contents/MacOS/Microsoft Edge"
    break
  fi
done
if [[ -z "$KIND" ]]; then
  [[ -n "$BROWSER_APP" ]] || fail browser_app_required
  BROWSER_APP="${BROWSER_APP%/}"
  [[ "$BROWSER_APP" == /*"/Google Chrome.app" && -x "$BROWSER_APP/Contents/MacOS/Google Chrome" ]] || fail browser_app_invalid
  KIND="chrome"
  GUARD="n30-chrome"
  BROWSER_APP_PATH="$BROWSER_APP"
  BROWSER_PATH="$BROWSER_APP/Contents/MacOS/Google Chrome"
  info "Edge 설치를 권장합니다(N30 크롬과 완전 분리). 지금은 Chrome 예비 경로 + N30 보호로 설치합니다."
fi
BROWSER_VERSION="$(/usr/bin/defaults read "$BROWSER_APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
[[ "$BROWSER_VERSION" =~ $VERSION_RE ]] || BROWSER_VERSION="unknown"

# 4. 묶음 받기: release·sha256(UTF-8 바이트) 확인 → app.new/ 에 풀기 → node --check → zsh -n
/bin/mkdir -p "$ROOT" "$ROOT/runs" "$ROOT/outbox" "$ROOT/state" "$ROOT/logs" "$ROOT/trial-results"
/bin/chmod 700 "$ROOT"
TMP_DIR="$(/usr/bin/mktemp -d)"
/usr/bin/curl -fsSL --proto '=https' --max-time 120 "$BUNDLE_URL" -o "$TMP_DIR/bundle.json" || fail bundle_download_failed
UNPACK_JS='
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [bundleFile, outDir, release] = process.argv.slice(1);
const stop = (code) => { process.stdout.write(`error=${code}\n`); process.exit(1); };
let bundle;
try { bundle = JSON.parse(fs.readFileSync(bundleFile, "utf8")); } catch { stop("bundle_invalid"); }
if (!bundle || bundle.schema !== 1 || !Array.isArray(bundle.files)) stop("bundle_invalid");
if (bundle.release !== release) stop("release_mismatch");
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(bundle.version))) stop("bundle_invalid");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const seen = new Set();
for (const file of bundle.files) {
  const rel = String(file && file.path || "");
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(rel) || rel.includes("..")) stop("bundle_invalid");
  if (typeof file.content !== "string") stop("bundle_invalid");
  const bytes = Buffer.from(file.content, "utf8");
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== file.sha256) stop("bundle_hash_mismatch");
  const target = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  seen.add(rel);
}
for (const required of ["worker.mjs", "trial.mjs", "run-worker.sh", "collector.plist.template", "lib/contract.mjs"]) {
  if (!seen.has(required)) stop("bundle_invalid");
}
fs.writeFileSync(path.join(outDir, "VERSION"), `${bundle.version} ${release}\n`);
process.stdout.write(`version=${bundle.version}\n`);
'
UNPACK_OUT="$("$NODE" -e "$UNPACK_JS" "$TMP_DIR/bundle.json" "$ROOT/app.new" "$RELEASE" 2>/dev/null || true)"
if [[ "$UNPACK_OUT" != version=* ]]; then
  CODE="${UNPACK_OUT#error=}"
  [[ "$CODE" =~ '^[a-z_]+$' ]] || CODE="bundle_invalid"
  fail "$CODE"
fi
BUNDLE_VERSION="${UNPACK_OUT#version=}"
for module in "$ROOT"/app.new/**/*.mjs(N); do
  "$NODE" --check "$module" >/dev/null 2>&1 || fail bundle_syntax_invalid
done
/bin/zsh -n "$ROOT/app.new/run-worker.sh" || fail bundle_syntax_invalid

# 5. 교체: 우리 에이전트를 내리고, 잠금을 기다리고, 우리 runs 폴더 브라우저만 끈 뒤 app/ 을 바꾼다.
WAS_LOADED=0
if agent_loaded; then WAS_LOADED=1; fi
/bin/launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
wait_lock
stop_ours "$RUNS_MARKER"
/bin/rm -rf "$ROOT/app.old"
[[ -d "$ROOT/app" ]] && /bin/mv "$ROOT/app" "$ROOT/app.old"
/bin/mv "$ROOT/app.new" "$ROOT/app"
/bin/rm -rf "$ROOT/app.old"

# 7. 설정 파일(collector.json·node-path). 시험(--trial-only)도 브라우저 경로가 필요해 같이 쓴다.
CONFIG_JS='
const fs = require("node:fs");
const [file, kind, browserPath, nodePath, schedulerLog, watchdogLog] = process.argv.slice(1);
const config = {
  schema: 1,
  platform: "macos",
  apiBase: "https://insight.momentlabs.co.kr",
  nodePath,
  browser: { kind, path: browserPath },
  chromeGuard: kind === "chrome" ? {
    schedulerLog, watchdogLog, intervalSeconds: 600, calendarLocalTimes: ["08:50", "14:50"],
    marginSeconds: 60, driftSeconds: 30, watchdogBusySeconds: 420,
  } : null,
};
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
'
"$NODE" -e "$CONFIG_JS" "$ROOT/collector.json" "$KIND" "$BROWSER_PATH" "$NODE" "$N30_SCHEDULER_LOG" "$N30_WATCHDOG_LOG" || fail config_write_failed
print -r -- "$NODE" > "$ROOT/node-path"
[[ "$BROWSER_VERSION" != "unknown" ]] && print -r -- "$BROWSER_VERSION" > "$ROOT/state/browser-version"

if (( TRIAL_ONLY )); then
  print -r -- "$TRIAL_JSON" > "$ROOT/trial.json"
  TRIAL_STATUS=0
  "$NODE" "$ROOT/app/trial.mjs" || TRIAL_STATUS=$?
  if (( WAS_LOADED )) && [[ -f "$PLIST" ]]; then
    /bin/launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
  fi
  exit 0
fi

# 6. 연결 코드(키체인). 값을 묻는 창에 두 번 붙여 넣으므로 명령줄에 원문이 남지 않는다. 다시 읽어 형식만 본다(출력 안 함).
if (( RESET_TOKEN )) || ! /usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
  info "관리자 화면에서 받은 연결 코드를 붙여 넣으세요(두 번 묻고, 화면에 보이지 않습니다)."
  /usr/bin/security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -T /usr/bin/security -w || fail keychain_write_failed
fi
CHECK_TOKEN="$(/usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null || true)"
if [[ ! "$CHECK_TOKEN" =~ $TOKEN_RE ]]; then
  CHECK_TOKEN=""
  fail connection_code_invalid
fi
CHECK_TOKEN=""

# 8. plist(템플릿 치환)
/bin/mkdir -p "$HOME/Library/LaunchAgents"
PLIST_JS='
const fs = require("node:fs");
const [template, out, root] = process.argv.slice(1);
const escaped = root.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
fs.writeFileSync(out, fs.readFileSync(template, "utf8").split("{ROOT}").join(escaped));
'
"$NODE" -e "$PLIST_JS" "$ROOT/app/collector.plist.template" "$PLIST" "$ROOT" || fail plist_write_failed
/usr/bin/plutil -lint "$PLIST" >/dev/null 2>&1 || fail plist_invalid

# 9. 등록·확인: bootstrap → --hello-only(토큰은 이 프로세스에만) → kickstart → 120초 안에 run_end
/bin/launchctl bootstrap "gui/$UID_NUM" "$PLIST" || fail launchd_bootstrap_failed
HELLO_TOKEN="$(/usr/bin/security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null || true)"
HELLO_OUT="$(MI_COUPANG_COLLECTOR_TOKEN="$HELLO_TOKEN" "$NODE" "$ROOT/app/worker.mjs" --hello-only 2>/dev/null || true)"
HELLO_TOKEN=""
AUTH="$(print -r -- "$HELLO_OUT" | /usr/bin/sed -n 's/.*auth=\([a-z_]*\).*/\1/p' | /usr/bin/tail -n 1)"
if [[ "$AUTH" != "ok" ]]; then
  /bin/launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  fail "auth_${AUTH:-error}"
fi
SINCE="$(/bin/date -u '+%Y-%m-%dT%H:%M:%S')"
/bin/launchctl kickstart -k "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true

first_run_reason() {
  local line stamp reason
  [[ -f "$ROOT/logs/worker.log" ]] || return 0
  /usr/bin/tail -n 300 "$ROOT/logs/worker.log" | while IFS= read -r line; do
    [[ "$line" == *" run_end "* && "$line" != *"mode=hello_only"* ]] || continue
    stamp="${line%% *}"
    [[ "$stamp" > "$SINCE" || "$stamp" == "$SINCE" ]] || continue
    reason="${line##*reason=}"
    reason="${reason%% *}"
    print -r -- "$reason"
  done | /usr/bin/tail -n 1
}

FIRST_RUN="pending"
for i in {1..24}; do
  sleep 5
  REASON="$(first_run_reason)"
  if [[ -n "$REASON" ]]; then
    FIRST_RUN="$REASON"
    break
  fi
done
AGENT_STATE="not_loaded"
if agent_loaded; then AGENT_STATE="loaded"; fi
print -r -- "MI_COUPANG_INSTALL_OK release=$RELEASE version=$BUNDLE_VERSION node=$NODE_VERSION browser=$KIND/$BROWSER_VERSION guard=$GUARD agent=$AGENT_STATE auth=ok first_run=$FIRST_RUN"
